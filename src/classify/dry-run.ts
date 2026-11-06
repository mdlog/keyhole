/**
 * DATA CONTRACT #5 `classifyTools` (RPC-live, near-sandbox): the differential dry-run (PRD MH3). Feeds planWrap
 * (R2 WARN lines) and the cage card's method table.
 *
 * Before wrap adds a key, each call tool of the pack, and each out-of-scope method it declares, is run against a
 * sandbox copy of the target, never the target itself:
 * 1. a sandbox: `opts.sandbox` (left running), or one booted here and stopped before returning, after which the
 *    `sandbox` RPC resolves as it did before the call;
 * 2. fresh accounts under the sandbox root: `dry-XXXX` (the contract), `seat-XXXX` and `cosigner-XXXX` (each with a
 *    full-access key generated in memory here);
 * 3. the pack's pinned wasm (sha256 and code hash checked, pinnedWasm), deployed at `dry-XXXX` and initialised in
 *    the same transaction with councilInitArgs (`{seat}` / `{cosigner}` filled, `policyOverride` merged into the
 *    policy) plus `{attacker}` filled, then the fixture's `setup` rows, in order;
 * 4. per method, in pack order (call tools, then out-of-scope methods): one FunctionCall from the seat's key with
 *    0 deposit and the tool's gas; if that does not land cleanly and the pack declares a deposit, once more with
 *    that deposit. Placeholders in the dry-run args are filled the same way.
 * labelMethod turns the bodies into the label. Every evidence string is either fixed text below or text read out
 * of the RPC bodies (the contract's panic message, verbatim; a node's JSON error scrubbed of the RPC URL's path and
 * query); nothing about the method is assumed. Captures are written only once the whole classification succeeded.
 *
 * Sandbox only by construction (fix round 1; the same guards as Task 9's deployDaoSandbox):
 * - before any RPC, the handle's root must be `sandbox` or `*.sandbox` (InputError otherwise). Every account the
 *   classifier creates or signs as is `NAME.<root>`, so every transaction it signs names sandbox accounts only;
 * - before anything is signed, the handle's RPC must be the `sandbox` network's, and its `status` must name neither
 *   mainnet nor testnet;
 * - right before each signAndSend, with no await in between, the `sandbox` network must still point at the handle's
 *   RPC (EnvironmentError otherwise: nothing more is signed). Remaining gap, as in Task 9: signAndSend re-reads
 *   rpcUrlFor("sandbox") itself, inside the signing key's lock, and Task 2's API takes no URL to pin; a useRpcUrl in
 *   that window is not caught here, and the root check above is what keeps the signer a sandbox account even then.
 * Keys: the classifier signs only with the handle's root key and keys it generates in memory. No key is printed,
 * written or returned. A send that fails or whose fate is unknown is never re-sent: the error propagates and the
 * whole classification fails (wrap then signs nothing).
 *
 * Its own sandboxes run one at a time per process (a promise chain), so each run's "before" RPC is the one in use
 * when no other own run is up, and restoring it never brings back a node another run has stopped.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Action, KeyPair, actions } from "near-api-js";
import { NEAR, TGAS } from "../core/amounts.js";
import { rpcUrlFor, useRpcUrl } from "../core/config.js";
import { EnvironmentError, InputError } from "../core/errors.js";
import { bodyState, executionFailure, panicMessage } from "../core/outcome.js";
import { redactUrl, rpcCall, rpcErrorTextAt, viewAccount } from "../core/rpc.js";
import { type SandboxHandle, startSandbox } from "../core/sandbox.js";
import { type SentTx, mustSucceed, signAndSend } from "../core/tx.js";
import type { Classification, DryRunInput, SandboxFixture, TargetPack, ToolSchema } from "../core/types.js";
import { accountNetwork, councilInitArgs, pinnedWasm } from "../packs/sputnik-setup.js";
import { ABSENT_EVIDENCE } from "../render/strings.js";
import { labelMethod } from "./label.js";

export interface ClassifyOptions {
  /** A running sandbox to dry-run in; without one, classifyTools starts (and stops) its own. */
  sandbox?: SandboxHandle;
  /** Write each dry-run body verbatim to `<dir>/sandbox.<pack>.<prefix>dryrun-<method>-zero.json` / `-deposit.json`. */
  capture?: { dir: string; prefix?: string };
  /** Shallow-merged into the init args' policy (e.g. `{ proposal_bond: "0" }` for the zero-bond DAO). */
  policyOverride?: Record<string, unknown>;
}

