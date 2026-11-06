/**
 * Task 9: the Sputnik pack code, offline. View replies are the spike's recorded get_proposal / get_policy
 * bodies (demo/fixtures/sandbox); sends replay the recorded status, view_access_key and send_tx bodies, and
 * the signed transaction is decoded from the request log. Signing keys are generated in memory per test and
 * never printed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, baseEncode, decodeSignedTransaction } from "near-api-js";
import { beforeEach, describe, expect, it } from "vitest";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { useRpcUrl } from "../src/core/config.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import type { SandboxHandle } from "../src/core/sandbox.js";
import type { SandboxFixture, TargetPack, ToolSchema } from "../src/core/types.js";
import { packHooks } from "../src/packs/hooks.js";
import { loadTargetPack, packProblems } from "../src/packs/index.js";
import { addProposal, councilInitArgs, deployDaoSandbox, pinnedWasm } from "../src/packs/sputnik-setup.js";
import { actProposalArgs, proposalLine, proposalStatus, requiredApprovals } from "../src/packs/sputnik-v2.js";
import { NEGATIVE_CONTROL_FIXTURES, REPO, SANDBOX_FIXTURES, type ReplayedRequest, readFixture, replayFetch, sampleSession } from "./helpers.js";

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
const STATUS = fx("001-0-status.json");
const POLICY = fx("017-b-get-policy.json");
/** Proposal #0 (Transfer 1 NEAR to grantee) after the seat's FC vote: InProgress, council [1, 0, 0]. */
const P0_AFTER_FC_VOTE = fx("028-e-get-proposal-0-after-fc-vote.json");
/** Proposal #0 after the cosigner's vote: Approved, council [2, 0, 0]. */
const P0_AFTER_COSIGNER = fx("034-e-get-proposal-0-after-cosigner.json");
/** Proposal #2 (kind "Vote") before any vote: vote_counts is {}. */
const P2_BEFORE = fx("044-f2-get-proposal-2-before.json");
/** TIMEOUT_ERROR as near-sandbox 2.14.0 sends it for a tx it has not seen final. */
const TIMEOUT =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"cause":"NOT_OBSERVED"},"name":"TIMEOUT_ERROR"},"code":-32000,"message":"Server error","data":"Timeout"},"id":"p"}';

/** The JSON a recorded call_function reply carries in its result bytes. */
const viewed = (raw: string): any => JSON.parse(Buffer.from(JSON.parse(raw).result.result).toString("utf8"));
/** A call_function reply carrying `value` as its result bytes, shaped like the recorded ones. */
const viewBody = (value: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: "x", result: { block_hash: "x", block_height: 1, logs: [], result: [...Buffer.from(JSON.stringify(value))] } });
/** The method_name and decoded args of a logged call_function request. */
const viewCall = (r: ReplayedRequest) => ({ method: r.params.method_name, args: JSON.parse(Buffer.from(r.params.args_base64, "base64").toString("utf8")) });
const signedTx = (r: ReplayedRequest) => decodeSignedTransaction(Buffer.from(r.params.signed_tx_base64, "base64")).transaction;

const storedKind = viewed(P0_AFTER_FC_VOTE).kind;
const s = sampleSession(); // seat.sandbox on dao.sandbox
let pack: TargetPack;
let daoVote: ToolSchema;
let listProposals: ToolSchema;
let inc: ToolSchema;
let urls = 0;

beforeEach(async () => {
  pack = await loadTargetPack("sputnik-v2");
  daoVote = pack.tools.find((t) => t.name === "dao_vote") as ToolSchema;
  listProposals = pack.tools.find((t) => t.name === "dao_list_proposals") as ToolSchema;
  inc = (await loadTargetPack("counter")).tools.find((t) => t.name === "counter_increment") as ToolSchema;
  useRpcUrl("sandbox", `http://sputnik-${++urls}.replay.invalid`); // assertChain remembers a check per URL: one status read per test
});

