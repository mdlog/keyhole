/**
 * Task 18: `keyhole wrap` (LAYOUT R2, DESIGN §5.1–5.2) offline, with fake CONTRACT functions (createWrapCommand).
 * planWrap and signWrap are fakes; the PREVIEW card is the real buildCageCard ("preview" opens no socket) and the
 * real renderer. The argument checks of the scaffold (T9, one line per problem, unknown flags) live in
 * test/cli.test.ts and must stay green unchanged.
 *
 * Expected strings are written out from the brief, LAYOUT R2 and strings.ts, never computed with the code under test.
 * No private key appears here: the session public key is the spike's (public), and keys are never printed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Command, Io } from "../src/cli/args.js";
import { main } from "../src/cli/main.js";
import { sessionHint } from "../src/cli/demo.js";
import { NOT_SIGNED, NOT_SIGNED_NON_TTY, type WrapDeps, confirmPrompt, createWrapCommand } from "../src/cli/wrap.js";
import { fullAccessKeyLoadCount } from "../src/core/credentials.js";
import { EnvironmentError, KeyholeError, TxSentError } from "../src/core/errors.js";
import { dropHeldKeys, heldPrivateKeyCount } from "../src/core/keys.js";
import { SendFateUnknownError } from "../src/core/tx.js";
import type { Session, ToolSchema, WrapOptions, WrapPlan } from "../src/core/types.js";
import { EXPOSURE_SUBACCOUNT, MAINNET_OUT_OF_SCOPE, exposureOnAccount, exposureVote, warnRuntime } from "../src/render/strings.js";
import { stripAnsi } from "../src/render/style.js";
import { REPO, sampleCageCard, sampleSession } from "./helpers.js";

const PIN = "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq";
const PUB = sampleSession().publicKey; // the spike's session key: public
const TX = "3vXgkD1mDuN7oVZ3aWpTyJhXrB8xg7QhN6zZ2bYk1Ut4";

afterEach(() => {
  dropHeldKeys();
  vi.unstubAllEnvs();
});

/** The hero plan as planWrap returns it (on-account, sputnik-v2): two views, dao_vote callable, add_proposal not in allowlist. */
function heroPlan(over: Partial<WrapPlan> = {}, draft: Partial<WrapPlan["draft"]> = {}): WrapPlan {
  const tools: ToolSchema[] = sampleCageCard().tools;
  return {
    draft: {
      id: "ks-7f3a",
      mode: "on-account",
      network: "sandbox",
      accountId: "seat.sandbox",
      receiverId: "dao.sandbox",
      methodNames: ["act_proposal"],
      allowanceYocto: "50000000000000000000000",
      codeHashPin: PIN,
      publicKey: PUB,
      packId: "sputnik-v2",
      tools,
      ...draft,
    },
    txActions: ["+ AddKey FunctionCall → seat.sandbox · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR"],
    tools,
    warnings: [],
    signerId: "seat.sandbox",
    fundingYocto: null,
    dryRunMs: 9400,
    ...over,
  };
}

/** The sub-account plan for the same scope: ks-7f3a.op.sandbox, created and funded by op.sandbox. */
function subPlan(): WrapPlan {
  return heroPlan(
    {
      signerId: "op.sandbox",
      fundingYocto: "60000000000000000000000",
      txActions: [
        "+ CreateAccount ks-7f3a.op.sandbox (sub-account of op.sandbox) · account creation ≈0.007 NEAR (gas, NEP-642)",
        "+ Transfer 0.0600 NEAR → ks-7f3a.op.sandbox · gas allowance 0.0500 + reserve 0.0100 (storage)",
        "+ AddKey FullAccess (operator) → ks-7f3a.op.sandbox · op.sandbox's full-access key; keyhole burn deletes the account with it",
        "+ AddKey FunctionCall → ks-7f3a.op.sandbox · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR",
      ],
    },
    { mode: "subaccount", accountId: "ks-7f3a.op.sandbox" },
  );
}

/** The live session signWrap returns for a plan. */
const signed = (plan: WrapPlan): Session => ({ ...plan.draft, methodNames: [...plan.draft.methodNames], createdAt: "2026-11-06T10:00:00.000Z", status: "live" });

/** Fakes for every CONTRACT function wrap calls; buildCageCard and loadTargetPack stay real (no socket). */
function fakes(plan: WrapPlan = heroPlan()) {
  return {
    planWrap: vi.fn<WrapDeps["planWrap"]>(async () => plan),
    signWrap: vi.fn<WrapDeps["signWrap"]>(async (p) => ({ session: signed(p), txHash: TX })),
  };
}

