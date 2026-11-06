/**
 * Task 8: renderRefusalBlock, the `full` style (LAYOUT R4 (b)) and the `beat` style (DESIGN_BRIEF §5.3).
 *
 * Expected strings are written out by hand from the brief, LAYOUT and DESIGN, never computed with the code
 * under test. The run is the committed spike capture (demo/fixtures/sandbox): real steps, real RPC bodies.
 */
import { describe, expect, it } from "vitest";
import { parseRefusal } from "../src/core/refusal.js";
import type { Attempt, DemoRun, DemoStep } from "../src/core/types.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { chainRejected, renderRefusalBlock } from "../src/render/refusal-block.js";
import { NOTE_SIGNER_GONE, failExpected, passRefused } from "../src/render/strings.js";
import { displayWidth, stripAnsi } from "../src/render/style.js";
import { SANDBOX_FIXTURES, color100, plain100, plain80 } from "./helpers.js";

const run: DemoRun = await loadDemoRunFixture(SANDBOX_FIXTURES);
const step = (method: string): DemoStep => run.steps.find((s) => s.attempt?.method === method && s.attempt.outcome.kind === "Refusal")!;
const g1 = step("add_proposal");
const refusalSteps = run.steps.filter((s) => s.attempt?.outcome.kind === "Refusal");
const hero = run.steps.filter((s) => s.phase === "refusals").slice(0, 4);
const ESC = "\x1b";
const uncolored = { ...color100, color: false };

const raw = (s: DemoStep): string => s.attempt!.outcome.rawRpcJson;
/** Computed on first use, inside a test, so an unbuilt renderer fails the test and not the file. */
const lazy = <T>(f: () => T): (() => T) => {
  let cached: { v: T } | undefined;
  return () => (cached ??= { v: f() }).v;
};

/** A copy of a step with its attempt fields replaced. */
function withAttempt(s: DemoStep, patch: Partial<Attempt>): DemoStep {
  return { ...s, attempt: { ...s.attempt!, ...patch } as Attempt };
}

/** A step whose body is `body`, parsed by the same parser the live path uses. */
function stepFromBody(base: DemoStep, body: string, patch: Partial<DemoStep> = {}): DemoStep {
  const outcome = parseRefusal(body);
  expect(outcome).not.toBeNull();
  return { ...base, ...patch, attempt: { ...base.attempt!, outcome: outcome! } };
}

/** SGR spans must open and close within a row, never nest and never leak into the next row. */
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

