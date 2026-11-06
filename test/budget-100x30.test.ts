/**
 * Task 8: the 100x30 recording budget (DESIGN_BRIEF §5.3). Beat 3 (the four hero refusals and the chain
 * check) must fit one 100x30 terminal at once: at most 29 rows of at most 100 cells, styled and plain.
 * Measured over the real fixture runs, never a stand-in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DemoRun, DemoStep, ScopedKey } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { createStepPrinter } from "../src/render/demo-log.js";
import { CAPTION, passChainCheck, passRefused } from "../src/render/strings.js";
import type { TermCaps } from "../src/render/term.js";
import { displayWidth, stripAnsi } from "../src/render/style.js";
import { COMPAT_FIXTURES, REPO, SANDBOX_FIXTURES, color100, plain100, readFixture, sampleSession } from "./helpers.js";

const run = await loadDemoRunFixture(SANDBOX_FIXTURES);
const compat = await loadDemoRunFixture(COMPAT_FIXTURES);

function keyFrom(dir: string, file: string): ScopedKey {
  const r = JSON.parse(readFixture(dir, file)).result;
  const fc = r.permission.FunctionCall;
  return { publicKey: sampleSession().publicKey, accountId: "seat.sandbox", receiverId: fc.receiver_id, methodNames: fc.method_names, allowanceRemainingYocto: fc.allowance, nonce: r.nonce };
}

/** Beat 3: the four hero refusals plus a chain-check step built from the capture's key reads before and after. */
function renderBeat3(of: DemoRun, dir: string, caps: TermCaps, testnetSized = false): string {
  let refusals = of.steps.filter((s) => s.phase === "refusals").slice(0, 4);
  expect(refusals).toHaveLength(4);
  if (testnetSized) {
    // Testnet ids and nonces are longer than the sandbox's: a 26-character receiver, a 15-digit nonce.
    refusals = refusals.map((s) => (s.attempt!.violates === "receiver" ? { ...s, attempt: { ...s.attempt!, receiverId: "kh-9z8y.sputnik-v2.testnet" } } : s));
  }
  const check: DemoStep = {
    n: refusals[3].n + 1,
    total: refusals[3].total,
    phase: "chain-check",
    label: "CHAIN CHECK",
    signer: "none",
    pass: true,
    chainCheck: { before: keyFrom(dir, "050-g-key-before.json"), after: keyFrom(dir, "066-g-key-after.json") },
  };
  if (testnetSized) {
    check.chainCheck = { before: { ...check.chainCheck!.before, nonce: 171403842000003 }, after: { ...check.chainCheck!.after, nonce: 171403842000003 } };
  }
  const printer = createStepPrinter({ caps, style: "beat", network: "sandbox", mode: "live" });
  return [...refusals, check].map((s) => printer.step(s)).join("\n");
}

const uncolored: TermCaps = { ...color100, color: false };

describe("beat 3 fits 100x30", () => {
  for (const [name, of, dir] of [
    ["the sandbox capture", run, SANDBOX_FIXTURES],
    ["the compat capture (sputnikv2.testnet default DAO code)", compat, COMPAT_FIXTURES],
  ] as const) {
    describe(name, () => {
      for (const [mode, caps] of [["styled (FORCE_COLOR, unicode)", color100], ["plain", plain100]] as const) {
        it(`${mode}: at most 29 rows of at most 100 cells`, () => {
          const lines = renderBeat3(of, dir, caps).split("\n");
          expect(lines.length).toBeLessThanOrEqual(29);
          expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100);
        });
      }

      it("shows the whole hero block: header, four groups, caption, witness, verdict", () => {
        const lines = stripAnsi(renderBeat3(of, dir, color100)).split("\n");
        expect(lines[0]).toMatch(/^── 3\/5 ASSUME THE INJECTION WORKS · 4 attempts via keyhole_attempt ─+ \[LIVE\] ──$/);
        expect(displayWidth(lines[0])).toBe(98);
        const verdicts = lines.filter((l) => l.startsWith("PASS: refused by protocol"));
        expect(verdicts.map((l) => l.replace(/ +breaks .*$/, ""))).toEqual(
          ["MethodNameMismatch", "RequiresFullAccess", "ReceiverMismatch", "DepositWithFunctionCall"].map(passRefused),
        );
        expect(lines.slice(-3)[0]).toBe(`4/4 ${CAPTION}`);
        expect(lines.at(-1)).toBe(passChainCheck(4));
        // groups are separated by exactly one blank line, and nothing else is blank
        expect(lines.filter((l) => l === "")).toHaveLength(4);
      });

      it("every group's body rows join to its fixture bytes (nothing elided to make it fit)", () => {
        const text = stripAnsi(renderBeat3(of, dir, color100)).split("\n");
        const refusals = of.steps.filter((s) => s.phase === "refusals").slice(0, 4);
        const groups = text
          .join("\n")
          .split("\n\n")
          .slice(0, 4)
          .map((g) =>
            g
              .split("\n")
              .filter((l) => l.startsWith("    "))
              .map((l) => l.slice(4))
              .join(""),
          );
        expect(groups).toEqual(refusals.map((s) => s.attempt!.outcome.rawRpcJson));
      });

      it("the styled block strips to the plain block (same unicode setting)", () => {
        expect(stripAnsi(renderBeat3(of, dir, color100))).toBe(renderBeat3(of, dir, uncolored));
      });
    });
  }

  it("testnet-sized ids and nonces still fit: the witness line breaks in two, the block stays within 29 rows", () => {
    for (const caps of [color100, plain100]) {
      const lines = renderBeat3(run, SANDBOX_FIXTURES, caps, true).split("\n");
      expect(lines.length).toBeLessThanOrEqual(29);
      expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100);
      expect(stripAnsi(lines.join("\n"))).toContain("nonce 171403842000003");
    }
  });

  it("the blank lines between groups are the only slack: dropping them leaves room to spare", () => {
    const lines = renderBeat3(run, SANDBOX_FIXTURES, plain100).split("\n");
    const withoutBlanks = lines.filter((l) => l !== "");
    expect(withoutBlanks.length).toBeLessThan(lines.length);
    expect(withoutBlanks.length).toBeLessThanOrEqual(25);
  });
});

