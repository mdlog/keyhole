import { CircleAlert, Clock3, ShieldCheck, Vote } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { pinVerdict, ReadStamp } from '../components/Live'
import { useData } from '../data/DataContext'
import { useCodeHash, usePolicy, useProposals } from '../data/live'
import type { Proposal } from '../data/live'
import { councilMembers, kindName, requiredApprovals } from '../data/quorum'
import { AccountLink, formatNear, nsToIso, shortAddress, TxLink, utc } from '../data/format'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const statusTone = (s: string) => (s === 'Approved' ? 'verified' : s === 'InProgress' ? 'warning' : s === 'Rejected' || s === 'Removed' || s === 'Failed' ? 'error' : 'muted') as 'verified' | 'warning' | 'error' | 'muted'

/** `Transfer 0.0100 NEAR → grantee.x.testnet`, or the variant name. */
function kindLine(kind: unknown): string {
  if (isObj(kind) && isObj(kind.Transfer)) {
    const t = kind.Transfer
    const token = t.token_id ? ` of ${String(t.token_id)}` : ' NEAR'
    return `Transfer ${t.token_id ? String(t.amount) : formatNear(String(t.amount))}${token} → ${String(t.receiver_id)}`
  }
  return kindName(kind)
}

/** The description's first line, without HTML comments: what a list row can show. */
const headline = (d: string) => d.replace(/<!--[\s\S]*?-->/g, '').split('\n')[0].trim() || '(no description)'

export default function ProposalsPage() {
  const data = useData()
  const dao = data.dao
  const proposals = useProposals(dao)
  const policy = usePolicy(dao)
  const code = useCodeHash(dao.accountId)
  const [params, setParams] = useSearchParams()
  const list = proposals.value?.ok ? [...proposals.value.value].sort((a, b) => b.id - a.id) : null
  const pol = policy.value?.ok ? policy.value.value : null
  const selectedId = params.get('id') !== null ? Number(params.get('id')) : list?.find((p) => p.status === 'InProgress')?.id ?? list?.[0]?.id
  const proposal = list?.find((p) => p.id === selectedId) ?? list?.[0]
  const pin = pinVerdict(code.value?.ok ? code.value.codeHash : null, dao.codeHashPin, data.packs)
  const members = pol ? councilMembers(pol) : null
  const refresh = () => { proposals.refresh(); policy.refresh(); code.refresh() }

  return <>
    <PageHeader eyebrow={`GOVERNANCE · ${dao.accountId.toUpperCase()}`} title="DAO proposals" description="Read from the DAO's get_proposals and get_policy views as you open the page. No vote control is here: votes are signed by the agent's session key, through keyhole serve." action={<StatusBadge tone={list ? 'live' : proposals.value ? 'warning' : 'muted'} dot>{list ? `LIVE · BLOCK ${proposals.value?.ok ? proposals.value.block.toLocaleString('en-US') : ''}` : proposals.value ? 'RPC ERROR' : 'READING'}</StatusBadge>} />
    <div className="notice-bar"><Vote size={16} /><span>The function-call key restricts <strong>which method</strong> the agent can call (<code>act_proposal</code>); it does not constrain the vote's direction. The DAO's policy and quorum are the approval control.</span></div>
    {proposals.value && !proposals.value.ok && <div className="notice-bar notice-amber"><CircleAlert size={16} /><span>get_proposals did not answer: {proposals.value.error}. <button className="quiet-button" onClick={refresh}>Read again</button></span></div>}
    <div className="proposal-layout">
      <section className="panel proposal-list-panel">
        <div className="panel-heading"><div><div className="section-kicker">{list ? `${list.length} PROPOSALS ON CHAIN` : 'READING GET_PROPOSALS'}</div><h2>Proposal register</h2></div><span className="subtle-label">TESTNET</span></div>
        <div className="proposal-list">{list?.map((item) => {
          const seeded = dao.seeded.find((s) => s.id === item.id)
          return <button key={item.id} className={`proposal-list-item ${proposal?.id === item.id ? 'selected' : ''}`} onClick={() => setParams({ id: String(item.id) }, { replace: true })}>
            <div className="proposal-list-top"><span>#{item.id}</span><StatusBadge tone={statusTone(item.status)}>{item.status.toUpperCase()}</StatusBadge></div>
            <strong>{headline(item.description)}</strong>
            <div className="proposal-list-meta"><span>{kindName(item.kind)}</span><span>{item.vote_counts?.council?.[0] ?? 0} approve · {item.vote_counts?.council?.[1] ?? 0} reject</span>{seeded ? <span className="seeded-tag">RUN: {seeded.note}</span> : /<!--/.test(item.description) && <span className="seeded-tag">HIDDEN COMMENT</span>}</div>
          </button>
        })}{!list && <div className="empty-state">{proposals.value ? 'No proposals to show.' : 'Reading from testnet…'}</div>}</div>
        <div className="panel-bottom-link"><ReadStamp at={proposals.at} loading={proposals.loading} onRefresh={refresh} /></div>
      </section>
      <section className="panel proposal-detail-panel">
        {proposal ? <ProposalDetail p={proposal} policy={pol} seededNote={dao.seeded.find((s) => s.id === proposal.id)?.note ?? null} /> : <div className="empty-state">{proposals.value ? 'Select a proposal.' : 'Reading from testnet…'}</div>}
        <div className="proposal-source"><span>READ SOURCE</span><AccountLink network="testnet" account={dao.accountId} /><StatusBadge tone={pin.tone}>{pin.label}</StatusBadge></div>
      </section>
    </div>
    <section className="panel policy-panel">
      <div className="panel-heading"><div><div className="section-kicker">GET_POLICY · LIVE</div><h2>Who can approve</h2></div><ShieldCheck size={17} className="cyan-text" /></div>
      {pol && isObj(pol) ? <div className="policy-grid">
        <div><span>COUNCIL</span><strong>{members ? members.length : '—'} members</strong><small>{members?.map((m) => <code key={m}>{m}</code>)}</small></div>
        <div><span>APPROVALS TO PASS</span><strong>{requiredApprovals(pol) ?? '—'} of {members?.length ?? '—'}</strong><small>threshold {JSON.stringify((pol.default_vote_policy as Obj | undefined)?.threshold)} · {String((pol.default_vote_policy as Obj | undefined)?.weight_kind)}</small></div>
        <div><span>PROPOSAL BOND</span><strong>{typeof pol.proposal_bond === 'string' ? `${formatNear(pol.proposal_bond)} NEAR` : '—'}</strong><small>why the session key's 0-deposit add_proposal fails even in scope</small></div>
        <div><span>PROPOSAL PERIOD</span><strong>{typeof pol.proposal_period === 'string' ? `${Number(BigInt(pol.proposal_period) / 3600000000000n) / 24} days` : '—'}</strong><small>after which an InProgress proposal expires</small></div>
      </div> : <div className="empty-state">{policy.value && !policy.value.ok ? `get_policy did not answer: ${policy.value.error}` : 'Reading get_policy…'}</div>}
      <div className="table-foot"><span>DAO created by the testnet run, step {dao.create.step} · <TxLink network="testnet" hash={dao.create.txHash} /></span><span>code {code.value?.ok ? shortAddress(code.value.codeHash, 10, 6) : '…'} · {dao.packId} pack pin</span></div>
    </section>
  </>
}

