/**
 * DATA CONTRACT #10 `sendAttempt` (path: RPC-live). One code path for the R3 `keyhole_attempt` and
 * `dao_vote` tools and the R4 driver (LAYOUT "Same code path as MCP").
 *
 * Ported from the Day-1 spike (spike/spike.ts `send` + `expectRefusal`): build and sign with
 * near-api-js, send the raw signed transaction with `send_tx` (`wait_until: FINAL`), keep the
 * response body byte for byte, and parse the outcome from that body.
 *
 * The code_hash pin (REFUSED (SERVER-SIDE, not the protocol)) is NOT applied here: it guards serve's
 * pack tools. keyhole_attempt and the driver must reach the chain so the protocol does the refusing.
 */
import { PublicKey, actions } from "near-api-js";
import { minAllowanceYocto } from "./amounts.js";
import { isEd25519PublicKey } from "./credentials.js";
import { EXIT_TX_SENT, EnvironmentError, InputError } from "./errors.js";
import { sessionKeyPair } from "./keys.js";
import { panicMessage } from "./outcome.js";
import { parseRefusal } from "./refusal.js";
import { printableRpcText } from "./rpc.js";
import { SendFateUnknownError, landedFailure, sendAttemptTx } from "./tx.js";
import type { Attempt, AttemptInput, AttemptOutcome, ContractPanic, Session, TxSuccess, Violation } from "./types.js";

type Action = ReturnType<typeof actions.transfer>;

/**
 * The single key rule an attempt would break, judged from the session's scope alone (Task 2): what
 * keyhole_attempt records as `violates`. The chain still does the refusing; this never stops a send.
 *
 * It follows the verifier's order (PRD §7): the allowance is charged first, with the gas a function
 * call attaches bought up front (minAllowanceYocto) plus any deposit a FunctionCall or Transfer carries;
 * then the function-call permission: one FunctionCall action, deposit 0, receiver, method. An empty
 * method list allows any method, as on chain.
 */
export function predictViolation(session: Session, input: Omit<AttemptInput, "sessionId" | "violates">): Violation {
  const deposit = yocto(input.depositYocto, "depositYocto");
  tgasToGas(input.gasTGas); // malformed gas is an input error for every action
  const fc = input.action === "FunctionCall";
  const charged = fc || input.action === "Transfer" ? deposit : 0n;
  if (minAllowanceYocto(fc ? input.gasTGas : 0) + charged > yocto(session.allowanceYocto, "session.allowanceYocto")) return "allowance";
  if (!fc) return "action";
  if (deposit > 0n) return "deposit";
  if (input.receiverId !== session.receiverId) return "receiver";
  if (session.methodNames.length > 0 && !session.methodNames.includes(input.method ?? "")) return "method";
  return "none";
}

/** TGas (number, up to 6 decimals) → gas units. */
export function tgasToGas(tgas: number): bigint {
  if (!Number.isFinite(tgas) || tgas < 0) throw new InputError([`gasTGas must be a non-negative number, got ${tgas}`]);
  return BigInt(Math.round(tgas * 1e6)) * 10n ** 6n;
}

function yocto(amount: string, field: string): bigint {
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) throw new InputError([`${field} must be a whole number of yoctoNEAR, got ${JSON.stringify(amount)}`]);
  return BigInt(amount);
}

/**
 * `args.publicKey` as an ed25519 public key: `ed25519:` and exactly 32 bytes of base58, by the one 32-byte check
 * (credentials.ts isEd25519PublicKey, C-T2b). Anything else is refused without echoing it: near-api-js would also
 * accept a 64-byte value, which is the shape of a private key, and an attempt must never put one in a signed transaction.
 */
function publicKeyArg(value: unknown): PublicKey {
  if (!isEd25519PublicKey(value)) throw new InputError(['args.publicKey must be an ed25519 public key: "ed25519:" and 32 bytes in base58 (value not shown)']);
  return PublicKey.fromString(value);
}

/** AddKey's `args.permission`: "FullAccess", or `{receiverId, methodNames, allowanceYocto?}` (no allowance = unlimited). */
function addKeyAction(publicKey: PublicKey, permission: unknown): Action {
  if (permission === "FullAccess") return actions.addFullAccessKey(publicKey);
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    throw new InputError(['args.permission must be "FullAccess" or {receiverId, methodNames, allowanceYocto}']);
  }
  const { receiverId, methodNames, allowanceYocto } = permission as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof receiverId !== "string" || receiverId === "") problems.push("args.permission.receiverId must be a non-empty account id");
  if (!Array.isArray(methodNames) || !methodNames.every((m) => typeof m === "string")) problems.push("args.permission.methodNames must be an array of method names");
  if (allowanceYocto !== undefined && (typeof allowanceYocto !== "string" || !/^[0-9]+$/.test(allowanceYocto))) {
    problems.push(`args.permission.allowanceYocto must be a whole number of yoctoNEAR, got ${JSON.stringify(allowanceYocto)}`);
  }
  if (problems.length > 0) throw new InputError(problems);
  return actions.addFunctionCallAccessKey(publicKey, receiverId as string, methodNames as string[], allowanceYocto === undefined ? undefined : BigInt(allowanceYocto as string));
}

