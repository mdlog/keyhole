/**
 * Task 18: `keyhole inspect` (LAYOUT R5) and `keyhole burn` (LAYOUT R6) offline. Most tests inject fake CONTRACT
 * functions (createInspectCommand / createBurnCommand); the integration tests run the real commands through main
 * against committed sandbox bodies (replayFetch) and tmpEnv() dirs. The session-id checks live in test/cli.test.ts.
 *
 * Keys are generated in memory and written only under tmpEnv() dirs; no assertion prints one (key checks are
 * booleans). The bodies are the spike's verbatim RPC captures: public chain data.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, baseEncode, decodeSignedTransaction } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Io } from "../src/cli/args.js";
import { type BurnDeps, createBurnCommand } from "../src/cli/burn.js";
import { type InspectDeps, createInspectCommand } from "../src/cli/inspect.js";
import { main } from "../src/cli/main.js";
import { LandedUnsettledError, outcomeFromBody } from "../src/core/attempt.js";
import { useRpcUrl } from "../src/core/config.js";
import { fullAccessKeyLoadCount, saveAccountKey, saveSessionKey, sessionKeyPath } from "../src/core/credentials.js";
import { EnvironmentError, KeyholeError } from "../src/core/errors.js";
import { dropHeldKeys, heldPrivateKeyCount } from "../src/core/keys.js";
import { NO_CODE_HASH } from "../src/core/rpc.js";
import { saveSession } from "../src/core/session.js";
import { SendFateUnknownError, type SentTx, mustSucceed } from "../src/core/tx.js";
import type { Attempt, AttemptInput, CageCard, Session, TxSuccess } from "../src/core/types.js";
import { ALREADY_BURNED, NOTE_SIGNER_GONE, PASS_KEY_GONE, failExpected, passRefused } from "../src/render/strings.js";
import { displayWidth } from "../src/render/style.js";
import { termCaps } from "../src/render/term.js";
import { renderTxLine } from "../src/render/tx-line.js";
import { REPO, SANDBOX_FIXTURES, type ReplayedRequest, readFixture, replayFetch, sampleCageCard, sampleSession, tmpEnv } from "./helpers.js";

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);
const STATUS = fx("001-0-status.json");
const DAO_ACCOUNT = fx("015-b-view-dao-account.json");
const KEY_PRESENT = fx("024-d-view-fc-key.json"); // act_proposal on dao.sandbox, 0.05 NEAR
const OPERATOR_NONCE = fx("068-i-burn-delete-key.nonce.json"); // a FullAccess key read (nonce + block hash)
const DELETE_OK = fx("069-i-burn-delete-key.send_tx.json"); // a landed DeleteKey
const KEY_GONE = fx("070-i-view-burned-key.json"); // `result.error: ... does not exist`
const BLOCK = fx("071-i-attempt-after-burn.block.json");
const AFTER_BURN = fx("072-i-attempt-after-burn.send_tx.json"); // InvalidAccessKeyError › AccessKeyNotFound
const REFUSED = fx("061-g4-deposit-1yocto.send_tx.json"); // a refusal at validation, never in a block
const SIGNER_GONE_BODY =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"SignerDoesNotExist":{"signer_id":"ks-7f3a.op.sandbox"}}}}},"id":"x"}';
const TX = "FQ7vAr3TpBN8cyU5o7NM2wWDf1XqJmV1Mo1Jt5CxJyQh";
const BURNED_AT = "2026-11-06T14:06:52.123Z";
const PUB = sampleSession().publicKey; // the spike's session key: public

let urls = 0;
beforeEach(() => {
  useRpcUrl("sandbox", `http://cli-${++urls}.replay.invalid`); // assertChain remembers a check per URL
});
afterEach(() => {
  dropHeldKeys();
  vi.unstubAllEnvs();
});

/** A terminal: stdout and stderr as text. */
function term(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => void out.push(t), err: (t) => void err.push(t), env };
  return { io, out: () => out.join("\n"), lines: () => out.join("\n").split("\n"), err: () => err.join("\n") };
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

// ---------------------------------------------------------------------------------------------------
// inspect

/** The hero card on sandbox, as buildCageCard("chain") returns it. */
function sandboxCard(over: Partial<CageCard> = {}): CageCard {
  const base = sampleCageCard();
  const session = sampleSession({ tools: base.tools });
  return sampleCageCard({ session, key: { ...base.key!, accountId: session.accountId, receiverId: session.receiverId }, ...over });
}

function inspectWith(card: CageCard) {
  const deps = {
    loadSession: vi.fn<InspectDeps["loadSession"]>(async () => card.session),
    buildCageCard: vi.fn<InspectDeps["buildCageCard"]>(async () => card),
  };
  return { deps, cmd: createInspectCommand(deps) };
}

