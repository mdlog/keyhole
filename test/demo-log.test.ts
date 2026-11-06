/**
 * Task 8: the R4 step log (createStepPrinter) and the run transcript (renderTranscript).
 *
 * Expected strings are written out by hand from the brief, LAYOUT R4 and DESIGN §5.3, never computed with
 * the code under test. The run is the committed spike capture (demo/fixtures/sandbox).
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRefusal } from "../src/core/refusal.js";
import type { AttemptOutcome, DemoRun, DemoStep, ScopedKey } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { renderCageCard } from "../src/render/cage-card.js";
import { createStepPrinter, resultLines as resultRows, runStopped } from "../src/render/demo-log.js";
import {
  BEATS,
  CAPTION,
  NOTE_IN_SCOPE,
  NOTE_SIGNER_GONE,
  PASS_IN_SCOPE,
  PASS_KEY_GONE,
  PASS_RUNTIME,
  SIX_OF_EIGHT,
  failChainCheck,
  failExpected,
  passChainCheck,
  passRefused,
} from "../src/render/strings.js";
import { termCaps } from "../src/render/term.js";
import type { TermCaps } from "../src/render/term.js";
import { renderTranscript } from "../src/render/transcript.js";
import { displayWidth, stripAnsi } from "../src/render/style.js";
import { SANDBOX_FIXTURES, color100, plain100, readFixture, sampleCageCard, sampleSession } from "./helpers.js";

const run: DemoRun = await loadDemoRunFixture(SANDBOX_FIXTURES);
const refusalSteps = run.steps.filter((s) => s.attempt?.outcome.kind === "Refusal");
const hero = run.steps.filter((s) => s.phase === "refusals").slice(0, 4);
const ESC = "\x1b";
const uncolored: TermCaps = { ...color100, color: false };

function keyFrom(file: string): ScopedKey {
  const r = JSON.parse(readFixture(SANDBOX_FIXTURES, file)).result;
  const fc = r.permission.FunctionCall;
  return { publicKey: sampleSession().publicKey, accountId: "seat.sandbox", receiverId: fc.receiver_id, methodNames: fc.method_names, allowanceRemainingYocto: fc.allowance, nonce: r.nonce };
}
const before = keyFrom("050-g-key-before.json"); // nonce 51000003, allowance 49218482625579400000000
const after = keyFrom("066-g-key-after.json");

const synthetic = (patch: Partial<DemoStep>): DemoStep => ({ n: 1, total: 14, phase: "setup", label: "step", signer: "operator", pass: true, ...patch });
const chainStep = (chainCheck: DemoStep["chainCheck"] = { before, after }, patch: Partial<DemoStep> = {}): DemoStep =>
  synthetic({ n: 9, total: 16, phase: "chain-check", label: "CHAIN CHECK", signer: "none", chainCheck, ...patch });

type Opts = { caps?: TermCaps; style?: "full" | "beat"; mode?: "live" | "replay"; network?: "sandbox" | "testnet" };
function printer(o: Opts = {}) {
  return createStepPrinter({ caps: o.caps ?? plain100, style: o.style ?? "full", network: o.network ?? "sandbox", mode: o.mode ?? "replay" });
}
/** Every step through one printer, as the CLI prints them: one chunk per call, joined by newlines. */
function print(steps: readonly DemoStep[], o: Opts = {}): string {
  const p = printer(o);
  return steps.map((s) => p.step(s)).join("\n");
}

/** A refusal step with the body replaced (parsed by the live path's parser). */
function withBody(s: DemoStep, body: string): DemoStep {
  const outcome = parseRefusal(body);
  expect(outcome).not.toBeNull();
  return { ...s, attempt: { ...s.attempt!, outcome: outcome! } };
}
const invalidNonce = (id: string): string =>
  `{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"tx_nonce":5,"ak_nonce":9}}}}},"id":"${id}"}`;

