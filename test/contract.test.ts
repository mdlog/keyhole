/**
 * LAYOUT "## DATA CONTRACT": the 16 functions the build binds to, exported from src/index.ts under their
 * exact names; plus the rest of the surface locked in Task 1 (Global Constraints → "Interfaces locked in
 * Task 1") and the test helpers locked with it.
 *
 * Stubs: every unbuilt function calls registerStub(name) at module load and throws NotImplementedError
 * (exit 2) before any I/O. This file iterates over unbuiltNames(), so building a function never edits it:
 * the builder deletes the registerStub line and the throw, and the sample call below is then skipped.
 * The sample calls are typed against the locked signatures, so typecheck also pins the signatures.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, actions, baseEncode } from "near-api-js";
import { type TaskMeta, beforeAll, describe, expect, it } from "vitest";
import "../src/cli/main.js";
import * as keyhole from "../src/index.js";
import type { DemoRun, DemoStep, KeyRef, SandboxHandle, Session, SentTx, TargetPack, WrapPlan } from "../src/index.js";
import { NotImplementedError, unbuiltNames } from "../src/index.js";
import { CAPS, REPO, SANDBOX_FIXTURES, readFixture, replayFetch, sampleCageCard, sampleSession, tmpEnv } from "./helpers.js";
import { replayLine } from "./replay-meta.js";

/** Stubs registered once src/index.ts and src/cli/main.ts are loaded: what the Task 1 checkpoint counts. */
const REACHED: ReadonlySet<string> = new Set(unbuiltNames());

const CONTRACT = [
  "loadSession",
  "loadTargetPack",
  "planWrap",
  "signWrap",
  "classifyTools",
  "labelMethod",
  "viewScopedKey",
  "viewCodeHash",
  "buildCageCard",
  "sendAttempt",
  "parseRefusal",
  "callView",
  "proposalStatus",
  "signBurn",
  "runDemo",
  "loadDemoRunFixture",
] as const;