describe("renderRefusalBlock: full style (LAYOUT R4 (b))", () => {
  const fullLines = lazy(() => renderRefusalBlock(g1, plain100, "full").split("\n"));

  it("has the anatomy of the first refusal: header, rule strip, signed, rpc, raw body, verdict, ledger", () => {
    const full = fullLines();
    expect(full[0]).toMatch(/^\[\d{2}\/\d{2}\] ATTEMPT  add_proposal /);
    expect(full[0]).toBe('[04/16] ATTEMPT  add_proposal  ("open a payout proposal")');
    expect(full[1]).toContain("[METHOD]");
    expect(full[1]).toBe("        breaks    [METHOD]     action      receiver    deposit     allowance");
    expect(full[2]).toMatch(/^        signed   FunctionCall add_proposal -> \S+ · deposit 0 · 30 TGas$/);
    expect(full[2]).toBe("        signed   FunctionCall add_proposal -> dao.sandbox · deposit 0 · 30 TGas");
    // C-T8a: the printed path names the file on disk, which lives in demo/fixtures/sandbox/. C-T14b: in one piece the row
    // is 104 cells, so at 100 columns the path takes the next row, after `· ` (the ledger's way).
    expect(full[3]).toBe("        rpc      response body, verbatim");
    expect(full[4]).toBe("        · demo/fixtures/sandbox/052-g1-method-add_proposal.send_tx.json");
    expect(full.filter((l) => l === "        PASS: refused by protocol (MethodNameMismatch)")).toHaveLength(1);
    // C-T12a: the ledger is 107 cells on one row, so at 100 columns its path takes the next row, after `· `.
    expect(full.slice(-2)).toEqual(["        reached block: no · on-chain tx: none", "        · InvalidTxError › InvalidAccessKeyError › MethodNameMismatch"]);
    expect(full.at(-3)).toBe(`        ${passRefused("MethodNameMismatch")}`);
    // Where it fits, it is LAYOUT's one row (the rpc row too).
    expect(renderRefusalBlock(g1, { ...plain100, width: 120 }, "full").split("\n")[3]).toBe("        rpc      response body, verbatim · demo/fixtures/sandbox/052-g1-method-add_proposal.send_tx.json");
    expect(renderRefusalBlock(g1, { ...plain100, width: 120 }, "full").split("\n").at(-1)).toBe("        reached block: no · on-chain tx: none · InvalidTxError › InvalidAccessKeyError › MethodNameMismatch");
  });

  it("C-T12a, C-T14b: every row fits 100 columns (the rpc row too: the longest spike capture name was 109 cells), and the ledger path is never broken", () => {
    for (const s of refusalSteps) {
      const lines = renderRefusalBlock(s, plain100, "full").split("\n");
      for (const l of lines) expect(displayWidth(l), `${s.fixture}: ${l}`).toBeLessThanOrEqual(100);
      const o = s.attempt!.outcome;
      if (o.kind === "Refusal") expect(lines.at(-1)!.endsWith(o.path.join(" › ")), s.fixture).toBe(true);
    }
  });

  it("C-T12a: a failed refusal's long note (a verbatim C-T2i error line) breaks at ` · `, then at spaces, never wider than 100", () => {
    const error = "send_tx: the RPC did not answer within 30s (ECONNRESET at https://rpc.testnet.near.org/some/long/path) · the tx may have landed · look up the hash before signing again · do not resend";
    const failed = { ...g1, pass: false, note: error };
    for (const style of ["full", "beat"] as const) {
      const lines = renderRefusalBlock(failed, plain100, style).split("\n");
      for (const l of lines) expect(displayWidth(l), `${style}: ${l}`).toBeLessThanOrEqual(100);
      const text = lines.join(" ");
      for (const part of error.split(" · ")) for (const w of part.split(" ")) expect(text, `${style}: ${w}`).toContain(w);
      expect(text).not.toContain("PASS: refused by protocol");
    }
    // A passing refusal's own note (testnet hashes make it long) is fitted the same way, under its PASS line.
    const noted = { ...g1, note: `AddKey (0.0100 NEAR) by the operator key · tx ${"7Gm4Qt7hoJ4tDaWXMpvSrnwrjcU9uVchxE2m3guAeHgA"} · then ${"word ".repeat(12).trim()}` };
    for (const style of ["full", "beat"] as const) {
      const lines = renderRefusalBlock(noted, plain100, style).split("\n");
      for (const l of lines) expect(displayWidth(l), `${style}: ${l}`).toBeLessThanOrEqual(100);
      expect(lines.join(" ")).toContain("7Gm4Qt7hoJ4tDaWXMpvSrnwrjcU9uVchxE2m3guAeHgA");
      expect(lines.filter((l) => l.includes(passRefused("MethodNameMismatch")))).toHaveLength(1);
    }
  });

  it("is 8 to 10 lines with no blank line inside, for every hero refusal", () => {
    for (const s of hero) {
      const lines = renderRefusalBlock(s, plain100, "full").split("\n");
      // LAYOUT's ledger and rpc rows are one line each; at 100 columns either can take a second row, hung under a `· `
      // (C-T12a, C-T14b), so those continuation rows are not counted.
      const anatomy = lines.filter((l) => !l.startsWith("        · ")).length;
      expect(anatomy, s.fixture).toBeGreaterThanOrEqual(8);
      expect(anatomy, s.fixture).toBeLessThanOrEqual(10);
      expect(lines.every((l) => l.trim() !== "")).toBe(true);
    }
  });

  it("C-T18a: counter: false leaves [NN/TT] off the header and changes nothing else; the default and the beat style keep it", () => {
    const withCounter = renderRefusalBlock(g1, plain100, "full").split("\n");
    const without = renderRefusalBlock(g1, plain100, "full", { counter: false }).split("\n");
    expect(without[0]).toBe('ATTEMPT  add_proposal  ("open a payout proposal")');
    expect(without.slice(1)).toEqual(withCounter.slice(1));
    expect(renderRefusalBlock(g1, plain100, "full", { counter: true }).split("\n")[0]).toBe('[04/16] ATTEMPT  add_proposal  ("open a payout proposal")');
    expect(renderRefusalBlock(g1, plain100, "full", {})).toBe(withCounter.join("\n"));
    expect(renderRefusalBlock(g1, plain100, "beat", { counter: false })).toBe(renderRefusalBlock(g1, plain100, "beat"));
    // Colour does not move it: the same row, with the same styling on the same words.
    expect(stripAnsi(renderRefusalBlock(g1, color100, "full", { counter: false })).split("\n")[0]).toBe(without[0]);
  });

  it("rows behind the gutter join to the fixture bytes", () => {
    expect(fullLines().filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(raw(g1));
    for (const s of refusalSteps) {
      const lines = renderRefusalBlock(s, plain100, "full").split("\n");
      expect(lines.filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(raw(s));
    }
  });

  it("each hero refusal lights one slot, one column right of the one before", () => {
    const slots = ["[METHOD]", "[ACTION]", "[RECEIVER]", "[DEPOSIT]"];
    hero.forEach((s, i) => {
      const strip = renderRefusalBlock(s, plain100, "full").split("\n")[1];
      expect(strip.indexOf(slots[i]), s.fixture).toBe(18 + 12 * i);
    });
  });

  it("the signed line says what was signed for a transfer and for a foreign receiver and a deposit", () => {
    const [, transfer, receiver, deposit] = hero;
    expect(renderRefusalBlock(transfer, plain100, "full").split("\n")[2]).toBe("        signed   Transfer -> attacker.sandbox · deposit 1 yocto");
    expect(renderRefusalBlock(receiver, plain100, "full").split("\n")[2]).toBe("        signed   FunctionCall act_proposal -> other-dao.sandbox · deposit 0 · 30 TGas");
    expect(renderRefusalBlock(deposit, plain100, "full").split("\n")[2]).toBe("        signed   FunctionCall act_proposal -> dao.sandbox · deposit 1 yocto · 30 TGas");
  });

  it("the burn PROOF is the same block without the rule strip", () => {
    const burn = run.steps.find((s) => s.phase === "burn")!;
    const lines = renderRefusalBlock(burn, plain100, "full").split("\n");
    expect(lines.some((l) => l.includes("breaks"))).toBe(false);
    expect(lines[0]).toBe('[09/16] ATTEMPT  act_proposal  ("vote with the deleted key")');
    expect(lines[1]).toMatch(/^        signed   /);
    expect(lines.filter((l) => l === "        PASS: refused by protocol (AccessKeyNotFound)")).toHaveLength(1);
    expect(lines.slice(-2)).toEqual(["        reached block: no · on-chain tx: none", "        · InvalidTxError › InvalidAccessKeyError › AccessKeyNotFound"]);
  });

  it("a sub-account burn (SignerDoesNotExist) adds the note after the PASS line", () => {
    const burn = run.steps.find((s) => s.phase === "burn")!;
    const body = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"SignerDoesNotExist":{"signer_id":"ks-7f3a.op.sandbox"}}}}},"id":"x"}';
    const lines = renderRefusalBlock(stepFromBody(burn, body), plain100, "full").split("\n");
    const at = lines.indexOf("        PASS: refused by protocol (SignerDoesNotExist)");
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(`        ${NOTE_SIGNER_GONE}`);
    expect(lines.at(-1)).toBe("        reached block: no · on-chain tx: none · InvalidTxError › SignerDoesNotExist");
    // the note belongs to that one name
    expect(renderRefusalBlock(burn, plain100, "full")).not.toContain(NOTE_SIGNER_GONE);
  });

  it("a parsed-name mismatch prints failExpected and no PASS line", () => {
    const transfer = hero[1]; // the body parses to RequiresFullAccess
    const note = failExpected("MethodNameMismatch", "RequiresFullAccess");
    const text = renderRefusalBlock({ ...transfer, pass: false, note }, plain100, "full");
    expect(text).toContain(`        ${note}`);
    expect(text).not.toContain("PASS");
    expect(text).not.toContain("refused by protocol");
    // the evidence is still on screen: the raw body and the parsed path
    expect(text.split("\n").filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(raw(transfer));
    expect(text.split("\n").at(-1)).toContain("InvalidTxError › InvalidAccessKeyError › RequiresFullAccess");
    const beat = renderRefusalBlock({ ...transfer, pass: false, note }, plain100, "beat");
    expect(beat).toContain(note);
    expect(beat).not.toContain("PASS");
    // a FAIL row names no card row it "breaks": the attempt did not do what the tag would claim
    expect(beat).not.toContain("breaks");
    expect(beat.split("\n")[0]).toBe(note);
  });

  it("a landed transaction in a refusal slot is a FAIL with its body and no PASS", () => {
    const landed = run.steps[0]; // an in-scope vote that landed
    const text = renderRefusalBlock({ ...landed, pass: false, note: failExpected("MethodNameMismatch", "no refusal (landed: TxSuccess)") }, plain100, "full");
    expect(text).toContain("FAIL: expected MethodNameMismatch, parsed no refusal (landed: TxSuccess) from the body");
    expect(text).not.toContain("PASS");
    expect(text).not.toContain("breaks");
    expect(text.split("\n").at(-1)).toBe(`        reached block: yes · on-chain tx: ${landed.txHash}`);
  });

  it("colored output strips to the uncolored output byte for byte, with balanced spans", () => {
    for (const s of [...hero, run.steps.find((x) => x.phase === "burn")!]) {
      for (const style of ["full", "beat"] as const) {
        const colored = renderRefusalBlock(s, color100, style);
        expect(colored).toContain(ESC);
        expect(stripAnsi(colored)).toBe(renderRefusalBlock(s, uncolored, style));
        expectBalanced(colored);
      }
    }
  });

  it("the verdict keeps PASS: refused by protocol contiguous, the name in inverse, the broken slot and field in bold", () => {
    const colored = renderRefusalBlock(g1, color100, "full");
    expect(colored).toContain("\x1b[1;30;42mPASS: refused by protocol\x1b[22;39;49m (\x1b[7mMethodNameMismatch\x1b[27m)");
    expect(colored).toContain("\x1b[1m[METHOD]\x1b[22m");
    expect(colored).toContain("FunctionCall \x1b[1madd_proposal\x1b[22m → dao.sandbox · deposit 0 · 30 TGas");
    // lit three times: in the verdict, in place in the body, and at the end of the ledger path
    expect(colored.split("\x1b[7mMethodNameMismatch\x1b[27m")).toHaveLength(4);
  });

  it("piped output has no escape bytes", () => {
    for (const s of [...hero, run.steps[0]]) {
      for (const style of ["full", "beat"] as const) expect(renderRefusalBlock(s, plain100, style)).not.toContain(ESC);
    }
  });

  it("uses → and │ with unicode caps and -> and | without", () => {
    const text = renderRefusalBlock(g1, uncolored, "full");
    expect(text).toContain("add_proposal → dao.sandbox");
    expect(text).toContain("        │ {");
    expect(renderRefusalBlock(g1, plain100, "full")).toContain("        | {");
  });

  it("the body wraps at width minus 10 at any width", () => {
    const lines = renderRefusalBlock(g1, plain80, "full").split("\n").filter((l) => l.startsWith("        | "));
    expect(lines.every((l) => displayWidth(l) <= 80)).toBe(true);
    expect(lines.map((l) => l.slice(10)).join("")).toBe(raw(g1));
  });
});