function expectBalanced(text: string): void {
  const ON = new Set(["1", "2", "4", "7", "1;30;42", "1;97;41", "1;30;43"]);
  for (const row of text.split("\n")) {
    let depth = 0;
    for (const m of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
      depth += ON.has(m[1]) ? 1 : -1;
      expect(depth, `nested or unopened SGR in ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(0);
      expect(depth, `nested SGR in ${JSON.stringify(row)}`).toBeLessThanOrEqual(1);
    }
    expect(depth, `SGR left open in ${JSON.stringify(row)}`).toBe(0);
  }
}

/** Computed on first use, inside a test, so an unbuilt printer fails the test and not the file. */
const lazy = <T>(f: () => T): (() => T) => {
  let cached: { v: T } | undefined;
  return () => (cached ??= { v: f() }).v;
};

const headerLines = (text: string): string[] => text.split("\n").filter((l) => /^-- .* -+ \[(LIVE|REPLAY)\] --$/.test(l));

describe("beat headers", () => {
  it("appear once per phase change, in BEATS order; the chain check stays in beat 3", () => {
    const card = sampleCageCard();
    const steps: DemoStep[] = [
      synthetic({ n: 1, phase: "setup", label: "create the DAO" }),
      synthetic({ n: 2, phase: "setup", label: "create proposals" }),
      synthetic({ n: 3, phase: "wrap", label: "AddKey", card }),
      run.steps[0],
      run.steps[1],
      ...hero,
      chainStep(),
      synthetic({ n: 10, phase: "inspect", label: "cage card", card }),
      run.steps.find((s) => s.phase === "burn")!,
      run.steps.find((s) => s.phase === "smoke")!,
    ];
    const text = print(steps);
    const titles = headerLines(text).map((l) => l.replace(/^-- /, "").replace(/ -+ \[REPLAY\] --$/, ""));
    expect(titles).toEqual([BEATS.setup, BEATS.wrap, BEATS["in-scope"], BEATS.refusals, BEATS.inspect, BEATS.burn, BEATS.smoke]);
  });

  it("is a 98-column rule with the tag on the right: [LIVE] live, [REPLAY] in replay", () => {
    const step = run.steps[0];
    const live = headerLines(print([step], { mode: "live" }));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatch(/^-- 2\/5 IN SCOPE · the key votes; the quorum decides -{3,} \[LIVE\] --$/);
    expect(displayWidth(live[0])).toBe(98);
    const replay = headerLines(print([step], { mode: "replay" }));
    expect(replay[0]).toMatch(/ -{3,} \[REPLAY\] --$/);
    expect(displayWidth(replay[0])).toBe(98);
    const wow = headerLines(print([hero[0]], { mode: "live" }))[0];
    expect(wow).toMatch(/^-- 3\/5 ASSUME THE INJECTION WORKS · 4 attempts via keyhole_attempt -{3,} \[LIVE\] --$/);
    expect(displayWidth(wow)).toBe(98);
  });

  it("uses box glyphs with unicode caps and styles the whole rule bold", () => {
    const text = print([hero[0]], { caps: color100, style: "beat", mode: "live" });
    const header = text.split("\n")[0];
    expect(header).toBe(`\x1b[1m── ${BEATS.refusals} ${"─".repeat(98 - 3 - BEATS.refusals.length - 1 - 10)} [LIVE] ──\x1b[22m`);
    expect(displayWidth(header)).toBe(98);
  });

  it("the first call has no leading blank line; later calls start with one (one blank between blocks)", () => {
    const p = printer();
    const first = p.step(hero[0]);
    expect(first.startsWith("\n")).toBe(false);
    const second = p.step(hero[1]);
    expect(second.startsWith("\n[05/16] ATTEMPT")).toBe(true);
    expect(second).not.toMatch(/^\n\n/);
  });
});

describe("the staircase (full style only)", () => {
  const staircase = lazy(() => {
    const lines = print([...hero, chainStep()]).split("\n");
    return { lines, at: lines.findIndex((l) => l.startsWith("-- REFUSALS")) };
  });

  it("prints immediately before the chain check: banner, columns, one row per refusal", () => {
    const { lines, at } = staircase();
    expect(at).toBeGreaterThan(0);
    const head = `-- REFUSALS 4/4 - ${CAPTION} `;
    expect(lines[at]).toBe(head + "-".repeat(98 - head.length));
    expect(lines.slice(at + 1, at + 6)).toEqual([
      "   step  rule broken — one per test, fixed slot order                  parsed from RPC body",
      "   [04]  [METHOD]     action      receiver    deposit     allowance    MethodNameMismatch",
      "   [05]   method     [ACTION]     receiver    deposit     allowance    RequiresFullAccess",
      "   [06]   method      action     [RECEIVER]   deposit     allowance    ReceiverMismatch",
      "   [07]   method      action      receiver   [DEPOSIT]    allowance    DepositWithFunctionCall",
    ]);
    expect(lines[at + 6]).toBe("");
    expect(lines[at + 7]).toBe("[09/16] CHAIN CHECK  view_access_key read before [04] and after [07]");
  });

  it("the bracket moves one slot right per row and no row repeats the PASS string", () => {
    const { lines, at } = staircase();
    const rows = lines.slice(at + 2, at + 6);
    expect(rows.map((r) => r.indexOf("[", 9))).toEqual([9, 21, 33, 45]);
    expect(rows.every((r) => !r.includes("PASS"))).toBe(true);
    expect(lines.slice(at, at + 6).join("\n")).not.toContain("refused by protocol");
  });

  it("is printed once, before the first chain check only", () => {
    const twice = print([...hero, chainStep(), chainStep()]);
    expect(twice.split("\n").filter((l) => l.startsWith("-- REFUSALS"))).toHaveLength(1);
  });

  it("the beat style has none (the 100x30 budget has no row for it)", () => {
    const beat = print([...hero, chainStep()], { style: "beat" });
    expect(beat).not.toContain("REFUSALS");
    expect(beat).not.toContain("rule broken");
  });

  it("drops the step column at 80 columns and shrinks the slots to 11", () => {
    const narrow = print([...hero, chainStep()], { caps: { ...plain100, width: 80 } }).split("\n");
    const i = narrow.findIndex((l) => l.startsWith("-- REFUSALS"));
    expect(narrow[i + 1]).toMatch(/^ {3}rule broken — one per test, fixed slot order +parsed from RPC body$/);
    expect(narrow[i + 2]).toMatch(/^ {3}\[METHOD\] {4}action {5}receiver {3}deposit {4}allowance {2,}MethodNameMismatch$/);
    expect(narrow[i + 3]).toMatch(/^ {4}method {4}\[ACTION\] {4}receiver/);
  });

  it("below 80 columns the staircase is key: value rows with no strip", () => {
    const lines = print([...hero, chainStep()], { caps: { ...plain100, width: 60 } }).split("\n");
    const i = lines.findIndex((l) => l.startsWith("-- REFUSALS"));
    expect(lines.slice(i + 1, i + 5)).toEqual([
      "   [04] METHOD: MethodNameMismatch",
      "   [05] ACTION: RequiresFullAccess",
      "   [06] RECEIVER: ReceiverMismatch",
      "   [07] DEPOSIT: DepositWithFunctionCall",
    ]);
  });

  it("colored: the broken slot is bold and the parsed name is inverse; strips to the plain rows", () => {
    const colored = print([...hero, chainStep()], { caps: color100 });
    expect(colored).toContain("\x1b[1m[METHOD]\x1b[22m");
    expect(colored).toContain("\x1b[7mMethodNameMismatch\x1b[27m");
    expect(stripAnsi(colored)).toBe(print([...hero, chainStep()], { caps: uncolored }));
    expectBalanced(colored);
  });
});

describe("the chain check", () => {
  it("full: prints passChainCheck(4) when nonce and allowance match", () => {
    const lines = print([...hero, chainStep()]).split("\n");
    const i = lines.findIndex((l) => l.startsWith("[09/16] CHAIN CHECK"));
    expect(lines.slice(i)).toEqual([
      "[09/16] CHAIN CHECK  view_access_key read before [04] and after [07]",
      "        nonce 51000003 -> 51000003 · allowance left 0.0492 -> 0.0492 NEAR",
      `        ${passChainCheck(4)}`,
    ]);
    expect(passChainCheck(4)).toBe("PASS: key state unchanged by 4 refusals");
  });

  it("beat: 4/4 caption, the witness line, then the verdict", () => {
    const lines = print([...hero, chainStep()], { style: "beat", caps: uncolored }).split("\n");
    expect(lines.slice(-4)).toEqual([
      "",
      `4/4 ${CAPTION}`,
      "gas allowance 0.0492 NEAR before and after · nonce 51000003 → 51000003 (view_access_key, read twice)",
      passChainCheck(4),
    ]);
  });

  it("beat: the witness line breaks at its own separator when it would not fit the width", () => {
    // plain arrows are one cell wider: 101 cells at 8 digits
    const plain = print([...hero, chainStep()], { style: "beat" }).split("\n");
    expect(plain.slice(-5)).toEqual([
      "",
      `4/4 ${CAPTION}`,
      "gas allowance 0.0492 NEAR before and after",
      "nonce 51000003 -> 51000003 (view_access_key, read twice)",
      passChainCheck(4),
    ]);
    // testnet nonces are 15 digits: two rows with unicode arrows too
    const big = { ...before, nonce: 171403842000003 };
    const bigAfter = { ...after, nonce: 171403842000003 };
    const lines = print([...hero, chainStep({ before: big, after: bigAfter })], { style: "beat", caps: uncolored }).split("\n");
    expect(lines.slice(-4)).toEqual([
      `4/4 ${CAPTION}`,
      "gas allowance 0.0492 NEAR before and after",
      "nonce 171403842000003 → 171403842000003 (view_access_key, read twice)",
      passChainCheck(4),
    ]);
  });

  it("a moved nonce prints failChainCheck and no PASS (full and beat)", () => {
    const moved = chainStep({ before, after: { ...after, nonce: after.nonce + 1 } }, { pass: false });
    for (const style of ["full", "beat"] as const) {
      const text = print([...hero, moved], { style });
      expect(text).toContain(failChainCheck("nonce 51000003 -> 51000004"));
      expect(text).not.toContain("key state unchanged");
      expect(text).not.toContain("PASS: key state");
    }
  });

  it("a moved allowance prints failChainCheck naming both values, even when the step says pass", () => {
    const moved = chainStep({ before, after: { ...after, allowanceRemainingYocto: "30000000000000000000000" } });
    const text = print([...hero, moved]);
    expect(text).toContain(failChainCheck("allowance 0.0492 -> 0.0300 NEAR"));
    expect(text).not.toContain("key state unchanged");
    const both = print([...hero, chainStep({ before, after: { ...after, nonce: 1, allowanceRemainingYocto: null } })], { style: "beat" });
    expect(both).toContain(failChainCheck("nonce 51000003 -> 1, allowance 0.0492 NEAR -> NO CAP ON CHAIN"));
  });

  it("a step that fails for another reason does not read as a pass", () => {
    const text = print([...hero, chainStep({ before, after }, { pass: false, note: "FAIL: view_access_key could not be read twice" })]);
    expect(text).toContain("FAIL: view_access_key could not be read twice");
    expect(text).not.toContain("key state unchanged");
  });

  it("counts the refusals it measured", () => {
    expect(print([hero[0], hero[1], chainStep()])).toContain(passChainCheck(2));
    expect(print([hero[0], hero[1], chainStep()], { style: "beat" })).toContain(`2/2 ${CAPTION}`);
  });

  it("with no refusal attempt seen it claims no refusals: no PASS, no 4/4, a FAIL line instead", () => {
    for (const style of ["full", "beat"] as const) {
      const text = print([chainStep()], { style });
      expect(text).not.toContain("key state unchanged");
      expect(text).not.toContain("PASS: key state");
      expect(text).not.toContain("4/4");
      expect(text).not.toContain(CAPTION);
      expect(text).not.toContain("REFUSALS");
      expect(text).toContain("FAIL: no refusal attempt preceded the chain check");
      // what the two reads measured is still shown
      expect(text).toContain("nonce 51000003 -> 51000003");
    }
  });

  it("a hostile allowance string is printed as visible text, not thrown on", () => {
    const evil = "9\x1b[2J";
    const text = print([...hero, chainStep({ before: { ...before, allowanceRemainingYocto: evil }, after: { ...after, allowanceRemainingYocto: evil } })]);
    expect(text).not.toContain(ESC);
    expect(text).toContain("9\\u001b[2J");
  });
});

describe("counts the verdict lines", () => {
  it("grep -c 'PASS: refused by protocol' equals the number of refusal steps, in both styles", () => {
    expect(refusalSteps).toHaveLength(13);
    for (const style of ["full", "beat"] as const) {
      const text = print([...run.steps.slice(0, 9), chainStep(), ...run.steps.slice(9)], { style });
      expect(text.split("\n").filter((l) => l.includes("PASS: refused by protocol"))).toHaveLength(refusalSteps.length);
    }
  });

  it("holds in color too, because the phrase stays contiguous", () => {
    for (const style of ["full", "beat"] as const) {
      const text = print(run.steps, { style, caps: color100 });
      expect(text.split("\n").filter((l) => l.includes("PASS: refused by protocol"))).toHaveLength(refusalSteps.length);
    }
  });

  it("a failed refusal step prints no PASS line, so the count follows the passes", () => {
    const failed = { ...hero[1], pass: false, note: failExpected("MethodNameMismatch", "RequiresFullAccess") };
    const text = print([hero[0], failed, hero[2], hero[3]]);
    expect(text.split("\n").filter((l) => l.includes("PASS: refused by protocol"))).toHaveLength(3);
    expect(text).toContain(failExpected("MethodNameMismatch", "RequiresFullAccess"));
  });

  it("a failed refusal is not counted in the tally or in the chain check (3 of 4, unchanged by 3)", () => {
    const failed = { ...hero[1], pass: false, note: failExpected("MethodNameMismatch", "RequiresFullAccess") };
    const full = print([hero[0], failed, hero[2], hero[3], chainStep()]);
    expect(full).toContain("-- REFUSALS 3/4 - ");
    expect(full).toContain(passChainCheck(3));
    expect(full).not.toContain(passChainCheck(4));
    const beat = print([hero[0], failed, hero[2], hero[3], chainStep()], { style: "beat" });
    expect(beat).toContain(`3/4 ${CAPTION}`);
    expect(beat).toContain(passChainCheck(3));
    expect(beat).not.toContain("4/4");
  });

  it("piped output has no escape bytes", () => {
    const piped = termCaps({ isTTY: false }, {});
    for (const style of ["full", "beat"] as const) {
      const text = print([...run.steps, chainStep()], { style, caps: piped });
      expect(text).not.toContain(ESC);
    }
    const p = printer({ caps: piped });
    expect(p.result(run)).not.toContain(ESC);
  });

  it("colored output strips to the uncolored output byte for byte, for both styles", () => {
    const card = sampleCageCard();
    const steps = [synthetic({ phase: "wrap", card, txHash: "9xTqHq4nXjPnM2cEvJm1uYtT3rBuw5a4Hb1sVQq9Ka2" }), ...run.steps, chainStep()];
    for (const style of ["full", "beat"] as const) {
      const colored = print(steps, { style, caps: color100, network: "testnet" });
      expect(colored).toContain(ESC);
      expect(stripAnsi(colored)).toBe(print(steps, { style, caps: uncolored, network: "testnet" }));
      expectBalanced(colored.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""));
    }
  });
});

describe("the other steps", () => {
  it("an in-scope vote: label, tx line, PASS: in scope, landed, and the proposal status", () => {
    const vote = { ...run.steps[0], proposal: { id: 0, status: "InProgress", approvals: 1, required: 2 } };
    expect(print([vote]).split("\n").slice(1)).toEqual([
      "[01/16] approve #0 (grant payout)",
      "        tx 8bU9DAkEHc6PX4xErpeAA19tf1ZxKE1zzfLb98tJuD3D · final · sandbox (no explorer)",
      `        ${PASS_IN_SCOPE}`,
      "        proposal #0 InProgress (1 of 2)",
    ]);
    expect(PASS_IN_SCOPE).toBe("PASS: in scope, landed");
  });

  it("the wrong-but-in-scope vote carries its NOTE", () => {
    const text = print([run.steps[1]]);
    expect(text).toContain(`        ${NOTE_IN_SCOPE}`);
    expect(text).toContain("        PASS: in scope, landed");
  });

  it("the status word and the tx hash are inverse (NEAR's voice); the NOTE is bold", () => {
    const vote = { ...run.steps[1], proposal: { id: 1, status: "InProgress", approvals: 1, required: 2 } };
    const colored = print([vote], { caps: color100 });
    expect(colored).toContain("\x1b[7mInProgress\x1b[27m");
    expect(colored).toContain("\x1b[7m68rkUM5tHGME8wjeT9cP1PZei4LsZsfpHuRVjNUvmR9B\x1b[27m");
    expect(colored).toContain(`\x1b[1m${NOTE_IN_SCOPE}\x1b[22m`);
    expect(colored).toContain("\x1b[1;30;42mPASS: in scope, landed\x1b[22;39;49m");
    expectBalanced(colored);
  });

  it("a further tx hash of the same step gets its own tx line", () => {
    const two = synthetic({ phase: "setup", txHash: "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF", moreTxHashes: ["GGGG1111HHHH2222JJJJ3333KKKK4444LLLL5555MMMM"] });
    const lines = print([two]).split("\n");
    expect(lines.filter((l) => l.startsWith("        tx "))).toHaveLength(2);
  });

  it("the explorer line appears on testnet", () => {
    const text = print([run.steps[0]], { network: "testnet" });
    // C-T8b: 112 cells on one row, so at 100 columns the explorer URL takes the next row, after `· `.
    expect(text).toContain("        tx 8bU9...uD3D · final\n        · https://testnet.nearblocks.io/txns/8bU9DAkEHc6PX4xErpeAA19tf1ZxKE1zzfLb98tJuD3D");
    expect(print([run.steps[0]], { network: "testnet", caps: { ...plain100, width: 120 } })).toContain("        tx 8bU9...uD3D · final · https://testnet.nearblocks.io/txns/8bU9DAkEHc6PX4xErpeAA19tf1ZxKE1zzfLb98tJuD3D");
  });

  it("the wrap step prints the compact card and the inspect step the full card, flush left", () => {
    const card = sampleCageCard();
    const wrap = print([synthetic({ phase: "wrap", label: "AddKey FunctionCall", card })]);
    expect(wrap).toContain(renderCageCard(card, "compact", plain100));
    const inspect = print([synthetic({ phase: "inspect", label: "the cage card", card, signer: "none" })]);
    expect(inspect).toContain(renderCageCard(card, "full", plain100));
    expect(inspect.split("\n").filter((l) => l.startsWith("+")).length).toBeGreaterThanOrEqual(2);
  });

  it("a burned chain card adds PASS: no such key on chain", () => {
    const burned = sampleCageCard({ key: null });
    const text = print([synthetic({ phase: "burn", label: "DeleteKey", card: burned, txHash: "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF" })]);
    expect(text).toContain(`        ${PASS_KEY_GONE}`);
    expect(print([synthetic({ phase: "inspect", card: sampleCageCard() })])).not.toContain(PASS_KEY_GONE);
  });

  it("the contrast case: tx line, panic text, PASS_RUNTIME", () => {
    const panic = "Smart contract panicked: ERR_MIN_BOND";
    const s = synthetic({
      n: 17,
      total: 20,
      phase: "smoke",
      label: "reset without 1 yocto",
      signer: "session",
      txHash: "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF",
      attempt: { ...run.steps[0].attempt!, outcome: { kind: "ContractPanic", txHash: "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF", message: panic, rawRpcJson: "{}" } },
    });
    expect(print([s]).split("\n").slice(1)).toEqual([
      "[17/20] reset without 1 yocto",
      "        tx AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF · final · sandbox (no explorer)",
      `        panic    ${panic}`,
      // C-T12a: the locked verdict is 96 cells, so it outdents to 4 spaces (100 cells) and is never broken.
      `    ${PASS_RUNTIME}`,
    ]);
  });

  it("a step that failed prints its FAIL note (or a generic one) and no verdict of ours", () => {
    const text = print([run.steps[0], { ...synthetic({ phase: "wrap", label: "AddKey" }), pass: false, note: "FAIL: the key was not on chain" }]);
    expect(text).toContain("        FAIL: the key was not on chain");
    expect(print([{ ...synthetic({ phase: "wrap", label: "AddKey" }), pass: false }])).toContain("        FAIL: step did not pass");
  });

  it("hostile labels, hashes, status words, panic text and notes print as visible text", () => {
    const evil = "e\x1b[31m\rFAKE";
    const shown = "e\\u001b[31m\\u000dFAKE";
    const s = {
      ...run.steps[1],
      label: evil,
      txHash: evil,
      moreTxHashes: [evil],
      note: evil,
      proposal: { id: 1, status: evil, approvals: 1, required: 2 },
    };
    const panicStep = synthetic({ phase: "smoke", attempt: { ...run.steps[0].attempt!, outcome: { kind: "ContractPanic", txHash: "H", message: evil, rawRpcJson: "{}" } } });
    for (const caps of [plain100, color100]) {
      for (const style of ["full", "beat"] as const) {
        const text = print([s, panicStep], { caps, style });
        expect(stripAnsi(text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""))).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
        expect(stripAnsi(text)).toContain(`[02/16] ${shown}`);
        expect(stripAnsi(text)).toContain(`panic    ${shown}`);
        expect(stripAnsi(text)).toContain(`proposal #1 ${shown} (1 of 2)`);
        if (caps.color) expectBalanced(text);
      }
    }
  });

  it("a hostile error name reaches neither the staircase nor the RESULT counts as an escape", () => {
    const hostileBody = JSON.stringify({ jsonrpc: "2.0", error: { data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { "Evil\x1b[31m": {} } } } } }, id: "x" });
    const h = withBody(hero[0], hostileBody);
    for (const style of ["full", "beat"] as const) {
      const text = print([h, hero[1], hero[2], hero[3], chainStep()], { style, caps: color100 });
      expect(stripAnsi(text)).not.toContain(ESC);
      expect(stripAnsi(text)).toContain("Evil\\u001b[31m");
    }
  });
});

