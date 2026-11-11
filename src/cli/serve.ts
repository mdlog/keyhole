/**
 * R3 `keyhole serve ID`: an MCP server over stdio that loads exactly one private key, the session's
 * function-call key. stdout carries MCP frames only; every line meant for humans goes to stderr.
 *
 * Tools (LAYOUT R3 Surface A, in this order): keyhole_inspect, the pack's views, the pack's call tools whose
 * method is in the session's methodNames (never a method the pack declares out of scope), keyhole_attempt. The
 * list is fixed at wrap (Session.tools): building it reads no chain, and the cage card's synthetic rows
 * (`chain:METHOD`, `*`) are never tools (C-T5b).
 *
 * Every signed call goes through sendAttempt with the session key, so the chain does the refusing. The one
 * server-side refusal is the code_hash pin, checked before a pack call tool signs anything. Results:
 * - text from a chain read passes through neutralizeControls (C-T6c, C-T6d), so no control character reaches
 *   the client verbatim; a normal body is unchanged by it;
 * - a landed tx is never sent again: a failed read-back after it (C-T9a), or a refund not seen (C-T2i), is
 *   reported next to the landed tx; a send whose fate is unknown prints its error line verbatim (C-T2i);
 * - only an InvalidAccessKeyError is the key's scope refusing; any other InvalidTxError reads
 *   `chain rejected the tx: NAME` (C-T2k);
 * - every result passes one last filter that replaces the session key's text, should any path ever carry it: the
 *   whole key, or any run of 12 or more of its characters (C-T19h), so a part that a cut left behind is caught too;
 *   text that is cut short has the key's text replaced before the cut, here and in core (rpc.ts printableRpcText).
 *   Only the key's base58 forms are known (keys.ts keyTextRedactor). Redaction never throws (sweep A fix round 1): a
 *   text it could not check is withheld, and a result it could not check is answered with WITHHELD, a tool error,
 *   never an MCP internal error.
 *
 * Before it serves, `keyhole serve` reads the session key once from chain (view_access_key): a key with full
 * access is never served (exit 2); a key the chain no longer has still starts, and the chain refuses its calls.
 * Every send reads it again (tx.ts, C-T19c): a key given full access after serve started is never signed with.
 *
 * A second Ctrl-C (or SIGTERM, SIGHUP) is the hard exit (main.ts): its last words name the session, whose key stays
 * live on chain until `keyhole burn` (C-T17b), and the calls still in flight.
 */
import { Console } from "node:console";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type KeyPair, baseDecode, baseEncode } from "near-api-js";
import { formatNear } from "../core/amounts.js";
import { LandedUnsettledError, predictViolation, sendAttempt } from "../core/attempt.js";
import { buildCageCard } from "../core/cage.js";
import { rpcUrlFor } from "../core/config.js";
import { fullAccessKeyLoadCount } from "../core/credentials.js";
import { EnvironmentError, InputError, KeyholeError } from "../core/errors.js";
import { KEY_NOT_SHOWN, KEY_WINDOW, TEXT_WITHHELD, dropHeldKeys, heldPrivateKeyCount, keyTextRedactor, keyTextWindows, privateKeyTexts, sessionKeyPair } from "../core/keys.js";
import { callView, isNoSuchKey, reasonOf, rpcCall, rpcErrorTextAt, viewCodeHash } from "../core/rpc.js";
import { loadSession } from "../core/session.js";
import { SendFateUnknownError } from "../core/tx.js";
import type { Attempt, AttemptAction, AttemptInput, AttemptOutcome, Network, Refusal, Session, ToolSchema } from "../core/types.js";
import { type PackHooks, packHooks } from "../packs/hooks.js";
import { loadTargetPack } from "../packs/index.js";
import { renderCageCard } from "../render/cage-card.js";
import { chainRejected } from "../render/refusal-block.js";
import { burnedNothingToServe, codeChanged } from "../render/strings.js";
import { neutralizeControls, wrapWords } from "../render/style.js";
import type { TermCaps } from "../render/term.js";
import { renderTxLine } from "../render/tx-line.js";
import { type Command, type Io, sessionIdArg } from "./args.js";

/** Tool order in /mcp (LAYOUT R3 Surface A); the dao_* names come from the session's pack. */
export const META_TOOLS = ["keyhole_inspect", "keyhole_attempt"] as const;

