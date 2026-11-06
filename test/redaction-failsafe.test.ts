/**
 * Sweep A fix round 1 (I1, Minor 5): redaction never throws and never changes an error's class.
 *
 * keys.ts is mocked here so that its redactors (redactHeldKeys, and the functions keyTextRedactor returns) throw while
 * `failing.on` is set: a stand-in for any failure inside them, a stack overflow on a huge reply say. Every call site must
 * then withhold the text (core: TEXT_WITHHELD; serve: its WITHHELD tool error) and keep the error it was building:
 * SendFateUnknownError with its tx hash and signer, LandedUnsettledError with its attempt, and signWrap's TxSentError
 * and SendFateUnknownError with the session's files kept. A serve result is a tool error, never an MCP internal error,
 * and an error that carries a tx hash still names it (fix round 2, m2: withheldTxHash).
 *
 * Keys are generated in memory; key text is never handed to expect().
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KeyPair, actions, baseDecode, baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMcpServer, withheldTxHash } from "../src/cli/serve.js";
import { LandedUnsettledError, sendAttempt } from "../src/core/attempt.js";
import { useRpcUrl } from "../src/core/config.js";
import { saveAccountKey, saveSessionKey, sessionKeyPath } from "../src/core/credentials.js";
import { EXIT_TX_SENT, EnvironmentError, TxSentError } from "../src/core/errors.js";
import { SESSION_KEY_ENV, TEXT_WITHHELD, dropHeldKeys, holdSessionKey, keyTextWindows, privateKeyTexts } from "../src/core/keys.js";
import { SendFateUnknownError, mustSucceed, signAndSend } from "../src/core/tx.js";
import type { AttemptInput, Session, WrapOptions } from "../src/core/types.js";
import { planWrap, sessionFromPlan, signWrap } from "../src/core/wrap.js";
import { SANDBOX_FIXTURES, type ReplayedRequest, type TmpEnv, readFixture, replayFetch, sampleCageCard, sampleSession, tmpEnv } from "./helpers.js";

/** While `on`, the redactors throw on every text that `when` accepts (all of them unless a test narrows it). */
const failing = vi.hoisted(() => ({ on: false, when: (_text: string): boolean => true }));
vi.mock("../src/core/keys.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/keys.js")>();
  const fail = (): never => {
    throw new RangeError("Maximum call stack size exceeded (forced)");
  };
  return {
    ...real,
    redactHeldKeys: (text: string) => (failing.on && failing.when(text) ? fail() : real.redactHeldKeys(text)),
    keyTextRedactor: (forms: readonly string[]) => {
      const redact = real.keyTextRedactor(forms);
      return (text: string) => (failing.on && failing.when(text) ? fail() : redact(text));
    },
  };
});
// sendAttempt: real, except where a serve test needs a tool error that carries a chosen `.txHash` (sweep B, m3).
vi.mock("../src/core/attempt.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/attempt.js")>();
  return { ...real, sendAttempt: vi.fn(real.sendAttempt) };
});
// mustSucceed: real, except where the TxSentError test reaches signWrap's last catch (wrap.test.ts does the same).
vi.mock("../src/core/tx.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/tx.js")>();
  return { ...real, mustSucceed: vi.fn(real.mustSucceed) };
});
const realMustSucceed = (await vi.importActual<typeof import("../src/core/tx.js")>("../src/core/tx.js")).mustSucceed;

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
const STATUS = fx("001-0-status.json");
const LANDED_VOTE = fx("027-e-fc-vote-approve-0.send_tx.json");
/** A node error whose data echoes `data`: it says nothing about any tx. */
const nodeError = (name: string, data: string) => JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data }, id: "p" });
const GATEWAY = nodeError("GATEWAY_ERROR", "upstream echoed the request");
/** INVALID_TRANSACTION with no InvalidTxError in it: neither a result nor a refusal. */
const NEITHER = nodeError("INVALID_TRANSACTION", "no InvalidTxError here");
const vote = (): AttemptInput => ({ sessionId: "ks-7f3a", receiverId: "dao.sandbox", action: "FunctionCall", method: "act_proposal", args: { id: 0, action: "VoteApprove" }, depositYocto: "0", gasTGas: 30, violates: "none" });
const hashOfSent = (log: ReplayedRequest[]) => {
  const sends = log.filter((q) => q.method === "send_tx");
  expect(sends).toHaveLength(1);
  return baseEncode(createHash("sha256").update(encodeTransaction(decodeSignedTransaction(Buffer.from(sends[0].params.signed_tx_base64, "base64")).transaction)).digest());
};
const UNKNOWN = "it was not re-sent, and whether it landed is unknown";

