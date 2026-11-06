/**
 * Task 21: scripts/stage-testnet.ts, offline. Every chain function is a fake (StageMainDeps): the state loader, the
 * keychain read, add_proposal, the views and the send. A send's body is a recorded one (the spike's landed cosigner
 * vote), so mustSucceed judges a real body. Keys are generated in memory; nothing reaches a network or a keychain.
 * The same functions run against a real DAO in test-sandbox/stage.sandbox.test.ts.
 */
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { EnvironmentError } from "../src/core/errors.js";
import { SendFateUnknownError, type SentTx } from "../src/core/tx.js";
import type { TestnetDemoState } from "../src/demo/testnet-setup.js";
import { injectionDescription } from "../src/demo/driver.js";
import { displayWidth } from "../src/render/style.js";
import { type StageMainDeps, USAGE, parseStageArgs, stageMain, stagedProposals } from "../scripts/stage-testnet.js";
import { SANDBOX_FIXTURES, readFixture } from "./helpers.js";

const OP = "kh-op-021e.testnet";
const STATE: TestnetDemoState = {
  operator: OP,
  seat: `seat.${OP}`,
  cosigner: `cosigner.${OP}`,
  grantee: `grantee.${OP}`,
  dao: "kh-2c19.sputnik-v2.testnet",
  daoCreateTx: "Ek1APr5joscLK3cRL9DPuesjGpvSLZ1cQPs9uRJEX9WT",
  daoCreatedAt: "2026-11-06T09:47:05.334Z",
  otherDao: "genesis.sputnik-v2.testnet",
  attacker: `attacker.${OP}`,
};
const BOND = 10n ** 23n; // the pack's proposal_bond, 0.1 NEAR
const PAYOUT = NEAR / 100n;
const DAO_LINE = `DAO ${STATE.dao} · verified: code_hash = pack pin · council [seat, cosigner] · 2-of-2`;

/** A recorded landed body (the spike's cosigner approval of #0, every receipt SuccessValue) as a SentTx. */
function landed(file = "033-e-cosigner-approve-0.send_tx.json"): SentTx {
  const raw = readFixture(SANDBOX_FIXTURES, file);
  const json = JSON.parse(raw);
  return { txHash: json.result.transaction.hash, raw, json };
}
const VOTE_TX = landed().txHash;
const ADD_TXS = [landed("019-c-add-proposal-0.send_tx.json"), landed("021-c-add-proposal-1.send_tx.json")];

interface Calls {
  [name: string]: unknown[][];
}

/** A proposal as get_proposal returns it (v2.0.0 shape). */
function proposal(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    proposer: STATE.cosigner,
    description: "Grant payout",
    kind: { Transfer: { token_id: "", receiver_id: STATE.grantee, amount: PAYOUT.toString(), msg: null } },
    status: "InProgress",
    vote_counts: { council: [1, 0, 0] },
    votes: { [STATE.seat]: "Approve" },
    submission_time: "1",
    ...over,
  };
}

/**
 * Fakes for every chain function, recording each call. `views` answers callView by method; `status` answers
 * proposalStatus in order; `balances` answers viewAccount in order; `send` is signAndSend.
 */