describe("renderRefusalBlock: beat style (DESIGN_BRIEF §5.3)", () => {
  const beatLines = lazy(() => renderRefusalBlock(g1, plain100, "beat").split("\n"));

  it("row 1 is the verdict with a right-aligned tag naming the card row it breaks", () => {
    const beat = beatLines();
    expect(beat[0]).toMatch(/^PASS: refused by protocol \(MethodNameMismatch\) +breaks METHOD · add_proposal$/);
    expect(displayWidth(beat[0])).toBeLessThanOrEqual(100);
    expect(displayWidth(beat[0])).toBe(98);
  });

  it("the rows after it join to the fixture bytes in at most 4 rows", () => {
    const beat = beatLines();
    expect(beat.slice(1).map((l) => l.slice(4)).join("")).toBe(raw(g1));
    expect(beat.length - 1).toBeLessThanOrEqual(4);
    expect(beat.slice(1).every((l) => l.startsWith("    ") && displayWidth(l) <= 100)).toBe(true);
  });

  it.each([
    [0, "MethodNameMismatch", "breaks METHOD · add_proposal"],
    [1, "RequiresFullAccess", "breaks ACTIONS · Transfer"],
    [2, "ReceiverMismatch", "breaks RECEIVER · other-dao.sandbox"],
    [3, "DepositWithFunctionCall", "breaks DEPOSIT · 1 yocto"],
  ])("hero refusal %i: tag and verdict", (i, name, tag) => {
    const lines = renderRefusalBlock(hero[i], plain100, "beat").split("\n");
    expect(lines[0]).toBe(`${passRefused(name)}${" ".repeat(98 - passRefused(name).length - tag.length)}${tag}`);
    expect(lines.slice(1).map((l) => l.slice(4)).join("")).toBe(raw(hero[i]));
    expect(lines.length - 1).toBeLessThanOrEqual(4);
  });

  it("the allowance rule shows its gas as the offending value", () => {
    const allowance = run.steps.find((s) => s.attempt?.violates === "allowance")!;
    expect(renderRefusalBlock(allowance, plain100, "beat").split("\n")[0]).toMatch(/^PASS: refused by protocol \(NotEnoughAllowance\) +breaks GAS · 30 TGas$/);
  });

  it("a longer body keeps every byte (the block grows; nothing is elided)", () => {
    const allowance = run.steps.find((s) => s.attempt?.violates === "allowance")!;
    const lines = renderRefusalBlock(allowance, plain100, "beat").split("\n");
    expect(lines.slice(1).map((l) => l.slice(4)).join("")).toBe(raw(allowance));
    expect(lines.join("\n")).not.toContain("…(+");
  });

  it("the burn proof has a verdict and no tag", () => {
    const burn = run.steps.find((s) => s.phase === "burn")!;
    expect(renderRefusalBlock(burn, plain100, "beat").split("\n")[0]).toBe("PASS: refused by protocol (AccessKeyNotFound)");
  });

  it("lights the name in the body in inverse, where it occurs, without changing a byte", () => {
    const colored = renderRefusalBlock(g1, color100, "beat");
    expect(colored).toContain("\x1b[7mMethodNameMismatch\x1b[27m");
    expect(stripAnsi(colored).split("\n").slice(1).map((l) => l.slice(4)).join("")).toBe(raw(g1));
  });
});

