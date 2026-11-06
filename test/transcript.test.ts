/**
 * Task 16: the committed testnet evidence. One live `npm run keyhole -- demo --testnet` wrote demo/transcript.md,
 * demo/run.testnet.json and the five demo/fixtures/testnet.sputnik-v2.*.json bodies; nothing here edits them.
 *
 * Every expectation is derived from those files (the run file's steps, the fixture bytes) with two pinned values:
 * the DAO's creation tx and time, which Task 15's bootstrap recorded as the testnet state's `daoCreateTx` and
 * `daoCreatedAt` (R13b; the state file lives in ~/.keyhole, which no test reads). Offline: committed files only.
 *
 * Rulings: R10b (the PASS count is the refusal rows, one passRefused each), R13b (the creation tx is in the
 * transcript), R18b (beat 3 over the testnet bodies fits 100x30), C-T14a (the manifest replays each step under its
 * own network; a replayed testnet capture never disagrees with the live verdict).
 *
 * Fix round 1: the privacy check matches local path forms, never a bare user name (I1); the RESULT line, the header
 * and every table row are checked against the run file (M1); row 01 shows the reused DAO's `created DATE` (M3:
 * demo/transcript.md was re-rendered from demo/run.testnet.json, a 22-byte change to that row only).
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeFromBody } from "../src/core/attempt.js";
import { landedFailure } from "../src/core/tx.js";
import type { DemoRun, DemoStep } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { createStepPrinter, hashesOf } from "../src/render/demo-log.js";
import { nn } from "../src/render/refusal-block.js";
import { PASS_IN_SCOPE, passChainCheck, passRefused } from "../src/render/strings.js";
import { displayWidth, stripAnsi } from "../src/render/style.js";
import type { TermCaps } from "../src/render/term.js";
import { renderTranscript } from "../src/render/transcript.js";
import { REPO, color100, plain100 } from "./helpers.js";

/** Task 15's bootstrap: `daoCreateTx` of ~/.keyhole/testnet-demo.json for kh-2c19.sputnik-v2.testnet (task-15-report). */
const DAO_CREATE_TX = "Ek1APr5joscLK3cRL9DPuesjGpvSLZ1cQPs9uRJEX9WT";
/** The same state's `daoCreatedAt`: [01] reuses the DAO, so its note says `created 2026-11-06` (R13a). */
const DAO_CREATED_AT = "2026-11-06T09:47:05.334Z";
const CREATED_NOTE = `created ${DAO_CREATED_AT.slice(0, 10)}`;
const HERO_REFUSALS = ["refuse-method", "refuse-action", "refuse-receiver", "refuse-deposit"] as const;
const TESTNET_TESTS = [...HERO_REFUSALS, "after-burn"] as const;

const TRANSCRIPT = join(REPO, "demo", "transcript.md");
const RUN_FILE = join(REPO, "demo", "run.testnet.json");
const FIXTURES = join(REPO, "demo", "fixtures");
const fixtureFile = (t: string): string => `testnet.sputnik-v2.${t}.json`;
const fixtureBytes = (t: string): string => readFileSync(join(FIXTURES, fixtureFile(t)), "utf8");

const md = readFileSync(TRANSCRIPT, "utf8");
const runText = readFileSync(RUN_FILE, "utf8");
const recorded = JSON.parse(runText) as DemoRun;
const replayed = await loadDemoRunFixture(RUN_FILE);

/** The steps whose outcome is a refusal: one transcript row and one fenced body each (R10b). */
const refusalSteps = recorded.steps.filter((s) => s.attempt?.outcome.kind === "Refusal");
const explorer = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;
const stepAt = (n: number): DemoStep => recorded.steps.find((s) => s.n === n)!;
/** The committed artifacts of the run, by name. */
const artifacts = (): Array<readonly [string, string]> => [
  ["demo/transcript.md", md],
  ["demo/run.testnet.json", runText],
  ...TESTNET_TESTS.map((t) => [fixtureFile(t), fixtureBytes(t)] as const),
];
/** Row NN of a transcript's step table. */
const rowOf = (text: string, n: number): string | undefined => text.split("\n").find((l) => l.startsWith(`| [${nn(n)}/`));

