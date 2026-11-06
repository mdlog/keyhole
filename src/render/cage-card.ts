/**
 * CageCard renderer (LAYOUT "CageCard: the design carrier"; DESIGN_BRIEF §5.1): the rating plate that shows
 * what a scoped session key may and may not do, and who enforces each limit.
 *
 *   cageCardRows(card)   the one row model (R16c): label, VALUE lines and ENFORCED BY per row. The plate, the
 *                        mcp text and the status page (Task 23) all render from it.
 *   renderCageCard(...)  full (98 cells: LABEL 11 · VALUE 58 · ENFORCED BY 21 and a right border), narrow
 *                        (80-98 cells: VALUE = columns - 40, 10-cell bar), compact (4 lines; 5 when the key line
 *                        breaks before ` on `, C-T16a) and mcp
 *                        (`LABEL: value (ENFORCED BY)` lines, pure ASCII: no escapes, no glyphs, no wrapping).
 *
 * A key or a hash is never shortened, in any variant. A value wider than its column continues on the next
 * row. Prose breaks at spaces; a single word wider than the column (an account id, a public key, a code
 * hash, raw panic text) is cut at the column edge. Wrapping measures plain text; the styles go on afterwards,
 * one span at a time, so no style is open at a row end (C-T6e).
 *
 * A burned key (chain or replay card with `key === null`) is drawn as burned, never as callable: METHOD says
 * `key burned`, GAS draws no bar. An allowance that is null on chain draws no bar either, and says so.
 *
 * Every string that can come from a chain read (account ids, method names, evidence, code hashes, the
 * exposure value, the timestamp) passes through neutralizeControls before it is printed (C-T6d). Pure string
 * functions: no I/O, no state, nothing happens at import.
 */
import { formatNear } from "../core/amounts.js";
import type { CageCard, Classification, ToolSchema } from "../core/types.js";
import { displayWidth, glyphs, neutralizeControls, sgr, wrapVerbatim } from "./style.js";
import type { TermCaps } from "./term.js";

/** full = 98 cells (from 100 columns) · narrow = 80-98 cells (VALUE under its row's width) · compact = 4 lines, 5 with a broken key line (R4 phase 2) · mcp = text for keyhole_inspect. */
export type CageCardVariant = "full" | "narrow" | "compact" | "mcp";

/** The ENFORCED BY column takes exactly one of these (DESIGN_BRIEF §5.1). */
export type Enforcer = "PROTOCOL" | "KEYHOLE server-side" | "OPERATOR" | "NOT A KEY LIMIT" | "—";

/** The state tag at the top right of the plate. */
export type CardTag = "PREVIEW" | "LIVE" | "BURNED" | "REPLAY";

/** Plain text with an optional style hint: leader dots are dim, `fails-without-deposit (runtime)` takes the RUNTIME style. */
export interface CardSpan {
  text: string;
  kind?: "dim" | "runtime";
}

/** One logical line of a VALUE, before wrapping. `verbatim` lines (raw panic text) are cut at the column, never at words. */
export interface CardLine {
  spans: CardSpan[];
  verbatim?: boolean;
}

/** One row of the plate. Line 0 sits on the label's row; further lines are continuation rows. */
export interface CageCardRow {
  label: string;
  lines: CardLine[];
  enforcedBy: Enforcer;
}

export interface CageCardRowOptions {
  /** Glyphs for the leader dots and the bar. Default true (the status page); the terminal passes caps.unicode. */
  unicode?: boolean;
  /** Bar width in cells. Default 20; narrow and mcp use 10. */
  barCells?: number;
  /**
   * Spell Keyhole's own fixed copy in ASCII (`·` as `-`, `—` as `--`): the mcp text. Strings that came from a
   * chain read are never transliterated, only neutralized. Default false.
   */
  ascii?: boolean;
}

