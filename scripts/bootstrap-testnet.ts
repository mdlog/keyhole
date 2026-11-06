/**
 * Testnet bootstrap (Task 15): the operator's demo accounts (seat, cosigner, grantee) and its Sputnik DAO, created
 * once through the sputnik-v2.testnet factory and then reused (src/demo/testnet-setup.ts).
 *
 *   KEYHOLE_OPERATOR=<account>.testnet npm run bootstrap:testnet
 *     creates what is missing (≈6.6 NEAR the first time), or verifies the recorded DAO and reuses it
 *   KEYHOLE_OPERATOR=<account>.testnet npm run bootstrap:testnet -- --check
 *     signs nothing: prints `DAO <dao> · code_hash <hash> · council [<seat>, <cosigner>] · 2-of-2 · operator balance <n> NEAR`
 *
 * Testnet only: the chain id is checked before any other RPC. Prints no key: new keys go to the legacy keychain
 * (0600) and stay there; the state file `$KEYHOLE_HOME/testnet-demo.json` holds public data only.
 * Exit 0 on success, 2 on an input or environment error. A send whose fate is unknown exits 3 (its error's
 * exitCode): its line names the tx hash to look up, and nothing was sent again.
 */
import { KeyholeError } from "../src/core/errors.js";
import { checkTestnetDemo, ensureTestnetDemo, testnetDemoStatePath } from "../src/demo/testnet-setup.js";

const USAGE = "usage: KEYHOLE_OPERATOR=<account>.testnet npm run bootstrap:testnet [-- --check]";
const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(argv: string[]): Promise<number> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check")) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    if (argv[0] === "--check") {
      out((await checkTestnetDemo(process.env)).line);
      return 0;
    }
    const { created } = await ensureTestnetDemo(process.env, { log: out });
    out(`${created ? "wrote" : "state"} ${testnetDemoStatePath(process.env)}`);
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof KeyholeError ? e.line() : `ERROR (environment): ${(e as Error).message}`}\n`);
    return e instanceof KeyholeError ? e.exitCode : 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