/** A refusals-phase step the replay loader emits when its fixture is missing or unparseable: no attempt, a FAIL note. */
const missingSlot = (n: number): DemoStep => ({
  n,
  total: 16,
  phase: "refusals",
  label: `slot ${n}`,
  signer: "session",
  pass: false,
  note: `FAIL: fixture missing /x/${n}.send_tx.json`,
  fixture: `${n}.send_tx.json`,
});

describe("refusal slots without evidence (the replay loader's missing-fixture steps)", () => {
  const four = [4, 5, 6, 7].map(missingSlot);
  const noneEarned = "FAIL: no attempt was refused by protocol before the chain check (0/4)";

  it("four missing slots, then a chain check: no PASS, and it reads 0/4 (beat)", () => {
    const text = print([...four, chainStep()], { style: "beat" });
    expect(text).toContain(`0/4 ${CAPTION}`);
    expect(text).toContain(noneEarned);
    expect(text).not.toContain("4/4");
    expect(text).not.toContain("key state unchanged");
    expect(text).not.toMatch(/PASS/);
    for (const s of four) expect(text).toContain(`[0${s.n}/16] slot ${s.n}\n        FAIL: fixture missing /x/${s.n}.send_tx.json`);
  });

  it("four missing slots (full): the staircase keeps every row, each with - and its FAIL, and reads 0/4", () => {
    const lines = print([...four, chainStep()]).split("\n");
    const at = lines.findIndex((l) => l.startsWith("-- REFUSALS"));
    expect(lines[at]).toMatch(/^-- REFUSALS 0\/4 - /);
    expect(lines.slice(at + 2, at + 6)).toEqual([4, 5, 6, 7].map((n) => `   [0${n}]   method      action      receiver    deposit     allowance    - FAIL: fixture missing /x/${n}.send_tx.json`));
    expect(lines.slice(at + 7)).toEqual([
      "[09/16] CHAIN CHECK  view_access_key read before [04] and after [07]",
      "        nonce 51000003 -> 51000003 · allowance left 0.0492 -> 0.0492 NEAR",
      `        ${noneEarned}`,
    ]);
  });

  it("the real loader's output: a capture with the four hero bodies deleted prints no PASS and reads 0/4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keyhole-t8-"));
    try {
      cpSync(SANDBOX_FIXTURES, dir, { recursive: true });
      for (const f of ["052-g1-method-add_proposal", "055-g2-transfer-1yocto-attacker", "058-g3-receiver-other-dao", "061-g4-deposit-1yocto"]) rmSync(join(dir, `${f}.send_tx.json`));
      const damaged = await loadDemoRunFixture(dir);
      const slots = damaged.steps.filter((s) => s.phase === "refusals");
      expect(slots.slice(0, 4).every((s) => s.attempt === undefined && !s.pass && s.note?.startsWith("FAIL: fixture missing"))).toBe(true);
      const check = chainStep();
      const at = damaged.steps.findIndex((s) => s.phase === "burn");
      const steps = [...damaged.steps.slice(0, at), check, ...damaged.steps.slice(at)];
      for (const style of ["full", "beat"] as const) {
        const text = print(steps, { style });
        expect(text).not.toContain(passChainCheck(4));
        expect(text).not.toContain("4/4");
        // the fifth slot (the transfer to the DAO itself) was not deleted, so exactly one refusal was earned, of five
        expect(text).toContain(passChainCheck(1));
        expect(text).toContain(style === "full" ? "-- REFUSALS 1/5 - " : `1/5 ${CAPTION}`);
      }
      const gone = print([...slots.slice(0, 4), check]);
      expect(gone).toContain("-- REFUSALS 0/4 - ");
      expect(gone).toContain("FAIL: no attempt was refused by protocol before the chain check (0/4)");
      expect(renderTranscript({ ...damaged, steps: [...slots.slice(0, 4), check] }, { rpc: "r", operator: "o", startedAt: "t" })).not.toContain("key state unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("one missing slot among earned ones still gets its row and stays in the denominator (3 of 4)", () => {
    const full = print([hero[0], hero[1], hero[2], missingSlot(7), chainStep()]);
    expect(full).toContain("-- REFUSALS 3/4 - ");
    expect(full).toContain("   [07]   method      action      receiver    deposit     allowance    - FAIL: fixture missing /x/7.send_tx.json");
    expect(full).toContain(passChainCheck(3));
    const beat = print([hero[0], hero[1], hero[2], missingSlot(7), chainStep()], { style: "beat" });
    expect(beat).toContain(`3/4 ${CAPTION}`);
    expect(beat).toContain(passChainCheck(3));
  });

  it("a slot with no attempt that nonetheless passed still has a row, saying so", () => {
    const text = print([hero[0], { ...missingSlot(5), pass: true, note: undefined }, chainStep()]);
    expect(text).toContain("-- REFUSALS 1/2 - ");
    expect(text).toContain("allowance    - no attempt recorded");
  });

  it("below 80 columns the slot row is key: value too", () => {
    const lines = print([...four, chainStep()], { caps: { ...plain100, width: 60 } }).split("\n");
    expect(lines).toContain("   [04] -: - FAIL: fixture missing /x/4.send_tx.json");
  });

  it("RESULT counts no protocol refusal for them", () => {
    const [line] = printer().result({ ...run, steps: four, exitCode: 1 }).split("\n").filter(Boolean);
    expect(line).toMatch(/^RESULT 0\/4 PASS · 4 FAIL · 0 protocol refusals · /);
  });
});

