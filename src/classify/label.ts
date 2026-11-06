/**
 * DATA CONTRACT #6 `labelMethod` (path: RPC-live + fixture-replay, pure).
 *
 * PRD MH3 differential dry-run: each method is called with 0 deposit, then with the deposit the
 * pack declares. Methods outside the key's on-chain method_names are `not in allowlist` whatever the
 * dry-run says (R7: the DAO's add_proposal dry-run hits ERR_MIN_BOND but is labelled `not in allowlist`).
 *
 * @param zeroDepositRaw  raw RPC body of the 0-deposit dry-run call
 * @param withDepositRaw  raw RPC body of the call with the pack's declared deposit; null if none declared
 * @param inAllowlist     whether the method is in the key's method_names
 */
import { bodyState } from "../core/outcome.js";
import type { Classification } from "../core/types.js";

export function labelMethod(zeroDepositRaw: string, withDepositRaw: string | null, inAllowlist: boolean): Classification {
  if (!inAllowlist) return "not in allowlist";
  const zero = bodyState(zeroDepositRaw);
  if (zero === "landed-ok") return "callable";
  // A function-call key can never attach a deposit (DepositWithFunctionCall), so a method that only
  // succeeds with one fails on-chain at runtime, and still costs gas (C3).
  if (zero === "landed-failed" && withDepositRaw !== null && bodyState(withDepositRaw) === "landed-ok") return "fails-without-deposit (runtime)";
  return "inconclusive";
}
