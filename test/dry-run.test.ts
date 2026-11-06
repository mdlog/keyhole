/**
 * classifyTools offline (Task 10 fix round 1). No socket: every RPC reply is stubbed. The dry-run replies are the
 * five committed captures (demo/fixtures/sandbox.sputnik-v2.*dryrun*.json); the account, deploy and setup replies
 * are spike captures (demo/fixtures/sandbox/). Each sandbox handle is hand-built with a key generated in memory;
 * no key is printed.
 *
 * - Replay: the labels and the evidence strings, exactly, for the hero scope, an in-scope add_proposal and the
 *   zero-bond DAO; and the transactions the classifier signed (decoded from the request log).
 * - Sandbox only by construction: a root that is not a sandbox account, a node whose chain_id is testnet, and the
 *   `sandbox` RPC switched to another node in the middle of a run all refuse before anything is sent there.
 * - Captures are written only after the whole run succeeded.
 * - Its own sandboxes run one after another, and the `sandbox` RPC is restored after a run that throws.
 * - Evidence text from a node's JSON error is scrubbed of the RPC URL's path and query (rpcErrorTextAt).
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, decodeSignedTransaction } from "near-api-js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLABLE_EVIDENCE, classifyTools } from "../src/classify/dry-run.js";
import { TGAS } from "../src/core/amounts.js";
import { rpcUrlFor, useRpcUrl } from "../src/core/config.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import type { SandboxHandle } from "../src/core/sandbox.js";
import { SendFateUnknownError } from "../src/core/tx.js";
import type { TargetPack, ToolSchema } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { ABSENT_EVIDENCE } from "../src/render/strings.js";
import { type ReplayedRequest, REPO, SANDBOX_FIXTURES, readFixture, replayFetch } from "./helpers.js";

/** What the mocked startSandbox did, in order ("start N" / "stop N"), and a gate that holds node 1's status read. */
const own = vi.hoisted(() => ({ events: [] as string[], started: 0, gate: null as Promise<void> | null }));

// classifyTools' own sandbox: a hand-built handle that points the `sandbox` RPC at itself, as startSandbox does.
vi.mock("../src/core/sandbox.js", async () => {
  const { KeyPair: KP } = await import("near-api-js");
  const { useRpcUrl: use } = await import("../src/core/config.js");
  return {
    startSandbox: async () => {
      const n = ++own.started;
      own.events.push(`start ${n}`);
      await new Promise((r) => setTimeout(r, 5));
      const rpcUrl = `http://own-${n}.replay.invalid`;
      use("sandbox", rpcUrl);
      const handle = { rpcUrl, rootId: "sandbox", stop: async () => void own.events.push(`stop ${n}`) };
      Object.defineProperty(handle, "rootKey", { value: KP.fromRandom("ed25519"), enumerable: false });
      return handle;
    },
  };
});

const DEMO_FIXTURES = join(REPO, "demo", "fixtures");
const capture = (file: string) => readFixture(DEMO_FIXTURES, file);
const spike = (file: string) => readFixture(SANDBOX_FIXTURES, file);

const DAO_VOTE_ZERO = capture("sandbox.sputnik-v2.dryrun-act_proposal-zero.json");
const DAO_ADD_ZERO = capture("sandbox.sputnik-v2.dryrun-add_proposal-zero.json");
const DAO_ADD_DEPOSIT = capture("sandbox.sputnik-v2.dryrun-add_proposal-deposit.json");
const ZERO_BOND_VOTE_ZERO = capture("sandbox.sputnik-v2.zero-bond-dryrun-act_proposal-zero.json");
const ZERO_BOND_ADD_ZERO = capture("sandbox.sputnik-v2.zero-bond-dryrun-add_proposal-zero.json");
/** The recorded ERR_MIN_BOND panic, as the contract wrote it. */
const MIN_BOND_PANIC = "Smart contract panicked: panicked at 'ERR_MIN_BOND', src/proposals.rs:392:9";

