/**
 * Tools from a contract's embedded ABI (Task 11): the `__contract_abi` view (zstd-compressed JSON, as
 * near-cli-rs download-abi decodes it), mapped to pack tools.
 *
 * cargo-near embeds the contract's near-abi (schema 0.4) as a zstd blob, and near-sdk's `__contract_abi` view
 * returns it verbatim. readContractAbi reads it with one `call_function` view at final finality and decodes it
 * with Node's zlib.zstdDecompressSync. toolsFromAbi maps it to pack tools:
 * - one tool per function, in ABI order, named `prefix` + the method name, of the ABI's kind (view or call);
 * - skipped: `#[init]` functions (constructors: a second call panics), `#[private]` ones (only the contract itself
 *   may call them) and functions with Borsh arguments (an MCP tool takes JSON);
 * - argsSchema: a JSON-Schema object of the function's JSON arguments, all required (an Option argument still
 *   takes `null`), no others allowed. A `$ref` is kept as it is, and the root-schema definitions it needs
 *   (transitively) travel with the schema under `definitions`;
 * - gasTGas: 30 for a call tool (the gas a pack call attaches, PRD §7), 0 for a view.
 * The ABI says nothing about dry-run inputs: abiPackTools carries those over from the pack file.
 *
 * abiPackTools refuses a live ABI whose tools differ from the pack's declared ones (final sweep, C-T11a): the pack was
 * selected by the code hash its fixture pins, and that code's ABI gives exactly the declared tools, so a difference
 * means the contract's code changed between the code-hash read and the ABI read (or the pack file is stale). Nothing
 * is labelled or signed from such a read.
 *
 * Every refusal is an InputError (the caller's id or prefix) or an EnvironmentError (what the chain returned),
 * raised before anything is returned. Nothing here signs or holds a key.
 */
import { isDeepStrictEqual } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { networkOfAccount } from "../core/amounts.js";
import { rpcUrlFor } from "../core/config.js";
import { EnvironmentError, InputError } from "../core/errors.js";
import { reasonOf, rpcCall, rpcErrorTextAt } from "../core/rpc.js";
import type { JsonSchema, Network, PackTool, TargetPack } from "../core/types.js";

/** The view near-sdk generates for a contract built with an embedded ABI. */
export const ABI_VIEW = "__contract_abi";
/** Gas attached by an ABI-derived call tool (PRD §7: 30 TGas per call). */
export const ABI_CALL_GAS_TGAS = 30;
/** Largest decoded ABI accepted: a zstd blob cannot inflate past this. */
const MAX_ABI_BYTES = 16 * 1024 * 1024;
/** A contract method an exported wasm function can name (as `--allow` takes it). */
const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** MCP tool names are letters, digits, `_` and `-`; the prefix may be empty. */
const TOOL_PREFIX = /^[A-Za-z0-9_-]*$/;
const DEFINITION_REF = /^#\/definitions\/(.+)$/;
const NO_ABI_HINT = "build the contract with cargo-near (it embeds the ABI by default), or use a pack that declares its tools (pack-json)";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Sets an own enumerable property, even for a name like `__proto__`. */
const define = (o: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
};

/** The `__contract_abi` view of `accountId`: the decoded ABI, plus the RPC body exactly as received. */
export async function readContractAbiBody(network: Network, accountId: string): Promise<{ abi: unknown; raw: string }> {
  if (networkOfAccount(accountId) !== network) throw new InputError([`${JSON.stringify(accountId)} is not a ${network} account (*.${network})`]);
  const url = rpcUrlFor(network);
  const reply = await rpcCall(url, "query", { request_type: "call_function", finality: "final", account_id: accountId, method_name: ABI_VIEW, args_base64: "" });
  const bytes: unknown = reply.json?.result?.result;
  if (reply.json?.error || typeof reply.json?.result?.error === "string" || !Array.isArray(bytes)) {
    throw new EnvironmentError(`${accountId} on ${network} has no readable near-abi (view ${ABI_VIEW}): ${rpcErrorTextAt(reply.json, url)}`, NO_ABI_HINT);
  }
  if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new EnvironmentError(`the ${ABI_VIEW} view of ${accountId} on ${network} returned a result that is not a byte array`, NO_ABI_HINT);
  }
  let text: string;
  try {
    text = zstdDecompressSync(Buffer.from(bytes), { maxOutputLength: MAX_ABI_BYTES }).toString("utf8");
  } catch (e) {
    throw new EnvironmentError(`the ${ABI_VIEW} view of ${accountId} on ${network} returned ${bytes.length} bytes that are not a zstd-compressed ABI (${reasonOf(e)})`, NO_ABI_HINT);
  }
  try {
    return { abi: JSON.parse(text), raw: reply.raw };
  } catch {
    throw new EnvironmentError(`the ${ABI_VIEW} view of ${accountId} on ${network} decompressed to ${text.length} characters that are not JSON`, NO_ABI_HINT);
  }
}

