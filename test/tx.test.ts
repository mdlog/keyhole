/**
 * src/core/tx.ts offline: signAndSend (chain check, one view_access_key read, send_tx FINAL, the
 * TIMEOUT_ERROR rule), settle, mustSucceed and successValue, against the committed spike capture through
 * replayFetch. Signing keys are generated in memory for each test and never leave it.
 */
import { createHash } from "node:crypto";
import { KeyPair, actions, baseDecode, baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcUrlFor, useRpcUrl } from "../src/core/config.js";
import { EnvironmentError } from "../src/core/errors.js";
import { KEY_NOT_SHOWN, dropHeldKeys, holdSessionKey } from "../src/core/keys.js";
import * as txModule from "../src/core/tx.js";
import { type SentTx, SendFateUnknownError, landedFailure, mustSucceed, sendAttemptTx, settle, signAndSend, successValue } from "../src/core/tx.js";
import { NEGATIVE_CONTROL_FIXTURES, type ReplayedRequest, SANDBOX_FIXTURES, keyGlue, readFixture, replayFetch, sampleSession } from "./helpers.js";

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
const NEAR = 10n ** 24n;

/** TIMEOUT_ERROR exactly as near-sandbox 2.14.0 sent it (HTTP 408) for a tx it had not seen final. */
const TIMEOUT =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"cause":"NOT_OBSERVED"},"name":"TIMEOUT_ERROR"},"code":-32000,"message":"Server error","data":"Timeout"},"id":"p"}';

/** replayFetch, except that TIMEOUT_ERROR bodies come back with HTTP 408, as nearcore sends them. */
function replay(bodies: Record<string, string | readonly string[]>): ReplayedRequest[] {
  const log = replayFetch(bodies);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = await (await inner(input, init)).text();
    return new Response(body, { status: body.includes('"TIMEOUT_ERROR"') ? 408 : 200 });
  };
  return log;
}

/** The hash the signer computed: sha256 of the borsh-encoded transaction inside a send_tx request. */
function localHash(sendTx: ReplayedRequest): string {
  const signed = decodeSignedTransaction(Buffer.from(sendTx.params.signed_tx_base64, "base64"));
  return baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
}

/** 027 (a landed vote) without the refund receipt's outcome: the receipt tree is not complete yet. */
function withoutRefund(raw: string): string {
  const json = JSON.parse(raw);
  json.result.receipts_outcome = json.result.receipts_outcome.filter((o: { outcome: { executor_id: string } }) => o.outcome.executor_id !== "seat.sandbox");
  return JSON.stringify(json);
}

/**
 * A DeleteAccount of the signer itself, shaped like near-sandbox 2.14.0's answer (probed live in T2 fix rounds 3
 * and 4): the tx's own status is SuccessValue; the main receipt spawns DeleteAccount's balance transfer to the
 * beneficiary and the gas refund to the signer, both sent by `system`; the refund fails, because the signer is
 * gone. `exp` is the EXPERIMENTAL_tx_status body: the same plus `receipts`, where predecessor_id lives (the
 * live answer lists only the two system receipts: the main one is local). As nearcore builds them, and as the
 * fix round 4 probe saw, the gas refund carries the signer as its signer_id, with the signer's key; the beneficiary
 * transfer (a balance refund) carries signer_id `system` and the empty key. Built from 069 (a landed DeleteKey).
 * Options reshape the refund (`refundPredecessor`, `refundSignerId`, `refundReceipt`: a receipt with no Action), or fail the
 * transfer too (`beneficiaryFails`: the beneficiary does not exist, so nearcore burns the deleted account's balance), and
 * give that transfer the signer as its Action signer_id (`beneficiarySignerId`) so that only its receiver tells it from
 * a gas refund (C-T5c).
 */
const BENEFICIARY_RECEIPT = "De36CxHy6zAD4h1gjjmumy2WShyXavhHhwBm8qnffskL";
/** The key nearcore puts on a balance refund: ed25519, 32 zero bytes. */
const EMPTY_KEY = `ed25519:${"1".repeat(32)}`;
function deleteOwnAccount(
  opts: { refundPredecessor?: string; refundSignerId?: string; beneficiaryFails?: boolean; beneficiarySignerId?: string; refundReceipt?: "action" | "data" | "absent" } = {},
): { body: string; exp: string; refundId: string; hash: string } {
  const { refundPredecessor = "system", refundSignerId = "seat.sandbox", beneficiaryFails = false, beneficiarySignerId = "system", refundReceipt = "action" } = opts;
  const json = JSON.parse(fx("069-i-burn-delete-key.send_tx.json"));
  const r = json.result;
  r.transaction.actions = [{ DeleteAccount: { beneficiary_id: "sandbox" } }];
  const [main, refund] = r.receipts_outcome;
  const transfer = JSON.parse(JSON.stringify(refund));
  transfer.id = BENEFICIARY_RECEIPT;
  transfer.outcome.executor_id = "sandbox";
  if (beneficiaryFails) transfer.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "sandbox" } } } } };
  main.outcome.receipt_ids = [transfer.id, refund.id];
  refund.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "seat.sandbox" } } } } };
  r.receipts_outcome = [main, transfer, refund];
  const body = JSON.stringify(json);
  const transferReceipt = (id: string, receiver: string, predecessor: string, signerId: string) => ({
    predecessor_id: predecessor,
    receiver_id: receiver,
    receipt_id: id,
    receipt: {
      Action: {
        signer_id: signerId,
        signer_public_key: signerId === "system" ? EMPTY_KEY : r.transaction.public_key,
        gas_price: "0",
        output_data_receivers: [],
        input_data_ids: [],
        actions: [{ Transfer: { deposit: "1" } }],
        is_promise_yield: false,
      },
    },
    priority: 0,
  });
  const receipts = [transferReceipt(transfer.id, "sandbox", "system", beneficiarySignerId), transferReceipt(refund.id, "seat.sandbox", refundPredecessor, refundSignerId)];
  // A receipt with no Action (a Data receipt, or none at all): nothing says whose gas it refunds.
  if (refundReceipt === "data") receipts[1].receipt = { Data: { data_id: "DataIdForTheRefundReceipt1111111111111111111", data: null } } as never;
  if (refundReceipt === "absent") delete (receipts[1] as { receipt?: unknown }).receipt;
  const exp = JSON.stringify({ ...json, result: { ...r, receipts } });
  return { body, exp, refundId: refund.id, hash: r.transaction.hash };
}
const deleteSelf = (kp: KeyPair) => signAndSend("sandbox", "seat.sandbox", kp, "seat.sandbox", [actions.deleteAccount("sandbox")]);

