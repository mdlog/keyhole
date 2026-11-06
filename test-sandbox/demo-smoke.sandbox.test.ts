/**
 * Task 13 live suite (`npm run test:sandbox`): runDemo({ network: "sandbox" }) end to end against a real near-sandbox
 * (nearcore 2.14.0): the hero [01]–[14], then phase 7, SMOKE [15]–[20], the counter contract (contracts/counter, the
 * pinned wasm) in sub-account mode with the sandbox root as the operator. Local only: every key is the sandbox root's
 * or minted in memory, none is printed, and nothing is written to the keychain or $KEYHOLE_HOME.
 *
 *   [15] the root deploys counter.sandbox (new {owner: cosigner}) and wraps it in a session sub-account: increment and
 *        reset, 0.05 NEAR. The dry-run labels reset fails-without-deposit (runtime): the step's note carries the WARN.
 *   [16] the session calls increment: it lands, get_value goes up by one.
 *   [17] the session calls reset with no deposit: a ContractPanic in a block ("Requires attached deposit of exactly
 *        1 yoctoNEAR"), the contract refusing, not the protocol.
 *   [18] the operator key adds a second function-call key with 0.01 NEAR (< the 0.030919 a 30 TGas call needs), then
 *        increment with it: NotEnoughAllowance, parsed from the RPC body, never in a block.
 *   [19] the burn: DeleteKey + DeleteAccount (beneficiary the operator) in one tx; the account, and both keys with it,
 *        are gone.
 *   [20] increment after the burn: SignerDoesNotExist, a burn proof in phase `smoke` (C-T8d).
 *
 * All 20 PASS and exit 0; the refusals parse to the six InvalidAccessKeyError names (six of eight); wall time < 300 s.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanText } from "../scripts/scan-secrets.js";
import { sessionsDir } from "../src/core/config.js";
import { credentialsDir } from "../src/core/credentials.js";
import { INVALID_ACCESS_KEY_ERRORS } from "../src/core/types.js";
import type { ContractPanic, DemoRun, DemoStep, Refusal } from "../src/core/types.js";
import { writeRunArtifacts } from "../src/demo/artifacts.js";
import { runDemo } from "../src/demo/driver.js";
import { createStepPrinter } from "../src/render/demo-log.js";
import { counter } from "../src/render/refusal-block.js";
import { BEATS, NOTE_SIGNER_GONE, PASS_IN_SCOPE, PASS_RUNTIME, SIX_OF_EIGHT } from "../src/render/strings.js";
import { displayWidth } from "../src/render/style.js";
import { renderTranscript } from "../src/render/transcript.js";
import { plain100 } from "../test/helpers.js";
import { repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

const nodesBefore = repoSandboxProcesses();
const homeBefore = sandboxHomeEntries();
const tmpRoot = mkdtempSync(join(tmpdir(), "keyhole-demo-smoke-"));

/** The runtime's panic text for reset with no deposit (contracts/counter); [17] passes on it, never on "any panic". */
const RESET_PANIC = "Requires attached deposit of exactly 1 yoctoNEAR";
const B58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** 0.01 NEAR: the second key's allowance in [18]; 30 TGas costs 0.030919 NEAR up front. */
const TINY_ALLOWANCE = (10n ** 22n).toString();

const count = (text: string, needle: string): number => text.split(needle).length - 1;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Nothing of the run is left up, and its sandbox dir is gone.
  expect(repoSandboxProcesses()).toEqual(nodesBefore);
  expect(sandboxHomeEntries()).toEqual(homeBefore);
});

