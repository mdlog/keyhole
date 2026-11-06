/**
 * Task 12 live suite (`npm run test:sandbox`): runDemo({ network: "sandbox" }), the hero (phases 1–6), against a
 * real near-sandbox (nearcore 2.14.0) and the vendored sputnikdao2 v2.0.0. Local only: the driver's keys are the
 * sandbox root's or generated in memory, none is printed, and nothing is written to the keychain or $KEYHOLE_HOME
 * (sandbox wraps and burns do not persist).
 *
 * 1. All 20 steps PASS (the hero's 14, then Task 13's six smoke steps): the four refusals parse to the four expected
 *    names, the chain check reads the same nonce and allowance before [07] and after [10], the burn is one DeleteKey
 *    and the attempt after it is AccessKeyNotFound; exit 0. The run then goes through writeRunArtifacts (every written file passes the secret
 *    scan), the step printer and the transcript.
 *    [01] is T15's verifyDao on this node (the DAO built from councilInitArgs verifies), plus the pack's bond.
 * 2. KEYHOLE_DEMO_PRESEED=2 (test only): two proposals first, so [02] returns ids 2 and 3, every vote targets them,
 *    and refuse-deposit and after-burn name #3 (this run's #B), not the pack's literal #1.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanText } from "../scripts/scan-secrets.js";
import { rpcUrlFor, sessionsDir } from "../src/core/config.js";
import { credentialsDir } from "../src/core/credentials.js";
import type { DemoRun, DemoStep, Refusal } from "../src/core/types.js";
import { writeRunArtifacts } from "../src/demo/artifacts.js";
import { PRESEED_ENV, payoutExecuted, proposalsLabel, runDemo } from "../src/demo/driver.js";
import { createStepPrinter } from "../src/render/demo-log.js";
import { NOTE_IN_SCOPE, PASS_IN_SCOPE } from "../src/render/strings.js";
import { renderTranscript } from "../src/render/transcript.js";
import { plain100 } from "../test/helpers.js";
import { repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

const nodesBefore = repoSandboxProcesses();
const homeBefore = sandboxHomeEntries();
const testnetUrlBefore = rpcUrlFor("testnet");
const tmpRoot = mkdtempSync(join(tmpdir(), "keyhole-demo-hero-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Nothing of either run is left up, and the per-run sandbox dirs are gone.
  expect(repoSandboxProcesses()).toEqual(nodesBefore);
  expect(sandboxHomeEntries()).toEqual(homeBefore);
});

describe("runDemo on near-sandbox: the hero, phases 1–6", () => {
  it("runs the 20 steps (the hero's 14, then the 6 smoke steps), every one PASS, and exits 0", async () => {
    const t0 = performance.now();
    const steps: DemoStep[] = [];
    const gen = runDemo({ network: "sandbox" });
    let r: IteratorResult<DemoStep, DemoRun>;
    while (!(r = await gen.next()).done) steps.push(r.value);
    const run = r.value;
    const wallMs = Math.round(performance.now() - t0);
    console.log(`demo-hero: ${steps.length} steps in ${(wallMs / 1000).toFixed(1)} s (durationMs ${run.durationMs})`);

    // The brief's assertions.
    expect(steps.filter((s) => !s.pass).map((s) => `[${s.n}] ${s.label}: ${s.note}`)).toEqual([]);
    expect(steps.slice(0, 14).every((s) => s.pass)).toBe(true);
    expect(steps.slice(6, 10).map((s) => (s.attempt!.outcome as Refusal).errorName)).toEqual(["MethodNameMismatch", "RequiresFullAccess", "ReceiverMismatch", "DepositWithFunctionCall"]);
    expect(steps[13].attempt!.outcome).toMatchObject({ kind: "Refusal", errorName: "AccessKeyNotFound" });
    expect(steps[10].chainCheck!.before.nonce).toBe(steps[10].chainCheck!.after.nonce);
    expect(r.value.exitCode).toBe(0);

    // The run's shape: the 14 hero steps, then Task 13's six smoke steps (pinned in demo-smoke.sandbox.test.ts), 20 of
    // 20 on sandbox; the returned run holds the yielded steps.
    expect(steps.map((s) => [s.n, s.total])).toEqual(Array.from({ length: 20 }, (_, i) => [i + 1, 20]));
    expect(steps.map((s) => s.phase)).toEqual(["setup", "setup", "wrap", "in-scope", "in-scope", "in-scope", "refusals", "refusals", "refusals", "refusals", "chain-check", "inspect", "burn", "burn", ...Array(6).fill("smoke")]);
    expect(run).toMatchObject({ network: "sandbox", mode: "live", transcriptPath: "" });
    expect(run.steps).toEqual(steps);
    expect(run.durationMs).toBeGreaterThan(0);

    // Setup: [01] the deploy tx, verified by T15's verifyDao reading network "sandbox" (this node); the testnet
    // endpoint is never touched. [02] ids 0 and 1 from add_proposal, two tx hashes.
    expect(steps[0].txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(steps[0].note).toMatch(/^code_hash [1-9A-HJ-NP-Za-km-z]{43,44} = pack pin$/);
    expect(rpcUrlFor("testnet")).toBe(testnetUrlBefore);
    expect(steps[1].label).toBe(proposalsLabel(0, 1));
    expect(steps[1].moreTxHashes).toHaveLength(1);

    // Wrap: on the seat, scoped to act_proposal on the DAO, the compact preview card.
    const session = steps[2].card!.session;
    expect(session).toMatchObject({ mode: "on-account", network: "sandbox", accountId: "seat.sandbox", receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowanceYocto: "50000000000000000000000" });
    expect(steps[2].card!.source).toBe("preview");
    expect(steps[2].label).toBe("seat.sandbox signs one AddKey: act_proposal only · gas allowance 0.0500 NEAR");

    // In scope: two session votes land (1 of 2), the cosigner's makes #0 Approved and pays the grantee 0.01 NEAR.
    expect(steps[3]).toMatchObject({ attempt: { outcome: { kind: "TxSuccess" }, args: { id: 0, action: "VoteApprove" } }, proposal: { id: 0, status: "InProgress", approvals: 1, required: 2 } });
    expect(steps[4]).toMatchObject({ signer: "cosigner", proposal: { id: 0, status: "Approved", approvals: 2, required: 2 }, note: payoutExecuted("grantee.sandbox", 10n ** 22n) });
    expect(steps[5]).toMatchObject({ attempt: { outcome: { kind: "TxSuccess" }, args: { id: 1 } }, proposal: { id: 1, status: "InProgress", approvals: 1, required: 2 }, note: NOTE_IN_SCOPE });

    // Refusals: never in a block, so no tx hash; the attacker and other-dao ids are the spike's.
    expect(steps.slice(6, 10).map((s) => s.attempt!.receiverId)).toEqual(["dao.sandbox", "attacker.sandbox", "other-dao.sandbox", "dao.sandbox"]);
    expect(steps.slice(6, 10).every((s) => s.txHash === undefined && (s.attempt!.outcome as Refusal).reachedBlock === false)).toBe(true);
    expect(steps[10].chainCheck!.after).toEqual(steps[10].chainCheck!.before);
    // refuse-deposit and after-burn name #B (1 here); the other DAO's attempt keeps the pack's literal 0.
    expect([8, 9, 13].map((i) => steps[i].attempt!.args)).toEqual([{ id: 0, action: "VoteApprove" }, { id: 1, action: "VoteApprove" }, { id: 1, action: "VoteReject" }]);

    // Inspect: the chain card, the allowance lower by the two votes; burn: one DeleteKey.
    expect(steps[11].card).toMatchObject({ source: "chain", codeHashNow: session.codeHashPin });
    expect(BigInt(steps[11].card!.key!.allowanceRemainingYocto!)).toBeLessThan(BigInt(session.allowanceYocto));
    expect(steps[12].txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(steps[12].label).toBe(`seat.sandbox signs DeleteKey of ${session.id}'s key`);

    // Sandbox wraps and burns persist nothing: no session file, no key file.
    expect(existsSync(sessionsDir())).toBe(false);
    expect(existsSync(join(credentialsDir(), "sandbox"))).toBe(false);

    // Artifacts: the seven refusal bodies (five hero, two smoke) byte for byte, then run.json; every written file
    // passes the secret scan.
    const dir = join(tmpRoot, "hero");
    const paths = await writeRunArtifacts(run, { fixturesDir: join(dir, "fixtures"), runJsonPath: join(dir, "run.sandbox.json") });
    expect(paths.map((p) => basename(p))).toEqual([
      ...["refuse-method", "refuse-action", "refuse-receiver", "refuse-deposit", "after-burn"].map((t) => `sandbox.sputnik-v2.${t}.json`),
      ...["refuse-allowance", "after-burn"].map((t) => `sandbox.counter.${t}.json`),
      "run.sandbox.json",
    ]);
    for (const s of steps.filter((x) => x.fixture)) expect(readFileSync(join(dir, "fixtures", s.fixture!), "utf8")).toBe(s.attempt!.outcome.rawRpcJson);
    for (const p of paths) expect(scanText(basename(p), readFileSync(p, "utf8")).hits).toEqual([]);

    // The printer and the transcript take the run as it is: 5 protocol refusals in the hero and 2 in the smoke phase,
    // one PASS line each; in scope, the hero's two votes and the smoke phase's increment.
    const printer = createStepPrinter({ caps: plain100, style: "full", network: "sandbox", mode: "live" });
    const out = [...steps.map((s) => printer.step(s)), printer.result(run)].join("\n");
    expect(out.split("\n").filter((l) => l.includes("PASS: refused by protocol")).length).toBe(7);
    expect(out.split("\n").filter((l) => l.includes(PASS_IN_SCOPE)).length).toBe(3);
    expect(out).toMatch(/^RESULT 20\/20 PASS · 7 protocol refusals · \d+ tx hashes · .* · exit 0$/m);
    const md = renderTranscript(run, { rpc: "http://127.0.0.1", operator: "sandbox", startedAt: new Date().toISOString() });
    for (const s of steps.filter((x) => x.fixture)) expect(md).toContain(s.attempt!.outcome.rawRpcJson);
  });

  it("pre-seeded proposals shift the ids, every vote targets them, and the DAO attempts name #B", async () => {
    const steps: DemoStep[] = [];
    const gen = runDemo({ network: "sandbox", env: { ...process.env, [PRESEED_ENV]: "2" } });
    let r: IteratorResult<DemoStep, DemoRun>;
    while (!(r = await gen.next()).done) steps.push(r.value);
    expect(steps.filter((s) => !s.pass).map((s) => `[${s.n}] ${s.label}: ${s.note}`)).toEqual([]);
    expect(r.value.exitCode).toBe(0);
    expect(steps[1].label).toBe(proposalsLabel(2, 3));
    expect(steps[3]).toMatchObject({ attempt: { args: { id: 2 } }, proposal: { id: 2, status: "InProgress", approvals: 1 } });
    expect(steps[4].proposal).toMatchObject({ id: 2, status: "Approved", approvals: 2 });
    expect(steps[5]).toMatchObject({ attempt: { args: { id: 3 } }, proposal: { id: 3, status: "InProgress", approvals: 1 } });
    // #3 is this run's #B: refuse-deposit and after-burn name it, refused as before (the literal #1 is a pre-seed).
    expect([steps[9], steps[13]].map((s) => [s.attempt!.args.id, (s.attempt!.outcome as Refusal).errorName])).toEqual([
      [3, "DepositWithFunctionCall"],
      [3, "AccessKeyNotFound"],
    ]);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
  });
});