/** Evidence of a `callable` method. */
export const CALLABLE_EVIDENCE = "dry-run at wrap: succeeded with 0 deposit";
/** Evidence of a method whose pack declares no dry-run input: nothing was run. */
export const NO_DRY_RUN_EVIDENCE = "no dry-run input declared by pack";

/** Gas of the ToolSchema made for an out-of-scope method, and of its dry-run call. */
const OUT_OF_SCOPE_GAS_TGAS = 30;
/** Gas a full-access transaction attaches (PRD §7): the init call and the setup rows. */
const FULL_ACCESS_GAS = 100n * TGAS;
/** NEAR given to the seat and the cosigner: gas, plus the bonds the setup rows and the dry-runs attach. */
const SIGNER_FUNDING = 10n * NEAR;
/** Storage staked per byte (10^19 yocto = 1 NEAR per 100 KB); the contract account gets its wasm's worth plus a margin. */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
const CONTRACT_MARGIN = 10n * NEAR;
/** Draws of the XXXX suffix before giving up on finding three unused account ids. */
const SUFFIX_DRAWS = 16;
const PLACEHOLDER = /\{(seat|cosigner|attacker)\}/g;
/** A capture file name is built from these; anything else could leave the capture dir. */
const CAPTURE_PREFIX = /^[a-z0-9-]*$/;
const CAPTURE_METHOD = /^[A-Za-z0-9_]+$/;

interface Ids {
  contract: string;
  seat: string;
  cosigner: string;
  /** Filled into `{attacker}`; never created (no dry-run needs it to exist). */
  attacker: string;
}

