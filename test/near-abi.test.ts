/**
 * Task 11: tools from a contract's embedded near-abi (src/packs/near-abi.ts), and the live near-abi branch of
 * loadTargetPack (R17b). Offline: every RPC reply is either the counter's `__contract_abi` view body recorded on
 * near-sandbox (demo/fixtures/sandbox.counter.abi.json, `npm run capture:sandbox -- --classifier`, never
 * regenerated here) or a reply built from it in the test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { useRpcUrl } from "../src/core/config.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import type { PackTool, TargetPack } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { abiPackTools, readContractAbi, toolsFromAbi } from "../src/packs/near-abi.js";
import { REPO, readFixture, replayFetch } from "./helpers.js";

const DEMO_FIXTURES = join(REPO, "demo", "fixtures");
const ABI_FIXTURE = "sandbox.counter.abi.json";
/** The recorded `__contract_abi` view body, read when a test runs (a missing capture fails that test, not the file). */
const abiBody = (): string => readFixture(DEMO_FIXTURES, ABI_FIXTURE);
/** The zstd bytes the recorded view returned. */
const abiBytes = (): Buffer => Buffer.from(JSON.parse(abiBody()).result.result);
/** The recorded ABI, decoded here independently of near-abi.ts. */
const recordedAbi = (): any => JSON.parse(zstdDecompressSync(abiBytes()).toString("utf8"));
/** A `call_function` reply shaped like the recorded one, returning `bytes`. */
const viewReply = (bytes: Uint8Array): string => {
  const body = JSON.parse(abiBody());
  body.result.result = [...bytes];
  return JSON.stringify(body);
};
const EMPTY_ARGS = { type: "object", properties: {}, additionalProperties: false };
const LIVE = { network: "sandbox", receiverId: "counter.sandbox" } as const;
const byName = (tools: PackTool[]): Record<string, PackTool> => Object.fromEntries(tools.map((t) => [t.name, t]));

/** A near-abi 0.4 document with these functions and root-schema definitions. */
const abiOf = (functions: unknown[], definitions: Record<string, unknown> = {}) => ({
  schema_version: "0.4.0",
  metadata: { name: "synthetic", version: "0.0.0" },
  body: { functions, root_schema: { $schema: "http://json-schema.org/draft-07/schema#", title: "String", type: "string", definitions } },
});
const jsonParams = (...args: Array<[string, unknown]>) => ({ serialization_type: "json", args: args.map(([name, type_schema]) => ({ name, type_schema })) });

let urls = 0;
beforeEach(() => {
  useRpcUrl("sandbox", `http://abi-${++urls}.replay.invalid`);
});

describe("readContractAbi + toolsFromAbi over the recorded counter ABI", () => {
  it("reads __contract_abi with one call_function view; the declared counter tools match the ABI's", async () => {
    const log = replayFetch({ "query:call_function": abiBody() });
    const abi = await readContractAbi("sandbox", "counter.sandbox");
    expect(log).toEqual([
      {
        url: expect.stringMatching(/^http:\/\/abi-[0-9]+\.replay\.invalid$/),
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: "counter.sandbox", method_name: "__contract_abi", args_base64: "" },
      },
    ]);
    expect(toolsFromAbi(abi, "counter_").map((t) => [t.name, t.kind])).toEqual(
      expect.arrayContaining([
        ["counter_increment", "call"],
        ["counter_reset", "call"],
        ["counter_transfer_ownership", "call"],
        ["counter_get_value", "view"],
      ]),
    );
    for (const t of (await loadTargetPack("counter")).tools) expect(toolsFromAbi(abi, "counter_").find((a) => a.name === t.name)?.argsSchema).toEqual(t.argsSchema);
  });

  it("zstd-decodes exactly the bytes the view returned, and those bytes are the ABI embedded in the pinned counter.wasm", async () => {
    replayFetch({ "query:call_function": abiBody() });
    expect(await readContractAbi("sandbox", "counter.sandbox")).toEqual(recordedAbi());
    const fixture = (await loadTargetPack("counter")).sandboxFixture;
    expect(fixture?.wasmPath).toBe("contracts/counter/res/counter.wasm");
    // near-sdk's __contract_abi returns its embedded zstd blob verbatim: the recorded ABI is this wasm's own.
    expect(readFileSync(join(REPO, fixture?.wasmPath ?? "")).includes(abiBytes())).toBe(true);
  });

  it("one tool per function the agent may call, in ABI order: named prefix + method, never the #[init] function", () => {
    const abi = recordedAbi();
    // near-sdk adds the NEP-330 view contract_source_metadata to every contract; `new` is the #[init] function.
    expect(abi.body.functions.map((f: { name: string }) => f.name)).toEqual(["contract_source_metadata", "get_value", "increment", "new", "reset", "transfer_ownership"]);
    const tools = toolsFromAbi(abi, "counter_");
    expect(tools.map((t) => t.name)).toEqual(["counter_contract_source_metadata", "counter_get_value", "counter_increment", "counter_reset", "counter_transfer_ownership"]);
    const t = byName(tools);
    expect(t.counter_contract_source_metadata).toEqual({ name: "counter_contract_source_metadata", kind: "view", method: "contract_source_metadata", argsSchema: EMPTY_ARGS, gasTGas: 0 });
    expect(t.counter_increment).toEqual({ name: "counter_increment", kind: "call", method: "increment", argsSchema: EMPTY_ARGS, gasTGas: 30 });
    expect(t.counter_reset).toEqual({ name: "counter_reset", kind: "call", method: "reset", argsSchema: EMPTY_ARGS, gasTGas: 30 });
    expect(t.counter_get_value).toEqual({ name: "counter_get_value", kind: "view", method: "get_value", argsSchema: EMPTY_ARGS, gasTGas: 0 });
    // near-sdk 5.30 inlines the AccountId schema (a string, with its rustdoc); no definitions are needed.
    const newOwner = abi.body.functions.find((f: { name: string }) => f.name === "transfer_ownership").params.args[0];
    expect(newOwner).toMatchObject({ name: "new_owner", type_schema: { type: "string" } });
    expect(t.counter_transfer_ownership).toEqual({
      name: "counter_transfer_ownership",
      kind: "call",
      method: "transfer_ownership",
      argsSchema: { type: "object", properties: { new_owner: newOwner.type_schema }, required: ["new_owner"], additionalProperties: false },
      gasTGas: 30,
    });
    for (const tool of tools) expect(tool).not.toHaveProperty("dryRun"); // the ABI says nothing about dry-run inputs
  });
});