/**
 * Text results are plain and wrap at spaces to 80 columns (LAYOUT R3 "Width"): client panes are narrow. A word
 * longer than 80 (a URL, an unbroken run in an RPC error) stays whole on a line of its own. RPC bodies and view
 * results are never wrapped: they are the chain's bytes. keyhole_inspect's card is laid out for 80 by renderCageCard,
 * which never cuts a hash or a key: its CODE HASH row runs past 80 (84 cells with a 43-character hash).
 */
const PLAIN: TermCaps = Object.freeze({ color: false, unicode: false, width: 80, tty: false });
const TEXT_WIDTH = 80;
const FIRST_SENTENCE_MAX = 80;
const DESCRIPTION_MAX = 300;
/** Names a client can call (the MCP spec's recommended form). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------------------------------
// Copy (local to serve; DESIGN §5.4 and the Task 19 ruling R1)

interface ToolCopy {
  title: string;
  /** Id-free, at most 80 characters: what lands on chain, and with which key. */
  first: string;
  /** One closing sentence. */
  closing: string;
}

const READ_ONLY = "Read-only, no key used.";
const INSPECT_COPY: ToolCopy = {
  title: "Inspect the session's on-chain scope",
  first: "Read this session's on-chain scope: receiver, methods, allowance left.",
  closing: READ_ONLY,
};
const ATTEMPT_COPY: ToolCopy = {
  title: "Attempt any transaction with the session key",
  first: "Signs any transaction with this session's key; returns the raw RPC response.",
  closing: "Refused transactions never reach a block.",
};
/** The Sputnik packs' tool copy: sputnik-v2 and sputnik-v2-331 (C-T20c) declare the same tools. */
const SPUTNIK_COPY: Readonly<Record<string, ToolCopy & { method: string }>> = {
  dao_list_proposals: { method: "get_proposals", title: "List DAO proposals", first: "List proposals of the DAO (get_proposals).", closing: READ_ONLY },
  dao_get_policy: { method: "get_policy", title: "Read the DAO policy", first: "Read the DAO policy: roles, council, vote thresholds (get_policy).", closing: READ_ONLY },
  dao_vote: {
    method: "act_proposal",
    title: "Vote on a DAO proposal",
    first: "Vote approve or reject on a proposal via act_proposal with the session key.",
    closing: "The key does not limit which way the vote goes.",
  },
};
/** Pack tools whose copy is written out (keyed by pack, then tool name; the method must match too). */
const PACK_COPY: Readonly<Record<string, Readonly<Record<string, ToolCopy & { method: string }>>>> = {
  "sputnik-v2": SPUTNIK_COPY,
  "sputnik-v2-331": SPUTNIK_COPY,
};

/** Copy for a pack tool with none written out. A method name that is not plain lowercase is left out of the prose. */
function genericCopy(tool: ToolSchema): ToolCopy {
  const m = tool.method !== null && /^[a-z_][a-z0-9_]*$/.test(tool.method) ? tool.method : null;
  const fit = (s: string | null, fallback: string) => (s !== null && s.length <= FIRST_SENTENCE_MAX ? s : fallback);
  if (tool.kind === "view") {
    return { title: `View ${tool.name}`, first: fit(m && `Calls the view method ${m}.`, "Calls a view method of the receiver."), closing: READ_ONLY };
  }
  return {
    title: `Call ${tool.name}`,
    first: fit(m && `Sends a call to ${m} with the session key.`, "Sends a contract call with the session key."),
    closing: "Returns the tx hash and the chain's answer.",
  };
}

/** An exact NEAR amount with no trailing zeros: 50000000000000000000000 → `0.05`. */
function nearAmount(yocto: string): string {
  return formatNear(yocto, 24).replace(/\.?0+$/, "");
}

/** The chain sentence on every call and meta tool; `compact` counts the methods instead of listing them. */
function chainSentence(s: Session, compact = false): string {
  const names = s.methodNames.map(neutralizeControls);
  const methods = names.length === 0 ? "any method" : names.length === 1 ? `method ${names[0]}` : compact ? `${names.length} methods` : `methods ${names.join(", ")}`;
  return `Chain-enforced key limits: receiver ${neutralizeControls(s.receiverId)}, ${methods}, ${nearAmount(s.allowanceYocto)} NEAR allowance for gas only; no deposit can be attached.`;
}

