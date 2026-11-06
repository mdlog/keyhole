/**
 * Task 11 live suite (`npm run test:sandbox`): the counter contract (contracts/counter, built in-repo by
 * `npm run build:counter`) on a real near-sandbox (nearcore 2.14.0). Local only: every key is generated in memory
 * here or is the sandbox root's, and none is printed.
 *
 * 1. The pinned wasm (sha256 = the pack's) deploys and initialises with the pack's init args; `increment` returns 1.
 * 2. Its embedded ABI, read live, is the recorded one, and the live near-abi pack equals the declared pack.
 * 3. classifyTools over the live pack, in the same sandbox: increment callable, reset fails-without-deposit
 *    (runtime), transfer_ownership (out of scope) not in allowlist, get_value a view.
 * 4. The contract's own rules: reset needs exactly 1 yoctoNEAR; transfer_ownership is the owner's only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { type KeyPair, actions } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyTools } from "../src/classify/dry-run.js";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { bodyState, panicMessage } from "../src/core/outcome.js";
import { callView, viewCodeHash } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import { type SentTx, mustSucceed, signAndSend, successValue } from "../src/core/tx.js";
import type { SandboxFixture, TargetPack, ToolSchema } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { readContractAbi } from "../src/packs/near-abi.js";
import { councilInitArgs, pinnedWasm } from "../src/packs/sputnik-setup.js";
import { sampleSession } from "../test/helpers.js";
import { REPO, createAccount, repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

const ABI_FIXTURE = join(REPO, "demo", "fixtures", "sandbox.counter.abi.json");
const byName = (tools: ToolSchema[]): Record<string, ToolSchema> => Object.fromEntries(tools.map((t) => [t.name, t]));

const nodesAtStart = repoSandboxProcesses();
const homeAtStart = sandboxHomeEntries();

let sb: SandboxHandle;
let pack: TargetPack;
let fixture: SandboxFixture;
const ids = { counter: "", owner: "", seat: "" };
const keys: { owner?: KeyPair; seat?: KeyPair } = {};

/** One FunctionCall on the counter from `who`'s full-access key. */
const call = (who: "owner" | "seat", method: string, args: Record<string, unknown>, depositYocto = 0n): Promise<SentTx> =>
  signAndSend("sandbox", ids[who], keys[who] as KeyPair, ids.counter, [actions.functionCall(method, args, 30n * TGAS, depositYocto)]);
const getValue = () => callView(sampleSession({ network: "sandbox", receiverId: ids.counter }), "get_value", {});

beforeAll(async () => {
  sb = await startSandbox();
  pack = await loadTargetPack("counter");
  fixture = pack.sandboxFixture as SandboxFixture;
  for (const who of ["counter", "owner", "seat"] as const) ids[who] = `${who}.${sb.rootId}`;
});

afterAll(async () => {
  await sb?.stop();
  expect(repoSandboxProcesses()).toEqual(nodesAtStart);
  expect(sandboxHomeEntries()).toEqual(homeAtStart);
});

describe("the counter on near-sandbox", () => {
  it("deploys the pinned wasm (sha256 = pack), initialises with the pack's init args, and increment returns 1", async () => {
    expect(fixture.wasmPath).toBe("contracts/counter/res/counter.wasm");
    expect(createHash("sha256").update(readFileSync(join(REPO, fixture.wasmPath))).digest("hex")).toBe(fixture.sha256);
    const wasm = await pinnedWasm(fixture); // also refuses unless base58(sha256) is the pinned codeHash

    keys.owner = await createAccount(sb, ids.owner, 10n * NEAR);
    keys.seat = await createAccount(sb, ids.seat, 10n * NEAR);
    const initArgs = councilInitArgs(pack, ids.seat, ids.owner); // { owner: "{cosigner}" } filled
    expect(initArgs).toEqual({ owner: ids.owner });
    const deployed = await signAndSend("sandbox", sb.rootId, sb.rootKey, ids.counter, [
      actions.createAccount(),
      actions.transfer(5n * NEAR),
      actions.deployContract(wasm),
      actions.functionCall(fixture.init.method, initArgs, 100n * TGAS, 0n),
    ]);
    mustSucceed(`create ${ids.counter}, deploy and ${fixture.init.method}`, deployed);
    expect(await viewCodeHash("sandbox", ids.counter)).toBe(fixture.codeHash);

    expect(await getValue()).toBe(0);
    expect(successValue(mustSucceed("increment", await call("seat", "increment", {})))).toBe(1);
    expect(await getValue()).toBe(1);
  });

  it("its embedded ABI, read live, is the recorded one; the live near-abi pack equals the declared pack", async () => {
    const recorded = JSON.parse(zstdDecompressSync(Buffer.from(JSON.parse(readFileSync(ABI_FIXTURE, "utf8")).result.result)).toString("utf8"));
    expect(await readContractAbi("sandbox", ids.counter)).toEqual(recorded);
    const live = await loadTargetPack("counter", { network: "sandbox", receiverId: ids.counter });
    expect(live.tools).toEqual(pack.tools);
    expect(live).toEqual(pack);
  });

  it("classifyTools over the live pack: increment callable, reset fails-without-deposit (runtime), transfer_ownership not in allowlist", async () => {
    const live = await loadTargetPack("counter", { network: "sandbox", receiverId: ids.counter });
    const tools = byName(await classifyTools(live, { receiverId: ids.counter, methodNames: ["increment", "reset"] }, { sandbox: sb }));
    expect(Object.keys(tools)).toEqual(["counter_contract_source_metadata", "counter_get_value", "counter_increment", "counter_reset", "transfer_ownership"]);
    for (const view of [tools.counter_contract_source_metadata, tools.counter_get_value]) expect(view).not.toHaveProperty("classification");
    expect(tools.counter_increment.classification).toBe("callable");
    expect(tools.counter_reset.classification).toBe("fails-without-deposit (runtime)");
    expect(tools.counter_reset.evidence).toContain("Requires attached deposit of exactly 1 yoctoNEAR");
    expect(tools.transfer_ownership.classification).toBe("not in allowlist");
    expect(tools.transfer_ownership.evidence).toContain("only the owner");
    expect(await getValue()).toBe(1); // the dry-runs ran on a copy, never on this counter
  });

  it("reset needs exactly 1 yoctoNEAR; transfer_ownership is the owner's only", async () => {
    const zero = await call("seat", "reset", {});
    expect(bodyState(zero.raw)).toBe("landed-failed");
    expect(panicMessage(zero.json)).toContain("Requires attached deposit of exactly 1 yoctoNEAR");
    mustSucceed("reset with 1 yocto", await call("seat", "reset", {}, 1n));
    expect(await getValue()).toBe(0);

    const bySeat = await call("seat", "transfer_ownership", { new_owner: ids.seat });
    expect(bodyState(bySeat.raw)).toBe("landed-failed");
    expect(panicMessage(bySeat.json)).toContain("only the owner");
    mustSucceed("transfer_ownership by the owner", await call("owner", "transfer_ownership", { new_owner: ids.seat }));
    const byOldOwner = await call("owner", "transfer_ownership", { new_owner: ids.owner });
    expect(panicMessage(byOldOwner.json)).toContain("only the owner");
  });
});
