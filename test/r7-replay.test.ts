/**
 * R7, the offline REPLAY (Task 14; LAYOUT R7). `npm test` re-derives every recorded protocol refusal from its
 * captured RPC JSON and puts one line per proof on the REPLAY banner (test/reporters/replay-reporter.ts).
 *
 * Everything here derives from the committed fixture bytes: the expected error names come from the target
 * packs (the only place they live), the parsed names from parseRefusal over the files read straight off disk,
 * and the counts are measured. Nothing is typed in from a screenshot, so a re-capture changes no test.
 *
 * The three inputs of loadDemoRunFixture are covered here: (a) the spike capture directory (C-T8a), (b) the
 * manifest, (c) a run.NETWORK.json DemoRun file. Offline: test/setup.ts replaces fetch, and nothing here reads
 * a key.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InputError } from "../src/core/errors.js";
import { parseRefusal } from "../src/core/refusal.js";
import { INVALID_ACCESS_KEY_ERRORS } from "../src/core/types.js";
import type { DemoRun, DemoStep, NegativeTest } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { loadTargetPack } from "../src/packs/index.js";
import { createStepPrinter } from "../src/render/demo-log.js";
import { renderRefusalBlock } from "../src/render/refusal-block.js";
import { NOTE_SIGNER_GONE, PASS_KEY_GONE, PASS_RUNTIME, SIX_OF_EIGHT, displayInvariant, passRefused } from "../src/render/strings.js";
import { neutralizeControls } from "../src/render/style.js";
import { renderTranscript } from "../src/render/transcript.js";
import { REPO, SANDBOX_FIXTURES, plain100 } from "./helpers.js";
import { replayLine } from "./replay-meta.js";

// KH_R7_FIXTURES points this file at another fixtures directory: only the child run of C-T14d (N1) below sets it.
const FIXTURES = process.env.KH_R7_FIXTURES ?? join(REPO, "demo", "fixtures");
const MANIFEST = join(FIXTURES, "manifest.json");
const RUN_SANDBOX = join(REPO, "demo", "run.sandbox.json");

interface Entry {
  network: string;
  pack: string;
  test: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { refusals: Entry[] };
const run = await loadDemoRunFixture(MANIFEST);
const packs = new Map(await Promise.all([...new Set(manifest.refusals.map((e) => e.pack))].map(async (id) => [id, await loadTargetPack(id)] as const)));
/** The pack's negative test for a manifest entry: the only place its expected error name lives. */
const testOf = (e: Entry): NegativeTest => {
  const t = packs.get(e.pack)?.negativeTests.find((x) => x.id === e.test);
  if (!t) throw new Error(`manifest entry ${e.pack}.${e.test} has no negative test in its pack`);
  return t;
};
const fileOf = (e: Entry): string => `${e.network}.${e.pack}.${e.test}.json`;
const onDisk = (e: Entry): string => readFileSync(join(FIXTURES, fileOf(e)), "utf8");

/** The rows behind the gutter of the full block, joined: what is on screen of the RPC body. */
const gutterBytes = (s: DemoStep): string =>
  renderRefusalBlock(s, plain100, "full")
    .split("\n")
    .filter((l) => l.startsWith("        | "))
    .map((l) => l.slice(10))
    .join("");

/**
 * A step as an assertion should show it. A failed step's note can quote a name parsed from a body (a decoded
 * \u001b is a real ESC), and a failed assertion prints it: so the note is neutralized before it is compared.
 */
const shown = (s: DemoStep): DemoStep => ({ ...s, note: s.note === undefined ? undefined : neutralizeControls(s.note) });

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "keyhole-r7-"));
  tmpRoots.push(root);
  return root;
};

/** Print a replayed run step by step, as the CLI would: one chunk per step. */
function printRun(of: DemoRun, runId?: string): string {
  const printer = createStepPrinter({ caps: plain100, style: "full", network: of.network, mode: "replay", ...(runId === undefined ? {} : { runId }) });
  return of.steps.map((s) => printer.step(s)).join("\n");
}
const count = (text: string, needle: string): number => text.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------------
// The R7 suites printed by the reporter