describe("a rejection that is not the key's scope (C-T2k)", () => {
  const rejected = withBody(hero[1], invalidNonce("x"));
  const steps = [hero[0], rejected, hero[2], hero[3]];

  it("is not counted in the staircase tally and its row names no rule", () => {
    const text = print([...steps, chainStep()]);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("-- REFUSALS"));
    expect(lines[at]).toMatch(/^-- REFUSALS 3\/4 - /);
    const row = lines.find((l) => l.startsWith("   [05]"))!;
    expect(row).toContain("chain rejected the tx: InvalidNonce");
    expect(row).not.toMatch(/\[[A-Z]+\]/);
    expect(row).toMatch(/^ {3}\[05\] {3}method {6}action {6}receiver {4}deposit {5}allowance {4}chain rejected the tx: InvalidNonce$/);
  });

  it("is not a protocol refusal in the chain check, the beat tally or the RESULT line", () => {
    expect(print([...steps, chainStep()])).toContain(passChainCheck(3));
    const beat = print([...steps, chainStep()], { style: "beat" });
    expect(beat).toContain(`3/4 ${CAPTION}`);
    expect(beat).toContain(passChainCheck(3));
    expect(beat.split("\n").filter((l) => l.includes("PASS: refused by protocol"))).toHaveLength(3);
    const p = printer();
    const result = p.result({ ...run, steps: [...steps] });
    expect(result).toContain(" · 3 protocol refusals · ");
  });

  it("says the chain rejected the tx and never that the scope refused it (full and beat)", () => {
    for (const style of ["full", "beat"] as const) {
      const text = print([rejected], { style });
      expect(text).toContain("chain rejected the tx: InvalidNonce");
      expect(text).not.toMatch(/refused by protocol|PASS|breaks/);
    }
  });
});