let urls = 0;
let env: TmpEnv;
let kp: KeyPair;
let session: Session;
beforeEach(() => {
  failing.on = false;
  failing.when = () => true;
  useRpcUrl("sandbox", `http://failsafe-${++urls}.replay.invalid`);
  env = tmpEnv();
  vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
  vi.stubEnv("KEYHOLE_CREDENTIALS_DIR", env.KEYHOLE_CREDENTIALS_DIR);
  vi.stubEnv(SESSION_KEY_ENV, "");
  kp = KeyPair.fromRandom("ed25519");
  session = sampleSession({ publicKey: kp.getPublicKey().toString(), tools: sampleCageCard().tools });
});
afterEach(() => {
  failing.on = false;
  dropHeldKeys();
  vi.unstubAllEnvs();
});

describe("core: a redaction that fails withholds the text and keeps the error", () => {
  beforeEach(() => holdSessionKey(session, kp));

  it("sendAttempt, a body that is neither a result nor a refusal: SendFateUnknownError with its tx hash, signer and exit 3", async () => {
    const log = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: NEITHER });
    failing.on = true;
    const err = await sendAttempt(session, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    const hash = hashOfSent(log);
    expect([(err as SendFateUnknownError).txHash, (err as SendFateUnknownError).signerId, (err as SendFateUnknownError).exitCode]).toEqual([hash, "seat.sandbox", EXIT_TX_SENT]);
    expect((err as EnvironmentError).what).toBe(`send_tx for tx ${hash} (signer seat.sandbox): its answer is neither a transaction result nor a refusal: ${TEXT_WITHHELD}; ${UNKNOWN}`);
  });

  it("signAndSend's poll path (send_tx and tx both answer an error): SendFateUnknownError with the polled hash", async () => {
    const log = replayFetch({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: GATEWAY, tx: GATEWAY });
    failing.on = true;
    const root = KeyPair.fromRandom("ed25519");
    const err = await signAndSend("sandbox", "sandbox", root, "seat.sandbox", [actions.createAccount()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    const polled = log.find((q) => q.method === "tx")?.params.tx_hash;
    expect((err as SendFateUnknownError).txHash).toBe(polled);
    expect((err as EnvironmentError).what).toBe(`send_tx for tx ${polled} (signer sandbox): the node answered ${TEXT_WITHHELD}; reading the tx then failed: ${TEXT_WITHHELD}; ${UNKNOWN}`);
  });

  it("a landed vote whose settle read fails: LandedUnsettledError with its attempt (outcome, tx hash) intact", async () => {
    const log = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: LANDED_VOTE, tx: GATEWAY });
    failing.on = true;
    const err = await sendAttempt(session, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandedUnsettledError);
    const hash = JSON.parse(LANDED_VOTE).result.transaction.hash;
    expect((err as LandedUnsettledError).attempt.outcome).toEqual({ kind: "TxSuccess", txHash: hash, rawRpcJson: LANDED_VOTE });
    expect((err as LandedUnsettledError).exitCode).toBe(EXIT_TX_SENT);
    expect((err as EnvironmentError).what).toBe(`the attempt landed in a block (TxSuccess, tx ${hash}), but its refund was not seen: tx ${hash}: ${TEXT_WITHHELD}`);
    expect(log.filter((q) => q.method === "send_tx")).toHaveLength(1);
  });
});