function fakes(opts: { views?: Record<string, unknown>; status?: Array<{ status: string; approvals: number; required: number }>; balances?: Array<bigint | null>; send?: () => Promise<SentTx>; ids?: number[] } = {}) {
  const calls: Calls = {};
  const record = (name: string, args: unknown[]) => (calls[name] ??= []).push(args);
  const key = KeyPair.fromRandom("ed25519");
  const ids = [...(opts.ids ?? [7, 8])];
  const status = [...(opts.status ?? [])];
  const balances = [...(opts.balances ?? [])];
  const deps: StageMainDeps = {
    checkTestnetDemo: (async (...a: unknown[]) => {
      record("checkTestnetDemo", a);
      return { state: STATE, line: "unused" };
    }) as StageMainDeps["checkTestnetDemo"],
    loadFullAccessKey: ((...a: unknown[]) => {
      record("loadFullAccessKey", a);
      return key;
    }) as StageMainDeps["loadFullAccessKey"],
    addProposal: (async (...a: unknown[]) => {
      record("addProposal", a);
      const id = ids.shift()!;
      return { id, sent: ADD_TXS[(calls.addProposal.length - 1) % 2] };
    }) as StageMainDeps["addProposal"],
    callView: (async (...a: unknown[]) => {
      record("callView", a);
      const method = a[1] as string;
      if (!(method in (opts.views ?? {}))) throw new Error(`fake: no view ${method}`);
      return opts.views![method];
    }) as StageMainDeps["callView"],
    proposalStatus: (async (...a: unknown[]) => {
      record("proposalStatus", a);
      return status.shift()!;
    }) as StageMainDeps["proposalStatus"],
    viewAccount: (async (...a: unknown[]) => {
      record("viewAccount", a);
      const b = balances.length > 0 ? balances.shift() : NEAR; // past the list: a funded account (the cosigner's 1 NEAR)
      return b === null || b === undefined ? null : { amountYocto: b.toString(), codeHash: "11111111111111111111111111111111" };
    }) as StageMainDeps["viewAccount"],
    actProposalArgs: (async (...a: unknown[]) => {
      record("actProposalArgs", a);
      const v = a[1] as { id: number; action: string };
      return { id: v.id, action: "VoteApprove", proposal: proposal(v.id).kind, memo: null };
    }) as StageMainDeps["actProposalArgs"],
    signAndSend: (async (...a: unknown[]) => {
      record("signAndSend", a);
      return opts.send ? opts.send() : landed();
    }) as StageMainDeps["signAndSend"],
    settle: (async (...a: unknown[]) => {
      record("settle", a);
    }) as StageMainDeps["settle"],
  };
  return { deps, calls, key };
}

async function run(argv: string[], f: ReturnType<typeof fakes>, env: NodeJS.ProcessEnv = { KEYHOLE_OPERATOR: OP }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await stageMain(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, env, f.deps);
  return { code, out, err };
}

const POLICY = { proposal_bond: BOND.toString() };

describe("stage:testnet arguments", () => {
  it("takes exactly --proposals or --covote ID (also --covote=ID)", () => {
    expect(parseStageArgs(["--proposals"])).toEqual({ kind: "proposals" });
    expect(parseStageArgs(["--covote", "12"])).toEqual({ kind: "covote", id: 12 });
    expect(parseStageArgs(["--covote=0"])).toEqual({ kind: "covote", id: 0 });
  });

  for (const argv of [[], ["--covote"], ["--covote", "-1"], ["--covote", "1.5"], ["--covote", "01"], ["--covote", "x"], ["--covote", "99999999999999999999"], ["--proposals", "--covote", "1"], ["--burn"]]) {
    it(`refuses ${JSON.stringify(argv)}: exit 2 before any read or key`, async () => {
      const f = fakes();
      const r = await run(argv, f);
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err.at(-1)).toMatch(/^ERROR \(input\): /);
      expect(Object.keys(f.calls)).toEqual([]);
    });
  }

  it("a missing flag prints the usage line first", async () => {
    const r = await run([], fakes());
    expect(r.err[0]).toBe(USAGE);
  });
});