/** A policy whose council Group has `size` members, with the given default threshold and quorum (RoleWeight). */
function policyWith(size: number, threshold: unknown, quorum: string, councilVotePolicy: Record<string, unknown> = {}, weightKind = "RoleWeight") {
  return {
    roles: [
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
      { name: "council", kind: { Group: Array.from({ length: size }, (_, i) => `m${i}.sandbox`) }, permissions: ["*:VoteApprove"], vote_policy: councilVotePolicy },
    ],
    default_vote_policy: { weight_kind: weightKind, quorum, threshold },
  };
}

/** Counts fetches, and fails any: for the checks that must refuse before any RPC. */
function noFetch(): { count: number } {
  const seen = { count: 0 };
  globalThis.fetch = async () => {
    seen.count++;
    throw new Error("this check must refuse before any RPC");
  };
  return seen;
}

describe("proposalStatus (replayed views)", () => {
  it("reads get_proposal then get_policy: #0 InProgress, 1 of 2", async () => {
    const log = replayFetch({ "query:call_function": [P0_AFTER_FC_VOTE, POLICY] });
    expect(await proposalStatus(sampleSession(), 0)).toEqual({ status: "InProgress", approvals: 1, required: 2 });
    expect(log.map(viewCall)).toEqual([
      { method: "get_proposal", args: { id: 0 } },
      { method: "get_policy", args: {} },
    ]);
    for (const r of log) expect(r.params).toMatchObject({ request_type: "call_function", finality: "final", account_id: "dao.sandbox" });
  });

  it("#0 after the cosigner: Approved, 2 of 2", async () => {
    replayFetch({ "query:call_function": [P0_AFTER_COSIGNER, POLICY] });
    expect(await proposalStatus(s, 0)).toEqual({ status: "Approved", approvals: 2, required: 2 });
  });

  it("a proposal no one voted on (vote_counts {}) has 0 approvals", async () => {
    replayFetch({ "query:call_function": [P2_BEFORE, POLICY] });
    expect(await proposalStatus(s, 2)).toEqual({ status: "InProgress", approvals: 0, required: 2 });
  });

  it("vote counts sent as U128 strings (sputnikdao2 2.3.x) are read too", async () => {
    const p = viewed(P0_AFTER_FC_VOTE);
    replayFetch({ "query:call_function": [viewBody({ ...p, vote_counts: { council: ["1", "0", "0"] } }), POLICY] });
    expect(await proposalStatus(s, 0)).toEqual({ status: "InProgress", approvals: 1, required: 2 });
  });

  it("refuses a proposal reply for another id, and a bad id before any RPC", async () => {
    replayFetch({ "query:call_function": [P2_BEFORE, POLICY] });
    await expect(proposalStatus(s, 0)).rejects.toThrow(EnvironmentError);
    const seen = noFetch();
    for (const id of [-1, 1.5, Number.NaN]) await expect(proposalStatus(s, id)).rejects.toThrow(InputError);
    expect(seen.count).toBe(0);
  });

  it("refuses council vote counts that are not [approve, reject, remove]", async () => {
    const p = viewed(P0_AFTER_FC_VOTE);
    for (const council of [[1, 0], [1, 0, 0, 0], "1", [-1, 0, 0]]) {
      replayFetch({ "query:call_function": [viewBody({ ...p, vote_counts: { council } }), POLICY] });
      await expect(proposalStatus(s, 0), JSON.stringify(council)).rejects.toThrow(EnvironmentError);
    }
  });
});

