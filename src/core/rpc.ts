/**
 * Raw NEAR JSON-RPC, plus the view-side DATA CONTRACT functions (#7, #8, #12), viewAccount and the
 * mainnet guard (assertChain). Every call goes through globalThis.fetch at call time, so `npm test` can
 * prove it opens no socket.
 *
 * Views read at `finality: "final"`: a tx sent with `wait_until: "FINAL"` (and settled) is already in a
 * final block, so a final read sees it, and a code_hash or key read from a final block cannot be undone.
 *
 * Limits (Task 2 fix round 1): one request waits at most RPC_TIMEOUT_MS (120 s for the methods that wait for
 * finality, 30 s for the rest) and reads at most RPC_MAX_BODY_BYTES (32 MiB). Errors name the RPC by scheme,
 * host and port only (redactUrl, Task 2 fix round 2): a path or query prints as `/…`, so an API key a provider
 * puts in the userinfo, the path (Infura's `/v3/<key>`) or the query never reaches an error, MCP text included.
 * A reply's own JSON error text is printed scrubbed of the URL in use (rpcErrorTextAt, Task 2 fix round 4).
 *
 * Final sweep (C-T18b, C-T19h): every text cut from a reply is made printable first (printableRpcText): scrubbed of
 * every RPC URL this process has called, then of the private keys it holds. So no cut can leave part of an API key or
 * of a key behind, and rpcErrorText, which knows no URL, scrubs as well as rpcErrorTextAt.
 */
import { rpcUrlFor } from "./config.js";
import { EnvironmentError } from "./errors.js";
import { TEXT_WITHHELD, redactHeldKeys } from "./keys.js";
import type { Network, ScopedKey, Session } from "./types.js";

/** `view_account` code_hash of an account with no contract deployed (base58 of 32 zero bytes). */
export const NO_CODE_HASH = "11111111111111111111111111111111";

export interface RpcReply {
  /** Response body exactly as received (kept byte for byte for evidence). */
  raw: string;
  /** Parsed body. RPC JSON is untyped by nature; callers narrow it. */
  json: any;
  httpStatus: number;
}

let seq = 0;

/** Methods that submit a transaction. They are sent once and never retried (PRD §7). */
const SEND_METHODS: ReadonlySet<string> = new Set(["send_tx", "broadcast_tx_commit", "broadcast_tx_async"]);
/** Statuses a rate limiter or gateway answers with; any other status carries the node's own JSON. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503]);
/** Waits before retries 1–4 of a non-send method. */
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000] as const;
/** Methods the node holds open until the transaction is final. */
const WAITING_METHODS: ReadonlySet<string> = new Set(["send_tx", "broadcast_tx_commit", "tx", "EXPERIMENTAL_tx_status"]);
/**
 * Client-side ceiling for one request, body included. nearcore answers a waiting method with TIMEOUT_ERROR
 * after about 10 s of its own; 120 s leaves a public RPC room to queue the call first. Reads get 30 s.
 */
export const RPC_TIMEOUT_MS = Object.freeze({ waiting: 120_000, other: 30_000 });
/** Largest response body read: 32 MiB. A contract view returns at most 4 MiB, sent as a JSON number array (up to 4 bytes per byte). */
export const RPC_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** The hint for every error after a send whose fate is unknown: never invite a second signature. */
export const SEND_HINT = "the transaction may have reached the node: look it up on chain before signing it again";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An RPC URL as errors print it: `scheme://host[:port]`, plus `/…` when it had a path or a query. A provider's
 * API key can sit in the userinfo, the path (`/v3/<key>`, `/<token>/`) or the query; none of them is printed.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${(u.pathname !== "" && u.pathname !== "/") || u.search !== "" ? "/…" : ""}`;
  } catch {
    return "<unparsable RPC URL>";
  }
}

/** Every RPC URL this process has posted to (post): printableRpcText scrubs each of them out of a text. */
const contacted = new Set<string>();

/**
 * `text` with every spelling of `url` replaced by redactUrl(url), its path and query on their own replaced by
 * `/…` and `?…`, and any other `//user:pass@` userinfo dropped.
 */
