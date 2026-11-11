/**
 * RefusalBlock (LAYOUT R4 (b); DESIGN_BRIEF §5.3): the WOW hero. One block per attempt that the chain
 * answered, in two styles that print the same evidence:
 *
 *   full   LAYOUT R4's anatomy, 8-10 lines, no blank line inside: header, rule strip, signed, rpc + fixture
 *          name, the raw body behind a gutter, the verdict, the ledger. Also the R6 burn PROOF (phase `burn`),
 *          which has no rule strip: no slot means "key gone".
 *   beat   DESIGN's group: row 1 is the verdict with a right-aligned tag naming the card row it breaks, then
 *          the raw body at 4 spaces, soft-wrapped at 96 (the video's 100x30 budget).
 *
 * Both print the raw body byte for byte (RawJsonBlock; nothing is elided) and exactly one
 * `PASS: refused by protocol (Name)` per refusal. The name is parsed from the body (parseRefusal); the
 * expectation lives in the pack, so a mismatch arrives as `step.pass === false` with a FAIL note, and no PASS
 * line is printed for it.
 *
 * Only a Refusal of family `InvalidTxError::InvalidAccessKeyError` was refused by the key's scope (C-T2k). Any
 * other InvalidTxError (InvalidNonce, Expired, ...) is the chain rejecting the tx for another reason: it prints
 * as `chain rejected the tx: Name`, never with a rule strip, a `breaks` tag or a PASS line, and it is not
 * counted as a scope refusal. One name in one context is the exception: `SignerDoesNotExist` (family
 * InvalidTxError) is the sub-account burn's expected proof, so in the burn proof's phases (`burn`, and `smoke`,
 * where the counter's sub-account burn is proven) it keeps its PASS line and NOTE_SIGNER_GONE (the plan's 7 PASS
 * lines on --sandbox rest on it). In any other phase it is a chain rejection like the rest, and a pack may only
 * expect it from a test whose key state is `after-burn` (packProblems).
 *
 * Width (C-T12a, C-T14b): the rows this module composes fit `caps.width`. The ledger breaks before its path (` · `),
 * the full style's rpc row breaks before the fixture path it names whole (C-T8b), and a FAIL or note row breaks at its
 * ` · ` separators, then at spaces; the raw body wraps on its own. The one row that may run wider is a word or path
 * wider than the terminal, which is never cut.
 *
 * Every chain-sourced string (parsed names, paths, methods, receivers, hashes, notes, fixture names) passes
 * through neutralizeControls before it is printed (C-T6d). Lines are built as spans of plain text and styled
 * one span at a time, so no style is open at a row end and stripAnsi(colored) equals the plain output (C-T6e).
 * Pure string functions: no I/O, no state, nothing happens at import.
 */
import { formatNear } from "../core/amounts.js";
import type { Attempt, AttemptOutcome, DemoPhase, DemoStep, Violation } from "../core/types.js";
import { renderRawJsonBlock } from "./raw-json-block.js";
import { renderRuleStrip } from "./rule-strip.js";
import { NOTE_SIGNER_GONE, RPC_NOT_SAVED, passRefused } from "./strings.js";
import { displayWidth, glyphs, neutralizeControls, sgr } from "./style.js";
import type { SgrKind } from "./style.js";
import type { TermCaps } from "./term.js";

/**
 * `full`: LAYOUT R4's 10-line anatomy (non-TTY output, the transcript, the R6 PROOF). `beat`: DESIGN
 * §5.3's group (a TTY, i.e. the video). Both print the raw body verbatim and exactly one PASS line.
 */
export type StepStyle = "full" | "beat";

// ---------------------------------------------------------------------------------------------------
// Helpers shared with the step log and the transcript

/** A piece of one line: plain text and the style it takes, if any. */
export type Span = readonly [text: string, kind?: SgrKind];

/** The line made of these spans, each styled on its own (nothing nests, nothing stays open). */
export function paint(caps: TermCaps, spans: readonly Span[]): string {
  return spans.map(([text, kind]) => (kind === undefined ? text : sgr(caps, kind, text))).join("");
}

