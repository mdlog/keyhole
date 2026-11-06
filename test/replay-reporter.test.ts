/**
 * The R7 reporter (test/reporters/replay-reporter.ts): fed fake vitest TestCase objects, so what it prints is
 * decided here and not by whichever suites happen to run. The real run is checked by `npm test` itself
 * (Task 14 Step 5: the REPLAY block, 7 PASS lines, 6/6).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestCase, TestModule } from "vitest/node";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";
import { displayWidth } from "../src/render/style.js";
import { CAPTURE_CLASSIFIER, replayBanner } from "../src/render/strings.js";
import { REPO } from "./helpers.js";
import ReplayReporter, { R7_FILES, SUITES, captureLogs, hasDryRuns, wrapLine } from "./reporters/replay-reporter.js";
import type { ReplayMeta, ReplaySuite } from "./replay-meta.js";

const REFUSALS: ReplaySuite = "protocol refusals";
const LABELS: ReplaySuite = "classifier labels (recorded dry-runs)";
const HYGIENE: ReplaySuite = "key hygiene";

type State = "passed" | "failed" | "skipped";

/** The part of a vitest TestCase the reporter reads: name, result().state, options.mode, meta() and the parent chain. */
function fake(name: string, state: State, meta?: ReplayMeta, parents: string[] = [], mode: "run" | "skip" | "todo" = state === "skipped" ? "skip" : "run"): TestCase {
  let parent: unknown = { type: "module" };
  for (const suite of [...parents].reverse()) parent = { type: "suite", name: suite, parent };
  return { type: "test", id: `${name}-${state}`, name, parent, options: { mode }, result: () => ({ state }), meta: () => (meta ? { replay: meta } : {}) } as unknown as TestCase;
}

/** The part of a vitest TestModule the reporter reads: where the file is, and the errors it collected. */
const fakeModule = (file: string, errors: string[] = []): TestModule =>
  ({ type: "module", moduleId: `/repo/${file}`, relativeModuleId: file, state: () => (errors.length ? "failed" : "passed"), errors: () => errors.map((message) => ({ message })) }) as unknown as TestModule;
const line = (suite: ReplaySuite, text: string, files: string[] = []): ReplayMeta => ({ suite, line: text, files });