function scrub(text: string, url: string): string {
  let out = text;
  const spellings: Array<[string, string]> = [[url, redactUrl(url)]];
  try {
    const u = new URL(url);
    spellings.push([u.href, redactUrl(url)]);
    if (u.pathname.length > 1) spellings.push([`${u.pathname}${u.search}`, "/…"], [u.pathname, "/…"]);
    if (u.search !== "") spellings.push([u.search, "?…"]);
  } catch {
    // unparsable: only the raw spelling can appear
  }
  for (const [spelling, printed] of spellings) if (spelling) out = out.split(spelling).join(printed);
  return out.replace(/\/\/[^/\s@]*@/g, "//");
}

/**
 * `text` (from a reply, or about one) made safe to print, before anything cuts it (C-T18b, C-T19h): `url` (when given)
 * and every RPC URL this process has called are scrubbed out of it (scrub), then the text of every private key it
 * holds (redactHeldKeys). It never throws (sweep A fix round 1): on any failure the text becomes TEXT_WITHHELD, so an
 * error built around it keeps its class and fields (a SendFateUnknownError keeps its tx hash and exit 3).
 */
export function printableRpcText(text: string, url?: string): string {
  try {
    let out = url === undefined ? text : scrub(text, url);
    for (const u of contacted) out = scrub(out, u);
    return redactHeldKeys(out);
  } catch {
    return TEXT_WITHHELD;
  }
}

/** What a rejection says, whatever was thrown: fetch may reject with a non-Error, or an Error whose message is not a string. */
export function reasonOf(e: unknown): string {
  try {
    return String((e as { message?: unknown } | null | undefined)?.message ?? e);
  } catch {
    return "a rejection with no readable reason"; // e.g. an object with no prototype: String() throws on it
  }
}

/** A request the client stopped waiting for. For a send, the transaction's fate is unknown: it is never re-sent. */
export class RpcTimeoutError extends EnvironmentError {
  constructor(
    readonly method: string,
    url: string,
    ms: number,
  ) {
    super(`RPC ${redactUrl(url)} did not answer ${method} within ${ms / 1000} s`, SEND_METHODS.has(method) ? SEND_HINT : "check the network and the RPC endpoint");
    this.name = "RpcTimeoutError";
  }
}

/**
 * One JSON-RPC call. HTTP 429, 502 and 503 are retried after 0.5, 1, 2 and 4 s, except for the send
 * methods (send_tx, broadcast_tx_*), which are never re-sent. Every other status returns the node's JSON
 * as the reply: nearcore answers TIMEOUT_ERROR with HTTP 408, and the caller decides what that means.
 * A request that outlives RPC_TIMEOUT_MS throws RpcTimeoutError (not retried).
 */
