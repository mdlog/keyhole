import { useMemo, useState } from 'react'
import { AlertOctagon, ArrowUpRight, Copy, FileSearch2, Search, ShieldCheck } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { useData } from '../data/DataContext'
import { copyText, formatNear, repoFile, Ticks } from '../data/format'

export default function EvidencePage() {
  const data = useData()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const selected = data.refusals.find((r) => r.fixture === params.get('fixture')) ?? data.refusals[0]
  const rows = useMemo(() => data.refusals.filter((r) => `${r.attempt} ${r.rule} ${r.errorName} ${r.boundary} ${r.network} ${r.sessionId}`.toLowerCase().includes(query.toLowerCase())), [data.refusals, query])
  const run = data.runs.find((r) => r.id === selected.runId)
  const step = run?.steps.find((s) => s.n === selected.step)
  const select = (fixture: string) => setParams({ fixture }, { replace: true })

  const copyBody = async () => {
    setCopied(await copyText(selected.body))
    window.setTimeout(() => setCopied(false), 1500)
  }

  return <>
    <PageHeader eyebrow="VERIFICATION · DEMO/FIXTURES" title="Refusal ledger" description={`${data.refusals.length} attempts signed with a session key and refused at validation — never in a block. Each body below is the RPC's response, byte for byte.`} action={<StatusBadge tone="protocol" dot>{data.refusals.length} / {data.refusals.length} REFUSED</StatusBadge>} />
    <div className="notice-bar notice-amber"><AlertOctagon size={16} /><span>A refused attempt never reaches a block, so there is no transaction to look up: the RPC's response body is the evidence. <code>npm test</code> passes every body through <code>parseRefusal</code>, the parser the live path uses.</span></div>
    <div className="evidence-layout">
      <section className="panel evidence-table-panel">
        <div className="evidence-toolbar"><div><div className="section-kicker">NEGATIVE TESTS · MANIFEST ORDER</div><h2>Attempt records <span className="inline-count">{rows.length}</span></h2></div><label className="table-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter attempts" aria-label="Filter attempts" /></label></div>
        <div className="table-wrap"><table className="data-table evidence-table"><thead><tr><th>ATTEMPT</th><th>RULE IT BREAKS</th><th>ERROR FROM RPC</th><th>SESSION</th></tr></thead><tbody>{rows.map((r) => <tr key={r.fixture} className={r.fixture === selected.fixture ? 'row-selected' : ''} onClick={() => select(r.fixture)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && select(r.fixture)}><td><strong><Ticks text={r.attempt} /></strong><small>#{String(r.n).padStart(2, '0')} · {r.network}</small></td><td><Ticks text={r.rule} /></td><td><StatusBadge tone="error">{r.errorName}</StatusBadge></td><td><code>{r.sessionId}</code></td></tr>)}</tbody></table></div>
        {!rows.length && <div className="empty-state">No matching evidence records.</div>}
        <div className="table-foot"><span>Rows 1–5 each break exactly one rule of the key that signs them; rows 6 and 7 follow a burn.</span><a href={repoFile(data.repo, 'demo/fixtures/manifest.json')} target="_blank" rel="noreferrer">manifest.json</a></div>
      </section>
      <aside className="panel evidence-detail">
        <div className="panel-heading"><div><div className="section-kicker">INSPECTOR · #{String(selected.n).padStart(2, '0')} · {selected.network.toUpperCase()}</div><h2>Refusal detail</h2></div><StatusBadge tone="protocol">PROTOCOL</StatusBadge></div>
        <div className="refusal-summary"><span className="refusal-icon"><FileSearch2 size={18} /></span><div><strong><Ticks text={selected.attempt} /></strong><small>{run?.label} · step {selected.step}/{step?.total} · {selected.sessionId && <Link to={`/sessions/${selected.sessionId}`}>{selected.sessionId}</Link>}</small></div></div>
        <div className="detail-definition"><span>RULE IT BREAKS</span><strong><Ticks text={selected.rule} /></strong></div>
        <div className="detail-definition"><span>ERROR NAME</span><code className="error-code">{selected.errorName}</code></div>
        <div className="detail-definition"><span>ERROR PATH</span><code>{selected.path.join(' › ')}</code></div>
        {step?.attempt && <div className="detail-definition"><span>SIGNED ATTEMPT</span><code>{step.attempt.action}{step.attempt.method ? ` ${step.attempt.method}` : ''} → {step.attempt.receiverId}{step.attempt.depositYocto && step.attempt.depositYocto !== '0' ? ` · deposit ${step.attempt.depositYocto} yocto` : ''}{step.attempt.gasTGas ? ` · ${step.attempt.gasTGas} TGas` : ''}</code></div>}
        {step?.note && <div className="detail-definition"><span>RUN NOTE</span><span>{step.note}</span></div>}
        <div className="payload-heading"><span>RPC RESPONSE BODY · VERBATIM · NEVER REACHED A BLOCK</span><button className="quiet-button" onClick={copyBody}>{copied ? <ShieldCheck size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy body'}</button></div>
        <pre className="payload-block"><code>{selected.body}</code></pre>
        <a className="evidence-file" href={repoFile(data.repo, `demo/fixtures/${selected.fixture}`)} target="_blank" rel="noreferrer"><span className="file-dot" /><div><strong>demo/fixtures/{selected.fixture}</strong><small>{selected.body.length} bytes · open on GitHub</small></div><ArrowUpRight size={15} /></a>
        {selected.boundary !== 'burn' && run?.steps.some((s) => s.chainCheck) && selected.network === 'testnet' && <ChainCheck before={run.steps.find((s) => s.chainCheck)!.chainCheck!.before} after={run.steps.find((s) => s.chainCheck)!.chainCheck!.after} />}
        <div className="evidence-tip"><ShieldCheck size={14} /><span>The protocol refusal shows this attempt was outside the access key's scope. It was not included in a block.</span></div>
      </aside>
    </div>
  </>
}

function ChainCheck({ before, after }: { before: string; after: string }) {
  return <div className="detail-definition"><span>KEY STATE AROUND THE REFUSALS</span><span>allowance {formatNear(before)} NEAR before and {formatNear(after)} NEAR after{before === after ? ': the refusals spent no gas' : ''}</span></div>
}