/** Column widths (DESIGN_BRIEF §5.1). A plate row is `| ` LABEL VALUE `   ` ENFORCED BY `  |`: 40 cells besides VALUE. */
const LABEL_WIDTH = 11;
const ENFORCED_WIDTH = 21;
const ROW_CHROME = 40;
const PLATE_MAX = 98;
const FULL_BAR = 20;
const NARROW_BAR = 10;
/** METHOD shows at most this many out-of-scope methods, then `+N more not in allowlist`. */
const OUT_OF_SCOPE_SHOWN = 3;
/** Leader dots between a method and its classification, at least. */
const LEADER_MIN = 8;
/** The compact card's key line, broken before ` on `, hangs its second row here: the step log's 8-column indent (C-T16a). */
const KEY_HANG = " ".repeat(8);

const NOT_IN_ALLOWLIST: Classification = "not in allowlist";
const RUNTIME_LABEL: Classification = "fails-without-deposit (runtime)";

/** Chain-sourced text on its way to a terminal, a transcript or MCP text. */
const safe = neutralizeControls;

const text = (t: string, kind?: CardSpan["kind"]): CardSpan => (kind === undefined ? { text: t } : { text: t, kind });
const plain = (...spans: CardSpan[]): CardLine => ({ spans });
const flat = (line: CardLine): string => line.spans.map((s) => s.text).join("");

// ---------------------------------------------------------------------------------------------------
// The card as data

/** A chain or replay card whose key the chain does not have: every row of it says `key burned`. */
const isBurned = (card: CageCard): boolean => card.key === null && card.source !== "preview";

/** The separator of Keyhole's fixed copy: ` · `, or ` - ` in the ASCII spelling. */
const dotOf = (ascii: boolean): string => (ascii ? " - " : " · ");

/**
 * What the plate says about the card itself: the title, the state tag and the source line of the footer.
 * The tag is BURNED only for a chain card without a key; a replay card without one stays REPLAY.
 * A replay card's footer names the run it was recorded in: `opts.runId` (a replayed DemoRun's id, which is not
 * the session id), else the session's.
 */
export function cageCardFrame(card: CageCard, opts: { ascii?: boolean; runId?: string } = {}): { title: string; tag: CardTag; footer: string } {
  const { session } = card;
  const dot = dotOf(opts.ascii ?? false);
  const tag: CardTag = card.source === "preview" ? "PREVIEW" : card.source === "replay" ? "REPLAY" : card.key === null ? "BURNED" : "LIVE";
  const footer =
    card.source === "preview"
      ? `PREVIEW${dot}nothing signed${dot}requested scope + sandbox dry-run`
      : card.source === "replay"
        ? `REPLAY of run ${safe(opts.runId ?? session.id)} recorded ${safe(card.readAt)}`
        : `read from chain: view_access_key${dot}${safe(card.readAt)}`;
  return { title: `keyhole${dot}cage card${dot}${safe(session.id)}${dot}${safe(session.network)}`, tag, footer };
}

/** The call tools of the card by method (a method once), allowed ones first. An unclassified tool counts as inconclusive. */
function methodEntries(card: CageCard): { allowed: Array<{ method: string; classification: Classification; evidence?: string }>; outOfScope: string[] } {
  const seen = new Set<string>();
  const allowed: Array<{ method: string; classification: Classification; evidence?: string }> = [];
  const outOfScope: string[] = [];
  for (const tool of card.tools) {
    if (tool.kind !== "call" || tool.method === null || seen.has(tool.method)) continue;
    seen.add(tool.method);
    const classification = tool.classification ?? "inconclusive";
    if (classification === NOT_IN_ALLOWLIST) outOfScope.push(tool.method);
    else allowed.push({ method: tool.method, classification, evidence: tool.evidence });
  }
  return { allowed, outOfScope };
}

function viewMethods(tools: readonly ToolSchema[]): string[] {
  return [...new Set(tools.filter((t) => t.kind === "view" && t.method !== null).map((t) => t.method!))];
}

/** The allowance as the GAS row and the compact line say it. Only `requested` and `left` draw a bar. */
type Gas =
  | { mode: "burned" }
  | { mode: "uncapped"; detail: string }
  | { mode: "requested" | "left"; bar: string; detail: string };

