/**
 * Signed transactions (Task 2): build, sign with a KeyPair held in memory, send the raw signed tx with
 * `send_tx`, keep the response body byte for byte. Never re-sends: whenever a send_tx does not say what became of
 * the tx (a TIMEOUT_ERROR, a client-side timeout, HTTP 429/5xx, a non-JSON or oversized body, an unreachable RPC,
 * any other RPC error) it polls `tx` with the locally computed hash (PRD §7), and a tx still not found is a
 * SendFateUnknownError (Task 2 fix round 2). Ported from spike/spike.ts `send`, `mustSucceed`, `settle`.
 *
 * Every exported way to sign (signAndSend, sendAttemptTx) goes through one private path (Task 2 fix round 1):
 * - assertChain first, then every read, send and poll of that operation at the URL it verified;
 * - one operation at a time per signing public key (an in-process lock), so concurrent callers never race on
 *   the nonce or on a function-call key's allowance.
 * A session send (sendAttemptTx) signs only with a key the chain lists as a function-call key, or with a key it does
 * not list at all (the protocol then refuses); a full-access key is never signed with there (final sweep, C-T19c).
 * Every text this module cuts is made printable first (rpc.ts printableRpcText: RPC URLs and held keys, C-T19h).
 */
import { type Action, type KeyPair, KeyPairSigner, baseDecode, baseEncode, createTransaction } from "near-api-js";
import { rpcUrlFor } from "./config.js";
import { EXIT_TX_SENT, EnvironmentError } from "./errors.js";
import { bodyState, panicMessage } from "./outcome.js";
import { parseRefusal } from "./refusal.js";
import { type RpcReply, RpcTimeoutError, SEND_HINT, assertChain, isNoSuchKey, printableRpcText, reasonOf, rpcCall, rpcErrorName, rpcErrorText, rpcErrorTextAt, sleep } from "./rpc.js";
import type { Network } from "./types.js";

/** A sent transaction: its hash, the RPC body exactly as received, and that body parsed. */
export interface SentTx {
  txHash: string;
  raw: string;
  /** RPC JSON is untyped by nature; callers narrow it. */
  json: any;
  /**
   * Ids of this tx's gas refunds to its signer (isGasRefund), read from EXPERIMENTAL_tx_status: that is the one
   * status answer that gives a receipt's predecessor_id; `tx` and `send_tx` bodies do not. Set only when a landed
   * tx whose own status is not Failure had a failed receipt (Task 2 fix rounds 3 and 4). A failure in one of them is
   * not the tx's failure (landedFailure): after a DeleteAccount of the signer, the gas refund to the deleted signer
   * fails with AccountDoesNotExist although the tx did what it was sent to do. Other receipts `system` sends (a
   * deposit refund, DeleteAccount's transfer to the beneficiary) are never listed: if one fails, nearcore burns
   * its tokens, and that failure counts.
   */
  refundReceiptIds?: readonly string[];
  /** Set instead of refundReceiptIds when that read failed: every failed receipt then counts. */
  refundCheckFailed?: string;
}

/** Where a landed tx failed: the reason, the failed receipt (if one), and whether the failure undid all it did. */
export interface LandedFailure {
  why: string;
  receiptId?: string;
  /**
   * True when the tx's own first receipt (or its conversion) failed: its actions were all rolled back, so the tx
   * changed nothing but the gas it burnt. False for a later receipt: the receipts before it stand.
   */
  rolledBackAll: boolean;
}

const hasFailure = (status: unknown): status is { Failure: unknown } => !!status && typeof status === "object" && "Failure" in status;

/**
 * The failure of a tx that reached a block, or null when it succeeded (Task 2 fix round 3): the tx's own status,
 * its conversion outcome, and every receipt, except those in `refundReceiptIds` (the tx's gas refunds to its
 * signer: a failed gas refund is not the tx's failure). A failed receipt not in that list counts, so a real
 * failure in a cross-contract call, or a burnt balance refund, is never hidden. With no list it judges like
 * outcome.ts executionFailure.
 */
