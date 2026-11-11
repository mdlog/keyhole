import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, CircleAlert, Clipboard, KeyRound, ScanSearch, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import { pinVerdict } from '../components/Live'
import { useData } from '../data/DataContext'
import { curlFor, host, readAccessKey, readCodeHash } from '../data/rpc'
import type { CodeRead, KeyRead } from '../data/rpc'
import { AccountLink, copyText, formatNear, percentOf, utcNow } from '../data/format'

const ACC_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
const PUB_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/
// A private key is 64 bytes: 87–88 base58 characters. Anything key-shaped and that long is cleared, base58 or not.
const SECRET_RE = /^(ed25519:)?[A-Za-z0-9]{80,90}$/
const PHRASE_RE = /^([a-z]+\s+){11,}[a-z]+$/i

const PRIVATE_KEY_MSG = 'That looks like a private key, so it was cleared and nothing was sent. Paste the public key: ed25519: and 43 or 44 base58 characters.'

type Result = { account: string; key: string; read: KeyRead; code: CodeRead | null; at: number }

export default function InspectPage() {
  const data = useData()
  const judging = data.sessions.find((s) => s.id === data.judgingSessionId)!
  const burned = data.sessions.find((s) => s.network === 'testnet' && s.burn)
  const [params, setParams] = useSearchParams()
  const [account, setAccount] = useState(params.get('account') ?? judging.accountId)
  const [key, setKey] = useState(params.get('key') ?? judging.publicKey)
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [invalid, setInvalid] = useState<'account' | 'key' | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [copied, setCopied] = useState(false)
  const seq = useRef(0)

  async function read(a: string, k: string) {
    setInvalid(null)
    if (SECRET_RE.test(k) || PHRASE_RE.test(k)) { setKey(''); setInvalid('key'); setMsg({ text: PRIVATE_KEY_MSG, bad: true }); return }
    if (!ACC_RE.test(a)) { setInvalid('account'); setMsg({ text: 'Not a NEAR account id: lowercase a-z, 0-9, - and _, joined by dots, 2 to 64 characters.', bad: true }); return }
    if (!PUB_RE.test(k)) { setInvalid('key'); setMsg({ text: 'Not an ed25519 public key: ed25519: and 43 or 44 base58 characters.', bad: true }); return }
    const mine = ++seq.current
    setBusy(true)
    setMsg({ text: 'Reading view_access_key from testnet.', bad: false })
    try {
      const r = await readAccessKey(a, k)
      const code = r.state === 'function-call' ? await readCodeHash(r.receiverId) : null
      if (mine !== seq.current) return
      setResult({ account: a, key: k, read: r, code, at: Date.now() })
      setMsg(message(r))
      const isJudging = a === judging.accountId && k === judging.publicKey
      setParams(isJudging ? {} : { account: a, key: k }, { replace: true })
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }

  // One read on arrival: the judging key, or the key named in the link.
  useEffect(() => { void read(account.trim(), key.trim()) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: FormEvent) => { e.preventDefault(); void read(account.trim(), key.trim()) }
  const preset = (a: string, k: string) => { setAccount(a); setKey(k); void read(a, k) }
  const curl = curlFor(account.trim() || judging.accountId, key.trim() || judging.publicKey)
  const copyCurl = async () => { setCopied(await copyText(curl)); window.setTimeout(() => setCopied(false), 1500) }

  return <>
    <PageHeader eyebrow="LIVE · VIEW_ACCESS_KEY" title="Key inspector" description="Read any testnet access key's scope from chain, the way keyhole inspect does. Paste an account and a public key; this page never asks for a private key." />
    <div className="notice-bar"><ScanSearch size={16} /><span>One read is a <code>view_access_key</code> on the account, then a <code>view_account</code> on the key's receiver for its code hash. Nothing is signed; the same read works from a terminal with the curl command below.</span></div>
    <div className="inspect-layout">
      <section className="panel inspect-form-panel">
        <div className="section-kicker">KEY TO READ</div><h2>Account and public key</h2>
        <form className="inspect-form" onSubmit={submit} noValidate>
          <label htmlFor="kh-account">ACCOUNT ID</label>
          <input id="kh-account" value={account} onChange={(e) => setAccount(e.target.value)} spellCheck={false} autoComplete="off" aria-invalid={invalid === 'account'} />
          <label htmlFor="kh-key">PUBLIC KEY</label>
          <input id="kh-key" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" aria-invalid={invalid === 'key'} placeholder="ed25519:…" />
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'READING…' : 'READ FROM CHAIN'}</button>
        </form>
        <p className={`inspect-msg${msg?.bad ? ' bad' : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
        <div className="preset-row">
          <span>TRY</span>
          <button className="quiet-button" onClick={() => preset(judging.accountId, judging.publicKey)}>{judging.id} · live</button>
          {burned && <button className="quiet-button" onClick={() => preset(burned.accountId, burned.publicKey)}>{burned.id} · burned</button>}
        </div>
        <details className="curl-details">
          <summary><TerminalSquare size={14} /> The same read with curl</summary>
          <pre className="payload-block"><code>{curl}</code></pre>
          <button className="quiet-button" onClick={copyCurl}>{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? 'Copied' : 'Copy command'}</button>
        </details>
      </section>
      <section className="panel cage-card inspect-card" aria-busy={busy}>
        <div className="cage-topline"><div className="cage-brand"><span className="cage-icon"><KeyRound size={15} /></span><strong>KEYHOLE <span>· CAGE CARD</span></strong></div><StatusBadge tone={tagTone(result?.read)} dot>{busy ? 'READING' : tag(result?.read)}</StatusBadge></div>
        {result ? <ResultCard result={result} judgingKey={judging.publicKey} judgingAllowance={judging.allowanceYocto} codeHashPin={result.key === judging.publicKey ? judging.codeHashPin : null} /> : <div className="empty-state">{busy ? 'Reading from testnet…' : 'No read yet.'}</div>}
      </section>
    </div>
  </>

  function ResultCard({ result: r, judgingKey, judgingAllowance, codeHashPin }: { result: Result; judgingKey: string; judgingAllowance: string; codeHashPin: string | null }) {
    const k = r.read
    const foot = <div className="cage-bottom"><span>{'url' in k ? `read from chain · ${host(k.url)} · ${utcNow(r.at)}` : utcNow(r.at)}{'block' in k ? ` · block ${k.block.toLocaleString('en-US')}` : ''}</span><AccountLink network="testnet" account={r.account} /></div>
    if (k.state === 'function-call') {
      const observed = r.code?.ok ? r.code.codeHash : null
      const pin = pinVerdict(observed, codeHashPin, data.packs)
      const isJudging = r.key === judgingKey
      return <>
        <div className="cage-title-row"><div><div className="section-kicker">{r.account}</div><h2>Function-call key</h2></div><div className="cage-live"><i />LIVE</div></div>
        <div className="cage-rules">
          <Rule label="RECEIVER" enforcer="PROTOCOL"><code>{k.receiverId}</code></Rule>
          <Rule label="METHOD" enforcer="PROTOCOL">{k.methodNames.length ? <div className="tool-lines">{k.methodNames.map((m) => <div className="tool-line" key={m}><code className="cyan-text">{m}</code><span className="lead" /><span className="tool-note">in allowlist</span></div>)}<div className="tool-line"><span>every other method</span><span className="lead" /><span className="tool-note is-out">not in allowlist</span></div></div> : <span className="amber-text">any method on the receiver (empty method_names)</span>}</Rule>
          <Rule label="ACTIONS" enforcer="PROTOCOL">One FunctionCall per transaction · no Transfer · no AddKey</Rule>
          <Rule label="DEPOSIT" enforcer="PROTOCOL">0 only · methods that demand one fail at runtime</Rule>
          <Rule label="GAS ALLOWANCE" enforcer="PROTOCOL">{k.allowanceYocto === null ? <span className="amber-text">no allowance limit on this key</span> : <><strong>{formatNear(k.allowanceYocto)} NEAR left</strong>{isJudging && <div className="gas-track wide"><span style={{ width: `${percentOf(k.allowanceYocto, judgingAllowance)}%` }} /></div>}<small>gas only{isJudging ? ` · of ${formatNear(judgingAllowance)} NEAR at wrap` : ''}</small></>}</Rule>
          <Rule label="CODE HASH" enforcer="KEYHOLE"><code>{observed ?? (r.code && !r.code.ok ? r.code.error : '—')}</code><small><StatusBadge tone={pin.tone}>{pin.label}</StatusBadge> {pin.detail}</small></Rule>
          <Rule label="VALUE" enforcer="NOT A KEY LIMIT">anything the signer owns inside the receiver</Rule>
          <Rule label="KEY" enforcer="—"><code>{r.key}</code><small>nonce {k.nonce}</small></Rule>
        </div>
        {foot}
      </>
    }
    if (k.state === 'full-access') {
      return <>
        <div className="cage-title-row"><div><div className="section-kicker">{r.account}</div><h2>Full-access key</h2></div><div className="cage-live is-warn"><i />FULL ACCESS</div></div>
        <div className="cage-alert"><ShieldAlert size={15} /><span>This key can do anything on the account: transfer, add keys, delete the account. It is the kind of key an agent should never hold.</span></div>
        <div className="cage-rules"><Rule label="PERMISSION" enforcer="PROTOCOL"><code>FullAccess</code></Rule><Rule label="KEY" enforcer="—"><code>{r.key}</code><small>nonce {k.nonce}</small></Rule></div>
        {foot}
      </>
    }
    return <>
      <div className="cage-title-row"><div><div className="section-kicker">{r.account}</div><h2>{k.state === 'error' ? 'The RPC did not answer' : k.state === 'no-account' ? 'No such account' : 'No such key'}</h2></div><div className="cage-live is-muted"><i />{k.state === 'error' ? 'RPC ERROR' : 'NOT FOUND'}</div></div>
      <div className="cage-alert"><CircleAlert size={15} /><span>{k.state === 'error' ? `Nothing was read and nothing was signed: ${k.error}.` : k.state === 'no-account' ? 'No such account on testnet: deleted, or never created.' : 'No such key on this account: burned, or never added.'}</span></div>
      <div className="payload-heading"><span>RPC RESPONSE BODY · VERBATIM</span></div>
      <pre className="payload-block"><code>{k.raw}</code></pre>
      {foot}
    </>
  }
}

function Rule({ label, enforcer, children }: { label: string; enforcer: string; children: ReactNode }) {
  return <div className="cage-rule-row"><div className="cage-rule-label">{label}</div><div className="cage-rule-value">{children}</div><div className="cage-rule-owner">{enforcer}</div></div>
}

function message(r: KeyRead): { text: string; bad: boolean } {
  if (r.state === 'function-call') return { text: 'Function-call key found. Every value on the card came back from the RPC just now.', bad: false }
  if (r.state === 'full-access') return { text: 'Full-access key found. It can do anything on this account.', bad: true }
  if (r.state === 'no-key') return { text: `No such key on this account. The RPC answered: ${r.error}`, bad: false }
  if (r.state === 'no-account') return { text: 'No such account: view_account answered UNKNOWN_ACCOUNT.', bad: false }
  return { text: `The RPC did not answer with a key (${r.error}). Retry, or run the curl command.`, bad: true }
}

const tag = (r: KeyRead | undefined) => (!r ? 'NOT READ' : r.state === 'function-call' ? 'LIVE' : r.state === 'full-access' ? 'FULL ACCESS' : r.state === 'error' ? 'RPC ERROR' : 'NOT FOUND')
const tagTone = (r: KeyRead | undefined) => (!r ? 'muted' : r.state === 'function-call' ? 'live' : r.state === 'full-access' ? 'error' : r.state === 'error' ? 'warning' : 'muted') as 'live' | 'error' | 'warning' | 'muted'