/** Terminal cells the spans occupy. */
export const spansWidth = (spans: readonly Span[]): number => spans.reduce((n, [text]) => n + displayWidth(text), 0);

/**
 * Segments of one line, joined with ` · ` and packed into rows of at most `width` cells (C-T8b, C-T12a): a segment
 * that does not fit on the row starts the next one, after `hang` and `· `. The first row starts with `lead`. A
 * segment wider than a row gets a row of its own, overlong: nothing is cut.
 */
export function packSegments(segments: readonly (readonly Span[])[], width: number, lead = "", hang = lead): Span[][] {
  const rows: Span[][] = [];
  let row: Span[] = [[lead], ...(segments[0] ?? [])];
  for (const seg of segments.slice(1)) {
    if (spansWidth(row) + 3 + spansWidth(seg) <= width) row.push([" · "], ...seg);
    else {
      rows.push(row);
      row = [[`${hang}· `], ...seg];
    }
  }
  rows.push(row);
  return rows;
}

/** One row of fitted text: what precedes the text (indent and continuation mark, never styled), then the text. */
export type FitRow = readonly [prefix: string, text: string];

/**
 * `text` as rows of at most `width` cells, for a row the printer composes (notes, FAIL lines, labels; C-T12a). One
 * row when `lead + text` fits. Otherwise it breaks before a ` · ` separator, the next row starting `hang` and `· `;
 * a part that still does not fit breaks at spaces, the next row starting `hang` and two spaces. A word wider than its
 * row stands alone, overlong; no character is dropped but the spaces and separators it breaks at.
 */
export function fitRows(text: string, width: number, lead: string, hang = lead): FitRow[] {
  if (displayWidth(lead + text) <= width) return [[lead, text]];
  const rows: FitRow[] = [];
  const parts = text.split(" · ");
  let prefix = lead;
  let body = parts[0];
  for (const part of parts.slice(1)) {
    if (displayWidth(`${prefix}${body} · ${part}`) <= width) body += ` · ${part}`;
    else {
      rows.push(...wordRows(prefix, body, width, `${hang}  `));
      prefix = `${hang}· `;
      body = part;
    }
  }
  rows.push(...wordRows(prefix, body, width, `${hang}  `));
  return rows;
}

/** `text` after `prefix`, broken at spaces into rows of at most `width` cells; later rows start with `hang`. */
function wordRows(prefix: string, text: string, width: number, hang: string): FitRow[] {
  if (displayWidth(prefix + text) <= width) return [[prefix, text]];
  const words = text.split(" ");
  const rows: FitRow[] = [];
  let lead = prefix;
  let line = words[0];
  for (const word of words.slice(1)) {
    if (line !== "" && displayWidth(`${lead}${line} ${word}`) > width) {
      rows.push([lead, line]);
      lead = hang;
      line = word;
    } else line += ` ${word}`;
  }
  rows.push([lead, line]);
  return rows;
}

/** Fitted rows, each painted: the prefix plain, the text in `kind`. */
export function paintRows(caps: TermCaps, rows: readonly FitRow[], kind?: SgrKind): string[] {
  return rows.map(([prefix, text]) => prefix + paint(caps, [[text, kind]]));
}

/** Two digits, as the step counter prints a step number: `7` -> `07`. */
export const nn = (n: number): string => String(n).padStart(2, "0");

/** `[07/14]`. */
export const counter = (step: DemoStep): string => `[${nn(step.n)}/${nn(step.total)}]`;

const FAMILY_ACCESS_KEY = "InvalidTxError::InvalidAccessKeyError";
/** The proof of a sub-account burn: family InvalidTxError, not an access-key error. */
export const SIGNER_GONE = "SignerDoesNotExist";
/** The phases that hold a burn proof (LAYOUT R4: [14] `burn` on-account; [20] `smoke`, the counter's sub-account burn). */
const BURN_PROOF_PHASES: readonly DemoPhase[] = ["burn", "smoke"];

