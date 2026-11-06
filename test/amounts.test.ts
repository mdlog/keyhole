/**
 * src/core/amounts.ts: yoctoNEAR arithmetic and account-id helpers (locked in Task 1).
 * PRD §7 (spike, measured): a function-call key buys its gas up front at the minimum gas price, so the
 * allowance must cover attached TGas × 0.001 NEAR plus a small fixed part (0.000919 NEAR measured).
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWANCE_MARGIN, MIN_GAS_PRICE, NEAR, SUBACCOUNT_RESERVE, TGAS, formatNear, minAllowanceYocto, networkOfAccount, parentAccount } from "../src/core/amounts.js";
import { InputError } from "../src/core/errors.js";
import { SANDBOX_FIXTURES, readFixture } from "./helpers.js";

describe("amounts", () => {
  it("constants: NEAR, TGas, the minimum gas price (protocol >= 85), the margin and the sub-account reserve", () => {
    expect(NEAR).toBe(10n ** 24n);
    expect(TGAS).toBe(10n ** 12n);
    expect(MIN_GAS_PRICE).toBe(10n ** 9n);
    expect(ALLOWANCE_MARGIN).toBe(10n ** 21n);
    expect(SUBACCOUNT_RESERVE).toBe(10n ** 22n);
  });

  it("minAllowanceYocto: attached gas at the minimum gas price, plus the 0.001 NEAR margin", () => {
    expect(minAllowanceYocto(30)).toBe(31n * 10n ** 21n);
    expect(minAllowanceYocto(100)).toBe(101n * 10n ** 21n);
    expect(minAllowanceYocto(0)).toBe(ALLOWANCE_MARGIN);
    expect(minAllowanceYocto(0.5)).toBe(5n * 10n ** 20n + ALLOWANCE_MARGIN);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => minAllowanceYocto(bad), String(bad)).toThrow(InputError);
  });

  it("minAllowanceYocto covers every up-front cost the spike measured (NotEnoughAllowance.cost), within the margin", () => {
    const measured = readdirSync(SANDBOX_FIXTURES).filter((f) => /-j-measure-\d+tgas\.send_tx\.json$/.test(f));
    expect(measured).toHaveLength(6);
    for (const file of measured) {
      const tgas = Number(/-j-measure-(\d+)tgas/.exec(file)?.[1]);
      const cost = BigInt(JSON.parse(readFixture(SANDBOX_FIXTURES, file)).error.data.TxExecutionError.InvalidTxError.InvalidAccessKeyError.NotEnoughAllowance.cost);
      expect(minAllowanceYocto(tgas) >= cost, file).toBe(true);
      expect(minAllowanceYocto(tgas) - cost < ALLOWANCE_MARGIN, file).toBe(true);
    }
  });

  it("formatNear: fixed decimals (default 4), floored, never rounded up", () => {
    expect(formatNear(31n * 10n ** 21n)).toBe("0.0310");
    expect(formatNear("39199999999999999999999")).toBe("0.0391");
    expect(formatNear(5n * 10n ** 22n, 2)).toBe("0.05");
    expect(formatNear("41200000000000000000000")).toBe("0.0412");
    expect(formatNear(66n * 10n ** 23n, 2)).toBe("6.60");
    expect(formatNear(0n)).toBe("0.0000");
    expect(formatNear(1n)).toBe("0.0000");
    expect(formatNear(1n, 24)).toBe("0.000000000000000000000001");
    expect(formatNear(12345n * NEAR + 999n, 0)).toBe("12345");
  });

  it("formatNear refuses a malformed amount and an impossible precision", () => {
    for (const bad of ["1.5", "-1", "", "0x10", " 1"]) expect(() => formatNear(bad), JSON.stringify(bad)).toThrow(InputError);
    expect(() => formatNear(-1n)).toThrow(InputError);
    for (const dp of [-1, 25, 1.5]) expect(() => formatNear(1n, dp), String(dp)).toThrow(RangeError);
  });

  it("parentAccount: drops the first label", () => {
    expect(parentAccount("ks-7f3a.op.testnet")).toBe("op.testnet");
    expect(parentAccount("ks-7f3a.sandbox")).toBe("sandbox");
    expect(() => parentAccount("testnet")).toThrow(InputError);
    expect(() => parentAccount("a".repeat(64))).toThrow(InputError);
  });

  it("networkOfAccount: *.testnet or *.sandbox; anything else (mainnet, implicit) is null", () => {
    expect(networkOfAccount("seat.op.testnet")).toBe("testnet");
    expect(networkOfAccount("kh-1a2b.sputnik-v2.testnet")).toBe("testnet");
    expect(networkOfAccount("dao.sandbox")).toBe("sandbox");
    expect(networkOfAccount("alice.near")).toBeNull();
    expect(networkOfAccount("a".repeat(64))).toBeNull();
    expect(networkOfAccount("testnet")).toBeNull();
    expect(networkOfAccount(".testnet")).toBeNull();
    expect(networkOfAccount("seat.testnet.near")).toBeNull();
    expect(networkOfAccount("SEAT.TESTNET")).toBeNull();
  });
});
