/**
 * Task 17 live suite (`npm run test:sandbox`): the real `keyhole demo --sandbox`, spawned as its own process
 * (`node --import tsx src/cli/index.ts`, what `npm run keyhole --` runs), piped, against a real near-sandbox. Nothing
 * is faked: the CLI boots its own sandbox through runDemo and stops it.
 *
 *   1. The whole run: exit 0, `RESULT 20/20 PASS · 7 protocol refusals …` then SIX_OF_EIGHT as the last two lines,
 *      seven `PASS: refused by protocol` lines, under 300 s, and nothing written to the keychain or $KEYHOLE_HOME.
 *   2. The same run through `npm run keyhole` (the tsx CLI: a tsx parent and a node child), as T16 runs it (M4).
 *   3. A second SIGTERM 250 ms after the first (past the 100 ms repeat window), to the pid only: the hard exit, 130,
 *      its last words on stderr (STOPPED: the step in flight, the sandbox stopped), and the exit hook still stops the
 *      node (M1). The tsx CLI's pid-only path is covered offline (test/cli-demo.test.ts, the same exit hook): a
 *      failed live run there would orphan a node this suite may not kill.
 *   4. SIGTERM, then SIGINT, sent mid-run to the child's pid only (C-T2c: the sandbox exit hook does not run on
 *      SIGTERM, so the CLI must stop the sandbox itself): the step in flight finishes and prints, the driver's
 *      `finally` stops the sandbox, ABORTED names the next step, exit 130, and no node or .sandbox-home dir is left.
 *
 * Local only: every key is the sandbox root's or minted in memory, none is printed (scanText checks the output).
 * HOME and the keychain point into the throwaway dir of test/home-guard.ts, and the child inherits them.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { scanText } from "../scripts/scan-secrets.js";
import { sessionsDir } from "../src/core/config.js";
import { credentialsDir } from "../src/core/credentials.js";
import { nn } from "../src/render/refusal-block.js";
import { SIX_OF_EIGHT, abortedSandbox } from "../src/render/strings.js";
import { REPO, repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

const nodesBefore = repoSandboxProcesses();
const homeBefore = sandboxHomeEntries();
const children: ChildProcess[] = [];

afterAll(() => {
  // Only the processes this file started, and only if one somehow outlived its test.
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  expect(repoSandboxProcesses()).toEqual(nodesBefore);
  expect(sandboxHomeEntries()).toEqual(homeBefore);
});

type Exit = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string; ms: number };

/** The two ways the CLI is launched: `node --import tsx` (what bin/keyhole.mjs does in-process) and `npm run keyhole`. */
const ENTRIES = {
  node: [process.execPath, "--import", "tsx", "src/cli/index.ts", "demo", "--sandbox"],
  npm: ["npm", "run", "keyhole", "--", "demo", "--sandbox"],
} as const;

/**
 * Spawns `keyhole demo --sandbox`, piped. `when` sees stdout as it grows; when it first returns true, `signals[0]` goes
 * to this child's pid (never a group, never another process), and each later one `gapMs` after the one before.
 */
function demoSandbox(opts: { entry?: keyof typeof ENTRIES; signals?: readonly NodeJS.Signals[]; gapMs?: number; when?: (out: string) => boolean; timeoutMs: number }): Promise<Exit> {
  const t0 = performance.now();
  const [cmd, ...args] = ENTRIES[opts.entry ?? "node"];
  const child = spawn(cmd, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  children.push(child);
  let out = "";
  let err = "";
  let sent = false;
  child.stderr!.on("data", (d) => (err += String(d)));
  child.stdout!.on("data", (d) => {
    out += String(d);
    if (!sent && opts.signals?.length && opts.when?.(out)) {
      sent = true;
      opts.signals.forEach((sig, i) => setTimeout(() => child.kill(sig), i * (opts.gapMs ?? 0)));
    }
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, ms: performance.now() - t0 });
    });
  });
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

