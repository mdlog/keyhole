/**
 * Task 13 offline suite (no socket, no sandbox, no key file): smokePhase, phase 7 of `runDemo --sandbox`, with the
 * chain mocked. Every chain-facing function it calls is a vi.fn backed by a small fake (FakeCounter below); the rest is
 * the real code (mustSucceed, outcomeFromBody, buildCageCard "preview", the counter pack, the pinned wasm read). The
 * landed and refused bodies are committed captures: the spike's, and T11's counter dry-runs.
 *
 * - The happy path: six steps numbered after n0, phase smoke, every PASS measured; what is signed, by whom, with what.
 * - Every PASS is earned: [16] needs get_value +1; [17] passes only on a panic holding RESET_PANIC (not any panic, not
 *   a landing); [18] only on NotEnoughAllowance from the send (not a landing, not another name); [19] only when the
 *   account and both keys are gone; [15] needs the dry-run's WARN and the key read back.
 * - A FAIL never stops the phase: it always yields six steps; nothing is sent twice (C-T2i); after an unfinished burn
 *   [20] is not sent; without a session [16]–[20] are not sent and nothing is signed.
 */
import { join } from "node:path";
import { type Action, KeyPair, baseEncode } from "near-api-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEAR, TGAS } from "../src/core/amounts.js";
import { LandedUnsettledError, outcomeFromBody, sendAttempt } from "../src/core/attempt.js";
import { signBurn } from "../src/core/burn.js";
import { EnvironmentError } from "../src/core/errors.js";
import { dropHeldKeys, sessionKeyPair } from "../src/core/keys.js";
import { callView, viewAccount, viewScopedKey } from "../src/core/rpc.js";
import type { SandboxHandle } from "../src/core/sandbox.js";
import { SendFateUnknownError, type SentTx, signAndSend } from "../src/core/tx.js";
import type { AttemptInput, ContractPanic, DemoStep, Session, TargetPack, ToolSchema, WrapOptions, WrapPlan } from "../src/core/types.js";
import { planWrap, sessionFromPlan, signWrap } from "../src/core/wrap.js";
import { RESET_PANIC, SMOKE_STEPS, smokePhase } from "../src/demo/smoke.js";
import { loadTargetPack } from "../src/packs/index.js";
import { failExpected, warnInconclusive, warnRuntime } from "../src/render/strings.js";
import { REPO, SANDBOX_FIXTURES, readFixture } from "./helpers.js";

vi.mock("../src/core/attempt.js", async (io) => ({ ...(await io<typeof import("../src/core/attempt.js")>()), sendAttempt: vi.fn() }));
vi.mock("../src/core/tx.js", async (io) => ({ ...(await io<typeof import("../src/core/tx.js")>()), signAndSend: vi.fn() }));
vi.mock("../src/core/rpc.js", async (io) => ({ ...(await io<typeof import("../src/core/rpc.js")>()), viewAccount: vi.fn(), viewScopedKey: vi.fn(), callView: vi.fn() }));
vi.mock("../src/core/wrap.js", async (io) => ({ ...(await io<typeof import("../src/core/wrap.js")>()), planWrap: vi.fn(), signWrap: vi.fn() }));
vi.mock("../src/core/burn.js", async (io) => ({ ...(await io<typeof import("../src/core/burn.js")>()), signBurn: vi.fn() }));
// The real packs, watched: one test hands smokePhase a counter pack whose tests expect other names.
vi.mock("../src/packs/index.js", async (io) => {
  const real = await io<typeof import("../src/packs/index.js")>();
  return { ...real, loadTargetPack: vi.fn(real.loadTargetPack) };
});

const FIXTURES = join(REPO, "demo", "fixtures");
const BODY = {
  landed: readFixture(SANDBOX_FIXTURES, "004-a-create-seat.send_tx.json"),
  vote: readFixture(SANDBOX_FIXTURES, "027-e-fc-vote-approve-0.send_tx.json"),
  notEnoughAllowance: readFixture(SANDBOX_FIXTURES, "077-j-attempt-1yocto-key.send_tx.json"),
  resetPanic: readFixture(FIXTURES, "sandbox.counter.dryrun-reset-zero.json"),
  ownerPanic: readFixture(FIXTURES, "sandbox.counter.dryrun-transfer_ownership-zero.json"),
  methodMismatch: readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json"),
  signerGone: JSON.stringify({
    jsonrpc: "2.0",
    error: { name: "HANDLER_ERROR", cause: { info: {}, name: "INVALID_TRANSACTION" }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: { SignerDoesNotExist: { signer_id: "ks-7f3a.sandbox" } } } } },
    id: "k",
  }),
} as const;

