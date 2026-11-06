/**
 * Task 10 live suite (`npm run test:sandbox`): classifyTools, the differential dry-run, against a real near-sandbox
 * (nearcore 2.14.0) running the vendored sputnikdao2 v2.0.0. Local only: the classifier signs with the sandbox
 * root key and with keys it generates in memory; none is printed.
 *
 * 1. Given no sandbox, classifyTools boots its own, labels the hero scope, stops it, and puts the `sandbox` RPC
 *    back as it was: no node and no run dir is left behind.
 * 2. Zero-bond DAO (policyOverride): add_proposal, in the allowlist, is callable with 0 deposit.
 * 3. In a running sandbox (opts.sandbox, left running): each body is captured verbatim, every label agrees with
 *    labelMethod over the captured bodies, and each evidence string is text read from them. Then the four labels,
 *    including `inconclusive` with its evidence, and the refusals made before anything is signed.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLABLE_EVIDENCE, NO_DRY_RUN_EVIDENCE, classifyTools } from "../src/classify/dry-run.js";
import { labelMethod } from "../src/classify/label.js";
import { rpcUrlFor } from "../src/core/config.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import { bodyState, panicMessage } from "../src/core/outcome.js";
import { callView, rpcCall, viewAccount, viewCodeHash } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import type { PackTool, TargetPack, ToolSchema } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { ABSENT_EVIDENCE } from "../src/render/strings.js";
import { sampleSession } from "../test/helpers.js";
import { repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

const HERO = { receiverId: "x.sandbox", methodNames: ["act_proposal"] };
const BOND = "100000000000000000000000";

const byName = (tools: ToolSchema[]): Record<string, ToolSchema> => Object.fromEntries(tools.map((t) => [t.name, t]));
/** The `sandbox` RPC as rpcUrlFor resolves it now, or null when it has none. */
const sandboxRpc = (): string | null => {
  try {
    return rpcUrlFor("sandbox");
  } catch {
    return null;
  }
};

const tmpDirs: string[] = [];
const captureDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "keyhole-dryrun-"));
  tmpDirs.push(dir);
  return dir;
};
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
/** The dry-run DAO a captured body went to (`dry-XXXX.sandbox`). */
const receiverOf = (raw: string): string => JSON.parse(raw).result.transaction.receiver_id;

let pack: TargetPack;
const nodesAtStart = repoSandboxProcesses();
const homeAtStart = sandboxHomeEntries();

beforeAll(async () => {
  pack = await loadTargetPack("sputnik-v2");
});

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(repoSandboxProcesses()).toEqual(nodesAtStart);
  expect(sandboxHomeEntries()).toEqual(homeAtStart);
});

