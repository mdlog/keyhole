/**
 * Reading a `send_tx` / `tx` result that DID reach a block. Ported from spike/spike.ts
 * (`executionFailure`). Pure: shared by sendAttempt (live) and labelMethod (live + replay).
 */
import { findKey } from "./refusal.js";

type Outcome = { id?: string; outcome?: { status?: Record<string, unknown> } };
type TxResult = { status?: Record<string, unknown>; receipts_outcome?: Outcome[] };

/** First failure inside an included transaction (tx status or any receipt), or null. */
export function executionFailure(json: { error?: unknown; result?: TxResult }): string | null {
  if (json.error) return `RPC error: ${JSON.stringify(json.error)}`;
  const r = json.result;
  if (!r) return `no result: ${JSON.stringify(json)}`;
  if (r.status && "Failure" in r.status) return `tx Failure: ${JSON.stringify(r.status.Failure)}`;
  for (const o of r.receipts_outcome ?? []) {
    if (o.outcome?.status && "Failure" in o.outcome.status) return `receipt ${o.id} Failure: ${JSON.stringify(o.outcome.status.Failure)}`;
  }
  return null;
}

/** The contract's panic text (FunctionCallError.ExecutionError), verbatim, or null. */
export function panicMessage(json: unknown): string | null {
  const m = findKey(json, "ExecutionError");
  return typeof m === "string" ? m : null;
}

/** Coarse state of a raw RPC body. "not-in-block" covers refusals and other RPC errors. */
export type BodyState = "landed-ok" | "landed-failed" | "not-in-block" | "unreadable";

export function bodyState(rawRpcJson: string): BodyState {
  let json: { error?: unknown; result?: TxResult };
  try {
    json = JSON.parse(rawRpcJson);
  } catch {
    return "unreadable";
  }
  if (!json || typeof json !== "object") return "unreadable";
  if (json.error) return "not-in-block";
  if (!json.result || !json.result.status) return "unreadable";
  return executionFailure(json) ? "landed-failed" : "landed-ok";
}
