/**
 * CLI entry: `npm run keyhole -- COMMAND` (tsx) and bin/keyhole.mjs (after `npm link`).
 * Tests import ./main.ts instead, which has no side effects.
 */
import { main } from "./main.js";

process.exitCode = await main(process.argv.slice(2));
