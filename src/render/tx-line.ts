/**
 * TxLine: `tx HASH · final · explorer URL`; on sandbox `· sandbox (no explorer)`. The full hash is
 * printed once per output. Explorer URLs are printed, never fetched.
 */
import type { Network } from "../core/types.js";
import { packSegments, paint } from "./refusal-block.js";
import { glyphs, link, neutralizeControls, sgr } from "./style.js";
import type { TermCaps } from "./term.js";

/** Explorer transaction pages by network. A network with no explorer prints the sandbox tail instead. */
const EXPLORER_TX: Record<Network, string | null> = {
  testnet: "https://testnet.nearblocks.io/txns/",
  sandbox: null,
};

const SHORT_HEAD = 4;
const SHORT_TAIL = 4;
/** Below this length `abcd…wxyz` would not be shorter than the hash, so the hash is printed whole. */
const MIN_SHORTENABLE = 12;

/**
 * `tx HASH · final · URL`. On a network with an explorer the URL carries the full hash, so the label is
 * shortened (first 4 and last 4 characters around an ellipsis) and the full hash still appears once. On
 * sandbox there is no URL, so the label is the full hash. Control characters in the label print as `\uXXXX`. The hash is inverse (NEAR's voice, DESIGN §4)
 * and the URL an underlined OSC 8 link, both only when caps.color; the characters never change.
 */
export function renderTxLine(txHash: string, network: Network, caps: TermCaps): string {
  const base = EXPLORER_TX[network];
  const shown = base !== null && txHash.length >= MIN_SHORTENABLE ? `${txHash.slice(0, SHORT_HEAD)}${glyphs(caps).ellipsis}${txHash.slice(-SHORT_TAIL)}` : txHash;
  const label = neutralizeControls(shown); // a no-op for a base58 hash; a hostile string cannot drive the terminal
  const head = `tx ${sgr(caps, "inverse", label)} · final`;
  if (base === null) return `${head} · sandbox (no explorer)`;
  const url = `${base}${encodeURIComponent(txHash)}`;
  return `${head} · ${link(caps, url, url)}`;
}

/**
 * renderTxLine as rows of at most `width` cells (default caps.width), for a command that prints it flush left (wrap,
 * burn; C-T18d) or after a label (inspect's `DeleteKey `, `lead`; a continuation row starts with `hang`, then `· `).
 * Where the line fits it is the same one row; a testnet line is about 104 cells, so the URL, which holds the full hash,
 * takes the next row after `· ` (the way demo-log breaks it under its indent).
 */
export function renderTxLineRows(txHash: string, network: Network, caps: TermCaps, width: number = caps.width, lead = "", hang = ""): string[] {
  const segments = renderTxLine(txHash, network, caps)
    .split(" · ")
    .map((part): Array<readonly [string]> => [[part]]);
  return packSegments(segments, width, lead, hang).map((row) => paint(caps, row));
}