/** status (chain_id test-chain-FSZ71), a full-access view_access_key, and the four landed setup sends: seat, cosigner, deploy + new, setup row. */
const STATUS = spike("001-0-status.json");
const ACCESS_KEY = spike("003-a-create-seat.nonce.json");
const SETUP_SENDS = ["004-a-create-seat.send_tx.json", "006-a-create-cosigner.send_tx.json", "014-b-deploy-and-new.send_tx.json", "019-c-add-proposal-0.send_tx.json"].map(spike);
const UNKNOWN_ACCOUNT = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT","info":{}},"code":-32000,"message":"Server error","data":"x"},"id":"p"}';
const statusWithChainId = (chainId: string) => JSON.stringify({ ...JSON.parse(STATUS), result: { ...JSON.parse(STATUS).result, chain_id: chainId } });

const HERO = { receiverId: "dao.sandbox", methodNames: ["act_proposal"] };
const BOTH = { receiverId: "dao.sandbox", methodNames: ["act_proposal", "add_proposal"] };
const byName = (tools: ToolSchema[]): Record<string, ToolSchema> => Object.fromEntries(tools.map((t) => [t.name, t]));
const sends = (log: ReplayedRequest[]) => log.filter((r) => r.method === "send_tx");
const signedTx = (r: ReplayedRequest) => decodeSignedTransaction(Buffer.from(r.params.signed_tx_base64, "base64")).transaction;

let pack: TargetPack;
let urls = 0;
const tmpDirs: string[] = [];

/** A hand-built sandbox handle at a fresh URL (assertChain remembers one check per URL), made the one in use. */
function handle(overrides: Partial<SandboxHandle> = {}): SandboxHandle {
  const sb = { rpcUrl: `http://dry-run-${++urls}.replay.invalid`, rootId: "sandbox", stop: async () => {}, ...overrides } as SandboxHandle;
  if (!("rootKey" in overrides)) Object.defineProperty(sb, "rootKey", { value: KeyPair.fromRandom("ed25519"), enumerable: false });
  useRpcUrl("sandbox", sb.rpcUrl);
  return sb;
}

/** The replies of one full dry-run, in order: status, view_account (no such account), keys, then the sends. */
const dryRunReplies = (dryRunSends: string[]) => ({ status: STATUS, "query:view_account": UNKNOWN_ACCOUNT, "query:view_access_key": ACCESS_KEY, send_tx: [...SETUP_SENDS, ...dryRunSends] });

