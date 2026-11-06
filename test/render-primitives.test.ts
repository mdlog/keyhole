/**
 * Task 6: render primitives. termCaps, the style helpers (sgr, link, stripAnsi, displayWidth, glyphs,
 * wrapVerbatim), TxLine, RuleStrip and RawJsonBlock. Pure string functions: no I/O, no chain.
 *
 * Expected strings are written out by hand from the brief and LAYOUT, not computed with the code under test.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RULE_SLOTS, renderRuleStrip } from "../src/render/rule-strip.js";
import { renderRawJsonBlock } from "../src/render/raw-json-block.js";
import { passRefused } from "../src/render/strings.js";
import { controlEscapes, displayWidth, glyphs, link, neutralizeControls, sgr, stripAnsi, wrapVerbatim, wrapWords } from "../src/render/style.js";
import { termCaps } from "../src/render/term.js";
import type { TermCaps } from "../src/render/term.js";
import { renderTxLine, renderTxLineRows } from "../src/render/tx-line.js";
import { REPO, SANDBOX_FIXTURES, color100, plain100, plain80, readFixture } from "./helpers.js";

const H = "4fTqHq4nXjPnM2cEvJm1uYtT3rBuw5a4Hb1sVQq9Ka2"; // a base58-shaped 43-char hash; public-looking sample
const ESC = "\x1b";

afterEach(() => vi.unstubAllEnvs());

describe("termCaps", () => {
  it("a UTF-8 color TTY gets color, unicode, its own width and tty", () => {
    expect(termCaps({ isTTY: true, columns: 120 }, { TERM: "xterm-256color", LANG: "en_US.UTF-8" })).toEqual({ color: true, unicode: true, width: 120, tty: true });
  });

  it("NO_COLOR turns off both color and unicode, even on a UTF-8 TTY", () => {
    expect(termCaps({ isTTY: true }, { NO_COLOR: "1", LANG: "en_US.UTF-8" })).toMatchObject({ color: false, unicode: false });
  });

  it("an empty NO_COLOR counts as unset (no-color.org)", () => {
    expect(termCaps({ isTTY: true, columns: 100 }, { NO_COLOR: "", TERM: "xterm", LANG: "C.UTF-8" })).toMatchObject({ color: true, unicode: true });
  });

  it("TERM=dumb has no color", () => {
    expect(termCaps({ isTTY: true }, { TERM: "dumb" }).color).toBe(false);
  });

  it("a TTY with no TERM at all still gets color", () => {
    expect(termCaps({ isTTY: true }, {}).color).toBe(true);
  });

  it("FORCE_COLOR=1 gives color on a pipe, and beats NO_COLOR and TERM=dumb; unicode needs a TTY", () => {
    expect(termCaps({ isTTY: false }, { FORCE_COLOR: "1" }).color).toBe(true);
    expect(termCaps({ isTTY: false }, { FORCE_COLOR: "1", LANG: "en_US.UTF-8" })).toMatchObject({ color: true, unicode: false, tty: false });
    expect(termCaps({ isTTY: true }, { FORCE_COLOR: "1", NO_COLOR: "1", TERM: "dumb" })).toMatchObject({ color: true, unicode: false });
  });

  it("only FORCE_COLOR=1 forces: other values leave the TTY rules in charge", () => {
    expect(termCaps({ isTTY: false }, { FORCE_COLOR: "0" }).color).toBe(false);
    expect(termCaps({ isTTY: false }, { FORCE_COLOR: "" }).color).toBe(false);
  });

  it("a pipe has no color and no unicode, even with a UTF-8 locale", () => {
    expect(termCaps({ isTTY: false }, { TERM: "xterm-256color", LANG: "en_US.UTF-8" })).toEqual({ color: false, unicode: false, width: 100, tty: false });
  });

  it("width: a TTY reports its columns; a pipe reads COLUMNS, else 100", () => {
    expect(termCaps({ isTTY: false }, { COLUMNS: "80" }).width).toBe(80);
    expect(termCaps({ isTTY: false }, {}).width).toBe(100);
    expect(termCaps({ isTTY: true, columns: 132 }, { COLUMNS: "80" }).width).toBe(132);
    expect(termCaps({ isTTY: false, columns: 132 }, { COLUMNS: "80" }).width).toBe(80);
  });

  it("width: a TTY without columns falls back to COLUMNS, then 100; junk values are ignored", () => {
    expect(termCaps({ isTTY: true }, { COLUMNS: "90" }).width).toBe(90);
    expect(termCaps({ isTTY: true }, {}).width).toBe(100);
    for (const junk of ["", "0", "-5", "abc", "80x", "8.5", " 80"]) expect(termCaps({ isTTY: false }, { COLUMNS: junk }).width).toBe(100);
    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 79.5]) expect(termCaps({ isTTY: true, columns: junk }, {}).width).toBe(100);
  });

  it("KEYHOLE_ASCII=1 forces ASCII glyphs and keeps color", () => {
    expect(termCaps({ isTTY: true }, { KEYHOLE_ASCII: "1", LANG: "C.UTF-8" }).unicode).toBe(false);
    expect(termCaps({ isTTY: true }, { KEYHOLE_ASCII: "1", LANG: "C.UTF-8", TERM: "xterm" }).color).toBe(true);
    expect(termCaps({ isTTY: true }, { KEYHOLE_ASCII: "0", LANG: "C.UTF-8" }).unicode).toBe(true);
  });

  it("unicode needs a UTF-8 locale: LC_ALL beats LC_CTYPE beats LANG; UTF8 and utf-8 both match", () => {
    const tty = { isTTY: true };
    expect(termCaps(tty, { LANG: "en_US.UTF-8" }).unicode).toBe(true);
    expect(termCaps(tty, { LANG: "en_US.utf8" }).unicode).toBe(true);
    expect(termCaps(tty, { LC_CTYPE: "de_DE.UTF-8" }).unicode).toBe(true);
    expect(termCaps(tty, { LC_ALL: "C.UTF-8" }).unicode).toBe(true);
    expect(termCaps(tty, {}).unicode).toBe(false);
    expect(termCaps(tty, { LANG: "C" }).unicode).toBe(false);
    expect(termCaps(tty, { LANG: "en_US.ISO-8859-1" }).unicode).toBe(false);
    expect(termCaps(tty, { LC_ALL: "C", LANG: "en_US.UTF-8" }).unicode).toBe(false);
    expect(termCaps(tty, { LC_ALL: "", LANG: "en_US.UTF-8" }).unicode).toBe(true);
    expect(termCaps(tty, { LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" }).unicode).toBe(false);
    expect(termCaps(tty, { LC_ALL: "en_US.UTF-8", LANG: "C" }).unicode).toBe(true);
  });

  it("reads process.env when no env is passed", () => {
    vi.stubEnv("COLUMNS", "77");
    vi.stubEnv("FORCE_COLOR", "1");
    expect(termCaps({ isTTY: false })).toMatchObject({ width: 77, color: true });
  });

  it("never mutates the env it is given", () => {
    const env = { TERM: "xterm", LANG: "C.UTF-8" };
    termCaps({ isTTY: true, columns: 90 }, env);
    expect(env).toEqual({ TERM: "xterm", LANG: "C.UTF-8" });
  });
});

describe("sgr", () => {
  const on = { ...plain100, color: true };
  const off = plain100;

  it("emits the DESIGN §4 codes, each closed with its own off code", () => {
    expect(sgr(on, "bold", "x")).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(sgr(on, "dim", "x")).toBe(`${ESC}[2mx${ESC}[22m`);
    expect(sgr(on, "inverse", "x")).toBe(`${ESC}[7mx${ESC}[27m`);
    expect(sgr(on, "underline", "x")).toBe(`${ESC}[4mx${ESC}[24m`);
    expect(sgr(on, "pass", "PASS")).toBe(`${ESC}[1;30;42mPASS${ESC}[22;39;49m`);
    expect(sgr(on, "fail", "FAIL")).toBe(`${ESC}[1;97;41mFAIL${ESC}[22;39;49m`);
    expect(sgr(on, "runtime", "RUNTIME")).toBe(`${ESC}[1;30;43mRUNTIME${ESC}[22;39;49m`);
  });

  it("returns the text untouched when caps.color is false", () => {
    for (const kind of ["bold", "inverse", "pass", "fail", "runtime", "dim", "underline"] as const) expect(sgr(off, kind, "text")).toBe("text");
  });

  it("stripAnsi undoes every kind byte for byte, and an empty text stays empty", () => {
    for (const kind of ["bold", "inverse", "pass", "fail", "runtime", "dim", "underline"] as const) expect(stripAnsi(sgr(on, kind, "a b·c"))).toBe("a b·c");
    expect(sgr(on, "bold", "")).toBe("");
  });

  it("nests: an inverse span inside a bold one leaves the bold on after it closes", () => {
    const s = sgr(on, "bold", `a ${sgr(on, "inverse", "NAME")} b`);
    expect(s).toBe(`${ESC}[1ma ${ESC}[7mNAME${ESC}[27m b${ESC}[22m`);
    expect(stripAnsi(s)).toBe("a NAME b");
  });

  it("uses no hue other than the three verdict pairs: foregrounds 30/97 on backgrounds 41/42/43 only", () => {
    const colorCodes = ["pass", "fail", "runtime"] as const;
    const seen = colorCodes.map((k) => sgr(on, k, "x").match(/\x1b\[([\d;]+)m/)![1]);
    expect(seen).toEqual(["1;30;42", "1;97;41", "1;30;43"]);
    for (const k of ["bold", "dim", "inverse", "underline"] as const) expect(sgr(on, k, "x")).not.toMatch(/\x1b\[[\d;]*(3[0-79]|9\d|4[0-79]|10\d)/);
  });
});

describe("link", () => {
  const url = "https://testnet.nearblocks.io/txns/abc";

  it("is OSC 8 plus underline when caps.color, and the bare text otherwise", () => {
    expect(link({ ...plain100, color: true }, url, "label")).toBe(`${ESC}]8;;${url}${ESC}\\${ESC}[4mlabel${ESC}[24m${ESC}]8;;${ESC}\\`);
    expect(link(plain100, url, "label")).toBe("label");
    expect(link(plain100, url, url)).toBe(url);
  });

  it("stripAnsi removes the whole OSC 8 wrapper, ST or BEL terminated", () => {
    expect(stripAnsi(link(color100, url, "label"))).toBe("label");
    expect(stripAnsi(`${ESC}]8;;${url}\x07label${ESC}]8;;\x07`)).toBe("label");
    expect(stripAnsi(`${ESC}]0;window title\x07rest`)).toBe("rest");
  });

  it("drops control characters from the url, so it cannot end the escape early or inject another", () => {
    const hostile = `https://x.test/${ESC}\\${ESC}[31mred\x07\x9b\ntail`;
    const out = link(color100, hostile, "t");
    expect(out).toBe(`${ESC}]8;;https://x.test/\\[31mredtail${ESC}\\${ESC}[4mt${ESC}[24m${ESC}]8;;${ESC}\\`);
    expect(stripAnsi(out)).toBe("t");
  });

  it("an empty url (or one that is only control characters) gives the bare text, with no empty hyperlink", () => {
    expect(link(color100, "", "label")).toBe("label");
    expect(link(color100, `${ESC}\x07`, "label")).toBe("label");
  });
});

describe("stripAnsi", () => {
  it("removes CSI sequences with any parameters and final byte", () => {
    expect(stripAnsi(`${ESC}[0m${ESC}[1;30;42mPASS${ESC}[22;39;49m ${ESC}[2K${ESC}[10;20H${ESC}[?25lend`)).toBe("PASS end");
  });

  it("leaves plain text, multi-byte text and a lone ESC alone", () => {
    expect(stripAnsi("plain · text — … │ 漢")).toBe("plain · text — … │ 漢");
    expect(stripAnsi(`${ESC}x`)).toBe(`${ESC}x`);
    expect(stripAnsi("")).toBe("");
  });

  it("is linear on unterminated OSC and CSI sequences (no catastrophic backtracking)", () => {
    // Absolute bound of 2 s, not a ratio: a linear scan of these ~400k characters takes a few ms even on a
    // loaded machine, while a quadratic one (every start rescanning to the end) needs ~10^10 steps.
    const inputs = [
      `${ESC}]8;;${"a".repeat(200_000)}`, // one unterminated OSC, a long body
      `${ESC}]8;;${"a".repeat(100)}`.repeat(2_000), // many unterminated OSC starts
      `${ESC}[${"1;".repeat(100_000)}`, // one unterminated CSI, a long parameter run
    ];
    for (const input of inputs) {
      const t = Date.now();
      stripAnsi(input);
      expect(Date.now() - t).toBeLessThan(2000);
    }
  });
});

describe("displayWidth", () => {
  it("counts ASCII, the Keyhole glyphs and the punctuation in strings.ts as one cell each", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("abc 123")).toBe(7);
    for (const ch of "┌┐└┘─│├┤┬┴┼█·…→—+-|#.") expect(displayWidth(ch)).toBe(1);
  });

  it("counts East-Asian wide and fullwidth characters as two", () => {
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("ひらがな")).toBe(8);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("ＡＢ")).toBe(4); // fullwidth Latin
    expect(displayWidth("a漢b")).toBe(4);
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("𠀀")).toBe(2); // CJK Extension B, outside the BMP
  });

  it("counts the Unicode 15 W blocks the first table missed as two: Tangut, Kana, Small Kana, Nushu, U+1F7F0", () => {
    const sample: Array<[string, number[]]> = [
      ["Tangut Components / Tangut / Supplement / Ideographic Supplement", [0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800, 0x18cd5, 0x18d00, 0x18d08]],
      ["Kana Extended-B", [0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd, 0x1affe]],
      ["Kana Supplement and Extended-A", [0x1b000, 0x1b0ff, 0x1b122]],
      ["Small Kana Extension", [0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b164, 0x1b167]],
      ["Nushu", [0x1b170, 0x1b2fb]],
      ["Geometric Shapes Extended", [0x1f7f0]],
    ];
    for (const [block, cps] of sample) for (const cp of cps) expect(displayWidth(String.fromCodePoint(cp)), `${block} U+${cp.toString(16)}`).toBe(2);
    expect(displayWidth("\u{1b000}\u{17000}\u{1b170}")).toBe(6);
  });

  it("keeps the East Asian Width N gaps inside Kana Extended-B at one cell", () => {
    expect(displayWidth(String.fromCodePoint(0x1aff4))).toBe(1);
    expect(displayWidth(String.fromCodePoint(0x1affc))).toBe(1);
  });

  it("counts combining marks, joiners and control characters as zero", () => {
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("a‍b")).toBe(2);
    expect(displayWidth("a​b")).toBe(2);
    expect(displayWidth("a\u0000b\nc\td")).toBe(4);
  });

  it("ignores ANSI and OSC 8 escapes, so styled text measures like plain text", () => {
    const styled = `${sgr(color100, "pass", "PASS")}: ${link(color100, "https://x.test/", "漢")}`;
    expect(displayWidth(styled)).toBe(displayWidth("PASS: 漢"));
    expect(displayWidth("PASS: 漢")).toBe(8);
  });
});

describe("glyphs", () => {
  it("unicode caps get the box, bar, ellipsis and arrow characters", () => {
    expect(glyphs(color100)).toMatchObject({ h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", fill: "█", empty: "─", ellipsis: "…", arrow: "→", leader: "·" });
  });

  it("ASCII caps fall back to + - |, # and ., ..., and ->", () => {
    expect(glyphs(plain100)).toMatchObject({ h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", fill: "#", empty: ".", ellipsis: "...", arrow: "->", leader: "." });
  });

  it("every ASCII glyph is pure ASCII, and every glyph is one cell wide except the ellipsis and arrow fallbacks", () => {
    for (const [name, value] of Object.entries(glyphs(plain100))) {
      expect(value, name).toMatch(/^[\x20-\x7e]+$/);
      if (name !== "ellipsis" && name !== "arrow") expect(displayWidth(value), name).toBe(1);
    }
    for (const [name, value] of Object.entries(glyphs(color100))) expect(displayWidth(value), name).toBe(1);
  });

  it("depends on caps.unicode only, never on caps.color", () => {
    expect(glyphs({ ...color100, color: false })).toEqual(glyphs(color100));
    expect(glyphs({ ...plain100, color: true })).toEqual(glyphs(plain100));
  });

  it("the plain arrow is the one later tasks build their expected rows from", () => {
    expect(glyphs(plain100).arrow).toBe("->");
  });
});

// C-T18c: moved here from cli/wrap.ts, where only the wrap command's own tests reached it.
describe("wrapWords", () => {
  it("breaks at a single space, which the break replaces; the first line takes `lead`, the rest `hang`", () => {
    expect(wrapWords("one two three four", 9, "", "")).toEqual(["one two", "three", "four"]);
    expect(wrapWords("one two three four", 11, "> ", "  ")).toEqual(["> one two", "  three", "  four"]);
    expect(wrapWords("one two three four", 100, "", "")).toEqual(["one two three four"]);
  });

  it("joining the lines (without lead and hang) with a space gives the text back", () => {
    const text = "The agent acts as seat.testnet for increment, reset on counter.testnet only, with any arguments, until burn.";
    for (const width of [20, 33, 80]) expect(wrapWords(text, width, "", "").join(" ")).toBe(text);
  });

  it("never cuts a word: one wider than the line stands alone on a long line", () => {
    expect(wrapWords("a https://testnet.nearblocks.io/txns/7Gm4Qt7hoJ4tDaWXMpvSrnwrjcU9uVchxE2m3guAeHgA b", 20, "", "")).toEqual(["a", "https://testnet.nearblocks.io/txns/7Gm4Qt7hoJ4tDaWXMpvSrnwrjcU9uVchxE2m3guAeHgA", "b"]);
  });

  it("measures display width, not length: a wide character counts for two cells", () => {
    expect(wrapWords("日本日本 cd", 8, "", "")).toEqual(["日本日本", "cd"]); // 8 cells in 4 characters: " cd" does not fit
  });

  it("a text with no space is one line; an empty text is one empty line", () => {
    expect(wrapWords("word", 2, "", "")).toEqual(["word"]);
    expect(wrapWords("", 10, "", "")).toEqual([""]);
  });
});

describe("wrapVerbatim", () => {
  it("cuts at the width and the rows join back to the text", () => {
    expect(wrapVerbatim("abcdefghijklmnopqrstuvwxyz", 10)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(wrapVerbatim("abcde", 5)).toEqual(["abcde"]);
    expect(wrapVerbatim("abcde", 100)).toEqual(["abcde"]);
    expect(wrapVerbatim("abcdef", 1)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps spaces: it is a hard wrap, not a word wrap", () => {
    expect(wrapVerbatim("ab cd  ef", 4)).toEqual(["ab c", "d  e", "f"]);
    expect(wrapVerbatim("   ", 2)).toEqual(["  ", " "]);
  });

  it("empty text is one empty row, so callers always have a first row", () => {
    expect(wrapVerbatim("", 10)).toEqual([""]);
  });

  it("clamps a width below 1 or not finite to 1, and floors a fractional one", () => {
    expect(wrapVerbatim("abc", 0)).toEqual(["a", "b", "c"]);
    expect(wrapVerbatim("abc", -4)).toEqual(["a", "b", "c"]);
    expect(wrapVerbatim("abc", Number.NaN)).toEqual(["a", "b", "c"]);
    expect(wrapVerbatim("abcd", 2.9)).toEqual(["ab", "cd"]);
  });

  it("measures display width: a wide character never straddles the edge", () => {
    expect(wrapVerbatim("漢字漢字", 5)).toEqual(["漢字", "漢字"]);
    expect(wrapVerbatim("a漢b", 2)).toEqual(["a", "漢", "b"]);
    expect(wrapVerbatim("漢", 1)).toEqual(["漢"]); // cannot fit, cannot split: a row of its own
  });

  it("keeps a combining mark with its base character, and an emoji (a surrogate pair) whole", () => {
    expect(wrapVerbatim("aébc", 2)).toEqual(["aé", "bc"]);
    expect(wrapVerbatim("a😀b", 3)).toEqual(["a😀", "b"]);
  });

  it("zero-width material stays with the character before it, even when that one is overlong", () => {
    expect(wrapVerbatim("漢\u0301字", 1)).toEqual(["漢\u0301", "字"]);
    expect(wrapVerbatim(`漢${ESC}[0mx`, 1)).toEqual([`漢${ESC}[0m`, "x"]);
    expect(wrapVerbatim("MethodNameMismatch\u200dx", 5, ["MethodNameMismatch"])).toEqual(["MethodNameMismatch\u200d", "x"]);
    expect(wrapVerbatim("\u0301ab", 1)).toEqual(["\u0301a", "b"]); // a leading mark has nothing before it: it opens the first row
  });

  it("never splits an ANSI or OSC 8 escape", () => {
    const text = `ab${ESC}[1;30;42mcd${ESC}[22;39;49mef`;
    const rows = wrapVerbatim(text, 2);
    expect(rows.join("")).toBe(text);
    expect(rows.map(stripAnsi)).toEqual(["ab", "cd", "ef"]);
    for (const row of rows) expect(row).not.toMatch(/\x1b(?!\[[\d;]*m)/); // every ESC starts a complete sequence
  });

  it("moves a keepWhole span to the next row rather than cut it", () => {
    const rows = wrapVerbatim("0123456789MethodNameMismatch", 15, ["MethodNameMismatch"]);
    expect(rows).toEqual(["0123456789", "MethodNameMismatch"]); // the span is wider than the width: its own row, unsplit
    expect(wrapVerbatim("0123456789ABCDEFGHIJ", 15, ["ABCDEFGHIJ"])).toEqual(["0123456789", "ABCDEFGHIJ"]);
    expect(wrapVerbatim("01234ABCDEFGHIJ", 15, ["ABCDEFGHIJ"])).toEqual(["01234ABCDEFGHIJ"]);
  });

  it("protects every occurrence, with several spans and with overlapping ones", () => {
    const text = "xxMethodNameMismatchyyMethodNameMismatchzz";
    const rows = wrapVerbatim(text, 20, ["MethodNameMismatch"]);
    expect(rows.join("")).toBe(text);
    expect(rows.filter((r) => r.includes("MethodNameMismatch"))).toHaveLength(2);
    // overlapping needles: the union is one unsplittable span, even when it is wider than the width
    expect(wrapVerbatim("xabcabcx", 3, ["abcab", "cabc"])).toEqual(["x", "abcabc", "x"]);
    expect(wrapVerbatim("..abcabc..", 3, ["abc", "cab"])).toEqual(["..", "abcabc", ".."]);
    // adjacent (not overlapping) occurrences are two spans and may part
    expect(wrapVerbatim("abcabc", 3, ["abc"])).toEqual(["abc", "abc"]);
  });

  it("ignores an empty needle and a needle that is not in the text", () => {
    expect(wrapVerbatim("abcdef", 3, ["", "zzz"])).toEqual(["abc", "def"]);
  });

  it("is deterministic and does not mutate its arguments", () => {
    const keep = ["bc"];
    const a = wrapVerbatim("abcdef", 3, keep);
    expect(wrapVerbatim("abcdef", 3, keep)).toEqual(a);
    expect(keep).toEqual(["bc"]);
  });

  describe("property: random texts, widths and keepWhole lists", () => {
    // mulberry32: a seeded PRNG, so a failure reproduces
    const prng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ALPHABET = ["a", "b", "c", "x", "1", "9", " ", " ", '"', ":", "{", "}", ",", "漢", "字", "한", "Ａ", "😀", "é", "‍", "│", "─", `${ESC}[7m`, `${ESC}[27m`, "MethodNameMismatch", "abab", "bab", "Mismatch"];
    const NEEDLES = ["MethodNameMismatch", "Mismatch", "abab", "bab", "漢字", "😀", "{}", '":"', "a"];

    function occurrences(text: string, needle: string): Array<[number, number]> {
      const out: Array<[number, number]> = [];
      for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push([i, i + needle.length]);
      return out;
    }

    /** Overlapping intervals merge into their union; touching ones stay apart. */
    function mergeOverlaps(iv: Array<[number, number]>): Array<[number, number]> {
      const out: Array<[number, number]> = [];
      for (const [s, e] of [...iv].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        const last = out.at(-1);
        if (last && s < last[1]) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
      }
      return out;
    }
    const invisible = (str: string) => [...stripAnsi(str)].every((c) => displayWidth(c) === 0);

    it("holds the invariants over 600 random cases", () => {
      const rnd = prng(0x4b657968);
      for (let n = 0; n < 600; n++) {
        const len = Math.floor(rnd() * 80);
        let text = "";
        for (let i = 0; i < len; i++) text += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
        const keep = NEEDLES.filter(() => rnd() < 0.35);
        const width = [1, 2, 3, 5, 8, 13, 40, 90][Math.floor(rnd() * 8)];
        const label = JSON.stringify({ text, keep, width });
        const rows = wrapVerbatim(text, width, keep);

        // 1. rows.join("") === text
        expect(rows.join(""), label).toBe(text);
        // 2. no empty row, except the one row of an empty text
        if (text !== "") for (const r of rows) expect(r, label).not.toBe("");
        // 2b. no row after the first opens with zero-width material: marks and escapes stay with what precedes them
        for (const r of rows.slice(1)) expect(r.startsWith(ESC) || displayWidth([...r][0]) === 0, `${label} row ${JSON.stringify(r)} opens with a zero-width piece`).toBe(false);
        // 3. no row boundary falls strictly inside an occurrence of any keepWhole span
        const bounds: number[] = [];
        let at = 0;
        for (const r of rows.slice(0, -1)) bounds.push((at += r.length));
        for (const needle of keep) for (const [s, e] of occurrences(text, needle)) for (const b of bounds) expect(b <= s || b >= e, `${label} splits ${needle} at ${b}`).toBe(true);
        // 4. a row is at most `width` cells, unless it is one protected span (or one wide character) that cannot be cut
        const spans = mergeOverlaps(keep.flatMap((k) => occurrences(text, k)));
        at = 0;
        for (const r of rows) {
          const [rs, re] = [at, (at += r.length)];
          const oneSpan = spans.some(([s, e]) => rs <= s && e <= re && invisible(text.slice(rs, s)) && invisible(text.slice(e, re)));
          const oneChar = [...stripAnsi(r)].filter((c) => displayWidth(c) > 0).length === 1;
          expect(displayWidth(r) <= width || oneSpan || oneChar, `${label} row ${JSON.stringify(r)}`).toBe(true);
        }
      }
    });

    it("packs plain ASCII tight: every row but the last is exactly `width` long", () => {
      const rnd = prng(7);
      for (let n = 0; n < 100; n++) {
        const text = Array.from({ length: Math.floor(rnd() * 200) + 1 }, () => "abcdefg{}\":, "[Math.floor(rnd() * 13)]).join("");
        const width = Math.floor(rnd() * 30) + 1;
        const rows = wrapVerbatim(text, width);
        for (const r of rows.slice(0, -1)) expect(r.length).toBe(width);
        expect(rows.at(-1)!.length).toBeLessThanOrEqual(width);
        expect(rows.join("")).toBe(text);
      }
    });
  });
});