describe("renderRefusalBlock: the beat tag never pushes a row past the width", () => {
  const longReceiver = `${"x".repeat(56)}.testnet`; // 64 characters, the longest account id
  const g3 = withAttempt(hero[2], { receiverId: longReceiver });

  it("a 64-character receiver puts the tag on its own right-aligned row; every row is at most 100 cells", () => {
    expect(longReceiver).toHaveLength(64);
    for (const caps of [plain100, color100]) {
      const lines = stripAnsi(renderRefusalBlock(g3, caps, "beat")).split("\n");
      expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100);
      expect(lines[0]).toBe(passRefused("ReceiverMismatch"));
      expect(lines[1]).toBe(`${" ".repeat(98 - `breaks RECEIVER · ${longReceiver}`.length)}breaks RECEIVER · ${longReceiver}`);
      expect(displayWidth(lines[1])).toBe(98);
      // the body follows untouched
      expect(lines.slice(2).map((l) => l.slice(4)).join("")).toBe(raw(hero[2]));
    }
  });

  it("a receiver that fits keeps the tag on row 1, ending on column 98", () => {
    const lines = renderRefusalBlock(withAttempt(hero[2], { receiverId: "kh-9z8y.sputnik-v2.testnet" }), plain100, "beat").split("\n");
    expect(lines[0]).toMatch(/^PASS: refused by protocol \(ReceiverMismatch\) +breaks RECEIVER · kh-9z8y\.sputnik-v2\.testnet$/);
    expect(displayWidth(lines[0])).toBe(98);
  });

  it("the exact fit and the first overflow: 98 cells, then 99", () => {
    const verdict = passRefused("ReceiverMismatch");
    // verdict + 2 spaces + "breaks RECEIVER · " (18) + id: 98 cells at id = 98 - 2 - 18 - verdict.length
    const fit = "y".repeat(98 - 2 - 18 - verdict.length);
    const exact = renderRefusalBlock(withAttempt(hero[2], { receiverId: fit }), plain100, "beat").split("\n");
    expect(displayWidth(exact[0])).toBe(98);
    expect(exact[0]).toBe(`${verdict}  breaks RECEIVER · ${fit}`);
    const over = renderRefusalBlock(withAttempt(hero[2], { receiverId: `${fit}z` }), plain100, "beat").split("\n");
    expect(over[0]).toBe(verdict);
    expect(over[1].trimStart()).toBe(`breaks RECEIVER · ${fit}z`);
  });
});

