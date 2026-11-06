/**
 * DATA CONTRACT #2 `loadTargetPack` (path: local pack JSON; RPC-live for near-abi packs).
 * Packs are data: src/packs/ID.pack.json. The expected error names of the negative tests live here
 * and nowhere else (LAYOUT R4 (e)).
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvironmentError, InputError } from "../core/errors.js";
import { INVALID_ACCESS_KEY_ERRORS, type Network, type TargetPack } from "../core/types.js";
import { abiPackTools } from "./near-abi.js";

const PACKS_DIR = dirname(fileURLToPath(import.meta.url));
const PACK_SUFFIX = ".pack.json";

export async function listPackIds(): Promise<string[]> {
  return (await readdir(PACKS_DIR))
    .filter((f) => f.endsWith(PACK_SUFFIX))
    .map((f) => f.slice(0, -PACK_SUFFIX.length))
    .sort();
}

/**
 * The pack `id` from src/packs/ID.pack.json, shape-checked. `live` names the contract a near-abi pack
 * reads its tools from (Task 11); without it, the declared tools are returned.
 */
export async function loadTargetPack(id: string, live?: { network: Network; receiverId: string }): Promise<TargetPack> {
  // The id becomes a file name: validate it first.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new InputError([`not a target pack id: ${JSON.stringify(id)}`]);
  const file = join(PACKS_DIR, `${id}${PACK_SUFFIX}`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InputError([`no target pack ${id} — available packs: ${(await listPackIds()).join(", ")}`]);
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvironmentError(`target pack ${file} is not JSON`, "fix the pack file");
  }
  const problems = packProblems(parsed, id);
  if (problems.length) throw new EnvironmentError(`target pack ${file} is malformed: ${problems.join(", ")}`, "fix the pack file");
  const pack = parsed as TargetPack;
  // near-abi pack read for a receiver (Task 11, R17): the tools come live from that contract's __contract_abi view
  // (zstd-compressed JSON) and must be the declared ones (C-T11a: abiPackTools refuses any difference); everything
  // else, the dry-run inputs included, from the pack file.
  if (live && pack.abiSource === "near-abi") return { ...pack, tools: await abiPackTools(pack, live) };
  return pack;
}

/**
 * The pack whose sandbox fixture pins this exact code (`sandboxFixture.codeHash`), or null. Pack selection
 * by code hash means the classifier always dry-runs exactly the code that wrap pins.
 */
export async function packForCodeHash(codeHash: string): Promise<TargetPack | null> {
  for (const id of await listPackIds()) {
    const pack = await loadTargetPack(id);
    if (pack.sandboxFixture?.codeHash === codeHash) return pack;
  }
  return null;
}

const REFUSAL_NAMES: readonly string[] = [...INVALID_ACCESS_KEY_ERRORS, "SignerDoesNotExist"];
const VIOLATIONS = ["method", "action", "receiver", "deposit", "allowance", "none"];
const KEY_STATES = ["session-key", "tiny-allowance-key", "after-burn"];
const RECEIVERS = ["receiver", "other-receiver", "attacker"];
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isYocto = (v: unknown) => typeof v === "string" && /^[0-9]+$/.test(v);

/** Shape check of a parsed pack. Returns one entry per problem; empty means well-formed. */
export function packProblems(v: unknown, expectedId?: string): string[] {
  if (!isObj(v)) return ["not an object"];
  const p: string[] = [];
  if (!isStr(v.id) || (expectedId !== undefined && v.id !== expectedId)) p.push("id");
  if (v.abiSource !== "near-abi" && v.abiSource !== "pack-json") p.push("abiSource");
  if (!isStr(v.description)) p.push("description");
  if (!isStr(v.notEnforced)) p.push("notEnforced");
  if (v.exposure !== undefined && !(isObj(v.exposure) && (v.exposure.label === "VOTE" || v.exposure.label === "VALUE") && isStr(v.exposure.value))) p.push("exposure");
  if (!Array.isArray(v.tools)) p.push("tools");
  else
    v.tools.forEach((t, i) => {
      if (!isObj(t) || !isStr(t.name) || !["view", "call", "meta"].includes(t.kind as string) || !(t.method === null || isStr(t.method)) || !isObj(t.argsSchema) || typeof t.gasTGas !== "number") p.push(`tools[${i}]`);
    });
  if (!Array.isArray(v.outOfScope) || !v.outOfScope.every((m) => isObj(m) && isStr(m.method))) p.push("outOfScope");
  const f = v.sandboxFixture;
  if (f !== null && !(isObj(f) && isStr(f.wasmPath) && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256) && isStr(f.codeHash) && isObj(f.init) && isStr(f.init.method) && isObj(f.init.args))) p.push("sandboxFixture");
  if (isObj(f) && f.setup !== undefined) {
    if (!Array.isArray(f.setup)) p.push("sandboxFixture.setup");
    else
      f.setup.forEach((s, i) => {
        if (!(isObj(s) && (s.signer === "seat" || s.signer === "cosigner") && isStr(s.method) && isObj(s.args) && isYocto(s.depositYocto))) p.push(`sandboxFixture.setup[${i}]`);
      });
  }
  if (!Array.isArray(v.negativeTests)) p.push("negativeTests");
  else {
    const ids = new Set<string>();
    v.negativeTests.forEach((t, i) => {
      const ok =
        isObj(t) &&
        isStr(t.id) &&
        !ids.has(t.id) &&
        isStr(t.label) &&
        VIOLATIONS.includes(t.violates as string) &&
        KEY_STATES.includes(t.keyState as string) &&
        RECEIVERS.includes(t.receiver as string) &&
        isStr(t.action) &&
        (t.action !== "FunctionCall" || isStr(t.method)) &&
        isObj(t.args) &&
        isYocto(t.depositYocto) &&
        typeof t.gasTGas === "number" &&
        REFUSAL_NAMES.includes(t.expected as string) &&
        // SignerDoesNotExist (family InvalidTxError, not an access-key error) is the proof of a sub-account burn:
        // only a test run on a burned key may expect it (the renderers count it as a protocol refusal only there).
        (t.expected !== "SignerDoesNotExist" || t.keyState === "after-burn");
      if (!ok) p.push(`negativeTests[${i}]`);
      if (isObj(t) && isStr(t.id)) ids.add(t.id);
    });
  }
  return p;
}