const STATUS = fx("001-0-status.json");
const mainnetStatus = STATUS.replace('"chain_id":"test-chain-FSZ71"', '"chain_id":"mainnet"');
let urls = 0;
beforeEach(() => useRpcUrl("sandbox", `http://sandbox-${++urls}.replay.invalid`)); // assertChain remembers a check per URL

/** Root creates seat.sandbox: the spike's first transaction (003 nonce read, 004 landed). */
function createSeat(root: KeyPair) {
  const seatKey = KeyPair.fromRandom("ed25519");
  return signAndSend("sandbox", "sandbox", root, "seat.sandbox", [actions.createAccount(), actions.transfer(10n * NEAR), actions.addFullAccessKey(seatKey.getPublicKey())]);
}

describe("signAndSend (replayed RPC)", () => {
  it("checks the chain, reads nonce and block hash from one view_access_key, then sends send_tx FINAL", async () => {
    const root = KeyPair.fromRandom("ed25519");
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: fx("004-a-create-seat.send_tx.json") });

    const sent = await createSeat(root);

    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx"]);
    // FINAL, not optimistic: every node of a multi-node RPC has a final block, so the tx never comes back Expired.
    expect(log[1].params).toEqual({ request_type: "view_access_key", finality: "final", account_id: "sandbox", public_key: root.getPublicKey().toString() });
    expect(log[2].params.wait_until).toBe("FINAL");
    const tx = decodeSignedTransaction(Buffer.from(log[2].params.signed_tx_base64, "base64")).transaction;
    const recorded = JSON.parse(fx("003-a-create-seat.nonce.json")).result;
    expect(tx.signerId).toBe("sandbox");
    expect(tx.publicKey.toString()).toBe(root.getPublicKey().toString());
    expect(tx.receiverId).toBe("seat.sandbox");
    expect(tx.nonce).toBe(BigInt(recorded.nonce) + 1n);
    expect(Buffer.from(tx.blockHash)).toEqual(Buffer.from(baseDecode(recorded.block_hash)));
    expect(tx.actions.map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "addKey"]); // a decoded action carries only its variant key
    expect(sent).toEqual({ txHash: localHash(log[2]), raw: fx("004-a-create-seat.send_tx.json"), json: JSON.parse(fx("004-a-create-seat.send_tx.json")) });
    // The signature verifies over the tx hash with the signer's public key (and with no other key).
    const signed = decodeSignedTransaction(Buffer.from(log[2].params.signed_tx_base64, "base64"));
    const digest = new Uint8Array(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    const signature = new Uint8Array(signed.signature.ed25519Signature?.data ?? []); // borsh decodes it as a plain array
    expect(baseEncode(digest)).toBe(sent.txHash);
    expect(root.getPublicKey().verify(digest, signature)).toBe(true);
    expect(KeyPair.fromRandom("ed25519").getPublicKey().verify(digest, signature)).toBe(false);
  });

  it("every read and send uses the URL assertChain verified: a useRpcUrl switch during the check never reaches the new URL", async () => {
    const checked = rpcUrlFor("sandbox");
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: fx("004-a-create-seat.send_tx.json") });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "status") useRpcUrl("sandbox", "http://switched.replay.invalid");
      return inner(input, init);
    };
    await createSeat(KeyPair.fromRandom("ed25519"));
    expect(rpcUrlFor("sandbox")).toBe("http://switched.replay.invalid"); // the switch did happen
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual([`status ${checked}`, `query ${checked}`, `send_tx ${checked}`]);
  });

  it("the only exported ways to sign check the chain first: sendSigned and accessKeyNonce are not exported", () => {
    expect(Object.keys(txModule).sort()).toEqual(["SendFateUnknownError", "landedFailure", "mustSucceed", "receiptTreeComplete", "sendAttemptTx", "settle", "signAndSend", "successValue"]);
  });

  it("two signAndSend calls with one key run one after the other: the second reads its nonce after the first send", async () => {
    const root = KeyPair.fromRandom("ed25519");
    const log = replay({
      status: STATUS,
      "query:view_access_key": [fx("003-a-create-seat.nonce.json"), fx("005-a-create-cosigner.nonce.json")],
      send_tx: [fx("004-a-create-seat.send_tx.json"), fx("006-a-create-cosigner.send_tx.json")],
    });
    await Promise.all([createSeat(root), createSeat(root)]);
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "query", "send_tx"]);
  });

  it("a call that fails while it holds the key's lock (a mainnet refusal) releases it: the next call with the key runs", async () => {
    const root = KeyPair.fromRandom("ed25519");
    const log = replay({ status: [mainnetStatus, STATUS], "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: fx("004-a-create-seat.send_tx.json") });
    const [first, second] = await Promise.allSettled([createSeat(root), createSeat(root)]);
    expect(first.status === "rejected" && first.reason instanceof EnvironmentError && /mainnet/.test(first.reason.message)).toBe(true);
    expect(second.status === "fulfilled" && second.value.raw === fx("004-a-create-seat.send_tx.json")).toBe(true);
    // The second call waited for the first to fail, then checked the chain itself: nothing ran in between.
    expect(log.map((r) => r.method)).toEqual(["status", "status", "query", "send_tx"]);
  });

  it("reads status once per process: the second send reuses the chain check", async () => {
    const root = KeyPair.fromRandom("ed25519");
    const log = replay({
      status: STATUS,
      "query:view_access_key": [fx("003-a-create-seat.nonce.json"), fx("005-a-create-cosigner.nonce.json")],
      send_tx: [fx("004-a-create-seat.send_tx.json"), fx("006-a-create-cosigner.send_tx.json")],
    });
    await createSeat(root);
    await createSeat(root);
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "query", "send_tx"]);
  });

  it("on a mainnet RPC it reads no key and signs nothing", async () => {
    const log = replay({ status: mainnetStatus });
    await expect(createSeat(KeyPair.fromRandom("ed25519"))).rejects.toThrow(/mainnet/);
    expect(log.map((r) => r.method)).toEqual(["status"]);
  });

  it("a signer key that is not on chain is an environment error, and nothing is sent", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const log = replay({ status: STATUS, "query:view_access_key": fx("070-i-view-burned-key.json") });
    const err = await signAndSend("sandbox", "seat.sandbox", kp, "seat.sandbox", [actions.deleteKey(kp.getPublicKey())]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toMatch(/seat\.sandbox has no access key .* on sandbox/);
    expect(log.map((r) => r.method)).toEqual(["status", "query"]);
  });

  it("a protocol refusal comes back as the SentTx: signAndSend never judges the outcome (mustSucceed does)", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const log = replay({ status: STATUS, "query:view_access_key": fx("051-g1-method-add_proposal.nonce.json"), send_tx: fx("052-g1-method-add_proposal.send_tx.json") });
    const sent = await signAndSend("sandbox", "seat.sandbox", kp, "dao.sandbox", [actions.functionCall("add_proposal", {}, 30n * 10n ** 12n, 0n)]);
    expect(sent.raw).toBe(fx("052-g1-method-add_proposal.send_tx.json"));
    expect(sent.txHash).toBe(localHash(log[2]));
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx"]); // no tx polling for a refusal
  });

  it("signAndSend: TIMEOUT_ERROR on send_tx is followed by tx polling, never a second send_tx", async () => {
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: TIMEOUT, tx: [TIMEOUT, fx("004-a-create-seat.send_tx.json")] });

    const sent = await createSeat(KeyPair.fromRandom("ed25519"));

    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "tx", "tx"]);
    const hash = localHash(log[2]);
    expect(sent.txHash).toBe(hash);
    for (const poll of log.slice(3)) expect(poll.params).toEqual({ tx_hash: hash, sender_account_id: "sandbox", wait_until: "FINAL" });
    expect(sent.raw).toBe(fx("004-a-create-seat.send_tx.json")); // the first body that carries the result
  });

  it("a tx still not seen final after 6 polls is an environment error; it is never re-sent", async () => {
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: TIMEOUT, tx: TIMEOUT });
    const err = await createSeat(KeyPair.fromRandom("ed25519")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    expect(err).toBeInstanceOf(EnvironmentError);
    const hash = localHash(log[2]);
    expect((err as SendFateUnknownError).txHash).toBe(hash);
    expect((err as SendFateUnknownError).signerId).toBe("sandbox");
    expect((err as SendFateUnknownError).message).toBe(`send_tx for tx ${hash} (signer sandbox): the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls; it was not re-sent, and whether it landed is unknown · look tx ${hash} up on chain before signing anything again (signer sandbox)`);
    expect(log.filter((r) => r.method === "send_tx")).toHaveLength(1);
    expect(log.filter((r) => r.method === "tx")).toHaveLength(6);
  });
});