/** `args.codeBase64` as bytes; it must be non-empty, valid base64. */
function codeArg(value: unknown): Uint8Array {
  if (typeof value !== "string" || value === "" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new InputError(["args.codeBase64 must be the contract code, base64-encoded"]);
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * The single action an attempt signs. Args per action: AddKey `publicKey` + `permission`; DeleteKey
 * `publicKey`; DeleteAccount `beneficiaryId`; DeployContract `codeBase64`; Stake `publicKey` with
 * `depositYocto` as the stake; CreateAccount none. `depositYocto` is checked for every action.
 */
export function attemptActions(a: AttemptInput): Action[] {
  const deposit = yocto(a.depositYocto, "depositYocto");
  const args: Record<string, unknown> = a.args ?? {};
  switch (a.action) {
    case "FunctionCall":
      if (!a.method) throw new InputError(["a FunctionCall attempt needs a method"]);
      return [actions.functionCall(a.method, a.args, tgasToGas(a.gasTGas), deposit)];
    case "Transfer":
      return [actions.transfer(deposit)];
    case "AddKey":
      return [addKeyAction(publicKeyArg(args.publicKey), args.permission)];
    case "DeleteKey":
      return [actions.deleteKey(publicKeyArg(args.publicKey))];
    case "CreateAccount":
      return [actions.createAccount()];
    case "DeleteAccount":
      if (typeof args.beneficiaryId !== "string" || args.beneficiaryId === "") throw new InputError(["args.beneficiaryId must be a non-empty account id"]);
      return [actions.deleteAccount(args.beneficiaryId)];
    case "DeployContract":
      return [actions.deployContract(codeArg(args.codeBase64))];
    case "Stake":
      return [actions.stake(deposit, publicKeyArg(args.publicKey))];
    default:
      throw new InputError([`unknown action ${JSON.stringify(a.action)}`]);
  }
}

/**
 * The outcome a `send_tx` body records: Refusal (parsed name), ContractPanic (landed, failed) or
 * TxSuccess. null for a body that is neither: another RPC error, or no transaction result.
 * Shared by sendAttempt (live) and loadDemoRunFixture (replay): one parser for both paths.
 * `refundReceiptIds` (SentTx, from EXPERIMENTAL_tx_status) are the tx's gas refunds to its signer: a failed gas
 * refund is not a ContractPanic (Task 2 fix rounds 3 and 4). The replay path has none, so there every failed
 * receipt counts.
 */
export function outcomeFromBody(rawRpcJson: string, localTxHash?: string, refundReceiptIds?: readonly string[]): AttemptOutcome | null {
  const refusal = parseRefusal(rawRpcJson);
  if (refusal) return refusal;
  let json: any;
  try {
    json = JSON.parse(rawRpcJson);
  } catch {
    return null;
  }
  if (!json || json.error || !json.result?.status) return null;
  const txHash: string | undefined = typeof json.result.transaction?.hash === "string" ? json.result.transaction.hash : localTxHash;
  if (!txHash) return null;
  const failure = landedFailure(json, refundReceiptIds);
  if (failure) return { kind: "ContractPanic", txHash, message: panicMessage(json) ?? failure.why, rawRpcJson };
  return { kind: "TxSuccess", txHash, rawRpcJson };
}

/**
 * A landed attempt (TxSuccess or ContractPanic) whose refund receipt was not seen in time. It is on chain, so it
 * must never be sent again; `attempt` keeps its outcome with the rawRpcJson. sendAttempt throws this instead of
 * returning, so the next call with the key cannot meet a still-pending refund and record a NotEnoughAllowance
 * refusal that the key's scope never caused. Exit 3, not 2: a transaction was sent (C-T2j).
 */
export class LandedUnsettledError extends EnvironmentError {
  override readonly exitCode = EXIT_TX_SENT;
  readonly attempt: Attempt;
  constructor(attempt: Attempt, landed: TxSuccess | ContractPanic, cause: EnvironmentError) {
    super(
      `the attempt landed in a block (${landed.kind}, tx ${landed.txHash}), but its refund was not seen: ${cause.what}`,
      `it is on chain: do not send it again; read tx ${landed.txHash} later, its refund lands on its own`,
    );
    this.name = "LandedUnsettledError";
    this.attempt = attempt;
  }
}

/**
 * Signs and sends one attempt with the session key, after the input checks, through tx.ts's attempt path:
 * under the key's lock (one attempt per signing key at a time), the chain check, one send at the verified
 * URL, and settle for a landed tx before the lock is released, so the next call sees the refunded allowance
 * (PRD §7). A refusal never reached a block and has nothing to settle.
 *
 * `outcome.rawRpcJson` is the send_tx body (when send_tx did not say what became of the tx: the first `tx`
 * body, polled by the local hash, that carries the result). Errors keep three cases apart by class for an MCP
 * caller, and none invites a second signature:
 * - LandedUnsettledError: the attempt is on chain (its `attempt` carries the outcome);
 * - SendFateUnknownError (tx.ts): it was sent, or may have been, and was not found; `txHash` is the hash to look up;
 * - any other error (InputError, the chain check, the nonce read): nothing was sent.
 */
export async function sendAttempt(session: Session, attempt: AttemptInput): Promise<Attempt> {
  if (attempt.sessionId !== session.id) throw new InputError([`attempt.sessionId ${attempt.sessionId} is not session ${session.id}`]);
  const acts = attemptActions(attempt); // bad input fails before any RPC
  const keyPair = sessionKeyPair(session);
  const { sent, unsettled } = await sendAttemptTx(session.network, session.accountId, keyPair, attempt.receiverId, acts);
  const outcome = outcomeFromBody(sent.raw, sent.txHash, sent.refundReceiptIds);
  // sendAttemptTx only returns a result or a refusal; anything else is a send whose fate is unknown. The body is made
  // printable (RPC URLs scrubbed, held keys replaced) before it is cut (C-T18b, C-T19h).
  if (!outcome) throw new SendFateUnknownError(sent.txHash, session.accountId, `its answer is neither a transaction result nor a refusal: ${printableRpcText(sent.raw).slice(0, 300)}`);
  const result: Attempt = { ...attempt, outcome };
  if (unsettled && outcome.kind !== "Refusal") throw new LandedUnsettledError(result, outcome, unsettled);
  return result;
}
