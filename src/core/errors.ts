/**
 * Error classes carry their exit code (LAYOUT "Command and file patterns" → Exit codes):
 *   0 success · 1 FAIL step, declined confirm, burned or unknown session · 2 environment or input error, nothing signed
 *   3 a transaction was sent and what became of it is not settled (SendFateUnknownError, LandedUnsettledError,
 *     TxSentError): look it up on chain before signing again (C-T2j) · 130 Ctrl-C (or SIGTERM / SIGHUP)
 */

/** The exit code of an error raised after a transaction was sent (exit 2 promises that nothing was signed). */
export const EXIT_TX_SENT = 3;

export abstract class KeyholeError extends Error {
  abstract readonly exitCode: number;
  /** The single line the CLI prints for this error. */
  abstract line(): string;
}

const stubs = new Set<string>();

/**
 * Called at module load by every unbuilt function, whose body then throws `new NotImplementedError(name)`.
 * Building the function means deleting both lines. test/contract.test.ts calls every registered stub,
 * and the demo-ready gate expects unbuiltNames() to be empty.
 */
export function registerStub(name: string): void {
  stubs.add(name);
}

/** The stubs registered by the modules loaded so far (a copy). */
export function unbuiltNames(): ReadonlySet<string> {
  return new Set(stubs);
}

/** Thrown by every scaffold stub. Prints `not built yet: WHAT (scaffold stub)` and exits 2. */
export class NotImplementedError extends KeyholeError {
  readonly exitCode = 2;
  constructor(readonly what: string) {
    super(`not built yet: ${what} (scaffold stub)`);
    this.name = "NotImplementedError";
  }
  line(): string {
    return this.message;
  }
}

/**
 * Bad arguments or bad local input. Exit 2, nothing signed. An optional `hint` is printed as its own line after the
 * problems (it is not a problem, so `problems` and the message leave it out).
 */
export class InputError extends KeyholeError {
  readonly exitCode = 2;
  constructor(
    readonly problems: string[],
    readonly hint?: string,
  ) {
    super(problems.join("; "));
    this.name = "InputError";
  }
  line(): string {
    const lines = this.problems.map((p) => `ERROR (input): ${p}`);
    if (this.hint) lines.push(this.hint);
    return lines.join("\n");
  }
}

/**
 * RPC unreachable, sandbox will not boot, missing key, malformed local file. Exit 2. Three subclasses report a
 * transaction that was sent (tx.ts SendFateUnknownError, attempt.ts LandedUnsettledError, TxSentError) and exit
 * EXIT_TX_SENT.
 */
export class EnvironmentError extends KeyholeError {
  readonly exitCode: number = 2;
  constructor(
    readonly what: string,
    readonly tryThis: string,
  ) {
    super(`${what} · ${tryThis}`);
    this.name = "EnvironmentError";
  }
  line(): string {
    return `ERROR (environment): ${this.what} · ${this.tryThis}`;
  }
}

/**
 * A transaction was sent and what it did is not settled for the caller, from a path that has no class of its own
 * (signWrap's kept AddKey, src/core/wrap.ts). Exit EXIT_TX_SENT, like SendFateUnknownError and LandedUnsettledError.
 */
export class TxSentError extends EnvironmentError {
  override readonly exitCode = EXIT_TX_SENT;
  constructor(what: string, tryThis: string) {
    super(what, tryThis);
    this.name = "TxSentError";
  }
}

/** No session file for this id (LAYOUT R5 "Unknown ID": list the known sessions, exit 1). */
export class UnknownSessionError extends KeyholeError {
  readonly exitCode = 1;
  constructor(
    readonly id: string,
    readonly known: string[],
  ) {
    super(`unknown session ${id}`);
    this.name = "UnknownSessionError";
  }
  line(): string {
    return `unknown session ${this.id} · known sessions: ${this.known.length ? this.known.join(", ") : "none"}`;
  }
}
