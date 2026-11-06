/**
 * The R7 REPLAY reporter (Task 14; LAYOUT R7). It runs next to vitest's own `default` reporter and adds one
 * block to `npm test`, printed once at the end of the run, just before vitest's summary:
 *
 *   1. the REPLAY banner, `replayBanner(N, logs)`, N being the size of the union of the fixture files the lines rest
 *      on, and `logs` the capture log of each network those files name (captureLogs: `testnet.…` files come from
 *      the testnet run, logged in demo/transcript.md; `sandbox.…` files from `npm run capture:sandbox`, whose
 *      --driver run logs to demo/capture.sandbox.md; its --classifier dry-runs print to the console, no file, so
 *      when the lines rest on any of them the banner names that command too, C-T16b, and wraps before it, never
 *      inside it);
 *   2. the three suites in order, each under its name: "protocol refusals", "classifier labels (recorded
 *      dry-runs)", "key hygiene". A suite prints the lines its tests recorded with `replayLine`
 *      (test/replay-meta.ts), in the order the tests ran;
 *   3. `K/6` at the end of the classifier suite, K being the number of passing tests that recorded a line there;
 *   4. `FAIL: <test name>` for a failed case of any of the three suites, in place of its line;
 *   5. no line over 100 columns (the locked banner is longer, so it wraps at a space; the PASS string never does);
 *   6. an honest block (fix round 1): when any of the three suites did not run in full (a filtered run such as
 *      `vitest run test/r7-replay.test.ts` or `-t`, or a suite whose tests were skipped), the first line says
 *      `partial: K of 3 R7 suites ran in full; missing: …`, so a partial block cannot pass for the whole;
 *      and a suite whose test file failed to load (a missing manifest.json rejects its top-level await) prints
 *      `FAIL: <suite> did not load (<reason>)` under its heading. A suite never silently vanishes.
 *
 * Nothing is printed when no test recorded a line and no R7 file failed to load (a run of other files), and
 * nothing is read from a test but what vitest hands the reporter: `testCase.meta()` (set by `replayLine` on the
 * test's own task), `result().state`, `options.mode`, the name, the parent suites, and each module's
 * `relativeModuleId` and `errors()`. Every printed line goes through neutralizeControls.
 *
 * Registered in vitest.config.ts as `reporters: ["./test/reporters/replay-reporter.ts", "default"]`.
 */
import type { Reporter, TestCase, TestModule, Vitest } from "vitest/node";
import type { Network } from "../../src/core/types.js";
import { transcriptRelPath } from "../../src/demo/artifacts.js";
import { CAPTURE_CLASSIFIER, replayBanner } from "../../src/render/strings.js";
import { displayWidth, neutralizeControls, wrapVerbatim } from "../../src/render/style.js";
import type { ReplaySuite } from "../replay-meta.js";

/** The suites, in the order they print. */
export const SUITES: readonly ReplaySuite[] = ["protocol refusals", "classifier labels (recorded dry-runs)", "key hygiene"];
/** The test file that records each suite's lines: how a file that failed to load is tied back to its suite. */
export const R7_FILES: Readonly<Record<ReplaySuite, string>> = {
  "protocol refusals": "test/r7-replay.test.ts",
  "classifier labels (recorded dry-runs)": "test/label.test.ts",
  "key hygiene": "test/key-hygiene.test.ts",
};
/** PRD §6: the classifier suite asserts 6 expected labels. */
export const CLASSIFIER_LABELS = 6;
export const MAX_COLUMNS = 100;
/** A wrapped line continues under a two-space indent. */
const CONTINUATION = "  ";

interface Row {
  suite: ReplaySuite;
  /** The recorded line, or `FAIL: <test name>`. */
  text: string;
  failed: boolean;
  /** Fixture file names the line rests on. */
  files: readonly string[];
}

export interface ReplayReporterOptions {
  /** Where the block goes. Default: vitest's logger (so a live progress area is handled), else stdout. */
  write?: (text: string) => void;
}

/** Networks in the order the banner names their logs. */
const LOG_ORDER: readonly Network[] = ["testnet", "sandbox"];

/**
 * The capture log of each network that flat fixture names (`NETWORK.PACK.TEST.json`, GC 8) were recorded on, as
 * `[network, path]`, testnet first: a live run's log is its transcript (transcriptRelPath, the path writeRunArtifacts
 * writes it to). A name without a network prefix names no log.
 */
export function captureLogs(files: Iterable<string>): Array<readonly [Network, string]> {
  const seen = new Set<string>();
  for (const file of files) seen.add(/^(sandbox|testnet)\./.exec(file)?.[1] ?? "");
  return LOG_ORDER.filter((network) => seen.has(network)).map((network) => [network, transcriptRelPath(network)] as const);
}

/** True when some of the files are the classifier's recorded dry-runs (`sandbox.PACK[.zero-bond-]dryrun-….json`), which `capture:sandbox --classifier` records and no log file holds (C-T16b). */
export const hasDryRuns = (files: Iterable<string>): boolean => [...files].some((file) => /^sandbox\.[^.]+\.(?:[a-z0-9-]*-)?dryrun-.+\.json$/.test(file));

/** `FAIL: <name>`; a name that already says FAIL (a missing fixture's note) is not prefixed twice. */
const failLine = (name: string): string => (name.startsWith("FAIL") ? name : `FAIL: ${name}`);

/**
 * The first line of an error message, on one line, with the working directory dropped and cut to `max` cells
 * (`ENOENT: no such file: 'demo/fixtures/manifest.json'`, from node's `no such file or directory, open '…'`).
 * Neutralized like every printed line.
 */