describe("renderTxLine", () => {
  const url = `https://testnet.nearblocks.io/txns/${H}`;

  it("testnet: a shortened hash, final, and the explorer URL carrying the full hash", () => {
    expect(renderTxLine(H, "testnet", plain100)).toBe(`tx ${H.slice(0, 4)}...${H.slice(-4)} · final · ${url}`);
    expect(renderTxLine(H, "testnet", plain100)).toBe(`tx 4fTq...9Ka2 · final · ${url}`);
  });

  it("testnet with unicode caps uses the one-cell ellipsis; stripping the escapes gives that line", () => {
    expect(stripAnsi(renderTxLine(H, "testnet", color100))).toBe(`tx ${H.slice(0, 4)}…${H.slice(-4)} · final · ${url}`);
  });

  it("sandbox: the full hash, and the line says there is no explorer", () => {
    expect(renderTxLine(H, "sandbox", plain100)).toBe(`tx ${H} · final · sandbox (no explorer)`);
    expect(stripAnsi(renderTxLine(H, "sandbox", color100))).toBe(`tx ${H} · final · sandbox (no explorer)`);
  });

  it("the full hash appears exactly once per line, on both networks", () => {
    for (const net of ["testnet", "sandbox"] as const) {
      const line = renderTxLine(H, net, color100);
      expect(stripAnsi(line).split(H)).toHaveLength(2);
    }
  });

  // C-T18d: wrap and burn print the line flush left, where a testnet line (105 cells) is over the 100-column rule.
  describe("renderTxLineRows", () => {
    it("a line that fits is the one row renderTxLine gives; a testnet line at 100 columns breaks before its URL", () => {
      expect(renderTxLineRows(H, "sandbox", plain100)).toEqual([renderTxLine(H, "sandbox", plain100)]);
      expect(displayWidth(renderTxLine(H, "testnet", plain100))).toBeGreaterThan(100);
      expect(renderTxLineRows(H, "testnet", plain100)).toEqual(["tx 4fTq...9Ka2 · final", `· ${url}`]);
      expect(renderTxLineRows(H, "testnet", { ...plain100, width: 120 })).toEqual([renderTxLine(H, "testnet", plain100)]);
    });

    it("joined with ` ` after the ` · ` it was cut at, it is renderTxLine's line; the full hash is still there once, in the URL", () => {
      for (const caps of [plain100, color100, plain80]) {
        const rows = renderTxLineRows(H, "testnet", caps);
        expect(rows.map(stripAnsi).join(" ")).toBe(stripAnsi(renderTxLine(H, "testnet", caps)));
        expect(rows.map(stripAnsi).join("\n").split(H)).toHaveLength(2);
        for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(Math.max(caps.width, displayWidth(url) + 2));
      }
    });

    it("color: the same styling as renderTxLine, on whole segments (the hash inverse, the URL an OSC 8 link)", () => {
      const [head, tail] = renderTxLineRows(H, "testnet", color100);
      expect(head).toContain(`${ESC}[7m${H.slice(0, 4)}…${H.slice(-4)}${ESC}[27m`);
      expect(tail).toContain(`${ESC}]8;;${url}${ESC}\\${ESC}[4m${url}${ESC}[24m${ESC}]8;;${ESC}\\`);
    });
  });

  it("color: the hash is inverse (NEAR's voice) and the URL is an OSC 8 underlined link", () => {
    const line = renderTxLine(H, "testnet", color100);
    expect(line).toContain(`${ESC}[7m${H.slice(0, 4)}…${H.slice(-4)}${ESC}[27m`);
    expect(line).toContain(`${ESC}]8;;${url}${ESC}\\${ESC}[4m${url}${ESC}[24m${ESC}]8;;${ESC}\\`);
    expect(renderTxLine(H, "sandbox", color100)).toContain(`${ESC}[7m${H}${ESC}[27m`);
  });

  it("plain output has no escape at all", () => {
    for (const net of ["testnet", "sandbox"] as const) expect(renderTxLine(H, net, plain100)).not.toContain(ESC);
  });

  it("styling never changes characters: color and plain differ only by escapes, per unicode setting", () => {
    for (const net of ["testnet", "sandbox"] as const) {
      expect(stripAnsi(renderTxLine(H, net, color100))).toBe(renderTxLine(H, net, { ...color100, color: false }));
      expect(stripAnsi(renderTxLine(H, net, { ...plain100, color: true }))).toBe(renderTxLine(H, net, plain100));
    }
  });

  it("a hash too short to shorten is printed whole", () => {
    expect(renderTxLine("abcd1234", "testnet", plain100)).toBe("tx abcd1234 · final · https://testnet.nearblocks.io/txns/abcd1234");
  });

  it("a hash with control characters prints them as text: no ESC, LF or bidi override reaches the line", () => {
    const hostile = `abc${ESC}[2Jdefghijkl\nmnop\u202eqrst`;
    for (const net of ["testnet", "sandbox"] as const) {
      const plain = renderTxLine(hostile, net, plain100);
      expect(plain).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
      // with color, the only escapes are the ones the renderer adds: inverse, underline and the OSC 8 link
      const own = new RegExp(`${ESC}\\[(?:7|27|4|24)m|${ESC}\\]8;;[^${ESC}]*${ESC}\\\\`, "g");
      expect(renderTxLine(hostile, net, color100).replace(own, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
    }
    expect(renderTxLine(hostile, "sandbox", plain100)).toBe("tx abc\\u001b[2Jdefghijkl\\u000amnop\\u202eqrst · final · sandbox (no explorer)");
    expect(renderTxLine(hostile, "testnet", plain100)).toBe(`tx abc\\u001b...qrst · final · https://testnet.nearblocks.io/txns/${encodeURIComponent(hostile)}`);
  });
});

describe("renderRuleStrip", () => {
  it("brackets and upper-cases the broken slot, in 12-cell slots at 100 columns", () => {
    expect(renderRuleStrip("method", plain100)).toBe("[METHOD]     action      receiver    deposit     allowance");
    expect(renderRuleStrip("action", plain100)).toBe(" method     [ACTION]     receiver    deposit     allowance");
    expect(renderRuleStrip("receiver", plain100)).toBe(" method      action     [RECEIVER]   deposit     allowance");
    expect(renderRuleStrip("deposit", plain100)).toBe(" method      action      receiver   [DEPOSIT]    allowance");
    expect(renderRuleStrip("allowance", plain100)).toBe(" method      action      receiver    deposit    [ALLOWANCE]");
  });

  it("uses 11-cell slots below 100 columns (80-99, and the key: value range too)", () => {
    expect(renderRuleStrip("method", plain80)).toBe("[METHOD]    action     receiver   deposit    allowance");
    expect(renderRuleStrip("allowance", plain80)).toBe(" method     action     receiver   deposit   [ALLOWANCE]");
    expect(renderRuleStrip("action", { ...plain80, width: 99 })).toBe(" method    [ACTION]    receiver   deposit    allowance");
    expect(renderRuleStrip("action", { ...plain80, width: 60 })).toBe(" method    [ACTION]    receiver   deposit    allowance");
    expect(renderRuleStrip("action", { ...plain80, width: 100 })).toBe(renderRuleStrip("action", plain100));
  });

  it("the five slots are in the fixed order, and the bracket moves one slot right per rule (the staircase)", () => {
    expect(RULE_SLOTS).toEqual(["method", "action", "receiver", "deposit", "allowance"]);
    const at = RULE_SLOTS.map((slot) => renderRuleStrip(slot, plain100).indexOf("["));
    expect(at).toEqual([0, 12, 24, 36, 48]);
    for (const slot of RULE_SLOTS) {
      const s = renderRuleStrip(slot, plain100);
      expect(s.match(/\[/g)).toHaveLength(1);
      expect(s.replace(/[[\]]/g, "").toLowerCase().split(/\s+/).filter(Boolean)).toEqual([...RULE_SLOTS]);
    }
  });

  it("never ends in a space, and fits 80 columns even after a 6-cell step prefix", () => {
    for (const caps of [plain100, plain80]) for (const slot of RULE_SLOTS) {
      const s = renderRuleStrip(slot, caps);
      expect(s).toBe(s.trimEnd());
      expect(displayWidth(s)).toBeLessThanOrEqual(caps.width - 6);
    }
  });

  it("'none' brackets nothing: all five rules, lower case", () => {
    expect(renderRuleStrip("none", plain100)).toBe(" method      action      receiver    deposit     allowance");
    expect(renderRuleStrip("none", plain100)).not.toMatch(/[[\]]/);
  });

  it("color: the bracketed slot is bold, nothing else is styled, and the padding stays outside the escape", () => {
    expect(renderRuleStrip("action", color100)).toBe(` method     ${ESC}[1m[ACTION]${ESC}[22m     receiver    deposit     allowance`);
    expect(renderRuleStrip("allowance", color100)).toBe(` method      action      receiver    deposit    ${ESC}[1m[ALLOWANCE]${ESC}[22m`);
    expect(renderRuleStrip("none", color100)).toBe(renderRuleStrip("none", plain100));
  });

  it("styling never changes characters", () => {
    for (const slot of [...RULE_SLOTS, "none"] as const) {
      expect(stripAnsi(renderRuleStrip(slot, color100))).toBe(renderRuleStrip(slot, { ...color100, color: false }));
      expect(stripAnsi(renderRuleStrip(slot, plain80))).toBe(renderRuleStrip(slot, plain80));
    }
  });
});

describe("renderRawJsonBlock", () => {
  const raw = readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json");

  it("full style: 8-space indent, ASCII gutter on plain caps, chunk = width - 10, bytes verbatim", () => {
    const rows = renderRawJsonBlock(raw, plain100, { highlight: "MethodNameMismatch" });
    expect(rows.every((r) => r.startsWith("        | ") && displayWidth(r) <= 100)).toBe(true); // color100 gutter: "        │ "
    expect(rows.map((r) => r.slice(10)).join("")).toBe(raw);
    expect(rows.some((r) => r.includes("MethodNameMismatch"))).toBe(true); // never split
  });

  it("the body is 289 bytes, so at 100 columns it takes ceil(289 / 90) = 4 rows of 90, 90, 90 and 19 (barring a kept span)", () => {
    const rows = renderRawJsonBlock(raw, plain100);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.length - 10)).toEqual([90, 90, 90, 19]);
  });

  it("with unicode caps the gutter is a box-drawing bar", () => {
    const rows = renderRawJsonBlock(raw, color100);
    expect(rows.every((r) => r.startsWith("        │ "))).toBe(true);
    expect(rows.map((r) => stripAnsi(r).slice(10)).join("")).toBe(raw);
  });

  it("the highlight is inverse, in place, on every occurrence; stripping the escapes gives the uncolored block", () => {
    const rows = renderRawJsonBlock(raw, color100, { highlight: "MethodNameMismatch" });
    expect(rows.join("\n")).toContain(`${ESC}[7mMethodNameMismatch${ESC}[27m`);
    expect(rows.join("\n").split(`${ESC}[7m`)).toHaveLength(2);
    expect(stripAnsi(rows.join("\n"))).toBe(renderRawJsonBlock(raw, { ...color100, color: false }, { highlight: "MethodNameMismatch" }).join("\n"));
  });

  it("highlights every occurrence of the name, not only the first", () => {
    const body = '{"a":"MethodNameMismatch","b":{"MethodNameMismatch":1},"c":"MethodNameMismatch"}';
    const rows = renderRawJsonBlock(body, color100, { highlight: "MethodNameMismatch", indent: 0, gutter: false, chunk: 30 });
    expect(rows.join("").split(`${ESC}[7m`)).toHaveLength(4);
    expect(rows.map(stripAnsi).join("")).toBe(body);
    for (const r of rows) expect(stripAnsi(r).replace(/MethodNameMismatch/g, "").includes("Method")).toBe(false); // never split
  });

  it("plain caps never emit an escape, with or without a highlight", () => {
    expect(renderRawJsonBlock(raw, plain100, { highlight: "MethodNameMismatch" }).join("")).not.toContain(ESC);
    expect(renderRawJsonBlock(raw, plain100).join("")).not.toContain(ESC);
  });

  it("an absent, empty or unmatched highlight changes nothing", () => {
    const base = renderRawJsonBlock(raw, color100);
    expect(renderRawJsonBlock(raw, color100, { highlight: "" })).toEqual(base);
    expect(renderRawJsonBlock(raw, color100, { highlight: "NoSuchName" })).toEqual(base);
    expect(base.join("")).not.toContain(`${ESC}[7m`);
  });

  it("beat style: indent 4, no gutter, chunk 96 - the bytes still join back, and no row passes 100 cells", () => {
    const rows = renderRawJsonBlock(raw, plain100, { indent: 4, gutter: false, chunk: 96, highlight: "MethodNameMismatch" });
    expect(rows.every((r) => r.startsWith("    ") && !r.startsWith("     ") && !r.includes("|") && displayWidth(r) <= 100)).toBe(true);
    expect(rows.map((r) => r.slice(4)).join("")).toBe(raw);
    expect(rows).toHaveLength(Math.ceil(raw.length / 96));
  });

  it("a smaller width gives a smaller chunk: at 80 columns every row is at most 80 cells", () => {
    const rows = renderRawJsonBlock(raw, plain80);
    expect(rows.every((r) => displayWidth(r) <= 80)).toBe(true);
    expect(rows.map((r) => r.slice(10)).join("")).toBe(raw);
    expect(rows.slice(0, -1).every((r) => r.length === 80)).toBe(true);
  });

  it("an explicit chunk wins over the width", () => {
    const rows = renderRawJsonBlock(raw, plain100, { chunk: 40 });
    expect(rows.slice(0, -1).every((r) => r.length === 50)).toBe(true);
    expect(rows.map((r) => r.slice(10)).join("")).toBe(raw);
  });

  it("an empty body is one empty gutter row, so the block never vanishes", () => {
    expect(renderRawJsonBlock("", plain100)).toEqual(["        | "]);
  });

  it("a width under 11 still yields a chunk of at least one cell", () => {
    const rows = renderRawJsonBlock("abc", { ...plain100, width: 5 });
    expect(rows.map((r) => r.slice(10)).join("")).toBe("abc");
  });

  /**
   * Every committed RPC response body under demo/fixtures: a .json file whose bytes start `{"jsonrpc"`.
   * The capture index (sandbox/index.json) and the analysis notes are JSON too, pretty-printed with LF,
   * but they are not bodies the block ever prints, so they are not selected.
   */
  function rpcBodies(): Array<{ file: string; body: string }> {
    const root = join(REPO, "demo", "fixtures");
    const out: Array<{ file: string; body: string }> = [];
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!rel.endsWith(".json") || !statSync(join(root, rel)).isFile()) continue;
      const body = readFileSync(join(root, rel), "utf8");
      if (body.startsWith('{"jsonrpc"')) out.push({ file: rel, body });
    }
    return out;
  }

  it("the fixture selection takes RPC bodies only: the capture index and the analysis notes are left out", () => {
    const files = rpcBodies().map((b) => b.file);
    expect(files.length).toBeGreaterThan(90);
    expect(files).toContain("sandbox/052-g1-method-add_proposal.send_tx.json");
    expect(files.filter((f) => /(^|\/)(index|analysis)\.json$/.test(f))).toEqual([]);
  });

  it("R7: every recorded RPC body joins back to its file at 80 and 100 columns, styled or not, and has no control to neutralize", () => {
    for (const { file, body } of rpcBodies()) {
      expect(neutralizeControls(body), `${file} has a raw control character`).toBe(body);
      expect(controlEscapes(body), file).toEqual([]);
      for (const caps of [plain100, plain80, color100, { ...color100, width: 80 }] as TermCaps[]) {
        const rows = renderRawJsonBlock(body, caps, { highlight: "MethodNameMismatch" });
        const lead = 8 + 2;
        expect(rows.map((r) => stripAnsi(r).slice(lead)).join(""), `${file} @${caps.width}`).toBe(body);
        for (const r of rows) expect(displayWidth(r), `${file} @${caps.width}`).toBeLessThanOrEqual(caps.width);
      }
    }
  });

  describe("hostile bodies: a node must not drive the user's terminal (controller ruling on T6)", () => {
    // ESC [ 3 1 m, an OSC 8 link (ST terminated), a lone CR that would overwrite the line, a BEL, and a
    // real error name right behind an escape.
    const hostile = `{"a":"${ESC}[31mred","b":"${ESC}]8;;https://evil.test${ESC}\\link${ESC}]8;;${ESC}\\","c":"x\ry","d":"ding\x07","e":"${ESC}[31mMethodNameMismatch"}`;
    // written out by hand: each control character becomes the text \uXXXX, lower-case hex
    const escaped = '{"a":"\\u001b[31mred","b":"\\u001b]8;;https://evil.test\\u001b\\link\\u001b]8;;\\u001b\\","c":"x\\u000dy","d":"ding\\u0007","e":"\\u001b[31mMethodNameMismatch"}';
    // everything neutralizeControls maps except LF, which the tests below use to join rows (and check separately)
    const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

    it("(b) plain style: none of ESC, CR or BEL reaches the output; \\u001b, \\u000d and \\u0007 show instead", () => {
      for (const [caps, opts, lead] of [
        [plain100, {}, 10],
        [plain80, { highlight: "MethodNameMismatch" }, 10],
        [plain100, { indent: 4, gutter: false, chunk: 96 }, 4],
        [color100, { indent: 4, gutter: false, chunk: 96 }, 4],
      ] as const) {
        const rows = renderRawJsonBlock(hostile, { ...caps, color: false }, opts);
        const out = rows.join("\n");
        expect(out).not.toContain(ESC);
        expect(out).not.toContain("\r");
        expect(out).not.toContain("\x07");
        expect(out).not.toMatch(CONTROL);
        for (const r of rows) expect(r).not.toContain("\n");
        expect(out).toContain("\\u001b");
        expect(out).toContain("\\u000d");
        expect(out).toContain("\\u0007");
        expect(rows.map((r) => r.slice(lead)).join("")).toBe(escaped);
        for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(caps.width);
      }
    });

    it("(c) styled: the only escapes left are the inverse spans the renderer adds itself", () => {
      for (const opts of [{ highlight: "MethodNameMismatch" }, { highlight: "MethodNameMismatch", indent: 4, gutter: false, chunk: 96 }, {}] as const) {
        const out = renderRawJsonBlock(hostile, color100, opts).join("\n");
        expect(out.replace(new RegExp(`${ESC}\\[(?:7|27)m`, "g"), "")).not.toMatch(CONTROL); // nothing but the renderer's own SGR
        expect(stripAnsi(out)).not.toMatch(CONTROL);
        expect(stripAnsi(out)).not.toContain("\r");
        expect(stripAnsi(out)).not.toContain("\x07");
        const lead = "indent" in opts ? 4 : 10;
        expect(renderRawJsonBlock(hostile, color100, opts).map((r) => stripAnsi(r).slice(lead)).join("")).toBe(escaped);
      }
      // the error name behind the escape is still lit in place, and the escape is text beside it
      expect(renderRawJsonBlock(hostile, color100, { highlight: "MethodNameMismatch", chunk: 400 }).join("")).toContain(`\\u001b[31m${ESC}[7mMethodNameMismatch${ESC}[27m`);
    });

    it("an escape the renderer wrote is never split across rows, at any chunk width", () => {
      for (let chunk = 1; chunk <= 60; chunk++) {
        const rows = renderRawJsonBlock(hostile, plain100, { indent: 0, gutter: false, chunk, highlight: "MethodNameMismatch" });
        expect(rows.join(""), `chunk ${chunk}`).toBe(escaped);
        const bounds: number[] = [];
        let at = 0;
        for (const r of rows.slice(0, -1)) bounds.push((at += r.length));
        for (const m of escaped.matchAll(/\\u00[0-9a-f]{2}/g)) {
          const [s0, e0] = [m.index!, m.index! + m[0].length];
          for (const b of bounds) expect(b <= s0 || b >= e0, `chunk ${chunk}: boundary ${b} splits ${m[0]} at ${s0}`).toBe(true);
        }
      }
    });

    it("plain and styled output carry the same characters once the renderer's escapes are stripped", () => {
      expect(stripAnsi(renderRawJsonBlock(hostile, color100, { highlight: "MethodNameMismatch" }).join("\n")))
        .toBe(renderRawJsonBlock(hostile, { ...color100, color: false }, { highlight: "MethodNameMismatch" }).join("\n"));
    });

    it("the chunk width applies to the escaped text, and a row never carries a raw control", () => {
      const rows = renderRawJsonBlock(ESC.repeat(10), plain100, { indent: 0, gutter: false, chunk: 12 });
      expect(rows).toEqual(["\\u001b\\u001b", "\\u001b\\u001b", "\\u001b\\u001b", "\\u001b\\u001b", "\\u001b\\u001b"]);
    });

    it("a highlight is neutralized the same way, so it still matches the escaped body", () => {
      const rows = renderRawJsonBlock("x" + "A\x1bB" + "y", color100, { highlight: "A\x1bB", indent: 0, gutter: false });
      expect(rows).toEqual([`x${ESC}[7mA\\u001bB${ESC}[27my`]);
    });

    it("LF and TAB print as \\u000a and \\u0009, so a row stays one physical line", () => {
      expect(renderRawJsonBlock("a\tb\nc", plain100, { indent: 0, gutter: false })).toEqual(["a\\u0009b\\u000ac"]);
      expect(renderRawJsonBlock("a\tb\nc", plain100)).toEqual(["        | a\\u0009b\\u000ac"]);
    });

    it("a raw LF cannot forge a flush-left Keyhole line: one physical line per row, each behind the gutter", () => {
      const forged = '{"e":"a\nPASS: refused by protocol (Fake)\nreached block: no"}';
      const want = '{"e":"a\\u000aPASS: refused by protocol (Fake)\\u000areached block: no"}';
      for (const [caps, opts, lead] of [
        [plain100, {}, "        | "],
        [color100, {}, "        │ "],
        [plain100, { indent: 4, gutter: false, chunk: 96 }, "    "],
        [plain80, { highlight: "PASS" }, "        | "],
      ] as const) {
        const rows = renderRawJsonBlock(forged, caps, opts);
        const text = rows.map(stripAnsi).join("\n");
        expect(text.split("\n"), "one physical line per row").toHaveLength(rows.length);
        for (const line of text.split("\n")) expect(line.startsWith(lead)).toBe(true);
        for (const r of rows) expect(r).not.toContain("\n");
        expect(text).not.toMatch(/^PASS/m);
        expect(text).not.toMatch(/^reached block/m);
        expect(rows.map((r) => stripAnsi(r).slice(lead.length)).join("")).toBe(want);
      }
    });

    it("U+2028, U+2029 and a lone CR forge no line either", () => {
      for (const sep of ["\u2028", "\u2029", "\r", "\r\n"]) {
        const rows = renderRawJsonBlock(`{"e":"a${sep}PASS: refused by protocol (Fake)${sep}x"}`, plain100);
        for (const r of rows) expect(r).not.toMatch(/[\n\r\u2028\u2029]/);
        expect(rows.join("\n").split("\n")).toHaveLength(rows.length);
        expect(rows.every((r) => r.startsWith("        | "))).toBe(true);
      }
    });

    it("bidi controls print as text, so a U+202E override cannot reorder what the reader sees", () => {
      const rows = renderRawJsonBlock('{"a":"\u202eevil\u2069\u2066x\u061cy"}', plain100);
      expect(rows.map((r) => r.slice(10)).join("")).toBe('{"a":"\\u202eevil\\u2069\\u2066x\\u061cy"}');
      expect(rows.join("")).not.toMatch(/[\u202e\u2069\u2066\u061c]/);
    });

    it("no neutralized row is wider than the width, whatever the controls and wide characters around them", () => {
      const prng = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pieces = ["\t", "\n", "\r", ESC, "\x07", "\x9b", "\x7f", "\u202e", "\u2066", "\u061c", "\u2028", "\u2029", `${ESC}[31m`, "MethodNameMismatch", "漢", "字", "a", "b", ":", "{", " "];
      const rnd = prng(0x7a11);
      for (let n = 0; n < 200; n++) {
        const body = Array.from({ length: Math.floor(rnd() * 120) }, () => pieces[Math.floor(rnd() * pieces.length)]).join("");
        for (const caps of [plain100, plain80, color100, { ...plain100, width: 40 }, { ...color100, width: 30 }] as TermCaps[]) {
          const rows = renderRawJsonBlock(body, caps, { highlight: "MethodNameMismatch" });
          const label = JSON.stringify({ body, width: caps.width });
          for (const r of rows) {
            expect(displayWidth(r), label).toBeLessThanOrEqual(caps.width);
            expect(r, label).not.toMatch(/[\n\r]/);
            expect(stripAnsi(r), label).not.toMatch(CONTROL);
          }
          expect(rows.map((r) => stripAnsi(r).slice(10)).join(""), label).toBe(neutralizeControls(body));
        }
      }
    });
  });
});