describe("requiredApprovals: RoleWeight threshold = max(quorum, min(num × size / den + 1, size))", () => {
  it("the brief's cases", () => {
    expect(requiredApprovals(policyWith(2, [1, 2], "0"))).toBe(2);
    expect(requiredApprovals(policyWith(3, [1, 2], "0"))).toBe(2);
    expect(requiredApprovals(policyWith(1, [1, 2], "0"))).toBe(1);
  });

  it("the recorded get_policy of the spike's DAO: 2 of 2", () => {
    expect(requiredApprovals(viewed(POLICY))).toBe(2);
  });

  it("quorum wins when it is higher; a Weight threshold is capped at the group size", () => {
    expect(requiredApprovals(policyWith(3, [1, 2], "3"))).toBe(3);
    expect(requiredApprovals(policyWith(5, [2, 3], "0"))).toBe(4); // 2 × 5 / 3 = 3 (floor), + 1
    expect(requiredApprovals(policyWith(4, "1", "0"))).toBe(1);
    expect(requiredApprovals(policyWith(2, "5", "0"))).toBe(2);
  });

  it("a per-kind vote policy of the council role applies to that kind only (sputnikdao2 policy labels)", () => {
    const one = { weight_kind: "RoleWeight", quorum: "0", threshold: "1" };
    const policy = policyWith(4, [1, 2], "0", { transfer: one, call: one, policy: one, add_member_to_role: one, set_vote_token: one });
    expect(requiredApprovals(policy)).toBe(3); // default: min(4 / 2 + 1, 4)
    expect(requiredApprovals(policy, "Vote")).toBe(3); // "vote": no entry
    expect(requiredApprovals(policy, storedKind)).toBe(1); // { Transfer: … } → "transfer"
    expect(requiredApprovals(policy, { FunctionCall: { receiver_id: "x.sandbox", actions: [] } })).toBe(1); // → "call"
    expect(requiredApprovals(policy, { ChangePolicy: { policy: {} } })).toBe(1); // → "policy" ("Change" dropped)
    expect(requiredApprovals(policy, { AddMemberToRole: { member_id: "x.sandbox", role: "council" } })).toBe(1); // → "add_member_to_role" (snake_case)
    expect(requiredApprovals(policy, { SetStakingContract: { staking_id: "x.sandbox" } })).toBe(1); // → "set_vote_token"
    expect(requiredApprovals(policy, { RemoveMemberFromRole: { member_id: "x.sandbox", role: "council" } })).toBe(3); // no entry
  });

  it("refuses what it cannot count: token weight, no council Group, no policy", () => {
    expect(() => requiredApprovals(policyWith(2, [1, 2], "0", {}, "TokenWeight"))).toThrow(EnvironmentError);
    expect(() => requiredApprovals({ ...policyWith(2, [1, 2], "0"), roles: [{ name: "all", kind: "Everyone", permissions: [], vote_policy: {} }] })).toThrow(/no council role/);
    expect(() => requiredApprovals({ ...policyWith(2, [1, 2], "0"), roles: [{ name: "council", kind: "Everyone", permissions: [], vote_policy: {} }] })).toThrow(EnvironmentError);
    expect(() => requiredApprovals(policyWith(2, [1, 0], "0"))).toThrow(EnvironmentError);
    expect(() => requiredApprovals({})).toThrow(EnvironmentError);
    expect(() => requiredApprovals(null)).toThrow(EnvironmentError);
  });
});