/** A terminal: stdout as one text (out adds a newline, write does not), stderr lines, a scripted stdin. */
function term(opts: { stdinIsTTY?: boolean; answers?: Array<string | null>; env?: NodeJS.ProcessEnv; stdout?: Io["stdout"]; signal?: AbortSignal } = {}) {
  const stdout: string[] = [];
  const err: string[] = [];
  let words: (() => string) | undefined;
  const wordsLog: Array<"set" | "clear"> = [];
  const answers = [...(opts.answers ?? [])];
  const readLine = vi.fn(async () => (answers.length ? (answers.shift() ?? null) : null));
  const io: Io = {
    out: (t) => void stdout.push(`${t}\n`),
    err: (t) => void err.push(t),
    write: (t) => void stdout.push(t),
    stdinIsTTY: opts.stdinIsTTY ?? true,
    readLine,
    env: opts.env ?? {},
    ...(opts.stdout ? { stdout: opts.stdout } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    lastWords: (w) => {
      words = w;
      wordsLog.push(w ? "set" : "clear");
    },
  };
  /** words(): what the hard exit (a repeat signal) would write now; wordsLog: each set and clear, in order. */
  return { io, readLine, text: () => stdout.join(""), err: () => err.join("\n"), words: () => words?.(), wordsLog };
}

/** Runs a command as main does: a KeyholeError prints its line on stderr and sets the exit code. */
async function exec(cmd: Command, argv: string[], io: Io): Promise<number> {
  try {
    return await cmd.run(argv, io);
  } catch (e) {
    if (e instanceof KeyholeError) {
      io.err(e.line());
      return e.exitCode;
    }
    throw e;
  }
}

const HERO = ["dao.sandbox", "--allow", "act_proposal", "--gas", "0.05N", "--on-account", "seat.sandbox"];

describe("keyhole wrap: refused before anything is read (exit 2, nothing signed)", () => {
  it("a mainnet CONTRACT is out of scope, through the real command (main)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (t) => void out.push(t), err: (t) => void err.push(t) };
    const code = await main(["wrap", "alice.near", "--allow", "act_proposal", "--gas", "0.05N"], io, {});
    expect({ code, out: out.join("\n"), err: err.join("\n") }).toMatchObject({ code: 2, out: "", err: `ERROR (input): ${MAINNET_OUT_OF_SCOPE}` });
  });

  it("wrap alice.near is refused before any key load: planWrap is never called", async () => {
    const f = fakes();
    const loads = fullAccessKeyLoadCount();
    const t = term();
    expect(await exec(createWrapCommand(f), ["alice.near", "--allow", "act_proposal", "--gas", "0.05N"], t.io)).toBe(2);
    expect(t.err()).toBe(`ERROR (input): ${MAINNET_OUT_OF_SCOPE}`);
    expect(t.text()).toBe("");
    expect(f.planWrap).not.toHaveBeenCalled();
    expect(f.signWrap).not.toHaveBeenCalled();
    expect(fullAccessKeyLoadCount()).toBe(loads);
  });

  it("C-T1c: a malformed CONTRACT keeps its own input error (no mainnet line on top)", async () => {
    const t = term();
    expect(await exec(createWrapCommand(fakes()), ["Alice.near", "--allow", "act_proposal", "--gas", "0.05N"], t.io)).toBe(2);
    expect(t.err()).toBe('ERROR (input): CONTRACT "Alice.near" is not a NEAR account id');
  });

  it("the mainnet check runs only once the argument list is clean: other problems are reported alone", async () => {
    const t = term();
    expect(await exec(createWrapCommand(fakes()), ["alice.near", "--allow", "act_proposal"], t.io)).toBe(2);
    expect(t.err()).toBe("ERROR (input): allowance must be explicit and non-zero (T9)");
  });

  it("sub-account mode without KEYHOLE_OPERATOR is an input error naming KEYHOLE_OPERATOR and --on-account", async () => {
    const f = fakes();
    const t = term({ env: {} });
    expect(await exec(createWrapCommand(f), ["dao.sandbox", "--allow", "act_proposal", "--gas", "0.05N"], t.io)).toBe(2);
    expect(t.err()).toMatch(/^ERROR \(input\): /);
    expect(t.err()).toContain("KEYHOLE_OPERATOR");
    expect(t.err()).toContain("--on-account");
    expect(f.planWrap).not.toHaveBeenCalled();
  });

  it("C-T4b: an allowance that is not a whole number of 0.0001 NEAR steps is refused in NEAR only (0.05005 NEAR)", async () => {
    const f = fakes();
    const t = term();
    expect(await exec(createWrapCommand(f), ["dao.sandbox", "--allow", "act_proposal", "--gas", "0.05005N", "--on-account", "seat.sandbox"], t.io)).toBe(2);
    expect(t.err()).toMatch(/^ERROR \(input\): /);
    expect(t.err()).toContain("allowance must be a whole multiple of 0.0001 NEAR");
    expect(t.err()).not.toMatch(/10\^20|10²⁰|yocto/);
    expect(f.planWrap).not.toHaveBeenCalled();
    // A whole number of steps passes the check.
    const ok = fakes();
    expect(await exec(createWrapCommand(ok), ["dao.sandbox", "--allow", "act_proposal", "--gas", "0.0501N", "--on-account", "seat.sandbox"], term({ answers: ["no"] }).io)).toBe(1);
    expect(ok.planWrap).toHaveBeenCalledTimes(1);
  });
});