/** First sentence, chain sentence (call and meta tools), closing sentence; within 300 characters, the closing sentence goes first. */
function description(copy: ToolCopy, session: Session, withChain: boolean): string {
  const tries = withChain
    ? [[copy.first, chainSentence(session), copy.closing], [copy.first, chainSentence(session)], [copy.first, chainSentence(session, true)]]
    : [[copy.first, copy.closing], [copy.first]];
  const texts = tries.map((parts) => parts.join(" "));
  return texts.find((t) => t.length <= DESCRIPTION_MAX) ?? texts[texts.length - 1];
}

// ---------------------------------------------------------------------------------------------------
// The tool list

/** The keyhole_attempt input: the Attempt fields without the outcome (LAYOUT R3). */
const ATTEMPT_ACTIONS: readonly AttemptAction[] = ["FunctionCall", "Transfer", "AddKey", "DeleteKey", "CreateAccount", "DeleteAccount", "DeployContract", "Stake"];
const ATTEMPT_SCHEMA: Tool["inputSchema"] = {
  type: "object",
  properties: {
    receiverId: { type: "string", description: "account id the transaction is sent to" },
    action: { type: "string", enum: [...ATTEMPT_ACTIONS] },
    method: { type: "string", description: "FunctionCall only" },
    args: { type: "object", description: "FunctionCall: the call's JSON arguments; other actions: their fields (e.g. publicKey)" },
    depositYocto: { type: "string", pattern: "^[0-9]+$", description: "yoctoNEAR attached (Transfer amount, Stake amount)" },
    gasTGas: { type: "number", minimum: 0 },
  },
  required: ["receiverId", "action", "depositYocto", "gasTGas"],
  additionalProperties: false,
};

/** The session's views, then its call tools whose method the key allows, minus what the pack declares out of scope. */
async function servedPackTools(session: Session): Promise<ToolSchema[]> {
  const outOfScope = new Set((await loadTargetPack(session.packId)).outOfScope.map((m) => m.method));
  const taken = new Set<string>(META_TOOLS);
  const take = (t: ToolSchema) => !taken.has(t.name) && TOOL_NAME.test(t.name) && t.method !== null && taken.add(t.name);
  const views = session.tools.filter((t) => t.kind === "view" && take(t));
  const calls = session.tools.filter((t) => t.kind === "call" && t.method !== null && session.methodNames.includes(t.method) && !outOfScope.has(t.method) && take(t));
  return [...views, ...calls];
}

function toolEntry(name: string, copy: ToolCopy, session: Session, kind: ToolSchema["kind"], inputSchema: Tool["inputSchema"]): Tool {
  const readOnly = kind === "view" || name === "keyhole_inspect";
  return {
    name,
    title: copy.title,
    description: description(copy, session, kind !== "view"),
    inputSchema,
    annotations: { title: copy.title, readOnlyHint: readOnly, openWorldHint: true },
  };
}

function listing(session: Session, packTools: readonly ToolSchema[]): Tool[] {
  const copyOf = (t: ToolSchema): ToolCopy => {
    const written = PACK_COPY[session.packId]?.[t.name];
    return written && written.method === t.method ? written : genericCopy(t);
  };
  return [
    toolEntry("keyhole_inspect", INSPECT_COPY, session, "meta", { type: "object", properties: {}, additionalProperties: false }),
    ...packTools.map((t) => toolEntry(t.name, copyOf(t), session, t.kind, { ...(t.argsSchema as Record<string, unknown>), type: "object" })),
    toolEntry("keyhole_attempt", ATTEMPT_COPY, session, "meta", ATTEMPT_SCHEMA),
  ];
}

// ---------------------------------------------------------------------------------------------------
// Results

const text = (t: string) => ({ type: "text" as const, text: t });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Replaces the session key's text in a string; built once per server from the key it holds. */
type Redact = (s: string) => string;

/**
 * The session key's two text forms, base58 (the extended key and its 32-byte seed): each, and any run of 12 or more of
 * their characters (keys.ts KEY_WINDOW, C-T19h), replaced by KEY_NOT_SHOWN.
 */
function keyRedactor(keyPair: KeyPair): Redact {
  const redact = keyTextRedactor(privateKeyTexts(keyPair));
  // keyTextRedactor never throws; this call site makes sure of it too (sweep A fix round 1).
  return (s) => {
    try {
      return redact(s);
    } catch {
      return TEXT_WITHHELD;
    }
  };
}

