/**
 * Sputnik DAO setup helpers (Task 9), shared by the demo driver, the dry-run classifier and the testnet
 * bootstrap so the council is built in one place.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type KeyPair, actions, baseEncode } from "near-api-js";
import { NEAR, TGAS, networkOfAccount } from "../core/amounts.js";
import { rpcUrlFor } from "../core/config.js";
import { EnvironmentError, InputError } from "../core/errors.js";
import { redactUrl } from "../core/rpc.js";
import type { SandboxHandle } from "../core/sandbox.js";
import { type SentTx, mustSucceed, signAndSend, successValue } from "../core/tx.js";
import type { Network, SandboxFixture, TargetPack } from "../core/types.js";
import { loadTargetPack } from "./index.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** NEAR moved into a sandbox DAO account: storage for the ~470 KB wasm plus room for payouts. */
const DAO_FUNDING = 15n * NEAR;
/** Gas a full-access transaction attaches (PRD §7): `new` and add_proposal. */
const FULL_ACCESS_GAS = 100n * TGAS;
const PLACEHOLDER = /\{(seat|cosigner)\}/g;
/** One part of a NEAR account id (no dot): a direct sub-account name. */
const ACCOUNT_LABEL = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
/** near-sandbox's root account. It has no `.sandbox` suffix, so networkOfAccount alone does not place it. */
const SANDBOX_ROOT = "sandbox";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The network an account id names: networkOfAccount, plus the sandbox root itself. */
export const accountNetwork = (accountId: string): Network | null => (accountId === SANDBOX_ROOT ? "sandbox" : networkOfAccount(accountId));

/** `v` deep-copied, with every `{seat}` / `{cosigner}` inside any string replaced in one pass (a filled id is never filled again). */
function fill(v: unknown, ids: { seat: string; cosigner: string }): unknown {
  if (typeof v === "string") return v.replace(PLACEHOLDER, (_m, which: "seat" | "cosigner") => ids[which]);
  if (Array.isArray(v)) return v.map((x) => fill(x, ids));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ids)]));
  return v;
}

function fixtureOf(pack: TargetPack): SandboxFixture {
  if (!pack.sandboxFixture) throw new EnvironmentError(`target pack ${pack.id} has no sandboxFixture to deploy`, "use a pack that pins a contract (sputnik-v2)");
  return pack.sandboxFixture;
}

/** The pack's `new` init args with `{seat}` and `{cosigner}` filled in; `policyOverride` is shallow-merged into the policy. */
export function councilInitArgs(pack: TargetPack, seat: string, cosigner: string, policyOverride?: Record<string, unknown>): Record<string, unknown> {
  const args = fill(fixtureOf(pack).init.args, { seat, cosigner }) as Record<string, unknown>;
  if (policyOverride) args.policy = { ...(isObj(args.policy) ? args.policy : {}), ...policyOverride };
  return args;
}

/**
 * The fixture's wasm (`wasmPath`, relative to the repo root), refused unless its sha256 is the pinned
 * `sha256` and base58 of it is the pinned `codeHash`: what gets deployed is exactly the code wrap pins.
 */
export async function pinnedWasm(fixture: SandboxFixture): Promise<Uint8Array> {
  const path = join(REPO, fixture.wasmPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new EnvironmentError(`cannot read ${fixture.wasmPath}: ${(e as Error).message}`, "restore the vendored wasm (vendor/VENDORED.md)");
  }
  const digest = createHash("sha256").update(bytes).digest();
  if (digest.toString("hex") !== fixture.sha256) {
    throw new EnvironmentError(`${fixture.wasmPath} has sha256 ${digest.toString("hex")}, not the pinned ${fixture.sha256}`, "restore the vendored wasm (vendor/VENDORED.md); never deploy unpinned code");
  }
  if (baseEncode(digest) !== fixture.codeHash) {
    throw new EnvironmentError(`the pack pins code_hash ${fixture.codeHash}, but base58(sha256) of ${fixture.wasmPath} is ${baseEncode(digest)}`, "fix sandboxFixture.codeHash in the pack");
  }
  return new Uint8Array(bytes);
}

/** EnvironmentError unless the `sandbox` network's RPC is `sb`'s; `prepared` names the second check, made right before signing. */
function assertSandboxInUse(sb: SandboxHandle, prepared: boolean): void {
  const inUse = rpcUrlFor("sandbox");
  if (inUse === sb.rpcUrl) return;
  const what = prepared
    ? `the sandbox in use changed to ${redactUrl(inUse)} while the deploy to ${redactUrl(sb.rpcUrl)} was prepared; nothing was signed`
    : `this sandbox handle (${redactUrl(sb.rpcUrl)}) is not the sandbox in use (${redactUrl(inUse)})`;
  throw new EnvironmentError(what, "deploy with the handle of the sandbox started last");
}

