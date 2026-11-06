/**
 * C-T4a (Task 10): planWrap + signWrap with the DEFAULT classifier (classifyTools; no `deps.classify`) against the
 * Sputnik DAO deployed on near-sandbox (Task 9's deployDaoSandbox, the vendored sputnikdao2 v2.0.0). Task 4's
 * wrap.sandbox.test.ts keeps its fake-classifier cases; this file adds the live dry-run under them.
 * Local only: every key is the sandbox root's or generated in memory, and none is printed.
 *
 * 1. On-account, `deps.sandbox` given: the classifier dry-runs a copy in the wrap's own sandbox, never the target
 *    DAO; the session's tools are its labels, and the key on chain bears them out (the vote lands, add_proposal is
 *    refused by the protocol).
 * 2. add_proposal in the allowlist: the runtime WARN comes from the live dry-run.
 * 3. Sub-account, no `deps.sandbox`: the classifier boots and stops a sandbox of its own, and the `sandbox` RPC is
 *    back on the wrap's sandbox, so signWrap lands there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLABLE_EVIDENCE } from "../src/classify/dry-run.js";
import { NEAR } from "../src/core/amounts.js";
import { sendAttempt } from "../src/core/attempt.js";
import { rpcUrlFor } from "../src/core/config.js";
import { saveAccountKey } from "../src/core/credentials.js";
import { dropHeldKeys } from "../src/core/keys.js";
import { callView, viewScopedKey } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import type { ToolSchema } from "../src/core/types.js";
import { planWrap, signWrap } from "../src/core/wrap.js";
import { addProposal, deployDaoSandbox } from "../src/packs/sputnik-setup.js";
import { actProposalArgs } from "../src/packs/sputnik-v2.js";
import { warnRuntime } from "../src/render/strings.js";
import { sampleSession, tmpEnv } from "../test/helpers.js";
import { createAccount, repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

const ALLOWANCE = "50000000000000000000000";
const BOND = 10n ** 23n;

let sb: SandboxHandle;
let seat: string;
let cosigner: string;
let cosignerKey: KeyPair;
let dao: string;
const env = tmpEnv();
const nodesAtStart = repoSandboxProcesses();
const homeAtStart = sandboxHomeEntries();

/** [name, classification] per tool, in order. */
const labels = (tools: ToolSchema[]) => tools.map((t) => [t.name, t.classification]);
const HERO_LABELS = [
  ["dao_list_proposals", undefined],
  ["dao_get_policy", undefined],
  ["dao_vote", "callable"],
  ["add_proposal", "not in allowlist"],
];

beforeAll(async () => {
  sb = await startSandbox();
  seat = `seat.${sb.rootId}`;
  cosigner = `cosigner.${sb.rootId}`;
  dao = `dao.${sb.rootId}`;
  const seatKey = await createAccount(sb, "seat", 10n * NEAR);
  cosignerKey = await createAccount(sb, "cosigner", 10n * NEAR);
  saveAccountKey("sandbox", seat, seatKey, env); // the keychain wrap reads (tmpEnv, never ~/.near-credentials)
  await deployDaoSandbox(sb, { daoId: dao, seat, cosigner });
});

afterAll(async () => {
  dropHeldKeys();
  await sb?.stop();
  expect(repoSandboxProcesses()).toEqual(nodesAtStart); // no node left running, the classifier's included
  expect(sandboxHomeEntries()).toEqual(homeAtStart);
});

describe("wrap with the default classifier on near-sandbox", () => {
  it("on-account: the dry-run labels a copy, not the target; the session carries them and the chain key bears them out", async () => {
    const plan = await planWrap({ contract: dao, allow: ["act_proposal"], allowanceYocto: ALLOWANCE, onAccount: seat, network: "sandbox" }, { sandbox: sb });
    expect(labels(plan.tools)).toEqual(HERO_LABELS);
    const vote = plan.tools.find((t) => t.name === "dao_vote");
    const add = plan.tools.find((t) => t.name === "add_proposal");
    expect(vote?.evidence).toBe(CALLABLE_EVIDENCE);
    expect(add?.evidence).toMatch(/^absent from the key's method_names \(chain\); 0-deposit dry-run: Smart contract panicked: .*ERR_MIN_BOND/);
    expect(plan.warnings).toEqual([]);
    expect(plan.dryRunMs).toBeGreaterThan(0);
    expect(plan.draft.tools).toEqual(plan.tools);
    // The dry-run ran on a dry-XXXX copy: the target DAO still has no proposal.
    const target = sampleSession({ accountId: seat, receiverId: dao });
    expect(await callView(target, "get_last_proposal_id", {})).toBe(0);

    const { session } = await signWrap(plan, { env });
    expect(session.tools).toEqual(plan.tools);
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", `${session.id}.json`), "utf8")).tools).toEqual(plan.tools);
    expect(await viewScopedKey(session)).toMatchObject({ accountId: seat, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: ALLOWANCE });

    // `callable`: the session key's vote lands. `not in allowlist`: its add_proposal is refused at validation.
    const { id } = await addProposal("sandbox", cosigner, cosignerKey, dao, { description: "default-classifier wrap: poll", kind: "Vote" }, BOND);
    const voteArgs = await actProposalArgs(target, { id, action: "approve" });
    const voted = await sendAttempt(session, { sessionId: session.id, receiverId: dao, action: "FunctionCall", method: "act_proposal", args: voteArgs, depositYocto: "0", gasTGas: 30, violates: "none" });
    expect(voted.outcome.kind).toBe("TxSuccess");
    const proposed = await sendAttempt(session, { sessionId: session.id, receiverId: dao, action: "FunctionCall", method: "add_proposal", args: { proposal: { description: "x", kind: "Vote" } }, depositYocto: "0", gasTGas: 30, violates: "method" });
    expect(proposed.outcome).toMatchObject({ kind: "Refusal", errorName: "MethodNameMismatch" });
  });

  it("add_proposal in the allowlist: the live dry-run labels it fails-without-deposit (runtime) and planWrap warns", async () => {
    const plan = await planWrap({ contract: dao, allow: ["act_proposal", "add_proposal"], allowanceYocto: ALLOWANCE, onAccount: seat, network: "sandbox" }, { sandbox: sb });
    const add = plan.tools.find((t) => t.name === "add_proposal");
    expect(add?.classification).toBe("fails-without-deposit (runtime)");
    expect(add?.evidence).toContain("ERR_MIN_BOND");
    expect(plan.warnings).toEqual([warnRuntime("add_proposal")]);
  });

  it("sub-account with no deps.sandbox: the classifier's own sandbox comes and goes; signWrap lands on the wrap's", async () => {
    const nodesBefore = repoSandboxProcesses();
    const plan = await planWrap({ contract: dao, allow: ["act_proposal"], allowanceYocto: ALLOWANCE, operatorId: sb.rootId, network: "sandbox" });
    expect(labels(plan.tools)).toEqual(HERO_LABELS);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(rpcUrlFor("sandbox")).toBe(sb.rpcUrl);

    const { session } = await signWrap(plan, { env, signerKey: sb.rootKey });
    expect(session.accountId).toMatch(/^ks-[0-9a-f]{4}\.sandbox$/);
    expect(await viewScopedKey(session)).toMatchObject({ accountId: session.accountId, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: ALLOWANCE });
  });
});