function gasParts(card: CageCard, cells: number, unicode: boolean): Gas {
  if (isBurned(card)) return { mode: "burned" };
  const g = glyphs({ color: false, unicode, width: 0, tty: false });
  const initialText = formatNear(card.session.allowanceYocto);
  const bar = (filled: number): string => g.fill.repeat(filled) + g.empty.repeat(cells - filled);
  if (card.source === "preview") return { mode: "requested", bar: bar(cells), detail: `${initialText} NEAR requested` };
  const remaining = card.key?.allowanceRemainingYocto ?? null;
  if (remaining === null) return { mode: "uncapped", detail: `NO CAP ON CHAIN (wrap set ${initialText} NEAR)` };
  const leftText = formatNear(remaining); // validates the decimal string before BigInt reads it
  const total = BigInt(card.session.allowanceYocto);
  const filled = total > 0n ? Math.min(cells, Math.max(0, Number((BigInt(cells) * BigInt(remaining)) / total))) : 0;
  return { mode: "left", bar: bar(filled), detail: `${leftText} of ${initialText} NEAR` };
}

/**
 * The rows of the plate in order (R16c). The chain read wins over the local session when there is one
 * (receiver, signer, public key); PREVIEW has only the session. `not in allowlist` is taken from the card's
 * tools as buildCageCard classified them.
 */
export function cageCardRows(card: CageCard, opts: CageCardRowOptions = {}): CageCardRow[] {
  const unicode = opts.unicode ?? true;
  const cells = opts.barCells ?? FULL_BAR;
  const ascii = opts.ascii ?? false;
  const dot = dotOf(ascii);
  const g = glyphs({ color: false, unicode, width: 0, tty: false });
  const burned = isBurned(card);
  const { session, key } = card;
  const rows: CageCardRow[] = [];
  const row = (label: string, enforcedBy: Enforcer, ...lines: CardLine[]): void => void rows.push({ label, lines, enforcedBy });

  row("RECEIVER", "PROTOCOL", plain(text(safe(key?.receiverId ?? session.receiverId))));

  const signer = safe(key?.accountId ?? session.accountId);
  row("SIGNER", "—", plain(text(session.mode === "subaccount" ? `${signer}${dot}sub-account ${safe(session.id)}` : `${signer}${dot}on-account`)));

  const { allowed, outOfScope } = methodEntries(card);
  const shownOut = outOfScope.slice(0, OUT_OF_SCOPE_SHOWN);
  const shown = [...allowed.map((a) => a.method), ...shownOut];
  const nameWidth = Math.max(0, ...shown.map((m) => displayWidth(safe(m))));
  // A burned key can call nothing: whatever the dry-run said at wrap, the row says so (and drops the evidence).
  const methodLine = (method: string, label: Classification): CardLine => {
    const name = safe(method);
    const verdict = burned ? text("key burned", "dim") : text(label, label === RUNTIME_LABEL ? "runtime" : undefined);
    return plain(text(name), text(" "), text(g.leader.repeat(LEADER_MIN + nameWidth - displayWidth(name)), "dim"), text(" "), verdict);
  };
  for (const a of allowed) {
    const lines = [methodLine(a.method, a.classification)];
    if (!burned && a.classification === "inconclusive" && a.evidence) lines.push({ spans: [text(safe(a.evidence))], verbatim: true });
    row("METHOD", "PROTOCOL", ...lines);
  }
  for (const method of shownOut) row("METHOD", "PROTOCOL", methodLine(method, NOT_IN_ALLOWLIST));
  if (outOfScope.length > OUT_OF_SCOPE_SHOWN) row("METHOD", "PROTOCOL", plain(text(`+${outOfScope.length - OUT_OF_SCOPE_SHOWN} more not in allowlist`)));
  if (shown.length === 0) row("METHOD", "PROTOCOL", plain(text("none listed")));

  row("ACTIONS", "PROTOCOL", plain(text("one FunctionCall per tx; no Transfer, no AddKey")));
  row("DEPOSIT", "PROTOCOL", plain(text("0 only; methods that demand one fail at runtime")));

  // The GAS row: a bar only where there is an allowance to draw. A key burned has none (the protocol rejects
  // any tx it signs); a null allowance on chain is no key limit at all.
  const gas = gasParts(card, cells, unicode);
  if (gas.mode === "burned") row("GAS", "PROTOCOL", plain(text(`key burned${dot}no allowance left`)));
  else if (gas.mode === "uncapped") row("GAS", "NOT A KEY LIMIT", plain(text(gas.detail)));
  else row("GAS", "PROTOCOL", plain(text(gas.bar), text(` ${gas.detail}${gas.mode === "left" ? " left" : ""}${dot}gas only`)));

  const pin = safe(session.codeHashPin);
  if (card.codeHashNow === null) row("CODE HASH", "KEYHOLE server-side", plain(text(`${pin}${dot}not checked`)));
  else if (card.codeHashNow === session.codeHashPin) row("CODE HASH", "KEYHOLE server-side", plain(text(`${pin}${dot}match`)));
  else {
    row("CODE HASH", "KEYHOLE server-side", plain(text(`CHANGED ${ascii ? "--" : "—"} serve refuses every call`)), plain(text(`pinned ${pin}`)), plain(text(`now    ${safe(card.codeHashNow)}`)));
  }

  row(card.exposure.label, "NOT A KEY LIMIT", plain(text(safe(card.exposure.value))));
  row("EXPIRY", "OPERATOR", plain(text(`none in the protocol; ends at keyhole burn ${safe(session.id)}`)));
  row("KEY", "—", plain(text(burned ? "no such key on chain (view_access_key)" : safe(key?.publicKey ?? session.publicKey))));

  const views = viewMethods(card.tools).map(safe);
  row("VIEWS", "—", plain(text(views.length > 0 ? `${views.join(", ")}: read-only, no key needed` : "none declared")));
  return rows;
}

