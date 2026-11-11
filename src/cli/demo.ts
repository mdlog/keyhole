/**
 * R4 `keyhole demo --sandbox|--testnet [--step]`: runs the scripted driver (runDemo) and prints its step log, the
 * WOW hero. Exactly one network flag; there is no default network.
 *
 * Output (LAYOUT R4):
 * - Style `beat` on a TTY (the video), `full` when piped; caps from termCaps(io.stdout, io.env).
 * - Header `KEYHOLE demo · NET · mode live · pack sputnik-v2 · on-account · rpc ORIGIN`, before the first step: on
 *   testnet at once, on sandbox when [01] arrives (the node's port is chosen at boot). The RPC prints as its origin
 *   only, because a configured URL can carry an API key in its user info, path or query.
 * - Progress (TTY only), written in place with `\r` and cleared with `\r\x1b[K` before the next print:
 *   `booting near-sandbox… Ns` each second until [01] arrives on sandbox, else `[NN/TT] waiting for RPC…` once a step
 *   has taken 1 s.
 * - `--step` (TTY only; ignored when piped): when the next step starts a new beat, wait for one stdin line, then
 *   scroll the screen clear (`rows` newlines, `\x1b[H`) so the beat starts on the top row. The finished beat stays on
 *   screen while it waits, and the newline typed to continue cannot push the next beat down a row. The step is
 *   already done when the pause starts, so the pause holds no unsent transaction and is never between refusals.
 * - End: on --testnet the run's evidence (fixtures, run.testnet.json, transcript.md) is written under
 *   `<KEYHOLE_DEMO_OUT or the repo>/demo` before RESULT names the transcript. Exit run.exitCode.
 *
 * Ctrl-C, SIGTERM and SIGHUP abort through io.signal (read when the command starts: C-T1b; SIGTERM and SIGHUP:
 * C-T2c). Nothing already sent is abandoned: a step in flight finishes and is printed; then the driver is closed,
 * and its `finally` stops the sandbox. One ABORTED line then says what is left. On sandbox that is nothing. On
 * testnet it is the live session and `keyhole burn ID` (C-T12c), or that no key was added, or that the key is
 * burned, or that a key may be live under an id the run never showed (where to find it). Exit 130.
 *
 * A second signal (a repeat within 100 ms is the same Ctrl-C) is the hard exit (src/cli/main.ts): main writes this
 * run's last words on stderr, then exits 130 through the exit hooks, which stop a running near-sandbox. One line of
 * ours: `STOPPED during [NN] TITLE` for the step in flight (else `at [NN]`, as ABORTED numbers it, or `after [NN]`
 * once the last step is done), then what is left: on sandbox that it stopped; on testnet the session and
 * `keyhole burn ID`, where the ID is if the key may have been added under one the run never showed, or that no key
 * was added or that it is burned. Nothing about the step in flight is printed, since it never finished.
 *
 * Errors: the error's own line first, verbatim (main's wording for one that is not Keyhole's), then:
 * - an EnvironmentError: OFFLINE_ALTERNATIVE, exit 2;
 * - a transaction that was sent and is not settled (SendFateUnknownError, LandedUnsettledError, signWrap's kept
 *   AddKey): nothing more, exit 3 (C-T2j). Nothing is re-sent;
 * - anything else: exit 2 (a KeyholeError: its own code).
 * On testnet a hint about the session key follows when one may be live: `keyhole burn ID`, or where the ID is
 * (C-T12c). Lines of ours (ABORTED, the hints) break at ` · ` to fit the terminal.
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import { rpcUrlFor, sessionsDir } from "../core/config.js";
import { EXIT_TX_SENT, EnvironmentError, InputError, KeyholeError } from "../core/errors.js";
import type { DemoPhase, DemoRun, DemoStep, Network } from "../core/types.js";
import { demoArtifactPaths, writeRunArtifacts } from "../demo/artifacts.js";
import { HERO_STEPS, SANDBOX_SMOKE_STEPS, runDemo } from "../demo/driver.js";
import { beatOf, createStepPrinter } from "../render/demo-log.js";
import { type Span, nn, packSegments, paint } from "../render/refusal-block.js";
import { OFFLINE_ALTERNATIVE, aborted, abortedSandbox } from "../render/strings.js";
import { glyphs, neutralizeControls } from "../render/style.js";
import { type TermCaps, termCaps } from "../render/term.js";
import { renderTranscript } from "../render/transcript.js";
import { type Command, type Io, commandUsage, parseOrThrow } from "./args.js";
import { Progress } from "./progress.js";

/** What `demo` calls. Tests replace any of them. */
export interface DemoDeps {
  runDemo: typeof runDemo;
  writeRunArtifacts: typeof writeRunArtifacts;
  rpcUrlFor: typeof rpcUrlFor;
}