describe("runDemo on near-sandbox: the hero, then phase 7 (SMOKE, the counter in sub-account mode)", () => {
  it("runs 20 steps, every one PASS: [17] a runtime panic, [18] NotEnoughAllowance, [20] SignerDoesNotExist; six of eight; < 300 s", async () => {
    const t0 = performance.now();
    const steps: DemoStep[] = [];
    const gen = runDemo({ network: "sandbox" });
    let r: IteratorResult<DemoStep, DemoRun>;
    while (!(r = await gen.next()).done) steps.push(r.value);
    const run = r.value;
    const wallMs = Math.round(performance.now() - t0);
    console.log(`demo-smoke: ${steps.length} steps in ${(wallMs / 1000).toFixed(1)} s (durationMs ${run.durationMs})`);

    // The brief's assertions: all 20 PASS; the names of [18] and [20]; the six-of-eight set is complete; < 300 s.
    expect(steps.filter((s) => !s.pass).map((s) => `[${s.n}] ${s.label}: ${s.note}`)).toEqual([]);
    expect(steps).toHaveLength(20);
    const names = new Set(steps.flatMap((s) => (s.attempt?.outcome.kind === "Refusal" ? [s.attempt.outcome.errorName] : [])));
    for (const n of INVALID_ACCESS_KEY_ERRORS) expect(names.has(n), n).toBe(true);
    expect(steps[16].attempt!.outcome).toMatchObject({ kind: "ContractPanic" });
    expect(steps[17].attempt!.outcome).toMatchObject({ kind: "Refusal", errorName: "NotEnoughAllowance" });
    expect(steps[19].attempt!.outcome).toMatchObject({ kind: "Refusal", errorName: "SignerDoesNotExist" });
    expect(wallMs).toBeLessThan(300_000);
    expect(run.exitCode).toBe(0);

    // The run's shape: 20 of 20 on sandbox, the six smoke steps after the hero's 14.
    expect(steps.map((s) => [s.n, s.total])).toEqual(Array.from({ length: 20 }, (_, i) => [i + 1, 20]));
    expect(steps.map((s) => s.phase).slice(12)).toEqual(["burn", "burn", "smoke", "smoke", "smoke", "smoke", "smoke", "smoke"]);
    expect(run).toMatchObject({ network: "sandbox", mode: "live", transcriptPath: "" });
    expect(run.steps).toEqual(steps);

    // [15] the deploy, then one wrap tx signed by the operator (the root): a session sub-account under it, scoped to
    // the counter's increment and reset, 0.05 NEAR, pinned to the pack's code hash. The WARN comes from the dry-run.
    const s15 = steps[14];
    const session = s15.card!.session;
    expect(session).toMatchObject({ mode: "subaccount", network: "sandbox", receiverId: "counter.sandbox", methodNames: ["increment", "reset"], allowanceYocto: "50000000000000000000000", packId: "counter", codeHashPin: "DdBoUCcNATd6UCjyzwGNyQ856j55L3Df876gRmZNsVtA" });
    expect(session.accountId).toBe(`${session.id}.sandbox`);
    expect(s15).toMatchObject({ signer: "operator", card: { source: "preview" } });
    expect([s15.txHash, ...(s15.moreTxHashes ?? [])]).toEqual([expect.stringMatching(B58_HASH), expect.stringMatching(B58_HASH)]);
    expect(s15.note).toMatch(/^WARN  reset — fails-without-deposit \(runtime\)/);
    expect(Object.fromEntries(session.tools.filter((t) => t.kind === "call").map((t) => [t.method, t.classification]))).toEqual({ increment: "callable", reset: "fails-without-deposit (runtime)", transfer_ownership: "not in allowlist" });

    // [16] increment lands; get_value read before and after.
    expect(steps[15]).toMatchObject({ signer: "session", attempt: { sessionId: session.id, receiverId: "counter.sandbox", method: "increment", depositYocto: "0", violates: "none", outcome: { kind: "TxSuccess" } } });
    expect(steps[15].txHash).toMatch(B58_HASH);
    expect(steps[15].note).toMatch(/get_value 0 -> 1/);

    // [17] reset with no deposit lands and panics: gas charged, a tx hash, the runtime's own text.
    const panic = steps[16].attempt!.outcome as ContractPanic;
    console.log(`demo-smoke [17] panic message: ${panic.message}`);
    expect(panic.message).toContain(RESET_PANIC);
    expect(steps[16]).toMatchObject({ signer: "session", attempt: { method: "reset", depositYocto: "0", receiverId: "counter.sandbox" }, txHash: panic.txHash });
    expect(steps[16].txHash).toMatch(B58_HASH);

    // [18] the second key: added by the operator key (AddKey tx in moreTxHashes), 0.01 NEAR; refused at validation.
    const tiny = steps[17].attempt!.outcome as Refusal;
    expect(steps[17]).toMatchObject({
      signer: "session",
      fixture: "sandbox.counter.refuse-allowance.json",
      attempt: { receiverId: "counter.sandbox", action: "FunctionCall", method: "increment", depositYocto: "0", gasTGas: 30, violates: "allowance" },
    });
    expect(tiny).toMatchObject({ family: "InvalidTxError::InvalidAccessKeyError", reachedBlock: false, detail: { NotEnoughAllowance: { account_id: session.accountId, allowance: TINY_ALLOWANCE } } });
    const detail = (tiny.detail as { NotEnoughAllowance: { cost: string; public_key: string; allowance: string } }).NotEnoughAllowance;
    expect(BigInt(detail.cost)).toBeGreaterThan(BigInt(detail.allowance));
    expect(detail.public_key).not.toBe(session.publicKey);
    expect(steps[17].txHash).toBeUndefined();
    expect(steps[17].moreTxHashes).toEqual([expect.stringMatching(B58_HASH)]);
    expect(steps[17].note).toContain(steps[17].moreTxHashes![0]);

    // [19] one tx: DeleteKey + DeleteAccount, signed as the sub-account with the operator's key.
    expect(steps[18]).toMatchObject({ signer: "operator" });
    expect(steps[18].txHash).toMatch(B58_HASH);
    expect(steps[18].label).toContain(session.accountId);

    // [20] after the burn: the account itself is gone.
    expect(steps[19]).toMatchObject({
      signer: "session",
      fixture: "sandbox.counter.after-burn.json",
      attempt: { sessionId: session.id, receiverId: "counter.sandbox", method: "increment", violates: "none", outcome: { family: "InvalidTxError", reachedBlock: false } },
    });

    // Every printed row (counter + label, and a passing step's note under the 8-column indent) fits 100 columns.
    for (const s of steps) {
      expect(displayWidth(`${counter(s)} ${s.label}`), s.label).toBeLessThanOrEqual(100);
      if (s.note) expect(displayWidth(`        ${s.note}`), s.note).toBeLessThanOrEqual(100);
    }

    // The printer takes the run as it is: 7 protocol refusals, one PASS line each; one PASS_RUNTIME; one
    // NOTE_SIGNER_GONE; three in-scope landings; the smoke beat once; the six-of-eight line; RESULT 20/20.
    for (const style of ["full", "beat"] as const) {
      const printer = createStepPrinter({ caps: plain100, style, network: "sandbox", mode: "live" });
      const out = [...steps.map((s) => printer.step(s)), printer.result(run)].join("\n");
      expect(out.split("\n").filter((l) => l.includes("PASS: refused by protocol")).length, style).toBe(7);
      expect(count(out, PASS_RUNTIME), style).toBe(1);
      expect(count(out, NOTE_SIGNER_GONE), style).toBe(1);
      expect(count(out, PASS_IN_SCOPE), style).toBe(3);
      expect(count(out, BEATS.smoke), style).toBe(1);
      expect(out, style).toContain(`\n${SIX_OF_EIGHT}`);
      expect(out, style).toMatch(/^RESULT 20\/20 PASS · 7 protocol refusals · \d+ tx hashes · .* · exit 0$/m);
    }

    // Artifacts: the seven refusal bodies byte for byte, then run.json; every written file passes the secret scan.
    const dir = join(tmpRoot, "smoke");
    const paths = await writeRunArtifacts(run, { fixturesDir: join(dir, "fixtures"), runJsonPath: join(dir, "run.sandbox.json") });
    expect(paths.map((p) => basename(p))).toEqual([
      ...["refuse-method", "refuse-action", "refuse-receiver", "refuse-deposit", "after-burn"].map((t) => `sandbox.sputnik-v2.${t}.json`),
      "sandbox.counter.refuse-allowance.json",
      "sandbox.counter.after-burn.json",
      "run.sandbox.json",
    ]);
    for (const s of steps.filter((x) => x.fixture)) expect(readFileSync(join(dir, "fixtures", s.fixture!), "utf8")).toBe(s.attempt!.outcome.rawRpcJson);
    for (const p of paths) expect(scanText(basename(p), readFileSync(p, "utf8")).hits).toEqual([]);
    const md = renderTranscript(run, { rpc: "http://127.0.0.1", operator: "sandbox", startedAt: new Date().toISOString() });
    for (const s of steps.filter((x) => x.fixture)) expect(md).toContain(s.attempt!.outcome.rawRpcJson);
    expect(count(md, NOTE_SIGNER_GONE)).toBe(1);
    expect(md).toContain(SIX_OF_EIGHT);

    // Sandbox wraps and burns persist nothing: no session file, no key file.
    expect(existsSync(sessionsDir())).toBe(false);
    expect(existsSync(join(credentialsDir(), "sandbox"))).toBe(false);
  }, 300_000);
});
