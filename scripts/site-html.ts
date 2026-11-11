/**
 * docs/index.html, the hosted page (GitHub Pages: branch main, folder /docs).
 *
 *   npm run site:html       rewrites the generated regions of docs/index.html and prints `docs/index.html (N KB)`
 *
 * The page is hand-written HTML, CSS and script. This generator owns only the regions between
 * `<!-- kh:NAME -->` and `<!-- /kh:NAME -->` markers, plus the CSP's script-src:
 *   - card    the judging session's cage card as recorded at wrap (demo/judging-session.json); the page's script
 *             replaces it with a live read of the same key, so a reader without script still sees the scope;
 *   - runs    the RESULT lines of demo/transcript.md (testnet) and demo/capture.sandbox.md (sandbox);
 *   - ledger  the refusals of demo/fixtures/manifest.json, each body byte for byte from its fixture file and named
 *             by parseRefusal, the parser the live path uses;
 *   - data    the inspector's JSON: the session's public fields and each pack's pinned code hash;
 *   - CSP     script-src lists the sha256 of every inline script, so no other script can run.
 *
 * Every value is escaped. The output depends on the committed files alone: no clock, no path, no network.
 * Importing this module writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatNear } from "../src/core/amounts.js";
import { parseRefusal } from "../src/core/refusal.js";
import { listPackIds, loadTargetPack } from "../src/packs/index.js";
import { REPO_ROOT, escapeHtml } from "./status-html.js";

export const SITE_FILE = "docs/index.html";
export const NOJEKYLL_FILE = "docs/.nojekyll";
const REPO_URL = "https://github.com/mdlog/keyhole";
const EXPLORER = "https://testnet.nearblocks.io";

/** The ledger, in reading order: the five single-rule refusals, then the two burns. Attempt text: `code` in backticks. */
const LEDGER: readonly { fixture: string; attempt: string; rule: string }[] = [
  { fixture: "testnet.sputnik-v2.refuse-method.json", attempt: "`add_proposal` on the DAO", rule: "method: the key names `act_proposal` only" },
  { fixture: "testnet.sputnik-v2.refuse-action.json", attempt: "Transfer of 1 yoctoNEAR to `attacker.kh-op-021e.testnet`", rule: "action: a function-call key signs one FunctionCall, nothing else" },
  { fixture: "testnet.sputnik-v2.refuse-receiver.json", attempt: "`act_proposal` on `genesis.sputnik-v2.testnet`, another DAO", rule: "receiver: the key names `kh-2c19.sputnik-v2.testnet` only" },
  { fixture: "testnet.sputnik-v2.refuse-deposit.json", attempt: "`act_proposal` with 1 yoctoNEAR attached", rule: "deposit: a function-call key attaches 0" },
  { fixture: "sandbox.counter.refuse-allowance.json", attempt: "`increment` from a second key whose 0.0100 NEAR allowance is below the up-front cost of 30 TGas (0.0309 NEAR)", rule: "allowance: it must cover the gas bought up front" },
  { fixture: "testnet.sputnik-v2.after-burn.json", attempt: "`act_proposal` after the key was deleted (burn, on-account mode)", rule: "none: the key is gone" },
  { fixture: "sandbox.counter.after-burn.json", attempt: "`increment` after the session sub-account was deleted (burn, sub-account mode)", rule: "none: the account is gone" },
];

const RUN_FILES: readonly { file: string; label: string }[] = [
  { file: "demo/transcript.md", label: "TESTNET RUN" },
  { file: "demo/capture.sandbox.md", label: "SANDBOX RUN" },
];

const SESSION_FIELDS = ["id", "network", "accountId", "receiverId", "methodNames", "allowanceYocto", "publicKey", "codeHashPin", "createdAt", "wrapTxHash"] as const;

export interface SiteSession {
  id: string;
  network: string;
  accountId: string;
  receiverId: string;
  methodNames: string[];
  allowanceYocto: string;
  publicKey: string;
  codeHashPin: string;
  createdAt: string;
  wrapTxHash: string;
}
export interface SiteRefusal { fixture: string; network: string; attempt: string; rule: string; errorName: string; body: string }
export interface SiteRun { file: string; label: string; pass: string; parts: string[] }
export interface SiteData { session: SiteSession; pins: { id: string; codeHash: string }[]; runs: SiteRun[]; ledger: SiteRefusal[] }

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