describe("keyhole wrap: what planWrap is asked", () => {
  it("on-account: the CONTRACT suffix picks the network; the allow list, the allowance in yocto and the account pass through", async () => {
    const f = fakes();
    await exec(createWrapCommand(f), ["kh-1a2b.sputnik-v2.testnet", "--allow", "act_proposal", "--gas", "0.05N", "--on-account", "seat.kh-op.testnet"], term({ answers: ["no"] }).io);
    expect(f.planWrap).toHaveBeenCalledTimes(1);
    expect(f.planWrap.mock.calls[0][0]).toEqual({
      contract: "kh-1a2b.sputnik-v2.testnet",
      allow: ["act_proposal"],
      allowanceYocto: "50000000000000000000000",
      onAccount: "seat.kh-op.testnet",
      network: "testnet",
    } satisfies WrapOptions);
  });

  it("sub-account: the operator comes from KEYHOLE_OPERATOR in the command's env", async () => {
    const f = fakes(subPlan());
    await exec(createWrapCommand(f), ["dao.sandbox", "--allow", "act_proposal", "--gas", "0.05N"], term({ answers: ["no"], env: { KEYHOLE_OPERATOR: "op.sandbox" } }).io);
    expect(f.planWrap.mock.calls[0][0]).toEqual({ contract: "dao.sandbox", allow: ["act_proposal"], allowanceYocto: "50000000000000000000000", network: "sandbox", operatorId: "op.sandbox" });
  });
});

