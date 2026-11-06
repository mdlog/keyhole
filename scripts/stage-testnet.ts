/**
 * Testnet staging for the video (Task 21; PRD §8 12–35 s, Take B): the proposals the agent reads and votes on, and
 * the cosigner's deciding vote after the agent's. It signs with the cosigner's full-access key only (the keychain's,
 * read by loadFullAccessKey): never the seat's, never a session key. It prints no key.
 *
 *   KEYHOLE_OPERATOR=<account>.testnet npm run stage:testnet -- --proposals
 *     the cosigner adds a fresh grant payout (0.01 NEAR to the grantee) and the injected proposal (the spike's
 *     description, 5 NEAR to the attacker), the demo driver's [02] pair, each with the DAO's 0.1 NEAR bond; prints
 *     their ids. Each run leaves 0.2 NEAR of bonds in the DAO: the payout's comes back when it is approved, the
 *     injected one's stays until that proposal expires (168 h).
 *   KEYHOLE_OPERATOR=<account>.testnet npm run stage:testnet -- --covote ID
 *     the cosigner approves #ID with its own full-access key, after the agent's vote, and the payout runs:
 *     prints `proposal #ID Approved · payout executed`.
 *
 * Before anything is signed:
 * - the operator's demo state is read and its DAO verified by Task 15's checkTestnetDemo, which signs nothing (chain
 *   id testnet first; code_hash = the pack's pin, council {seat, cosigner}, 2-of-2 on every kind, no other voter).
 *   A missing or unverified DAO stops here: staging never creates one (that is `npm run bootstrap:testnet`);
 * - --proposals: get_policy's proposal_bond must be the pack's 0.1 NEAR, the bond the driver attaches, and the
 *   cosigner must hold enough for both sends (2 × (bond + 100 TGas of prepaid gas at the minimum price) = 0.4 NEAR);
 * - --covote: get_proposal must show #ID as a NEAR transfer to the grantee (never the injected proposal), InProgress,
 *   not yet voted by the cosigner, and one approval short of passing, so the cosigner's vote is the deciding one.
 *
 * Exit codes: 0 done · 1 the vote landed but #ID is not Approved with its payout · 2 an input or environment error with
 * nothing signed, or a vote that landed and failed, or landed and settled with a failed read after it (its line names
 * the tx) · 3 a send whose fate is unknown, or a vote that landed and did not settle (its line names the tx). Once a
 * vote is in a block (or its fate is unknown) its `tx HASH` line is on stdout, whatever fails after it; nothing is
 * ever sent again. Testnet only by construction: the CLI path builds a testnet cast from the testnet state;
 * addProposal and signAndSend check the account suffixes and the chain id again.
 *
 * The functions below take a cast and a network, so the sandbox suite runs the same code against a local DAO
 * (test-sandbox/stage.sandbox.test.ts). Importing this module runs nothing.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type KeyPair, actions } from "near-api-js";
import { MIN_GAS_PRICE, NEAR, TGAS, formatNear } from "../src/core/amounts.js";
import { loadFullAccessKey } from "../src/core/credentials.js";
import { EnvironmentError, InputError, KeyholeError, TxSentError } from "../src/core/errors.js";
import { bodyState } from "../src/core/outcome.js";
import { callView, viewAccount } from "../src/core/rpc.js";
import { SendFateUnknownError, type SentTx, mustSucceed, settle, signAndSend } from "../src/core/tx.js";
import type { Network, Session } from "../src/core/types.js";
import { injectionDescription, proposalsLabel } from "../src/demo/driver.js";
import { checkTestnetDemo } from "../src/demo/testnet-setup.js";
import { loadTargetPack } from "../src/packs/index.js";
import { addProposal, councilInitArgs } from "../src/packs/sputnik-setup.js";
import { type ProposalStatus, actProposalArgs, proposalStatus } from "../src/packs/sputnik-v2.js";

export const USAGE = "usage: KEYHOLE_OPERATOR=<account>.testnet npm run stage:testnet -- --proposals | --covote ID";

/** #A pays the grantee 0.01 NEAR; #B, the injected one, would pay the attacker 5 NEAR (the driver's [02] amounts). */
export const PAYOUT_YOCTO = NEAR / 100n;
export const INJECTED_PAYOUT_YOCTO = 5n * NEAR;
/** Gas the cosigner's full-access vote attaches (PRD §7; the driver's [05]). */
export const COSIGNER_GAS = 100n * TGAS;
/** Gas each add_proposal attaches (sputnik-setup.ts: full-access transactions attach 100 TGas, PRD §7). */
const ADD_PROPOSAL_GAS = 100n * TGAS;
const VOTE_METHOD = "act_proposal";
const PACK_ID = "sputnik-v2";
/** A continuation row: the step log's 8-column indent. */
const INDENT = " ".repeat(8);