describe("toolsFromAbi rules (synthetic ABIs)", () => {
  it("skips #[init], #[private] and Borsh-argument functions; keeps argument order; carries only the definitions used", () => {
    const abi = abiOf(
      [
        { name: "new", kind: "call", modifiers: ["init"], params: jsonParams(["owner", { type: "string" }]) },
        { name: "on_done", kind: "call", modifiers: ["private"] },
        { name: "raw_borsh", kind: "call", params: { serialization_type: "borsh", args: [{ name: "x", type_schema: { declaration: "u64", definitions: {} } }] } },
        { name: "pay", kind: "call", modifiers: ["payable"], params: jsonParams(["to", { $ref: "#/definitions/Payee" }], ["memo", { type: ["string", "null"] }]) },
        { name: "peek", kind: "view" },
      ],
      {
        Payee: { type: "object", properties: { id: { $ref: "#/definitions/AccountId" } } },
        AccountId: { type: "string" },
        Unused: { type: "integer" },
      },
    );
    const tools = toolsFromAbi(abi, "x_");
    expect(tools.map((t) => t.name)).toEqual(["x_pay", "x_peek"]);
    expect(tools[0]).toEqual({
      name: "x_pay",
      kind: "call",
      method: "pay",
      argsSchema: {
        type: "object",
        properties: { to: { $ref: "#/definitions/Payee" }, memo: { type: ["string", "null"] } },
        required: ["to", "memo"],
        additionalProperties: false,
        definitions: { Payee: abi.body.root_schema.definitions.Payee, AccountId: { type: "string" } },
      },
      gasTGas: 30,
    });
    expect(tools[1]).toEqual({ name: "x_peek", kind: "view", method: "peek", argsSchema: EMPTY_ARGS, gasTGas: 0 });
  });

  it("returns copies: changing a tool never changes the ABI", () => {
    const abi = abiOf([{ name: "pay", kind: "call", params: jsonParams(["to", { $ref: "#/definitions/AccountId" }]) }], { AccountId: { type: "string" } });
    const [tool] = toolsFromAbi(abi, "x_");
    (tool.argsSchema.definitions as any).AccountId.type = "integer";
    (tool.argsSchema.properties as any).to.$ref = "#/definitions/Other";
    expect(abi.body.root_schema.definitions.AccountId).toEqual({ type: "string" });
    expect((abi.body.functions[0] as any).params.args[0].type_schema).toEqual({ $ref: "#/definitions/AccountId" });
  });

  it.each([
    ["not an object", null],
    ["no body.functions", { schema_version: "0.4.0", body: {} }],
    ["a function with no name", abiOf([{ kind: "call" }])],
    ["a function whose name is not a method name", abiOf([{ name: "do-it", kind: "call" }])],
    ["a function whose kind is neither view nor call", abiOf([{ name: "f", kind: "send" }])],
    ["two functions with one name", abiOf([{ name: "f", kind: "call" }, { name: "f", kind: "view" }])],
    ["an argument with no name", abiOf([{ name: "f", kind: "call", params: { serialization_type: "json", args: [{ type_schema: {} }] } }])],
    ["an argument named twice", abiOf([{ name: "f", kind: "call", params: jsonParams(["a", {}], ["a", {}]) }])],
    ["a $ref to a missing definition", abiOf([{ name: "f", kind: "call", params: jsonParams(["a", { $ref: "#/definitions/Nope" }]) }])],
    ["a $ref outside #/definitions/", abiOf([{ name: "f", kind: "call", params: jsonParams(["a", { $ref: "https://example.com/s.json" }]) }])],
  ])("refuses an ABI with %s (EnvironmentError)", (_what, abi) => {
    expect(() => toolsFromAbi(abi, "x_")).toThrow(EnvironmentError);
  });

  it("refuses a prefix that cannot start an MCP tool name", () => {
    expect(() => toolsFromAbi(abiOf([]), "bad prefix ")).toThrow(InputError);
  });

  it("follows recursive definitions without looping", () => {
    const abi = abiOf([{ name: "f", kind: "call", params: jsonParams(["n", { $ref: "#/definitions/Node" }]) }], {
      Node: { type: "object", properties: { next: { anyOf: [{ $ref: "#/definitions/Node" }, { type: "null" }] } } },
    });
    expect(toolsFromAbi(abi, "x_")[0].argsSchema.definitions).toEqual({ Node: abi.body.root_schema.definitions.Node });
  });
});

