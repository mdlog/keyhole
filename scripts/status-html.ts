/**
 * Task 23 (R8; DESIGN_BRIEF 5.6): `demo/status.html`, a static page rendered from the committed testnet run.
 *
 *   npm run status:html       writes demo/status.html and prints `demo/status.html (N KB)`
 *
 * The page shows the cage card as a rating plate and the refusal evidence beside it. It has no script, no
 * network, no web font and no image: one inline style sheet, the system fonts, and links only to explorer
 * transaction pages (Keyhole prints them, nothing here fetches them). It holds public keys and transaction
 * hashes; no key file is read.
 *
 * Every value comes from the DemoRun that loadDemoRunFixture returns for demo/run.testnet.json (the refusal
 * bodies are the fixture files, re-read by that loader) and from the render modules the terminal and the
 * transcript use: cageCardRows is the one row model of the plate (R16d), so the page has no card logic of its
 * own. The output depends on the run alone: the same run gives the same bytes, with no clock and no path in it.
 *
 * Every string that came from a chain read goes through neutralizeControls and escapeHtml before it is placed.
 * Importing this module writes nothing.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatNear } from "../src/core/amounts.js";
import type { CageCard, DemoRun, DemoStep, ScopedKey } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { type CardSpan, cageCardFrame, cageCardRows } from "../src/render/cage-card.js";
import { chainCheckVerdict, hashesOf, refusalTally, resultLines } from "../src/render/demo-log.js";
import { chainRejected, counter, depositText, failText, isProtocolRefusal } from "../src/render/refusal-block.js";
import { RULE_SLOTS } from "../src/render/rule-strip.js";
import { BEATS, CAPTION, PASS_IN_SCOPE, PASS_RUNTIME, passRefused } from "../src/render/strings.js";
import { neutralizeControls } from "../src/render/style.js";
import type { TermCaps } from "../src/render/term.js";
import { renderTxLine } from "../src/render/tx-line.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The run the page is generated from, and the page, both relative to the repo root. */
export const RUN_FILE = "demo/run.testnet.json";
export const STATUS_FILE = "demo/status.html";

/** The page is a file, not a terminal: plain strings, the default 100 columns (the same caps the transcript uses). */
const PLAIN: TermCaps = { color: false, unicode: false, width: 100, tty: false };
/** The plate's bar: 20 cells, with the glyphs of the unicode spelling (the status page's, per C-T7d). */
const PLATE = { unicode: true, barCells: 20 } as const;

// ---------------------------------------------------------------------------------------------------
// Escaping

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for an element body or an attribute value: the two angle brackets, the ampersand and both quotes. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Chain-sourced text on its way into the page: control characters shown as `\uXXXX` text (C-T6d), then escaped. */
const h = (text: string): string => escapeHtml(neutralizeControls(text));

/** A step number as the page writes it: two digits, escaped (it lands in id attributes and in brackets). */
const nn = (n: number): string => h(String(n).padStart(2, "0"));

// ---------------------------------------------------------------------------------------------------
// The style sheet: Paper, Ink, and Mint for the PASS stamp only

