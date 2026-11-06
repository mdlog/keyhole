/**
 * Task 9 live suite (`npm run test:sandbox`): the Sputnik pack code against a real near-sandbox
 * (nearcore 2.14.0) running the vendored sputnikdao2 v2.0.0. Local only: every key is the sandbox root's or
 * generated in memory here, and none is printed.
 *
 * 1. deployDaoSandbox pins the vendored code (viewCodeHash = the pack's codeHash) and seats the council.
 * 2. addProposal ids are 0 then 1, read from SuccessValue.
 * 3. Votes go through the hooks / actProposalArgs (the 4-arg form with the stored kind; memo null when absent),
 *    and proposalStatus / afterCall read the result back: 1 of 2, then Approved 2 of 2.
 * 4. A zero-bond DAO (policyOverride) runs the pack's `setup` row and then dao_vote's dry-run args, as the
 *    classifier (Task 10) will: the setup proposal is #0 and the 4-arg dry-run vote lands.
 */
import { actions } from "near-api-js";
import { describe, expect, it } from "vitest";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { EnvironmentError } from "../src/core/errors.js";
import { bodyState } from "../src/core/outcome.js";
import { callView, viewCodeHash } from "../src/core/rpc.js";
import { mustSucceed, signAndSend, successValue } from "../src/core/tx.js";
import type { PackTool } from "../src/core/types.js";
import { packHooks } from "../src/packs/hooks.js";
import { loadTargetPack } from "../src/packs/index.js";
import { addProposal, deployDaoSandbox } from "../src/packs/sputnik-setup.js";
import { actProposalArgs, proposalStatus, requiredApprovals } from "../src/packs/sputnik-v2.js";
import { sampleSession } from "../test/helpers.js";
import { createAccount, repoSandboxProcesses, sandboxHomeEntries, withSandbox } from "./helpers.js";

const VOTE_GAS = 30n * TGAS;