/** The tx hashes a step produced, read from the run file alone: its own (or its landed attempt's), then the further ones. */
function hashesIn(s: DemoStep): string[] {
  const o = s.attempt?.outcome;
  const own = s.txHash ?? (o !== undefined && o.kind !== "Refusal" ? o.txHash : undefined);
  return [...new Set([...(own === undefined ? [] : [own]), ...(s.moreTxHashes ?? [])])];
}

/** Any home path, in the three OS forms. */
const ANY_HOME = /\/home\/|\/Users\/|[A-Za-z]:\\Users\\/i;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The local paths `text` names (I1): any `/home/`, `/Users/` or `C:\Users\` path, and the user's own homes, each
 * as a whole path (followed by a separator, a quote, a space, `)` or the end): `/home/USER`, `/Users/USER`,
 * `C:\Users\USER` and every home directory given. The bare user name is never matched on its own: a short name
 * (`app`, `ali`) is a substring of ordinary words ("approve", "validation") and of base58 hashes. A home that is
 * only separators (`/`) would name every path, so it is skipped.
 */
function localPathLeaks(text: string, who: { user: string; homes: readonly string[] }): string[] {
  const leaks: string[] = [];
  const any = ANY_HOME.exec(text);
  if (any) leaks.push(any[0]);
  const forms = [...(who.user === "" ? [] : [`/home/${who.user}`, `/Users/${who.user}`, `C:\\Users\\${who.user}`]), ...who.homes];
  for (const home of new Set(forms.filter((h) => /[^\\/:]/.test(h.replace(/^[A-Za-z]:/, ""))))) {
    const hit = new RegExp(`${escapeRegExp(home)}(?=[\\\\/"'\x60\\s)]|$)`, home.includes("\\") ? "i" : "").exec(text);
    if (hit) leaks.push(hit[0]);
  }
  return leaks;
}

