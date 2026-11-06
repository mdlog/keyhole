/**
 * DATA CONTRACT #10 sendAttempt, offline: fetch is stubbed to answer from the committed spike
 * capture, so the test checks what sendAttempt signs and sends, and that it parses the recorded
 * body with the same parser as the replay. The signing key is generated in memory for each test.
 * Also predictViolation (the `violates` label keyhole_attempt records) and attemptActions (all 8 actions).
 */
import { createHash } from "node:crypto";
import { KeyPair, PublicKey, type Action, baseDecode, baseEncode, createTransaction, decodeSignedTransaction, decodeTransaction, encodeTransaction } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandedUnsettledError, attemptActions, outcomeFromBody, predictViolation, sendAttempt, tgasToGas } from "../src/core/attempt.js";
import { rpcUrlFor, useRpcUrl } from "../src/core/config.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import { dropHeldKeys, holdSessionKey } from "../src/core/keys.js";
import type { Attempt, AttemptAction, AttemptInput, Session } from "../src/core/types.js";
import { SendFateUnknownError } from "../src/core/tx.js";
import { listPackIds, loadTargetPack } from "../src/packs/index.js";
import { NEGATIVE_CONTROL_FIXTURES, SANDBOX_FIXTURES, keyGlue, readFixture, replayFetch, sampleSession } from "./helpers.js";

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
const STATUS = fx("001-0-status.json");
/** TIMEOUT_ERROR as near-sandbox 2.14.0 sent it for a tx it had not seen final. */
const TIMEOUT =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"cause":"NOT_OBSERVED"},"name":"TIMEOUT_ERROR"},"code":-32000,"message":"Server error","data":"Timeout"},"id":"p"}';
/** A `tx` reply for settle: the landed body with another request id, so the test can tell the two bodies apart. */
const asTxStatus = (raw: string) => raw.replace(/"id":"[^"]*"}$/, '"id":"keyhole-settle"}');
/** The landed vote (027) without its refund receipt's outcome: the receipt tree is not complete yet. */
function withoutRefund(raw: string): string {
  const json = JSON.parse(raw);
  json.result.receipts_outcome = json.result.receipts_outcome.filter((o: { outcome: { executor_id: string } }) => o.outcome.executor_id !== "seat.sandbox");
  return JSON.stringify(json);
}

/**
 * A DeleteAccount of the signer itself, shaped like near-sandbox 2.14.0's answer (see test/tx.test.ts
 * deleteOwnAccount): tx status SuccessValue; the gas refund to the deleted signer, sent by `system`, failed.
 * As the fix round 4 probe saw: the gas refund's signer_id is the signer, with its key; the beneficiary transfer's
 * is `system`, with the empty key.
 */
function deleteOwnAccount(): { body: string; exp: string; refundId: string } {
  const json = JSON.parse(fx("069-i-burn-delete-key.send_tx.json"));
  const r = json.result;
  r.transaction.actions = [{ DeleteAccount: { beneficiary_id: "sandbox" } }];
  const [main, refund] = r.receipts_outcome;
  const transfer = JSON.parse(JSON.stringify(refund));
  transfer.id = "De36CxHy6zAD4h1gjjmumy2WShyXavhHhwBm8qnffskL";
  transfer.outcome.executor_id = "sandbox";
  main.outcome.receipt_ids = [transfer.id, refund.id];
  refund.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "seat.sandbox" } } } } };
  r.receipts_outcome = [main, transfer, refund];
  const fromSystem = (id: string, receiver: string, signerId: string, key: string) => ({
    predecessor_id: "system",
    receiver_id: receiver,
    receipt_id: id,
    receipt: { Action: { signer_id: signerId, signer_public_key: key, gas_price: "0", output_data_receivers: [], input_data_ids: [], actions: [{ Transfer: { deposit: "1" } }], is_promise_yield: false } },
    priority: 0,
  });
  const receipts = [fromSystem(transfer.id, "sandbox", "system", `ed25519:${"1".repeat(32)}`), fromSystem(refund.id, "seat.sandbox", "seat.sandbox", r.transaction.public_key)];
  return { body: JSON.stringify(json), exp: JSON.stringify({ ...json, result: { ...r, receipts } }), refundId: refund.id };
}

let session: Session;
let urls = 0;

beforeEach(() => {
  const kp = KeyPair.fromRandom("ed25519");
  session = sampleSession({ publicKey: kp.getPublicKey().toString() });
  holdSessionKey(session, kp);
  useRpcUrl("sandbox", `http://sandbox-${++urls}.replay.invalid`); // assertChain remembers a check per URL: one status read per test
});
afterEach(() => dropHeldKeys());

