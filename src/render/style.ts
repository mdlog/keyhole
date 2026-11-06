/**
 * Styling primitives shared by the renderers (built in Task 6; Tasks 7, 8 and 19 use them):
 *
 *   sgr(caps, kind, text)        bold | inverse | pass | fail | runtime | dim | underline
 *   link(caps, url, text)        OSC 8 hyperlink + underline, only when caps.color
 *   stripAnsi(s)                 removes CSI sequences and OSC sequences (OSC 8 links included)
 *   displayWidth(s)              terminal cells, East-Asian-width aware, escapes ignored
 *   glyphs(caps)                 frame, bar, ellipsis, arrow and leader characters, ASCII fallback
 *   wrapVerbatim(text, width, keepWhole?)   rows.join("") === text; never splits a keepWhole span
 *
 * SGR only when caps.color (DESIGN_BRIEF §4): bold for labels and beat headers, inverse for NEAR's voice,
 * PASS 1;30;42, FAIL 1;97;41, RUNTIME 1;30;43, underline + OSC 8 for links, dim for leader dots. No other
 * hue. Styling never changes characters: stripAnsi(colored) equals the uncolored output byte for byte,
 * for the same caps.unicode.
 *
 * Pure string functions: no I/O, no state, nothing happens at import.
 */
import type { TermCaps } from "./term.js";

// ---------------------------------------------------------------------------------------------------
// SGR and links

export type SgrKind = "bold" | "inverse" | "pass" | "fail" | "runtime" | "dim" | "underline";

/**
 * [on, off] per kind. Each style closes with its own off code instead of a full reset (`0`), so styles
 * nest: an inverse name inside a bold line leaves the bold on. Bold and dim share off code 22, so a dim
 * span inside a bold one ends the bold too; nothing in Keyhole nests them.
 *
 * pass, fail and runtime close with `22;39;49`: that also ends an enclosing bold (22) and any foreground
 * or background colour set outside them (39, 49), so a verdict span must not sit inside a bold span or a
 * coloured one. Keyhole prints each verdict as its own span on a line, never nested.
 */
const SGR: Record<SgrKind, readonly [on: string, off: string]> = {
  bold: ["1", "22"],
  dim: ["2", "22"],
  inverse: ["7", "27"],
  underline: ["4", "24"],
  pass: ["1;30;42", "22;39;49"],
  fail: ["1;97;41", "22;39;49"],
  runtime: ["1;30;43", "22;39;49"],
};

/** Wraps one line of text in the SGR pair for `kind`. With caps.color false, or an empty text, it returns the text itself. */
export function sgr(caps: TermCaps, kind: SgrKind, text: string): string {
  if (!caps.color || text === "") return text;
  const [on, off] = SGR[kind];
  return `\x1b[${on}m${text}\x1b[${off}m`;
}

/** Bytes that may not appear in an OSC 8 URI: C0, DEL and C1 controls. Left in, they could end the escape early. */
const URL_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * An underlined OSC 8 hyperlink (`ESC ] 8 ; ; URL ST text ESC ] 8 ; ; ST`) when caps.color; otherwise just
 * the text, so plain output carries no URL it did not print itself. Control characters are dropped from the
 * URL. A URL that is empty after that gives the bare text.
 */
export function link(caps: TermCaps, url: string, text: string): string {
  if (!caps.color) return text;
  const safe = url.replace(URL_CONTROLS, "");
  if (safe === "") return text;
  return `\x1b]8;;${safe}\x1b\\${sgr(caps, "underline", text)}\x1b]8;;\x1b\\`;
}