/**
 * Every line of `t` wrapped at spaces to TEXT_WIDTH (render/style.ts wrapWords, no lead or hang): each break replaces
 * exactly one space, so the words are kept verbatim and joining the lines with a space gives the line back. A word
 * wider than TEXT_WIDTH stays whole.
 */
const wrapped = (t: string) =>
  t
    .split("\n")
    .flatMap((l) => wrapWords(l, TEXT_WIDTH, "", ""))
    .join("\n");

/**
 * A KeyholeError's line (verbatim: SendFateUnknownError's message and hint included), each line neutralized and
 * wrapped. The key's text is replaced before anything is cut. When that fails, only a SendFateUnknownError's tx hash
 * can still be named, and only a hash that holds no window of the session key (sweep B, m3: `keyWindows`).
 */
function errorResult(e: unknown, redact: Redact, keyWindows: ReadonlySet<string>): CallToolResult {
  const shown = redact(e instanceof KeyholeError ? e.line() : reasonOf(e));
  if (shown === TEXT_WITHHELD) return withheld(withheldTxHash(e instanceof SendFateUnknownError ? e : null, keyWindows));
  const line = e instanceof KeyholeError ? shown : `ERROR (environment): ${clip(shown, 300)}`;
  return { isError: true, content: [text(wrapped(line.split("\n").map(neutralizeControls).join("\n")))] };
}

/** Item 1 of an attempt (LAYOUT R3 B.4). The name was parsed from the body by parseRefusal, never written here. */
function outcomeLine(o: AttemptOutcome): string {
  if (o.kind === "Refusal") return refusalLine(o);
  if (o.kind === "ContractPanic") return `runtime failure in a block · tx ${neutralizeControls(o.txHash)}`;
  return `landed · tx ${neutralizeControls(o.txHash)}`;
}

/** Only an InvalidAccessKeyError is the key's scope refusing; any other InvalidTxError is the chain rejecting the tx (C-T2k). */
function refusalLine(r: Refusal): string {
  if (r.family !== "InvalidTxError::InvalidAccessKeyError") return `${chainRejected(r.errorName)} · reached block: no`;
  return `refused by protocol (${neutralizeControls(r.errorName)}) · reached block: no`;
}

/**
 * `tx SHORT · final · WHAT`, then the explorer URL (or `sandbox (no explorer)`), from renderTxLine. When the first
 * line would pass 80 columns (sandbox prints the whole hash), WHAT gets a line of its own.
 */
function txLines(txHash: string, network: Network, what: string): string[] {
  const line = renderTxLine(txHash, network, PLAIN);
  const cut = line.lastIndexOf(" · "); // the URL is percent-encoded and the sandbox tail fixed: neither holds " · "
  const head = line.slice(0, cut);
  const tail = line.slice(cut + 3);
  const first = `${head} · ${what}`;
  return first.length <= TEXT_WIDTH ? [first, tail] : [head, what, tail];
}

/** String values neutralized (a pack's structured result holds chain-read strings, e.g. a proposal's status). */
function neutralizedValues(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? neutralizeControls(v) : v]));
}

/** sendAttempt; a landed attempt whose refund was not seen is returned with that error, never sent again (C-T2i). */
async function send(session: Session, attempt: AttemptInput): Promise<{ done: Attempt; unsettled: LandedUnsettledError | null }> {
  try {
    return { done: await sendAttempt(session, attempt), unsettled: null };
  } catch (e) {
    if (e instanceof LandedUnsettledError) return { done: e.attempt, unsettled: e };
    throw e;
  }
}

const unsettledNote = (e: LandedUnsettledError) => `note: ${neutralizeControls(e.what)} · ${neutralizeControls(e.tryThis)}`;

/** keyhole_inspect: the card in its mcp variant, read from chain; structured content holds scope fields only, never a key. */
async function inspectTool(session: Session): Promise<CallToolResult> {
  const card = await buildCageCard(session, "chain");
  const n = neutralizeControls;
  const key = card.key;
  return {
    content: [text(renderCageCard(card, "mcp", PLAIN))],
    structuredContent: {
      sessionId: session.id,
      accountId: n(key?.accountId ?? session.accountId),
      keyOnChain: key !== null,
      receiverId: key ? n(key.receiverId) : null,
      methodNames: key ? key.methodNames.map(n) : [],
      allowanceRemainingYocto: key ? key.allowanceRemainingYocto : null,
      nonce: key ? key.nonce : null,
      codeHashPin: n(session.codeHashPin),
      codeHashNow: card.codeHashNow === null ? null : n(card.codeHashNow),
      readAt: card.readAt,
      tools: card.tools.map((t) => ({
        name: n(t.name),
        kind: t.kind,
        method: t.method === null ? null : n(t.method),
        ...(t.classification === undefined ? {} : { classification: t.classification }),
        ...(t.evidence === undefined ? {} : { evidence: n(t.evidence) }),
      })),
    },
  };
}