beforeEach(async () => {
  pack = await loadTargetPack("sputnik-v2");
});

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("classifyTools replays the recorded Sputnik dry-runs", () => {
  it("hero scope: dao_vote callable, add_proposal not in allowlist with the recorded ERR_MIN_BOND text; 7 sends, as built", async () => {
    const log = replayFetch(dryRunReplies([DAO_VOTE_ZERO, DAO_ADD_ZERO, DAO_ADD_DEPOSIT]));
    const tools = await classifyTools(pack, HERO, { sandbox: handle() });

    expect(tools.map((t) => [t.name, t.kind, t.classification, t.evidence])).toEqual([
      ["dao_list_proposals", "view", undefined, undefined],
      ["dao_get_policy", "view", undefined, undefined],
      ["dao_vote", "call", "callable", CALLABLE_EVIDENCE],
      ["add_proposal", "call", "not in allowlist", `${ABSENT_EVIDENCE}; 0-deposit dry-run: ${MIN_BOND_PANIC}`],
    ]);

    // What was signed: root → seat-X and cosigner-X (create, fund, full-access key), root → dry-X (create, fund,
    // deploy, init), the cosigner's setup row, then the seat's three dry-run calls at 30 TGas: 0, 0, then the bond.
    const txs = sends(log).map(signedTx);
    expect(txs).toHaveLength(7);
    const x = /^seat-([0-9a-f]{4})\.sandbox$/.exec(txs[0].receiverId)?.[1];
    expect(x).toBeDefined();
    const [seat, cosigner, dry] = [`seat-${x}.sandbox`, `cosigner-${x}.sandbox`, `dry-${x}.sandbox`];
    expect(txs.map((t) => [t.signerId, t.receiverId])).toEqual([
      ["sandbox", seat],
      ["sandbox", cosigner],
      ["sandbox", dry],
      [cosigner, dry],
      [seat, dry],
      [seat, dry],
      [seat, dry],
    ]);
    expect(txs[0].actions.map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "addKey"]);
    expect(txs[2].actions.map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "deployContract", "functionCall"]);
    const init = JSON.parse(Buffer.from(txs[2].actions[3].functionCall?.args ?? []).toString("utf8"));
    expect(init.policy.roles[1].kind.Group).toEqual([seat, cosigner]);
    expect(init.policy.proposal_bond).toBe("100000000000000000000000");
    const calls = txs.slice(4).map((t) => t.actions[0].functionCall);
    expect(calls.map((c) => [c?.methodName, c?.gas, c?.deposit])).toEqual([
      ["act_proposal", 30n * TGAS, 0n],
      ["add_proposal", 30n * TGAS, 0n],
      ["add_proposal", 30n * TGAS, 10n ** 23n],
    ]);
  });

  it("add_proposal in the scope: fails-without-deposit (runtime), its evidence the 0-deposit panic text", async () => {
    replayFetch(dryRunReplies([DAO_VOTE_ZERO, DAO_ADD_ZERO, DAO_ADD_DEPOSIT]));
    const tools = byName(await classifyTools(pack, BOTH, { sandbox: handle() }));
    expect([tools.dao_vote.classification, tools.dao_vote.evidence]).toEqual(["callable", CALLABLE_EVIDENCE]);
    expect([tools.add_proposal.classification, tools.add_proposal.evidence]).toEqual(["fails-without-deposit (runtime)", MIN_BOND_PANIC]);
  });

  it("zero-bond DAO: both 0-deposit calls land, so 6 sends and no deposit call; add_proposal callable", async () => {
    const log = replayFetch(dryRunReplies([ZERO_BOND_VOTE_ZERO, ZERO_BOND_ADD_ZERO]));
    const tools = byName(await classifyTools(pack, BOTH, { sandbox: handle(), policyOverride: { proposal_bond: "0" } }));
    expect([tools.dao_vote.classification, tools.add_proposal.classification, tools.add_proposal.evidence]).toEqual(["callable", "callable", CALLABLE_EVIDENCE]);
    const txs = sends(log).map(signedTx);
    expect(txs).toHaveLength(6);
    expect(JSON.parse(Buffer.from(txs[2].actions[3].functionCall?.args ?? []).toString("utf8")).policy.proposal_bond).toBe("0");
    expect(txs.slice(4).map((t) => t.actions[0].functionCall?.deposit)).toEqual([0n, 0n]);
  });
});

describe("sandbox only, by construction", () => {
  it("a root that is not a sandbox account: InputError before any RPC", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      throw new Error("must refuse before any RPC");
    };
    await expect(classifyTools(pack, HERO, { sandbox: handle({ rootId: "alice.testnet" }) })).rejects.toThrow(InputError);
    expect(fetches).toBe(0);
  });

  it("a node whose chain_id is testnet: EnvironmentError after its status read, and nothing else is sent anywhere", async () => {
    // The node would answer everything (so a classifier that skipped the chain_id check would go on to send).
    const log = replayFetch({ ...dryRunReplies([DAO_VOTE_ZERO, DAO_ADD_ZERO, DAO_ADD_DEPOSIT]), status: statusWithChainId("testnet") });
    await expect(classifyTools(pack, HERO, { sandbox: handle() })).rejects.toThrow(EnvironmentError);
    expect(log.map((r) => r.method)).toEqual(["status"]);
  });

  it("the sandbox RPC switched to another node in the middle of a run: EnvironmentError, nothing is sent to the new node", async () => {
    const sb = handle();
    const other = `http://other-${++urls}.replay.invalid`;
    const log: Array<{ url: string; method: string }> = [];
    let sent = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const req = JSON.parse(String(init?.body));
      log.push({ url, method: req.method });
      const key = req.method === "query" ? `query:${req.params.request_type}` : req.method;
      const replies: Record<string, string> = { status: url === other ? statusWithChainId("testnet") : STATUS, "query:view_account": UNKNOWN_ACCOUNT, "query:view_access_key": ACCESS_KEY };
      let raw = replies[key];
      if (key === "send_tx") {
        raw = SETUP_SENDS[0];
        if (++sent === 1) useRpcUrl("sandbox", other); // after the first send has gone out at sb's node
      }
      if (raw === undefined) throw new Error(`no stub for ${key}`);
      return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
    };
    await expect(classifyTools(pack, HERO, { sandbox: sb })).rejects.toThrow(EnvironmentError);
    expect(log.filter((r) => r.method === "send_tx").map((r) => r.url)).toEqual([sb.rpcUrl]);
    expect(log.filter((r) => r.url === other)).toEqual([]);
  });
});