describe("actProposalArgs: always the 4-arg form {id, action, proposal: stored kind, memo}", () => {
  it("approve → VoteApprove with the stored kind, read with get_proposal", async () => {
    const log = replayFetch({ "query:call_function": P0_AFTER_FC_VOTE });
    const args = await actProposalArgs(s, { id: 0, action: "approve", memo: "m" });
    expect(args).toEqual({ id: 0, action: "VoteApprove", proposal: storedKind, memo: "m" });
    expect(Object.keys(args)).toEqual(["id", "action", "proposal", "memo"]);
    expect(storedKind).toEqual({ Transfer: { token_id: "", receiver_id: "grantee.sandbox", amount: "1000000000000000000000000", msg: null } });
    expect(log.map(viewCall)).toEqual([{ method: "get_proposal", args: { id: 0 } }]);
  });

  it("reject → VoteReject; with no memo the memo key is still sent (null)", async () => {
    replayFetch({ "query:call_function": P0_AFTER_FC_VOTE });
    const args = await actProposalArgs(s, { id: 0, action: "reject" });
    expect(args.action).toBe("VoteReject");
    expect(args).toEqual({ id: 0, action: "VoteReject", proposal: storedKind, memo: null });
  });

  it("a Vote-kind proposal gives dao_vote's dry-run shape (the shape serve sends)", async () => {
    replayFetch({ "query:call_function": P2_BEFORE });
    const dry = daoVote as ToolSchema & { dryRun?: { args: Record<string, unknown> } };
    expect(await actProposalArgs(s, { id: 2, action: "approve", memo: "keyhole dry-run" })).toEqual({ ...dry.dryRun?.args, id: 2 });
  });

  it("refuses a bad vote before any RPC", async () => {
    const seen = noFetch();
    for (const vote of [{ id: -1, action: "approve" }, { id: 0.5, action: "approve" }, { id: 0, action: "VoteApprove" }, { id: 0, action: "approve", memo: 7 }]) {
      await expect(actProposalArgs(s, vote as never)).rejects.toThrow(InputError);
    }
    expect(seen.count).toBe(0);
  });
});

describe("packHooks", () => {
  it("sputnik-v2 dao_vote: callArgs is actProposalArgs, afterCall reports the proposal", async () => {
    const h = packHooks("sputnik-v2");
    replayFetch({ "query:call_function": P0_AFTER_FC_VOTE });
    expect(await h.callArgs(s, daoVote, { id: 0, action: "approve", memo: "m" })).toEqual(await actProposalArgs(s, { id: 0, action: "approve", memo: "m" }));
    replayFetch({ "query:call_function": [P0_AFTER_FC_VOTE, POLICY] });
    const after = await h.afterCall(s, daoVote, { id: 0, action: "approve" });
    expect(after?.text).toBe("proposal #0 InProgress (1 of 2 approvals)");
    expect(after).toEqual({ text: "proposal #0 InProgress (1 of 2 approvals)", structured: { id: 0, status: "InProgress", approvals: 1, required: 2 } });
    replayFetch({ "query:call_function": [P0_AFTER_COSIGNER, POLICY] });
    expect((await h.afterCall(s, daoVote, { id: 0, action: "approve" }))?.text).toBe("proposal #0 Approved (2 of 2 approvals)");
  });

  it("sputnik-v2 views pass their input through and report nothing extra, with no RPC", async () => {
    const seen = noFetch();
    const h = packHooks("sputnik-v2");
    expect(await h.callArgs(s, listProposals, { from_index: 0, limit: 10 })).toEqual({ from_index: 0, limit: 10 });
    expect(await h.afterCall(s, listProposals, { from_index: 0, limit: 10 })).toBeNull();
    expect(seen.count).toBe(0);
  });

  it("sputnik-v2 dao_vote refuses input outside its schema before any RPC", async () => {
    const seen = noFetch();
    const h = packHooks("sputnik-v2");
    for (const input of [{ action: "approve" }, { id: "0", action: "approve" }, { id: 0, action: "yes" }, { id: 0, action: "approve", memo: {} }, { id: 0, action: "approve", deposit: "1" }]) {
      await expect(h.callArgs(s, daoVote, input)).rejects.toThrow(InputError);
      await expect(h.afterCall(s, daoVote, input)).rejects.toThrow(InputError);
    }
    expect(seen.count).toBe(0);
  });

  it("a pack without hooks (counter, or any other id) passes the input through and reports nothing", async () => {
    const seen = noFetch();
    expect(await packHooks("counter").callArgs(s, inc, { a: 1 })).toEqual({ a: 1 });
    expect(await packHooks("counter").afterCall(s, inc, {})).toBeNull();
    for (const id of ["near-abi-x", "constructor", "__proto__"]) {
      expect(await packHooks(id).callArgs(s, inc, { a: 1 })).toEqual({ a: 1 });
      expect(await packHooks(id).afterCall(s, inc, {})).toBeNull();
    }
    expect(seen.count).toBe(0);
  });

  it("proposalLine is the dao_vote result line", () => {
    expect(proposalLine(3, { status: "Rejected", approvals: 0, required: 2 })).toBe("proposal #3 Rejected (0 of 2 approvals)");
  });
});

