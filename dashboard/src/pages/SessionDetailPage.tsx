import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleCheck, Copy, Fingerprint, Flame, Info, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useState } from 'react'
import type { ReactNode } from 'react'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { pinVerdict, ReadStamp, SessionBadge, sessionState } from '../components/Live'
import { useData } from '../data/DataContext'
import { isLiveNetwork, useCodeHash, useSessionKey } from '../data/live'
import { AccountLink, copyText, formatNear, percentOf, repoFile, shortAddress, TxLink, utc } from '../data/format'

export default function SessionDetailPage() {
  const data = useData()
  const { sessionId = '' } = useParams()
  const s = data.sessions.find((item) => item.id === sessionId)
  const key = useSessionKey(s)
  const code = useCodeHash(s && isLiveNetwork(s.network) ? s.receiverId : null)
  const [copied, setCopied] = useState(false)
  if (!s) return <div className="not-found"><h1>No session {sessionId}</h1><Link to="/sessions">Return to sessions</Link></div>

  const live = isLiveNetwork(s.network)
  const state = sessionState(s, key)
  const k = key.value
  const fc = k?.state === 'function-call' ? k : null
  const pack = data.packs.find((p) => p.id === s.packId)
  const run = data.runs.find((r) => r.id === s.runId)
  const refusals = data.refusals.filter((r) => r.sessionId === s.id)
  const steps = run?.steps.filter((st) => st.sessionId === s.id && st.signer === 'session') ?? []
  const methods = fc ? fc.methodNames : s.methodNames

  // Allowance and code hash: the chain's answer on testnet; the run's last read on sandbox.
  const remaining = fc ? fc.allowanceYocto : s.lastRead?.allowanceRemainingYocto ?? null
  const observed = live ? (code.value?.ok ? code.value.codeHash : null) : s.lastRead?.codeHashNow ?? null
  const pin = pinVerdict(observed, s.codeHashPin, data.packs)
  const gone = state.live === false

  const tools = s.tools ?? pack?.tools ?? []
  const toolRows = [
    ...tools.map((t) => ({ name: t.name, method: t.method, kind: t.kind, note: t.kind === 'view' ? 'view · no key needed' : t.classification ?? (methods.includes(t.method) ? 'in allowlist' : 'not in allowlist'), evidence: t.evidence })),
    ...(pack?.outOfScope ?? []).filter((m) => !tools.some((t) => t.method === m)).map((m) => ({ name: m, method: m, kind: 'call', note: 'not in allowlist', evidence: undefined })),
  ]

  const copyScope = async () => {
    const ok = await copyText(`Session ${s.id} (${s.network}, ${s.mode})\nSigner: ${s.accountId}\nReceiver: ${s.receiverId}\nMethods: ${s.methodNames.join(', ')}\nDeposit: 0 only\nGas allowance: ${formatNear(s.allowanceYocto)} NEAR (gas only)\nCode hash pin: ${s.codeHashPin}\nPublic key: ${s.publicKey}`)
    setCopied(ok)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return <>
    <div className="back-link-wrap"><Link to="/sessions" className="back-link"><ArrowLeft size={15} />All sessions</Link><span className="breadcrumb-mini">/ {s.id}</span></div>
    <PageHeader eyebrow={`SESSION · ${s.network.toUpperCase()} · ${s.role.toUpperCase()}`} title={s.id} description={live ? 'The cage card, read from testnet: the key\'s scope from view_access_key, the receiver\'s code from view_account.' : 'The cage card as the sandbox run read it from its chain. That chain stopped with the run, so nothing here is re-read.'} action={<SessionBadge state={state} />} />
    <div className="detail-status-row"><SessionBadge state={state} /><span className="detail-status-copy"><i /> {state.detail}</span>{live ? <ReadStamp at={key.at} loading={key.loading} onRefresh={() => { key.refresh(); code.refresh() }} /> : <span className="detail-status-time">recorded {s.lastRead ? utc(s.lastRead.readAt) : utc(s.createdAt)}</span>}</div>
    <div className="detail-layout">
      <section className="panel cage-card">
        <div className="cage-topline"><div className="cage-brand"><span className="cage-icon"><KeyRound size={15} /></span><strong>KEYHOLE <span>· CAGE CARD</span></strong></div><StatusBadge tone={live ? 'protocol' : 'muted'}>{live ? 'READ FROM CHAIN' : `RECORDED · ${s.source.toUpperCase()}`}</StatusBadge></div>
        <div className="cage-title-row"><div><div className="section-kicker">{s.id} · {s.network.toUpperCase()}</div><h2>Function-call key scope</h2></div><div className="cage-live"><i className={gone ? 'is-muted' : ''} />{gone ? 'BURNED' : s.mode.toUpperCase()}</div></div>
        {live && k && k.state !== 'function-call' && <div className="cage-alert"><CircleAlert size={15} /><span>{k.state === 'error' ? `The RPC did not answer with the key: ${k.error}. The rows below are the session's record.` : `${k.state === 'full-access' ? 'A full-access key' : 'No key'} — the chain answered ${k.state === 'no-key' || k.state === 'no-account' ? `“${k.error}”` : 'FullAccess'}. The rows below are the scope it had at wrap.`}</span></div>}
        <div className="cage-rules">
          <CageRule label="RECEIVER" value={<code>{fc?.receiverId ?? s.receiverId}</code>} enforcer="PROTOCOL" />
          <CageRule label="SIGNER" value={<><AccountLink network={s.network} account={s.accountId} /> <span className="chip">{s.mode}</span></>} enforcer="—" />
          <div className="cage-rule-row"><div className="cage-rule-label">METHOD</div><div className="cage-rule-value"><div className="tool-lines">{toolRows.map((t) => <div className="tool-line" key={t.name + t.method} title={t.evidence}><code className={t.note === 'not in allowlist' ? '' : 'cyan-text'}>{t.method}</code><span className="tool-name">{t.name !== t.method ? t.name : ''}</span><span className="lead" /><span className={`tool-note${t.note === 'not in allowlist' ? ' is-out' : ''}`}>{t.note}</span></div>)}<div className="tool-line"><span>every other method</span><span className="lead" /><span className="tool-note is-out">not in allowlist</span></div></div></div><div className="cage-rule-owner">PROTOCOL</div></div>
          <CageRule label="ACTIONS" value="One FunctionCall per transaction · no Transfer · no AddKey" enforcer="PROTOCOL" />
          <CageRule label="DEPOSIT" value="0 only · methods that demand one fail at runtime" enforcer="PROTOCOL" />
          <div className="cage-rule-row"><div className="cage-rule-label">GAS ALLOWANCE</div><div className="cage-rule-value"><strong>{remaining ? `${formatNear(remaining)} of ${formatNear(s.allowanceYocto)} NEAR left` : `${formatNear(s.allowanceYocto)} NEAR at wrap`}</strong><div className="gas-track wide"><span style={{ width: `${remaining ? percentOf(remaining, s.allowanceYocto) : 0}%` }} /></div><small>{fc ? 'gas only · from view_access_key now' : s.lastRead ? `gas only · as the run read it at step ${s.lastRead.step}${live ? '; the key is gone now' : ''}` : 'gas only · as wrapped'}</small></div><div className="cage-rule-owner">PROTOCOL</div></div>
          <div className={`cage-rule-row code-hash-row ${pin.match === false ? 'mismatch-row' : ''}`}><div className="cage-rule-label">CODE HASH</div><div className="cage-rule-value"><code>{observed ?? s.codeHashPin}</code><small><StatusBadge tone={pin.tone}>{pin.label}</StatusBadge> {pin.detail}</small></div><div className="cage-rule-owner">KEYHOLE</div></div>
          {pack?.exposure && <CageRule label={pack.exposure.label} value={pack.exposure.value} enforcer="NOT A KEY LIMIT" />}
          <CageRule label="EXPIRY" value={<>none in the protocol; ends at <code>keyhole burn {s.id}</code></>} enforcer="OPERATOR" />
          <CageRule label="PUBLIC KEY" value={s.publicKey} enforcer="—" mono />
        </div>
        <div className="cage-bottom"><span><Info size={14} />{live ? 'This page holds no key: every read is a view.' : `Source: ${s.source}`}</span><button className="quiet-button" onClick={copyScope}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied scope' : 'Copy scope summary'}</button></div>
      </section>

      <aside className="detail-aside">
        <section className={`panel hash-panel ${pin.match === false ? 'hash-warning' : ''}`}>
          <div className="panel-heading"><div><div className="section-kicker">SERVER-SIDE CHECK</div><h2>Code integrity</h2></div>{pin.match === false ? <CircleAlert size={18} className="amber-text" /> : <CircleCheck size={18} className="green-text" />}</div>
          <div className="hash-status"><StatusBadge tone={pin.tone} dot>{pin.label}</StatusBadge><span>serve compares the receiver's code_hash with the pin before each pack call that signs.</span></div>
          <div className="hash-pair"><span>PINNED AT WRAP</span><code>{shortAddress(s.codeHashPin, 16, 9)}</code></div>
          <div className="hash-pair"><span>{live ? 'RECEIVER NOW' : 'RECEIVER AT READ'}</span><code className={pin.match === false ? 'amber-text' : ''}>{observed ? shortAddress(observed, 16, 9) : '—'}</code></div>
          <div className="hash-disclaimer"><Info size={14} /><span>{pack ? `${pack.id} pack: ${pack.description.split('. ')[0]}.` : 'No pack.'}</span></div>
        </section>
        <section className="panel key-state-panel">
          <div className="section-kicker">KEY LIFECYCLE</div><h2>{s.burn ? 'Wrapped, used, burned' : 'Wrapped, not burned'}</h2>
          <div className="lifecycle-line"><span className="lifecycle-icon"><KeyRound size={16} /></span><div><strong>Wrapped {utc(s.createdAt)}</strong><small>AddKey signed by the operator · <TxLink network={s.network} hash={s.wrap.txHash} />{s.wrap.step ? ` · step ${s.wrap.step}` : ''}</small></div></div>
          {s.lastRead && <div className="lifecycle-line"><span className="lifecycle-icon"><Fingerprint size={16} /></span><div><strong>Inspected {utc(s.lastRead.readAt)}</strong><small>keyhole inspect read the card from chain · step {s.lastRead.step}</small></div></div>}
          {s.burn
            ? <div className="lifecycle-line"><span className="lifecycle-icon is-burn"><Flame size={16} /></span><div><strong>Burned at step {s.burn.step}</strong><small>{s.burn.label} · <TxLink network={s.network} hash={s.burn.txHash} />{s.burn.note ? ` · ${s.burn.note}` : ''}</small></div></div>
            : <div className="burn-note"><ShieldAlert size={14} /><span>No burn yet. The operator ends this key with <code>npm run keyhole -- burn {s.id}</code>; the protocol never expires it.</span></div>}
          {live && <div className="lifecycle-now"><span>CHAIN NOW</span><SessionBadge state={state} /></div>}
        </section>
        <div className="scope-limit-card"><ShieldAlert size={16} /><div><strong>No value cap</strong><p>The allowance pays gas, not value. What the signer owns inside the receiver stays reachable through the allowed method.</p><Link to="/security">See the trust model <ArrowRight size={13} /></Link></div></div>
      </aside>
    </div>
    {(refusals.length > 0 || steps.length > 0) && <section className="panel session-evidence">
      <div className="panel-heading"><div><div className="section-kicker">SIGNED WITH THIS KEY · {run?.label.toUpperCase()}</div><h2>{steps.length} attempts, {refusals.length} refused by the protocol</h2></div>{run && <Link className="text-link" to={`/activity?run=${run.network}`}>Run log <ArrowRight size={14} /></Link>}</div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>STEP</th><th>ATTEMPT</th><th>CHAIN ANSWER</th></tr></thead><tbody>{steps.map((st) => {
        const ref = st.fixture ? data.refusals.find((r) => r.fixture === st.fixture) : undefined
        return <tr key={st.n}><td className="muted-cell">{String(st.n).padStart(2, '0')}/{st.total}</td><td>{st.label}{st.proposal && <small>proposal #{st.proposal.id} → {st.proposal.status} · {st.proposal.approvals} of {st.proposal.required}</small>}</td><td>{ref ? <Link to={`/evidence?fixture=${encodeURIComponent(ref.fixture)}`}><StatusBadge tone="error">{ref.errorName}</StatusBadge></Link> : st.txHashes[0] ? <TxLink network={s.network} hash={st.txHashes[0]} /> : <StatusBadge tone="muted">NO TX</StatusBadge>}</td></tr>
      })}</tbody></table></div>
    </section>}
    <div className="detail-meta-grid">
      <MetaCard icon={<Fingerprint size={16} />} label="SIGNER MODE" value={s.mode} note={s.accountId} />
      <MetaCard icon={<ShieldCheck size={16} />} label="TARGET PACK" value={s.packId} note={`pins ${shortAddress(s.codeHashPin, 10, 6)}`} />
      <MetaCard icon={<CircleCheck size={16} />} label="SOURCE" value={s.source.split(' ')[0]} note={<a href={repoFile(data.repo, s.source.split(' ')[0])} target="_blank" rel="noreferrer">open on GitHub</a>} />
    </div>
  </>
}

function CageRule({ label, value, enforcer, mono = false }: { label: string; value: ReactNode; enforcer: string; mono?: boolean }) {
  return <div className="cage-rule-row"><div className="cage-rule-label">{label}</div><div className={`cage-rule-value${mono ? ' mono' : ''}`}>{value}</div><div className="cage-rule-owner">{enforcer}</div></div>
}

function MetaCard({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note: ReactNode }) {
  return <div className="meta-card"><div className="meta-icon">{icon}</div><div><div className="meta-label">{label}</div><strong>{value}</strong><span>{note}</span></div></div>
}
