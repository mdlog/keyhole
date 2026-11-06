/**
 * Task 21 live suite (`npm run test:sandbox`): scripts/stage-testnet.ts's stageProposals and coVote, the code
 * `npm run stage:testnet` runs, against a real near-sandbox DAO (the vendored sputnikdao2 v2.0.0, council
 * [seat, cosigner], 2-of-2, bond 0.1 NEAR) instead of the testnet one. Take B's order: the cosigner adds the payout
 * and the injected proposal; the seat (the agent's vote, here with the seat's own key) approves the payout; the
 * cosigner's co-vote decides it and the grantee is paid. The refusals sign nothing. Keys are the sandbox root's or
 * generated in memory here; none is printed.
 */
import { actions } from "near-api-js";
import { describe, expect, it } from "vitest";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { InputError } from "../src/core/errors.js";
import { callView, viewAccount } from "../src/core/rpc.js";
import { mustSucceed, signAndSend } from "../src/core/tx.js";
import { injectionDescription } from "../src/demo/driver.js";
import { deployDaoSandbox } from "../src/packs/sputnik-setup.js";
import { actProposalArgs, proposalStatus } from "../src/packs/sputnik-v2.js";
import { type StageCast, coVote, coVoteVerdict, stageProposals } from "../scripts/stage-testnet.js";
import { sampleSession } from "../test/helpers.js";
import { createAccount, repoSandboxProcesses, sandboxHomeEntries, withSandbox } from "./helpers.js";

describe("stage:testnet's functions on near-sandbox", () => {
  it("--proposals adds #0 payout and #1 injected with the bond; --covote decides #0 after the seat's vote; the payout runs", async () => {
    const homeBefore = sandboxHomeEntries();
    const nodesBefore = repoSandboxProcesses();

    await withSandbox(async (sb) => {
      const seat = `seat.${sb.rootId}`;
      const cosigner = `cosigner.${sb.rootId}`;
      const grantee = `grantee.${sb.rootId}`;
      const dao = `dao.${sb.rootId}`;
      const seatKey = await createAccount(sb, "seat", 10n * NEAR);
      const cosignerKey = await createAccount(sb, "cosigner", 10n * NEAR);
      await createAccount(sb, "grantee", NEAR);
      await deployDaoSandbox(sb, { daoId: dao, seat, cosigner });
      const cast: StageCast = { network: "sandbox", dao, cosigner, cosignerKey, grantee, attacker: `attacker.${sb.rootId}`, otherDao: `other.${sb.rootId}` };
      const reader = sampleSession({ accountId: seat, receiverId: dao });

      // --proposals: ids from add_proposal, the DAO's bond attached, each line logged as its proposal lands.
      const log: string[] = [];
      const daoBefore = BigInt((await viewAccount("sandbox", dao))!.amountYocto);
      const staged = await stageProposals(cast, { log: (l) => log.push(l) });
      expect([staged.payout.id, staged.injected.id]).toEqual([0, 1]);
      expect(staged.bondYocto).toBe(10n ** 23n);
      expect(log.filter((l) => l.startsWith("proposal #"))).toEqual([`proposal #0 (grant payout) · 0.0100 NEAR to ${grantee}`, `proposal #1 (injected description) · 5.0000 NEAR to ${cast.attacker}`]);
      expect(BigInt((await viewAccount("sandbox", dao))!.amountYocto) - daoBefore).toBeGreaterThanOrEqual(2n * 10n ** 23n - 10n ** 22n); // two bonds in (less the DAO's own receipt gas)
      const p0 = (await callView(reader, "get_proposal", { id: 0 })) as any;
      const p1 = (await callView(reader, "get_proposal", { id: 1 })) as any;
      expect(p0).toMatchObject({ proposer: cosigner, status: "InProgress", kind: { Transfer: { token_id: "", receiver_id: grantee, amount: (NEAR / 100n).toString() } } });
      expect(p1).toMatchObject({ proposer: cosigner, status: "InProgress", description: injectionDescription(cast.attacker, cast.otherDao), kind: { Transfer: { receiver_id: cast.attacker } } });

      // --covote before the agent's vote, or on the injected proposal: refused, nothing signed (no vote recorded).
      await expect(coVote(cast, 0)).rejects.toThrow(InputError);
      await expect(coVote(cast, 1)).rejects.toThrow(/is not a NEAR payout to grantee\.sandbox/);
      expect(await proposalStatus(reader, 0)).toEqual({ status: "InProgress", approvals: 0, required: 2 });
      expect(((await callView(reader, "get_proposal", { id: 1 })) as any).votes).toEqual({});

      // The agent's vote on the payout (the seat's dao_vote: the 4-arg act_proposal, 30 TGas, no deposit): 1 of 2.
      const args = await actProposalArgs(reader, { id: 0, action: "approve" });
      mustSucceed("the seat approves #0", await signAndSend("sandbox", seat, seatKey, dao, [actions.functionCall("act_proposal", args, 30n * TGAS, 0n)]));
      expect(await proposalStatus(reader, 0)).toEqual({ status: "InProgress", approvals: 1, required: 2 });

      // --covote 0: the deciding vote; Approved 2 of 2 and the grantee is paid exactly 0.01 NEAR.
      const lines: string[] = [];
      const r = await coVote(cast, 0, { log: (l) => lines.push(l) });
      expect(lines).toEqual(["the cosigner approves #0 with its own full-access key", `        tx ${r.txHash}`]); // the tx line as it lands (M2)
      expect(r.status).toEqual({ status: "Approved", approvals: 2, required: 2 });
      expect(r.paidYocto).toBe(NEAR / 100n);
      expect(coVoteVerdict(0, cast, r)).toEqual({ line: "proposal #0 Approved · payout executed", exitCode: 0 });
      expect(((await callView(reader, "get_proposal", { id: 0 })) as any).votes).toEqual({ [seat]: "Approve", [cosigner]: "Approve" });

      // Again on the same id: it is Approved now, so nothing is signed.
      await expect(coVote(cast, 0)).rejects.toThrow(/proposal #0 is Approved, not InProgress/);
    });

    // Nothing left behind: no near-sandbox process from this repo, no run dir.
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  });
});