describe("RESULT", () => {
  const resultLines = (r: DemoRun, o: Opts = {}): string[] => printer(o).result(r).split("\n").filter((l) => l !== "");

  it("states the counts measured from the run, then the six-of-eight line on sandbox", () => {
    expect(resultLines(run)).toEqual([
      "RESULT 16/16 PASS · 13 protocol refusals · 3 tx hashes · 12s · exit 0 · transcript demo/transcript.sandbox.md",
      SIX_OF_EIGHT,
    ]);
    expect(SIX_OF_EIGHT).toBe("six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope");
    expect(printer().result(run).startsWith("RESULT ")).toBe(true); // nothing printed before it
    const after = printer();
    after.step(run.steps[0]);
    expect(after.result(run).startsWith("\nRESULT ")).toBe(true); // one blank line between blocks
  });

  it("is the last output: RESULT first at(-2), the six-of-eight line at(-1) on sandbox", () => {
    const all = (print(run.steps) + "\n" + printer().result(run)).split("\n");
    expect(all.at(-2)).toMatch(/^RESULT /);
    expect(all.at(-1)).toBe(SIX_OF_EIGHT);
  });

  it("no six-of-eight line on testnet, or when a name is missing from the run", () => {
    expect(resultLines({ ...run, network: "testnet" }, { network: "testnet" })).toHaveLength(1);
    const withoutBurn = { ...run, steps: run.steps.filter((s) => s.phase !== "burn") };
    expect(resultLines(withoutBurn)).toHaveLength(1);
    expect(resultLines(withoutBurn)[0]).toContain("RESULT 15/15 PASS · 12 protocol refusals");
  });

  it("only passing refusals count, and a failure is stated", () => {
    const failing = { ...run, exitCode: 1, steps: run.steps.map((s, i) => (i === 3 ? { ...s, pass: false, note: failExpected("A", "B") } : s)) };
    const [line] = resultLines(failing);
    expect(line).toMatch(/^RESULT 15\/16 PASS · 1 FAIL · 12 protocol refusals · 3 tx hashes · 12s · exit 1 · /);
    expect(resultLines(failing)).toHaveLength(1); // MethodNameMismatch is no longer verified, so no six-of-eight line
  });

  it("counts distinct tx hashes, including further hashes of a step", () => {
    const steps = [synthetic({ txHash: "A1", moreTxHashes: ["B2", "A1"] }), synthetic({ txHash: "C3" }), synthetic({})];
    const [line] = resultLines({ ...run, network: "testnet", steps, durationMs: 221_000, exitCode: 0, transcriptPath: "demo/transcript.md" }, { network: "testnet" });
    expect(line).toBe("RESULT 3/3 PASS · 0 protocol refusals · 3 tx hashes · 3m41s · exit 0 · transcript demo/transcript.md");
  });

  it("formats durations under a minute, over a minute and when the path is unknown", () => {
    const of = (durationMs: number, transcriptPath: string) => resultLines({ ...run, network: "testnet", steps: [synthetic({})], durationMs, transcriptPath }, { network: "testnet" })[0];
    expect(of(41_000, "demo/transcript.md")).toContain(" · 41s · exit 0 · transcript demo/transcript.md");
    expect(of(60_400, "demo/transcript.md")).toContain(" · 1m00s · ");
    expect(of(0, "")).toBe("RESULT 1/1 PASS · 0 protocol refusals · 0 tx hashes · 0s · exit 0");
  });

  it("SignerDoesNotExist is a protocol refusal in the burn and smoke phases only; plain InvalidTxError names never are", () => {
    const body = (variant: string) => `{"jsonrpc":"2.0","error":{"data":{"TxExecutionError":{"InvalidTxError":${variant}}}},"id":"x"}`;
    const counted = (phase: DemoStep["phase"], variant: string): string => {
      const s = withBody({ ...run.steps.find((x) => x.phase === "burn")!, phase }, body(variant));
      return resultLines({ ...run, network: "testnet", steps: [s] }, { network: "testnet" })[0];
    };
    for (const phase of ["burn", "smoke"] as const) expect(counted(phase, '{"SignerDoesNotExist":{"signer_id":"a"}}')).toContain(" · 1 protocol refusal · ");
    for (const phase of ["setup", "wrap", "in-scope", "refusals", "chain-check", "inspect"] as const) {
      expect(counted(phase, '{"SignerDoesNotExist":{"signer_id":"a"}}'), phase).toContain(" · 0 protocol refusals · ");
    }
    for (const variant of ['"Expired"', '{"InvalidNonce":{"tx_nonce":1,"ak_nonce":2}}', '{"NotEnoughBalance":{"signer_id":"a","balance":"1","cost":"2"}}', '{"InvalidSignerId":{"signer_id":"a"}}']) {
      for (const phase of ["refusals", "burn", "smoke"] as const) expect(counted(phase, variant), `${phase} ${variant}`).toContain(" · 0 protocol refusals · ");
    }
  });

  it("a single refusal is not pluralized", () => {
    const [line] = resultLines({ ...run, network: "testnet", steps: [hero[0]] }, { network: "testnet" });
    expect(line).toContain(" · 1 protocol refusal · ");
  });

  it("colored: RESULT is bold and the count span is the PASS style; it strips to the plain line", () => {
    const colored = printer({ caps: color100 }).result(run);
    expect(colored).toContain("\x1b[1mRESULT\x1b[22m \x1b[1;30;42m16/16 PASS\x1b[22;39;49m");
    expect(stripAnsi(colored)).toBe(printer({ caps: uncolored }).result(run));
    const failing = { ...run, steps: run.steps.map((s, i) => (i === 0 ? { ...s, pass: false } : s)) };
    expect(printer({ caps: color100 }).result(failing)).toContain("\x1b[1;97;41m15/16 PASS\x1b[22;39;49m");
    expectBalanced(colored);
  });
});