describe("readContractAbi refusals", () => {
  it("refuses an account of another network before any RPC (InputError)", async () => {
    const log = replayFetch({});
    await expect(readContractAbi("sandbox", "counter.testnet")).rejects.toBeInstanceOf(InputError);
    await expect(readContractAbi("testnet", "counter.near")).rejects.toBeInstanceOf(InputError);
    expect(log).toEqual([]);
  });

  it("a contract with no __contract_abi export is an EnvironmentError that names the account", async () => {
    const noAbi = JSON.stringify({
      jsonrpc: "2.0",
      id: "x",
      error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: {} }, code: -32000, message: "Server error", data: "wasm execution failed with error: MethodResolveError(MethodNotFound)" },
    });
    replayFetch({ "query:call_function": noAbi });
    const err = await readContractAbi("sandbox", "plain.sandbox").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toContain("plain.sandbox");
    expect((err as EnvironmentError).what).toContain("MethodNotFound");
  });

  // C-T11c (final sweep, mutant M5): a zstd blob a few KB long can inflate to gigabytes; MAX_ABI_BYTES (16 MiB) caps what
  // is decoded. The bomb is valid JSON, so with the cap gone it would parse and be served: only the cap refuses it.
  const BOMB = zstdCompressSync(Buffer.from(JSON.stringify({ pad: "a".repeat(16 * 1024 * 1024) })));
  it.each([
    ["bytes that are not zstd", Buffer.from("not zstd at all"), /bytes that are not a zstd-compressed ABI/],
    ["zstd that is not JSON", zstdCompressSync(Buffer.from("not json")), /decompressed to 8 characters that are not JSON/],
    ["zstd that inflates past the 16 MiB cap (a valid JSON document)", BOMB, /bytes that are not a zstd-compressed ABI/],
  ])("%s: EnvironmentError", async (_what, bytes, message) => {
    replayFetch({ "query:call_function": viewReply(bytes) });
    const err = await readContractAbi("sandbox", "counter.sandbox").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(message);
  });

  it("the zstd bomb above is small on the wire, and a document just under the cap is still read", async () => {
    expect(BOMB.length).toBeLessThan(10_000);
    const ok = zstdCompressSync(Buffer.from(JSON.stringify({ pad: "a".repeat(16 * 1024 * 1024 - 64) })));
    replayFetch({ "query:call_function": viewReply(ok) });
    await expect(readContractAbi("sandbox", "counter.sandbox")).resolves.toMatchObject({ pad: expect.any(String) });
  });
});

