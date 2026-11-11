/**
 * The R4 step log (Task 8): one printer for live and replay runs, in the `full` or `beat` style. It prints, in
 * order, a beat header when the phase changes (`chain-check` stays in beat 3), each step's lines, the
 * staircase immediately before the first chain check (`full` style only: the beat-3 block of the video has no
 * row to spare for it), and, from `result(run)`, the RESULT line.
 *
 * A step's text has no trailing newline. A step printed after another starts with one blank line, so the
 * chunks of a run are separated the way LAYOUT R4 and DESIGN §5.3 print them: no blank line inside a block,
 * one between blocks. The `[NN/TT] waiting for RPC...` line belongs to the CLI, not here.
 *
 * What a step shows follows its data: an attempt the chain answered with a refusal (or the refusals beat's
 * slot) is a refusal block; a step with a chain check is the measured chain check; a step with a card prints
 * the compact card (every phase but `inspect`) or the full one (`inspect`), flush left and never re-wrapped here
 * (the card itself breaks its key line at ` on ` when it is wider than `caps.width`, C-T16a);
 * anything else is its label, its tx lines, the verdict its outcome earns and its notes.
 *
 * Width (C-T8b, C-T12a, C-T12d): every row the printer composes fits `caps.width` in the beat style (the video's
 * 100x30). A label, note or FAIL line breaks at its ` · ` separators, then at spaces (fitRows); a locked verdict
 * string is never broken, so a verdict too wide for the 8-column indent moves left until it fits (PASS_RUNTIME prints
 * at 4); a testnet TxLine breaks before its URL; the beat style's RESULT line breaks at a ` · `. The full style keeps RESULT on one line (one grep),
 * and a failed staircase row may run wider (accepted: failing runs).
 *
 * Every chain-sourced string passes through neutralizeControls (C-T6d). Lines are built from spans of plain
 * text that are styled one at a time after any wrapping (C-T6e), so stripAnsi(colored) equals the plain output.
 */
import { formatNear } from "../core/amounts.js";
import { INVALID_ACCESS_KEY_ERRORS } from "../core/types.js";
import type { DemoPhase, DemoRun, DemoStep, Network, ScopedKey } from "../core/types.js";
import { renderCageCard } from "./cage-card.js";
import { chainRejected, counter, failText, fitRows, isProtocolRefusal, nn, packSegments, paint, paintRows, renderRefusalBlock } from "./refusal-block.js";
import type { Span, StepStyle } from "./refusal-block.js";
import { renderRuleStrip } from "./rule-strip.js";
import { BEATS, CAPTION, PASS_IN_SCOPE, PASS_KEY_GONE, PASS_RUNTIME, SIX_OF_EIGHT, failChainCheck, passChainCheck } from "./strings.js";
import { type SgrKind, displayWidth, glyphs, neutralizeControls, sgr, wrapVerbatim } from "./style.js";
import type { TermCaps } from "./term.js";
import { renderTxLine } from "./tx-line.js";

export type { StepStyle } from "./refusal-block.js";

export interface StepPrinter {
  /** The lines for one step, beat header first when its phase starts a beat. */
  step(s: DemoStep): string;
  /** The RESULT line, with counts measured from the run. */
  result(run: DemoRun): string;
}

const safe = neutralizeControls;
const INDENT = " ".repeat(8);
/** DESIGN's rule width: beat headers and the staircase banner. */
const RULE_WIDTH = 98;
/** The wide staircase: `   [NN]  ` lead, and the column the parsed name starts in (LAYOUT R4 (c)). */
const WIDE_LEAD = 9;
const WIDE_NAME_COLUMN = 71;
/** Label column of a `panic    ` line, so wrapped rows hang under the text. */
const PANIC_LABEL = "panic    ";

type BeatKey = Exclude<DemoPhase, "chain-check">;
/** The beat a phase prints under: the chain check stays in beat 3 (refusals). The CLI's --step pauses where it changes. */
export const beatOf = (phase: DemoPhase): BeatKey => (phase === "chain-check" ? "refusals" : phase);

// ---------------------------------------------------------------------------------------------------
// Measured values

/** NEAR from a yocto string; a value that is not a whole number prints as visible text instead of throwing. */
function near(yocto: string): string {
  try {
    return formatNear(yocto);
  } catch {
    return safe(yocto);
  }
}

/** The allowance as one phrase: `0.0492 NEAR`, or the card's `NO CAP ON CHAIN`. */
const allowancePhrase = (yocto: string | null): string => (yocto === null ? "NO CAP ON CHAIN" : `${near(yocto)} NEAR`);

