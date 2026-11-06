/**
 * Local configuration: where session metadata lives and which RPC endpoint each network uses.
 * No key material is read here.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentError } from "./errors.js";
import type { Network } from "./types.js";

/** `$KEYHOLE_HOME`, default `~/.keyhole`. */
export function keyholeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KEYHOLE_HOME ? resolve(env.KEYHOLE_HOME) : join(homedir(), ".keyhole");
}

/** Session metadata files: `$KEYHOLE_HOME/sessions/ID.json` (metadata only; never a private key). */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(keyholeHome(env), "sessions");
}

export const DEFAULT_TESTNET_RPC = "https://rpc.testnet.near.org";

const rpcOverrides = new Map<Network, string>();

/** The demo driver calls this after booting near-sandbox, whose RPC port is chosen at start. */
export function useRpcUrl(network: Network, url: string): void {
  rpcOverrides.set(network, url);
}

/**
 * RPC endpoint for a network: an in-process override (useRpcUrl), then `KEYHOLE_TESTNET_RPC` /
 * `KEYHOLE_SANDBOX_RPC`, then the public testnet RPC. Sandbox has no default: its port is per run.
 */
export function rpcUrlFor(network: Network, env: NodeJS.ProcessEnv = process.env): string {
  const override = rpcOverrides.get(network);
  if (override) return override;
  if (network === "testnet") return env.KEYHOLE_TESTNET_RPC || DEFAULT_TESTNET_RPC;
  if (env.KEYHOLE_SANDBOX_RPC) return env.KEYHOLE_SANDBOX_RPC;
  throw new EnvironmentError("no RPC endpoint for network sandbox", "set KEYHOLE_SANDBOX_RPC, or run keyhole demo --sandbox");
}