function ProposalDetail({ p, policy, seededNote }: { p: Proposal; policy: unknown; seededNote: string | null }) {
  const approvals = p.vote_counts?.council?.[0] ?? 0
  const need = policy ? requiredApprovals(policy, p.kind) : null
  const hidden = /<!--[\s\S]*?-->/.test(p.description)
  return <>
    <div className="proposal-detail-top"><div><div className="section-kicker">PROPOSAL</div><div className="proposal-id">#{p.id}</div></div><StatusBadge tone={statusTone(p.status)} dot>{p.status.toUpperCase()}</StatusBadge></div>
    <h2>{headline(p.description)}</h2>
    {hidden && <div className="cage-alert"><CircleAlert size={15} /><span>The description hides an HTML comment: text an agent reads that a person skimming a DAO interface may not see.{seededNote ? <> The testnet run seeded this one as the <strong>{seededNote}</strong>.</> : ''} Whatever an agent makes of it, the key can only call <code>act_proposal</code> on this DAO, and the quorum decides the outcome.</span></div>}
    <div className="payload-heading"><span>DESCRIPTION · VERBATIM FROM CHAIN</span></div>
    <pre className="payload-block description-block"><code>{p.description}</code></pre>
    <div className="proposal-stats"><div><span>KIND</span><strong>{kindLine(p.kind)}</strong></div><div><span>PROPOSER</span><strong>{p.proposer}</strong></div><div><span>SUBMITTED</span><strong>{utc(nsToIso(p.submission_time))}</strong></div></div>
    <div className="quorum-card"><div className="quorum-heading"><span><ShieldCheck size={15} /> Council approvals</span><strong>{approvals} / {need ?? '?'}</strong></div><div className="quorum-track"><span style={{ width: `${need ? Math.min(100, (approvals / need) * 100) : 0}%` }} /></div><div className="quorum-caption"><span>{Object.entries(p.votes ?? {}).map(([who, v]) => `${who.split('.')[0]}: ${v}`).join(' · ') || 'no votes yet'}</span><span>get_policy · RoleWeight</span></div></div>
    <div className="governance-context"><div className="context-icon"><Clock3 size={15} /></div><p><strong>Approval is a governance decision.</strong> The session key can call <code>act_proposal</code> here, either way, until the operator burns it; the council's quorum decides whether a proposal passes.</p></div>
  </>
}