const s: Session = sampleSession();
const kp = KeyPair.fromRandom("ed25519"); // in memory only; never written or printed
const env = tmpEnv(); // every key-path sample call points at temp dirs, never at ~/.near-credentials
const ref: KeyRef = { network: s.network, accountId: s.accountId, publicKey: s.publicKey };
const { createdAt: _c, status: _s, burnedAt: _b, burnTxHashes: _h, ...draft } = s;
const plan: WrapPlan = { draft, txActions: [], tools: [], warnings: [], signerId: "seat.sandbox", fundingYocto: null, dryRunMs: 0 };
const sent: SentTx = { txHash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", raw: "{}", json: {} };
const sandbox: SandboxHandle = { rpcUrl: "http://replay.invalid", rootId: "sandbox", rootKey: kp, stop: async () => {} };
const step: DemoStep = { n: 1, total: 1, phase: "refusals", label: "open a payout proposal", signer: "session", pass: true };
const run: DemoRun = { id: "replay-sample", network: "sandbox", mode: "replay", steps: [step], durationMs: 0, exitCode: 0, transcriptPath: "" };
let pack: TargetPack;

/** One sample call per stub, keyed by the name it registers. */
const SAMPLE_CALLS = new Map<string, () => unknown>([
  // src/core
  ["assertChain", () => keyhole.assertChain("sandbox")],
  ["viewAccount", () => keyhole.viewAccount("sandbox", "dao.sandbox")],
  ["viewScopedKey", () => keyhole.viewScopedKey(s)],
  ["viewCodeHash", () => keyhole.viewCodeHash("sandbox", "dao.sandbox")],
  ["callView", () => keyhole.callView(s, "get_policy", {})],
  ["signAndSend", () => keyhole.signAndSend("sandbox", "seat.sandbox", kp, "dao.sandbox", [actions.transfer(1n)])],
  ["settle", () => keyhole.settle("sandbox", sent.txHash, "seat.sandbox")],
  ["mustSucceed", () => keyhole.mustSucceed("vote", sent)],
  ["successValue", () => keyhole.successValue(sent)],
  ["startSandbox", () => keyhole.startSandbox()],
  ["predictViolation", () => keyhole.predictViolation(s, { receiverId: "dao.sandbox", action: "FunctionCall", method: "add_proposal", args: {}, depositYocto: "0", gasTGas: 30 })],
  ["credentialsDir", () => keyhole.credentialsDir(env)],
  ["loadFullAccessKey", () => keyhole.loadFullAccessKey("sandbox", "seat.sandbox", env)],
  ["fullAccessKeyLoadCount", () => keyhole.fullAccessKeyLoadCount()],
  ["saveSessionKey", () => keyhole.saveSessionKey(ref, kp, env)],
  ["readSessionKey", () => keyhole.readSessionKey(ref, env)],
  ["deleteSessionKey", () => keyhole.deleteSessionKey(ref, env)],
  ["saveAccountKey", () => keyhole.saveAccountKey("sandbox", "seat.sandbox", kp, env)],
  ["planWrap", () => keyhole.planWrap({ contract: "dao.sandbox", allow: ["act_proposal"], allowanceYocto: "50000000000000000000000", network: "sandbox" }, { sandbox })],
  ["signWrap", () => keyhole.signWrap(plan, { persist: false, signerKey: kp, env })],
  ["sessionFromPlan", () => keyhole.sessionFromPlan(plan)],
  ["signBurn", () => keyhole.signBurn(s, { persist: false, signerKey: kp, env })],
  ["buildCageCard", () => keyhole.buildCageCard(s, "chain")],
  // src/classify, src/packs
  ["classifyTools", () => keyhole.classifyTools(pack, { receiverId: "dao.sandbox", methodNames: ["act_proposal"] }, { sandbox })],
  ["proposalStatus", () => keyhole.proposalStatus(s, 0)],
  ["actProposalArgs", () => keyhole.actProposalArgs(s, { id: 0, action: "approve" })],
  ["requiredApprovals", () => keyhole.requiredApprovals({})],
  ["packHooks", () => keyhole.packHooks("sputnik-v2")],
  ["councilInitArgs", () => keyhole.councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox")],
  ["deployDaoSandbox", () => keyhole.deployDaoSandbox(sandbox, { daoId: "dao.sandbox", seat: "seat.sandbox", cosigner: "cosigner.sandbox" })],
  ["addProposal", () => keyhole.addProposal("sandbox", "seat.sandbox", kp, "dao.sandbox", { description: "x", kind: "Vote" }, 10n ** 23n)],
  ["readContractAbi", () => keyhole.readContractAbi("sandbox", "counter.sandbox")],
  ["toolsFromAbi", () => keyhole.toolsFromAbi({}, "counter_")],
  // src/demo
  ["runDemo", () => keyhole.runDemo({ network: "sandbox", env }).next()],
  ["writeRunArtifacts", () => keyhole.writeRunArtifacts(run, { fixturesDir: join(env.KEYHOLE_HOME, "fixtures"), runJsonPath: join(env.KEYHOLE_HOME, "run.json") })],
  ["ensureTestnetDemo", () => keyhole.ensureTestnetDemo(env)],
  ["factoryCreateArgs", () => keyhole.factoryCreateArgs(pack, "kh-1a2b", "seat.kh-op.testnet", "cosigner.kh-op.testnet")],
  // src/render
  ["termCaps", () => keyhole.termCaps({ isTTY: false }, {})],
  ["renderTxLine", () => keyhole.renderTxLine(sent.txHash, "sandbox", CAPS.plain100)],
  ["renderRuleStrip", () => keyhole.renderRuleStrip("method", CAPS.plain100)],
  ["renderRawJsonBlock", () => keyhole.renderRawJsonBlock("{}", CAPS.plain100, { highlight: "MethodNameMismatch" })],
  ["renderRefusalBlock", () => keyhole.renderRefusalBlock(step, CAPS.plain100, "beat")],
  ["renderCageCard", () => keyhole.renderCageCard(sampleCageCard(), "full", CAPS.plain100)],
  ["createStepPrinter", () => keyhole.createStepPrinter({ caps: CAPS.plain100, style: "full", network: "sandbox", mode: "replay" })],
  ["renderTranscript", () => keyhole.renderTranscript(run, { rpc: "http://127.0.0.1:1", operator: "op.testnet", startedAt: "2026-11-11T09:00:00Z" })],
  // src/cli (reached through src/cli/main.ts, not src/index.ts)
  ["buildMcpServer", async () => (await import("../src/cli/serve.js")).buildMcpServer(s)],
]);

beforeAll(async () => {
  pack = await keyhole.loadTargetPack("sputnik-v2");
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

describe("DATA CONTRACT", () => {
  it("exports the 16 functions by name", () => {
    const exported = keyhole as unknown as Record<string, unknown>;
    expect(CONTRACT).toHaveLength(16);
    for (const name of CONTRACT) expect(typeof exported[name], name).toBe("function");
  });

  it("src/index.ts and src/cli/main.ts reach every stub module, so the unbuiltNames() gate counts them all", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of walk(join(REPO, "src"))) {
      // The CLI entry runs main() on import; main.ts is its side-effect-free twin, loaded above.
      if (!file.endsWith(".ts") || file === join(REPO, "src", "cli", "index.ts")) continue;
      const mod = await import(relative(here, file).split(sep).join("/"));
      // One registry: the module loaded here is the one src/index.ts loaded (not a second copy).
      if (file === join(REPO, "src", "core", "errors.ts")) expect(mod.unbuiltNames).toBe(unbuiltNames);
    }
    expect([...unbuiltNames()].filter((n) => !REACHED.has(n))).toEqual([]);
  });

  it("every unbuilt CONTRACT function throws NotImplementedError (exit 2) before any I/O", async () => {
    expect([...unbuiltNames()].filter((n) => !SAMPLE_CALLS.has(n))).toEqual([]); // a stub with no sample call fails
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      throw new Error("a stub reached for the network");
    };
    for (const [name, call] of SAMPLE_CALLS) {
      if (!unbuiltNames().has(name)) continue; // built: its own task's tests cover it
      const err = await Promise.resolve()
        .then(call) // sync stubs throw too
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err, name).toBeInstanceOf(NotImplementedError);
      expect((err as NotImplementedError).what, name).toBe(name);
      expect((err as NotImplementedError).exitCode, name).toBe(2);
    }
    expect(fetches).toBe(0);
    expect(existsSync(join(env.KEYHOLE_HOME, "sessions")) || existsSync(join(env.KEYHOLE_HOME, "fixtures"))).toBe(false);
    expect(readdirSync(env.KEYHOLE_CREDENTIALS_DIR)).toEqual([]);
  });

  it("unbuiltNames() is a snapshot: changing it does not change the registry", () => {
    const names = unbuiltNames();
    expect(names).not.toBe(unbuiltNames());
    expect([...names]).toEqual([...unbuiltNames()]);
    (names as Set<string>).add("not-a-stub");
    expect(unbuiltNames().has("not-a-stub")).toBe(false);
  });
});