describe("neutralizeControls", () => {
  const u = (cp: number) => `\\u${cp.toString(16).padStart(4, "0")}`;

  it("maps every C0 control, TAB and LF included, to a lower-case four-digit \\uXXXX escape", () => {
    for (let cp = 0; cp < 0x20; cp++) expect(neutralizeControls(`a${String.fromCharCode(cp)}b`), `U+${cp.toString(16)}`).toBe(`a${u(cp)}b`);
    expect(neutralizeControls(ESC)).toBe("\\u001b");
    expect(neutralizeControls("\r")).toBe("\\u000d");
    expect(neutralizeControls("\x07")).toBe("\\u0007");
    expect(neutralizeControls("\x00")).toBe("\\u0000");
  });

  it("TAB prints as \\u0009, so it can no longer hide cells from displayWidth", () => {
    expect(neutralizeControls("a\tb")).toBe("a\\u0009b");
    expect(displayWidth("a\tb")).toBe(2); // the raw tab counts zero cells but a terminal advances to a stop
    expect(displayWidth(neutralizeControls("a\tb"))).toBe(8); // the printed text is what the width measures
  });

  it("LF prints as \\u000a", () => {
    expect(neutralizeControls("a\nb")).toBe("a\\u000ab");
  });

  it("U+202E (right-to-left override) prints as \\u202e", () => {
    expect(neutralizeControls("a\u202eb")).toBe("a\\u202eb");
  });

  it("U+2066 (left-to-right isolate) prints as \\u2066", () => {
    expect(neutralizeControls("a\u2066b")).toBe("a\\u2066b");
  });

  it("U+061C (Arabic letter mark) prints as \\u061c", () => {
    expect(neutralizeControls("a\u061cb")).toBe("a\\u061cb");
  });

  it("U+2028 (line separator) prints as \\u2028", () => {
    expect(neutralizeControls("a\u2028b")).toBe("a\\u2028b");
  });

  it("U+2029 (paragraph separator) prints as \\u2029", () => {
    expect(neutralizeControls("a\u2029b")).toBe("a\\u2029b");
  });

  it("covers the whole bidi set: U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069", () => {
    for (const cp of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) expect(neutralizeControls(String.fromCharCode(cp)), `U+${cp.toString(16)}`).toBe(u(cp));
  });

  it("covers DEL and the whole C1 range, including the 8-bit CSI and OSC introducers", () => {
    expect(neutralizeControls("\x7f")).toBe("\\u007f");
    expect(neutralizeControls("\x9b31m\x9d0;t\x9c")).toBe("\\u009b31m\\u009d0;t\\u009c");
    for (let cp = 0x80; cp <= 0x9f; cp++) expect(neutralizeControls(String.fromCharCode(cp))).toBe(u(cp));
  });

  it("leaves printable text, Latin-1 above U+009F, multi-byte text and the other zero-width characters alone", () => {
    const text = ' !"#{}[]:,0189azAZ~ \u00a0é·…│─█漢字😀\u0301';
    expect(neutralizeControls(text)).toBe(text);
    // neighbours of the mapped ranges, and joiners emoji sequences need
    const near = "\u061b\u061d\u200b\u200c\u200d\u2027\u202f\u2065\u206a\ufe0f\ufeff";
    expect(neutralizeControls(near)).toBe(near);
    expect(neutralizeControls("")).toBe("");
  });

  it("is idempotent: its output has no control left to change", () => {
    const once = neutralizeControls(`a${ESC}[0m\r\n\t\x07\x9bz\u202e\u2028`);
    expect(neutralizeControls(once)).toBe(once);
  });

  it("controlEscapes lists the distinct escapes it writes, in first-seen order, and none for clean text", () => {
    expect(controlEscapes(`a${ESC}b\nc${ESC}d\u202e`)).toEqual(["\\u001b", "\\u000a", "\\u202e"]);
    expect(controlEscapes('{"jsonrpc":"2.0"}')).toEqual([]);
    expect(controlEscapes("")).toEqual([]);
  });
});