describe("councilInitArgs", () => {
  it("fills {seat} and {cosigner} into the council Group", () => {
    expect(councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox").policy).toMatchObject({ roles: [{}, { kind: { Group: ["seat.sandbox", "cosigner.sandbox"] } }] });
  });

  it("replaces the placeholders everywhere, inside strings too, and leaves the pack untouched", () => {
    const before = JSON.stringify(pack);
    const fixture = pack.sandboxFixture as SandboxFixture;
    const withText: TargetPack = { ...pack, sandboxFixture: { ...fixture, init: { ...fixture.init, args: { ...fixture.init.args, config: { name: "d", purpose: "{seat} and {cosigner} vote", metadata: "" } } } } };
    const args = councilInitArgs(withText, "seat.sandbox", "cosigner.sandbox");
    expect(args.config).toEqual({ name: "d", purpose: "seat.sandbox and cosigner.sandbox vote", metadata: "" });
    expect(JSON.stringify(councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox"))).not.toMatch(/\{seat\}|\{cosigner\}/);
    expect(JSON.stringify(pack)).toBe(before);
  });

  it("an id that spells a placeholder is not filled twice", () => {
    const args = councilInitArgs(pack, "{cosigner}.sandbox", "cosigner.sandbox") as any;
    expect(args.policy.roles[1].kind.Group).toEqual(["{cosigner}.sandbox", "cosigner.sandbox"]);
  });

  it("shallow-merges policyOverride into the policy", () => {
    const base = councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox") as any;
    const zeroBond = councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox", { proposal_bond: "0" }) as any;
    expect(zeroBond.policy).toEqual({ ...base.policy, proposal_bond: "0" });
    expect(zeroBond.config).toEqual(base.config);
    const replaced = councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox", { roles: [] }) as any;
    expect(replaced.policy.roles).toEqual([]); // shallow: a key is replaced, not merged
    expect(replaced.policy.default_vote_policy).toEqual(base.policy.default_vote_policy);
  });

  it("refuses a pack with no sandbox fixture", async () => {
    // Task 11 gave the counter a sandboxFixture, so the fixture-less pack is the counter with it taken away.
    const counter = { ...(await loadTargetPack("counter")), sandboxFixture: null };
    expect(() => councilInitArgs(counter, "seat.sandbox", "cosigner.sandbox")).toThrow(EnvironmentError);
  });
});

describe("sputnik-v2.pack.json (Task 9 additions)", () => {
  it("sandboxFixture.setup adds the proposal the act_proposal {id: 0} dry-run finds", () => {
    expect(pack.sandboxFixture?.setup).toEqual([
      { signer: "cosigner", method: "add_proposal", args: { proposal: { description: "keyhole dry-run setup", kind: "Vote" } }, depositYocto: "100000000000000000000000" },
    ]);
  });

  it("dao_vote's dry-run sends the 4-arg form", () => {
    expect((daoVote as { dryRun?: unknown }).dryRun).toEqual({ args: { id: 0, action: "VoteApprove", proposal: "Vote", memo: "keyhole dry-run" }, depositYocto: null });
  });

  it("is still well-formed", () => {
    expect(packProblems(JSON.parse(readFileSync(join(REPO, "src", "packs", "sputnik-v2.pack.json"), "utf8")), "sputnik-v2")).toEqual([]);
  });
});

describe("pinnedWasm", () => {
  it("reads the vendored wasm and checks it against the pack's sha256 and code hash", async () => {
    const fixture = pack.sandboxFixture as SandboxFixture;
    const wasm = await pinnedWasm(fixture);
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(fixture.sha256);
    expect(baseEncode(createHash("sha256").update(wasm).digest())).toBe(fixture.codeHash);
  });

  it("refuses bytes that are not the pinned ones", async () => {
    const fixture = pack.sandboxFixture as SandboxFixture;
    await expect(pinnedWasm({ ...fixture, sha256: "0".repeat(64) })).rejects.toThrow(/sha256/);
    await expect(pinnedWasm({ ...fixture, codeHash: "11111111111111111111111111111111" })).rejects.toThrow(EnvironmentError);
  });
});

describe("deployDaoSandbox (replayed RPC)", () => {
  const handle = (rpcUrl: string): SandboxHandle => ({ rpcUrl, rootId: "sandbox", rootKey: KeyPair.fromRandom("ed25519"), stop: async () => {} });

  it("one tx from the root: createAccount, transfer 15 NEAR, deploy the pinned wasm, new(council args) at 100 TGas", async () => {
    const url = `http://sputnik-deploy-${urls}.replay.invalid`;
    useRpcUrl("sandbox", url);
    const sb = handle(url);
    const log = replayFetch({ status: STATUS, "query:view_access_key": fx("013-b-deploy-and-new.nonce.json"), send_tx: fx("014-b-deploy-and-new.send_tx.json") });
    const sent = await deployDaoSandbox(sb, { daoId: "dao.sandbox", seat: "seat.sandbox", cosigner: "cosigner.sandbox" }, { proposal_bond: "0" });
    expect(log.map((r) => r.method)).toEqual(["status", "query", "send_tx"]);
    expect(log.every((r) => r.url === url)).toBe(true);
    const tx = signedTx(log[2]);
    expect(tx.signerId).toBe("sandbox");
    expect(tx.publicKey.toString()).toBe(sb.rootKey.getPublicKey().toString());
    expect(tx.receiverId).toBe("dao.sandbox");
    expect(tx.actions.map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "deployContract", "functionCall"]);
    expect(tx.actions[1].transfer?.deposit).toBe(15n * NEAR);
    const code = Buffer.from(tx.actions[2].deployContract?.code ?? []);
    expect(createHash("sha256").update(code).digest("hex")).toBe(pack.sandboxFixture?.sha256);
    const fc = tx.actions[3].functionCall;
    expect(fc?.methodName).toBe("new");
    expect(fc?.gas).toBe(100n * TGAS);
    expect(fc?.deposit).toBe(0n);
    expect(JSON.parse(Buffer.from(fc?.args ?? []).toString("utf8"))).toEqual(councilInitArgs(pack, "seat.sandbox", "cosigner.sandbox", { proposal_bond: "0" }));
    expect(sent.raw).toBe(fx("014-b-deploy-and-new.send_tx.json"));
  });

  it("a deploy that fails in a block is an EnvironmentError, not a result", async () => {
    const url = `http://sputnik-deploy-fail-${urls}.replay.invalid`;
    useRpcUrl("sandbox", url);
    replayFetch({ status: STATUS, "query:view_access_key": fx("013-b-deploy-and-new.nonce.json"), send_tx: readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json") });
    await expect(deployDaoSandbox(handle(url), { daoId: "dao.sandbox", seat: "seat.sandbox", cosigner: "cosigner.sandbox" })).rejects.toThrow(/failed in a block/);
  });

  it("refuses, before any RPC, a DAO id the root cannot create and a handle that is not the sandbox in use", async () => {
    const url = `http://sputnik-deploy-guard-${urls}.replay.invalid`;
    useRpcUrl("sandbox", url);
    const seen = noFetch();
    const ids = { seat: "seat.sandbox", cosigner: "cosigner.sandbox" };
    for (const daoId of ["dao.other.sandbox", "dao.testnet", "sandbox"]) await expect(deployDaoSandbox(handle(url), { ...ids, daoId })).rejects.toThrow(InputError);
    await expect(deployDaoSandbox(handle("http://another-node.replay.invalid"), { ...ids, daoId: "dao.sandbox" })).rejects.toThrow(EnvironmentError);
    expect(seen.count).toBe(0);
  });

  it("is sandbox-only by construction: a non-sandbox root or DAO is refused before any RPC, even when its URL is the one in use", async () => {
    // KEYHOLE_SANDBOX_RPC pointed at a testnet RPC, and a hand-built handle that matches it.
    const url = "https://rpc.testnet.example.invalid";
    useRpcUrl("sandbox", url);
    const seen = noFetch();
    const testnetRoot: SandboxHandle = { ...handle(url), rootId: "op.testnet" };
    const cases: Array<[SandboxHandle, string]> = [
      [testnetRoot, "dao.op.testnet"],
      [testnetRoot, "dao.sandbox"],
      [handle(url), "dao.testnet"],
      [{ ...handle(url), rootId: "near" }, "dao.near"],
    ];
    for (const [sb, daoId] of cases) {
      const err = await deployDaoSandbox(sb, { daoId, seat: "seat.op.testnet", cosigner: "cosigner.op.testnet" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, `${sb.rootId} → ${daoId}`).toBeInstanceOf(InputError);
      expect((err as InputError).message).toMatch(/sandbox/);
    }
    expect(seen.count).toBe(0);
  });

  it("re-checks the sandbox in use right before signing: an override switched while the deploy is prepared refuses, nothing sent", async () => {
    const url = `http://sputnik-deploy-race-${urls}.replay.invalid`;
    useRpcUrl("sandbox", url);
    const seen = noFetch();
    const deploying = deployDaoSandbox(handle(url), { daoId: "dao.sandbox", seat: "seat.sandbox", cosigner: "cosigner.sandbox" });
    // The first check ran synchronously, before the first await; the pack and the wasm are still being read.
    useRpcUrl("sandbox", `http://another-sandbox-${urls}.replay.invalid`);
    const err = await deploying.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(/changed to .* while the deploy .* was prepared/);
    expect(seen.count).toBe(0);
  });
});

describe("addProposal (replayed RPC)", () => {
  const P0 = { description: "Grant payout", kind: { Transfer: { token_id: "", receiver_id: "grantee.sandbox", amount: "1000000000000000000000000" } } };
  const P1 = { description: "Poll", kind: "Vote" };

  it("attaches the bond at 100 TGas; the ids are the contract's SuccessValue: 0 then 1", async () => {
    const cosignerKey = KeyPair.fromRandom("ed25519");
    const log = replayFetch({
      status: STATUS,
      "query:view_access_key": [fx("018-c-add-proposal-0.nonce.json"), fx("020-c-add-proposal-1.nonce.json")],
      send_tx: [fx("019-c-add-proposal-0.send_tx.json"), fx("021-c-add-proposal-1.send_tx.json")],
    });
    const bond = 10n ** 23n;
    const a = await addProposal("sandbox", "cosigner.sandbox", cosignerKey, "dao.sandbox", P0, bond);
    const b = await addProposal("sandbox", "cosigner.sandbox", cosignerKey, "dao.sandbox", P1, bond);
    expect([a.id, b.id]).toEqual([0, 1]);
    expect(a.sent.raw).toBe(fx("019-c-add-proposal-0.send_tx.json"));
    const sends = log.filter((r) => r.method === "send_tx");
    expect(sends).toHaveLength(2);
    const tx = signedTx(sends[0]);
    expect([tx.signerId, tx.receiverId]).toEqual(["cosigner.sandbox", "dao.sandbox"]);
    expect(tx.actions).toHaveLength(1);
    const fc = tx.actions[0].functionCall;
    expect([fc?.methodName, fc?.gas, fc?.deposit]).toEqual(["add_proposal", 100n * TGAS, bond]);
    expect(JSON.parse(Buffer.from(fc?.args ?? []).toString("utf8"))).toEqual({ proposal: P0 });
  });

  it("a refused or failed add_proposal is an EnvironmentError", async () => {
    const key = KeyPair.fromRandom("ed25519");
    replayFetch({
      status: STATUS,
      "query:view_access_key": fx("018-c-add-proposal-0.nonce.json"),
      send_tx: [fx("052-g1-method-add_proposal.send_tx.json"), readFixture(NEGATIVE_CONTROL_FIXTURES, "052-g1-method-add_proposal.send_tx.json")],
    });
    await expect(addProposal("sandbox", "seat.sandbox", key, "dao.sandbox", P1, 0n)).rejects.toThrow(/refused at validation \(MethodNameMismatch\)/);
    await expect(addProposal("sandbox", "seat.sandbox", key, "dao.sandbox", P1, 0n)).rejects.toThrow(/ERR_MIN_BOND/);
  });

  it("a landed tx whose value is not a proposal id is an EnvironmentError (act_proposal's SuccessValue is empty)", async () => {
    replayFetch({ status: STATUS, "query:view_access_key": fx("026-e-fc-vote-approve-0.nonce.json"), send_tx: fx("027-e-fc-vote-approve-0.send_tx.json") });
    await expect(addProposal("sandbox", "cosigner.sandbox", KeyPair.fromRandom("ed25519"), "dao.sandbox", P1, 10n ** 23n)).rejects.toThrow(/not a proposal id/);
  });

  it("a send whose fate is unknown keeps signAndSend's look-it-up hint and is never sent twice", async () => {
    // send_tx answers garbage; a `tx` read (if the send path polls by the local hash) never sees it final.
    const log = replayFetch({ status: STATUS, "query:view_access_key": fx("018-c-add-proposal-0.nonce.json"), send_tx: "<html>bad gateway</html>", tx: TIMEOUT });
    const err = await addProposal("sandbox", "cosigner.sandbox", KeyPair.fromRandom("ed25519"), "dao.sandbox", P1, 10n ** 23n).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).tryThis).toMatch(/up on chain before signing/); // passed through verbatim, not rewritten
    expect((err as EnvironmentError).tryThis).not.toMatch(/get_last_proposal_id/);
    expect(log.filter((r) => r.method === "send_tx")).toHaveLength(1);
  });

  it("refuses, before any RPC, a DAO id off the network and a negative bond", async () => {
    const seen = noFetch();
    const key = KeyPair.fromRandom("ed25519");
    await expect(addProposal("sandbox", "cosigner.sandbox", key, "dao.near", P1, 0n)).rejects.toThrow(InputError);
    await expect(addProposal("sandbox", "cosigner.sandbox", key, "dao.testnet", P1, 0n)).rejects.toThrow(InputError);
    await expect(addProposal("sandbox", "cosigner.sandbox", key, "dao.sandbox", P1, -1n)).rejects.toThrow(InputError);
    expect(seen.count).toBe(0);
  });

  it("refuses, before any RPC, a signer off the network", async () => {
    const seen = noFetch();
    const key = KeyPair.fromRandom("ed25519");
    await expect(addProposal("sandbox", "op.testnet", key, "dao.sandbox", P1, 0n)).rejects.toThrow(InputError);
    await expect(addProposal("testnet", "sandbox", key, "dao.testnet", P1, 0n)).rejects.toThrow(InputError);
    await expect(addProposal("testnet", "cosigner.near", key, "dao.testnet", P1, 0n)).rejects.toThrow(InputError);
    expect(seen.count).toBe(0);
  });

  it("the sandbox root itself may propose on sandbox", async () => {
    replayFetch({ status: STATUS, "query:view_access_key": fx("018-c-add-proposal-0.nonce.json"), send_tx: fx("019-c-add-proposal-0.send_tx.json") });
    expect((await addProposal("sandbox", "sandbox", KeyPair.fromRandom("ed25519"), "dao.sandbox", P1, 10n ** 23n)).id).toBe(0);
  });
});
