/**
 * Task 15: the testnet bootstrap, offline. RPC replies are replayed (replayFetch): the recorded testnet `status`
 * (chain_id testnet), the spike's recorded view_access_key and landed send_tx bodies, and view_account /
 * call_function bodies shaped like the recorded ones. Keys are generated in memory and written only into tmpEnv()
 * keychains; no test reads the real keychain, and nothing reaches a network.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, baseEncode, decodeSignedTransaction } from "near-api-js";
import { beforeEach, describe, expect, it } from "vitest";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { useRpcUrl } from "../src/core/config.js";
import { loadFullAccessKey, saveAccountKey } from "../src/core/credentials.js";
import { EnvironmentError } from "../src/core/errors.js";
import { SendFateUnknownError } from "../src/core/tx.js";
import type { TargetPack } from "../src/core/types.js";
import { type TestnetDemoState, checkTestnetDemo, ensureTestnetDemo, factoryCreateArgs } from "../src/demo/testnet-setup.js";
import { loadTargetPack } from "../src/packs/index.js";
import { councilInitArgs } from "../src/packs/sputnik-setup.js";
import { type ReplayedRequest, SANDBOX_FIXTURES, readFixture, replayFetch, tmpEnv } from "./helpers.js";

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
/** `status` as rpc.testnet.near.org answered it (chain_id "testnet"), recorded read-only by the spike. */
const STATUS = readFixture(join(SANDBOX_FIXTURES, "testnet-readonly"), "testnet-status.json");
/** A view_access_key reply for a full-access key (nonce 0, a real block hash). */
const NONCE = fx("003-a-create-seat.nonce.json");
/** A landed create-account tx: [CreateAccount, Transfer, AddKey], every receipt SuccessValue. */
const LANDED = fx("004-a-create-seat.send_tx.json");
/** `raw` with the tx's own (top-level) status set to SuccessValue base64(`value`); receipt outcomes untouched. */
const withTxValue = (raw: string, value: string) => {
  const json = JSON.parse(raw);
  json.result.status = { SuccessValue: Buffer.from(value).toString("base64") };
  return JSON.stringify(json);
};
/** The same landed body with the factory's on_create result `true` as the tx's SuccessValue. */
const FACTORY_LANDED = withTxValue(LANDED, "true");
/** TIMEOUT_ERROR as nearcore sends it for a tx it has not seen final. */
const TIMEOUT =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"cause":"NOT_OBSERVED"},"name":"TIMEOUT_ERROR"},"code":-32000,"message":"Server error","data":"Timeout"},"id":"p"}';
/** view_access_key for a key that is not on the account (nearcore 2.x legacy `result.error`). */
const NO_SUCH_KEY = '{"jsonrpc":"2.0","result":{"block_hash":"x","block_height":1,"error":"access key ed25519:x does not exist while viewing","logs":[]},"id":"x"}';
/**
 * SYNTHETIC (C-T15c): a landed factory create whose on_create returned `false` while every receipt succeeded. The real
 * shape of a failed create is FACTORY_FAILED below (its batch receipt fails); this one only exercises the
 * returned-false safety net after mustSucceed.
 */
const FACTORY_FALSE = withTxValue(LANDED, "false");
/** The DAO's batch receipt (CreateAccount, Transfer, DeployContract, new) on the factory's real failure path. */
const BATCH_RECEIPT = "7Lr8hDThSUJ4MgS4LH9rdrrhH5HuFoibcZVkzqvbn1Tq";
/** The factory's on_create callback, which reads the batch's result and returns it. */
const CALLBACK_RECEIPT = "3Yi7uViVa5jJnRrD4oXjGhC7bJ7UACLPa4FEpqp2Kd2v";
/**
 * The real shape of a factory create that did not create the DAO (C-T15c): the tx's own status is SuccessValue
 * base64(`false`) (on_create's return), and the batch receipt to the DAO account failed (here: the name was taken).
 * Built from LANDED: its first receipt (the factory call) spawns the batch and the callback; the gas refund stays.
 */
function factoryFailed(dao: string): { body: string; exp: string } {
  const json = JSON.parse(LANDED);
  const r = json.result;
  r.status = { SuccessValue: Buffer.from("false").toString("base64") };
  const [call, refund] = r.receipts_outcome;
  const batch = structuredClone(refund);
  batch.id = BATCH_RECEIPT;
  batch.outcome.executor_id = dao;
  batch.outcome.receipt_ids = [];
  batch.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountAlreadyExists: { account_id: dao } } } } };
  const callback = structuredClone(refund);
  callback.id = CALLBACK_RECEIPT;
  callback.outcome.executor_id = "sputnik-v2.testnet";
  callback.outcome.receipt_ids = [];
  callback.outcome.status = { SuccessValue: Buffer.from("false").toString("base64") };
  call.outcome.receipt_ids = [BATCH_RECEIPT, CALLBACK_RECEIPT, refund.id];
  r.receipts_outcome = [call, batch, callback, refund];
  const body = JSON.stringify(json);
  // EXPERIMENTAL_tx_status: the batch was sent by the factory (a contract), so it is no gas refund to the signer.
  const receipts = [{ predecessor_id: "sputnik-v2.testnet", receiver_id: dao, receipt_id: BATCH_RECEIPT, receipt: { Action: { signer_id: OP, actions: [] } } }];
  const exp = JSON.stringify({ ...json, result: { ...r, receipts } });
  return { body, exp };
}
/** An earlier DAO create's hash (public sample value). */
const H0 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const UNKNOWN_TX =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"requested_transaction_hash":"x"},"name":"UNKNOWN_TRANSACTION"},"code":-32000,"message":"Server error","data":"Transaction x doesn\'t exist"},"id":"p"}';