export function landedFailure(json: any, refundReceiptIds: readonly string[] = []): LandedFailure | null {
  const r = json?.result;
  if (!r) return null;
  const refunds = new Set(refundReceiptIds);
  const conversion = r.transaction_outcome?.outcome?.status;
  if (hasFailure(conversion)) return { why: `tx Failure: ${JSON.stringify(conversion.Failure)}`, rolledBackAll: true };
  const firstReceipt: unknown = r.transaction_outcome?.outcome?.receipt_ids?.[0];
  const failed = (Array.isArray(r.receipts_outcome) ? r.receipts_outcome : []).find((o: any) => hasFailure(o?.outcome?.status) && !refunds.has(o.id));
  if (hasFailure(r.status)) return { why: `tx Failure: ${JSON.stringify(r.status.Failure)}`, receiptId: failed?.id, rolledBackAll: !failed || failed.id === firstReceipt };
  if (!failed) return null;
  return { why: `receipt ${failed.id} Failure: ${JSON.stringify(failed.outcome.status.Failure)}`, receiptId: failed.id, rolledBackAll: failed.id === firstReceipt };
}

/**
 * True when an EXPERIMENTAL_tx_status receipt is a gas refund to the tx's signer (Task 2 fix round 4). nearcore
 * sends three kinds of refund, all with predecessor `system`: the gas refund (new_gas_refund: to the tx's signer,
 * with that signer as its Action signer_id and its key), the deposit refund and DeleteAccount's transfer to the
 * beneficiary (new_balance_refund: signer_id `system`, the empty key). A failed balance refund burns its tokens,
 * so only the gas refund may be skipped: receiver and Action signer_id must both be the tx's signer, which a
 * balance refund never has (the fix round 4 probe saw exactly these shapes on near-sandbox 2.14.0).
 */
function isGasRefund(x: any, signerId: string): x is { receipt_id: string } {
  return x?.predecessor_id === "system" && x.receiver_id === signerId && x.receipt?.Action?.signer_id === signerId && typeof x.receipt_id === "string";
}

/**
 * For a landed tx whose own status is not Failure but that has a failed receipt: which of its receipts are gas
 * refunds to the signer (isGasRefund), from EXPERIMENTAL_tx_status (the only answer with predecessor_id). Any other
 * tx is returned as it is, with no read. A failed read is recorded (refundCheckFailed), never thrown: the tx has
 * landed, and every failed receipt then counts.
 */
