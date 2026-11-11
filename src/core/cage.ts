/**
 * DATA CONTRACT #9 `buildCageCard` (RPC-live): the one view model behind R2 (PREVIEW), R5 (CHAIN),
 * R3 `keyhole_inspect`, R4 phases 2 and 5, and R8. Rendering lives in src/render/cage-card.ts.
 *
 * The card never claims more than the chain shows (C-T7a). The renderer prints `card.tools` classifications
 * exactly as given, so they are settled here, against the key as view_access_key returned it:
 * - a call tool whose method is not in the key's method_names (or whose receiver is not the key's) is
 *   `not in allowlist`, whatever the wrap-time dry-run said; the chain's reason comes first, the wrap-time
 *   evidence stays after it;
 * - a tool wrap saw outside the allowlist, but the chain key does list, was never dry-run in scope:
 *   `inconclusive`, with its old evidence kept (a chain reason that evidence carried from wrap is dropped: the
 *   card never prints two reasons that contradict each other);
 * - a method the chain key lists that no in-scope tool covers gets a row of its own (`inconclusive`), and an
 *   empty method_names (any method) gets a `*` row that says so: the card never hides what the key can call.
 *   That includes a key whose receiver is not the session's: the session's tools are refused by the protocol
 *   (`not in allowlist`), and the key's own methods appear as rows marked `(on RECEIVER)`;
 * - no key on chain: nothing is callable, so every call tool is `not in allowlist`.
 * The classifications that agree with the chain (callable, fails-without-deposit) are the wrap-time dry-run's.
 */
import { packHooks } from "../packs/hooks.js";
import { loadTargetPack } from "../packs/index.js";
import { ABSENT_EVIDENCE } from "../render/strings.js";
import { attemptActions } from "./attempt.js";
import { EnvironmentError, InputError } from "./errors.js";
import { viewCodeHash, viewScopedKey } from "./rpc.js";
import type { CageCard, Exposure, ScopedKey, Session, ToolSchema } from "./types.js";

/** The VOTE / VALUE row when a pack declares none (types.ts: TargetPack.exposure). */
const DEFAULT_EXPOSURE: Exposure = { label: "VALUE", value: "anything the signer owns inside the receiver" };

const NOT_IN_ALLOWLIST = "not in allowlist" as const;
/** The reason a method outside the key's method_names gets; the wrap-time dry-run writes the same text (one constant). */
const ABSENT = ABSENT_EVIDENCE;
const NO_KEY = "no such key on chain (view_access_key)";

/**
 * Refuses a session whose public key is not `ed25519:` and exactly 32 bytes of base58, before the value reaches
 * an RPC call, a transaction or a screen (C-T2b). The check is Task 2's, reused through attemptActions' DeleteKey
 * path (src/core/attempt.ts publicKeyArg), not copied; the error does not echo the value.
 */
export function assertSessionPublicKey(session: Session): void {
  try {
    attemptActions({ sessionId: session.id, receiverId: session.accountId, action: "DeleteKey", args: { publicKey: session.publicKey }, depositYocto: "0", gasTGas: 0, violates: "none" });
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    throw new InputError([`session ${session.id}: its publicKey is not an ed25519 public key ("ed25519:" and 32 bytes in base58); value not shown`]);
  }
}

/** The pack's exposure, else the default. A session whose pack cannot be found still gets a card (the default is the broad statement). */
async function exposureOf(session: Session): Promise<Exposure> {
  try {
    const pack = await loadTargetPack(session.packId);
    return pack.exposure ? { ...pack.exposure } : { ...DEFAULT_EXPOSURE };
  } catch (e) {
    if (e instanceof InputError) return { ...DEFAULT_EXPOSURE };
    throw e;
  }
}

/**
 * The card's VOTE / VALUE row as the receiver states it (RPC-live, final review I1): the pack's exposure, then what the
 * pack's hooks read from the receiver after a `; ` (sputnik: `quorum N-of-M` from the DAO's get_policy). A pack stating
 * no DAO's quorum is the point: every DAO sets its own, so the card prints only one it read. A read that fails (an
 * EnvironmentError: unreachable RPC, a view that panics on changed code) or a policy with no single count leaves the
 * row as the pack says it, with no quorum; the rest of the card does not depend on it.
 */
export async function cardExposure(session: Session): Promise<Exposure> {
  const base = await exposureOf(session);
  let note: string | null;
  try {
    note = await packHooks(session.packId).exposureNote(session);
  } catch (e) {
    if (e instanceof EnvironmentError) return base;
    throw e;
  }
  return note === null ? base : { ...base, value: `${base.value}; ${note}` };
}

/** The receiver reason this module writes for a key whose receiver is not the session's. */
const wrongReceiverReason = (onChain: string, sessionReceiver: string): string => `the key's receiver on chain is ${onChain}, not ${sessionReceiver}`;

/**
 * wrongReceiverReason with any two account ids, built from the same template so the strip cannot drift from the
 * text it strips (C-T5c). ABSENT and NO_KEY are the other chain reasons. Evidence can carry any of them from an
 * earlier read: this module writes all three, and the wrap-time dry-run writes ABSENT too (src/classify/dry-run.ts
 * ABSENT_EVIDENCE, for a method outside the allowlist).
 */
const WRONG_RECEIVER = (() => {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = wrongReceiverReason("\0", "\0").split("\0");
  return new RegExp(`^${parts.map(escape).join("[^\\s,;]+")}`);
})();