describe("renderRefusalBlock: SignerDoesNotExist is a burn proof only in the burn and smoke phases (C-T2k)", () => {
  const body = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"SignerDoesNotExist":{"signer_id":"ks-7f3a.op.sandbox"}}}}},"id":"x"}';
  const burn = run.steps.find((s) => s.phase === "burn")!;

  it.each(["burn", "smoke"] as const)("phase %s: the PASS line and the note, in both styles", (phase) => {
    for (const style of ["full", "beat"] as const) {
      const text = renderRefusalBlock(stepFromBody({ ...burn, phase }, body), plain100, style);
      expect(text).toContain("PASS: refused by protocol (SignerDoesNotExist)");
      expect(text).toContain(NOTE_SIGNER_GONE);
      expect(text).not.toContain("chain rejected");
    }
  });

  it.each(["setup", "wrap", "in-scope", "refusals", "chain-check", "inspect"] as const)("phase %s: it is a chain rejection, with no PASS line and no note", (phase) => {
    for (const style of ["full", "beat"] as const) {
      for (const caps of [plain100, color100]) {
        const text = stripAnsi(renderRefusalBlock(stepFromBody({ ...burn, phase }, body), caps, style));
        expect(text).toContain("chain rejected the tx: SignerDoesNotExist");
        expect(text).not.toMatch(/PASS|refused by protocol|breaks/);
        expect(text).not.toContain(NOTE_SIGNER_GONE);
      }
    }
  });
});