describe("values locked in Task 1", () => {
  it("NO_CODE_HASH is base58 of 32 zero bytes: view_account's code_hash for an account with no contract", () => {
    expect(keyhole.NO_CODE_HASH).toBe(baseEncode(new Uint8Array(32)));
    // The spike's grantee is a plain account (no contract deployed); recorded view_account body.
    expect(JSON.parse(readFixture(SANDBOX_FIXTURES, "030-e-grantee-balance-before.json")).result.code_hash).toBe(keyhole.NO_CODE_HASH);
  });
});

describe("test helpers locked in Task 1", () => {
  it("replayFetch answers by method or query:REQUEST_TYPE, arrays in order, and returns the request log", async () => {
    const log = replayFetch({ block: '{"b":1}', "query:view_access_key": ['{"k":1}', '{"k":2}'] });
    const post = (method: string, params: unknown) =>
      fetch("http://replay.invalid", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params }) }).then((r) => r.text());
    expect(await post("query", { request_type: "view_access_key" })).toBe('{"k":1}');
    expect(await post("block", { finality: "final" })).toBe('{"b":1}');
    expect(await post("query", { request_type: "view_access_key" })).toBe('{"k":2}');
    await expect(post("query", { request_type: "view_access_key" })).rejects.toThrow(/query:view_access_key/);
    await expect(post("send_tx", {})).rejects.toThrow(/no fixture for send_tx/);
    expect(log.map((r) => r.method)).toEqual(["query", "block", "query", "query", "send_tx"]);
    expect(log[1]).toEqual({ url: "http://replay.invalid", method: "block", params: { finality: "final" } });
  });

  it("tmpEnv: fresh KEYHOLE_HOME and KEYHOLE_CREDENTIALS_DIR temp dirs, never the real ones", () => {
    const a = tmpEnv();
    const b = tmpEnv();
    expect(Object.keys(a).sort()).toEqual(["KEYHOLE_CREDENTIALS_DIR", "KEYHOLE_HOME"]);
    for (const dir of [a.KEYHOLE_HOME, a.KEYHOLE_CREDENTIALS_DIR]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    }
    expect(a.KEYHOLE_HOME).not.toBe(a.KEYHOLE_CREDENTIALS_DIR);
    expect(b.KEYHOLE_HOME).not.toBe(a.KEYHOLE_HOME);
  });

  it("CAPS: plain100, plain80, color100", () => {
    expect(CAPS).toEqual({
      plain100: { color: false, unicode: false, width: 100, tty: false },
      plain80: { color: false, unicode: false, width: 80, tty: false },
      color100: { color: true, unicode: true, width: 100, tty: true },
    });
  });

  it("sampleCageCard: the hero card, read from chain, with the sputnik pack's exposure and the hero DAO's quorum", () => {
    const card = sampleCageCard();
    const packJson = JSON.parse(readFileSync(join(REPO, "src", "packs", "sputnik-v2.pack.json"), "utf8"));
    expect(card).toMatchObject({
      source: "chain",
      readAt: "2026-11-11T09:14:07Z",
      codeHashNow: card.session.codeHashPin,
      exposure: { label: packJson.exposure.label, value: `${packJson.exposure.value}; quorum 2-of-2` },
      session: { id: "ks-7f3a", network: "testnet", accountId: "seat.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet", allowanceYocto: "50000000000000000000000" },
      key: { publicKey: card.session.publicKey, accountId: "seat.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet", methodNames: ["act_proposal"], allowanceRemainingYocto: "41200000000000000000000", nonce: 3 },
    });
    expect(card.exposure).toEqual({ label: "VOTE", value: "any proposal here, either way, until burn; quorum 2-of-2" });
    expect(card.tools.map((t) => [t.name, t.kind, t.method, t.classification])).toEqual([
      ["dao_list_proposals", "view", "get_proposals", undefined],
      ["dao_get_policy", "view", "get_policy", undefined],
      ["dao_vote", "call", "act_proposal", "callable"],
      ["add_proposal", "call", "add_proposal", "not in allowlist"],
    ]);
    expect(card.tools.some((t) => "dryRun" in t)).toBe(false);
    expect(sampleCageCard({ key: null, source: "preview" })).toMatchObject({ key: null, source: "preview", readAt: "2026-11-11T09:14:07Z" });
  });

  it("replayLine records the R7 line on a task's meta", () => {
    // A stand-in task: this test's own meta must stay empty, or the R7 reporter would print it.
    const task: { meta: TaskMeta } = { meta: {} };
    replayLine(task, "key hygiene", "secret scan: 0 keys in repo");
    expect(task.meta.replay).toEqual({ suite: "key hygiene", line: "secret scan: 0 keys in repo", files: [] });
    replayLine(task, "protocol refusals", "REPLAY [sandbox] sputnik-v2.refuse-method", ["sandbox.sputnik-v2.refuse-method.json"]);
    expect(task.meta.replay).toEqual({ suite: "protocol refusals", line: "REPLAY [sandbox] sputnik-v2.refuse-method", files: ["sandbox.sputnik-v2.refuse-method.json"] });
  });
});
