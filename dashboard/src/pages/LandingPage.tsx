import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, Clipboard, Github, RefreshCw } from 'lucide-react'
import StatusBadge from '../components/StatusBadge'
import type { Tone } from '../components/StatusBadge'
import { pinVerdict, SessionBadge, sessionState } from '../components/Live'
import { useData } from '../data/DataContext'
import { useAccessKey, useBlock, useCodeHash, usePolicy, useProposals } from '../data/live'
import { councilMembers, requiredApprovals } from '../data/quorum'
import { AccountLink, copyText, formatNear, percentOf, repoFile, shortAddress, Ticks, TxLink, utcNow } from '../data/format'
import type { Run, Step } from '../data/types'
import { BOUNDARIES } from './SecurityPage'
import { COMMANDS, MCP_TOOLS } from './CommandsPage'

/**
 * The landing page at the site's root. Every record on it comes from data/keyhole.json (the committed runs) or from a
 * testnet read made by the visitor's browser; test/dashboard.test.ts keeps RESULT lines and hashes out of this file.
 */

const SECTIONS = [
  { id: 'how', label: 'How it works' },
  { id: 'enforce', label: 'Who enforces what' },
  { id: 'limits', label: 'Limits' },
  { id: 'try', label: 'Try it' },
]

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const word = (n: number) => WORDS[n] ?? String(n)
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const HIDDEN_COMMENT = /<!--[\s\S]*?-->/

function jump(id: string) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

