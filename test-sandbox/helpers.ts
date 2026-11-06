/**
 * Helpers for the live suite (`npm run test:sandbox`): boot a near-sandbox for a block of work and always
 * stop it, create funded accounts with keys generated in memory, and look at what a run leaves behind
 * (files under .sandbox-home, near-sandbox processes started from this repo). Nothing here kills a
 * process: the suite only observes, so a sandbox another project runs is never touched.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, actions } from "near-api-js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import { mustSucceed, signAndSend } from "../src/core/tx.js";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const SANDBOX_HOME = join(REPO, ".sandbox-home");

/** Boots a sandbox, runs `fn` with it, and stops it whatever `fn` does. */
export async function withSandbox<T>(fn: (sb: SandboxHandle) => Promise<T>): Promise<T> {
  const sb = await startSandbox();
  try {
    return await fn(sb);
  } finally {
    await sb.stop();
  }
}

/**
 * Creates `name` under the sandbox root (`seat` → `seat.sandbox`; a full `*.sandbox` id is used as is),
 * funded with `amountYocto` and one full-access key generated in memory. Returns that key.
 */
export async function createAccount(sb: SandboxHandle, name: string, amountYocto: bigint | string): Promise<KeyPair> {
  const accountId = name.endsWith(`.${sb.rootId}`) ? name : `${name}.${sb.rootId}`;
  const keyPair = KeyPair.fromRandom("ed25519");
  const sent = await signAndSend("sandbox", sb.rootId, sb.rootKey, accountId, [
    actions.createAccount(),
    actions.transfer(BigInt(amountYocto)),
    actions.addFullAccessKey(keyPair.getPublicKey()),
  ]);
  mustSucceed(`create ${accountId}`, sent);
  return keyPair;
}

/** Names directly under .sandbox-home, sorted (a run leaves a `run-XXXXXX` dir only while it is up). */
export function sandboxHomeEntries(): string[] {
  try {
    return readdirSync(SANDBOX_HOME).sort();
  } catch {
    return [];
  }
}

/** PIDs of live processes whose command line names a path under this repo's .sandbox-home (our nodes only). */
export function repoSandboxProcesses(): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (args.some((a) => a.startsWith(`${SANDBOX_HOME}/`))) pids.push(Number(entry));
    } catch {
      // the process ended while we looked
    }
  }
  return pids.sort((a, b) => a - b);
}