export async function siteData(root: string = REPO_ROOT): Promise<SiteData> {
  const raw = JSON.parse(read(root, "demo/judging-session.json")) as Record<string, unknown>;
  const session = Object.fromEntries(SESSION_FIELDS.map((k) => {
    if (raw[k] === undefined) throw new Error(`demo/judging-session.json has no ${k}`);
    return [k, raw[k]];
  })) as unknown as SiteSession;

  const pins: { id: string; codeHash: string }[] = [];
  for (const id of await listPackIds()) {
    const codeHash = (await loadTargetPack(id)).sandboxFixture?.codeHash;
    if (codeHash) pins.push({ id, codeHash });
  }

  const manifest = JSON.parse(read(root, "demo/fixtures/manifest.json")) as { refusals: { network: string; pack: string; test: string }[] };
  const listed = manifest.refusals.map((r) => `${r.network}.${r.pack}.${r.test}.json`).sort();
  const ours = LEDGER.map((l) => l.fixture).sort();
  if (listed.join() !== ours.join()) throw new Error(`the site ledger (${ours.join(", ")}) is not the manifest's refusals (${listed.join(", ")})`);
  const ledger = LEDGER.map((l) => {
    const body = read(root, `demo/fixtures/${l.fixture}`);
    const refusal = parseRefusal(body);
    if (!refusal) throw new Error(`demo/fixtures/${l.fixture} is not a refusal body`);
    return { ...l, network: l.fixture.split(".")[0], errorName: refusal.errorName, body };
  });

  const runs = RUN_FILES.map(({ file, label }) => {
    const line = read(root, file).split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`${file} has no RESULT line`);
    const [pass, ...parts] = line.slice("RESULT ".length).split(" · transcript ")[0].split(" · ");
    return { file, label, pass, parts };
  });

  return { session, pins, runs, ledger };
}

/** `a` and `b` become text and <code>; the text is escaped either way. */
const withCode = (s: string): string =>
  s.split("`").map((part, i) => (i % 2 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part))).join("");

const ENFORCERS: Record<string, string> = {
  PROTOCOL: `<span class="inv enf">PROTOCOL</span>`,
  KEYHOLE: `<span class="out enf">KEYHOLE</span><span class="muted">server-side</span>`,
  OPERATOR: `<span class="out enf">OPERATOR</span>`,
  NONE: `<span class="out enf">NOT A KEY LIMIT</span>`,
  "": `<span class="muted mono" aria-label="no enforcer: identity row">—</span>`,
};
const row = (label: string, value: string, enforcer: keyof typeof ENFORCERS) =>
  `      <div class="row"><div class="c-l">${label}</div><div class="c-v">${value}</div><div class="c-e">${ENFORCERS[enforcer]}</div></div>`;

const SEGMENTS = 20;
const bar = (filled: number) =>
  `<span class="bar" aria-hidden="true">${Array.from({ length: SEGMENTS }, (_, i) => `<i${i < filled ? ' class="on"' : ""}></i>`).join("")}</span>`;

/** The session's mode as wrap names it: a session sub-account is ks-XXXX.OPERATOR; anything else is on-account. */
export const sessionMode = (accountId: string) => (/^ks-[0-9a-f]{4}\./.test(accountId) ? "SUB-ACCOUNT" : "ON-ACCOUNT");

function cardHtml(s: SiteSession): string {
  const methods = s.methodNames.map((m) => `<span class="m"><code class="b">${escapeHtml(m)}</code><span class="lead"></span><span class="lbl">IN ALLOWLIST</span></span>`).join("");
  return [
    `<div class="card" id="kh-card">`,
    `  <div class="card-head"><span class="card-title">CAGE CARD</span><code class="card-sub">${escapeHtml(s.accountId)}</code><span class="tag" id="kh-tag">[RECORDED]</span></div>`,
    `  <div class="rows" id="kh-rows">`,
    `      <div class="row hd" aria-hidden="true"><div class="c-l">LABEL</div><div class="c-v">VALUE</div><div class="c-e">ENFORCED BY</div></div>`,
    row("RECEIVER", `<code>${escapeHtml(s.receiverId)}</code>`, "PROTOCOL"),
    row("SIGNER", `<code>${escapeHtml(s.accountId)}</code><span class="chip">${sessionMode(s.accountId)}</span>`, ""),
    row("METHOD", `${methods}<span class="m other"><span>every other method</span><span class="lead"></span><span class="lbl">NOT IN ALLOWLIST</span></span>`, "PROTOCOL"),
    row("ACTIONS", "one FunctionCall per transaction; no Transfer, no AddKey", "PROTOCOL"),
    row("DEPOSIT", `0 only; methods that demand one fail at runtime <span class="runtime">RUNTIME</span>`, "PROTOCOL"),
    row("GAS", `${bar(SEGMENTS)}<span class="mono">${formatNear(s.allowanceYocto)} NEAR allowance at wrap · gas only</span>`, "PROTOCOL"),
    row("CODE HASH", `<code class="hash">${escapeHtml(s.codeHashPin)}</code><span class="chip">PINNED AT WRAP</span>`, "KEYHOLE"),
    row("VALUE", "anything the signer owns inside the receiver", "NONE"),
    row("EXPIRY", `none in the protocol; ends at <code>keyhole burn ${escapeHtml(s.id)}</code>`, "OPERATOR"),
    row("KEY", `<code class="hash">${escapeHtml(s.publicKey)}</code>`, ""),
    `  </div>`,
    `  <div class="card-foot" id="kh-foot">recorded at wrap · ${escapeHtml(s.createdAt)} · tx <a href="${EXPLORER}/txns/${escapeHtml(s.wrapTxHash)}">${escapeHtml(s.wrapTxHash)}</a></div>`,
    `</div>`,
  ].join("\n");
}

