import { AlertTriangle, Check, CircleHelp, Fingerprint, LockKeyhole, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import type { Tone } from '../components/StatusBadge'
import { useData } from '../data/DataContext'

/** The README's boundary table (lines 3–10), row for row. */
const BOUNDARIES: { boundary: string; owner: string; tone: Tone; how: string; check: string }[] = [
  { boundary: 'method · action · receiver · deposit 0 · gas allowance', owner: 'PROTOCOL', tone: 'protocol', how: 'at transaction validation', check: 'view_access_key; the refusal ledger' },
  { boundary: 'the value the agent can move', owner: 'NOT A KEY LIMIT', tone: 'warning', how: 'only what the session account owns in the target', check: 'target views' },
  { boundary: 'target code unchanged (code_hash pin)', owner: 'KEYHOLE server-side', tone: 'violet', how: 'serve, before each pack call (dao_vote)', check: 'keyhole inspect' },
  { boundary: 'key lifetime', owner: 'OPERATOR', tone: 'warning', how: 'keyhole burn; no protocol expiry', check: 'AccessKeyNotFound after burn' },
  { boundary: 'refused attempts', owner: '—', tone: 'muted', how: 'nothing on-chain; the RPC response is the evidence', check: 'demo/fixtures/' },
  { boundary: 'how the agent votes', owner: 'NOT A KEY LIMIT', tone: 'warning', how: 'the prompt; the DAO\'s quorum (2-of-2 in the demo DAO) is the control', check: 'proposal status' },
]

const LAYERS: { owner: string; badge: string; tone: Tone; detail: string }[] = [
  { owner: 'NEAR protocol', badge: 'PROTOCOL', tone: 'protocol', detail: 'Receiver, method, one FunctionCall action, zero deposit and the gas allowance are checked at transaction validation. An attempt outside them is refused before it reaches a block.' },
  { owner: 'Keyhole server', badge: 'SERVER-SIDE', tone: 'violet', detail: 'serve compares the receiver\'s code_hash with the pack\'s pin before each pack call that signs, and refuses on a mismatch. This is Keyhole\'s code, not a key permission.' },
  { owner: 'Operator', badge: 'OPERATOR', tone: 'warning', detail: 'The operator wraps the session and decides when it ends: keyhole burn deletes the key. The protocol imposes no expiry.' },
  { owner: 'DAO governance', badge: 'QUORUM', tone: 'verified', detail: 'The quorum decides whether a proposal passes. The key limits which method the agent can call, not how it votes.' },
  { owner: 'Agent prompt', badge: 'PROMPT', tone: 'muted', detail: 'The prompt shapes what the agent tries. It is not a boundary: the injected proposal on this DAO exists to show the key holds either way.' },
]

export default function SecurityPage() {
  const data = useData()
  return <>
    <PageHeader eyebrow="THREAT MODEL · README" title="Security model" description="What the protocol enforces, what Keyhole checks, what people decide, and what nobody limits." action={<StatusBadge tone="muted" dot>REFERENCE</StatusBadge>} />
    <div className="security-summary"><div className="summary-mark"><LockKeyhole size={21} /></div><div><span>ONE FUNCTION-CALL KEY PER AGENT SESSION</span><h2>The agent holds one key that can call only the methods you allowed, and one keyhole burn deletes it.</h2><p>NEAR checks the key's receiver, methods, action, deposit and gas allowance at transaction validation. Keyhole separately pins the target's code before each pack call. The rest is people: the operator's burn and the DAO's quorum.</p></div></div>
    <div className="security-layer-list">{LAYERS.map((layer, index) => <article className="panel security-layer" key={layer.owner}><div className={`layer-number layer-${layer.tone}`}>{String(index + 1).padStart(2, '0')}</div><div className="layer-owner"><strong>{layer.owner}</strong><StatusBadge tone={layer.tone}>{layer.badge}</StatusBadge></div><p>{layer.detail}</p></article>)}</div>
    <div className="security-limits-grid">
      <section className="panel limit-card limit-warning"><div className="limit-heading"><span><AlertTriangle size={16} /></span><StatusBadge tone="warning">NOT A KEY LIMIT</StatusBadge></div><h2>No value cap</h2><p>The gas allowance pays for gas only. Through an allowed method, the agent reaches anything the signer owns inside the receiver.</p><div className="limit-bottom"><strong>Control lives in</strong><span>the target contract · the signer's holdings · the DAO's policy</span></div></section>
      <section className="panel limit-card"><div className="limit-heading"><span><CircleHelp size={16} /></span><StatusBadge tone="muted">OPERATOR CONTROL</StatusBadge></div><h2>No protocol expiry</h2><p>A function-call key lives until it is deleted. The operator ends the session with keyhole burn; the run log shows both burns and the refusal after each.</p><div className="limit-bottom"><strong>Control lives in</strong><span><Link to="/activity?run=testnet&phase=burn">keyhole burn</Link></span></div></section>
      <section className="panel limit-card"><div className="limit-heading"><span><Fingerprint size={16} /></span><StatusBadge tone="muted">KEYS STAY LOCAL</StatusBadge></div><h2>One private key in serve</h2><p>The operator's full-access key signs wrap and burn on the operator's machine. serve loads one private key, the session's; the agent never sees a private key.</p><div className="limit-bottom"><strong>This site</strong><span>no wallet · no private key · views only</span></div></section>
    </div>
    <section className="panel boundaries-table-panel"><div className="panel-heading"><div><div className="section-kicker">BOUNDARY MAP · README</div><h2>Who enforces what</h2></div><a className="text-link" href={data.repo} target="_blank" rel="noreferrer">README</a></div><div className="boundary-grid boundary-grid-4"><div className="boundary-head">BOUNDARY</div><div className="boundary-head">ENFORCED BY</div><div className="boundary-head">HOW</div><div className="boundary-head">CHECK IT WITH</div>{BOUNDARIES.map((b) => <BoundaryRow key={b.boundary} {...b} />)}</div></section>
    <div className="security-footer-callout"><ShieldAlert size={16} /><span><strong>This site reads only.</strong> It cannot wrap, burn or sign. Every live value on it is a view anyone can repeat; every recorded value links to its file in the repo.</span></div>
  </>
}

function BoundaryRow({ boundary, owner, tone, how, check }: { boundary: string; owner: string; tone: Tone; how: string; check: string }) {
  return <><div className="boundary-property"><Check size={14} />{boundary}</div><div><StatusBadge tone={tone}>{owner}</StatusBadge></div><div className="boundary-note">{how}</div><div className="boundary-note"><code>{check}</code></div></>
}
