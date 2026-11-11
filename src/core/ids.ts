/**
 * Identifier rules shared by the core and the commands (final review M8: they lived in src/cli/args.ts, which
 * src/core/wrap.ts then imported across the layers).
 */

/** NEAR account id rules (2–64 chars; lowercase alphanumerics separated by `-`, `_` or `.`). */
export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

export function isMethodName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}