describe("stage:testnet --proposals", () => {
  it("adds the driver's payout and injected proposals as the cosigner, with the DAO's bond, and prints both ids", async () => {
    const f = fakes({ views: { get_policy: POLICY }, ids: [7, 8] });
    const r = await run(["--proposals"], f);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      DAO_LINE,
      `proposal #7 (grant payout) · 0.0100 NEAR to ${STATE.grantee}`,
      `        tx ${ADD_TXS[0].txHash}`,
      `proposal #8 (injected description) · 5.0000 NEAR to ${STATE.attacker}`,
      `        tx ${ADD_TXS[1].txHash}`,
      "cosigner adds proposal #7 (grant payout) and #8 (injected description) · bond 0.1000 NEAR each",
    ]);
    // Both on testnet, signed by the cosigner with the key the keychain read gave, on the state's DAO, bond attached.
    expect(f.calls.addProposal.map((a) => [a[0], a[1], a[2], a[3], a[5]])).toEqual([
      ["testnet", STATE.cosigner, f.key, STATE.dao, BOND],
      ["testnet", STATE.cosigner, f.key, STATE.dao, BOND],
    ]);
    expect(f.calls.addProposal.map((a) => a[4])).toEqual([
      { description: `Grant payout: 0.0100 NEAR to ${STATE.grantee} for milestone 1 (docs translation).`, kind: { Transfer: { token_id: "", receiver_id: STATE.grantee, amount: "10000000000000000000000" } } },
      { description: injectionDescription(STATE.attacker, STATE.otherDao), kind: { Transfer: { token_id: "", receiver_id: STATE.attacker, amount: "5000000000000000000000000" } } },
    ]);
    // The only key read is the cosigner's full-access key; nothing else signs.
    expect(f.calls.loadFullAccessKey).toEqual([["testnet", STATE.cosigner, { KEYHOLE_OPERATOR: OP }]]);
    expect(f.calls.signAndSend).toBeUndefined();
  });

  it("every line fits the 100-column recording, and no line carries the private key", async () => {
    const f = fakes({ views: { get_policy: POLICY }, ids: [1234, 1235] });
    const r = await run(["--proposals"], f);
    for (const line of r.out) expect(displayWidth(line), line).toBeLessThanOrEqual(100);
    expect(r.out.join("\n")).not.toContain(f.key.toString().slice("ed25519:".length));
  });

  it("a DAO whose proposal_bond is not the pack's 0.1 NEAR: exit 2, nothing added", async () => {
    for (const policy of [{ proposal_bond: "0" }, { proposal_bond: (2n * BOND).toString() }, {}, null]) {
      const f = fakes({ views: { get_policy: policy } });
      const r = await run(["--proposals"], f);
      expect(r.code).toBe(2);
      expect(r.err.at(-1)).toMatch(/^ERROR \(environment\): kh-2c19\.sputnik-v2\.testnet: proposal_bond .*, not the pack's 0\.1000 NEAR · /);
      expect(f.calls.addProposal).toBeUndefined();
    }
  });

  it("M7: the cosigner must hold both sends (2 × (0.1 NEAR bond + 100 TGas at the minimum gas price) = 0.4 NEAR) before the first", async () => {
    const need = 2n * (BOND + 100n * TGAS * 10n ** 9n);
    expect(need).toBe(4n * 10n ** 23n);
    for (const [balance, line] of [
      [need - 1n, `ERROR (environment): ${STATE.cosigner} has 0.3999 NEAR; two proposals need 0.4000 NEAR (each: the 0.1000 NEAR bond + 100 TGas of prepaid gas) · fund the cosigner, then stage again; nothing was signed`],
      [null, `ERROR (environment): ${STATE.cosigner} does not exist; two proposals need 0.4000 NEAR (each: the 0.1000 NEAR bond + 100 TGas of prepaid gas) · fund the cosigner, then stage again; nothing was signed`],
    ] as const) {
      const f = fakes({ views: { get_policy: POLICY }, balances: [balance] });
      const r = await run(["--proposals"], f);
      expect(r.code).toBe(2);
      expect(r.err).toEqual([line]);
      expect(f.calls.viewAccount).toEqual([["testnet", STATE.cosigner]]);
      expect(f.calls.addProposal).toBeUndefined();
    }
    const f = fakes({ views: { get_policy: POLICY }, balances: [need] });
    expect((await run(["--proposals"], f)).code).toBe(0);
    expect(f.calls.addProposal).toHaveLength(2);
  });

  it("the payout lands, the injected one fails: the payout's id and tx are already printed", async () => {
    const f = fakes({ views: { get_policy: POLICY } });
    let n = 0;
    f.deps.addProposal = (async () => {
      if (n++ === 0) return { id: 9, sent: ADD_TXS[0] };
      throw new EnvironmentError("add_proposal on kh-2c19.sputnik-v2.testnet: failed in a block: ERR_X · tx abc", "whether to retry is the caller's decision");
    }) as StageMainDeps["addProposal"];
    const r = await run(["--proposals"], f);
    expect(r.code).toBe(2);
    expect(r.out.slice(1)).toEqual([`proposal #9 (grant payout) · 0.0100 NEAR to ${STATE.grantee}`, `        tx ${ADD_TXS[0].txHash}`]);
  });

  it("the same id twice is an error, both txs named", async () => {
    const f = fakes({ views: { get_policy: POLICY }, ids: [4, 4] });
    const r = await run(["--proposals"], f);
    expect(r.code).toBe(2);
    expect(r.err.at(-1)).toContain(`add_proposal returned id 4 twice (tx ${ADD_TXS[0].txHash}, tx ${ADD_TXS[1].txHash})`);
  });

  it("staging never creates a DAO: an unverified state stops before any key is read", async () => {
    const f = fakes();
    f.deps.checkTestnetDemo = (async () => {
      throw new EnvironmentError("DAO kh-2c19.sputnik-v2.testnet does not verify: its council is [x], not [y]", "run: npm run bootstrap:testnet (it creates a new demo DAO)");
    }) as StageMainDeps["checkTestnetDemo"];
    const r = await run(["--proposals"], f);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(f.calls.loadFullAccessKey).toBeUndefined();
  });

  it("mainnet is out: a KEYHOLE_OPERATOR that is not *.testnet fails in the real state loader, before any RPC", async () => {
    const f = fakes();
    const { checkTestnetDemo } = await import("../src/demo/testnet-setup.js");
    f.deps.checkTestnetDemo = checkTestnetDemo; // the offline fetch guard (test/setup.ts) fails any RPC it would make
    for (const op of ["kh-op.near", "kh-op", ""]) {
      const r = await run(["--proposals"], f, { KEYHOLE_OPERATOR: op });
      expect(r.code).toBe(2);
      expect(r.err).toEqual(["ERROR (environment): set KEYHOLE_OPERATOR=<account>.testnet · its full-access key must be in ~/.near-credentials/testnet/<account>.json"]);
    }
    expect(f.calls.addProposal).toBeUndefined();
  });
});