describe("demo/transcript.md: the testnet run", () => {
  it("links at least 3 testnet txns: the DAO creation, a vote, the DeleteKey", () => {
    expect(md.match(/https:\/\/testnet\.nearblocks\.io\/txns\/\w+/g)!.length).toBeGreaterThanOrEqual(3);
    const vote = stepAt(4); // the session's in-scope vote on #A
    const burn = stepAt(13); // the seat's DeleteKey
    expect(vote.phase).toBe("in-scope");
    expect(burn.phase).toBe("burn");
    for (const hash of [DAO_CREATE_TX, vote.txHash!, burn.txHash!]) expect(md).toContain(explorer(hash));
  });

  it("carries each refusal body byte for byte, as its fixture holds it", () => {
    for (const t of HERO_REFUSALS) expect(md).toContain(fixtureBytes(t));
    expect(md).toContain(fixtureBytes("after-burn"));
  });

  it("ends 14/14 PASS, exit 0", () => {
    expect(md).toMatch(/^RESULT 14\/14 PASS .* exit 0 /m);
    expect(recorded.network).toBe("testnet");
    expect(recorded.mode).toBe("live");
    expect(recorded.exitCode).toBe(0);
    expect(recorded.steps).toHaveLength(14);
    expect(recorded.steps.every((s) => s.pass)).toBe(true);
  });

  it("R10b: one `PASS: refused by protocol` per refusal row, each with its parsed name", () => {
    expect(refusalSteps).toHaveLength(5);
    const lines = md.split("\n").filter((l) => l.includes("PASS: refused by protocol"));
    expect(lines).toHaveLength(refusalSteps.length);
    refusalSteps.forEach((s, i) => {
      const o = s.attempt!.outcome;
      expect(o.kind).toBe("Refusal");
      if (o.kind === "Refusal") expect(lines[i]).toContain(`| ${passRefused(o.errorName)} | never in a block |`);
    });
  });

  it("R13b: row [01] carries the DAO's creation tx from Task 15's state", () => {
    expect(md).toContain(DAO_CREATE_TX);
    expect(stepAt(1).txHash).toBe(DAO_CREATE_TX);
  });

  it("names no local path: the artifacts are committed (I1)", () => {
    // The real home: HOME is redirected into a temp dir by test/home-guard.ts, the passwd entry is not.
    const who = { user: userInfo().username, homes: [userInfo().homedir, process.env.HOME ?? ""] };
    for (const [name, text] of artifacts()) expect(localPathLeaks(text, who), name).toEqual([]);
  });

  it("I1: the check matches path forms, never a bare user name: `app` passes the clean artifacts, /home/app/x fails", () => {
    const app = { user: "app", homes: ["/home/app"] };
    expect(md).toContain("approve"); // `app` is a substring of the clean transcript
    for (const [name, text] of artifacts()) expect(localPathLeaks(text, app), name).toEqual([]);
    expect(localPathLeaks(`${md}log /home/app/x\n`, app)).toEqual(["/home/", "/home/app"]);
    expect(localPathLeaks("log C:\\Users\\app\\x", app)).toEqual(["C:\\Users\\", "C:\\Users\\app"]);
    expect(localPathLeaks("log /Users/app", app)).toEqual(["/Users/", "/Users/app"]);
    // A home outside /home (a container's /app): that path is caught, the word "approve" is not.
    const container = { user: "app", homes: ["/app"] };
    expect(localPathLeaks(md, container)).toEqual([]);
    expect(localPathLeaks("log /app/x.json", container)).toEqual(["/app"]);
    // A root home names every path, so it is skipped rather than matched.
    expect(localPathLeaks(md, { user: "root", homes: ["/"] })).toEqual([]);
    // The review's sample of short names that occur in the artifacts as substrings: none of them is a leak.
    for (const user of ["max", "ann", "eve", "ali", "ash", "art", "ted", "pat", "test", "demo", "app"]) {
      for (const [name, text] of artifacts()) expect(localPathLeaks(text, { user, homes: [`/home/${user}`] }), `${user} in ${name}`).toEqual([]);
    }
  });

  it("M1: the RESULT line states the run file's own counts", () => {
    const passed = recorded.steps.filter((s) => s.pass).length;
    const refusals = recorded.steps.filter((s) => s.pass && s.attempt?.outcome.kind === "Refusal").length;
    const hashes = new Set(recorded.steps.flatMap(hashesIn)).size;
    const secs = Math.round(recorded.durationMs / 1000);
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
    const result = `RESULT ${passed}/${recorded.steps.length} PASS · ${refusals} protocol refusals · ${hashes} tx hashes · ${took} · exit ${recorded.exitCode} · transcript ${recorded.transcriptPath}`;
    expect(md.split("\n").filter((l) => l.startsWith("RESULT"))).toEqual([result]);
  });

  it("M1: the header names the run's network, mode and id", () => {
    const lines = md.split("\n");
    expect(lines.filter((l) => l.startsWith("- network: "))).toEqual([`- network: ${recorded.network}`]);
    expect(lines.filter((l) => l.startsWith("- mode: "))).toEqual([`- mode: ${recorded.mode}`]);
    expect(lines.filter((l) => l.startsWith("- run: "))).toEqual([`- run: \`${recorded.id}\``]);
  });

  it("M1: every table row carries its step's label, signer, verdict and tx cell; nothing says FAIL", () => {
    const rows = md.split("\n").filter((l) => /^\| \[\d{2}\/\d{2}\] /.test(l));
    expect(rows).toHaveLength(recorded.steps.length);
    let earned = 0; // refusals-phase steps refused so far: the chain check's count
    recorded.steps.forEach((s, i) => {
      const o = s.attempt?.outcome;
      const verdict = o?.kind === "Refusal" ? passRefused(o.errorName) : o?.kind === "TxSuccess" ? PASS_IN_SCOPE : s.chainCheck ? passChainCheck(earned) : "PASS";
      const links = hashesIn(s).map((h) => `[${h.slice(0, 4)}...${h.slice(-4)}](${explorer(h)})`);
      const tx = o?.kind === "Refusal" ? "never in a block" : links.length === 0 ? "—" : links.join("<br>") + (s.n === 1 ? ` · ${CREATED_NOTE}` : "");
      const signer = s.signer === "operator" ? "full access" : s.signer;
      expect(rows[i]).toBe(`| [${nn(s.n)}/${nn(s.total)}] ${s.label} | ${signer} | ${verdict} | ${tx} |`);
      if (s.phase === "refusals" && s.pass && o?.kind === "Refusal") earned++;
    });
    expect(md).not.toContain("FAIL");
  });
});