describe("renderRefusalBlock: a refusal that is not the key's scope (C-T2k)", () => {
  const named = (variant: string): string =>
    `{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":${variant}}}},"id":"x"}`;

  it.each([
    ["Expired", '"Expired"'],
    ["InvalidSignerId", '{"InvalidSignerId":{"signer_id":"a b"}}'],
    ["NotEnoughBalance", '{"NotEnoughBalance":{"signer_id":"a.sandbox","balance":"1","cost":"2"}}'],
    ["InvalidNonce", '{"InvalidNonce":{"tx_nonce":5,"ak_nonce":9}}'],
  ])("%s: the chain rejected the tx, in every phase and both styles", (name, variant) => {
    for (const phase of ["refusals", "burn", "smoke", "in-scope"] as const) {
      const s = stepFromBody({ ...hero[0], phase }, named(variant));
      const o = s.attempt!.outcome;
      expect(o.kind === "Refusal" && [o.errorName, o.family]).toEqual([name, "InvalidTxError"]);
      for (const style of ["full", "beat"] as const) {
        const text = renderRefusalBlock(s, plain100, style);
        expect(text).toContain(`chain rejected the tx: ${name}`);
        expect(text).not.toMatch(/PASS|refused by protocol|breaks|scope|cage/i);
        expect(text).not.toContain(NOTE_SIGNER_GONE);
      }
    }
  });

  // The chain rejected the tx for another reason: family is plain InvalidTxError, not InvalidAccessKeyError.
  const body = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"tx_nonce":5,"ak_nonce":9}}}}},"id":"x"}';
  const rejected = stepFromBody(g1, body);

  it("the parsed refusal is a plain InvalidTxError (the premise of these tests)", () => {
    const o = rejected.attempt!.outcome;
    expect(o.kind === "Refusal" && o.family).toBe("InvalidTxError");
    expect(o.kind === "Refusal" && o.errorName).toBe("InvalidNonce");
  });

  it.each(["full", "beat"] as const)("%s style says the chain rejected the tx and never claims the scope refused it", (style) => {
    const text = renderRefusalBlock(rejected, plain100, style);
    expect(text).toContain("chain rejected the tx: InvalidNonce");
    expect(chainRejected("InvalidNonce")).toBe("chain rejected the tx: InvalidNonce");
    expect(text).not.toMatch(/refused by protocol/);
    expect(text).not.toMatch(/PASS/);
    expect(text).not.toMatch(/breaks|METHOD|ACTIONS|RECEIVER|DEPOSIT|GAS/);
    expect(text).not.toMatch(/scope|cage/i);
    // the body is still shown verbatim
    const prefix = style === "full" ? "        | " : "    ";
    const rows = text.split("\n").filter((l) => l.startsWith(prefix) && !l.includes("chain rejected"));
    expect(rows.map((l) => l.slice(prefix.length)).join("")).toContain('"InvalidNonce"');
  });

  it("the full ledger names the plain path and the raw rows join to the body", () => {
    const lines = renderRefusalBlock(rejected, plain100, "full").split("\n");
    expect(lines.at(-1)).toBe("        reached block: no · on-chain tx: none · InvalidTxError › InvalidNonce");
    expect(lines.filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(body);
  });

  it("an unexpected rejection that fails its step also prints the FAIL note", () => {
    const note = failExpected("MethodNameMismatch", "InvalidNonce");
    const text = renderRefusalBlock({ ...rejected, pass: false, note }, plain100, "full");
    expect(text).toContain("chain rejected the tx: InvalidNonce");
    expect(text).toContain(note);
    expect(text).not.toContain("refused by protocol");
  });
});