const OP = "kh-op-1a2b.testnet";
const SEAT = `seat.${OP}`;
const COSIGNER = `cosigner.${OP}`;
const GRANTEE = `grantee.${OP}`;
const PIN = "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq";
const NO_CODE = "11111111111111111111111111111111";
const B58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** A view_account reply. */
const account = (amountYocto: bigint, codeHash = NO_CODE) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: "x",
    result: { amount: amountYocto.toString(), block_hash: "x", block_height: 1, code_hash: codeHash, locked: "0", storage_paid_at: 0, storage_usage: 182 },
  });
/** view_account for an account that does not exist (UNKNOWN_ACCOUNT, as nearcore 2.x sends it). */
const noAccount = (id: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: "x",
    error: {
      name: "HANDLER_ERROR",
      cause: { info: { requested_account_id: id, block_hash: "x", block_height: 1 }, name: "UNKNOWN_ACCOUNT" },
      code: -32000,
      message: "Server error",
      data: `account ${id} does not exist while viewing`,
    },
  });
/** A call_function reply carrying `value` as its result bytes. */
const viewBody = (value: unknown) => JSON.stringify({ jsonrpc: "2.0", id: "x", result: { block_hash: "x", block_height: 1, logs: [], result: [...Buffer.from(JSON.stringify(value))] } });
/** get_policy of a DAO the factory created from the pack's init args; the contract lists the Group sorted. */
const policyBody = (seat: string, cosigner: string, threshold: unknown = [1, 2]) => {
  const policy = structuredClone(councilInitArgs(pack, seat, cosigner).policy) as any;
  policy.roles[1].kind.Group = [seat, cosigner].sort();
  policy.default_vote_policy.threshold = threshold;
  return viewBody(policy);
};
const methods = (log: ReplayedRequest[]) => log.map((r) => (r.method === "query" ? `query:${r.params.request_type}` : r.method));
const signedTx = (r: ReplayedRequest) => decodeSignedTransaction(Buffer.from(r.params.signed_tx_base64, "base64")).transaction;
const keyText = (pk: { ed25519Key?: { data: ArrayLike<number> } }) => `ed25519:${baseEncode(Uint8Array.from(pk.ed25519Key?.data ?? []))}`;
const keyFiles = (env: { KEYHOLE_CREDENTIALS_DIR: string }) => {
  const dir = join(env.KEYHOLE_CREDENTIALS_DIR, "testnet");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const pack: TargetPack = await loadTargetPack("sputnik-v2");
let urls = 0;
let env: ReturnType<typeof tmpEnv> & { KEYHOLE_OPERATOR: string };

beforeEach(() => {
  useRpcUrl("testnet", `http://testnet-setup-${++urls}.replay.invalid`); // assertChain remembers a check per URL: one status read per test
  env = { ...tmpEnv(), KEYHOLE_OPERATOR: OP };
});

function stateFor(dao = "kh-1a2b.sputnik-v2.testnet"): TestnetDemoState {
  return {
    operator: OP,
    seat: SEAT,
    cosigner: COSIGNER,
    grantee: GRANTEE,
    dao,
    daoCreateTx: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    daoCreatedAt: "2026-11-06T18:00:00.000Z",
    otherDao: "genesis.sputnik-v2.testnet",
    attacker: `attacker.${OP}`,
  };
}

function writeState(state: TestnetDemoState): string {
  mkdirSync(env.KEYHOLE_HOME, { recursive: true });
  const path = join(env.KEYHOLE_HOME, "testnet-demo.json");
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

const pendingFile = () => join(env.KEYHOLE_HOME, "testnet-demo.pending.json");
/** The pending DAO record as it is on disk now, or null. */
const readPendingFile = (): any => (existsSync(pendingFile()) ? JSON.parse(readFileSync(pendingFile(), "utf8")) : null);
function writePending(record: Record<string, unknown>): void {
  mkdirSync(env.KEYHOLE_HOME, { recursive: true });
  writeFileSync(pendingFile(), JSON.stringify(record));
}

/** This operator's pending record for kh-beef, with `extra` merged in. */
const pendingFor = (extra: Record<string, unknown> = {}) => ({ operator: OP, dao: "kh-beef.sputnik-v2.testnet", seat: SEAT, cosigner: COSIGNER, recordedAt: "2026-11-06T18:00:00.000Z", ...extra });

/** Wraps the replay: at each factory create send_tx, records the pending file as it is on disk at that moment. */
function spyPendingAtSend(): any[] {
  const seen: any[] = [];
  const replay = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = JSON.parse(String(init?.body));
    if (req.method === "send_tx" && signedTx({ url: "", method: req.method, params: req.params }).receiverId === "sputnik-v2.testnet") seen.push(readPendingFile());
    return replay(input, init);
  };
  return seen;
}

/** No send_tx in the log, and no state file on disk. */
function expectNothingSentOrWritten(log: ReplayedRequest[]): void {
  expect(methods(log)).not.toContain("send_tx");
  expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.json"))).toBe(false);
}

/** Saves an in-memory full-access key for `id` into the test keychain; returns it. */
function keyFor(id: string): KeyPair {
  const kp = KeyPair.fromRandom("ed25519");
  saveAccountKey("testnet", id, kp, env);
  return kp;
}

it("the factory fixtures carry their value in the tx's own status, which successValue reads", () => {
  expect(JSON.parse(FACTORY_LANDED).result.status).toEqual({ SuccessValue: "dHJ1ZQ==" });
  expect(JSON.parse(FACTORY_FALSE).result.status).toEqual({ SuccessValue: "ZmFsc2U=" });
  expect(JSON.parse(FACTORY_LANDED).result.receipts_outcome).toEqual(JSON.parse(LANDED).result.receipts_outcome);
  // C-T15c: the real failure shape returns false too, with its batch receipt failed.
  const failed = JSON.parse(factoryFailed("kh-beef.sputnik-v2.testnet").body).result;
  expect(failed.status).toEqual({ SuccessValue: "ZmFsc2U=" });
  expect(failed.receipts_outcome.filter((o: any) => "Failure" in o.outcome.status).map((o: any) => o.id)).toEqual([BATCH_RECEIPT]);
});

describe("factoryCreateArgs", () => {
  it("names the DAO and carries the council init args as base64 JSON (councilInitArgs, no second copy)", () => {
    expect(factoryCreateArgs(pack, "kh-1a2b", "seat.op.testnet", "cosigner.op.testnet").name).toBe("kh-1a2b");
    const args = JSON.parse(Buffer.from(factoryCreateArgs(pack, "kh-1a2b", "s.testnet", "c.testnet").args, "base64").toString());
    expect(args.policy.roles[1].kind.Group).toEqual(["s.testnet", "c.testnet"]);
    expect(args).toEqual(councilInitArgs(pack, "s.testnet", "c.testnet"));
  });
});

describe("ensureTestnetDemo", () => {
  it.each([["alice.near"], [""], [undefined], ["op.sandbox"]])("refuses KEYHOLE_OPERATOR=%j before any RPC", async (op) => {
    const log = replayFetch({});
    const bad = { ...env, KEYHOLE_OPERATOR: op } as NodeJS.ProcessEnv;
    await expect(ensureTestnetDemo(bad)).rejects.toThrow(EnvironmentError);
    await expect(ensureTestnetDemo(bad)).rejects.toThrow("set KEYHOLE_OPERATOR=<account>.testnet · its full-access key must be in ~/.near-credentials/testnet/<account>.json");
    expect(log).toEqual([]);
  });

  it("balance gate refuses below 6.6 NEAR without sending", async () => {
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR) });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).line()).toBe(
      `ERROR (environment): operator ${OP} has 5.00 NEAR; the first testnet run needs ≈6.6 NEAR (DAO code storage ≈4.7) · fund a second faucet account and transfer, or run: npm run keyhole -- demo --sandbox`,
    );
    expect(methods(log)).toEqual(["status", "query:view_account"]);
    expect(log[1].params).toMatchObject({ account_id: OP, finality: "final" });
    expect(methods(log)).not.toContain("send_tx");
    expect(keyFiles(env)).toEqual([]);
  });

  it("6.6 NEAR passes the gate; a missing operator key then stops the run before any key is written or sent", async () => {
    const log = replayFetch({ status: STATUS, "query:view_account": [account((66n * NEAR) / 10n), noAccount(SEAT), noAccount(COSIGNER), noAccount(GRANTEE)] });
    await expect(ensureTestnetDemo(env)).rejects.toThrow(`no full-access key for ${OP}`);
    expect(methods(log)).not.toContain("send_tx");
    expect(keyFiles(env)).toEqual([]);
  });

  it("an existing state file is reused without any send_tx", async () => {
    const state = stateFor();
    writeState(state);
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, COSIGNER) });
    const lines: string[] = [];
    expect(await ensureTestnetDemo(env, { log: (l) => lines.push(l) })).toEqual({ state, created: false });
    expect(methods(log)).toEqual(["status", "query:view_account", "query:call_function"]);
    expect(log[1].params.account_id).toBe(state.dao);
    expect(log[2].params).toMatchObject({ account_id: state.dao, method_name: "get_policy" });
    expect(lines.join("\n")).toContain(`DAO ${state.dao} · code_hash ${PIN} · council [${SEAT}, ${COSIGNER}] · 2-of-2`);
  });

  it.each([
    ["its DAO is gone", noAccount("kh-1a2b.sputnik-v2.testnet"), null],
    ["its DAO runs other code", account(5n * NEAR, "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH"), null],
    ["its council is someone else", account(5n * NEAR, PIN), policyBody(SEAT, "mallory.testnet")],
    ["its DAO is 1-of-2", account(5n * NEAR, PIN), policyBody(SEAT, COSIGNER, "1")],
  ])("a state file is not reused when %s: the run goes on to the balance gate", async (_why, daoAccount, policy) => {
    writeState(stateFor());
    const bodies: Record<string, string | string[]> = { status: STATUS, "query:view_account": [daoAccount, account(5n * NEAR)] };
    if (policy) bodies["query:call_function"] = policy;
    const log = replayFetch(bodies);
    await expect(ensureTestnetDemo(env)).rejects.toThrow(/≈6\.6 NEAR/);
    expect(methods(log)).not.toContain("send_tx");
  });

  it("C-T15a: a state file for another operator is never reused or overwritten: an EnvironmentError before any other read", async () => {
    const path = writeState({ ...stateFor(), operator: "someone-else.testnet" });
    const before = readFileSync(path, "utf8");
    const log = replayFetch({ status: STATUS, "query:view_account": account(10n * NEAR) });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`${path} records operator someone-else.testnet's demo DAO kh-1a2b.sputnik-v2.testnet; it is never overwritten`);
    expect((err as EnvironmentError).tryThis).toBe(
      `set KEYHOLE_OPERATOR=someone-else.testnet to reuse it, or move it aside (e.g. to testnet-demo.someone-else.testnet.json) to bootstrap ${OP} (≈6.6 NEAR: the demo accounts and a new DAO)`,
    );
    expect(methods(log)).toEqual(["status"]); // not even the gate: nothing is read, written or sent
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readPendingFile()).toBeNull();
  });

  it("C-T15a: a state file of this operator's whose demo accounts are not its own is refused the same way, and kept", async () => {
    const path = writeState({ ...stateFor(), seat: "seat.someone-else.testnet" });
    const before = readFileSync(path, "utf8");
    const log = replayFetch({ status: STATUS, "query:view_account": account(10n * NEAR) });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`${path} names demo accounts that are not ${OP}'s; it is never overwritten`);
    expect((err as EnvironmentError).tryThis).toBe(`restore it, or move it aside to bootstrap ${OP} again (≈6.6 NEAR: the demo accounts and a new DAO)`);
    expect(methods(log)).toEqual(["status"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("creates seat, cosigner and grantee, then the DAO; each key is saved (0600) before its send", async () => {
    const opKey = keyFor(OP);
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [account(10n * NEAR), noAccount(SEAT), noAccount(COSIGNER), noAccount(GRANTEE), noAccount("kh-name"), account(5n * NEAR, PIN)],
      "query:view_access_key": NONCE,
      "query:call_function": policyBody(SEAT, COSIGNER),
      send_tx: [LANDED, LANDED, LANDED, FACTORY_LANDED],
    });
    const replay = globalThis.fetch;
    const keysAtSend: string[][] = [];
    let pendingAtCreate: any = "no factory send seen";
    globalThis.fetch = async (input, init) => {
      const req = JSON.parse(String(init?.body));
      if (req.method === "send_tx") {
        keysAtSend.push(keyFiles(env));
        if (signedTx({ url: "", method: req.method, params: req.params }).receiverId === "sputnik-v2.testnet") pendingAtCreate = readPendingFile();
      }
      return replay(input, init);
    };
    const lines: string[] = [];
    const { state, created } = await ensureTestnetDemo(env, { log: (l) => lines.push(l) });

    expect(created).toBe(true);
    // The DAO name was on disk before the factory create left: a run killed during that send_tx (SIGINT, no catch)
    // leaves the record, so the next run adopts or re-creates that name and never spends 5 NEAR on a second DAO.
    expect(pendingAtCreate).toMatchObject({ operator: OP, dao: `${state.dao}`, seat: SEAT, cosigner: COSIGNER });
    expect(pendingAtCreate.txHash).toBeUndefined();
    expect(pendingAtCreate.priorTxHash).toBeUndefined();
    const sends = log.filter((r) => r.method === "send_tx").map(signedTx);
    expect(sends).toHaveLength(4);
    // Accounts: [CreateAccount, Transfer(funding), AddKey(full access, the key saved in the keychain)] from the operator.
    for (const [i, [id, funding]] of ([[SEAT, NEAR / 2n], [COSIGNER, NEAR], [GRANTEE, NEAR / 20n]] as const).entries()) {
      const tx = sends[i];
      expect(tx.signerId).toBe(OP);
      expect(tx.publicKey.toString()).toBe(opKey.getPublicKey().toString());
      expect(tx.receiverId).toBe(id);
      expect(tx.actions.map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "addKey"]);
      expect(tx.actions[1].transfer?.deposit).toBe(funding);
      const addKey = (tx.actions[2] as any).addKey;
      expect(Object.keys(addKey.accessKey.permission)).toEqual(["fullAccess"]);
      expect(keyText(addKey.publicKey)).toBe(loadFullAccessKey("testnet", id, env).getPublicKey().toString());
      expect(keysAtSend[i]).toContain(`${id}.json`); // saved before its send
      expect(statSync(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", `${id}.json`)).mode & 0o777).toBe(0o600);
    }
    // The DAO: the factory's create(name, base64 council args), 5 NEAR, 300 TGas.
    const dao = sends[3];
    expect(dao.receiverId).toBe("sputnik-v2.testnet");
    expect(dao.actions).toHaveLength(1);
    const fc = dao.actions[0].functionCall;
    expect(fc?.methodName).toBe("create");
    expect(fc?.gas).toBe(300n * TGAS);
    expect(fc?.deposit).toBe(5n * NEAR);
    const args = JSON.parse(Buffer.from(fc?.args ?? []).toString("utf8"));
    expect(args.name).toMatch(/^kh-[0-9a-f]{4}$/);
    expect(args).toEqual(factoryCreateArgs(pack, args.name, SEAT, COSIGNER));
    expect(pendingAtCreate.dao).toBe(`${args.name}.sputnik-v2.testnet`);
    // The name was checked unused, and the new DAO verified, before the state was written.
    const views = log.filter((r) => r.params?.request_type === "view_account").map((r) => r.params.account_id);
    expect(views).toEqual([OP, SEAT, COSIGNER, GRANTEE, `${args.name}.sputnik-v2.testnet`, `${args.name}.sputnik-v2.testnet`]);

    expect(state).toEqual({
      operator: OP,
      seat: SEAT,
      cosigner: COSIGNER,
      grantee: GRANTEE,
      dao: `${args.name}.sputnik-v2.testnet`,
      daoCreateTx: expect.stringMatching(B58_HASH),
      daoCreatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      otherDao: "genesis.sputnik-v2.testnet",
      attacker: `attacker.${OP}`,
    });
    const raw = readFileSync(join(env.KEYHOLE_HOME, "testnet-demo.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(state);
    expect(raw).not.toMatch(/private|secret|ed25519:/); // public data only
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.pending.json"))).toBe(false);

    expect(lines.filter((l) => l.startsWith("created "))).toEqual([
      expect.stringMatching(new RegExp(`^created ${SEAT.replace(/\./g, "\\.")} · 0\\.50 NEAR · tx [1-9A-HJ-NP-Za-km-z]{43,44}$`)),
      expect.stringMatching(new RegExp(`^created ${COSIGNER.replace(/\./g, "\\.")} · 1\\.00 NEAR · tx [1-9A-HJ-NP-Za-km-z]{43,44}$`)),
      expect.stringMatching(new RegExp(`^created ${GRANTEE.replace(/\./g, "\\.")} · 0\\.05 NEAR · tx [1-9A-HJ-NP-Za-km-z]{43,44}$`)),
    ]);
    expect(lines).toContain(`DAO ${state.dao} created · tx ${state.daoCreateTx}`);
    expect(lines.join("\n")).not.toMatch(/private|ed25519:/);
  });

  it("an existing demo account whose key is not in the keychain is refused before anything is sent", async () => {
    const log = replayFetch({ status: STATUS, "query:view_account": [account(10n * NEAR), account(NEAR / 2n)] });
    await expect(ensureTestnetDemo(env)).rejects.toThrow(new RegExp(`${SEAT.replace(/\./g, "\\.")} exists on testnet, but its full-access key is not in`));
    expect(methods(log)).not.toContain("send_tx");
    expect(keyFiles(env)).toEqual([]);
  });

  it("an account send whose fate is unknown stops the run: one send_tx, its key kept, no state", async () => {
    keyFor(OP);
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [account(10n * NEAR), noAccount(SEAT), noAccount(COSIGNER), noAccount(GRANTEE)],
      "query:view_access_key": NONCE,
      send_tx: TIMEOUT,
      tx: UNKNOWN_TX,
    });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect(methods(log).filter((m) => m === "send_tx")).toHaveLength(1);
    expect((err as SendFateUnknownError).txHash).toMatch(B58_HASH);
    expect(keyFiles(env)).toContain(`${SEAT}.json`);
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.json"))).toBe(false);
  });

  it("a DAO create whose fate is unknown is never re-sent; the next run adopts that DAO without a send", async () => {
    keyFor(OP);
    for (const id of [SEAT, COSIGNER, GRANTEE]) keyFor(id);
    const first = replayFetch({
      status: STATUS,
      "query:view_account": [account(10n * NEAR), account(NEAR / 2n), account(NEAR), account(NEAR / 20n), noAccount("kh-name")],
      "query:view_access_key": NONCE,
      send_tx: TIMEOUT,
      tx: UNKNOWN_TX,
    });
    const lines: string[] = [];
    const err = await ensureTestnetDemo(env, { log: (l) => lines.push(l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect(lines.filter((l) => l.startsWith("reused "))).toHaveLength(3); // the three accounts existed with their keys
    expect(methods(first).filter((m) => m === "send_tx")).toHaveLength(1);
    const name = JSON.parse(Buffer.from(signedTx(first.find((r) => r.method === "send_tx") as ReplayedRequest).actions[0].functionCall?.args ?? []).toString()).name;
    const pending = JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "testnet-demo.pending.json"), "utf8"));
    expect(pending).toMatchObject({ operator: OP, dao: `${name}.sputnik-v2.testnet`, txHash: (err as SendFateUnknownError).txHash });
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.json"))).toBe(false);

    useRpcUrl("testnet", `http://testnet-setup-${++urls}.replay.invalid`);
    const second = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, COSIGNER) });
    const { state, created } = await ensureTestnetDemo(env);
    expect(created).toBe(false);
    expect(state.dao).toBe(`${name}.sputnik-v2.testnet`);
    expect(state.daoCreateTx).toBe((err as SendFateUnknownError).txHash);
    expect(methods(second)).toEqual(["status", "query:view_account", "query:call_function"]);
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "testnet-demo.json"), "utf8"))).toEqual(state);
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.pending.json"))).toBe(false);
  });

  it("a DAO create that did not land is retried under the same recorded name, never a new one; the old hash is only priorTxHash", async () => {
    keyFor(OP);
    for (const id of [SEAT, COSIGNER, GRANTEE]) keyFor(id);
    const dao = "kh-beef.sputnik-v2.testnet";
    writePending({ operator: OP, dao, seat: SEAT, cosigner: COSIGNER, recordedAt: "2026-11-06T18:00:00.000Z", txHash: H0 });
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [noAccount(dao), account(10n * NEAR), account(NEAR / 2n), account(NEAR), account(NEAR / 20n), account(5n * NEAR, PIN)],
      "query:view_access_key": NONCE,
      "query:call_function": policyBody(SEAT, COSIGNER),
      send_tx: FACTORY_LANDED,
    });
    const pendingAtSend = spyPendingAtSend();
    const { state, created } = await ensureTestnetDemo(env);
    expect(created).toBe(true);
    expect(state.dao).toBe(dao);
    const sends = log.filter((r) => r.method === "send_tx").map(signedTx);
    expect(sends).toHaveLength(1);
    expect(JSON.parse(Buffer.from(sends[0].actions[0].functionCall?.args ?? []).toString()).name).toBe("kh-beef");
    // While the re-create was in flight, the earlier tx (which did not create the DAO) was never the record's txHash:
    // a run killed then must not adopt the DAO under H0.
    expect(pendingAtSend).toHaveLength(1);
    expect(pendingAtSend[0]).toMatchObject({ dao, priorTxHash: H0 });
    expect(pendingAtSend[0].txHash).toBeUndefined();
    expect(state.daoCreateTx).toMatch(B58_HASH);
    expect(state.daoCreateTx).not.toBe(H0);
  });

  // Pending-record recovery paths: each one sends nothing and writes no state file.

  it("a pending DAO that exists but runs other code is an EnvironmentError (B)", async () => {
    writePending(pendingFor({ txHash: H0 }));
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH") });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(/^DAO kh-beef\.sputnik-v2\.testnet \(named before its create was sent\) exists, but its code_hash is AA4nA45v/);
    expect((err as EnvironmentError).tryThis).toMatch(/another 5 NEAR/);
    expectNothingSentOrWritten(log);
    expect(readPendingFile()).toEqual(pendingFor({ txHash: H0 })); // kept as it was
  });

  it("a pending DAO that verifies but has no recorded create tx is an EnvironmentError: first add the hash, or pay 5 NEAR for a new DAO (C)", async () => {
    writePending(pendingFor());
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, COSIGNER) });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe("DAO kh-beef.sputnik-v2.testnet exists and verifies, but its create tx was never recorded");
    expect((err as EnvironmentError).tryThis).toBe(
      `add its create tx as "txHash" in ${pendingFile()} and run again; or remove that file to create a new demo DAO (another 5 NEAR)`,
    );
    expectNothingSentOrWritten(log);
  });

  // C-T15b: two creates of the pending name went out with unknown fates (txHash, and the earlier priorTxHash).
  const H1 = "4pWxvXQ3LyjzAmP9JUvH6m1Rr9Vd5wEf6hbM2SnKcY8T";
  it("C-T15b: a verified DAO with two unconfirmed creates is adopted under txHash only after one tx read shows it returned true", async () => {
    writePending(pendingFor({ txHash: H1, priorTxHash: H0 }));
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, COSIGNER), tx: FACTORY_LANDED });
    const { state, created } = await ensureTestnetDemo(env);
    expect(created).toBe(false);
    expect(state.daoCreateTx).toBe(H1);
    expect(methods(log)).toEqual(["status", "query:view_account", "query:call_function", "tx"]);
    expect(log[3].params).toEqual({ tx_hash: H1, sender_account_id: OP, wait_until: "FINAL" });
    expect(methods(log)).not.toContain("send_tx");
    expect(readPendingFile()).toBeNull();
  });

  it.each([
    ["the factory returned false, every receipt succeeding (synthetic)", () => FACTORY_FALSE, "the factory did not return true"],
    ["its batch receipt failed and the factory returned false (the real shape)", () => factoryFailed("kh-beef.sputnik-v2.testnet").body, "it failed in a block"],
    ["the node does not know the tx", () => UNKNOWN_TX, "reading it failed: UNKNOWN_TRANSACTION"],
    // Fix round 1 (Minor 3): the read itself throws (rpcCall: a non-JSON answer, never retried); a failed read is a why.
    ["the read itself fails (a non-JSON answer)", () => "<html>502 Bad Gateway</html>", "reading it failed: RPC \\S+ returned non-JSON for tx \\(HTTP 200\\)"],
  ])("C-T15b: with two unconfirmed creates, a txHash whose read is not 'returned true' (%s) is never adopted", async (_what, body, why) => {
    writePending(pendingFor({ txHash: H1, priorTxHash: H0 }));
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, COSIGNER), tx: body() });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(
      new RegExp(`^DAO kh-beef\\.sputnik-v2\\.testnet exists and verifies, but its recorded create tx ${H1} did not make it \\(${why}.*\\); an earlier create of this name, tx ${H0}, may be the one$`),
    );
    expect((err as EnvironmentError).tryThis).toBe(
      `look both txs up on chain, put the one that returned true as "txHash" in ${pendingFile()} and remove "priorTxHash", then run again; or remove that file to create a new demo DAO (another 5 NEAR)`,
    );
    expect(methods(log).filter((m) => m === "tx")).toHaveLength(1);
    expectNothingSentOrWritten(log);
    expect(readPendingFile()).toEqual(pendingFor({ txHash: H1, priorTxHash: H0 })); // kept as it was
  });

  it("a pending DAO with only an earlier, unconfirmed tx (priorTxHash) is never adopted under that hash", async () => {
    writePending(pendingFor({ priorTxHash: H0 }));
    const log = replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, COSIGNER) });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(
      `DAO kh-beef.sputnik-v2.testnet exists and verifies, but its create tx was never recorded (an earlier create of this name, tx ${H0}, may or may not be it)`,
    );
    expect((err as EnvironmentError).tryThis).toMatch(/^add its create tx as "txHash" in /);
    expectNothingSentOrWritten(log);
  });

  it("a newly created DAO that does not verify is an EnvironmentError; the pending record keeps its create tx (G)", async () => {
    keyFor(OP);
    for (const id of [SEAT, COSIGNER, GRANTEE]) keyFor(id);
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [account(10n * NEAR), account(NEAR / 2n), account(NEAR), account(NEAR / 20n), noAccount("kh-name"), account(5n * NEAR, PIN)],
      "query:view_access_key": NONCE,
      "query:call_function": policyBody(SEAT, "mallory.testnet"),
      send_tx: FACTORY_LANDED,
    });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    const pending = readPendingFile();
    expect(pending.txHash).toMatch(B58_HASH);
    expect((err as EnvironmentError).what).toBe(`DAO ${pending.dao} was created (tx ${pending.txHash}), but its council is [mallory.testnet, ${SEAT}], not [${SEAT}, ${COSIGNER}]`);
    expect(methods(log).filter((m) => m === "send_tx")).toHaveLength(1); // the create only; nothing after it
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.json"))).toBe(false);
  });

  it("a reused account whose keychain key is not on chain is an EnvironmentError before any send (D)", async () => {
    keyFor(SEAT);
    const log = replayFetch({ status: STATUS, "query:view_account": [account(10n * NEAR), account(NEAR / 2n)], "query:view_access_key": NO_SUCH_KEY });
    await expect(ensureTestnetDemo(env)).rejects.toThrow(new RegExp(`^${SEAT.replace(/\./g, "\\.")} exists on testnet, but the key in the keychain \\(ed25519:\\w+\\) is not on it`));
    expectNothingSentOrWritten(log);
  });

  it("a factory create that returns false is an EnvironmentError, and no state is written (F)", async () => {
    keyFor(OP);
    for (const id of [SEAT, COSIGNER, GRANTEE]) keyFor(id);
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [account(10n * NEAR), account(NEAR / 2n), account(NEAR), account(NEAR / 20n), noAccount("kh-name"), account(5n * NEAR, PIN)],
      "query:view_access_key": NONCE,
      "query:call_function": policyBody(SEAT, COSIGNER),
      send_tx: FACTORY_FALSE,
    });
    await expect(ensureTestnetDemo(env)).rejects.toThrow(/^sputnik-v2\.testnet create kh-[0-9a-f]{4} returned false: the DAO was not created/);
    expect(methods(log).filter((m) => m === "send_tx")).toHaveLength(1);
    expect(methods(log)).not.toContain("query:call_function"); // never verified as if created
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.json"))).toBe(false);
  });

  it("C-T15c: the factory's real failure shape (batch receipt Failure, SuccessValue false) fails in a block; the pending record stays, with no txHash", async () => {
    keyFor(OP);
    for (const id of [SEAT, COSIGNER, GRANTEE]) keyFor(id);
    const { body, exp } = factoryFailed("kh-name.sputnik-v2.testnet");
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [account(10n * NEAR), account(NEAR / 2n), account(NEAR), account(NEAR / 20n), noAccount("kh-name")],
      "query:view_access_key": NONCE,
      send_tx: body,
      EXPERIMENTAL_tx_status: exp,
    });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(new RegExp(`^create DAO kh-[0-9a-f]{4}\\.sputnik-v2\\.testnet through sputnik-v2\\.testnet: failed in a block: receipt ${BATCH_RECEIPT} Failure: .*AccountAlreadyExists`));
    expect((err as EnvironmentError).what).not.toContain("which failed receipts are gas refunds could not be read");
    expect(methods(log).filter((m) => m === "send_tx")).toHaveLength(1);
    expect(methods(log)).not.toContain("query:call_function"); // never verified as if created
    const pending = readPendingFile();
    expect(pending).toMatchObject({ operator: OP, seat: SEAT, cosigner: COSIGNER });
    expect(pending.dao).toMatch(/^kh-[0-9a-f]{4}\.sputnik-v2\.testnet$/);
    expect(pending.txHash).toBeUndefined(); // its fate is known (failed): the next run creates the same name again
    expect(existsSync(join(env.KEYHOLE_HOME, "testnet-demo.json"))).toBe(false);
  });

  it("another operator's pending DAO is an EnvironmentError naming it, and its record is left as it was (E)", async () => {
    const other = { operator: "kh-op-ffff.testnet", dao: "kh-beef.sputnik-v2.testnet", seat: "seat.kh-op-ffff.testnet", cosigner: "cosigner.kh-op-ffff.testnet", recordedAt: "2026-11-06T18:00:00.000Z", txHash: H0 };
    writePending(other);
    const log = replayFetch({ status: STATUS });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`${pendingFile()} records operator kh-op-ffff.testnet's DAO kh-beef.sputnik-v2.testnet, whose create was sent and not confirmed`);
    expect((err as EnvironmentError).tryThis).toBe(
      "finish it with that operator (KEYHOLE_OPERATOR=kh-op-ffff.testnet npm run bootstrap:testnet), or look that DAO up on chain and then remove the file deliberately",
    );
    expect(methods(log)).toEqual(["status"]);
    expect(readPendingFile()).toEqual(other);
  });

  it.each([
    ["a dao that is not kh-XXXX.sputnik-v2.testnet", { dao: "evil.near" }, `dao "evil.near" is not a kh-XXXX.sputnik-v2.testnet id`],
    ["a dao with a longer name", { dao: "kh-beef0.sputnik-v2.testnet" }, `dao "kh-beef0.sputnik-v2.testnet" is not a kh-XXXX.sputnik-v2.testnet id`],
    ["a seat that is not its operator's", { seat: "seat.someone.testnet" }, `seat and cosigner are not ${OP}'s demo accounts`],
    ["a txHash that is not a tx hash", { txHash: "not-a-hash" }, "txHash and priorTxHash must be base58 tx hashes"],
  ])("a pending record with %s is an EnvironmentError naming the file, before any read", async (_what, change, problem) => {
    writePending({ ...pendingFor(), ...change });
    const log = replayFetch({ status: STATUS });
    const err = await ensureTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`${pendingFile()}: ${problem}`);
    expect(methods(log)).toEqual(["status"]);
  });

  it.each([["verdict.testnet"], ["verdict-council-a.testnet"], ["sub.verdict.testnet"], ["kh-verdict.testnet"], ["kh_verdict.testnet"]])(
    "refuses a Verdict account as operator (%s) before any RPC (Q-015)",
    async (op) => {
      const log = replayFetch({});
      const bad = { ...env, KEYHOLE_OPERATOR: op };
      for (const run of [() => ensureTestnetDemo(bad), () => checkTestnetDemo(bad)]) {
        const err = await run().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EnvironmentError);
        expect((err as EnvironmentError).what).toBe(`KEYHOLE_OPERATOR ${op} is a Verdict account: Keyhole and Verdict share no accounts (Q-015)`);
      }
      expect(log).toEqual([]);
    },
  );
});

