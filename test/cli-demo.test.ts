/**
 * Task 17: `keyhole demo --sandbox|--testnet [--step]` offline. The command runs a fake runDemo that replays committed
 * runs: the spike capture (loadDemoRunFixture(SANDBOX_FIXTURES), 16 steps) and the live driver run T13 recorded
 * (demo/run.sandbox.json, 20 steps; its first 14 steps stand in for a testnet run). Nothing here opens a socket, boots
 * a sandbox or reads a key: the live run is in test-sandbox/cli-demo.sandbox.test.ts.
 *
 * Covered: the header, the full and beat styles, the TTY progress lines, --step, Ctrl-C (in process and as a real
 * signal to a child process), environment and sent-tx errors (exit 2 and 3), FAIL steps, the early stop, and the
 * --testnet artifacts, plus the carry-forwards C-T1b, C-T2c, C-T2j, C-T8b, C-T12c, C-T12d and C-T19a.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Command, Io } from "../src/cli/args.js";
import { STEP_TITLES, abortedBurned, abortedKeyUnknown, abortedNoKey, createDemoCommand, type DemoDeps, keyUnknownHint, sessionHint } from "../src/cli/demo.js";
import { helpText } from "../src/cli/help.js";
import { COMMANDS, main } from "../src/cli/main.js";
import { LandedUnsettledError } from "../src/core/attempt.js";
import { EnvironmentError, KeyholeError } from "../src/core/errors.js";
import { SendFateUnknownError } from "../src/core/tx.js";
import type { DemoRun, DemoStep, Network, TxSuccess } from "../src/core/types.js";
import type { runDemo } from "../src/demo/driver.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { nn } from "../src/render/refusal-block.js";
import { OFFLINE_ALTERNATIVE, PASS_RUNTIME, RPC_NOT_SAVED, SIX_OF_EIGHT, aborted, abortedSandbox, failExpected } from "../src/render/strings.js";
import { displayWidth, stripAnsi } from "../src/render/style.js";
import { REPO, SANDBOX_FIXTURES } from "./helpers.js";

// ---------------------------------------------------------------------------------------------------
// Runs and fakes

/** The spike capture: 16 session attempts, 13 of them refusals (the brief's fixture). */
const SPIKE = await loadDemoRunFixture(SANDBOX_FIXTURES);
const refusalSteps = SPIKE.steps.filter((s) => s.attempt?.outcome.kind === "Refusal").length;
/** T13's live driver run on sandbox: [01]–[20], every PASS. */
const RUN_SANDBOX = JSON.parse(readFileSync(join(REPO, "demo", "run.sandbox.json"), "utf8")) as DemoRun;
/** Its hero, [01]–[14], as a testnet run would number and name it. */
const HERO_TESTNET: DemoStep[] = RUN_SANDBOX.steps.slice(0, 14).map((s) => ({ ...s, total: 14, ...(s.fixture ? { fixture: s.fixture.replace(/^sandbox\./, "testnet.") } : {}) }));
/** The session [03] wrapped in that run. */
const SESSION = "ks-f298";
const OP = "kh-op-021e.testnet";
const RPC = "http://127.0.0.1:3030";

interface FakeOpts {
  network: Network;
  steps: readonly DemoStep[];
  /** The chain work before step i (0-based) is yielded. */
  work?: (i: number) => Promise<void> | void;
  /** Step i is not yielded: this is thrown instead. */
  throwAt?: { i: number; error: unknown };
  run?: Partial<DemoRun>;
  /** Shared with the terminal, to check what happened in which order. */
  events?: string[];
  /** Called in the generator's finally (where the real driver stops the sandbox). */
  onFinally?: () => void;
}

/** A runDemo that replays `steps`, recording how it was driven. */
function fake(o: FakeOpts) {
  const log = { calls: [] as Array<{ network: Network; env?: NodeJS.ProcessEnv }>, started: 0, finallyRan: false };
  async function* fakeRunDemo(opts: { network: Network; env?: NodeJS.ProcessEnv }): AsyncGenerator<DemoStep, DemoRun, void> {
    log.calls.push(opts);
    o.events?.push("runDemo");
    try {
      for (let i = 0; i < o.steps.length; i++) {
        log.started++;
        await o.work?.(i);
        if (o.throwAt?.i === i) throw o.throwAt.error;
        yield o.steps[i];
      }
    } finally {
      log.finallyRan = true;
      o.events?.push("finally");
      o.onFinally?.();
    }
    return {
      id: `live-${o.network}-20261106T120000Z`,
      network: o.network,
      mode: "live",
      steps: [...o.steps],
      durationMs: 24_000,
      exitCode: o.steps.every((s) => s.pass) ? 0 : 1,
      transcriptPath: o.network === "testnet" ? "demo/transcript.md" : "",
      ...o.run,
    };
  }
  return { runDemo: fakeRunDemo as typeof runDemo, log };
}

interface TermOpts {
  tty?: boolean;
  columns?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  readLine?: () => Promise<string | null>;
  /** Called with each io.out text, after it is recorded. */
  onOut?: (text: string) => void;
  events?: string[];
}

