/**
 * R1 `README.md` (Task 20): the first screen for the AI screeners (LAYOUT R1, DESIGN §5.5, PRD §4 README contract).
 *
 * Every hash, key, count and evidence link the README quotes is checked here against the committed file it was
 * copied from: `demo/transcript.md` (the testnet run), `demo/capture.sandbox.md` (a sandbox run),
 * `demo/judging-session.json` (the live judging session) and `demo/fixtures/manifest.json` (the R7 refusals).
 * Nothing is typed in from a screenshot, so a README value that drifts from its source turns this file red.
 * Offline: it reads files only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatNear } from "../src/core/amounts.js";
import { DEFAULT_TESTNET_RPC } from "../src/core/config.js";
import { parseRefusal } from "../src/core/refusal.js";
import { SIX_OF_EIGHT, noTools } from "../src/render/strings.js";
import { REPO } from "./helpers.js";

const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const readme = read("README.md");
const lines = readme.split("\n");

interface JudgingSession {
  id: string;
  network: string;
  accountId: string;
  receiverId: string;
  methodNames: string[];
  allowanceYocto: string;
  publicKey: string;
  codeHashPin: string;
}
const judging = JSON.parse(read("demo/judging-session.json")) as JudgingSession;

/** The `RESULT …` line of a capture log. */
const resultLine = (log: string): string => read(log).split("\n").find((l) => l.startsWith("RESULT ")) ?? "";
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** The first words of noTools: the error `wrap` prints for code no pack pins. */
const NO_TOOLS = noTools([]).split(" — ")[0];

/** A 43–44 character base58 run: a tx hash, the body of a public key, or a code hash. */
const BASE58_HASH = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;

/**
 * Whether `hash` stands for a transaction somewhere in `text`. Every occurrence counts as a tx hash unless it is
 * the body of a public key (`ed25519:` right before it) or a code hash (its line names code_hash / CODE HASH /
 * codeHash). So an unlabelled hash is checked as a tx hash: the stricter reading.
 */
function isTxHashContext(hash: string, text: string = readme): boolean {
  for (let i = text.indexOf(hash); i !== -1; i = text.indexOf(hash, i + hash.length)) {
    if (text.slice(Math.max(0, i - 8), i) === "ed25519:") continue;
    const lineStart = text.lastIndexOf("\n", i) + 1;
    const lineEnd = text.indexOf("\n", i);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (/code_hash|CODE HASH|codeHash/.test(line)) continue;
    return true;
  }
  return false;
}

/** Markdown link targets that are repo paths: no URL scheme, not an in-page anchor; a `#fragment` is dropped. */
function relativeLinks(text: string): string[] {
  const links: string[] = [];
  for (const m of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#")) continue;
    links.push(decodeURIComponent(target.split("#")[0]));
  }
  return links;
}