/** What one dry-run observed: the 0-deposit body, and the body with the declared deposit when one was sent. */
interface Observed {
  method: string;
  /** The RPC the bodies came from (the handle's): a node's JSON error text is scrubbed of it. */
  url: string;
  zero: SentTx;
  deposit: { yocto: string; sent: SentTx } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * #5 classifyTools: the pack's tools labelled by a sandbox dry-run (see the header). Returns, in order:
 * - the pack's view (and meta) tools, unclassified;
 * - every call tool, classified, with its evidence;
 * - one ToolSchema per out-of-scope method: `{ name: method, kind: "call", method, argsSchema: {}, gasTGas: 30,
 *   classification, evidence }` (`not in allowlist` unless the scope lists the method).
 * No `dryRun` field is returned, and the pack is not modified. `scope.methodNames` decides only `inAllowlist`;
 * `scope.receiverId` names the real receiver, which is never read or called here: the copy stands in for it
 * (planWrap selected the pack by the receiver's code hash, so the copy runs the same code).
 */
export async function classifyTools(pack: TargetPack, scope: { receiverId: string; methodNames: string[] }, opts: ClassifyOptions = {}): Promise<ToolSchema[]> {
  const fixture = pack.sandboxFixture;
  if (!fixture) throw new EnvironmentError(`target pack ${pack.id} has no sandboxFixture: no pinned code to dry-run`, "use a pack that pins its contract's wasm (sandboxFixture)");
  if (!Array.isArray(scope.methodNames) || scope.methodNames.length === 0) {
    throw new InputError(["classify needs at least one method: an empty method_names lets a function-call key call every method of the receiver"]);
  }
  const prefix = opts.capture?.prefix ?? "";
  if (opts.capture && !CAPTURE_PREFIX.test(prefix)) throw new InputError([`capture prefix ${JSON.stringify(prefix)} must be lowercase letters, digits and dashes`]);
  const inputs = dryRunInputs(pack, opts.capture !== undefined);
  const wasm = await pinnedWasm(fixture); // refused unless it is exactly the pinned code: before any sandbox work

  const run = (sb: SandboxHandle) => dryRunAll(sb, pack, fixture, wasm, inputs, opts);
  const observed = opts.sandbox ? await run(opts.sandbox) : await inOwnSandbox(run);
  const tools = schemas(pack, scope.methodNames, observed);
  // Only a classification that succeeded leaves captures behind: a failed run never leaves a partial set.
  if (opts.capture) for (const o of observed.values()) capture(opts.capture.dir, `sandbox.${pack.id}.${prefix}dryrun-${o.method}`, o);
  return tools;
}

// ---------------------------------------------------------------------------------------------------
// Inputs (no I/O)

/** Key of one dry-run: the same method with the same input is run once, and its bodies are reused. */
const inputKey = (method: string, input: DryRunInput, gasTGas: number) => JSON.stringify([method, input.args, input.depositYocto, gasTGas]);

/** The dry-runs to make, in pack order, each checked: args an object, a deposit in yocto or null, a method safe to name a file. */
function dryRunInputs(pack: TargetPack, capturing: boolean): Map<string, { method: string; input: DryRunInput; gasTGas: number }> {
  const runs = new Map<string, { method: string; input: DryRunInput; gasTGas: number }>();
  const add = (method: string, input: DryRunInput | undefined, gasTGas: number) => {
    if (!input) return;
    const bad = (what: string) => new EnvironmentError(`target pack ${pack.id}: the dry-run input of ${method} ${what}`, "fix the pack's dryRun");
    if (!isObj(input.args)) throw bad("has no args object");
    if (input.depositYocto !== null && !(typeof input.depositYocto === "string" && /^[0-9]+$/.test(input.depositYocto))) throw bad("has a deposit that is not a yocto amount");
    if (!Number.isSafeInteger(gasTGas) || gasTGas <= 0) throw bad(`attaches ${gasTGas} TGas, not a whole number above 0`);
    if (capturing && !CAPTURE_METHOD.test(method)) throw bad("is for a method whose name cannot name a capture file");
    const key = inputKey(method, input, gasTGas);
    // Captures are named by method: a second, different input for the same method would overwrite the first's body.
    if (capturing && !runs.has(key) && [...runs.values()].some((r) => r.method === method)) throw bad("differs from another dry-run input of the same method, and both would capture to one file");
    runs.set(key, { method, input, gasTGas });
  };
  for (const tool of pack.tools) if (tool.kind === "call" && tool.method !== null) add(tool.method, tool.dryRun, tool.gasTGas);
  for (const m of pack.outOfScope) add(m.method, m.dryRun, OUT_OF_SCOPE_GAS_TGAS);
  return runs;
}

/** `v` deep-copied, with every `{seat}`, `{cosigner}` and `{attacker}` inside any string replaced in one pass. */
function fill(v: unknown, ids: Ids): unknown {
  if (typeof v === "string") return v.replace(PLACEHOLDER, (_m, which: "seat" | "cosigner" | "attacker") => ids[which]);
  if (Array.isArray(v)) return v.map((x) => fill(x, ids));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ids)]));
  return v;
}

// ---------------------------------------------------------------------------------------------------
// The sandbox run

/** The tail of the queue of own-sandbox runs: one at a time per process. */
let ownSandboxQueue: Promise<unknown> = Promise.resolve();

/** Runs `run` in a sandbox of its own once every earlier own-sandbox run has finished, whether it succeeded or not. */
function inOwnSandbox<T>(run: (sb: SandboxHandle) => Promise<T>): Promise<T> {
  const next = ownSandboxQueue.then(() => ownSandboxRun(run));
  ownSandboxQueue = next.catch(() => undefined);
  return next;
}