const hash = (label: string): string => baseEncode(Buffer.from(label.padEnd(32, "#").slice(0, 32)));
const sent = (label: string, raw: string = BODY.landed): SentTx => ({ txHash: hash(label), raw, json: JSON.parse(raw) });
const ROOT_KEY = KeyPair.fromRandom("ed25519");
const SESSION_KEY = KeyPair.fromRandom("ed25519");
const SESSION_PUB = SESSION_KEY.getPublicKey().toString();
const ALLOWANCE = (5n * NEAR) / 100n;
const TINY = NEAR / 100n;

let pack: TargetPack;
let sb: SandboxHandle & { stop: ReturnType<typeof vi.fn> };

/** The counter, the session sub-account and its keys behind the mocks. */
class FakeCounter {
  value = 0;
  /** Keys on ks-7f3a.sandbox, by public key: receiver, methods, allowance. */
  keys = new Map<string, { receiverId: string; methodNames: string[]; allowance: string }>();
  accountGone = false;
  /** What sendAttempt answers, per call: the default plays a well-behaved chain. */
  answer: (session: Session, input: AttemptInput) => string = (session, input) => {
    if (this.accountGone) return BODY.signerGone;
    if (session.publicKey !== SESSION_PUB) return BODY.notEnoughAllowance;
    if (input.method === "increment") {
      this.value++;
      return BODY.vote;
    }
    return BODY.resetPanic;
  };
}
let chain: FakeCounter;

function setUp(): void {
  chain = new FakeCounter();
  const stop = vi.fn(async () => undefined);
  sb = { rpcUrl: "http://127.0.0.1:1", rootId: "sandbox", stop } as unknown as SandboxHandle & { stop: typeof stop };
  Object.defineProperty(sb, "rootKey", { value: ROOT_KEY, enumerable: false });
  vi.mocked(signAndSend).mockImplementation(async (_network, signerId, _key, receiverId, acts: Action[]) => {
    if (signerId === "sandbox" && receiverId === "counter.sandbox") return sent("deploy");
    const add = (acts[0] as { addKey?: { publicKey: { toString(): string }; accessKey: { permission: { functionCall: { receiverId: string; methodNames: string[]; allowance: bigint } } } } }).addKey;
    if (add && signerId === receiverId) {
      const fc = add.accessKey.permission.functionCall;
      chain.keys.set(add.publicKey.toString(), { receiverId: fc.receiverId, methodNames: [...fc.methodNames], allowance: fc.allowance.toString() });
      return sent("addkey");
    }
    throw new Error(`fake chain: unexpected send ${signerId} -> ${receiverId}`);
  });
  vi.mocked(planWrap).mockImplementation(async (opts: WrapOptions): Promise<WrapPlan> => {
    const tools: ToolSchema[] = [
      ...pack.tools.map((t): ToolSchema => {
        const { dryRun: _d, ...tool } = t;
        if (t.kind !== "call") return tool;
        return { ...tool, classification: t.method === "reset" ? "fails-without-deposit (runtime)" : "callable" };
      }),
      { name: "transfer_ownership", kind: "call", method: "transfer_ownership", argsSchema: {}, gasTGas: 30, classification: "not in allowlist" },
    ];
    const draft = {
      id: "ks-7f3a",
      mode: "subaccount" as const,
      network: opts.network,
      accountId: `ks-7f3a.${opts.operatorId}`,
      receiverId: opts.contract,
      methodNames: [...opts.allow],
      allowanceYocto: opts.allowanceYocto,
      codeHashPin: pack.sandboxFixture!.codeHash,
      publicKey: SESSION_PUB,
      packId: "counter",
      tools,
    };
    return { draft, txActions: [], tools, warnings: [warnRuntime("reset")], signerId: opts.operatorId!, fundingYocto: (ALLOWANCE + NEAR / 100n).toString(), dryRunMs: 5 };
  });
  vi.mocked(signWrap).mockImplementation(async (plan) => {
    chain.keys.set(SESSION_PUB, { receiverId: plan.draft.receiverId, methodNames: [...plan.draft.methodNames], allowance: plan.draft.allowanceYocto });
    return { session: sessionFromPlan(plan), txHash: hash("wrap") };
  });
  vi.mocked(viewScopedKey).mockImplementation(async (session) => {
    const k = chain.accountGone ? undefined : chain.keys.get(session.publicKey);
    return k ? { publicKey: session.publicKey, accountId: session.accountId, receiverId: k.receiverId, methodNames: k.methodNames, allowanceRemainingYocto: k.allowance, nonce: 7 } : null;
  });
  vi.mocked(viewAccount).mockImplementation(async () => (chain.accountGone ? null : { amountYocto: "1", codeHash: "11111111111111111111111111111111" }));
  vi.mocked(callView).mockImplementation(async (_session, method) => {
    if (method !== "get_value") throw new Error(`fake counter: unexpected view ${method}`);
    return chain.value;
  });
  vi.mocked(sendAttempt).mockImplementation(async (session, input) => ({ ...input, outcome: outcomeFromBody(chain.answer(session, input))! }));
  vi.mocked(signBurn).mockImplementation(async (session) => {
    chain.accountGone = true;
    return { session: { ...session, status: "burned", burnedAt: "2026-11-06T12:00:00.000Z", burnTxHashes: [hash("burn")] }, txHashes: [hash("burn")] };
  });
}