async function withRefundReceipts(url: string, sent: SentTx, signerId: string): Promise<SentTx> {
  const r = sent.json?.result;
  if (!r?.status || hasFailure(r.status) || !Array.isArray(r.receipts_outcome) || !r.receipts_outcome.some((o: any) => hasFailure(o?.outcome?.status))) return sent;
  const txHash: string = typeof r.transaction?.hash === "string" ? r.transaction.hash : sent.txHash;
  try {
    const reply = await rpcCall(url, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
    const receipts = reply.json?.result?.receipts;
    if (!Array.isArray(receipts)) return { ...sent, refundCheckFailed: `EXPERIMENTAL_tx_status listed no receipts (${rpcErrorTextAt(reply.json, url)})` };
    const ids = receipts.filter((x: unknown) => isGasRefund(x, signerId)).map((x: { receipt_id: string }) => x.receipt_id);
    return { ...sent, refundReceiptIds: ids };
  } catch (e) {
    return { ...sent, refundCheckFailed: e instanceof EnvironmentError ? e.what : reasonOf(e) };
  }
}

/**
 * A send whose fate is unknown: send_tx went out (or may have), its answer did not say what became of the tx, and
 * `tx` polls by the hash computed before sending did not find it. It was not re-sent and must not be: look the tx
 * up on chain first. `txHash` is the local hash; `signerId` the account that signed it. Exit 3, not 2: a
 * transaction was sent (C-T2j).
 */
export class SendFateUnknownError extends EnvironmentError {
  override readonly exitCode = EXIT_TX_SENT;
  constructor(
    readonly txHash: string,
    readonly signerId: string,
    why: string,
  ) {
    super(`send_tx for tx ${txHash} (signer ${signerId}): ${why}; it was not re-sent, and whether it landed is unknown`, `look tx ${txHash} up on chain before signing anything again (signer ${signerId})`);
    this.name = "SendFateUnknownError";
  }
}

/** `tx` reads after a send whose fate is unknown before giving up (each read itself waits on the node). */
const TIMEOUT_POLLS = 6;
/** `tx` reads settle makes before giving up, spaced POLL_GAP_MS apart (the spike's 20 × 300 ms). */
const SETTLE_POLLS = 20;
const POLL_GAP_MS = 300;

/** A text from or about a reply, cut to `n` characters only after it is made printable (C-T18b, C-T19h). */
const clip = (s: string, n = 300) => {
  const t = printableRpcText(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const notAgain = (txHash: string) => `it is on chain: do not sign it again; read tx ${txHash} later`;

/** Per signing public key: the tail of the queue of operations that sign with it. */
const keyQueues = new Map<string, Promise<void>>();

/** Runs `fn` after every earlier operation on the same signing key has finished, whether it succeeded or not. */
function withKeyLock<T>(publicKey: string, fn: () => Promise<T>): Promise<T> {
  const run = (keyQueues.get(publicKey) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  keyQueues.set(publicKey, tail);
  void tail.then(() => {
    if (keyQueues.get(publicKey) === tail) keyQueues.delete(publicKey);
  });
  return run;
}

/** What the chain says a signing key may do: `view_access_key`'s permission, read with the nonce. */
type KeyPermission = "full-access" | "function-call" | "other";

/**
 * The key's next nonce and a block hash from one `view_access_key` read at FINAL finality, made just before
 * signing, with the key's permission from the same answer. A final block is one every node of a multi-node RPC has,
 * so the tx never comes back `Expired` because the receiving node lacks an optimistic block (near-api-js reads a
 * final block for the same reason); every earlier send waited for FINAL, so the nonce is current. null when the key
 * or its account is gone.
 */
async function accessKeyNonce(url: string, accountId: string, publicKey: string): Promise<{ nonce: bigint; blockHash: string; permission: KeyPermission } | null> {
  const reply = await rpcCall(url, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  if (isNoSuchKey(reply.json)) return null;
  const r = reply.json?.result;
  if (r?.nonce === undefined || typeof r.block_hash !== "string") {
    throw new EnvironmentError(`view_access_key ${accountId} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the RPC endpoint and the account");
  }
  const p = r.permission;
  const permission: KeyPermission = p === "FullAccess" ? "full-access" : p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 1 && "FunctionCall" in p ? "function-call" : "other";
  return { nonce: BigInt(r.nonce) + 1n, blockHash: r.block_hash, permission };
}

/** The hint when a session send meets a key that is not a function-call key on chain: nothing was signed. */
const NOT_A_SESSION_KEY_TRY = "nothing was signed: delete that key with the account's own full-access key, then run keyhole wrap for a new session";

async function finalBlockHash(url: string): Promise<string> {
  const reply = await rpcCall(url, "block", { finality: "final" });
  const hash = reply.json?.result?.header?.hash;
  if (typeof hash !== "string") throw new EnvironmentError(`block query returned no header hash (${rpcErrorTextAt(reply.json, url)})`, "check the RPC endpoint");
  return hash;
}

/**
 * Signs one transaction and sends it once with `send_tx` (`wait_until: FINAL`); returns the body as received
 * when it says what became of the tx: a result (landed, failed or not) or a refusal at validation. Any other
 * answer, or none, is never followed by a second send_tx: `tx` is polled with the hash computed here, and the
 * result is the first body that carries the transaction's outcome (pollUnknownFate). No outcome is judged here
 * (mustSucceed / outcomeFromBody do that).
 */
async function sendSigned(url: string, signerId: string, keyPair: KeyPair, receiverId: string, acts: Action[], nonce: bigint, blockHash: string): Promise<SentTx> {
  const tx = createTransaction(signerId, keyPair.getPublicKey(), receiverId, nonce, acts, baseDecode(blockHash));
  const { txHash, signedTransaction } = await new KeyPairSigner(keyPair).signTransaction(tx);
  const hash = baseEncode(txHash);
  const signed_tx_base64 = Buffer.from(signedTransaction.encode()).toString("base64");
  let first: string;
  try {
    const reply = await rpcCall(url, "send_tx", { signed_tx_base64, wait_until: "FINAL" });
    const state = bodyState(reply.raw);
    const name = rpcErrorName(reply.json);
    if (state === "landed-ok" || state === "landed-failed" || name === "INVALID_TRANSACTION" || parseRefusal(reply.raw)) return { txHash: hash, raw: reply.raw, json: reply.json };
    first = name === "TIMEOUT_ERROR" ? "the node timed out (TIMEOUT_ERROR)" : `the node answered ${rpcErrorTextAt(reply.json, url)}`;
  } catch (e) {
    // rpcCall failed the send: a client-side timeout, HTTP 429/502/503, non-JSON, the body cap or no connection.
    first = `the send failed: ${e instanceof EnvironmentError ? e.what : reasonOf(e)}`;
  }
  return pollUnknownFate(url, hash, signerId, first);
}

/** Polls `tx` by the local hash after a send whose answer did not settle the tx's fate; never sends it again. */
async function pollUnknownFate(url: string, hash: string, signerId: string, first: string): Promise<SentTx> {
  for (let i = 1; i <= TIMEOUT_POLLS; i++) {
    let poll: RpcReply;
    try {
      poll = await rpcCall(url, "tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "FINAL" });
    } catch (e) {
      if (e instanceof RpcTimeoutError) continue; // the client waited as long as a node would
      throw new SendFateUnknownError(hash, signerId, `${first}; reading the tx then failed: ${e instanceof EnvironmentError ? e.what : reasonOf(e)}`);
    }
    const name = rpcErrorName(poll.json);
    if (name === "TIMEOUT_ERROR") continue; // the node already waited before answering
    if (name === "UNKNOWN_TRANSACTION") {
      await sleep(POLL_GAP_MS);
      continue;
    }
    if (name || !poll.json?.result?.status) throw new SendFateUnknownError(hash, signerId, `${first}; reading the tx then failed: ${rpcErrorTextAt(poll.json, url)}`);
    return { txHash: hash, raw: poll.raw, json: poll.json };
  }
  throw new SendFateUnknownError(hash, signerId, `${first}; not seen final after ${TIMEOUT_POLLS} tx polls`);
}

/**
 * The one way to sign: assertChain resolves to the URL it verified, and the nonce read, any block read, the
 * send and its polls all use that URL. `missingKey` says what to do when the signing key is not on chain:
 * "refuse" (nothing is signed) or "sign" with nonce 1 and a final block hash, because the verifier rejects
 * such a tx on signer and key existence before it reads the nonce (PRD §7 check order).
 *
 * A "session" send (sendAttemptTx: "sign") signs only when that same read says the key is a function-call key
 * (C-T19c): a key with full access, or any other permission, under the session's public key is refused before
 * anything is signed, however it got there (re-added mid-session, a session file that names another key).
 */
async function chainSend(network: Network, signerId: string, keyPair: KeyPair, receiverId: string, acts: Action[], missingKey: "refuse" | "sign"): Promise<{ url: string; sent: SentTx }> {
  const url = await assertChain(network);
  const publicKey = keyPair.getPublicKey().toString();
  const key = await accessKeyNonce(url, signerId, publicKey);
  if (!key && missingKey === "refuse") throw new EnvironmentError(`${signerId} has no access key ${publicKey} on ${network}`, "check the signer account and the key it signs with");
  if (key && missingKey === "sign" && key.permission !== "function-call") {
    throw new EnvironmentError(
      key.permission === "full-access"
        ? `the session key ${publicKey} has full access on ${signerId}; a session send signs only with a function-call key`
        : `view_access_key ${signerId} ${publicKey} answered a permission that is not a function-call key; a session send signs only with one`,
      NOT_A_SESSION_KEY_TRY,
    );
  }
  const sent = key ? await sendSigned(url, signerId, keyPair, receiverId, acts, key.nonce, key.blockHash) : await sendSigned(url, signerId, keyPair, receiverId, acts, 1n, await finalBlockHash(url));
  return { url, sent: await withRefundReceipts(url, sent, signerId) };
}

/**
 * Signs `actions` as `signerId` with a fresh nonce and block hash (one `view_access_key` read), then sends.
 * Checks the chain first (assertChain: once per process per network and RPC URL), so nothing is ever
 * signed for a mainnet RPC. The returned body may be a refusal or a landed failure: see mustSucceed.
 */
export async function signAndSend(network: Network, signerId: string, keyPair: KeyPair, receiverId: string, actions: Action[]): Promise<SentTx> {
  return withKeyLock(keyPair.getPublicKey().toString(), async () => (await chainSend(network, signerId, keyPair, receiverId, actions, "refuse")).sent);
}

/** What the attempt path returns: the send's body and, when it landed but its refund was not seen, why. */
export interface AttemptSent {
  sent: SentTx;
  /** Set when the tx landed in a block but settle failed: the tx is on chain and must not be sent again. */
  unsettled?: EnvironmentError;
}

/**
 * sendAttempt's path through the seam. Under the signing key's lock: the chain check, one send at the
 * verified URL, then, for a tx that landed, settle at that same URL before the lock is released, so the next
 * call with the key sees the refunded allowance. Unlike signAndSend, a key that is gone still signs (nonce 1,
 * final block hash): an attempt after burn must reach the chain so the protocol does the refusing. A key the chain
 * lists with full access (or any permission but FunctionCall) is never signed with here: an EnvironmentError, and
 * nothing is sent (C-T19c).
 */
export async function sendAttemptTx(network: Network, signerId: string, keyPair: KeyPair, receiverId: string, actions: Action[]): Promise<AttemptSent> {
  return withKeyLock(keyPair.getPublicKey().toString(), async () => {
    const { url, sent } = await chainSend(network, signerId, keyPair, receiverId, actions, "sign");
    const state = bodyState(sent.raw);
    if (state !== "landed-ok" && state !== "landed-failed") return { sent };
    const landedHash: string = typeof sent.json?.result?.transaction?.hash === "string" ? sent.json.result.transaction.hash : sent.txHash;
    try {
      await settleAt(url, landedHash, signerId);
    } catch (e) {
      return { sent, unsettled: e instanceof EnvironmentError ? e : new EnvironmentError(`settle failed: ${(e as Error).message}`, notAgain(landedHash)) };
    }
    return { sent };
  });
}

/** True once every receipt id spawned in the tx tree has an outcome, the gas refund included (spike). */
export function receiptTreeComplete(json: any): boolean {
  const r = json?.result;
  if (!r?.transaction_outcome || !Array.isArray(r.receipts_outcome)) return false;
  const have = new Set(r.receipts_outcome.map((o: any) => o.id));
  return [r.transaction_outcome, ...r.receipts_outcome].flatMap((o: any) => o.outcome?.receipt_ids ?? []).every((id: string) => have.has(id));
}

/**
 * Waits until the tx's refund receipt has landed, so the next function-call tx sees the refunded allowance (PRD §7).
 * Polls `tx` (`wait_until: FINAL`) at most 20 times, 300 ms apart; a TIMEOUT_ERROR (or a client-side timeout)
 * is asked again at once, an unknown tx after the gap, and any other RPC error fails at once.
 */
export async function settle(network: Network, txHash: string, signerId: string): Promise<void> {
  return settleAt(rpcUrlFor(network), txHash, signerId);
}

async function settleAt(url: string, txHash: string, signerId: string): Promise<void> {
  let wait = false;
  for (let i = 1; i <= SETTLE_POLLS; i++) {
    if (wait) await sleep(POLL_GAP_MS);
    let reply: RpcReply;
    try {
      reply = await rpcCall(url, "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
    } catch (e) {
      if (!(e instanceof RpcTimeoutError)) throw e;
      wait = false;
      continue;
    }
    const name = rpcErrorName(reply.json);
    wait = name !== "TIMEOUT_ERROR";
    if (name === "TIMEOUT_ERROR" || name === "UNKNOWN_TRANSACTION") continue;
    if (name || !reply.json?.result) throw new EnvironmentError(`tx ${txHash}: ${rpcErrorTextAt(reply.json, url)}`, notAgain(txHash));
    if (receiptTreeComplete(reply.json)) return;
  }
  throw new EnvironmentError(`tx ${txHash}: receipt tree incomplete after ${SETTLE_POLLS} tx polls`, notAgain(txHash));
}

/**
 * Returns `sent` when it landed and nothing failed but its gas refunds: a `landed-ok` body, or a `landed-failed`
 * one whose only failed receipts are in `sent.refundReceiptIds` (a failed gas refund to a signer the tx deleted,
 * say; see landedFailure). Otherwise throws an EnvironmentError naming `label`: a failure in a block, a refusal at
 * validation, or a body with no transaction result.
 */
export function mustSucceed(label: string, sent: SentTx): SentTx {
  const state = bodyState(sent.raw);
  if (state === "landed-ok" || state === "landed-failed") {
    const failure = landedFailure(sent.json, sent.refundReceiptIds);
    if (!failure) return sent; // a failed gas refund (e.g. to a signer this tx deleted) is not the tx's failure
    const why = panicMessage(sent.json) ?? failure.why;
    const unchecked = sent.refundCheckFailed ? ` (which failed receipts are gas refunds could not be read: ${clip(sent.refundCheckFailed, 200)})` : "";
    throw new EnvironmentError(`${label}: failed in a block: ${clip(why)}${unchecked} · tx ${sent.txHash}`, failedOnChainHint(sent.txHash, failure));
  }
  const refusal = parseRefusal(sent.raw);
  if (refusal) {
    throw new EnvironmentError(`${label}: refused at validation (${refusal.errorName}), never in a block · tx ${sent.txHash}`, "nothing reached the chain: check the signer's key, its scope and its balance");
  }
  throw new EnvironmentError(`${label}: no transaction result (${rpcErrorText(sent.json)}) · tx ${sent.txHash}`, SEND_HINT);
}

/**
 * The hint for a tx that landed and failed (Task 2 fix round 3). Its fate is known, so it never says "do not sign
 * it again" (that is for fate-unknown and landed-unsettled): a failed DeleteKey leaves the key live, and sending
 * again is right. It says what the failure undid, and leaves the retry to the caller.
 */
function failedOnChainHint(txHash: string, failure: LandedFailure): string {
  const decide = "whether to retry is the caller's decision";
  if (failure.rolledBackAll || !failure.receiptId) return `tx ${txHash} failed on chain and changed nothing except the gas it burnt; ${decide}`;
  return `tx ${txHash} landed, but its receipt ${failure.receiptId} failed on chain: that receipt changed nothing except gas, and the receipts before it stand; ${decide}`;
}

/** The tx's SuccessValue, base64-decoded and parsed as JSON (e.g. the id add_proposal returns); "" → null. */
export function successValue(sent: SentTx): unknown {
  const status = sent.json?.result?.status;
  const value = status?.SuccessValue;
  if (typeof value !== "string") {
    const what = status ? `status ${Object.keys(status).join(", ")}` : rpcErrorText(sent.json);
    throw new EnvironmentError(`tx ${sent.txHash} has no SuccessValue (${clip(what, 200)})`, "check that the transaction succeeded (mustSucceed) before reading its value");
  }
  const text = Buffer.from(value, "base64").toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new EnvironmentError(`tx ${sent.txHash}: its SuccessValue is not JSON (${clip(text, 80)})`, "read the value as bytes instead");
  }
}
