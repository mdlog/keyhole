/**
 * Task 23 (R8): `demo/status.html`, the static page generated from the committed testnet run. The page is
 * evidence, so this suite reads it the way a judge's browser and a scanner would: as bytes. It has no script,
 * no network and no font download; its only links are explorer transaction pages; the four refusal bodies
 * (and the burn proof's) are the fixture files, byte for byte, behind nothing but HTML escaping; the plate is
 * built from cageCardRows; and the secret scan finds nothing in it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanText } from "../scripts/scan-secrets.js";
import { escapeHtml, renderStatusHtml } from "../scripts/status-html.js";
import type { Attempt, CageCard, DemoRun, DemoStep, Network } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { cageCardFrame, cageCardRows, renderCageCard } from "../src/render/cage-card.js";
import { hashesOf } from "../src/render/demo-log.js";
import { renderRefusalBlock } from "../src/render/refusal-block.js";
import type { TermCaps } from "../src/render/term.js";
import { renderTxLine } from "../src/render/tx-line.js";
import { REPO } from "./helpers.js";

const RUN_FILE = join(REPO, "demo", "run.testnet.json");
const PAGE_FILE = join(REPO, "demo", "status.html");
const FIXTURES = join(REPO, "demo", "fixtures");
const EXPLORER = "https://testnet.nearblocks.io/txns/";

const run = await loadDemoRunFixture(RUN_FILE);
const page = readFileSync(PAGE_FILE, "utf8");
const generated = renderStatusHtml(run);

/** What a browser makes of the entities this page may use. One pass, so `&amp;lt;` stays the text `&lt;`. */
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" };
const decode = (s: string): string => s.replace(/&(lt|gt|amp|quot|#39);/g, (_, name: string) => ENTITIES[name]);
/** The page's text: no style sheet, no tags, entities decoded. */
const textOf = (html: string): string => decode(html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, ""));
/** The content of every `<pre>`, decoded: the refusal bodies as a browser would copy them. */
const preBodies = (html: string): string[] => [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => decode(m[1]));
const fixtureBytes = (step: DemoStep): string => readFileSync(join(FIXTURES, step.fixture!), "utf8");

/** The style sheet, and the declarations of the rule that has exactly this selector (flat rules, as the sheet writes them). */
const css = /<style>([\s\S]*?)<\/style>/.exec(page)![1];
const ruleOf = (selector: string): string => new RegExp(`(?:^|[}\\s])${selector.replace(/[.]/g, "\\.")}\\s*\\{([^{}]*)\\}`).exec(css)?.[1] ?? "";

const refusalSteps = run.steps.filter((s) => s.phase === "refusals");
const burnProof = run.steps.filter((s) => s.phase === "burn" && s.attempt?.outcome.kind === "Refusal");
const inspectCard = run.steps.find((s) => s.phase === "inspect")!.card!;

describe("demo/status.html: what it is", () => {
  it("is the page the generator makes from the committed run, byte for byte, and the generator is deterministic", () => {
    expect(page.length).toBeGreaterThan(5_000);
    expect(generated).toBe(page);
    expect(renderStatusHtml(run)).toBe(generated);
  });

  it("is generated from the replayed run file: replay mode, the testnet run, exit 0", () => {
    expect(run.mode).toBe("replay");
    expect(run.network).toBe("testnet");
    expect(run.exitCode).toBe(0);
    expect(run.steps).toHaveLength(14);
  });

  it("opens with the strip: REPLAY, the run id, the network, the exit code, and the two disclaimers", () => {
    const strip = /<p class="strip">([\s\S]*?)<\/p>/.exec(page);
    expect(strip).not.toBeNull();
    expect(decode(strip![1])).toBe(`REPLAY · demo run ${run.id} · ${run.network} · exit ${run.exitCode} · nothing on this page is live · no keys on this page`);
  });

  it("names the scope in its headline, from the card", () => {
    const methods = inspectCard.key?.methodNames ?? inspectCard.session.methodNames;
    expect(methods.length).toBeGreaterThan(0);
    expect(decode(/<h1>([\s\S]*?)<\/h1>/.exec(page)![1])).toBe(methods.join(", "));
    expect(textOf(page)).toContain(inspectCard.key?.receiverId);
  });
});

describe("demo/status.html: no script, no network", () => {
  it("has no script element, no event-handler attribute and no javascript: URL", () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/javascript:/i);
  });

  it("loads nothing: no url(), no @import, no @font-face, no link, image, frame, object, embed, form, or src", () => {
    expect(page).not.toMatch(/url\(/i);
    expect(page).not.toMatch(/@import/i);
    expect(page).not.toMatch(/@font-face/i);
    expect(page).not.toMatch(/<(link|img|iframe|object|embed|form|audio|video|source|base|meta[^>]+http-equiv)\b/i);
    expect(page).not.toMatch(/\s(src|srcset|action|poster|data)\s*=/i);
  });

  it("every http mention is an explorer transaction link, and each hash of the run is linked once", () => {
    const all = page.match(/https?:/gi) ?? [];
    const links = [...page.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(all).toHaveLength(links.length);
    for (const href of links) expect(href).toMatch(new RegExp(`^${EXPLORER.replace(/[./]/g, "\\$&")}[1-9A-HJ-NP-Za-km-z]{43,44}$`));
    const expected = [...new Set(run.steps.flatMap(hashesOf))];
    expect(expected.length).toBe(8);
    expect(links.map((h) => h.slice(EXPLORER.length)).sort()).toEqual([...expected].sort());
    // Every link opens in no new context and leaks no referrer.
    for (const tag of page.match(/<a\s[^>]*>/g) ?? []) expect(tag).toContain('rel="noopener noreferrer"');
  });

  it("downloads no font: the stacks are system fonts, the plate font is the system monospace, nothing is inlined", () => {
    expect(page).not.toMatch(/base64|woff|\.ttf|\.otf/i);
    expect(page).toMatch(/--mono:[^;]*monospace/);
    expect(page).toMatch(/--sans:[^;]*sans-serif/);
  });

  it("names no local path and no user: no /home/, no file: URL, no login name", () => {
    expect(page).not.toMatch(/\/home\//);
    expect(page).not.toMatch(/file:/i);
    expect(page).not.toMatch(/mdlog/i);
    expect(page).not.toMatch(/node_modules|\/tmp\//);
  });
});

describe("demo/status.html: the plate", () => {
  it("sizes the plate from its own container: the formula is on .plate, the container type on .plate-slot around it, the 1440px cap on .page", () => {
    expect(ruleOf(".plate")).toContain("font-size: min(18px, (100cqi - 4px) / 49)");
    expect(ruleOf(".plate-slot")).toContain("container-type: inline-size");
    expect(ruleOf(".page")).toContain("max-width: 1440px");
    expect(page.match(/min\(18px, \(100cqi - 4px\) \/ 49\)/g)).toHaveLength(1);
    // cqi resolves against the nearest container above the element: in the markup .plate is .plate-slot's own child,
    // and nothing between the two (a heading) is a container.
    const between = /<section class="plate-slot"[^>]*>([\s\S]*?)<article class="plate"/.exec(page)![1];
    const classes = [...between.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(" "));
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(ruleOf(`.${c}`), c).not.toContain("container-type");
  });

  it("uses Paper and Ink, and Mint only as the stamp's fill", () => {
    expect(page).toMatch(/#F2F0E9/i);
    expect(page).toMatch(/#111110/i);
    const mint = [...page.matchAll(/#00EC97/gi)];
    expect(mint).toHaveLength(1);
    const rule = /([^{}]+)\{[^{}]*#00EC97[^{}]*\}/i.exec(page);
    expect(rule![1].trim()).toBe(".stamp");
    expect(rule![0]).toMatch(/background:\s*#00EC97/i);
    // No other colour in the style sheet is a hex value that is not Paper, Ink or Mint.
    const css = /<style>([\s\S]*?)<\/style>/.exec(page)![1];
    const hexes = new Set([...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toUpperCase()));
    expect([...hexes].sort()).toEqual(["#00EC97", "#111110", "#F2F0E9"]);
  });

  it("is built from cageCardRows: every row's label, every line and every enforcer is on the plate, in order", () => {
    const plate = /<article class="plate"[\s\S]*?<\/article>/.exec(page)![0];
    const text = textOf(plate);
    const rows = cageCardRows(inspectCard, { unicode: true, barCells: 20 });
    expect(rows.length).toBeGreaterThan(8);
    let at = 0;
    let previous = "";
    for (const row of rows) {
      const lines = row.lines.map((l) => l.spans.map((s) => s.text).join(""));
      // A run of rows with one label (METHOD) prints it once, as the terminal plate does.
      const label = row.label === previous ? [] : [row.label];
      previous = row.label;
      for (const piece of [...label, ...lines, row.enforcedBy]) {
        const found = text.indexOf(piece, at);
        expect(found, `${row.label}: ${piece}`).toBeGreaterThanOrEqual(at);
        at = found;
      }
    }
  });

  it("carries the card's frame: title, the REPLAY tag and the footer naming the run", () => {
    const plate = textOf(/<article class="plate"[\s\S]*?<\/article>/.exec(page)![0]);
    const frame = cageCardFrame(inspectCard, { runId: run.id });
    expect(frame.tag).toBe("REPLAY");
    expect(plate).toContain(frame.title);
    expect(plate).toContain(`[${frame.tag}]`);
    expect(plate).toContain(frame.footer);
    expect(frame.footer).toContain(run.id);
  });

  it("shows the whole public key and the whole code hash, never shortened", () => {
    const plate = textOf(/<article class="plate"[\s\S]*?<\/article>/.exec(page)![0]);
    expect(plate).toContain(inspectCard.key!.publicKey);
    expect(plate).toContain(inspectCard.session.codeHashPin);
    expect(plate).not.toMatch(/…|\.\.\./);
  });

  it("fills ENFORCED BY the way the plate does: PROTOCOL cells are the filled ones", () => {
    const rows = cageCardRows(inspectCard, { unicode: true, barCells: 20 });
    const protocol = rows.filter((r) => r.enforcedBy === "PROTOCOL").length;
    expect(protocol).toBeGreaterThan(0);
    expect((page.match(/class="enforcer protocol"/g) ?? []).length).toBe(protocol);
    expect((page.match(/class="enforcer"/g) ?? []).length).toBe(rows.length - protocol);
  });
});

describe("demo/status.html: the refusal evidence", () => {
  it("shows the four refusal bodies, and the burn proof's, exactly as the fixture files hold them", () => {
    const bodies = preBodies(page);
    expect(refusalSteps).toHaveLength(4);
    expect(burnProof).toHaveLength(1);
    expect(bodies).toEqual([...refusalSteps, ...burnProof].map(fixtureBytes));
  });

  it("the loader's outcome is the fixture file, so the page reads the same bytes whichever way it asks", () => {
    for (const s of [...refusalSteps, ...burnProof]) {
      const o = s.attempt!.outcome;
      expect(o.kind).toBe("Refusal");
      expect(o.rawRpcJson).toBe(fixtureBytes(s));
    }
  });

  it("each body sits next to the name parsed from it, a stamp, and the fixture's file name", () => {
    for (const s of [...refusalSteps, ...burnProof]) {
      const o = s.attempt!.outcome;
      if (o.kind !== "Refusal") throw new Error("not a refusal");
      expect(page).toContain(`<span class="verdict">${escapeHtml(o.errorName)}</span>`);
      expect(page).toContain(escapeHtml(s.fixture!));
    }
    expect((page.match(/<span class="stamp">PASS<\/span>/g) ?? []).length).toBe(5);
  });

  it("says each refusal never reached a block, and shows the chain check that measured the key unchanged", () => {
    const text = textOf(page);
    expect((text.match(/reached block: no/g) ?? []).length).toBe(5);
    expect(text).toContain("PASS: key state unchanged by 4 refusals");
  });

  it("lays out the staircase: one bracketed rule per refusal, in the fixed slot order", () => {
    const stair = /<section class="staircase"[\s\S]*?<\/section>/.exec(page)![0];
    const hits = [...stair.matchAll(/<span class="slot hit">\[([A-Z]+)\]<\/span>/g)].map((m) => m[1]);
    expect(hits).toEqual(refusalSteps.map((s) => s.attempt!.violates.toUpperCase()));
    expect(hits).toEqual(["METHOD", "ACTION", "RECEIVER", "DEPOSIT"]);
  });
});

describe("demo/status.html: the step table", () => {
  /** The transcript's table, split into cells: [step, signer, result, tx]. */
  const transcriptRows = readFileSync(join(REPO, "demo", "transcript.md"), "utf8")
    .split("\n")
    .filter((l) => /^\| \[\d\d\/\d\d\]/.test(l))
    .map((l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|")));

  const rows = [...page.matchAll(/<tr id="step-(\d\d)">([\s\S]*?)<\/tr>/g)].map((m) => ({
    n: Number(m[1]),
    cell: (name: string): string => decode(new RegExp(`<td class="${name}"[^>]*>([\\s\\S]*?)</td>`).exec(m[2])![1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    html: m[2],
  }));

  it("has a row for each of the 14 steps", () => {
    expect(rows.map((r) => r.n)).toEqual(run.steps.map((s) => s.n));
    expect(transcriptRows).toHaveLength(14);
  });

  it("says what the transcript says: the same label, the same signer and the same result for every step", () => {
    rows.forEach((r, i) => {
      const [step, signer, result] = transcriptRows[i];
      expect(r.cell("step"), `step ${r.n}`).toBe(step.replace(/\s+/g, " "));
      expect(r.cell("signer"), `signer ${r.n}`).toBe(signer);
      expect(r.cell("result"), `result ${r.n}`).toBe(result);
    });
  });

  it("links each transaction to the explorer, and says `never in a block` for each refusal", () => {
    rows.forEach((r, i) => {
      const step = run.steps[i];
      const hashes = hashesOf(step);
      const links = [...r.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(links, `step ${step.n}`).toEqual(hashes.map((h) => `${EXPLORER}${h}`));
      if (step.attempt?.outcome.kind === "Refusal") expect(r.cell("tx")).toBe("never in a block");
    });
  });
});

describe("demo/status.html: order, wording and structure (LAYOUT R8)", () => {
  it("follows R8's order: the card, the step table, the refusal bodies, the staircase, the footer", () => {
    const at = [`id="plate-h"`, `<section class="steps"`, `<section class="evidence"`, `<section class="staircase"`, `<footer class="foot"`].map((needle) => page.indexOf(needle));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // The header comes first: the strip, the headline, the RESULT line, all before the card.
    expect(page.indexOf(`<p class="result">`)).toBeLessThan(at[0]);
  });

  it("the footer says what R8 says: generated from the DemoRun of the testnet run, no keys in this file", () => {
    const foot = textOf(/<footer class="foot">[\s\S]*?<\/footer>/.exec(page)![0]);
    expect(foot).toContain(`Generated from the DemoRun of the ${run.network} run ${run.id}`);
    expect(foot).toContain("no keys in this file");
  });

  it("every row of a table role holds cells: plate rows and staircase rows have a role on each child", () => {
    const grids: Array<[string, RegExp]> = [
      ["plate", /<div class="plate-grid"[\s\S]*?<footer class="plate-foot">/],
      ["staircase", /<div class="stair"[\s\S]*?<\/section>/],
    ];
    for (const [name, region] of grids) {
      const html = region.exec(page)![0];
      const rows = (html.match(/role="row"/g) ?? []).length;
      expect(rows, name).toBeGreaterThan(2);
      expect((html.match(/role="(rowheader|cell|columnheader)"/g) ?? []).length, name).toBe(rows * 3);
    }
    // A label left blank under a run of rows (METHOD) is a cell, not an empty row header.
    expect(page).not.toMatch(/role="rowheader"><\/div>/);
  });

  it("a response summary names the fixture only when the step has one: no dangling separator", () => {
    for (const s of [...refusalSteps, ...burnProof]) expect(page).toContain(`<summary>response body, verbatim · ${escapeHtml(s.fixture!)}</summary>`);
    const bare = structuredClone(run);
    for (const s of bare.steps) delete s.fixture;
    const html = renderStatusHtml(bare);
    const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
    expect(summaries).toHaveLength(5);
    for (const text of summaries) expect(text).toBe("response body, verbatim");
    expect(html).not.toMatch(/verbatim\s*·\s*<\/summary>/);
  });
});

describe("demo/status.html: its copies agree with their sources", () => {
  const caps: TermCaps = { color: false, unicode: true, width: 100, tty: false };
  const PLAIN: TermCaps = { color: false, unicode: false, width: 100, tty: false };

  it("`signed:` is the terminal's `signed` row of the same attempt, for all five refusals", () => {
    for (const s of [...refusalSteps, ...burnProof]) {
      const lead = "        signed   ";
      const row = renderRefusalBlock(s, caps, "full").split("\n").find((l) => l.startsWith(lead));
      expect(row, `step ${s.n}`).toBeDefined();
      const item = new RegExp(`<li class="refusal" id="refusal-${String(s.n).padStart(2, "0")}">[\\s\\S]*?</li>`).exec(page)![0];
      expect(decode(/<p class="signed">signed: ([^<]*)<\/p>/.exec(item)![1])).toBe(row!.slice(lead.length));
    }
  });

  it("the plate's rows are the terminal plate's rows: the same label (once per run of rows), value and enforcer on every row", () => {
    const terminal = renderCageCard(inspectCard, "full", caps, run.id)
      .split("\n")
      .filter((l) => l.startsWith("│"))
      .map((l) => ({ label: l.slice(2, 13).trim(), value: l.slice(13, 71).trimEnd(), enforcer: l.slice(74, 95).trim() }));
    const html = /<article class="plate"[\s\S]*?<\/article>/.exec(page)![0];
    const onPage = [...html.matchAll(/<div class="row" role="row"><div class="label" role="[a-z]+">([\s\S]*?)<\/div><div class="value" role="cell">([\s\S]*?)<\/div><div class="enforcer[^"]*" role="cell">([\s\S]*?)<\/div><\/div>/g)].flatMap((m) =>
      [...m[2].matchAll(/<div class="line">([\s\S]*?)<\/div>/g)].map((line, i) => ({ label: i === 0 ? textOf(m[1]) : "", value: textOf(line[1]), enforcer: i === 0 ? textOf(m[3]) : "" })),
    );
    expect(terminal.length).toBeGreaterThan(8);
    expect(onPage).toEqual(terminal);
  });

  it("the explorer link of every hash is the one the transcript links, and the one renderTxLine prints", () => {
    const transcript = [...readFileSync(join(REPO, "demo", "transcript.md"), "utf8").matchAll(/\((https:\/\/testnet\.nearblocks\.io\/txns\/[^)]+)\)/g)].map((m) => m[1]);
    const hrefs = [...page.matchAll(/href="([^"]*)"/g)].map((m) => decode(m[1]));
    expect(transcript).toHaveLength(8);
    expect([...hrefs].sort()).toEqual([...transcript].sort());
    for (const hash of run.steps.flatMap(hashesOf)) {
      const line = renderTxLine(hash, "testnet", PLAIN);
      expect(line.endsWith(` · final · ${EXPLORER}${hash}`), hash).toBe(true);
      expect(hrefs).toContain(`${EXPLORER}${hash}`);
    }
  });

  it("on a network with no explorer, no link is made and each hash is shown as text", () => {
    const sandbox = structuredClone(run);
    sandbox.network = "sandbox";
    const html = renderStatusHtml(sandbox);
    expect(html).not.toContain("href=");
    expect(html).not.toMatch(/https?:/);
    const text = textOf(html);
    for (const hash of run.steps.flatMap(hashesOf)) expect(text).toContain(hash);
  });

  it("a hash with an apostrophe or a parenthesis keeps the link in the explorer's path, entity-escaped in the attribute", () => {
    const odd = structuredClone(run);
    odd.steps.find((s) => s.n === 4)!.txHash = "a'b(c)";
    const html = renderStatusHtml(odd);
    expect(html).toContain(`href="${EXPLORER}a&#39;b(c)"`);
    expect(html).toContain(">a&#39;b(c)</a>");
  });
});

describe("demo/status.html: escaping", () => {
  it("escapeHtml turns the three markup characters and the quote into entities, and a browser reads them back", () => {
    const hostile = `<script>alert("x")</script> & &amp; &lt; '"><img src=x onerror=1>`;
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toMatch(/[<>"']/);
    expect(decode(escaped)).toBe(hostile);
  });

  it("every refusal body round-trips through the page to its fixture bytes, whatever characters it holds", () => {
    // A copy of the run whose first refusal body and a label hold every character HTML treats specially.
    const hostile = structuredClone(run);
    const body = `{"error":"<script>alert(1)</script> & &amp; &lt;b&gt; \\" ' </pre><h1>x</h1>","n":"a  b\\tc"}`;
    const step = hostile.steps.find((s) => s.phase === "refusals")!;
    step.attempt!.outcome.rawRpcJson = body;
    step.label = `<img src=x onerror=alert(1)> & "q"`;
    const html = renderStatusHtml(hostile);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<h1>x</h1>");
    expect(preBodies(html)[0]).toBe(body);
    expect(html).toContain(escapeHtml(step.label));
  });

  it("a control character in a chain-sourced string is shown as text, not sent to the browser", () => {
    const hostile: DemoRun = structuredClone(run);
    hostile.steps[0].label = "created \u001b[31mred\u0007";
    const html = renderStatusHtml(hostile);
    expect(html).not.toContain("\u001b");
    expect(html).not.toContain("\u0007");
  });
});

/**
 * Hostile text at every site where a chain read reaches the page (I1). One payload: a script element, a break out of an
 * attribute with an image, and a literal `&amp;` that must stay the text `&amp;` and not turn into `&`. Each site gets its
 * own test: the payload is put there and nowhere else (or, where one field feeds several places, the test names the
 * place it checks), the page is rendered, and then
 *   - the place shows the payload escaped, so a browser displays it as text;
 *   - the page has no `<script` or `<img`, and
 *   - its tags and attribute names are those of the real page: no element, no attribute came from the payload.
 * Dropping the escape at any one site turns its test red; so does dropping it in the shared helper.
 */
const P = `<script>x</script>"><img src=x onerror=1>&amp;`;
const PE = escapeHtml(P);

const stepN = (r: DemoRun, n: number): DemoStep => r.steps.find((s) => s.n === n)!;
const cardOf = (r: DemoRun): CageCard => r.steps.find((s) => s.phase === "inspect")!.card!;
const refusalOf = (r: DemoRun, n: number): Extract<Attempt["outcome"], { kind: "Refusal" }> => {
  const o = stepN(r, n).attempt!.outcome;
  if (o.kind !== "Refusal") throw new Error(`step ${n} is not a refusal`);
  return o;
};
const attemptOf = (r: DemoRun, n: number): Attempt => stepN(r, n).attempt!;

/** Every tag with its attribute names: the shape of the markup, with the style sheet left out. */
function markup(html: string, except: readonly string[] = []): string[] {
  return [...html.replace(/<style>[\s\S]*?<\/style>/g, "").matchAll(/<(\/?[a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/g)]
    // Attribute names are read outside the quoted values (an escaped value holds no quote, so it cannot end early).
    .map((m) => ({ tag: m[1].toLowerCase(), attrs: [...m[2].replace(/"[^"]*"/g, '""').matchAll(/([a-zA-Z_:][\w:.-]*)\s*=/g)].map((a) => a[1].toLowerCase()).sort().join(",") }))
    .filter((t) => !except.includes(t.tag.replace(/^\//, "")))
    .map((t) => `${t.tag} ${t.attrs}`)
    .sort();
}

const REGION = {
  title: /<title>([\s\S]*?)<\/title>/,
  strip: /<p class="strip">([\s\S]*?)<\/p>/,
  h1: /<h1>([\s\S]*?)<\/h1>/,
  sub: /<p class="sub">([\s\S]*?)<\/p>/,
  meta: /<p class="meta">([\s\S]*?)<\/p>/,
  result: /<p class="result">([\s\S]*?)<\/p>/,
  plateHeading: /<h2 class="sect-h" id="plate-h">([\s\S]*?)<\/h2>/,
  plateHead: /<header class="plate-head">([\s\S]*?)<\/header>/,
  plateFoot: /<footer class="plate-foot">([\s\S]*?)<\/footer>/,
  plate: /<article class="plate"[\s\S]*?<\/article>/,
  evidence: /<section class="evidence"[\s\S]*?<\/section>/,
  staircase: /<section class="staircase"[\s\S]*?<\/section>/,
  steps: /<section class="steps"[\s\S]*?<\/section>/,
  foot: /<footer class="foot">([\s\S]*?)<\/footer>/,
  page: /[\s\S]*/,
};

interface Site {
  name: string;
  region: RegExp;
  mutate?: (r: DemoRun) => void;
  /** renderStatusHtml's second argument, for the one site that is not in the run. */
  source?: string;
  /** What the region must hold; by default the escaped payload. */
  holds?: string;
  /** Tags the site may legitimately change (a network with no explorer has no links). */
  except?: string[];
}

const SITES: Site[] = [
  { name: "title: the run id", region: REGION.title, mutate: (r) => void (r.id = P) },
  { name: "strip: the run id", region: REGION.strip, mutate: (r) => void (r.id = P) },
  { name: "strip: the network", region: REGION.strip, mutate: (r) => void (r.network = P as Network), except: ["a"] },
  { name: "strip: the exit code", region: REGION.strip, mutate: (r) => void (r.exitCode = P as unknown as number) },
  { name: "headline: the scope", region: REGION.h1, mutate: (r) => void (cardOf(r).key!.methodNames = [P]) },
  { name: "subline: the receiver", region: REGION.sub, mutate: (r) => void (cardOf(r).key!.receiverId = P) },
  { name: "subline: the signer account", region: REGION.sub, mutate: (r) => void (cardOf(r).key!.accountId = P) },
  { name: "meta line: the network", region: REGION.meta, mutate: (r) => void (r.network = P as Network), except: ["a"] },
  { name: "meta line: the mode", region: REGION.meta, mutate: (r) => void (r.mode = P as DemoRun["mode"]) },
  { name: "meta line: the run id", region: REGION.meta, mutate: (r) => void (r.id = P) },
  { name: "RESULT line: the transcript path", region: REGION.result, mutate: (r) => void (r.transcriptPath = P) },
  { name: "plate heading: the inspect step's label", region: REGION.plateHeading, mutate: (r) => void (stepN(r, 12).label = P) },
  { name: "plate title: the session id", region: REGION.plateHead, mutate: (r) => void (cardOf(r).session.id = P) },
  { name: "plate title: the session network", region: REGION.plateHead, mutate: (r) => void (cardOf(r).session.network = P as Network) },
  { name: "plate footer: the read time", region: REGION.plateFoot, mutate: (r) => void (cardOf(r).readAt = P) },
  { name: "plate footer: the run id", region: REGION.plateFoot, mutate: (r) => void (r.id = P) },
  {
    name: "plate span: a method name",
    region: REGION.plate,
    mutate: (r) => void (cardOf(r).tools.find((t) => t.kind === "call" && t.classification === "callable")!.method = P),
  },
  { name: "plate span: a view method", region: REGION.plate, mutate: (r) => void (cardOf(r).tools.find((t) => t.kind === "view")!.method = P) },
  { name: "plate span: the receiver", region: REGION.plate, mutate: (r) => void (cardOf(r).key!.receiverId = P) },
  { name: "plate span: the signer account", region: REGION.plate, mutate: (r) => void (cardOf(r).key!.accountId = P) },
  { name: "plate span: the public key", region: REGION.plate, mutate: (r) => void (cardOf(r).key!.publicKey = P) },
  {
    name: "plate span: the code hash",
    region: REGION.plate,
    mutate: (r) => {
      cardOf(r).session.codeHashPin = P;
      cardOf(r).codeHashNow = P;
    },
  },
  { name: "plate span: the exposure value", region: REGION.plate, mutate: (r) => void (cardOf(r).exposure.value = P) },
  { name: "plate span: the session id (the EXPIRY row)", region: REGION.plate, mutate: (r) => void (cardOf(r).session.id = P) },
  { name: "plate label: the exposure label", region: REGION.plate, mutate: (r) => void (cardOf(r).exposure.label = P as CageCard["exposure"]["label"]), holds: `role="rowheader">${PE}</div>` },
  { name: "evidence: the parsed error name", region: REGION.evidence, mutate: (r) => void (refusalOf(r, 7).errorName = P), holds: `<span class="verdict">${PE}</span>` },
  { name: "evidence: the step label", region: REGION.evidence, mutate: (r) => void (stepN(r, 7).label = P) },
  { name: "evidence: the signed method", region: REGION.evidence, mutate: (r) => void (attemptOf(r, 7).method = P) },
  { name: "evidence: the signed receiver", region: REGION.evidence, mutate: (r) => void (attemptOf(r, 7).receiverId = P) },
  { name: "evidence: the signed deposit", region: REGION.evidence, mutate: (r) => void (attemptOf(r, 7).depositYocto = P) },
  { name: "evidence: the signed action", region: REGION.evidence, mutate: (r) => void (attemptOf(r, 8).action = P as Attempt["action"]) },
  { name: "evidence: the error path", region: REGION.evidence, mutate: (r) => void (refusalOf(r, 7).path[2] = P) },
  { name: "evidence: the fixture name in the summary", region: REGION.evidence, mutate: (r) => void (stepN(r, 7).fixture = P) },
  { name: "evidence: the body", region: REGION.evidence, mutate: (r) => void (refusalOf(r, 7).rawRpcJson = P), holds: `<pre>${PE}</pre>` },
  { name: "evidence: the step number in the id", region: REGION.page, mutate: (r) => void (stepN(r, 7).n = P as unknown as number), holds: `id="refusal-${PE}"` },
  { name: "staircase: the parsed error name", region: REGION.staircase, mutate: (r) => void (refusalOf(r, 7).errorName = P), holds: `<span class="verdict">${PE}</span>` },
  { name: "staircase: the step number", region: REGION.staircase, mutate: (r) => void (stepN(r, 7).n = P as unknown as number), holds: `<span class="n" role="cell">[${PE}]</span>` },
  { name: "staircase: the check's first slot number", region: REGION.staircase, mutate: (r) => void (stepN(r, 7).n = P as unknown as number), holds: `read before [${PE}] and after` },
  { name: "staircase: the check's last slot number", region: REGION.staircase, mutate: (r) => void (stepN(r, 10).n = P as unknown as number), holds: `and after [${PE}]` },
  { name: "staircase: the check's own step number", region: REGION.staircase, mutate: (r) => void (stepN(r, 11).n = P as unknown as number), holds: `<strong>[${PE}/14] CHAIN CHECK</strong>` },
  { name: "staircase: the check's nonce", region: REGION.staircase, mutate: (r) => void (stepN(r, 11).chainCheck!.before.nonce = P as unknown as number), holds: `nonce ${PE} →` },
  { name: "step table: the label", region: REGION.steps, mutate: (r) => void (stepN(r, 1).label = P) },
  { name: "step table: the signer", region: REGION.steps, mutate: (r) => void (stepN(r, 4).signer = P as DemoStep["signer"]) },
  { name: "step table: the result of a refusal (its error name)", region: REGION.steps, mutate: (r) => void (refusalOf(r, 7).errorName = P), holds: `PASS: refused by protocol (${PE})` },
  {
    name: "step table: the result of a failed step (its note)",
    region: REGION.steps,
    mutate: (r) => {
      stepN(r, 4).pass = false;
      stepN(r, 4).note = P;
    },
    holds: `FAIL: ${PE}`,
  },
  { name: "step table: a note row", region: REGION.steps, mutate: (r) => void (stepN(r, 1).note = P), holds: `<td colspan="4">${PE}</td>` },
  {
    name: "step table: the text of a hash on a network with no explorer",
    region: REGION.steps,
    mutate: (r) => {
      r.network = "sandbox";
      stepN(r, 4).txHash = P;
    },
    except: ["a"],
  },
  { name: "step table: the link text of a hash", region: REGION.steps, mutate: (r) => void (stepN(r, 4).txHash = P) },
  { name: "step table: the step number in the id", region: REGION.page, mutate: (r) => void (stepN(r, 4).n = P as unknown as number), holds: `id="step-${PE}"` },
  { name: "footer: the run id", region: REGION.foot, mutate: (r) => void (r.id = P) },
  { name: "footer: the network", region: REGION.foot, mutate: (r) => void (r.network = P as Network), except: ["a"] },
  { name: "footer: the source path", region: REGION.foot, source: P },
];

describe("demo/status.html: hostile text at every site a chain read reaches", () => {
  it("the table names at least 50 distinct sites, each with a test of its own below", () => {
    expect(new Set(SITES.map((s) => s.name)).size).toBe(SITES.length);
    expect(SITES.length).toBeGreaterThanOrEqual(50);
  });

  it("a failing step's note is its FAIL result, not also a note row", () => {
    const failed = structuredClone(run);
    stepN(failed, 4).pass = false;
    stepN(failed, 4).note = "x marks the spot";
    const html = renderStatusHtml(failed);
    expect(html.match(/x marks the spot/g)).toHaveLength(1);
    expect(html).toContain("FAIL: x marks the spot");
  });

  it.each(SITES.map((site) => [site.name, site] as const))("%s", (_, site) => {
    const hostile = structuredClone(run);
    site.mutate?.(hostile);
    const html = renderStatusHtml(hostile, site.source);
    const region = site.region.exec(html);
    expect(region, "the place exists").not.toBeNull();
    expect(region![0], "the payload is there, escaped").toContain(site.holds ?? PE);
    expect(textOf(region![0]), "and a browser shows it as text").toContain(P);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(markup(html, site.except), "no element and no attribute came from the payload").toEqual(markup(page, site.except));
    for (const href of [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])) expect(href.startsWith(EXPLORER)).toBe(true);
  });
});

describe("demo/status.html: the secret scan", () => {
  it("finds no key in it, and the scan did read the public values the page holds", () => {
    const r = scanText("demo/status.html", page);
    expect(r.hits).toEqual([]);
    expect(r.values32).toBeGreaterThan(0); // the session's public key, the card's and the burn body's
    expect(r.values64).toBe(0);
  });

  it("holds no private key by name either: the three words the scan keys on do not appear", () => {
    expect(page).not.toMatch(/private|secret|seed/i);
  });
});
