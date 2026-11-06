/**
 * Command dispatch and the single error handler (LAYOUT "Command and file patterns"):
 * `ERROR (environment): what failed · what to try`; stack traces only when DEBUG is set.
 */
import { writeSync } from "node:fs";
import { type Interface, createInterface } from "node:readline";
import { KeyholeError } from "../core/errors.js";
import type { Command, Io } from "./args.js";
import { burn } from "./burn.js";
import { demo } from "./demo.js";
import { helpText } from "./help.js";
import { inspect } from "./inspect.js";
import { serve } from "./serve.js";
import { wrap } from "./wrap.js";

/** Lifecycle order: wrap, serve, inspect, burn, then demo. One bin, five subcommands, no aliases. */
export const COMMANDS: readonly Command[] = [wrap, serve, inspect, burn, demo];

/**
 * stdin as lines, through one node:readline interface for the whole process, so lines that arrive
 * together are queued, never dropped. While no read is pending, stdin is paused and unref'd: an open
 * stdin (a TTY never ends) does not keep the process alive. `terminal: false` leaves the TTY in cooked
 * mode, so Ctrl-C stays a SIGINT. Once the abort signal fires (Ctrl-C, SIGTERM, SIGHUP), every read returns null at once.
 */
let stdinLines: { rl: Interface; queue: string[]; waiting: Array<(line: string | null) => void>; closed: boolean } | undefined;

function readStdinLine(): Promise<string | null> {
  if (sigint?.signal.aborted) return Promise.resolve(null);
  if (!stdinLines) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const state = { rl, queue: [] as string[], waiting: [] as Array<(line: string | null) => void>, closed: false };
    rl.on("line", (line) => {
      const reader = state.waiting.shift();
      if (reader) reader(line);
      else state.queue.push(line);
      if (state.waiting.length === 0) {
        rl.pause();
        process.stdin.unref?.();
      }
    });
    rl.on("close", () => {
      state.closed = true;
      for (const reader of state.waiting.splice(0)) reader(null);
    });
    stdinLines = state;
  }
  const state = stdinLines;
  const queued = state.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (state.closed) return Promise.resolve(null);
  return new Promise((resolve) => {
    state.waiting.push(resolve);
    process.stdin.ref?.();
    state.rl.resume();
  });
}

let sigint: AbortController | undefined;

/** What the hard exit writes before exit 130: set by the running command through Io.lastWords. */
let lastWords: (() => string) | undefined;

/**
 * The signals that take the Ctrl-C path (C-T2c). near-sandbox's exit hook does not run when the process dies of a
 * signal, so SIGTERM and SIGHUP abort like SIGINT: the command stops its run, the sandbox is stopped, exit 130. A
 * second one exits at once, still through the exit hooks (sigintSignal).
 */
const ABORT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * A repeat signal this soon after the first is the same Ctrl-C delivered twice, not a second one: under `npm run` a
 * terminal's Ctrl-C reaches tsx's parent from the terminal and again from npm (where /bin/sh execs the script), and
 * tsx relays to its node child a signal the child has not acknowledged within 30 ms, so the child can get one Ctrl-C
 * twice, about 30 ms apart. 100 ms: past that relay, and still well under a person's second key press.
 */
export const REPEAT_SIGNAL_WINDOW_MS = 100;

/**
 * What one Ctrl-C, SIGTERM or SIGHUP does: the first aborts `controller`; a repeat within REPEAT_SIGNAL_WINDOW_MS of
 * the first is ignored (measured from the first, so repeats cannot extend the window); any later one is `hardExit`.
 */
export function abortSignalHandler(controller: AbortController, hardExit: () => void, now: () => number = () => performance.now()): () => void {
  let firstAt = 0;
  return () => {
    if (!controller.signal.aborted) {
      firstAt = now();
      controller.abort();
    } else if (now() - firstAt >= REPEAT_SIGNAL_WINDOW_MS) {
      hardExit();
    }
  };
}