/** `evidence` without leading chain reasons (and their `; `), so a new reason does not stack on, or contradict, an old one. */
function withoutChainReason(evidence: string | undefined): string {
  let rest = evidence ?? "";
  for (;;) {
    const before = rest;
    for (const reason of [ABSENT, NO_KEY]) if (rest.startsWith(reason)) rest = rest.slice(reason.length);
    rest = rest.replace(WRONG_RECEIVER, "").replace(/^;\s*/, "");
    if (rest === before) return rest;
  }
}

/** `reason`, then the tool's earlier evidence after a semicolon, minus any chain reason it carried. */
function withReason(reason: string, prior: string | undefined): string {
  const rest = withoutChainReason(prior);
  return rest === "" ? reason : `${reason}; ${rest}`;
}

function notInAllowlist(tool: ToolSchema, reason: string): ToolSchema {
  return { ...tool, classification: NOT_IN_ALLOWLIST, evidence: withReason(reason, tool.evidence) };
}

/**
 * The session's tools as the key read says they are (see the header). `key` null is a key the chain does not
 * have. Returns new objects; the session's own tools are not touched.
 */
function toolsAgainstKey(session: Session, key: ScopedKey | null): ToolSchema[] {
  if (key === null) return session.tools.map((t) => (t.kind === "call" && t.method !== null ? notInAllowlist(t, NO_KEY) : { ...t }));

  const sameReceiver = key.receiverId === session.receiverId;
  const anyMethod = key.methodNames.length === 0;
  const listed = new Set(key.methodNames);
  const wrongReceiver = wrongReceiverReason(key.receiverId, session.receiverId);
  const inScope = anyMethod ? "the key's method_names is empty on chain: every method is allowed" : "listed in the key's method_names (chain)";

  // Chain methods that already have a row which does not say `not in allowlist`.
  const covered = new Set<string>();
  const where = sameReceiver ? "" : ` (on ${key.receiverId})`;
  const extra = (method: string, evidence: string): ToolSchema => ({ name: `chain:${method}`, kind: "call", method, argsSchema: {}, gasTGas: 0, classification: "inconclusive", evidence });
  const rowFor = (method: string): ToolSchema => extra(method, `listed in the key's method_names (chain)${where}; no wrap-time dry-run covers it`);

  const tools: ToolSchema[] = [];
  for (const t of session.tools) {
    if (t.kind !== "call" || t.method === null) {
      tools.push({ ...t });
    } else if (!sameReceiver) {
      // This tool calls the session's receiver, which the key cannot reach. The key's own method of that name,
      // on its own receiver, goes first: the renderer shows a method once, from its first row.
      if (listed.has(t.method) && !covered.has(t.method)) {
        tools.push(rowFor(t.method));
        covered.add(t.method);
      }
      tools.push(notInAllowlist(t, wrongReceiver));
    } else if (!anyMethod && !listed.has(t.method)) {
      tools.push(notInAllowlist(t, ABSENT));
    } else {
      covered.add(t.method);
      // In scope on chain. Wrap saw it outside the allowlist, so no dry-run ever ran it in scope.
      tools.push(t.classification === NOT_IN_ALLOWLIST ? { ...t, classification: "inconclusive", evidence: withReason(`${inScope}; not dry-run in scope at wrap`, t.evidence) } : { ...t });
    }
  }

  // What the chain key can call that no row above covers: a row each, so the card never hides it.
  for (const method of listed) if (!covered.has(method)) tools.push(rowFor(method));
  if (anyMethod) tools.push(extra("*", `the key's method_names is empty on chain: it may call ANY method of ${key.receiverId}`));
  return tools;
}

/**
 * "preview" makes no RPC call: the requested scope is the key (nonce 0, the whole allowance), the pin is the
 * code hash, and the tools are the wrap-time dry-run's. "chain" reads the key (view_access_key), the code
 * hash (view_account) and the exposure row (cardExposure: the sputnik DAO's get_policy) in parallel; chain wins
 * over the session file. `key: null` with source "chain" is a key the chain does not have (burned). `readAt` is an
 * ISO string.
 *
 * `opts.exposure` is a row the caller already read (wrap reads it with cardExposure before the preview; offline tests
 * feed one): it is used as given, and the chain card then reads no policy. Without it a preview prints the pack's
 * row, with no quorum: a preview reads nothing.
 */
export async function buildCageCard(session: Session, source: "preview" | "chain", opts: { exposure?: Exposure } = {}): Promise<CageCard> {
  assertSessionPublicKey(session);
  const given = opts.exposure ? { ...opts.exposure } : undefined;
  if (source === "preview") {
    const key: ScopedKey = {
      publicKey: session.publicKey,
      accountId: session.accountId,
      receiverId: session.receiverId,
      methodNames: [...session.methodNames],
      allowanceRemainingYocto: session.allowanceYocto,
      nonce: 0,
    };
    return { session, key, tools: toolsAgainstKey(session, key), codeHashNow: session.codeHashPin, source, readAt: new Date().toISOString(), exposure: given ?? (await exposureOf(session)) };
  }
  const [key, codeHashNow, exposure] = await Promise.all([viewScopedKey(session), viewCodeHash(session.network, session.receiverId), given ?? cardExposure(session)]);
  return { session, key, tools: toolsAgainstKey(session, key), codeHashNow, source, readAt: new Date().toISOString(), exposure };
}