describe("passRefused", () => {
  it("a normal name gives exactly PASS: refused by protocol (Name)", () => {
    expect(passRefused("MethodNameMismatch")).toBe("PASS: refused by protocol (MethodNameMismatch)");
    expect(passRefused("AccessKeyNotFound")).toBe("PASS: refused by protocol (AccessKeyNotFound)");
  });

  it("a name with an escape decoded from a hostile body prints as text: no ESC byte", () => {
    const line = passRefused("X\u001b[2J");
    expect(line).not.toContain(ESC);
    expect(line).toBe("PASS: refused by protocol (X\\u001b[2J)");
    // the path the name takes: JSON.parse turns the body's \u001b escape into a real ESC
    const parsed = JSON.parse('{"name":"X\\u001b[2J"}').name as string;
    expect(parsed).toContain(ESC);
    expect(passRefused(parsed)).not.toContain(ESC);
  });

  it("a name with LF, CR or a bidi override stays one line and in order", () => {
    for (const name of ["a\nPASS: refused by protocol (Fake)", "a\rb", "a\u202eb", "a\u2028b"]) {
      const line = passRefused(name);
      expect(line).not.toMatch(/[\n\r\u202e\u2028]/);
      expect(line.startsWith("PASS: refused by protocol (")).toBe(true);
      expect(line.endsWith(")")).toBe(true);
    }
  });
});