/** Who signs and who is paid. The cosigner's key is in memory; on testnet it comes from the keychain. */
export interface StageCast {
  network: Network;
  dao: string;
  cosigner: string;
  cosignerKey: KeyPair;
  grantee: string;
  attacker: string;
  otherDao: string;
}

/** The chain functions staging calls. Tests replace any of them; the defaults are the program's own. */
export interface StageDeps {
  addProposal: typeof addProposal;
  signAndSend: typeof signAndSend;
  settle: typeof settle;
  callView: typeof callView;
  viewAccount: typeof viewAccount;
  proposalStatus: typeof proposalStatus;
  actProposalArgs: typeof actProposalArgs;
}

/** What the CLI path adds: the state loader (read-only) and the keychain read. */
export interface StageMainDeps extends StageDeps {
  checkTestnetDemo: typeof checkTestnetDemo;
  loadFullAccessKey: typeof loadFullAccessKey;
}

const DEFAULT_DEPS: StageMainDeps = { addProposal, signAndSend, settle, callView, viewAccount, proposalStatus, actProposalArgs, checkTestnetDemo, loadFullAccessKey };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** An error's own words, for a line that wraps it. */
const reasonOf = (e: unknown): string => (e instanceof EnvironmentError ? e.what : e instanceof KeyholeError ? e.line() : e instanceof Error ? e.message : String(e));
const transfer = (receiver: string, yocto: bigint) => ({ Transfer: { token_id: "", receiver_id: receiver, amount: yocto.toString() } });

/**
 * callView and the Sputnik readers take a Session but read only its network and receiver: this one names the DAO.
 * It holds no key and is never signed with (the driver's daoReader).
 */
function daoReader(cast: StageCast): Session {
  return { id: "ks-0000", mode: "on-account", network: cast.network, accountId: cast.dao, receiverId: cast.dao, methodNames: [], allowanceYocto: "0", codeHashPin: "", publicKey: "", createdAt: "", status: "live", packId: PACK_ID, tools: [] };
}

/** The demo driver's [02] pair (src/demo/driver.ts), word for word: the grant payout and the injected proposal. */
export function stagedProposals(cast: Pick<StageCast, "grantee" | "attacker" | "otherDao">): { payout: Record<string, unknown>; injected: Record<string, unknown> } {
  return {
    payout: { description: `Grant payout: ${formatNear(PAYOUT_YOCTO)} NEAR to ${cast.grantee} for milestone 1 (docs translation).`, kind: transfer(cast.grantee, PAYOUT_YOCTO) },
    injected: { description: injectionDescription(cast.attacker, cast.otherDao), kind: transfer(cast.attacker, INJECTED_PAYOUT_YOCTO) },
  };
}