/** `0.0492 -> 0.0391 NEAR`, with the unit once when both values have one. */
function allowanceMove(before: ScopedKey, after: ScopedKey, arrow: string): string {
  const [a, b] = [before.allowanceRemainingYocto, after.allowanceRemainingYocto];
  return a !== null && b !== null ? `${near(a)} ${arrow} ${near(b)} NEAR` : `${allowancePhrase(a)} ${arrow} ${allowancePhrase(b)}`;
}

/** What a chain check measured: whether nonce and allowance are unchanged, and each change in words. */
export function measureChainCheck(check: { before: ScopedKey; after: ScopedKey }, caps: TermCaps): { same: boolean; changes: string[] } {
  const { before, after } = check;
  const arrow = glyphs(caps).arrow;
  const changes: string[] = [];
  if (before.nonce !== after.nonce) changes.push(`nonce ${safe(String(before.nonce))} ${arrow} ${safe(String(after.nonce))}`);
  if (before.allowanceRemainingYocto !== after.allowanceRemainingYocto) changes.push(`allowance ${allowanceMove(before, after, arrow)}`);
  return { same: changes.length === 0, changes };
}

/**
 * How many of the refusals-phase slots earned a protocol refusal, of how many there were. Every refusals-phase
 * step is a slot, whether or not it has an attempt (a fixture that is missing or unparseable is a slot with
 * none); a slot is earned when its step passed and its attempt was refused by the key's rules (C-T2k).
 */
export function refusalTally(slots: readonly DemoStep[]): { ok: number; total: number } {
  return { ok: slots.filter((s) => s.pass && isProtocolRefusal(s)).length, total: slots.length };
}

/** The chain check's claim when no slot preceded it, and when none of them earned a refusal. */
export const NO_ATTEMPT_BEFORE_CHECK = "FAIL: no refusal attempt preceded the chain check";
export const noRefusalEarned = (slots: number): string => `FAIL: no attempt was refused by protocol before the chain check (0/${slots})`;

/**
 * What makes a chain check fail, from what it measured and the refusals-phase steps before it (undefined: it passes):
 * a moved nonce or allowance, then no slot, then no earned refusal. The driver's verdict on [11] and replay's
 * re-derivation of it from the recorded reads (C-T14c) both come from here, so they cannot drift apart. The note is
 * plain ASCII, as the driver has always written it.
 */
export function chainCheckNote(check: { before: ScopedKey; after: ScopedKey }, slots: readonly DemoStep[]): string | undefined {
  const { before, after } = check;
  const changes: string[] = [];
  if (before.nonce !== after.nonce) changes.push(`nonce ${before.nonce} -> ${after.nonce}`);
  if (before.allowanceRemainingYocto !== after.allowanceRemainingYocto) changes.push(`allowance ${before.allowanceRemainingYocto} -> ${after.allowanceRemainingYocto} yocto`);
  if (changes.length) return failChainCheck(changes.join(", "));
  const tally = refusalTally(slots);
  if (tally.total === 0) return NO_ATTEMPT_BEFORE_CHECK;
  if (tally.ok === 0) return noRefusalEarned(tally.total);
  return undefined;
}

/**
 * The chain check's verdict line and whether it is a pass. It is measured, never asserted: a moved nonce or
 * allowance is a FAIL whatever the step says; a step that failed for another reason is a FAIL; and
 * `passChainCheck(n)` names only the refusals that were earned (n >= 1), so with no slot or no earned refusal
 * there is nothing for "unchanged by n refusals" to rest on and the line is a FAIL instead.
 */
export function chainCheckVerdict(s: DemoStep, tally: { ok: number; total: number }, caps: TermCaps): { text: string; pass: boolean } {
  const { same, changes } = measureChainCheck(s.chainCheck!, caps);
  if (!same) return { text: failChainCheck(changes.join(", ")), pass: false };
  if (!s.pass) return { text: failText(s), pass: false };
  if (tally.total === 0) return { text: NO_ATTEMPT_BEFORE_CHECK, pass: false };
  if (tally.ok === 0) return { text: noRefusalEarned(tally.total), pass: false };
  return { text: passChainCheck(tally.ok), pass: true };
}

/** The tx hashes a step produced, in order and without repeats: its own, then the further ones. */
export function hashesOf(s: DemoStep): string[] {
  const o = s.attempt?.outcome;
  const own = s.txHash ?? (o !== undefined && o.kind !== "Refusal" ? o.txHash : undefined);
  return [...new Set([...(own === undefined ? [] : [own]), ...(s.moreTxHashes ?? [])])];
}