const STYLE = `
:root {
  color-scheme: light;
  --paper: #F2F0E9;
  --ink: #111110;
  --dim: rgb(17 17 16 / 0.62);
  --rule: rgb(17 17 16 / 0.3);
  --mono: "Iosevka Term", "Iosevka", ui-monospace, "SF Mono", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace;
  --sans: "Atkinson Hyperlegible", system-ui, "Segoe UI", "Helvetica Neue", "Noto Sans", sans-serif;
  --display: "D-DIN Condensed", "DIN Condensed", "Barlow Condensed", "Liberation Sans Narrow", "Nimbus Sans Narrow", "Helvetica Neue", system-ui, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; font: 16px/1.5 var(--sans); }
a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }

.page { container-type: inline-size; max-width: 1440px; margin: 0 auto; padding: 16px clamp(12px, 3vw, 32px) 56px; }

.strip { margin: 0 0 clamp(20px, 4cqi, 40px); padding: 8px 12px; border: 2px solid var(--ink); font: 700 13px/1.45 var(--mono); overflow-wrap: anywhere; }

.hero h1 { margin: 0; font-family: var(--display); font-weight: 700; font-stretch: condensed; font-size: min(120px, 10cqi); line-height: 0.95; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.sub { margin: 14px 0 0; max-width: 62ch; font-size: clamp(17px, 2cqi, 24px); line-height: 1.35; overflow-wrap: anywhere; }
.meta, .result { margin: 12px 0 0; font: 14px/1.5 var(--mono); overflow-wrap: anywhere; }
.result { font-weight: 700; }

.cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px 24px; margin-top: 32px; align-items: start; }
@container (min-width: 1100px) {
  .cols { grid-template-columns: repeat(12, minmax(0, 1fr)); }
  .primary { grid-column: 1 / 9; }
  .evidence { grid-column: 9 / 13; }
}
.sect-h { margin: 0 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--ink); font: 700 13px/1.4 var(--mono); letter-spacing: 0.03em; overflow-wrap: anywhere; }
/* The left column: the plate, then the step table (LAYOUT R8 order: card, steps, refusal bodies, staircase). */
.primary { min-width: 0; }
.sect-sub { margin: 0 0 12px; font-size: 14px; line-height: 1.4; }

/* The plate: a grid in the system monospace, sized from the width of its own container. */
.plate-slot { container-type: inline-size; min-width: 0; }
.plate { --cols: 11ch minmax(0, 1fr) 14ch; font-family: var(--mono); font-size: min(18px, (100cqi - 4px) / 49); line-height: 1.35; width: min(calc(98ch + 4px), 100%); border: 2px solid var(--ink); background: var(--paper); }
.plate-head { display: flex; justify-content: space-between; gap: 2ch; padding: 0.35em 1ch; border-bottom: 2px solid var(--ink); font-weight: 700; }
.plate-title { min-width: 0; overflow-wrap: anywhere; }
.plate-tag { flex: none; }
.plate-foot { padding: 0.35em 1ch; border-top: 2px solid var(--ink); overflow-wrap: anywhere; }
.plate-grid { display: grid; }
.row { display: grid; grid-template-columns: var(--cols); border-top: 1px solid var(--rule); }
.row:first-child { border-top: 0; }
.row > div { min-width: 0; padding: 0.25em 0.5ch; }
.row.head > div { font-size: 0.75em; font-weight: 700; letter-spacing: 0.05em; }
.label { font-weight: 700; border-right: 1px solid var(--rule); }
.line { white-space: pre-wrap; overflow-wrap: anywhere; }
.dim { color: var(--dim); }
.runtime { font-weight: 700; text-decoration: underline dotted; text-underline-offset: 0.2em; }
.enforcer { align-self: start; justify-self: start; margin: 0.25em 0.5ch; padding: 0 0.5ch; border: 1px solid var(--ink); }
.enforcer.protocol { background: var(--ink); color: var(--paper); font-weight: 700; }

.refusals { list-style: none; margin: 0 0 24px; padding: 0; }
.refusal { margin: 0 0 14px; border: 2px solid var(--ink); }
.refusal-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 10px; }
.stamp { background: #00EC97; color: var(--ink); border: 2px solid var(--ink); padding: 1px 8px; font: 700 14px/1.3 var(--mono); letter-spacing: 0.08em; }
.verdict { background: var(--ink); color: var(--paper); padding: 1px 8px; font: 700 14px/1.3 var(--mono); overflow-wrap: anywhere; }
.refusal p { margin: 0; padding: 0 10px 6px; font: 12.5px/1.45 var(--mono); overflow-wrap: anywhere; }
.refusal p.what { font: 15px/1.35 var(--sans); }
.refusal details { border-top: 1px solid var(--ink); }
.refusal summary { padding: 6px 10px; font: 12px/1.4 var(--mono); cursor: pointer; overflow-wrap: anywhere; }
.refusal pre { margin: 0; padding: 8px 10px 10px; border-top: 1px dashed var(--rule); font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }

.staircase, .primary .steps { margin-top: 48px; }
.stair { font: 14px/1.5 var(--mono); }
.stair-row { display: flex; flex-wrap: wrap; gap: 0 2ch; padding: 4px 0; border-top: 1px solid var(--rule); }
.stair-row.head { border-top: 0; font-size: 12px; font-weight: 700; }
.stair-row .n { flex: none; width: 5ch; }
.stair-row .slots { display: flex; flex-wrap: wrap; flex: 0 1 auto; min-width: 0; }
.stair-row .parsed { flex: 1 1 24ch; min-width: 0; overflow-wrap: anywhere; }
.slot { display: inline-block; width: 12ch; padding-left: 1ch; }
.slot.hit { padding-left: 0; font-weight: 700; }
.check { margin: 14px 0 0; font: 14px/1.5 var(--mono); overflow-wrap: anywhere; }
.check strong { font-weight: 700; }

.steps table { width: 100%; border-collapse: collapse; font-size: 15px; line-height: 1.4; }
.steps th { padding: 6px 12px 6px 0; border-bottom: 2px solid var(--ink); font: 700 12px/1.4 var(--mono); text-align: left; }
.steps td { padding: 8px 12px 8px 0; border-top: 1px solid var(--rule); vertical-align: top; overflow-wrap: anywhere; }
.steps tr:first-child td { border-top: 0; }
.steps td.signer { white-space: nowrap; overflow-wrap: normal; }
.steps td.tx { font: 13px/1.5 var(--mono); }
.steps tr.note-row td { padding: 0 12px 8px 0; border-top: 0; color: var(--dim); font-size: 13px; }

.foot { margin-top: 56px; padding-top: 12px; border-top: 2px solid var(--ink); font: 13px/1.55 var(--mono); }
.foot p { margin: 0 0 6px; overflow-wrap: anywhere; }

@container (max-width: 719px) {
  .steps thead { display: none; }
  .steps table, .steps tbody { display: block; }
  .steps tr { display: block; padding: 10px 0; border-top: 1px solid var(--rule); }
  .steps tr:first-child { border-top: 0; }
  .steps td, .steps tr:first-child td { display: block; padding: 2px 0; border: 0; }
  .steps td::before { content: attr(data-label); display: block; color: var(--dim); font: 700 11px/1.3 var(--mono); }
  .steps tr.note-row { padding: 0 0 10px; border-top: 0; }
  .steps tr.note-row td::before { content: none; }
}
`;

