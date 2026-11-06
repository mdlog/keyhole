/**
 * Suite "classifier labels (recorded dry-runs)" (LAYOUT R7; PRD §6 "tests assert 6/6 expected labels").
 * labelMethod over recorded RPC bodies. The DAO and zero-bond DAO labels rest on the dry-run captures
 * classifyTools recorded on near-sandbox (`npm run capture:sandbox -- --classifier`, demo/fixtures/,
 * never regenerated here); the counter labels rest on the counter captures of the same run (Task 11).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { labelMethod } from "../src/classify/label.js";
import { bodyState } from "../src/core/outcome.js";
import type { TargetPack } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { NEGATIVE_CONTROL_FIXTURES, REPO, SANDBOX_FIXTURES, readFixture } from "./helpers.js";
import { replayLine } from "./replay-meta.js";

const SUITE = "classifier labels (recorded dry-runs)";
/** The flat fixture dir (Global Constraints → Fixtures): `sandbox.PACK.[PREFIX]dryrun-METHOD-zero|deposit.json`. */
const DEMO_FIXTURES = join(REPO, "demo", "fixtures");
/** A recorded dry-run body, read when the test runs (a missing capture fails that test, not the file). */
const read = (file: string): string => readFixture(DEMO_FIXTURES, file);

/** The Sputnik DAO with the pack's 0.1 NEAR proposal bond: act_proposal, then add_proposal with 0 deposit and with the bond. */
const DAO_VOTE_ZERO = "sandbox.sputnik-v2.dryrun-act_proposal-zero.json";
const DAO_ADD_ZERO = "sandbox.sputnik-v2.dryrun-add_proposal-zero.json";
const DAO_ADD_DEPOSIT = "sandbox.sputnik-v2.dryrun-add_proposal-deposit.json";
/** The same DAO with `proposal_bond: "0"` (policyOverride): both 0-deposit calls landed, so no -deposit file. */
const ZERO_BOND_VOTE_ZERO = "sandbox.sputnik-v2.zero-bond-dryrun-act_proposal-zero.json";
const ZERO_BOND_ADD_ZERO = "sandbox.sputnik-v2.zero-bond-dryrun-add_proposal-zero.json";
const SPUTNIK_CAPTURES = [DAO_VOTE_ZERO, DAO_ADD_ZERO, DAO_ADD_DEPOSIT, ZERO_BOND_VOTE_ZERO, ZERO_BOND_ADD_ZERO];

/** act_proposal (VoteApprove), 0 deposit, landed: SuccessValue "" (spike capture). */
const ACT_PROPOSAL_LANDED = readFixture(SANDBOX_FIXTURES, "027-e-fc-vote-approve-0.send_tx.json");
/** add_proposal with 0 deposit, landed and panicked: ERR_MIN_BOND (negative control, key allowed it). */
const ADD_PROPOSAL_ZERO_DEPOSIT = readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json");
/** add_proposal with the 0.1 NEAR bond attached (full-access key), landed. */
const ADD_PROPOSAL_WITH_BOND = readFixture(SANDBOX_FIXTURES, "019-c-add-proposal-0.send_tx.json");
/** A protocol refusal: nothing ran, so it says nothing about the method. */
const REFUSED = readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json");

describe("classifier labels (recorded dry-runs)", () => {
  it("DAO: act_proposal is callable", ({ task }) => {
    expect(labelMethod(read(DAO_VOTE_ZERO), null, true)).toBe("callable");
    replayLine(task, SUITE, "DAO: act_proposal is callable", [DAO_VOTE_ZERO]);
  });

  it("DAO: add_proposal is not in allowlist (the dry-run hit ERR_MIN_BOND)", ({ task }) => {
    const zero = read(DAO_ADD_ZERO);
    expect(zero).toContain("ERR_MIN_BOND");
    expect(labelMethod(zero, read(DAO_ADD_DEPOSIT), false)).toBe("not in allowlist");
    replayLine(task, SUITE, "DAO: add_proposal is not in allowlist (the dry-run hit ERR_MIN_BOND)", [DAO_ADD_ZERO, DAO_ADD_DEPOSIT]);
  });

  it("zero-bond DAO: add_proposal is callable with 0 deposit (protection comes from method_names alone)", ({ task }) => {
    expect(labelMethod(read(ZERO_BOND_ADD_ZERO), null, true)).toBe("callable");
    replayLine(task, SUITE, "zero-bond DAO: add_proposal is callable with 0 deposit (protection comes from method_names alone)", [ZERO_BOND_ADD_ZERO]);
  });
});