const vote = (over: Partial<AttemptInput> = {}): AttemptInput => ({
  sessionId: "ks-7f3a",
  receiverId: "dao.sandbox",
  action: "FunctionCall",
  method: "act_proposal",
  args: { id: 0, action: "VoteApprove" },
  depositYocto: "0",
  gasTGas: 30,
  violates: "none",
  ...over,
});

describe("sendAttempt (replayed RPC)", () => {
  it("signs one FunctionCall with the session key and parses the recorded refusal", async () => {
    const nonceBody = fx("051-g1-method-add_proposal.nonce.json");
    const refusal = fx("052-g1-method-add_proposal.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": nonceBody, send_tx: refusal });

    const a = await sendAttempt(session, vote({ method: "add_proposal", args: { proposal: { description: "x", kind: "Vote" } }, violates: "method" }));

    expect(a.outcome.kind).toBe("Refusal");
    expect(a.outcome.kind === "Refusal" && a.outcome.errorName).toBe("MethodNameMismatch");
    expect(a.outcome.rawRpcJson).toBe(refusal);

    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx"]); // a refusal never reached a block: nothing to settle
    expect(sent[1].params).toEqual({ request_type: "view_access_key", finality: "final", account_id: "seat.sandbox", public_key: session.publicKey });
    expect(sent[2].params.wait_until).toBe("FINAL");
    const tx = decodeSignedTransaction(Buffer.from(sent[2].params.signed_tx_base64, "base64")).transaction;
    const recorded = JSON.parse(nonceBody).result;
    expect(tx.signerId).toBe("seat.sandbox");
    expect(tx.publicKey.toString()).toBe(session.publicKey);
    expect(tx.receiverId).toBe("dao.sandbox");
    expect(tx.nonce).toBe(BigInt(recorded.nonce) + 1n);
    expect(Buffer.from(tx.blockHash)).toEqual(Buffer.from(baseDecode(recorded.block_hash)));
    expect(tx.actions).toHaveLength(1);
    const fc = tx.actions[0].functionCall;
    expect(fc?.methodName).toBe("add_proposal");
    expect(fc?.deposit).toBe(0n);
    expect(fc?.gas).toBe(30n * 10n ** 12n);
    // Signed by the session key: the signature verifies over the tx hash with the session's public key.
    const signed = decodeSignedTransaction(Buffer.from(sent[2].params.signed_tx_base64, "base64"));
    const digest = new Uint8Array(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    expect(PublicKey.fromString(session.publicKey).verify(digest, new Uint8Array(signed.signature.ed25519Signature?.data ?? []))).toBe(true);
  });

  it("the nonce read, the send and the settle poll all use the URL assertChain verified, even if the RPC URL is switched during the check", async () => {
    const checked = rpcUrlFor("sandbox");
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: landed, tx: asTxStatus(landed) });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "status") useRpcUrl("sandbox", "http://switched.replay.invalid");
      return inner(input, init);
    };
    await sendAttempt(session, vote());
    expect(rpcUrlFor("sandbox")).toBe("http://switched.replay.invalid");
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`status ${checked}`, `query ${checked}`, `send_tx ${checked}`, `tx ${checked}`]);
  });

  it("two attempts with one session key run one after the other: the second reads its nonce after the first is settled", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: landed, tx: asTxStatus(landed) });
    const [first, second] = await Promise.all([sendAttempt(session, vote()), sendAttempt(session, vote({ args: { id: 0, action: "VoteReject" } }))]);
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx", "query", "send_tx", "tx"]);
    expect([first.outcome.kind, second.outcome.kind]).toEqual(["TxSuccess", "TxSuccess"]);
    const votedAction = (i: number) => {
      const fc = decodeSignedTransaction(Buffer.from(sent.filter((s) => s.method === "send_tx")[i].params.signed_tx_base64, "base64")).transaction.actions[0].functionCall;
      return JSON.parse(Buffer.from(fc?.args ?? []).toString("utf8")).action;
    };
    expect([votedAction(0), votedAction(1)]).toEqual(["VoteApprove", "VoteReject"]); // in call order
  });

  it("an attempt that fails after its send still releases the key: the next one with it runs", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({
      status: STATUS,
      "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"),
      send_tx: [fx("053-g1-method-add_proposal.tx_status.json"), landed],
      // The first send's answer says nothing of the tx; polling it then fails at once (INVALID_TRANSACTION).
      tx: [fx("052-g1-method-add_proposal.send_tx.json"), asTxStatus(landed)],
    });
    const [first, second] = await Promise.allSettled([sendAttempt(session, vote()), sendAttempt(session, vote())]);
    expect(first.status === "rejected" && first.reason instanceof SendFateUnknownError).toBe(true);
    expect(second.status === "fulfilled" && second.value.outcome.kind).toBe("TxSuccess");
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx", "query", "send_tx", "tx"]);
  });

  it("an in-scope vote that landed is TxSuccess with the recorded tx hash, settled before it returns", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: landed, tx: asTxStatus(landed) });
    const a = await sendAttempt(session, vote());
    expect(a.outcome).toEqual({ kind: "TxSuccess", txHash: JSON.parse(landed).result.transaction.hash, rawRpcJson: landed });
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx"]);
    expect(sent[3].params).toEqual({ tx_hash: JSON.parse(landed).result.transaction.hash, sender_account_id: "seat.sandbox", wait_until: "FINAL" });
  });

  it("after burn: the key is gone, so it signs against a fresh block hash and parses AccessKeyNotFound", async () => {
    const sent = replayFetch({
      status: STATUS,
      "query:view_access_key": fx("070-i-view-burned-key.json"),
      block: fx("071-i-attempt-after-burn.block.json"),
      send_tx: fx("072-i-attempt-after-burn.send_tx.json"),
    });
    const a = await sendAttempt(session, vote());
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "block", "send_tx"]);
    expect(a.outcome.kind === "Refusal" && a.outcome.errorName).toBe("AccessKeyNotFound");
  });

  it("checks its input before any RPC (fetch stays offline)", async () => {
    await expect(sendAttempt(session, vote({ sessionId: "ks-0000" }))).rejects.toBeInstanceOf(InputError);
    await expect(sendAttempt(session, vote({ depositYocto: "1.5" }))).rejects.toBeInstanceOf(InputError);
    await expect(sendAttempt(session, vote({ method: undefined }))).rejects.toBeInstanceOf(InputError);
    await expect(sendAttempt(session, vote({ action: "AddKey", method: undefined, args: {} }))).rejects.toBeInstanceOf(InputError);
  });

  it("checks the chain before its first send: on a mainnet RPC it reads no key and signs nothing", async () => {
    const sent = replayFetch({ status: STATUS.replace('"chain_id":"test-chain-FSZ71"', '"chain_id":"mainnet"') });
    await expect(sendAttempt(session, vote())).rejects.toThrow(/mainnet/);
    expect(sent.map((s) => s.method)).toEqual(["status"]);
  });

  it("a landed panic is a ContractPanic, settled like any landed tx", async () => {
    const panic = readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("051-g1-method-add_proposal.nonce.json"), send_tx: panic, tx: asTxStatus(panic) });
    const a = await sendAttempt(session, vote({ method: "add_proposal", args: {} }));
    expect(a.outcome).toMatchObject({ kind: "ContractPanic", message: "Smart contract panicked: panicked at 'ERR_MIN_BOND', src/proposals.rs:392:9", rawRpcJson: panic });
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx"]);
  });

  it("a DeleteAccount attempt of the session's own account whose gas refund failed is TxSuccess (fix round 3)", async () => {
    const { body, exp } = deleteOwnAccount();
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp, tx: asTxStatus(body) });
    const a = await sendAttempt(session, vote({ receiverId: session.accountId, action: "DeleteAccount", method: undefined, args: { beneficiaryId: "sandbox" } }));
    expect(a.outcome).toEqual({ kind: "TxSuccess", txHash: JSON.parse(body).result.transaction.hash, rawRpcJson: body });
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "EXPERIMENTAL_tx_status", "tx"]);
  });

  it("TIMEOUT_ERROR on send_tx: the outcome is read from the polled tx body, and send_tx is sent once", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: TIMEOUT, tx: [landed, asTxStatus(landed)] });
    const a = await sendAttempt(session, vote());
    expect(a.outcome).toEqual({ kind: "TxSuccess", txHash: JSON.parse(landed).result.transaction.hash, rawRpcJson: landed });
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx", "tx"]);
  });
});