/** A scripted terminal: stdout lines, stderr lines, the raw writes, and everything in order (`stream`). */
function terminal(o: TermOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const writes: string[] = [];
  const stream: string[] = [];
  let words: (() => string) | undefined;
  const wordsLog: Array<"set" | "clear"> = [];
  const io: Io = {
    out: (t) => {
      out.push(t);
      stream.push(`${t}\n`);
      o.events?.push(`out:${t}`);
      o.onOut?.(t);
    },
    err: (t) => {
      err.push(t);
      stream.push(`[stderr] ${t}\n`);
      o.events?.push(`err:${t}`);
    },
    write: (t) => {
      writes.push(t);
      stream.push(t);
    },
    stdout: { isTTY: o.tty ?? false, columns: o.columns ?? 100, rows: o.rows },
    stdinIsTTY: o.tty ?? false,
    env: { LANG: "C.UTF-8", ...o.env },
    ...(o.readLine ? { readLine: o.readLine } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    lastWords: (w) => {
      words = w;
      wordsLog.push(w ? "set" : "clear");
    },
  };
  return {
    io,
    /** What the hard exit would write now (main calls the command's lastWords), or undefined. */
    words: () => words?.(),
    wordsLog,
    out: () => out.join("\n"),
    lines: () => out.join("\n").split("\n"),
    err: () => err.join("\n"),
    writes,
    stream: () => stream.join(""),
  };
}

/** Runs a command as main does: a KeyholeError prints its line on stderr and sets the exit code. */
async function exec(cmd: Command, argv: string[], io: Io): Promise<number> {
  try {
    return await cmd.run(argv, io);
  } catch (e) {
    if (e instanceof KeyholeError) {
      io.err(e.line());
      return e.exitCode;
    }
    io.err(`ERROR (environment): ${(e as Error).message} · rerun with DEBUG=1 for a stack trace`);
    return 2;
  }
}

function command(f: { runDemo: typeof runDemo }, deps: Partial<DemoDeps> = {}) {
  const writeRunArtifacts = vi.fn<DemoDeps["writeRunArtifacts"]>(async () => []);
  const cmd = createDemoCommand({ runDemo: f.runDemo, writeRunArtifacts, rpcUrlFor: () => RPC, ...deps });
  return { cmd, writeRunArtifacts };
}

/** Aborts `ac` once a printed chunk names step `n`. */
const abortAfter = (ac: AbortController, n: number, total: number) => (text: string) => {
  if (text.includes(`[${nn(n)}/${nn(total)}]`)) ac.abort();
};

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------

describe("keyhole demo, piped (full style)", () => {
  it("--sandbox: plain, the header first, every step, RESULT at(-2) and the six-of-eight line at(-1); exit 0", async () => {
    const f = fake({ network: "sandbox", steps: SPIKE.steps });
    const { cmd, writeRunArtifacts } = command(f);
    const t = terminal();
    expect(await exec(cmd, ["--sandbox"], t.io)).toBe(0);
    expect(t.err()).toBe("");
    const out = t.out();
    expect(out).not.toContain("\x1b");
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe(`KEYHOLE demo · sandbox · mode live · pack sputnik-v2 · on-account · rpc ${RPC}`);
    expect(lines.at(-2)).toMatch(/^RESULT 16\/16 PASS · 13 protocol refusals · /);
    expect(lines.at(-1)).toBe(SIX_OF_EIGHT);
    expect(lines.filter((l) => l.includes("PASS: refused by protocol")).length).toBe(refusalSteps);
    for (const s of SPIKE.steps) expect(out).toContain(`[${nn(s.n)}/16]`);
    expect(lines.filter((l) => l.includes(" ATTEMPT  "))).toHaveLength(refusalSteps); // the full style: R4's anatomy
    expect(t.writes).toEqual([]); // no progress line when piped
    expect(f.log.calls).toEqual([{ network: "sandbox", env: t.io.env }]);
    expect(writeRunArtifacts).not.toHaveBeenCalled(); // sandbox leaves no artifacts
  });

  it("--testnet: the header names the RPC origin only (no credentials, path or query) and breaks at a ` · `; RESULT is the last line", async () => {
    const f = fake({ network: "testnet", steps: HERO_TESTNET });
    const writeRunArtifacts = vi.fn<DemoDeps["writeRunArtifacts"]>(async () => []);
    const cmd = createDemoCommand({ runDemo: f.runDemo, writeRunArtifacts }); // the real rpcUrlFor: KEYHOLE_TESTNET_RPC
    const t = terminal({ env: { KEYHOLE_TESTNET_RPC: "https://user:pw-secret@rpc.example-provider.org:8443/v1/k3y-secret?apikey=q-secret", KEYHOLE_OPERATOR: OP } });
    expect(await exec(cmd, ["--testnet"], t.io)).toBe(0);
    const lines = t.lines();
    expect(lines.slice(0, 2)).toEqual(["KEYHOLE demo · testnet · mode live · pack sputnik-v2 · on-account", "             · rpc https://rpc.example-provider.org:8443"]);
    expect(t.out() + t.err()).not.toMatch(/secret/);
    expect(lines.at(-1)).toMatch(/^RESULT 14\/14 PASS · 5 protocol refusals · \d+ tx hashes · 24s · exit 0 · transcript demo\/transcript\.md$/);
    expect(f.log.calls[0].network).toBe("testnet");
    expect(writeRunArtifacts).toHaveBeenCalledOnce();
  });

  it("every row fits 100 columns; the ledger breaks at a ` · ` and PASS_RUNTIME stays whole (C-T12a, C-T14b)", async () => {
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps });
    const t = terminal();
    expect(await exec(command(f).cmd, ["--sandbox"], t.io)).toBe(0);
    const lines = t.lines();
    for (const l of lines) expect(displayWidth(l), l).toBeLessThanOrEqual(100);
    const i = lines.indexOf("        reached block: no · on-chain tx: none");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe("        · InvalidTxError › InvalidAccessKeyError › MethodNameMismatch");
    expect(lines.filter((l) => l.includes(PASS_RUNTIME))).toEqual([`    ${PASS_RUNTIME}`]);
    expect(lines.at(-2)).toMatch(/^RESULT 20\/20 PASS · 7 protocol refusals · 14 tx hashes · 24s · exit 0$/);
    expect(lines.at(-1)).toBe(SIX_OF_EIGHT);
  });

  it("final review M3: --sandbox, piped, names no fixture file under 'verbatim' (it writes none); each rpc row says not saved", async () => {
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps });
    const { cmd, writeRunArtifacts } = command(f);
    const t = terminal();
    expect(await exec(cmd, ["--sandbox"], t.io)).toBe(0);
    expect(writeRunArtifacts).not.toHaveBeenCalled();
    const lines = t.lines();
    expect(t.out()).not.toContain("demo/fixtures/");
    const rows = lines.filter((l) => l.includes("rpc      response body, verbatim"));
    expect(rows.length).toBe(RUN_SANDBOX.steps.filter((s) => s.fixture !== undefined && s.attempt?.outcome.kind === "Refusal").length);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) expect(row).toBe(`        rpc      response body, verbatim · ${RPC_NOT_SAVED}`);
  });

  it("final review M3: --testnet, piped, names each fixture file under 'verbatim': that run is written", async () => {
    const f = fake({ network: "testnet", steps: HERO_TESTNET });
    const { cmd, writeRunArtifacts } = command(f);
    const t = terminal({ env: { KEYHOLE_OPERATOR: OP } });
    expect(await exec(cmd, ["--testnet"], t.io)).toBe(0);
    expect(writeRunArtifacts).toHaveBeenCalledOnce();
    const refused = HERO_TESTNET.filter((s) => s.fixture !== undefined && s.attempt?.outcome.kind === "Refusal");
    expect(refused.length).toBeGreaterThanOrEqual(5);
    for (const s of refused) expect(t.out(), s.fixture).toContain(`demo/fixtures/${s.fixture}`);
    expect(t.out()).not.toContain(RPC_NOT_SAVED);
  });

  it("C-T14b: the spike capture's long fixture names (the widest rpc row was 109 cells) break before the path: every piped row fits 100 columns, no path is cut", async () => {
    // A run that is written names its files (M3): --testnet, fed the spike capture's 16 steps. A real testnet run has
    // 14 steps and 5 refusals; with these 13, a transcript claim would stretch RESULT, which is not under test here.
    const f = fake({ network: "testnet", steps: SPIKE.steps, run: { transcriptPath: "" } });
    const t = terminal({ env: { KEYHOLE_OPERATOR: OP } });
    expect(await exec(command(f).cmd, ["--testnet"], t.io)).toBe(0);
    const lines = t.lines();
    for (const l of lines) expect(displayWidth(l), l).toBeLessThanOrEqual(100);
    const refused = SPIKE.steps.filter((s) => s.fixture !== undefined && s.attempt?.outcome.kind === "Refusal");
    expect(refused.length).toBeGreaterThanOrEqual(6);
    for (const s of refused) {
      const at = lines.indexOf("        · demo/fixtures/" + s.fixture);
      if (at > 0) expect(lines[at - 1], s.fixture).toBe("        rpc      response body, verbatim");
      else expect(lines, s.fixture).toContain("        rpc      response body, verbatim · demo/fixtures/" + s.fixture);
    }
    // The longest name (055-g2-transfer-1yocto-attacker.send_tx.json) is the one that needs the break.
    expect(lines).toContain("        · demo/fixtures/sandbox/055-g2-transfer-1yocto-attacker.send_tx.json");
  });

  it("input errors exit 2 before anything runs; --help prints the usage with [--step]", async () => {
    const f = fake({ network: "sandbox", steps: SPIKE.steps });
    const { cmd } = command(f);
    for (const argv of [["--sandbox", "--steps"], ["--sandbox", "extra"], ["--sandbox", "--testnet"], []]) {
      const t = terminal();
      expect(await exec(cmd, argv, t.io), argv.join(" ")).toBe(2);
      expect(t.err()).toMatch(/^ERROR \(input\): /);
    }
    expect(f.log.calls).toEqual([]);
    const t = terminal();
    expect(await exec(cmd, ["--help"], t.io)).toBe(0);
    expect(t.out()).toBe("usage: keyhole demo --sandbox|--testnet [--step]\nkeys:  demo accounts only");
    // The default command parses the same way through main.
    const m = terminal();
    expect(await main(["demo", "--sandbox", "--steps"], m.io, {})).toBe(2);
  });
});