/** The decoded ABI of `accountId`'s contract. */
export async function readContractAbi(network: Network, accountId: string): Promise<unknown> {
  return (await readContractAbiBody(network, accountId)).abi;
}

/** One pack tool per ABI function; tool names are `prefix` + the method name. */
export function toolsFromAbi(abi: unknown, prefix: string): PackTool[] {
  if (!TOOL_PREFIX.test(prefix)) throw new InputError([`tool prefix ${JSON.stringify(prefix)} may hold only letters, digits, "_" and "-" (an MCP tool name)`]);
  const bad = (what: string) => new EnvironmentError(`the contract's near-abi ${what}`, "check the contract's ABI (cargo near abi); tools are made only from a well-formed one");
  if (!isObj(abi) || !isObj(abi.body) || !Array.isArray(abi.body.functions)) throw bad("has no body.functions list");
  const root = abi.body.root_schema;
  const definitions = isObj(root) && isObj(root.definitions) ? root.definitions : {};

  const seen = new Set<string>();
  const tools: PackTool[] = [];
  abi.body.functions.forEach((f: unknown, i: number) => {
    if (!isObj(f) || typeof f.name !== "string" || !METHOD_NAME.test(f.name)) throw bad(`function [${i}] has no method name (${JSON.stringify(isObj(f) ? f.name : f)})`);
    const method = f.name;
    if (seen.has(method)) throw bad(`lists function ${method} twice`);
    seen.add(method);
    if (f.kind !== "view" && f.kind !== "call") throw bad(`function ${method} has kind ${JSON.stringify(f.kind)}, not view or call`);
    if (f.modifiers !== undefined && !(Array.isArray(f.modifiers) && f.modifiers.every((m) => typeof m === "string"))) throw bad(`function ${method} has malformed modifiers`);
    const params = f.params;
    if (params !== undefined && !(isObj(params) && Array.isArray(params.args) && (params.serialization_type === "json" || params.serialization_type === "borsh"))) {
      throw bad(`function ${method} has malformed params`);
    }
    const modifiers = (f.modifiers ?? []) as string[];
    if (modifiers.includes("init") || modifiers.includes("private") || params?.serialization_type === "borsh") return;
    tools.push({
      name: `${prefix}${method}`,
      kind: f.kind,
      method,
      argsSchema: argsSchemaOf(method, (params?.args ?? []) as unknown[], definitions, bad),
      gasTGas: f.kind === "call" ? ABI_CALL_GAS_TGAS : 0,
    });
  });
  return tools;
}

/** The JSON-Schema object of one function's JSON arguments (copies; the ABI is never shared or changed). */
function argsSchemaOf(method: string, args: unknown[], definitions: Record<string, unknown>, bad: (what: string) => EnvironmentError): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  args.forEach((a, j) => {
    if (!isObj(a) || typeof a.name !== "string" || a.name === "") throw bad(`function ${method}: argument [${j}] has no name`);
    if (Object.hasOwn(properties, a.name)) throw bad(`function ${method} names argument ${a.name} twice`);
    const schema = a.type_schema ?? {};
    if (!isObj(schema) && typeof schema !== "boolean") throw bad(`function ${method}: argument ${a.name} has a type_schema that is not a JSON Schema`);
    define(properties, a.name, structuredClone(schema));
    required.push(a.name);
  });
  const used = usedDefinitions(Object.values(properties), definitions, method, bad);
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
    ...(Object.keys(used).length ? { definitions: used } : {}),
  };
}

