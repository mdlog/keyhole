/**
 * What the driver (the hero, phases 1–6) and the smoke phase (phase 7) both use to build a step: `guarded` turns an
 * error into one printable line, `send` sends an attempt once, `verdict` and `withoutUndefined` shape the step. A leaf
 * module (C-T13a, M4): driver.ts imports smoke.ts, so smoke.ts could not import them from driver.ts, and the two
 * files each kept a copy. Nothing here imports either of them.
 */
import { LandedUnsettledError, sendAttempt } from "../core/attempt.js";
import { KeyholeError } from "../core/errors.js";
import type { Attempt, AttemptInput, DemoStep, Session } from "../core/types.js";

/** What `send` found: the attempt the chain answered, and the error line when something went wrong after it. */
export type Sent = { attempt?: Attempt; error?: string };

/** `fn`'s value, or its error as one printable line (the class's own line: message and hint verbatim). */
export async function guarded<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: errorLine(e) };
  }
}

export function errorLine(e: unknown): string {
  if (e instanceof KeyholeError) return e.line();
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * One attempt through sendAttempt, sent once (C-T2i). A LandedUnsettledError is the landed attempt it carries; any
 * other error leaves no attempt (a SendFateUnknownError's line names the tx to look up).
 */
export async function send(session: Session, input: AttemptInput): Promise<Sent> {
  try {
    return { attempt: await sendAttempt(session, input) };
  } catch (e) {
    return e instanceof LandedUnsettledError ? { attempt: e.attempt, error: errorLine(e) } : { error: errorLine(e) };
  }
}

/** pass and note from a list of problems: no problem is a PASS with `okNote`. */
export function verdict(problems: string[], okNote?: string): { pass: boolean; note?: string } {
  return problems.length === 0 ? { pass: true, note: okNote } : { pass: false, note: `FAIL: ${problems.join("; ")}` };
}

/** A step without its unset fields, so run.json and the step log carry only what the step has. */
export function withoutUndefined(s: DemoStep): DemoStep {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as unknown as DemoStep;
}