describe("keyhole inspect (LAYOUT R5)", () => {
  it("live: header, the CHAIN card [LIVE], the verify line with the full key, the explorer line, NEXT burn; exit 0", async () => {
    const card = sampleCageCard(); // testnet: seat.kh-op.testnet
    const { deps, cmd } = inspectWith(card);
    const t = term();
    expect(await exec(cmd, ["ks-7f3a"], t.io)).toBe(0);
    expect(deps.buildCageCard).toHaveBeenCalledWith(card.session, "chain");
    const lines = t.lines();
    expect(lines[0]).toBe("KEYHOLE inspect · ks-7f3a · testnet · on-account");
    const tag = lines.findIndex((l) => l.includes("[LIVE]"));
    expect(tag).toBeGreaterThan(0);
    const verify = lines.indexOf(`verify independently: RPC query, request_type view_access_key, account_id seat.kh-op.testnet, public_key ${PUB}`);
    expect(verify).toBeGreaterThan(tag);
    expect(lines[verify + 1]).toBe("explorer  https://testnet.nearblocks.io/address/seat.kh-op.testnet");
    expect(lines.slice(-2)).toEqual(["NEXT", "  keyhole burn ks-7f3a"]);
    expect(t.err()).toBe("");
  });

  it("sandbox has no explorer", async () => {
    const t = term();
    expect(await exec(inspectWith(sandboxCard()).cmd, ["ks-7f3a"], t.io)).toBe(0);
    expect(t.lines()).toContain("sandbox (no explorer)");
    expect(t.lines()[0]).toBe("KEYHOLE inspect · ks-7f3a · sandbox · on-account");
  });

  it("burned → a 3-line BURNED block in place of the card (DeleteKey tx and time from the session file; 4 rows on testnet), exit 0", async () => {
    const session: Session = { ...sampleSession(), status: "burned", burnedAt: BURNED_AT, burnTxHashes: [TX] };
    const t = term();
    expect(await exec(inspectWith(sandboxCard({ session, key: null })).cmd, ["ks-7f3a"], t.io)).toBe(0);
    const lines = t.lines();
    const at = lines.indexOf("BURNED · no such key on chain (view_access_key)");
    expect(at).toBe(1);
    expect(lines.slice(at + 1, at + 3)).toEqual([`DeleteKey tx ${TX} · final · sandbox (no explorer)`, `burned at ${BURNED_AT}`]);
    expect(t.out()).not.toContain("[LIVE]");
    expect(t.out()).not.toContain("[BURNED]"); // the block replaces the card
    expect(t.out()).not.toContain("keyhole burn");
    expect(t.out()).not.toContain("source of truth"); // file and chain agree
  });

  // Fix round 1, m-2: the T16 run's burned session (ks-16e5 on seat.kh-op-021e.testnet) and its DeleteKey tx, read from the
  // committed run file. With its `DeleteKey ` label the tx line is 114 cells; it breaks before the URL (the block is 4 rows).
  it("a burned testnet session: the DeleteKey tx line breaks before its URL, every row within 100 cells (T16's ids)", async () => {
    const run = JSON.parse(readFileSync(join(REPO, "demo", "run.testnet.json"), "utf8")) as { steps: Array<{ n: number; txHash?: string; label: string }> };
    const burn = run.steps.find((s) => s.n === 13)!;
    const hash = burn.txHash!;
    expect(burn.label).toBe("seat.kh-op-021e.testnet signs DeleteKey of ks-16e5's key");
    const session: Session = { ...sampleSession({ network: "testnet", id: "ks-16e5", accountId: "seat.kh-op-021e.testnet", receiverId: "kh-2c19.sputnik-v2.testnet" }), status: "burned", burnedAt: BURNED_AT, burnTxHashes: [hash] };
    const caps = termCaps({ isTTY: false, columns: 100 }, {});
    expect(displayWidth(`DeleteKey ${renderTxLine(hash, "testnet", caps)}`)).toBeGreaterThan(100); // the line this fixes
    const t = term();
    expect(await exec(inspectWith(sandboxCard({ session, key: null })).cmd, ["ks-16e5"], t.io)).toBe(0);
    const lines = t.lines();
    const at = lines.indexOf("BURNED · no such key on chain (view_access_key)");
    expect(at).toBe(1);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      `DeleteKey tx ${hash.slice(0, 4)}...${hash.slice(-4)} · final`,
      `          · https://testnet.nearblocks.io/txns/${hash}`,
      `burned at ${BURNED_AT}`,
    ]);
    for (const l of lines) expect(displayWidth(l), l).toBeLessThanOrEqual(100);
    expect(lines.filter((l) => l.includes(hash))).toHaveLength(1); // the full hash once, in the URL
  });

  it("chain and file disagree (file says live, chain has no key): the chain wins, and NEXT burn records it", async () => {
    const t = term();
    expect(await exec(inspectWith(sandboxCard({ key: null })).cmd, ["ks-7f3a"], t.io)).toBe(0);
    const lines = t.lines();
    expect(lines[1]).toBe("BURNED · no such key on chain (view_access_key)");
    expect(lines[2]).toBe("DeleteKey tx: none recorded in the session file");
    expect(lines[3]).toBe("burned at: not recorded in the session file");
    expect(lines).toContain("local session file says live; chain has no key — the chain is the source of truth");
    expect(lines.slice(-2)).toEqual(["NEXT", "  keyhole burn ks-7f3a (records the burn locally; no transaction is sent)"]);
  });

  it("chain and file disagree the other way (file says burned, chain has the key): the card, and the chain wins", async () => {
    const session: Session = { ...sampleSession(), status: "burned", burnedAt: BURNED_AT, burnTxHashes: [TX] };
    const t = term();
    expect(await exec(inspectWith(sandboxCard({ session })).cmd, ["ks-7f3a"], t.io)).toBe(0);
    expect(t.out()).toContain("[LIVE]");
    expect(t.lines()).toContain("local session file says burned; chain has the key — the chain is the source of truth");
    expect(t.lines().slice(-2)).toEqual(["NEXT", "  keyhole burn ks-7f3a"]);
  });

  it("code changed since wrap: the card says CHANGED, and inspect still exits 0", async () => {
    const t = term();
    expect(await exec(inspectWith(sandboxCard({ codeHashNow: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" })).cmd, ["ks-7f3a"], t.io)).toBe(0);
    expect(t.out()).toContain("CHANGED");
  });

  it("loads no key of any kind", async () => {
    const loads = fullAccessKeyLoadCount();
    await exec(inspectWith(sandboxCard()).cmd, ["ks-7f3a"], term().io);
    expect(fullAccessKeyLoadCount()).toBe(loads);
    expect(heldPrivateKeyCount()).toBe(0);
  });

  it("inspect unknown id lists sessions (id, receiver, status) and exits 1 (real command, real session files)", async () => {
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
    await saveSession(sampleSession({ id: "ks-1111" }), env);
    await saveSession({ ...sampleSession({ id: "ks-2222", receiverId: "other.sandbox" }), status: "burned", burnedAt: BURNED_AT }, env);
    const t = term();
    expect(await main(["inspect", "ks-0000"], t.io, {})).toBe(1);
    expect(t.err().split("\n")).toEqual(["unknown session ks-0000 · known sessions:", "  ks-1111 · dao.sandbox · live", "  ks-2222 · other.sandbox · burned"]);
    expect(t.out()).toBe("");
  });

  it("unknown id with no sessions at all says none", async () => {
    vi.stubEnv("KEYHOLE_HOME", tmpEnv().KEYHOLE_HOME);
    const t = term();
    expect(await main(["inspect", "ks-0000"], t.io, {})).toBe(1);
    expect(t.err()).toBe("unknown session ks-0000 · known sessions: none");
  });

  it("the real command reads the key, the code hash and the DAO's policy from RPC (view_access_key, view_account, get_policy), never the file", async () => {
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
    await saveSession(sampleSession({ tools: sampleCageCard().tools }), env);
    const policy = readFixture(SANDBOX_FIXTURES, "017-b-get-policy.json"); // the spike DAO: council {seat, cosigner}, [1, 2]
    const log = replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT, "query:call_function": policy });
    const t = term();
    expect(await main(["inspect", "ks-7f3a"], t.io, {})).toBe(0);
    expect(log.map((r) => r.params?.request_type).sort()).toEqual(["call_function", "view_access_key", "view_account"]);
    expect(log.find((r) => r.params?.request_type === "call_function")?.params).toMatchObject({ account_id: "dao.sandbox", method_name: "get_policy" });
    expect(t.out()).toContain("[LIVE]");
    expect(t.out()).toMatch(/act_proposal \.+ callable/);
    // Final review I1: the VOTE row's quorum is this DAO's, as get_policy gave it.
    expect(t.out()).toContain("| VOTE       any proposal here, either way, until burn; quorum 2-of-2 ");
  });
});

// ---------------------------------------------------------------------------------------------------
// burn

const SCOPED = { publicKey: PUB, accountId: "seat.sandbox", receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowanceRemainingYocto: "50000000000000000000000", nonce: 3 };
const onAccount = (): Session => sampleSession({ tools: sampleCageCard().tools });
const subAccount = (): Session => sampleSession({ mode: "subaccount", accountId: "ks-7f3a.op.sandbox", tools: sampleCageCard().tools });
const burnedOf = (s: Session, txHashes: string[]): Session => ({ ...s, status: "burned", burnedAt: BURNED_AT, burnTxHashes: txHashes });

/** sendAttempt's answer: the attempt as given, with the outcome the real parser reads from `body`. */
const attemptFrom = (input: AttemptInput, body: string): Attempt => ({ ...input, outcome: outcomeFromBody(body, TX)! });

/** Fakes for every CONTRACT function burn calls (loadTargetPack stays real: a file read). The key is live on chain. */
function burnFakes(session: Session, opts: { proofBody?: string; live?: boolean } = {}) {
  const live = opts.live ?? true;
  const sessionKey = KeyPair.fromRandom("ed25519");
  return {
    loadSession: vi.fn<BurnDeps["loadSession"]>(async () => session),
    viewScopedKey: vi.fn<BurnDeps["viewScopedKey"]>(async () => (live ? { ...SCOPED, accountId: session.accountId } : null)),
    viewAccount: vi.fn<BurnDeps["viewAccount"]>(async () => null),
    viewAccessKeyBody: vi.fn<BurnDeps["viewAccessKeyBody"]>(async () => ({ raw: KEY_GONE, json: JSON.parse(KEY_GONE), httpStatus: 200, url: "http://cli.replay.invalid" })),
    sessionKeyPair: vi.fn<BurnDeps["sessionKeyPair"]>(() => sessionKey),
    loadFullAccessKey: vi.fn<BurnDeps["loadFullAccessKey"]>(() => KeyPair.fromRandom("ed25519")),
    signBurn: vi.fn<BurnDeps["signBurn"]>(async (s) => {
      const txHashes = live ? [TX] : [];
      return { session: burnedOf(s, txHashes), txHashes };
    }),
    sendAttempt: vi.fn<BurnDeps["sendAttempt"]>(async (_s, input) => attemptFrom(input, opts.proofBody ?? AFTER_BURN)),
  };
}

const PROOF_HEADER = 'ATTEMPT  act_proposal  ("vote with the deleted key")';
/** I1: the session line of a burn whose PROOF did not pass (wrapped at ` · ` to 100 columns). */
const PROOF_FAILED_LINES = ["session ks-7f3a · DeleteKey recorded locally · PROOF FAILED: the chain may still accept this key", "        · run keyhole inspect ks-7f3a"];
const BARE_BURNED = /^session ks-7f3a · burned/m;

describe("keyhole burn (LAYOUT R6)", () => {
  // LAYOUT R6, loading state (C-T18a): `waiting for RPC…` in place on a TTY while DeleteKey reaches finality.
  describe("the TTY loading line (C-T18a)", () => {
    const TTY = { isTTY: true, columns: 100 };
    const ENV = { LANG: "en_US.UTF-8", TERM: "xterm-256color", NO_COLOR: "1" }; // NO_COLOR also turns unicode off: `...`, not `…`
    /** A terminal that records raw writes in order with its lines, so the in-place line can be placed. */
    function ttyTerm(env: NodeJS.ProcessEnv = ENV) {
      const log: string[] = [];
      const io: Io = { out: (t) => void log.push(`out:${t}`), err: (t) => void log.push(`err:${t}`), write: (t) => void log.push(`write:${t}`), stdout: TTY, env };
      return { io, log };
    }
    /** signBurn that stays pending until `release()`. */
    function slowBurn(session: Session) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const f = burnFakes(session);
      f.signBurn.mockImplementation(async (s) => {
        await held;
        return { session: burnedOf(s, [TX]), txHashes: [TX] };
      });
      return { f, release };
    }

    it("shows it once DeleteKey has taken a second, and clears it before the TxLine", async () => {
      vi.useFakeTimers();
      try {
        const { f, release } = slowBurn(onAccount());
        const t = ttyTerm();
        const running = exec(createBurnCommand(f), ["ks-7f3a"], t.io);
        await vi.advanceTimersByTimeAsync(999);
        expect(t.log.filter((l) => l.startsWith("write:"))).toEqual([]); // under a second: nothing
        await vi.advanceTimersByTimeAsync(2);
        expect(t.log.filter((l) => l.startsWith("write:"))).toEqual(["write:\rwaiting for RPC..."]);
        release();
        expect(await running).toBe(0);
        const writes = t.log.filter((l) => l.startsWith("write:"));
        expect(writes).toEqual(["write:\rwaiting for RPC...", "write:\r\x1b[K"]);
        // Cleared before anything else is printed after it, and the line is the first print after the clear.
        const clear = t.log.indexOf("write:\r\x1b[K");
        expect(t.log[clear + 1]).toBe(`out:tx ${TX} · final · sandbox (no explorer)`);
        expect(t.log.indexOf("write:\rwaiting for RPC...")).toBeLessThan(clear);
      } finally {
        vi.useRealTimers();
      }
    });

    it("nothing for a burn that takes under a second, none off a TTY, and it is cleared when DeleteKey fails", async () => {
      vi.useFakeTimers();
      try {
        // Quick: the timer is cancelled before it fires, so nothing is written a second later either.
        const quick = ttyTerm();
        expect(await exec(createBurnCommand(burnFakes(onAccount())), ["ks-7f3a"], quick.io)).toBe(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(quick.log.filter((l) => l.startsWith("write:"))).toEqual([]);

        // Not a TTY: no in-place write, however long it takes.
        const piped = slowBurn(onAccount());
        const t = term();
        const pipedIo: Io = { ...t.io, write: () => void t.io.out("WRITE") };
        const running = exec(createBurnCommand(piped.f), ["ks-7f3a"], pipedIo);
        await vi.advanceTimersByTimeAsync(5000);
        piped.release();
        expect(await running).toBe(0);
        expect(t.out()).not.toContain("WRITE");

        // A failed DeleteKey: the line is cleared before the error is raised.
        const failing = burnFakes(onAccount());
        let reject!: (e: Error) => void;
        failing.signBurn.mockImplementation(() => new Promise((_resolve, rej) => (reject = rej)));
        const ft = ttyTerm();
        const failed = exec(createBurnCommand(failing), ["ks-7f3a"], ft.io);
        await vi.advanceTimersByTimeAsync(1100);
        expect(ft.log.filter((l) => l.startsWith("write:"))).toEqual(["write:\rwaiting for RPC..."]);
        reject(new EnvironmentError("RPC down", "retry"));
        expect(await failed).toBe(2);
        expect(ft.log.filter((l) => l.startsWith("write:"))).toEqual(["write:\rwaiting for RPC...", "write:\r\x1b[K"]);
        expect(ft.log.at(-1)).toMatch(/^err:/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("C-T18d: a testnet DeleteKey TxLine is two rows of at most 100 cells, flush left; the PROOF follows it", async () => {
    const f = burnFakes({ ...onAccount(), network: "testnet" });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    const lines = t.lines();
    const at = lines.indexOf(`tx ${TX.slice(0, 4)}...${TX.slice(-4)} · final`);
    expect(at).toBe(3);
    expect(lines.slice(at + 1, at + 3)).toEqual([`· https://testnet.nearblocks.io/txns/${TX}`, "PROOF"]);
    expect(lines.slice(at, at + 2).every((l) => l.length <= 100)).toBe(true);
  });

  it("burn: plan, TxLine, PROOF with exactly one PASS AccessKeyNotFound line, session line", async () => {
    const f = burnFakes(onAccount());
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    const lines = t.lines();
    expect(lines[0]).toBe("KEYHOLE burn · ks-7f3a · sandbox · on-account");
    expect(lines.slice(1, 3)).toEqual(["PLAN", `- DeleteKey(${PUB}) on seat.sandbox, signed with seat.sandbox's full-access key`]);
    expect(lines[3]).toBe(`tx ${TX} · final · sandbox (no explorer)`);
    expect(lines[4]).toBe("PROOF");
    expect(lines[5]).toBe(PROOF_HEADER);
    expect(lines[6]).toBe("        signed   FunctionCall act_proposal -> dao.sandbox · deposit 0 · 30 TGas");
    expect(lines.filter((l) => l === `        ${passRefused("AccessKeyNotFound")}`)).toHaveLength(1);
    expect(lines.filter((l) => l.includes("PASS:"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("breaks"))).toBe(false); // no rule strip: no slot means "key gone" (C-T6b)
    expect(lines.filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(AFTER_BURN); // the body, verbatim
    // C-T12a: the ledger is 106 cells on one row, so its path takes the next row at 100 columns.
    expect(lines.slice(-3, -1)).toEqual(["        reached block: no · on-chain tx: none", "        · InvalidTxError › InvalidAccessKeyError › AccessKeyNotFound"]);
    expect(lines.at(-1)).toBe("session ks-7f3a · burned · 14:06:52Z");
    expect(t.err()).toBe("");
  });

  it("the PROOF attempt is the pack's after-burn test, signed with the session key, on the session's receiver", async () => {
    const f = burnFakes(onAccount());
    await exec(createBurnCommand(f), ["ks-7f3a"], term().io);
    expect(f.sendAttempt).toHaveBeenCalledTimes(1);
    const [s, input] = f.sendAttempt.mock.calls[0];
    expect(s.publicKey).toBe(PUB);
    expect(input).toEqual({ sessionId: "ks-7f3a", receiverId: "dao.sandbox", action: "FunctionCall", method: "act_proposal", args: { id: 1, action: "VoteReject" }, depositYocto: "0", gasTGas: 30, violates: "none" });
  });

  it("R11b: the session key pair is resolved before signBurn (which deletes its file), and the operator key is passed in", async () => {
    const f = burnFakes(onAccount());
    await exec(createBurnCommand(f), ["ks-7f3a"], term({ KEYHOLE_HOME: "/x" }).io);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(order(f.sessionKeyPair)).toBeLessThan(order(f.signBurn));
    expect(order(f.signBurn)).toBeLessThan(order(f.sendAttempt));
    expect(f.sessionKeyPair.mock.calls[0][1]).toEqual({ KEYHOLE_HOME: "/x" });
    expect(f.loadFullAccessKey).toHaveBeenCalledWith("sandbox", "seat.sandbox", { KEYHOLE_HOME: "/x" });
    expect(f.signBurn.mock.calls[0][1]).toEqual({ signerKey: f.loadFullAccessKey.mock.results[0].value, env: { KEYHOLE_HOME: "/x" } });
  });

  it("sub-account: DeleteAccount → operator in the PLAN; PROOF is SignerDoesNotExist with its note (phase burn, C-T8d)", async () => {
    const f = burnFakes(subAccount(), { proofBody: SIGNER_GONE_BODY });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    const lines = t.lines();
    expect(lines[0]).toBe("KEYHOLE burn · ks-7f3a · sandbox · sub-account");
    expect(lines.slice(1, 4)).toEqual(["PLAN", `- DeleteKey(${PUB}) on ks-7f3a.op.sandbox, signed with op.sandbox's full-access key`, "- DeleteAccount -> op.sandbox (beneficiary)"]);
    expect(f.loadFullAccessKey).toHaveBeenCalledWith("sandbox", "op.sandbox", {});
    const pass = lines.indexOf(`        ${passRefused("SignerDoesNotExist")}`);
    expect(pass).toBeGreaterThan(0);
    expect(lines[pass + 1]).toBe(`        ${NOTE_SIGNER_GONE}`);
    expect(t.out()).not.toContain("chain rejected the tx");
    expect(lines.at(-1)).toBe("session ks-7f3a · burned · 14:06:52Z");
  });

  it("burn already burned without a key file prints PASS_KEY_GONE and exits 0: no tx, no operator key", async () => {
    const f = burnFakes(onAccount(), { live: false });
    f.sessionKeyPair.mockImplementation(() => {
      throw new EnvironmentError("no private key for session ks-7f3a: none held, KEYHOLE_SESSION_KEY is not set, and there is no key file /x/sandbox/seat.sandbox/ed25519_x.json", "set KEYHOLE_SESSION_KEY");
    });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    const lines = t.lines();
    expect(lines[1]).toBe(ALREADY_BURNED);
    expect(lines).toContain("PROOF");
    expect(lines.filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(KEY_GONE);
    expect(lines).toContain(`        ${PASS_KEY_GONE}`);
    expect(lines.at(-1)).toBe("session ks-7f3a · burned · 14:06:52Z");
    expect(t.out()).not.toContain("PLAN");
    expect(f.loadFullAccessKey).not.toHaveBeenCalled();
    expect(f.sendAttempt).not.toHaveBeenCalled();
    expect(f.signBurn).toHaveBeenCalledTimes(1); // records the burn locally; sends nothing (txHashes [])
  });

  it("burn already burned with the key file still there re-runs the attempt proof (exit 0)", async () => {
    const f = burnFakes(onAccount(), { live: false });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    expect(t.lines()[1]).toBe(ALREADY_BURNED);
    expect(t.lines()).toContain(PROOF_HEADER);
    expect(t.lines().filter((l) => l === `        ${passRefused("AccessKeyNotFound")}`)).toHaveLength(1);
    expect(t.out()).not.toContain(PASS_KEY_GONE);
    expect(f.loadFullAccessKey).not.toHaveBeenCalled();
  });

  it("burned between the read and the send (signBurn sent nothing): already burned, still a proof", async () => {
    const f = burnFakes(onAccount());
    f.signBurn.mockImplementationOnce(async (s) => ({ session: burnedOf(s, []), txHashes: [] }));
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    expect(t.lines()).toContain(ALREADY_BURNED);
    expect(t.out()).not.toMatch(/^tx /m);
    expect(t.lines()).toContain(PROOF_HEADER);
  });

  it("C-T5a: the key gone but the sub-account still there: it says the sub-account (operator key + funds) remains and how to delete it", async () => {
    const f = burnFakes(subAccount(), { live: false });
    f.viewAccount.mockResolvedValue({ amountYocto: "60000000000000000000000", codeHash: NO_CODE_HASH });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
    const out = t.out();
    expect(f.viewAccount).toHaveBeenCalledWith("sandbox", "ks-7f3a.op.sandbox");
    expect(out).toContain("the sub-account ks-7f3a.op.sandbox remains");
    expect(out).toContain("op.sandbox's full-access key");
    expect(out).toContain("0.0600 NEAR");
    expect(out).toContain("DeleteAccount");
    expect(out).toContain("near account delete-account ks-7f3a.op.sandbox beneficiary op.sandbox");
    // The account exists, so the key's absence is an access-key error, not SignerDoesNotExist.
    expect(t.lines().filter((l) => l === `        ${passRefused("AccessKeyNotFound")}`)).toHaveLength(1);
  });

  it("operator key missing: ERROR (environment), exit 2, and it says the session stays live; nothing is signed", async () => {
    const f = burnFakes(onAccount());
    f.loadFullAccessKey.mockImplementation(() => {
      throw new EnvironmentError("no full-access key for seat.sandbox in /creds/sandbox", "near account import-account … save-to-legacy-keychain (near-cli-rs), or set KEYHOLE_CREDENTIALS_DIR");
    });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toMatch(/^ERROR \(environment\): no full-access key for seat\.sandbox in \/creds\/sandbox/);
    expect(t.err()).toContain("session ks-7f3a stays live");
    expect(f.signBurn).not.toHaveBeenCalled();
    expect(f.sendAttempt).not.toHaveBeenCalled();
    expect(t.out()).toContain("PLAN");
    expect(t.out()).not.toContain("PROOF");
  });

  it("refused at validation: nothing reached the chain, so the session stays live", async () => {
    const f = burnFakes(onAccount());
    let refusal: unknown;
    try {
      mustSucceed("burn ks-7f3a", { txHash: TX, raw: REFUSED, json: JSON.parse(REFUSED) });
    } catch (e) {
      refusal = e;
    }
    f.signBurn.mockRejectedValueOnce(refusal);
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toContain("refused at validation");
    expect(t.err()).toContain("session ks-7f3a stays live");
    expect(f.sendAttempt).not.toHaveBeenCalled();
  });

  it("C-T5a: the burn tx landed and FAILED in a block, the key still live on chain: it says so and to run keyhole burn ID again", async () => {
    const f = burnFakes(onAccount());
    const json = JSON.parse(DELETE_OK);
    json.result.status = { Failure: { ActionError: { index: 0, kind: { DeleteKeyDoesNotExist: { account_id: "seat.sandbox", public_key: PUB } } } } };
    json.result.receipts_outcome[0].outcome.status = json.result.status;
    const sent: SentTx = { txHash: TX, raw: JSON.stringify(json), json };
    const failed = (() => {
      try {
        mustSucceed("burn ks-7f3a", sent);
      } catch (e) {
        return e as EnvironmentError;
      }
    })();
    expect(failed).toBeInstanceOf(EnvironmentError);
    f.signBurn.mockRejectedValueOnce(failed);
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(f.viewScopedKey).toHaveBeenCalledTimes(2); // read back after the failure: the chain decides what to say
    expect(t.err()).toContain(failed!.what);
    expect(t.err()).toContain("the session key is still live on chain");
    expect(t.err()).toContain("run keyhole burn ks-7f3a again");
    expect(t.err()).not.toContain("do not sign it again");
    expect(f.sendAttempt).not.toHaveBeenCalled();
  });

  it("C-T2l: DeleteAccount landed but the transfer to the beneficiary failed: the sub-account is deleted and its balance was burnt", async () => {
    const f = burnFakes(subAccount());
    f.viewScopedKey.mockResolvedValueOnce({ ...SCOPED, accountId: "ks-7f3a.op.sandbox" }).mockResolvedValueOnce(null);
    const { sent } = beneficiaryBurnt();
    const failed = (() => {
      try {
        mustSucceed("burn ks-7f3a", sent);
      } catch (e) {
        return e as EnvironmentError;
      }
    })();
    expect(failed).toBeInstanceOf(EnvironmentError);
    f.signBurn.mockRejectedValueOnce(failed);
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toContain("the sub-account ks-7f3a.op.sandbox was deleted");
    expect(t.err()).toContain("its balance was burnt");
    expect(t.err()).toContain("the beneficiary op.sandbox did not exist");
    expect(t.err()).toContain("run keyhole burn ks-7f3a again");
    expect(t.err()).not.toContain("changed nothing except gas"); // tx.ts's generic hint would hide the burnt balance
  });

  it("a burn tx whose failure leaves the key gone (e.g. the refund check was unreadable): the key is gone; run burn again to record it", async () => {
    const f = burnFakes(onAccount());
    f.viewScopedKey.mockResolvedValueOnce(SCOPED).mockResolvedValueOnce(null);
    f.signBurn.mockRejectedValueOnce(new EnvironmentError(`burn ks-7f3a: failed in a block: receipt X Failure: {} · tx ${TX}`, "whether to retry is the caller's decision"));
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toContain("the session key is gone on chain");
    expect(t.err()).toContain("run keyhole burn ks-7f3a again");
  });

  it("the key cannot be read back after a failed burn: fail closed (never says gone or live), and running burn again is the way", async () => {
    const f = burnFakes(onAccount());
    f.viewScopedKey.mockResolvedValueOnce(SCOPED).mockRejectedValueOnce(new EnvironmentError("RPC http://x unreachable (query): boom", "check the network"));
    f.signBurn.mockRejectedValueOnce(new EnvironmentError(`burn ks-7f3a: failed in a block: tx Failure: {} · tx ${TX}`, "whether to retry is the caller's decision"));
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toContain("could not be read back");
    expect(t.err()).not.toContain("still live on chain");
    expect(t.err()).not.toContain("gone on chain");
    expect(t.err()).toContain("keyhole burn ks-7f3a");
  });

  it("a send whose fate is unknown is printed verbatim, never retried", async () => {
    const f = burnFakes(onAccount());
    const fate = new SendFateUnknownError(TX, "seat.sandbox", "the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls");
    f.signBurn.mockRejectedValueOnce(fate);
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(fate.exitCode);
    expect(t.err()).toBe(fate.line());
    expect(f.signBurn).toHaveBeenCalledTimes(1);
    expect(f.sendAttempt).not.toHaveBeenCalled();
  });

  it("a PROOF attempt that LANDS is a FAIL (the deleted key still signs): no PASS line, the qualified session line, exit 1", async () => {
    const f = burnFakes(onAccount());
    const landed: TxSuccess = { kind: "TxSuccess", txHash: TX, rawRpcJson: DELETE_OK };
    f.sendAttempt.mockImplementationOnce(async (_s, input) => ({ ...input, outcome: landed }));
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(1);
    expect(t.out()).toContain(failExpected("AccessKeyNotFound", "TxSuccess"));
    expect(t.out()).not.toContain("PASS:");
    expect(t.lines().slice(-2)).toEqual(PROOF_FAILED_LINES);
    expect(t.out()).not.toMatch(BARE_BURNED);
    expect(t.err()).toBe("");
  });

  it("a PROOF refused with another name is a FAIL: failExpected, the qualified session line, exit 1", async () => {
    const f = burnFakes(onAccount(), { proofBody: SIGNER_GONE_BODY }); // on-account: the account still exists
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(1);
    expect(t.out()).toContain(failExpected("AccessKeyNotFound", "SignerDoesNotExist"));
    expect(t.lines().slice(-2)).toEqual(PROOF_FAILED_LINES);
    expect(t.out()).not.toMatch(BARE_BURNED);
  });

  it("I1: a PROOF that landed but did not settle is a FAIL: the FAIL block, the unsettled note word for word, the qualified line, exit 1", async () => {
    const f = burnFakes(onAccount());
    let unsettled: LandedUnsettledError | undefined;
    f.sendAttempt.mockImplementationOnce(async (_s, input) => {
      const landed: TxSuccess = { kind: "TxSuccess", txHash: TX, rawRpcJson: DELETE_OK };
      unsettled = new LandedUnsettledError({ ...input, outcome: landed }, landed, new EnvironmentError("tx X: receipt tree incomplete after 20 tx polls", "x"));
      throw unsettled;
    });
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(1); // the burn FAILED; nothing is uncaught
    const lines = t.lines();
    expect(lines).toContain(PROOF_HEADER);
    expect(lines).toContain(`        ${failExpected("AccessKeyNotFound", "TxSuccess")}`);
    expect(lines.filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(DELETE_OK); // the landed body, verbatim
    expect(lines).toContain(`        reached block: yes · on-chain tx: ${TX}`);
    // The note: the error's own words, wrapped at spaces (a continuation is indented 10).
    const note = t.out().replace(/\n {10}/g, " ");
    expect(note).toContain(`        ${unsettled!.what} · ${unsettled!.tryThis}`);
    expect(note).toContain("do not send it again");
    expect(lines.slice(-2)).toEqual(PROOF_FAILED_LINES);
    expect(t.out()).not.toMatch(BARE_BURNED);
    expect(t.out()).not.toContain("PASS:");
    expect(t.err()).toBe("");
  });

  it("I1: a PROOF that ends in another error: the qualified line (not completed), then the error verbatim on stderr", async () => {
    const f = burnFakes(onAccount());
    const fate = new SendFateUnknownError(TX, "seat.sandbox", "the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls");
    f.sendAttempt.mockRejectedValueOnce(fate);
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(fate.exitCode);
    expect(t.lines().slice(-2)).toEqual(["session ks-7f3a · DeleteKey recorded locally · PROOF not completed: see the error", "        · run keyhole inspect ks-7f3a"]);
    expect(t.out()).not.toMatch(BARE_BURNED);
    expect(t.err()).toBe(fate.line());
  });

  it("M2a: the pre-read of the key fails closed: an RPC error is exit 2, and nothing is signed, sent or recorded", async () => {
    const f = burnFakes(onAccount());
    f.viewScopedKey.mockRejectedValueOnce(new EnvironmentError("RPC http://x unreachable (query): boom", "check the network"));
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toBe("ERROR (environment): RPC http://x unreachable (query): boom · check the network");
    expect(f.signBurn).not.toHaveBeenCalled(); // signBurn is also what records a burn locally
    expect(f.loadFullAccessKey).not.toHaveBeenCalled();
    expect(f.sendAttempt).not.toHaveBeenCalled();
    expect(t.out()).not.toContain(ALREADY_BURNED);
    expect(t.out()).not.toContain("PROOF");
  });

  describe("M3: the view_access_key proof (no session key left) judges three ways", () => {
    const noKey = (f: ReturnType<typeof burnFakes>) =>
      f.sessionKeyPair.mockImplementation(() => {
        throw new EnvironmentError("no private key for session ks-7f3a", "set KEYHOLE_SESSION_KEY");
      });

    it("no such key → PASS_KEY_GONE, exit 0", async () => {
      const f = burnFakes(onAccount(), { live: false });
      noKey(f);
      const t = term();
      expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(0);
      expect(t.lines()).toContain(`        ${PASS_KEY_GONE}`);
      expect(t.lines().at(-1)).toBe("session ks-7f3a · burned · 14:06:52Z");
    });

    it("M2b: a key with its permission in the body → FAIL (the key is still there), the qualified line, exit 1", async () => {
      const f = burnFakes(onAccount(), { live: false });
      noKey(f);
      f.viewAccessKeyBody.mockResolvedValue({ raw: KEY_PRESENT, json: JSON.parse(KEY_PRESENT), httpStatus: 200, url: "http://cli.replay.invalid" });
      const t = term();
      expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(1);
      expect(t.lines().filter((l) => l.startsWith("        | ")).map((l) => l.slice(10)).join("")).toBe(KEY_PRESENT);
      expect(t.lines()).toContain("        FAIL: view_access_key still finds the session key on chain");
      expect(t.out()).not.toContain(PASS_KEY_GONE);
      expect(t.lines().slice(-2)).toEqual(PROOF_FAILED_LINES);
      expect(t.out()).not.toMatch(BARE_BURNED);
    });

    it("anything else (here UNKNOWN_BLOCK from a gateway that echoes its URL) → ERROR (environment), scrubbed, never a false FAIL", async () => {
      const f = burnFakes(onAccount(), { live: false });
      noKey(f);
      const url = "https://rpc.example.invalid/v3/k3yt0ken?apiKey=s3cr3tvalue";
      const body = JSON.stringify({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} }, code: -32000, message: "Server error", data: `block not found at ${url}` }, id: "x" });
      f.viewAccessKeyBody.mockResolvedValue({ raw: body, json: JSON.parse(body), httpStatus: 200, url });
      const t = term();
      expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
      expect(t.err()).toMatch(/^ERROR \(environment\): view_access_key seat\.sandbox ed25519:\S+ failed: UNKNOWN_BLOCK: /);
      expect(t.err()).toContain("https://rpc.example.invalid");
      for (const secret of ["k3yt0ken", "s3cr3tvalue", "/v3"]) expect(t.err().includes(secret), secret).toBe(false);
      expect(t.out()).not.toContain("still finds");
      expect(t.out()).not.toContain(PASS_KEY_GONE);
      expect(t.lines().slice(-2)).toEqual(["session ks-7f3a · DeleteKey recorded locally · PROOF not completed: see the error", "        · run keyhole inspect ks-7f3a"]);
    });
  });

  describe("M4: a sub-account burn that failed in a block with the key gone: the beneficiary's fate is read from chain", () => {
    function failedSubBurn(what: string) {
      const f = burnFakes(subAccount());
      f.viewScopedKey.mockResolvedValueOnce({ ...SCOPED, accountId: "ks-7f3a.op.sandbox" }).mockResolvedValueOnce(null);
      f.signBurn.mockRejectedValueOnce(new EnvironmentError(what, "whether to retry is the caller's decision"));
      return f;
    }

    it("the error names AccountDoesNotExist for the operator, but the chain has the operator: no burnt-balance claim", async () => {
      const { sent } = beneficiaryBurnt();
      const failed = (() => {
        try {
          mustSucceed("burn ks-7f3a", sent);
        } catch (e) {
          return e as EnvironmentError;
        }
      })();
      const f = failedSubBurn(failed!.what);
      f.viewAccount.mockImplementation(async (_n, id) => (id === "op.sandbox" ? { amountYocto: "1000000000000000000000000", codeHash: NO_CODE_HASH } : null));
      const t = term();
      expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
      expect(f.viewAccount).toHaveBeenCalledWith("sandbox", "op.sandbox");
      expect(t.err()).not.toContain("balance was burnt");
      expect(t.err()).toContain("the session key is gone on chain");
      expect(t.err()).toContain("run keyhole burn ks-7f3a again");
    });

    it("an error text that names no account, and the chain has neither account: the balance was burnt", async () => {
      const f = failedSubBurn(`burn ks-7f3a: failed in a block: receipt X Failure: {} · tx ${TX}`);
      const t = term();
      expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
      expect(t.err()).toContain("the sub-account ks-7f3a.op.sandbox was deleted");
      expect(t.err()).toContain("its balance was burnt: the beneficiary op.sandbox did not exist");
    });

    it("the operator's account cannot be read: no burnt-balance claim, the generic gone line", async () => {
      const f = failedSubBurn(`burn ks-7f3a: failed in a block: receipt X Failure: {} · tx ${TX}`);
      f.viewAccount.mockRejectedValue(new EnvironmentError("RPC http://x unreachable (query): boom", "check the network"));
      const t = term();
      expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
      expect(t.err()).not.toContain("balance was burnt");
      expect(t.err()).toContain("the session key is gone on chain");
    });
  });

  it("M7: the keychain's operator key is not a key of the account on chain: nothing signed, the session stays live", async () => {
    const f = burnFakes(onAccount());
    const signerKey = KeyPair.fromRandom("ed25519");
    f.loadFullAccessKey.mockReturnValue(signerKey);
    f.signBurn.mockRejectedValueOnce(new EnvironmentError(`seat.sandbox has no access key ${signerKey.getPublicKey().toString()} on sandbox`, "check the signer account and the key it signs with"));
    const t = term();
    expect(await exec(createBurnCommand(f), ["ks-7f3a"], t.io)).toBe(2);
    expect(t.err()).toMatch(/^ERROR \(environment\): seat\.sandbox has no access key ed25519:\S+ on sandbox/);
    expect(t.err()).toContain("nothing was signed: session ks-7f3a stays live");
    expect(t.err()).toContain("run keyhole burn ks-7f3a again");
    expect(f.sendAttempt).not.toHaveBeenCalled();
  });

  it("burn of an unknown session exits 1 and names the known ones", async () => {
    vi.stubEnv("KEYHOLE_HOME", tmpEnv().KEYHOLE_HOME);
    const t = term();
    expect(await main(["burn", "ks-0000"], t.io, {})).toBe(1);
    expect(t.err()).toMatch(/^unknown session ks-0000/);
  });
});

/**
 * A DeleteKey + DeleteAccount of ks-7f3a.op.sandbox whose transfer to the beneficiary failed (the beneficiary does not
 * exist, so nearcore burns the balance), shaped as test/tx.test.ts deleteOwnAccount: the tx status SuccessValue; the
 * beneficiary transfer (signer_id `system`) failed; the gas refund to the deleted signer failed too and is listed as
 * the gas refund (refundReceiptIds), as withRefundReceipts would read it. Built from 069 (a landed DeleteKey).
 */
function beneficiaryBurnt(): { sent: SentTx } {
  const json = JSON.parse(DELETE_OK);
  const r = json.result;
  const sub = "ks-7f3a.op.sandbox";
  r.transaction.signer_id = sub;
  r.transaction.receiver_id = sub;
  r.transaction.actions = [{ DeleteKey: { public_key: PUB } }, { DeleteAccount: { beneficiary_id: "op.sandbox" } }];
  const [main, refund] = r.receipts_outcome;
  const transfer = JSON.parse(JSON.stringify(refund));
  transfer.id = "De36CxHy6zAD4h1gjjmumy2WShyXavhHhwBm8qnffskL";
  transfer.outcome.executor_id = "op.sandbox";
  transfer.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "op.sandbox" } } } } };
  main.outcome.executor_id = sub;
  main.outcome.receipt_ids = [transfer.id, refund.id];
  refund.outcome.executor_id = sub;
  refund.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: sub } } } } };
  r.receipts_outcome = [main, transfer, refund];
  return { sent: { txHash: r.transaction.hash, raw: JSON.stringify(json), json, refundReceiptIds: [refund.id] } };
}