describe("renderTranscript: a reused DAO's creation date (R13a, T16 M3)", () => {
  const meta = { rpc: "https://rpc.testnet.near.org", operator: "kh-op-021e.testnet", startedAt: "2026-11-06T15:05:56.092Z" };
  const withNote = (n: number, note: string | undefined): DemoRun => ({ ...recorded, steps: recorded.steps.map((s) => (s.n === n ? { ...s, note } : s)) });

  it("follows the creation tx in row 01's tx cell; the note's other parts stay out of the table", () => {
    expect(stepAt(1).note).toContain(`${CREATED_NOTE} · `);
    const row = rowOf(renderTranscript(recorded, meta), 1)!;
    expect(row.endsWith(`| [Ek1A...X9WT](${explorer(DAO_CREATE_TX)}) · ${CREATED_NOTE} |`)).toBe(true);
    expect(row).not.toContain("code_hash");
  });

  it("changes row 01 only: without the created part, row 01 is the bare link and every other line is the same", () => {
    const noted = renderTranscript(recorded, meta).split("\n");
    const bare = renderTranscript(withNote(1, "code_hash ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq = pack pin"), meta).split("\n");
    expect(bare).toHaveLength(noted.length);
    expect(noted.filter((l, i) => l !== bare[i])).toEqual([rowOf(noted.join("\n"), 1)]);
    expect(rowOf(bare.join("\n"), 1)!.endsWith(`(${explorer(DAO_CREATE_TX)}) |`)).toBe(true);
  });

  it("only the exact `created YYYY-MM-DD` part of a setup step counts", () => {
    for (const note of ["created 2026-11-06x · code_hash X", "recreated 2026-11-06", "created 2026-11-06T09:47:05Z", "created soon", `${CREATED_NOTE} | x`]) {
      expect(rowOf(renderTranscript(withNote(1, note), meta), 1), note).not.toContain("· created");
    }
    // [04] is an in-scope vote, not a setup step: a note there never reaches its tx cell.
    expect(rowOf(renderTranscript(withNote(4, CREATED_NOTE), meta), 4)).not.toContain("created");
  });

  it("a sandbox run, whose DAO is deployed in the run, names no creation date", () => {
    const sandbox = JSON.parse(readFileSync(join(REPO, "demo", "run.sandbox.json"), "utf8")) as DemoRun;
    expect(renderTranscript(sandbox, meta)).not.toContain("created");
  });

  it("the committed transcript carries it: row 01 of demo/transcript.md ends `· created 2026-11-06`", () => {
    expect(rowOf(md, 1)!.endsWith(` · ${CREATED_NOTE} |`)).toBe(true);
  });
});