/** The root-schema definitions `schemas` reach through `#/definitions/NAME` refs, transitively (each once). */
function usedDefinitions(schemas: unknown[], definitions: Record<string, unknown>, method: string, bad: (what: string) => EnvironmentError): Record<string, unknown> {
  const used: Record<string, unknown> = {};
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!isObj(v)) return;
    for (const [key, x] of Object.entries(v)) {
      if (key !== "$ref" || typeof x !== "string") {
        visit(x);
        continue;
      }
      const m = DEFINITION_REF.exec(x);
      if (!m) throw bad(`function ${method}: $ref ${JSON.stringify(x)} is not a #/definitions/ reference`);
      const name = m[1].replace(/~1/g, "/").replace(/~0/g, "~"); // JSON Pointer escapes
      if (!Object.hasOwn(definitions, name)) throw bad(`function ${method}: $ref ${JSON.stringify(x)} names no definition in root_schema`);
      if (Object.hasOwn(used, name)) continue;
      define(used, name, structuredClone(definitions[name])); // before visiting: a recursive definition stops here
      visit(definitions[name]);
    }
  };
  schemas.forEach(visit);
  return used;
}

/** The tool-name prefix of a near-abi pack: its id with `-` as `_`, then `_` (pack `counter` → `counter_increment`). */
export const abiToolPrefix = (packId: string): string => `${packId.replace(/-/g, "_")}_`;

/**
 * The tools of near-abi pack `pack` for the contract at `live.receiverId` (loadTargetPack's live branch, R17):
 * one per function of that contract's ABI (toolsFromAbi, abiToolPrefix) except the pack's out-of-scope methods,
 * which are never served. Each must be one the pack declares, with the same name, kind, method and argsSchema, and
 * every declared tool must be there (C-T11a): any difference is an EnvironmentError, so a tool is never served,
 * labelled or dropped on a read that does not match the pinned code. Each tool keeps the pack's gas and dry-run
 * input (the ABI has neither). The pack's meta tools are kept.
 */
export async function abiPackTools(pack: TargetPack, live: { network: Network; receiverId: string }): Promise<PackTool[]> {
  const fromAbi = toolsFromAbi(await readContractAbi(live.network, live.receiverId), abiToolPrefix(pack.id));
  const outOfScope = new Set(pack.outOfScope.map((m) => m.method));
  const served = fromAbi.filter((t) => !outOfScope.has(t.method as string));
  const declared = pack.tools.filter((t) => t.kind !== "meta");
  const differences = toolDifferences(served, declared);
  if (differences.length) {
    throw new EnvironmentError(
      `the near-abi of ${live.receiverId} on ${live.network} does not give pack ${pack.id}'s tools (${differences.join("; ")})`,
      "nothing was signed: the contract's code may have changed after its code hash was read; run wrap again (a pack whose tools are stale must be re-pinned from its code)",
    );
  }
  const byName = new Map(declared.map((t) => [t.name, t]));
  const tools = served.map((t): PackTool => {
    const d = byName.get(t.name) as PackTool;
    return { ...t, gasTGas: d.gasTGas, ...(d.dryRun ? { dryRun: structuredClone(d.dryRun) } : {}) };
  });
  return [...tools, ...pack.tools.filter((t) => t.kind === "meta").map((t) => structuredClone(t))];
}

/** How the ABI's tools differ from the declared ones, by tool name: missing, extra, or another kind, method or argsSchema. */
function toolDifferences(fromAbi: readonly PackTool[], declared: readonly PackTool[]): string[] {
  const abi = new Map(fromAbi.map((t) => [t.name, t]));
  const pack = new Map(declared.map((t) => [t.name, t]));
  const out: string[] = [];
  for (const d of declared) if (!abi.has(d.name)) out.push(`declared ${d.name} is not in the ABI`);
  for (const t of fromAbi) {
    const d = pack.get(t.name);
    if (!d) out.push(`${t.name} is in the ABI, not in the pack`);
    else if (d.kind !== t.kind || d.method !== t.method) out.push(`${t.name} is a ${t.kind} of ${t.method} in the ABI, a ${d.kind} of ${d.method} in the pack`);
    else if (!isDeepStrictEqual(d.argsSchema, t.argsSchema)) out.push(`${t.name} takes other arguments in the ABI`);
  }
  return out;
}
