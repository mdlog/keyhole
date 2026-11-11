import { useState } from 'react'
import { BookOpen, Check, Clipboard, Command, Info, LockKeyhole, TerminalSquare } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import StatusBadge from '../components/StatusBadge'
import type { Tone } from '../components/StatusBadge'
import { useData } from '../data/DataContext'
import { copyText, repoFile } from '../data/format'

/**
 * The README's "Try it" commands, run from the repo root. test/dashboard.test.ts checks that every
 * `npm run SCRIPT` named here exists in package.json.
 */
export const COMMANDS: { id: string; label: string; tag: string; tone: Tone; command: string; description: string; needs: string }[] = [
  { id: 'test', label: 'Replay the recorded evidence', tag: 'OFFLINE', tone: 'verified', command: 'npm ci && npm test', description: 'Installs the pinned dependencies, then replays every refusal body through parseRefusal. No NEAR node and no network: test/setup.ts replaces fetch in every test.', needs: 'Node 22.22.2 or newer · nothing else' },
  { id: 'sandbox', label: 'Run the demo on a local chain', tag: 'NETWORK · SANDBOX', tone: 'protocol', command: 'npm run keyhole -- demo --sandbox', description: 'Boots a private near-sandbox, creates the DAO from the vendored wasm, wraps a key, votes, makes four out-of-scope attempts, burns the key, then smoke-tests a counter in sub-account mode. RESULT 20/20 PASS.', needs: 'Downloads near-sandbox (about 90 MB) on the first run' },
  { id: 'testnet', label: 'Run the demo on testnet', tag: 'SIGNS · FUNDED ACCOUNT', tone: 'warning', command: 'export KEYHOLE_OPERATOR=YOUR-ACCOUNT.testnet\nexport KEYHOLE_DEMO_OUT=./my-run\nnpm run keyhole -- demo --testnet', description: 'The same 14 steps on testnet, each landed transaction linked to the explorer. KEYHOLE_DEMO_OUT keeps the committed demo/ files as they are.', needs: 'A testnet account with about 6.6 NEAR, its full-access key in the near-cli-rs legacy keychain' },
  { id: 'wrap', label: 'Wrap a DAO seat', tag: 'SIGNS · OPERATOR KEY', tone: 'warning', command: 'npm run keyhole -- wrap DAO --allow act_proposal \\\n  --gas 0.05N --on-account SEAT', description: 'The seat\'s full-access key signs one AddKey after a typed yes: a function-call key for act_proposal on the DAO, with a 0.05 NEAR gas allowance. Prints the session id and its cage card.', needs: 'A DAO whose code a Sputnik pack pins · the seat\'s full-access key' },
  { id: 'inspect', label: 'Inspect a session', tag: 'READ ONLY', tone: 'verified', command: 'npm run keyhole -- inspect ks-XXXX', description: 'Reads the session\'s key scope and the receiver\'s code hash from chain and prints the cage card. The Key inspector on this site makes the same reads.', needs: 'The session file on the operator\'s machine · no key used' },
  { id: 'serve', label: 'Serve the session to an MCP client', tag: 'SESSION KEY ONLY', tone: 'protocol', command: 'node <ABSOLUTE PATH>/bin/keyhole.mjs serve ks-XXXX', description: 'Started by the MCP client from examples/claude-code.mcp.json (node, never npm run: npm\'s banner would corrupt stdio). Loads one private key, the session\'s, and exposes five tools.', needs: 'A wrapped session · KEYHOLE_SESSION_KEY or the session\'s keychain file' },
  { id: 'burn', label: 'Burn the session', tag: 'SIGNS · OPERATOR KEY', tone: 'warning', command: 'npm run keyhole -- burn ks-XXXX', description: 'Deletes the session key (on-account mode) or the session sub-account (sub-account mode). After it, any attempt with the key comes back AccessKeyNotFound or SignerDoesNotExist.', needs: 'The operator\'s full-access key' },
]