/**
 * Boots a sandbox for `run` and stops it after, whatever `run` does. startSandbox points the `sandbox` RPC at the
 * new node; once it is stopped the RPC is put back as it was, so a wrap on sandbox signs on its own node after.
 * The first error wins: `run`'s, then stop's.
 */
async function ownSandboxRun<T>(run: (sb: SandboxHandle) => Promise<T>): Promise<T> {
  const before = sandboxRpc();
  const sb = await startSandbox();
  let failed = false;
  let error: unknown;
  let result: T | undefined;
  try {
    result = await run(sb);
  } catch (e) {
    failed = true;
    error = e;
  }
  try {
    await sb.stop();
  } catch (e) {
    if (!failed) {
      failed = true;
      error = e;
    }
  } finally {
    restoreSandboxRpc(before);
  }
  if (failed) throw error;
  return result as T;
}

/** The `sandbox` RPC as rpcUrlFor resolves it now, or null when it has none. */
function sandboxRpc(): string | null {
  try {
    return rpcUrlFor("sandbox");
  } catch {
    return null;
  }
}

/**
 * Puts the `sandbox` RPC back to `before`. config.ts has no way to remove an override, but rpcUrlFor skips an empty
 * one: an empty override restores the fallback (KEYHOLE_SANDBOX_RPC, or none) when that is what `before` was.
 */
function restoreSandboxRpc(before: string | null): void {
  const fallback = process.env.KEYHOLE_SANDBOX_RPC || null;
  useRpcUrl("sandbox", before !== null && before !== fallback ? before : "");
}

/** InputError, before any RPC, unless the handle's root is `sandbox` or `*.sandbox`: every id signed for is `NAME.<root>`. */
function requireSandboxRoot(sb: SandboxHandle): void {
  if (accountNetwork(sb.rootId) !== "sandbox") {
    throw new InputError([`the sandbox handle's root ${JSON.stringify(sb.rootId)} is not a sandbox account (sandbox or *.sandbox): the classifier signs on sandbox only`]);
  }
}

/** EnvironmentError unless the `sandbox` network's RPC is the handle's; synchronous, so a caller can sign right after it. */
function assertSandboxInUse(sb: SandboxHandle, signing: boolean): void {
  const inUse = sandboxRpc();
  if (inUse === sb.rpcUrl) return;
  const now = inUse === null ? "none" : redactUrl(inUse);
  const what = signing
    ? `the sandbox in use changed to ${now} during the dry-run on ${redactUrl(sb.rpcUrl)}; nothing more was signed`
    : `this sandbox handle (${redactUrl(sb.rpcUrl)}) is not the sandbox in use (${now})`;
  throw new EnvironmentError(what, "dry-run with the handle of the sandbox started last");
}

/** signAndSend on the `sandbox` network, right after the check that it still points at `sb` (no await in between). */
function sendOn(sb: SandboxHandle, signerId: string, keyPair: KeyPair, receiverId: string, acts: Action[]): Promise<SentTx> {
  assertSandboxInUse(sb, true);
  return signAndSend("sandbox", signerId, keyPair, receiverId, acts);
}

/** The handle must be the sandbox the `sandbox` network signs on, and that node must not be a public chain. */
async function requireLocalSandbox(sb: SandboxHandle): Promise<void> {
  assertSandboxInUse(sb, false);
  const reply = await rpcCall(sb.rpcUrl, "status", []);
  const chainId = reply.json?.result?.chain_id;
  if (typeof chainId !== "string" || chainId === "mainnet" || chainId === "testnet") {
    throw new EnvironmentError(
      `the dry-run RPC ${redactUrl(sb.rpcUrl)} serves chain_id ${JSON.stringify(chainId ?? null)}: the classifier signs on a local near-sandbox only`,
      "pass the handle startSandbox returned, or none",
    );
  }
}

