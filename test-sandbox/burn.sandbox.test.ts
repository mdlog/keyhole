/**
 * Task 5 live suite (`npm run test:sandbox`): signBurn against a real near-sandbox (nearcore 2.14.0), in both
 * modes, plus the idempotent re-run and the local files. One sandbox is booted for the file and stopped after it.
 * Local only: every key is the sandbox root's or generated in memory here, and none is printed (public keys are
 * compared as booleans). Session keys are added with Task 2's signAndSend (an AddKey from the account itself),
 * never through wrap.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, actions } from "near-api-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NEAR } from "../src/core/amounts.js";
import { sendAttempt } from "../src/core/attempt.js";
import { saveAccountKey, saveSessionKey, sessionKeyPath } from "../src/core/credentials.js";
import { dropHeldKeys, heldPrivateKeyCount, holdSessionKey } from "../src/core/keys.js";
import { signBurn } from "../src/core/burn.js";
import { NO_CODE_HASH, rpcCall, viewAccount, viewScopedKey } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import { saveSession } from "../src/core/session.js";
import { mustSucceed, signAndSend } from "../src/core/tx.js";
import type { Attempt, Session } from "../src/core/types.js";
import { sampleSession, tmpEnv } from "../test/helpers.js";
import { createAccount, repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

/** The session allowance the PRD uses (MH4): room for one 30 TGas vote in flight. */
const ALLOWANCE = 5n * 10n ** 22n;

let sb: SandboxHandle;
let seatKey: KeyPair;
let operatorKey: KeyPair;
let seat: string;
let dao: string;
let operator: string;
const nodesBefore = repoSandboxProcesses();
const homeBefore = sandboxHomeEntries();
let nextSession = 0x7f00;

beforeAll(async () => {
  sb = await startSandbox();
  seat = `seat.${sb.rootId}`;
  dao = `dao.${sb.rootId}`;
  operator = `op.${sb.rootId}`;
  seatKey = await createAccount(sb, "seat", 10n * NEAR);
  await createAccount(sb, "dao", NEAR); // the receiver: a plain account is enough, a refusal never reaches it
  operatorKey = await createAccount(sb, "op", 10n * NEAR);
});

afterAll(async () => {
  await sb?.stop();
  expect(repoSandboxProcesses()).toEqual(nodesBefore); // nothing of this run is left up
  expect(sandboxHomeEntries()).toEqual(homeBefore);
});

afterEach(() => dropHeldKeys());

const addFcKey = (accountId: string, signerKey: KeyPair, fcKey: KeyPair) =>
  signAndSend("sandbox", accountId, signerKey, accountId, [actions.addFunctionCallAccessKey(fcKey.getPublicKey(), dao, ["act_proposal"], ALLOWANCE)]);

/** A session for a key that is already on chain. */
function sessionFor(accountId: string, mode: Session["mode"], fcKey: KeyPair): Session {
  return sampleSession({
    id: `ks-${(nextSession++).toString(16)}`,
    mode,
    accountId,
    receiverId: dao,
    methodNames: ["act_proposal"],
    allowanceYocto: ALLOWANCE.toString(),
    codeHashPin: NO_CODE_HASH,
    publicKey: fcKey.getPublicKey().toString(),
  });
}

/** A session key added to the seat (on-account mode), seen on chain before the burn. */
async function liveOnAccountSession(): Promise<{ session: Session; fcKey: KeyPair }> {
  const fcKey = KeyPair.fromRandom("ed25519");
  mustSucceed("add session key", await addFcKey(seat, seatKey, fcKey));
  const session = sessionFor(seat, "on-account", fcKey);
  expect(await viewScopedKey(session)).toMatchObject({ accountId: seat, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: ALLOWANCE.toString() });
  return { session, fcKey };
}

/** The attempt a prompt-injected agent would make next, signed with the (deleted) session key. */
async function attemptWith(session: Session, fcKey: KeyPair): Promise<Attempt> {
  holdSessionKey(session, fcKey);
  return sendAttempt(session, { sessionId: session.id, receiverId: dao, action: "FunctionCall", method: "act_proposal", args: { id: 0, action: "VoteApprove" }, depositYocto: "0", gasTGas: 30, violates: "none" });
}

const refusalName = (a: Attempt) => (a.outcome.kind === "Refusal" ? a.outcome.errorName : a.outcome.kind);