describe("protocol refusals", () => {
  it("the manifest lists the 7 refusals, and the loader returned one step for each", () => {
    expect(manifest.refusals).toHaveLength(7);
    expect(run.steps).toHaveLength(manifest.refusals.length);
    expect(run.mode).toBe("replay");
    expect(run.exitCode).toBe(0);
  });

  run.steps.forEach((s, i) => {
    const e = manifest.refusals[i];
    // A step that did not pass (a missing fixture) is named by its FAIL note, so the reporter's FAIL line says why.
    // The note can carry a name parsed from a body (a decoded \u001b is a real ESC), and a title and an assertion
    // message go to the terminal through vitest's own reporter: both are neutralized here (C-T6d).
    it(neutralizeControls(s.pass ? s.fixture! : (s.note ?? `step ${s.n}`)), ({ task }) => {
      expect(s.pass, neutralizeControls(s.note ?? "")).toBe(true);
      expect(s.fixture).toBe(fileOf(e));
      const bytes = onDisk(e);
      // The committed bytes, parsed here on their own: the loader's outcome must be the same parse.
      const r = parseRefusal(bytes);
      expect(r, fileOf(e)).not.toBeNull();
      expect(neutralizeControls(r!.errorName)).toBe(testOf(e).expected);
      expect(s.attempt!.outcome).toEqual(r);

      // Display invariant: the raw block on screen is the fixture, byte for byte, and PASS is printed once.
      const block = renderRefusalBlock(s, plain100, "full");
      expect(gutterBytes(s)).toBe(bytes);
      expect(block.split("\n").filter((l) => l.includes("PASS: refused by protocol"))).toEqual([`        ${passRefused(r!.errorName)}`]);
      // The path the rpc line prints names a file that exists (C-T8a).
      const printed = /· (demo\/fixtures\/\S+)$/m.exec(block)?.[1]; // on the rpc row, or on the row after it where the row is too wide (C-T14b)
      expect(printed, "the rpc line names its fixture").toBeDefined();
      expect(existsSync(join(REPO, printed!))).toBe(true);

      replayLine(task, "protocol refusals", `REPLAY [${e.network}] ${e.pack}.${e.test}`.padEnd(48) + passRefused(r!.errorName), [fileOf(e)]);
    });
  });

  it("six of eight", ({ task }) => {
    // Parsed from the committed bytes, never from the file name: the six plain-key variants must all appear.
    const parsed = manifest.refusals.map((e) => parseRefusal(onDisk(e)));
    const names = new Set(parsed.filter((r) => r?.family === "InvalidTxError::InvalidAccessKeyError").map((r) => r!.errorName));
    expect(INVALID_ACCESS_KEY_ERRORS).toHaveLength(6);
    for (const name of INVALID_ACCESS_KEY_ERRORS) expect(names.has(name), name).toBe(true);
    replayLine(task, "protocol refusals", SIX_OF_EIGHT, manifest.refusals.map(fileOf));
  });

  it("display invariant", ({ task }) => {
    const ok = run.steps.filter((s, i) => gutterBytes(s) === onDisk(manifest.refusals[i])).length;
    expect(run.steps).toHaveLength(7);
    expect(ok).toBe(run.steps.length);
    replayLine(task, "protocol refusals", displayInvariant(ok, run.steps.length), manifest.refusals.map(fileOf));
  });
});

// ---------------------------------------------------------------------------------------------------
// (b) the manifest

