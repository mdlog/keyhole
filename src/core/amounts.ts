/**
 * yoctoNEAR arithmetic and account-id helpers (locked in Task 1). Pure: no I/O.
 *
 * PRD §7 (spike, measured): a function-call key buys the gas it attaches up front, at the minimum gas
 * price, out of its allowance. The measured up-front cost is TGas × 0.001 NEAR + 0.000919 NEAR, so a
 * 30 TGas vote costs 0.030919 NEAR and the smallest allowance wrap accepts is 0.031 NEAR.
 */
import { InputError } from "./errors.js";
import type { Network } from "./types.js";

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
/** yocto per gas: the minimum gas price, protocol >= 85. */
export const MIN_GAS_PRICE = 10n ** 9n;
/** 0.001 NEAR on top of the gas price, which covers the measured 0.000919 NEAR fixed part. */
export const ALLOWANCE_MARGIN = 10n ** 21n;
/** 0.01 NEAR kept in a session sub-account on top of its gas allowance. */
export const SUBACCOUNT_RESERVE = 10n ** 22n;
/**
 * 0.0001 NEAR: the step formatNear prints at its default 4 decimals. An allowance is a whole number of steps, so the
 * figure printed is the one signed (core/wrap.ts refuses any other; cli/wrap.ts says so in NEAR before planWrap).
 */
export const ALLOWANCE_STEP_YOCTO = 10n ** 20n;

/** gasTGas × TGAS × MIN_GAS_PRICE + ALLOWANCE_MARGIN: the smallest allowance that pays for one call with that gas. */
export function minAllowanceYocto(gasTGas: number): bigint {
  if (!Number.isFinite(gasTGas) || gasTGas < 0) throw new InputError([`gasTGas must be a non-negative number, got ${gasTGas}`]);
  // TGas to gas with up to 6 decimals, as tgasToGas does (src/core/attempt.ts).
  const gas = BigInt(Math.round(gasTGas * 1e6)) * 10n ** 6n;
  return gas * MIN_GAS_PRICE + ALLOWANCE_MARGIN;
}

/** `dp` decimals of NEAR (default 4), floored: a balance or an allowance is never shown larger than it is. */
export function formatNear(yocto: bigint | string, dp = 4): string {
  if (!Number.isInteger(dp) || dp < 0 || dp > 24) throw new RangeError(`formatNear: dp must be an integer from 0 to 24, got ${dp}`);
  if (typeof yocto === "string" && !/^[0-9]+$/.test(yocto)) throw new InputError([`not a whole number of yoctoNEAR: ${JSON.stringify(yocto)}`]);
  const v = BigInt(yocto);
  if (v < 0n) throw new InputError([`a NEAR amount cannot be negative: ${v} yocto`]);
  const whole = (v / NEAR).toString();
  if (dp === 0) return whole;
  const fraction = (v % NEAR) / 10n ** BigInt(24 - dp);
  return `${whole}.${fraction.toString().padStart(dp, "0")}`;
}

/** The account one level up: `ks-7f3a.op.testnet` → `op.testnet` (sub-account mode's operator). */
export function parentAccount(accountId: string): string {
  const dot = accountId.indexOf(".");
  if (dot <= 0 || dot === accountId.length - 1) throw new InputError([`${JSON.stringify(accountId)} has no parent account`]);
  return accountId.slice(dot + 1);
}

/** The network an account id names by its suffix: `*.testnet` or `*.sandbox`. Anything else (mainnet, implicit ids) is null. */
export function networkOfAccount(accountId: string): Network | null {
  if (/^.+\.testnet$/.test(accountId)) return "testnet";
  if (/^.+\.sandbox$/.test(accountId)) return "sandbox";
  return null;
}
