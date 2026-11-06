/**
 * RuleStrip: the five key rules in fixed slot order, the broken one bracketed and uppercase.
 * Order of presentation only; the verifier's check order is PRD §7.
 */
import type { Violation } from "../core/types.js";
import { sgr } from "./style.js";
import type { TermCaps } from "./term.js";

export const RULE_SLOTS = ["method", "action", "receiver", "deposit", "allowance"] as const;

/** Slot width in cells: 12 from 100 columns, 11 below (80–99 narrow, and the key: value range). */
const wide = (caps: TermCaps): number => (caps.width >= 100 ? 12 : 11);

/**
 * `[METHOD]     action      receiver    deposit     allowance` for "method". Every slot is one cell wide:
 * the broken one is `[NAME]` in bold (Keyhole's statement, so not inverse), flush left; the others are
 * ` name` with one leading space, so the bracket moves one slot right per rule and the four refusals form
 * the staircase. The last slot has no padding, so the strip never ends in a space. "none" (no rule broken)
 * brackets nothing.
 */
export function renderRuleStrip(broken: Violation, caps: TermCaps): string {
  const cell = wide(caps);
  const last = RULE_SLOTS.length - 1;
  return RULE_SLOTS.map((slot, i) => {
    const hit = slot === broken;
    const text = hit ? `[${slot.toUpperCase()}]` : ` ${slot}`;
    const pad = i === last ? "" : " ".repeat(Math.max(0, cell - text.length));
    return (hit ? sgr(caps, "bold", text) : text) + pad;
  }).join("");
}