describe("capture and the sandbox RPC around a failed or overlapping run", () => {
  it("captures are written only after the whole run: a send that fails on the 2nd method leaves the dir empty, and is not re-sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keyhole-dryrun-"));
    tmpDirs.push(dir);
    // The 6th send (add_proposal, 0 deposit) gets no answer, and the `tx` lookup fails: its fate is unknown.
    const log = replayFetch(dryRunReplies([DAO_VOTE_ZERO]));
    await expect(classifyTools(pack, HERO, { sandbox: handle(), capture: { dir } })).rejects.toThrow(SendFateUnknownError);
    expect(sends(log)).toHaveLength(6);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("own sandboxes run one after another; each is stopped and the sandbox RPC is back as before, after runs that throw", async () => {
    const before = `http://before-${++urls}.replay.invalid`;
    useRpcUrl("sandbox", before);
    own.events.length = 0;
    const first = own.started + 1;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    // Every own node reports chain_id testnet, so each run throws right after its status read; node 1 holds its
    // status read until released, so a second run started meanwhile would overlap it.
    globalThis.fetch = async (input) => {
      if (String(input).includes(`own-${first}.`)) await gate;
      return new Response(statusWithChainId("testnet"), { status: 200, headers: { "content-type": "application/json" } });
    };
    const a = classifyTools(pack, HERO).then(
      () => null,
      (e: unknown) => e,
    );
    await vi.waitFor(() => expect(own.events).toContain(`start ${first}`));
    const b = classifyTools(pack, HERO).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 30)); // room for b to start a node, were it not queued
    release();
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea).toBeInstanceOf(EnvironmentError);
    expect(eb).toBeInstanceOf(EnvironmentError);
    expect(own.events).toEqual([`start ${first}`, `stop ${first}`, `start ${first + 1}`, `stop ${first + 1}`]);
    expect(rpcUrlFor("sandbox")).toBe(before);
  });
});

describe("evidence from a node's JSON error", () => {
  it("is scrubbed of the RPC URL's path and query (rpcErrorTextAt)", async () => {
    const sb = handle({ rpcUrl: `http://dry-run-${++urls}.replay.invalid/v3/tok-123?apikey=abc` });
    const refusedAtNode = JSON.stringify({
      jsonrpc: "2.0",
      error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: "gateway /v3/tok-123?apikey=abc refused the tx" },
      id: "p",
    });
    replayFetch(dryRunReplies([refusedAtNode, DAO_ADD_ZERO, DAO_ADD_DEPOSIT]));
    const vote = byName(await classifyTools(pack, HERO, { sandbox: sb })).dao_vote;
    expect(vote.classification).toBe("inconclusive");
    expect(vote.evidence).toBe("not in a block: INVALID_TRANSACTION: gateway /… refused the tx");
    expect(vote.evidence).not.toMatch(/tok-123|apikey/);
  });
});