describe("keyhole wrap: the preview (LAYOUT R2 blocks 1–7)", () => {
  async function preview(plan = heroPlan(), env: NodeJS.ProcessEnv = {}) {
    const f = fakes(plan);
    const t = term({ answers: ["no"], env });
    const code = await exec(createWrapCommand(f), plan.draft.mode === "subaccount" ? ["dao.sandbox", "--allow", "act_proposal", "--gas", "0.05N"] : HERO, t.io);
    return { code, text: t.text(), lines: t.text().split("\n"), f, t };
  }

  it("preview blocks print in order and end with the typed prompt", async () => {
    const f = fakes();
    const t = term({ answers: [] });
    const readLine = vi.fn(async () => {
      // When the prompt is waiting, it is the last thing on stdout: one space after it, no newline.
      expect(t.text().endsWith(`${confirmPrompt("seat.sandbox")} `)).toBe(true);
      return "no";
    });
    t.io.readLine = readLine;
    await exec(createWrapCommand(f), HERO, t.io);
    expect(readLine).toHaveBeenCalledTimes(1);
    const lines = t.text().split("\n");
    const at = (pred: (l: string) => boolean, what: string): number => {
      const i = lines.findIndex(pred);
      expect(i, what).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at((l) => l === "KEYHOLE wrap · sandbox · on-account · pack sputnik-v2 (pack-json)", "header"),
      at((l) => l === `receiver  dao.sandbox · code_hash ${PIN} (view_account) — will be pinned`, "pre-flight receiver"),
      at((l) => l === "signer    seat.sandbox full-access key (keychain) — signs this 1 tx; serve never sees it", "pre-flight signer"),
      at((l) => l === "dry-run   near-sandbox · 2 methods classified · 9.4 s", "pre-flight dry-run"),
      at((l) => l.includes("[PREVIEW]"), "the PREVIEW card"),
      at((l) => l.startsWith("EXPOSURE  "), "EXPOSURE"),
      at((l) => l === "TX PLAN", "TX PLAN"),
      at((l) => l.startsWith("+ AddKey FunctionCall -> seat.sandbox · "), "the + line"),
      at((l) => l.startsWith(confirmPrompt("seat.sandbox")), "the prompt"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 107 columns at the default width of 100: the + line wraps once, at a space, and nothing is cut.
    expect(`${lines[order[7]]} ${lines[order[7] + 1].trimStart()}`).toBe("+ AddKey FunctionCall -> seat.sandbox · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR");
    expect(order[1]).toBe(order[0] + 1); // the three pre-flight lines follow the header
    expect(order[3]).toBe(order[0] + 3);
    expect(f.planWrap).toHaveBeenCalledTimes(1);
    expect(f.signWrap).not.toHaveBeenCalled();
  });

  it("the card is the PREVIEW plate: requested scope, nothing signed, the pin in full, no WARN for the hero", async () => {
    const { text } = await preview();
    expect(text).toContain("PREVIEW · nothing signed · requested scope + sandbox dry-run");
    expect(text).toContain(PIN);
    expect(text).toContain("0.0500 NEAR requested");
    expect(text).not.toContain("WARN");
    expect(text).not.toContain("[LIVE]");
  });

  it("EXPOSURE: a VOTE pack on-account gets exposureVote, word for word (wrapped at the width, never cut)", async () => {
    const { text } = await preview();
    const flat = text.replace(/\n {10}/g, " ");
    expect(flat).toContain(`EXPOSURE  ${exposureVote("seat.sandbox", "act_proposal", "dao.sandbox")}`);
    const exposure = text.split("\n").filter((l, i, all) => l.startsWith("EXPOSURE  ") || (i > 0 && l.startsWith("          ") && all[i - 1].length > 0));
    expect(exposure.length).toBeGreaterThan(1); // it is longer than 100 columns, so it wraps
    for (const l of exposure) expect(l.length, l).toBeLessThanOrEqual(100);
  });

  it("EXPOSURE: a VALUE pack on-account gets exposureOnAccount with every method", async () => {
    const plan = heroPlan({}, { packId: "counter", receiverId: "counter.sandbox", methodNames: ["increment", "reset"] });
    const { text } = await preview(plan);
    expect(text.replace(/\n {10}/g, " ")).toContain(`EXPOSURE  ${exposureOnAccount("seat.sandbox", "increment, reset", "counter.sandbox")}`);
    expect(text).toContain("KEYHOLE wrap · sandbox · on-account · pack counter (near-abi)");
  });

  it("sub-account: header, the operator signs, EXPOSURE_SUBACCOUNT, four + lines, the prompt names the operator", async () => {
    const { text, lines } = await preview(subPlan(), { KEYHOLE_OPERATOR: "op.sandbox" });
    expect(lines[0]).toBe("KEYHOLE wrap · sandbox · sub-account · pack sputnik-v2 (pack-json)");
    expect(lines).toContain("signer    op.sandbox full-access key (keychain) — signs this 1 tx; serve never sees it");
    expect(text.replace(/\n {10}/g, " ")).toContain(`EXPOSURE  ${EXPOSURE_SUBACCOUNT}`);
    const plus = lines.filter((l) => l.startsWith("+ "));
    expect(plus.map((l) => l.split(" ")[1])).toEqual(["CreateAccount", "Transfer", "AddKey", "AddKey"]);
    expect(text).toContain(confirmPrompt("op.sandbox"));
  });

  it("WARN lines: one per warning, the raw panic text (evidence) on the next line, indented", async () => {
    const tools = heroPlan().tools.map((t) =>
      t.method === "add_proposal" ? { ...t, classification: "fails-without-deposit (runtime)" as const, evidence: "Smart contract panicked: ERR_MIN_BOND" } : t,
    );
    const plan = heroPlan({ tools, warnings: [warnRuntime("add_proposal")] }, { tools, methodNames: ["act_proposal", "add_proposal"] });
    const { lines } = await preview(plan);
    const at = lines.indexOf(warnRuntime("add_proposal"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe("      Smart contract panicked: ERR_MIN_BOND");
    expect(lines.findIndex((l) => l.includes("[PREVIEW]"))).toBeLessThan(at);
    expect(lines.findIndex((l) => l.startsWith("EXPOSURE  "))).toBeGreaterThan(at);
  });

  it("C-T5b: the dry-run count is planWrap's tools, never the card's synthetic chain rows", async () => {
    // methodNames lists a method no tool covers: the preview card adds a `chain:sweep_all` row, which is not a tool.
    const plan = heroPlan({}, { methodNames: ["act_proposal", "sweep_all"] });
    const { text, lines } = await preview(plan);
    expect(text).toContain("sweep_all"); // the card shows the row
    expect(lines).toContain("dry-run   near-sandbox · 2 methods classified · 9.4 s");
  });

  it("TX PLAN arrows follow the glyphs: `->` in plain output, `→` on a UTF-8 color TTY (and stripping the color gives the same text)", async () => {
    const f = fakes();
    const t = term({ answers: ["no"], stdout: { isTTY: true, columns: 120 }, env: { LANG: "en_US.UTF-8", TERM: "xterm-256color" } });
    await exec(createWrapCommand(f), HERO, t.io);
    const plain = stripAnsi(t.text());
    expect(t.text()).not.toBe(plain); // it was colored
    // M6 (LAYOUT R2 loading state): one in-place progress line while planWrap runs, erased before block 1.
    expect(t.text().startsWith("dry-run  booting near-sandbox…\r\x1b[2K")).toBe(true);
    expect(plain.split("\n")[0]).toBe("dry-run  booting near-sandbox…\rKEYHOLE wrap · sandbox · on-account · pack sputnik-v2 (pack-json)");
    expect(plain.split("\n")).toContain("+ AddKey FunctionCall → seat.sandbox · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR");
  });

  it("a TX PLAN line wider than the terminal wraps with a 4-space hanging indent, nothing cut", async () => {
    const f = fakes();
    const t = term({ answers: ["no"], env: { COLUMNS: "80" } });
    await exec(createWrapCommand(f), HERO, t.io);
    const lines = t.text().split("\n");
    const at = lines.findIndex((l) => l.startsWith("+ AddKey"));
    expect(lines[at].length).toBeLessThanOrEqual(80);
    expect(lines[at + 1].startsWith("    ")).toBe(true);
    expect(`${lines[at]} ${lines[at + 1].trimStart()}`).toBe("+ AddKey FunctionCall -> seat.sandbox · receiver dao.sandbox · methods act_proposal · allowance 0.0500 NEAR");
  });
});

describe("keyhole wrap: the typed confirm (only the exact word yes signs)", () => {
  it.each([
    ["y", 1, NOT_SIGNED],
    ["", 1, NOT_SIGNED],
    ["YES", 1, NOT_SIGNED],
    ["yes ", 1, NOT_SIGNED],
    ["yes", 0, null],
  ] as const)("answer %j → exit %i", async (answer, code, line) => {
    const f = fakes();
    const t = term({ answers: [answer] });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(code);
    expect(f.signWrap).toHaveBeenCalledTimes(answer === "yes" ? 1 : 0);
    if (line !== null) expect(t.text().split("\n").at(-2)).toBe(line);
  });

  it("non-TTY stdin never blocks: NOT_SIGNED_NON_TTY, exit 2, nothing signed, stdin never read", async () => {
    const f = fakes();
    const t = term({ stdinIsTTY: false, answers: ["yes"] });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(2);
    expect(t.readLine).not.toHaveBeenCalled();
    expect(f.signWrap).not.toHaveBeenCalled();
    expect(t.text().trimEnd().split("\n").at(-1)).toBe(NOT_SIGNED_NON_TTY);
    expect(t.text()).toContain("[PREVIEW]"); // the preview is still shown
  });

  it("no readLine at all counts as non-interactive (exit 2)", async () => {
    const f = fakes();
    const t = term();
    delete t.io.readLine;
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(2);
    expect(t.text()).toContain(NOT_SIGNED_NON_TTY);
    expect(f.signWrap).not.toHaveBeenCalled();
  });

  it("end of input at the prompt is not a yes: not signed, exit 1", async () => {
    const f = fakes();
    const t = term({ answers: [null] });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(1);
    expect(f.signWrap).not.toHaveBeenCalled();
  });

  it("M1: Ctrl-C while the real prompt waits: the signal is read before the prompt, so the handler is in place; not signed, exit 130", async () => {
    // processIo's `signal` is a getter that installs the SIGINT handler on first use (main.ts sigintSignal). Modelled
    // here: a Ctrl-C before that first use is Node's default (the read just ends: no abort is seen); after it, the
    // handler aborts the signal and the pending read settles with null.
    const f = fakes();
    const t = term();
    let handler: AbortController | undefined;
    let readsBeforeHandler = 0;
    Object.defineProperty(t.io, "signal", {
      get: () => {
        handler ??= new AbortController();
        return handler.signal;
      },
    });
    t.io.readLine = vi.fn(async () => {
      if (!handler) readsBeforeHandler++;
      return new Promise<string | null>((resolve) =>
        setTimeout(() => {
          handler?.abort(); // the user presses Ctrl-C while the prompt waits
          resolve(null);
        }, 0),
      );
    });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(130);
    expect(readsBeforeHandler).toBe(0);
    expect(t.text().split("\n").at(-2)).toBe(NOT_SIGNED);
    expect(f.signWrap).not.toHaveBeenCalled();
  });

  it("M2d: `yes` with the signal already aborted does not sign (Ctrl-C wins), exit 130", async () => {
    const f = fakes();
    const ctrl = new AbortController();
    ctrl.abort();
    const t = term({ answers: ["yes"], signal: ctrl.signal });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(130);
    expect(f.signWrap).not.toHaveBeenCalled();
  });

  it("a Ctrl-C while signing cannot recall the tx: the result is printed whole (the session to burn), then exit 130", async () => {
    const f = fakes();
    const ctrl = new AbortController();
    f.signWrap.mockImplementationOnce(async (p) => {
      ctrl.abort();
      return { session: signed(p), txHash: TX };
    });
    const t = term({ answers: ["yes"], signal: ctrl.signal });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(130);
    expect(t.text().split("\n")).toContain(`tx ${TX} · final · sandbox (no explorer)`);
    expect(t.text().split("\n")).toContain("  keyhole burn ks-7f3a");
  });

  // C-T18d: the signal is read before the dry-run, which boots a near-sandbox: processIo installs its SIGINT handler on
  // first use, so reading it only at the prompt left a Ctrl-C during the dry-run to Node's default kill.
  it("C-T18d: io.signal is read before planWrap runs (the dry-run), not first at the prompt", async () => {
    const events: string[] = [];
    const f = fakes();
    f.planWrap.mockImplementationOnce(async () => (events.push("planWrap"), heroPlan()));
    const t = term({ answers: ["no"] });
    Object.defineProperty(t.io, "signal", { get: () => (events.push("signal read"), undefined) });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(1);
    expect(events[0]).toBe("signal read");
    expect(events.indexOf("signal read")).toBeLessThan(events.indexOf("planWrap"));
  });

  it("C-T18d: a Ctrl-C during the dry-run: it finishes, nothing is previewed, asked or signed; `not signed`, exit 130", async () => {
    const ctrl = new AbortController();
    const f = fakes();
    f.planWrap.mockImplementationOnce(async () => {
      ctrl.abort(); // the signal arrives while the sandbox is booting
      return heroPlan();
    });
    const t = term({ answers: ["yes"], signal: ctrl.signal });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(130);
    expect(t.text()).toBe("not signed\n");
    expect(t.readLine).not.toHaveBeenCalled();
    expect(f.signWrap).not.toHaveBeenCalled();
    expect(t.err()).toBe("");
  });

  it("C-T18d: a testnet TxLine is two rows of at most 100 cells, flush left: the URL, which holds the full hash, takes the second", async () => {
    const f = fakes();
    f.signWrap.mockImplementationOnce(async (p) => ({ session: { ...signed(p), network: "testnet" }, txHash: TX }));
    const t = term({ answers: ["yes"] });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(0);
    const lines = t.text().split("\n");
    const at = lines.indexOf(`tx ${TX.slice(0, 4)}...${TX.slice(-4)} · final`);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(`· https://testnet.nearblocks.io/txns/${TX}`);
    expect(lines.slice(at, at + 2).every((l) => l.length <= 100)).toBe(true);
    expect(lines[at + 2]).toMatch(/^session ks-7f3a · live · /);
  });

  it("M2c: stdinIsTTY unknown (undefined) counts as non-interactive: exit 2, stdin never read", async () => {
    const f = fakes();
    const t = term({ answers: ["yes"] });
    delete t.io.stdinIsTTY;
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(2);
    expect(t.readLine).not.toHaveBeenCalled();
    expect(f.signWrap).not.toHaveBeenCalled();
  });

  it("Ctrl-C at the prompt: exit 130, nothing signed", async () => {
    const f = fakes();
    const ctrl = new AbortController();
    ctrl.abort();
    const t = term({ answers: [null], signal: ctrl.signal });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(130);
    expect(f.signWrap).not.toHaveBeenCalled();
  });
});

describe("keyhole wrap: after yes (R2 blocks 8–9)", () => {
  it("signs the plan planWrap returned, then prints the TxLine, the session line, the full public key and NEXT", async () => {
    const plan = heroPlan();
    const f = fakes(plan);
    const env = { KEYHOLE_HOME: "/tmp/kh-home", KEYHOLE_CREDENTIALS_DIR: "/tmp/kh-creds" };
    const t = term({ answers: ["yes"], env });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(0);
    expect(f.signWrap).toHaveBeenCalledTimes(1);
    expect(f.signWrap.mock.calls[0][0]).toBe(plan);
    expect(f.signWrap.mock.calls[0][1]).toMatchObject({ env });
    const lines = t.text().split("\n");
    const tx = lines.indexOf(`tx ${TX} · final · sandbox (no explorer)`);
    expect(tx).toBeGreaterThan(lines.findIndex((l) => l.startsWith(confirmPrompt("seat.sandbox"))));
    expect(lines[tx + 1]).toBe("session ks-7f3a · live · /tmp/kh-home/sessions/ks-7f3a.json");
    expect(lines[tx + 2]).toBe(`key       ${PUB} · function-call key on seat.sandbox`);
    const next = lines.indexOf("NEXT");
    expect(next).toBeGreaterThan(tx);
    expect(lines.slice(next + 1, next + 5)).toEqual([
      "  keyhole serve ks-7f3a",
      `  attach: node ${join(REPO, "bin", "keyhole.mjs")} serve ks-7f3a (see examples/, optional)`,
      "  keyhole inspect ks-7f3a",
      "  keyhole burn ks-7f3a",
    ]);
  });

  it("a session file under the home directory prints as ~/.keyhole/sessions/ID.json", async () => {
    const { homedir } = await import("node:os");
    const t = term({ answers: ["yes"], env: { KEYHOLE_HOME: join(homedir(), ".keyhole") } });
    expect(await exec(createWrapCommand(fakes()), HERO, t.io)).toBe(0);
    expect(t.text().split("\n")).toContain("session ks-7f3a · live · ~/.keyhole/sessions/ks-7f3a.json");
  });

  it("a send whose fate is unknown exits 3: its line verbatim (the hash), then keyhole burn ID; no offline alternative (C-T2j)", async () => {
    const f = fakes();
    const fate = new SendFateUnknownError(TX, "seat.sandbox", "the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls");
    f.signWrap.mockRejectedValueOnce(fate); // signWrap rethrows it untouched
    const t = term({ answers: ["yes"] });
    const code = await exec(createWrapCommand(f), HERO, t.io);
    expect(code).toBe(3);
    expect(t.err().split("\n")).toEqual([fate.line(), sessionHint("ks-7f3a")]);
    expect(t.err()).toContain(`look tx ${TX} up on chain before signing anything again`);
    expect(t.err()).not.toContain("offline alternative");
    expect(f.signWrap).toHaveBeenCalledTimes(1); // never re-sent (C-T2i)
    expect(t.text()).not.toContain("session ks-7f3a · live");
  });

  it("an error that already names the session's burn (signWrap's kept error) gets no second hint; exit 3 stays 3", async () => {
    const f = fakes();
    const kept = new TxSentError("wrap: no transaction result · tx X · session ks-7f3a kept: the AddKey may be on chain", "look tx X up; then run keyhole burn ks-7f3a");
    f.signWrap.mockRejectedValueOnce(kept);
    const t = term({ answers: ["yes"] });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(3);
    expect(t.err()).toBe(kept.line());
  });

  it("an error before the send (nothing signed) is main's: exit 2, its line only", async () => {
    const f = fakes();
    const before = new EnvironmentError("seat.sandbox has no access key ed25519:x on sandbox", "check the signer account and the key it signs with");
    f.signWrap.mockRejectedValueOnce(before);
    const t = term({ answers: ["yes"] });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(2);
    expect(t.err()).toBe(before.line());
  });

  it("wrap loads no key itself: the preview holds none, and no full-access key is read before yes", async () => {
    const loads = fullAccessKeyLoadCount();
    const t = term({ answers: ["no"] });
    await exec(createWrapCommand(fakes()), HERO, t.io);
    expect(fullAccessKeyLoadCount()).toBe(loads);
    expect(heldPrivateKeyCount()).toBe(0);
  });
});

// A repeat signal after the first one's abort is the hard exit (src/cli/main.ts): main writes the command's last words
// on stderr, synchronously, then exits 130. wrap has something to say only while signWrap runs: the AddKey may be on
// chain, and the session's id is known (the plan's draft).
describe("keyhole wrap: the hard exit's last words while signWrap runs (M1)", () => {
  const STOPPED = "STOPPED during the AddKey · session ks-7f3a may still be live · run: keyhole burn ks-7f3a";

  it("set while signWrap runs, cleared once it returns; within 100 columns", async () => {
    const f = fakes();
    const t = term({ answers: ["yes"] });
    let during: string | undefined;
    f.signWrap.mockImplementationOnce(async (p) => {
      during = t.words();
      return { session: signed(p), txHash: TX };
    });
    expect(await exec(createWrapCommand(f), HERO, t.io)).toBe(0);
    expect(during).toBe(STOPPED);
    expect(STOPPED.length).toBeLessThanOrEqual(100);
    expect(t.words()).toBeUndefined();
    expect(t.wordsLog).toEqual(["set", "clear"]);
  });

  it("cleared after a send whose fate is unknown (exit 3) and after an error before the send; never set when nothing is signed", async () => {
    for (const error of [new SendFateUnknownError(TX, "seat.sandbox", "the node timed out"), new EnvironmentError("no access key", "check the signer")]) {
      const f = fakes();
      f.signWrap.mockRejectedValueOnce(error);
      const t = term({ answers: ["yes"] });
      await exec(createWrapCommand(f), HERO, t.io);
      expect(t.wordsLog).toEqual(["set", "clear"]);
    }
    const t = term({ answers: ["no"] });
    expect(await exec(createWrapCommand(fakes()), HERO, t.io)).toBe(1);
    expect(t.wordsLog).toEqual([]);
  });

  // The real handler, in a child process: `yes` at once, then a signWrap that takes 3 s, as a slow AddKey would.
  describe("in a child process (processIo, main's handler)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keyhole-wrap-sig-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const planFile = join(dir, "plan.json");
    writeFileSync(planFile, JSON.stringify(heroPlan()));
    const file = join(dir, "wrap-child.mts");
    writeFileSync(
      file,
      [
        `const { processIo } = await import(${JSON.stringify(join(REPO, "src/cli/main.ts"))});`,
        `const { createWrapCommand } = await import(${JSON.stringify(join(REPO, "src/cli/wrap.ts"))});`,
        'const { readFileSync } = await import("node:fs");',
        `const plan = JSON.parse(readFileSync(${JSON.stringify(planFile)}, "utf8"));`,
        "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));",
        "const signWrap = async (p: any) => {",
        "  await sleep(3000);",
        `  return { session: { ...p.draft, createdAt: "2026-11-06T10:00:00.000Z", status: "live" }, txHash: ${JSON.stringify(TX)} };`,
        "};",
        "const cmd = createWrapCommand({ planWrap: async () => plan, signWrap });",
        'const io = { ...processIo, stdinIsTTY: true, readLine: async () => "yes", get signal() { return processIo.signal; } };',
        `process.exitCode = await cmd.run(${JSON.stringify(HERO)}, io);`,
      ].join("\n"),
    );

    it.each([
      ["SIGTERM, then SIGTERM 300 ms later: the hard exit, its last words, exit 130", 300, "hard"],
      ["SIGTERM, then SIGTERM 10 ms later (the same Ctrl-C twice): the result prints whole, exit 130", 10, "soft"],
    ] as const)("%s", async (_what, gapMs, path) => {
      const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let sent = false;
      child.stderr.on("data", (d) => (err += String(d)));
      child.stdout.on("data", (d) => {
        out += String(d);
        if (!sent && out.includes(confirmPrompt("seat.sandbox"))) {
          sent = true; // `yes` is read at once: signWrap is running
          child.kill("SIGTERM"); // only the process this test started
          setTimeout(() => child.kill("SIGTERM"), gapMs);
        }
      });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => (child.kill("SIGKILL"), resolve({ code: null, signal: "SIGKILL" })), 15_000);
        child.on("exit", (code, sig) => (clearTimeout(timer), resolve({ code, signal: sig })));
      });
      expect(exit).toEqual({ code: 130, signal: null });
      if (path === "hard") {
        expect(err).toBe(`${STOPPED}\n`);
        expect(out).not.toContain("session ks-7f3a · live");
      } else {
        expect(err).toBe("");
        expect(out).toContain(`tx ${TX} · final · sandbox (no explorer)`);
        expect(out).toContain("session ks-7f3a · live");
      }
    });
  });
});