describe("Sputnik pack on near-sandbox", () => {
  it("deploys the pinned DAO, adds proposals 0 and 1, votes through the hooks and reads the status back", async () => {
    const homeBefore = sandboxHomeEntries();
    const nodesBefore = repoSandboxProcesses();

    await withSandbox(async (sb) => {
      const pack = await loadTargetPack("sputnik-v2");
      const fixture = pack.sandboxFixture;
      if (!fixture?.setup) throw new Error("sputnik-v2 pack has no sandboxFixture.setup");
      const daoVote = pack.tools.find((t) => t.name === "dao_vote") as PackTool;
      const seat = `seat.${sb.rootId}`;
      const cosigner = `cosigner.${sb.rootId}`;
      const dao = `dao.${sb.rootId}`;
      const seatKey = await createAccount(sb, "seat", 10n * NEAR);
      const cosignerKey = await createAccount(sb, "cosigner", 10n * NEAR);

      // 1. One tx from the root: the DAO exists with exactly the pinned code, and its council is [seat, cosigner].
      const deployed = await deployDaoSandbox(sb, { daoId: dao, seat, cosigner });
      expect(bodyState(deployed.raw)).toBe("landed-ok");
      expect(deployed.json.result.transaction.signer_id).toBe(sb.rootId);
      expect(await viewCodeHash("sandbox", dao)).toBe(fixture.codeHash);
      const session = sampleSession({ accountId: seat, receiverId: dao });
      const policy = (await callView(session, "get_policy", {})) as any;
      expect([...policy.roles[1].kind.Group].sort()).toEqual([cosigner, seat]);
      expect(requiredApprovals(policy)).toBe(2);
      const bond = BigInt(policy.proposal_bond);
      expect(bond).toBe(10n ** 23n);

      // 2. Ids from SuccessValue: 0 then 1.
      const payout = { description: "Grant payout: 0.01 NEAR to the seat", kind: { Transfer: { token_id: "", receiver_id: seat, amount: (10n ** 22n).toString() } } };
      const p0 = await addProposal("sandbox", cosigner, cosignerKey, dao, payout, bond);
      const p1 = await addProposal("sandbox", cosigner, cosignerKey, dao, { description: "Poll: adopt the 2027 grants calendar?", kind: "Vote" }, bond);
      expect([p0.id, p1.id]).toEqual([0, 1]);
      expect([successValue(p0.sent), successValue(p1.sent)]).toEqual([0, 1]);
      expect(await proposalStatus(session, 0)).toEqual({ status: "InProgress", approvals: 0, required: 2 });

      // 3. The seat approves #0 with the args the hook builds (the stored kind, msg: null included), then the cosigner.
      const hooks = packHooks("sputnik-v2");
      const args0 = await hooks.callArgs(session, daoVote, { id: p0.id, action: "approve", memo: "sandbox: approve #0" });
      expect(args0).toEqual({ id: 0, action: "VoteApprove", proposal: { Transfer: { ...payout.kind.Transfer, msg: null } }, memo: "sandbox: approve #0" });
      mustSucceed("seat approves #0", await signAndSend("sandbox", seat, seatKey, dao, [actions.functionCall("act_proposal", args0, VOTE_GAS, 0n)]));
      expect(await hooks.afterCall(session, daoVote, { id: p0.id, action: "approve" })).toEqual({
        text: "proposal #0 InProgress (1 of 2 approvals)",
        structured: { id: 0, status: "InProgress", approvals: 1, required: 2 },
      });
      const cosignerSession = sampleSession({ accountId: cosigner, receiverId: dao });
      const cosignerArgs = await actProposalArgs(cosignerSession, { id: p0.id, action: "approve" });
      mustSucceed("cosigner approves #0", await signAndSend("sandbox", cosigner, cosignerKey, dao, [actions.functionCall("act_proposal", cosignerArgs, 100n * TGAS, 0n)]));
      expect(await proposalStatus(session, 0)).toEqual({ status: "Approved", approvals: 2, required: 2 });

      // A reject with no memo: the 4-arg form with memo null lands on v2.0.0; the council's approvals stay 0.
      const args1 = await actProposalArgs(session, { id: p1.id, action: "reject" });
      expect(args1).toEqual({ id: 1, action: "VoteReject", proposal: "Vote", memo: null });
      mustSucceed("seat rejects #1", await signAndSend("sandbox", seat, seatKey, dao, [actions.functionCall("act_proposal", args1, VOTE_GAS, 0n)]));
      expect(await proposalStatus(session, 1)).toEqual({ status: "InProgress", approvals: 0, required: 2 });
      expect((await callView(session, "get_proposal", { id: 1 })) as any).toMatchObject({ votes: { [seat]: "Reject" }, vote_counts: { council: [0, 1, 0] } });

      // No such proposal: the contract's panic comes back as an EnvironmentError, nothing signed.
      await expect(proposalStatus(session, 99)).rejects.toThrow(EnvironmentError);

      // 4. The classifier's DAO: zero bond (policyOverride), then the pack's setup row, then the dry-run vote.
      const dry = `dry.${sb.rootId}`;
      mustSucceed("deploy the zero-bond DAO", await deployDaoSandbox(sb, { daoId: dry, seat, cosigner }, { proposal_bond: "0" }));
      expect(await viewCodeHash("sandbox", dry)).toBe(fixture.codeHash);
      const drySession = sampleSession({ accountId: seat, receiverId: dry });
      expect(((await callView(drySession, "get_policy", {})) as any).proposal_bond).toBe("0");
      const keys = { seat: seatKey, cosigner: cosignerKey };
      const ids = { seat, cosigner };
      const setupIds: unknown[] = [];
      for (const row of fixture.setup) {
        const sent = await signAndSend("sandbox", ids[row.signer], keys[row.signer], dry, [actions.functionCall(row.method, row.args, 100n * TGAS, BigInt(row.depositYocto))]);
        setupIds.push(successValue(mustSucceed(`setup ${row.method}`, sent)));
      }
      expect(setupIds).toEqual([0]);
      const dryRun = daoVote.dryRun;
      if (!dryRun) throw new Error("dao_vote has no dryRun");
      expect(await actProposalArgs(drySession, { id: 0, action: "approve", memo: "keyhole dry-run" })).toEqual(dryRun.args); // the shape serve sends
      const voted = await signAndSend("sandbox", seat, seatKey, dry, [actions.functionCall("act_proposal", dryRun.args, BigInt(daoVote.gasTGas) * TGAS, 0n)]);
      expect(bodyState(voted.raw)).toBe("landed-ok");
      expect(await proposalStatus(drySession, 0)).toEqual({ status: "InProgress", approvals: 1, required: 2 });
    });

    // Nothing left behind: no near-sandbox process from this repo, no run dir.
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  });
});