describe("keyhole demo on a TTY (beat style)", () => {
  it("progress in place: booting near-sandbox… Ns each second, then [NN/TT] waiting for RPC… after 1 s, each cleared before the next print", async () => {
    vi.useFakeTimers();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps, work: (i) => (i === 0 ? sleep(2_500) : i === 4 ? sleep(1_500) : undefined) });
    const t = terminal({ tty: true });
    const done = exec(command(f).cmd, ["--sandbox"], t.io);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe(0);
    expect(t.writes.filter((w) => w.includes("booting"))).toEqual(["\rbooting near-sandbox… 1s", "\rbooting near-sandbox… 2s"]);
    expect(t.writes.filter((w) => w.includes("waiting"))).toEqual(["\r[05/20] waiting for RPC…"]); // only the slow step
    const s = t.stream();
    expect(s).toContain("\rbooting near-sandbox… 2s\r\x1b[K\x1b[1mKEYHOLE demo\x1b[22m · sandbox · mode live");
    expect(stripAnsi(s)).toMatch(/\r\[05\/20\] waiting for RPC…\r\n\[05\/20\] the cosigner approves/);
    expect(s).toContain("\r[05/20] waiting for RPC…\r\x1b[K\n");
    const out = stripAnsi(t.out());
    expect(out).not.toContain(" ATTEMPT  "); // beat style
    expect(out).toContain("breaks METHOD · add_proposal");
  });

  it("every row fits 100 columns: RESULT breaks at a ` · ` (C-T8b); a long operator id's labels wrap (C-T12d)", async () => {
    const op = "kh-op-a-rather-long-operator-name-for-width.testnet"; // seat.<op> is 56 characters
    const steps = HERO_TESTNET.map((s) => ({ ...s, label: s.label.replace("seat.sandbox", `seat.${op}`) }));
    // 98 cells at 24s; a run of 59m59s makes RESULT 101 cells, so it must break.
    const f = fake({ network: "testnet", steps, run: { durationMs: 3_599_000 } });
    const t = terminal({ tty: true, env: { KEYHOLE_TESTNET_RPC: "https://rpc.testnet.near.org", KEYHOLE_OPERATOR: op } });
    expect(await exec(createDemoCommand({ runDemo: f.runDemo, writeRunArtifacts: async () => [] }), ["--testnet"], t.io)).toBe(0);
    const rows = stripAnsi(t.out()).split("\n");
    for (const r of rows) expect(displayWidth(r), r).toBeLessThanOrEqual(100);
    expect(rows[0]).toBe("KEYHOLE demo · testnet · mode live · pack sputnik-v2 · on-account · rpc https://rpc.testnet.near.org"); // 100 cells
    // A testnet TxLine is 110 cells at the indent here (unicode ellipsis; 112 in ASCII): the URL takes the next row.
    const tx = rows.findIndex((l) => l.startsWith("        tx 7Gm4…eHgA · final"));
    expect(rows.slice(tx, tx + 2)).toEqual(["        tx 7Gm4…eHgA · final", "        · https://testnet.nearblocks.io/txns/7Gm4Qt7hoJ4tDaWXMpvSrnwrjcU9uVchxE2m3guAeHgA"]);
    const r = rows.findIndex((l) => l.startsWith("RESULT 14/14 PASS · 5 protocol refusals · "));
    expect(rows.slice(r, r + 2)).toEqual(["RESULT 14/14 PASS · 5 protocol refusals · 8 tx hashes · 59m59s · exit 0", "       · transcript demo/transcript.md"]);
    const w = rows.findIndex((l) => l.startsWith("[03/14] "));
    expect(rows.slice(w, w + 2)).toEqual([`[03/14] seat.${op} signs one AddKey: act_proposal only`, "        · gas allowance 0.0500 NEAR"]);
  });

  it("the longest account id (64 characters) still fits: a part too wide for its row breaks at spaces", async () => {
    const seat = `seat.${"a".repeat(51)}.testnet`;
    expect(seat).toHaveLength(64);
    const steps = HERO_TESTNET.map((s) => ({ ...s, label: s.label.replace("seat.sandbox", seat) }));
    for (const tty of [true, false]) {
      const t = terminal({ tty, env: { KEYHOLE_TESTNET_RPC: "https://rpc.testnet.near.org" } });
      expect(await exec(createDemoCommand({ runDemo: fake({ network: "testnet", steps }).runDemo, writeRunArtifacts: async () => [] }), ["--testnet"], t.io)).toBe(0);
      const rows = stripAnsi(t.out()).split("\n");
      for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(100);
      const w = rows.findIndex((l) => l.startsWith("[03/14] "));
      expect(rows.slice(w, w + 3)).toEqual([`[03/14] ${seat} signs one AddKey:`, "          act_proposal only", "        · gas allowance 0.0500 NEAR"]);
    }
  });

  it("the 20-step sandbox run fits 100 columns: every beat row and every piped row (C-T8b, C-T12a, C-T14b)", async () => {
    for (const tty of [true, false]) {
      const t = terminal({ tty });
      expect(await exec(createDemoCommand({ runDemo: fake({ network: "sandbox", steps: RUN_SANDBOX.steps }).runDemo, writeRunArtifacts: async () => [] }), ["--sandbox"], t.io)).toBe(0);
      const rows = stripAnsi(t.out()).replace(/\r\x1b\[K/g, "").split("\n");
      for (const row of rows) expect(displayWidth(row), `${tty ? "beat" : "full"}: ${row}`).toBeLessThanOrEqual(100);
      // the 96-cell runtime verdict is whole on one row
      expect(rows.filter((r) => r.trim() === PASS_RUNTIME)).toHaveLength(1);
    }
  });
});