/** Three unused account ids under the root that share one random suffix, plus the attacker id. */
async function freshIds(sb: SandboxHandle): Promise<Ids> {
  for (let i = 0; i < SUFFIX_DRAWS; i++) {
    const x = randomBytes(2).toString("hex");
    const ids: Ids = { contract: `dry-${x}.${sb.rootId}`, seat: `seat-${x}.${sb.rootId}`, cosigner: `cosigner-${x}.${sb.rootId}`, attacker: `attacker-${x}.${sb.rootId}` };
    const existing = await Promise.all([ids.contract, ids.seat, ids.cosigner].map((id) => viewAccount("sandbox", id)));
    if (existing.every((a) => a === null)) return ids;
  }
  throw new EnvironmentError(`no unused dry-XXXX / seat-XXXX / cosigner-XXXX ids under ${sb.rootId} after ${SUFFIX_DRAWS} draws`, "dry-run in a fresh sandbox (pass none)");
}

/** Deploys the copy, runs the setup rows, then every dry-run. Returns what each dry-run observed (nothing is written here). */
async function dryRunAll(
  sb: SandboxHandle,
  pack: TargetPack,
  fixture: SandboxFixture,
  wasm: Uint8Array,
  inputs: Map<string, { method: string; input: DryRunInput; gasTGas: number }>,
  opts: ClassifyOptions,
): Promise<Map<string, Observed>> {
  requireSandboxRoot(sb); // before any RPC
  await requireLocalSandbox(sb);
  const ids = await freshIds(sb);
  const keys = { seat: KeyPair.fromRandom("ed25519"), cosigner: KeyPair.fromRandom("ed25519") };

  for (const who of ["seat", "cosigner"] as const) {
    const sent = await sendOn(sb, sb.rootId, sb.rootKey, ids[who], [actions.createAccount(), actions.transfer(SIGNER_FUNDING), actions.addFullAccessKey(keys[who].getPublicKey())]);
    mustSucceed(`dry-run: create ${ids[who]}`, sent);
  }
  const initArgs = fill(councilInitArgs(pack, ids.seat, ids.cosigner, opts.policyOverride), ids) as Record<string, unknown>;
  const funding = BigInt(wasm.length) * STORAGE_YOCTO_PER_BYTE + CONTRACT_MARGIN;
  const deployed = await sendOn(sb, sb.rootId, sb.rootKey, ids.contract, [
    actions.createAccount(),
    actions.transfer(funding),
    actions.deployContract(wasm),
    actions.functionCall(fixture.init.method, initArgs, FULL_ACCESS_GAS, 0n),
  ]);
  mustSucceed(`dry-run: create ${ids.contract}, deploy ${fixture.wasmPath} and ${fixture.init.method}`, deployed);

  for (const [i, row] of (fixture.setup ?? []).entries()) {
    const args = fill(row.args, ids) as Record<string, unknown>;
    const sent = await sendOn(sb, ids[row.signer], keys[row.signer], ids.contract, [actions.functionCall(row.method, args, FULL_ACCESS_GAS, BigInt(row.depositYocto))]);
    mustSucceed(`dry-run setup row ${i} (${row.signer} ${row.method})`, sent);
  }

  const call = (method: string, args: Record<string, unknown>, gasTGas: number, depositYocto: bigint) =>
    sendOn(sb, ids.seat, keys.seat, ids.contract, [actions.functionCall(method, args, BigInt(gasTGas) * TGAS, depositYocto)]);
  const observed = new Map<string, Observed>();
  for (const [key, { method, input, gasTGas }] of inputs) {
    const args = fill(input.args, ids) as Record<string, unknown>;
    const zero = await call(method, args, gasTGas, 0n);
    let deposit: Observed["deposit"] = null;
    if (bodyState(zero.raw) !== "landed-ok" && input.depositYocto !== null) {
      deposit = { yocto: input.depositYocto, sent: await call(method, args, gasTGas, BigInt(input.depositYocto)) };
    }
    observed.set(key, { method, url: sb.rpcUrl, zero, deposit });
  }
  return observed;
}