describe("loadTargetPack(id, live): the live near-abi branch (R17b)", () => {
  it("without live, nothing is read: the declared tools", async () => {
    const log = replayFetch({});
    const pack = await loadTargetPack("counter");
    expect(log).toEqual([]);
    expect(pack.tools.map((t) => t.name)).toEqual(["counter_contract_source_metadata", "counter_get_value", "counter_increment", "counter_reset"]);
  });

  it("with live, the counter's tools are re-read from the receiver's ABI, and equal the declared ones", async () => {
    const log = replayFetch({ "query:call_function": abiBody() });
    const declared = await loadTargetPack("counter");
    const live = await loadTargetPack("counter", LIVE);
    expect(log.map((r) => [r.method, r.params])).toEqual([
      ["query", { request_type: "call_function", finality: "final", account_id: "counter.sandbox", method_name: "__contract_abi", args_base64: "" }],
    ]);
    // Names, kinds and argsSchemas from the ABI; gas and the dry-run inputs carried over from the pack.
    expect(live.tools).toEqual(declared.tools);
    // transfer_ownership is in the ABI, but the pack keeps it out of scope: it is never served as a tool.
    expect(live.tools.map((t) => t.method)).not.toContain("transfer_ownership");
    expect(live.outOfScope).toEqual(declared.outOfScope);
    // Everything but the tools is the pack file's.
    expect({ ...live, tools: [] }).toEqual({ ...declared, tools: [] });
  });

  // C-T11a (final sweep): the pack is selected by the code hash its fixture pins, so a live ABI that does not give the
  // declared tools came from other code (a swap between the code-hash read and the ABI read, or a stale pack). It is
  // refused: no tool is served, labelled or dropped on such a read.
  const edited = (edit: (functions: any[]) => void) => {
    const abi = recordedAbi();
    edit(abi.body.functions);
    return viewReply(zstdCompressSync(Buffer.from(JSON.stringify(abi))));
  };
  it.each([
    ["a declared method the ABI lacks", (fs: any[]) => fs.splice(fs.findIndex((f) => f.name === "reset"), 1), "declared counter_reset is not in the ABI"],
    ["a function the pack does not declare", (fs: any[]) => fs.push({ name: "decrement", kind: "call" }), "counter_decrement is in the ABI, not in the pack"],
    ["a declared call that the ABI lists as a view", (fs: any[]) => (fs.find((f) => f.name === "increment").kind = "view"), "counter_increment is a view of increment in the ABI, a call of increment in the pack"],
    [
      "a declared tool whose arguments differ",
      (fs: any[]) => (fs.find((f) => f.name === "increment").params = jsonParams(["by", { type: "integer" }])),
      "counter_increment takes other arguments in the ABI",
    ],
  ])("C-T11a: %s is an EnvironmentError naming the difference; nothing comes back", async (_what, edit, difference) => {
    const log = replayFetch({ "query:call_function": edited(edit) });
    const err = await loadTargetPack("counter", LIVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe(`the near-abi of counter.sandbox on sandbox does not give pack counter's tools (${difference})`);
    expect((err as EnvironmentError).tryThis).toMatch(/^nothing was signed: the contract's code may have changed after its code hash was read; run wrap again/);
    expect(log.map((r) => r.params.method_name)).toEqual(["__contract_abi"]); // one read, then the refusal
  });

  it("C-T11b: each live tool keeps the pack's own gas (not the ABI's 30) and its dry-run input", async () => {
    const declared = await loadTargetPack("counter");
    const pack: TargetPack = { ...declared, tools: declared.tools.map((t) => (t.name === "counter_increment" ? { ...t, gasTGas: 50 } : t)) };
    replayFetch({ "query:call_function": abiBody() });
    const tools = byName(await abiPackTools(pack, LIVE));
    expect(tools.counter_increment).toEqual({ name: "counter_increment", kind: "call", method: "increment", argsSchema: EMPTY_ARGS, gasTGas: 50, dryRun: { args: {}, depositYocto: null } });
    expect(tools.counter_reset.gasTGas).toBe(30);
    expect(tools.counter_reset.dryRun).toEqual({ args: {}, depositYocto: "1" });
  });

  it("C-T11b: a declared tool of another kind is never merged with the ABI's: the read is refused, no dry-run input crosses kinds", async () => {
    const declared = await loadTargetPack("counter");
    // The pack says reset is a view; the ABI (the recorded one) says call. Merging would hand a view's tool a call's dry-run.
    const pack: TargetPack = { ...declared, tools: declared.tools.map((t) => (t.name === "counter_reset" ? { ...t, kind: "view" as const, gasTGas: 0 } : t)) };
    replayFetch({ "query:call_function": abiBody() });
    const err = await abiPackTools(pack, LIVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toContain("counter_reset is a call of reset in the ABI, a view of reset in the pack");
  });

  it("a pack-json pack (sputnik-v2) is never read live: no RPC, the declared tools", async () => {
    const log = replayFetch({});
    const live = await loadTargetPack("sputnik-v2", { network: "sandbox", receiverId: "dao.sandbox" });
    expect(log).toEqual([]);
    expect(live).toEqual(await loadTargetPack("sputnik-v2"));
  });

  it("a receiver whose ABI cannot be read is an EnvironmentError; one on another network is an InputError before any RPC", async () => {
    replayFetch({ "query:call_function": viewReply(Buffer.from("not zstd at all")) });
    await expect(loadTargetPack("counter", LIVE)).rejects.toBeInstanceOf(EnvironmentError);
    const log = replayFetch({});
    await expect(loadTargetPack("counter", { network: "sandbox", receiverId: "counter.testnet" })).rejects.toBeInstanceOf(InputError);
    expect(log).toEqual([]);
  });
});