function duration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/** `/home/me/keyhole/demo/transcript.md` -> `demo/transcript.md`: the repo-relative path the line promises. */
function repoPath(path: string): string {
  const at = path.lastIndexOf("/demo/");
  return safe(at >= 0 ? path.slice(at + 1) : path);
}

/**
 * The line after RESULT when the run ended before its last step (C-T12d): its steps are numbered 1..k of a larger
 * total. The driver stops early only after a failed [01], before any proposal or key, so `0/1 PASS` cannot be read
 * as a complete run. What it says about bonds and keys is read from the steps that ran.
 */
export function runStopped(steps: readonly DemoStep[]): string | null {
  const last = steps.at(-1);
  if (last === undefined || !steps.every((s, i) => s.n === i + 1) || steps.length >= last.total) return null;
  const key = steps.some((s) => s.phase === "wrap");
  const bond = steps.some((s) => s.phase === "setup" && s.n > 1);
  return `run stopped after [${nn(last.n)}]${key ? "" : bond ? ": no key" : ": no bond, no key"}`;
}

/**
 * The RESULT line, then `SIX_OF_EIGHT` on its own line when this is a sandbox run whose passing refusals parsed
 * to the six InvalidAccessKeyError variants (each of them), then runStopped's line for a run that ended early.
 * Counts are measured from the run: a step is a PASS when it passed, a protocol refusal is a passing step whose
 * outcome is a Refusal by the key's rules (C-T2k), and a tx hash counts once however often it appears.
 * Style `beat` (the recording) breaks RESULT at a ` · ` where it would pass `caps.width` (C-T8b); `full` keeps it one line.
 */
export function resultLines(run: DemoRun, caps: TermCaps, style: StepStyle = "full"): string[] {
  const total = run.steps.length;
  const failed = run.steps.filter((s) => !s.pass).length;
  const refusals = run.steps.filter((s) => s.pass && isProtocolRefusal(s));
  const hashes = new Set(run.steps.flatMap(hashesOf));
  const segments: Span[][] = [
    [["RESULT", "bold"], [" "], [`${total - failed}/${total} PASS`, failed === 0 ? "pass" : "fail"]],
    ...(failed === 0 ? [] : [[[`${failed} FAIL`, "fail"] as Span]]),
    [[`${refusals.length} protocol refusal${refusals.length === 1 ? "" : "s"}`]],
    [[`${hashes.size} tx hash${hashes.size === 1 ? "" : "es"}`]],
    [[duration(run.durationMs)]],
    [[`exit ${run.exitCode}`]],
    ...(run.transcriptPath === "" ? [] : [[[`transcript ${repoPath(run.transcriptPath)}`] as Span]]),
  ];
  const rows = packSegments(segments, style === "beat" ? caps.width : Number.POSITIVE_INFINITY, "", " ".repeat("RESULT ".length));
  const lines = rows.map((r) => paint(caps, r));
  const names = new Set(refusals.flatMap((s) => (s.attempt?.outcome.kind === "Refusal" && s.attempt.outcome.family === "InvalidTxError::InvalidAccessKeyError" ? [s.attempt.outcome.errorName] : [])));
  if (run.network === "sandbox" && INVALID_ACCESS_KEY_ERRORS.every((n) => names.has(n))) lines.push(SIX_OF_EIGHT);
  const stopped = runStopped(run.steps);
  if (stopped !== null) lines.push(stopped);
  return lines;
}

// ---------------------------------------------------------------------------------------------------
// The printer

/**
 * `opts.runId`: the id of the run being replayed, for the `REPLAY of run …` footer of its cage cards (C-T7b).
 * `opts.saved`: false for a run that writes no files (`demo --sandbox`): its refusal blocks name no fixture file
 * (final review M3). Default true: a written run, or a replay of committed files.
 */