/** How a Refusal of any other family is worded (C-T2k). */
export const chainRejected = (errorName: string): string => `chain rejected the tx: ${neutralizeControls(errorName)}`;

/**
 * True for a step whose attempt the protocol refused by the key's rules: a Refusal of family
 * InvalidAccessKeyError, or SignerDoesNotExist in a burn proof's phase (see the header). False for a landed
 * outcome, for a step with no attempt, and for every other InvalidTxError, which the chain rejected for a
 * reason that is not the key's scope. It takes the step, not the outcome, because the exception is by context.
 */
export function isProtocolRefusal(step: DemoStep): boolean {
  const o = step.attempt?.outcome;
  return o?.kind === "Refusal" && (o.family === FAMILY_ACCESS_KEY || (o.errorName === SIGNER_GONE && BURN_PROOF_PHASES.includes(step.phase)));
}

/** `FAIL: ...` for a step that did not pass: its note (a note that already starts with FAIL is kept as is). */
export function failText(step: DemoStep): string {
  const note = step.note === undefined ? "" : neutralizeControls(step.note);
  if (note.startsWith("FAIL")) return note;
  return note === "" ? "FAIL: step did not pass" : `FAIL: ${note}`;
}

/** A deposit as the signed line shows it: `0`, `1 yocto`, or NEAR once it is large enough to read as NEAR. */
export function depositText(yocto: string): string {
  if (!/^[0-9]+$/.test(yocto)) return neutralizeControls(yocto);
  const v = BigInt(yocto);
  if (v === 0n) return "0";
  return v < 10n ** 20n ? `${v} yocto` : `${formatNear(v)} NEAR`;
}

// ---------------------------------------------------------------------------------------------------
// Rows

const safe = neutralizeControls;
const INDENT = 8;
const BEAT_INDENT = 4;
const BEAT_CHUNK = 96;
/** DESIGN's rule width, and the column the beat tag ends on. */
const RULE_WIDTH = 98;

/** What the attempt was, for the header: the method of a call, else the action. */
const whatOf = (a: Attempt): string => safe(a.method ?? a.action);

/** A text row of `kind`, fitted to `room` cells (its lead is added by the caller): one Span[] per row. */
const fitted = (text: string, room: number, kind: SgrKind): Span[][] => fitRows(text, room, "").map(([prefix, t]): Span[] => (prefix === "" ? [[t, kind]] : [[prefix], [t, kind]]));

/**
 * The verdict rows of a step, as spans, fitted to `room` cells. Row 0 is the PASS line of a protocol refusal that
 * passed (never broken: it is one locked string).
 */
function verdictRows(step: DemoStep, outcome: AttemptOutcome, room: number): Span[][] {
  const rows: Span[][] = [];
  const refusal = outcome.kind === "Refusal" ? outcome : undefined;
  if (refusal && !isProtocolRefusal(step)) rows.push([[chainRejected(refusal.errorName), "bold"]]);
  if (!step.pass) {
    rows.push(...fitted(failText(step), room, "fail"));
  } else if (refusal && isProtocolRefusal(step)) {
    // passRefused is the locked string. Split it around the name so the name can be inverse (NEAR's voice)
    // while "PASS: refused by protocol" stays one contiguous span of the output.
    const full = passRefused(refusal.errorName);
    const tail = `${safe(refusal.errorName)})`;
    const head = full.endsWith(tail) ? full.slice(0, full.length - tail.length) : "";
    rows.push(head.endsWith(" (") ? [[head.slice(0, -2), "pass"], [" ("], [safe(refusal.errorName), "inverse"], [")"]] : [[full, "pass"]]);
  }
  return rows;
}