describe("classifyTools with no sandbox given", () => {
  it("boots its own, labels the hero scope, stops it, and restores the sandbox RPC", async () => {
    const rpcBefore = sandboxRpc();
    const tools = await classifyTools(pack, HERO);

    expect(byName(tools)).toMatchObject({
      dao_vote: { classification: "callable" },
      add_proposal: { classification: "not in allowlist", evidence: expect.stringContaining("ERR_MIN_BOND") },
      dao_list_proposals: { kind: "view" },
    });
    // The views unclassified, every call tool classified, one schema per out-of-scope method; no dryRun leaks out.
    expect(tools.map((t) => t.name)).toEqual(["dao_list_proposals", "dao_get_policy", "dao_vote", "add_proposal"]);
    const { dao_list_proposals, dao_get_policy, dao_vote, add_proposal } = byName(tools);
    for (const view of [dao_list_proposals, dao_get_policy]) {
      expect(view).not.toHaveProperty("classification");
      expect(view).not.toHaveProperty("evidence");
    }
    for (const t of tools) expect(t).not.toHaveProperty("dryRun");
    const { dryRun: _dryRun, ...voteTemplate } = pack.tools.find((t) => t.name === "dao_vote") as PackTool;
    expect(dao_vote).toEqual({ ...voteTemplate, classification: "callable", evidence: CALLABLE_EVIDENCE });
    expect(add_proposal).toEqual({ name: "add_proposal", kind: "call", method: "add_proposal", argsSchema: {}, gasTGas: 30, classification: "not in allowlist", evidence: expect.any(String) });
    expect(add_proposal.evidence).toMatch(/^absent from the key's method_names \(chain\); 0-deposit dry-run: Smart contract panicked: .*ERR_MIN_BOND/);
    expect(pack.tools.find((t) => t.name === "dao_vote")).not.toHaveProperty("classification"); // the pack is not touched

    // Its own sandbox is gone, and the sandbox RPC resolves as it did before the call.
    expect(repoSandboxProcesses()).toEqual(nodesAtStart);
    expect(sandboxHomeEntries()).toEqual(homeAtStart);
    expect(sandboxRpc()).toBe(rpcBefore);
  });

  it("a classification that throws in its own sandbox (a setup row panics) still stops it and restores the sandbox RPC", async () => {
    const rpcBefore = sandboxRpc();
    const variant = structuredClone(pack);
    if (!variant.sandboxFixture) throw new Error("sputnik-v2 pack has no sandboxFixture");
    // No proposal #99 to vote on: the setup row lands and panics, so mustSucceed throws mid-run.
    variant.sandboxFixture.setup = [{ signer: "seat", method: "act_proposal", args: { id: 99, action: "VoteApprove", proposal: "Vote", memo: null }, depositYocto: "0" }];
    const dir = captureDir();
    await expect(classifyTools(variant, HERO, { capture: { dir } })).rejects.toThrow(EnvironmentError);
    expect(sandboxRpc()).toBe(rpcBefore);
    expect(repoSandboxProcesses()).toEqual(nodesAtStart);
    expect(sandboxHomeEntries()).toEqual(homeAtStart);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("zero-bond DAO: add_proposal in the allowlist is callable with 0 deposit", async () => {
    const tools = byName(await classifyTools(pack, { receiverId: "x", methodNames: ["act_proposal", "add_proposal"] }, { policyOverride: { proposal_bond: "0" } }));
    expect(tools.add_proposal.classification).toBe("callable");
    expect(tools.add_proposal.evidence).toBe(CALLABLE_EVIDENCE);
    expect(tools.dao_vote.classification).toBe("callable");
    expect(repoSandboxProcesses()).toEqual(nodesAtStart);
  });
});

describe("classifyTools in a running sandbox (opts.sandbox)", () => {
  let sb: SandboxHandle;

  beforeAll(async () => {
    sb = await startSandbox();
  });

  afterAll(async () => {
    await sb?.stop();
  });

  it("captures each body verbatim; the labels and the evidence come from those bodies; the sandbox stays up", async () => {
    const dir = captureDir();
    const tools = byName(await classifyTools(pack, HERO, { sandbox: sb, capture: { dir } }));
    // 0-deposit act_proposal landed: no -deposit call. add_proposal failed with 0, so it ran again with the bond.
    expect(readdirSync(dir).sort()).toEqual(["sandbox.sputnik-v2.dryrun-act_proposal-zero.json", "sandbox.sputnik-v2.dryrun-add_proposal-deposit.json", "sandbox.sputnik-v2.dryrun-add_proposal-zero.json"]);
    const voteZero = read(dir, "sandbox.sputnik-v2.dryrun-act_proposal-zero.json");
    const addZero = read(dir, "sandbox.sputnik-v2.dryrun-add_proposal-zero.json");
    const addDeposit = read(dir, "sandbox.sputnik-v2.dryrun-add_proposal-deposit.json");
    expect(bodyState(voteZero)).toBe("landed-ok");
    expect(bodyState(addZero)).toBe("landed-failed");
    expect(bodyState(addDeposit)).toBe("landed-ok");

    expect(tools.dao_vote.classification).toBe(labelMethod(voteZero, null, true));
    expect(tools.add_proposal.classification).toBe(labelMethod(addZero, addDeposit, false));
    expect(tools.add_proposal.evidence).toBe(`${ABSENT_EVIDENCE}; 0-deposit dry-run: ${panicMessage(JSON.parse(addZero))}`);

    // The calls went to a fresh dry-XXXX copy running exactly the pinned code, seeded by the setup row; the
    // scope's receiver (no such account here) was never read or written.
    const dry = receiverOf(voteZero);
    expect(dry).toMatch(/^dry-[0-9a-f]{4}\.sandbox$/);
    expect([receiverOf(addZero), receiverOf(addDeposit)]).toEqual([dry, dry]);
    expect(await viewCodeHash("sandbox", dry)).toBe(pack.sandboxFixture?.codeHash);
    const drySession = sampleSession({ receiverId: dry });
    expect(((await callView(drySession, "get_policy", {})) as any).proposal_bond).toBe(BOND);
    expect(await callView(drySession, "get_last_proposal_id", {})).toBe(2); // setup #0, then the bond dry-run #1
    expect(await viewAccount("sandbox", HERO.receiverId)).toBeNull();

    // A handle passed in is not stopped.
    expect((await rpcCall(sb.rpcUrl, "status", [])).json.result.chain_id).toEqual(expect.any(String));
    expect(sandboxRpc()).toBe(sb.rpcUrl);
  });

  it("zero-bond capture (prefix): both 0-deposit calls land, so there is no -deposit file", async () => {
    const dir = captureDir();
    const tools = byName(await classifyTools(pack, { receiverId: "x.sandbox", methodNames: ["act_proposal", "add_proposal"] }, { sandbox: sb, capture: { dir, prefix: "zero-bond-" }, policyOverride: { proposal_bond: "0" } }));
    expect(readdirSync(dir).sort()).toEqual(["sandbox.sputnik-v2.zero-bond-dryrun-act_proposal-zero.json", "sandbox.sputnik-v2.zero-bond-dryrun-add_proposal-zero.json"]);
    const addZero = read(dir, "sandbox.sputnik-v2.zero-bond-dryrun-add_proposal-zero.json");
    expect(tools.add_proposal).toMatchObject({ classification: labelMethod(addZero, null, true), evidence: CALLABLE_EVIDENCE });
    expect(tools.add_proposal.classification).toBe("callable");
    const dry = receiverOf(addZero);
    expect(((await callView(sampleSession({ receiverId: dry }), "get_policy", {})) as any).proposal_bond).toBe("0");
  });

  it("fails-without-deposit (runtime): add_proposal in the allowlist panics with 0 and lands with the bond; evidence = the panic text", async () => {
    const dir = captureDir();
    const tools = byName(await classifyTools(pack, { receiverId: "x.sandbox", methodNames: ["act_proposal", "add_proposal"] }, { sandbox: sb, capture: { dir } }));
    const addZero = read(dir, "sandbox.sputnik-v2.dryrun-add_proposal-zero.json");
    const addDeposit = read(dir, "sandbox.sputnik-v2.dryrun-add_proposal-deposit.json");
    expect(tools.add_proposal.classification).toBe("fails-without-deposit (runtime)");
    expect(tools.add_proposal.classification).toBe(labelMethod(addZero, addDeposit, true));
    expect(tools.add_proposal.evidence).toBe(panicMessage(JSON.parse(addZero)));
    expect(tools.add_proposal.evidence).toContain("ERR_MIN_BOND");
  });

  it("inconclusive carries its evidence: the raw panic text, both ways when a deposit was tried; no dry-run input → said so", async () => {
    const variant = structuredClone(pack);
    const vote = variant.tools.find((t) => t.name === "dao_vote") as PackTool;
    // No proposal #99: the vote panics with 0 deposit, and again with the 1 yocto the variant declares.
    vote.dryRun = { args: { id: 99, action: "VoteApprove", proposal: "Vote", memo: "keyhole dry-run" }, depositYocto: "1" };
    const { dryRun: _dryRun, ...undeclared } = vote;
    variant.tools.push({ ...undeclared, name: "dao_vote_undeclared" });
    variant.outOfScope = [{ method: "add_proposal" }];

    const dir = captureDir();
    const tools = byName(await classifyTools(variant, { receiverId: "x.sandbox", methodNames: ["act_proposal"] }, { sandbox: sb, capture: { dir } }));
    expect(readdirSync(dir).sort()).toEqual(["sandbox.sputnik-v2.dryrun-act_proposal-deposit.json", "sandbox.sputnik-v2.dryrun-act_proposal-zero.json"]);
    const zero = read(dir, "sandbox.sputnik-v2.dryrun-act_proposal-zero.json");
    const deposit = read(dir, "sandbox.sputnik-v2.dryrun-act_proposal-deposit.json");
    expect([bodyState(zero), bodyState(deposit)]).toEqual(["landed-failed", "landed-failed"]);
    expect(tools.dao_vote.classification).toBe("inconclusive");
    expect(tools.dao_vote.classification).toBe(labelMethod(zero, deposit, true));
    expect(tools.dao_vote.evidence).toBe(`${panicMessage(JSON.parse(zero))} · with 1 yocto deposit: ${panicMessage(JSON.parse(deposit))}`);
    expect(tools.dao_vote.evidence).toContain("ERR_NO_PROPOSAL");

    // A call tool in the allowlist with no dry-run input: nothing ran, and the label says it could not tell.
    expect(tools.dao_vote_undeclared).toMatchObject({ classification: "inconclusive", evidence: NO_DRY_RUN_EVIDENCE });
    // Out of scope with no dry-run input: not in allowlist, and the evidence says nothing ran.
    expect(tools.add_proposal).toEqual({ name: "add_proposal", kind: "call", method: "add_proposal", argsSchema: {}, gasTGas: 30, classification: "not in allowlist", evidence: `${ABSENT_EVIDENCE}; 0-deposit dry-run: none (${NO_DRY_RUN_EVIDENCE})` });
  });

  it("an inconclusive vote with no deposit declared: only the -zero body, and its panic text is the evidence", async () => {
    const variant = structuredClone(pack);
    const vote = variant.tools.find((t) => t.name === "dao_vote") as PackTool;
    vote.dryRun = { args: { id: 99, action: "VoteApprove", proposal: "Vote", memo: "keyhole dry-run" }, depositYocto: null };
    const dir = captureDir();
    const tools = byName(await classifyTools(variant, HERO, { sandbox: sb, capture: { dir } }));
    expect(readdirSync(dir).filter((f) => f.includes("act_proposal"))).toEqual(["sandbox.sputnik-v2.dryrun-act_proposal-zero.json"]);
    const zero = read(dir, "sandbox.sputnik-v2.dryrun-act_proposal-zero.json");
    expect(tools.dao_vote).toMatchObject({ classification: "inconclusive", evidence: panicMessage(JSON.parse(zero)) });
  });

  it("refuses before signing: a handle that is not the sandbox in use, a pack with no fixture, an empty scope, a bad capture prefix", async () => {
    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      fetches++;
      return realFetch(...args);
    };
    try {
      const stale: SandboxHandle = { rpcUrl: "http://127.0.0.1:9", rootId: "sandbox", rootKey: KeyPair.fromRandom("ed25519"), stop: async () => {} };
      await expect(classifyTools(pack, HERO, { sandbox: stale })).rejects.toThrow(EnvironmentError);
      await expect(classifyTools({ ...pack, sandboxFixture: null }, HERO, { sandbox: sb })).rejects.toThrow(EnvironmentError);
      await expect(classifyTools(pack, { receiverId: "x.sandbox", methodNames: [] }, { sandbox: sb })).rejects.toThrow(InputError);
      await expect(classifyTools(pack, HERO, { sandbox: sb, capture: { dir: captureDir(), prefix: "../x-" } })).rejects.toThrow(InputError);
      // Two different dry-run inputs for one method would capture to one file name.
      const twice = structuredClone(pack);
      const vote = twice.tools.find((t) => t.name === "dao_vote") as PackTool;
      twice.tools.push({ ...vote, name: "dao_vote_again", dryRun: { args: { id: 1, action: "VoteApprove", proposal: "Vote", memo: null }, depositYocto: null } });
      await expect(classifyTools(twice, HERO, { sandbox: sb, capture: { dir: captureDir() } })).rejects.toThrow(EnvironmentError);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sandboxRpc()).toBe(sb.rpcUrl);
  });
});