/** A fresh fake chain and fresh mocks, for a second run inside one test. */
function again(): void {
  vi.clearAllMocks();
  setUp();
}

async function drain(): Promise<DemoStep[]> {
  const steps: DemoStep[] = [];
  for await (const s of smokePhase({ sb, n0: 14, total: 20 })) steps.push(s);
  return steps;
}

/** The sendAttempt calls, as [public key, method]. */
const attempts = () => vi.mocked(sendAttempt).mock.calls.map(([s, i]) => [s.publicKey === SESSION_PUB ? "session" : "other", i.method]);

describe("smokePhase (chain mocked)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pack = await loadTargetPack("counter");
    setUp();
  });

  it("yields six smoke steps after n0, every PASS measured, with what was signed, by whom", async () => {
    const steps = await drain();
    expect(SMOKE_STEPS).toBe(6);
    expect(steps.map((s) => [s.n, s.total, s.phase])).toEqual([15, 16, 17, 18, 19, 20].map((n) => [n, 20, "smoke"]));
    expect(steps.filter((s) => !s.pass).map((s) => `[${s.n}] ${s.note}`)).toEqual([]);
    expect(steps.map((s) => s.signer)).toEqual(["operator", "session", "session", "session", "operator", "session"]);

    // [15]: the deploy (root, pinned wasm, `new {owner: cosigner}`), then the sub-account wrap with the root's key.
    const [deploy] = vi.mocked(signAndSend).mock.calls;
    expect(deploy.slice(0, 4)).toEqual(["sandbox", "sandbox", ROOT_KEY, "counter.sandbox"]);
    expect(deploy[4].map((a) => Object.keys(a)[0])).toEqual(["createAccount", "transfer", "deployContract", "functionCall"]);
    const init = (deploy[4][3] as unknown as { functionCall: { methodName: string; args: Uint8Array; gas: bigint } }).functionCall;
    expect([init.methodName, JSON.parse(Buffer.from(init.args).toString()), init.gas]).toEqual(["new", { owner: "cosigner.sandbox" }, 100n * TGAS]);
    expect(vi.mocked(planWrap).mock.calls[0]).toEqual([{ contract: "counter.sandbox", allow: ["increment", "reset"], allowanceYocto: ALLOWANCE.toString(), operatorId: "sandbox", network: "sandbox" }, { sandbox: sb }]);
    expect(vi.mocked(signWrap).mock.calls[0][1]).toEqual({ persist: false, signerKey: ROOT_KEY });
    expect(steps[0]).toMatchObject({ txHash: hash("deploy"), moreTxHashes: [hash("wrap")], card: { source: "preview", session: { id: "ks-7f3a" } } });
    expect(steps[0].note).toBe("WARN  reset — fails-without-deposit (runtime) · key on chain: gas allowance 0.0500 NEAR");
    expect(steps[0].label).toBe("sandbox deploys counter.sandbox and wraps it in a sub-account: increment, reset");

    // [16] [17]: the session key, increment then reset with no deposit, each at its tool's 30 TGas.
    expect(vi.mocked(sendAttempt).mock.calls.slice(0, 2).map(([, i]) => i)).toEqual([
      { sessionId: "ks-7f3a", receiverId: "counter.sandbox", action: "FunctionCall", method: "increment", args: {}, depositYocto: "0", gasTGas: 30, violates: "none" },
      { sessionId: "ks-7f3a", receiverId: "counter.sandbox", action: "FunctionCall", method: "reset", args: {}, depositYocto: "0", gasTGas: 30, violates: "none" },
    ]);
    expect(steps[1]).toMatchObject({ label: "the session (ks-7f3a.sandbox) calls increment", attempt: { outcome: { kind: "TxSuccess" } }, note: "get_value 0 -> 1 (view before and after)" });
    expect(steps[2]).toMatchObject({ attempt: { outcome: { kind: "ContractPanic" } }, note: "get_value still 1 (view before and after)" });
    expect((steps[2].attempt!.outcome as ContractPanic).message).toContain(RESET_PANIC);
    expect(steps[2].txHash).toBe((steps[2].attempt!.outcome as ContractPanic).txHash);

    // [18]: AddKey by the operator key, signed as the sub-account: the session's scope with 0.01 NEAR; then the pack's
    // refuse-allowance attempt with that key.
    const [, addKey] = vi.mocked(signAndSend).mock.calls;
    expect(addKey.slice(0, 4)).toEqual(["sandbox", "ks-7f3a.sandbox", ROOT_KEY, "ks-7f3a.sandbox"]);
    const tinyPub = [...chain.keys.keys()].find((k) => k !== SESSION_PUB)!;
    expect(chain.keys.get(tinyPub)).toEqual({ receiverId: "counter.sandbox", methodNames: ["increment", "reset"], allowance: TINY.toString() });
    const [tinySession, tinyInput] = vi.mocked(sendAttempt).mock.calls[2];
    expect(tinySession).toMatchObject({ id: "ks-7f3a", accountId: "ks-7f3a.sandbox", publicKey: tinyPub, allowanceYocto: TINY.toString() });
    expect(tinyInput).toEqual({ sessionId: "ks-7f3a", receiverId: "counter.sandbox", action: "FunctionCall", method: "increment", args: {}, depositYocto: "0", gasTGas: 30, violates: "allowance" });
    expect(steps[3]).toMatchObject({
      label: "call with a key whose allowance is below the prepaid gas",
      fixture: "sandbox.counter.refuse-allowance.json",
      moreTxHashes: [hash("addkey")],
      note: `AddKey (0.0100 NEAR) by the operator key · tx ${hash("addkey")}`,
      attempt: { outcome: { kind: "Refusal", errorName: "NotEnoughAllowance" } },
    });
    expect(steps[3].txHash).toBeUndefined();

    // [19] [20]: the burn with the root's key, nothing persisted; then the session key against a gone account.
    expect(vi.mocked(signBurn).mock.calls).toEqual([[expect.objectContaining({ id: "ks-7f3a", publicKey: SESSION_PUB }), { persist: false, signerKey: ROOT_KEY }]]);
    expect(steps[4]).toMatchObject({ label: "ks-7f3a.sandbox signs DeleteKey + DeleteAccount (to sandbox) with the operator key", txHash: hash("burn"), note: "account gone (view_account); both keys went with it (view_access_key)" });
    expect(vi.mocked(viewScopedKey).mock.calls.slice(-2).map(([s]) => s.publicKey)).toEqual([SESSION_PUB, tinyPub]);
    expect(vi.mocked(sendAttempt).mock.calls[3][0]).toMatchObject({ status: "burned", publicKey: SESSION_PUB });
    expect(steps[5]).toMatchObject({ label: "call after the session sub-account is deleted", fixture: "sandbox.counter.after-burn.json", attempt: { violates: "none", outcome: { errorName: "SignerDoesNotExist" } } });
    expect(steps[5].note).toBeUndefined(); // the step log prints NOTE_SIGNER_GONE from the outcome (phase smoke)
    expect(attempts()).toEqual([["session", "increment"], ["session", "reset"], ["other", "increment"], ["session", "increment"]]);
  });

  it("[16] FAILs when get_value did not go up by one, and the phase goes on", async () => {
    const answer = chain.answer;
    chain.answer = (s, i) => (i.method === "increment" && s.publicKey === SESSION_PUB && !chain.accountGone ? BODY.vote : answer(s, i)); // lands, counts nothing
    const steps = await drain();
    expect(steps[1]).toMatchObject({ pass: false, note: "FAIL: get_value 0 -> 0, not +1" });
    expect(steps).toHaveLength(6);
    expect(steps.slice(2).every((s) => s.pass)).toBe(true);
  });

  it("[16] needs a landing: a panic body FAILs even if get_value moved", async () => {
    const answer = chain.answer;
    chain.answer = (s, i) => {
      if (i.method !== "increment" || s.publicKey !== SESSION_PUB || chain.accountGone) return answer(s, i);
      chain.value++;
      return BODY.resetPanic;
    };
    const steps = await drain();
    expect(steps[1]).toMatchObject({ pass: false, note: "FAIL: expected increment to land as TxSuccess, got ContractPanic" });
  });

  it("[17] FAILs when the failed call moved get_value", async () => {
    const answer = chain.answer;
    chain.answer = (s, i) => {
      if (i.method === "reset") chain.value = 0;
      return answer(s, i);
    };
    const steps = await drain();
    expect(steps[2]).toMatchObject({ pass: false, note: "FAIL: get_value 1 -> 0: the failed call changed state", attempt: { outcome: { kind: "ContractPanic" } } });
  });

  it("[17] passes only on a panic holding the contract's words: another panic, or a landing, is a FAIL", async () => {
    const answer = chain.answer;
    chain.answer = (s, i) => (i.method === "reset" ? BODY.ownerPanic : answer(s, i));
    let steps = await drain();
    expect((steps[2].attempt!.outcome as ContractPanic).message).toContain("only the owner");
    expect(steps[2]).toMatchObject({ pass: false, note: `FAIL: the panic text lacks "${RESET_PANIC}"` });
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([17]);

    again();
    const answer2 = chain.answer;
    chain.answer = (s, i) => (i.method === "reset" ? BODY.vote : answer2(s, i));
    steps = await drain();
    expect(steps[2]).toMatchObject({ pass: false, note: "FAIL: expected reset to panic in a block, got TxSuccess" });
  });

  it("[18] passes only on NotEnoughAllowance from the send: a landing or another name is a FAIL", async () => {
    const answer = chain.answer;
    chain.answer = (s, i) => (s.publicKey !== SESSION_PUB ? BODY.vote : answer(s, i));
    let steps = await drain();
    expect(steps[3]).toMatchObject({ pass: false, note: failExpected("NotEnoughAllowance", "no refusal (landed: TxSuccess)"), attempt: { outcome: { kind: "TxSuccess" } } });
    expect(steps[3].txHash).toBe((steps[3].attempt!.outcome as { txHash: string }).txHash);

    again();
    const answer2 = chain.answer;
    chain.answer = (s, i) => (s.publicKey !== SESSION_PUB ? BODY.methodMismatch : answer2(s, i));
    steps = await drain();
    expect(steps[3]).toMatchObject({ pass: false, note: failExpected("NotEnoughAllowance", "MethodNameMismatch") });
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([18]);
  });

  it("[18] is not sent when the second key is not on chain as planned; the burn still runs", async () => {
    vi.mocked(viewScopedKey).mockImplementation(async (session) => {
      const k = chain.accountGone ? undefined : chain.keys.get(session.publicKey);
      if (!k) return null;
      const allowance = session.publicKey === SESSION_PUB ? k.allowance : "1"; // the chain says another allowance
      return { publicKey: session.publicKey, accountId: session.accountId, receiverId: k.receiverId, methodNames: k.methodNames, allowanceRemainingYocto: allowance, nonce: 7 };
    });
    const steps = await drain();
    expect(steps[3]).toMatchObject({ pass: false, moreTxHashes: [hash("addkey")] });
    expect(steps[3].note).toMatch(/^FAIL: not sent: the second key is not on chain as planned: the key's allowance is 1 yocto, not 10000000000000000000000$/);
    expect(attempts()).toEqual([["session", "increment"], ["session", "reset"], ["session", "increment"]]);
    expect(steps[4]).toMatchObject({ pass: true, note: "account gone (view_account); its key went with it (view_access_key)" });
    expect(steps[5].pass).toBe(true);
  });

  it("an AddKey refused at validation is a FAIL with nothing sent with that key", async () => {
    const real = vi.mocked(signAndSend).getMockImplementation()!;
    vi.mocked(signAndSend).mockImplementation(async (...a) => (a[1] === a[3] ? sent("addkey", BODY.notEnoughAllowance) : real(...a)));
    const steps = await drain();
    expect(steps[3].pass).toBe(false);
    expect(steps[3].note).toMatch(/^FAIL: not sent: ERROR \(environment\): AddKey of a second key on ks-7f3a\.sandbox: refused at validation \(NotEnoughAllowance\)/);
    expect(steps[3].moreTxHashes).toBeUndefined(); // never in a block: no hash to count
    expect(attempts().filter(([who]) => who === "other")).toEqual([]);
    expect(signBurn).toHaveBeenCalledTimes(1);
  });

  it("[19] FAILs while the account or a key is still there; after a burn that threw, [20] is not sent", async () => {
    vi.mocked(viewAccount).mockResolvedValue({ amountYocto: "1", codeHash: "11111111111111111111111111111111" });
    let steps = await drain();
    expect(steps[4]).toMatchObject({ pass: false, note: "FAIL: ks-7f3a.sandbox still exists (view_account)" });
    expect(steps[5].pass).toBe(true); // the burn landed: [20] is sent

    again();
    vi.mocked(signBurn).mockImplementation(async (session) => {
      chain.accountGone = true;
      return { session: { ...session, status: "burned" }, txHashes: [] }; // the chain had no key: nothing was sent
    });
    steps = await drain();
    expect(steps[4]).toMatchObject({ pass: false, note: "FAIL: expected one DeleteKey + DeleteAccount tx, got 0" });

    again();
    vi.mocked(signBurn).mockRejectedValue(new EnvironmentError("burn ks-7f3a: failed in a block: x · tx H", "read the tx"));
    steps = await drain();
    expect(steps[4]).toMatchObject({ pass: false, note: "FAIL: ERROR (environment): burn ks-7f3a: failed in a block: x · tx H · read the tx" });
    expect(steps[5]).toEqual({ n: 20, total: 20, phase: "smoke", label: "call after the session sub-account is deleted", signer: "session", pass: false, note: "FAIL: not sent: the burn [19] did not finish, so the key may still be on chain" });
    expect(attempts()).toEqual([["session", "increment"], ["session", "reset"], ["other", "increment"]]);
  });

  it("nothing is sent twice: a landed-unsettled increment is a FAIL carrying its attempt; a fate-unknown send names its tx", async () => {
    const real = vi.mocked(sendAttempt).getMockImplementation()!;
    vi.mocked(sendAttempt).mockImplementation(async (session, input) => {
      if (input.method === "increment" && session.publicKey === SESSION_PUB && !chain.accountGone) {
        const attempt = { ...input, outcome: outcomeFromBody(BODY.vote)! };
        throw new LandedUnsettledError(attempt, attempt.outcome as never, new EnvironmentError("tx X: receipt tree incomplete after 20 tx polls", "wait"));
      }
      if (input.method === "reset") throw new SendFateUnknownError("FATE", "ks-7f3a.sandbox", "no answer");
      return real(session, input);
    });
    const steps = await drain();
    expect(steps[1]).toMatchObject({ pass: false, attempt: { outcome: { kind: "TxSuccess" } } });
    expect(steps[1].note).toMatch(/^FAIL: ERROR \(environment\): the attempt landed in a block \(TxSuccess/);
    expect(steps[2].pass).toBe(false);
    expect(steps[2].attempt).toBeUndefined();
    expect(steps[2].note).toContain("FATE");
    expect(attempts()).toEqual([["session", "increment"], ["session", "reset"], ["other", "increment"], ["session", "increment"]]);
    expect(steps.slice(3).every((s) => s.pass)).toBe(true);
  });

  it("[15] needs the dry-run's WARN for reset and the key read back; the session is kept, so [16]–[20] still run", async () => {
    const real = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => ({ ...(await real(...a)), warnings: [] }));
    vi.mocked(viewScopedKey).mockResolvedValueOnce(null);
    const steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, moreTxHashes: [hash("wrap")] });
    expect(steps[0].note).toBe(`FAIL: no key ${SESSION_PUB} on ks-7f3a.sandbox (view_access_key); expected one WARN, for reset; wrap gave 0`);
    expect(steps.slice(1).every((s) => s.pass)).toBe(true);
    expect(signBurn).toHaveBeenCalledTimes(1);
  });

  it("[15] FAILs when the pin is not the counter pack's code hash", async () => {
    const real = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => {
      const plan = await real(...a);
      return { ...plan, draft: { ...plan.draft, codeHashPin: "11111111111111111111111111111111" } };
    });
    const steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, note: `FAIL: pinned 11111111111111111111111111111111 (pack counter), not the counter pack's ${pack.sandboxFixture!.codeHash}` });
  });

  it("[15] FAILs on a dry-run that labelled reset otherwise", async () => {
    const real = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => {
      const plan = await real(...a);
      const tools = plan.draft.tools.map((t) => (t.method === "reset" ? { ...t, classification: "callable" as const } : t));
      return { ...plan, draft: { ...plan.draft, tools } };
    });
    const steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, note: "FAIL: the dry-run labelled increment callable and reset callable, not callable and fails-without-deposit (runtime)" });
  });

  it("a wrap that fails leaves no session: [15] FAILs with the deploy's hash, [16]–[20] are not sent, nothing else is signed", async () => {
    vi.mocked(signWrap).mockRejectedValue(new EnvironmentError("wrap ks-7f3a: refused at validation (NotEnoughBalance), never in a block · tx W", "check"));
    const steps = await drain();
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => [s.n, s.pass])).toEqual([15, 16, 17, 18, 19, 20].map((n) => [n, false]));
    expect(steps[0]).toMatchObject({ txHash: hash("deploy"), note: "FAIL: ERROR (environment): wrap ks-7f3a: refused at validation (NotEnoughBalance), never in a block · tx W · check" });
    expect(steps[0].moreTxHashes).toBeUndefined();
    for (const s of steps.slice(1)) expect(s.note).toBe("FAIL: not sent: [15] did not wrap a session");
    expect(steps.slice(1).map((s) => s.label)).toEqual([
      "the session calls increment",
      "the session calls reset with no deposit",
      "call with a key whose allowance is below the prepaid gas",
      "the session sub-account signs DeleteKey + DeleteAccount",
      "call after the session sub-account is deleted",
    ]);
    expect(sendAttempt).not.toHaveBeenCalled();
    expect(signBurn).not.toHaveBeenCalled();
    expect(vi.mocked(signAndSend).mock.calls).toHaveLength(1); // the deploy only
  });

  it("a deploy that failed in a block leaves no session and no hash to count", async () => {
    const failed = readFixture(FIXTURES, "sandbox.counter.dryrun-reset-zero.json"); // a landed-failed body
    vi.mocked(signAndSend).mockResolvedValueOnce(sent("deploy", failed));
    const steps = await drain();
    expect(steps[0].pass).toBe(false);
    expect(steps[0].note).toMatch(/^FAIL: ERROR \(environment\): create counter\.sandbox, deploy contracts\/counter\/res\/counter\.wasm and new: failed in a block/);
    expect(steps[0].txHash).toBe(hash("deploy")); // it is in a block: its hash is shown
    expect(planWrap).not.toHaveBeenCalled();
    expect(steps.slice(1).every((s) => !s.pass && s.note === "FAIL: not sent: [15] did not wrap a session")).toBe(true);
  });

  it("a counter pack whose tests expect other names is refused before anything is signed", async () => {
    const edited = structuredClone(pack);
    edited.negativeTests = edited.negativeTests.map((t) => (t.id === "refuse-allowance" ? { ...t, expected: "MethodNameMismatch" as const } : t));
    vi.mocked(loadTargetPack).mockResolvedValueOnce(edited);
    const steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, note: "FAIL: ERROR (environment): target pack counter: its refuse-allowance test is not an increment on the counter expecting NotEnoughAllowance · restore src/packs/counter.pack.json" });
    expect(signAndSend).not.toHaveBeenCalled();
    expect(steps.slice(1).every((s) => !s.pass)).toBe(true);
  });

  // -------------------------------------------------------------------------------------------------------------
  // C-T13a (final sweep): the offline pins the T13 review found missing (M1, M2, M3). Each test below kills mutants
  // that survived the suite; the behaviour was already right.

  it("C-T13a M1: [20] passes only on SignerDoesNotExist: a landing, or another refusal name, is a FAIL (the shared refusalFields)", async () => {
    const answer = chain.answer;
    chain.answer = (s, i) => (chain.accountGone ? BODY.vote : answer(s, i));
    let steps = await drain();
    expect(steps[5]).toMatchObject({ pass: false, note: failExpected("SignerDoesNotExist", "no refusal (landed: TxSuccess)"), attempt: { outcome: { kind: "TxSuccess" } } });
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([20]);

    again();
    const answer2 = chain.answer;
    chain.answer = (s, i) => (chain.accountGone ? BODY.methodMismatch : answer2(s, i));
    steps = await drain();
    expect(steps[5]).toMatchObject({ pass: false, note: failExpected("SignerDoesNotExist", "MethodNameMismatch") });
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([20]);
  });

  it.each([
    ["view_account rejects after the burn", () => vi.mocked(viewAccount).mockRejectedValue(new EnvironmentError("RPC down (view_account)", "retry"))],
    [
      "view_access_key rejects after the burn",
      () => {
        const real = vi.mocked(viewScopedKey).getMockImplementation()!;
        vi.mocked(viewScopedKey).mockImplementation(async (session) => {
          if (chain.accountGone) throw new EnvironmentError("RPC down (view_access_key)", "retry");
          return real(session);
        });
      },
    ],
  ])("C-T13a M2: [19] with a verifying read that throws (%s) is a FAIL naming the error, never a PASS with nothing checked; [20] is still sent", async (_what, arrange) => {
    arrange();
    const steps = await drain();
    expect(steps[4]).toMatchObject({ pass: false, txHash: hash("burn") });
    expect(steps[4].note).toMatch(/^FAIL: ERROR \(environment\): RPC down \(view_(account|access_key)\) · retry$/);
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([19]);
    expect(steps[5].pass).toBe(true); // the burn itself landed
  });

  // The pack guard (smoke.ts smokeTests) checks the expected name, the receiver, the action and the method of both tests.
  it.each([
    ["refuse-allowance", "its receiver", { receiver: "other-receiver" as const }],
    ["refuse-allowance", "its action", { action: "Transfer" as const }],
    ["refuse-allowance", "its method", { method: "reset" }],
    ["after-burn", "its receiver", { receiver: "attacker" as const }],
    ["after-burn", "its action", { action: "Transfer" as const }],
    ["after-burn", "its method", { method: "reset" }],
    ["after-burn", "its expected name", { expected: "AccessKeyNotFound" as const }],
  ])("C-T13a M3: a counter pack whose %s test has another %s is refused before anything is signed", async (id, _what, change) => {
    const edited = structuredClone(pack);
    edited.negativeTests = edited.negativeTests.map((t) => (t.id === id ? { ...t, ...change } : t));
    vi.mocked(loadTargetPack).mockResolvedValueOnce(edited);
    const steps = await drain();
    const want = id === "refuse-allowance" ? "NotEnoughAllowance" : "SignerDoesNotExist";
    expect(steps[0]).toMatchObject({ pass: false, note: `FAIL: ERROR (environment): target pack counter: its ${id} test is not an increment on the counter expecting ${want} · restore src/packs/counter.pack.json` });
    expect(signAndSend).not.toHaveBeenCalled();
    expect(steps.slice(1).every((s) => !s.pass)).toBe(true);
  });

  it("C-T13a M3: a counter pack with no refuse-allowance test is refused, naming the missing test", async () => {
    const edited = structuredClone(pack);
    edited.negativeTests = edited.negativeTests.filter((t) => t.id !== "refuse-allowance");
    vi.mocked(loadTargetPack).mockResolvedValueOnce(edited);
    const steps = await drain();
    expect(steps[0].note).toContain("target pack counter: no refuse-allowance test");
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it("C-T13a M3: [15] accepts exactly one WARN, and it is the one for reset: two, or another one, is a FAIL", async () => {
    const real = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => ({ ...(await real(...a)), warnings: [warnRuntime("reset"), warnInconclusive("increment")] }));
    let steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, note: "FAIL: expected one WARN, for reset; wrap gave 2" });
    expect(steps.slice(1).every((s) => s.pass)).toBe(true);

    again();
    const real2 = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => ({ ...(await real2(...a)), warnings: [warnInconclusive("reset")] }));
    steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, note: "FAIL: expected one WARN, for reset; wrap gave 1" });
  });

  it("C-T13a M3: [17] needs the contract's whole sentence, not a prefix of it", async () => {
    const answer = chain.answer;
    const weaker = BODY.resetPanic.replaceAll("exactly 1 yoctoNEAR", "at least 5 yoctoNEAR"); // still "Requires attached deposit of ..."
    expect(weaker).not.toBe(BODY.resetPanic);
    chain.answer = (s, i) => (i.method === "reset" ? weaker : answer(s, i));
    const steps = await drain();
    expect((steps[2].attempt!.outcome as ContractPanic).message).toContain("Requires attached deposit of at least 5 yoctoNEAR");
    expect(steps[2]).toMatchObject({ pass: false, note: `FAIL: the panic text lacks "${RESET_PANIC}"` });
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([17]);
  });

  it.each([
    ["an on-account session", { mode: "on-account" as const }, /^FAIL: expected the session sub-account ks-7f3a\.sandbox, got ks-7f3a\.sandbox \(on-account\)$/],
    ["a session account that is not ID.root", { accountId: "other.sandbox" }, /^FAIL: expected the session sub-account ks-7f3a\.sandbox, got other\.sandbox \(subaccount\)$/],
  ])("C-T13a M3: [15] FAILs on %s", async (_what, draft, note) => {
    const real = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => {
      const plan = await real(...a);
      return { ...plan, draft: { ...plan.draft, ...draft } };
    });
    const steps = await drain();
    expect(steps[0].pass).toBe(false);
    expect(steps[0].note).toMatch(note);
  });

  it("C-T13a M3: [15] FAILs on a session of another pack even when its pin is the counter's", async () => {
    const real = vi.mocked(planWrap).getMockImplementation()!;
    vi.mocked(planWrap).mockImplementation(async (...a) => {
      const plan = await real(...a);
      return { ...plan, draft: { ...plan.draft, packId: "sputnik-v2" } };
    });
    const steps = await drain();
    expect(steps[0]).toMatchObject({ pass: false, note: `FAIL: pinned ${pack.sandboxFixture!.codeHash} (pack sputnik-v2), not the counter pack's ${pack.sandboxFixture!.codeHash}` });
  });

  it("C-T13a M3: the second key's private half is held in memory for sendAttempt, and only its public half is on chain", async () => {
    try {
      const steps = await drain();
      expect(steps.every((s) => s.pass)).toBe(true);
      const tinyPub = [...chain.keys.keys()].find((k) => k !== SESSION_PUB)!;
      const tinySession = vi.mocked(sendAttempt).mock.calls[2][0];
      expect(tinySession.publicKey).toBe(tinyPub);
      // sessionKeyPair reads a held key first; with none held it would look for a keychain file and throw.
      expect(sessionKeyPair(tinySession).getPublicKey().toString()).toBe(tinyPub);
    } finally {
      dropHeldKeys();
    }
  });

  it("the sandbox handle is the phase's only chain: nothing here stops it (the driver's finally does)", async () => {
    await drain();
    expect(sb.stop).not.toHaveBeenCalled();
  });
});
