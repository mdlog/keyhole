/**
 * RawJsonBlock: the RPC body byte for byte behind an 8-space indent and a `│ ` gutter, hard-wrapped at
 * width − 10, never pretty-printed or reordered. Invariant (R7): strip indent and gutter, join the
 * lines, and the result equals the fixture file exactly.
 *
 * Why control characters print as `\uXXXX`: the body comes from an RPC node Keyhole does not control, and a
 * hostile node must not be able to drive the user's terminal (escape sequences, a CR that overwrites the
 * line), forge flush-left Keyhole lines with a raw LF, or reorder the text with bidi controls. Conformant
 * NEAR RPC JSON has none of these raw characters, so a real body still prints byte-identical.
 */
import { controlEscapes, glyphs, neutralizeControls, sgr, wrapVerbatim } from "./style.js";
import type { TermCaps } from "./term.js";

/**
 * Defaults are the full style: indent 8, the gutter, and chunk = caps.width − 10. The beat style passes
 * `{ indent: 4, gutter: false, chunk: 96 }`. `highlight` is styled inverse in place and never split.
 *
 * The body is cut only where the width runs out (wrapVerbatim); the gutter is `│ ` with unicode caps and
 * `| ` otherwise. An empty body gives one empty gutter row, so the block never vanishes. Control
 * characters are neutralized first (neutralizeControls in style.ts, which lists the set), in every style
 * and with or without color, so every row is one physical line and the only escapes in the output are the
 * inverse spans this function adds itself. The wrap and the chunk width apply to the neutralized text, and
 * an escape this function wrote (`\u001b`) is never split across rows. The `highlight` is neutralized the
 * same way, so it still matches.
 */
export function renderRawJsonBlock(rawRpcJson: string, caps: TermCaps, opts: { highlight?: string; indent?: number; gutter?: boolean; chunk?: number } = {}): string[] {
  const indent = Math.max(0, Math.floor(opts.indent ?? 8));
  const chunk = Math.max(1, Math.floor(opts.chunk ?? caps.width - 10));
  const lead = " ".repeat(indent) + (opts.gutter === false ? "" : `${glyphs(caps).v} `);
  const name = opts.highlight ? neutralizeControls(opts.highlight) : undefined;
  const lit = name === undefined ? undefined : sgr(caps, "inverse", name);
  const written = controlEscapes(rawRpcJson); // none for a conformant body
  const keepWhole = name === undefined ? written : [name, ...written];
  return wrapVerbatim(neutralizeControls(rawRpcJson), chunk, keepWhole).map((row) => lead + (name === undefined ? row : row.split(name).join(lit)));
}