/** The note rows that follow a passing verdict, fitted to `room`: the sub-account burn's explanation, then the step's own note. */
function noteRows(step: DemoStep, outcome: AttemptOutcome, room: number): Span[][] {
  if (!step.pass) return []; // a failing step's note is already its FAIL row
  const rows: Span[][] = [];
  if (outcome.kind === "Refusal" && outcome.errorName === SIGNER_GONE && isProtocolRefusal(step)) rows.push([[NOTE_SIGNER_GONE, "bold"]]);
  if (step.note !== undefined && step.note !== "") rows.push(...fitted(safe(step.note), room, "bold"));
  return rows;
}

/**
 * The ledger: the absence is the datum (`reached block: no`, `on-chain tx: none`), then the parsed path. Fitted to
 * `room` cells: a path that does not fit takes the next row, after `· ` (C-T12a; the path itself is never broken).
 */
function ledgerRows(outcome: AttemptOutcome, room: number): Span[][] {
  if (outcome.kind !== "Refusal") return packSegments([[["reached block: yes"]], [[`on-chain tx: ${safe(outcome.txHash)}`]]], room);
  const path = outcome.path.map(safe);
  const last = path.length - 1;
  const pathSpans = path.flatMap((p, i): Span[] => [...(i === 0 ? [] : [[" › "] as Span]), i === last ? [p, "inverse"] : [p]]);
  return packSegments([[["reached block: no"]], [["on-chain tx: none"]], pathSpans], room);
}

/** The signed line: exactly what was signed. The field that breaks the rule is bold, like the bracketed slot. */
function signedRow(a: Attempt, caps: TermCaps): Span[] {
  const emph = (rule: Violation): SgrKind | undefined => (a.violates === rule ? "bold" : undefined);
  const spans: Span[] = [[safe(a.action), emph("action")]];
  if (a.method !== undefined) spans.push([" "], [safe(a.method), emph("method")]);
  spans.push([` ${glyphs(caps).arrow} `], [safe(a.receiverId), emph("receiver")], [" · deposit "], [depositText(a.depositYocto), emph("deposit")]);
  if (a.action === "FunctionCall") spans.push([" · "], [`${a.gasTGas} TGas`, emph("allowance")]);
  return spans;
}

/** `breaks METHOD · add_proposal`: the card row an attempt breaks and the offending value (DESIGN §5.3). */
function breaksTag(a: Attempt): { label: string; value: string } | null {
  switch (a.violates) {
    case "method":
      return { label: "METHOD", value: safe(a.method ?? a.action) };
    case "action":
      return { label: "ACTIONS", value: safe(a.action) };
    case "receiver":
      return { label: "RECEIVER", value: safe(a.receiverId) };
    case "deposit":
      return { label: "DEPOSIT", value: depositText(a.depositYocto) };
    case "allowance":
      return { label: "GAS", value: `${a.gasTGas} TGas` };
    default:
      return null;
  }
}

const requireAttempt = (step: DemoStep): Attempt => {
  if (!step.attempt) throw new TypeError(`renderRefusalBlock: step ${step.n} (${safe(step.label)}) has no attempt to show`);
  return step.attempt;
};

// ---------------------------------------------------------------------------------------------------
// The two styles

