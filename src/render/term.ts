/**
 * Terminal capabilities (LAYOUT "Responsive strategy"; DESIGN_BRIEF §4 "Rendering switches").
 */

export interface TermCaps {
  /** SGR codes: stdout is a TTY, NO_COLOR unset, TERM not dumb; FORCE_COLOR=1 forces them (recording). */
  color: boolean;
  /** Box drawing: UTF-8 locale, NO_COLOR unset, a TTY, and KEYHOLE_ASCII not 1. Otherwise + - | # . ... -> */
  unicode: boolean;
  /** TTY columns; non-TTY: COLUMNS, else 100. Layouts: ≥100 full · 80–99 narrow · <80 key: value lines. */
  width: number;
  /** Progress lines (`waiting for RPC…`) only on a TTY. */
  tty: boolean;
}

const DEFAULT_WIDTH = 100;

/** A positive whole number, or undefined. */
function positiveInt(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The locale's character set, by POSIX precedence: LC_ALL beats LC_CTYPE beats LANG, and an empty
 * variable counts as unset. LC_ALL=C therefore means ASCII even when LANG says UTF-8.
 */
function isUtf8Locale(env: NodeJS.ProcessEnv): boolean {
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((v) => v !== undefined && v !== "");
  return locale !== undefined && /UTF-?8/i.test(locale);
}

/**
 * Pure: reads only its two arguments (`process.env` is the default for the second), so a test passes
 * both and never depends on the machine it runs on. NO_COLOR is "set" when non-empty (no-color.org).
 */
export function termCaps(stream: { isTTY?: boolean; columns?: number }, env: NodeJS.ProcessEnv = process.env): TermCaps {
  const tty = stream.isTTY === true;
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = env.FORCE_COLOR === "1" || (tty && !noColor && env.TERM !== "dumb");
  const unicode = tty && isUtf8Locale(env) && !noColor && env.KEYHOLE_ASCII !== "1";
  const fromEnv = /^\d+$/.test(env.COLUMNS ?? "") ? positiveInt(Number(env.COLUMNS)) : undefined;
  const width = (tty ? positiveInt(stream.columns) : undefined) ?? fromEnv ?? DEFAULT_WIDTH;
  return { color, unicode, width, tty };
}
