/**
 * Navigation "Global header": `keyhole --help`. The five commands in lifecycle order, each with the
 * keys it loads, so the privilege split is visible before any command runs. Plain ASCII, ≤100 columns.
 */
import type { Command } from "./args.js";

export function helpText(commands: readonly Command[]): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  return [
    "KEYHOLE - any NEAR contract's methods as MCP tools behind a burnable function-call key",
    "",
    `${pad("COMMAND", 10)}KEYS IT LOADS`,
    ...commands.map((c) => `${pad(c.name, 10)}${c.keys}`),
    "",
    "USAGE",
    ...commands.map((c) => `  keyhole ${c.name} ${c.args}`),
    "  From a clone without npm link: npm run keyhole -- COMMAND ARGS",
    "",
    "ARGUMENTS",
    "  CONTRACT, ACCOUNT  NEAR account ids",
    "  METHODS            comma-separated method names, e.g. act_proposal",
    "  AMOUNT             the key's gas allowance in NEAR, explicit and non-zero, e.g. 0.05N",
    "  ID                 the session id that wrap prints, e.g. ks-7f3a",
    "",
    "EXIT CODES",
    "  0    success, or every step PASS",
    "  1    a FAIL step, a declined confirm, or a burned or unknown session",
    "  2    an environment or input error; nothing was signed",
    "  3    a transaction was sent; look it up on chain before signing again",
    "  130  Ctrl-C (also SIGTERM and SIGHUP)",
  ].join("\n");
}
