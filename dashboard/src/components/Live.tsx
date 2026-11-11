import { RefreshCw } from 'lucide-react'
import StatusBadge from './StatusBadge'
import type { Live } from '../data/live'
import type { KeyRead } from '../data/rpc'
import type { Pack, Session } from '../data/types'
import { utcNow } from '../data/format'

type Tone = 'live' | 'verified' | 'warning' | 'muted' | 'error' | 'protocol' | 'violet'

export interface SessionState { tone: Tone; label: string; detail: string; live: boolean | null }

/**
 * What a session is right now. Testnet: the chain's answer to view_access_key. Sandbox: the run's record, since that
 * chain stopped when its run ended.
 */
export function sessionState(s: Session, read: Live<KeyRead>): SessionState {
  if (s.network !== 'testnet') {
    return s.burn
      ? { tone: 'muted', label: 'BURNED · RECORDED', detail: `burned at step ${s.burn.step} of the ${s.network} run; that chain stopped with the run`, live: false }
      : { tone: 'warning', label: 'RECORDED', detail: 'recorded only', live: null }
  }
  const r = read.value
  if (!r) return { tone: 'muted', label: 'READING…', detail: 'view_access_key in flight', live: null }
  if (r.state === 'function-call') return { tone: 'live', label: 'LIVE · ON CHAIN', detail: `function-call key present at block ${r.block.toLocaleString('en-US')}`, live: true }
  if (r.state === 'full-access') return { tone: 'error', label: 'FULL ACCESS', detail: 'the chain holds a full-access key under this public key', live: true }
  if (r.state === 'no-key' || r.state === 'no-account') return { tone: 'muted', label: 'BURNED · ON CHAIN', detail: r.state === 'no-key' ? 'view_access_key: no such key on this account' : 'view_account: no such account', live: false }
  return { tone: 'warning', label: 'RPC ERROR', detail: r.error, live: null }
}

export function SessionBadge({ state }: { state: SessionState }) {
  return <StatusBadge tone={state.tone} dot>{state.label}</StatusBadge>
}

export type PinVerdict = { tone: Tone; label: string; detail: string; match: boolean | null }

/** The receiver's code hash against the session's pin, and against every pack's pin. */
export function pinVerdict(observed: string | null | undefined, pin: string | null, packs: Pack[]): PinVerdict {
  if (!observed) return { tone: 'muted', label: 'NOT READ', detail: 'code hash not read', match: null }
  if (pin && observed === pin) return { tone: 'verified', label: 'MATCHES THE PIN', detail: 'the receiver runs the code the session pinned at wrap', match: true }
  const pack = packs.find((p) => p.codeHash === observed)
  if (pin) return { tone: 'error', label: 'MISMATCH', detail: pack ? `the receiver now runs code pinned by ${pack.id}, not the session's pin` : 'the receiver runs code no pack pins; serve refuses pack calls', match: false }
  if (pack) return { tone: 'verified', label: `PINNED BY ${pack.id.toUpperCase()}`, detail: `the ${pack.id} pack pins this code`, match: true }
  return { tone: 'warning', label: 'NO PACK PINS THIS CODE', detail: 'wrap would refuse this receiver', match: false }
}

/** "read 14:03:22 UTC · rpc.testnet.near.org" with a re-read button. */
export function ReadStamp({ at, loading, onRefresh, what = 'read from chain' }: { at: number | null; loading: boolean; onRefresh: () => void; what?: string }) {
  return (
    <span className="read-stamp">
      <i className={`tiny-status${loading ? ' is-loading' : ''}`} />
      {loading ? 'reading from testnet…' : at ? `${what} · ${utcNow(at)}` : 'not read yet'}
      <button className="icon-button small" onClick={onRefresh} disabled={loading} aria-label="Read again from chain" title="Read again from chain"><RefreshCw size={13} /></button>
    </span>
  )
}
