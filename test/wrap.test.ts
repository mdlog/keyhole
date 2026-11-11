/**
 * src/core/wrap.ts offline (Task 4): planWrap, signWrap and sessionFromPlan against committed sandbox RPC
 * bodies (replayFetch), with a fake classifier. Task 10's classifyTools (the default `deps.classify`) is not
 * built yet, so every test injects `fake`: it returns the 4 Sputnik ToolSchemas classifyTools returns for the
 * hero scope (the pack's two views unclassified, dao_vote callable, add_proposal `not in allowlist`).
 *
 * Keys are generated in memory and written only under tmpEnv() dirs. No assertion prints a private key: key
 * checks compare booleans, never values.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, baseEncode, decodeSignedTransaction } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { classifyTools } from "../src/classify/dry-run.js";
import { SUBACCOUNT_RESERVE, formatNear } from "../src/core/amounts.js";
import { useRpcUrl } from "../src/core/config.js";
import { fullAccessKeyLoadCount, saveAccountKey, sessionKeyPath } from "../src/core/credentials.js";
import { EXIT_TX_SENT, EnvironmentError, InputError } from "../src/core/errors.js";
import { dropHeldKeys, heldPrivateKeyCount, sessionKeyPair } from "../src/core/keys.js";
import { NO_CODE_HASH } from "../src/core/rpc.js";
import * as sessionModule from "../src/core/session.js";
import type { SandboxHandle } from "../src/core/sandbox.js";
import { SendFateUnknownError, mustSucceed } from "../src/core/tx.js";
import type { Session, TargetPack, ToolSchema, WrapOptions, WrapPlan } from "../src/core/types.js";
import { planWrap, sessionFromPlan, signWrap } from "../src/core/wrap.js";
import * as packs from "../src/packs/index.js";
import { MAINNET_OUT_OF_SCOPE, noTools, warnInconclusive, warnRuntime } from "../src/render/strings.js";
import { displayWidth } from "../src/render/style.js";
import { NEGATIVE_CONTROL_FIXTURES, type ReplayedRequest, SANDBOX_FIXTURES, readFixture, replayFetch, sampleCageCard, tmpEnv } from "./helpers.js";

// Spies over the real modules: newSessionId (the R2b re-roll), saveSession (its order against the send), and
// pack selection (R17a near-abi). Each mock calls the real function unless a test says otherwise.
vi.mock("../src/core/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/session.js")>();
  return { ...actual, newSessionId: vi.fn(actual.newSessionId), saveSession: vi.fn(actual.saveSession) };
});
vi.mock("../src/packs/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packs/index.js")>();
  return { ...actual, packForCodeHash: vi.fn(actual.packForCodeHash), loadTargetPack: vi.fn(actual.loadTargetPack) };
});
// mustSucceed: real, except where a test reaches signWrap's last catch (a reply sendSigned does not return today).
vi.mock("../src/core/tx.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/tx.js")>();
  return { ...actual, mustSucceed: vi.fn(actual.mustSucceed) };
});
const realSession = await vi.importActual<typeof import("../src/core/session.js")>("../src/core/session.js");
const realPacks = await vi.importActual<typeof import("../src/packs/index.js")>("../src/packs/index.js");

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
const PIN = "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq";
const STATUS = fx("001-0-status.json");
const MAINNET_STATUS = STATUS.replace('"chain_id":"test-chain-FSZ71"', '"chain_id":"mainnet"');
/** view_account of dao.sandbox: the vendored Sputnik v2 code. */
const DAO_ACCOUNT = fx("015-b-view-dao-account.json");
/** view_account of a plain account (the spike's grantee): code_hash NO_CODE_HASH. */
const NO_CODE_ACCOUNT = fx("030-e-grantee-balance-before.json");
/** The DAO's body with code no pack pins. */
const OTHER_CODE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER_CODE_ACCOUNT = DAO_ACCOUNT.replace(PIN, OTHER_CODE);
/** C-T20c: the default DAO code of the maintained sputnikv2.testnet factory (v3.31), which pack sputnik-v2-331 pins. */
const V331 = "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH";
/** Every pack in src/packs, as the refusal names them. */
const PACK_IDS = ["counter", "sputnik-v2", "sputnik-v2-331"];
const FULL_ACCESS = fx("022-d-add-fc-key.nonce.json");
const FC_KEY = fx("024-d-view-fc-key.json");
const NO_KEY = fx("070-i-view-burned-key.json");
const ADDKEY_LANDED = fx("023-d-add-fc-key.send_tx.json");
/** Refused at validation (InvalidTxError MethodNameMismatch): never in a block. */
const REFUSED = fx("052-g1-method-add_proposal.send_tx.json");
/** Landed and failed (ERR_MIN_BOND): in a block, its receipt reverted. */
const LANDED_FAILED = readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json");
/** An RPC error that says nothing about the tx: its fate is unknown. */
const INTERNAL_ERROR = '{"jsonrpc":"2.0","error":{"name":"INTERNAL_ERROR","cause":{"name":"INTERNAL_ERROR","info":{}},"code":-32000,"message":"Server error","data":"busy"},"id":"p"}';

const ALLOWANCE = "50000000000000000000000";
const opts: WrapOptions = { contract: "dao.sandbox", allow: ["act_proposal"], allowanceYocto: ALLOWANCE, onAccount: "seat.sandbox", network: "sandbox" };
const subOpts: WrapOptions = { ...opts, onAccount: undefined, operatorId: "sandbox" };

/** The 4 Sputnik ToolSchemas classifyTools returns for the hero scope. */
const heroTools = (): ToolSchema[] => sampleCageCard().tools;
const fake = vi.fn<typeof classifyTools>(async () => heroTools());
const d = { classify: fake };
/** A fake classifier that labels act_proposal (and only it) as given. */
const labelling = (classification: ToolSchema["classification"]) =>
  vi.fn<typeof classifyTools>(async () => heroTools().map((t) => (t.method === "act_proposal" ? { ...t, classification, evidence: "Smart contract panicked: ERR_X" } : t)));

let urls = 0;
beforeEach(() => {
  useRpcUrl("sandbox", `http://wrap-${++urls}.replay.invalid`); // assertChain remembers a check per URL
  fake.mockClear();
  vi.mocked(sessionModule.newSessionId).mockClear();
  vi.mocked(sessionModule.saveSession).mockClear();
  vi.mocked(packs.packForCodeHash).mockClear();
  vi.mocked(packs.loadTargetPack).mockClear();
});
afterEach(() => {
  dropHeldKeys();
  vi.unstubAllEnvs();
});

const PLAN_RPC = { status: STATUS, "query:view_account": DAO_ACCOUNT };
const SIGN_RPC = { status: STATUS, "query:view_account": DAO_ACCOUNT, "query:view_access_key": FULL_ACCESS, send_tx: ADDKEY_LANDED };