describe("signAndSend after a send_tx timeout (replayed RPC, fake timers)", () => {
  /** Advances fake time in `stepMs` steps until `p` settles (at most 300 steps). */
  async function drive<T>(p: Promise<T>, stepMs = 100): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 300 && !done; i++) await vi.advanceTimersByTimeAsync(stepMs);
    return p;
  }
  /** Records the (fake) time of every `tx` request. */
  function txTimes(): number[] {
    const times: number[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "tx") times.push(Date.now());
      return inner(input, init);
    };
    return times;
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an unknown tx is asked again 300 ms later; send_tx is never sent twice", async () => {
    const log = replay({
      status: STATUS,
      "query:view_access_key": fx("003-a-create-seat.nonce.json"),
      send_tx: TIMEOUT,
      tx: [fx("053-g1-method-add_proposal.tx_status.json"), fx("004-a-create-seat.send_tx.json")],
    });
    const times = txTimes();
    const sent = await drive(createSeat(KeyPair.fromRandom("ed25519")));
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "tx", "tx"]);
    expect(times[1] - times[0]).toBe(300);
    expect(sent.raw).toBe(fx("004-a-create-seat.send_tx.json"));
    expect(sent.txHash).toBe(localHash(log[2]));
  });

  it("any other RPC error while polling fails at once and says the tx was not re-sent", async () => {
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: TIMEOUT, tx: fx("052-g1-method-add_proposal.send_tx.json") });
    const err = await drive(createSeat(KeyPair.fromRandom("ed25519"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    const hash = localHash(log[2]);
    expect((err as EnvironmentError).message).toContain(`send_tx for tx ${hash} (signer sandbox): the node timed out (TIMEOUT_ERROR); reading the tx then failed: INVALID_TRANSACTION`);
    expect((err as EnvironmentError).message).toContain("it was not re-sent");
    expect((err as EnvironmentError).tryThis).toContain(`look tx ${hash} up on chain before signing anything again`);
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "tx"]);
  });

  it("a send_tx the client stopped waiting for (120 s) takes the same path: tx polls by the local hash, never a second send_tx", async () => {
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: fx("004-a-create-seat.send_tx.json"), tx: fx("004-a-create-seat.send_tx.json") });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const res = await inner(input, init); // logged
      if (JSON.parse(String(init?.body)).method !== "send_tx") return res;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))));
    };
    const t0 = Date.now();
    const sent = await drive(createSeat(KeyPair.fromRandom("ed25519")), 1000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120_000);
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "tx"]);
    const hash = localHash(log[2]);
    expect(log[3].params).toEqual({ tx_hash: hash, sender_account_id: "sandbox", wait_until: "FINAL" });
    expect(sent.txHash).toBe(hash);
    expect(sent.raw).toBe(fx("004-a-create-seat.send_tx.json"));
  });

  /** Every way an RPC can fail a send_tx without saying what became of the transaction (Task 2 fix round 2). */
  const FAILED_SENDS: Record<string, () => Response> = {
    "HTTP 502": () => new Response("<html>bad gateway</html>", { status: 502 }),
    "HTTP 429": () => new Response("Too Many Requests", { status: 429 }),
    "HTTP 500 with a JSON error": () =>
      new Response('{"jsonrpc":"2.0","error":{"name":"INTERNAL_ERROR","cause":{"name":"INTERNAL_ERROR","info":{"error_message":"boom"}},"code":-32000,"message":"Server error","data":"boom"},"id":"p"}', { status: 500 }),
    unreachable: () => {
      throw new TypeError("fetch failed");
    },
    "non-JSON": () => new Response("<html>oops</html>", { status: 200 }),
    "a body over the cap": () => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } }),
  };
  /** replay, with send_tx (still logged) failed as `kind` says. */
  function failSend(kind: string, bodies: Record<string, string | readonly string[]>): ReplayedRequest[] {
    const log = replay({ ...bodies, send_tx: "{}" });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const res = await inner(input, init); // logged
      return JSON.parse(String(init?.body)).method === "send_tx" ? FAILED_SENDS[kind]() : res;
    };
    return log;
  }

  for (const kind of Object.keys(FAILED_SENDS)) {
    it(`send_tx failed (${kind}), then tx finds it by the local hash: the outcome comes back as usual, sent once`, async () => {
      const log = failSend(kind, { status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), tx: fx("004-a-create-seat.send_tx.json") });
      const sent = await drive(createSeat(KeyPair.fromRandom("ed25519")));
      expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "tx"]);
      const hash = localHash(log[2]);
      expect(log[3].params).toEqual({ tx_hash: hash, sender_account_id: "sandbox", wait_until: "FINAL" });
      expect(sent.txHash).toBe(hash);
      expect(sent.raw).toBe(fx("004-a-create-seat.send_tx.json"));
    });

    it(`send_tx failed (${kind}), and tx never finds it: SendFateUnknownError names the hash and the signer, never re-sent`, async () => {
      const unknown = fx("053-g1-method-add_proposal.tx_status.json");
      const log = failSend(kind, { status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), tx: unknown });
      const err = await drive(createSeat(KeyPair.fromRandom("ed25519"))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SendFateUnknownError);
      expect(err).toBeInstanceOf(EnvironmentError);
      const hash = localHash(log[2]);
      const e = err as SendFateUnknownError;
      expect(e.txHash).toBe(hash);
      expect(e.signerId).toBe("sandbox");
      expect(e.what.startsWith(`send_tx for tx ${hash} (signer sandbox): `)).toBe(true);
      expect(e.what.endsWith("; not seen final after 6 tx polls; it was not re-sent, and whether it landed is unknown")).toBe(true);
      expect(e.tryThis).toBe(`look tx ${hash} up on chain before signing anything again (signer sandbox)`);
      expect(log.filter((r) => r.method === "send_tx")).toHaveLength(1);
      expect(log.filter((r) => r.method === "tx")).toHaveLength(6);
    });
  }
});