/** OSC (to BEL or ST) and CSI. The OSC body excludes ESC and BEL, so matching is linear. */
const ANSI_SOURCE = String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]`;
const ANSI_ALL = new RegExp(ANSI_SOURCE, "g");
const ANSI_AT = new RegExp(ANSI_SOURCE, "y");

/** Removes every CSI and OSC sequence. Text that merely contains an ESC byte which starts neither is left alone. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ALL, "");
}

// ---------------------------------------------------------------------------------------------------
// Display width

/**
 * Zero-width code points: combining marks, joiners, direction marks, variation selectors, tags. A minimal
 * table (the common blocks), not full Unicode Mn/Me/Cf; scripts it omits count as one cell per code point.
 */
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7],
  [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0x3099, 0x309a],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0001, 0xe0001], [0xe0020, 0xe007f], [0xe0100, 0xe01ef],
];

/**
 * Two-cell code points: Unicode East Asian Width W and F (Hangul Jamo, CJK, kana, Hangul syllables,
 * fullwidth forms, wide emoji). The emoji blocks are rounded to whole blocks. Ambiguous-width characters
 * (box drawing, arrows, block elements) count as ONE cell: on a terminal that draws them double-wide the
 * operator sets KEYHOLE_ASCII=1 (DESIGN_BRIEF §5.3).
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  // Tangut, Kana Extended-B (with its N gaps at U+1AFF4 and U+1AFFC), Kana Supplement and Extended-A, Small
  // Kana Extension, Nushu (Unicode 15)
  [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb], [0x1affd, 0x1affe], [0x1b000, 0x1b122], [0x1b132, 0x1b132],
  [0x1b150, 0x1b152], [0x1b155, 0x1b155], [0x1b164, 0x1b167], [0x1b170, 0x1b2fb],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

const inTable = (table: ReadonlyArray<readonly [number, number]>, cp: number): boolean => table.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Cells one code point occupies: 0 for controls and combining marks, 2 for East Asian wide, else 1. */
function charWidth(cp: number): number {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1; // the common case: ASCII and Latin-1
  if (inTable(ZERO_WIDTH, cp)) return 0;
  return inTable(WIDE, cp) ? 2 : 1;
}

/** Terminal cells the string occupies once escapes are removed. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

// ---------------------------------------------------------------------------------------------------
// Glyphs

export interface Glyphs {
  /** Frame: horizontal and vertical rules, the four corners, and the T and cross pieces. ASCII: - | + */
  h: string;
  v: string;
  tl: string;
  tr: string;
  bl: string;
  br: string;
  teeL: string;
  teeR: string;
  teeT: string;
  teeB: string;
  cross: string;
  /** The allowance bar: a filled cell and an empty cell. ASCII: # and . */
  fill: string;
  empty: string;
  /** `…` or `...` (the only glyph that is wider in the fallback). */
  ellipsis: string;
  /** `→` or `->`. */
  arrow: string;
  /** One leader-dot cell (`·········`). ASCII: `.` */
  leader: string;
}

const UNICODE_GLYPHS: Glyphs = Object.freeze({
  h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", teeL: "├", teeR: "┤", teeT: "┬", teeB: "┴", cross: "┼",
  fill: "█", empty: "─", ellipsis: "…", arrow: "→", leader: "·",
});

const ASCII_GLYPHS: Glyphs = Object.freeze({
  h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", teeL: "+", teeR: "+", teeT: "+", teeB: "+", cross: "+",
  fill: "#", empty: ".", ellipsis: "...", arrow: "->", leader: ".",
});

/** Depends on caps.unicode only: color never changes a character. Every unicode glyph is one cell wide. */
export function glyphs(caps: TermCaps): Glyphs {
  return caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

// ---------------------------------------------------------------------------------------------------
// Verbatim wrapping

/**
 * Every occurrence of every needle as [start, end), overlapping occurrences merged into their union, keyed
 * by start. A span that two needles share a piece of is therefore one span: neither is split.
 */
function protectedSpans(text: string, needles: readonly string[]): Map<number, number> {
  const found: Array<[number, number]> = [];
  for (const needle of needles) {
    if (needle === "") continue;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push([at, at + needle.length]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const spans = new Map<number, number>();
  let start = -1;
  let end = -1;
  for (const [s, e] of found) {
    if (start !== -1 && s < end) end = Math.max(end, e);
    else [start, end] = [s, e];
    spans.set(start, end);
  }
  return spans;
}

/**
 * Hard-wraps `text` into rows of at most `width` terminal cells, cutting exactly where the width runs out.
 * No character is added, dropped, trimmed or reordered: `rows.join("") === text`.
 *
 * - A keepWhole span (every occurrence of every string in `keepWhole`) is never split: when it does not
 *   fit in what is left of the row it starts the next row, and when it is wider than `width` it gets a
 *   row of its own, overlong. Overlapping occurrences count as one span. The guarantee holds only for
 *   an occurrence that does not start inside an ANSI or OSC sequence of the text: the sequence is taken
 *   as one piece first, so a needle that begins within it is not seen. renderRawJsonBlock passes
 *   ESC-free text (its controls are neutralized first), so the guarantee holds there.
 * - A wide character that does not fit moves to the next row; on a width-1 row it stands alone, overlong.
 * - Zero-width material (combining marks, joiners, ANSI and OSC sequences) stays with the character
 *   before it, and an escape sequence is never cut. Styled input is allowed, but a style that is open at a
 *   row end stays open on the next row: wrap plain text, then style each row.
 * - `width` is floored and clamped to at least 1. Empty text gives `[""]`, so there is always a first row.
 */
export function wrapVerbatim(text: string, width: number, keepWhole: readonly string[] = []): string[] {
  const limit = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const spans = protectedSpans(text, keepWhole);
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  let i = 0;
  while (i < text.length) {
    let piece: string;
    let w: number;
    const spanEnd = spans.get(i);
    if (spanEnd !== undefined) {
      piece = text.slice(i, spanEnd);
      w = displayWidth(piece);
    } else {
      ANSI_AT.lastIndex = i;
      const escape = text.charCodeAt(i) === 0x1b ? ANSI_AT.exec(text) : null;
      if (escape) {
        piece = escape[0];
        w = 0;
      } else {
        const cp = text.codePointAt(i)!;
        piece = String.fromCodePoint(cp);
        w = charWidth(cp);
      }
    }
    i += piece.length;
    if (w === 0 && spanEnd === undefined) {
      row += piece; // zero-width: it belongs to whatever precedes it
      continue;
    }
    if (rowWidth > 0 && rowWidth + w > limit) {
      rows.push(row);
      row = "";
      rowWidth = 0;
    }
    row += piece;
    rowWidth += w;
  }
  rows.push(row);
  return rows;
}

/**
 * `text` word-wrapped to `width` columns: the first line starts with `lead`, the rest with `hang`. Lines break at a
 * single space, which the break replaces; a word wider than the line is never cut (that line runs long). It lives
 * here, with the other layout primitives, so that a command that only prints (burn) does not import the wrap command
 * for it (C-T18c).
 */
export function wrapWords(text: string, width: number, lead: string, hang: string): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = lead + words[0];
  for (const word of words.slice(1)) {
    if (displayWidth(`${line} ${word}`) <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = hang + word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * `parts` joined with ` · `, broken before a ` · ` where the width runs out; a continuation row starts with `hang`, then
 * `· `. A part wider than a row gets one of its own, overlong: nothing is cut. (burn's session line, wrap's hint, C-T20e.)
 */
export function joinAtDots(parts: readonly string[], width: number, hang = ""): string[] {
  const lines: string[] = [];
  let line = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    if (displayWidth(`${line} · ${part}`) <= width) line += ` · ${part}`;
    else {
      lines.push(line);
      line = `${hang}· ${part}`;
    }
  }
  lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------------------------------
// Neutralizing control characters

/**
 * What neutralizeControls maps: C0 controls (including TAB, LF, CR, BEL and ESC), DEL, the C1 controls
 * U+0080 to U+009F (including the 8-bit CSI and OSC introducers), the bidirectional controls U+061C,
 * U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069, and the separators U+2028 and U+2029. Every one is
 * a single UTF-16 unit.
 */
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `\uXXXX` for one such character: four lower-case hex digits, the JSON escape. */
const controlEscape = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * Replaces each control or text-reordering character with its visible JSON escape `\uXXXX` (four
 * lower-case hex digits), so ESC prints as the text `\u001b`, LF as `\u000a`, TAB as `\u0009`. For text
 * that came from outside Keyhole (an RPC body, an error name parsed from one) before it is printed.
 * The set: C0 (LF, TAB and CR included), DEL, C1, U+061C, U+200E, U+200F, U+2028, U+2029, U+202A to
 * U+202E and U+2066 to U+2069. Three reasons:
 *
 * 1. Terminal escape injection. A terminal acts on ESC sequences (CSI, OSC 8 links, title and clipboard
 *    writes), on BEL, and on CR, which overwrites the line; the 8-bit C1 forms (U+009B, U+009D) do the same
 *    on terminals that read them.
 * 2. Flush-left line forgery. A raw LF (or U+2028, U+2029) in a hostile body starts a new physical line
 *    with no gutter, so `PASS: refused by protocol (Fake)` could appear exactly where Keyhole prints its
 *    own verdict. A TAB hides cells from displayWidth, which counts it as zero.
 * 3. Trojan-Source reordering. The bidi controls (marks, embeddings, overrides and isolates) change the
 *    on-screen order of the text around them, so what a reader sees is not the bytes that were sent.
 *
 * Plain ASCII text, and the other zero-width characters (ZWJ, variation selectors, combining marks), are
 * left alone. Returns a new string; nothing is mutated, and callers keep the original for storage.
 */
export function neutralizeControls(text: string): string {
  return text.replace(CONTROLS, controlEscape);
}

/** The distinct escapes neutralizeControls writes for this text, in first-seen order. Empty when it writes none. */
export function controlEscapes(text: string): string[] {
  return [...new Set((text.match(CONTROLS) ?? []).map(controlEscape))];
}
