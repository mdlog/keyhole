/**
 * Builds the counter contract (Task 11) in-repo:
 *
 *   npm run build:counter
 *
 * Runs `cargo near build non-reproducible-wasm --locked` in contracts/counter (Rust 1.95.0 from its
 * rust-toolchain.toml; cargo-near 0.22.0 runs wasm-opt and embeds the zstd-compressed near-abi that the
 * `__contract_abi` view returns), copies target/near/counter.wasm to contracts/counter/res/counter.wasm, and
 * prints exactly one line:
 *
 *   counter.wasm sha256 <hex> · codeHash <base58>
 *
 * the two values the counter pack pins (`sandboxFixture.sha256` and `.codeHash`; NEAR's code_hash is
 * base58(sha256(wasm))). cargo's own output is printed only when the build fails, on stderr, and the exit code
 * is then 2 (an environment error; Global Constraints → exit codes). Never runs `cargo clean`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseEncode } from "near-api-js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CRATE = join(REPO, "contracts", "counter");
const BUILT = join(CRATE, "target", "near", "counter.wasm");
const PINNED = join(CRATE, "res", "counter.wasm");
const CARGO_ARGS = ["near", "build", "non-reproducible-wasm", "--locked"];
const TRY = "check the Rust 1.95.0 toolchain (with wasm32-unknown-unknown) and cargo-near 0.22.0";

function fail(what: string): number {
  process.stderr.write(`ERROR (environment): ${what} · ${TRY}\n`);
  return 2;
}

function main(): number {
  const r = spawnSync("cargo", CARGO_ARGS, { cwd: CRATE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return fail(`cargo ${CARGO_ARGS.join(" ")} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout}${r.stderr}`);
    return fail(`cargo ${CARGO_ARGS.join(" ")} in contracts/counter exited ${r.status ?? r.signal}`);
  }
  if (!existsSync(BUILT)) return fail(`the build finished but wrote no ${BUILT.slice(REPO.length)}`);
  copyFileSync(BUILT, PINNED);
  chmodSync(PINNED, 0o644); // cargo writes the wasm 0600; the pinned copy is an ordinary repo file
  const digest = createHash("sha256").update(readFileSync(PINNED)).digest();
  process.stdout.write(`counter.wasm sha256 ${digest.toString("hex")} · codeHash ${baseEncode(digest)}\n`);
  return 0;
}

process.exitCode = main();