describe("the recorded Sputnik dry-runs are what their names say", () => {
  let pack: TargetPack;
  const tx = (file: string) => JSON.parse(read(file)).result.transaction;

  it("exactly the 5 captures: a method whose 0-deposit call landed has no -deposit file", () => {
    const files = readdirSync(DEMO_FIXTURES).filter((f) => f.startsWith("sandbox.sputnik-v2.") && f.includes("dryrun-"));
    expect(files.sort()).toEqual([...SPUTNIK_CAPTURES].sort());
  });

  it("each is one FunctionCall from a dry-run seat to a dry-run DAO, with the deposit its name says", async () => {
    pack = await loadTargetPack("sputnik-v2");
    const declared = pack.outOfScope.find((m) => m.method === "add_proposal")?.dryRun?.depositYocto;
    expect(declared).toBe("100000000000000000000000");
    for (const file of SPUTNIK_CAPTURES) {
      const [, method, kind] = /dryrun-([a-z_]+)-(zero|deposit)\.json$/.exec(file) ?? [];
      const t = tx(file);
      expect(t.signer_id, file).toMatch(/^seat-[0-9a-f]{4}\.sandbox$/);
      expect(t.receiver_id, file).toMatch(/^dry-[0-9a-f]{4}\.sandbox$/);
      expect(t.signer_id.slice("seat-".length), file).toBe(t.receiver_id.slice("dry-".length)); // one dry-run's accounts
      expect(t.actions, file).toHaveLength(1);
      expect(t.actions[0].FunctionCall, file).toMatchObject({ method_name: method, deposit: kind === "zero" ? "0" : declared });
    }
    // The bond and zero-bond runs dry-ran two different DAOs; within a run, every call went to the same one.
    expect(tx(DAO_ADD_ZERO).receiver_id).toBe(tx(DAO_VOTE_ZERO).receiver_id);
    expect(tx(DAO_ADD_DEPOSIT).receiver_id).toBe(tx(DAO_VOTE_ZERO).receiver_id);
    expect(tx(ZERO_BOND_ADD_ZERO).receiver_id).toBe(tx(ZERO_BOND_VOTE_ZERO).receiver_id);
    expect(tx(ZERO_BOND_VOTE_ZERO).receiver_id).not.toBe(tx(DAO_VOTE_ZERO).receiver_id);
  });

  it("the differential: with the bond attached add_proposal lands, so in an allowlist it would be fails-without-deposit (runtime)", () => {
    expect(bodyState(read(DAO_ADD_DEPOSIT))).toBe("landed-ok");
    expect(labelMethod(read(DAO_ADD_ZERO), read(DAO_ADD_DEPOSIT), true)).toBe("fails-without-deposit (runtime)");
    expect(labelMethod(read(DAO_ADD_ZERO), null, true)).toBe("inconclusive");
  });

  it("zero-bond DAO: act_proposal is still callable", () => {
    expect(labelMethod(read(ZERO_BOND_VOTE_ZERO), null, true)).toBe("callable");
  });
});

// Task 11 (2nd owner): the counter's labels, from the counter dry-run captures (same capture run, scope
// [increment, reset]; transfer_ownership is the pack's out-of-scope method, dry-run as {attacker}).
const COUNTER_INC_ZERO = "sandbox.counter.dryrun-increment-zero.json";
const COUNTER_RESET_ZERO = "sandbox.counter.dryrun-reset-zero.json";
const COUNTER_RESET_DEPOSIT = "sandbox.counter.dryrun-reset-deposit.json";
const COUNTER_TRANSFER_ZERO = "sandbox.counter.dryrun-transfer_ownership-zero.json";
const COUNTER_CAPTURES = [COUNTER_INC_ZERO, COUNTER_RESET_ZERO, COUNTER_RESET_DEPOSIT, COUNTER_TRANSFER_ZERO];