/** Testnet, before [03] added the session key. */
const NO_KEY_LEFT = "no session key was added · nothing to burn";
/** Testnet, after [13] burned the session key. */
const burnedLeft = (id: string): string => `session ${id} is burned · nothing to clean up`;
/** Sandbox, once the run stops (abortedSandbox's words). */
const SANDBOX_LEFT = "sandbox stopped; nothing persists";
/** Aborted on testnet before [03] added the session key. */
export const abortedNoKey = (n: string): string => `ABORTED at [${n}] · ${NO_KEY_LEFT}`;
/** Aborted on testnet after [13] burned the session key. */
export const abortedBurned = (n: string, id: string): string => `ABORTED at [${n}] · ${burnedLeft(id)}`;
/** A key may have been added whose session id the run did not show ([03] failed after its send). */
export const keyUnknownHint = (dir: string): string => `session key may be live · its ID is in ${dir} · run: keyhole burn ID`;
/** Aborted on testnet after a key may have been added whose session id the run did not show (99 cells at ~/.keyhole). */
export const abortedKeyUnknown = (n: string, dir: string): string => `ABORTED at [${n}] · ${keyUnknownHint(dir)}`;
/** Added to an error once a testnet session key exists (C-T12c). */
export const sessionHint = (id: string): string => `session ${id} may still be live · run: keyhole burn ${id}`;

/** The hero adds the session key in [03] (the driver's fixed order). */
const WRAP_STEP = 3;

/**
 * What the driver's step [NN] does, with its phase, in the driver's fixed order (src/demo/driver.ts: the hero
 * [01]–[14], then smoke [15]–[20] on sandbox). A step's own label exists only once it is yielded, so the hard exit's
 * last words name the step in flight by this. Pinned against the phases of a real run (test/cli-demo.test.ts).
 */
export const STEP_TITLES: ReadonlyArray<readonly [DemoPhase, string]> = [
  ["setup", "the DAO"],
  ["setup", "the proposals"],
  ["wrap", "the AddKey"],
  ["in-scope", "a session vote"],
  ["in-scope", "a cosigner vote"],
  ["in-scope", "a session vote"],
  ...Array.from({ length: 4 }, () => ["refusals", "a refusal attempt"] as const),
  ["chain-check", "the chain check"],
  ["inspect", "the inspect"],
  ["burn", "the DeleteKey"],
  ["burn", "the after-burn attempt"],
  ...Array.from({ length: 6 }, () => ["smoke", "a smoke test"] as const),
];
/** The indent of a continuation row of a line of ours: under the text, after `ABORTED `. */
const HANG = " ".repeat(8);
const PACK = "sputnik-v2";
const MODE = "on-account";

export function createDemoCommand(overrides: Partial<DemoDeps> = {}): Command {
  const d: DemoDeps = { runDemo, writeRunArtifacts, rpcUrlFor, ...overrides };
  const cmd: Command = {
    name: "demo",
    args: "--sandbox|--testnet [--step]",
    keys: "demo accounts only",
    async run(argv, io) {
      const { values, positionals } = parseOrThrow(argv, {
        sandbox: { type: "boolean" },
        testnet: { type: "boolean" },
        step: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      });
      if (values.help) {
        io.out(commandUsage(cmd));
        return 0;
      }
      const problems: string[] = [];
      if (positionals.length) problems.push(`demo takes no positional arguments, got ${positionals.map((p) => JSON.stringify(p)).join(" ")}`);
      if (Boolean(values.sandbox) === Boolean(values.testnet)) problems.push("demo needs exactly one of --sandbox or --testnet (there is no default network)");
      if (problems.length) throw new InputError(problems);
      // C-T1b: read the signal now. processIo installs its SIGINT/SIGTERM/SIGHUP handler on this first read, so a
      // signal from here on aborts the run instead of killing the process (and a running near-sandbox with it).
      const signal = io.signal;
      return new DemoRunner(d, io, values.sandbox ? "sandbox" : "testnet", values.step === true, signal).run();
    },
  };
  return cmd;
}