describe("checkTestnetDemo (bootstrap --check)", () => {
  it("prints the DAO line and the operator balance, and signs nothing", async () => {
    const state = stateFor();
    writeState(state);
    const log = replayFetch({
      status: STATUS,
      "query:view_account": [account(5n * NEAR, PIN), account(3_391_200_000_000_000_000_000_000n)],
      "query:call_function": policyBody(SEAT, COSIGNER),
    });
    const { line } = await checkTestnetDemo(env);
    expect(line).toBe(`DAO ${state.dao} · code_hash ${PIN} · council [${SEAT}, ${COSIGNER}] · 2-of-2 · operator balance 3.39 NEAR`);
    expect(methods(log)).toEqual(["status", "query:view_account", "query:call_function", "query:view_account"]);
    expect(log[3].params.account_id).toBe(OP);
  });

  it("with no state file it is an EnvironmentError that says to bootstrap and what that costs (C-T15d), after no read but status", async () => {
    const log = replayFetch({ status: STATUS });
    const err = await checkTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).tryThis).toBe("run: npm run bootstrap:testnet (≈6.6 NEAR: the demo accounts and a new DAO)");
    expect(methods(log)).toEqual(["status"]);
  });

  it("C-T15d: another operator's state names that operator and what a bootstrap for this one costs", async () => {
    const path = writeState({ ...stateFor(), operator: "someone-else.testnet" });
    replayFetch({ status: STATUS });
    const err = await checkTestnetDemo(env).catch((e: unknown) => e);
    expect((err as EnvironmentError).what).toBe(`${path} is operator someone-else.testnet's demo, not ${OP}'s`);
    expect((err as EnvironmentError).tryThis).toBe(
      `set KEYHOLE_OPERATOR=someone-else.testnet, or move that file aside and run: npm run bootstrap:testnet for ${OP} (≈6.6 NEAR: the demo accounts and a new DAO)`,
    );
  });

  it("the recorded sputnikdao2 v2.0.0 get_policy shape (spike 017: the pack's init args, as the contract returns them) verifies", async () => {
    const state = stateFor();
    writeState(state);
    // The spike's verbatim get_policy body for a DAO built from the same councilInitArgs the factory DAO got; only
    // the two sandbox account ids are swapped for this operator's (the bytes are otherwise unchanged).
    const recorded = JSON.parse(fx("017-b-get-policy.json"));
    const text = Buffer.from(recorded.result.result).toString("utf8").replaceAll("seat.sandbox", SEAT).replaceAll("cosigner.sandbox", COSIGNER);
    const policy = JSON.parse(text);
    expect(policy.roles.map((r: any) => [r.name, r.permissions.filter((p: string) => /Vote/.test(p)).length, r.vote_policy])).toEqual([
      ["all", 0, {}],
      ["council", 3, {}],
    ]); // the shape the reviewer saw live: no per-kind override, "all" may only AddProposal
    replayFetch({
      status: STATUS,
      "query:view_account": [account(5n * NEAR, PIN), account(3n * NEAR)],
      "query:call_function": JSON.stringify({ ...recorded, result: { ...recorded.result, result: [...Buffer.from(text)] } }),
    });
    expect((await checkTestnetDemo(env)).line).toBe(`DAO ${state.dao} · code_hash ${PIN} · council [${SEAT}, ${COSIGNER}] · 2-of-2 · operator balance 3.00 NEAR`);
  });

  /** policyBody's policy with `edit` applied. */
  const policyWith = (edit: (policy: any) => void) => {
    const policy = JSON.parse(Buffer.from(JSON.parse(policyBody(SEAT, COSIGNER)).result.result).toString("utf8"));
    edit(policy);
    return viewBody(policy);
  };

  it.each([
    [
      "a per-kind override on the council's vote_policy (transfer 1-of-2)",
      (p: any) => (p.roles[1].vote_policy = { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } }),
      "the council has per-kind vote policies (transfer): the demo needs 2-of-2 on every kind",
    ],
    ["the all role holding *:VoteApprove", (p: any) => p.roles[0].permissions.push("*:VoteApprove"), "role all can vote (*:VoteApprove): only the council may"],
    ["the all role holding a per-kind vote (transfer:VoteReject)", (p: any) => p.roles[0].permissions.push("transfer:VoteReject"), "role all can vote (transfer:VoteReject): only the council may"],
    ["the all role holding *:*", (p: any) => p.roles[0].permissions.push("*:*"), "role all can vote (*:*): only the council may"],
    [
      "a third role that can vote",
      (p: any) => p.roles.push({ name: "shadow", kind: { Group: ["mallory.testnet"] }, permissions: ["*:VoteApprove"], vote_policy: {} }),
      "role shadow can vote (*:VoteApprove): only the council may",
    ],
  ])("a DAO with %s does not verify (bootstrap and --check share verifyDao)", async (_what, edit, why) => {
    const state = stateFor();
    writeState(state);
    replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyWith(edit) });
    const err = await checkTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`DAO ${state.dao} does not verify: ${why}`);
    // The bootstrap's reuse check is the same verifyDao: the state is not reused, and the run goes on to the gate.
    useRpcUrl("testnet", `http://testnet-setup-${++urls}.replay.invalid`);
    const log = replayFetch({ status: STATUS, "query:view_account": [account(5n * NEAR, PIN), account(5n * NEAR)], "query:call_function": policyWith(edit) });
    const lines: string[] = [];
    await expect(ensureTestnetDemo(env, { log: (l) => lines.push(l) })).rejects.toThrow(/≈6\.6 NEAR/);
    expect(lines[0]).toContain(`no longer verifies (${why})`);
    expect(methods(log)).not.toContain("send_tx");
  });

  it("a DAO that no longer verifies is an EnvironmentError whose hint says a new demo DAO costs another 5 NEAR (C-T15d)", async () => {
    writeState(stateFor());
    replayFetch({ status: STATUS, "query:view_account": account(5n * NEAR, PIN), "query:call_function": policyBody(SEAT, "mallory.testnet") });
    const err = await checkTestnetDemo(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).tryThis).toBe("run: npm run bootstrap:testnet (it creates a new demo DAO: another 5 NEAR)");
  });
});