/**
 * Creates `ids.daoId` from the sandbox root, deploys the pack's wasm (sha256 checked) and calls `new`, in one tx:
 * [createAccount, transfer(15 NEAR), deployContract(wasm), functionCall("new", councilInitArgs, 100 TGas)].
 * Returns the landed tx (its body is the setup step's evidence); a refused or failed one is an EnvironmentError.
 *
 * Sandbox only by construction, checked before any RPC: the handle's root is `sandbox` or `*.sandbox` and
 * `ids.daoId` is a `*.sandbox` direct sub-account of it (InputError otherwise), so a hand-built handle whose
 * RPC is some other network's can never move NEAR there. `sb` must be the sandbox the `sandbox` network
 * points at, checked once up front and again right before signing. Remaining gap: signAndSend re-reads
 * rpcUrlFor("sandbox") itself, inside the root key's lock (after any queued operation on that key), and
 * Task 2's API takes no URL to pin, so a useRpcUrl in that window is not caught here.
 */
export async function deployDaoSandbox(sb: SandboxHandle, ids: { daoId: string; seat: string; cosigner: string }, policyOverride?: Record<string, unknown>): Promise<SentTx> {
  const problems: string[] = [];
  if (accountNetwork(sb.rootId) !== "sandbox") problems.push(`the handle's root ${JSON.stringify(sb.rootId)} is not a sandbox account (sandbox or *.sandbox): deployDaoSandbox signs on sandbox only`);
  if (networkOfAccount(ids.daoId) !== "sandbox") problems.push(`DAO ${JSON.stringify(ids.daoId)} is not a sandbox account (*.sandbox): deployDaoSandbox signs on sandbox only`);
  const suffix = `.${sb.rootId}`;
  const name = ids.daoId.endsWith(suffix) ? ids.daoId.slice(0, -suffix.length) : "";
  if (!ACCOUNT_LABEL.test(name)) problems.push(`the sandbox root ${sb.rootId} can only create a direct sub-account NAME.${sb.rootId}, not ${JSON.stringify(ids.daoId)}`);
  if (problems.length) throw new InputError(problems);
  assertSandboxInUse(sb, false);
  const pack = await loadTargetPack("sputnik-v2");
  const fixture = fixtureOf(pack);
  const wasm = await pinnedWasm(fixture);
  const init = actions.functionCall(fixture.init.method, councilInitArgs(pack, ids.seat, ids.cosigner, policyOverride), FULL_ACCESS_GAS, 0n);
  const acts = [actions.createAccount(), actions.transfer(DAO_FUNDING), actions.deployContract(wasm), init];
  assertSandboxInUse(sb, true); // the awaits above let another sandbox boot (useRpcUrl); see the remaining gap above
  const sent = await signAndSend("sandbox", sb.rootId, sb.rootKey, ids.daoId, acts);
  return mustSucceed(`create ${ids.daoId}, deploy ${fixture.wasmPath} and ${fixture.init.method}`, sent);
}

/**
 * `add_proposal` with the bond attached; `id` is the one the contract returned (SuccessValue), never assumed.
 * The DAO and the signer must both be accounts of `network` (the sandbox root counts as sandbox): InputError
 * before any RPC otherwise.
 */
export async function addProposal(
  network: Network,
  signerId: string,
  key: KeyPair,
  daoId: string,
  proposal: Record<string, unknown>,
  bondYocto: bigint,
): Promise<{ id: number; sent: SentTx }> {
  const problems: string[] = [];
  if (networkOfAccount(daoId) !== network) problems.push(`DAO ${JSON.stringify(daoId)} is not a ${network} account (*.${network})`);
  if (accountNetwork(signerId) !== network) problems.push(`signer ${JSON.stringify(signerId)} is not a ${network} account (*.${network})`);
  if (bondYocto < 0n) problems.push(`the bond must be >= 0 yocto (got ${bondYocto})`);
  if (problems.length) throw new InputError(problems);
  const sent = mustSucceed(`add_proposal on ${daoId}`, await signAndSend(network, signerId, key, daoId, [actions.functionCall("add_proposal", { proposal }, FULL_ACCESS_GAS, bondYocto)]));
  const id = successValue(sent);
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
    throw new EnvironmentError(`add_proposal on ${daoId} landed but returned ${JSON.stringify(id)}, not a proposal id · tx ${sent.txHash}`, `it is on chain: do not sign it again; read tx ${sent.txHash} and get_last_proposal_id`);
  }
  return { id, sent };
}
