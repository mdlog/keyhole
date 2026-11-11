import { useCallback, useEffect, useState } from 'react'
import { callView, readAccessKey, readBlock, readCodeHash } from './rpc'
import type { BlockRead, CodeRead, KeyRead, ViewRead } from './rpc'
import type { Dao, Session } from './types'

/**
 * Live reads, shared across pages: one request per key until something asks for a refresh. A read that fails is
 * kept as its failure (the reads never throw), so a page shows why instead of spinning.
 */
type Entry = { promise: Promise<unknown>; at: number }
const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()

/** Forget every read and make every mounted page read again. */
export function refreshAll() {
  cache.clear()
  listeners.forEach((l) => l())
}

export type Live<T> = { value: T | undefined; loading: boolean; at: number | null; refresh: () => void }

export function useLive<T>(key: string | null, read: () => Promise<T>): Live<T> {
  const [tick, setTick] = useState(0)
  const [result, setResult] = useState<{ key: string; value: T; at: number } | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const l = () => setTick((t) => t + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])

  useEffect(() => {
    if (!key) return
    let alive = true
    let entry = cache.get(key)
    if (!entry) {
      entry = { promise: read(), at: Date.now() }
      cache.set(key, entry)
    }
    const { at } = entry
    setPending(true)
    ;(entry.promise as Promise<T>).then(
      (value) => { if (alive) { setResult({ key, value, at }); setPending(false) } },
      () => { cache.delete(key); if (alive) setPending(false) },
    )
    return () => { alive = false }
    // `read` is keyed by `key`: a new key is a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  const refresh = useCallback(() => {
    if (key) cache.delete(key)
    setTick((t) => t + 1)
  }, [key])

  const fresh = result && result.key === key ? result : null
  return { value: fresh?.value, loading: !!key && pending, at: fresh?.at ?? null, refresh }
}

/** Testnet only: a sandbox session's chain stopped with its run. */
export const isLiveNetwork = (network: string) => network === 'testnet'

export const useAccessKey = (accountId: string | null, publicKey: string | null): Live<KeyRead> =>
  useLive(accountId && publicKey ? `key:${accountId}:${publicKey}` : null, () => readAccessKey(accountId!, publicKey!))

export const useSessionKey = (s: Session | undefined): Live<KeyRead> =>
  useAccessKey(s && isLiveNetwork(s.network) ? s.accountId : null, s && isLiveNetwork(s.network) ? s.publicKey : null)

export const useCodeHash = (accountId: string | null): Live<CodeRead> =>
  useLive(accountId ? `code:${accountId}` : null, () => readCodeHash(accountId!))

export const useBlock = (): Live<BlockRead> => useLive('block', readBlock)

/** sputnikdao2's Proposal, as get_proposals returns it. */
export interface Proposal {
  id: number
  proposer: string
  description: string
  kind: unknown
  status: string
  vote_counts: Record<string, [number, number, number]>
  votes: Record<string, string>
  submission_time: string
}

export const useProposals = (dao: Dao): Live<ViewRead<Proposal[]>> =>
  useLive(`proposals:${dao.accountId}`, () => callView<Proposal[]>(dao.accountId, 'get_proposals', { from_index: 0, limit: 100 }))

export const usePolicy = (dao: Dao): Live<ViewRead<unknown>> =>
  useLive(`policy:${dao.accountId}`, () => callView<unknown>(dao.accountId, 'get_policy', {}))