describe("Ctrl-C (io.signal)", () => {
  it("abort after [06] prints the ABORTED line and exits 130 (testnet: the session is still live)", async () => {
    const ac = new AbortController();
    const f = fake({ network: "testnet", steps: HERO_TESTNET });
    const { cmd, writeRunArtifacts } = command(f);
    const t = terminal({ signal: ac.signal, onOut: abortAfter(ac, 6, 14), env: { KEYHOLE_OPERATOR: OP } });
    expect(await exec(cmd, ["--testnet"], t.io)).toBe(130);
    expect(t.lines().at(-1)).toBe(aborted("07", SESSION));
    expect(t.out()).not.toMatch(/^RESULT/m);
    expect(f.log.started).toBe(6); // [07] was never asked for
    expect(f.log.finallyRan).toBe(true); // the generator was closed, so its finally ran
    expect(writeRunArtifacts).not.toHaveBeenCalled();
  });

  it.each([
    ["testnet", 2, abortedNoKey("03")],
    ["testnet", 3, aborted("04", SESSION)],
    ["testnet", 12, aborted("13", SESSION)],
    ["testnet", 13, abortedBurned("14", SESSION)],
    ["sandbox", 5, abortedSandbox("06")],
  ] as const)("%s, abort after [%i]: %s", async (network, n, line) => {
    const ac = new AbortController();
    const steps = network === "testnet" ? HERO_TESTNET : RUN_SANDBOX.steps;
    const f = fake({ network, steps });
    const t = terminal({ signal: ac.signal, onOut: abortAfter(ac, n, steps[0].total) });
    expect(await exec(command(f).cmd, [`--${network}`], t.io)).toBe(130);
    expect(t.lines().at(-1)).toBe(line);
    expect(f.log.finallyRan).toBe(true);
  });

  it("testnet, a key whose session id was never shown: ABORTED says a key may be live and where its id is, within 100 columns (M3)", async () => {
    // [03] printed with no card, no attempt and no ks- id in its note: the key went on chain under an id we never saw.
    const steps = HERO_TESTNET.map((s) => (s.n === 3 ? { ...s, card: undefined, attempt: undefined, note: "key on chain (view_access_key) as planned" } : s));
    // Under the home directory the path reads ~/…, and the line is one row of 99 cells.
    const ac = new AbortController();
    const t = terminal({ signal: ac.signal, onOut: abortAfter(ac, 3, 14), env: { KEYHOLE_HOME: join(homedir(), ".keyhole") } });
    expect(await exec(command(fake({ network: "testnet", steps })).cmd, ["--testnet"], t.io)).toBe(130);
    expect(t.lines().at(-1)).toBe("ABORTED at [04] · session key may be live · its ID is in ~/.keyhole/sessions · run: keyhole burn ID");
    expect(t.lines().at(-1)).toBe(abortedKeyUnknown("04", "~/.keyhole/sessions"));
    expect(displayWidth(t.lines().at(-1)!)).toBe(99);
    // A longer KEYHOLE_HOME breaks the line at a ` · `; every row fits.
    const env = { KEYHOLE_HOME: "/srv/keyhole-home-of-the-demo-operator" };
    const dir = "/srv/keyhole-home-of-the-demo-operator/sessions";
    const ac1 = new AbortController();
    const t1 = terminal({ signal: ac1.signal, onOut: abortAfter(ac1, 3, 14), env });
    expect(await exec(command(fake({ network: "testnet", steps })).cmd, ["--testnet"], t1.io)).toBe(130);
    expect(t1.lines().slice(-2)).toEqual(["ABORTED at [04] · session key may be live", `        · its ID is in ${dir} · run: keyhole burn ID`]);
    for (const row of t1.lines()) expect(displayWidth(row), row).toBeLessThanOrEqual(100);
    // A step that failed in flight at [03] or later may have added the key: the same line. Before [03], no key.
    for (const [i, rows] of [[2, ["ABORTED at [03] · session key may be live", `        · its ID is in ${dir} · run: keyhole burn ID`]], [1, [abortedNoKey("02")]]] as const) {
      const ac2 = new AbortController();
      const error = new EnvironmentError("testnet RPC timed out", "retry");
      const t2 = terminal({ signal: ac2.signal, env });
      const f2 = fake({ network: "testnet", steps: HERO_TESTNET, work: (k) => void (k === i && ac2.abort()), throwAt: { i, error } });
      expect(await exec(command(f2).cmd, ["--testnet"], t2.io)).toBe(130);
      expect(t2.err()).toBe(error.line());
      expect(t2.lines().slice(-rows.length)).toEqual(rows);
    }
  });

  it("while a step is in flight: the step finishes and prints, the generator's finally runs (the sandbox stops), then ABORTED at the next step", async () => {
    const ac = new AbortController();
    const events: string[] = [];
    const work = async (i: number) => {
      if (i !== 7) return;
      ac.abort(); // Ctrl-C while [08] is being sent
      await new Promise((r) => setTimeout(r, 20));
    };
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps, work, events });
    const t = terminal({ signal: ac.signal, events });
    expect(await exec(command(f).cmd, ["--sandbox"], t.io)).toBe(130);
    expect(t.out()).toContain("[08/20] ATTEMPT  Transfer");
    expect(t.out()).not.toContain("[09/20]");
    expect(t.lines().at(-1)).toBe(abortedSandbox("09"));
    expect(events.indexOf("finally")).toBeLessThan(events.indexOf(`out:${abortedSandbox("09")}`));
    expect(f.log.started).toBe(8);
  });

  it("an error from the step in flight is printed (no offline alternative), then ABORTED", async () => {
    const ac = new AbortController();
    const error = new EnvironmentError("near-sandbox at 127.0.0.1 refused the connection", "retry");
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps, work: (i) => void (i === 2 && ac.abort()), throwAt: { i: 2, error } });
    const t = terminal({ signal: ac.signal });
    expect(await exec(command(f).cmd, ["--sandbox"], t.io)).toBe(130);
    expect(t.err()).toBe(error.line());
    expect(t.lines().at(-1)).toBe(abortedSandbox("03"));
  });

  it("reads io.signal when the command starts, before runDemo (C-T1b)", async () => {
    const events: string[] = [];
    const ac = new AbortController();
    const t = terminal({ events });
    Object.defineProperty(t.io, "signal", {
      get() {
        events.push("signal");
        return ac.signal;
      },
      enumerable: false,
    });
    const f = fake({ network: "sandbox", steps: SPIKE.steps, events });
    expect(await exec(command(f).cmd, ["--sandbox"], t.io)).toBe(0);
    expect(events[0]).toBe("signal");
    expect(events.indexOf("signal")).toBeLessThan(events.indexOf("runDemo"));
  });
});