export const demo: Command = createDemoCommand();

/** Whether a run on `network` writes its evidence (fixtures, run json, transcript): testnet only; sandbox persists nothing. */
const writesArtifacts = (network: Network): boolean => network === "testnet";

/** What the steps printed so far say: the last one, and the testnet session's id and state. */
interface Seen {
  last?: DemoStep;
  wrapped: boolean;
  sessionId?: string;
  burned: boolean;
}

type Next = IteratorResult<DemoStep, DemoRun>;

/** One `demo` run: the driver's steps printed as they arrive, with progress, --step pauses and the abort path. */
class DemoRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly caps: TermCaps;
  private readonly printer: ReturnType<typeof createStepPrinter>;
  private readonly progress: Progress;
  private readonly startedAt = new Date().toISOString();
  private readonly seen: Seen = { wrapped: false, burned: false };
  private readonly aborted: Promise<"abort">;
  private gen: AsyncGenerator<DemoStep, DemoRun, void> | undefined;
  /** The step whose chain work is running, until it is yielded or fails: what the hard exit names. */
  private inFlight: number | undefined;
  /** The last step started: from [03] on, a key may exist even if no step showed its id. */
  private started = 0;
  private rpc: string | undefined;
  private headerShown = false;
  private screenCleared = false;
  private pausing: boolean;

  constructor(
    private readonly d: DemoDeps,
    private readonly io: Io,
    private readonly network: Network,
    step: boolean,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.env = io.env ?? process.env;
    this.caps = termCaps(io.stdout ?? {}, this.env);
    // Only a testnet run is written (end()); a sandbox run's refusal blocks name no fixture file (final review M3).
    this.printer = createStepPrinter({ caps: this.caps, style: this.caps.tty ? "beat" : "full", network, mode: "live", saved: writesArtifacts(network) });
    this.progress = new Progress(io, this.caps);
    this.pausing = step && this.caps.tty && io.readLine !== undefined;
    this.aborted = new Promise((resolve) => {
      if (!signal) return;
      if (signal.aborted) resolve("abort");
      else signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
  }

  async run(): Promise<number> {
    if (this.network === "testnet") this.printHeader(); // its RPC is known before anything runs
    const gen = this.d.runDemo({ network: this.network, env: this.env });
    this.gen = gen;
    this.io.lastWords?.(() => this.lastWords());
    try {
      for (;;) {
        if (this.signal?.aborted) return await this.abort();
        const n = this.nextNumber();
        const ell = glyphs(this.caps).ellipsis;
        if (this.network === "sandbox" && this.seen.last === undefined) this.progress.every((secs) => `booting near-sandbox${ell} ${secs}s`);
        else this.progress.after(`[${nn(n)}/${nn(this.total())}] waiting for RPC${ell}`);
        this.inFlight = this.started = n;
        const pending = gen.next();
        const r = await Promise.race([pending.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })), this.aborted]);
        this.progress.stop();
        if (r === "abort") return await this.abort(pending); // still in flight: abort waits for it
        this.inFlight = undefined;
        if (!r.ok) {
          if (this.signal?.aborted) return await this.abort(pending);
          throw r.e;
        }
        if (r.v.done) return await this.end(r.v.value);
        const s = r.v.value;
        if (this.pausing && this.seen.last !== undefined && beatOf(s.phase) !== beatOf(this.seen.last.phase)) {
          if (!(await this.pause())) {
            this.print(s); // it happened: show it before saying what is left
            return await this.abort();
          }
        }
        this.print(s);
      }
    } catch (e) {
      return await this.fail(e);
    } finally {
      this.progress.stop();
      this.io.lastWords?.(undefined);
    }
  }

  // -- printing ------------------------------------------------------------------------------------------

  private total(): number {
    return this.seen.last?.total ?? HERO_STEPS + (this.network === "sandbox" ? SANDBOX_SMOKE_STEPS : 0);
  }

  private nextNumber(): number {
    return (this.seen.last?.n ?? 0) + 1;
  }

  /** The RPC origin the header and the transcript show. */
  private rpcShown(): string {
    if (this.rpc === undefined) {
      try {
        this.rpc = origin(this.d.rpcUrlFor(this.network, this.env));
      } catch {
        this.rpc = "not known";
      }
    }
    return this.rpc;
  }

  private printHeader(): void {
    if (this.headerShown) return;
    this.headerShown = true;
    const segments: Span[][] = [[["KEYHOLE demo", "bold"]], [[this.network]], [["mode live"]], [[`pack ${PACK}`]], [[MODE]], [[`rpc ${this.rpcShown()}`]]];
    for (const row of packSegments(segments, this.caps.width, "", " ".repeat("KEYHOLE demo ".length))) this.io.out(paint(this.caps, row));
  }

  private print(s: DemoStep): void {
    this.progress.clear();
    this.printHeader();
    let chunk = this.printer.step(s);
    // After a --step clear the beat starts on the top row: no blank line above its header.
    if (this.screenCleared && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.screenCleared = false;
    this.io.out(chunk);
    this.remember(s);
  }

  private remember(s: DemoStep): void {
    const seen = this.seen;
    seen.last = s;
    if (s.phase === "wrap") seen.wrapped = true;
    const id = s.card?.session.id ?? s.attempt?.sessionId ?? (s.phase === "wrap" ? /\bks-[0-9a-f]{4}\b/.exec(s.note ?? "")?.[0] : undefined);
    if (id !== undefined && id !== seen.sessionId) {
      seen.sessionId = id;
      seen.burned = false;
    }
    // [13]: the full-access DeleteKey of the session's key, and it passed.
    if (s.phase === "burn" && s.signer === "operator" && s.pass) seen.burned = true;
  }

  /** --step: wait for a line between beats, then clear the screen. False when the wait ended in an abort. */
  private async pause(): Promise<boolean> {
    this.progress.clear();
    const line = await this.io.readLine!();
    if (this.signal?.aborted) return false;
    if (line === null) {
      this.pausing = false; // end of input: run on without pausing
      return true;
    }
    if (this.io.write) {
      this.io.write("\n".repeat(this.io.stdout?.rows ?? 30));
      this.io.write("\x1b[H");
      this.screenCleared = true;
    }
    return true;
  }

  // -- the three ways a run ends -------------------------------------------------------------------------

  /** The run returned: on testnet its evidence is written first, then RESULT (which names the transcript). */
  private async end(run: DemoRun): Promise<number> {
    this.progress.clear();
    this.printHeader(); // a run with no step still says where it ran
    let shown = run;
    let writeError: unknown;
    if (writesArtifacts(this.network)) {
      try {
        const transcript = renderTranscript(run, { rpc: this.rpcShown(), operator: this.env.KEYHOLE_OPERATOR ?? "not set", startedAt: this.startedAt });
        await this.d.writeRunArtifacts(run, { ...demoArtifactPaths("testnet", this.env), transcript });
      } catch (e) {
        writeError = e;
        // RESULT names no transcript that was not written, and states the exit code the process returns (M2): 1,
        // not 2 ("nothing was signed"), because the chain part has run; the run's evidence is what is missing.
        shown = { ...run, transcriptPath: "", exitCode: 1 };
      }
    }
    this.io.out(this.printer.result(shown));
    if (writeError === undefined) return run.exitCode;
    this.io.err(errorLine(writeError));
    return shown.exitCode;
  }

  /**
   * Ctrl-C (or SIGTERM / SIGHUP). A step in flight finishes and prints (a sent transaction is never abandoned);
   * then the driver is closed, so its `finally` stops the sandbox before ABORTED is printed. Exit 130.
   */
  private async abort(pending?: Promise<Next>): Promise<number> {
    this.progress.stop();
    const n = this.nextNumber();
    let error: unknown;
    if (pending) {
      this.progress.show(`[${nn(n)}/${nn(this.total())}] stopping: the step in flight finishes first${glyphs(this.caps).ellipsis}`);
      try {
        const r = await pending;
        this.inFlight = undefined;
        if (r.done) return await this.end(r.value); // it ended as the signal came: nothing was cut short
        this.print(r.value);
      } catch (e) {
        this.inFlight = undefined;
        error = e;
      }
    }
    await this.close();
    this.progress.clear();
    if (error !== undefined) this.io.err(errorLine(error));
    for (const row of this.fit(this.abortLine(nn(this.nextNumber()), error !== undefined))) this.io.out(row);
    return 130;
  }

  private abortLine(at: string, failedInFlight: boolean): string {
    if (this.network === "sandbox") return abortedSandbox(at);
    const { sessionId, burned, wrapped } = this.seen;
    if (sessionId !== undefined) return burned ? abortedBurned(at, sessionId) : aborted(at, sessionId);
    // [03] ran without showing its id, or the step that failed in flight was [03] or later.
    if (wrapped || (failedInFlight && Number(at) >= WRAP_STEP)) return abortedKeyUnknown(at, homeRelative(sessionsDir(this.env)));
    return abortedNoKey(at);
  }

  /**
   * An error from the driver (or from printing): close the driver, then report it. The error's line comes first,
   * verbatim, then the offline alternative (an EnvironmentError that sent nothing), then the session-key hint (M5).
   */
  private async fail(e: unknown): Promise<number> {
    this.progress.stop();
    await this.close();
    this.progress.clear();
    this.io.err(errorLine(e));
    if (this.env.DEBUG && e instanceof Error && e.stack) this.io.err(e.stack);
    // A sent transaction is not an environment to route around: its line says to look it up first (C-T2j).
    const sent = e instanceof KeyholeError && e.exitCode === EXIT_TX_SENT;
    if (e instanceof EnvironmentError && !sent) this.io.err(OFFLINE_ALTERNATIVE);
    const hint = this.keyHint(sent);
    if (hint !== undefined) for (const row of this.fit(hint)) this.io.err(row);
    return e instanceof KeyholeError ? e.exitCode : 2; // 2: main's code for an error that is not Keyhole's
  }

  /**
   * What to do about a testnet session key that may be live after an error: `keyhole burn ID` for the session the
   * run showed, or where to find the ID when the key may have been added under one it never showed ([03] sent its
   * AddKey and its fate is unknown, C-T2j). None on sandbox, where nothing persists, and none once it is burned.
   */
  private keyHint(sent: boolean): string | undefined {
    if (this.network !== "testnet") return undefined;
    const { sessionId, burned, wrapped } = this.seen;
    if (sessionId !== undefined) return burned ? undefined : sessionHint(sessionId);
    if (wrapped || (sent && this.nextNumber() >= WRAP_STEP)) return keyUnknownHint(homeRelative(sessionsDir(this.env)));
    return undefined;
  }

  /**
   * The hard exit's line (main writes it on stderr, then exits 130): the step in flight, else where the run stopped,
   * then what is left (see the header). The progress line is cleared first, so the line starts its own row.
   */
  private lastWords(): string {
    this.progress.stop();
    this.progress.clear();
    const n = this.inFlight;
    const title = n === undefined ? undefined : STEP_TITLES[n - 1]?.[1];
    const where =
      n !== undefined
        ? `during [${nn(n)}]${title === undefined ? "" : ` ${title}`}`
        : this.nextNumber() > this.total()
          ? `after [${nn(this.total())}]`
          : `at [${nn(this.nextNumber())}]`;
    return this.fit(`STOPPED ${where} · ${this.network === "sandbox" ? SANDBOX_LEFT : this.keyLeft()}`).join("\n");
  }

  /** Testnet, at the hard exit: the session to burn, where its ID is (a key may exist under an ID never shown), or none. */
  private keyLeft(): string {
    const { sessionId, burned } = this.seen;
    if (sessionId !== undefined) return burned ? burnedLeft(sessionId) : sessionHint(sessionId);
    if (this.started >= WRAP_STEP) return keyUnknownHint(homeRelative(sessionsDir(this.env)));
    return NO_KEY_LEFT;
  }

  /** A line of ours, broken at its ` · ` to fit the terminal (C-T8b, M3); continuation rows hang under it. */
  private fit(text: string): string[] {
    return packSegments(text.split(" · ").map((part): Span[] => [[part]]), this.caps.width, "", HANG).map((row) => paint(this.caps, row));
  }

  /** Closes the driver: its `finally` runs (the sandbox stops). It waits for a step in flight, never abandons it. */
  private async close(): Promise<void> {
    await this.gen?.return(undefined as unknown as DemoRun).catch(() => undefined);
  }
}

/** The single line a KeyholeError prints; main's wording for anything else. */
function errorLine(e: unknown): string {
  if (e instanceof KeyholeError) return e.line();
  const message = e instanceof Error ? e.message : String(e);
  return `ERROR (environment): ${neutralizeControls(message)} · rerun with DEBUG=1 for a stack trace`;
}

/** `https://host:port` of an RPC URL: no user info, path or query, which can hold an API key. */
function origin(url: string): string {
  try {
    const u = new URL(url);
    return neutralizeControls(`${u.protocol}//${u.host}`);
  } catch {
    return "not a URL";
  }
}

/** A path under the home directory as `~/…`. */
function homeRelative(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