describe("renderTranscript", () => {
  const meta = { rpc: "http://127.0.0.1:1", operator: "op.testnet", startedAt: "2026-11-11T09:00:00Z" };
  const mdOf = lazy(() => renderTranscript(run, meta));

  it("has every refusal body verbatim in a fenced json block", () => {
    for (const s of refusalSteps) expect(mdOf()).toContain("```json\n" + s.attempt!.outcome.rawRpcJson + "\n```");
  });

  it("says never in a block and ends with the RESULT line (and the six-of-eight line on sandbox)", () => {
    expect(mdOf()).toMatch(/never in a block/);
    expect(mdOf()).toMatch(/^RESULT /m);
    const lines = mdOf().trimEnd().split("\n");
    expect(lines.at(-1)).toBe(SIX_OF_EIGHT);
    expect(lines.at(-3)).toBe("RESULT 16/16 PASS · 13 protocol refusals · 3 tx hashes · 12s · exit 0 · transcript demo/transcript.sandbox.md");
    expect(mdOf().endsWith("\n")).toBe(true);
  });

  it("opens with the date, network, RPC, operator and session public key", () => {
    const head = mdOf().split("\n").slice(0, 12).join("\n");
    expect(head).toMatch(/^# /);
    expect(head).toContain("2026-11-11T09:00:00Z");
    expect(head).toContain("sandbox");
    expect(head).toContain("`http://127.0.0.1:1`");
    expect(head).toContain("`op.testnet`");
    expect(head).toMatch(/session public key: not recorded in this run/);
    // a run with a card names the key (public half)
    const card = sampleCageCard();
    const withKey = renderTranscript({ ...run, steps: [synthetic({ phase: "wrap", card }), ...run.steps] }, meta);
    expect(withKey).toContain(`session public key: \`${card.session.publicKey}\``);
    const viaCheck = renderTranscript({ ...run, steps: [...run.steps, chainStep()] }, meta);
    expect(viaCheck).toContain(`session public key: \`${before.publicKey}\``);
  });

  it("has a step table: step | signer | result | tx, one row per step", () => {
    const lines = mdOf().split("\n");
    const i = lines.indexOf("| step | signer | result | tx |");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe("|---|---|---|---|");
    const rows = lines.slice(i + 2, i + 2 + run.steps.length);
    expect(rows.every((r) => r.startsWith("| [") && r.endsWith(" |"))).toBe(true);
    expect(lines[i + 2 + run.steps.length]).toBe("");
    expect(rows[0]).toBe("| [01/16] approve #0 (grant payout) | session | PASS: in scope, landed | `8bU9DAkEHc6PX4xErpeAA19tf1ZxKE1zzfLb98tJuD3D` |");
    expect(rows[3]).toBe(`| [04/16] open a payout proposal | session | ${passRefused("MethodNameMismatch")} | never in a block |`);
  });

  it("the refusal rows carry passRefused(name) in the result cell, and that string appears nowhere else", () => {
    const lines = mdOf().split("\n");
    expect(lines.filter((l) => l.includes("PASS: refused by protocol"))).toHaveLength(refusalSteps.length);
    for (const s of refusalSteps) {
      const o = s.attempt!.outcome;
      const row = lines.find((l) => l.startsWith(`| [${String(s.n).padStart(2, "0")}/16]`))!;
      expect(o.kind === "Refusal" && row.includes(`| ${passRefused(o.errorName)} | never in a block |`)).toBe(true);
    }
  });

  it("links the tx on testnet and prints the hash in code on sandbox", () => {
    const testnet = renderTranscript({ ...run, network: "testnet" }, meta);
    expect(testnet).toContain("| [8bU9...uD3D](https://testnet.nearblocks.io/txns/8bU9DAkEHc6PX4xErpeAA19tf1ZxKE1zzfLb98tJuD3D) |");
    expect(testnet).not.toContain(SIX_OF_EIGHT);
  });

  it("the in-scope rows, the contrast case and failures read as such", () => {
    const panic = synthetic({ n: 17, total: 20, phase: "smoke", signer: "session", label: "reset", attempt: { ...run.steps[0].attempt!, outcome: { kind: "ContractPanic", txHash: "PH1", message: "m", rawRpcJson: "{}" } } });
    const failed = { ...hero[1], pass: false, note: failExpected("MethodNameMismatch", "RequiresFullAccess") };
    const text = renderTranscript({ ...run, steps: [panic, failed, synthetic({ label: "setup" })] }, meta);
    expect(text).toContain("| [17/20] reset | session | PASS: runtime failure in a block, gas charged (contrast: the contract refused, not the protocol) | `PH1` |");
    expect(text).toContain(`| ${failExpected("MethodNameMismatch", "RequiresFullAccess")} | never in a block |`);
    expect(text).toContain("| [01/14] setup | full access | PASS | — |");
  });

  it("a rejection that is not the key's scope is a chain-rejected row, not a PASS row (C-T2k)", () => {
    const rejected = withBody(hero[1], invalidNonce("x"));
    const text = renderTranscript({ ...run, steps: [hero[0], rejected] }, meta);
    expect(text).toContain("| chain rejected the tx: InvalidNonce | never in a block |");
    expect(text.split("\n").filter((l) => l.includes("PASS: refused by protocol"))).toHaveLength(1);
    expect(text).toContain("```json\n" + invalidNonce("x") + "\n```");
    expect(text).toContain(" · 1 protocol refusal · ");
  });

  it("the bodies section says what the bodies are, and labels a chain rejection as one", () => {
    const rejected = withBody(hero[1], invalidNonce("x"));
    const text = renderTranscript({ ...run, steps: [hero[0], rejected] }, meta);
    expect(text).toContain("\n## RPC bodies (never in a block)\n");
    expect(text).not.toContain("Refusal bodies");
    expect(text).toContain("### [04/16] open a payout proposal — MethodNameMismatch\n");
    expect(text).toContain("### [05/16] send NEAR — chain rejected the tx: InvalidNonce\n");
  });

  it("the chain-check row is measured: PASS with the earned count, FAIL when the state moved", () => {
    const pass = renderTranscript({ ...run, steps: [...hero, chainStep()] }, meta);
    expect(pass).toContain("| [09/16] CHAIN CHECK | none | PASS: key state unchanged by 4 refusals | — |");
    const moved = renderTranscript({ ...run, steps: [...hero, chainStep({ before, after: { ...after, nonce: after.nonce + 1 } })] }, meta);
    expect(moved).toContain("| [09/16] CHAIN CHECK | none | FAIL: key state changed by refusals (nonce 51000003 -> 51000004) | — |");
    expect(moved).not.toContain("key state unchanged");
  });

  it("counts only the refusals-phase slots before the chain check (a burn proof is not one of them)", () => {
    const burn = run.steps.find((s) => s.phase === "burn")!;
    const text = renderTranscript({ ...run, steps: [...hero, burn, chainStep()] }, meta);
    expect(text).toContain("PASS: key state unchanged by 4 refusals");
    expect(text).not.toContain("unchanged by 5 refusals");
    // refusals after the check do not count either
    const late = renderTranscript({ ...run, steps: [hero[0], hero[1], chainStep(), hero[2], hero[3]] }, meta);
    expect(late).toContain("PASS: key state unchanged by 2 refusals");
  });

  it("claims no refusals it did not earn: no slot, or four missing slots, is no PASS (replay-shaped)", () => {
    const none = renderTranscript({ ...run, steps: [chainStep()] }, meta);
    expect(none).not.toContain("key state unchanged");
    expect(none).toContain("| FAIL: no refusal attempt preceded the chain check | — |");
    const four = renderTranscript({ ...run, steps: [4, 5, 6, 7].map(missingSlot).concat(chainStep()) }, meta);
    expect(four).not.toContain("key state unchanged");
    expect(four).not.toContain("by 0 refusals");
    expect(four).toContain("| FAIL: no attempt was refused by protocol before the chain check (0/4) | — |");
  });

  it("a failed refusal does not count in the chain-check row", () => {
    const failed = { ...hero[1], pass: false, note: failExpected("MethodNameMismatch", "RequiresFullAccess") };
    expect(renderTranscript({ ...run, steps: [hero[0], failed, hero[2], hero[3], chainStep()] }, meta)).toContain("PASS: key state unchanged by 3 refusals");
  });

  describe("the burn proof of a sub-account (SignerDoesNotExist)", () => {
    const body = '{"jsonrpc":"2.0","error":{"data":{"TxExecutionError":{"InvalidTxError":{"SignerDoesNotExist":{"signer_id":"ks-7f3a.op.sandbox"}}}}},"id":"x"}';
    const burn = run.steps.find((s) => s.phase === "burn")!;
    const gone = (phase: DemoStep["phase"]) => renderTranscript({ ...run, steps: [withBody({ ...burn, phase }, body)] }, meta);

    it.each(["burn", "smoke"] as const)("phase %s: NOTE_SIGNER_GONE sits under the body's heading; the result cell is unchanged (R10a)", (phase) => {
      const text = gone(phase);
      expect(text).toContain(`| ${passRefused("SignerDoesNotExist")} | never in a block |`);
      expect(text).toContain(`### [09/16] vote with the deleted key — SignerDoesNotExist\n\n${NOTE_SIGNER_GONE}\n\n\`\`\`json\n${body}\n\`\`\``);
      expect(text).toContain(" · 1 protocol refusal · ");
    });

    it("in any other phase it is a chain rejection: no PASS cell, no note, not counted", () => {
      const text = gone("refusals");
      expect(text).toContain("| chain rejected the tx: SignerDoesNotExist | never in a block |");
      expect(text).toContain("### [09/16] vote with the deleted key — chain rejected the tx: SignerDoesNotExist\n");
      expect(text).not.toContain(NOTE_SIGNER_GONE);
      expect(text).not.toContain("PASS: refused by protocol");
      expect(text).toContain(" · 0 protocol refusals · ");
    });

    it("the note appears once, only for that name", () => {
      const text = renderTranscript({ ...run, steps: [...run.steps.filter((s) => s.phase === "burn"), withBody({ ...burn, phase: "smoke" }, body)] }, meta);
      expect(text.split(NOTE_SIGNER_GONE)).toHaveLength(2);
    });
  });

  it("neutralizes chain-sourced text, keeps table rows to one line and fences around any backticks", () => {
    const evil = "a|b\x1b[31m\nFAKE | ROW";
    const body = JSON.stringify({ jsonrpc: "2.0", error: { data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { "Ev\x1b[31m```il": {} } } } } }, id: "x" });
    const h = { ...withBody(hero[0], body), label: evil };
    const text = renderTranscript({ ...run, steps: [h, hero[1]] }, { rpc: "http://x/\x1b[2J", operator: "op\x1b.testnet", startedAt: "2026\x07" });
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\x07");
    expect(text).toContain("a\\|b\\u001b[31m\\u000aFAKE \\| ROW");
    expect(text.split("\n").filter((l) => l.startsWith("| [")).length).toBe(2);
    expect(text).toContain("Ev\\u001b[31m```il");
    // the body holds a run of three backticks, so its fence is longer than three
    expect(text).toContain("````json\n");
    expect(text).toContain("\n````\n");
  });

  it("a body that carries raw control bytes is neutralized inside its fence (stored fixtures keep the original)", () => {
    const body = '{"jsonrpc":"2.0","error":{"data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}},"message":"a\x1b[2J\nPASS: refused by protocol (Fake)"}}';
    const forged = { ...hero[1], attempt: { ...hero[1].attempt!, outcome: { ...hero[1].attempt!.outcome, rawRpcJson: body } as AttemptOutcome } };
    const text = renderTranscript({ ...run, steps: [forged] }, meta);
    expect(text).not.toContain(ESC);
    expect(text).toContain('a\\u001b[2J\\u000aPASS: refused by protocol (Fake)"}}\n```');
    // the forged PASS text sits inside the fence on one line, so it is not a line of its own
    expect(text.split("\n").filter((l) => l.startsWith("PASS: refused by protocol"))).toHaveLength(0);
  });

  it("is plain markdown: no escape bytes, ever", () => {
    expect(mdOf()).not.toContain(ESC);
    expect(mdOf()).not.toContain("\r");
  });
});