// ---------------------------------------------------------------------------------------------------
// Wrapping

interface Token {
  text: string;
  kind?: CardSpan["kind"];
  space: boolean;
  width: number;
}

const WORDS_AND_SPACES = / +|[^ ]+/g;

function tokenize(spans: readonly CardSpan[]): Token[] {
  const tokens: Token[] = [];
  for (const span of spans) {
    for (const m of span.text.matchAll(WORDS_AND_SPACES)) {
      tokens.push({ text: m[0], kind: span.kind, space: m[0][0] === " ", width: displayWidth(m[0]) });
    }
  }
  return tokens;
}

/** Adjacent spans of one kind become one, so a styled phrase is one escape pair. */
function coalesce(spans: readonly CardSpan[]): CardSpan[] {
  const out: CardSpan[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last !== undefined && last.kind === span.kind) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

/**
 * Greedy word wrap into rows of at most `width` cells. It drops the space at a break, spaces before a row's
 * first word and spaces after its last word; every other character is kept, so joining the rows with one
 * space each gives the text back when it had single spaces. A word that fits a row is never split; one wider
 * than a row starts its own row and is cut at the column edge, so no word is ever shortened.
 */
function wrapWords(spans: readonly CardSpan[], width: number): CardSpan[][] {
  const rows: CardSpan[][] = [];
  let row: Token[] = [];
  let used = 0;
  const flush = (): void => {
    while (row.length > 0 && row[row.length - 1].space) row.pop();
    rows.push(coalesce(row.map((t) => text(t.text, t.kind))));
    row = [];
    used = 0;
  };
  for (const token of tokenize(spans)) {
    if (token.space) {
      if (used === 0) continue;
      if (used + token.width <= width) {
        row.push(token);
        used += token.width;
      } else flush();
      continue;
    }
    if (used > 0 && used + token.width > width) flush();
    if (token.width <= width) {
      row.push(token);
      used += token.width;
      continue;
    }
    const pieces = wrapVerbatim(token.text, width);
    for (const piece of pieces.slice(0, -1)) rows.push([text(piece, token.kind)]);
    const rest = pieces[pieces.length - 1];
    row = [{ text: rest, kind: token.kind, space: false, width: displayWidth(rest) }];
    used = displayWidth(rest);
  }
  if (row.length > 0 || rows.length === 0) flush();
  return rows;
}

function wrapLine(line: CardLine, width: number): CardSpan[][] {
  if (line.verbatim) return wrapVerbatim(flat(line), width).map((piece) => [text(piece)]);
  return wrapWords(line.spans, width);
}

// ---------------------------------------------------------------------------------------------------
// The plate

function styleSpan(caps: TermCaps, span: CardSpan): string {
  return span.kind === "dim" ? sgr(caps, "dim", span.text) : span.kind === "runtime" ? sgr(caps, "runtime", span.text) : span.text;
}

/** `text` padded with blanks to `width` cells; the style wraps the text only. */
function cell(styled: string, plainWidth: number, width: number): string {
  return styled + " ".repeat(Math.max(0, width - plainWidth));
}

function renderPlate(card: CageCard, caps: TermCaps, narrow: boolean, runId?: string): string {
  const g = glyphs(caps);
  const width = Math.min(caps.width, PLATE_MAX);
  const valueWidth = width - ROW_CHROME;
  const { title, tag, footer } = cageCardFrame(card, { runId });
  const out: string[] = [];

  const tagText = `[${tag}]`;
  const topRule = Math.max(1, width - displayWidth(`${g.tl}${g.h} `) - displayWidth(title) - 2 - displayWidth(tagText) - displayWidth(` ${g.h}${g.tr}`));
  out.push(`${g.tl}${g.h} ${title} ${g.h.repeat(topRule)} ${sgr(caps, "bold", tagText)} ${g.h}${g.tr}`);

  let previousLabel = "";
  for (const r of cageCardRows(card, { unicode: caps.unicode, barCells: narrow ? NARROW_BAR : FULL_BAR })) {
    const wrapped = r.lines.flatMap((line) => wrapLine(line, valueWidth));
    wrapped.forEach((spans, i) => {
      const label = i === 0 && r.label !== previousLabel ? r.label : "";
      const labelCell = label === "" ? " ".repeat(LABEL_WIDTH) : cell(sgr(caps, "bold", label), displayWidth(label), LABEL_WIDTH);
      const valueCell = cell(coalesce(spans).map((s) => styleSpan(caps, s)).join(""), spans.reduce((w, s) => w + displayWidth(s.text), 0), valueWidth);
      const enforcer = i === 0 ? r.enforcedBy : "";
      const enforcedCell = cell(enforcer === "PROTOCOL" ? sgr(caps, "inverse", enforcer) : enforcer, displayWidth(enforcer), ENFORCED_WIDTH);
      out.push(`${g.v} ${labelCell}${valueCell}   ${enforcedCell}  ${g.v}`);
    });
    previousLabel = r.label;
  }

  const bottomRule = Math.max(1, width - displayWidth(g.bl) - 1 - displayWidth(footer) - displayWidth(` ${g.h}${g.br}`));
  out.push(`${g.bl}${g.h.repeat(bottomRule)} ${footer} ${g.h}${g.br}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// The mcp text

/**
 * `LABEL: value (ENFORCED BY)` per row; the identity rows (`—`) have no parenthesis. Pure ASCII (Global
 * Constraints, variant `mcp`): Keyhole's own copy is spelled with `-` and `--`, the rows are drawn with `#`
 * and `.`, and strings from a chain read are neutralized, never transliterated. No escapes, no wrapping.
 */
function renderMcp(card: CageCard, runId?: string): string {
  const { title, tag, footer } = cageCardFrame(card, { ascii: true, runId });
  const out = [`${title} [${tag}]`];
  for (const r of cageCardRows(card, { unicode: false, barCells: NARROW_BAR, ascii: true })) {
    const [first, ...rest] = r.lines.map(flat);
    out.push(`${r.label}: ${first}${r.enforcedBy === "—" ? "" : ` (${r.enforcedBy})`}`);
    for (const line of rest) out.push(`  ${line}`);
  }
  out.push(footer);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// The compact card

/**
 * Four lines: key, may call, gas, code_hash. The public key and the code hash are printed whole (Global Constraints,
 * clash 4); they are never cut. A key line wider than caps.width breaks before ` on ` into two rows, the second hung
 * at 8 columns (C-T16a: 112-113 cells on real testnet ids, which Take C records at 100x30), so the card is then five
 * rows. A row can still run wider than a very narrow terminal: the key alone is 52 cells. A card whose key the chain
 * does not have says so on every line.
 */
function renderCompact(card: CageCard, caps: TermCaps): string {
  const g = glyphs(caps);
  const { session, key } = card;
  const label = (t: string): string => sgr(caps, "bold", t);
  const burned = isBurned(card);

  const { allowed, outOfScope } = methodEntries(card);
  const groups = (["callable", RUNTIME_LABEL, "inconclusive"] as const)
    .map((cls) => ({ cls, names: allowed.filter((a) => a.classification === cls).map((a) => safe(a.method)) }))
    .filter((grp) => grp.names.length > 0)
    .map((grp) => `${grp.names.join(", ")} (${grp.cls})`);
  const refused = outOfScope.slice(0, OUT_OF_SCOPE_SHOWN).map(safe).join(", ");
  const more = outOfScope.length > OUT_OF_SCOPE_SHOWN ? ` +${outOfScope.length - OUT_OF_SCOPE_SHOWN} more` : "";
  const mayCall = burned
    ? `${label("may call")} nothing (key burned)`
    : `${label("may call")} ${groups.length > 0 ? groups.join(", ") : "nothing"}${outOfScope.length > 0 ? ` · not ${refused}${more}` : ""}`;

  const gas = gasParts(card, caps.width >= 100 ? FULL_BAR : NARROW_BAR, caps.unicode);
  const gasLine =
    gas.mode === "burned" ? "none · key burned" : gas.mode === "uncapped" ? gas.detail : `${gas.bar} ${gas.detail} · gas only`;
  const pin = safe(session.codeHashPin);
  const pinState =
    card.codeHashNow === null ? "not checked" : card.codeHashNow === session.codeHashPin ? "pinned" : "CHANGED — serve refuses every call";
  const burnedTag = cageCardFrame(card).tag === "BURNED" ? " [BURNED]" : "";

  // C-T16a: on testnet ids the key line is 112-113 cells (a 52-cell key, a 23-cell seat, a 26-cell DAO). Wider than
  // the terminal, it breaks before ` on ` and the rest hangs at 8 columns, the step log's indent. Nothing is cut.
  const keyHead = `${label("key")} ${safe(key?.publicKey ?? session.publicKey)}`;
  const keyTail = `on ${safe(key?.accountId ?? session.accountId)} ${g.arrow} ${safe(key?.receiverId ?? session.receiverId)}${burnedTag}`;
  const keyLine = `${keyHead} ${keyTail}`;

  return [
    ...(displayWidth(keyLine) <= caps.width ? [keyLine] : [keyHead, `${KEY_HANG}${keyTail}`]),
    mayCall,
    `${label("gas")} ${gasLine}`,
    `${label("code_hash")} ${pin} · ${pinState} (KEYHOLE server-side)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Entry point

/**
 * `full` is rendered as `narrow` when caps.width is 80-99 and as `mcp` below 80; an explicit `narrow` below 80
 * is `mcp` too (a 40-cell VALUE column needs 80 columns). `compact` ignores the width, except that its bar is
 * 10 cells below 100 columns and its key line breaks before ` on ` when wider than the width (C-T16a). `mcp` is
 * pure ASCII and never uses color, even on a color TTY.
 * `runId` is for a replay card (C-T7b): the id of the DemoRun it was recorded in, which differs from the session
 * id (`live-sandbox-…` against `ks-f298`), for the footer's `REPLAY of run …`. CageCard itself has no run id.
 */
export function renderCageCard(card: CageCard, variant: CageCardVariant, caps: TermCaps, runId?: string): string {
  if (variant === "compact") return renderCompact(card, caps);
  if (variant === "mcp" || caps.width < 80) return renderMcp(card, runId);
  return renderPlate(card, caps, variant === "narrow" || caps.width < 100, runId);
}