describe("keyhole demo --sandbox, the real CLI in its own process", () => {
  it("runs all 20 steps piped: RESULT 20/20 then the six-of-eight line, 7 protocol refusals, exit 0, < 300 s", async () => {
    const run = await demoSandbox({ timeoutMs: 300_000 });
    expect(run.err).toBe("");
    expect(run).toMatchObject({ code: 0, signal: null });
    expect(run.ms).toBeLessThan(300_000);
    const lines = run.out.trimEnd().split("\n");
    // The sandbox header waits for the first step, so it names the node runDemo booted (origin only).
    expect(lines[0]).toMatch(/^KEYHOLE demo · sandbox · mode live · pack sputnik-v2 · on-account · rpc http:\/\/127\.0\.0\.1:\d+$/);
    expect(lines.at(-2)).toMatch(/^RESULT 20\/20 PASS · 7 protocol refusals · \d+ tx hashes · \d+(m\d+)?s · exit 0$/);
    expect(lines.at(-1)).toBe(SIX_OF_EIGHT);
    expect(count(run.out, "PASS: refused by protocol")).toBe(7);
    expect(lines.filter((l) => /^\[\d{2}\/20\] /.test(l)).map((l) => l.slice(1, 3))).toEqual(Array.from({ length: 20 }, (_, i) => nn(i + 1)));
    expect(run.out).not.toContain("FAIL");
    expect(scanText("stdout", run.out).hits).toEqual([]); // public keys only
    // Nothing persists on --sandbox: no session file, no keychain entry, no artifacts.
    expect(entries(sessionsDir(process.env))).toEqual([]);
    expect(entries(credentialsDir(process.env))).toEqual([]);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  }, 330_000);

  it("through `npm run keyhole` (the tsx CLI, as T16 runs it): RESULT 20/20 then the six-of-eight line, exit 0 (M4)", async () => {
    const run = await demoSandbox({ entry: "npm", timeoutMs: 300_000 });
    expect(run).toMatchObject({ code: 0, signal: null });
    expect(run.ms).toBeLessThan(300_000);
    const lines = run.out.trimEnd().split("\n");
    expect(lines.slice(0, 3)).toEqual(["", "> keyhole@0.0.0 keyhole", "> tsx src/cli/index.ts demo --sandbox"]); // npm's own header
    expect(lines.at(-2)).toMatch(/^RESULT 20\/20 PASS · 7 protocol refusals · \d+ tx hashes · \d+(m\d+)?s · exit 0$/);
    expect(lines.at(-1)).toBe(SIX_OF_EIGHT);
    expect(count(run.out, "PASS: refused by protocol")).toBe(7);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  }, 330_000);

  it("a second SIGTERM to the pid while the first one's abort waits: exit 130 at once, its last words, and the exit hook still stops the node (M1)", async () => {
    // 250 ms apart: past the repeat window (a repeat within 100 ms is the same Ctrl-C), while the first signal's abort
    // still waits for the step in flight, so the second one is the hard exit. Its last words name that step (or, if it
    // had just finished, where the run stopped). process.exit runs sandbox.ts's exit hook, which SIGKILLs the node and
    // removes its run dir.
    const run = await demoSandbox({ signals: ["SIGTERM", "SIGTERM"], gapMs: 250, when: (out) => /^\[04\/20\] /m.test(out), timeoutMs: 170_000 });
    expect(run).toMatchObject({ code: 130, signal: null });
    expect(run.err).toMatch(/^STOPPED (during \[\d{2}\] [a-z -]+|at \[\d{2}\]) · sandbox stopped; nothing persists\n$/);
    expect(run.out).not.toContain("ABORTED"); // the hard path: no claim about what is left
    expect(run.out).not.toMatch(/^RESULT /m);
    expect(scanText("stdout", run.out).hits).toEqual([]);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  }, 180_000);

  it.each(["SIGTERM", "SIGINT"] as const)("%s mid-run: the step in flight prints, the sandbox stops, ABORTED, exit 130, no node left", async (signal) => {
    // Sent once [04] has printed: the sandbox is up and the DAO is set, so the driver is mid-run when it lands.
    const run = await demoSandbox({ signals: [signal], when: (out) => /^\[04\/20\] /m.test(out), timeoutMs: 170_000 });
    expect(run).toMatchObject({ code: 130, signal: null });
    expect(run.err).toBe("");
    const lines = run.out.trimEnd().split("\n");
    const printed = lines.filter((l) => /^\[\d{2}\/20\] /.test(l)).map((l) => Number(l.slice(1, 3)));
    expect(printed.at(-1)).toBeGreaterThanOrEqual(4);
    expect(printed).toEqual(Array.from({ length: printed.length }, (_, i) => i + 1)); // no step lost or skipped
    expect(lines.at(-1)).toBe(abortedSandbox(nn(printed.at(-1)! + 1)));
    expect(run.out).not.toMatch(/^RESULT /m);
    expect(scanText("stdout", run.out).hits).toEqual([]);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  }, 180_000);
});