/** The body of the `## TITLE` section, up to the next `## ` heading. */
function section(title: string): string {
  const start = readme.indexOf(`\n## ${title}\n`);
  expect(start, `section ## ${title}`).toBeGreaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

/** The 4 numbered steps of "Try it", each with its indented body. */
function trySteps(): string[] {
  return section("Try it")
    .split(/\n(?=\d+\. )/)
    .slice(1);
}

describe("the helpers", () => {
  it("isTxHashContext: a public key's body and a code hash are not tx hashes; a tx link and a bare hash are", () => {
    const tx = "Ek1APr5joscLK3cRL9DPuesjGpvSLZ1cQPs9uRJEX9WT";
    const key = "C4M3YfYSuVQf74MwUqVA2WdNmesZZ8X3ZYzrdy6tQ3Gj";
    const code = "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq";
    expect(isTxHashContext(key, `key \`ed25519:${key}\` on seat`)).toBe(false);
    expect(isTxHashContext(code, `| CODE HASH  ${code} · match |`)).toBe(false);
    expect(isTxHashContext(code, `code_hash ${code}`)).toBe(false);
    expect(isTxHashContext(tx, `[Ek1A...X9WT](https://testnet.nearblocks.io/txns/${tx})`)).toBe(true);
    expect(isTxHashContext(tx, `DAO creation \`${tx}\``)).toBe(true);
    expect(isTxHashContext(key, `ed25519:${key}\nthen ${key} alone`)).toBe(true);
  });

  it("relativeLinks: repo paths only, fragments dropped", () => {
    const md = "[a](demo/transcript.md) [b](https://x.y/z) [c](#try-it) [d](LICENSE#L1) [e](<demo/screeners/>) [f](mailto:a@b)";
    expect(relativeLinks(md)).toEqual(["demo/transcript.md", "LICENSE", "demo/screeners/"]);
  });
});

describe("README.md (R1)", () => {
  it("lines 1–14: the near-mcp answer, the boundary table, the positioning lines; no stale copy", () => {
    expect(lines[0]).toMatch(/^\*\*Keyhole\*\*.*near-mcp.*import_account/);
    expect(lines[1]).toBe("");
    expect(lines[10]).toBe("");
    expect(lines.slice(2, 10).filter((l) => l.startsWith("|"))).toHaveLength(8);
    expect(readme).not.toMatch(/npx keyhole|TODO\(build\)|Status: scaffold|deleted at exit/);
    expect(readme).toContain(judging.publicKey);
    expect(readme).toContain("six of eight");
    expect(readme).toMatch(/\*\*Verdict\*\*/);
    expect(readme).toContain("operator-side daemon");
    for (const t of ["[offline]", "[network]", "[network + funded testnet account in env]", "[optional]"]) expect(readme).toContain(t);
  });

  it("every tx hash is one the testnet transcript recorded, and there are at least 3 (DAO creation, vote, DeleteKey)", () => {
    const transcript = read("demo/transcript.md");
    const txHashes = new Set<string>();
    for (const h of readme.match(BASE58_HASH) ?? []) {
      if (!isTxHashContext(h)) continue;
      txHashes.add(h);
      expect(transcript, h).toContain(h);
    }
    expect(txHashes.size).toBeGreaterThanOrEqual(3);
  });

  it("every relative link resolves to a file or directory in the repo", () => {
    const links = relativeLinks(readme);
    expect(links.length).toBeGreaterThan(0);
    for (const link of relativeLinks(readme)) expect(existsSync(join(REPO, link)), link).toBe(true);
  });

  it("the boundary table: the 'Enforced by' column opens with the card's words, and only PROTOCOL is bold", () => {
    const rows = lines.slice(4, 10).map((l) => l.split("|").map((c) => c.trim()));
    const enforcedBy = rows.map((cells) => cells[2]);
    const openers = ["**PROTOCOL** — ", "NOT A KEY LIMIT — ", "KEYHOLE server-side — ", "OPERATOR — ", "— ", "NOT A KEY LIMIT — "];
    expect(enforcedBy).toHaveLength(openers.length);
    enforcedBy.forEach((cell, i) => expect(cell.startsWith(openers[i]), cell).toBe(true));
    expect(enforcedBy.join(" ").match(/\*\*/g)).toHaveLength(2);
  });

  it("the cage card follows lines 1–14 as a fenced text block from inspect of the judging session", () => {
    const tryIt = readme.indexOf("\n## Try it\n");
    const fence = readme.indexOf("\n```text\n");
    expect(fence).toBeGreaterThan(lines.slice(0, 14).join("\n").length);
    expect(fence).toBeLessThan(tryIt);
    const card = readme.slice(fence, readme.indexOf("\n```\n", fence + 1));
    expect(card).toContain(`KEYHOLE inspect · ${judging.id} · ${judging.network} · on-account`);
    expect(card).toContain(`| KEY        ${judging.publicKey} `);
    expect(card).toContain(`| CODE HASH  ${judging.codeHashPin} · match `);
    expect(card).toContain(`| RECEIVER   ${judging.receiverId} `);
    expect(card).toContain(`| SIGNER     ${judging.accountId} · on-account `);
    expect(card).toContain("[LIVE]");
    expect(card).not.toMatch(/\/home\/|\/Users\//);
  });

  it("'Try it' has 4 numbered steps, each opening with its tag, in order", () => {
    const steps = section("Try it")
      .split("\n")
      .filter((l) => /^\d+\. /.test(l));
    expect(steps.map((s) => s.match(/^\d+\. `(\[[^\]]+\])`/)?.[1])).toEqual([
      "[offline]",
      "[network]",
      "[network + funded testnet account in env]",
      "[optional]",
    ]);
  });

  it("every `npm run SCRIPT` the README names exists in package.json", () => {
    const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);
    const named = [...readme.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(named).toContain("keyhole");
    for (const s of named) expect(scripts, s).toContain(s);
  });

  it("every RESULT line it quotes is in the capture log it came from", () => {
    const logs = read("demo/transcript.md") + read("demo/capture.sandbox.md");
    const quoted = [...readme.matchAll(/`(RESULT [^`]+)`/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThan(0);
    for (const q of quoted) expect(logs, q).toContain(q);
  });

  it("Verification: 7 rows whose evidence files are the manifest's, each refusing with the error its row names", () => {
    const verification = section("Verification — negative tests");
    expect(verification).toContain("Negative tests — the protocol is expected to reject the following.");
    expect(verification).toContain(SIX_OF_EIGHT.split(" InvalidAccessKeyError")[0]);
    expect(verification).toContain("https://github.com/near/nearcore/blob/master/core/primitives/src/errors.rs");
    const manifest = (JSON.parse(read("demo/fixtures/manifest.json")) as { refusals: Array<Record<string, string>> }).refusals;
    const files = manifest.map((r) => `demo/fixtures/${r.network}.${r.pack}.${r.test}.json`);
    const rows = verification.split("\n").filter((l) => l.startsWith("| ") && /\]\(demo\/fixtures\//.test(l));
    expect(rows).toHaveLength(7);
    const linked = rows.map((row) => row.match(/\]\((demo\/fixtures\/[^)]+)\)/)?.[1] ?? "");
    expect([...linked].sort()).toEqual([...files].sort());
    for (const [i, row] of rows.entries()) {
      const expected = row.split("|")[3].match(/`(\w+)`/)?.[1];
      expect(parseRefusal(read(linked[i]))?.errorName, linked[i]).toBe(expected);
    }
  });

  it("the judging session line names its public key and account, and view_access_key", () => {
    const line = section("Verification — negative tests")
      .split("\n")
      .find((l) => l.includes(judging.publicKey));
    expect(line).toBeDefined();
    expect(line).toContain(judging.accountId);
    expect(line).toContain("view_access_key");
  });

  it("Evidence links demo/screeners/, and the screener prompt is neutral", () => {
    expect(section("Evidence")).toContain("](demo/screeners/)");
    const prompt = read("demo/screeners/prompt.txt");
    expect(prompt).toContain("Read README.md.");
    expect(prompt).toContain("Do not modify files.");
    expect(prompt).not.toMatch(/\byou are\b|attack|hack|bypass|jailbreak/i);
  });

  it("names no local home path", () => {
    expect(readme).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:\\Users\\/);
  });
});

describe("README.md: quoted values pinned to their sources", () => {
  it("every public key in it is the judging session's: the card, the prose line and the curl command (I2)", () => {
    const keys = readme.match(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g) ?? [];
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const k of keys) expect(k).toBe(judging.publicKey);
  });

  it("the curl command asks the default testnet RPC for the judging key's view_access_key (I2)", () => {
    const curl = section("Verification — negative tests").match(/\ncurl -s (\S+) \\\n[\s\S]*?\n {2}-d '([^']+)'\n/);
    expect(curl, "curl block").not.toBeNull();
    expect(curl?.[1]).toBe(DEFAULT_TESTNET_RPC);
    const body = JSON.parse(curl?.[2] ?? "null") as { method: string; params: unknown };
    expect(body.method).toBe("query");
    expect(body.params).toEqual({ request_type: "view_access_key", finality: "final", account_id: judging.accountId, public_key: judging.publicKey });
  });

  it("the quoted view_access_key reply is the judging session's scope (M8)", () => {
    const reply = readme.match(/the reply held `"permission":(\{[^`]+\})`/);
    expect(reply, "reply quote").not.toBeNull();
    expect(JSON.parse(reply?.[1] ?? "null")).toEqual({
      FunctionCall: { allowance: judging.allowanceYocto, method_names: judging.methodNames, receiver_id: judging.receiverId },
    });
  });

  it("step 1 states the Node version package.json requires (M6)", () => {
    const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(trySteps()[0]).toContain(`Node ${engines.slice(2)} or newer`);
  });

  it("step 2's wall time is the committed sandbox run's, and step 3's is the committed testnet run's (M1, M8)", () => {
    const sandboxSecs = resultLine("demo/capture.sandbox.md").match(/ · (\d+)s · exit 0/)?.[1];
    expect(sandboxSecs).toBeDefined();
    expect(trySteps()[1]).toContain(`(${sandboxSecs} s in the committed run, [\`demo/capture.sandbox.md\`](demo/capture.sandbox.md))`);
    const testnetTime = resultLine("demo/transcript.md").match(/ · (\d+m\d+s) · exit 0/)?.[1];
    expect(testnetTime).toBeDefined();
    expect(trySteps()[2]).toContain(`exit 0, in ${testnetTime}.`);
    const refusals = read("demo/transcript.md").match(/PASS: refused by protocol/g)?.length ?? 0;
    expect(trySteps()[2]).toContain(`${NUMBER_WORDS[refusals]} \`PASS: refused by protocol (NAME)\` lines`);
  });

  it("step 3 writes its run outside the committed demo/ (M7)", () => {
    const dir = trySteps()[2].match(/\n {3}export KEYHOLE_DEMO_OUT=(\S+)\n/)?.[1];
    expect(dir).toBeDefined();
    expect(dir).toMatch(/^\.\/[\w-]+$/);
    expect(dir).not.toBe("./demo");
    expect(trySteps()[2]).toContain(`\`${dir}/demo\``);
    // C-T20e: a judge's clone must not show that run as untracked files.
    const ignored = read(".gitignore").split("\n").map((l) => l.trim());
    expect(ignored, `.gitignore lists ${dir!.slice(2)}/`).toContain(`${dir!.slice(2)}/`);
  });

  it("step 4 names the refusal a v3.31 DAO gets, and its 'see' is the tools/list handshake's tool list (I1, M3, M8)", () => {
    const step4 = trySteps()[3];
    expect(step4).toContain("`sputnikv2.testnet` factory (v3.31)");
    expect(step4).toContain(`\`${NO_TOOLS}\``);
    expect(step4).toContain("(see Limits)");
    expect(step4).toContain("from a `tools/list` handshake");
    // serve lists keyhole_inspect, the pack's views, its call tools whose method the key allows, then keyhole_attempt
    // (src/cli/serve.ts servedPackTools). The session is the testnet run's, as wrap minted it.
    type Tool = { name: string; kind: string; method: string | null };
    const run = JSON.parse(read("demo/run.testnet.json")) as { steps: Array<{ n: number; card?: { session: { methodNames: string[]; tools: Tool[] } } }> };
    const session = run.steps.find((s) => s.n === 3)?.card?.session;
    const served = (session?.tools ?? []).filter((t) => t.kind === "view" || (t.kind === "call" && t.method !== null && session?.methodNames.includes(t.method)));
    const packTools = [...served.filter((t) => t.kind === "view"), ...served.filter((t) => t.kind === "call")].map((t) => t.name);
    expect(packTools.length).toBeGreaterThan(0);
    const listed = step4.match(/: (\w+) tools, ((?:`\w+`(?:, | and )?)+);/);
    expect(listed, "tool list").not.toBeNull();
    const names = [...(listed?.[2] ?? "").matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(names).toEqual(["keyhole_inspect", ...packTools, "keyhole_attempt"]);
    expect(listed?.[1]).toBe(NUMBER_WORDS[names.length]);
    expect(step4).toContain(`\`${names.length} tools\``);
  });

  it("row 5's amounts are the allowance fixture's, at 4 decimals (M8)", () => {
    const body = read("demo/fixtures/sandbox.counter.refuse-allowance.json");
    const detail = (parseRefusal(body)?.detail as { NotEnoughAllowance: { account_id: string; allowance: string; cost: string } }).NotEnoughAllowance;
    const row = section("Verification — negative tests")
      .split("\n")
      .find((l) => l.includes("`NotEnoughAllowance`"));
    expect(row).toContain(`whose ${formatNear(detail.allowance)} NEAR allowance`);
    expect(row).toContain(`(${formatNear(detail.cost)} NEAR)`);
    expect(section("Verification — negative tests")).toContain(`the session sub-account \`${detail.account_id}\``);
  });

  it("a tx link's text is the hash its URL names (M8)", () => {
    const links = [...readme.matchAll(/\[`?([^\]`]+)`?\]\(https:\/\/testnet\.nearblocks\.io\/txns\/([^)]+)\)/g)];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const [, text, hash] of links) expect(text).toBe(hash);
  });

  it("Limits keeps each recorded limit, with the v3.31 refusal among the first three (I1, M4, C-T9b, C-T10a, C-T17a)", () => {
    const bullets = section("Limits")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    const v331 = bullets.findIndex((b) => b.includes("`sputnikv2.testnet` factory (version 3.31)"));
    expect(v331).toBeGreaterThanOrEqual(0);
    expect(v331).toBeLessThan(3);
    expect(bullets[v331]).toContain(`\`${NO_TOOLS}\``);
    const limits = bullets.join("\n");
    for (const phrase of [
      "`keyhole_attempt` does not check it",
      "A `callable` label is observed by dry-running the method from a council seat's full-access key on a sandbox copy of the target.",
      "it never hides a capability",
      "the role name `council`",
      "TokenWeight",
      "`ERR_WRONG_KIND` path is untested",
      "`msg: null` included",
      "above 2^53",
      "The default `~/.keyhole` fits; a `KEYHOLE_HOME` path of about 69 characters or more",
    ])
      expect(limits).toContain(phrase);
    expect(lines[6]).toContain("before each pack call (`dao_vote`)");
  });

  it("Disclosures and Evidence keep the verbatim key sentence, the compat-wasm licence basis and the screener-log note (M2, M5)", () => {
    expect(section("Disclosures")).toContain(
      "Private keys live only in near-cli-rs's legacy keychain (`~/.near-credentials`) or in process memory; never in this repo.",
    );
    expect(section("Disclosures")).toContain("It has no licence file of its own: its licence basis is the factory's metadata");
    expect(section("Evidence")).toContain("The logs of those runs are added by the screener runs.");
  });
});
