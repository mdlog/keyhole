/**
 * Suite "protocol refusals" (LAYOUT R7), offline: parseRefusal over the send_tx response bodies the
 * Day-1 spike recorded. Each file is the RPC body byte for byte; the expected names come from this
 * table, never from the file name, so a renamed or regenerated fixture cannot pass by accident.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRefusal } from "../src/core/refusal.js";
import { INVALID_ACCESS_KEY_ERRORS } from "../src/core/types.js";
import { COMPAT_FIXTURES, NEGATIVE_CONTROL_FIXTURES, SANDBOX_FIXTURES, readFixture } from "./helpers.js";

/** Every refusal the spike recorded: send_tx body → the InvalidAccessKeyError variant inside it. */
const REFUSALS: Record<string, string> = {
  "052-g1-method-add_proposal.send_tx.json": "MethodNameMismatch",
  "055-g2-transfer-1yocto-attacker.send_tx.json": "RequiresFullAccess",
  "058-g3-receiver-other-dao.send_tx.json": "ReceiverMismatch",
  "061-g4-deposit-1yocto.send_tx.json": "DepositWithFunctionCall",
  "064-g2b-transfer-1yocto-dao.send_tx.json": "RequiresFullAccess",
  "072-i-attempt-after-burn.send_tx.json": "AccessKeyNotFound",
  "077-j-attempt-1yocto-key.send_tx.json": "NotEnoughAllowance",
  "080-j-measure-5tgas.send_tx.json": "NotEnoughAllowance",
  "082-j-measure-10tgas.send_tx.json": "NotEnoughAllowance",
  "084-j-measure-30tgas.send_tx.json": "NotEnoughAllowance",
  "086-j-measure-48tgas.send_tx.json": "NotEnoughAllowance",
  "088-j-measure-50tgas.send_tx.json": "NotEnoughAllowance",
  "090-j-measure-100tgas.send_tx.json": "NotEnoughAllowance",
};

/** `tx` status lookups of the refused transactions: UNKNOWN_TRANSACTION, i.e. no block holds them. */
const TX_STATUS = [
  "053-g1-method-add_proposal.tx_status.json",
  "056-g2-transfer-1yocto-attacker.tx_status.json",
  "059-g3-receiver-other-dao.tx_status.json",
  "062-g4-deposit-1yocto.tx_status.json",
  "065-g2b-transfer-1yocto-dao.tx_status.json",
  "073-i-attempt-after-burn.tx_status.json",
  "078-j-attempt-1yocto-key.tx_status.json",
];

/** In the negative control the key also allowed add_proposal, so g1 was NOT refused. */
const NEGATIVE_CONTROL_LANDED = "052-g1-method-add_proposal.send_tx.json";

const RUNS = [
  { name: "sandbox", dir: SANDBOX_FIXTURES, landed: [] as string[] },
  { name: "compat-sputnikv2-3.31", dir: COMPAT_FIXTURES, landed: [] as string[] },
  { name: "negative-control", dir: NEGATIVE_CONTROL_FIXTURES, landed: [NEGATIVE_CONTROL_LANDED] },
];

describe.each(RUNS)("protocol refusals: REPLAY of $name", ({ name, dir, landed }) => {
  const expected = Object.entries(REFUSALS).filter(([file]) => !landed.includes(file));

  it.each(expected)(`REPLAY [${name}] %s → %s`, (file, errorName) => {
    const raw = readFixture(dir, file);
    const r = parseRefusal(raw);
    expect(r).not.toBeNull();
    expect(r?.errorName).toBe(errorName);
    expect(r?.family).toBe("InvalidTxError::InvalidAccessKeyError");
    expect(r?.path).toEqual(["InvalidTxError", "InvalidAccessKeyError", errorName]);
    expect(r?.reachedBlock).toBe(false);
    // Display invariant, parser half: the body carried for display is the fixture, byte for byte.
    expect(r?.rawRpcJson).toBe(raw);
  });

  it("every refusal-shaped send_tx body in the capture is in the table above", () => {
    const refusalShaped = readdirSync(dir)
      .filter((f) => f.endsWith(".send_tx.json"))
      .filter((f) => readFixture(dir, f).includes('"InvalidTxError"'))
      .sort();
    expect(refusalShaped).toEqual(expected.map(([file]) => file).sort());
  });

  it("no other send_tx body parses as a refusal", () => {
    const others = readdirSync(dir).filter((f) => f.endsWith(".send_tx.json") && !(f in REFUSALS && !landed.includes(f)));
    expect(others.length).toBeGreaterThan(10);
    for (const f of others) expect(parseRefusal(readFixture(dir, f)), f).toBeNull();
  });
});

describe("protocol refusals: what is not a refusal", () => {
  it.each(TX_STATUS)("%s (UNKNOWN_TRANSACTION: no block holds the refused tx) is not a refusal", (file) => {
    const raw = readFixture(SANDBOX_FIXTURES, file);
    expect(raw).toContain("UNKNOWN_TRANSACTION");
    expect(parseRefusal(raw)).toBeNull();
  });

  it("negative control: with add_proposal in method_names, g1 lands and the contract panics; no refusal is parsed", () => {
    const raw = readFixture(NEGATIVE_CONTROL_FIXTURES, NEGATIVE_CONTROL_LANDED);
    expect(raw).toContain("ERR_MIN_BOND");
    expect(parseRefusal(raw)).toBeNull();
  });

  it("malformed input is not a refusal", () => {
    expect(parseRefusal("")).toBeNull();
    expect(parseRefusal("not json")).toBeNull();
    expect(parseRefusal("null")).toBeNull();
    expect(parseRefusal('{"jsonrpc":"2.0","result":{}}')).toBeNull();
  });

  it("an InvalidTxError outside InvalidAccessKeyError keeps its own family", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", error: { data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 9 } } } } } });
    const r = parseRefusal(raw);
    expect(r?.family).toBe("InvalidTxError");
    expect(r?.errorName).toBe("InvalidNonce");
    expect(r?.path).toEqual(["InvalidTxError", "InvalidNonce"]);
  });
});

describe("protocol refusals: coverage", () => {
  it("the capture reproduces the six InvalidAccessKeyError variants a plain access key can hit", () => {
    const seen = new Set(Object.values(REFUSALS));
    expect([...INVALID_ACCESS_KEY_ERRORS].sort()).toEqual([...seen].sort());
  });
});