describe("sendAttempt waits for the refund (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a landed vote is settled before sendAttempt returns, and rawRpcJson stays the first send_tx body", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({
      status: STATUS,
      "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"),
      send_tx: landed,
      tx: [withoutRefund(landed), asTxStatus(landed)],
    });
    let done = false;
    const p = sendAttempt(session, vote()).finally(() => (done = true));
    for (let i = 0; i < 50 && !done; i++) await vi.advanceTimersByTimeAsync(100);
    const a = await p;
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx", "tx"]);
    expect(a.outcome.rawRpcJson).toBe(landed);
  });

  it("a landed vote whose refund is never seen: LandedUnsettledError says it landed (kind, hash), keeps the outcome, and nothing is re-sent", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: landed, tx: withoutRefund(landed) });
    let done = false;
    const settled = sendAttempt(session, vote())
      .then(
        () => null,
        (e: unknown) => e,
      )
      .finally(() => (done = true));
    for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(100);
    const err = await settled;
    expect(err).toBeInstanceOf(LandedUnsettledError);
    expect(err).toBeInstanceOf(EnvironmentError);
    const hash = JSON.parse(landed).result.transaction.hash;
    expect((err as LandedUnsettledError).message.startsWith(`the attempt landed in a block (TxSuccess, tx ${hash}), but its refund was not seen: tx ${hash}: receipt tree incomplete after 20 tx polls`)).toBe(true);
    expect((err as LandedUnsettledError).tryThis).toContain("do not send it again");
    const kept: Attempt = (err as LandedUnsettledError).attempt;
    expect(kept.outcome).toEqual({ kind: "TxSuccess", txHash: hash, rawRpcJson: landed });
    expect(kept.violates).toBe("none");
    expect(sent.filter((s) => s.method === "send_tx")).toHaveLength(1);
    expect(sent.filter((s) => s.method === "tx")).toHaveLength(20);
  });
});

