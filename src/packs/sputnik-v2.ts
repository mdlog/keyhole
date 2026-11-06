/**
 * Sputnik v2 pack code. DATA CONTRACT #13 `proposalStatus` (RPC-live): R3 `dao_vote` result and R4
 * phase 3 (`proposal #0 InProgress (1 of 2)`).
 *
 * Counts are the council role's: the pack's DAO policy (sandboxFixture.init) names its voting Group
 * `council`, and so do the DAOs the testnet factory creates from it. The threshold math is sputnikdao2
 * v2.0.0's policy.rs (spike step b): for RoleWeight, threshold = max(quorum, min(num × size / den + 1, size)),
 * with a Weight threshold capped at the size, and the role's per-kind vote policy taking precedence over
 * the default one.
 */
import { EnvironmentError, InputError } from "../core/errors.js";
import { callView } from "../core/rpc.js";
import type { Session } from "../core/types.js";

/** The voting role whose counts and threshold are reported. */
export const COUNCIL_ROLE = "council";

export interface ProposalStatus {
  status: string;
  approvals: number;
  required: number;
}

/** One dao_vote, as an agent asks for it. */
export interface Vote {
  id: number;
  action: "approve" | "reject";
  memo?: string;
}

const VOTE_ACTIONS = { approve: "VoteApprove", reject: "VoteReject" } as const;
const VOTE_KEYS: readonly string[] = ["id", "action", "memo"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isProposalId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const NOT_A_DAO = "check that the receiver is a Sputnik v2 DAO";

/**
 * A dao_vote input checked against the tool's schema: `id` an integer >= 0, `action` approve or reject,
 * `memo` a string if given (null counts as absent), nothing else. InputError otherwise, before any RPC.
 */
export function voteInput(input: Record<string, unknown>): Vote {
  const problems: string[] = [];
  const extra = Object.keys(input).filter((k) => !VOTE_KEYS.includes(k));
  if (extra.length) problems.push(`a vote takes id, action and memo only (got ${extra.join(", ")})`);
  if (!isProposalId(input.id)) problems.push(`id must be a proposal id, an integer >= 0 (got ${JSON.stringify(input.id) ?? "nothing"})`);
  if (input.action !== "approve" && input.action !== "reject") problems.push(`action must be "approve" or "reject" (got ${JSON.stringify(input.action) ?? "nothing"})`);
  if (input.memo !== undefined && input.memo !== null && typeof input.memo !== "string") problems.push("memo must be a string");
  if (problems.length) throw new InputError(problems);
  const vote: Vote = { id: input.id as number, action: input.action as Vote["action"] };
  if (typeof input.memo === "string") vote.memo = input.memo;
  return vote;
}

/** The dao_vote result line: `proposal #0 InProgress (1 of 2 approvals)`. */
export function proposalLine(id: number, s: ProposalStatus): string {
  return `proposal #${id} ${s.status} (${s.approvals} of ${s.required} approvals)`;
}

/** get_proposal for `id`, shape-checked: the reply must be that proposal, with a status and a kind. */
async function getProposal(session: Session, id: number): Promise<Record<string, unknown>> {
  if (!isProposalId(id)) throw new InputError([`not a proposal id: ${JSON.stringify(id) ?? String(id)}`]);
  const p = await callView(session, "get_proposal", { id });
  if (!isObj(p) || p.id !== id || typeof p.status !== "string" || p.kind === undefined || p.kind === null) {
    throw new EnvironmentError(`get_proposal ${id} on ${session.receiverId} returned no proposal #${id}`, NOT_A_DAO);
  }
  return p;
}

/** A count as sputnikdao2 serializes it: a JSON number (v2.0.0) or a U128 decimal string (2.3.x). */
function toCount(v: unknown, what: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new EnvironmentError(`get_policy / get_proposal: ${what} is not a count (${JSON.stringify(v)})`, NOT_A_DAO);
}

/** The council's approvals on a proposal: vote_counts.council[0] (Approve), 0 before anyone in the role voted. */
function approvalsOf(p: Record<string, unknown>): number {
  const counts = isObj(p.vote_counts) ? p.vote_counts[COUNCIL_ROLE] : undefined;
  if (counts === undefined) return 0;
  if (!Array.isArray(counts) || counts.length !== 3) {
    throw new EnvironmentError(`get_proposal ${String(p.id)}: vote_counts.${COUNCIL_ROLE} is not [approve, reject, remove]`, NOT_A_DAO);
  }
  return Number(toCount(counts[0], `vote_counts.${COUNCIL_ROLE}[0]`));
}

/**
 * #13 proposalStatus (RPC-live): get_proposal (status and the council's approvals), then get_policy (the
 * approvals the council needs for this proposal's kind). Both are final reads.
 */
export async function proposalStatus(session: Session, id: number): Promise<ProposalStatus> {
  const p = await getProposal(session, id);
  const policy = await callView(session, "get_policy", {});
  return { status: p.status as string, approvals: approvalsOf(p), required: requiredApprovals(policy, p.kind) };
}

/**
 * dao_vote → act_proposal arguments. Always the 4-arg form {id, action, proposal: stored kind, memo}:
 * it is accepted by both deployed testnet builds and required by sputnikdao2 main 2.3.1
 * (SPIKE_REPORT Gotcha 5; vendor/VENDORED.md §4). The stored kind is read with get_proposal and sent back
 * as the contract returned it; with no memo the key is still sent, as null (`memo: Option<String>`).
 */
export async function actProposalArgs(session: Session, vote: { id: number; action: "approve" | "reject"; memo?: string }): Promise<Record<string, unknown>> {
  const v = voteInput({ ...vote });
  const p = await getProposal(session, v.id);
  return { id: v.id, action: VOTE_ACTIONS[v.action], proposal: p.kind, memo: v.memo ?? null };
}

/**
 * sputnikdao2's policy label of a proposal kind (`ProposalKind::to_policy_label`): the variant name in
 * snake_case without a leading "Change", except FunctionCall → call and SetStakingContract → set_vote_token.
 */
function policyLabel(kind: unknown): string | undefined {
  const variant = typeof kind === "string" ? kind : isObj(kind) && Object.keys(kind).length === 1 ? Object.keys(kind)[0] : undefined;
  if (!variant) return undefined;
  if (variant === "FunctionCall") return "call";
  if (variant === "SetStakingContract") return "set_vote_token";
  return variant.replace(/^Change(?=[A-Z])/, "").replace(/[A-Z]/g, (c, i: number) => (i ? "_" : "") + c.toLowerCase());
}

/**
 * Approvals the council role needs to pass a proposal, from a get_policy result: for RoleWeight,
 * threshold = max(quorum, min(num × size / den + 1, size)) (PRD §7). With `kind` (a proposal's stored kind),
 * the council's vote policy for that kind applies when it has one. EnvironmentError when the policy has no
 * council Group, or counts token weight (TokenWeight approvals are stake, not members).
 */
export function requiredApprovals(policy: unknown, kind?: unknown): number {
  const bad = (why: string) => new EnvironmentError(`get_policy: ${why}`, NOT_A_DAO);
  if (!isObj(policy) || !Array.isArray(policy.roles)) throw bad("no roles");
  const role = policy.roles.find((r) => isObj(r) && r.name === COUNCIL_ROLE);
  if (!isObj(role)) throw bad(`no ${COUNCIL_ROLE} role (roles: ${policy.roles.map((r) => (isObj(r) ? String(r.name) : "?")).join(", ") || "none"})`);
  const group = isObj(role.kind) ? role.kind.Group : undefined;
  if (!Array.isArray(group)) throw bad(`the ${COUNCIL_ROLE} role is not a Group of accounts (kind ${JSON.stringify(role.kind)})`);
  const label = kind === undefined ? undefined : policyLabel(kind);
  const perKind = label !== undefined && isObj(role.vote_policy) && Object.hasOwn(role.vote_policy, label) ? role.vote_policy[label] : undefined;
  const vp = perKind ?? policy.default_vote_policy;
  if (!isObj(vp)) throw bad("no vote policy");
  if (vp.weight_kind !== "RoleWeight") throw bad(`weight_kind ${JSON.stringify(vp.weight_kind)}: approvals are counted as token weight, not members`);
  const size = BigInt(group.length);
  let weight: bigint;
  if (Array.isArray(vp.threshold)) {
    if (vp.threshold.length !== 2) throw bad(`threshold ${JSON.stringify(vp.threshold)} is not [num, den]`);
    const num = toCount(vp.threshold[0], "threshold num");
    const den = toCount(vp.threshold[1], "threshold den");
    if (den === 0n) throw bad("threshold has a zero denominator");
    weight = (num * size) / den + 1n;
  } else {
    weight = toCount(vp.threshold, "threshold weight");
  }
  if (weight > size) weight = size;
  const quorum = toCount(vp.quorum, "quorum");
  return Number(quorum > weight ? quorum : weight);
}