// ---------------------------------------------------------------------------------------------------
// The cage card as a plate

function spanHtml(span: CardSpan): string {
  const text = h(span.text);
  return span.kind === undefined ? text : `<span class="${span.kind}">${text}</span>`;
}

/**
 * The plate, from cageCardRows: LABEL, VALUE and ENFORCED BY per row. A label is printed once for a run of rows
 * that share it (METHOD), as the terminal plate does. PROTOCOL is the filled cell; the others are outlined.
 */
function plateHtml(card: CageCard, runId: string): string {
  const frame = cageCardFrame(card, { runId });
  let previous = "";
  const rows = cageCardRows(card, PLATE).map((row) => {
    const label = row.label === previous ? "" : row.label;
    previous = row.label;
    const lines = row.lines.map((line) => `<div class="line">${line.spans.map(spanHtml).join("")}</div>`).join("");
    const enforcer = `<div class="enforcer${row.enforcedBy === "PROTOCOL" ? " protocol" : ""}" role="cell">${h(row.enforcedBy)}</div>`;
    return `<div class="row" role="row"><div class="label" role="${label === "" ? "cell" : "rowheader"}">${h(label)}</div><div class="value" role="cell">${lines}</div>${enforcer}</div>`;
  });
  return [
    `<article class="plate" aria-label="cage card">`,
    `<header class="plate-head"><span class="plate-title">${h(frame.title)}</span><span class="plate-tag">[${h(frame.tag)}]</span></header>`,
    `<div class="plate-grid" role="table" aria-label="what the key may and may not do, and who enforces each limit">`,
    `<div class="row head" role="row"><div role="columnheader">FIELD</div><div role="columnheader">VALUE</div><div role="columnheader">ENFORCED BY</div></div>`,
    ...rows,
    `</div>`,
    `<footer class="plate-foot">${h(frame.footer)}</footer>`,
    `</article>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Steps: results, signers, transactions

/**
 * The result a step table shows. The wording is the transcript's (this mirrors the transcript's own result cell,
 * without its markdown escaping; test/status-html.test.ts compares the two for all 14 steps).
 */
function resultText(step: DemoStep, before: readonly DemoStep[]): string {
  const outcome = step.attempt?.outcome;
  if (step.chainCheck) return chainCheckVerdict(step, refusalTally(before.filter((b) => b.phase === "refusals")), PLAIN).text;
  const rejected = outcome?.kind === "Refusal" && !isProtocolRefusal(step) ? chainRejected(outcome.errorName) : undefined;
  if (!step.pass) return [rejected, failText(step)].filter((part) => part !== undefined).join(" · ");
  if (outcome?.kind === "Refusal") return rejected ?? passRefused(outcome.errorName);
  if (outcome?.kind === "TxSuccess") return PASS_IN_SCOPE;
  if (outcome?.kind === "ContractPanic") return PASS_RUNTIME;
  return "PASS";
}

/** The key that signed: an operator step is a full-access key, the seat's own (C-T12b). */
const signerText = (step: DemoStep): string => (step.signer === "operator" ? "full access" : step.signer);

/** The explorer page of a transaction, from the one place that knows it (renderTxLine); null on a network without one. */
function explorerUrl(hash: string, run: DemoRun): string | null {
  return / · final · (https:\/\/\S+)$/.exec(renderTxLine(hash, run.network, PLAIN))?.[1] ?? null;
}

function txCell(step: DemoStep, run: DemoRun): string {
  if (step.attempt?.outcome.kind === "Refusal") return "never in a block";
  const hashes = hashesOf(step);
  if (hashes.length === 0) return "—";
  return hashes
    .map((hash) => {
      const url = explorerUrl(hash, run);
      return url === null ? h(hash) : `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${h(hash)}</a>`;
    })
    .join("<br>");
}

function stepTable(run: DemoRun): string {
  const rows = run.steps.flatMap((step, i) => {
    const main = [
      `<tr id="step-${nn(step.n)}">`,
      `<td class="step" data-label="step">${h(`${counter(step)} ${step.label}`)}</td>`,
      `<td class="signer" data-label="signer">${h(signerText(step))}</td>`,
      `<td class="result" data-label="result">${h(resultText(step, run.steps.slice(0, i)))}</td>`,
      `<td class="tx" data-label="tx">${txCell(step, run)}</td>`,
      `</tr>`,
    ].join("");
    // What a step measured or noted (a payout executed, the vote the key does not judge). A refusal's fixture is named in
    // the evidence, and a failing step's note is already its FAIL result (the terminal's noteRows do the same).
    const note = step.pass && step.fixture === undefined && step.note !== undefined && step.note !== "" ? step.note : undefined;
    return note === undefined ? [main] : [main, `<tr class="note-row"><td colspan="4">${h(note)}</td></tr>`];
  });
  return [
    `<section class="steps" aria-labelledby="steps-h">`,
    `<h2 class="sect-h" id="steps-h">STEPS · ${run.steps.length} · the signer, the result, and the transaction or "never in a block"</h2>`,
    `<table>`,
    `<thead><tr><th>step</th><th>signer</th><th>result</th><th>tx</th></tr></thead>`,
    `<tbody>`,
    ...rows,
    `</tbody>`,
    `</table>`,
    `</section>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// The refusal evidence

/** `FunctionCall add_proposal → receiver · deposit 0 · 30 TGas`: exactly what was signed (the terminal's `signed` row). */
function signedText(step: DemoStep): string {
  const a = step.attempt!;
  const call = a.method === undefined ? a.action : `${a.action} ${a.method}`;
  return `${call} → ${a.receiverId} · deposit ${depositText(a.depositYocto)}${a.action === "FunctionCall" ? ` · ${a.gasTGas} TGas` : ""}`;
}

function refusalItem(step: DemoStep): string {
  const outcome = step.attempt!.outcome;
  if (outcome.kind !== "Refusal") throw new TypeError(`status page: step ${step.n} is not a refusal`);
  const protocol = step.pass && isProtocolRefusal(step);
  return [
    `<li class="refusal" id="refusal-${nn(step.n)}">`,
    `<div class="refusal-head">${protocol ? `<span class="stamp">PASS</span>` : ""}<span class="verdict">${h(outcome.errorName)}</span></div>`,
    `<p class="what">${h(`${counter(step)} ${step.label}`)}</p>`,
    `<p class="signed">signed: ${h(signedText(step))}</p>`,
    `<p class="ledger-line">reached block: ${outcome.reachedBlock ? "yes" : "no"} · on-chain tx: none · ${h(outcome.path.join(" › "))}</p>`,
    `<details open><summary>response body, verbatim${step.fixture === undefined ? "" : ` · ${h(step.fixture)}`}</summary><pre>${h(outcome.rawRpcJson)}</pre></details>`,
    `</li>`,
  ].join("\n");
}

function evidenceHtml(run: DemoRun): string {
  const refusals = run.steps.filter((s) => s.phase === "refusals" && s.attempt?.outcome.kind === "Refusal");
  const burned = run.steps.filter((s) => s.phase === "burn" && s.attempt?.outcome.kind === "Refusal");
  const list = (steps: readonly DemoStep[]): string => `<ol class="refusals">\n${steps.map(refusalItem).join("\n")}\n</ol>`;
  return [
    `<section class="evidence" aria-labelledby="evidence-h">`,
    `<h2 class="sect-h" id="evidence-h">${h(BEATS.refusals)}</h2>`,
    `<p class="sect-sub">${h(CAPTION)}</p>`,
    list(refusals),
    ...(burned.length === 0 ? [] : [`<h3 class="sect-h">${h(BEATS.burn)}</h3>`, list(burned)]),
    `</section>`,
  ].join("\n");
}

/** The summary staircase: the rule each refusal broke, one bracketed slot per row, and the chain check that measured the key unchanged. */
function staircaseHtml(run: DemoRun): string {
  const slots = run.steps.filter((s) => s.phase === "refusals" && s.attempt !== undefined);
  const tally = refusalTally(run.steps.filter((s) => s.phase === "refusals"));
  const rows = slots.map((step) => {
    const a = step.attempt!;
    const cells = RULE_SLOTS.map((slot) => (slot === a.violates ? `<span class="slot hit">[${slot.toUpperCase()}]</span>` : `<span class="slot">${slot}</span>`)).join("");
    const parsed = a.outcome.kind === "Refusal" ? `<span class="verdict">${h(a.outcome.errorName)}</span>` : "";
    return `<div class="stair-row" role="row"><span class="n" role="cell">[${nn(step.n)}]</span><span class="slots" role="cell">${cells}</span><span class="parsed" role="cell">${parsed}</span></div>`;
  });
  const checkIndex = run.steps.findIndex((s) => s.chainCheck !== undefined);
  const check = checkIndex < 0 ? undefined : run.steps[checkIndex];
  const left = (k: ScopedKey): string => (k.allowanceRemainingYocto === null ? "no cap" : formatNear(k.allowanceRemainingYocto));
  const checkHtml =
    check?.chainCheck === undefined
      ? []
      : [
          `<p class="check"><strong>${h(`${counter(check)} CHAIN CHECK`)}</strong> view_access_key, read before [${nn(slots[0]?.n ?? 0)}] and after [${nn(slots.at(-1)?.n ?? 0)}]</p>`,
          `<p class="check">${h(`nonce ${check.chainCheck.before.nonce} → ${check.chainCheck.after.nonce} · allowance left ${left(check.chainCheck.before)} → ${left(check.chainCheck.after)} NEAR`)}</p>`,
          `<p class="check"><strong>${h(chainCheckVerdict(check, tally, PLAIN).text)}</strong></p>`,
        ];
  return [
    `<section class="staircase" aria-labelledby="stair-h">`,
    `<h2 class="sect-h" id="stair-h">${h(`REFUSALS ${tally.ok}/${tally.total}`)} · ${h(CAPTION)}</h2>`,
    `<div class="stair" role="table" aria-label="the rule each refusal broke">`,
    `<div class="stair-row head" role="row"><span class="n" role="columnheader">step</span><span class="slots" role="columnheader">rule broken, one per test, fixed slot order</span><span class="parsed" role="columnheader">parsed from the RPC body</span></div>`,
    ...rows,
    `</div>`,
    ...checkHtml,
    `</section>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// The page

/** `live-testnet-20261106T150556Z` -> `2026-11-06 15:05:56 UTC`; a run id with no stamp has no date. */
function runDate(id: string): string | null {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  return m === null ? null : `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
}

/** The card of the INSPECT beat (phase 5: the cage card, read from chain); a run without one has no page to make. */
function inspectStep(run: DemoRun): DemoStep & { card: CageCard } {
  const step = run.steps.find((s) => s.phase === "inspect" && s.card !== undefined) ?? [...run.steps].reverse().find((s) => s.card !== undefined);
  if (step?.card === undefined) throw new TypeError(`status page: run ${run.id} holds no cage card`);
  return step as DemoStep & { card: CageCard };
}

export function renderStatusHtml(run: DemoRun, source: string = RUN_FILE): string {
  const inspect = inspectStep(run);
  const card = inspect.card;
  const methods = card.key?.methodNames ?? card.session.methodNames;
  const receiver = card.key?.receiverId ?? card.session.receiverId;
  const account = card.key?.accountId ?? card.session.accountId;
  const date = runDate(run.id);
  const [result, ...more] = resultLines(run, PLAIN);
  const title = `keyhole · status · replay of ${run.id}`;

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<title>${h(title)}</title>`,
    `<style>${STYLE}</style>`,
    `</head>`,
    `<body>`,
    `<main class="page">`,
    `<p class="strip">${h(`REPLAY · demo run ${run.id} · ${run.network} · exit ${run.exitCode} · nothing on this page is live · no keys on this page`)}</p>`,
    `<header class="hero">`,
    `<h1>${h(methods.join(", "))}</h1>`,
    `<p class="sub">${methods.length === 1 ? "is the only method" : "are the only methods"} this key can call — on ${h(receiver)}, as ${h(account)}.</p>`,
    `<p class="meta">keyhole · ${h(run.network)}${date === null ? "" : ` · run of ${h(date)}`} · ${h(run.mode)} of ${h(run.id)}</p>`,
    `<p class="result">${h(result)}</p>`,
    ...more.map((line) => `<p class="meta">${h(line)}</p>`),
    `</header>`,
    `<div class="cols">`,
    `<div class="primary">`,
    `<section class="plate-slot" aria-labelledby="plate-h">`,
    `<h2 class="sect-h" id="plate-h">${h(`${counter(inspect)} ${inspect.label}`)}</h2>`,
    plateHtml(card, run.id),
    `</section>`,
    stepTable(run),
    `</div>`,
    evidenceHtml(run),
    `</div>`,
    staircaseHtml(run),
    `<footer class="foot">`,
    `<p>Generated from the DemoRun of the ${h(run.network)} run ${h(run.id)} (${h(source)}, replayed from its fixtures); no keys in this file (public keys and transaction hashes only).</p>`,
    `<p>Nothing on this page was fetched or is live; the explorer links are printed here and never fetched by this page. Regenerate: npm run status:html</p>`,
    `</footer>`,
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// The command

async function main(): Promise<void> {
  const run = await loadDemoRunFixture(resolve(REPO_ROOT, RUN_FILE));
  const html = renderStatusHtml(run);
  writeFileSync(resolve(REPO_ROOT, STATUS_FILE), html);
  console.log(`${STATUS_FILE} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
