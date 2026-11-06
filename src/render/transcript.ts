/**
 * The run transcript (Task 8): markdown for demo/transcript.md. A header (date, network, RPC, operator,
 * session public key), the step table (step | signer | result | tx), each refusal body in a fenced json block,
 * and the RESULT line.
 *
 * The refusal rows' result cell is `passRefused(name)`, the one place that string appears, so
 * `grep -c "PASS: refused by protocol"` equals the number of refusals the key's rules made (a Refusal of any
 * other InvalidTxError family reads `chain rejected the tx: Name`, C-T2k; SignerDoesNotExist is a PASS only in a
 * burn proof's phase, where NOTE_SIGNER_GONE also sits under its body). A refused tx never reached a block, so
 * its tx cell says `never in a block`. The fenced bodies are the RPC responses byte for byte, under the heading
 * "RPC bodies (never in a block)", because a body can be a chain rejection as well as a refusal by the key's rules.
 * The chain-check row is measured like the step log's: its count is the earned refusals-phase slots before it.
 *
 * The signer cell names the key that signed: DemoSigner "operator" is a full-access key, which in the hero is the
 * seat's own ([03] AddKey, [13] DeleteKey), so it reads `full access` rather than suggesting the operator account
 * (C-T12b). The step table carries no notes, with one exception: a reused DAO's `created DATE` ([01] on testnet,
 * R13a) follows its creation tx in the tx cell, because that tx predates the run (T16 M3). The classifier's WARN
 * notes ([15] on sandbox) are listed under "## Warnings", one per line, within 100 columns (C-T13b). A run that
 * stopped early says so under RESULT (C-T12d).
 *
 * Every chain-sourced string passes through neutralizeControls (C-T6d) and `|` is escaped in table cells, so a
 * hostile label, name or body cannot add a row, a heading or an escape sequence. A fence is longer than any run
 * of backticks in its body. The file is plain: no escape bytes, ASCII glyph fallbacks (`...`, `->`).
 * Pure string function: no I/O, no state, nothing happens at import.
 */
import type { DemoRun, DemoSigner, DemoStep, Network } from "../core/types.js";
import { chainCheckVerdict, hashesOf, refusalTally, resultLines } from "./demo-log.js";
import { SIGNER_GONE, chainRejected, counter, failText, fitRows, isProtocolRefusal } from "./refusal-block.js";
import { CAPTION, NOTE_SIGNER_GONE, PASS_IN_SCOPE, PASS_RUNTIME, passRefused } from "./strings.js";
import { neutralizeControls } from "./style.js";
import type { TermCaps } from "./term.js";
import { renderTxLine } from "./tx-line.js";

const safe = neutralizeControls;

/** The transcript is a file, not a terminal: plain, ASCII fallbacks, the default 100 columns. */
const PLAIN: TermCaps = { color: false, unicode: false, width: 100, tty: false };