function runsHtml(runs: readonly SiteRun[]): string {
  return runs.map((r) => [
    `<div class="run">`,
    `  <div class="lbl">${escapeHtml(r.label)} · <a href="${REPO_URL}/blob/main/${escapeHtml(r.file)}">${escapeHtml(r.file)}</a></div>`,
    `  <div class="run-line"><span class="stamp">${escapeHtml(r.pass)}</span>${r.parts.map((p) => `<span class="mono">${escapeHtml(p)}</span>`).join("")}</div>`,
    `</div>`,
  ].join("\n")).join("\n");
}

function ledgerHtml(ledger: readonly SiteRefusal[]): string {
  const rows = ledger.map((r, i) => [
    `<details class="led" data-fixture="${escapeHtml(r.fixture)}">`,
    `  <summary class="led-row"><span class="n">${String(i + 1).padStart(2, "0")}</span><span class="net"><span class="out">${escapeHtml(r.network.toUpperCase())}</span></span><span class="att">${withCode(r.attempt)}</span><span class="rule">${withCode(r.rule)}</span><span class="err"><code class="inv">${escapeHtml(r.errorName)}</code></span><span class="res"><span class="stamp">PASS</span></span><span class="tog" aria-hidden="true"></span></summary>`,
    `  <div class="led-body"><div class="lbl">RPC RESPONSE BODY · VERBATIM · never reached a block · <a href="${REPO_URL}/blob/main/demo/fixtures/${escapeHtml(r.fixture)}">demo/fixtures/${escapeHtml(r.fixture)}</a></div><pre>${escapeHtml(r.body)}</pre></div>`,
    `</details>`,
  ].join("\n"));
  return [
    `<div class="led-hd" aria-hidden="true"><span>#</span><span>NETWORK</span><span>ATTEMPT, SIGNED WITH THE SESSION KEY</span><span>RULE IT BREAKS</span><span>ERROR FROM RPC</span><span>RESULT</span><span></span></div>`,
    ...rows,
  ].join("\n");
}

/** JSON inside a script element: `<` is escaped so no string can close the element. */
function dataHtml(d: SiteData): string {
  const json = JSON.stringify({ session: d.session, pins: d.pins }).replace(/</g, "\\u003c");
  return `<script id="kh-data" type="application/json">${json}</script>`;
}

/** The text of every inline script the browser runs (not JSON data, not src=). */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\bsrc=/.test(m[1]) && !/type="application\/json"/.test(m[1]))
    .map((m) => m[2]);
}

function replaceRegion(html: string, name: string, body: string): string {
  const re = new RegExp(`(<!-- kh:${name} -->)[\\s\\S]*?(<!-- /kh:${name} -->)`);
  if (!re.test(html)) throw new Error(`${SITE_FILE} has no <!-- kh:${name} --> region`);
  return html.replace(re, (_m, open: string, close: string) => `${open}\n${body}\n${close}`);
}

export function renderSite(html: string, data: SiteData): string {
  let out = html;
  out = replaceRegion(out, "card", cardHtml(data.session));
  out = replaceRegion(out, "runs", runsHtml(data.runs));
  out = replaceRegion(out, "ledger", ledgerHtml(data.ledger));
  out = replaceRegion(out, "data", dataHtml(data));
  const hashes = inlineScripts(out).map((s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`);
  const csp = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?)script-src [^;"]*/;
  if (!csp.test(out)) throw new Error(`${SITE_FILE} has no CSP meta with a script-src directive`);
  return out.replace(csp, (_m, head: string) => `${head}script-src ${hashes.join(" ")}`);
}

async function main(): Promise<void> {
  const file = join(REPO_ROOT, SITE_FILE);
  const out = renderSite(readFileSync(file, "utf8"), await siteData());
  writeFileSync(file, out);
  const nojekyll = join(REPO_ROOT, NOJEKYLL_FILE);
  if (!existsSync(nojekyll)) writeFileSync(nojekyll, "");
  process.stdout.write(`${SITE_FILE} (${Math.round(Buffer.byteLength(out) / 1024)} KB)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
