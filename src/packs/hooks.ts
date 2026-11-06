/**
 * Per-pack call hooks (Task 9): how serve turns a tool's input into contract arguments, and what it
 * reports after a call lands. A pack without hooks passes the input through and reports nothing extra.
 */
import type { Session, ToolSchema } from "../core/types.js";
import { actProposalArgs, proposalLine, proposalStatus, voteInput } from "./sputnik-v2.js";

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
}

const passThrough: PackHooks = {
  callArgs: async (_session, _tool, input) => ({ ...input }),
  afterCall: async () => null,
};

/**
 * sputnik-v2: the act_proposal tool (dao_vote) takes `{id, action: approve | reject, memo?}`, checked
 * against its schema before any RPC, and sends the 4-arg form with the stored kind (actProposalArgs). After
 * it lands, the proposal is read back: `proposal #N STATUS (A of R approvals)`, and structured
 * `{id, status, approvals, required}`. Every other tool passes through.
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
};

const HOOKS: ReadonlyMap<string, PackHooks> = new Map([["sputnik-v2", sputnikV2]]);

/** The hooks of pack `packId`; any pack without its own (counter, near-abi packs) passes through. */
export function packHooks(packId: string): PackHooks {
  return HOOKS.get(packId) ?? passThrough;
}