describe("classifier labels (recorded dry-runs): counter", () => {
  it("counter: increment is callable", ({ task }) => {
    expect(labelMethod(read(COUNTER_INC_ZERO), null, true)).toBe("callable");
    replayLine(task, SUITE, "counter: increment is callable", [COUNTER_INC_ZERO]);
  });

  it("counter: reset fails-without-deposit (runtime)", ({ task }) => {
    const zero = read(COUNTER_RESET_ZERO);
    expect(zero).toContain("Requires attached deposit of exactly 1 yoctoNEAR");
    expect(labelMethod(zero, read(COUNTER_RESET_DEPOSIT), true)).toBe("fails-without-deposit (runtime)");
    replayLine(task, SUITE, "counter: reset fails-without-deposit (runtime)", [COUNTER_RESET_ZERO, COUNTER_RESET_DEPOSIT]);
  });

  it("counter: transfer_ownership is not in allowlist", ({ task }) => {
    const zero = read(COUNTER_TRANSFER_ZERO);
    expect(zero).toContain("only the owner");
    expect(labelMethod(zero, null, false)).toBe("not in allowlist");
    replayLine(task, SUITE, "counter: transfer_ownership is not in allowlist", [COUNTER_TRANSFER_ZERO]);
  });
});

describe("the recorded counter dry-runs are what their names say", () => {
  const tx = (file: string) => JSON.parse(read(file)).result.transaction;
  const argsOf = (file: string) => JSON.parse(Buffer.from(tx(file).actions[0].FunctionCall.args, "base64").toString("utf8"));

  it("exactly the 4 captures: increment landed with 0 deposit, so it has no -deposit file", () => {
    const files = readdirSync(DEMO_FIXTURES).filter((f) => f.startsWith("sandbox.counter.") && f.includes("dryrun-"));
    expect(files.sort()).toEqual([...COUNTER_CAPTURES].sort());
  });

  it("each is one FunctionCall from one dry-run seat to one dry-run counter, with the deposit its name says", async () => {
    const pack = await loadTargetPack("counter");
    expect(pack.tools.find((t) => t.method === "reset")?.dryRun?.depositYocto).toBe("1");
    const receiver = tx(COUNTER_INC_ZERO).receiver_id;
    for (const file of COUNTER_CAPTURES) {
      const [, method, kind] = /dryrun-([a-z_]+)-(zero|deposit)\.json$/.exec(file) ?? [];
      const t = tx(file);
      expect(t.signer_id, file).toMatch(/^seat-[0-9a-f]{4}\.sandbox$/);
      expect(t.receiver_id, file).toBe(receiver);
      expect(t.signer_id.slice("seat-".length), file).toBe(t.receiver_id.slice("dry-".length));
      expect(t.actions, file).toHaveLength(1);
      expect(t.actions[0].FunctionCall, file).toMatchObject({ method_name: method, deposit: kind === "zero" ? "0" : "1" });
    }
    // The out-of-scope dry-run names an attacker account in the same run ({attacker}, never created).
    expect(argsOf(COUNTER_TRANSFER_ZERO)).toEqual({ new_owner: `attacker-${receiver.slice("dry-".length)}` });
    expect(bodyState(read(COUNTER_RESET_DEPOSIT))).toBe("landed-ok");
  });
});

describe("labelMethod rules", () => {
  it("fails-without-deposit (runtime): the 0-deposit call panics, the call with the deposit lands", () => {
    expect(labelMethod(ADD_PROPOSAL_ZERO_DEPOSIT, ADD_PROPOSAL_WITH_BOND, true)).toBe("fails-without-deposit (runtime)");
  });

  it("inconclusive: a panic with no deposit declared", () => {
    expect(labelMethod(ADD_PROPOSAL_ZERO_DEPOSIT, null, true)).toBe("inconclusive");
  });

  it("inconclusive: a panic both ways", () => {
    expect(labelMethod(ADD_PROPOSAL_ZERO_DEPOSIT, ADD_PROPOSAL_ZERO_DEPOSIT, true)).toBe("inconclusive");
  });

  it("inconclusive: a protocol refusal or an unreadable body", () => {
    expect(labelMethod(REFUSED, ADD_PROPOSAL_WITH_BOND, true)).toBe("inconclusive");
    expect(labelMethod("not json", null, true)).toBe("inconclusive");
  });

  it("not in allowlist wins whatever the dry-run says", () => {
    expect(labelMethod(ACT_PROPOSAL_LANDED, null, false)).toBe("not in allowlist");
  });
});