describe("sendAttempt when the send's fate is unknown (fake timers, Task 2 fix round 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Runs `p` to its end on fake time. */
  async function drive<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 300 && !done; i++) await vi.advanceTimersByTimeAsync(100);
    return p;
  }
  /** The hash sendAttempt computed for the tx inside a send_tx request. */
  const localHash = (signedTxBase64: string) =>
    baseEncode(createHash("sha256").update(encodeTransaction(decodeSignedTransaction(Buffer.from(signedTxBase64, "base64")).transaction)).digest());

  it("a send_tx answered HTTP 502, then tx finds the landed vote: the outcome is read from that body and settled, sent once", async () => {
    const landed = fx("027-e-fc-vote-approve-0.send_tx.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: "{}", tx: [landed, asTxStatus(landed)] });
    const replay = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const res = await replay(input, init); // logged
      return JSON.parse(String(init?.body)).method === "send_tx" ? new Response("<html>bad gateway</html>", { status: 502 }) : res;
    };
    const a = await drive(sendAttempt(session, vote()));
    expect(a.outcome).toEqual({ kind: "TxSuccess", txHash: JSON.parse(landed).result.transaction.hash, rawRpcJson: landed });
    expect(sent.map((s) => s.method)).toEqual(["status", "query", "send_tx", "tx", "tx"]);
  });

  it("a send_tx body that is neither a result nor a refusal, and a tx never found: SendFateUnknownError with the local hash and the signer", async () => {
    const unknown = fx("053-g1-method-add_proposal.tx_status.json");
    const sent = replayFetch({ status: STATUS, "query:view_access_key": fx("051-g1-method-add_proposal.nonce.json"), send_tx: unknown, tx: unknown });
    const err = await drive(sendAttempt(session, vote())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect(err).toBeInstanceOf(EnvironmentError);
    const hash = localHash(sent[2].params.signed_tx_base64);
    expect((err as SendFateUnknownError).txHash).toBe(hash);
    expect((err as SendFateUnknownError).signerId).toBe(session.accountId);
    expect((err as SendFateUnknownError).what.startsWith(`send_tx for tx ${hash} (signer ${session.accountId}): the node answered UNKNOWN_TRANSACTION`)).toBe(true);
    expect((err as SendFateUnknownError).tryThis).toBe(`look tx ${hash} up on chain before signing anything again (signer ${session.accountId})`);
    expect(sent.filter((s) => s.method === "send_tx")).toHaveLength(1);
    expect(sent.filter((s) => s.method === "tx")).toHaveLength(6);
  });
});