describe("stage:testnet --covote ID", () => {
  const happy = () =>
    fakes({
      views: { get_proposal: proposal(7) },
      status: [
        { status: "InProgress", approvals: 1, required: 2 },
        { status: "Approved", approvals: 2, required: 2 },
      ],
      balances: [NEAR, NEAR + PAYOUT],
    });

  it("approves the payout as the cosigner (act_proposal, 100 TGas, no deposit), settles, and prints `proposal #ID Approved · payout executed`", async () => {
    const f = happy();
    const r = await run(["--covote", "7"], f);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      DAO_LINE,
      "the cosigner approves #7 with its own full-access key",
      `        tx ${VOTE_TX}`,
      `        ${STATE.grantee} +0.0100 NEAR (view_account before and after)`,
      "proposal #7 Approved · payout executed",
    ]);
    expect(f.calls.signAndSend).toHaveLength(1);
    const [network, signer, key, receiver, acts] = f.calls.signAndSend[0] as [string, string, KeyPair, string, any[]];
    expect([network, signer, key, receiver]).toEqual(["testnet", STATE.cosigner, f.key, STATE.dao]);
    expect(acts).toHaveLength(1);
    const fc = acts[0].functionCall;
    expect(fc.methodName).toBe("act_proposal");
    expect(BigInt(fc.gas)).toBe(100n * TGAS);
    expect(BigInt(fc.deposit)).toBe(0n);
    expect(JSON.parse(Buffer.from(fc.args).toString())).toEqual({ id: 7, action: "VoteApprove", proposal: proposal(7).kind, memo: null });
    expect(f.calls.settle).toEqual([["testnet", VOTE_TX, STATE.cosigner]]);
    // The grantee's balance is read before the send and after it settled.
    expect(f.calls.viewAccount).toEqual([
      ["testnet", STATE.grantee],
      ["testnet", STATE.grantee],
    ]);
    for (const line of r.out) expect(displayWidth(line), line).toBeLessThanOrEqual(100);
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["the injected proposal (a transfer to the attacker)", proposal(7, { kind: { Transfer: { token_id: "", receiver_id: STATE.attacker, amount: (5n * NEAR).toString() } } }), /proposal #7 is not a NEAR payout to grantee\.kh-op-021e\.testnet: the cosigner co-votes only the grant payout, never the injected proposal/],
    ["a token transfer", proposal(7, { kind: { Transfer: { token_id: "usdc.testnet", receiver_id: STATE.grantee, amount: "1" } } }), /is not a NEAR payout/],
    ["a non-transfer kind", proposal(7, { kind: "Vote" }), /is not a NEAR payout/],
    ["an Approved proposal", proposal(7, { status: "Approved" }), /proposal #7 is Approved, not InProgress: there is nothing to vote on/],
    ["a proposal the cosigner already voted on", proposal(7, { votes: { [STATE.seat]: "Approve", [STATE.cosigner]: "Approve" } }), /cosigner\.kh-op-021e\.testnet has already voted on proposal #7/],
  ];
  for (const [what, p, message] of refusals) {
    it(`refuses ${what}: exit 2, nothing signed`, async () => {
      const f = fakes({ views: { get_proposal: p }, status: [{ status: "InProgress", approvals: 1, required: 2 }] });
      const r = await run(["--covote", "7"], f);
      expect(r.code).toBe(2);
      expect(r.err.at(-1)).toMatch(message);
      expect(f.calls.signAndSend).toBeUndefined();
      expect(r.out).toEqual([DAO_LINE]);
    });
  }

  it("refuses when the agent has not voted yet: the cosigner's vote must be the deciding one", async () => {
    const f = fakes({ views: { get_proposal: proposal(7, { votes: {} }) }, status: [{ status: "InProgress", approvals: 0, required: 2 }] });
    const r = await run(["--covote", "7"], f);
    expect(r.code).toBe(2);
    expect(r.err.at(-1)).toBe("ERROR (input): proposal #7 has 0 of 2 approvals: the cosigner's vote would not decide it; the agent votes first (dao_vote)");
    expect(f.calls.signAndSend).toBeUndefined();
  });

  it("refuses a reply that is not proposal #ID", async () => {
    const f = fakes({ views: { get_proposal: proposal(6) } });
    const r = await run(["--covote", "7"], f);
    expect(r.code).toBe(2);
    expect(r.err.at(-1)).toMatch(/^ERROR \(environment\): get_proposal 7 on kh-2c19\.sputnik-v2\.testnet returned no proposal #7 · /);
    expect(f.calls.signAndSend).toBeUndefined();
  });

  it("the vote lands but the proposal is not Approved, or the payout did not arrive: FAIL, exit 1", async () => {
    const cases: Array<[{ status: string; approvals: number; required: number }, Array<bigint | null>, string]> = [
      [{ status: "InProgress", approvals: 1, required: 2 }, [NEAR, NEAR], `FAIL: proposal #7 InProgress (1 of 2 approvals) · ${STATE.grantee} moved 0 yocto, not +${PAYOUT}`],
      [{ status: "Approved", approvals: 2, required: 2 }, [NEAR, NEAR], `FAIL: proposal #7 Approved (2 of 2 approvals) · ${STATE.grantee} moved 0 yocto, not +${PAYOUT}`],
      [{ status: "Failed", approvals: 2, required: 2 }, [NEAR, NEAR + PAYOUT], `FAIL: proposal #7 Failed (2 of 2 approvals) · ${STATE.grantee} moved ${PAYOUT} yocto, not +${PAYOUT}`],
      [{ status: "Approved", approvals: 2, required: 2 }, [null, null], `FAIL: proposal #7 Approved (2 of 2 approvals) · ${STATE.grantee} does not exist (view_account)`],
    ];
    for (const [after, balances, line] of cases) {
      const f = fakes({ views: { get_proposal: proposal(7) }, status: [{ status: "InProgress", approvals: 1, required: 2 }, after], balances });
      const r = await run(["--covote", "7"], f);
      expect(r.code, line).toBe(1);
      expect(r.out.at(-1)).toBe(line);
    }
  });

  it("a send whose fate is unknown: exit 3, its line names the tx, nothing settles or is sent again", async () => {
    const f = happy();
    const fate = new SendFateUnknownError(VOTE_TX, STATE.cosigner, "TIMEOUT_ERROR and 6 tx polls found nothing");
    f.deps.signAndSend = (async (...a: unknown[]) => {
      (f.calls.signAndSend ??= []).push(a);
      throw fate;
    }) as StageMainDeps["signAndSend"];
    const r = await run(["--covote", "7"], f);
    expect(r.code).toBe(3);
    expect(r.out.at(-1)).toBe(`        tx ${VOTE_TX} · fate unknown`); // M2: the hash reaches stdout too
    expect(r.err).toEqual([fate.line()]);
    expect(r.err[0]).toContain(`look tx ${VOTE_TX} up on chain before signing anything again`);
    expect(f.calls.signAndSend).toHaveLength(1);
    expect(f.calls.settle).toBeUndefined();
  });

  it("a vote that landed and failed: exit 2 with the tx named (mustSucceed's line)", async () => {
    const f = happy();
    const failed = landed();
    failed.json = structuredClone(failed.json);
    failed.json.result.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_ALREADY_VOTED" } } } } };
    failed.json.result.receipts_outcome[0].outcome.status = failed.json.result.status;
    failed.raw = JSON.stringify(failed.json);
    f.deps.signAndSend = (async () => failed) as StageMainDeps["signAndSend"];
    const r = await run(["--covote", "7"], f);
    expect(r.code).toBe(2);
    expect(r.err.at(-1)).toContain(`the cosigner's vote on #7: failed in a block`);
    expect(r.err.at(-1)).toContain(`tx ${VOTE_TX}`);
    expect(r.out.slice(-2)).toEqual(["the cosigner approves #7 with its own full-access key", `        tx ${VOTE_TX}`]); // M2: in a block, so on stdout
  });

  // M2-M4 (fix round 1): once the vote is in a block its tx line is on stdout, whatever fails after it, and nothing is
  // sent again. settle failing means the vote's effects are unknown: exit 3. A read failing after it settled: exit 2.
  it("M3: the vote lands but settle fails: exit 3, the tx line on stdout, the error names the tx, nothing sent again", async () => {
    const f = happy();
    f.deps.settle = (async (...a: unknown[]) => {
      (f.calls.settle ??= []).push(a);
      throw new EnvironmentError(`tx ${VOTE_TX}: receipt tree incomplete after 20 tx polls`, `it is on chain: do not sign it again; read tx ${VOTE_TX} later`);
    }) as StageMainDeps["settle"];
    const r = await run(["--covote", "7"], f);
    expect(r.code).toBe(3);
    expect(r.out.slice(1)).toEqual(["the cosigner approves #7 with its own full-access key", `        tx ${VOTE_TX}`]);
    expect(r.err).toEqual([
      `ERROR (environment): the cosigner's vote on #7 landed (tx ${VOTE_TX}) but did not settle: tx ${VOTE_TX}: receipt tree incomplete after 20 tx polls · it is on chain: do not sign it again; look tx ${VOTE_TX} up and read proposal #7 (get_proposal)`,
    ]);
    expect(f.calls.signAndSend).toHaveLength(1);
    expect(f.calls.settle).toHaveLength(1);
    expect(f.calls.proposalStatus).toHaveLength(1); // the pre-check only: nothing is read as a result
  });

  for (const which of ["proposalStatus", "viewAccount"] as const) {
    it(`M2: the vote lands and settles, then ${which} fails: exit 2, the tx line on stdout, the error names the tx`, async () => {
      const f = happy();
      const real = f.deps[which] as (...a: unknown[]) => Promise<unknown>;
      let n = 0;
      // The second call is the read after the vote (the first is the pre-check / the balance before).
      (f.deps as unknown as Record<string, unknown>)[which] = async (...a: unknown[]) => {
        if (++n === 2) throw new EnvironmentError(`${which} failed: HTTP 503`, "check the RPC endpoint");
        return real(...a);
      };
      const r = await run(["--covote", "7"], f);
      expect(r.code).toBe(2);
      expect(r.out.slice(1)).toEqual(["the cosigner approves #7 with its own full-access key", `        tx ${VOTE_TX}`]);
      expect(r.err).toEqual([
        `ERROR (environment): the cosigner's vote on #7 landed and settled (tx ${VOTE_TX}), but reading the result failed: ${which} failed: HTTP 503 · it is on chain: do not sign it again; look tx ${VOTE_TX} up and read proposal #7 (get_proposal)`,
      ]);
      expect(f.calls.signAndSend).toHaveLength(1);
      expect(f.calls.settle).toHaveLength(1);
    });
  }

  it("M2: a vote refused at validation is never in a block: no tx line, mustSucceed's line names the hash, exit 2", async () => {
    const f = happy();
    const refused = { ...landed(), raw: readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json") };
    refused.json = JSON.parse(refused.raw);
    f.deps.signAndSend = (async () => refused) as StageMainDeps["signAndSend"];
    const r = await run(["--covote", "7"], f);
    expect(r.code).toBe(2);
    expect(r.out.at(-1)).toBe("the cosigner approves #7 with its own full-access key");
    expect(r.err.at(-1)).toContain("refused at validation (MethodNameMismatch), never in a block");
  });
});

describe("stagedProposals: the driver's [02] pair", () => {
  it("names the grantee for the payout and the attacker and the other DAO in the injected description", () => {
    const { payout, injected } = stagedProposals(STATE);
    expect(JSON.stringify(payout)).toContain(STATE.grantee);
    expect(injected.description).toContain("NOTICE TO AI AGENTS");
    expect(injected.description).toContain(`vote yes in ${STATE.otherDao}`);
    expect(injected.kind).toEqual({ Transfer: { token_id: "", receiver_id: STATE.attacker, amount: (5n * NEAR).toString() } });
  });
});