/** get_policy's proposal_bond, which must be the pack's (0.1 NEAR): the bond each add_proposal attaches. */
export async function daoBond(cast: StageCast, deps: Pick<StageDeps, "callView"> = DEFAULT_DEPS): Promise<bigint> {
  const pack = await loadTargetPack(PACK_ID);
  // The bond does not depend on the council's ids: any pair fills the placeholders.
  const packBond = BigInt((councilInitArgs(pack, "seat", "cosigner").policy as { proposal_bond: string }).proposal_bond);
  const policy = await deps.callView(daoReader(cast), "get_policy", {});
  const raw = isObj(policy) ? policy.proposal_bond : undefined;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw) || BigInt(raw) !== packBond) {
    throw new EnvironmentError(`${cast.dao}: proposal_bond ${JSON.stringify(raw)}, not the pack's ${formatNear(packBond)} NEAR`, "stage on the operator's demo DAO: npm run bootstrap:testnet -- --check");
  }
  return packBond;
}

export interface StagedProposals {
  payout: { id: number; txHash: string };
  injected: { id: number; txHash: string };
  bondYocto: bigint;
}

/** --proposals: the payout, then the injected proposal, each printed (`log`) as soon as it lands. Ids come from add_proposal. */
export async function stageProposals(cast: StageCast, opts: { deps?: StageDeps; log?: (line: string) => void } = {}): Promise<StagedProposals> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const log = opts.log ?? (() => undefined);
  const bond = await daoBond(cast, deps);
  // Both sends must be affordable before the first one: each attaches the bond and prepays its gas (at least the
  // minimum gas price). Otherwise the injected proposal could fail after the payout already landed.
  const need = 2n * (bond + ADD_PROPOSAL_GAS * MIN_GAS_PRICE);
  const funds = await deps.viewAccount(cast.network, cast.cosigner);
  if (!funds || BigInt(funds.amountYocto) < need) {
    const has = funds ? `has ${formatNear(funds.amountYocto)} NEAR` : "does not exist";
    throw new EnvironmentError(`${cast.cosigner} ${has}; two proposals need ${formatNear(need)} NEAR (each: the ${formatNear(bond)} NEAR bond + 100 TGas of prepaid gas)`, "fund the cosigner, then stage again; nothing was signed");
  }
  const { payout, injected } = stagedProposals(cast);
  const a = await deps.addProposal(cast.network, cast.cosigner, cast.cosignerKey, cast.dao, payout, bond);
  log(`proposal #${a.id} (grant payout) · ${formatNear(PAYOUT_YOCTO)} NEAR to ${cast.grantee}`);
  log(`${INDENT}tx ${a.sent.txHash}`);
  const b = await deps.addProposal(cast.network, cast.cosigner, cast.cosignerKey, cast.dao, injected, bond);
  log(`proposal #${b.id} (injected description) · ${formatNear(INJECTED_PAYOUT_YOCTO)} NEAR to ${cast.attacker}`);
  log(`${INDENT}tx ${b.sent.txHash}`);
  if (a.id === b.id) throw new EnvironmentError(`add_proposal returned id ${a.id} twice (tx ${a.sent.txHash}, tx ${b.sent.txHash})`, "read get_last_proposal_id on the DAO before staging again");
  return { payout: { id: a.id, txHash: a.sent.txHash }, injected: { id: b.id, txHash: b.sent.txHash }, bondYocto: bond };
}

export interface CoVote {
  txHash: string;
  /** proposalStatus after the vote settled. */
  status: ProposalStatus;
  /** The payout the proposal names, and what the grantee's balance moved by across the vote (null: no account). */
  amountYocto: bigint;
  paidYocto: bigint | null;
}

/**
 * --covote ID: the cosigner's approval of the grant payout #ID, sent once, settled; then the status and the grantee's
 * balance are read again. Every check that can refuse runs before signing (InputError, exit 2, nothing signed).
 * `log` gets one line right before the send and, once the vote is in a block (or its fate is unknown), the
 * `tx HASH` line, before anything that can fail after it: settle failing is a TxSentError (exit 3), a read after it
 * failing an EnvironmentError (exit 2); both name the tx. Nothing is ever sent again.
 */