describe("predictViolation (the rule an attempt breaks, from the session's scope alone)", () => {
  const s = sampleSession();
  const inScope = { receiverId: s.receiverId, action: "FunctionCall", method: "act_proposal", args: {}, depositYocto: "0", gasTGas: 30 } as const;

  it("one rule each: action, deposit, receiver, method", () => {
    expect(predictViolation(s, { receiverId: "attacker.sandbox", action: "Transfer", args: {}, depositYocto: "1", gasTGas: 0 })).toBe("action");
    expect(predictViolation(s, { receiverId: s.receiverId, action: "FunctionCall", method: "act_proposal", args: {}, depositYocto: "1", gasTGas: 30 })).toBe("deposit");
    expect(predictViolation(s, { receiverId: "other.sandbox", action: "FunctionCall", method: "act_proposal", args: {}, depositYocto: "0", gasTGas: 30 })).toBe("receiver");
    expect(predictViolation(s, { receiverId: s.receiverId, action: "FunctionCall", method: "add_proposal", args: {}, depositYocto: "0", gasTGas: 30 })).toBe("method");
  });

  it("an in-scope call breaks none", () => {
    expect(predictViolation(s, inScope)).toBe("none");
  });

  it("several rules broken: the first one the verifier checks (action, deposit, receiver, method)", () => {
    expect(predictViolation(s, { receiverId: "other.sandbox", action: "Transfer", args: {}, depositYocto: "1", gasTGas: 0 })).toBe("action");
    expect(predictViolation(s, { ...inScope, receiverId: "other.sandbox", method: "add_proposal", depositYocto: "1" })).toBe("deposit");
    expect(predictViolation(s, { ...inScope, receiverId: "other.sandbox", method: "add_proposal" })).toBe("receiver");
  });

  it("allowance comes before the permission checks: prepaid gas or a deposit beyond the session's allowance", () => {
    expect(predictViolation({ ...s, allowanceYocto: "1" }, inScope)).toBe("allowance");
    expect(predictViolation(s, { ...inScope, gasTGas: 100 })).toBe("allowance"); // needs ≈0.101 NEAR (spike j-measure-100tgas) of 0.05
    expect(predictViolation(s, { ...inScope, gasTGas: 49 })).toBe("none"); // minAllowanceYocto(49) = 0.05 NEAR exactly
    expect(predictViolation(s, { ...inScope, method: "add_proposal", gasTGas: 100 })).toBe("allowance");
    expect(predictViolation(s, { receiverId: "attacker.sandbox", action: "Transfer", args: {}, depositYocto: String(10n ** 24n), gasTGas: 0 })).toBe("allowance");
  });

  it("an empty method_names allows any method, as on chain", () => {
    expect(predictViolation({ ...s, methodNames: [] }, { ...inScope, method: "anything" })).toBe("none");
  });

  it("every action but FunctionCall is an action violation", () => {
    for (const action of ["Transfer", "AddKey", "DeleteKey", "CreateAccount", "DeleteAccount", "DeployContract", "Stake"] as const) {
      expect(predictViolation(s, { receiverId: s.receiverId, action, args: {}, depositYocto: "0", gasTGas: 0 }), action).toBe("action");
    }
  });

  it("agrees with the `violates` of every pack's negative tests", async () => {
    let checked = 0;
    for (const id of await listPackIds()) {
      const pack = await loadTargetPack(id);
      const receiverId = `${id}.sandbox`;
      const scope = sampleSession({ receiverId, methodNames: pack.tools.filter((t) => t.kind === "call").map((t) => t.method ?? "") });
      const receivers = { receiver: receiverId, "other-receiver": "other-dao.sandbox", attacker: "attacker.sandbox" };
      for (const t of pack.negativeTests) {
        const keyScope = t.keyState === "tiny-allowance-key" ? { ...scope, allowanceYocto: "1" } : scope;
        const input = { receiverId: receivers[t.receiver], action: t.action, method: t.method, args: t.args, depositYocto: t.depositYocto, gasTGas: t.gasTGas };
        expect(predictViolation(keyScope, input), `${id}.${t.id}`).toBe(t.violates);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("malformed input is an input error", () => {
    expect(() => predictViolation(s, { ...inScope, depositYocto: "1.5" })).toThrow(InputError);
    expect(() => predictViolation(s, { ...inScope, gasTGas: -1 })).toThrow(InputError);
  });
});

describe("attempt helpers", () => {
  it("tgasToGas", () => {
    expect(tgasToGas(30)).toBe(30_000_000_000_000n);
    expect(tgasToGas(0.5)).toBe(500_000_000_000n);
    expect(() => tgasToGas(-1)).toThrow(InputError);
  });

  it("a Transfer attempt signs one Transfer action", () => {
    const [act] = attemptActions(vote({ action: "Transfer", method: undefined, depositYocto: "1" }));
    expect(act.transfer?.deposit).toBe(1n);
  });

  it("outcomeFromBody: a failed receipt that is a gas refund is not the tx's failure (fix round 3); without the refund ids it is", () => {
    const { body, refundId } = deleteOwnAccount();
    const hash = JSON.parse(body).result.transaction.hash;
    expect(outcomeFromBody(body, undefined, [refundId])).toEqual({ kind: "TxSuccess", txHash: hash, rawRpcJson: body });
    expect(outcomeFromBody(body)?.kind).toBe("ContractPanic"); // the replay path has no EXPERIMENTAL_tx_status: strict
  });

  it("outcomeFromBody: a landed panic is ContractPanic with the contract's message", () => {
    const o = outcomeFromBody(readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json"));
    expect(o?.kind).toBe("ContractPanic");
    expect(o?.kind === "ContractPanic" && o.message).toBe("Smart contract panicked: panicked at 'ERR_MIN_BOND', src/proposals.rs:392:9");
  });
});

describe("attemptActions (keyhole_attempt: all 8 actions)", () => {
  const signer = KeyPair.fromRandom("ed25519");
  const pk = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const WASM_HEADER = "AGFzbQEAAAA="; // "\0asm" + version 1
  const attempt = (action: AttemptAction, args: Record<string, unknown>, depositYocto = "0") => vote({ action, method: undefined, args, depositYocto, gasTGas: 0 });
  const CASES: Record<string, { args: Record<string, unknown>; depositYocto?: string; check: (a: Action) => void }> = {
    AddKey: {
      args: { publicKey: pk, permission: "FullAccess" },
      check: (a) => {
        expect(a.addKey?.publicKey.toString()).toBe(pk);
        expect(a.addKey?.accessKey.permission.fullAccess).toBeDefined();
      },
    },
    DeleteKey: { args: { publicKey: pk }, check: (a) => expect(a.deleteKey?.publicKey.toString()).toBe(pk) },
    CreateAccount: { args: {}, check: (a) => expect(a.createAccount).toBeDefined() },
    DeleteAccount: { args: { beneficiaryId: "attacker.sandbox" }, check: (a) => expect(a.deleteAccount?.beneficiaryId).toBe("attacker.sandbox") },
    DeployContract: { args: { codeBase64: WASM_HEADER }, check: (a) => expect(Buffer.from(a.deployContract?.code ?? []).toString("base64")).toBe(WASM_HEADER) },
    Stake: {
      args: { publicKey: pk },
      depositYocto: "7",
      check: (a) => {
        expect(a.stake?.stake).toBe(7n);
        expect(a.stake?.publicKey.toString()).toBe(pk);
      },
    },
  };

  it.each(["AddKey", "DeleteKey", "CreateAccount", "DeleteAccount", "DeployContract", "Stake"] as const)("attemptActions builds %s", (action) => {
    const c = CASES[action];
    const acts = attemptActions(attempt(action, c.args, c.depositYocto));
    expect(acts).toHaveLength(1);
    expect(acts[0].enum).toBe(action[0].toLowerCase() + action.slice(1));
    c.check(acts[0]);
    // Signable as is: it survives a borsh round trip inside a transaction (a decoded action carries only its variant key).
    const tx = createTransaction("seat.sandbox", signer.getPublicKey(), "dao.sandbox", 1n, acts, new Uint8Array(32));
    const bytes = encodeTransaction(tx);
    const decoded = decodeTransaction(bytes);
    expect(Object.keys(decoded.actions[0])).toEqual([acts[0].enum]);
    expect(Buffer.from(encodeTransaction(decoded)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("AddKey with a function-call permission; allowanceYocto may be left out (unlimited)", () => {
    const [scoped] = attemptActions(attempt("AddKey", { publicKey: pk, permission: { receiverId: "dao.sandbox", methodNames: ["add_proposal"], allowanceYocto: "1" } }));
    expect(scoped.addKey?.accessKey.permission.functionCall).toMatchObject({ receiverId: "dao.sandbox", methodNames: ["add_proposal"], allowance: 1n });
    const [open] = attemptActions(attempt("AddKey", { publicKey: pk, permission: { receiverId: "dao.sandbox", methodNames: [] } }));
    expect(open.addKey?.accessKey.permission.functionCall?.allowance).toBeUndefined();
  });

  it("each action's args are checked: input errors, before any RPC", () => {
    const bad: Array<[AttemptAction, Record<string, unknown>, string?]> = [
      ["AddKey", {}],
      ["AddKey", { publicKey: pk }],
      ["AddKey", { publicKey: pk, permission: "Full" }],
      ["AddKey", { publicKey: pk, permission: { receiverId: "dao.sandbox", methodNames: "act_proposal" } }],
      ["AddKey", { publicKey: pk, permission: { receiverId: "", methodNames: [] } }],
      ["AddKey", { publicKey: pk, permission: { receiverId: "dao.sandbox", methodNames: [], allowanceYocto: "0.5" } }],
      ["DeleteKey", {}],
      ["DeleteKey", { publicKey: "ed25519:nope" }],
      ["DeleteKey", { publicKey: pk.replace("ed25519:", "secp256k1:") }],
      ["DeleteAccount", {}],
      ["DeleteAccount", { beneficiaryId: "" }],
      ["DeployContract", {}],
      ["DeployContract", { codeBase64: "not base64!" }],
      ["Stake", { publicKey: pk }, "1.5"],
      ["Stake", {}, "1"],
    ];
    for (const [action, args, deposit] of bad) {
      expect(() => attemptActions(attempt(action, args, deposit)), `${action} ${JSON.stringify(args)}`).toThrow(InputError);
    }
  });

  it("a 64-byte value in args.publicKey is refused, so a private key never enters a signed transaction, and the error never echoes it", () => {
    const leaked = KeyPair.fromRandom("ed25519").toString(); // in memory only; asserted with booleans
    for (const action of ["AddKey", "DeleteKey", "Stake"] as const) {
      let message = "";
      try {
        attemptActions(attempt(action, { publicKey: leaked, permission: "FullAccess" }, "1"));
      } catch (e) {
        expect(e).toBeInstanceOf(InputError);
        message = (e as InputError).message;
      }
      expect(message.length > 0).toBe(true);
      expect(message.includes(leaked)).toBe(false);
      expect(message.includes(leaked.slice(8, 30))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Final sweep: C-T19c (a session send never signs with a full-access key), C-T18b and C-T19h (a body is made
// printable before it is cut: RPC URLs scrubbed, held key text replaced).

/** view_access_key for a key with full access (nearcore's shape; nonce and block hash present). */
const FULL_ACCESS = '{"jsonrpc":"2.0","result":{"block_hash":"11111111111111111111111111111111","block_height":1,"nonce":1,"permission":"FullAccess"},"id":"x"}';
/** The 12-character windows of a key's two text forms (test memory only; compared with booleans). */
function keyWindows(kp: KeyPair): string[] {
  const extended = kp.toString().slice("ed25519:".length);
  const out: string[] = [];
  for (const form of [extended, baseEncode(baseDecode(extended).slice(0, 32))]) for (let i = 0; i + 12 <= form.length; i++) out.push(form.slice(i, i + 12));
  return out;
}
/** An INVALID_TRANSACTION reply with no InvalidTxError in it (neither a refusal nor a result) whose data is `data`. */
const invalidTxWith = (data: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data }, id: "p" });

describe("final sweep: what a session send signs with, and what its errors print", () => {
  it("C-T19c: a session key the chain lists with full access is never signed with: an EnvironmentError, nothing sent", async () => {
    const log = replayFetch({ status: STATUS, "query:view_access_key": FULL_ACCESS, send_tx: fx("027-e-fc-vote-approve-0.send_tx.json") });
    const err = await sendAttempt(session, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect(err).not.toBeInstanceOf(SendFateUnknownError);
    expect((err as EnvironmentError).what).toBe(`the session key ${session.publicKey} has full access on seat.sandbox; a session send signs only with a function-call key`);
    expect((err as EnvironmentError).tryThis).toBe("nothing was signed: delete that key with the account's own full-access key, then run keyhole wrap for a new session");
    expect((err as EnvironmentError).exitCode).toBe(2);
    expect(log.map((s) => s.method)).toEqual(["status", "query"]);
  });

  it("C-T19c: a permission that is neither FunctionCall nor FullAccess is refused the same way (fail-safe)", async () => {
    const other = FULL_ACCESS.replace('"FullAccess"', '{"GasKeyFullAccess":{"balance":"1","num_nonces":1}}');
    const log = replayFetch({ status: STATUS, "query:view_access_key": other });
    const err = await sendAttempt(session, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`view_access_key seat.sandbox ${session.publicKey} answered a permission that is not a function-call key; a session send signs only with one`);
    expect(log.map((s) => s.method)).not.toContain("send_tx");
  });

  it("C-T18b: a body that is neither a result nor a refusal is printed scrubbed of the RPC URL's path and query", async () => {
    const url = "https://rpc-attempt.example.invalid/v3/k3yt0ken?apiKey=s3cr3tvalue";
    useRpcUrl("sandbox", url);
    replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: invalidTxWith(`upstream ${url} rejected the tx`) });
    const err = await sendAttempt(session, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    const printed = `${(err as EnvironmentError).message} ${(err as EnvironmentError).tryThis}`;
    expect(printed).toContain("its answer is neither a transaction result nor a refusal: ");
    expect(printed).toContain("upstream https://rpc-attempt.example.invalid/… rejected the tx");
    expect(["/v3", "k3yt0ken", "s3cr3tvalue", "apiKey"].filter((secret) => printed.includes(secret))).toEqual([]);
  });

  it("C-T19h: a held key's text that straddles the 300-character cut is replaced before the cut: no 12-character part of it survives", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const held = sampleSession({ id: "ks-7f3a", publicKey: kp.getPublicKey().toString() });
    holdSessionKey(held, kp);
    const seed = baseEncode(baseDecode(kp.toString().slice("ed25519:".length)).slice(0, 32));
    const prefix = invalidTxWith("").indexOf('"data":"') + '"data":"'.length;
    const x = keyGlue(seed, keyWindows(kp), { before: "x" }).before; // "x" unless the key continues into it (fix round 2, I2)
    const body = invalidTxWith(`${x.repeat(300 - 20 - prefix)}${seed} and more`); // the cut at 300 falls 20 characters into the seed
    replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: body });
    const err = await sendAttempt(held, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    const printed = (err as EnvironmentError).message;
    expect(printed.includes(`${x}${"(private key not shown)".slice(0, 20)}; it was not re-sent`)).toBe(true); // the cut falls in the replacement
    expect(keyWindows(kp).some((w) => printed.includes(w))).toBe(false);
  });

  it("C-T19h: an RPC error whose text holds a held key at the cut (rpcErrorTextAt) prints no 12-character part of it", async () => {
    const extended = KeyPair.fromString(KeyPair.fromRandom("ed25519").toString() as `ed25519:${string}`);
    const held = sampleSession({ id: "ks-7f3a", publicKey: extended.getPublicKey().toString() });
    holdSessionKey(held, extended);
    const text = extended.toString().slice("ed25519:".length);
    const nonceError = (data: string) => JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "INTERNAL_ERROR", info: {} }, code: -32000, message: "Server error", data }, id: "x" });
    const lead = "INTERNAL_ERROR: ".length;
    const y = keyGlue(text, keyWindows(extended), { before: "y" }).before; // "y" unless the key continues into it (fix round 2, I2)
    replayFetch({ status: STATUS, "query:view_access_key": nonceError(`${y.repeat(300 - 30 - lead)}${text}`) });
    const err = await sendAttempt(held, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    const printed = (err as EnvironmentError).message;
    expect(printed.startsWith(`view_access_key seat.sandbox failed: INTERNAL_ERROR: ${y.repeat(3)}`)).toBe(true);
    expect(keyWindows(extended).some((w) => printed.includes(w))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Sweep A fix round 1 (I1): a reply under the 32 MiB body cap can hold a base58 run of millions of characters. The
// redactor scans it without overflowing the stack, so a send whose fate is unknown keeps its class and its tx hash
// (a RangeError there read as "nothing was sent": serve showed no hash, signWrap deleted a key that may be on chain).

describe("fix round 1 (I1): a reply with a 7M-character base58 run", () => {
  const BIG_RUN = "A".repeat(7_000_000);
  const hashOfSent = (log: { method: string; params: any }[]) => {
    const sends = log.filter((q) => q.method === "send_tx");
    expect(sends).toHaveLength(1);
    return baseEncode(createHash("sha256").update(encodeTransaction(decodeSignedTransaction(Buffer.from(sends[0].params.signed_tx_base64, "base64")).transaction)).digest());
  };

  it("in a send_tx body that is neither a result nor a refusal: SendFateUnknownError with the tx hash, exit 3, the text cut at 300", async () => {
    const log = replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: invalidTxWith(BIG_RUN) });
    const err = await sendAttempt(session, vote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect((err as SendFateUnknownError).txHash).toBe(hashOfSent(log));
    expect((err as SendFateUnknownError).signerId).toBe("seat.sandbox");
    expect((err as SendFateUnknownError).exitCode).toBe(3);
    const what = (err as EnvironmentError).what;
    const body = invalidTxWith(BIG_RUN).slice(0, 300);
    expect(what).toBe(`send_tx for tx ${hashOfSent(log)} (signer seat.sandbox): its answer is neither a transaction result nor a refusal: ${body}; it was not re-sent, and whether it landed is unknown`);
  }, 30_000);
});