describe("signWrap: a redaction that fails never turns a sent AddKey into 'nothing was sent'", () => {
  const opts: WrapOptions = { contract: "dao.sandbox", allow: ["act_proposal"], allowanceYocto: "50000000000000000000000", onAccount: "seat.sandbox", network: "sandbox" };
  const SIGN_RPC = { status: STATUS, "query:view_account": fx("015-b-view-dao-account.json"), "query:view_access_key": fx("022-d-add-fc-key.nonce.json") };
  /** A planned on-account wrap (the classifier faked), and the seat's full-access key in the tmp keychain. */
  async function plan() {
    replayFetch({ status: STATUS, "query:view_account": fx("015-b-view-dao-account.json") });
    const p = await planWrap(opts, { classify: async () => sampleCageCard().tools });
    saveAccountKey("sandbox", "seat.sandbox", KeyPair.fromRandom("ed25519"), env);
    return p;
  }
  const filesKept = (p: Awaited<ReturnType<typeof plan>>) =>
    existsSync(join(env.KEYHOLE_HOME, "sessions", `${p.draft.id}.json`)) && existsSync(sessionKeyPath(sessionFromPlan(p), env));

  it("the AddKey's fate unknown: SendFateUnknownError with the polled hash, and the key and session files stay", async () => {
    const p = await plan();
    const log = replayFetch({ ...SIGN_RPC, send_tx: GATEWAY, tx: GATEWAY });
    failing.on = true;
    const err = await signWrap(p, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect((err as SendFateUnknownError).txHash).toBe(log.find((q) => q.method === "tx")?.params.tx_hash);
    expect((err as EnvironmentError).what).toContain(`the node answered ${TEXT_WITHHELD}`);
    expect(filesKept(p)).toBe(true);
  });

  it("a sent AddKey that mustSucceed rejects with a reply's text: TxSentError (exit 3) naming the kept session, the files stay", async () => {
    const p = await plan();
    replayFetch({ ...SIGN_RPC, send_tx: fx("023-d-add-fc-key.send_tx.json") });
    // The only way into signWrap's last catch today (wrap.test.ts): mustSucceed reads a reply with no tx result.
    vi.mocked(mustSucceed).mockImplementationOnce((label, sent) => realMustSucceed(label, { ...sent, raw: GATEWAY, json: JSON.parse(GATEWAY) }));
    failing.on = true;
    const err = await signWrap(p, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxSentError);
    expect((err as TxSentError).exitCode).toBe(EXIT_TX_SENT);
    expect((err as EnvironmentError).what).toMatch(new RegExp(`^wrap ${p.draft.id}: no transaction result \\(${TEXT_WITHHELD.replace(/[()]/g, "\\$&")}\\) · tx \\S+ · session ${p.draft.id} kept: the AddKey may be on chain$`));
    expect(filesKept(p)).toBe(true);
  });
});

describe("serve: a redaction that fails is answered with WITHHELD, a tool error, never an MCP internal error", () => {
  const WITHHELD_LINE =
    "ERROR (environment): the result was withheld: its text could not be cleared of the session key's text (private key not shown) · if this call sent a tx, it may be on chain: look up the session account's latest txs before signing again";
  /** WITHHELD for an error that carries a tx hash (fix round 2, m2): the same, naming the tx. */
  const withheldNaming = (hash: string) =>
    `ERROR (environment): the result was withheld: its text could not be cleared of the session key's text (private key not shown) · tx ${hash} may be on chain: look it up before signing again`;
  async function connect(): Promise<Client> {
    saveSessionKey(session, kp, env);
    const server = await buildMcpServer(session);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    return client;
  }
  const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text);
  const voteReplies = (over: Record<string, string>) => ({
    "query:view_account": fx("015-b-view-dao-account.json"),
    "query:call_function": fx("028-e-get-proposal-0-after-fc-vote.json"),
    status: STATUS,
    "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"),
    ...over,
  });

  it.each([
    ["a view result (the final filter)", { "query:call_function": fx("017-b-get-policy.json") }, { name: "dao_get_policy", arguments: {} }],
    ["a vote with bad input (an InputError: no tx hash)", voteReplies({}), { name: "dao_vote", arguments: { id: -1, action: "maybe" } }],
    ["a landed vote (its result lines, then the final filter)", voteReplies({ send_tx: LANDED_VOTE, tx: LANDED_VOTE }), { name: "dao_vote", arguments: { id: 0, action: "approve" } }],
  ])("%s: WITHHELD, wrapped to 80 columns", async (_what, replies, call) => {
    const client = await connect();
    replayFetch(replies);
    failing.on = true;
    const r = await client.callTool(call);
    expect(r.isError).toBe(true);
    const [line, ...more] = textOf(r);
    expect(more).toEqual([]);
    expect(Math.max(...line.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
    expect(line.split("\n").join(" ")).toBe(WITHHELD_LINE);
    await client.close();
  });

  it.each([
    ["every redaction fails (errorResult, then the final filter)", () => true],
    // errorResult redacts the error's line; the final filter, the result's JSON
    ["only the error line fails to redact (errorResult); the final filter works", (t: string) => t.startsWith("ERROR (")],
  ])("a vote whose fate is unknown, %s: WITHHELD naming the tx hash (m2), never the bare withheld text", async (_what, when) => {
    const client = await connect();
    const log = replayFetch(voteReplies({ send_tx: GATEWAY, tx: GATEWAY }));
    failing.on = true;
    failing.when = when;
    const r = await client.callTool({ name: "dao_vote", arguments: { id: 0, action: "approve" } });
    expect(r.isError).toBe(true);
    const polled = log.find((q) => q.method === "tx")?.params.tx_hash as string;
    expect(polled).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const [line, ...more] = textOf(r);
    expect(more).toEqual([]);
    expect(Math.max(...line.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
    expect(line.split("\n").join(" ")).toBe(withheldNaming(polled));
    await client.close();
  });

  it("withheldTxHash: a tx hash by its form alone (base58, exactly 32 bytes, canonical); anything else names no tx", () => {
    const hash = baseEncode(createHash("sha256").update("a tx").digest());
    const none = new Set<string>();
    expect(withheldTxHash(new SendFateUnknownError(hash, "seat.sandbox", "why"), none)).toBe(hash);
    expect(withheldTxHash({ txHash: hash }, none)).toBe(hash);
    for (const txHash of [
      baseEncode(new Uint8Array(33).fill(7)), // 33 bytes
      baseEncode(new Uint8Array(31).fill(7)), // 31 bytes
      `1${hash}`, // a leading zero byte: 33 bytes
      `${hash.slice(0, -1)}0`, // "0" is not base58
      hash.slice(0, 20),
      "",
      42,
      undefined,
    ]) {
      expect(withheldTxHash({ txHash }, none)).toBeNull();
    }
    expect(withheldTxHash(new EnvironmentError("no hash here", "x"), none)).toBeNull();
    expect(withheldTxHash(null, none)).toBeNull();
    expect(withheldTxHash("a string", none)).toBeNull();
  });

  /** The session seed (32 bytes, base58): a hash by its form alone, and key text (sweep B, m3). */
  const seedOf = (pair: KeyPair) => privateKeyTexts(pair)[1];

  it("withheldTxHash (m3): a value that shares a 12-character window with the session key's text names no tx; the public key is not key text", () => {
    const hash = baseEncode(createHash("sha256").update("a tx").digest());
    const windows = keyTextWindows(privateKeyTexts(kp));
    const seed = seedOf(kp);
    // A seed passes for a hash by its form (base58, 32 bytes, canonical): only the windows refuse it.
    expect(withheldTxHash({ txHash: seed }, new Set())).toBe(seed);
    expect(withheldTxHash({ txHash: seed }, windows)).toBeNull();
    // One byte off the seed: still 43 or 44 base58 characters, all but the last one or two the seed's own.
    const nearSeed = baseDecode(seed);
    nearSeed[31] ^= 1;
    const lookalike = baseEncode(nearSeed);
    expect(lookalike).not.toBe(seed);
    expect(withheldTxHash({ txHash: lookalike }, new Set())).toBe(lookalike);
    expect(withheldTxHash({ txHash: lookalike }, windows)).toBeNull();
    // One shared window is enough; 11 characters make none (keyTextWindows of a text shorter than a window is empty).
    expect(withheldTxHash({ txHash: seed }, keyTextWindows([seed.slice(5, 17)]))).toBeNull();
    // ...wherever it sits in the value: the first window, a middle one, and the last.
    for (const at of [0, 20, seed.length - 12]) expect(withheldTxHash({ txHash: seed }, keyTextWindows([seed.slice(at, at + 12)])), `window at ${at}`).toBeNull();
    expect(keyTextWindows([seed.slice(5, 16)]).size).toBe(0);
    expect(withheldTxHash({ txHash: seed }, keyTextWindows([seed.slice(5, 16)]))).toBe(seed);
    // An unrelated hash is named, and so are the public key's bytes: the public key is public.
    expect(withheldTxHash({ txHash: hash }, windows)).toBe(hash);
    const publicKey = kp.getPublicKey().toString().slice("ed25519:".length);
    expect(withheldTxHash({ txHash: publicKey }, windows)).toBe(publicKey);
  });

  describe("a tool error whose .txHash is key text (sweep B, m3)", () => {
    it.each([
      ["every redaction fails (errorResult, then the final filter)", () => true],
      ["only the error line fails to redact (errorResult); the final filter works", (t: string) => t.startsWith("ERROR (")],
    ])("a SendFateUnknownError whose tx hash is the session seed, %s: the bare WITHHELD, no hash", async (_what, when) => {
      const client = await connect();
      replayFetch(voteReplies({}));
      const seed = seedOf(kp);
      vi.mocked(sendAttempt).mockImplementationOnce(async () => {
        throw new SendFateUnknownError(seed, "seat.sandbox", "why");
      });
      failing.on = true;
      failing.when = when;
      const r = await client.callTool({ name: "dao_vote", arguments: { id: 0, action: "approve" } });
      expect(r.isError).toBe(true);
      const [line, ...more] = textOf(r);
      expect(more).toEqual([]);
      expect(line.split("\n").join(" ")).toBe(WITHHELD_LINE);
      expect(JSON.stringify(r).includes(seed)).toBe(false);
      await client.close();
    });

    it("a .txHash on an error that is not a SendFateUnknownError is not named, valid hash or not", async () => {
      const client = await connect();
      replayFetch(voteReplies({}));
      const hash = baseEncode(createHash("sha256").update("a tx").digest());
      vi.mocked(sendAttempt).mockImplementationOnce(async () => {
        throw Object.assign(new EnvironmentError("some other error", "x"), { txHash: hash });
      });
      failing.on = true;
      const r = await client.callTool({ name: "dao_vote", arguments: { id: 0, action: "approve" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)[0].split("\n").join(" ")).toBe(WITHHELD_LINE);
      await client.close();
    });
  });

  it("the same call with redaction working is answered as usual (the WITHHELD above came from the failure)", async () => {
    const client = await connect();
    replayFetch({ "query:call_function": fx("017-b-get-policy.json") });
    const r = await client.callTool({ name: "dao_get_policy", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)[0].startsWith("{")).toBe(true);
    await client.close();
  });
});