/**
 * The hard exit: the command's last words (the step in flight, a key that may be live, what to run), written
 * synchronously on stderr so they are not lost on exit, then exit 130 through the exit hooks.
 */
function hardExit(): void {
  try {
    const words = lastWords?.();
    if (words) writeSync(2, `${words}\n`);
  } catch {
    // Nothing must stop the exit: it is what stops a running near-sandbox.
  }
  process.exit(130);
}

/**
 * Aborted by the first Ctrl-C, SIGTERM or SIGHUP. The handler is installed on first use, so importing this module
 * has no side effect, and it stays installed. A repeat signal of any of the three within REPEAT_SIGNAL_WINDOW_MS is the
 * same Ctrl-C; after that, one is the hard exit: the command's last words, then `process.exit(130)`, without waiting
 * for the command to clean up.
 *
 * Why never a death by signal (M1): Node runs `exit` hooks on process.exit, never on a death by signal, and an exit
 * hook is how a running near-sandbox is stopped when the run cannot finish (sandbox.ts SIGKILLs its node in one).
 * It is also why the handler is never removed: near-sandbox's proper-lockfile loads signal-exit@3 when a sandbox
 * boots, so its listener sits after ours, and it re-raises the signal (a death by signal: no `finally`, no exit
 * hook, the node orphaned) whenever it finds itself the only listener left.
 */
function sigintSignal(): AbortSignal {
  if (!sigint) {
    const controller = new AbortController();
    // Registered before any caller can add its own listener, so pending reads settle first.
    controller.signal.addEventListener("abort", releaseStdin, { once: true });
    const onSignal = abortSignalHandler(controller, hardExit);
    for (const name of ABORT_SIGNALS) process.on(name, onSignal);
    sigint = controller;
  }
  return sigint.signal;
}

/** On abort: settle every pending read with null and let go of stdin, so the process can exit. */
function releaseStdin(): void {
  if (!stdinLines) return;
  for (const reader of stdinLines.waiting.splice(0)) reader(null);
  stdinLines.rl.pause();
  process.stdin.unref?.();
}

/**
 * The real terminal. Members are read at use time, never at import. `lastWords` sets what the hard exit writes.
 * `signal` (aborted by Ctrl-C, SIGTERM or SIGHUP; a command that runs until stopped returns 130 once it has cleaned
 * up) is a non-enumerable getter:
 * a spread copy (`{ ...processIo, out: processIo.err }`) neither installs the SIGINT handler nor carries
 * `signal`; a derived Io that needs it adds `get signal() { return processIo.signal; }`.
 */
export const processIo: Io = Object.defineProperty(
  {
    out: (text: string) => void process.stdout.write(`${text}\n`),
    err: (text: string) => void process.stderr.write(`${text}\n`),
    write: (text: string) => void process.stdout.write(text),
    get stdout() {
      return process.stdout;
    },
    get stdinIsTTY() {
      return process.stdin.isTTY === true;
    },
    readLine: readStdinLine,
    get env() {
      return process.env;
    },
    lastWords: (words: (() => string) | undefined) => {
      lastWords = words;
    },
  } satisfies Io,
  "signal",
  { get: sigintSignal, enumerable: false },
);

export async function main(argv: string[], io: Io = processIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--help" || name === "-h" || name === "help") {
    io.out(helpText(COMMANDS));
    return 0;
  }
  if (name === undefined) {
    io.err(helpText(COMMANDS));
    return 2;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    io.err(`ERROR (input): unknown command ${JSON.stringify(name)} · run: keyhole --help`);
    return 2;
  }
  try {
    return await cmd.run(rest, io);
  } catch (e) {
    const debug = Boolean(env.DEBUG);
    if (e instanceof KeyholeError) {
      io.err(e.line());
      if (debug && e.stack) io.err(e.stack);
      return e.exitCode;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    io.err(`ERROR (environment): ${err.message} · rerun with DEBUG=1 for a stack trace`);
    if (debug && err.stack) io.err(err.stack);
    return 2;
  }
}