describe("settle (replayed RPC)", () => {
  /** Advances fake time in small steps until `p` settles (at most 20 s). */
  async function drive<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(100);
    return p;
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const landed = fx("027-e-fc-vote-approve-0.send_tx.json");

  it("polls tx (wait_until FINAL) until every receipt in the tree has an outcome, refund included", async () => {
    const log = replay({ tx: [withoutRefund(landed), landed] });
    await drive(settle("sandbox", "2VDPAEeT6hcf7c5qtTrSjXx3gtGeV9mrm5RL5DeDxMqT", "seat.sandbox"));
    expect(log.map((r) => r.method)).toEqual(["tx", "tx"]);
    for (const poll of log) expect(poll.params).toEqual({ tx_hash: "2VDPAEeT6hcf7c5qtTrSjXx3gtGeV9mrm5RL5DeDxMqT", sender_account_id: "seat.sandbox", wait_until: "FINAL" });
  });

  it("one tx read when the tree is complete; a TIMEOUT_ERROR is simply asked again", async () => {
    const log = replay({ tx: [TIMEOUT, landed] });
    await drive(settle("sandbox", "h", "seat.sandbox"));
    expect(log).toHaveLength(2);
    const once = replay({ tx: [landed] });
    await drive(settle("sandbox", "h", "seat.sandbox"));
    expect(once).toHaveLength(1);
  });

  it("gives up with an environment error when the tree never completes (20 polls, 300 ms apart)", async () => {
    const log = replay({ tx: withoutRefund(landed) });
    const t0 = Date.now();
    const err = await drive(settle("sandbox", "h", "seat.sandbox")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toMatch(/tx h: receipt tree incomplete after 20 tx polls/);
    expect(log).toHaveLength(20);
    expect(Date.now() - t0).toBe(19 * 300);
  });

  it("an unknown tx is polled again; any other RPC error fails at once", async () => {
    const unknown = fx("053-g1-method-add_proposal.tx_status.json");
    const log = replay({ tx: [unknown, landed] });
    await drive(settle("sandbox", "h", "seat.sandbox"));
    expect(log).toHaveLength(2);
    const other = replay({ tx: fx("052-g1-method-add_proposal.send_tx.json") }); // INVALID_TRANSACTION: no tx to wait for
    await expect(drive(settle("sandbox", "h", "seat.sandbox"))).rejects.toThrow(/INVALID_TRANSACTION/);
    expect(other).toHaveLength(1);
  });
});

describe("mustSucceed and successValue", () => {
  const sentOf = (raw: string): SentTx => ({ txHash: "5v3kfdxNKwdZNnwgpED2o4kUv8xFQWfhg14XN8Y4AYsK", raw, json: JSON.parse(raw) });

  it("mustSucceed returns a landed, failure-free tx as it is", () => {
    const s = sentOf(fx("019-c-add-proposal-0.send_tx.json"));
    expect(mustSucceed("add_proposal #0", s)).toBe(s);
  });

  it("mustSucceed: a protocol refusal is an environment error naming the label and the parsed refusal", () => {
    expect(() => mustSucceed("vote", sentOf(fx("052-g1-method-add_proposal.send_tx.json")))).toThrow(
      /^vote: refused at validation \(MethodNameMismatch\), never in a block · tx 5v3kfdxNKwdZNnwgpED2o4kUv8xFQWfhg14XN8Y4AYsK/,
    );
  });

  it("mustSucceed: a landed failure is an environment error with the contract's panic text", () => {
    const err = (() => {
      try {
        mustSucceed("add_proposal", sentOf(readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json")));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toContain("add_proposal: failed in a block: Smart contract panicked: panicked at 'ERR_MIN_BOND'");
    // Fix round 3: the tx's own receipt failed, so nothing but gas changed; retrying is the caller's call (a failed
    // DeleteKey leaves the key live). "Do not sign it again" belongs to fate-unknown and landed-unsettled only.
    expect((err as EnvironmentError).tryThis).toBe("tx 5v3kfdxNKwdZNnwgpED2o4kUv8xFQWfhg14XN8Y4AYsK failed on chain and changed nothing except the gas it burnt; whether to retry is the caller's decision");
    expect(/do not sign|look .* up on chain/.test((err as EnvironmentError).tryThis)).toBe(false);
  });

  it("mustSucceed: a body with no tx result is an environment error", () => {
    expect(() => mustSucceed("create seat", sentOf(TIMEOUT))).toThrow(/create seat: no transaction result .*TIMEOUT_ERROR/);
  });

  it("successValue decodes the tx's SuccessValue as JSON (add_proposal returns the id)", () => {
    expect(successValue(sentOf(fx("019-c-add-proposal-0.send_tx.json")))).toBe(0);
    expect(successValue(sentOf(fx("021-c-add-proposal-1.send_tx.json")))).toBe(1);
    expect(successValue(sentOf(fx("027-e-fc-vote-approve-0.send_tx.json")))).toBeNull(); // SuccessValue ""
  });

  it("successValue: a tx with no SuccessValue is an environment error", () => {
    expect(() => successValue(sentOf(fx("052-g1-method-add_proposal.send_tx.json")))).toThrow(EnvironmentError);
    expect(() => successValue(sentOf(readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json")))).toThrow(/no SuccessValue/);
  });
});

describe("a DeleteAccount of the signer itself: its failed gas refund is not the tx's failure (fix round 3)", () => {
  it("the refund to the deleted signer failed (AccountDoesNotExist): mustSucceed passes; the refund is known from EXPERIMENTAL_tx_status", async () => {
    const { body, exp, refundId, hash } = deleteOwnAccount();
    const log = replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(mustSucceed("delete seat", sent)).toBe(sent);
    expect(sent.raw).toBe(body); // kept byte for byte
    // Fix round 4: only the gas refund to the signer is listed, never the beneficiary transfer `system` also sent.
    expect(sent.refundReceiptIds).toEqual([refundId]);
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx", "EXPERIMENTAL_tx_status"]);
    expect(log[3].params).toEqual({ tx_hash: hash, sender_account_id: "seat.sandbox", wait_until: "FINAL" });
    expect(landedFailure(sent.json, sent.refundReceiptIds)).toBeNull();
  });

  it("the same failed receipt, sent by the signer and not by system, still fails the tx: landed-failed, with the later-receipt hint", async () => {
    const { body, exp, refundId, hash } = deleteOwnAccount({ refundPredecessor: "seat.sandbox" });
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    const err = (() => {
      try {
        mustSucceed("delete seat", sent);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what.startsWith(`delete seat: failed in a block: receipt ${refundId} Failure: {"ActionError"`)).toBe(true);
    expect((err as EnvironmentError).tryThis).toBe(
      `tx ${sent.txHash} landed, but its receipt ${refundId} failed on chain: that receipt changed nothing except gas, and the receipts before it stand; whether to retry is the caller's decision`,
    );
    expect(landedFailure(sent.json, sent.refundReceiptIds)).toMatchObject({ receiptId: refundId, rolledBackAll: false });
    expect(hash).toBe(JSON.parse(body).result.transaction.hash);
  });

  it("fix round 4: DeleteAccount's transfer to a beneficiary that does not exist failed (the balance is burnt): a failed system receipt to anyone but the signer still fails the tx", async () => {
    const { body, exp, refundId } = deleteOwnAccount({ beneficiaryFails: true });
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    const err = (() => {
      try {
        mustSucceed("delete seat", sent);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what.startsWith(`delete seat: failed in a block: receipt ${BENEFICIARY_RECEIPT} Failure: {"ActionError"`)).toBe(true);
    expect((err as EnvironmentError).what).toContain('"AccountDoesNotExist":{"account_id":"sandbox"}');
    expect(landedFailure(sent.json, sent.refundReceiptIds)).toMatchObject({ receiptId: BENEFICIARY_RECEIPT, rolledBackAll: false });
    expect(sent.refundReceiptIds).toEqual([refundId]); // the beneficiary transfer is not a gas refund
  });

  it("fix round 4: a failed system receipt to the signer that is not a gas refund (signer_id system: a balance refund) still fails the tx", async () => {
    const { body, exp, refundId } = deleteOwnAccount({ refundSignerId: "system" });
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(() => mustSucceed("delete seat", sent)).toThrow(new RegExp(`^delete seat: failed in a block: receipt ${refundId} Failure: .*AccountDoesNotExist`));
    expect(sent.refundReceiptIds).toEqual([]);
  });

  // C-T5c (final sweep): the two clauses of isGasRefund the round 4 tests left unpinned. Each fixture below passes the
  // other clauses, so removing the clause it pins turns a failed system receipt into a skipped one.
  it("C-T5c: a failed system receipt to anyone but the signer is not a gas refund even when it names the signer as its Action signer_id (the receiver clause)", async () => {
    const { body, exp, refundId } = deleteOwnAccount({ beneficiaryFails: true, beneficiarySignerId: "seat.sandbox" });
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(sent.refundReceiptIds).toEqual([refundId]); // the transfer to `sandbox` is not listed
    expect(() => mustSucceed("delete seat", sent)).toThrow(new RegExp(`^delete seat: failed in a block: receipt ${BENEFICIARY_RECEIPT} Failure: .*AccountDoesNotExist.*"account_id":"sandbox"`));
    expect(landedFailure(sent.json, sent.refundReceiptIds)).toMatchObject({ receiptId: BENEFICIARY_RECEIPT, rolledBackAll: false });
  });

  it.each([
    ["a Data receipt", "data"],
    ["a receipt object with no receipt at all", "absent"],
  ] as const)("C-T5c: a failed system receipt to the signer that carries no Action (%s) is not a gas refund: the tx fails, and the refund read still succeeded", async (_what, refundReceipt) => {
    const { body, exp, refundId } = deleteOwnAccount({ refundReceipt });
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body, EXPERIMENTAL_tx_status: exp });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(sent.refundCheckFailed).toBeUndefined(); // read fine: this is not the "could not be read" path
    expect(sent.refundReceiptIds).toEqual([]);
    expect(() => mustSucceed("delete seat", sent)).toThrow(new RegExp(`^delete seat: failed in a block: receipt ${refundId} Failure: .*AccountDoesNotExist`));
  });

  it("when EXPERIMENTAL_tx_status cannot be read, every failed receipt counts, and the error says the refund check was not possible", async () => {
    const { body } = deleteOwnAccount();
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: body }); // no EXPERIMENTAL_tx_status answer
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(sent.refundReceiptIds).toBeUndefined();
    expect(typeof sent.refundCheckFailed).toBe("string");
    expect(() => mustSucceed("delete seat", sent)).toThrow(/^delete seat: failed in a block: receipt \w+ Failure: .*AccountDoesNotExist.* \(which failed receipts are gas refunds could not be read: /);
  });

  it("a tx whose own status is Failure is landed-failed whatever system sent: no EXPERIMENTAL_tx_status read", async () => {
    const json = JSON.parse(deleteOwnAccount().body);
    json.result.status = { Failure: { ActionError: { index: 0, kind: { DeleteAccountStaking: { account_id: "seat.sandbox" } } } } };
    json.result.receipts_outcome[0].outcome.status = json.result.status;
    const log = replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: JSON.stringify(json) });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(() => mustSucceed("delete seat", sent)).toThrow(/^delete seat: failed in a block: tx Failure: .*DeleteAccountStaking/);
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx"]);
  });

  it("landedFailure ignores only the receipts it is told are refunds; with none it judges like executionFailure", () => {
    const { body, refundId } = deleteOwnAccount();
    const json = JSON.parse(body);
    expect(landedFailure(json)).toMatchObject({ receiptId: refundId, rolledBackAll: false });
    expect(landedFailure(json, [refundId])).toBeNull();
    expect(landedFailure(json, [BENEFICIARY_RECEIPT])).toMatchObject({ receiptId: refundId });
    expect(landedFailure(JSON.parse(fx("019-c-add-proposal-0.send_tx.json")))).toBeNull();
    expect(landedFailure(JSON.parse(readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json")))).toMatchObject({ rolledBackAll: true });
  });
});

describe("an RPC's JSON error never prints the RPC URL's path or query (fix round 4)", () => {
  /** Where a provider puts its API key: the path and the query. None of these may reach an error. */
  const SECRETS = ["/v3", "k3yt0ken", "s3cr3tvalue", "apiKey"];
  let n = 0;
  /** A keyed RPC URL, new for each use (assertChain remembers a passed check per URL), made the sandbox RPC. */
  function keyedRpc(): string {
    const url = `https://rpc-${++n}.example.invalid/v3/k3yt0ken?apiKey=s3cr3tvalue`;
    useRpcUrl("sandbox", url);
    return url;
  }
  /** A gateway's JSON error that echoes the request: the URL whole, then its path and query on their own. */
  const echo = (url: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: `upstream ${url} failed: POST ${new URL(url).pathname}${new URL(url).search}` },
      id: "p",
    });
  const clean = (text: string) => SECRETS.every((secret) => !text.includes(secret));
  const cleanError = (e: unknown) => e instanceof EnvironmentError && clean(`${e.message} ${e.tryThis}`);

  it("tx.ts scrubs the text of every reply it prints: the nonce read, send_tx and its poll, EXPERIMENTAL_tx_status, settle, the final block read", async () => {
    // view_access_key answered an error: nothing was sent.
    let url = keyedRpc();
    replay({ status: STATUS, "query:view_access_key": echo(url) });
    const nonce = await createSeat(KeyPair.fromRandom("ed25519")).catch((e: unknown) => e);
    expect(cleanError(nonce)).toBe(true);
    expect((nonce as EnvironmentError).what).toContain(`view_access_key sandbox failed: GATEWAY_ERROR: upstream https://rpc-${n}.example.invalid/… failed: POST /…`);

    // send_tx answered an error, and so did the tx poll by the local hash.
    url = keyedRpc();
    replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: echo(url), tx: echo(url) });
    const fate = await createSeat(KeyPair.fromRandom("ed25519")).catch((e: unknown) => e);
    expect(fate).toBeInstanceOf(SendFateUnknownError);
    expect(cleanError(fate)).toBe(true);
    expect((fate as EnvironmentError).what).toContain("the node answered GATEWAY_ERROR: upstream");
    expect((fate as EnvironmentError).what).toContain("reading the tx then failed: GATEWAY_ERROR: upstream");

    // EXPERIMENTAL_tx_status answered an error: recorded on the SentTx, then printed by mustSucceed.
    url = keyedRpc();
    replay({ status: STATUS, "query:view_access_key": fx("068-i-burn-delete-key.nonce.json"), send_tx: deleteOwnAccount().body, EXPERIMENTAL_tx_status: echo(url) });
    const sent = await deleteSelf(KeyPair.fromRandom("ed25519"));
    expect(typeof sent.refundCheckFailed === "string" && sent.refundCheckFailed.includes("GATEWAY_ERROR") && clean(sent.refundCheckFailed)).toBe(true);
    const judged = (() => {
      try {
        mustSucceed("delete seat", sent);
      } catch (e) {
        return e;
      }
    })();
    expect(cleanError(judged)).toBe(true);

    // settle's tx poll answered an error.
    url = keyedRpc();
    replay({ tx: echo(url) });
    const unsettled = await settle("sandbox", "h", "seat.sandbox").catch((e: unknown) => e);
    expect(cleanError(unsettled)).toBe(true);
    expect((unsettled as EnvironmentError).what).toContain("tx h: GATEWAY_ERROR: upstream");

    // An attempt with a key that is gone signs with a final block hash; that block read answered an error.
    url = keyedRpc();
    const kp = KeyPair.fromRandom("ed25519");
    replay({ status: STATUS, "query:view_access_key": fx("070-i-view-burned-key.json"), block: echo(url) });
    const block = await sendAttemptTx("sandbox", "seat.sandbox", kp, "seat.sandbox", [actions.deleteKey(kp.getPublicKey())]).catch((e: unknown) => e);
    expect(cleanError(block)).toBe(true);
    expect((block as EnvironmentError).what).toContain("block query returned no header hash (GATEWAY_ERROR: upstream");
  });

  it("C-T18b: mustSucceed and successValue print a body scrubbed of every RPC URL this process has posted to", async () => {
    const url = keyedRpc();
    replay({ tx: echo(url) });
    await settle("sandbox", "h", "seat.sandbox").catch(() => undefined); // a read that posts to the keyed URL
    const sent: SentTx = { txHash: "5v3kfdxNKwdZNnwgpED2o4kUv8xFQWfhg14XN8Y4AYsK", raw: echo(url), json: JSON.parse(echo(url)) };
    const thrown = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e;
      }
    };
    const judged = thrown(() => mustSucceed("create seat", sent));
    expect(cleanError(judged)).toBe(true);
    expect((judged as EnvironmentError).what).toBe(`create seat: no transaction result (GATEWAY_ERROR: upstream https://rpc-${n}.example.invalid/… failed: POST /…) · tx ${sent.txHash}`);
    const value = thrown(() => successValue(sent));
    expect(cleanError(value)).toBe(true);
    expect((value as EnvironmentError).what).toBe(`tx ${sent.txHash} has no SuccessValue (GATEWAY_ERROR: upstream https://rpc-${n}.example.invalid/… failed: POST /…)`);
  });
});

// ---------------------------------------------------------------------------------------------------
// Final sweep C-T19h: tx.ts replaces a held key's text before it cuts a text it prints, so no cut leaves 12 or more
// characters of the key behind.

describe("C-T19h: a cut never leaves part of a held key behind", () => {
  afterEach(() => dropHeldKeys());
  /** A key held as a session key; its 12-character windows in its two text forms (test memory only). */
  function heldKey() {
    const kp = KeyPair.fromRandom("ed25519");
    holdSessionKey(sampleSession({ publicKey: kp.getPublicKey().toString() }), kp);
    const extended = kp.toString().slice("ed25519:".length);
    const seed = baseEncode(baseDecode(extended).slice(0, 32));
    const windows: string[] = [];
    for (const form of [extended, seed]) for (let i = 0; i + 12 <= form.length; i++) windows.push(form.slice(i, i + 12));
    return { extended, seed, windows };
  }
  const message = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as EnvironmentError).what;
    }
    return "";
  };
  const HASH = "5v3kfdxNKwdZNnwgpED2o4kUv8xFQWfhg14XN8Y4AYsK";
  const valueTx = (text: string): SentTx => {
    const raw = JSON.stringify({ jsonrpc: "2.0", result: { status: { SuccessValue: Buffer.from(text).toString("base64") } }, id: "p" });
    return { txHash: HASH, raw, json: JSON.parse(raw) };
  };

  /**
   * The three cuts, for one held key, as named booleans (a failing assertion must not print the key's text). Each key
   * part is glued to base58 that cannot extend it (helpers keyGlue; sweep A fix round 2, I2): the test's own letter
   * when it is safe for this key, another when the key's next character is that letter. With a fixed letter, 1 key in
   * 58 failed the no-result cut: its seed[2] was the glue, which the redactor rightly replaced with the part.
   */
  const LANDED_FAILURE = fx("019-c-add-proposal-0.send_tx.json").replaceAll('"SuccessValue":"MA=="', '"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"boom"}}}}');
  function cuts(k: ReturnType<typeof heldKey>) {
    const z = keyGlue(k.seed, k.windows, { before: "z" }).before;
    const what = message(() => successValue(valueTx(`${z.repeat(70)}${k.seed}`)));

    const r = keyGlue(k.extended, k.windows, { before: "r" }).before;
    const failed: SentTx = { txHash: HASH, raw: LANDED_FAILURE, json: JSON.parse(LANDED_FAILURE), refundCheckFailed: `${r.repeat(190)}${k.extended}` };
    const refund = message(() => mustSucceed("add_proposal", failed));

    const part = k.seed.slice(3, 40);
    const q = keyGlue(part, k.windows, { before: "q" }).before;
    const errorBody = JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: `${q.repeat(270)}${part}` }, id: "p" });
    const none = message(() => mustSucceed("add_proposal", { txHash: HASH, raw: errorBody, json: JSON.parse(errorBody) }));

    const clean = (t: string) => !k.windows.some((w) => t.includes(w));
    return {
      successValueCut: what === `tx ${HASH}: its SuccessValue is not JSON (${z.repeat(70)}${KEY_NOT_SHOWN.slice(0, 10)}…)`,
      successValueClean: clean(what),
      refundCut: refund.includes(`could not be read: ${r.repeat(190)}${KEY_NOT_SHOWN.slice(0, 10)}…)`),
      refundClean: clean(refund),
      noResultCut: none.includes(`${q.repeat(270)}${KEY_NOT_SHOWN.slice(0, 300 - 270 - "GATEWAY_ERROR: ".length)}`),
      noResultClean: clean(none),
      /** The no-result body's old fixed glue "q" would have been replaced with the part for this key. */
      oldGlueJoins: q !== "q",
    };
  }

  it("successValue's not-JSON text (cut at 80): the seed straddling the cut is replaced first", () => {
    const { successValueCut, successValueClean } = cuts(heldKey());
    expect({ successValueCut, successValueClean }).toEqual({ successValueCut: true, successValueClean: true });
  });

  it("mustSucceed's refund-read text (cut at 200) and a no-result body: the extended key is replaced, whole or in part", () => {
    expect(LANDED_FAILURE).not.toBe(fx("019-c-add-proposal-0.send_tx.json"));
    const { refundCut, refundClean, noResultCut, noResultClean } = cuts(heldKey());
    expect({ refundCut, refundClean, noResultCut, noResultClean }).toEqual({ refundCut: true, refundClean: true, noResultCut: true, noResultClean: true });
  });

  it("all three cuts hold for 200 random keys and on until 2 keys whose seed[2] is the old glue \"q\" (fix round 2, I2)", () => {
    const failing: number[] = [];
    let keys = 0;
    let oldGlueJoins = 0;
    for (; keys < 20_000 && (keys < 200 || oldGlueJoins < 2); keys++) {
      const { oldGlueJoins: joins, ...cut } = cuts(heldKey());
      dropHeldKeys();
      if (joins) oldGlueJoins++;
      if (Object.values(cut).length !== 6 || !Object.values(cut).every(Boolean)) failing.push(keys); // key indexes only: never a key's text
    }
    expect(failing).toEqual([]);
    expect(keys).toBeGreaterThanOrEqual(200);
    expect(oldGlueJoins).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// Sweep A fix round 1 (I1): signAndSend's poll path with a 7M-character base58 run in both answers (send_tx and the
// tx poll by hash) and a key held, so the redactor scans both: still SendFateUnknownError with the polled hash.

describe("fix round 1 (I1): signAndSend after answers with a 7M-character base58 run", () => {
  afterEach(() => dropHeldKeys());

  it("send_tx and the tx poll both answer GATEWAY_ERROR with it: SendFateUnknownError with the local hash, never a RangeError", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    holdSessionKey(sampleSession({ publicKey: kp.getPublicKey().toString() }), kp);
    const run = "A".repeat(7_000_000);
    const big = JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: run }, id: "p" });
    const log = replay({ status: STATUS, "query:view_access_key": fx("003-a-create-seat.nonce.json"), send_tx: big, tx: big });
    const err = await createSeat(KeyPair.fromRandom("ed25519")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFateUnknownError);
    const polled = log.find((q) => q.method === "tx")?.params.tx_hash;
    expect(polled).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect((err as SendFateUnknownError).txHash).toBe(polled);
    expect((err as SendFateUnknownError).exitCode).toBe(3);
    const cut = `GATEWAY_ERROR: ${run}`.slice(0, 300);
    expect((err as EnvironmentError).what).toBe(
      `send_tx for tx ${polled} (signer ${(err as SendFateUnknownError).signerId}): the node answered ${cut}; reading the tx then failed: ${cut}; it was not re-sent, and whether it landed is unknown`,
    );
    expect(log.filter((q) => q.method === "send_tx")).toHaveLength(1);
  }, 30_000);
});