export async function coVote(cast: StageCast, id: number, opts: { deps?: StageDeps; log?: (line: string) => void } = {}): Promise<CoVote> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const log = opts.log ?? (() => undefined);
  if (!Number.isSafeInteger(id) || id < 0) throw new InputError([`--covote takes a proposal id, an integer >= 0 (got ${JSON.stringify(id)})`]);
  const reader = daoReader(cast);
  const p = await deps.callView(reader, "get_proposal", { id });
  if (!isObj(p) || p.id !== id || typeof p.status !== "string") {
    throw new EnvironmentError(`get_proposal ${id} on ${cast.dao} returned no proposal #${id}`, "use the payout id that --proposals printed");
  }
  const t = isObj(p.kind) && isObj(p.kind.Transfer) ? p.kind.Transfer : undefined;
  if (!t || t.token_id !== "" || t.receiver_id !== cast.grantee || typeof t.amount !== "string" || !/^[0-9]+$/.test(t.amount)) {
    throw new InputError([`proposal #${id} is not a NEAR payout to ${cast.grantee}: the cosigner co-votes only the grant payout, never the injected proposal`]);
  }
  if (p.status !== "InProgress") throw new InputError([`proposal #${id} is ${p.status}, not InProgress: there is nothing to vote on`]);
  if (isObj(p.votes) && Object.hasOwn(p.votes, cast.cosigner)) throw new InputError([`${cast.cosigner} has already voted on proposal #${id}`]);
  const before = await deps.proposalStatus(reader, id);
  if (before.approvals + 1 < before.required) {
    throw new InputError([`proposal #${id} has ${before.approvals} of ${before.required} approvals: the cosigner's vote would not decide it; the agent votes first (dao_vote)`]);
  }

  const balanceBefore = await deps.viewAccount(cast.network, cast.grantee);
  const args = await deps.actProposalArgs(reader, { id, action: "approve" });
  log(`the cosigner approves #${id} with its own full-access key`);
  let sent: SentTx;
  try {
    sent = await deps.signAndSend(cast.network, cast.cosigner, cast.cosignerKey, cast.dao, [actions.functionCall(VOTE_METHOD, args, COSIGNER_GAS, 0n)]);
  } catch (e) {
    // Sent, fate unknown: the hash computed before sending is the one to look up. The error exits 3; nothing is re-sent.
    if (e instanceof SendFateUnknownError) log(`${INDENT}tx ${e.txHash} · fate unknown`);
    throw e;
  }
  // In a block: its line is printed now, so whatever fails after this still leaves the hash on stdout.
  const landed = bodyState(sent.raw);
  if (landed === "landed-ok" || landed === "landed-failed") log(`${INDENT}tx ${sent.txHash}`);
  mustSucceed(`the cosigner's vote on #${id}`, sent);
  const onChain = `it is on chain: do not sign it again; look tx ${sent.txHash} up and read proposal #${id} (get_proposal)`;
  try {
    await deps.settle(cast.network, sent.txHash, cast.cosigner);
  } catch (e) {
    // Landed, not settled: what its receipts did is unknown (exit 3, like LandedUnsettledError).
    throw new TxSentError(`the cosigner's vote on #${id} landed (tx ${sent.txHash}) but did not settle: ${reasonOf(e)}`, onChain);
  }
  let status: ProposalStatus;
  let balanceAfter: Awaited<ReturnType<StageDeps["viewAccount"]>>;
  try {
    status = await deps.proposalStatus(reader, id);
    balanceAfter = await deps.viewAccount(cast.network, cast.grantee);
  } catch (e) {
    // Landed and settled; only the read back failed (exit 2, the tx named: as wrap, burn and bootstrap do).
    throw new EnvironmentError(`the cosigner's vote on #${id} landed and settled (tx ${sent.txHash}), but reading the result failed: ${reasonOf(e)}`, onChain);
  }
  const paid = balanceBefore && balanceAfter ? BigInt(balanceAfter.amountYocto) - BigInt(balanceBefore.amountYocto) : null;
  return { txHash: sent.txHash, status, amountYocto: BigInt(t.amount), paidYocto: paid };
}

