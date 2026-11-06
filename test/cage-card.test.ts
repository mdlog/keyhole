/**
 * Task 7: the cage-card plate. renderCageCard (full, narrow, compact, mcp) and cageCardRows.
 *
 * Expected strings are written out by hand from the brief, DESIGN_BRIEF §5.1 and the controller rulings
 * (R16c, R19d, C-T6a, C-T6d, C-T6e), never computed with the code under test. The helper `plate` below
 * assembles a row from the column widths the brief fixes (LABEL 11, ENFORCED BY 21, VALUE = width - 40).
 */
import { describe, expect, it } from "vitest";
import type { CageCard, Classification, Network, ToolSchema } from "../src/core/types.js";
import { cageCardRows, renderCageCard } from "../src/render/cage-card.js";
import { displayWidth, stripAnsi } from "../src/render/style.js";
import { color100, plain100, plain80, sampleCageCard, sampleSession } from "./helpers.js";

const PUBKEY = "ed25519:6Cg1xR924ox82u6nKx1X3iDc2Xj3CVhEE4THQgKsmMr";
const PIN = "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq";
/** The sample's compact key line, 107 cells in ASCII: one row from 107 columns up. */
const KEY_LINE = `key ${PUBKEY} on seat.kh-op.testnet -> kh-1a2b.sputnik-v2.testnet`;
/** The same line below 107 columns: broken before ` on `, the rest hung at 8 columns (C-T16a). */
const KEY_ROWS = [`key ${PUBKEY}`, "        on seat.kh-op.testnet -> kh-1a2b.sputnik-v2.testnet"];
/** A compact card's row that starts with `label` (`may call`, `gas`, `code_hash`), wherever the key line ends. */
const compactRow = (text: string, label: string): string => text.split("\n").find((l) => l.startsWith(`${label} `))!;

/** One plate row in ASCII: `| ` LABEL(11) VALUE(v) 3 spaces ENFORCED BY(21) 2 spaces `|`. */
const plate = (label: string, value: string, enforcedBy: string, v = 58): string =>
  `| ${label.padEnd(11)}${value.padEnd(v)}   ${enforcedBy.padEnd(21)}  |`;

/** The VALUE cell of a plate row, trailing blanks removed. */
const valueCell = (line: string, v = 58): string => line.slice(13, 13 + v).trimEnd();

/** The VALUE cells of the row that carries `label` and every blank-labelled row after it, joined. */
function joinedValue(lines: string[], label: string, v = 58): string {
  const start = lines.findIndex((l) => l.slice(2, 13).trimEnd() === label);
  expect(start).toBeGreaterThan(0);
  let out = "";
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i].slice(2, 13).trim() !== "") break;
    out += valueCell(lines[i], v);
  }
  return out;
}

const tool = (name: string, method: string, classification: Classification, evidence?: string): ToolSchema => ({
  name,
  kind: "call",
  method,
  argsSchema: {},
  gasTGas: 30,
  classification,
  ...(evidence === undefined ? {} : { evidence }),
});

/** The sample card with its call tools replaced (the sample's two views stay). */
function withCalls(...calls: ToolSchema[]): CageCard {
  const base = sampleCageCard();
  return sampleCageCard({ tools: [...base.tools.filter((t) => t.kind !== "call"), ...calls] });
}

describe("renderCageCard · full at 100 columns (the brief's assertions)", () => {
  const full = (): string[] => renderCageCard(sampleCageCard(), "full", plain100).split("\n");

  it("fits the 14 x 98 plate", () => {
    expect(full().length).toBeLessThanOrEqual(14);
    expect(Math.max(...full().map(displayWidth))).toBeLessThanOrEqual(98);
  });

  it("title: id, network and the LIVE tag at top right", () => {
    expect(full()[0]).toMatch(/keyhole · cage card · ks-7f3a · testnet .*\[LIVE\] -\+$/); // ASCII caps
  });

  it("every label, in this order", () => {
    const LABELS = ["RECEIVER", "SIGNER", "METHOD", "ACTIONS", "DEPOSIT", "GAS", "CODE HASH", "VOTE", "EXPIRY", "KEY", "VIEWS"];
    const at = LABELS.map((l) => full().findIndex((x) => x.slice(2, 13).trimEnd() === l));
    expect(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1]))).toBe(true);
  });

  it("footer in the bottom border, right-aligned (R19d; supersedes the left-aligned regex of the brief)", () => {
    expect(full().at(-1)).toMatch(/^\+-+ read from chain: view_access_key · 2026-11-11T09:14:07Z -\+$/);
  });

  it("GAS row: 20-cell bar (16 filled), left of initial, gas only", () => {
    expect(full().find((l) => l.includes("GAS"))).toMatch(/################\.\.\.\. 0\.0412 of 0\.0500 NEAR left · gas only/);
  });

  it("the public key and the code hash are printed in full, never shortened", () => {
    expect(full().join("\n")).toContain(sampleCageCard().session.publicKey);
    expect(full().join("\n")).toContain(PIN);
  });

  it("color: PROTOCOL is inverse, and stripping the escapes gives the uncolored card byte for byte", () => {
    const styled = renderCageCard(sampleCageCard(), "full", color100);
    expect(styled).toContain("\x1b[7mPROTOCOL");
    expect(stripAnsi(styled)).toBe(renderCageCard(sampleCageCard(), "full", { ...color100, color: false }));
  });

  it("PREVIEW: tag, requested allowance, and the nothing-signed footer", () => {
    expect(renderCageCard(sampleCageCard({ source: "preview" }), "full", plain100)).toMatch(
      /\[PREVIEW\][\s\S]*requested · gas only[\s\S]*PREVIEW · nothing signed/,
    );
  });

  it("burned: the BURNED tag", () => {
    expect(renderCageCard(sampleCageCard({ key: null }), "full", plain100)).toContain("[BURNED]");
  });

  it("changed code: CHANGED, and serve refuses every call", () => {
    expect(renderCageCard(sampleCageCard({ codeHashNow: "3Zr8…" }), "full", plain100)).toContain("CHANGED — serve refuses every call");
  });
});