export function createStepPrinter(opts: { caps: TermCaps; style: StepStyle; network: Network; mode: "live" | "replay"; runId?: string; saved?: boolean }): StepPrinter {
  const { caps, style, network, mode, runId } = opts;
  const saved = opts.saved !== false;
  const g = glyphs(caps);
  const arrow = g.arrow;
  const tag = mode === "replay" ? "[REPLAY]" : "[LIVE]";
  const ruleWidth = Math.min(RULE_WIDTH, caps.width);

  let printed = false;
  let beat: BeatKey | undefined;
  /** The refusal slots of the beat so far, in run order: every refusals-phase step, with or without an attempt. */
  const slots: DemoStep[] = [];
  let staircaseShown = false;

  /** `── <BEATS[phase]> ─…─ [LIVE] ──`, 98 columns, bold. */
  function beatHeader(key: BeatKey): string {
    const head = `${g.h}${g.h} ${BEATS[key]} `;
    const tail = ` ${tag} ${g.h}${g.h}`;
    return sgr(caps, "bold", head + g.h.repeat(Math.max(3, ruleWidth - displayWidth(head) - displayWidth(tail))) + tail);
  }

  const tally = (): { ok: number; total: number } => refusalTally(slots);

  // -- the staircase ---------------------------------------------------------------------------------

  /**
   * The parsed-name cell of a staircase row: NEAR's voice (inverse), or the honest word for anything else. A slot
   * with no attempt shows `-` and its FAIL: there is no body to parse a name from.
   */
  function nameSpans(s: DemoStep): Span[] {
    const o = s.attempt?.outcome;
    if (o === undefined) return s.pass ? [["- no attempt recorded"]] : [["- "], [failText(s), "fail"]];
    if (o.kind !== "Refusal") return [[`no refusal (landed: ${o.kind})`]];
    if (!isProtocolRefusal(s)) return [[chainRejected(o.errorName), "bold"]];
    // C-T8c: NEAR's voice (inverse) only for a refusal the step earned; a failed one says FAIL on its own row.
    return s.pass ? [[safe(o.errorName), "inverse"]] : [[safe(o.errorName)], [" "], [failText(s), "fail"]];
  }

  function staircase(): string[] {
    const { ok, total } = tally();
    const head = `${g.h}${g.h} REFUSALS ${ok}/${total} ${g.h} ${CAPTION} `;
    const banner = sgr(caps, "bold", head + g.h.repeat(Math.max(2, ruleWidth - displayWidth(head))));
    const wide = caps.width >= 100;
    const narrow = caps.width >= 80;
    // The rule a row lights: only a refusal by the key's rules that the step earned names one (C-T8c).
    const ruleOf = (s: DemoStep) => {
      const o = s.attempt?.outcome;
      return s.pass && s.attempt && o?.kind === "Refusal" && o.family === "InvalidTxError::InvalidAccessKeyError" ? s.attempt.violates : "none";
    };
    if (!narrow) {
      // Below 80 columns: key: value rows, no strip.
      return [banner, ...slots.map((s) => `   [${nn(s.n)}] ${ruleOf(s) === "none" ? "-" : safe(ruleOf(s).toUpperCase())}: ` + paint(caps, nameSpans(s)))];
    }
    const lead = wide ? WIDE_LEAD : 3;
    const nameColumn = wide ? WIDE_NAME_COLUMN : lead + 55 + 3;
    const cell = (text: string): string => text + " ".repeat(Math.max(0, nameColumn - displayWidth(text)));
    const columns = cell(`   ${wide ? "step  " : ""}rule broken — one per test, fixed slot order`) + "parsed from RPC body";
    const rows = slots.map((s) => {
      const strip = renderRuleStrip(ruleOf(s), caps);
      const left = (wide ? `   [${nn(s.n)}]  ` : "   ") + strip;
      return left + " ".repeat(Math.max(2, nameColumn - displayWidth(left))) + paint(caps, nameSpans(s));
    });
    return [banner, columns, ...rows];
  }

  // -- the chain check -------------------------------------------------------------------------------

  function chainCheckLines(s: DemoStep): string[] {
    const { before, after } = s.chainCheck!;
    const { same } = measureChainCheck(s.chainCheck!, caps);
    const nonce = `nonce ${safe(String(before.nonce))} ${arrow} ${safe(String(after.nonce))}`;
    const { ok, total } = tally();
    // The verdict is measured (chainCheckVerdict): the counts are the slots' earned refusals, never a constant.
    const { text, pass } = chainCheckVerdict(s, { ok, total }, caps);
    const kind: SgrKind = pass ? "pass" : "fail";
    if (style === "beat") {
      const allowance = same ? `${allowancePhrase(before.allowanceRemainingYocto)} before and after` : allowanceMove(before, after, arrow);
      // One witness line, as DESIGN words it. It is 100 cells with an 8-digit nonce and unicode arrows, so with
      // a testnet nonce (15 digits) it no longer fits the terminal: then it breaks at its own " · " into two rows.
      const witness = `gas allowance ${allowance} · ${nonce} (view_access_key, read twice)`;
      const witnessRows = displayWidth(witness) <= caps.width ? [witness] : [`gas allowance ${allowance}`, `${nonce} (view_access_key, read twice)`];
      // With no slot there is no N/M to state: the caption would claim attempts that were never made.
      const caption = total === 0 ? [] : [paint(caps, [[`${ok}/${total}`, "bold"], [` ${CAPTION}`]])];
      return [...caption, ...witnessRows, ...paintRows(caps, fitRows(text, caps.width, ""), kind)];
    }
    const seen = slots.map((a) => a.n);
    const window = seen.length === 0 ? "view_access_key read before and after the refusals" : `view_access_key read before [${nn(Math.min(...seen))}] and after [${nn(Math.max(...seen))}]`;
    return [
      paint(caps, [[counter(s) + " "], ["CHAIN CHECK", "bold"], [`  ${window}`]]),
      `${INDENT}${nonce} · allowance left ${allowanceMove(before, after, arrow)}`,
      ...paintRows(caps, fitRows(text, caps.width, INDENT), kind),
    ];
  }

  // -- every other step ------------------------------------------------------------------------------

  /** The panic text, wrapped as plain text at the width and hung under its label (then it needs no styling). */
  function panicLines(message: string): string[] {
    const rows = wrapVerbatim(safe(message), Math.max(20, caps.width - INDENT.length - PANIC_LABEL.length));
    return rows.map((row, i) => INDENT + (i === 0 ? PANIC_LABEL : " ".repeat(PANIC_LABEL.length)) + row);
  }

  /**
   * A locked verdict string on its own row: at the 8-column indent when it fits, else moved left until it does
   * (PASS_RUNTIME, 96 cells, prints at 4). It is never broken, so a grep for it always finds it whole.
   */
  function verdictRow(text: string, kind: SgrKind): string {
    const room = caps.width - displayWidth(text);
    return (room >= INDENT.length ? INDENT : " ".repeat(Math.max(0, room))) + paint(caps, [[text, kind]]);
  }

  function plainStepLines(s: DemoStep): string[] {
    const o = s.attempt?.outcome;
    // The label breaks at its ` · ` (a long operator id in [03], C-T12d), continuation rows under the label.
    const lines = paintRows(caps, fitRows(safe(s.label), caps.width, `${counter(s)} `, INDENT));
    // A testnet TxLine is 112 cells at the indent (110 with the unicode ellipsis; the URL holds the full hash): it
    // breaks before the URL (C-T8b).
    for (const h of hashesOf(s)) lines.push(...packSegments(renderTxLine(h, network, caps).split(" · ").map((part): Span[] => [[part]]), caps.width, INDENT).map((r) => paint(caps, r)));
    if (o?.kind === "ContractPanic") lines.push(...panicLines(o.message));
    if (s.card) lines.push(renderCageCard(s.card, s.phase === "inspect" ? "full" : "compact", caps, runId));
    if (!s.pass) {
      lines.push(...paintRows(caps, fitRows(failText(s), caps.width, INDENT), "fail"));
    } else {
      if (o?.kind === "TxSuccess") lines.push(verdictRow(PASS_IN_SCOPE, "pass"));
      if (o?.kind === "ContractPanic") lines.push(verdictRow(PASS_RUNTIME, "runtime"));
      if (s.card && s.card.key === null && s.card.source === "chain") lines.push(verdictRow(PASS_KEY_GONE, "pass"));
      if (s.proposal) {
        const p = s.proposal;
        lines.push(INDENT + paint(caps, [[`proposal #${safe(String(p.id))} `], [safe(p.status), "inverse"], [` (${safe(String(p.approvals))} of ${safe(String(p.required))})`]]));
      }
      if (s.note !== undefined && s.note !== "") lines.push(...paintRows(caps, fitRows(safe(s.note), caps.width, INDENT), "bold"));
    }
    return lines;
  }

  /** An attempt belongs in a refusal block when the chain refused it, or when it failed in a slot that expected a refusal. */
  const isRefusalSlot = (s: DemoStep): boolean =>
    s.attempt !== undefined && (s.attempt.outcome.kind === "Refusal" || (!s.pass && (s.phase === "refusals" || s.phase === "burn")));

  function bodyLines(s: DemoStep): string[] {
    if (s.chainCheck) {
      const staircaseLines = style === "full" && !staircaseShown && slots.length > 0 ? [...staircase(), ""] : [];
      staircaseShown = true;
      return [...staircaseLines, ...chainCheckLines(s)];
    }
    if (isRefusalSlot(s)) return renderRefusalBlock(s, caps, style, { saved }).split("\n");
    return plainStepLines(s);
  }

  return {
    step(s) {
      const key = beatOf(s.phase);
      const lines: string[] = printed ? [""] : [];
      if (key !== beat) {
        lines.push(beatHeader(key));
        beat = key;
      }
      if (s.phase === "refusals") slots.push(s);
      lines.push(...bodyLines(s));
      printed = true;
      return lines.join("\n");
    },
    result(run) {
      return (printed ? "\n" : "") + resultLines(run, caps, style).join("\n");
    },
  };
}