// A repeat signal after the first one's abort is the hard exit (src/cli/main.ts): main writes the command's last words
// on stderr, synchronously, then exits 130. The run sets them while it runs; here they are read where a second signal
// would land, through the terminal's lastWords.
describe("the hard exit's last words (M1)", () => {
  const KH = { KEYHOLE_HOME: join(homedir(), ".keyhole") };

  /**
   * Runs to step i (0-based), aborts there as the first Ctrl-C, and returns what a second one would print while the
   * step is in flight (`words`) and, once it has landed, while the generator's finally runs (`closing`).
   */
  async function wordsInFlight(network: Network, i: number, tty = false) {
    const ac = new AbortController();
    let words: string | undefined;
    let closing: string | undefined;
    let writesBefore: string[] = [];
    let writesByWords: string[] = [];
    const t = terminal({ signal: ac.signal, env: KH, tty });
    const work = async (k: number) => {
      if (k !== i) return;
      ac.abort(); // the first Ctrl-C while the step is in flight: the run waits for it
      await new Promise((r) => setTimeout(r, 20));
      writesBefore = [...t.writes];
      words = t.words(); // a second one lands here
      writesByWords = t.writes.slice(writesBefore.length); // what the words call itself wrote
    };
    const steps = network === "testnet" ? HERO_TESTNET : RUN_SANDBOX.steps;
    const code = await exec(command(fake({ network, steps, work, onFinally: () => (closing = t.words()) })).cmd, [`--${network}`], t.io);
    return { words, closing, code, t, writesBefore, writesByWords };
  }

  it("testnet, [03]'s AddKey in flight: the step, then where the key's ID is, broken at a ` · ` to fit; cleared when the run ends", async () => {
    const { words, closing, code, t } = await wordsInFlight("testnet", 2);
    expect(words?.split("\n")).toEqual([
      "STOPPED during [03] the AddKey · session key may be live · its ID is in ~/.keyhole/sessions",
      "        · run: keyhole burn ID",
    ]);
    // Once [03] has landed and printed its session, nothing is in flight: where the run stopped, and the session.
    expect(closing).toBe(`STOPPED at [04] · session ${SESSION} may still be live · run: keyhole burn ${SESSION}`);
    expect(code).toBe(130);
    expect(t.lines().at(-1)).toBe(aborted("04", SESSION)); // no second signal came: the soft path ran to its end
    expect(t.words()).toBeUndefined();
    expect(t.wordsLog).toEqual(["set", "clear"]);
  });

  it.each([
    ["testnet", 1, "STOPPED during [02] the proposals · no session key was added · nothing to burn"],
    ["testnet", 4, `STOPPED during [05] a cosigner vote · session ${SESSION} may still be live · run: keyhole burn ${SESSION}`],
    ["testnet", 12, `STOPPED during [13] the DeleteKey · session ${SESSION} may still be live · run: keyhole burn ${SESSION}`],
    ["testnet", 13, `STOPPED during [14] the after-burn attempt · session ${SESSION} is burned · nothing to clean up`],
    ["sandbox", 7, "STOPPED during [08] a refusal attempt · sandbox stopped; nothing persists"],
    ["sandbox", 16, "STOPPED during [17] a smoke test · sandbox stopped; nothing persists"],
  ] as const)("%s, step index %i in flight: %s", async (network, i, line) => {
    const { words } = await wordsInFlight(network, i);
    expect(words).toBe(line);
    expect(displayWidth(line)).toBeLessThanOrEqual(100);
  });

  it("on a TTY, the progress line (`stopping: …`) is cleared first, so the last words start their own row", async () => {
    const { words, writesBefore, writesByWords } = await wordsInFlight("sandbox", 7, true);
    expect(writesBefore.at(-1)).toBe("\r[08/20] stopping: the step in flight finishes first…");
    expect(writesByWords).toEqual(["\r\x1b[K"]); // the words call clears it, before main writes them
    expect(words).toBe("STOPPED during [08] a refusal attempt · sandbox stopped; nothing persists");
  });

  it("nothing in flight: where the run stopped (as ABORTED numbers it) and what is left", async () => {
    // Sandbox, aborted after [04] printed: a second signal while the generator's finally stops the sandbox.
    const ac = new AbortController();
    let closing: string | undefined;
    const t = terminal({ signal: ac.signal, onOut: abortAfter(ac, 4, 20) });
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps, onFinally: () => (closing = t.words()) });
    expect(await exec(command(f).cmd, ["--sandbox"], t.io)).toBe(130);
    expect(closing).toBe("STOPPED at [05] · sandbox stopped; nothing persists");
    // Testnet, the run done and its evidence being written: after the last step, and the key is burned.
    let writing: string | undefined;
    const t2 = terminal();
    const { cmd } = command(fake({ network: "testnet", steps: HERO_TESTNET }), {
      writeRunArtifacts: async () => {
        writing = t2.words();
        return [];
      },
    });
    expect(await exec(cmd, ["--testnet"], t2.io)).toBe(0);
    expect(writing).toBe(`STOPPED after [14] · session ${SESSION} is burned · nothing to clean up`);
    expect(t2.wordsLog).toEqual(["set", "clear"]);
  });

  it("STEP_TITLES follows the driver's fixed order: one title per step of a real run (T13's), phase by phase", () => {
    expect(STEP_TITLES.map(([phase]) => phase)).toEqual(RUN_SANDBOX.steps.map((s) => s.phase));
  });
});

