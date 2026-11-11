import { useMemo, useState } from 'react'
import { ArrowUpRight, Filter, Fingerprint, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { SessionBadge, sessionState } from '../components/Live'
import { useData } from '../data/DataContext'
import { useSessionKey } from '../data/live'
import type { Session } from '../data/types'
import { repoFile, utc } from '../data/format'

const filters = ['All sessions', 'Testnet', 'Sandbox'] as const

export default function SessionsPage() {
  const data = useData()
  const [filter, setFilter] = useState<(typeof filters)[number]>('All sessions')
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => data.sessions.filter((s) => {
    const matches = filter === 'All sessions' || s.network === filter.toLowerCase()
    const haystack = `${s.id} ${s.receiverId} ${s.accountId} ${s.packId} ${s.role}`.toLowerCase()
    return matches && haystack.includes(query.toLowerCase())
  }), [data.sessions, filter, query])
  const count = (f: (typeof filters)[number]) => (f === 'All sessions' ? data.sessions.length : data.sessions.filter((s) => s.network === f.toLowerCase()).length)

  return <>
    <PageHeader eyebrow={`WORKSPACE · ${data.sessions.length} SESSIONS`} title="Sessions" description="Every session Keyhole wrapped for this workspace: the live judging key, and the keys the recorded runs wrapped, used and burned." />
    <div className="notice-bar"><Fingerprint size={16} /><span>Testnet keys are read again from chain on this page. Sandbox sessions ran on a local near-sandbox that stopped with its run, so their state is the run's record.</span></div>
    <section className="panel list-panel">
      <div className="list-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="Filter sessions">{filters.map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}<span>{count(item)}</span></button>)}</div>
        <label className="table-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find session, account or receiver" aria-label="Find session, account or receiver" /><Filter size={14} /></label>
      </div>
      <div className="table-wrap"><table className="data-table sessions-table"><thead><tr><th>SESSION</th><th>RECEIVER</th><th>SCOPE</th><th>NETWORK</th><th>CODE PIN</th><th>STATE</th><th /></tr></thead><tbody>{filtered.map((s) => <SessionRow key={s.id} session={s} />)}</tbody></table></div>
      {!filtered.length && <div className="empty-state">No sessions match the current filter.</div>}
      <div className="table-foot"><span>Showing <strong>{filtered.length}</strong> of {data.sessions.length} sessions</span><span>from <a href={repoFile(data.repo, 'demo/judging-session.json')} target="_blank" rel="noreferrer">demo/judging-session.json</a> and the cage cards in <a href={`${data.repo}/tree/main/demo`} target="_blank" rel="noreferrer">demo/run.*.json</a></span></div>
    </section>
    <div className="notice-bar notice-amber"><span className="notice-icon">!</span><span><strong>Trust boundary:</strong> the key restricts method and receiver; it is not a limit on the value the session account can move within the target.</span></div>
  </>
}

function SessionRow({ session: s }: { session: Session }) {
  const state = sessionState(s, useSessionKey(s))
  return <tr>
    <td><Link className="table-session-id" to={`/sessions/${s.id}`}><span className="table-icon"><Fingerprint size={15} /></span><span><strong>{s.id}</strong><small>{s.role} · {utc(s.createdAt).slice(0, 10)}</small></span></Link></td>
    <td><code>{s.receiverId}</code></td>
    <td><span className="method-pills">{s.methodNames.map((m) => <code key={m}>{m}</code>)}</span></td>
    <td><span className="network-cell"><i className={s.network === 'testnet' ? '' : 'is-muted'} />{s.network} · {s.mode}</span></td>
    <td><StatusBadge tone="verified">{s.packId.toUpperCase()}</StatusBadge></td>
    <td><SessionBadge state={state} /></td>
    <td><Link to={`/sessions/${s.id}`} className="table-open" aria-label={`Open ${s.id}`}><ArrowUpRight size={16} /></Link></td>
  </tr>
}