describe("demo/run.testnet.json: replayed offline", () => {
  it("writes each refusal's fixture: demo/fixtures/testnet.sputnik-v2.TEST.json holds the step's body", () => {
    const named = recorded.steps.filter((s) => s.fixture !== undefined);
    expect(named.map((s) => s.fixture)).toEqual(TESTNET_TESTS.map(fixtureFile));
    for (const s of named) expect(fixtureBytes(s.fixture!.split(".")[2])).toBe(s.attempt!.outcome.rawRpcJson);
  });

  it("re-derives every outcome from its body and agrees with the live verdict, step by step", () => {
    expect(replayed.exitCode).toBe(0);
    expect(replayed.steps.map((s) => [s.n, s.pass, s.note])).toEqual(recorded.steps.map((s) => [s.n, true, s.note]));
    replayed.steps.forEach((s, i) => expect(s.attempt?.outcome, `step ${s.n}`).toEqual(recorded.steps[i].attempt?.outcome));
  });

  it("C-T14a (2): no landed capture carries a failed receipt, so replay needs no refund-receipt ids", () => {
    const landed = recorded.steps.filter((s) => s.attempt !== undefined && s.attempt.outcome.kind !== "Refusal");
    expect(landed.length).toBeGreaterThan(0);
    for (const s of landed) {
      const o = s.attempt!.outcome;
      expect(landedFailure(JSON.parse(o.rawRpcJson)), `step ${s.n}`).toBeNull();
      expect(outcomeFromBody(o.rawRpcJson)?.kind, `step ${s.n}`).toBe(o.kind);
    }
  });

  it("lists the run's tx hashes: the DAO creation, the proposals, the AddKey, three votes, the DeleteKey", () => {
    const hashes = new Set(recorded.steps.flatMap(hashesOf));
    expect(hashes.has(DAO_CREATE_TX)).toBe(true);
    expect(hashes.size).toBe(8);
    for (const h of hashes) expect(md).toContain(h);
  });
});

/** Beat 3 of the testnet run, as the live TTY prints it: [07]-[10] and the measured chain check [11]. */
function renderBeat3(of: DemoRun, caps: TermCaps): string {
  const beat = of.steps.filter((s) => s.phase === "refusals" || s.phase === "chain-check");
  expect(beat.map((s) => s.phase)).toEqual(["refusals", "refusals", "refusals", "refusals", "chain-check"]);
  const printer = createStepPrinter({ caps, style: "beat", network: "testnet", mode: "live" });
  return beat.map((s) => printer.step(s)).join("\n");
}

describe("R18b: beat 3 over the testnet bodies fits 100x30", () => {
  for (const [mode, caps] of [["styled (FORCE_COLOR, unicode)", color100], ["plain", plain100]] as const) {
    it(`${mode}: at most 29 rows of at most 100 cells`, () => {
      const lines = renderBeat3(recorded, caps).split("\n");
      expect(lines.length).toBeLessThanOrEqual(29);
      expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100);
    });
  }

  it("shows the four testnet bodies whole: each group's rows join to its fixture bytes", () => {
    const groups = stripAnsi(renderBeat3(recorded, color100))
      .split("\n\n")
      .slice(0, 4)
      .map((g) =>
        g
          .split("\n")
          .filter((l) => l.startsWith("    "))
          .map((l) => l.slice(4))
          .join(""),
      );
    expect(groups).toEqual(HERO_REFUSALS.map(fixtureBytes));
  });
});

describe("demo/fixtures/manifest.json after the testnet run (C-T14a (1))", () => {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { refusals: Array<{ network: string; pack: string; test: string }> };

  it("names the 5 sputnik-v2 captures on testnet and the 2 counter refusals on sandbox", () => {
    expect(manifest.refusals.map((e) => `${e.network}.${e.pack}.${e.test}`)).toEqual([...TESTNET_TESTS.map((t) => `testnet.sputnik-v2.${t}`), "sandbox.counter.refuse-allowance", "sandbox.counter.after-burn"]);
  });

  it("replays each entry from the fixture its own network names", async () => {
    const run = await loadDemoRunFixture(join(FIXTURES, "manifest.json"));
    expect(run.exitCode).toBe(0);
    expect(run.steps.map((s) => s.fixture)).toEqual(manifest.refusals.map((e) => `${e.network}.${e.pack}.${e.test}.json`));
    run.steps.forEach((s, i) => {
      const e = manifest.refusals[i];
      expect(s.attempt!.outcome.rawRpcJson).toBe(readFileSync(join(FIXTURES, `${e.network}.${e.pack}.${e.test}.json`), "utf8"));
    });
  });
});