/** Everything the reporter prints for these cases (and modules), one entry per physical line. */
function output(cases: TestCase[], modules: TestModule[] = []): string[] {
  let text = "";
  const reporter = new ReplayReporter({ write: (t) => void (text += `${t}\n`) });
  for (const c of cases) reporter.onTestCaseResult(c);
  reporter.onTestRunEnd(modules);
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

const isHeading = (l: string): boolean => SUITES.some((suite) => l === `── ${suite} ──`);

/** One passing line in each of the three suites: a run of the whole of R7. */
const wholeRun = (): TestCase[] => [
  fake("r", "passed", line(REFUSALS, "REPLAY r", ["r.json"])),
  ...labelCases(6),
  fake("h", "passed", line(HYGIENE, "secret scan: 0 keys in repo")),
];

const labelCases = (n: number, fail = false): TestCase[] =>
  Array.from({ length: n }, (_, i) => (fail && i === n - 1 ? fake(`label ${i + 1}`, "failed", undefined, [LABELS]) : fake(`label ${i + 1}`, "passed", line(LABELS, `label ${i + 1}`, [`dry-${i + 1}.json`]))));

describe("the REPLAY reporter", () => {
  it("prints the banner first, with the size of the union of the files the lines rest on", () => {
    const out = output([
      fake("a", "passed", line(REFUSALS, "REPLAY a", ["x.json", "y.json"])),
      fake("b", "passed", line(REFUSALS, "REPLAY b", ["y.json", "z.json"])), // y.json is counted once
      fake("c", "passed", line(HYGIENE, "secret scan: 0 keys in repo")), // rests on no fixture
      fake("d", "passed", line(HYGIENE, "display invariant", ["x.json"])), // 4 lines, 3 distinct files
    ]);
    // The locked banner is longer than 100 columns, so it wraps; read back, it is the locked string.
    const banner = out.slice(out.findIndex((l) => l.startsWith("REPLAY —")), out.findIndex(isHeading));
    expect(banner[0]).toMatch(/^REPLAY — offline: no RPC, no sandbox, no keys/);
    expect(banner.map((l) => l.trim()).join(" ")).toBe(replayBanner(3));
  });

  it("names the capture log of each network the files come from (T16 M2): testnet's transcript, the sandbox capture's", () => {
    const bannerOf = (files: string[]): string => {
      const out = output([fake("r", "passed", line(REFUSALS, "REPLAY r", files))]);
      return out.slice(out.findIndex((l) => l.startsWith("REPLAY —")), out.findIndex(isHeading)).map((l) => l.trim()).join(" ");
    };
    const TESTNET = "testnet.sputnik-v2.refuse-method.json";
    const SANDBOX = "sandbox.counter.refuse-allowance.json";
    const DRYRUN = "sandbox.counter.dryrun-increment-zero.json";
    // C-T16b: the dry-run fixtures come from `capture:sandbox --classifier`, which logs to the console and writes no file,
    // so when the lines rest on any of them the banner names that command after the logs.
    expect(bannerOf([SANDBOX, TESTNET, DRYRUN])).toBe(
      "REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (3 files, verbatim RPC responses; capture logs demo/transcript.md (testnet), demo/capture.sandbox.md (sandbox); dry-runs: npm run capture:sandbox -- --classifier)",
    );
    expect(bannerOf([SANDBOX, TESTNET])).toBe(
      "REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (2 files, verbatim RPC responses; capture logs demo/transcript.md (testnet), demo/capture.sandbox.md (sandbox))",
    );
    expect(bannerOf([TESTNET])).toBe("REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (1 files, verbatim RPC responses; capture log demo/transcript.md)");
    expect(bannerOf([SANDBOX, DRYRUN])).toBe(
      "REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (2 files, verbatim RPC responses; capture log demo/capture.sandbox.md; dry-runs: npm run capture:sandbox -- --classifier)",
    );
    // A file name that names no network (a capture directory's `sandbox/052-….json`, a test's `x.json`) names no log.
    expect(bannerOf(["sandbox/052-g1-method-add_proposal.send_tx.json", "x.json"])).not.toContain("capture log");
    expect(captureLogs([TESTNET, SANDBOX, "testnetwork.x.json", "x.testnet.json"])).toEqual([
      ["testnet", "demo/transcript.md"],
      ["sandbox", "demo/capture.sandbox.md"],
    ]);
  });

  // Fix round 1, m-1: the banner names a command someone will copy; a break inside it ("npm run" / "capture:sandbox …") made
  // that copy a broken command. The banner breaks before the command instead.
  it("m-1: the command the banner names is on one row, whole; every row is within 100 cells and reads back as the banner", () => {
    const files = ["sandbox.counter.refuse-allowance.json", "testnet.sputnik-v2.refuse-method.json", "sandbox.counter.dryrun-increment-zero.json"];
    const out = output([fake("r", "passed", line(REFUSALS, "REPLAY r", files))]);
    const banner = out.slice(out.findIndex((l) => l.startsWith("REPLAY —")), out.findIndex(isHeading));
    expect(banner.length).toBeGreaterThan(1);
    expect(banner.filter((row) => row.includes(CAPTURE_CLASSIFIER))).toHaveLength(1);
    expect(banner.at(-1)).toBe(`  ${CAPTURE_CLASSIFIER})`); // the command opens the last row
    for (const row of banner) expect(displayWidth(row), row).toBeLessThanOrEqual(100);
    expect(banner.map((row) => row.trim()).join(" ")).toBe(
      replayBanner(3, [["testnet", "demo/transcript.md"], ["sandbox", "demo/capture.sandbox.md"]], true),
    );
  });

  it("wrapLine keepWhole: a cut that would fall inside the string ends the row before it; without it the string is split", () => {
    const banner = replayBanner(15, [["testnet", "demo/transcript.md"], ["sandbox", "demo/capture.sandbox.md"]], true);
    expect(wrapLine(banner).some((row) => row.includes(CAPTURE_CLASSIFIER))).toBe(false); // the premise: a plain wrap splits it
    const kept = wrapLine(banner, [CAPTURE_CLASSIFIER]);
    expect(kept.filter((row) => row.includes(CAPTURE_CLASSIFIER))).toHaveLength(1);
    expect(kept.map((row) => row.trim()).join(" ")).toBe(banner);
    // A string that opens the text, or is wider than a row, is cut like any word; nothing is lost.
    const wide = "x".repeat(130);
    expect(wrapLine(wide, [wide]).join("").replaceAll(" ", "")).toBe(wide);
    expect(wrapLine(`a ${wide}`, [wide]).every((row) => displayWidth(row) <= 100)).toBe(true);
    // No keepWhole: the wrap is the one it always was.
    expect(wrapLine("word ".repeat(30).trim())).toEqual(wrapLine("word ".repeat(30).trim(), []));
  });

  it("hasDryRuns: the classifier's recorded dry-runs, of either pack, with or without the zero-bond prefix, and nothing else (C-T16b)", () => {
    for (const file of [
      "sandbox.counter.dryrun-increment-zero.json",
      "sandbox.sputnik-v2.dryrun-add_proposal-deposit.json",
      "sandbox.sputnik-v2.zero-bond-dryrun-add_proposal-zero.json",
    ]) expect(hasDryRuns([file]), file).toBe(true);
    for (const file of ["sandbox.counter.refuse-allowance.json", "testnet.sputnik-v2.refuse-method.json", "sandbox.counter.abi.json", "sandbox/052-g1-method-add_proposal.send_tx.json", "dryrun-x.json", "x.json"]) {
      expect(hasDryRuns([file]), file).toBe(false);
    }
    expect(hasDryRuns([])).toBe(false);
  });

  it("prints the suites in order whatever order the tests finished in, and each suite's lines in test order", () => {
    const out = output([
      fake("h1", "passed", line(HYGIENE, "hygiene one")),
      fake("l1", "passed", line(LABELS, "label one", ["l1.json"])),
      fake("r2", "passed", line(REFUSALS, "REPLAY second", ["r2.json"])),
      fake("r1", "passed", line(REFUSALS, "REPLAY first", ["r1.json"])),
      fake("h2", "passed", line(HYGIENE, "hygiene two")),
      fake("l2", "passed", line(LABELS, "label two", ["l2.json"])),
    ]);
    const at = (text: string): number => out.findIndex((l) => l.includes(text));
    expect(at("REPLAY first")).toBe(at("REPLAY second") + 1);
    expect(at("REPLAY first")).toBeLessThan(at("label one"));
    expect(at("label one")).toBeLessThan(at("label two"));
    expect(at("label two")).toBeLessThan(at("hygiene one"));
    expect(at("hygiene one")).toBeLessThan(at("hygiene two"));
    // The three suites carry their names, in the order the LAYOUT gives.
    const heads = [REFUSALS, LABELS, HYGIENE].map((s) => out.findIndex((l) => l.includes(s)));
    expect(heads).toEqual([...heads].sort((a, b) => a - b));
    expect(heads.every((i) => i >= 0)).toBe(true);
  });

  it("ends the classifier suite with K/6, K being the passing tests with that meta", () => {
    const six = output(labelCases(6));
    const sixAt = six.findIndex((l) => l.includes("label 6"));
    expect(six[sixAt + 1]).toBe("6/6");

    const five = output(labelCases(6, true));
    expect(five).toContain("FAIL: label 6");
    expect(five.some((l) => l === "5/6")).toBe(true);
    expect(five.some((l) => l === "6/6")).toBe(false);

    // Only the classifier suite is counted: refusal and hygiene lines do not move K.
    const mixed = output([...labelCases(2), fake("r", "passed", line(REFUSALS, "REPLAY r", ["r.json"])), fake("h", "passed", line(HYGIENE, "h"))]);
    expect(mixed.filter((l) => /^\d+\/6$/.test(l))).toEqual(["2/6"]);
  });

  it("prints FAIL: <test name> for a failed case, in its suite, even when it never reached replayLine", () => {
    const out = output([
      fake("REPLAY x", "passed", line(REFUSALS, "REPLAY [sandbox] a.b", ["a.json"])),
      fake("sandbox.sputnik-v2.refuse-action.json", "failed", undefined, [REFUSALS]),
      fake("serve opens exactly one private key", "failed", undefined, [HYGIENE]),
      fake("unrelated", "failed", undefined, ["some other suite"]), // not an R7 suite: vitest reports it, we do not
    ]);
    expect(out).toContain("FAIL: sandbox.sputnik-v2.refuse-action.json");
    expect(out).toContain("FAIL: serve opens exactly one private key");
    expect(out.some((l) => l.includes("unrelated"))).toBe(false);
    // A name that already starts with FAIL (a missing fixture's note) is not prefixed twice.
    const missing = output([fake("FAIL: fixture missing demo/fixtures/x.json", "failed", undefined, [REFUSALS])]);
    expect(missing).toContain("FAIL: fixture missing demo/fixtures/x.json");
    expect(missing.some((l) => l.startsWith("FAIL: FAIL"))).toBe(false);
  });

  it("every line is at most 100 columns, the banner and a long test name included", () => {
    const long = "x".repeat(250);
    const out = output([
      fake("a", "passed", line(REFUSALS, "REPLAY [sandbox] sputnik-v2.refuse-deposit".padEnd(48) + "PASS: refused by protocol (DepositWithFunctionCall)", ["a.json"])),
      fake("b", "passed", line(LABELS, "zero-bond DAO: add_proposal is callable with 0 deposit (protection comes from method_names alone)")),
      fake(long, "failed", undefined, [HYGIENE]),
      fake("c", "passed", line(HYGIENE, `a ${long} z`)),
    ]);
    expect(out.length).toBeGreaterThan(8);
    for (const l of out) expect(displayWidth(l), l).toBeLessThanOrEqual(100);
    // The PASS string is never shortened or split.
    expect(out).toContain("REPLAY [sandbox] sputnik-v2.refuse-deposit".padEnd(48) + "PASS: refused by protocol (DepositWithFunctionCall)");
  });

  it("neutralizes control characters in anything it prints", () => {
    const out = output([fake("a", "passed", line(HYGIENE, "evil \u001b[31mred\u0007 \nPASS: refused by protocol (Fake)"))]);
    expect(out.join("\n")).not.toMatch(/[\u001b\u0007]/);
    expect(out.some((l) => l === "PASS: refused by protocol (Fake)")).toBe(false); // a raw LF cannot forge a flush-left line
  });

  it("prints nothing when no test carries an R7 line, and ignores skipped and todo cases", () => {
    expect(output([])).toEqual([]);
    expect(output([fake("plain", "passed"), fake("todo", "skipped", undefined, [LABELS]), fake("skip", "skipped", line(HYGIENE, "never"))])).toEqual([]);
  });

  it("a second run starts clean", () => {
    let text = "";
    const reporter = new ReplayReporter({ write: (t) => void (text += `${t}\n`) });
    reporter.onTestCaseResult(fake("a", "passed", line(HYGIENE, "first run")));
    reporter.onTestRunStart();
    reporter.onTestCaseResult(fake("b", "passed", line(HYGIENE, "second run")));
    reporter.onTestRunEnd();
    expect(text).toContain("second run");
    expect(text).not.toContain("first run");
  });

  describe("an honest block: a partial run says so, and a suite that did not load says so", () => {
    it("a run of all three suites carries no partial marker, and a todo case does not make one", () => {
      const out = output([...wholeRun(), fake("prints 6/6", "skipped", undefined, [LABELS], "todo")]);
      expect(out.some((l) => l.startsWith("partial"))).toBe(false);
      expect(out[0]).toMatch(/^REPLAY — offline/);
      expect(out).toContain("6/6");
    });

    it("a filtered run (one suite) opens with a partial marker naming what is missing, before the banner", () => {
      const out = output([fake("r", "passed", line(REFUSALS, "REPLAY r", ["r.json"]))]);
      expect(out[0]).toBe("partial: 1 of 3 R7 suites ran in full; missing: classifier labels (recorded dry-runs), key hygiene");
      expect(out[1]).toMatch(/^REPLAY — offline/);
      for (const l of out) expect(displayWidth(l), l).toBeLessThanOrEqual(100);
      // Two suites: still partial, and it names the one that is left.
      const two = output([...labelCases(6), fake("h", "passed", line(HYGIENE, "h"))]);
      expect(two[0]).toBe("partial: 2 of 3 R7 suites ran in full; missing: protocol refusals");
    });

    it("a suite with a test skipped (a -t filter, an it.skip) did not run in full, even though it has lines", () => {
      const out = output([...wholeRun(), fake("skipped refusal", "skipped", undefined, [REFUSALS])]);
      expect(out[0]).toBe("partial: 2 of 3 R7 suites ran in full; missing: protocol refusals");
      expect(out.some((l) => l === "REPLAY r")).toBe(true);
    });

    it("a suite whose test file failed to load prints FAIL: <suite> did not load (<reason>) under its heading", () => {
      const reason = `ENOENT: no such file or directory, open '${process.cwd()}/demo/fixtures/manifest.json'`;
      const out = output([...labelCases(6), fake("h", "passed", line(HYGIENE, "h"))], [fakeModule(R7_FILES[REFUSALS], [reason]), fakeModule(R7_FILES[LABELS]), fakeModule(R7_FILES[HYGIENE])]);
      const at = out.indexOf(`── ${REFUSALS} ──`);
      expect(at).toBeGreaterThan(0);
      // The working directory is dropped from the reason, and node's wording is compacted to fit.
      expect(out[at + 1]).toBe("FAIL: protocol refusals did not load (ENOENT: no such file: 'demo/fixtures/manifest.json')");
      expect(out[at + 1]).not.toContain(process.cwd());
      expect(out[0]).toBe("partial: 2 of 3 R7 suites ran in full; missing: protocol refusals");
      expect(out.indexOf(`── ${LABELS} ──`)).toBeGreaterThan(at); // suites keep their order
      for (const l of out) expect(displayWidth(l), l).toBeLessThanOrEqual(100);
    });

    // C-T14d (N3): R7_FILES ties a file that failed to load back to its suite by path. A renamed file would silently turn
    // that off (the partial marker would still fire), so each path must be a real file that records lines for its suite.
    it("R7_FILES names the real test file of each suite, and that file records lines for it", () => {
      expect(Object.keys(R7_FILES).sort()).toEqual([...SUITES].sort());
      for (const suite of SUITES) {
        const file = join(REPO, R7_FILES[suite]);
        expect(existsSync(file), `${suite}: ${R7_FILES[suite]}`).toBe(true);
        const text = readFileSync(file, "utf8");
        expect(text, `${R7_FILES[suite]} records ${suite}`).toMatch(/replayLine\(/);
        expect(text, `${R7_FILES[suite]} names its suite`).toContain(`"${suite}"`);
      }
    });

    it("a run in which only the one file failed to load still prints the block, with 0 of 3", () => {
      const out = output([], [fakeModule(R7_FILES[LABELS], ["boom"])]);
      // 118 columns, so the marker wraps; read back it is the one sentence.
      expect(`${out[0]} ${out[1].trim()}`).toBe("partial: 0 of 3 R7 suites ran in full; missing: protocol refusals, classifier labels (recorded dry-runs), key hygiene");
      expect(out).toContain("FAIL: classifier labels (recorded dry-runs) did not load (boom)");
      expect(out).toContain("0/6");
    });

    it("keeps the reason short (at most 100 columns for the whole line) and neutralizes it", () => {
      const out = output([], [fakeModule(R7_FILES[LABELS], [`bad \u001b]0;pwned\u0007 ${"x".repeat(300)}\nsecond line`])]);
      const fail = out.find((l) => l.startsWith("FAIL: classifier"))!;
      expect(displayWidth(fail)).toBeLessThanOrEqual(100);
      expect(fail.endsWith("…)")).toBe(true);
      expect(out.join("\n")).not.toMatch(/[\u001b\u0007]/);
    });

    it("ignores a module that is not an R7 file, and a module error in a suite that did print rows", () => {
      expect(output([], [fakeModule("test/amounts.test.ts", ["syntax error"])])).toEqual([]);
      const out = output(wholeRun(), [fakeModule(R7_FILES[REFUSALS], ["afterAll hook failed"])]);
      expect(out.some((l) => l.includes("did not load"))).toBe(false);
    });
  });

  it("is registered in vitest.config.ts ahead of the default reporter, which keeps the normal summary", () => {
    expect(config.test?.reporters).toEqual(["./test/reporters/replay-reporter.ts", "default"]);
  });
});