describe("renderCageCard · full: the hero plate, line by line", () => {
  const hero = (): string[] => renderCageCard(sampleCageCard(), "full", plain100).split("\n");

  it("is exactly 14 lines of 98 cells", () => {
    const lines = hero();
    expect(lines).toHaveLength(14);
    expect(lines.map(displayWidth)).toEqual(Array(14).fill(98));
  });

  it("borders: 45 rules after the title, 38 before the footer", () => {
    const lines = hero();
    expect(lines[0]).toBe(`+- keyhole · cage card · ks-7f3a · testnet ${"-".repeat(45)} [LIVE] -+`);
    expect(lines[13]).toBe(`+${"-".repeat(38)} read from chain: view_access_key · 2026-11-11T09:14:07Z -+`);
  });

  it("rows: label 11, value 58, enforced by 21; the PROTOCOL column forms the bars", () => {
    expect(hero().slice(1, 13)).toEqual([
      plate("RECEIVER", "kh-1a2b.sputnik-v2.testnet", "PROTOCOL"),
      plate("SIGNER", "seat.kh-op.testnet · on-account", "—"),
      plate("METHOD", "act_proposal ........ callable", "PROTOCOL"),
      plate("", "add_proposal ........ not in allowlist", "PROTOCOL"),
      plate("ACTIONS", "one FunctionCall per tx; no Transfer, no AddKey", "PROTOCOL"),
      plate("DEPOSIT", "0 only; methods that demand one fail at runtime", "PROTOCOL"),
      plate("GAS", "################.... 0.0412 of 0.0500 NEAR left · gas only", "PROTOCOL"),
      plate("CODE HASH", `${PIN} · match`, "KEYHOLE server-side"),
      plate("VOTE", "any proposal here, either way, until burn; quorum 2-of-2", "NOT A KEY LIMIT"),
      plate("EXPIRY", "none in the protocol; ends at keyhole burn ks-7f3a", "OPERATOR"),
      plate("KEY", PUBKEY, "—"),
      plate("VIEWS", "get_proposals, get_policy: read-only, no key needed", "—"),
    ]);
  });

  it("unicode caps: box rules, the right border, and a solid bar", () => {
    const u = renderCageCard(sampleCageCard(), "full", { ...plain100, unicode: true }).split("\n");
    expect(u[0].startsWith("┌─ keyhole · cage card · ks-7f3a · testnet ─")).toBe(true);
    expect(u[0].endsWith(" [LIVE] ─┐")).toBe(true);
    expect(u.at(-1)).toMatch(/^└─+ read from chain: view_access_key · 2026-11-11T09:14:07Z ─┘$/);
    expect(u.slice(1, 13).every((l) => l.startsWith("│ ") && l.endsWith("│"))).toBe(true);
    expect(u.find((l) => l.includes("GAS"))).toContain("████████████████──── 0.0412 of 0.0500 NEAR left · gas only");
    expect(u.find((l) => l.includes("act_proposal"))).toContain("act_proposal ········ callable");
    expect(u.map(displayWidth)).toEqual(Array(14).fill(98));
  });

  it("a sub-account card names the sub-account in SIGNER", () => {
    const sub = sampleCageCard({ session: sampleSession({ mode: "subaccount", network: "testnet", accountId: "ks-7f3a.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet" }) });
    const row = renderCageCard(sub, "full", plain100).split("\n").find((l) => l.slice(2, 13).trimEnd() === "SIGNER")!;
    expect(valueCell(row)).toBe("seat.kh-op.testnet · sub-account ks-7f3a"); // key.accountId (chain) wins over session.accountId
  });
});