export default function LandingPage() {
  const data = useData()
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-inner">
          <Link to="/" className="lp-brand" aria-label="Keyhole home"><img src="./keyhole-mark.svg" alt="" width="28" height="28" /><span>keyhole</span></Link>
          <nav className="lp-nav-links" aria-label="Sections">{SECTIONS.map((s) => <button key={s.id} type="button" onClick={() => jump(s.id)}>{s.label}</button>)}</nav>
          <div className="lp-nav-actions">
            <a className="lp-icon-link" href={data.repo} target="_blank" rel="noreferrer" aria-label="Source on GitHub" title="Source on GitHub"><Github size={17} /></a>
            <Link className="lp-button lp-button-small" to="/overview">Open the console</Link>
          </div>
        </div>
      </header>
      <main>
        <Hero />
        <LiveKey />
        <HowItWorks />
        <Enforcement />
        <Limits />
        <TryIt />
      </main>
      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-inner">
          <div className="lp-brand lp-brand-quiet"><img src="./keyhole-mark.svg" alt="" width="22" height="22" /><span>keyhole</span></div>
          <p>This page reads public data from NEAR testnet and signs nothing. Keyhole is MIT-licensed.</p>
          <div className="lp-footer-links">
            <a href={data.repo} target="_blank" rel="noreferrer">Source on GitHub</a>
            <a href={`${data.repo}#readme`} target="_blank" rel="noreferrer">README</a>
            <Link to="/overview">Operator console</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------------ hero: the testnet run, row by row */

function Hero() {
  const data = useData()
  const run = data.runs.find((r) => r.network === 'testnet')!
  const rows = run.steps.filter((s) => s.signer === 'session' || s.phase === 'burn')
  const date = new Date(run.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <section className="lp-hero" aria-labelledby="lp-title">
      <div className="lp-wrap">
        <div className="lp-hero-top">
          <h1 id="lp-title">An agent gets one NEAR key. The chain refuses everything outside it.</h1>
          <div className="lp-hero-lede">
            <p>An agent that signs NEAR transactions needs a key, and a full-access key can do anything the account can. Keyhole gives the agent a function-call key instead: one contract, the methods you allow, a gas allowance and no deposit. It serves that key to an MCP client as tools, and one <code>keyhole burn</code> deletes it.</p>
            <div className="lp-cta">
              <Link className="lp-button" to="/overview">Open the operator console</Link>
              <a className="lp-button lp-button-ghost" href={data.repo} target="_blank" rel="noreferrer"><Github size={16} />Source on GitHub</a>
            </div>
          </div>
        </div>

        <div className="lp-ledger" role="table" aria-label={`What the session key tried in the testnet run of ${date}, and the chain's answer`}>
          <p className="lp-ledger-caption">The testnet demo run of {date}, from <a href={repoFile(data.repo, run.transcript)} target="_blank" rel="noreferrer"><code>{run.transcript}</code></a>. The agent's session key signed every attempt; the operator's key signed the burn.</p>
          <div className="lp-ledger-head" role="row"><span role="columnheader">What was tried</span><span role="columnheader">Transaction</span><span role="columnheader">Chain's answer</span></div>
          {rows.map((s, i) => <LedgerRow key={s.n} run={run} step={s} index={i} />)}
          <div className="lp-ledger-foot">
            {data.runs.map((r) => <code key={r.id}>{r.label}: RESULT {[r.result.pass, ...r.result.parts].join(' · ')}</code>)}
            <Link to="/activity?run=testnet">Open the run log</Link>
          </div>
        </div>
      </div>
    </section>
  )
}

function call(step: Step): string {
  const a = step.attempt
  if (!a) return step.label
  const deposit = a.depositYocto && a.depositYocto !== '0' ? a.depositYocto : null
  if (a.action === 'Transfer') return `Transfer ${deposit ?? '0'} yoctoNEAR to ${a.receiverId}`
  return `${a.method} on ${a.receiverId}${deposit ? `, ${deposit} yoctoNEAR attached` : ''}`
}

function LedgerRow({ run, step, index }: { run: Run; step: Step; index: number }) {
  const data = useData()
  const refusal = data.refusals.find((r) => r.runId === run.id && r.step === step.n)
  const operator = step.signer !== 'session'
  const style = { '--i': index } as CSSProperties
  return (
    <div className={`lp-ledger-row${refusal ? ' is-refused' : ' is-landed'}${operator ? ' is-operator' : ''}`} role="row" style={style}>
      <span role="cell" className="lp-what">{operator ? 'The operator burns the session key' : capital(step.label)}</span>
      <span role="cell" className="lp-call"><code>{call(step)}</code></span>
      <span role="cell" className="lp-answer">
        {refusal
          ? <><span className="lp-verdict">refused</span><Link to={`/evidence?fixture=${encodeURIComponent(refusal.fixture)}`}><code>{refusal.errorName}</code></Link></>
          : <><span className="lp-verdict">landed</span>{step.txHashes[0] && <TxLink network={run.network} hash={step.txHashes[0]} />}{step.proposal && <small>#{step.proposal.id}: {step.proposal.approvals} of {step.proposal.required} approvals</small>}</>}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ the judging key, read from testnet */

function LiveKey() {
  const data = useData()
  const lead = data.sessions.find((s) => s.id === data.judgingSessionId)!
  const key = useAccessKey(lead.accountId, lead.publicKey)
  const code = useCodeHash(lead.receiverId)
  const block = useBlock()
  const proposals = useProposals(data.dao)
  const policy = usePolicy(data.dao)
  const state = sessionState(lead, key)
  const k = key.value
  const fc = k?.state === 'function-call' ? k : null
  const observed = code.value?.ok ? code.value.codeHash : null
  const pin = pinVerdict(observed, lead.codeHashPin, data.packs)
  const list = proposals.value?.ok ? proposals.value.value : null
  const pol = policy.value?.ok ? policy.value.value : null
  const members = pol ? councilMembers(pol) : null
  const need = pol ? requiredApprovals(pol) : null
  const open = list?.filter((p) => p.status === 'InProgress') ?? []
  const hidden = list?.filter((p) => HIDDEN_COMMENT.test(p.description)) ?? []
  const loading = key.loading || code.loading || proposals.loading || policy.loading
  const refresh = () => { key.refresh(); code.refresh(); block.refresh(); proposals.refresh(); policy.refresh() }
  const failed = [k?.state === 'error' ? `view_access_key: ${k.error}` : null, code.value && !code.value.ok ? `view_account: ${code.value.error}` : null, proposals.value && !proposals.value.ok ? `get_proposals: ${proposals.value.error}` : null].filter(Boolean)

  const allowance = fc?.allowanceYocto ?? null
  const rows: { label: string; value: ReactNode; by: string; tone: Tone }[] = [
    { label: 'RECEIVER', value: fc?.receiverId ?? lead.receiverId, by: 'PROTOCOL', tone: 'protocol' },
    { label: 'METHOD', value: (fc?.methodNames ?? lead.methodNames).join(', '), by: 'PROTOCOL', tone: 'protocol' },
    { label: 'ACTIONS', value: 'one FunctionCall per tx; no Transfer, no AddKey', by: 'PROTOCOL', tone: 'protocol' },
    { label: 'DEPOSIT', value: '0 only', by: 'PROTOCOL', tone: 'protocol' },
    {
      label: 'GAS',
      value: <span className="lp-gas"><span className="lp-gas-track"><i style={{ width: `${allowance ? percentOf(allowance, lead.allowanceYocto) : 0}%` }} /></span>{allowance ? `${formatNear(allowance)} of ${formatNear(lead.allowanceYocto)} NEAR left, gas only` : `${formatNear(lead.allowanceYocto)} NEAR at wrap, gas only`}</span>,
      by: 'PROTOCOL', tone: 'protocol',
    },
    { label: 'CODE HASH', value: `${shortAddress(observed ?? lead.codeHashPin, 10, 6)} · ${observed ? (pin.match ? 'match' : pin.label.toLowerCase()) : 'reading'}`, by: 'KEYHOLE', tone: 'violet' },
    { label: 'VOTE', value: `any proposal here, either way, until burn${need && members ? `; quorum ${need}-of-${members.length}` : ''}`, by: 'NOT A KEY LIMIT', tone: 'warning' },
    { label: 'EXPIRY', value: `none in the protocol; ends at keyhole burn ${lead.id}`, by: 'OPERATOR', tone: 'warning' },
  ]

  return (
    <section className="lp-section lp-live" aria-labelledby="lp-live-title">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <h2 id="lp-live-title">The judging key is live on testnet</h2>
          <p>Your browser read the values below from NEAR testnet when this page opened: the key's scope with <code>view_access_key</code>, the DAO's code hash, proposals and policy with its views. The key stays live through judging, until the operator burns it.</p>
        </div>
        {failed.length > 0 && <div className="lp-alert" role="status">Testnet did not answer every read ({failed.join('; ')}). Rows without a live value show what was recorded at wrap. <button type="button" onClick={refresh}>Read again</button></div>}
        <div className="lp-live-grid">
          <figure className="lp-card" aria-label={`Cage card of session ${lead.id}`}>
            <div className="lp-card-head"><code>keyhole · cage card · {lead.id} · {lead.network} · {lead.mode}</code><SessionBadge state={state} /></div>
            <dl className="lp-card-rows">
              {rows.map((r) => <div key={r.label} className="lp-card-row"><dt>{r.label}</dt><dd>{r.value}</dd><span className={`lp-by lp-by-${r.tone}`}>{r.by}</span></div>)}
            </dl>
            <figcaption className="lp-card-foot">
              <span>{key.loading ? 'reading from testnet…' : key.at ? `read from chain: view_access_key${block.value?.ok ? `, block #${block.value.height.toLocaleString('en-US')}` : ''}, ${utcNow(key.at)}` : 'not read yet'}</span>
              <button type="button" className="lp-icon-button" onClick={refresh} disabled={loading} aria-label="Read again from testnet" title="Read again from testnet"><RefreshCw size={14} /></button>
            </figcaption>
          </figure>

          <div className="lp-dao">
            <h3>The DAO it votes in</h3>
            <p><AccountLink network="testnet" account={data.dao.accountId} />, created by the testnet run. {observed ? (pin.match ? 'It runs the code the session pinned at wrap.' : pin.detail) : 'Reading its code hash…'}</p>
            <dl className="lp-stats">
              <div><dt>Proposals</dt><dd>{list ? list.length : '…'}</dd></div>
              <div><dt>Waiting for quorum</dt><dd>{list ? open.length : '…'}</dd></div>
              <div><dt>Approvals to pass</dt><dd>{need && members ? `${need} of ${members.length}` : '…'}</dd></div>
            </dl>
            {hidden.length > 0 && <p>{capital(word(hidden.length))} of {list!.length === hidden.length ? 'them' : 'these proposals'} {hidden.length === 1 ? 'hides' : 'hide'} an HTML comment in the description: text an agent reads and a person skimming a DAO interface may not see. Whatever the agent makes of it, this key can only call <code>{lead.methodNames.join(', ')}</code> here, and the council's quorum decides.</p>}
            <div className="lp-links">
              <Link to={hidden[0] ? `/proposals?id=${hidden[0].id}` : '/proposals'}>Read the proposals</Link>
              <Link to={`/inspect?account=${encodeURIComponent(lead.accountId)}&key=${encodeURIComponent(lead.publicKey)}`}>Check the key yourself</Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ how a session works */

function HowItWorks() {
  const steps: { name: string; text: ReactNode; key: string }[] = [
    { name: 'wrap', text: <>Adds a function-call key for one agent session: one receiver, the methods you allow, a gas allowance, no deposit. Before it signs, it dry-runs each method on a near-sandbox copy of the target and labels what the key will be able to call.</>, key: 'The operator\'s full-access key, for one transaction after a typed yes.' },
    { name: 'inspect', text: <>Reads the key's scope and the target's code hash from chain and prints the cage card, each row tagged with what enforces it.</>, key: 'None. It only reads.' },
    { name: 'serve', text: <>Runs an MCP server for Claude Code or Codex. With a Sputnik pack it exposes {word(MCP_TOOLS.length)} tools: {MCP_TOOLS.map((t, i) => <span key={t.name}>{i ? ', ' : ''}<code>{t.name}</code></span>)}. Before each <code>dao_vote</code> it re-reads the DAO's code hash and signs nothing if the code changed since wrap.</>, key: 'One private key: the session\'s.' },
    { name: 'burn', text: <>Deletes the session key, or the session sub-account in sub-account mode. The protocol sets no expiry, so the session ends when the operator burns it.</>, key: 'The operator\'s full-access key, for one transaction.' },
  ]
  return (
    <section className="lp-section" id="how" aria-labelledby="lp-how-title">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <h2 id="lp-how-title">One session, four commands</h2>
          <p>Wrap and burn are the only steps that touch a full-access key, and they run on the operator's machine. The agent never sees a private key: it talks to <code>serve</code>, which holds the session key alone.</p>
        </div>
        <ol className="lp-steps">
          {steps.map((s, i) => (
            <li key={s.name} className="lp-step">
              <span className="lp-step-n" aria-hidden="true">{i + 1}</span>
              <h3><code>keyhole {s.name}</code></h3>
              <p>{s.text}</p>
              <p className="lp-step-key"><strong>Key it loads.</strong> {s.key}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ who enforces what */

function Enforcement() {
  const data = useData()
  return (
    <section className="lp-section" id="enforce" aria-labelledby="lp-enforce-title">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <h2 id="lp-enforce-title">Who enforces what</h2>
          <p>NEAR's own access-key check carries most of the scope, at transaction validation, before anything reaches a block. The rest is named for what it is, including the two rows no key can limit.</p>
        </div>
        <div className="lp-table" role="table" aria-label="Boundaries and what enforces each">
          <div className="lp-table-head" role="row"><span role="columnheader">Boundary</span><span role="columnheader">Enforced by</span><span role="columnheader">How</span><span role="columnheader">Check it with</span></div>
          {BOUNDARIES.map((b) => (
            <div className="lp-table-row" role="row" key={b.boundary}>
              <span role="cell" className="lp-boundary">{b.boundary}</span>
              <span role="cell"><StatusBadge tone={b.tone}>{b.owner}</StatusBadge></span>
              <span role="cell">{b.how}</span>
              <span role="cell" className="lp-check">{b.check}</span>
            </div>
          ))}
        </div>
        <p className="lp-after">
          {capital(word(data.refusals.length))} refusals are on record, each the RPC response body byte for byte, replayed offline by <code>npm test</code>. <Link to="/evidence">Open the refusal ledger</Link>
        </p>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ limits */

function Limits() {
  const data = useData()
  const packs = data.packs.map((p) => p.id)
  const items: { title: string; text: ReactNode }[] = [
    { title: 'No value cap.', text: 'The allowance pays for gas only. Through an allowed method, the agent reaches whatever the session account owns inside the target, up to what the operator put there.' },
    { title: 'No protocol expiry.', text: <>A function-call key lives until it is deleted. The operator ends the session with <code>keyhole burn</code>.</> },
    { title: 'The key limits the method, not the vote.', text: 'An agent with `act_proposal` can vote either way on any proposal in that DAO. The DAO\'s quorum is the control.' },
    { title: `${capital(word(packs.length))} target packs.`, text: <>{packs.map((p, i) => <span key={p}>{i ? (i === packs.length - 1 ? ' and ' : ', ') : ''}<code>{p}</code></span>)}. <code>wrap</code> picks the pack by the receiver's code hash and refuses a contract whose code no pack pins.</> },
    { title: 'Testnet and near-sandbox only.', text: 'No mainnet.' },
  ]
  return (
    <section className="lp-section" id="limits" aria-labelledby="lp-limits-title">
      <div className="lp-wrap lp-limits">
        <div className="lp-section-head">
          <h2 id="lp-limits-title">What it does not do</h2>
          <p>The limits are part of the design, and the cage card prints them next to what the protocol enforces.</p>
        </div>
        <ul className="lp-limit-list">{items.map((it) => <li key={it.title}><strong>{it.title}</strong> {typeof it.text === 'string' ? <Ticks text={it.text} /> : it.text}</li>)}</ul>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ try it */

function TryIt() {
  const data = useData()
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (id: string, text: string) => {
    if (await copyText(text)) setCopied(id)
    window.setTimeout(() => setCopied(null), 1500)
  }
  const picks = COMMANDS.filter((c) => ['test', 'sandbox', 'testnet'].includes(c.id))
  return (
    <section className="lp-section" id="try" aria-labelledby="lp-try-title">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <h2 id="lp-try-title">Run it yourself</h2>
          <p>From a clone of <a href={data.repo} target="_blank" rel="noreferrer">the repo</a>. The first needs no network at all; the README tags each step with what it needs and quotes a real run's output.</p>
        </div>
        <div className="lp-try">
          {picks.map((c) => (
            <article key={c.id} className="lp-try-item">
              <div className="lp-try-head"><h3>{c.label}</h3><StatusBadge tone={c.tone}>{c.tag}</StatusBadge></div>
              <div className="lp-try-code">
                <pre className="lp-code"><code>{c.command}</code></pre>
                <button type="button" className="lp-icon-button" onClick={() => copy(c.id, c.command)} aria-label={`Copy: ${c.label}`} title="Copy">{copied === c.id ? <Check size={14} /> : <Clipboard size={14} />}</button>
              </div>
              <p>{c.description}</p>
              <p className="lp-needs"><strong>Needs.</strong> {c.needs}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