function fullBlock(step: DemoStep, caps: TermCaps, withCounter: boolean, saved: boolean): string[] {
  const a = requireAttempt(step);
  const o = a.outcome;
  const lead = " ".repeat(INDENT);
  const row = (spans: readonly Span[]): string => lead + paint(caps, spans);
  const scope = o.kind === "Refusal" && o.family === FAMILY_ACCESS_KEY;

  const lines = [paint(caps, [[withCounter ? `${counter(step)} ` : ""], ["ATTEMPT", "bold"], [`  ${whatOf(a)}`], ...(step.label === "" ? [] : [[`  ("${safe(step.label)}")`] as Span])])];
  // No slot means "key gone": the burn PROOF and an attempt that breaks no rule have no strip, and neither has
  // a rejection that is not the key's scope.
  if (scope && a.violates !== "none" && step.phase !== "burn") lines.push(row([["breaks", "bold"], ["    "]]) + renderRuleStrip(a.violates, caps));
  lines.push(row([["signed", "bold"], ["   "], ...signedRow(a, caps)]));
  const room = caps.width - INDENT;
  // C-T14b: the fixture file is named whole; where `rpc … · demo/fixtures/NAME` does not fit, the path takes the next row, after `· ` (a spike capture's long names made it 109 cells).
  // M3 (final review): a run that writes no files names none; the row says the body is not saved instead.
  const where: Span[][] = step.fixture === undefined ? [] : [[[saved ? `demo/fixtures/${safe(step.fixture)}` : RPC_NOT_SAVED]]];
  const rpc: Span[][] = [[["rpc", "bold"], ["      "], ["response body, verbatim"]], ...where];
  for (const r of packSegments(rpc, room)) lines.push(row(r));
  lines.push(...renderRawJsonBlock(o.rawRpcJson, caps, { highlight: o.kind === "Refusal" ? o.errorName : undefined }));
  for (const r of verdictRows(step, o, room)) lines.push(row(r));
  for (const r of noteRows(step, o, room)) lines.push(row(r));
  for (const r of ledgerRows(o, room)) lines.push(row(r));
  return lines;
}

function beatBlock(step: DemoStep, caps: TermCaps): string[] {
  const a = requireAttempt(step);
  const o = a.outcome;
  const lead = " ".repeat(BEAT_INDENT);
  const rows = verdictRows(step, o, caps.width);
  const lines: string[] = [];

  // Row 1: the verdict, with the tag right-aligned. The tag names a card row the attempt broke, so it appears
  // only for a protocol refusal that passed.
  const tag = step.pass && o.kind === "Refusal" && o.family === FAMILY_ACCESS_KEY ? breaksTag(a) : null;
  rows.forEach((spans, i) => {
    if (i !== 0 || tag === null) return void lines.push(paint(caps, spans));
    const tagSpans: Span[] = [["breaks "], [tag.label, "bold"], [` · ${tag.value}`]];
    const width = spansWidth;
    const target = Math.min(RULE_WIDTH, caps.width);
    if (width(spans) + 2 + width(tagSpans) <= target) {
      lines.push(paint(caps, [...spans, [" ".repeat(target - width(spans) - width(tagSpans))], ...tagSpans]));
    } else {
      // A long receiver or method would push row 1 past the terminal: the tag takes its own row, still
      // right-aligned (a tag wider than the rule starts at column 0; values are never cut).
      lines.push(paint(caps, spans), paint(caps, [[" ".repeat(Math.max(0, target - width(tagSpans)))], ...tagSpans]));
    }
  });

  lines.push(...renderRawJsonBlock(o.rawRpcJson, caps, { highlight: o.kind === "Refusal" ? o.errorName : undefined, indent: BEAT_INDENT, gutter: false, chunk: Math.max(20, Math.min(BEAT_CHUNK, caps.width - BEAT_INDENT)) }));
  for (const r of noteRows(step, o, caps.width - BEAT_INDENT)) lines.push(lead + paint(caps, r));
  return lines;
}

/**
 * The block for one attempt the chain answered. `step.attempt` is required. A refusal passes when
 * `step.pass` says so (the driver compared the parsed name to the pack's expectation); otherwise the FAIL
 * note takes the place of the PASS line and the raw body is still printed. `counter: false` leaves the `[NN/TT]`
 * off the full style's header, for a block that is one proof and not a step of a run (the burn PROOF, C-T18a).
 * `saved: false` is for a run that writes no files (`demo --sandbox`, final review M3): the full style's `rpc` row
 * then names no fixture file (RPC_NOT_SAVED instead); the default names `demo/fixtures/FIXTURE`.
 */
export function renderRefusalBlock(step: DemoStep, caps: TermCaps, style: StepStyle = "full", opts: { counter?: boolean; saved?: boolean } = {}): string {
  return (style === "beat" ? beatBlock(step, caps) : fullBlock(step, caps, opts.counter !== false, opts.saved !== false)).join("\n");
}