describe("real signals in a child process (processIo; C-T1b, C-T2c)", () => {
  /** A child node running `demo --sandbox` through processIo, with a fake runDemo: [01] at once, then one step a second. */
  const script = [
    'const { processIo: io } = await import("./src/cli/main.ts");',
    'const { createDemoCommand } = await import("./src/cli/demo.ts");',
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    'const step = (n) => ({ n, total: 5, phase: "setup", label: `step ${n}`, signer: "none", pass: true });',
    "async function* runDemo() {",
    "  try { for (let n = 1; n <= 5; n++) { await sleep(n === 1 ? 0 : 1000); yield step(n); } }",
    '  finally { process.stderr.write("finally\\n"); }',
    '  return { id: "x", network: "sandbox", mode: "live", steps: [1, 2, 3, 4, 5].map(step), durationMs: 0, exitCode: 0, transcriptPath: "" };',
    "}",
    'const cmd = createDemoCommand({ runDemo, writeRunArtifacts: async () => [], rpcUrlFor: () => "http://127.0.0.1:1" });',
    'process.exitCode = await cmd.run(["--sandbox"], io);',
  ].join("\n");

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("%s: the step in flight finishes, the generator closes, ABORTED, exit 130", async (signal) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let sent = false;
    child.stderr.on("data", (d) => (err += String(d)));
    child.stdout.on("data", (d) => {
      out += String(d);
      if (!sent && out.includes("[02/05]")) {
        sent = true;
        child.kill(signal); // only the process this test started
      }
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const timer = setTimeout(() => (child.kill("SIGKILL"), resolve({ code: null, signal: "SIGKILL" })), 15_000);
      child.on("exit", (code, sig) => (clearTimeout(timer), resolve({ code, signal: sig })));
    });
    expect(exit).toEqual({ code: 130, signal: null });
    expect(err).toBe("finally\n");
    const lines = out.trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/^ABORTED at \[0[3-5]\] · sandbox stopped; nothing persists$/);
    const at = Number(/\[0(\d)\]/.exec(lines.at(-1)!)![1]);
    expect(out).toContain(`[${nn(at - 1)}/05] step ${at - 1}`); // the step in flight printed before ABORTED
  });

  // near-sandbox locks its binary with proper-lockfile, which loads signal-exit@3 when the sandbox boots: after our
  // handler. signal-exit's listener re-raises the signal when it finds itself the only listener left, so a handler
  // that removed itself inside the same emit let the first signal kill the process and orphan the sandbox. The second
  // signal is a hard exit: process.exit(130), so the exit hooks run and sandbox.ts's hook SIGKILLs the node (M1).
  //
  // The fake driver below owns a child process (`sleep`) the way runDemo owns near-sandbox: `finally` stops it, and
  // an `exit` hook kills it as sandbox.ts's does. Both launch paths: `node --import tsx` (bin/keyhole.mjs, which
  // registers tsx in-process) and the tsx CLI (`npm run keyhole`: a tsx parent that relays signals to a node child).
  // Signals go to the one pid this test started: the node, or the tsx parent.
  describe("with near-sandbox's signal-exit loaded and a child process to stop (both launch paths)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keyhole-sig-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "demo-child.mts");
    writeFileSync(
      file,
      [
        `const { processIo: io } = await import(${JSON.stringify(join(REPO, "src/cli/main.ts"))});`,
        `const { createDemoCommand } = await import(${JSON.stringify(join(REPO, "src/cli/demo.ts"))});`,
        'const { spawn } = await import("node:child_process");',
        `const onExit = (await import("node:module")).createRequire(${JSON.stringify(join(REPO, "package.json"))})("signal-exit");`,
        "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));",
        'const step = (n: number) => ({ n, total: 5, phase: "setup", label: `step ${n}`, signer: "none", pass: true });',
        "async function* runDemo(): AsyncGenerator<any, any, void> {",
        '  const node = spawn("sleep", ["20"], { stdio: "ignore" });',
        '  process.on("exit", () => node.kill("SIGKILL"));',
        "  onExit(() => {});",
        "  process.stderr.write(`node ${node.pid}\\n`);",
        "  try { for (let n = 1; n <= 5; n++) { await sleep(n === 1 ? 0 : 1000); yield step(n); } }",
        '  finally { node.kill("SIGKILL"); process.stderr.write("finally\\n"); }',
        '  return { id: "x", network: "sandbox", mode: "live", steps: [1, 2, 3, 4, 5].map(step), durationMs: 0, exitCode: 0, transcriptPath: "" };',
        "}",
        'const cmd = createDemoCommand({ runDemo, writeRunArtifacts: async () => [], rpcUrlFor: () => "http://127.0.0.1:1" });',
        'process.exitCode = await cmd.run(["--sandbox"], io);',
      ].join("\n"),
    );
    const entries = {
      node: [process.execPath, "--import", "tsx", file],
      tsx: [process.execPath, join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), file],
    } as const;
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it.each([
      ["node", ["SIGTERM"]],
      ["tsx", ["SIGTERM"]],
      ["tsx", ["SIGINT"]],
      ["node", ["SIGTERM", "SIGTERM"]],
      ["node", ["SIGINT", "SIGTERM"]],
      ["tsx", ["SIGTERM", "SIGTERM"]],
      ["tsx", ["SIGINT", "SIGINT"]],
    ] as const)("%s entry, %j to its pid: exit 130 and the child process is stopped", async (entry, signals) => {
      const [cmd, ...args] = entries[entry];
      const child = spawn(cmd, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let sent = false;
      child.stderr.on("data", (d) => (err += String(d)));
      child.stdout.on("data", (d) => {
        out += String(d);
        if (!sent && out.includes("[02/05]")) {
          sent = true;
          child.kill(signals[0]); // only the process this test started
          if (signals.length > 1) setTimeout(() => child.kill(signals[1]), 300); // past the repeat window, while [03] is still in flight
        }
      });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => (child.kill("SIGKILL"), resolve({ code: null, signal: "SIGKILL" })), 15_000);
        child.on("exit", (code, sig) => (clearTimeout(timer), resolve({ code, signal: sig })));
      });
      expect(exit).toEqual({ code: 130, signal: null });
      const pid = Number(/^node (\d+)$/m.exec(err)?.[1]);
      expect(pid).toBeGreaterThan(0);
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid), `the driver's child ${pid} outlived the CLI`).toBe(false);
      const last = out.trimEnd().split("\n").at(-1);
      if (signals.length === 1) {
        // The soft path: the step in flight prints, finally stops the child, ABORTED.
        expect(err).toContain("finally\n");
        expect(last).toMatch(/^ABORTED at \[0[3-5]\] · sandbox stopped; nothing persists$/);
      } else {
        // The hard path: the second signal ends the wait; the exit hook stops the child; no ABORTED claim, but the
        // last words say what was in flight.
        expect(err).not.toContain("finally");
        expect(out).not.toContain("ABORTED");
        expect(err).toMatch(/^STOPPED during \[03\] the AddKey · sandbox stopped; nothing persists$/m);
      }
    });
  });

  // Testnet, [03]'s AddKey in flight (the fake holds it 3 s), through processIo and main's real handler. A second
  // signal past the repeat window is the hard exit: its last words name [03] and where the key's ID is. A repeat inside
  // the window is the same Ctrl-C: the soft path runs, [03] prints, ABORTED names the session. The group case is a
  // terminal's Ctrl-C under `npm run` where /bin/sh execs tsx: npm forwards it to tsx as well, and tsx relays it to the
  // node child about 30 ms after the child had it from the terminal.
  describe("the hard exit's last words in a child process: testnet, [03] in flight (M1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keyhole-sig-tn-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "demo-testnet.mts");
    writeFileSync(
      file,
      [
        `const { processIo: io } = await import(${JSON.stringify(join(REPO, "src/cli/main.ts"))});`,
        `const { createDemoCommand } = await import(${JSON.stringify(join(REPO, "src/cli/demo.ts"))});`,
        'const { readFileSync } = await import("node:fs");',
        `const run = JSON.parse(readFileSync(${JSON.stringify(join(REPO, "demo", "run.sandbox.json"))}, "utf8"));`,
        "const steps = run.steps.slice(0, 14).map((s: any) => ({ ...s, total: 14 }));",
        "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));",
        "async function* runDemo(): AsyncGenerator<any, any, void> {",
        "  try { for (let i = 0; i < 14; i++) { await sleep(i === 2 ? 3000 : 0); yield steps[i]; } }",
        '  finally { process.stderr.write("finally\\n"); }',
        '  return { ...run, network: "testnet", steps, exitCode: 0, transcriptPath: "demo/transcript.md" };',
        "}",
        'const cmd = createDemoCommand({ runDemo, writeRunArtifacts: async () => [], rpcUrlFor: () => "https://rpc.testnet.near.org" });',
        'process.exitCode = await cmd.run(["--testnet"], io);',
      ].join("\n"),
    );
    const entries = {
      node: [process.execPath, "--import", "tsx", file],
      tsx: [process.execPath, join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), file],
    } as const;
    const STOPPED_03 = "STOPPED during [03] the AddKey · session key may be live · its ID is in ~/.keyhole/sessions\n        · run: keyhole burn ID\n";

    it.each([
      ["node", "SIGTERM, then SIGTERM 300 ms later", "hard", false, ["SIGTERM", "SIGTERM"], 300],
      ["tsx", "SIGINT, then SIGINT 300 ms later", "hard", false, ["SIGINT", "SIGINT"], 300],
      ["node", "SIGTERM, then SIGTERM 10 ms later", "soft", false, ["SIGTERM", "SIGTERM"], 10],
      ["tsx", "SIGINT to the group (a terminal's Ctrl-C), then SIGINT to tsx 3 ms later (npm forwarding it)", "soft", true, ["SIGINT", "SIGINT"], 3],
    ] as const)("%s entry, %s: the %s path", async (entry, _what, path, group, signals, gapMs) => {
      const [cmd, ...args] = entries[entry];
      // A group of its own when the test signals the group: only processes this test started are in it.
      const child = spawn(cmd, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: group, env: { ...process.env, KEYHOLE_HOME: join(homedir(), ".keyhole") } });
      const kill = (sig: NodeJS.Signals, toGroup = false) => (toGroup ? process.kill(-child.pid!, sig) : child.kill(sig));
      let out = "";
      let err = "";
      let sent = false;
      child.stderr.on("data", (d) => (err += String(d)));
      child.stdout.on("data", (d) => {
        out += String(d);
        if (!sent && out.includes("[02/14]")) {
          sent = true;
          kill(signals[0], group);
          setTimeout(() => kill(signals[1]), gapMs);
        }
      });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => (kill("SIGKILL", group), resolve({ code: null, signal: "SIGKILL" })), 15_000);
        child.on("exit", (code, sig) => (clearTimeout(timer), resolve({ code, signal: sig })));
      });
      expect(exit).toEqual({ code: 130, signal: null });
      if (path === "hard") {
        expect(err).toBe(STOPPED_03); // no finally: the exit came first
        expect(out).not.toContain("[03/14]");
        expect(out).not.toContain("ABORTED");
      } else {
        expect(err).toBe("finally\n");
        expect(out).toContain("[03/14]");
        expect(out.trimEnd().split("\n").at(-1)).toBe(aborted("04", SESSION));
      }
    });
  });
});

