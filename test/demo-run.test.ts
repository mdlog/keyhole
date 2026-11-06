/**
 * DATA CONTRACT #16 loadDemoRunFixture: the committed spike capture read back as a DemoRun, offline.
 * Every Attempt field is decoded from the signed transaction in the capture log; every outcome goes
 * through the live path's parser (outcomeFromBody → parseRefusal).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/core/errors.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { NOTE_IN_SCOPE } from "../src/render/strings.js";
import { COMPAT_FIXTURES, NEGATIVE_CONTROL_FIXTURES, REPO, SANDBOX_FIXTURES } from "./helpers.js";

const REFUSAL_ORDER = [
  "MethodNameMismatch",
  "RequiresFullAccess",
  "ReceiverMismatch",
  "DepositWithFunctionCall",
  "RequiresFullAccess",
  "AccessKeyNotFound",
  ...Array(7).fill("NotEnoughAllowance"),
];

describe("loadDemoRunFixture (fixture-replay)", () => {
  it("reads demo/fixtures/sandbox as a 16-step sandbox REPLAY that exits 0", async () => {
    const run = await loadDemoRunFixture(SANDBOX_FIXTURES);
    expect(run.id).toBe("replay-sandbox");
    expect(run.mode).toBe("replay");
    expect(run.network).toBe("sandbox");
    expect(run.exitCode).toBe(0);
    expect(run.steps.map((s) => s.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(run.steps.every((s) => s.total === 16 && s.pass && s.signer === "session")).toBe(true);
    expect(run.durationMs).toBeGreaterThan(0);
    expect(run.transcriptPath).toBe(join(REPO, "demo", "transcript.sandbox.md"));
  });

  it("decodes what was signed, and parses the refusals in run order", async () => {
    const run = await loadDemoRunFixture(SANDBOX_FIXTURES);
    const [vote0, inject, , method] = run.steps;

    expect(vote0.phase).toBe("in-scope");
    expect(vote0.attempt).toMatchObject({ action: "FunctionCall", method: "act_proposal", receiverId: "dao.sandbox", depositYocto: "0", gasTGas: 30, args: { id: 0, action: "VoteApprove" } });
    expect(vote0.attempt?.outcome.kind).toBe("TxSuccess");
    expect(vote0.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(inject.note).toBe(NOTE_IN_SCOPE);

    expect(method.phase).toBe("refusals");
    expect(method.attempt).toMatchObject({ action: "FunctionCall", method: "add_proposal", receiverId: "dao.sandbox", depositYocto: "0", gasTGas: 30, violates: "method" });
    expect(method.txHash).toBeUndefined();

    const refusals = run.steps.flatMap((s) => (s.attempt?.outcome.kind === "Refusal" ? [s.attempt.outcome.errorName] : []));
    expect(refusals).toEqual(REFUSAL_ORDER);

    const transfer = run.steps[4].attempt;
    expect(transfer).toMatchObject({ action: "Transfer", receiverId: "attacker.sandbox", depositYocto: "1", violates: "action" });
    expect(transfer?.method).toBeUndefined();

    expect(run.steps.slice(10).map((s) => s.attempt?.gasTGas)).toEqual([5, 10, 30, 48, 50, 100]);
  });

  it("reads the compat run (sputnikv2.testnet default DAO code) the same way", async () => {
    const run = await loadDemoRunFixture(COMPAT_FIXTURES);
    expect(run.id).toBe("replay-compat-sputnikv2-3.31");
    expect(run.exitCode).toBe(0);
    expect(run.steps.flatMap((s) => (s.attempt?.outcome.kind === "Refusal" ? [s.attempt.outcome.errorName] : []))).toEqual(REFUSAL_ORDER);
  });

  it("negative control: the landed add_proposal is a FAIL step and the run exits 1", async () => {
    const run = await loadDemoRunFixture(NEGATIVE_CONTROL_FIXTURES);
    expect(run.exitCode).toBe(1);
    const failed = run.steps.filter((s) => !s.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0].attempt?.outcome.kind).toBe("ContractPanic");
    expect(failed[0].note).toBe("FAIL: expected MethodNameMismatch, parsed no refusal (landed: ContractPanic) from the body");
    const panic = failed[0].attempt?.outcome;
    expect(panic?.kind === "ContractPanic" && panic.message).toContain("ERR_MIN_BOND");
  });

  it("a directory without a capture log is an input error", async () => {
    await expect(loadDemoRunFixture(join(REPO, "demo", "fixtures", "no-capture-here"))).rejects.toBeInstanceOf(InputError);
  });
});