describe("loadDemoRunFixture: the manifest (b)", () => {
  it("takes Attempt fields from the pack's negativeTests and each outcome from the fixture body", () => {
    // C-T12e: the manifest has no live args, so this branch uses the pack's. The run-file branch (c) never does.
    run.steps.forEach((s, i) => {
      const t = testOf(manifest.refusals[i]);
      expect(s.attempt, s.fixture).toMatchObject({ action: t.action, depositYocto: t.depositYocto, gasTGas: t.gasTGas, violates: t.violates, args: t.args });
      expect(s.attempt?.method).toBe(t.method);
      expect(s.label).toBe(t.label);
      expect(s.attempt?.outcome).toEqual(parseRefusal(onDisk(manifest.refusals[i])));
    });
  });

  it("files each refusal under the phase the live run does: beat 3, the burn proof, and the counter's SMOKE", () => {
    expect(run.steps.map((s) => s.phase)).toEqual(["refusals", "refusals", "refusals", "refusals", "burn", "smoke", "smoke"]);
    expect(run.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(run.steps.every((s) => s.total === 7)).toBe(true);
  });

  it("the sub-account burn proof keeps its PASS line and its note, and no other step counts it", () => {
    const text = printRun(run);
    expect(count(text, "PASS: refused by protocol")).toBe(7);
    expect(count(text, passRefused("SignerDoesNotExist"))).toBe(1);
    expect(count(text, NOTE_SIGNER_GONE)).toBe(1);
    expect(text).not.toContain("chain rejected the tx");
  });

  /** A manifest in a throwaway demo/fixtures dir, with the named fixtures copied from the committed ones. */
  function stageManifest(entries: unknown[], copy: string[]): string {
    const dir = join(tmp(), "demo", "fixtures");
    mkdirSync(dir, { recursive: true });
    for (const f of copy) copyFileSync(join(FIXTURES, f), join(dir, f));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ refusals: entries }));
    return join(dir, "manifest.json");
  }
  const method = { network: "sandbox", pack: "sputnik-v2", test: "refuse-method" };
  const allowance = { network: "sandbox", pack: "counter", test: "refuse-allowance" };

  it("a missing fixture is a FAIL line, not a skip", async () => {
    // R12: the loader never rejects for a missing file. It pushes a FAIL step and fails the run.
    const file = stageManifest([method, allowance], [fileOf(method)]);
    const broken = await loadDemoRunFixture(file);
    expect(broken.steps).toHaveLength(2);
    expect(broken.steps[0]).toMatchObject({ pass: true });
    expect(broken.steps[1]).toMatchObject({
      pass: false,
      note: "FAIL: fixture missing demo/fixtures/sandbox.counter.refuse-allowance.json",
      fixture: "sandbox.counter.refuse-allowance.json",
      phase: "smoke",
    });
    expect(broken.steps[1].attempt).toBeUndefined();
    expect(broken.exitCode).toBe(1);
    // The step log shows it as a FAIL, never as a PASS and never as nothing.
    const text = printRun(broken);
    expect(text).toContain("FAIL: fixture missing demo/fixtures/sandbox.counter.refuse-allowance.json");
    expect(count(text, "PASS: refused by protocol")).toBe(1);
  });

  it("a body that is neither a transaction result nor a refusal is a FAIL step", async () => {
    const file = stageManifest([method], []);
    writeFileSync(join(file, "..", fileOf(method)), '{"jsonrpc":"2.0","result":{"status":"nothing"}}');
    const odd = await loadDemoRunFixture(file);
    expect(odd.steps[0]).toMatchObject({ pass: false, fixture: fileOf(method) });
    expect(neutralizeControls(odd.steps[0].note ?? "")).toMatch(/^FAIL: sandbox\.sputnik-v2\.refuse-method\.json holds neither a transaction result nor a refusal$/);
    expect(odd.exitCode).toBe(1);
  });

  it("a fixture that parses to another refusal than the pack expects fails with the pack's expectation", async () => {
    const file = stageManifest([method], []);
    copyFileSync(join(FIXTURES, fileOf({ ...method, test: "refuse-action" })), join(file, "..", fileOf(method)));
    const swapped = await loadDemoRunFixture(file);
    expect(shown(swapped.steps[0])).toMatchObject({ pass: false, note: "FAIL: expected MethodNameMismatch, parsed RequiresFullAccess from the body" });
    expect(swapped.exitCode).toBe(1);
  });

  it("a manifest naming an unknown pack or test, or a path-like id, is an input error", async () => {
    for (const bad of [{ ...method, pack: "no-such-pack" }, { ...method, test: "no-such-test" }, { ...method, test: "../x" }, { ...method, network: "mainnet" }, { network: "sandbox" }]) {
      await expect(loadDemoRunFixture(stageManifest([bad], [])), JSON.stringify(bad)).rejects.toBeInstanceOf(InputError);
    }
    await expect(loadDemoRunFixture(stageManifest([], []))).rejects.toBeInstanceOf(InputError);
  });

  it("a hostile error name in a fixture reaches the step log and the transcript only as visible text (C-T6d)", async () => {
    // The JSON key is `Req\u001b[31mFA\u0007`: parsing decodes it to a real ESC and BEL. The loader keeps the parsed
    // name as it is (the FAIL note quotes it); every printer neutralizes it, and so does this file's own output.
    const file = stageManifest([method], []);
    const hostile = readFileSync(join(FIXTURES, fileOf(method)), "utf8").replace("MethodNameMismatch", "Req\\u001b[31mFA\\u0007");
    writeFileSync(join(file, "..", fileOf(method)), hostile);
    const broken = await loadDemoRunFixture(file);
    expect(broken.steps[0].pass).toBe(false);
    expect(broken.steps[0].note).toContain("\u001b");
    const log = printRun(broken);
    expect(log).toContain("Req");
    expect(log).not.toMatch(/[\u001b\u0007]/);
    const md = renderTranscript(broken, { rpc: "recorded", operator: "recorded", startedAt: "recorded" });
    expect(md).not.toMatch(/[\u001b\u0007]/);
    expect(neutralizeControls(broken.steps[0].note ?? "")).not.toMatch(/[\u001b\u0007]/);
  });

  // C-T14d (N1): the loader, printers and transcript neutralize a hostile name (the test above), but this file's own test
  // titles and assertion messages go to the terminal through vitest's reporter. A child vitest run over a staged
  // hostile fixture is the only way to see that output; it must hold no raw ESC or BEL.
  it("a hostile error name in a fixture reaches vitest's own output (titles, assertion messages) only as visible text (C-T6d, N1)", () => {
    const dir = join(tmp(), "fixtures");
    mkdirSync(dir, { recursive: true });
    copyFileSync(MANIFEST, join(dir, "manifest.json"));
    for (const e of manifest.refusals) copyFileSync(join(FIXTURES, fileOf(e)), join(dir, fileOf(e)));
    const action = manifest.refusals.find((e) => e.test === "refuse-action")!;
    const clean = readFileSync(join(dir, fileOf(action)), "utf8");
    expect(clean).toContain("RequiresFullAccess");
    writeFileSync(join(dir, fileOf(action)), clean.replace("RequiresFullAccess", "Req\\u001b[31mFA\\u0007"));
    const env: NodeJS.ProcessEnv = { ...process.env, KH_R7_FIXTURES: dir, NO_COLOR: "1", FORCE_COLOR: "0" };
    for (const key of Object.keys(env)) if (key.startsWith("VITEST") || key === "TEST") delete env[key];
    const child = spawnSync(process.execPath, [join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", "test/r7-replay.test.ts", "-t", "protocol refusals"], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
    const output = `${child.stdout}${child.stderr}`;
    // The child ran, and the hostile step failed there: its title carries the name, as visible text.
    expect(output).toContain("expected RequiresFullAccess, parsed Req\\u001b[31mFA\\u0007");
    expect(child.status).toBe(1);
    expect(output).not.toMatch(/[\u001b\u0007]/);
  }, 90_000);

  it("C-T14d: a manifest that lists one refusal twice is an input error (one fixture is one send)", async () => {
    const file = stageManifest([method, allowance, method], [fileOf(method), fileOf(allowance)]);
    const error = (await loadDemoRunFixture(file).catch((e: unknown) => e)) as InputError;
    expect(error).toBeInstanceOf(InputError);
    expect(error.problems).toEqual([`${file}: refusals[2] repeats sandbox.sputnik-v2.refuse-method: one fixture is one send`]);
  });

  it("a manifest of two networks is one run, labelled testnet", async () => {
    const dir = join(tmp(), "demo", "fixtures");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIXTURES, fileOf(method)), join(dir, "testnet.sputnik-v2.refuse-method.json"));
    copyFileSync(join(FIXTURES, fileOf(allowance)), join(dir, fileOf(allowance)));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ refusals: [{ ...method, network: "testnet" }, allowance] }));
    const mixed = await loadDemoRunFixture(join(dir, "manifest.json"));
    expect(mixed.network).toBe("testnet");
    expect(mixed.steps.map((s) => s.fixture)).toEqual(["testnet.sputnik-v2.refuse-method.json", "sandbox.counter.refuse-allowance.json"]);
    expect(mixed.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// (c) a run.NETWORK.json DemoRun file

describe("loadDemoRunFixture: a run file (c)", () => {
  const recorded = JSON.parse(readFileSync(RUN_SANDBOX, "utf8")) as DemoRun;

  /** demo/run.sandbox.json copied into a throwaway demo/ dir, mutated, with its fixtures copied beside it (or not). */
  function stageRun(mutate: (r: any, demo: string) => void = () => undefined, copyFixtures = true): string {
    const demo = join(tmp(), "demo");
    mkdirSync(join(demo, "fixtures"), { recursive: true });
    const json = JSON.parse(readFileSync(RUN_SANDBOX, "utf8"));
    if (copyFixtures) for (const s of json.steps) if (s.fixture) copyFileSync(join(FIXTURES, s.fixture), join(demo, "fixtures", s.fixture));
    mutate(json, demo);
    const file = join(demo, "run.sandbox.json");
    writeFileSync(file, JSON.stringify(json));
    return file;
  }

  it("replays the recorded sandbox run: every step, in order, passing, exit 0, mode replay", async () => {
    const replay = await loadDemoRunFixture(RUN_SANDBOX);
    expect(replay.mode).toBe("replay");
    expect(replay.id).toBe(recorded.id);
    expect(replay.network).toBe("sandbox");
    expect(replay.steps).toHaveLength(recorded.steps.length);
    expect(replay.steps.map((s) => s.n)).toEqual(recorded.steps.map((s) => s.n));
    expect(replay.steps.filter((s) => !s.pass).map((s) => neutralizeControls(s.note ?? ""))).toEqual([]);
    expect(replay.exitCode).toBe(0);
    expect(replay.transcriptPath).toBe(recorded.transcriptPath);
  });

  it("keeps every step's captured phase (C-T8d), and re-derives each outcome from its rawRpcJson", async () => {
    const replay = await loadDemoRunFixture(RUN_SANDBOX);
    expect(replay.steps.map((s) => s.phase)).toEqual(recorded.steps.map((s) => s.phase));
    const withAttempt = recorded.steps.filter((s) => s.attempt);
    expect(withAttempt.length).toBeGreaterThanOrEqual(10);
    for (const was of withAttempt) {
      const now = replay.steps.find((s) => s.n === was.n)!;
      const o = now.attempt!.outcome;
      expect(o.kind, `step ${was.n}`).toBe(was.attempt!.outcome.kind);
      if (o.kind === "Refusal") expect(o).toEqual(parseRefusal(o.rawRpcJson));
      // What was signed comes from the run file (C-T12e), not from a pack.
      expect(now.attempt).toMatchObject({ receiverId: was.attempt!.receiverId, args: was.attempt!.args, depositYocto: was.attempt!.depositYocto, gasTGas: was.attempt!.gasTGas, violates: was.attempt!.violates });
    }
  });

  it("replays the contrast case and the sub-account burn proof, each exactly once (D1)", async () => {
    // T13's [17] (ContractPanic) and [20] (SignerDoesNotExist, phase smoke) do not set note = PASS_RUNTIME /
    // NOTE_SIGNER_GONE: the step log and the transcript print those from the outcome and the phase alone. So a replay that
    // changed either would lose a line, or print the burn proof as a chain rejection.
    const replay = await loadDemoRunFixture(RUN_SANDBOX);
    const panic = replay.steps.find((s) => s.attempt?.outcome.kind === "ContractPanic")!;
    const gone = replay.steps.find((s) => s.attempt?.outcome.kind === "Refusal" && s.attempt.outcome.errorName === "SignerDoesNotExist")!;
    expect([panic.n, gone.n]).toEqual([17, 20]);
    expect(gone.phase).toBe("smoke");
    // Their notes are the chain evidence the run recorded ([17]: get_value unchanged), carried over untouched;
    // neither repeats the line the printer derives from the outcome.
    expect([panic.note, gone.note]).toEqual([recorded.steps[16].note, recorded.steps[19].note]);
    expect(panic.note).toBeDefined();
    expect(panic.note ?? "").not.toContain(PASS_RUNTIME);
    expect(gone.note ?? "").not.toContain(NOTE_SIGNER_GONE);

    const log = printRun(replay);
    expect(count(log, PASS_RUNTIME)).toBe(1);
    expect(count(log, NOTE_SIGNER_GONE)).toBe(1);
    expect(count(log, passRefused("SignerDoesNotExist"))).toBe(1);
    expect(log).not.toContain("chain rejected the tx");
    expect(count(log, "PASS: refused by protocol")).toBe(7);

    const md = renderTranscript(replay, { rpc: "recorded", operator: "recorded", startedAt: "recorded" });
    expect(count(md, PASS_RUNTIME)).toBe(1);
    expect(count(md, NOTE_SIGNER_GONE)).toBe(1);
    expect(md).not.toContain("chain rejected the tx");
  });

  it("derives the outcome from rawRpcJson, not from what the file says about it", async () => {
    const file = stageRun((r) => {
      Object.assign(r.steps[6].attempt.outcome, { errorName: "Forged", path: ["InvalidTxError", "InvalidAccessKeyError", "Forged"] });
      Object.assign(r.steps[3].attempt.outcome, { kind: "ContractPanic", message: "forged panic" }); // [04] landed: TxSuccess
    });
    const replay = await loadDemoRunFixture(file);
    const [refusal, landed] = [replay.steps[6], replay.steps[3]];
    expect(refusal.attempt!.outcome).toMatchObject({ kind: "Refusal", errorName: "MethodNameMismatch" });
    expect(shown(refusal)).toMatchObject({ pass: false, note: 'FAIL: the run file says Forged, its rawRpcJson parses as MethodNameMismatch' });
    expect(landed.attempt!.outcome.kind).toBe("TxSuccess");
    expect(landed.pass).toBe(false);
    expect(replay.exitCode).toBe(1);
    expect(printRun(replay)).not.toContain("Forged)");
  });

  it("a body that parses to neither a result nor a refusal is a FAIL step", async () => {
    const file = stageRun((r) => {
      r.steps[3].attempt.outcome.rawRpcJson = '{"jsonrpc":"2.0","result":{}}';
    });
    const replay = await loadDemoRunFixture(file);
    expect(replay.steps[3].pass).toBe(false);
    expect(neutralizeControls(replay.steps[3].note ?? "")).toMatch(/^FAIL: step 4 holds neither a transaction result nor a refusal$/);
    expect(replay.exitCode).toBe(1);
  });

  it("a refusal slot passes only if the body parses to the name its pack test expects", async () => {
    // [08] "send NEAR" carries sandbox.sputnik-v2.refuse-action.json (RequiresFullAccess). Swap in another
    // refusal in the run file and in its fixture alike, so only the pack's expectation can catch it.
    const other = readFileSync(join(FIXTURES, "sandbox.sputnik-v2.refuse-method.json"), "utf8");
    const file = stageRun((r, demo) => {
      Object.assign(r.steps[7].attempt.outcome, { rawRpcJson: other, errorName: "MethodNameMismatch", path: ["InvalidTxError", "InvalidAccessKeyError", "MethodNameMismatch"] });
      writeFileSync(join(demo, "fixtures", r.steps[7].fixture), other);
    });
    const replay = await loadDemoRunFixture(file);
    expect(shown(replay.steps[7])).toMatchObject({ pass: false, note: "FAIL: expected RequiresFullAccess, parsed MethodNameMismatch from the body" });
    expect(replay.exitCode).toBe(1);
  });

  it("a missing fixture is a FAIL step (R12); one that differs from the run file's body is too", async () => {
    const missing = await loadDemoRunFixture(stageRun(() => undefined, false));
    const named = recorded.steps.filter((s) => s.fixture);
    expect(named).toHaveLength(7);
    for (const s of named) {
      expect(shown(missing.steps.find((m) => m.n === s.n)!)).toMatchObject({ pass: false, note: `FAIL: fixture missing demo/fixtures/${s.fixture}` });
    }
    expect(missing.exitCode).toBe(1);

    const drift = await loadDemoRunFixture(stageRun((_r, demo) => writeFileSync(join(demo, "fixtures", "sandbox.counter.refuse-allowance.json"), "{}")));
    expect(drift.steps.filter((s) => !s.pass).map((s) => [s.n, neutralizeControls(s.note ?? "")])).toEqual([[18, "FAIL: demo/fixtures/sandbox.counter.refuse-allowance.json differs from the run file's rawRpcJson"]]);
    expect(drift.exitCode).toBe(1);
  });

  it("renders a cage card read from chain as a REPLAY card that names the recorded run (C-T7b)", async () => {
    const replay = await loadDemoRunFixture(RUN_SANDBOX);
    const inspect = replay.steps.find((s) => s.phase === "inspect")!;
    // The run id is not the session id, so the footer needs its own parameter.
    expect(inspect.card!.session.id).not.toBe(replay.id);
    expect(inspect.card!.source).toBe("replay");
    expect(replay.steps.filter((s) => s.card && s.phase !== "inspect").map((s) => s.card!.source)).toEqual(["preview", "preview"]);
    const text = printRun(replay, replay.id);
    expect(text).toContain(`REPLAY of run ${replay.id} recorded `);
    expect(text).not.toContain(`REPLAY of run ${inspect.card!.session.id}`);
  });

  it("an attempt no pack test judges is checked for what it was; its recorded pass is not taken on trust", async () => {
    // [04] is an in-scope vote that landed and names no fixture. Each forgery below is coherent (the file's body
    // and its outcome agree), so only the shape of the attempt can catch it.
    const refusal = readFileSync(join(FIXTURES, "sandbox.sputnik-v2.refuse-method.json"), "utf8");
    const asRefusal = await loadDemoRunFixture(
      stageRun((r) => {
        Object.assign(r.steps[3].attempt.outcome, { kind: "Refusal", errorName: "MethodNameMismatch", family: "InvalidTxError::InvalidAccessKeyError", path: [], detail: {}, rawRpcJson: refusal, reachedBlock: false });
      }),
    );
    expect(shown(asRefusal.steps[3])).toMatchObject({ pass: false, note: "FAIL: step 4 was refused by the chain, but names no fixture to check the refusal against" });

    const brokeARule = await loadDemoRunFixture(stageRun((r) => void (r.steps[3].attempt.violates = "method")));
    expect(shown(brokeARule.steps[3])).toMatchObject({ pass: false, note: "FAIL: step 4 broke the method rule but landed (TxSuccess)" });

    const asPanic = await loadDemoRunFixture(stageRun((r) => void (r.steps[3].attempt.outcome = structuredClone(r.steps[16].attempt.outcome))));
    expect(shown(asPanic.steps[3])).toMatchObject({ pass: false, note: "FAIL: step 4 is an in-scope call but ContractPanic" });
    for (const forged of [asRefusal, brokeARule, asPanic]) expect(forged.exitCode).toBe(1);

    // The recorded run passes every one of these checks: the in-scope votes, the increment, the contrast reset.
    const real = await loadDemoRunFixture(RUN_SANDBOX);
    expect([3, 5, 15, 16].map((i) => real.steps[i].pass)).toEqual([true, true, true, true]);
  });

  // -------------------------------------------------------------------------------------------------------------
  // C-T14d (final sweep): a hand-forged run file that names a real fixture. The body and the name it parses to are real,
  // so the checks above hold; what the step says about itself must also agree with the pack test the fixture belongs
  // to, and with every other step. Every check fails closed.

  it.each([
    ["the rule it says it broke", (a: any) => void (a.violates = "action"), "FAIL: step 7 says it broke the action rule, but its pack test refuse-method breaks the method rule"],
    ["its action", (a: any) => void (a.action = "Transfer"), /^FAIL: step 7 signed Transfer add_proposal with deposit 0 yocto and 30 TGas, but its pack test refuse-method signs FunctionCall add_proposal with deposit 0 yocto and 30 TGas$/],
    ["its method", (a: any) => void (a.method = "act_proposal"), /^FAIL: step 7 signed FunctionCall act_proposal with deposit 0 yocto and 30 TGas, but its pack test refuse-method signs FunctionCall add_proposal /],
    ["its deposit", (a: any) => void (a.depositYocto = "1"), /^FAIL: step 7 signed FunctionCall add_proposal with deposit 1 yocto and 30 TGas, but its pack test refuse-method signs /],
    ["its gas", (a: any) => void (a.gasTGas = 100), /^FAIL: step 7 signed FunctionCall add_proposal with deposit 0 yocto and 100 TGas, but its pack test refuse-method signs /],
  ])("C-T14d (N2): a refusal that names a real fixture but says another thing about %s is a FAIL, not a replay of the pack's test", async (_what, change, note) => {
    const replay = await loadDemoRunFixture(stageRun((r) => change(r.steps[6].attempt)));
    expect(replay.steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([7]);
    if (typeof note === "string") expect(shown(replay.steps[6]).note).toBe(note);
    else expect(shown(replay.steps[6]).note).toMatch(note);
    expect(replay.exitCode).toBe(1);
  });

  it("C-T14d: the step's phase and signer must be the pack test's too (the phase decides whether SignerDoesNotExist is a proof)", async () => {
    const phase = await loadDemoRunFixture(stageRun((r) => void (r.steps[6].phase = "in-scope")));
    expect(shown(phase.steps[6])).toMatchObject({ pass: false, note: "FAIL: step 7 is in phase in-scope, but its pack test refuse-method belongs to phase refusals" });
    // [20] is a smoke-phase burn proof (SignerDoesNotExist): the same fixture moved to the hero's refusals phase is not one.
    const moved = await loadDemoRunFixture(stageRun((r) => void (r.steps[19].phase = "refusals")));
    expect(shown(moved.steps[19])).toMatchObject({ pass: false, note: "FAIL: step 20 is in phase refusals, but its pack test after-burn belongs to phase smoke" });
    const signer = await loadDemoRunFixture(stageRun((r) => void (r.steps[6].signer = "operator")));
    expect(shown(signer.steps[6])).toMatchObject({ pass: false, note: "FAIL: step 7 was signed by operator, but its pack test refuse-method is signed with the session key" });
  });

  it("C-T14d: a name shaped like a pack test's fixture (NETWORK.PACK.TEST.json) that no pack test owns judges nothing, so the step fails", async () => {
    const ghost = (name: string) =>
      stageRun((r, demo) => {
        writeFileSync(join(demo, "fixtures", name), r.steps[3].attempt.outcome.rawRpcJson);
        r.steps[3].fixture = name;
      });
    const noTest = await loadDemoRunFixture(ghost("sandbox.sputnik-v2.no-such-test.json"));
    expect(shown(noTest.steps[3])).toMatchObject({ pass: false, note: "FAIL: step 4 names the fixture sandbox.sputnik-v2.no-such-test.json, but pack sputnik-v2 has no test no-such-test" });
    const noPack = await loadDemoRunFixture(ghost("sandbox.nopack.refuse-method.json"));
    expect(shown(noPack.steps[3])).toMatchObject({ pass: false, note: "FAIL: step 4 names the fixture sandbox.nopack.refuse-method.json, but there is no pack nopack" });
    expect(noTest.exitCode).toBe(1);
  });

  it("C-T14d: a step that names a fixture but records no attempt cannot pass on its recorded pass", async () => {
    const replay = await loadDemoRunFixture(
      stageRun((r) => {
        delete r.steps[6].attempt; // [07] keeps its fixture and its recorded pass: true
      }),
    );
    expect(replay.steps.filter((s) => !s.pass).map((s) => [s.n, shown(s).note])).toEqual([[7, "FAIL: step 7 names the fixture sandbox.sputnik-v2.refuse-method.json, but records no attempt"]]);
    expect(replay.exitCode).toBe(1);
  });

  it("C-T14d: a fixture of the other network is no evidence for this run", async () => {
    const other = readFileSync(join(FIXTURES, "testnet.sputnik-v2.refuse-method.json"), "utf8");
    const replay = await loadDemoRunFixture(
      stageRun((r, demo) => {
        writeFileSync(join(demo, "fixtures", "testnet.sputnik-v2.refuse-method.json"), other);
        Object.assign(r.steps[6].attempt.outcome, { rawRpcJson: other });
        r.steps[6].fixture = "testnet.sputnik-v2.refuse-method.json";
      }),
    );
    expect(shown(replay.steps[6])).toMatchObject({ pass: false, note: "FAIL: step 7 names the testnet fixture testnet.sputnik-v2.refuse-method.json, but this is a sandbox run" });
  });

  it("C-T14d: one fixture is one send: a second step that names it is a FAIL, so one real body cannot prove two refusals", async () => {
    const replay = await loadDemoRunFixture(
      stageRun((r) => {
        r.steps[7].fixture = r.steps[6].fixture;
        r.steps[7].attempt = structuredClone(r.steps[6].attempt);
      }),
    );
    expect(replay.steps.filter((s) => !s.pass).map((s) => [s.n, shown(s).note])).toEqual([[8, "FAIL: step 8 names the fixture sandbox.sputnik-v2.refuse-method.json, which step 7 already names"]]);
    expect(replay.exitCode).toBe(1);
  });

  // C-T14c: [11] is the one step with no attempt that carries evidence, the two key reads around the refusals.
  it("C-T14c: [11] is judged again from its two reads and the refusals before it, not from the pass it recorded", async () => {
    const real = await loadDemoRunFixture(RUN_SANDBOX);
    expect(real.steps[10]).toMatchObject({ phase: "chain-check", pass: true });
    const note = async (change: (r: any) => void) => {
      const replay = await loadDemoRunFixture(stageRun(change));
      return { failed: replay.steps.filter((s) => !s.pass).map((s) => s.n), note: shown(replay.steps[10]).note, pass: replay.steps[10].pass, exitCode: replay.exitCode };
    };
    const nonce = recorded.steps[10].chainCheck!.before.nonce;
    expect(await note((r) => void (r.steps[10].chainCheck.after.nonce = nonce + 1))).toEqual({ failed: [11], note: `FAIL: key state changed by refusals (nonce ${nonce} -> ${nonce + 1})`, pass: false, exitCode: 1 });
    const allowance = recorded.steps[10].chainCheck!.before.allowanceRemainingYocto;
    expect(await note((r) => void (r.steps[10].chainCheck.after.allowanceRemainingYocto = "1"))).toEqual({
      failed: [11],
      note: `FAIL: key state changed by refusals (allowance ${allowance} -> 1 yocto)`,
      pass: false,
      exitCode: 1,
    });
    // No refusal was earned before it: the four refusals did not pass (they fail themselves), so "unchanged by 0 refusals" rests on nothing.
    const none = await note((r) => {
      for (const i of [6, 7, 8, 9]) r.steps[i].pass = false;
    });
    expect(none).toMatchObject({ failed: [7, 8, 9, 10, 11], note: "FAIL: no attempt was refused by protocol before the chain check (0/4)", pass: false });
    // ...or there was no refusals-phase step before it at all.
    const nothing = await note((r) => {
      for (const i of [6, 7, 8, 9]) r.steps[i].phase = "in-scope";
    });
    expect(nothing.note).toBe("FAIL: no refusal attempt preceded the chain check");
    expect(nothing.pass).toBe(false);
  });

  it("C-T14c: a chain check with no reads recorded cannot pass, and a malformed read is an input error", async () => {
    const bare = await loadDemoRunFixture(stageRun((r) => void delete r.steps[10].chainCheck));
    expect(shown(bare.steps[10])).toMatchObject({ pass: false, note: "FAIL: step 11 is a chain check, but the run file records no before/after view_access_key reads" });
    // A failed chain check the driver recorded (the reads themselves failed) has no reads either, and stays failed with its own note.
    const failedBefore = await loadDemoRunFixture(
      stageRun((r) => {
        delete r.steps[10].chainCheck;
        Object.assign(r.steps[10], { pass: false, note: "FAIL: the session key is not on chain before the refusals (view_access_key)" });
      }),
    );
    expect(shown(failedBefore.steps[10])).toMatchObject({ pass: false, note: "FAIL: the session key is not on chain before the refusals (view_access_key)" });
    const malformed = await loadDemoRunFixture(stageRun((r) => void (r.steps[10].chainCheck.before = { nonce: "7" }))).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(InputError);
    expect((malformed as InputError).problems[0]).toMatch(/steps\[10\] is not a DemoStep/);
  });

  // Fix round 1, m-3: replayChainCheck judges a step that still calls itself a chain check. A run of the hero's shape must
  // also have one, in its phase, right after its refusals; relabelling [11] (and deleting its reads) must not drop the claim.
  it("m-3: a run with refusals needs their chain check in the chain-check phase right after them: relabelled, removed or cut off is a FAIL", async () => {
    const real = await loadDemoRunFixture(RUN_SANDBOX);
    expect(real.steps.map((s) => s.phase).slice(9, 12)).toEqual(["refusals", "chain-check", "inspect"]);

    // [11] relabelled `inspect` with its reads deleted (it replayed green before): FAIL, and the run exits 1.
    const relabelled = await loadDemoRunFixture(
      stageRun((r) => {
        r.steps[10].phase = "inspect";
        delete r.steps[10].chainCheck;
      }),
    );
    expect(relabelled.steps.filter((s) => !s.pass).map((s) => [s.n, shown(s).note])).toEqual([
      [11, "FAIL: step 11 follows the refusals, so it must be their chain check (phase chain-check, with its before/after view_access_key reads), but it is in phase inspect"],
    ]);
    expect(relabelled.exitCode).toBe(1);

    // ...also when it keeps its (good) reads: the phase is part of the claim.
    const relabelledWithReads = await loadDemoRunFixture(stageRun((r) => void (r.steps[10].phase = "inspect")));
    expect(relabelledWithReads.steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([11]);

    // [11] removed: the step after the refusals is [12], the inspect card.
    const removed = await loadDemoRunFixture(stageRun((r) => void r.steps.splice(10, 1)));
    expect(removed.steps.filter((s) => !s.pass).map((s) => [s.n, shown(s).note?.slice(0, 40)])).toEqual([[12, "FAIL: step 12 follows the refusals, so i"]]);

    // The run ends on its last refusal: that refusal fails.
    const cut = await loadDemoRunFixture(stageRun((r) => void (r.steps = r.steps.slice(0, 10))));
    expect(cut.steps.filter((s) => !s.pass).map((s) => [s.n, shown(s).note])).toEqual([[10, "FAIL: step 10 is the last refusal, but no chain check follows it"]]);
    expect(cut.exitCode).toBe(1);

    // A run with no refusals-phase step needs no chain check (it is not a hero run): setup and in-scope steps replay green.
    const noRefusals = await loadDemoRunFixture(stageRun((r) => void (r.steps = r.steps.slice(0, 6))));
    expect(noRefusals.exitCode).toBe(0);
  });

  it("a chain card with no key keeps PASS_KEY_GONE; one with a key is a REPLAY card without it (M5)", async () => {
    const real = await loadDemoRunFixture(RUN_SANDBOX);
    expect(count(printRun(real), PASS_KEY_GONE)).toBe(0); // [12]'s key is still on chain there
    const burned = await loadDemoRunFixture(stageRun((r) => void (r.steps[11].card.key = null)));
    const card = burned.steps[11].card!;
    expect([card.key, card.source]).toEqual([null, "chain"]);
    expect(count(printRun(burned), PASS_KEY_GONE)).toBe(1);
  });

  it("a JSON file that is neither a manifest nor a run is an input error", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "other.json"), '{"hello":"world"}');
    writeFileSync(join(dir, "bad.json"), "not json");
    await expect(loadDemoRunFixture(join(dir, "other.json"))).rejects.toBeInstanceOf(InputError);
    await expect(loadDemoRunFixture(join(dir, "bad.json"))).rejects.toBeInstanceOf(InputError);
  });
});