describe("errors", () => {
  it("an environment error exits 2 with the offline alternative", async () => {
    const error = new EnvironmentError("near-sandbox did not start: spawn ENOENT", "check .sandbox-bin/near-sandbox-2.14.0");
    const f = fake({ network: "sandbox", steps: SPIKE.steps, throwAt: { i: 0, error } });
    const t = terminal();
    expect(await exec(command(f).cmd, ["--sandbox"], t.io)).toBe(2);
    expect(t.err().split("\n")).toEqual([error.line(), OFFLINE_ALTERNATIVE]);
    expect(t.out()).not.toMatch(/^RESULT/m);
  });

  const LANDED = HERO_TESTNET[3].attempt!;
  it.each([
    ["SendFateUnknownError", new SendFateUnknownError("FQ7vAr3TpBN8cyU5o7NM2wWDf1XqJmV1Mo1Jt5CxJyQh", "cosigner.kh-op-021e.testnet", "the node timed out (TIMEOUT_ERROR)")],
    ["LandedUnsettledError", new LandedUnsettledError(LANDED, LANDED.outcome as TxSuccess, new EnvironmentError("tx X: receipt tree incomplete after 20 tx polls", "x"))],
  ])("%s: a transaction was sent, so exit 3 and no offline alternative (C-T2j)", async (_name, error) => {
    expect(error.exitCode).toBe(3);
    const f = fake({ network: "testnet", steps: HERO_TESTNET, throwAt: { i: 1, error } });
    const t = terminal();
    expect(await exec(command(f).cmd, ["--testnet"], t.io)).toBe(3);
    expect(t.err()).toBe(error.line());
  });

  it("[03]'s AddKey fate unknown on testnet (signWrap rethrows it untouched): exit 3, its line, where the key's ID is; no offline alternative, nothing re-sent (I1)", async () => {
    const fate = new SendFateUnknownError("FQ7vAr3TpBN8cyU5o7NM2wWDf1XqJmV1Mo1Jt5CxJyQh", `seat.${OP}`, "the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls");
    const f = fake({ network: "testnet", steps: HERO_TESTNET, throwAt: { i: 2, error: fate } });
    const t = terminal({ env: { KEYHOLE_HOME: join(homedir(), ".keyhole") } });
    expect(await exec(command(f).cmd, ["--testnet"], t.io)).toBe(3);
    expect(t.err().split("\n")).toEqual([fate.line(), keyUnknownHint("~/.keyhole/sessions")]);
    expect(keyUnknownHint("~/.keyhole/sessions")).toBe("session key may be live · its ID is in ~/.keyhole/sessions · run: keyhole burn ID");
    expect(t.err()).not.toContain(OFFLINE_ALTERNATIVE);
    expect(f.log.started).toBe(3); // [03] was asked for once: nothing after it, nothing again (C-T2i)
    expect(f.log.finallyRan).toBe(true);
    expect(t.out()).not.toMatch(/^RESULT/m);
    // The same error on sandbox: exit 3, its line only (nothing persists there, so no key to find).
    const sb = fake({ network: "sandbox", steps: RUN_SANDBOX.steps, throwAt: { i: 2, error: fate } });
    const ts = terminal();
    expect(await exec(command(sb).cmd, ["--sandbox"], ts.io)).toBe(3);
    expect(ts.err()).toBe(fate.line());
  });

  it("an error after [03] on testnet adds the burn hint for the live session (C-T12c)", async () => {
    const error = new EnvironmentError("rpc.testnet.near.org answered HTTP 503 four times", "retry later");
    const f = fake({ network: "testnet", steps: HERO_TESTNET, throwAt: { i: 4, error } });
    const t = terminal();
    expect(await exec(command(f).cmd, ["--testnet"], t.io)).toBe(2);
    expect(t.err().split("\n")).toEqual([error.line(), OFFLINE_ALTERNATIVE, sessionHint(SESSION)]);
    expect(sessionHint(SESSION)).toBe(`session ${SESSION} may still be live · run: keyhole burn ${SESSION}`);
  });

  it("an error that is not Keyhole's prints main's line first, then the burn hint; exit 2 (M5)", async () => {
    const f = fake({ network: "testnet", steps: HERO_TESTNET, throwAt: { i: 7, error: new TypeError("boom") } });
    const t = terminal();
    expect(await exec(command(f).cmd, ["--testnet"], t.io)).toBe(2);
    expect(t.err().split("\n")).toEqual(["ERROR (environment): boom · rerun with DEBUG=1 for a stack trace", sessionHint(SESSION)]);
    // With DEBUG its stack follows the line, still before the hint.
    const g = fake({ network: "testnet", steps: HERO_TESTNET, throwAt: { i: 7, error: new TypeError("boom") } });
    const d = terminal({ env: { DEBUG: "1" } });
    expect(await exec(command(g).cmd, ["--testnet"], d.io)).toBe(2);
    const lines = d.err().split("\n");
    expect(lines[0]).toBe("ERROR (environment): boom · rerun with DEBUG=1 for a stack trace");
    expect(lines[1]).toBe("TypeError: boom");
    expect(lines.at(-1)).toBe(sessionHint(SESSION));
  });

  it("exit codes (C-T2j) and the help text (C-T19a): 3 is listed, EnvironmentError stays 2, no scaffold status", () => {
    expect(new EnvironmentError("a", "b").exitCode).toBe(2);
    const help = helpText(COMMANDS);
    expect(help).toContain("  3    a transaction was sent; look it up on chain before signing again");
    expect(help).toContain("  keyhole demo --sandbox|--testnet [--step]");
    expect(help).not.toMatch(/TODO\(build\)|not built yet|scaffold/);
  });
});

describe("FAIL steps and the early stop", () => {
  it("a FAIL step exits 1 and later steps still print", async () => {
    const steps = SPIKE.steps.map((s, i) => (i === 4 ? { ...s, pass: false, note: failExpected("MethodNameMismatch", "RequiresFullAccess") } : s));
    const t = terminal();
    expect(await exec(command(fake({ network: "sandbox", steps })).cmd, ["--sandbox"], t.io)).toBe(1);
    const lines = t.lines();
    const failAt = lines.indexOf(`        ${failExpected("MethodNameMismatch", "RequiresFullAccess")}`);
    expect(failAt).toBeGreaterThan(0);
    for (let n = 6; n <= 16; n++) expect(lines.findIndex((l) => l.startsWith(`[${nn(n)}/16]`)), `[${n}]`).toBeGreaterThan(failAt);
    expect(lines.find((l) => l.startsWith("RESULT "))).toMatch(/^RESULT 15\/16 PASS · 1 FAIL · 12 protocol refusals · .* · exit 1$/);
  });

  it("an early stop after a failed [01] says so in the log and the transcript (C-T12d)", async () => {
    const first = { ...HERO_TESTNET[0], pass: false, note: "FAIL: the council is not {seat, cosigner}" };
    const f = fake({ network: "testnet", steps: [first] });
    const { cmd, writeRunArtifacts } = command(f);
    const t = terminal({ env: { KEYHOLE_OPERATOR: OP } });
    expect(await exec(cmd, ["--testnet"], t.io)).toBe(1);
    const lines = t.lines();
    expect(lines.slice(-2)).toEqual(["RESULT 0/1 PASS · 1 FAIL · 0 protocol refusals · 1 tx hash · 24s · exit 1 · transcript demo/transcript.md", "run stopped after [01]: no bond, no key"]);
    const transcript = writeRunArtifacts.mock.calls[0][1].transcript!;
    expect(transcript.trimEnd().split("\n").at(-1)).toBe("run stopped after [01]: no bond, no key");
  });
});