/** The final --covote line: exit 0 only when #ID is Approved and the grantee received exactly its payout. */
export function coVoteVerdict(id: number, cast: Pick<StageCast, "grantee">, r: CoVote): { line: string; exitCode: 0 | 1 } {
  const approved = r.status.status === "Approved" && r.status.approvals >= r.status.required;
  const paid = r.paidYocto === r.amountYocto;
  if (approved && paid) return { line: `proposal #${id} Approved · payout executed`, exitCode: 0 };
  const moved = r.paidYocto === null ? `${cast.grantee} does not exist (view_account)` : `${cast.grantee} moved ${r.paidYocto} yocto, not +${r.amountYocto}`;
  return { line: `FAIL: proposal #${id} ${r.status.status} (${r.status.approvals} of ${r.status.required} approvals) · ${moved}`, exitCode: 1 };
}

type StageCommand = { kind: "proposals" } | { kind: "covote"; id: number };

/** `--proposals`, or `--covote ID` / `--covote=ID`; anything else is an InputError. */
export function parseStageArgs(argv: readonly string[]): StageCommand {
  if (argv.length === 1 && argv[0] === "--proposals") return { kind: "proposals" };
  const raw = argv.length === 2 && argv[0] === "--covote" ? argv[1] : argv.length === 1 && argv[0].startsWith("--covote=") ? argv[0].slice("--covote=".length) : undefined;
  if (raw === undefined) throw new InputError([`expected --proposals or --covote ID (got ${argv.length ? argv.join(" ") : "nothing"})`]);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new InputError([`--covote takes a proposal id, an integer >= 0 (got ${JSON.stringify(raw)})`]);
  return { kind: "covote", id: Number(raw) };
}

export interface StageIo {
  out(line: string): void;
  err(line: string): void;
}

/** The CLI: one command, its lines on stdout, an error's one line on stderr; returns the exit code. */
export async function stageMain(argv: readonly string[], io: StageIo, env: NodeJS.ProcessEnv = process.env, overrides: Partial<StageMainDeps> = {}): Promise<number> {
  const deps: StageMainDeps = { ...DEFAULT_DEPS, ...overrides };
  try {
    const cmd = parseStageArgs(argv);
    const { state } = await deps.checkTestnetDemo(env);
    io.out(`DAO ${state.dao} · verified: code_hash = pack pin · council [seat, cosigner] · 2-of-2`);
    const cast: StageCast = {
      network: "testnet",
      dao: state.dao,
      cosigner: state.cosigner,
      cosignerKey: deps.loadFullAccessKey("testnet", state.cosigner, env),
      grantee: state.grantee,
      attacker: state.attacker,
      otherDao: state.otherDao,
    };
    if (cmd.kind === "proposals") {
      const staged = await stageProposals(cast, { deps, log: io.out });
      io.out(`${proposalsLabel(staged.payout.id, staged.injected.id)} · bond ${formatNear(staged.bondYocto)} NEAR each`);
      return 0;
    }
    const r = await coVote(cast, cmd.id, { deps, log: io.out });
    if (r.paidYocto !== null) io.out(`${INDENT}${cast.grantee} +${formatNear(r.paidYocto)} NEAR (view_account before and after)`);
    const verdict = coVoteVerdict(cmd.id, cast, r);
    io.out(verdict.line);
    return verdict.exitCode;
  } catch (e) {
    if (e instanceof InputError && /^expected --proposals/.test(e.problems[0] ?? "")) io.err(USAGE);
    io.err(e instanceof KeyholeError ? e.line() : `ERROR (environment): ${(e as Error).message}`);
    return e instanceof KeyholeError ? e.exitCode : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await stageMain(process.argv.slice(2), { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}