export const MCP_TOOLS: { name: string; tag: string; tone: Tone; note: string }[] = [
  { name: 'keyhole_inspect', tag: 'READ', tone: 'verified', note: 'the cage card, read from chain' },
  { name: 'dao_list_proposals', tag: 'VIEW', tone: 'verified', note: 'get_proposals' },
  { name: 'dao_get_policy', tag: 'VIEW', tone: 'verified', note: 'get_policy' },
  { name: 'dao_vote', tag: 'CALL', tone: 'protocol', note: 'act_proposal, signed with the session key; code hash checked first' },
  { name: 'keyhole_attempt', tag: 'CALL', tone: 'warning', note: 'any action, signed with the session key; the chain answers' },
]

export default function CommandsPage() {
  const data = useData()
  const [copied, setCopied] = useState<string | null>(null)
  const copyCommand = async (id: string, command: string) => {
    if (await copyText(command)) setCopied(id)
    window.setTimeout(() => setCopied(null), 1500)
  }
  return <>
    <PageHeader eyebrow="OPERATOR REFERENCE · README › TRY IT" title="Command guide" description="The commands behind every record on this site, run from the repo root. Copying a command never runs it." action={<StatusBadge tone="muted" dot>COPY ONLY</StatusBadge>} />
    <div className="notice-bar"><LockKeyhole size={16} /><span>The npm name <code>keyhole</code> belongs to an unrelated package, so commands run as <code>npm run keyhole -- COMMAND</code> from a clone of the repo. Commands tagged SIGNS use a full-access key that stays on the operator's machine.</span></div>
    <div className="command-layout">
      <section className="command-list">{COMMANDS.map((item, index) => <article className="panel command-card" key={item.id}><div className="command-card-head"><div className="command-number">{String(index + 1).padStart(2, '0')}</div><div><div className="section-kicker">KEYHOLE CLI</div><h2>{item.label}</h2></div><StatusBadge tone={item.tone}>{item.tag}</StatusBadge></div><p>{item.description}</p><div className="command-code"><span className="prompt-sign">$</span><code>{item.command}</code><button className="copy-command" onClick={() => copyCommand(item.id, item.command)} aria-label={`Copy: ${item.label}`}>{copied === item.id ? <Check size={15} /> : <Clipboard size={15} />}{copied === item.id && <span>Copied</span>}</button></div><div className="command-meta"><span><Info size={13} />Needs</span><strong>{item.needs}</strong></div></article>)}</section>
      <aside className="command-aside">
        <section className="panel command-reference"><div className="reference-icon"><BookOpen size={17} /></div><div className="section-kicker">START HERE</div><h2>Clone and replay</h2><pre className="install-code"><code>git clone {data.repo}{`\n`}cd keyhole{`\n`}npm ci{`\n`}npm test</code></pre><p>The README's Try it section tags each step with what it needs and quotes the output of a real run.</p><a className="text-link" href={`${data.repo}#try-it`} target="_blank" rel="noreferrer">README › Try it</a></section>
        <section className="command-warning"><div className="warning-icon"><Command size={15} /></div><div><strong>Copy ≠ execute</strong><p>No command runner is connected to this page. Read a command before running it, above all the ones tagged SIGNS.</p></div></section>
        <section className="panel command-tool-list"><div className="section-kicker">MCP TOOL SURFACE · TOOLS/LIST</div><h2>Five tools</h2>{MCP_TOOLS.map((t) => <div className="tool-row" key={t.name} title={t.note}><span>{t.name}</span><StatusBadge tone={t.tone}>{t.tag}</StatusBadge></div>)}<small>serve reports <code>1 private key loaded (session)</code> and <code>5 tools</code>. Wrap and burn are not tools: the agent cannot extend or end its own key. <a href={repoFile(data.repo, 'examples/claude-code.mcp.json')} target="_blank" rel="noreferrer">examples/claude-code.mcp.json</a></small></section>
      </aside>
    </div>
    <div className="read-only-note"><TerminalSquare size={15} /><span>Every command here is the README's; the RESULT lines quoted on this site are in <code>demo/transcript.md</code> and <code>demo/capture.sandbox.md</code>.</span></div>
  </>
}