// ---------------------------------------------------------------------------------------------------
// T17's carry-forwards in the renderers: C-T8c, C-T12a, C-T12b, C-T12d, C-T13b, C-T8b

describe("carry-forwards landed with the demo command (T17)", () => {
  const sandboxRun = JSON.parse(readFixture(join(SANDBOX_FIXTURES, "..", ".."), "run.sandbox.json")) as DemoRun;
  const meta = { rpc: "http://127.0.0.1:1", operator: "op.testnet", startedAt: "2026-11-11T09:00:00Z" };

  it("C-T8c: a failed slot whose body is a real InvalidAccessKeyError lights no rule, no inverse name, and says FAIL on its row", () => {
    const failed = { ...hero[0], pass: false, note: failExpected("RequiresFullAccess", "MethodNameMismatch") };
    const lines = print([failed, hero[1], hero[2], hero[3], chainStep()]).split("\n");
    const at = lines.findIndex((l) => l.startsWith("-- REFUSALS"));
    expect(lines[at]).toMatch(/^-- REFUSALS 3\/4 /);
    const row = lines[at + 2];
    expect(row.startsWith("   [04]  ")).toBe(true);
    expect(row).not.toContain("[METHOD]");
    expect(row).toContain(`MethodNameMismatch ${failExpected("RequiresFullAccess", "MethodNameMismatch")}`);
    const colored = print([failed, hero[1], hero[2], hero[3], chainStep()], { caps: color100 });
    const cl = colored.split("\n");
    const c = cl.findIndex((l) => /^(--|──) REFUSALS/.test(stripAnsi(l)));
    const [failedRow, earnedRow] = [cl[c + 2], cl[c + 3]]; // the body above still marks the name it parsed: only the staircase row is judged
    expect(failedRow).not.toContain("\x1b[7m");
    expect(failedRow).not.toContain("[METHOD]");
    expect(stripAnsi(failedRow)).toContain(`MethodNameMismatch ${failExpected("RequiresFullAccess", "MethodNameMismatch")}`);
    expect(earnedRow).toContain("\x1b[7mRequiresFullAccess\x1b[27m"); // the earned rows keep NEAR's voice
    expect(earnedRow).toContain("\x1b[1m[ACTION]\x1b[22m");
    expectBalanced(colored);
  });

  it("C-T8c: the transcript prints NOTE_SIGNER_GONE only for a SignerDoesNotExist proof the step earned", () => {
    const body = '{"jsonrpc":"2.0","error":{"data":{"TxExecutionError":{"InvalidTxError":{"SignerDoesNotExist":{"signer_id":"ks-7f3a.op.sandbox"}}}}},"id":"x"}';
    const burn = withBody(run.steps.find((s) => s.phase === "burn")!, body);
    expect(renderTranscript({ ...run, steps: [burn] }, meta)).toContain(NOTE_SIGNER_GONE);
    expect(renderTranscript({ ...run, steps: [{ ...burn, pass: false, note: "FAIL: the proof was not earned" }] }, meta)).not.toContain(NOTE_SIGNER_GONE);
  });

  it("C-T12b: the transcript's signer cell names the full-access key, not the operator; the other signers read as they are", () => {
    const md = renderTranscript(sandboxRun, meta);
    const rows = md.split("\n").filter((l) => l.startsWith("| ["));
    expect(rows).toHaveLength(20);
    expect(rows.find((r) => r.startsWith("| [03/20] "))!.split(" | ")[1]).toBe("full access");
    expect(rows.find((r) => r.startsWith("| [13/20] "))!.split(" | ")[1]).toBe("full access");
    expect(rows.find((r) => r.startsWith("| [02/20] "))!.split(" | ")[1]).toBe("cosigner");
    expect(rows.find((r) => r.startsWith("| [06/20] "))!.split(" | ")[1]).toBe("session");
    expect(rows.some((r) => r.split(" | ")[1] === "operator")).toBe(false);
    expect(md).toContain("operator: `op.testnet`"); // the header still names the operator
  });

  it("C-T13b: WARN notes get a Warnings section in the transcript, one item per warning, within 100 columns", () => {
    const md = renderTranscript(sandboxRun, meta);
    const lines = md.split("\n");
    const at = lines.indexOf("## Warnings");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 4)).toEqual(["## Warnings", "", "- [15/20] WARN  reset — fails-without-deposit (runtime)", ""]);
    // the note's other part (not a warning) stays out of the section
    expect(md).not.toContain("- [15/20] key on chain");
    // a long warning wraps under its item, words intact
    const long = `WARN  ${"word ".repeat(40).trim()}`;
    const w = renderTranscript({ ...run, steps: [{ ...run.steps[0], note: long }] }, meta).split("\n");
    const i = w.indexOf("## Warnings");
    const item = w.slice(i + 2, w.indexOf("", i + 2));
    expect(item.length).toBeGreaterThan(1);
    expect(item.every((l) => displayWidth(l) <= 100)).toBe(true);
    expect(item.slice(1).every((l) => l.startsWith("  "))).toBe(true);
    expect(item.map((l, k) => (k === 0 ? l.replace(/^- \[01\/16\] /, "") : l.trim())).join(" ")).toBe(long);
    // no warnings, no section
    expect(renderTranscript(run, meta)).not.toContain("## Warnings");
  });

  it("C-T12a: a FAIL note carrying a long verbatim error line wraps at ` · `, then at spaces, in both styles, words intact", () => {
    const error = "send_tx: the RPC did not answer within 30s (ECONNRESET at https://rpc.testnet.near.org) · the tx may have landed · look up the hash before signing again · do not resend";
    const s = { ...synthetic({ n: 7, total: 14, phase: "refusals", label: "attach the bond", signer: "session" }), pass: false, note: error };
    for (const style of ["full", "beat"] as const) {
      const rows = print([s], { style }).split("\n").filter((l) => l.trim() !== "");
      expect(rows.every((l) => displayWidth(l) <= 100), style).toBe(true);
      const words = rows.join(" ").split(/\s+/).filter((w) => w !== "" && w !== "·");
      for (const w of `FAIL: ${error}`.split(/\s+/).filter((w) => w !== "·")) expect(words, `${style}: ${w}`).toContain(w);
    }
  });

  it("C-T12d: runStopped names the step the run stopped after, and what it left behind", () => {
    const steps = sandboxRun.steps;
    expect(runStopped(steps)).toBeNull(); // a complete run
    expect(runStopped([])).toBeNull();
    expect(runStopped([{ ...steps[0], pass: false }])).toBe("run stopped after [01]: no bond, no key");
    expect(runStopped(steps.slice(0, 2))).toBe("run stopped after [02]: no key");
    expect(runStopped(steps.slice(0, 5))).toBe("run stopped after [05]");
    expect(runStopped([steps[0], steps[2]])).toBeNull(); // not 1..k: a replay with gaps, not an early stop
    // printed after RESULT in the log
    const rows = resultRows({ ...sandboxRun, steps: [{ ...steps[0], pass: false }], exitCode: 1 }, plain100);
    expect(rows.at(-1)).toBe("run stopped after [01]: no bond, no key");
    expect(rows.at(-2)).toMatch(/^RESULT 0\/1 PASS · 1 FAIL /);
  });

  it("C-T8b: beat-style RESULT breaks at a ` · ` before 100 columns; full style keeps one row", () => {
    const long = { ...sandboxRun, network: "testnet" as const, steps: sandboxRun.steps.slice(0, 14).map((s) => ({ ...s, total: 14 })), durationMs: 3_599_000, transcriptPath: "/home/me/keyhole/demo/transcript.md" };
    const beat = resultRows(long, plain100, "beat");
    expect(beat).toEqual(["RESULT 14/14 PASS · 5 protocol refusals · 8 tx hashes · 59m59s · exit 0", "       · transcript demo/transcript.md"]);
    expect(resultRows(long, plain100, "full")).toEqual(["RESULT 14/14 PASS · 5 protocol refusals · 8 tx hashes · 59m59s · exit 0 · transcript demo/transcript.md"]);
    // the sandbox run's RESULT is 106 cells: beat style breaks it and still ends with the six-of-eight line
    const sb = resultRows(sandboxRun, plain100, "beat");
    expect(sb.every((l) => displayWidth(l) <= 100)).toBe(true);
    expect(sb.at(-1)).toBe(SIX_OF_EIGHT);
    expect(sb[0]).toMatch(/^RESULT 20\/20 PASS · 7 protocol refusals /);
    expect(stripAnsi(resultRows(long, color100, "beat").join("\n"))).toBe(beat.join("\n"));
  });
});
