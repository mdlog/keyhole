import { useMemo } from 'react'
import { Activity, CircleAlert, Fingerprint, Flame, KeyRound, ScanSearch, ScrollText, ShieldCheck, Vote, Wrench } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { useData } from '../data/DataContext'
import type { Step } from '../data/types'
import { formatNear, repoFile, TxLink, utc } from '../data/format'

const PHASE_TONE: Record<string, 'protocol' | 'live' | 'error' | 'verified' | 'warning' | 'muted' | 'violet'> = {
  setup: 'muted', wrap: 'protocol', 'in-scope': 'live', refusals: 'error', 'chain-check': 'verified', inspect: 'violet', burn: 'warning', smoke: 'muted',
}

export default function ActivityPage() {
  const data = useData()
  const [params, setParams] = useSearchParams()
  const run = data.runs.find((r) => r.network === params.get('run')) ?? data.runs[0]
  const phase = params.get('phase') ?? 'all'
  const phases = useMemo(() => ['all', ...new Set(run.steps.map((s) => s.phase))], [run])
  const visible = run.steps.filter((s) => phase === 'all' || s.phase === phase)
  const set = (next: { run?: string; phase?: string }) => setParams({ run: next.run ?? run.network, ...(next.phase && next.phase !== 'all' ? { phase: next.phase } : {}) }, { replace: true })

  return <>
    <PageHeader eyebrow="AUDIT TRAIL · DEMO/RUN.*.JSON" title="Run log" description="Every step of the two recorded runs of npm run keyhole -- demo: who signed, what the chain answered, and the transaction hash where one landed." action={<StatusBadge tone="verified" dot>{run.result.pass}</StatusBadge>} />
    <div className="event-toolbar panel">
      <div className="filter-tabs" role="tablist" aria-label="Run">{data.runs.map((r) => <button key={r.id} role="tab" aria-selected={r.id === run.id} className={r.id === run.id ? 'selected' : ''} onClick={() => set({ run: r.network, phase: 'all' })}>{r.label}<span>{r.steps.length}</span></button>)}</div>
      <div className="filter-tabs" role="tablist" aria-label="Phase">{phases.map((p) => <button key={p} role="tab" aria-selected={p === phase} className={p === phase ? 'selected' : ''} onClick={() => set({ phase: p })}>{p}</button>)}</div>
    </div>
    <section className="panel run-header">
      <div><div className="section-kicker">{run.network.toUpperCase()} · STARTED {utc(run.startedAt)}</div><h2>RESULT {run.result.pass}</h2><p>{run.result.parts.join(' · ')}</p></div>
      <div className="run-links">
        <a href={repoFile(data.repo, run.transcript)} target="_blank" rel="noreferrer"><ScrollText size={14} /> {run.transcript}</a>
        <a href={repoFile(data.repo, run.file)} target="_blank" rel="noreferrer"><ScrollText size={14} /> {run.file}</a>
        {run.network !== 'testnet' && <span className="muted-inline">a local near-sandbox: its hashes are not on a public explorer</span>}
      </div>
    </section>
    <section className="panel event-stream-panel"><div className="event-stream-head"><div><div className="section-kicker">TIMELINE · STEP ORDER</div><h2>{visible.length} steps <span className="muted-inline">· {run.id}</span></h2></div><span className="connection-state"><i /> RECORDED · exit {run.exitCode}</span></div>
      <div className="timeline-list">{visible.map((s, index) => <StepRow key={s.n} step={s} network={run.network} last={index === visible.length - 1} />)}</div>
      {!visible.length && <div className="empty-state">No steps in this phase.</div>}
      <div className="event-stream-foot"><Activity size={14} /><span>Steps are as the run wrote them; this page adds links, nothing else.</span></div>
    </section>
  </>

  function StepRow({ step: s, network, last }: { step: Step; network: string; last: boolean }) {
    const ref = s.fixture ? data.refusals.find((r) => r.fixture === s.fixture) : undefined
    return <div className="timeline-row">
      <div className="timeline-axis"><span className={`event-marker marker-${s.phase === 'refusals' || ref ? 'refusal' : s.phase === 'burn' ? 'burn' : s.phase === 'chain-check' ? 'hash' : s.phase === 'in-scope' ? 'proposal' : 'session'}`}><StepIcon step={s} refused={!!ref} /></span>{!last && <i />}</div>
      <div className="timeline-content">
        <div className="timeline-main">
          <div>
            <div className="timeline-title-row"><strong>{s.label}</strong><StatusBadge tone={PHASE_TONE[s.phase] ?? 'muted'}>{s.phase.toUpperCase()}</StatusBadge>{s.pass && <StatusBadge tone="verified">PASS</StatusBadge>}</div>
            <p>
              signed by <b>{s.signer === 'none' ? 'nobody (read only)' : s.signer}</b>
              {s.sessionId && <> · session <Link to={`/sessions/${s.sessionId}`}>{s.sessionId}</Link></>}
              {s.proposal && <> · proposal #{s.proposal.id} → {s.proposal.status}, {s.proposal.approvals} of {s.proposal.required}</>}
              {s.chainCheck && <> · allowance {formatNear(s.chainCheck.before)} NEAR before, {formatNear(s.chainCheck.after)} after</>}
            </p>
            {s.note && <p className="step-note">{s.note}</p>}
            <div className="step-evidence">
              {s.txHashes.map((h) => <TxLink key={h} network={network} hash={h} />)}
              {ref && <Link to={`/evidence?fixture=${encodeURIComponent(ref.fixture)}`} className="step-refusal"><StatusBadge tone="error">{ref.errorName}</StatusBadge> refused · no tx</Link>}
            </div>
          </div>
          <time>{String(s.n).padStart(2, '0')}/{s.total}</time>
        </div>
      </div>
    </div>
  }
}

function StepIcon({ step, refused }: { step: Step; refused: boolean }) {
  if (refused) return <CircleAlert size={14} />
  if (step.phase === 'burn') return <Flame size={14} />
  if (step.phase === 'wrap') return <KeyRound size={14} />
  if (step.phase === 'in-scope') return <Vote size={14} />
  if (step.phase === 'chain-check') return <ShieldCheck size={14} />
  if (step.phase === 'inspect') return <ScanSearch size={14} />
  if (step.phase === 'setup') return <Wrench size={14} />
  return <Fingerprint size={14} />
}