describe("--step (TTY only)", () => {
  /**
   * A TTY (or not) whose readLine records, at each call, the last step printed: runDemo has produced the step held
   * for printing, so that is the number of steps produced minus one.
   */
  function stepping(o: { tty: boolean; step: boolean; answer?: () => Promise<string | null> }) {
    const f = fake({ network: "sandbox", steps: RUN_SANDBOX.steps });
    const pauses: string[] = [];
    const readLine = vi.fn(async () => {
      pauses.push(nn(f.log.started - 1));
      return o.answer ? o.answer() : "";
    });
    const t = terminal({ tty: o.tty, rows: 42, readLine });
    return { f, t, readLine, pauses, argv: o.step ? ["--sandbox", "--step"] : ["--sandbox"] };
  }

  it("on a TTY it waits once per beat boundary, never between refusals, then clears the screen; piped it never waits", async () => {
    const s = stepping({ tty: true, step: true });
    expect(await exec(command(s.f).cmd, s.argv, s.t.io)).toBe(0);
    // beats: SETUP · WRAP · IN SCOPE · REFUSALS (+ the chain check) · INSPECT · BURN · SMOKE = 7, so 6 boundaries
    expect(s.readLine).toHaveBeenCalledTimes(6);
    expect(s.pauses).toEqual(["02", "03", "06", "11", "12", "14"]);
    expect(s.t.writes.filter((w) => w === "\n".repeat(42))).toHaveLength(6);
    expect(s.t.writes.filter((w) => w === "\x1b[H")).toHaveLength(6);
    // after the clear, the next beat starts on the top row: its header, no blank line first
    for (const chunk of s.t.stream().split("\x1b[H").slice(1)) expect(stripAnsi(chunk).startsWith("── ")).toBe(true);

    for (const [tty, step] of [[false, true], [true, false]] as const) {
      const p = stepping({ tty, step });
      expect(await exec(command(p.f).cmd, p.argv, p.t.io)).toBe(0);
      expect(p.readLine).not.toHaveBeenCalled();
      expect(p.t.writes.filter((w) => w === "\x1b[H")).toEqual([]);
    }
  });

  it("Ctrl-C at a pause: the step already done prints, then ABORTED, exit 130; end of input runs on without pausing", async () => {
    const ac = new AbortController();
    const s = stepping({ tty: true, step: true, answer: async () => (ac.abort(), null) });
    Object.assign(s.t.io, { signal: ac.signal });
    expect(await exec(command(s.f).cmd, s.argv, s.t.io)).toBe(130);
    expect(s.readLine).toHaveBeenCalledOnce();
    const out = stripAnsi(s.t.out());
    expect(out).toContain("[03/20] seat.sandbox signs one AddKey");
    expect(out.trimEnd().split("\n").at(-1)).toBe(abortedSandbox("04"));
    expect(s.f.log.started).toBe(3);

    const eof = stepping({ tty: true, step: true, answer: async () => null });
    expect(await exec(command(eof.f).cmd, eof.argv, eof.t.io)).toBe(0);
    expect(eof.readLine).toHaveBeenCalledOnce();
    expect(stripAnsi(eof.t.out())).toMatch(/^RESULT 20\/20 PASS/m);
  });
});

describe("--testnet artifacts", () => {
  it("--testnet writes fixtures, run json and transcript under KEYHOLE_DEMO_OUT, before RESULT names the transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "keyhole-demo-out-"));
    tmpRoots.push(root);
    const f = fake({ network: "testnet", steps: HERO_TESTNET });
    let writtenAtResult = false;
    const t = terminal({
      env: { KEYHOLE_DEMO_OUT: root, KEYHOLE_OPERATOR: OP, KEYHOLE_TESTNET_RPC: "https://rpc.testnet.near.org" },
      onOut: (text) => {
        if (text.includes("RESULT ")) writtenAtResult = existsSync(join(root, "demo", "transcript.md"));
      },
    });
    expect(await exec(createDemoCommand({ runDemo: f.runDemo }), ["--testnet"], t.io)).toBe(0);
    expect(writtenAtResult).toBe(true);
    const fixtures = HERO_TESTNET.filter((s) => s.fixture !== undefined);
    expect(fixtures.map((s) => s.fixture)).toEqual([
      "testnet.sputnik-v2.refuse-method.json",
      "testnet.sputnik-v2.refuse-action.json",
      "testnet.sputnik-v2.refuse-receiver.json",
      "testnet.sputnik-v2.refuse-deposit.json",
      "testnet.sputnik-v2.after-burn.json",
    ]);
    for (const s of fixtures) expect(readFileSync(join(root, "demo", "fixtures", s.fixture!), "utf8")).toBe(s.attempt!.outcome.rawRpcJson);
    const saved = JSON.parse(readFileSync(join(root, "demo", "run.testnet.json"), "utf8")) as DemoRun;
    expect(saved).toMatchObject({ network: "testnet", mode: "live", exitCode: 0, transcriptPath: "demo/transcript.md" });
    expect(saved.steps).toEqual(HERO_TESTNET);
    const md = readFileSync(join(root, "demo", "transcript.md"), "utf8");
    expect(md).toContain("- network: testnet");
    expect(md).toContain("- RPC: `https://rpc.testnet.near.org`");
    expect(md).toContain(`- operator: \`${OP}\``);
    expect(md).toContain("| [03/14] seat.sandbox signs one AddKey: act_proposal only · gas allowance 0.0500 NEAR | full access |"); // C-T12b
    expect(md).toContain("| [04/14] the session approves #0 (grant payout) | session |");
    expect(md).toMatch(/^RESULT 14\/14 PASS · 5 protocol refusals · .* · exit 0 · transcript demo\/transcript\.md$/m);
    expect(t.lines().at(-1)).toMatch(/^RESULT 14\/14 PASS .* · transcript demo\/transcript\.md$/);
  });

  it("a failed write: RESULT without the transcript claim, the error, exit 1", async () => {
    const error = new EnvironmentError("cannot write /ro/demo/run.testnet.json (EACCES)", "check the output directory and its permissions");
    const f = fake({ network: "testnet", steps: HERO_TESTNET });
    const t = terminal();
    expect(await exec(command(f, { writeRunArtifacts: async () => Promise.reject(error) }).cmd, ["--testnet"], t.io)).toBe(1);
    // RESULT states the exit code the process returns (M2), and no transcript it did not write.
    expect(t.lines().at(-1)).toMatch(/^RESULT 14\/14 PASS · 5 protocol refusals · .* · exit 1$/);
    expect(t.err()).toBe(error.line());
  });
});