/** A markdown code span around `text`, with a delimiter longer than any backtick run inside it. */
function code(text: string): string {
  const t = safe(text);
  const fence = "`".repeat(Math.max(1, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** One table cell: neutralized, with `|` escaped so it cannot end the cell. */
const cell = (text: string): string => safe(text).replace(/\|/g, "\\|");

/** The tx cell for a hash: an explorer link (short label, full URL) where the network has one, else the hash in code. */
function hashCell(hash: string, network: Network): string {
  const line = renderTxLine(hash, network, PLAIN); // `tx LABEL · final · URL`, or `... · sandbox (no explorer)`
  const m = /^tx (.*) · final · (https?:\/\/\S+)$/.exec(line);
  return m ? `[${m[1].replace(/[[\]|]/g, "\\$&")}](${m[2].replace(/\)/g, "%29")})` : code(hash);
}

/**
 * The `created DATE` part of a setup step's note: the driver adds it to [01] when the run reuses a DAO, whose
 * creation tx is then older than the run (R13a). Only that exact shape counts; the note's other parts stay out.
 */
const CREATED = /^created \d{4}-\d{2}-\d{2}$/;
const createdOf = (s: DemoStep): string | undefined => (s.phase === "setup" && s.note !== undefined ? s.note.split(" · ").find((part) => CREATED.test(part)) : undefined);

function txCell(s: DemoStep, network: Network): string {
  if (s.attempt?.outcome.kind === "Refusal") return "never in a block";
  const hashes = hashesOf(s);
  if (hashes.length === 0) return "—";
  const created = createdOf(s);
  return hashes.map((h) => hashCell(h, network)).join("<br>") + (created === undefined ? "" : ` · ${created}`);
}

/**
 * The result cell. Protocol refusals say passRefused(name); anything that did not pass says why. A chain check
 * is measured from the slots (refusals-phase steps) that came before it in the run.
 */
function resultCell(s: DemoStep, before: readonly DemoStep[]): string {
  const o = s.attempt?.outcome;
  if (s.chainCheck) return cell(chainCheckVerdict(s, refusalTally(before.filter((b) => b.phase === "refusals")), PLAIN).text);
  const rejected = o?.kind === "Refusal" && !isProtocolRefusal(s) ? chainRejected(o.errorName) : undefined;
  if (!s.pass) return cell([rejected, failText(s)].filter((p) => p !== undefined).join(" · "));
  if (o?.kind === "Refusal") return cell(rejected ?? passRefused(o.errorName));
  if (o?.kind === "TxSuccess") return cell(PASS_IN_SCOPE);
  if (o?.kind === "ContractPanic") return cell(PASS_RUNTIME);
  return "PASS";
}

/** The signer cell: the kind of key that signed (C-T12b). */
const signerCell = (signer: DemoSigner): string => (signer === "operator" ? "full access" : cell(signer));

/** The WARN parts of a step's note (a note's parts are joined with ` · `). */
const warningsOf = (s: DemoStep): string[] => (s.note === undefined ? [] : s.note.split(" · ").filter((part) => part.startsWith("WARN")));

/** The longest run of backticks decides the fence: one more than that, at least three. */
function fenceFor(body: string): string {
  return "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
}

export function renderTranscript(run: DemoRun, meta: { rpc: string; operator: string; startedAt: string }): string {
  const key = run.steps.map((s) => s.card?.session.publicKey ?? s.card?.key?.publicKey ?? s.chainCheck?.before.publicKey).find((k) => k !== undefined);
  const out: string[] = [
    "# Keyhole demo transcript",
    "",
    `- date: ${code(meta.startedAt)}`,
    `- network: ${safe(run.network)}`,
    `- mode: ${safe(run.mode)}`,
    `- RPC: ${code(meta.rpc)}`,
    `- operator: ${code(meta.operator)}`,
    `- session public key: ${key === undefined ? "not recorded in this run" : code(key)}`,
    `- run: ${code(run.id)}`,
    "",
    `> ${CAPTION}`,
    "",
    "## Steps",
    "",
    "| step | signer | result | tx |",
    "|---|---|---|---|",
    ...run.steps.map((s, i) => `| ${cell(`${counter(s)} ${s.label}`)} | ${signerCell(s.signer)} | ${resultCell(s, run.steps.slice(0, i))} | ${txCell(s, run.network)} |`),
    "",
  ];

  const warned = run.steps.filter((s) => warningsOf(s).length > 0);
  if (warned.length > 0) {
    out.push("## Warnings", "");
    for (const s of warned) {
      for (const warning of warningsOf(s)) {
        // A markdown list item; a continuation row is indented under it, so it stays part of the item.
        for (const [prefix, text] of fitRows(safe(warning), PLAIN.width, `- ${counter(s)} `, "  ")) out.push(prefix + text);
      }
    }
    out.push("");
  }

  const refusals = run.steps.filter((s) => s.attempt?.outcome.kind === "Refusal");
  if (refusals.length > 0) {
    out.push("## RPC bodies (never in a block)", "");
    for (const s of refusals) {
      const o = s.attempt!.outcome;
      const body = safe(o.rawRpcJson);
      const fence = fenceFor(body);
      // A body that is not the key's refusal is labelled as the chain's rejection; the burn proof carries its note.
      const name = o.kind !== "Refusal" ? "" : ` — ${isProtocolRefusal(s) ? cell(o.errorName) : cell(chainRejected(o.errorName))}`;
      // Only a proof the step earned carries the note (C-T8c).
      const note = s.pass && isProtocolRefusal(s) && o.kind === "Refusal" && o.errorName === SIGNER_GONE ? [cell(NOTE_SIGNER_GONE), ""] : [];
      out.push(`### ${cell(`${counter(s)} ${s.label}`)}${name}`, "", ...note, `${fence}json`, body, fence, "");
    }
  }

  const [result, ...rest] = resultLines(run, PLAIN);
  out.push("## Result", "", result, ...rest.flatMap((line) => ["", line]));
  return out.join("\n") + "\n";
}