describe("renderCageCard · what each row is built from", () => {
  it("METHOD: allowed first, then at most three out-of-scope, then +N more not in allowlist", () => {
    const card = withCalls(
      tool("a", "zeta_not_allowed", "not in allowlist"),
      tool("b", "act_proposal", "callable"),
      tool("c", "m3", "not in allowlist"),
      tool("d", "m4", "not in allowlist"),
      tool("e", "m5", "not in allowlist"),
      tool("f", "m6", "not in allowlist"),
    );
    const lines = renderCageCard(card, "full", plain100).split("\n");
    const methodRows = lines.slice(lines.findIndex((l) => l.slice(2, 13).trimEnd() === "METHOD")).slice(0, 5).map((l) => valueCell(l));
    expect(methodRows).toEqual([
      `act_proposal ${".".repeat(12)} callable`, // 8 dots for the longest name (16), plus the difference
      `zeta_not_allowed ${".".repeat(8)} not in allowlist`,
      `m3 ${".".repeat(22)} not in allowlist`,
      `m4 ${".".repeat(22)} not in allowlist`,
      "+2 more not in allowlist",
    ]);
  });

  it("METHOD: a name is never repeated, and 3 out-of-scope methods need no +N row", () => {
    const card = withCalls(tool("b", "act_proposal", "callable"), tool("b2", "act_proposal", "callable"), tool("c", "x1", "not in allowlist"), tool("d", "x2", "not in allowlist"), tool("e", "x3", "not in allowlist"));
    const text = renderCageCard(card, "full", plain100);
    expect(text.match(/act_proposal/g)).toHaveLength(1);
    expect(text).not.toContain("more not in allowlist");
  });

  it("GAS: the bar fills floor(20 x left / initial) cells", () => {
    const bar = (left: string): string => {
      const base = sampleCageCard();
      const card = sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: left } });
      return /GAS {8}(\S+) /.exec(renderCageCard(card, "full", plain100))![1];
    };
    expect(bar("50000000000000000000000")).toBe("#".repeat(20));
    expect(bar("49999999999999999999999")).toBe("#".repeat(19) + ".");
    expect(bar("2500000000000000000000")).toBe("#" + ".".repeat(19)); // 0.0025 of 0.05 = 5 % -> 1 cell
    expect(bar("2499999999999999999999")).toBe(".".repeat(20));
    expect(bar("0")).toBe(".".repeat(20));
  });

  it("GAS: a null allowance on chain draws no bar at all (neither fill nor empty cells) and is NOT A KEY LIMIT", () => {
    const base = sampleCageCard();
    const card = sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: null } });
    for (const caps of [plain100, { ...color100, color: false }]) {
      const row = renderCageCard(card, "full", caps).split("\n").find((l) => l.includes("GAS"))!;
      if (!caps.unicode) expect(row).toBe(plate("GAS", "NO CAP ON CHAIN (wrap set 0.0500 NEAR)", "NOT A KEY LIMIT"));
      expect(valueCell(row)).toBe("NO CAP ON CHAIN (wrap set 0.0500 NEAR)"); // the whole VALUE: nothing before it, no "left", no "gas only"
      expect(row.slice(74, 95).trimEnd()).toBe("NOT A KEY LIMIT");
      expect(row).not.toMatch(/[█#]/); // no fill glyph (the empty cell `.` is ruled out by the whole-VALUE equality above)
    }
    // narrow (10 cells) and mcp say the same
    expect(renderCageCard(card, "full", plain80)).toContain("NO CAP ON CHAIN (wrap set 0.0500 NEAR)");
    expect(renderCageCard(card, "mcp", plain100)).toContain("\nGAS: NO CAP ON CHAIN (wrap set 0.0500 NEAR) (NOT A KEY LIMIT)\n");
  });

  it("GAS: a null allowance is not a PROTOCOL stamp: no inverse cell on that row", () => {
    const base = sampleCageCard();
    const styled = renderCageCard(sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: null } }), "full", color100);
    const row = styled.split("\n").find((l) => stripAnsi(l).includes("GAS"))!;
    expect(row).not.toContain("\x1b[7m");
    expect(styled.match(/\x1b\[7mPROTOCOL/g)).toHaveLength(5); // RECEIVER, METHOD x2, ACTIONS, DEPOSIT
  });

  it("GAS: a malformed allowance from a bad read is an input error, not a crash inside BigInt", () => {
    const base = sampleCageCard();
    const card = sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: "4.12e22" } });
    expect(() => renderCageCard(card, "full", plain100)).toThrow(/not a whole number of yoctoNEAR/);
  });

  it("GAS: PREVIEW shows the requested allowance with a full bar", () => {
    const row = renderCageCard(sampleCageCard({ source: "preview" }), "full", plain100).split("\n").find((l) => l.includes("GAS"))!;
    expect(valueCell(row)).toBe(`${"#".repeat(20)} 0.0500 NEAR requested · gas only`);
  });

  it("GAS: a burned key draws no bar: key burned · no allowance left, still PROTOCOL", () => {
    for (const caps of [plain100, { ...color100, color: false }]) {
      const row = renderCageCard(sampleCageCard({ key: null }), "full", caps).split("\n").find((l) => l.includes("GAS"))!;
      expect(valueCell(row)).toBe("key burned · no allowance left");
      expect(row.slice(74, 95).trimEnd()).toBe("PROTOCOL");
      expect(row).not.toMatch(/[█#]/); // no fill cell
      expect(row.slice(13, 71)).not.toMatch(/[.─]/); // and no empty cell either (the amount is gone too)
    }
    // the inverse PROTOCOL stamp stays: the protocol rejects any tx a missing key signs
    expect(renderCageCard(sampleCageCard({ key: null }), "full", color100).match(/\x1b\[7mPROTOCOL/g)).toHaveLength(6);
  });

  it("CODE HASH: a changed pin says CHANGED, then the pin and the code hash now on continuation rows", () => {
    const now = "3Zr8mQpXvK2dLw9sYtHn4cBj7eUfAa6GoRiP1kNxVq5";
    const lines = renderCageCard(sampleCageCard({ codeHashNow: now }), "full", plain100).split("\n");
    const at = lines.findIndex((l) => l.slice(2, 13).trimEnd() === "CODE HASH");
    expect(plate("CODE HASH", "CHANGED — serve refuses every call", "KEYHOLE server-side")).toBe(lines[at]);
    expect(lines[at + 1]).toBe(plate("", `pinned ${PIN}`, ""));
    expect(lines[at + 2]).toBe(plate("", `now    ${now}`, ""));
    expect(lines.join("\n")).not.toContain("· match");
  });

  it("CODE HASH: a code hash that could not be read is not called a change", () => {
    const text = renderCageCard(sampleCageCard({ codeHashNow: null }), "full", plain100);
    expect(text).toContain(`${PIN} · not checked`);
    expect(text).not.toContain("CHANGED");
  });

  it("VOTE / VALUE: the pack's exposure, under its own label, NOT A KEY LIMIT", () => {
    const text = renderCageCard(sampleCageCard({ exposure: { label: "VALUE", value: "anything the signer owns inside the receiver" } }), "full", plain100).split("\n");
    expect(text).toContain(plate("VALUE", "anything the signer owns inside the receiver", "NOT A KEY LIMIT"));
  });

  it("KEY: a burned card says the key is not on chain", () => {
    const lines = renderCageCard(sampleCageCard({ key: null }), "full", plain100).split("\n");
    expect(lines).toContain(plate("KEY", "no such key on chain (view_access_key)", "—"));
    expect(lines.join("\n")).not.toContain(PUBKEY);
  });

  it("KEY and RECEIVER come from the chain read when there is one: the chain wins", () => {
    const base = sampleCageCard();
    const card = sampleCageCard({ key: { ...base.key!, receiverId: "other.sputnik-v2.testnet", publicKey: "ed25519:ChainKeyFromViewAccessKey" } });
    const text = renderCageCard(card, "full", plain100);
    expect(text).toContain("other.sputnik-v2.testnet");
    expect(text).toContain("ed25519:ChainKeyFromViewAccessKey");
    expect(text).not.toContain("kh-1a2b.sputnik-v2.testnet");
  });

  it("VIEWS: lists the view methods; without any, says none", () => {
    const noViews = sampleCageCard({ tools: sampleCageCard().tools.filter((t) => t.kind !== "view") });
    expect(renderCageCard(noViews, "full", plain100).split("\n")).toContain(plate("VIEWS", "none declared", "—"));
  });

  it("REPLAY: tag and footer name the run and the recording time", () => {
    const lines = renderCageCard(sampleCageCard({ source: "replay" }), "full", plain100).split("\n");
    expect(lines[0]).toMatch(/\[REPLAY\] -\+$/);
    expect(lines.at(-1)).toMatch(/^\+-+ REPLAY of run ks-7f3a recorded 2026-11-11T09:14:07Z -\+$/);
  });

  it("BURNED keeps the chain footer: the absence of the key was read from the chain", () => {
    expect(renderCageCard(sampleCageCard({ key: null }), "full", plain100).split("\n").at(-1)).toMatch(/ read from chain: view_access_key · 2026-11-11T09:14:07Z -\+$/);
  });

  it("PREVIEW footer", () => {
    expect(renderCageCard(sampleCageCard({ source: "preview" }), "full", plain100).split("\n").at(-1)).toMatch(/^\+-+ PREVIEW · nothing signed · requested scope \+ sandbox dry-run -\+$/);
  });

  it("does not mutate the card, and is deterministic", () => {
    const card = sampleCageCard();
    const before = JSON.stringify(card);
    const a = renderCageCard(card, "full", plain100);
    expect(JSON.stringify(card)).toBe(before);
    expect(renderCageCard(card, "full", plain100)).toBe(a);
  });
});

describe("renderCageCard · long values wrap, never truncate", () => {
  const ID64 = `${"a".repeat(56)}.testnet`; // 64 characters
  const card = sampleCageCard({
    session: sampleSession({ network: "testnet", accountId: ID64, receiverId: `${"b".repeat(56)}.testnet` }),
    key: { ...sampleCageCard().key!, accountId: ID64, receiverId: `${"b".repeat(56)}.testnet` },
  });

  it("64-char account ids: every line within 98, the ids whole across their continuation rows", () => {
    expect(ID64).toHaveLength(64);
    const lines = renderCageCard(card, "full", plain100).split("\n");
    expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(98);
    expect(joinedValue(lines, "RECEIVER")).toBe(`${"b".repeat(56)}.testnet`);
    expect(joinedValue(lines, "SIGNER")).toBe(`${ID64} · on-account`);
    // the first row is filled to the VALUE width, the rest carries on
    const receiverAt = lines.findIndex((l) => l.slice(2, 13).trimEnd() === "RECEIVER");
    expect(valueCell(lines[receiverAt])).toBe("b".repeat(56) + ".t");
    expect(valueCell(lines[receiverAt + 1])).toBe("estnet");
  });

  it("color wraps the same cells as plain (wrap first, then style)", () => {
    const styled = renderCageCard(card, "full", color100);
    expect(stripAnsi(styled)).toBe(renderCageCard(card, "full", { ...color100, color: false }));
    for (const line of styled.split("\n")) {
      const on = (line.match(/\x1b\[(?:1|2|7|1;30;43)m/g) ?? []).length;
      const off = (line.match(/\x1b\[(?:22|27|22;39;49)m/g) ?? []).length;
      expect(on).toBe(off); // no style is left open at a row end
    }
  });

  it("an inconclusive method prints its raw evidence on continuation rows, cut at the column and complete", () => {
    const panic = "Smart contract panicked: panicked at 'ERR_MIN_BOND', src/proposals.rs:392:9 with a long tail that must wrap";
    const lines = renderCageCard(withCalls(tool("v", "act_proposal", "inconclusive", panic)), "full", plain100).split("\n");
    const at = lines.findIndex((l) => l.includes("act_proposal ........ inconclusive"));
    expect(at).toBeGreaterThan(0);
    expect(valueCell(lines[at + 1])).toBe(panic.slice(0, 58));
    expect(valueCell(lines[at + 2])).toBe(panic.slice(58));
    expect(lines[at + 1].slice(2, 13).trim()).toBe(""); // continuation: no label
    expect(lines[at + 1].slice(-24).trim()).toBe("|"); // and no enforcer repeated
  });

  it("fails-without-deposit (runtime) takes the RUNTIME style, inconclusive and the others do not", () => {
    const styled = renderCageCard(withCalls(tool("v", "act_proposal", "fails-without-deposit (runtime)"), tool("w", "reset", "inconclusive")), "full", color100);
    expect(styled).toContain("\x1b[1;30;43mfails-without-deposit (runtime)\x1b[22;39;49m");
    expect(styled).not.toContain("\x1b[1;30;43minconclusive");
    expect(stripAnsi(styled)).toContain("act_proposal");
  });
});

describe("renderCageCard · styling", () => {
  const styledCard = (): string => renderCageCard(sampleCageCard(), "full", color100);

  it("PROTOCOL cells are inverse, six of them, and nothing else is", () => {
    const styled = styledCard();
    expect(styled.match(/\x1b\[7mPROTOCOL\x1b\[27m/g)).toHaveLength(6);
    expect(styled.match(/\x1b\[7m/g)).toHaveLength(6);
    for (const other of ["KEYHOLE server-side", "NOT A KEY LIMIT", "OPERATOR"]) expect(styled).not.toContain(`\x1b[7m${other}`);
  });

  it("labels are bold, the state tag is bold and never inverse, leader dots are dim", () => {
    const styled = styledCard();
    expect(styled).toContain("\x1b[1mRECEIVER\x1b[22m");
    expect(styled).toContain("\x1b[1m[LIVE]\x1b[22m");
    expect(styled).toContain("\x1b[2m········\x1b[22m");
  });

  it("uses no other hue than the RUNTIME span", () => {
    const styled = styledCard();
    const codes = new Set([...styled.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual(["1", "2", "22", "27", "7"]);
  });

  it("the narrow and the mcp variants strip to their plain selves too", () => {
    expect(stripAnsi(renderCageCard(sampleCageCard(), "narrow", { ...color100, width: 90 }))).toBe(renderCageCard(sampleCageCard(), "narrow", { ...color100, width: 90, color: false }));
    expect(renderCageCard(sampleCageCard(), "mcp", color100)).toBe(renderCageCard(sampleCageCard(), "mcp", plain100));
  });
});

describe("renderCageCard · narrow (80 to 99 columns)", () => {
  const narrow80 = (): string[] => renderCageCard(sampleCageCard(), "full", plain80).split("\n");

  it("a full request at 80 columns fits 80 cells, with a 10-cell bar", () => {
    const lines80 = narrow80();
    expect(lines80.every((l) => displayWidth(l) <= 80)).toBe(true);
    expect(lines80.map(displayWidth)).toEqual(Array(lines80.length).fill(80));
    expect(lines80.join("\n")).toContain("########.. 0.0412 of 0.0500 NEAR left");
  });

  it("VALUE is columns - 40: long prose wraps at words, with the label and enforcer on the first row only", () => {
    const lines80 = narrow80();
    const at = lines80.findIndex((l) => l.slice(2, 13).trimEnd() === "ACTIONS");
    expect(lines80[at]).toBe(plate("ACTIONS", "one FunctionCall per tx; no Transfer, no", "PROTOCOL", 40));
    expect(lines80[at + 1]).toBe(plate("", "AddKey", "", 40));
    const dep = lines80.findIndex((l) => l.slice(2, 13).trimEnd() === "DEPOSIT");
    expect(lines80[dep]).toBe(plate("DEPOSIT", "0 only; methods that demand one fail at", "PROTOCOL", 40));
    expect(lines80[dep + 1]).toBe(plate("", "runtime", "", 40));
  });

  it("the key and the pin are never shortened: they continue on the next row", () => {
    const lines80 = narrow80();
    expect(joinedValue(lines80, "KEY", 40)).toBe(PUBKEY);
    expect(valueCell(lines80[lines80.findIndex((l) => l.slice(2, 13).trimEnd() === "CODE HASH")], 40)).toBe(PIN.slice(0, 40));
    expect(lines80.join("\n")).toContain(`${PIN.slice(40)} · match`);
  });

  it("the title and the footer fit 80 and keep the tag and the source", () => {
    const lines80 = narrow80();
    expect(lines80[0]).toBe(`+- keyhole · cage card · ks-7f3a · testnet ${"-".repeat(27)} [LIVE] -+`);
    expect(lines80.at(-1)).toMatch(/^\+-+ read from chain: view_access_key · 2026-11-11T09:14:07Z -\+$/);
  });

  it("at 90 columns the width is the width: VALUE 50, bar 10", () => {
    const lines = renderCageCard(sampleCageCard(), "full", { ...plain100, width: 90 }).split("\n");
    expect(lines.map(displayWidth)).toEqual(Array(lines.length).fill(90));
    expect(lines.join("\n")).toContain("########.. 0.0412 of 0.0500 NEAR left · gas only");
  });

  it("an explicit narrow request at 100 columns still caps the plate at 98", () => {
    const lines = renderCageCard(sampleCageCard(), "narrow", plain100).split("\n");
    expect(Math.max(...lines.map(displayWidth))).toBe(98);
    expect(lines.join("\n")).toContain("########.. 0.0412 of 0.0500 NEAR left");
  });

  it("below 80 columns a full or narrow request is the mcp text", () => {
    const mcp = renderCageCard(sampleCageCard(), "mcp", plain100);
    expect(renderCageCard(sampleCageCard(), "full", { ...plain100, width: 79 })).toBe(mcp);
    expect(renderCageCard(sampleCageCard(), "narrow", { ...plain100, width: 60 })).toBe(mcp);
  });
});

describe("renderCageCard · compact (4 lines; 5 when the key line breaks, C-T16a)", () => {
  it("key and receiver, may call, gas, code_hash: the public key whole; at 100 columns the 107-cell key line breaks before ` on `", () => {
    const lines = renderCageCard(sampleCageCard(), "compact", plain100).split("\n");
    expect(lines).toEqual([
      ...KEY_ROWS,
      "may call act_proposal (callable) · not add_proposal",
      `gas ${"#".repeat(16)}.... 0.0412 of 0.0500 NEAR · gas only`,
      `code_hash ${PIN} · pinned (KEYHOLE server-side)`,
    ]);
    expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100);
  });

  it("C-T16a: a key line that fits the width stays one line; one wider breaks before ` on `, hung at 8 columns", () => {
    expect(renderCageCard(sampleCageCard(), "compact", { ...plain100, width: 120 }).split("\n")[0]).toBe(KEY_LINE);
    expect(displayWidth(KEY_LINE)).toBe(107);
    expect(renderCageCard(sampleCageCard(), "compact", { ...plain100, width: 107 }).split("\n")[0]).toBe(KEY_LINE); // exactly the width: fits
    expect(renderCageCard(sampleCageCard(), "compact", { ...plain100, width: 106 }).split("\n").slice(0, 2)).toEqual(KEY_ROWS);
    // A short line (sandbox ids) never breaks at 100 columns.
    const short = sampleCageCard({ session: sampleSession({ accountId: "seat.sandbox", receiverId: "dao.sandbox" }), key: { ...sampleCageCard().key!, accountId: "seat.sandbox", receiverId: "dao.sandbox" } });
    expect(renderCageCard(short, "compact", plain100).split("\n")[0]).toBe(`key ${PUBKEY} on seat.sandbox -> dao.sandbox`);
    expect(renderCageCard(short, "compact", plain100).split("\n")).toHaveLength(4);
  });

  it("never shortens the key or the hash, at any width or in any state (Global Constraints, clash 4)", () => {
    const states = [sampleCageCard(), sampleCageCard({ source: "preview" }), sampleCageCard({ key: null }), sampleCageCard({ source: "replay" }), sampleCageCard({ codeHashNow: "3Zr8mQpXvK" })];
    for (const card of states) {
      for (const caps of [plain100, plain80, color100, { ...plain100, width: 60 }, { ...plain100, width: 120 }]) {
        const lines = stripAnsi(renderCageCard(card, "compact", caps)).split("\n");
        expect(lines[0]).toContain(PUBKEY);
        expect(lines.at(-1)).toContain(PIN);
        // No ellipsis on the key row(s) and the hash line: nothing was cut. All lines but the middle two (may call, gas):
        // the head, the hung `on ACCOUNT → RECEIVER` row when the key line breaks (C-T16a), and the hash line (M1).
        expect([...lines.slice(0, -3), lines.at(-1)].join("\n")).not.toMatch(/…|\.\.\./);
        expect(lines.slice(0, -3).join(" ")).toContain(`on ${card.key?.accountId ?? card.session.accountId}`);
      }
    }
  });

  it("is four lines when the key line fits, five when it breaks; never another count", () => {
    for (const card of [sampleCageCard(), sampleCageCard({ source: "preview" }), sampleCageCard({ key: null }), sampleCageCard({ codeHashNow: "3Zr8…" })]) {
      // The sample's key line is 107 cells (116 with ` [BURNED]`): it breaks at every width below that.
      for (const caps of [plain100, plain80, color100, { ...plain100, width: 60 }]) expect(renderCageCard(card, "compact", caps).split("\n")).toHaveLength(5);
      expect(renderCageCard(card, "compact", { ...plain100, width: 120 }).split("\n")).toHaveLength(4);
    }
  });

  it("unicode caps use the arrow glyph; color adds nothing but styles", () => {
    const u = stripAnsi(renderCageCard(sampleCageCard(), "compact", color100));
    expect(u.split("\n").slice(0, 2)).toEqual([`key ${PUBKEY}`, "        on seat.kh-op.testnet → kh-1a2b.sputnik-v2.testnet"]);
    expect(compactRow(u, "gas")).toBe("gas ████████████████──── 0.0412 of 0.0500 NEAR · gas only");
  });

  it("the bar is 20 cells from 100 columns and 10 below", () => {
    const gas = (width: number, caps = plain100): string => compactRow(stripAnsi(renderCageCard(sampleCageCard(), "compact", { ...caps, width })), "gas");
    expect(gas(100)).toBe(`gas ${"#".repeat(16)}.... 0.0412 of 0.0500 NEAR · gas only`);
    expect(gas(120)).toBe(`gas ${"#".repeat(16)}.... 0.0412 of 0.0500 NEAR · gas only`);
    expect(gas(99)).toBe("gas ########.. 0.0412 of 0.0500 NEAR · gas only");
    expect(gas(80)).toBe("gas ########.. 0.0412 of 0.0500 NEAR · gas only");
    expect(gas(60)).toBe("gas ########.. 0.0412 of 0.0500 NEAR · gas only");
    expect(gas(90, color100)).toBe("gas ████████── 0.0412 of 0.0500 NEAR · gas only");
  });

  it("PREVIEW reads requested; a changed pin is said on the code_hash line; an unread hash is not a change", () => {
    expect(compactRow(renderCageCard(sampleCageCard({ source: "preview" }), "compact", plain100), "gas")).toBe(`gas ${"#".repeat(20)} 0.0500 NEAR requested · gas only`);
    expect(compactRow(renderCageCard(sampleCageCard({ codeHashNow: "3Zr8…" }), "compact", plain100), "code_hash")).toBe(`code_hash ${PIN} · CHANGED — serve refuses every call (KEYHOLE server-side)`);
    expect(compactRow(renderCageCard(sampleCageCard({ codeHashNow: null }), "compact", plain100), "code_hash")).toBe(`code_hash ${PIN} · not checked (KEYHOLE server-side)`);
  });

  it("several callable methods are listed together, runtime failures by their label", () => {
    const card = withCalls(tool("a", "act_proposal", "callable"), tool("b", "vote", "callable"), tool("c", "reset", "fails-without-deposit (runtime)"), tool("d", "add_proposal", "not in allowlist"));
    expect(compactRow(renderCageCard(card, "compact", plain100), "may call")).toBe("may call act_proposal, vote (callable), reset (fails-without-deposit (runtime)) · not add_proposal");
  });

  it("out-of-scope methods: three by name, then +N more; exactly three need no +N", () => {
    const five = withCalls(tool("a", "act_proposal", "callable"), ...["x1", "x2", "x3", "x4", "x5"].map((m) => tool(m, m, "not in allowlist")));
    expect(compactRow(renderCageCard(five, "compact", plain100), "may call")).toBe("may call act_proposal (callable) · not x1, x2, x3 +2 more");
    const three = withCalls(tool("a", "act_proposal", "callable"), ...["x1", "x2", "x3"].map((m) => tool(m, m, "not in allowlist")));
    expect(compactRow(renderCageCard(three, "compact", plain100), "may call")).toBe("may call act_proposal (callable) · not x1, x2, x3");
  });

  it("no allowed method says nothing, with or without out-of-scope ones", () => {
    expect(compactRow(renderCageCard(withCalls(), "compact", plain100), "may call")).toBe("may call nothing");
    expect(compactRow(renderCageCard(withCalls(tool("d", "add_proposal", "not in allowlist")), "compact", plain100), "may call")).toBe("may call nothing · not add_proposal");
  });

  it("labels are bold when color is on, and only the four labels; the hung row carries no style", () => {
    const lines = renderCageCard(sampleCageCard(), "compact", color100).split("\n");
    expect(lines[0].startsWith("\x1b[1mkey\x1b[22m ")).toBe(true);
    expect(lines[1]).toBe("        on seat.kh-op.testnet → kh-1a2b.sputnik-v2.testnet");
    expect(lines[2].startsWith("\x1b[1mmay call\x1b[22m ")).toBe(true);
    expect(lines[3].startsWith("\x1b[1mgas\x1b[22m ")).toBe(true);
    expect(lines[4].startsWith("\x1b[1mcode_hash\x1b[22m ")).toBe(true);
    expect(lines.join("\n").match(/\x1b\[/g)).toHaveLength(8); // four on, four off
    expect(renderCageCard(sampleCageCard(), "compact", plain100)).not.toContain("\x1b");
  });

  it("a null allowance on chain: no bar, said as it is", () => {
    const base = sampleCageCard();
    const card = sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: null } });
    for (const caps of [plain100, color100]) expect(compactRow(stripAnsi(renderCageCard(card, "compact", caps)), "gas")).toBe("gas NO CAP ON CHAIN (wrap set 0.0500 NEAR)");
  });
});

describe("renderCageCard · a burned key is drawn as burned, never as callable", () => {
  const burnedCard = (): CageCard => sampleCageCard({ key: null });
  const rowOf = (lines: string[], label: string): string => lines.find((l) => l.slice(2, 13).trimEnd() === label)!;

  it("plate: METHOD says key burned for every listed method; GAS has no bar", () => {
    const lines = renderCageCard(burnedCard(), "full", plain100).split("\n");
    expect(lines).toContain(plate("METHOD", "act_proposal ........ key burned", "PROTOCOL"));
    expect(lines).toContain(plate("", "add_proposal ........ key burned", "PROTOCOL"));
    expect(lines).toContain(plate("GAS", "key burned · no allowance left", "PROTOCOL"));
    expect(lines.join("\n")).not.toContain("callable");
    expect(lines.join("\n")).not.toContain("not in allowlist");
    expect(lines.join("\n")).toContain("[BURNED]");
  });

  it("plate: the +N more row is unchanged, and an inconclusive method loses its evidence", () => {
    const card = sampleCageCard({
      key: null,
      tools: [
        ...sampleCageCard().tools.filter((t) => t.kind === "view"),
        tool("a", "act_proposal", "inconclusive", "Smart contract panicked: ERR_X"),
        ...["x1", "x2", "x3", "x4", "x5"].map((m) => tool(m, m, "not in allowlist")),
      ],
    });
    const lines = renderCageCard(card, "full", plain100).split("\n");
    const methodRows = lines.slice(lines.findIndex((l) => l.slice(2, 13).trimEnd() === "METHOD")).slice(0, 5).map((l) => valueCell(l));
    expect(methodRows).toEqual([
      `act_proposal ${".".repeat(8)} key burned`,
      `x1 ${".".repeat(18)} key burned`,
      `x2 ${".".repeat(18)} key burned`,
      `x3 ${".".repeat(18)} key burned`,
      "+2 more not in allowlist",
    ]);
    expect(lines.join("\n")).not.toContain("ERR_X");
    expect(lines).toContain(plate("", "+2 more not in allowlist", "PROTOCOL"));
  });

  it("plate in color: key burned is dim, the PROTOCOL stamps stay", () => {
    const styled = renderCageCard(burnedCard(), "full", color100);
    expect(styled.match(/\x1b\[2mkey burned\x1b\[22m/g)).toHaveLength(2);
    expect(styled).not.toContain("\x1b[1;30;43m"); // no RUNTIME span on a burned card either
    expect(stripAnsi(styled)).toBe(renderCageCard(burnedCard(), "full", { ...color100, color: false }));
  });

  it("the GAS row has neither fill nor empty glyphs, in ASCII and Unicode", () => {
    for (const caps of [plain100, { ...color100, color: false }]) {
      const row = rowOf(renderCageCard(burnedCard(), "full", caps).split("\n"), "GAS");
      expect(row.slice(13, 71)).not.toMatch(/[#.█─]/);
    }
  });

  it("compact: [BURNED] ends the key line (its hung row at 100 columns), may call says nothing (key burned), gas says none", () => {
    const lines = renderCageCard(burnedCard(), "compact", plain100).split("\n");
    expect(lines).toEqual([
      `key ${PUBKEY}`,
      "        on seat.kh-op.testnet -> kh-1a2b.sputnik-v2.testnet [BURNED]",
      "may call nothing (key burned)",
      "gas none · key burned",
      `code_hash ${PIN} · pinned (KEYHOLE server-side)`,
    ]);
    expect(lines[1].endsWith(" [BURNED]")).toBe(true);
    expect(renderCageCard(burnedCard(), "compact", { ...plain100, width: 120 }).split("\n")[0]).toBe(`${KEY_LINE} [BURNED]`);
  });

  it("mcp uses the same row text", () => {
    const lines = renderCageCard(burnedCard(), "mcp", plain100).split("\n");
    expect(lines).toContain("METHOD: act_proposal ........ key burned (PROTOCOL)");
    expect(lines).toContain("METHOD: add_proposal ........ key burned (PROTOCOL)");
    expect(lines).toContain("GAS: key burned - no allowance left (PROTOCOL)");
    expect(lines).toContain("KEY: no such key on chain (view_access_key)");
  });

  it("no variant of a burned card says callable, and every one says key burned", () => {
    for (const [variant, caps] of [["full", plain100], ["narrow", plain80], ["compact", plain100], ["mcp", plain100]] as const) {
      const text = renderCageCard(burnedCard(), variant, caps);
      expect(text).not.toContain("callable");
      expect(text).toContain("key burned");
    }
  });

  it("a replay card without a key keeps [REPLAY] (tag precedence) but its rows still say key burned", () => {
    const card = sampleCageCard({ source: "replay", key: null });
    const full = renderCageCard(card, "full", plain100);
    expect(full.split("\n")[0]).toMatch(/\[REPLAY\] -\+$/);
    expect(full).not.toContain("[BURNED]");
    expect(full).toContain("act_proposal ........ key burned");
    expect(full).toContain("key burned · no allowance left");
    expect(full).toContain("no such key on chain (view_access_key)");
    expect(full).not.toContain("callable");
    expect(renderCageCard(card, "mcp", plain100).split("\n")[0]).toBe("keyhole - cage card - ks-7f3a - testnet [REPLAY]");
    const compact = renderCageCard(card, "compact", plain100).split("\n");
    expect(compact.slice(0, 2)).toEqual(KEY_ROWS); // the tag is the tag: no [BURNED] on the key line
    expect(compact.slice(2, 4)).toEqual(["may call nothing (key burned)", "gas none · key burned"]);
  });

  it("a PREVIEW card without a key is not burned: it has not been signed yet", () => {
    const text = renderCageCard(sampleCageCard({ source: "preview", key: null }), "full", plain100);
    expect(text).toContain("[PREVIEW]");
    expect(text).toContain("act_proposal ........ callable");
    expect(text).toContain(`KEY        ${PUBKEY}`);
  });
});

describe("renderCageCard · mcp text", () => {
  const mcpCard = (): string => renderCageCard(sampleCageCard(), "mcp", color100);

  it("even on a color TTY: no escapes, no box or block glyphs", () => {
    const mcp = mcpCard();
    expect(mcp).not.toMatch(/[\x1b─-▟]/);
    expect(mcp).toMatch(/^RECEIVER: .+ \(PROTOCOL\)$/m);
  });

  it("is pure ASCII for the hero card, on a color TTY too (Global Constraints, variant mcp)", () => {
    expect(mcpCard()).toMatch(/^[\x20-\x7e\n]*$/);
    expect(renderCageCard(sampleCageCard(), "mcp", plain100)).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("is pure ASCII in every state of the card whose strings are ASCII", () => {
    const base = sampleCageCard();
    const cards = [
      sampleCageCard({ source: "preview" }),
      sampleCageCard({ source: "replay" }),
      sampleCageCard({ key: null }),
      sampleCageCard({ codeHashNow: "3Zr8mQpXvK" }),
      sampleCageCard({ codeHashNow: null }),
      sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: null } }),
      sampleCageCard({ session: sampleSession({ mode: "subaccount", network: "testnet", accountId: "ks-7f3a.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet" }) }),
      withCalls(tool("v", "act_proposal", "fails-without-deposit (runtime)"), tool("w", "reset", "inconclusive", "panic: x")),
      sampleCageCard({ tools: base.tools.filter((t) => t.kind !== "call") }),
    ];
    for (const card of cards) expect(renderCageCard(card, "mcp", color100)).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("fixed copy is transliterated, chain strings are only neutralized: a middle dot or a dash from the chain stays", () => {
    const card = sampleCageCard({
      exposure: { label: "VOTE", value: "any · vote — until burn" },
      tools: [...sampleCageCard().tools.filter((t) => t.kind === "view"), tool("v", "act·proposal", "callable")],
    });
    const lines = renderCageCard(card, "mcp", plain100).split("\n");
    expect(lines).toContain("VOTE: any · vote — until burn (NOT A KEY LIMIT)");
    expect(lines).toContain("METHOD: act·proposal ........ callable (PROTOCOL)");
    expect(lines).toContain("SIGNER: seat.kh-op.testnet - on-account"); // the fixed copy next to them is ASCII
  });

  it("the changed-code line spells its dash as --", () => {
    expect(renderCageCard(sampleCageCard({ codeHashNow: "3Zr8mQpXvK" }), "mcp", plain100)).toContain("CODE HASH: CHANGED -- serve refuses every call (KEYHOLE server-side)");
  });

  it("one LABEL: value (ENFORCED BY) line per row, whole values, no wrapping", () => {
    expect(mcpCard().split("\n")).toEqual([
      "keyhole - cage card - ks-7f3a - testnet [LIVE]",
      "RECEIVER: kh-1a2b.sputnik-v2.testnet (PROTOCOL)",
      "SIGNER: seat.kh-op.testnet - on-account",
      "METHOD: act_proposal ........ callable (PROTOCOL)",
      "METHOD: add_proposal ........ not in allowlist (PROTOCOL)",
      "ACTIONS: one FunctionCall per tx; no Transfer, no AddKey (PROTOCOL)",
      "DEPOSIT: 0 only; methods that demand one fail at runtime (PROTOCOL)",
      "GAS: ########.. 0.0412 of 0.0500 NEAR left - gas only (PROTOCOL)",
      `CODE HASH: ${PIN} - match (KEYHOLE server-side)`,
      "VOTE: any proposal here, either way, until burn; quorum 2-of-2 (NOT A KEY LIMIT)",
      "EXPIRY: none in the protocol; ends at keyhole burn ks-7f3a (OPERATOR)",
      `KEY: ${PUBKEY}`,
      "VIEWS: get_proposals, get_policy: read-only, no key needed",
      "read from chain: view_access_key - 2026-11-11T09:14:07Z",
    ]);
  });

  it("continuation rows are indented under their line, with the enforcer on the first line only", () => {
    const now = "3Zr8mQpXvK2dLw9sYtHn4cBj7eUfAa6GoRiP1kNxVq5";
    const lines = renderCageCard(sampleCageCard({ codeHashNow: now }), "mcp", plain100).split("\n");
    const at = lines.findIndex((l) => l.startsWith("CODE HASH:"));
    expect(lines.slice(at, at + 3)).toEqual([
      "CODE HASH: CHANGED -- serve refuses every call (KEYHOLE server-side)",
      `  pinned ${PIN}`,
      `  now    ${now}`,
    ]);
  });

  it("burned and preview states", () => {
    const burned = renderCageCard(sampleCageCard({ key: null }), "mcp", plain100).split("\n");
    expect(burned[0]).toBe("keyhole - cage card - ks-7f3a - testnet [BURNED]");
    expect(burned).toContain("KEY: no such key on chain (view_access_key)");
    const preview = renderCageCard(sampleCageCard({ source: "preview" }), "mcp", plain100).split("\n");
    expect(preview[0]).toBe("keyhole - cage card - ks-7f3a - testnet [PREVIEW]");
    expect(preview.at(-1)).toBe("PREVIEW - nothing signed - requested scope + sandbox dry-run");
  });

  it("a null allowance on chain: NO CAP ON CHAIN, enforced by NOT A KEY LIMIT", () => {
    const base = sampleCageCard();
    expect(renderCageCard(sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: null } }), "mcp", plain100)).toContain(
      "\nGAS: NO CAP ON CHAIN (wrap set 0.0500 NEAR) (NOT A KEY LIMIT)\n",
    );
  });
});

describe("renderCageCard · text from the chain cannot forge the plate (C-T6d)", () => {
  const hostile = sampleCageCard({
    session: sampleSession({ id: "ks-\x1b[2J", mode: "subaccount", network: "testnet", accountId: "seat.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet", codeHashPin: "pin\x1b[0mPIN" }),
    key: {
      ...sampleCageCard().key!,
      publicKey: "ed25519:\x1b[31m0123456789abcdef\x07",
      receiverId: "evil\x1b]0;pwned\x07.testnet",
      accountId: "bad\nPASS: refused by protocol (Fake)",
    },
    tools: [
      tool("g", "act_proposal", "callable"),
      { ...tool("w", "get\x1b[1mviews", "callable"), kind: "view" },
      tool("v", "act\x1b[2Jproposal", "inconclusive", "panic\r\nPASS: forged\x1b[31m"),
      tool("n", "evil\x1b[3Jmethod", "not in allowlist"),
    ],
    codeHashNow: "hash\x1b[0mNOW",
    readAt: "2026-11-11T09:14:07Z\u202e",
    exposure: { label: "VOTE", value: "any\x1b[7m proposal" },
  });

  for (const variant of ["full", "narrow", "compact", "mcp"] as const) {
    it(`${variant}: no escape, no bidi control, no raw LF or CR in the output; the escapes print as text`, () => {
      const width = variant === "narrow" ? 80 : 100;
      const text = renderCageCard(hostile, variant, { ...color100, width, color: false });
      expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/); // plain caps: any ESC here is the attacker's
      expect(text).toContain("\\u001b");
      expect(text.split("\n").every((l) => !l.startsWith("PASS:"))).toBe(true);
      // and color adds its own escapes only: stripping them gives the plain output
      expect(stripAnsi(renderCageCard(hostile, variant, { ...color100, width }))).toBe(text);
    });
  }

  it("the fake PASS line stays inside its cell: it begins with the neutralized text", () => {
    const lines = stripAnsi(renderCageCard(hostile, "full", color100)).split("\n");
    expect(lines.join("\n")).toContain("bad\\u000aPASS:");
  });
});

describe("renderCageCard · the review's survivors, pinned", () => {
  const CTRL = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
  const VARIANTS = [["full", plain100], ["narrow", plain80], ["compact", plain100], ["mcp", plain100]] as const;

  it("a hostile network in the title is neutralized, in every variant that prints it", () => {
    const hostileNet = "test\x1b[2Jnet" as unknown as Network;
    const card = sampleCageCard({ session: sampleSession({ network: hostileNet, accountId: "seat.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet" }) });
    for (const [variant, caps] of VARIANTS) {
      const text = renderCageCard(card, variant, caps);
      expect(text).not.toMatch(CTRL); // plain caps: an ESC here is the attacker's
      if (variant !== "compact") expect(text.split("\n")[0]).toContain("test\\u001b[2Jnet"); // compact has no title: it prints no network
    }
    expect(renderCageCard(card, "full", { ...color100, color: false }).split("\n")[0]).toContain("test\\u001b[2Jnet");
  });

  it("a hostile readAt on a replay card is neutralized in the REPLAY footer", () => {
    const card = sampleCageCard({ source: "replay", readAt: "2026-11-11T09:14:07Z\x1b[31m\u202e" });
    for (const [variant, caps] of VARIANTS) {
      const text = renderCageCard(card, variant, caps);
      expect(text).not.toMatch(CTRL);
      if (variant !== "compact") expect(text.split("\n").at(-1)).toContain("recorded 2026-11-11T09:14:07Z\\u001b[31m\\u202e");
    }
  });

  it("a hostile session id in a replay footer is neutralized too", () => {
    const card = sampleCageCard({ source: "replay", session: sampleSession({ id: "ks-\x1b[2J", network: "testnet", accountId: "seat.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet" }) });
    expect(renderCageCard(card, "full", plain100)).not.toMatch(CTRL);
    expect(renderCageCard(card, "full", plain100).split("\n").at(-1)).toContain("REPLAY of run ks-\\u001b[2J recorded");
  });

  it("tag precedence: a replay card without a key is [REPLAY], a chain card without one is [BURNED]", () => {
    expect(renderCageCard(sampleCageCard({ source: "replay", key: null }), "mcp", plain100).split("\n")[0]).toMatch(/\[REPLAY\]$/);
    expect(renderCageCard(sampleCageCard({ source: "chain", key: null }), "mcp", plain100).split("\n")[0]).toMatch(/\[BURNED\]$/);
    expect(renderCageCard(sampleCageCard({ source: "preview", key: null }), "mcp", plain100).split("\n")[0]).toMatch(/\[PREVIEW\]$/);
  });

  it("no call tool at all: one METHOD row says none listed, still PROTOCOL", () => {
    const lines = renderCageCard(withCalls(), "full", plain100).split("\n");
    expect(lines).toContain(plate("METHOD", "none listed", "PROTOCOL"));
    expect(lines.filter((l) => l.slice(2, 13).trimEnd() === "METHOD")).toHaveLength(1);
    expect(renderCageCard(withCalls(), "mcp", plain100)).toContain("\nMETHOD: none listed (PROTOCOL)\n");
    expect(renderCageCard(sampleCageCard(), "full", plain100)).not.toContain("none listed");
  });

  it("two view tools on one method list it once", () => {
    const [v1, v2] = sampleCageCard().tools.filter((t) => t.kind === "view");
    const card = sampleCageCard({ tools: [v1, { ...v1, name: "dao_list_again" }, v2, { ...v2, name: "dao_policy_again" }] });
    expect(renderCageCard(card, "full", plain100).split("\n")).toContain(plate("VIEWS", "get_proposals, get_policy: read-only, no key needed", "—"));
  });

  it("an allowance above the initial one is a full bar, not a crash", () => {
    const base = sampleCageCard();
    const card = sampleCageCard({ key: { ...base.key!, allowanceRemainingYocto: "100000000000000000000000" } }); // 0.1 NEAR left of 0.05
    expect(valueCell(renderCageCard(card, "full", plain100).split("\n").find((l) => l.includes("GAS"))!)).toBe(`${"#".repeat(20)} 0.1000 of 0.0500 NEAR left · gas only`);
    expect(renderCageCard(card, "full", plain80)).toContain(`${"#".repeat(10)} 0.1000 of 0.0500 NEAR left`);
    expect(compactRow(renderCageCard(card, "compact", plain100), "gas")).toBe(`gas ${"#".repeat(20)} 0.1000 of 0.0500 NEAR · gas only`);
  });
});

describe("renderCageCard · wide characters are measured in cells, never in code units", () => {
  const WIDE_ID = `${"合约🚀".repeat(10)}.testnet`; // 10 x (2 + 2 + 2 cells) + 8 = 68 cells, 48 code units
  const SIGNER = "席位🔥seat.testnet"; // 19 cells, 17 code units
  const EXPOSURE = Array(6).fill("任意提案🚀").join(" "); // six 10-cell words, 6 code units each
  const base = sampleCageCard();
  const wide = sampleCageCard({
    session: sampleSession({ id: "ks-席", network: "testnet", accountId: SIGNER, receiverId: WIDE_ID }),
    key: { ...base.key!, accountId: SIGNER, receiverId: WIDE_ID },
    tools: [...base.tools.filter((t) => t.kind === "view"), tool("a", "act", "callable"), tool("w", "投票🚀", "not in allowlist")],
    exposure: { label: "VOTE", value: EXPOSURE },
    readAt: "2026-11-11T09:14:07Z席",
  });
  const unicode100 = { ...color100, color: false };
  const unicode80 = { ...color100, color: false, width: 80 };

  /** The VALUE cell of a plate row: what lies between the 13-unit label part and the 27-unit ENFORCED BY tail (both ASCII). */
  const valueOf = (line: string): string => line.slice(13, line.length - 27).trimEnd();
  const rowsOf = (lines: string[], label: string): string[] => {
    const start = lines.findIndex((l) => l.slice(2, 13).trimEnd() === label);
    const out = [valueOf(lines[start])];
    for (let i = start + 1; i < lines.length && lines[i].slice(2, 13).trim() === ""; i++) out.push(valueOf(lines[i]));
    return out;
  };

  it("every line of the full plate is exactly 98 cells, in ASCII and Unicode", () => {
    for (const caps of [plain100, unicode100]) {
      const lines = renderCageCard(wide, "full", caps).split("\n");
      expect(lines.map(displayWidth)).toEqual(Array(lines.length).fill(98));
    }
  });

  it("every line of the narrow plate is exactly 80 cells, in ASCII and Unicode", () => {
    for (const caps of [plain80, unicode80]) {
      const lines = renderCageCard(wide, "full", caps).split("\n");
      expect(lines.map(displayWidth)).toEqual(Array(lines.length).fill(80));
    }
  });

  it("a wide id is cut at the 58-cell column edge (29 cells of CJK + emoji, then the rest) and kept whole", () => {
    const lines = renderCageCard(wide, "full", plain100).split("\n");
    const parts = rowsOf(lines, "RECEIVER");
    expect(parts.join("")).toBe(WIDE_ID);
    expect(parts.map(displayWidth)).toEqual([58, 10]);
    expect(parts[0]).toBe(`${"合约🚀".repeat(9)}合约`);
    const narrow = rowsOf(renderCageCard(wide, "full", plain80).split("\n"), "RECEIVER");
    expect(narrow.join("")).toBe(WIDE_ID);
    expect(narrow.map(displayWidth)).toEqual([40, 28]);
  });

  it("prose of wide words breaks by cells: five 10-cell words fit 58, the sixth wraps (3 + 3 at 40)", () => {
    const five = Array(5).fill("任意提案🚀").join(" ");
    expect(rowsOf(renderCageCard(wide, "full", plain100).split("\n"), "VOTE")).toEqual([five, "任意提案🚀"]);
    const three = Array(3).fill("任意提案🚀").join(" ");
    expect(rowsOf(renderCageCard(wide, "full", plain80).split("\n"), "VOTE")).toEqual([three, three]);
  });

  it("leader dots pad to the widest method name in cells: 11 dots after a 3-cell name, 8 after the 6-cell one", () => {
    const ascii = renderCageCard(wide, "full", plain100);
    expect(ascii).toContain(`act ${".".repeat(11)} callable`);
    expect(ascii).toContain(`投票🚀 ${".".repeat(8)} not in allowlist`);
    const uni = renderCageCard(wide, "full", unicode100);
    expect(uni).toContain(`act ${"·".repeat(11)} callable`);
    expect(uni).toContain(`投票🚀 ${"·".repeat(8)} not in allowlist`);
    expect(renderCageCard(wide, "mcp", plain100)).toContain(`METHOD: act ${".".repeat(11)} callable (PROTOCOL)`);
  });

  it("the rest of a cut wide word counts in cells: what follows it wraps when the cells run out", () => {
    const long = "席".repeat(54); // 108 cells in 54 code units: a 58-cell piece (29), then 50 cells (25)
    const card = sampleCageCard({
      session: sampleSession({ network: "testnet", accountId: long, receiverId: "kh-1a2b.sputnik-v2.testnet" }),
      key: { ...base.key!, accountId: long },
    });
    const lines = renderCageCard(card, "full", plain100).split("\n");
    expect(lines.map(displayWidth)).toEqual(Array(lines.length).fill(98));
    expect(rowsOf(lines, "SIGNER")).toEqual(["席".repeat(29), `${"席".repeat(25)} ·`, "on-account"]); // 50 + " · " + 10 = 63 cells > 58
  });

  it("the signer row, the title and the footer are measured in cells too", () => {
    const lines = renderCageCard(wide, "full", plain100).split("\n");
    expect(rowsOf(lines, "SIGNER")).toEqual([`${SIGNER} · on-account`]);
    expect(lines[0]).toBe(`+- keyhole · cage card · ks-席 · testnet ${"-".repeat(47)} [LIVE] -+`);
    expect(lines.at(-1)).toBe(`+${"-".repeat(36)} read from chain: view_access_key · 2026-11-11T09:14:07Z席 -+`);
  });
});

describe("cageCardRows (R16c: the one row model behind the plate and the status page)", () => {
  it("lists the rows in plate order with their enforcers", () => {
    const rows = cageCardRows(sampleCageCard());
    expect(rows.map((r) => [r.label, r.enforcedBy])).toEqual([
      ["RECEIVER", "PROTOCOL"],
      ["SIGNER", "—"],
      ["METHOD", "PROTOCOL"],
      ["METHOD", "PROTOCOL"],
      ["ACTIONS", "PROTOCOL"],
      ["DEPOSIT", "PROTOCOL"],
      ["GAS", "PROTOCOL"],
      ["CODE HASH", "KEYHOLE server-side"],
      ["VOTE", "NOT A KEY LIMIT"],
      ["EXPIRY", "OPERATOR"],
      ["KEY", "—"],
      ["VIEWS", "—"],
    ]);
  });

  it("a row's lines are the unwrapped VALUE, as plain text", () => {
    const rows = cageCardRows(sampleCageCard());
    const text = (label: string, n = 0): string => rows.filter((r) => r.label === label)[n].lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
    expect(text("RECEIVER")).toBe("kh-1a2b.sputnik-v2.testnet");
    expect(text("METHOD", 1)).toBe("add_proposal ········ not in allowlist");
    expect(text("KEY")).toBe(PUBKEY);
    expect(text("CODE HASH")).toBe(`${PIN} · match`);
  });

  it("takes the label of the pack's exposure", () => {
    const rows = cageCardRows(sampleCageCard({ exposure: { label: "VALUE", value: "anything the signer owns inside the receiver" } }));
    expect(rows.map((r) => r.label)).toContain("VALUE");
    expect(rows.map((r) => r.label)).not.toContain("VOTE");
  });
});
