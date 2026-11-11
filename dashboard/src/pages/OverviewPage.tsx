import { ArrowRight, ArrowUpRight, CircleAlert, CircleCheck, Clock3, FileWarning, Fingerprint, ScrollText, ShieldAlert, ShieldCheck, TerminalSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { pinVerdict, ReadStamp, SessionBadge, sessionState } from '../components/Live'
import { useData } from '../data/DataContext'
import { useAccessKey, useCodeHash, usePolicy, useProposals } from '../data/live'
import { requiredApprovals } from '../data/quorum'
import { formatNear, percentOf, repoFile, shortAddress, Ticks, utc } from '../data/format'

export default function OverviewPage() {
  const data = useData()
  const lead = data.sessions.find((s) => s.id === data.judgingSessionId)!
  const testnet = data.sessions.filter((s) => s.network === 'testnet')
  const leadKey = useAccessKey(lead.accountId, lead.publicKey)
  const otherKey = useAccessKey(testnet[1]?.accountId ?? null, testnet[1]?.publicKey ?? null)
  const code = useCodeHash(lead.receiverId)
  const proposals = useProposals(data.dao)
  const policy = usePolicy(data.dao)

  const leadState = sessionState(lead, leadKey)
  const states = data.sessions.map((s) => (s.id === lead.id ? leadState : sessionState(s, s.id === testnet[1]?.id ? otherKey : leadKey)))
  const liveCount = states.filter((s) => s.live === true).length
  const burned = states.filter((s) => s.live === false).length
  const settled = states.every((s) => s.label !== 'READING…')
  const k = leadKey.value
  const remaining = k?.state === 'function-call' ? k.allowanceYocto : null
  const pin = pinVerdict(code.value?.ok ? code.value.codeHash : null, lead.codeHashPin, data.packs)
  const list = proposals.value?.ok ? proposals.value.value : null
  const open = list?.filter((p) => p.status === 'InProgress') ?? []
  const pol = policy.value?.ok ? policy.value.value : null
  const testnetRefusals = data.refusals.filter((r) => r.network === 'testnet').length

  return (
    <>
      <PageHeader eyebrow="JUDGING WORKSPACE · NEAR TESTNET" title="Operations overview" description="The judging session's key and its DAO, read from testnet as you open the page; the recorded runs and refusals, from the repo." action={<SessionBadge state={leadState} />} />
      <div className="demo-ribbon"><ShieldCheck size={16} /><span><strong>Read-only.</strong> This console holds no key and signs nothing. Live values come from <code>view_access_key</code>, <code>view_account</code> and the DAO's views; recorded values link to their file in <code>demo/</code>.</span><Link to="/security">Who enforces what <ArrowRight size={14} /></Link></div>

      <section className="metric-grid" aria-label="Workspace summary">
        <MetricCard icon={<Fingerprint size={16} />} label="Live session keys" value={settled ? String(liveCount).padStart(2, '0') : '··'} note={settled ? `of ${data.sessions.length} wrapped · ${burned} burned` : 'reading the testnet keys'} tone="cyan" />
        <MetricCard icon={<ShieldCheck size={16} />} label="DAO code vs pin" value={code.value ? (pin.match ? 'MATCH' : pin.label) : '··'} note={`${shortAddress(lead.codeHashPin, 8, 4)} · ${lead.packId} pack`} tone={pin.match === false ? 'amber' : 'green'} />
        <MetricCard icon={<FileWarning size={16} />} label="Refusals on record" value={String(data.refusals.length).padStart(2, '0')} note={`${testnetRefusals} testnet · ${data.refusals.length - testnetRefusals} sandbox · bodies verbatim`} tone="violet" />
        <MetricCard icon={<Clock3 size={16} />} label="Open proposals" value={list ? String(open.length).padStart(2, '0') : '··'} note={list ? `of ${list.length} on the DAO · ${pol ? `quorum ${requiredApprovals(pol) ?? '?'} of council` : 'reading policy'}` : proposals.value && !proposals.value.ok ? proposals.value.error : 'reading get_proposals'} tone="amber" />
      </section>

      <div className="overview-grid">
        <section className="panel featured-session">
          <div className="panel-heading">
            <div><div className="section-kicker">JUDGING SESSION · TESTNET</div><h2>The key judges can read</h2></div>
            <SessionBadge state={leadState} />
          </div>
          <div className="session-identity">
            <div className="identity-mark"><Fingerprint size={21} /></div>
            <div><div className="identity-title">{lead.id}<span className="network-tag">{lead.mode}</span></div><div className="identity-sub">Signer · {lead.accountId}</div></div>
            <Link className="square-link" to={`/sessions/${lead.id}`} aria-label="Open session detail"><ArrowUpRight size={17} /></Link>
          </div>
          <div className="scope-row"><span className="scope-label">RECEIVER</span><code>{k?.state === 'function-call' ? k.receiverId : lead.receiverId}</code><span className="enforcer">PROTOCOL</span></div>
          <div className="scope-row"><span className="scope-label">METHOD</span><code className="cyan-text">{(k?.state === 'function-call' ? k.methodNames : lead.methodNames).join(', ') || 'any method'}</code><span className="enforcer">PROTOCOL</span></div>
          <div className="scope-row"><span className="scope-label">ACTIONS</span><code>1 FunctionCall / tx</code><span className="enforcer">PROTOCOL</span></div>
          <div className="scope-row"><span className="scope-label">DEPOSIT</span><code>0 only</code><span className="enforcer">PROTOCOL</span></div>
          <div className="scope-row"><span className="scope-label">GAS ALLOWANCE</span><div className="gas-cell"><code>{remaining ? `${formatNear(remaining)} of ${formatNear(lead.allowanceYocto)} NEAR left` : `${formatNear(lead.allowanceYocto)} NEAR at wrap`}</code><div className="gas-track"><span style={{ width: `${remaining ? percentOf(remaining, lead.allowanceYocto) : 0}%` }} /></div><small>gas only</small></div><span className="enforcer">PROTOCOL</span></div>
          <div className={`code-pin-strip${pin.match === false ? ' is-warning' : ''}`}>
            <div className="pin-symbol">{pin.match === false ? <CircleAlert size={16} /> : <CircleCheck size={16} />}</div>
            <div className="pin-copy"><strong>{code.value ? (pin.match ? 'The DAO runs the code the session pinned' : pin.detail) : 'Reading the DAO\'s code hash…'}</strong><code>{code.value?.ok ? shortAddress(code.value.codeHash, 20, 10) : shortAddress(lead.codeHashPin, 20, 10)}</code></div>
            <StatusBadge tone={pin.tone}>{code.value ? pin.label : 'READING'}</StatusBadge>
          </div>
          <div className="panel-foot"><ReadStamp at={leadKey.at} loading={leadKey.loading} onRefresh={() => { leadKey.refresh(); code.refresh() }} /><Link to={`/sessions/${lead.id}`}>Open cage card <ArrowRight size={14} /></Link></div>
        </section>

        <section className="panel activity-panel">
          <div className="panel-heading"><div><div className="section-kicker">RECORDED RUNS · npm run keyhole -- demo</div><h2>Both runs passed</h2></div><Link className="text-link" to="/activity">Run log <ArrowRight size={14} /></Link></div>
          <div className="mini-timeline">
            {data.runs.map((run) => (
              <Link className="mini-event run-summary" key={run.id} to={`/activity?run=${run.network}`}>
                <span className="event-marker marker-hash"><ScrollText size={14} /></span>
                <div className="mini-event-copy"><strong>{run.label} · {run.result.pass}</strong><span>{run.result.parts.join(' · ')}</span></div>
                <time>{run.startedAt.slice(0, 10)}</time>
              </Link>
            ))}
          </div>
          <div className="run-phases">
            {phaseCounts(data.runs.find((r) => r.network === 'testnet')?.steps.map((s) => s.phase) ?? []).map(([phase, n]) => <span key={phase}><b>{n}</b>{phase}</span>)}
          </div>
          <div className="panel-bottom-link"><a href={repoFile(data.repo, data.runs[0].transcript)} target="_blank" rel="noreferrer">Testnet transcript on GitHub <ArrowUpRight size={14} /></a></div>
        </section>
      </div>

      <div className="lower-grid">
        <section className="panel ledger-panel">
          <div className="panel-heading"><div><div className="section-kicker">PROTOCOL EVIDENCE</div><h2>Refused at validation — never in a block</h2></div><StatusBadge tone="protocol">{data.refusals.length} FIXTURES</StatusBadge></div>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>ATTEMPT</th><th>RULE</th><th>ERROR FROM RPC</th><th>NETWORK</th></tr></thead><tbody>{data.refusals.slice(0, 5).map((item) => <tr key={item.fixture}><td><Link to={`/evidence?fixture=${encodeURIComponent(item.fixture)}`} className="cell-link"><Ticks text={item.attempt} /></Link><small>#{String(item.n).padStart(2, '0')} · {item.sessionId}</small></td><td>{item.boundary}</td><td><StatusBadge tone="error">{item.errorName}</StatusBadge></td><td className="muted-cell">{item.network}</td></tr>)}</tbody></table></div>
          <div className="panel-bottom-link"><Link to="/evidence">Inspect all {data.refusals.length} response bodies <ArrowRight size={14} /></Link></div>
        </section>
        <section className="panel attention-panel">
          <div className="panel-heading"><div><div className="section-kicker">OPERATOR QUEUE · LIVE</div><h2>Needs a person</h2></div><span className="attention-count">{open.length + (leadState.live ? 1 : 0) + (pin.match === false ? 1 : 0)}</span></div>
          {pin.match === false && <Link to={`/sessions/${lead.id}`} className="attention-item"><span className="attention-icon"><ShieldAlert size={16} /></span><span className="attention-copy"><strong>Code hash mismatch</strong><small>{lead.receiverId} · serve refuses pack calls</small></span><ArrowRight size={15} /></Link>}
          {open.map((p) => {
            const approvals = p.vote_counts?.council?.[0] ?? 0
            const need = pol ? requiredApprovals(pol, p.kind) : null
            const seeded = data.dao.seeded.find((s) => s.id === p.id)
            return <Link key={p.id} to={`/proposals?id=${p.id}`} className="attention-item"><span className="attention-icon soft"><Clock3 size={16} /></span><span className="attention-copy"><strong>Proposal #{p.id} awaiting quorum</strong><small>{approvals} of {need ?? '?'} council approvals{seeded ? ` · seeded by the run: ${seeded.note}` : ''}</small></span><ArrowRight size={15} /></Link>
          })}
          {leadState.live && <Link to={`/sessions/${lead.id}`} className="attention-item"><span className="attention-icon soft"><Fingerprint size={16} /></span><span className="attention-copy"><strong>{lead.id} is live until the operator burns it</strong><small>no protocol expiry · <code>npm run keyhole -- burn {lead.id}</code></small></span><ArrowRight size={15} /></Link>}
          {list && !open.length && !leadState.live && pin.match !== false && <div className="empty-state">Nothing waits on a person right now.</div>}
          <div className="value-limit-note"><ShieldAlert size={14} /><span><strong>Scope ≠ value cap.</strong> The key limits which method on which contract; it does not limit what the signer owns inside that contract.</span></div>
        </section>
      </div>
      <div className="read-only-note"><TerminalSquare size={15} /><span><strong>Wrap and burn are not here.</strong> They sign with the operator's full-access key, so they run on the operator's machine (<Link to="/commands">command guide</Link>). Judging session created {utc(lead.createdAt)}.</span></div>
    </>
  )
}

function phaseCounts(phases: string[]): [string, number][] {
  const out: [string, number][] = []
  for (const p of phases) {
    const hit = out.find(([q]) => q === p)
    if (hit) hit[1] += 1
    else out.push([p, 1])
  }
  return out
}

function MetricCard({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note: string; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon metric-${tone}`}>{icon}</div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-note"><span className={`metric-bullet bullet-${tone}`} />{note}</div></div>
}