/** The one send_tx in a request log, decoded. */
function sentTx(log: ReplayedRequest[]) {
  const sends = log.filter((r) => r.method === "send_tx");
  expect(sends).toHaveLength(1);
  return decodeSignedTransaction(Buffer.from(sends[0].params.signed_tx_base64, "base64")).transaction;
}
/** A decoded borsh public key, as `ed25519:BASE58`. */
const keyText = (pk: { ed25519Key?: { data: ArrayLike<number> } }) => `ed25519:${baseEncode(Uint8Array.from(pk.ed25519Key?.data ?? []))}`;

/** A planned on-account wrap, and the seat's full-access key saved in a fresh tmpEnv() keychain. */
async function onAccountPlan() {
  replayFetch(PLAN_RPC);
  const plan = await planWrap(opts, d);
  const env = tmpEnv();
  const seatKey = KeyPair.fromRandom("ed25519");
  saveAccountKey("sandbox", "seat.sandbox", seatKey, env);
  return { plan, env, seatKey };
}

const sessionFile = (env: { KEYHOLE_HOME: string }, id: string) => join(env.KEYHOLE_HOME, "sessions", `${id}.json`);
/** Every file under a directory, recursively (relative paths). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

describe("planWrap", () => {
  it("on-account: pins the code hash, picks the pack by it, dry-runs, mints a held key, plans one AddKey (no key loaded)", async () => {
    const before = fullAccessKeyLoadCount();
    const held = heldPrivateKeyCount();
    const log = replayFetch(PLAN_RPC);
    const sb = { rpcUrl: "http://replay.invalid", rootId: "sandbox", stop: async () => {} } as SandboxHandle;

    const plan = await planWrap(opts, { classify: fake, sandbox: sb });

    expect(plan).toMatchObject({ signerId: "seat.sandbox", fundingYocto: null, warnings: [] });
    expect(plan.draft).toMatchObject({ mode: "on-account", accountId: "seat.sandbox", packId: "sputnik-v2", codeHashPin: "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq" });
    expect(plan.draft).toMatchObject({ network: "sandbox", receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowanceYocto: ALLOWANCE });
    expect(plan.draft.id).toMatch(/^ks-[0-9a-f]{4}$/);
    expect(plan.txActions).toHaveLength(1);
    expect(plan.txActions[0]).toMatch(/^\+ AddKey FunctionCall → seat\.sandbox · receiver dao\.sandbox · methods act_proposal · allowance 0\.0500 NEAR$/);
    expect(plan.txActions[0]).toBe("+ AddKey FunctionCall → seat.sandbox · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR");
    expect(fullAccessKeyLoadCount()).toBe(before); // planWrap loads no key
    // The tools are the classifier's, and the dry-run got the pack, the scope and the sandbox.
    expect(plan.tools).toEqual(heroTools());
    expect(plan.draft.tools).toEqual(heroTools());
    expect(fake).toHaveBeenCalledTimes(1);
    const [pack, scope, classifyOpts] = fake.mock.calls[0];
    expect(pack.id).toBe("sputnik-v2");
    expect(scope).toEqual({ receiverId: "dao.sandbox", methodNames: ["act_proposal"] });
    expect(classifyOpts?.sandbox).toBe(sb);
    expect(typeof plan.dryRunMs).toBe("number");
    expect(plan.dryRunMs).toBeGreaterThanOrEqual(0);
    // The chain check, then the pin; nothing signed, nothing written.
    expect(log.map((r) => (r.method === "query" ? `query:${r.params.request_type}` : r.method))).toEqual(["status", "query:view_account"]);
    expect(log[1].params).toMatchObject({ account_id: "dao.sandbox", finality: "final" });
    expect(existsSync(join(process.env.KEYHOLE_HOME ?? "", "sessions"))).toBe(false);
    // A pack-json pack is used as selected: no live re-read.
    expect(packs.loadTargetPack).not.toHaveBeenCalled();
    // The session key: freshly minted, held in memory only, its public half in the draft (32 bytes).
    expect(heldPrivateKeyCount()).toBe(held + 1);
    expect(sessionKeyPair(sessionFromPlan(plan), {}).getPublicKey().toString() === plan.draft.publicKey).toBe(true);
    expect(plan.draft.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // The plan is plain data: no key pair rides on it.
    expect(JSON.stringify(plan)).not.toMatch(/private|secret/i);
  });

  it("C-T20c: a DAO on the sputnikv2.testnet factory's v3.31 code selects pack sputnik-v2-331, pins that code and dry-runs it", async () => {
    replayFetch({ status: STATUS, "query:view_account": DAO_ACCOUNT.replace(PIN, V331) });
    const plan = await planWrap(opts, d);
    expect(plan.draft).toMatchObject({ packId: "sputnik-v2-331", codeHashPin: V331, methodNames: ["act_proposal"] });
    expect(fake).toHaveBeenCalledTimes(1);
    const [pack] = fake.mock.calls[0];
    expect(pack.id).toBe("sputnik-v2-331");
    expect(pack.sandboxFixture?.codeHash).toBe(V331);
    expect(packs.packForCodeHash).toHaveBeenCalledWith(V331);
  });

  it("two plans mint two different keys and session ids", async () => {
    replayFetch(PLAN_RPC);
    const a = await planWrap(opts, d);
    const b = await planWrap(opts, d);
    expect(a.draft.publicKey).not.toBe(b.draft.publicKey);
    expect(heldPrivateKeyCount()).toBe(2);
  });

  it("refuses an allowance below one call's up-front gas, with the measured minimum (boundary: exactly 0.031 NEAR passes)", async () => {
    replayFetch(PLAN_RPC);
    await expect(planWrap({ ...opts, allowanceYocto: "30000000000000000000000" }, { classify: fake })).rejects.toThrow(
      "allowance 0.0300 NEAR is below the minimum 0.0310 NEAR for one 30 TGas call (gas is bought up front at ≥10⁹ yocto/gas)",
    );
    // 0.0309 NEAR: one 0.0001 step below the minimum (a multiple of 0.0001, so it is the minimum that refuses it).
    await expect(planWrap({ ...opts, allowanceYocto: "30900000000000000000000" }, d)).rejects.toThrow("allowance 0.0309 NEAR is below the minimum 0.0310 NEAR");
    expect(fake).not.toHaveBeenCalled();
    expect((await planWrap({ ...opts, allowanceYocto: "31000000000000000000000" }, d)).draft.allowanceYocto).toBe("31000000000000000000000");
  });

  it.each([["0"], [""], ["0.05"], ["-1"], ["5e22"]])("refuses allowance %j before any RPC: explicit and non-zero (T9)", async (allowanceYocto) => {
    const log = replayFetch(PLAN_RPC);
    await expect(planWrap({ ...opts, allowanceYocto }, d)).rejects.toThrow("allowance must be explicit and non-zero (T9)");
    expect(log).toEqual([]);
  });

  it("fix 3: refuses an allowance 4 decimals cannot print exactly (0.0500 NEAR + 1 yocto), before any RPC", async () => {
    const log = replayFetch(PLAN_RPC);
    for (const allowanceYocto of ["50000000000000000000001", "50000000000000000000000".replace(/0{2}$/, "99")]) {
      const err = await planWrap({ ...opts, allowanceYocto }, d).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).problems).toEqual(["allowance must be a whole multiple of 0.0001 NEAR (10^20 yocto): it is printed to 4 decimals and signed exactly"]);
    }
    expect(log).toEqual([]);
    // Exactly 0.0001 NEAR steps pass, and the printed figure is then the signed one.
    replayFetch(PLAN_RPC);
    const plan = await planWrap({ ...opts, allowanceYocto: "50100000000000000000000" }, d);
    expect(plan.txActions[0]).toContain("· allowance 0.0501 NEAR");
  });

  it("C-T4b: 0.05005 NEAR (half a 0.0001 NEAR step) is refused, before any RPC (a 10^19 step would pass it)", async () => {
    const log = replayFetch(PLAN_RPC);
    const err = await planWrap({ ...opts, allowanceYocto: "50050000000000000000000" }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).problems).toEqual(["allowance must be a whole multiple of 0.0001 NEAR (10^20 yocto): it is printed to 4 decimals and signed exactly"]);
    expect(log).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  });

  it("fix 6: refuses an --allow entry that is not a method name, naming it, before any RPC", async () => {
    const log = replayFetch(PLAN_RPC);
    const err = await planWrap({ ...opts, allow: ["act_proposal", "act_proposal, add_proposal", "a·b"] }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).problems).toEqual([
      '--allow: "act_proposal, add_proposal" is not a method name',
      '--allow: "a·b" is not a method name',
    ]);
    expect(log).toEqual([]);
  });

  it("refuses a method outside the pack, naming the pack's call tools and out-of-scope methods; views are not call tools", async () => {
    replayFetch(PLAN_RPC);
    await expect(planWrap({ ...opts, allow: ["foo"] }, d)).rejects.toThrow("method foo is not in pack sputnik-v2 (tools: act_proposal; out of scope: add_proposal)");
    await expect(planWrap({ ...opts, allow: ["get_policy"] }, d)).rejects.toThrow("method get_policy is not in pack sputnik-v2");
    const err = await planWrap({ ...opts, allow: ["act_proposal", "foo", "bar"] }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).problems).toEqual([
      "method foo is not in pack sputnik-v2 (tools: act_proposal; out of scope: add_proposal)",
      "method bar is not in pack sputnik-v2 (tools: act_proposal; out of scope: add_proposal)",
    ]);
    expect(fake).not.toHaveBeenCalled();
  });

  it("accepts an out-of-scope method (the negative control) and dedupes the allow list", async () => {
    replayFetch(PLAN_RPC);
    const plan = await planWrap({ ...opts, allow: ["act_proposal", "add_proposal", "act_proposal"] }, d);
    expect(plan.draft.methodNames).toEqual(["act_proposal", "add_proposal"]);
    expect(plan.txActions[0]).toContain("· methods act_proposal, add_proposal ·");
  });

  it("refuses an empty allow list: an empty method_names would let the key call every method", async () => {
    const log = replayFetch(PLAN_RPC);
    await expect(planWrap({ ...opts, allow: [] }, d)).rejects.toThrow(/at least one method/);
    expect(log).toEqual([]);
  });

  it("a receiver with no code, or code no pack pins, is an input error; nothing is classified and no key is minted", async () => {
    replayFetch({ status: STATUS, "query:view_account": NO_CODE_ACCOUNT });
    expect(JSON.parse(NO_CODE_ACCOUNT).result.code_hash).toBe(NO_CODE_HASH);
    await expect(planWrap(opts, d)).rejects.toThrow("CONTRACT dao.sandbox has no code");
    replayFetch({ status: STATUS, "query:view_account": OTHER_CODE_ACCOUNT });
    const err = await planWrap(opts, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).problems).toEqual([noTools(PACK_IDS)]);
    expect(fake).not.toHaveBeenCalled();
    expect(heldPrivateKeyCount()).toBe(0);
  });

  it("code no pack pins: a hint line names the receiver's code_hash, each pack and the code_hash it pins, and README › Limits", async () => {
    // The pins are read from the packs themselves, never typed here: sputnik-v2's is the vendored DAO's (PIN).
    const pins = await Promise.all(
      (await realPacks.listPackIds()).map(async (id) => ({ id, codeHash: (await realPacks.loadTargetPack(id)).sandboxFixture?.codeHash })),
    );
    expect(pins.find((p) => p.id === "sputnik-v2")?.codeHash).toBe(PIN);
    // C-T20c: three pins, the v3.31 pack's among them.
    expect(pins.map((p) => p.id)).toEqual(PACK_IDS);
    expect(pins.every((p) => typeof p.codeHash === "string" && p.codeHash.length > 0)).toBe(true);
    expect(pins.find((p) => p.id === "sputnik-v2-331")?.codeHash).toBe(V331);
    replayFetch({ status: STATUS, "query:view_account": OTHER_CODE_ACCOUNT });
    const err = (await planWrap(opts, d).catch((e: unknown) => e)) as InputError & { hint?: string };
    expect(err).toBeInstanceOf(InputError);
    expect(err.problems).toEqual([noTools(PACK_IDS)]);
    // C-T20e: with real 44-character code hashes the one-line hint is over 100 cells, so it breaks before a ` · `, each
    // continuation hung under the text after `hint: `; joined with a space again, the rows are the one-line hint.
    const rows = err.hint!.split("\n");
    expect(rows[0]).toBe(`hint: code_hash ${OTHER_CODE} matches no pack`);
    for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(100);
    for (const row of rows.slice(1)) expect(row, row).toMatch(/^ {6}· \S/);
    expect(rows.length).toBeGreaterThan(1);
    for (const p of pins) expect(rows.filter((r) => r.includes(`${p.id} pins ${p.codeHash}`))).toHaveLength(1);
    expect(rows.at(-1)).toMatch(/ · see README › Limits$|^ {6}· see README › Limits$/);
    expect(rows.map((r) => r.trim()).join(" ")).toBe(`hint: code_hash ${OTHER_CODE} matches no pack ${pins.map((p) => `· ${p.id} pins ${p.codeHash}`).join(" ")} · see README › Limits`);
    // Printed after the problem, one row per line (main prints line()); the message, which tests match, is unchanged.
    expect(err.line().split("\n")).toEqual([`ERROR (input): ${noTools(PACK_IDS)}`, ...rows]);
    expect(err.message).toBe(noTools(PACK_IDS));
    expect(fake).not.toHaveBeenCalled();

    // The receiver's hash is RPC data: a control character in it reaches the terminal neutralized.
    replayFetch({ status: STATUS, "query:view_account": DAO_ACCOUNT.replace(PIN, "\\u001b[2Jevil") });
    const hostile = (await planWrap(opts, d).catch((e: unknown) => e)) as InputError & { hint?: string };
    expect(hostile.hint).toContain("evil matches no pack");
    expect(hostile.line()).not.toContain("\u001b");
  });

  it("a missing receiver is an environment error", async () => {
    const unknown = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT","info":{}},"code":-32000,"message":"Server error","data":"x"},"id":"p"}';
    replayFetch({ status: STATUS, "query:view_account": unknown });
    await expect(planWrap(opts, d)).rejects.toThrow(/dao\.sandbox does not exist on sandbox/);
  });

  it("network: the CONTRACT suffix decides; mainnet and mismatched accounts are refused before any RPC", async () => {
    const log = replayFetch(PLAN_RPC);
    await expect(planWrap({ ...opts, contract: "dao.near" }, d)).rejects.toThrow(MAINNET_OUT_OF_SCOPE);
    await expect(planWrap({ ...opts, contract: "alice.near", onAccount: "alice.near" }, d)).rejects.toThrow(MAINNET_OUT_OF_SCOPE);
    await expect(planWrap({ ...opts, contract: "dao.testnet" }, d)).rejects.toThrow(/CONTRACT dao\.testnet is a testnet account, not sandbox/);
    await expect(planWrap({ ...opts, onAccount: "seat.testnet" }, d)).rejects.toThrow(/--on-account seat\.testnet must be a sandbox account/);
    await expect(planWrap({ ...subOpts, operatorId: "op.testnet" }, d)).rejects.toThrow(/KEYHOLE_OPERATOR op\.testnet must be a sandbox account/);
    await expect(planWrap({ ...opts, contract: "Dao.sandbox" }, d)).rejects.toThrow(/not a NEAR account id/);
    expect(log).toEqual([]);
  });

  it("sub-account mode without an operator names KEYHOLE_OPERATOR and --on-account", async () => {
    replayFetch(PLAN_RPC);
    const err = await planWrap({ ...opts, onAccount: undefined }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as Error).message).toMatch(/KEYHOLE_OPERATOR/);
    expect((err as Error).message).toMatch(/--on-account/);
  });

  it("refuses a mainnet RPC before the pin is read (assertChain)", async () => {
    const log = replayFetch({ status: MAINNET_STATUS, "query:view_account": DAO_ACCOUNT });
    await expect(planWrap(opts, d)).rejects.toThrow(/mainnet/);
    expect(log.map((r) => r.method)).toEqual(["status"]);
  });

  it("sub-account: ks-XXXX.OPERATOR, funded with allowance + reserve, four actions (R14 creation cost on CreateAccount)", async () => {
    replayFetch(PLAN_RPC);
    const sub = await planWrap(subOpts, d);
    expect(sub.draft.accountId).toMatch(/^ks-[0-9a-f]{4}\.sandbox$/);
    expect(sub.draft.accountId).toBe(`${sub.draft.id}.sandbox`);
    expect(sub.draft.mode).toBe("subaccount");
    expect(sub.signerId).toBe("sandbox");
    expect(sub.fundingYocto).toBe("60000000000000000000000");
    expect(BigInt(sub.fundingYocto ?? 0) - BigInt(ALLOWANCE)).toBe(SUBACCOUNT_RESERVE);
    expect(sub.txActions.map((l) => l.split(" ")[1])).toEqual(["CreateAccount", "Transfer", "AddKey", "AddKey"]);
    const acct = sub.draft.accountId;
    expect(sub.txActions).toEqual([
      `+ CreateAccount ${acct} (sub-account of sandbox) · account creation ≈0.007 NEAR (gas, NEP-642)`,
      `+ Transfer 0.0600 NEAR → ${acct} · gas allowance 0.0500 + reserve 0.0100 (storage)`,
      `+ AddKey FullAccess (operator) → ${acct} · sandbox's full-access key; keyhole burn deletes the account with it`,
      `+ AddKey FunctionCall → ${acct} · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR`,
    ]);
    expect(sub.txActions[0].endsWith("· account creation ≈0.007 NEAR (gas, NEP-642)")).toBe(true);
  });

  it("warnings: one per allowed method labelled runtime or inconclusive; none for the hero; never for a method not allowed", async () => {
    replayFetch(PLAN_RPC);
    expect((await planWrap(opts, { classify: labelling("fails-without-deposit (runtime)") })).warnings).toEqual([warnRuntime("act_proposal")]);
    expect((await planWrap(opts, { classify: labelling("inconclusive") })).warnings).toEqual([warnInconclusive("act_proposal")]);
    // add_proposal labelled runtime but not allowed: no warning.
    const notAllowed = vi.fn<typeof classifyTools>(async () => heroTools().map((t) => (t.method === "add_proposal" ? { ...t, classification: "fails-without-deposit (runtime)" as const } : t)));
    expect((await planWrap(opts, { classify: notAllowed })).warnings).toEqual([]);
    // The label is looked up by method, wherever the tool sits in the list.
    const firstNotAllowed = vi.fn<typeof classifyTools>(async () =>
      heroTools()
        .map((t) => (t.method === "add_proposal" ? { ...t, classification: "fails-without-deposit (runtime)" as const } : t))
        .reverse(),
    );
    expect((await planWrap(opts, { classify: firstNotAllowed })).warnings).toEqual([]);
    const second = vi.fn<typeof classifyTools>(async () => heroTools().map((t) => (t.method === "add_proposal" ? { ...t, classification: "inconclusive" as const } : t)));
    expect((await planWrap({ ...opts, allow: ["act_proposal", "add_proposal"] }, { classify: second })).warnings).toEqual([warnInconclusive("add_proposal")]);
  });

  it("R2b: the session id re-rolls on collision with an existing session file", async () => {
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
    mkdirSync(join(env.KEYHOLE_HOME, "sessions"));
    writeFileSync(sessionFile(env, "ks-aaaa"), "{}\n");
    vi.mocked(sessionModule.newSessionId).mockReturnValueOnce("ks-aaaa").mockReturnValueOnce("ks-aaaa").mockReturnValueOnce("ks-bbbb");
    replayFetch(PLAN_RPC);
    const plan = await planWrap(subOpts, d);
    expect(plan.draft.id).toBe("ks-bbbb");
    expect(plan.draft.accountId).toBe("ks-bbbb.sandbox");
    expect(sessionModule.newSessionId).toHaveBeenCalledTimes(3);
    expect(readFileSync(sessionFile(env, "ks-aaaa"), "utf8")).toBe("{}\n"); // untouched
  });

  it("R2b: gives up with an environment error when every id it draws is taken", async () => {
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
    mkdirSync(join(env.KEYHOLE_HOME, "sessions"));
    writeFileSync(sessionFile(env, "ks-aaaa"), "{}\n");
    vi.mocked(sessionModule.newSessionId).mockImplementation(() => "ks-aaaa");
    try {
      replayFetch(PLAN_RPC);
      await expect(planWrap(opts, d)).rejects.toBeInstanceOf(EnvironmentError);
    } finally {
      vi.mocked(sessionModule.newSessionId).mockImplementation(realSession.newSessionId);
    }
    expect(heldPrivateKeyCount()).toBe(0);
  });

  it("R17a: a near-abi pack is re-read live for the receiver, and its live tools set the scope", async () => {
    const counter = await realPacks.loadTargetPack("counter");
    const selected: TargetPack = { ...counter, sandboxFixture: { wasmPath: "x.wasm", sha256: "0".repeat(64), codeHash: OTHER_CODE, init: { method: "new", args: {} } } };
    const live: TargetPack = { ...counter, tools: [...counter.tools, { name: "counter_add", kind: "call", method: "add", argsSchema: {}, gasTGas: 10 }] };
    vi.mocked(packs.packForCodeHash).mockResolvedValueOnce(selected);
    vi.mocked(packs.loadTargetPack).mockResolvedValueOnce(live);
    replayFetch({ status: STATUS, "query:view_account": OTHER_CODE_ACCOUNT });
    const classify = vi.fn<typeof classifyTools>(async () => []);
    const plan = await planWrap({ ...subOpts, contract: "counter.sandbox", allow: ["add"], allowanceYocto: "11000000000000000000000" }, { classify });
    expect(packs.loadTargetPack).toHaveBeenCalledWith("counter", { network: "sandbox", receiverId: "counter.sandbox" });
    expect(classify.mock.calls[0][0]).toBe(live);
    expect(plan.draft).toMatchObject({ packId: "counter", methodNames: ["add"], codeHashPin: OTHER_CODE });
  });
});

describe("sessionFromPlan", () => {
  it("is the draft made live: same fields, status live, an ISO createdAt, copies of the arrays", async () => {
    replayFetch(PLAN_RPC);
    const plan = await planWrap(opts, d);
    const s = sessionFromPlan(plan);
    expect(s).toMatchObject({ ...plan.draft, status: "live" });
    expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt);
    expect(s.burnedAt).toBeUndefined();
    expect(sessionModule.sessionProblems(s)).toEqual([]);
    s.methodNames.push("add_proposal");
    s.tools.pop();
    expect(plan.draft.methodNames).toEqual(["act_proposal"]);
    expect(plan.draft.tools).toHaveLength(4);
  });

  it("carries only Session fields", () => {
    const { createdAt: _c, status: _s, ...draft } = { ...sampleCageCard().session, extra: "x" } as Session & { extra: string };
    const plan: WrapPlan = { draft, txActions: [], tools: [], warnings: [], signerId: "seat.sandbox", fundingYocto: null, dryRunMs: 0 };
    expect(Object.keys(sessionFromPlan(plan)).sort()).toEqual(
      ["accountId", "allowanceYocto", "codeHashPin", "createdAt", "id", "methodNames", "mode", "network", "packId", "publicKey", "receiverId", "status", "tools"].sort(),
    );
  });
});

describe("signWrap", () => {
  it("on-account: one AddKey with exactly the planned scope, signed by the account's full-access key from the keychain", async () => {
    const { plan, env, seatKey } = await onAccountPlan();
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch(SIGN_RPC);

    const { session, txHash } = await signWrap(plan, { env });

    expect(fullAccessKeyLoadCount()).toBe(loads + 1);
    const tx = sentTx(log);
    expect(tx.signerId).toBe("seat.sandbox");
    expect(tx.receiverId).toBe("seat.sandbox");
    expect(tx.publicKey.toString() === seatKey.getPublicKey().toString()).toBe(true);
    expect(tx.actions).toHaveLength(1);
    const addKey = (tx.actions[0] as any).addKey;
    expect(keyText(addKey.publicKey)).toBe(plan.draft.publicKey);
    expect(addKey.accessKey.permission).toEqual({ functionCall: { receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowance: 50_000_000_000_000_000_000_000n } });
    // RPC order: chain check, pin + scope, signer key FullAccess, then signAndSend's nonce read and the send.
    expect(log.map((r) => (r.method === "query" ? `query:${r.params.request_type}` : r.method))).toEqual([
      "query:view_account",
      "query:view_access_key",
      "query:view_access_key",
      "send_tx",
    ]); // status was checked (and remembered) by planWrap at this URL
    expect(log[0].params).toMatchObject({ account_id: "dao.sandbox" });
    expect(log[1].params).toMatchObject({ account_id: "seat.sandbox", public_key: seatKey.getPublicKey().toString() });
    expect(txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // The session: the draft, live; its file holds exactly it (metadata only); its key file is 0600 in a 0700 dir.
    expect(session).toMatchObject({ ...plan.draft, status: "live" });
    expect(JSON.parse(readFileSync(sessionFile(env, session.id), "utf8"))).toEqual(session);
    const keyPath = sessionKeyPath(session, env);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(env.KEYHOLE_CREDENTIALS_DIR, "sandbox", "seat.sandbox")).mode & 0o777).toBe(0o700);
    expect(readFileSync(sessionFile(env, session.id), "utf8")).not.toMatch(/private|secret/i);
  });

  it("session file and key file exist before the send (C-T3c: the key file is saved first)", async () => {
    const { plan, env } = await onAccountPlan();
    const events: string[] = [];
    vi.mocked(sessionModule.saveSession).mockImplementationOnce(async (s, e) => {
      events.push(`saveSession called · key file ${existsSync(sessionKeyPath(s, e)) ? "present" : "absent"}`);
      const path = await realSession.saveSession(s, e);
      events.push("saveSession resolved");
      return path;
    });
    replayFetch(SIGN_RPC);
    const replay = globalThis.fetch;
    let atSend: { sessionFile: boolean; keyMode: number } | null = null;
    globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "send_tx") {
        events.push("send_tx");
        const s = sessionFromPlan(plan);
        atSend = { sessionFile: existsSync(sessionFile(env, s.id)), keyMode: statSync(sessionKeyPath(s, env)).mode & 0o777 };
      }
      return replay(input, init);
    };
    await signWrap(plan, { env });
    expect(events).toEqual(["saveSession called · key file present", "saveSession resolved", "send_tx"]);
    expect(atSend).toEqual({ sessionFile: true, keyMode: 0o600 });
  });

  it("signWrap leaves no files when the send fails (refused at validation: never in a block)", async () => {
    const { plan, env } = await onAccountPlan();
    replayFetch({ ...SIGN_RPC, send_tx: REFUSED });
    await expect(signWrap(plan, { env })).rejects.toThrow(/refused at validation \(MethodNameMismatch\)/);
    expect(filesUnder(join(env.KEYHOLE_HOME, "sessions"))).toEqual([]);
    expect(filesUnder(env.KEYHOLE_CREDENTIALS_DIR)).toEqual(["sandbox/seat.sandbox.json"]); // the seat's own key only
  });

  it("signWrap leaves no files when the tx landed and failed (its receipt reverted, so no key was added)", async () => {
    const { plan, env } = await onAccountPlan();
    replayFetch({ ...SIGN_RPC, send_tx: LANDED_FAILED });
    await expect(signWrap(plan, { env })).rejects.toThrow(/failed in a block/);
    expect(filesUnder(join(env.KEYHOLE_HOME, "sessions"))).toEqual([]);
    expect(filesUnder(env.KEYHOLE_CREDENTIALS_DIR)).toEqual(["sandbox/seat.sandbox.json"]);
  });

  /** A node error whose data is a 7M-character base58 run (sweep A fix round 1, I1): under the body cap, and redacted. */
  const BIG_RUN_ERROR = JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: "A".repeat(7_000_000) }, id: "p" });
  it.each([
    ["an RPC error that does not say what happened to the tx", { send_tx: INTERNAL_ERROR }],
    ["a dropped connection during the send", {}],
    // planWrap holds the session key, so both answers go through the redactor; it must not throw (fix round 1, I1).
    ["send_tx and the tx poll answering with a 7M-character base58 run", { send_tx: BIG_RUN_ERROR, tx: BIG_RUN_ERROR }],
  ])("keeps both files when the AddKey's fate is unknown (%s): the SendFateUnknownError is rethrown untouched, exit 3 (C-T2j)", async (_what, override) => {
    const { plan, env } = await onAccountPlan();
    const rpc: Record<string, string> = { ...SIGN_RPC, ...override };
    if (!("send_tx" in override)) delete rpc.send_tx; // replayFetch then throws: the connection drops
    const log = replayFetch(rpc); // no `tx` body either: T2's poll by hash fails, so the fate stays unknown
    const err = await signWrap(plan, { env }).catch((e: unknown) => e);
    // Its own class, message and hint (a transaction was sent: exit 3). The CLI names the session (cli-wrap.test.ts).
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect((err as SendFateUnknownError).exitCode).toBe(EXIT_TX_SENT);
    const id = plan.draft.id;
    const hash = log.find((r) => r.method === "tx")?.params.tx_hash;
    expect(hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/); // the local hash T2 polled
    expect((err as SendFateUnknownError).txHash).toBe(hash);
    const text = (err as EnvironmentError).line();
    expect(text).toContain(`look tx ${hash} up on chain before signing anything again`);
    expect(text).not.toContain(id); // untouched: nothing appended
    expect(log.filter((r) => r.method === "send_tx").length).toBeLessThanOrEqual(1); // never re-sent (C-T2i)
    expect(existsSync(sessionFile(env, id))).toBe(true);
    expect(existsSync(sessionKeyPath(sessionFromPlan(plan), env))).toBe(true);
  }, 30_000);

  it("a sent AddKey whose reply mustSucceed rejects past every known shape is kept too: exit 3, the session and keyhole burn ID named (C-T2j)", async () => {
    // sendSigned returns only landed or refused replies today, so this catch is a guard: if it is ever reached, a tx
    // was sent, and exit 2 ("nothing was signed") would be false.
    const { plan, env } = await onAccountPlan();
    const log = replayFetch(SIGN_RPC);
    vi.mocked(mustSucceed).mockImplementationOnce(() => {
      throw new EnvironmentError("wrap: no transaction result (an answer no one has seen) · tx X", "look tx X up on chain before signing anything again");
    });
    const err = await signWrap(plan, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).exitCode).toBe(EXIT_TX_SENT);
    const id = plan.draft.id;
    const text = (err as EnvironmentError).line();
    expect(text).toContain("wrap: no transaction result (an answer no one has seen) · tx X");
    expect(text).toContain(`session ${id} kept: the AddKey may be on chain`);
    expect(text).toContain(`keyhole burn ${id}`);
    expect(log.filter((r) => r.method === "send_tx")).toHaveLength(1);
    expect(existsSync(sessionFile(env, id))).toBe(true);
    expect(existsSync(sessionKeyPath(sessionFromPlan(plan), env))).toBe(true);
  });

  /** An RPC error body for a view: it says nothing about any tx. */
  const VIEW_FAILED = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"INTERNAL_ERROR","info":{}},"code":-32000,"message":"Server error","data":"busy"},"id":"p"}';

  it.each([
    ["the nonce read (2nd view_access_key) fails", { "query:view_access_key": [FULL_ACCESS, VIEW_FAILED] }, false],
    ["the signer's key vanishes before the nonce read", { "query:view_access_key": [FULL_ACCESS, NO_KEY] }, false],
    ["signAndSend's own chain check fails (the RPC switched to a mainnet node)", { status: MAINNET_STATUS }, true],
  ])("fix 1: a pre-send failure inside signAndSend (%s) removes both files and never says the key may be on chain", async (_what, override, switchRpc) => {
    const { plan, env } = await onAccountPlan();
    const log = replayFetch({ ...SIGN_RPC, ...override });
    if (switchRpc) {
      // planWrap checked this URL's status (remembered); after the FullAccess read the RPC moves to an unchecked node.
      const replay = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const reply = await replay(input, init);
        if (JSON.parse(String(init?.body)).params?.request_type === "view_access_key") useRpcUrl("sandbox", `http://wrap-switched-${urls}.replay.invalid`);
        return reply;
      };
    }
    const err = await signWrap(plan, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    const text = (err as EnvironmentError).line();
    expect(text).not.toMatch(/may be on chain|keyhole burn|look tx/);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
    expect(filesUnder(env.KEYHOLE_CREDENTIALS_DIR)).toEqual(["sandbox/seat.sandbox.json"]);
  });

  it("an INVALID_TRANSACTION answer whose variant does not parse is still a refusal: both files removed", async () => {
    const { plan, env } = await onAccountPlan();
    const odd = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"INVALID_TRANSACTION","info":{}},"code":-32000,"message":"Server error","data":{"SomethingNew":{}}},"id":"p"}';
    replayFetch({ ...SIGN_RPC, send_tx: odd });
    const err = await signWrap(plan, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).line()).not.toMatch(/may be on chain|keyhole burn/);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
    expect(filesUnder(env.KEYHOLE_CREDENTIALS_DIR)).toEqual(["sandbox/seat.sandbox.json"]);
  });

  it("fix 4 (M3): when saveSession fails, the key file already written is removed and nothing is sent", async () => {
    const { plan, env } = await onAccountPlan();
    vi.mocked(sessionModule.saveSession).mockImplementationOnce(async () => {
      throw new EnvironmentError("cannot write the session file (disk full)", "free some space");
    });
    const log = replayFetch(SIGN_RPC);
    await expect(signWrap(plan, { env })).rejects.toThrow("cannot write the session file (disk full)");
    expect(existsSync(sessionKeyPath(sessionFromPlan(plan), env))).toBe(false);
    expect(filesUnder(env.KEYHOLE_CREDENTIALS_DIR)).toEqual(["sandbox/seat.sandbox.json"]);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
  });

  it("refuses before writing or sending when the signer's key is not full access, or not on chain", async () => {
    for (const body of [FC_KEY, NO_KEY]) {
      const { plan, env } = await onAccountPlan();
      const log = replayFetch({ ...SIGN_RPC, "query:view_access_key": body });
      await expect(signWrap(plan, { env })).rejects.toBeInstanceOf(EnvironmentError);
      expect(log.some((r) => r.method === "send_tx")).toBe(false);
      expect(filesUnder(join(env.KEYHOLE_HOME))).toEqual([]);
    }
  });

  it("C-T2l: a failed read of the signer's key prints the node's error text scrubbed of the RPC URL's path and query", async () => {
    const { plan, env } = await onAccountPlan();
    const url = `https://rpc-${urls}.example.invalid/v3/k3yt0ken?apiKey=s3cr3tvalue`;
    useRpcUrl("sandbox", url);
    const echo = JSON.stringify({
      jsonrpc: "2.0",
      error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: `upstream ${url} failed: POST ${new URL(url).pathname}${new URL(url).search}` },
      id: "p",
    });
    const log = replayFetch({ ...SIGN_RPC, "query:view_access_key": echo });
    const err = await signWrap(plan, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    const text = `${(err as EnvironmentError).what} ${(err as EnvironmentError).tryThis}`;
    expect(text).toContain("view_access_key seat.sandbox failed: GATEWAY_ERROR: upstream https://");
    for (const secret of ["/v3", "k3yt0ken", "s3cr3tvalue", "apiKey"]) expect(text.includes(secret), secret).toBe(false);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
  });

  it("refuses when the receiver's code changed since planWrap (the pin is re-read before signing); nothing is loaded or written", async () => {
    const { plan, env } = await onAccountPlan();
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch({ ...SIGN_RPC, "query:view_account": OTHER_CODE_ACCOUNT });
    await expect(signWrap(plan, { env })).rejects.toThrow(`code_hash of dao.sandbox changed since planWrap (pinned ${PIN}, now ${OTHER_CODE})`);
    expect(fullAccessKeyLoadCount()).toBe(loads);
    expect(log.some((r) => r.method === "send_tx" || r.params?.request_type === "view_access_key")).toBe(false);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
  });

  it("refuses a mainnet RPC before any key is read", async () => {
    const { plan, env } = await onAccountPlan();
    useRpcUrl("sandbox", "http://wrap-mainnet.replay.invalid");
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch({ ...SIGN_RPC, status: MAINNET_STATUS });
    await expect(signWrap(plan, { env })).rejects.toThrow(/mainnet/);
    expect(fullAccessKeyLoadCount()).toBe(loads);
    expect(log.map((r) => r.method)).toEqual(["status"]);
  });

  it("refuses a plan changed after planWrap: the signed actions must be exactly the printed TX PLAN", async () => {
    const { plan, env } = await onAccountPlan();
    const log = replayFetch(SIGN_RPC);
    const variants: WrapPlan[] = [
      // Caught by the TX PLAN line mismatch (its line still says act_proposal), not by the empty-list guard;
      // the self-consistent empty-list plan is the "fix 2" test below.
      { ...plan, draft: { ...plan.draft, methodNames: [] } },
      { ...plan, draft: { ...plan.draft, methodNames: ["act_proposal", "add_proposal"] } },
      { ...plan, draft: { ...plan.draft, allowanceYocto: "60000000000000000000000" } },
      { ...plan, draft: { ...plan.draft, receiverId: "other.sandbox" } },
      { ...plan, txActions: ["+ AddKey FunctionCall → seat.sandbox · receiver dao.sandbox · methods * · allowance 0.0500 NEAR"] },
      { ...plan, signerId: "other.sandbox" },
      { ...plan, fundingYocto: "1" },
      { ...plan, draft: { ...plan.draft, allowanceYocto: "0" } },
      { ...plan, draft: { ...plan.draft, network: "testnet" } },
    ];
    for (const v of variants) await expect(signWrap(v, { env }), JSON.stringify(v.draft.methodNames)).rejects.toBeInstanceOf(InputError);
    expect(log).toEqual([]);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
  });

  /** `plan` with its draft changed and its one TX PLAN line rewritten to match: a self-consistent tampered plan. */
  const consistent = (plan: WrapPlan, draft: Partial<WrapPlan["draft"]>): WrapPlan => {
    const d2 = { ...plan.draft, ...draft };
    return { ...plan, draft: d2, txActions: [`+ AddKey FunctionCall → ${d2.accountId} · receiver ${d2.receiverId} · methods ${d2.methodNames.join(", ")} · allowance ${formatNear(d2.allowanceYocto)} NEAR`] };
  };

  it("fix 2: a self-consistent plan with methodNames [] (line rewritten to match) is refused; no any-method AddKey is sent", async () => {
    const { plan, env } = await onAccountPlan();
    const tampered = consistent(plan, { methodNames: [] });
    expect(tampered.txActions[0]).toBe("+ AddKey FunctionCall → seat.sandbox · receiver dao.sandbox · methods  · allowance 0.0500 NEAR");
    const log = replayFetch(SIGN_RPC);
    const err = await signWrap(tampered, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).message).toMatch(/every method/);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
  });

  it("fix 4 (M5): signWrap re-checks the scope against the pack, not just the pack lookup (self-consistent tampered plans)", async () => {
    const { plan, env } = await onAccountPlan();
    const log = replayFetch(SIGN_RPC);
    await expect(signWrap(consistent(plan, { methodNames: ["get_policy"] }), { env })).rejects.toThrow("method get_policy is not in pack sputnik-v2");
    await expect(signWrap(consistent(plan, { allowanceYocto: "10000000000000000000000" }), { env })).rejects.toThrow("allowance 0.0100 NEAR is below the minimum 0.0310 NEAR");
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
  });

  it("fix 3: signWrap refuses an allowance its printed line cannot show exactly (0.0500 NEAR + 1 yocto, line unchanged)", async () => {
    const { plan, env } = await onAccountPlan();
    const tampered = consistent(plan, { allowanceYocto: "50000000000000000000001" });
    expect(tampered.txActions).toEqual(plan.txActions); // floored to 4 decimals, the line is the same
    const log = replayFetch(SIGN_RPC);
    await expect(signWrap(tampered, { env })).rejects.toThrow("allowance must be a whole multiple of 0.0001 NEAR");
    expect(log).toEqual([]);
  });

  it("sub-account: refuses funding other than allowance + reserve, even when the printed line rounds the same", async () => {
    replayFetch(PLAN_RPC);
    const plan = await planWrap(subOpts, d);
    const env = tmpEnv();
    const log = replayFetch(SIGN_RPC);
    for (const fundingYocto of ["60000000000000000000001", "50000000000000000000000", null]) {
      await expect(signWrap({ ...plan, fundingYocto }, { env, signerKey: KeyPair.fromRandom("ed25519") })).rejects.toBeInstanceOf(InputError);
    }
    await expect(signWrap({ ...plan, draft: { ...plan.draft, accountId: "ks-ffff.sandbox" } }, { env })).rejects.toBeInstanceOf(InputError);
    expect(log).toEqual([]);
  });

  it("refuses when the receiver's code selects another pack than the plan's", async () => {
    const { plan, env } = await onAccountPlan();
    const log = replayFetch(SIGN_RPC);
    await expect(signWrap({ ...plan, draft: { ...plan.draft, packId: "counter" } }, { env })).rejects.toThrow(/selects pack sputnik-v2, not the plan's counter/);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
  });

  it("C-T2b: a 64-byte (private-key-shaped) publicKey in the plan is refused before any RPC, and never echoed", async () => {
    const { plan, env } = await onAccountPlan();
    const log = replayFetch(SIGN_RPC);
    const shaped = KeyPair.fromRandom("ed25519").toString(); // in memory only
    const err = await signWrap({ ...plan, draft: { ...plan.draft, publicKey: shaped } }, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect(String((err as Error).message).includes(shaped.slice(8))).toBe(false);
    expect(log).toEqual([]);
  });

  it("refuses when this plan's session file already exists in KEYHOLE_HOME, before any key is loaded (fix 5), and leaves that file alone", async () => {
    const { plan, env } = await onAccountPlan();
    mkdirSync(join(env.KEYHOLE_HOME, "sessions"));
    writeFileSync(sessionFile(env, plan.draft.id), "{}\n");
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch(SIGN_RPC);
    await expect(signWrap(plan, { env })).rejects.toThrow(/already exists/);
    expect(fullAccessKeyLoadCount()).toBe(loads); // the full-access key was never loaded
    expect(log.some((r) => r.params?.request_type === "view_access_key" || r.method === "send_tx")).toBe(false);
    expect(readFileSync(sessionFile(env, plan.draft.id), "utf8")).toBe("{}\n");
    expect(existsSync(sessionKeyPath(sessionFromPlan(plan), env))).toBe(false);
  });

  it("refuses when the plan's session key is not held in this process (and none is in the keychain)", async () => {
    const { plan, env } = await onAccountPlan();
    dropHeldKeys();
    const log = replayFetch(SIGN_RPC);
    await expect(signWrap(plan, { env })).rejects.toThrow(/no private key for session/);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
  });

  it("persist: false writes nothing; signerKey replaces the keychain (no full-access load)", async () => {
    replayFetch(PLAN_RPC);
    const plan = await planWrap(opts, d);
    const env = tmpEnv();
    const seatKey = KeyPair.fromRandom("ed25519");
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch(SIGN_RPC);
    const { session } = await signWrap(plan, { persist: false, signerKey: seatKey, env });
    expect(fullAccessKeyLoadCount()).toBe(loads);
    expect(sentTx(log).publicKey.toString() === seatKey.getPublicKey().toString()).toBe(true);
    expect(session.status).toBe("live");
    expect(filesUnder(env.KEYHOLE_HOME)).toEqual([]);
    expect(filesUnder(env.KEYHOLE_CREDENTIALS_DIR)).toEqual([]);
  });

  it("sub-account: CreateAccount, Transfer(funding), AddKey(operator, FullAccess), AddKey(session, FunctionCall) to ks-XXXX.OPERATOR", async () => {
    replayFetch(PLAN_RPC);
    const plan = await planWrap(subOpts, d);
    const env = tmpEnv();
    const operatorKey = KeyPair.fromRandom("ed25519");
    saveAccountKey("sandbox", "sandbox", operatorKey, env); // C-T3c: the bare network root is a valid operator id
    const log = replayFetch(SIGN_RPC);
    const { session } = await signWrap(plan, { env });
    const tx = sentTx(log);
    expect(tx.signerId).toBe("sandbox");
    expect(tx.receiverId).toBe(plan.draft.accountId);
    expect(tx.actions.map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "addKey", "addKey"]);
    const [, transfer, operatorAdd, sessionAdd] = tx.actions as any[];
    expect(transfer.transfer.deposit).toBe(60_000_000_000_000_000_000_000n);
    expect(keyText(operatorAdd.addKey.publicKey) === operatorKey.getPublicKey().toString()).toBe(true);
    expect(operatorAdd.addKey.accessKey.permission).toEqual({ fullAccess: {} });
    expect(keyText(sessionAdd.addKey.publicKey)).toBe(plan.draft.publicKey);
    expect(sessionAdd.addKey.accessKey.permission).toEqual({ functionCall: { receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowance: 50_000_000_000_000_000_000_000n } });
    expect(session).toMatchObject({ mode: "subaccount", accountId: plan.draft.accountId });
    expect(statSync(sessionKeyPath(session, env)).mode & 0o777).toBe(0o600);
  });

  it("no key text in any output: errors, the plan, the session and its file carry no private key", async () => {
    const texts: string[] = [];
    const secrets: string[] = [];
    for (const [rpc, sign] of [
      [{ ...SIGN_RPC, send_tx: REFUSED }, {}],
      [{ ...SIGN_RPC, send_tx: LANDED_FAILED }, {}],
      [{ ...SIGN_RPC, send_tx: INTERNAL_ERROR }, {}],
      [{ ...SIGN_RPC, "query:view_access_key": FC_KEY }, {}],
      [SIGN_RPC, { ok: true }],
    ] as const) {
      const { plan, env, seatKey } = await onAccountPlan();
      secrets.push(seatKey.toString(), sessionKeyPair(sessionFromPlan(plan), {}).toString());
      texts.push(JSON.stringify(plan));
      replayFetch(rpc);
      try {
        const { session } = await signWrap(plan, { env });
        texts.push(JSON.stringify(session), readFileSync(sessionFile(env, session.id), "utf8"));
        if (!("ok" in sign)) texts.push("unexpected success");
      } catch (e) {
        texts.push(String(e), (e as Error).stack ?? "", JSON.stringify(e));
      }
    }
    expect(texts.length).toBeGreaterThan(10);
    expect(texts.some((t) => secrets.some((s) => t.includes(s) || t.includes(s.slice(8))))).toBe(false);
  });
});