// ---------------------------------------------------------------------------------------------------
// (a) the spike capture (C-T8a)

describe("loadDemoRunFixture: paths that are not there", () => {
  it("a .json path that does not exist is `no such file: <path>`, not a capture-directory error", async () => {
    const missing = join(tmp(), "nope.json");
    const error = await loadDemoRunFixture(missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InputError);
    expect((error as InputError).problems).toEqual([`no such file: ${missing}`]);
    const dir = join(tmp(), "dir.json");
    mkdirSync(dir);
    expect(((await loadDemoRunFixture(dir).catch((e: unknown) => e)) as InputError).problems).toEqual([`not a file: ${dir}`]);
  });

  it("a directory with no capture log says what a capture directory holds, with no stale TODO", async () => {
    const empty = join(tmp(), "empty");
    mkdirSync(empty);
    const error = (await loadDemoRunFixture(empty).catch((e: unknown) => e)) as InputError;
    expect(error).toBeInstanceOf(InputError);
    expect(error.problems[0]).toMatch(/^no capture log at .*index\.json \(a capture directory holds an index\.json;/);
    expect(error.problems[0]).not.toContain("TODO");
  });
});

describe("loadDemoRunFixture: the spike capture (a)", () => {
  it("a deleted body is `FAIL: fixture missing demo/fixtures/<file>` (R12), with no host path in it", async () => {
    const dir = join(tmp(), "capture");
    cpSync(SANDBOX_FIXTURES, dir, { recursive: true });
    rmSync(join(dir, "052-g1-method-add_proposal.send_tx.json"));
    const damaged = await loadDemoRunFixture(dir);
    const failed = damaged.steps.filter((s) => !s.pass);
    expect(failed).toHaveLength(1);
    expect(shown(failed[0])).toMatchObject({ phase: "refusals", fixture: "052-g1-method-add_proposal.send_tx.json", note: "FAIL: fixture missing demo/fixtures/052-g1-method-add_proposal.send_tx.json" });
    expect(failed[0].attempt).toBeUndefined();
    expect(failed[0].note).not.toContain(dir);
    expect(damaged.exitCode).toBe(1);
  });


  it("prints an rpc line whose path exists on disk", async () => {
    const spike = await loadDemoRunFixture(SANDBOX_FIXTURES);
    const step = spike.steps.find((s) => s.phase === "refusals")!;
    const block = renderRefusalBlock(step, plain100, "full");
    const printed = /· (demo\/fixtures\/\S+)$/m.exec(block)![1]; // 104 cells in one row, so on the row after `rpc` (C-T14b)
    expect(printed).toBe("demo/fixtures/sandbox/052-g1-method-add_proposal.send_tx.json");
    expect(readFileSync(join(REPO, printed), "utf8")).toBe(step.attempt!.outcome.rawRpcJson);
  });
});