export function shortReason(message: unknown, max: number): string {
  const first = String(message ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
  const plain = first.replaceAll(`${process.cwd()}/`, "").replace(/no such file or directory, \w+ /, "no such file: ").replace(/\s+/g, " ").trim();
  const text = neutralizeControls(plain);
  return displayWidth(text) <= max ? text : `${wrapVerbatim(text, Math.max(1, max - 1))[0]}…`;
}

/** The suite a case belongs to: the one it recorded its line for, else the R7 suite it sits in. */
function suiteOf(testCase: TestCase): ReplaySuite | undefined {
  const recorded = testCase.meta().replay;
  if (recorded) return recorded.suite;
  for (let p: TestCase["parent"] | undefined = testCase.parent; p?.type === "suite"; p = p.parent) {
    const hit = SUITES.find((name) => name === p?.name);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * `text` as rows of at most MAX_COLUMNS cells: cut at the last space that fits, continuation rows indented;
 * a word wider than a row is cut where the width runs out. A line that fits is returned as it is.
 * `keepWhole`: a string that is never cut by a break (a command someone will copy): where the cut would fall inside one
 * the row ends at the space before it instead, so it starts the next row (C-T16b, m-1). One that begins a row and is
 * still wider than the row is cut like any word.
 */
export function wrapLine(text: string, keepWhole: readonly string[] = []): string[] {
  const rows: string[] = [];
  let rest = neutralizeControls(text);
  let lead = "";
  while (displayWidth(lead + rest) > MAX_COLUMNS) {
    const head = wrapVerbatim(rest, MAX_COLUMNS - displayWidth(lead))[0];
    const space = head.lastIndexOf(" ");
    let cut = space > 0 ? space : head.length;
    for (const keep of keepWhole) {
      for (let at = rest.indexOf(keep); keep !== "" && at !== -1; at = rest.indexOf(keep, at + 1)) {
        const before = rest.lastIndexOf(" ", at - 1);
        if (at < cut && cut < at + keep.length && before > 0) cut = before;
      }
    }
    const take = rest.slice(0, cut);
    rows.push(lead + take);
    rest = rest.slice(take.length).replace(/^ +/, "");
    lead = CONTINUATION;
  }
  rows.push(lead + rest);
  return rows;
}

export default class ReplayReporter implements Reporter {
  private readonly rows = new Map<string, Row>();
  /** Skipped cases (not todo) of the R7 suites, by test id: a suite with any did not run in full. */
  private readonly skipped = new Map<string, ReplaySuite>();
  private logger: Vitest["logger"] | undefined;

  constructor(private readonly options: ReplayReporterOptions = {}) {}

  onInit(vitest: Vitest): void {
    this.logger = vitest.logger;
  }

  onTestRunStart(): void {
    this.rows.clear();
    this.skipped.clear();
  }

  /** Called when a test and its hooks are done. Keyed by the test's id, so a rerun replaces its row. */
  onTestCaseResult(testCase: TestCase): void {
    const state = testCase.result().state;
    const suite = suiteOf(testCase);
    if (!suite) return;
    if (state === "skipped") {
      if (testCase.options?.mode !== "todo") this.skipped.set(testCase.id, suite);
      return;
    }
    if (state !== "passed" && state !== "failed") return;
    const recorded = testCase.meta().replay;
    if (state === "failed") {
      this.rows.set(testCase.id, { suite, text: failLine(testCase.name), failed: true, files: recorded?.files ?? [] });
    } else if (recorded) {
      this.rows.set(testCase.id, { suite, text: recorded.line, failed: false, files: recorded.files });
    }
  }

  /** `testModules` are the files of the run, including one that failed to load (state failed, errors, no tests). */
  onTestRunEnd(testModules: ReadonlyArray<TestModule> = []): void {
    const rows = [...this.rows.values()];
    // A suite's file that failed to load has no rows; its error is the only thing the run can say about it.
    const didNotLoad = new Map<ReplaySuite, string>();
    for (const m of testModules) {
      const suite = SUITES.find((name) => m.relativeModuleId.endsWith(R7_FILES[name]));
      const errors = m.errors();
      if (suite && errors.length > 0 && !rows.some((r) => r.suite === suite)) didNotLoad.set(suite, String(errors[0]?.message ?? ""));
    }
    if (rows.length === 0 && didNotLoad.size === 0) return;

    const skipped = new Set(this.skipped.values());
    const notInFull = SUITES.filter((name) => !rows.some((r) => r.suite === name) || skipped.has(name));
    const files = new Set(rows.flatMap((r) => r.files));
    const lines: string[] = [];
    if (notInFull.length > 0) {
      lines.push(...wrapLine(`partial: ${SUITES.length - notInFull.length} of ${SUITES.length} R7 suites ran in full; missing: ${notInFull.join(", ")}`));
    }
    lines.push(...wrapLine(replayBanner(files.size, captureLogs(files), hasDryRuns(files)), [CAPTURE_CLASSIFIER])); // the command it names stays on one row (m-1)
    for (const suite of SUITES) {
      const mine = rows.filter((r) => r.suite === suite);
      const gone = didNotLoad.get(suite);
      if (mine.length === 0 && gone === undefined) continue;
      lines.push(...wrapLine(`── ${suite} ──`), ...mine.flatMap((r) => wrapLine(r.text)));
      if (gone !== undefined) {
        const prefix = `FAIL: ${suite} did not load (`;
        lines.push(...wrapLine(`${prefix}${shortReason(gone, MAX_COLUMNS - displayWidth(prefix) - 1)})`));
      }
      if (suite === SUITES[1]) lines.push(`${mine.filter((r) => !r.failed).length}/${CLASSIFIER_LABELS}`);
    }
    const text = lines.join("\n");
    if (this.options.write) this.options.write(text);
    else if (this.logger) this.logger.log(text);
    else process.stdout.write(`${text}\n`);
  }
}
