/**
 * Read-only NEAR testnet RPC. The console sends three kinds of request and nothing else: view_access_key,
 * view_account and call_function on view methods (plus `block` for the status chip). It never signs.
 * rpc.testnet.fastnear.com first (it answers in about half a second here; rpc.testnet.near.org took about 3.5 s);
 * on HTTP 429, a 5xx or a network error, rpc.testnet.near.org. The curl command names near.org, the default RPC.
 */
export const RPCS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'] as const
export const DEFAULT_RPC = 'https://rpc.testnet.near.org'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type RpcAnswer =
  | { kind: 'ok'; json: any; text: string; url: string }
  | { kind: 'http'; status: number; text: string; url: string }
  | { kind: 'net'; text: string; url: string }
  | { kind: 'bad'; text: string; url: string }

export async function rpc(method: string, params: unknown): Promise<RpcAnswer> {
  let last: RpcAnswer = { kind: 'net', text: 'no response', url: RPCS[0] }
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'keyhole-console', method, params }),
      })
      const text = await r.text()
      if (r.status === 429 || r.status >= 500) { last = { kind: 'http', status: r.status, text, url }; continue }
      if (!r.ok) return { kind: 'http', status: r.status, text, url }
      try { return { kind: 'ok', json: JSON.parse(text), text, url } } catch { return { kind: 'bad', text, url } }
    } catch (e) {
      last = { kind: 'net', text: e instanceof Error ? e.message : String(e), url }
    }
  }
  return last
}

export const host = (url: string) => new URL(url).host

/** Why an answer is not a result, in words. */
export function failure(a: RpcAnswer): string {
  if (a.kind === 'http') return a.status === 429 ? `rate limited (HTTP 429) by ${host(a.url)}` : `HTTP ${a.status} from ${host(a.url)}`
  if (a.kind === 'net') return `${host(a.url)} did not answer (${a.text})`
  if (a.kind === 'bad') return `${host(a.url)} answered with something that is not JSON`
  const e = a.json?.error
  return e ? String(e.cause?.name ?? e.name ?? 'RPC error') : 'unexpected answer'
}

export type KeyRead =
  | { state: 'function-call'; receiverId: string; methodNames: string[]; allowanceYocto: string | null; nonce: number; block: number; url: string; raw: string }
  | { state: 'full-access'; nonce: number; block: number; url: string; raw: string }
  | { state: 'no-key' | 'no-account'; error: string; url: string; raw: string }
  | { state: 'error'; error: string; url: string; raw: string }

const query = (params: Record<string, unknown>) => rpc('query', { finality: 'final', ...params })

/** view_access_key, with the missing-key / missing-account ambiguity settled by view_account. */
export async function readAccessKey(accountId: string, publicKey: string): Promise<KeyRead> {
  const r = await query({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey })
  if (r.kind !== 'ok') return { state: 'error', error: failure(r), url: r.url, raw: r.text }
  const err = r.json.error
  const res = r.json.result
  if (err) {
    const cause = String(err.cause?.name ?? err.name ?? 'RPC_ERROR')
    if (cause === 'UNKNOWN_ACCESS_KEY') return { state: 'no-key', error: cause, url: r.url, raw: r.text }
    if (cause === 'UNKNOWN_ACCOUNT') return { state: 'no-account', error: cause, url: r.url, raw: r.text }
    return { state: 'error', error: cause, url: r.url, raw: r.text }
  }
  if (res?.error) {
    // The RPC words a missing key and a missing account alike here ("access key … does not exist while viewing").
    const acct = await query({ request_type: 'view_account', account_id: accountId })
    const gone = acct.kind === 'ok' && acct.json.error?.cause?.name === 'UNKNOWN_ACCOUNT'
    return { state: gone ? 'no-account' : 'no-key', error: String(res.error), url: r.url, raw: r.text }
  }
  if (res?.permission === 'FullAccess') return { state: 'full-access', nonce: Number(res.nonce), block: Number(res.block_height), url: r.url, raw: r.text }
  const fc = res?.permission?.FunctionCall
  if (!fc) return { state: 'error', error: 'unknown permission', url: r.url, raw: r.text }
  return {
    state: 'function-call',
    receiverId: String(fc.receiver_id),
    methodNames: (fc.method_names ?? []).map(String),
    allowanceYocto: fc.allowance == null ? null : String(fc.allowance),
    nonce: Number(res.nonce),
    block: Number(res.block_height),
    url: r.url,
    raw: r.text,
  }
}

export type CodeRead = { ok: true; codeHash: string; block: number } | { ok: false; error: string }

/** view_account's code_hash: what the receiver runs now. */
export async function readCodeHash(accountId: string): Promise<CodeRead> {
  const r = await query({ request_type: 'view_account', account_id: accountId })
  if (r.kind !== 'ok') return { ok: false, error: failure(r) }
  if (r.json.error) return { ok: false, error: failure(r) }
  return { ok: true, codeHash: String(r.json.result.code_hash), block: Number(r.json.result.block_height) }
}

export type ViewRead<T> = { ok: true; value: T; block: number } | { ok: false; error: string }

/** call_function on a view method; the result bytes are JSON. */
export async function callView<T>(accountId: string, method: string, args: unknown): Promise<ViewRead<T>> {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))))
  const r = await query({ request_type: 'call_function', account_id: accountId, method_name: method, args_base64: argsBase64 })
  if (r.kind !== 'ok') return { ok: false, error: failure(r) }
  if (r.json.error) return { ok: false, error: failure(r) }
  if (r.json.result?.error) return { ok: false, error: String(r.json.result.error) }
  try {
    const bytes = new Uint8Array(r.json.result.result as number[])
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T, block: Number(r.json.result.block_height) }
  } catch {
    return { ok: false, error: `${method} did not return JSON` }
  }
}

export type BlockRead = { ok: true; height: number; time: string } | { ok: false; error: string }

/** The latest final block: the status chip's proof that the RPC answers. */
export async function readBlock(): Promise<BlockRead> {
  const r = await rpc('block', { finality: 'final' })
  if (r.kind !== 'ok' || r.json.error) return { ok: false, error: failure(r) }
  const h = r.json.result.header
  return { ok: true, height: Number(h.height), time: new Date(Number(BigInt(h.timestamp_nanosec) / 1000000n)).toISOString() }
}

/** The curl command that makes the same view_access_key read. */
export const curlFor = (accountId: string, publicKey: string) =>
  `curl -s ${DEFAULT_RPC} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey } })}'`
