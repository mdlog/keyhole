/**
 * Argument parsing shared by the five commands. Input errors exit 2 with nothing signed.
 */
import { parseArgs } from "node:util";
import { parseNearAmount } from "near-api-js";
import { InputError } from "../core/errors.js";
import { isSessionId } from "../core/session.js";

/** A command's terminal. processIo (src/cli/main.ts) fills every member; tests set the ones they need. */
export interface Io {
  /** A line to stdout. */
  out(text: string): void;
  /** A line to stderr. */
  err(text: string): void;
  /** Text to stdout with no newline added (prompts, progress lines). */
  write?(text: string): void;
  stdout?: { isTTY?: boolean; columns?: number; rows?: number };
  stdinIsTTY?: boolean;
  /** One stdin line without its newline; null at end of input or once `signal` aborts (`signal?.aborted` tells which). */
  readLine?(): Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  /**
   * Aborted on Ctrl-C (SIGINT), SIGTERM or SIGHUP: the command cleans up, then returns 130. A second signal (processIo;
   * a repeat within 100 ms is the same Ctrl-C) exits at once, 130, through the exit hooks: the hard exit.
   */
  signal?: AbortSignal;
  /**
   * Sets what the hard exit writes on stderr before exit 130 (processIo: synchronously, as it exits), or clears it with
   * undefined. A command sets it while a step or a send is in flight and clears it when it returns. Called once, at the
   * hard exit: one line of ours (broken at ` · ` to fit), naming what was cut short and what is left to do.
   */
  lastWords?(words: (() => string) | undefined): void;
}

export interface Command {
  name: "wrap" | "serve" | "inspect" | "burn" | "demo";
  /** Arguments after the command name, LAYOUT notation (UPPERCASE placeholders). */
  args: string;
  /** Navigation "Global header": the keys this command loads. */
  keys: string;
  run(argv: string[], io: Io): Promise<number>;
}

type Options = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;

/** node:util parseArgs in strict mode; unknown flags and missing values become input errors. */
export function parseOrThrow<O extends Options>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new InputError([(e as Error).message]);
  }
}

/** `0.05N`, `0.05NEAR` or `0.05` (NEAR, up to 24 decimals) → yoctoNEAR; null if malformed. */
export function parseAmountYocto(s: string): bigint | null {
  const m = /^\s*(\d+(?:\.\d{1,24})?)\s*(?:N|NEAR)?\s*$/i.exec(s);
  if (!m) return null;
  const yocto = parseNearAmount(m[1] as `${number}`); // validated by the regex above
  return yocto === null ? null : BigInt(yocto);
}

/** Commands that take exactly one session ID (serve, inspect, burn). Returns the id, or null after --help. */
export function sessionIdArg(cmd: Command, argv: string[], io: Io): string | null {
  const { values, positionals } = parseOrThrow(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    io.out(commandUsage(cmd));
    return null;
  }
  if (positionals.length !== 1) throw new InputError([`${cmd.name} takes exactly one session ID (usage: keyhole ${cmd.name} ${cmd.args})`]);
  const id = positionals[0];
  if (!isSessionId(id)) throw new InputError([`not a session id: ${JSON.stringify(id)} (expected ks- and 4 lowercase hex digits, e.g. ks-7f3a)`]);
  return id;
}

export function commandUsage(cmd: Command): string {
  return [`usage: keyhole ${cmd.name} ${cmd.args}`, `keys:  ${cmd.keys}`].join("\n");
}