/** The actions of a landed tx, as the RPC lists them. */
async function landedActions(txHash: string, signerId: string): Promise<Array<Record<string, any>>> {
  const reply = await rpcCall(sb.rpcUrl, "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
  return reply.json.result.transaction.actions;
}

describe("signBurn on near-sandbox", () => {
  it("on-account: one DeleteKey; the key is gone; the next attempt is AccessKeyNotFound", async () => {
    const { session, fcKey } = await liveOnAccountSession();

    const result = await signBurn(session, { persist: false, signerKey: seatKey });

    expect(result.txHashes).toHaveLength(1);
    expect(result.session).toMatchObject({ status: "burned", burnTxHashes: result.txHashes });
    const sent = await landedActions(result.txHashes[0], seat);
    expect(sent).toHaveLength(1);
    expect(sent[0].DeleteKey.public_key === session.publicKey).toBe(true);
    expect(await viewScopedKey(session)).toBeNull();
    expect(await viewAccount("sandbox", seat)).not.toBeNull(); // the account survives an on-account burn

    const after = await attemptWith(session, fcKey);
    expect(refusalName(after)).toBe("AccessKeyNotFound");
  });

  it("sub-account: DeleteKey + DeleteAccount(beneficiary = parent) in one tx; the next attempt is SignerDoesNotExist", async () => {
    const sub = `ks-b0b0.${operator}`;
    const fcKey = KeyPair.fromRandom("ed25519");
    // wrap's sub-account shape: created by the operator, holding the operator's key (full access) and the session key.
    mustSucceed(
      "create the session sub-account",
      await signAndSend("sandbox", operator, operatorKey, sub, [
        actions.createAccount(),
        actions.transfer(2n * NEAR),
        actions.addFullAccessKey(operatorKey.getPublicKey()),
        actions.addFunctionCallAccessKey(fcKey.getPublicKey(), dao, ["act_proposal"], ALLOWANCE),
      ]),
    );
    const session = { ...sessionFor(sub, "subaccount", fcKey), id: "ks-b0b0" };
    expect(await viewScopedKey(session)).not.toBeNull();
    const env = tmpEnv();
    saveAccountKey("sandbox", operator, operatorKey, env); // signBurn finds the operator's key in the keychain, by the parent id
    const before = (await viewAccount("sandbox", operator))?.amountYocto ?? "0";

    const result = await signBurn(session, { persist: false, env });

    expect(result.txHashes).toHaveLength(1);
    const sent = await landedActions(result.txHashes[0], sub);
    expect(sent).toHaveLength(2);
    expect(sent[0].DeleteKey.public_key === session.publicKey).toBe(true);
    expect(sent[1].DeleteAccount.beneficiary_id).toBe(operator);
    expect(await viewAccount("sandbox", sub)).toBeNull();
    expect(await viewScopedKey(session)).toBeNull();
    // The beneficiary received what the sub-account still held: most of the 2 NEAR it was funded with.
    const gained = BigInt((await viewAccount("sandbox", operator))?.amountYocto ?? "0") - BigInt(before);
    expect(gained > (NEAR * 19n) / 10n && gained < 2n * NEAR).toBe(true);

    const after = await attemptWith(session, fcKey);
    expect(refusalName(after)).toBe("SignerDoesNotExist");
  });

  it("already burned: no send_tx, txHashes []", async () => {
    const { session } = await liveOnAccountSession();
    const first = await signBurn(session, { persist: false, signerKey: seatKey });
    expect(first.txHashes).toHaveLength(1);

    const methods: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      methods.push(JSON.parse(String(init?.body)).method);
      return realFetch(input, init);
    };
    try {
      const second = await signBurn(session, { persist: false }); // no signerKey and an empty keychain: it must not be needed
      expect(second.txHashes).toEqual([]);
      expect(second.session).toMatchObject({ status: "burned", burnTxHashes: [] });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(methods).toEqual(["query"]); // one view_access_key, nothing signed
  });

  it("persist: session file says burned with burnedAt and burnTxHashes; the key file is deleted; a held key stays held", async () => {
    const env = tmpEnv();
    const { session, fcKey } = await liveOnAccountSession();
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    saveAccountKey("sandbox", seat, seatKey, env); // the seat's own full-access key, from the keychain
    holdSessionKey(session, fcKey);
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);

    const result = await signBurn(session, { env });

    const file = JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", `${session.id}.json`), "utf8"));
    expect(result.txHashes).toHaveLength(1);
    expect(file).toMatchObject({ id: session.id, status: "burned", burnedAt: result.session.burnedAt, burnTxHashes: result.txHashes });
    expect(new Date(file.burnedAt).toISOString()).toBe(file.burnedAt);
    expect(existsSync(sessionKeyPath(session, env))).toBe(false);
    expect(heldPrivateKeyCount()).toBe(1); // R11a
    expect(await viewScopedKey(session)).toBeNull();

    // Again: nothing to sign, nothing changes.
    const again = await signBurn(result.session, { env });
    expect(again.txHashes).toEqual([]);
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", `${session.id}.json`), "utf8"))).toEqual(file);

    // The held key still signs; the chain is what refuses it.
    expect(refusalName(await attemptWith(session, fcKey))).toBe("AccessKeyNotFound");
  });
});
