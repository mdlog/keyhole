/**
 * Task 4 live suite (`npm run test:sandbox`): planWrap + signWrap against a real near-sandbox (nearcore 2.14.0).
 * Local only: every key is the sandbox root's or generated in memory here, and none is printed.
 *
 * The vendored Sputnik v2 DAO is deployed straight from vendor/ with Task 2's signAndSend, after its sha256 is
 * checked against the pack's sandboxFixture (Task 9's deployDaoSandbox is built in parallel, so it is not used).
 *
 * Task 10's classifyTools (the default `deps.classify`) is not built yet: both wraps inject a fake classifier
 * that returns the 4 Sputnik ToolSchemas. This suite proves the AddKey, its scope, the code-hash pin and the
 * key save live; the default-classifier run is added when Task 10 lands.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { actions } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { classifyTools } from "../src/classify/dry-run.js";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { saveAccountKey, sessionKeyPath } from "../src/core/credentials.js";
import { sendAttempt } from "../src/core/attempt.js";
import { dropHeldKeys } from "../src/core/keys.js";
import { rpcCall, viewAccount, viewCodeHash, viewScopedKey } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import { mustSucceed, signAndSend } from "../src/core/tx.js";
import type { TargetPack } from "../src/core/types.js";
import { planWrap, signWrap } from "../src/core/wrap.js";
import { sampleCageCard, tmpEnv } from "../test/helpers.js";
import { REPO, createAccount, repoSandboxProcesses } from "./helpers.js";

const ALLOWANCE = "50000000000000000000000";
/** The committed pack file, read directly (no src/packs code: Task 9 is editing it in parallel). */
const PACK = JSON.parse(readFileSync(join(REPO, "src", "packs", "sputnik-v2.pack.json"), "utf8")) as TargetPack;
/** The 4 Sputnik ToolSchemas classifyTools returns for the hero scope. */
const fake = vi.fn<typeof classifyTools>(async () => sampleCageCard().tools);

let sb: SandboxHandle;
let nodesBefore: number[];
let seat: string;
let dao: string;
const env = tmpEnv();

/** Deploys vendor/sputnikdao2-v2.0.0.wasm (sha256-checked) at dao.sandbox with the pack's `new` args. */
async function deployDao(seatId: string, cosignerId: string): Promise<string> {
  const fixture = PACK.sandboxFixture;
  if (!fixture) throw new Error("sputnik-v2 pack has no sandboxFixture");
  const wasm = readFileSync(join(REPO, fixture.wasmPath));
  expect(createHash("sha256").update(wasm).digest("hex")).toBe(fixture.sha256);
  const daoId = `dao.${sb.rootId}`;
  const daoKey = await createAccount(sb, daoId, 10n * NEAR);
  const initArgs = JSON.parse(JSON.stringify(fixture.init.args).replaceAll('"{seat}"', JSON.stringify(seatId)).replaceAll('"{cosigner}"', JSON.stringify(cosignerId)));
  mustSucceed("deploy + new", await signAndSend("sandbox", daoId, daoKey, daoId, [actions.deployContract(new Uint8Array(wasm)), actions.functionCall(fixture.init.method, initArgs, 100n * TGAS, 0n)]));
  expect(await viewCodeHash("sandbox", daoId)).toBe(fixture.codeHash);
  return daoId;
}

beforeAll(async () => {
  nodesBefore = repoSandboxProcesses();
  sb = await startSandbox();
  seat = `seat.${sb.rootId}`;
  const seatKey = await createAccount(sb, "seat", 10n * NEAR);
  saveAccountKey("sandbox", seat, seatKey, env); // the keychain wrap reads (tmpEnv, never ~/.near-credentials)
  dao = await deployDao(seat, `cosigner.${sb.rootId}`);
});

afterAll(async () => {
  dropHeldKeys();
  await sb?.stop();
  expect(repoSandboxProcesses()).toEqual(nodesBefore); // no node left running
});

describe("wrap on near-sandbox", () => {
  it("on-account: one AddKey lands with exactly the planned scope; the session file and the 0600 key file persist", async () => {
    const plan = await planWrap({ contract: dao, allow: ["act_proposal"], allowanceYocto: ALLOWANCE, onAccount: seat, network: "sandbox" }, { sandbox: sb, classify: fake });
    expect(plan.draft.codeHashPin).toBe(PACK.sandboxFixture?.codeHash);
    expect(plan.txActions).toEqual([`+ AddKey FunctionCall → ${seat} · receiver ${dao} · methods act_proposal · allowance 0.0500 NEAR`]);
    expect(fake.mock.calls.at(-1)?.[2]?.sandbox).toBe(sb);

    const { session, txHash } = await signWrap(plan, { env });

    // The chain has the key, scoped exactly as planned (view_access_key).
    expect(await viewScopedKey(session)).toMatchObject({ publicKey: plan.draft.publicKey, accountId: seat, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: ALLOWANCE });
    const tx = await rpcCall(sb.rpcUrl, "tx", { tx_hash: txHash, sender_account_id: seat, wait_until: "FINAL" });
    expect(tx.json.result.transaction.actions.map((a: object) => Object.keys(a)[0])).toEqual(["AddKey"]);
    // Persisted under tmpEnv(): metadata-only session file, key file 0600.
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", `${session.id}.json`), "utf8"))).toEqual(session);
    expect(statSync(sessionKeyPath(session, env)).mode & 0o777).toBe(0o600);
    // The held key is the one on chain: an act_proposal call passes validation (and the contract answers: no proposal 0).
    const attempt = await sendAttempt(session, { sessionId: session.id, receiverId: dao, action: "FunctionCall", method: "act_proposal", args: { id: 0, action: "VoteApprove" }, depositYocto: "0", gasTGas: 30, violates: "none" });
    expect(attempt.outcome.kind).toBe("ContractPanic");
  });

  it("sub-account: ks-XXXX.sandbox exists, funded, with 2 keys (operator FullAccess, session FunctionCall)", async () => {
    const plan = await planWrap({ contract: dao, allow: ["act_proposal"], allowanceYocto: ALLOWANCE, operatorId: sb.rootId, network: "sandbox" }, { sandbox: sb, classify: fake });
    expect(plan.draft.accountId).toMatch(/^ks-[0-9a-f]{4}\.sandbox$/);

    const { session } = await signWrap(plan, { env, signerKey: sb.rootKey });

    const list = await rpcCall(sb.rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: session.accountId });
    const keys: Array<{ public_key: string; access_key: { permission: unknown } }> = list.json.result.keys;
    expect(keys).toHaveLength(2);
    const operatorPub = sb.rootKey.getPublicKey().toString();
    const roles = keys.map((k) => [k.public_key === operatorPub ? "operator" : k.public_key === session.publicKey ? "session" : "other", k.access_key.permission === "FullAccess" ? "FullAccess" : "FunctionCall"]);
    expect(roles.sort()).toEqual([
      ["operator", "FullAccess"],
      ["session", "FunctionCall"],
    ]);
    expect(await viewScopedKey(session)).toMatchObject({ accountId: session.accountId, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: ALLOWANCE });
    expect((await viewAccount("sandbox", session.accountId))?.amountYocto).toBe(plan.fundingYocto);
    expect(statSync(sessionKeyPath(session, env)).mode & 0o777).toBe(0o600);
  });
});