/** A view: the contract's result as UTF-8 JSON, unfiltered (LAYOUT R3 B.2); control characters neutralized. */
async function viewTool(session: Session, tool: ToolSchema, input: Record<string, unknown>): Promise<CallToolResult> {
  const value = await callView(session, tool.method as string, input);
  return { content: [text(neutralizeControls(JSON.stringify(value) ?? "null"))] };
}

/**
 * A pack call tool (dao_vote): the code_hash pin first (on a change, codeChanged and nothing signed), then the
 * pack's contract args, one FunctionCall with deposit 0 through sendAttempt, and the pack's read-back of a landed tx.
 */
async function callTool(session: Session, tool: ToolSchema, hooks: PackHooks, input: Record<string, unknown>, redact: Redact): Promise<CallToolResult> {
  const now = await viewCodeHash(session.network, session.receiverId);
  if (now !== session.codeHashPin) {
    return { isError: true, content: [text(wrapped(codeChanged(neutralizeControls(session.receiverId), neutralizeControls(session.codeHashPin), neutralizeControls(now))))] };
  }
  const args = await hooks.callArgs(session, tool, input);
  const call = { sessionId: session.id, receiverId: session.receiverId, action: "FunctionCall" as const, method: tool.method as string, args, depositYocto: "0", gasTGas: tool.gasTGas };
  const { done, unsettled } = await send(session, { ...call, violates: predictViolation(session, call) });
  const o = done.outcome;
  // Wrapped like keyhole_attempt's line (C-T19e): a long error name read from the body still fits 80 columns.
  if (o.kind === "Refusal") return { isError: true, content: [text(wrapped(refusalLine(o))), text(neutralizeControls(o.rawRpcJson))] };

  const txHash = neutralizeControls(o.txHash);
  let lines: string[];
  let structured: Record<string, unknown> = { txHash };
  if (o.kind === "ContractPanic") {
    lines = [...txLines(o.txHash, session.network, "runtime failure in a block"), `panic: ${neutralizeControls(o.message)}`];
  } else {
    // The tx is in a block: whatever the read-back does, it is reported as landed and never sent again (C-T9a).
    let after: Awaited<ReturnType<PackHooks["afterCall"]>> = null;
    let readFailed: string | null = null;
    try {
      after = await hooks.afterCall(session, tool, input); // the TOOL input, never callArgs' result (C-T5b)
    } catch (e) {
      readFailed = clip(neutralizeControls(redact(e instanceof EnvironmentError ? e.what : e instanceof KeyholeError ? e.message : reasonOf(e))), 200);
    }
    lines = txLines(o.txHash, session.network, after ? neutralizeControls(after.text) : "landed");
    if (after) structured = { txHash, ...neutralizedValues(after.structured) };
    if (readFailed !== null) lines.push(`note: the tx landed; reading the result back failed: ${readFailed}; it is not sent again`);
  }
  if (unsettled) lines.push(unsettledNote(unsettled));
  return { isError: o.kind === "ContractPanic", content: [text(wrapped(lines.join("\n")))], structuredContent: structured };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ATTEMPT_FIELDS: readonly string[] = ["receiverId", "action", "method", "args", "depositYocto", "gasTGas"];

/** The keyhole_attempt input, shape-checked (amounts, gas and per-action args are checked by predictViolation and sendAttempt). */
function attemptInput(session: Session, input: Record<string, unknown>): Omit<AttemptInput, "violates"> {
  const problems: string[] = [];
  const extra = Object.keys(input).filter((k) => !ATTEMPT_FIELDS.includes(k));
  if (extra.length) problems.push(`keyhole_attempt takes ${ATTEMPT_FIELDS.join(", ")} only (got ${extra.map((k) => JSON.stringify(k)).join(", ")})`);
  if (typeof input.receiverId !== "string" || input.receiverId === "") problems.push("receiverId must be a non-empty account id");
  if (typeof input.action !== "string" || !ATTEMPT_ACTIONS.includes(input.action as AttemptAction)) problems.push(`action must be one of ${ATTEMPT_ACTIONS.join(", ")}`);
  if (input.method !== undefined && typeof input.method !== "string") problems.push("method must be a string");
  if (input.args !== undefined && !isObject(input.args)) problems.push("args must be a JSON object");
  if (typeof input.gasTGas !== "number") problems.push("gasTGas must be a number (TGas)");
  if (problems.length) throw new InputError(problems);
  return {
    sessionId: session.id,
    receiverId: input.receiverId as string,
    action: input.action as AttemptAction,
    ...(typeof input.method === "string" ? { method: input.method } : {}),
    args: (input.args as Record<string, unknown> | undefined) ?? {},
    depositYocto: input.depositYocto as string,
    gasTGas: input.gasTGas as number,
  };
}

/**
 * keyhole_attempt: two items, the parsed line and the RPC body verbatim (control characters neutralized). An
 * attempt the chain refused is a result, not a tool error: the chain answering is what the tool is for.
 */
async function attemptTool(session: Session, input: Record<string, unknown>): Promise<CallToolResult> {
  const fields = attemptInput(session, input);
  const violates = predictViolation(session, fields);
  const { done, unsettled } = await send(session, { ...fields, violates });
  const o = done.outcome;
  const structured =
    o.kind === "Refusal"
      ? { outcome: o.kind, reachedBlock: false, family: o.family, errorName: neutralizeControls(o.errorName), violates }
      : { outcome: o.kind, reachedBlock: true, txHash: neutralizeControls(o.txHash), violates, ...(unsettled ? { refundSeen: false } : {}) };
  const line = unsettled ? `${outcomeLine(o)}\n${unsettledNote(unsettled)}` : outcomeLine(o);
  return { content: [text(wrapped(line)), text(neutralizeControls(o.rawRpcJson))], structuredContent: structured };
}

/**
 * The tx hash an error carries (SendFateUnknownError's), when it is one by its form alone: base58 that decodes to
 * exactly 32 bytes and is written canonically. A tx hash is the sha256 of the tx, computed here before the send, never
 * key text: this check is what lets a withheld answer still name it (fix round 2, m2) with no redaction to vouch for it.
 * It is also what a withheld answer skips the final filter on, so a hash that shares any KEY_WINDOW-character window
 * with the session key's text (`keyWindows`, a plain Set built when the key was loaded, not the redactor that just
 * failed) names no tx at all (sweep B, m3): the form alone accepts a 32-byte seed. The public key is public, and is not
 * among the windows.
 */
export function withheldTxHash(e: unknown, keyWindows: ReadonlySet<string>): string | null {
  const hash = typeof e === "object" && e !== null ? (e as { txHash?: unknown }).txHash : undefined;
  if (typeof hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) return null;
  try {
    const bytes = baseDecode(hash);
    if (bytes.length !== 32 || baseEncode(bytes) !== hash) return null;
    for (let i = 0; i + KEY_WINDOW <= hash.length; i++) if (keyWindows.has(hash.slice(i, i + KEY_WINDOW))) return null;
    return hash;
  } catch {
    return null;
  }
}

/** Results made here from constant text and a checked tx hash only: the final filter passes them as they are. */
const withheldResults = new WeakSet<CallToolResult>();

/**
 * Served in place of a result whose key text could not be replaced inside valid JSON, or whose text could not be
 * checked at all (TEXT_WITHHELD). A send may be behind it, so it never says that nothing was sent; when the error
 * carries a tx hash (withheldTxHash), it names that tx.
 */
function withheld(txHash: string | null): CallToolResult {
  const next =
    txHash === null ? "if this call sent a tx, it may be on chain: look up the session account's latest txs before signing again" : `tx ${txHash} may be on chain: look it up before signing again`;
  const result: CallToolResult = { isError: true, content: [text(wrapped(`ERROR (environment): the result was withheld: its text could not be cleared of the session key's text ${KEY_NOT_SHOWN} · ${next}`))] };
  withheldResults.add(result);
  return result;
}
const WITHHELD = withheld(null);

/**
 * The last filter on every result, error results included: the session key's text (the extended key or its seed,
 * base58), whole or any run of 12 or more of its characters, is replaced. No path is meant to carry it; this makes that
 * structural. Base58 holds no JSON escapes, so the JSON text is searched; should a replacement ever leave text that is
 * not JSON, the whole result is withheld.
 */
function withoutKeyText(redact: Redact, result: CallToolResult): CallToolResult {
  if (withheldResults.has(result)) return result; // already withheld: constant text and a checked tx hash
  try {
    const json = JSON.stringify(result);
    const out = redact(json);
    if (out === json) return result;
    return JSON.parse(out) as CallToolResult; // TEXT_WITHHELD is not JSON: withheld too
  } catch {
    return WITHHELD;
  }
}

// ---------------------------------------------------------------------------------------------------
// The server

function packageVersion(): string {
  try {
    const v = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Served {
  server: Server;
  toolCount: number;
  /** Resolves once no tool call is in flight. */
  idle(): Promise<void>;
  /** How many tool calls are in flight now. */
  inFlight(): number;
}

async function serveSession(session: Session): Promise<Served> {
  if (session.status === "burned") throw new EnvironmentError(burnedNothingToServe(session.id), "wrap a new session; a burned one is never served again");
  // The session key first, and the only key serve loads: no other key path exists here.
  const keyPair = sessionKeyPair(session);
  const redact = keyRedactor(keyPair);
  const keyWindows = keyTextWindows(privateKeyTexts(keyPair)); // withheldTxHash's lookup (sweep B, m3)
  const packTools = await servedPackTools(session);
  const hooks = packHooks(session.packId);
  const byName = new Map(packTools.map((t) => [t.name, t]));
  const tools = listing(session, packTools);
  const inflight = new Set<Promise<unknown>>();

  // The SDK marks the low-level Server deprecated in favour of McpServer; the plan uses it on purpose (raw JSON Schemas, two-item results).
  const server = new Server({ name: "keyhole", version: packageVersion() }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const input = isObject(request.params.arguments) ? request.params.arguments : {};
    const tool = byName.get(name);
    if (name !== "keyhole_inspect" && name !== "keyhole_attempt" && !tool) {
      throw new McpError(ErrorCode.InvalidParams, `unknown tool ${clip(neutralizeControls(name), 64)}`);
    }
    const run = async (): Promise<CallToolResult> => {
      try {
        if (name === "keyhole_inspect") return await inspectTool(session);
        if (name === "keyhole_attempt") return await attemptTool(session, input);
        const t = tool as ToolSchema;
        return t.kind === "view" ? await viewTool(session, t, input) : await callTool(session, t, hooks, input, redact);
      } catch (e) {
        return errorResult(e, redact, keyWindows);
      }
    };
    const call = run();
    inflight.add(call);
    try {
      return withoutKeyText(redact, await call);
    } finally {
      inflight.delete(call);
    }
  });
  const idle = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };
  return { server, toolCount: tools.length, idle, inFlight: () => inflight.size };
}

/**
 * The MCP server for one session (the SDK's low-level Server): keyhole_inspect, the pack's tools from
 * Session.tools, keyhole_attempt. Each call/meta description's second sentence states the chain-enforced
 * limits from Session. Loads the session key (sessionKeyPair) before anything else; makes no RPC call.
 */
export async function buildMcpServer(session: Session): Promise<Server> {
  return (await serveSession(session)).server;
}

/** What serve prints when the chain says the session key has full access (Task 19 ruling). */
const FULL_ACCESS_WHAT = "the session key has full access on chain; keyhole serves function-call keys only";
const FULL_ACCESS_TRY = "delete that key with the account's own full-access key, then run keyhole wrap for a new session";

/**
 * One view_access_key read of the session key before serving: full access is refused; no such key (deleted
 * outside keyhole) still starts, and the chain refuses every call it signs. An answer that says neither, or no
 * answer, is an environment error: serve does not start on a key it could not check.
 */
async function refuseFullAccessKey(session: Session): Promise<void> {
  const url = rpcUrlFor(session.network);
  const reply = await rpcCall(url, "query", { request_type: "view_access_key", finality: "final", account_id: session.accountId, public_key: session.publicKey });
  if (isNoSuchKey(reply.json)) return;
  const permission = reply.json?.result?.permission;
  if (permission === "FullAccess") throw new EnvironmentError(FULL_ACCESS_WHAT, FULL_ACCESS_TRY);
  if (permission?.FunctionCall) return;
  throw new EnvironmentError(
    `view_access_key ${neutralizeControls(session.accountId)} ${neutralizeControls(session.publicKey)} failed: ${neutralizeControls(rpcErrorTextAt(reply.json, url))}`,
    "check the RPC endpoint; serve reads the session key's permission before it starts",
  );
}

/**
 * The hard exit's last words while serve runs (C-T17b): an MCP host that kills serve twice must not leave the key live
 * unnamed. serve never burns: the session's key stays on chain until `keyhole burn ID`. Calls in flight are named,
 * since a tx one of them sent may have reached the chain. The tail is sessionHint's wording (cli/demo.ts).
 */
export const stoppedServing = (id: string, inFlight: number): string => {
  const calls = inFlight === 1 ? "1 tool call in flight: any tx it sent" : `${inFlight} tool calls in flight: any tx they sent`;
  return `STOPPED keyhole serve${inFlight > 0 ? ` · ${calls} may be on chain; look it up before signing again` : ""} · session ${id} may still be live · run: keyhole burn ${id}`;
};

/**
 * Runs until the client closes stdin (exit 0), Ctrl-C (exit 130) or a stdout failure other than EPIPE (exit 2);
 * in-flight calls finish first, then the key is dropped. From start to return, the hard exit names the session
 * (stoppedServing through Io.lastWords).
 */
async function serveStdio(id: string, session: Session, io: Io): Promise<number> {
  let inFlight = () => 0;
  io.lastWords?.(() => stoppedServing(id, inFlight()));
  try {
    return await serveUntilStopped(id, session, io, (count) => {
      inFlight = count;
    });
  } finally {
    io.lastWords?.(undefined);
  }
}

async function serveUntilStopped(id: string, session: Session, io: Io, track: (inFlight: () => number) => void): Promise<number> {
  globalThis.console = new Console(process.stderr, process.stderr); // every console method: stdout is the MCP channel
  const { server, toolCount, idle, inFlight } = await serveSession(session);
  track(inFlight);
  const held = heldPrivateKeyCount();
  const fullAccess = fullAccessKeyLoadCount();
  if (held !== 1 || fullAccess !== 0) {
    dropHeldKeys();
    throw new EnvironmentError(`serve must hold exactly 1 private key and load no full-access key; it holds ${held} and loaded ${fullAccess} full-access`, "run keyhole serve ID in a process of its own");
  }
  try {
    await refuseFullAccessKey(session);
  } catch (e) {
    dropHeldKeys();
    throw e;
  }

  let stop: (code: number) => void = () => undefined;
  const stopped = new Promise<number>((resolve) => {
    stop = resolve;
  });
  const onStdoutError = (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") return; // the client closed its end: its stdin closes too, and that stops serving
    io.err(`ERROR (environment): stdout failed: ${clip(neutralizeControls(reasonOf(e)), 200)} · restart keyhole serve`);
    stop(2);
  };
  process.stdout.on("error", onStdoutError);
  if (io.env?.DEBUG) server.onerror = (e) => io.err(`keyhole serve: ${clip(neutralizeControls(reasonOf(e)), 200)}`);
  process.stdin.once("end", () => stop(0));
  process.stdin.once("close", () => stop(0));
  server.onclose = () => stop(0);
  const signal = io.signal;
  if (signal) {
    if (signal.aborted) stop(130);
    signal.addEventListener("abort", () => stop(130), { once: true });
  }
  await server.connect(new StdioServerTransport());
  io.err(`keyhole serve · ${id} · ${held} private key loaded (session) · ${toolCount} tools · receiver ${neutralizeControls(session.receiverId)} · stdio`);

  const code = await stopped;
  await idle();
  await server.close().catch(() => undefined);
  process.stdin.destroy();
  process.stdout.off("error", onStdoutError);
  dropHeldKeys();
  return code;
}

export const serve: Command = {
  name: "serve",
  args: "ID",
  keys: "1 session key",
  async run(argv, io) {
    const id = sessionIdArg(serve, argv, io);
    if (id === null) return 0;
    const session = await loadSession(id);
    if (session.status === "burned") {
      io.err(burnedNothingToServe(id));
      return 1;
    }
    rpcUrlFor(session.network); // no RPC configured for the network: an environment error now, not on every call
    return serveStdio(id, session, io);
  },
};
