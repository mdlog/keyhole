/**
 * DATA CONTRACT #11 `parseRefusal` (path: RPC-live + fixture-replay, pure).
 *
 * Ported from the Day-1 spike (spike/spike.ts, "Refusal parsing"). The error name is read out of
 * the RPC JSON, never written by Keyhole. The node puts the variant under `error.data`
 * (`TxExecutionError.InvalidTxError.InvalidAccessKeyError.<Name>`); `error.cause` only says
 * INVALID_TRANSACTION. Unit variants arrive as strings, struct variants as one-key objects
 * (SPIKE_REPORT Gotcha 8).
 */
import type { Refusal } from "./types.js";

/** Depth-first search for the first own property named `key` (spike.ts `findKey`). */
export function findKey(node: unknown, key: string): unknown {
  if (node && typeof node === "object") {
    if (Object.prototype.hasOwnProperty.call(node, key)) return (node as Record<string, unknown>)[key];
    for (const v of Object.values(node)) {
      const found = findKey(v, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** `"RequiresFullAccess"` → itself; `{ MethodNameMismatch: {...} }` → `"MethodNameMismatch"` (spike.ts `variantName`). */
export function variantName(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return String(v);
}

/** Refusal, or null when the body is not an InvalidTxError (a landed tx, a tx-status reply, another RPC error, non-JSON). */
export function parseRefusal(rawRpcJson: string): Refusal | null {
  let json: { error?: unknown } | null;
  try {
    json = JSON.parse(rawRpcJson) as { error?: unknown } | null;
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || !json.error) return null;
  const itx = findKey(json.error, "InvalidTxError");
  if (itx === undefined) return null;
  const ake = itx && typeof itx === "object" ? (itx as Record<string, unknown>).InvalidAccessKeyError : undefined;
  if (ake !== undefined) {
    const name = variantName(ake);
    return {
      kind: "Refusal",
      errorName: name,
      family: "InvalidTxError::InvalidAccessKeyError",
      path: ["InvalidTxError", "InvalidAccessKeyError", name],
      detail: ake,
      rawRpcJson,
      reachedBlock: false,
    };
  }
  const name = variantName(itx);
  return {
    kind: "Refusal",
    errorName: name,
    family: "InvalidTxError",
    path: ["InvalidTxError", name],
    detail: itx,
    rawRpcJson,
    reachedBlock: false,
  };
}