describe("renderRefusalBlock: chain-sourced text is neutralized (C-T6d)", () => {
  const hostileName = "Evil\x1b[31m\nPASS: refused by protocol (Fake)";
  const body = JSON.stringify({ jsonrpc: "2.0", error: { data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { [hostileName]: {} } } } } }, id: "x" });
  const hostile = stepFromBody(g1, body);

  it("parseRefusal decodes the escape into a real control character (the premise)", () => {
    const o = hostile.attempt!.outcome;
    expect(o.kind === "Refusal" && o.errorName).toContain(ESC);
  });

  it.each(["full", "beat"] as const)("%s: a hostile error name prints as visible text, one physical line, no escape", (style) => {
    for (const caps of [plain100, color100]) {
      const text = renderRefusalBlock(hostile, caps, style);
      expect(stripAnsi(text)).not.toContain(ESC);
      expect(stripAnsi(text)).not.toContain("\r");
      expect(stripAnsi(text)).toContain("Evil\\u001b[31m\\u000aPASS: refused by protocol (Fake)");
      // no line of ours is forged by the embedded LF: every PASS line starts with the verdict, exactly once
      const passLines = stripAnsi(text).split("\n").filter((l) => /^ *PASS: refused by protocol/.test(l));
      expect(passLines).toHaveLength(1);
      if (caps.color) expectBalanced(text);
    }
  });

  it.each(["full", "beat"] as const)("%s: a hostile method, receiver, label, fixture and note print as visible text", (style) => {
    const evil = "x\x1b]8;;http://evil\x07y\r\nFAKE";
    const shown = "x\\u001b]8;;http://evil\\u0007y\\u000d\\u000aFAKE";
    const s = withAttempt({ ...g1, label: evil, fixture: evil, note: evil }, { method: evil, receiverId: evil });
    for (const caps of [plain100, color100]) {
      const text = renderRefusalBlock(s, caps, style);
      const plain = stripAnsi(text);
      expect(plain).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
      expect(plain.split("\n").every((l) => !l.startsWith("FAKE"))).toBe(true);
      if (style === "full") {
        expect(plain).toContain(`ATTEMPT  ${shown}  ("${shown}")`);
        expect(plain).toContain("rpc      response body, verbatim");
        expect(plain).toContain(`· demo/fixtures/${shown}`); // 104 cells in one piece: the path takes the next row (C-T14b)
        expect(plain).toContain(`FunctionCall ${shown} ${caps.unicode ? "→" : "->"} ${shown}`);
        expect(plain).toContain(`        ${shown}`); // the note, as visible text
      } else {
        expect(plain).toContain(`breaks METHOD · ${shown}`);
        expect(plain).toContain(shown);
      }
      if (caps.color) expectBalanced(text);
    }
  });

  it("a hostile path element and a hostile panic message in a landed body are neutralized too", () => {
    const evil = "p\x1b[2Jq";
    const s: DemoStep = { ...g1, attempt: { ...g1.attempt!, outcome: { kind: "ContractPanic", txHash: "H\x1b[0m", message: evil, rawRpcJson: '{"x":1}' } }, pass: false, note: failExpected("MethodNameMismatch", "no refusal (landed: ContractPanic)") };
    const text = renderRefusalBlock(s, plain100, "full");
    expect(text).not.toContain(ESC);
    expect(text).toContain("on-chain tx: H\\u001b[0m");
    const r = parseRefusal('{"error":{"data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"A\\u001bB":{}}}}}}}')!;
    expect(r.path[2]).toContain(ESC);
    const t = renderRefusalBlock({ ...g1, attempt: { ...g1.attempt!, outcome: r } }, plain100, "full");
    expect(t).not.toContain(ESC);
    expect(t.split("\n").at(-1)).toBe("        reached block: no · on-chain tx: none · InvalidTxError › InvalidAccessKeyError › A\\u001bB");
  });
});