/** Writes the bodies exactly as received: `<base>-zero.json`, and `<base>-deposit.json` when a deposit call was made. */
function capture(dir: string, base: string, o: Observed): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${base}-zero.json`), o.zero.raw);
  if (o.deposit) writeFileSync(join(dir, `${base}-deposit.json`), o.deposit.sent.raw);
}

// ---------------------------------------------------------------------------------------------------
// Labels and evidence

/**
 * What a body says happened, in the body's own words: "succeeded", the contract's panic text, or the failure. A node's
 * JSON error is scrubbed of `url`'s path and query (rpcErrorTextAt), so an endpoint's API key never becomes evidence.
 */
function outcomeText(sent: SentTx, url: string): string {
  switch (bodyState(sent.raw)) {
    case "landed-ok":
      return "succeeded";
    case "landed-failed":
      return panicMessage(sent.json) ?? executionFailure(sent.json) ?? "failed in a block";
    case "not-in-block":
      return `not in a block: ${rpcErrorTextAt(sent.json, url)}`;
    default:
      return "unreadable RPC body";
  }
}

function label(o: Observed, inAllowlist: boolean): { classification: Classification; evidence: string } {
  const classification = labelMethod(o.zero.raw, o.deposit?.sent.raw ?? null, inAllowlist);
  const zero = outcomeText(o.zero, o.url);
  switch (classification) {
    case "callable":
      return { classification, evidence: CALLABLE_EVIDENCE };
    case "fails-without-deposit (runtime)":
      return { classification, evidence: zero };
    case "not in allowlist":
      return { classification, evidence: `${ABSENT_EVIDENCE}; 0-deposit dry-run: ${zero}` };
    default:
      return { classification, evidence: o.deposit ? `${zero} · with ${o.deposit.yocto} yocto deposit: ${outcomeText(o.deposit.sent, o.url)}` : zero };
  }
}

/** A method with nothing to run: `not in allowlist` still holds outside the scope; inside it, the label is inconclusive. */
function unrun(inAllowlist: boolean, why: string): { classification: Classification; evidence: string } {
  return inAllowlist ? { classification: "inconclusive", evidence: why } : { classification: "not in allowlist", evidence: `${ABSENT_EVIDENCE}; 0-deposit dry-run: none (${why})` };
}

function schemas(pack: TargetPack, methodNames: readonly string[], observed: Map<string, Observed>): ToolSchema[] {
  const labelled = (method: string, input: DryRunInput | undefined, gasTGas: number) => {
    const inAllowlist = methodNames.includes(method);
    if (!input) return unrun(inAllowlist, NO_DRY_RUN_EVIDENCE);
    const o = observed.get(inputKey(method, input, gasTGas));
    if (!o) throw new Error(`classifyTools: the dry-run of ${method} was planned but never observed`); // unreachable: dryRunAll runs every input
    return label(o, inAllowlist);
  };
  const tools = pack.tools.map(({ dryRun, ...tool }): ToolSchema => {
    const schema = structuredClone(tool);
    if (tool.kind !== "call") return schema;
    if (tool.method === null) return { ...schema, classification: "inconclusive", evidence: "no contract method declared by pack" };
    return { ...schema, ...labelled(tool.method, dryRun, tool.gasTGas) };
  });
  for (const m of pack.outOfScope) {
    tools.push({ name: m.method, kind: "call", method: m.method, argsSchema: {}, gasTGas: OUT_OF_SCOPE_GAS_TGAS, ...labelled(m.method, m.dryRun, OUT_OF_SCOPE_GAS_TGAS) });
  }
  return tools;
}