/**
 * C-T16a (Task 21): on real testnet ids the WRAP step's compact card key line was 112 cells in the beat style and 113
 * in the full one (`key PUBKEY on seat.kh-op-021e.testnet → kh-2c19.sputnik-v2.testnet`), so it wrapped in Take C's
 * 100x30 recording. It now breaks before ` on ` and hangs the rest at 8 columns. Measured over Task 16's committed
 * testnet evidence (demo/run.testnet.json and the demo/fixtures/testnet.* bodies its refusal steps carry), never a
 * stand-in; nothing here edits those files.
 */
describe("C-T16a: every step of the testnet run fits 100 columns, the WRAP card's key line included", () => {
  const testnet = JSON.parse(readFileSync(join(REPO, "demo", "run.testnet.json"), "utf8")) as DemoRun;
  const wrapStep = testnet.steps.find((s) => s.phase === "wrap")!;
  const STYLES = [["beat (the TTY: FORCE_COLOR, unicode)", "beat", color100], ["full (piped)", "full", plain100]] as const;
  const stepLines = (style: "beat" | "full", caps: TermCaps, s: DemoStep): string[] =>
    createStepPrinter({ caps, style, network: "testnet", mode: "live" }).step(s).split("\n");

  it("the run's refusal steps carry the committed testnet fixtures byte for byte", () => {
    const named = testnet.steps.filter((s) => s.fixture?.startsWith("testnet."));
    expect(named).toHaveLength(5);
    for (const s of named) expect(s.attempt!.outcome.rawRpcJson, s.fixture).toBe(readFileSync(join(REPO, "demo", "fixtures", s.fixture!), "utf8"));
  });

  for (const [name, style, caps] of STYLES) {
    it(`${name}: no row of any step is wider than 100 cells`, () => {
      const printer = createStepPrinter({ caps, style, network: "testnet", mode: "live" });
      for (const s of testnet.steps) {
        const widest = Math.max(...printer.step(s).split("\n").map(displayWidth));
        expect(widest, `[${s.n}] ${s.phase}`).toBeLessThanOrEqual(100);
      }
    });
  }

  it("the key line breaks at ` on `: the public key whole on the first row, ` on ACCOUNT → RECEIVER` hung at 8 columns", () => {
    const { publicKey, accountId, receiverId } = wrapStep.card!.session;
    expect(`key ${publicKey} on ${accountId} → ${receiverId}`).toHaveLength(112); // the line T16 measured, before the break
    for (const [, style, caps] of STYLES) {
      const arrow = caps.unicode ? "→" : "->";
      const lines = stripAnsi(stepLines(style, caps, wrapStep).join("\n")).split("\n");
      const at = lines.indexOf(`key ${publicKey}`);
      expect(at, style).toBeGreaterThan(0);
      expect(lines[at + 1]).toBe(`        on ${accountId} ${arrow} ${receiverId}`);
      expect(lines.slice(at + 2, at + 5).map((l) => l.split(" ")[0])).toEqual(["may", "gas", "code_hash"]);
    }
  });

  it("a key line that fits stays one line: the sandbox run's WRAP card (87 cells) is unchanged", () => {
    const sandbox = JSON.parse(readFileSync(join(REPO, "demo", "run.sandbox.json"), "utf8")) as DemoRun;
    const s = sandbox.steps.find((x) => x.phase === "wrap")!;
    const { publicKey, accountId, receiverId } = s.card!.session;
    const lines = stripAnsi(createStepPrinter({ caps: color100, style: "beat", network: "sandbox", mode: "live" }).step(s)).split("\n");
    expect(lines).toContain(`key ${publicKey} on ${accountId} → ${receiverId}`);
    expect(lines.some((l) => l.startsWith("        on "))).toBe(false);
  });
});