export async function rpcCall(url: string, method: string, params: unknown): Promise<RpcReply> {
  const send = SEND_METHODS.has(method);
  const where = redactUrl(url);
  for (let attempt = 1; ; attempt++) {
    const { status, raw } = await post(url, method, params, send);
    if (RETRY_STATUSES.has(status)) {
      if (send) throw new EnvironmentError(`RPC ${where} answered HTTP ${status} for ${method}; a send is never re-sent`, SEND_HINT);
      if (attempt <= RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw new EnvironmentError(`RPC ${where} answered HTTP ${status} for ${method} after ${attempt} attempts`, "wait and retry, or use another RPC endpoint; offline alternative: npm test (REPLAY)");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new EnvironmentError(`RPC ${where} returned non-JSON for ${method} (HTTP ${status})`, send ? SEND_HINT : "check the RPC endpoint");
    }
    return { raw, json, httpStatus: status };
  }
}

/** One POST with the client-side timeout and the body cap. */
async function post(url: string, method: string, params: unknown, send: boolean): Promise<{ status: number; raw: string }> {
  const ms = WAITING_METHODS.has(method) ? RPC_TIMEOUT_MS.waiting : RPC_TIMEOUT_MS.other;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  contacted.add(url);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `keyhole-${++seq}`, method, params }),
      signal: controller.signal,
    });
    return { status: res.status, raw: await readCapped(res, url, method, send) };
  } catch (e) {
    if (timedOut) throw new RpcTimeoutError(method, url, ms);
    if (e instanceof EnvironmentError) throw e; // the body cap
    throw new EnvironmentError(
      `RPC ${redactUrl(url)} unreachable (${method}): ${scrub(reasonOf(e), url)}`,
      send ? SEND_HINT : "check the network and the RPC endpoint; offline alternative: npm test (REPLAY)",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The body as UTF-8 text, refused past RPC_MAX_BODY_BYTES (by its declared length, or as it streams in). */
async function readCapped(res: Response, url: string, method: string, send: boolean): Promise<string> {
  const tooLarge = () =>
    new EnvironmentError(`RPC ${redactUrl(url)} answered more than ${RPC_MAX_BODY_BYTES / 1024 / 1024} MiB for ${method}`, send ? SEND_HINT : "ask for less (a smaller page of a view), or use another RPC endpoint");
  if (Number(res.headers.get("content-length") ?? Number.NaN) > RPC_MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RPC_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The node's name for an RPC error (`error.cause.name`, e.g. TIMEOUT_ERROR, UNKNOWN_ACCOUNT), if any. */
export function rpcErrorName(json: any): string | undefined {
  const name = json?.error?.cause?.name ?? json?.error?.name;
  return typeof name === "string" ? name : undefined;
}

/** What went wrong in a reply, uncut: the RPC error, a legacy `result.error`, or the whole body. */
function errorText(json: any): string {
  if (json?.error) {
    const data = json.error.data;
    const detail = typeof data === "string" ? data : data !== undefined ? JSON.stringify(data) : (json.error.message ?? "");
    return `${rpcErrorName(json) ?? "RPC error"}: ${detail}`;
  }
  if (typeof json?.result?.error === "string") return json.result.error;
  return String(JSON.stringify(json));
}

/**
 * A short, printable account of what went wrong in a reply: the RPC error, or a legacy `result.error`, made printable
 * (printableRpcText: every RPC URL this process has called and every key it holds) before it is cut to 300 characters
 * (C-T18b). For a reply from a known URL, rpcErrorTextAt also scrubs that one, called or not.
 */
export function rpcErrorText(json: any): string {
  return printableRpcText(errorText(json)).slice(0, 300);
}

/**
 * rpcErrorText for a reply from `url` (Task 2 fix round 4): the text is scrubbed (see scrub) before it is cut to 300
 * characters, so a gateway that echoes the request URL, its path or its query in a JSON error never puts an API key
 * in an error, and a cut can never leave part of one behind. The held keys go too (C-T19h).
 */
export function rpcErrorTextAt(json: any, url: string): string {
  return printableRpcText(errorText(json), url).slice(0, 300);
}

/**
 * True when a `view_access_key` reply says there is no such key (deleted, or its account is gone).
 * nearcore 2.x answers this with the legacy `result.error` string, not `error` (SPIKE_REPORT Gotcha 8);
 * UNKNOWN_ACCESS_KEY / UNKNOWN_ACCOUNT are accepted too.
 */
export function isNoSuchKey(json: any): boolean {
  if (typeof json?.result?.error === "string") return /does not exist/.test(json.result.error);
  return ["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"].includes(rpcErrorName(json) ?? "");
}

const chainChecks = new Map<string, Promise<string>>();

/**
 * Reads `status` once per process per network and RPC URL, before the first signed transaction (Global
 * Constraints → Safety). Refuses `chain_id: "mainnet"` on any network, and on testnet anything but
 * `testnet`. A passed check is remembered; a refused one is not, so the next call reads status again.
 *
 * Resolves to the URL it verified (Task 2 fix round 1). A signing operation reads, sends and polls at
 * exactly that URL and never re-resolves rpcUrlFor afterwards, so a useRpcUrl switch during the check
 * cannot route a signed transaction to an unchecked node.
 */
export async function assertChain(network: Network): Promise<string> {
  const url = rpcUrlFor(network);
  const key = `${network} ${url}`;
  let check = chainChecks.get(key);
  if (!check) {
    check = readChainId(network, url).then(() => url);
    chainChecks.set(key, check);
    check.catch(() => chainChecks.delete(key));
  }
  return check;
}

async function readChainId(network: Network, url: string): Promise<void> {
  const where = redactUrl(url);
  const reply = await rpcCall(url, "status", []);
  const chainId = reply.json?.result?.chain_id;
  if (typeof chainId !== "string") throw new EnvironmentError(`RPC ${where} status returned no chain_id (${rpcErrorTextAt(reply.json, url)})`, "check the RPC endpoint");
  if (chainId === "mainnet") {
    throw new EnvironmentError(`RPC ${where} serves chain_id "mainnet"; Keyhole never signs on mainnet`, `point the ${network} RPC (KEYHOLE_TESTNET_RPC / KEYHOLE_SANDBOX_RPC) at a testnet or sandbox node`);
  }
  if (network === "testnet" && chainId !== "testnet") {
    throw new EnvironmentError(`RPC ${where} serves chain_id ${JSON.stringify(chainId)}, not "testnet"`, "point KEYHOLE_TESTNET_RPC at a testnet RPC node");
  }
}

/** `view_account`: balance and code_hash, or null when the account does not exist. */
export async function viewAccount(network: Network, accountId: string): Promise<{ amountYocto: string; codeHash: string } | null> {
  const url = rpcUrlFor(network);
  const reply = await rpcCall(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  if (rpcErrorName(reply.json) === "UNKNOWN_ACCOUNT") return null;
  const r = reply.json?.result;
  if (typeof r?.amount !== "string" || typeof r?.code_hash !== "string") {
    throw new EnvironmentError(`view_account ${accountId} on ${network} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the RPC endpoint");
  }
  return { amountYocto: r.amount, codeHash: r.code_hash };
}

/**
 * #7 viewScopedKey (RPC-live): `view_access_key` for Session.accountId + Session.publicKey, or null
 * when the chain has no such key (burned). Consumers: buildCageCard; R4 [11] chain check; R5 BURNED.
 * Note: a deleted key comes back as `result.error` (a string), not `error` (SPIKE_REPORT Gotcha 8).
 * A full-access key under the session's public key is an environment error: it is never shown as scoped.
 */
export async function viewScopedKey(session: Session): Promise<ScopedKey | null> {
  const url = rpcUrlFor(session.network);
  const reply = await rpcCall(url, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: session.accountId,
    public_key: session.publicKey,
  });
  if (isNoSuchKey(reply.json)) return null;
  const r = reply.json?.result;
  if (r?.nonce === undefined || r.permission === undefined) {
    throw new EnvironmentError(`view_access_key ${session.accountId} ${session.publicKey} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the RPC endpoint");
  }
  const fc = r.permission?.FunctionCall;
  if (!fc) {
    throw new EnvironmentError(
      `the session key ${session.publicKey} on ${session.accountId} is a full-access key, not a function-call key`,
      `delete it from ${session.accountId} with its own full-access key; a session key must never hold full access`,
    );
  }
  return {
    publicKey: session.publicKey,
    accountId: session.accountId,
    receiverId: fc.receiver_id,
    methodNames: fc.method_names,
    allowanceRemainingYocto: fc.allowance ?? null,
    nonce: Number(r.nonce),
  };
}

/**
 * #8 viewCodeHash (RPC-live): `view_account` → code_hash. Consumers: R2 pre-flight; CageCard
 * code_hash row; R3 SERVER-SIDE refusal when it no longer matches Session.codeHashPin.
 * NO_CODE_HASH means the account exists with no contract; a missing account is an environment error.
 */
export async function viewCodeHash(network: Network, accountId: string): Promise<string> {
  const account = await viewAccount(network, accountId);
  if (!account) throw new EnvironmentError(`account ${accountId} does not exist on ${network}`, "check the account id and the network");
  return account.codeHash;
}

/**
 * #12 callView (RPC-live): a contract view, returned untouched (no filtering, no flagging of
 * injected text). Consumers: R3 dao_list_proposals, dao_get_policy.
 * Args go as base64 JSON (`call_function`, `args_base64`); the result bytes are parsed as JSON (empty → null).
 */
export async function callView(session: Session, method: string, args: object): Promise<unknown> {
  const url = rpcUrlFor(session.network);
  const reply = await rpcCall(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: session.receiverId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const bytes = reply.json?.result?.result;
  if (reply.json?.error || typeof reply.json?.result?.error === "string" || !Array.isArray(bytes)) {
    throw new EnvironmentError(`view ${session.receiverId}.${method} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the method name and its arguments");
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new EnvironmentError(`view ${session.receiverId}.${method} returned ${bytes.length} bytes that are not JSON`, "check that the method is a JSON view");
  }
}
