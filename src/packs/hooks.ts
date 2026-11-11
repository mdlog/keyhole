/**
 * Per-pack call hooks (Task 9): how serve turns a tool's input into contract arguments, what it reports after a
 * call lands, and what the receiver itself says on the cage card's VOTE / VALUE row (final review I1). A pack
 * without hooks passes the input through, reports nothing extra and reads nothing for the card.
 */
import { callView } from "../core/rpc.js";
import type { Session, ToolSchema } from "../core/types.js";
import { actProposalArgs, proposalLine, proposalStatus, quorumNote, voteInput } from "./sputnik-v2.js";

export interface PackHooks {
  /** The contract arguments for a call tool's input (sputnik-v2: the 4-arg act_proposal form). */
  callArgs(session: Session, tool: ToolSchema, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * Extra result after a call lands (sputnik-v2: the proposal's status), or null. `input` is the TOOL input,
   * the same object callArgs received (sputnik-v2 dao_vote: `{id, action, memo?}`), never callArgs' result
   * (the 4-arg contract args). It reads the chain after the tx is already in a block: if it throws, report the
   * landed tx anyway and never send the call again.
   */
  afterCall(session: Session, tool: ToolSchema, input: Record<string, unknown>): Promise<{ text: string; structured: Record<string, unknown> } | null>;
  /**
   * Words read from the receiver that end the cage card's exposure row, or null when there is nothing to add
   * (sputnik: `quorum N-of-M` from get_policy, final). RPC-live; a failed read throws, and the card leaves it out.
   */
  exposureNote(session: Session): Promise<string | null>;
}

const passThrough: PackHooks = {
  callArgs: async (_session, _tool, input) => ({ ...input }),
  afterCall: async () => null,
  exposureNote: async () => null,
};

/**
 * sputnik-v2: the act_proposal tool (dao_vote) takes `{id, action: approve | reject, memo?}`, checked
 * against its schema before any RPC, and sends the 4-arg form with the stored kind (actProposalArgs). After
 * it lands, the proposal is read back: `proposal #N STATUS (A of R approvals)`, and structured
 * `{id, status, approvals, required}`. Every other tool passes through. The card's VOTE row ends with the DAO's
 * own quorum, read with get_policy (quorumNote): never a pack constant, since every DAO sets its own.
 */
const sputnikV2: PackHooks = {
  async callArgs(session, tool, input) {
    if (tool.method !== "act_proposal") return { ...input };
    return actProposalArgs(session, voteInput(input));
  },
  async afterCall(session, tool, input) {
    if (tool.method !== "act_proposal") return null;
    const { id } = voteInput(input);
    const status = await proposalStatus(session, id);
    return { text: proposalLine(id, status), structured: { id, ...status } };
  },
  async exposureNote(session) {
    return quorumNote(await callView(session, "get_policy", {}));
  },
};

/**
 * Both Sputnik packs share the hooks (C-T20c): sputnik-v2-331 is sputnik-v2 pinned to the sputnikv2.testnet factory's
 * v3.31 code, whose act_proposal takes the same 4-arg form. Load-bearing: a pack id missing here passes dao_vote's
 * `{id, action}` straight through as the contract args, and the vote panics in the contract.
 */
const HOOKS: ReadonlyMap<string, PackHooks> = new Map([
  ["sputnik-v2", sputnikV2],
  ["sputnik-v2-331", sputnikV2],
]);

/** The hooks of pack `packId`; any pack without its own (counter, near-abi packs) passes through. */
export function packHooks(packId: string): PackHooks {
  return HOOKS.get(packId) ?? passThrough;
}