// ---------------------------------------------------------------------------------------------------
// burn: the real command, offline (committed bodies, tmpEnv keychain)

/** True when a decoded (borsh) public key is `pub`: a boolean, so a failure cannot print a key. */
const isKey = (decoded: { ed25519Key?: { data: ArrayLike<number> } }, pub: string): boolean => `ed25519:${baseEncode(Uint8Array.from(decoded.ed25519Key?.data ?? []))}` === pub;
const sends = (log: ReplayedRequest[]) => log.filter((r) => r.method === "send_tx").map((r) => decodeSignedTransaction(Buffer.from(r.params.signed_tx_base64, "base64")).transaction);

describe("keyhole burn: the real command (main), offline", () => {
  async function persisted() {
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
    vi.stubEnv("KEYHOLE_CREDENTIALS_DIR", env.KEYHOLE_CREDENTIALS_DIR);
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: fcKey.getPublicKey().toString(), tools: sampleCageCard().tools });
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    return { env, fcKey, session };
  }

  it("R11b: a persisted burn under tmpEnv() still prints PROOF, signed with the session key held before its file was deleted", async () => {
    const { env, fcKey, session } = await persisted();
    const seatKey = KeyPair.fromRandom("ed25519");
    saveAccountKey("sandbox", "seat.sandbox", seatKey, env);
    const log = replayFetch({
      status: STATUS,
      // the CLI's read, signBurn's read, the operator key's nonce, then the session key (gone) before the proof
      "query:view_access_key": [KEY_PRESENT, KEY_PRESENT, OPERATOR_NONCE, KEY_GONE],
      send_tx: [DELETE_OK, AFTER_BURN],
      block: BLOCK,
    });
    const t = term(process.env);
    expect(await main(["burn", "ks-7f3a"], t.io, {})).toBe(0);
    expect(t.err()).toBe("");
    expect(t.lines().filter((l) => l === `        ${passRefused("AccessKeyNotFound")}`)).toHaveLength(1);
    expect(t.lines()).toContain(PROOF_HEADER);
    // The key file is gone, the session file says burned, and the proof was signed with the deleted key.
    expect(existsSync(sessionKeyPath(session, env))).toBe(false);
    const file = JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", "ks-7f3a.json"), "utf8"));
    // The recorded hash is the one signBurn computed for the tx it signed (fresh keys here), the one the TxLine prints.
    const txLine = t.lines().find((l) => l.startsWith("tx "));
    expect(txLine).toMatch(/^tx \S+ · final · sandbox \(no explorer\)$/);
    expect(file).toMatchObject({ status: "burned", burnTxHashes: [txLine?.split(" ")[1]] });
    const [deleteKey, proof] = sends(log);
    expect(isKey(deleteKey.publicKey, seatKey.getPublicKey().toString())).toBe(true);
    expect(isKey(proof.publicKey, fcKey.getPublicKey().toString())).toBe(true);
    expect(t.lines().at(-1)).toMatch(/^session ks-7f3a · burned · \d{2}:\d{2}:\d{2}Z$/);
  });

  it("already burned on chain: no DeleteKey, no operator key; the key file is still there, so the proof is an attempt, and the burn is recorded", async () => {
    const { env, session } = await persisted();
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch({ status: STATUS, "query:view_access_key": KEY_GONE, block: BLOCK, send_tx: AFTER_BURN });
    const t = term(process.env);
    expect(await main(["burn", "ks-7f3a"], t.io, {})).toBe(0);
    expect(t.lines()[1]).toBe(ALREADY_BURNED);
    expect(t.lines().filter((l) => l === `        ${passRefused("AccessKeyNotFound")}`)).toHaveLength(1);
    expect(log.filter((r) => r.method === "send_tx")).toHaveLength(1); // the proof only
    expect(fullAccessKeyLoadCount()).toBe(loads);
    expect(existsSync(sessionKeyPath(session, env))).toBe(false); // the local cleanup ran
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", "ks-7f3a.json"), "utf8")).status).toBe("burned");

    // Run again, as a new process (no key held): no key file now, so the proof is the view_access_key body.
    dropHeldKeys();
    const again = term(process.env);
    const log2 = replayFetch({ "query:view_access_key": KEY_GONE });
    expect(await main(["burn", "ks-7f3a"], again.io, {})).toBe(0);
    expect(again.lines()[1]).toBe(ALREADY_BURNED);
    expect(again.lines()).toContain(`        ${PASS_KEY_GONE}`);
    expect(log2.every((r) => r.method === "query")).toBe(true);
  });

  it("M7: the keychain's operator key is not on chain (signAndSend refuses it): exit 2, the session stays live, its files stay", async () => {
    const { env, session } = await persisted();
    saveAccountKey("sandbox", "seat.sandbox", KeyPair.fromRandom("ed25519"), env); // a key seat.sandbox does not have
    // the CLI's read and signBurn's read find the session key; the operator key's nonce read finds no such key
    const log = replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, KEY_PRESENT, KEY_GONE] });
    const t = term(process.env);
    expect(await main(["burn", "ks-7f3a"], t.io, {})).toBe(2);
    expect(t.err()).toMatch(/^ERROR \(environment\): seat\.sandbox has no access key ed25519:\S+ on sandbox \(the keychain's full-access key for seat\.sandbox\); nothing was signed: session ks-7f3a stays live/);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", "ks-7f3a.json"), "utf8")).status).toBe("live");
  });

  it("operator key missing (an empty keychain): ERROR (environment), exit 2, the session stays live and its files stay", async () => {
    const { env, session } = await persisted();
    const loads = fullAccessKeyLoadCount();
    const log = replayFetch({ "query:view_access_key": KEY_PRESENT });
    const t = term(process.env);
    expect(await main(["burn", "ks-7f3a"], t.io, {})).toBe(2);
    expect(t.err()).toMatch(/^ERROR \(environment\): no full-access key for seat\.sandbox in /);
    expect(t.err()).toContain("session ks-7f3a stays live");
    expect(fullAccessKeyLoadCount()).toBe(loads + 1);
    expect(log.some((r) => r.method === "send_tx")).toBe(false);
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);
    expect(JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", "ks-7f3a.json"), "utf8")).status).toBe("live");
  });
});
