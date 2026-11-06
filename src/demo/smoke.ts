/**
 * Phase 7, SMOKE (sandbox only; Task 13): steps [15]–[20] of `runDemo --sandbox`, in the hero's sandbox, after [14].
 * The counter contract (contracts/counter: the pinned wasm, its tools from the embedded near-abi) is wrapped in
 * sub-account mode with the sandbox root as the operator (LAYOUT R4 phase 7).
 *
 *   [15] The root creates counter.<root> with the pinned wasm and `new {owner: cosigner.<root>}` (the hero's cosigner;
 *        it signs nothing here), then planWrap + signWrap in sub-account mode: ks-XXXX.<root>, increment and reset,
 *        0.05 NEAR. PASS: both txs landed, the pin is the pack's code hash, the key reads back with the planned scope,
 *        and the dry-run labelled increment callable and reset fails-without-deposit (runtime). The note carries that
 *        WARN: the head of warnRuntime("reset"), because the whole line (141 columns) does not fit a 100-column row.
 *   [16] The session calls increment: TxSuccess, and get_value, read before and after, went up by exactly one.
 *   [17] The session calls reset with no deposit. PASS only on a ContractPanic whose message holds RESET_PANIC, the
 *        contract's own words (never "any panic"), with get_value unchanged. The step log prints PASS_RUNTIME from
 *        the outcome, so the note does not repeat it.
 *   [18] The operator's full-access key (the sub-account holds it since wrap) adds a second function-call key with
 *        the session's scope and 0.01 NEAR, below the 0.030919 NEAR a 30 TGas call buys up front; it is read back from
 *        chain. Then the pack's refuse-allowance test with that key, through sendAttempt. PASS only on
 *        NotEnoughAllowance parsed from the RPC body of that send: refused at validation, never in a block.
 *   [19] signBurn: DeleteKey + DeleteAccount (beneficiary the operator) in one tx. PASS: one tx; then view_account finds
 *        no account and view_access_key finds neither key. The second key is never deleted on its own: it dies with
 *        the account here.
 *   [20] The pack's after-burn test with the session key: SignerDoesNotExist. Its phase, `smoke`, keeps it a burn proof
 *        (C-T8d); the step log adds NOTE_SIGNER_GONE from the outcome, so the note does not repeat it.
 *
 * The driver's rules hold here too. Every PASS is measured from the chain. A FAIL never stops the phase: it always
 * yields its six steps, and a step that needs an earlier step's result is a FAIL "not sent" when that one did not
 * finish (after an unfinished burn [20] is not sent: the key may still be live). Once the session key is on chain
 * every step is guarded and the burn runs. Nothing is sent twice: a LandedUnsettledError is reported as the landed
 * attempt it carries, a SendFateUnknownError as a FAIL whose note names the tx. Keys stay in memory (the root's, and
 * two minted here); nothing is persisted.
 *
 * Nothing here is imported from driver.ts (driver.ts imports this module): `guarded`, `send`, `verdict` and
 * `withoutUndefined` are the driver's too, from the leaf module step-helpers.ts (C-T13a, M4); the fixture name is
 * restated.
 */
import { KeyPair, actions } from "near-api-js";
import { NEAR, TGAS, formatNear } from "../core/amounts.js";
import { signBurn } from "../core/burn.js";
import { buildCageCard } from "../core/cage.js";
import { EnvironmentError } from "../core/errors.js";
import { holdSessionKey } from "../core/keys.js";
import { callView, viewAccount, viewScopedKey } from "../core/rpc.js";
import type { SandboxHandle } from "../core/sandbox.js";
import { mustSucceed, signAndSend } from "../core/tx.js";
import type { Attempt, AttemptInput, DemoSigner, DemoStep, NegativeTest, ScopedKey, Session, TargetPack } from "../core/types.js";
import { planWrap, signWrap } from "../core/wrap.js";
import { loadTargetPack } from "../packs/index.js";
import { councilInitArgs, pinnedWasm } from "../packs/sputnik-setup.js";
import { nn } from "../render/refusal-block.js";
import { failExpected, warnRuntime } from "../render/strings.js";
import { type Sent, guarded, send, verdict, withoutUndefined } from "./step-helpers.js";

/** Steps this phase yields, always: [15]–[20]. */
export const SMOKE_STEPS = 6;

const PACK_ID = "counter";
/** The wrap's scope (LAYOUT R4 phase 7): increment lands, reset fails at runtime without its 1 yoctoNEAR. */
const METHODS = ["increment", "reset"] as const;
/** The session's gas allowance: 0.05 NEAR, as in the hero. */
const ALLOWANCE_YOCTO = (5n * NEAR) / 100n;
/** [18]'s second key: 0.01 NEAR, below the 0.030919 NEAR a 30 TGas call costs up front (PRD §7). */
const TINY_ALLOWANCE_YOCTO = NEAR / 100n;
/** NEAR the root moves into counter.<root>: storage for the ~92 KB wasm (as the counter's own sandbox suite). */
const COUNTER_FUNDING = 5n * NEAR;
/** Gas the full-access `new` call attaches (PRD §7). */
const INIT_GAS = 100n * TGAS;
/** The counter's panic text for reset without exactly 1 yoctoNEAR (contracts/counter): [17] passes on it only. */
export const RESET_PANIC = "Requires attached deposit of exactly 1 yoctoNEAR";
/** The pack's tests this phase runs ([18], [20]) and the names they must expect. */
const SMOKE_TESTS = { "refuse-allowance": "NotEnoughAllowance", "after-burn": "SignerDoesNotExist" } as const;

type Fields = Omit<DemoStep, "n" | "total" | "phase">;

export async function* smokePhase(ctx: { sb: SandboxHandle; n0: number; total: number }): AsyncGenerator<DemoStep> {
  const { sb, n0, total } = ctx;
  const root = sb.rootId;
  const counterId = `counter.${root}`;
  let k = 0;
  const step = (fields: Fields): DemoStep => withoutUndefined({ n: n0 + ++k, total, phase: "smoke", ...fields });

  // -- [15] deploy, then one wrap tx in sub-account mode ----------------------------------------------------------
  const wrapped = await wrapStep(sb, counterId);
  yield step(wrapped.fields);
  const session = wrapped.session;
  const tests = wrapped.tests;
  if (!session || !tests) {
    // No session key reached the chain: nothing below can be sent.
    const why = `not sent: [${nn(n0 + 1)}] did not wrap a session`;
    yield step({ label: "the session calls increment", signer: "session", pass: false, note: `FAIL: ${why}` });
    yield step({ label: "the session calls reset with no deposit", signer: "session", pass: false, note: `FAIL: ${why}` });
    yield step({ label: tests?.allowance.label ?? "call with a key whose allowance is below the prepaid gas", signer: "session", pass: false, note: `FAIL: ${why}` });
    yield step({ label: "the session sub-account signs DeleteKey + DeleteAccount", signer: "operator", pass: false, note: `FAIL: ${why}` });
    yield step({ label: tests?.afterBurn.label ?? "call after the session sub-account is deleted", signer: "session", pass: false, note: `FAIL: ${why}` });
    return;
  }
  // The key is on chain from here: every step below is guarded, so the burn [19] always runs.

  // -- [16] increment, [17] reset with no deposit -----------------------------------------------------------------
  const who = `the session (${session.accountId})`;
  yield step({ label: `${who} calls increment`, signer: "session", ...(await incrementStep(session)) });
  yield step({ label: `${who} calls reset with no deposit (it needs exactly 1 yocto)`, signer: "session", ...(await resetStep(session)) });

  // -- [18] a second key with 0.01 NEAR, added by the operator key; increment with it -----------------------------
  const tiny = await addTinyKey(sb, session);
  if (tiny.ok) {
    const { attempt, error } = await send(tiny.session, testInput(tiny.session, tests.allowance));
    const fields = refusalFields(tests.allowance, attempt, error);
    // The AddKey landed: its hash is the step's further tx, and a passing step's note names it.
    yield step({ ...fields, moreTxHashes: [tiny.txHash], ...(fields.pass ? { note: tinyKeyNote(tiny.txHash) } : {}) });
  } else {
    yield step({ label: tests.allowance.label, signer: "session", moreTxHashes: tiny.txHash === undefined ? undefined : [tiny.txHash], pass: false, note: `FAIL: not sent: ${tiny.error}` });
  }

  // -- [19] the burn: DeleteKey + DeleteAccount, signed as the sub-account with the operator's key ----------------
  const burned = await guarded(() => signBurn(session, { persist: false, signerKey: sb.rootKey }));
  const burnProblems: string[] = [];
  if (!burned.ok) burnProblems.push(burned.error);
  else {
    if (burned.value.txHashes.length !== 1) burnProblems.push(`expected one DeleteKey + DeleteAccount tx, got ${burned.value.txHashes.length}`);
    const gone = await guarded(() => goneProblems(session, tiny.ok ? tiny.session : undefined));
    burnProblems.push(...(gone.ok ? gone.value : [gone.error]));
  }
  yield step({
    label: `${session.accountId} signs DeleteKey + DeleteAccount (to ${root}) with the operator key`,
    signer: "operator",
    txHash: burned.ok ? burned.value.txHashes[0] : undefined,
    ...verdict(burnProblems, tiny.ok ? "account gone (view_account); both keys went with it (view_access_key)" : "account gone (view_account); its key went with it (view_access_key)"),
  });

  // -- [20] the session key again, after the burn ------------------------------------------------------------------
  // Sent only once the burn landed: if it did not finish, the key may still be live and the attempt could land.
  if (burned.ok) {
    const { attempt, error } = await send(burned.value.session, testInput(burned.value.session, tests.afterBurn));
    yield step(refusalFields(tests.afterBurn, attempt, error));
  } else {
    yield step({ label: tests.afterBurn.label, signer: "session", pass: false, note: `FAIL: not sent: the burn [${nn(n0 + 5)}] did not finish, so the key may still be on chain` });
  }
}

// ---------------------------------------------------------------------------------------------------
// [15]

interface SmokeTests {
  allowance: NegativeTest;
  afterBurn: NegativeTest;
}

/** The counter pack's refuse-allowance and after-burn tests, checked: increment on the receiver, the names expected. */
function smokeTests(pack: TargetPack): SmokeTests {
  const problems: string[] = [];
  const get = (id: keyof typeof SMOKE_TESTS): NegativeTest => {
    const t = pack.negativeTests.find((x) => x.id === id);
    if (!t) problems.push(`no ${id} test`);
    else if (t.expected !== SMOKE_TESTS[id] || t.receiver !== "receiver" || t.action !== "FunctionCall" || t.method !== "increment") {
      problems.push(`its ${id} test is not an increment on the counter expecting ${SMOKE_TESTS[id]}`);
    }
    return t as NegativeTest;
  };
  const tests = { allowance: get("refuse-allowance"), afterBurn: get("after-burn") };
  if (problems.length) throw new EnvironmentError(`target pack ${pack.id}: ${problems.join("; ")}`, "restore src/packs/counter.pack.json");
  return tests;
}

/**
 * [15]: the deploy and the wrap, then what the chain and the dry-run say about them. An error before the wrap landed
 * leaves no session (the rest of the phase is not sent); after it, a failed check is a FAIL and the session is kept,
 * so the burn still runs.
 */
async function wrapStep(sb: SandboxHandle, counterId: string): Promise<{ fields: Fields; session?: Session; tests?: SmokeTests }> {
  const root = sb.rootId;
  const label = `${root} deploys ${counterId} and wraps it in a sub-account: ${METHODS.join(", ")}`;
  let deployTx: string | undefined;
  let tests: SmokeTests | undefined;
  const made = await guarded(async () => {
    const pack = await loadTargetPack(PACK_ID);
    tests = smokeTests(pack);
    const fixture = pack.sandboxFixture;
    if (!fixture) throw new EnvironmentError(`target pack ${pack.id} has no sandboxFixture to deploy`, "restore src/packs/counter.pack.json");
    const wasm = await pinnedWasm(fixture); // sha256 and code hash checked: exactly the code wrap pins
    // The owner is the hero's cosigner (`new {owner: "{cosigner}"}`); it signs nothing in this phase.
    const init = actions.functionCall(fixture.init.method, councilInitArgs(pack, `seat.${root}`, `cosigner.${root}`), INIT_GAS, 0n);
    const sent = await signAndSend("sandbox", root, sb.rootKey, counterId, [actions.createAccount(), actions.transfer(COUNTER_FUNDING), actions.deployContract(wasm), init]);
    if (sent.json?.result?.status) deployTx = sent.txHash; // in a block: its hash is printed whatever follows
    mustSucceed(`create ${counterId}, deploy ${fixture.wasmPath} and ${fixture.init.method}`, sent);
    const plan = await planWrap({ contract: counterId, allow: [...METHODS], allowanceYocto: ALLOWANCE_YOCTO.toString(), operatorId: root, network: "sandbox" }, { sandbox: sb });
    const { session, txHash } = await signWrap(plan, { persist: false, signerKey: sb.rootKey });
    return { session, txHash, plan, codeHash: fixture.codeHash };
  });
  if (!made.ok) return { fields: { label, signer: "operator", txHash: deployTx, pass: false, note: `FAIL: ${made.error}` }, tests };

  const { session, txHash, plan, codeHash } = made.value;
  const checked = await guarded(async () => {
    const [key, card] = await Promise.all([viewScopedKey(session), buildCageCard(session, "preview")]);
    return { problems: keyProblems(key, session), card };
  });
  const problems = checked.ok ? [...checked.value.problems] : [checked.error];
  if (session.mode !== "subaccount" || session.accountId !== `${session.id}.${root}`) problems.push(`expected the session sub-account ${session.id}.${root}, got ${session.accountId} (${session.mode})`);
  if (session.packId !== PACK_ID || session.codeHashPin !== codeHash) problems.push(`pinned ${session.codeHashPin} (pack ${session.packId}), not the ${PACK_ID} pack's ${codeHash}`);
  // The dry-run's labels, from the session's tools (fixed at wrap; never the card's rows, C-T5b), and the WARN they give.
  const labels = Object.fromEntries(session.tools.filter((t) => t.kind === "call").map((t) => [t.method, t.classification]));
  if (labels.increment !== "callable" || labels.reset !== "fails-without-deposit (runtime)") {
    problems.push(`the dry-run labelled increment ${labels.increment} and reset ${labels.reset}, not callable and fails-without-deposit (runtime)`);
  }
  const warn = warnRuntime("reset");
  if (plan.warnings.length !== 1 || plan.warnings[0] !== warn) problems.push(`expected one WARN, for reset; wrap gave ${plan.warnings.length}`);
  const head = warn.slice(0, warn.indexOf(":")); // "WARN  reset — fails-without-deposit (runtime)"
  return {
    fields: {
      label,
      signer: "operator",
      txHash: deployTx,
      moreTxHashes: [txHash],
      card: checked.ok ? checked.value.card : undefined,
      ...verdict(problems, `${head} · key on chain: gas allowance ${formatNear(ALLOWANCE_YOCTO)} NEAR`),
    },
    session,
    tests,
  };
}

/** A key read back from chain: exactly the planned receiver, methods and allowance. */
function keyProblems(key: ScopedKey | null, session: Session): string[] {
  if (key === null) return [`no key ${session.publicKey} on ${session.accountId} (view_access_key)`];
  const problems: string[] = [];
  if (key.receiverId !== session.receiverId) problems.push(`the key's receiver is ${key.receiverId}, not ${session.receiverId}`);
  if (key.methodNames.join() !== session.methodNames.join()) problems.push(`the key's methods are [${key.methodNames.join(", ")}], not [${session.methodNames.join(", ")}]`);
  if (key.allowanceRemainingYocto !== session.allowanceYocto) problems.push(`the key's allowance is ${key.allowanceRemainingYocto ?? "unlimited"} yocto, not ${session.allowanceYocto}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// [16] [17]

/** get_value, read from the counter (a number, or an error). */
async function getValue(session: Session): Promise<number> {
  const v = await callView(session, "get_value", {});
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new EnvironmentError(`view ${session.receiverId}.get_value returned ${JSON.stringify(v)}, not a number`, "check the counter contract");
  return v;
}

/** One in-scope call by the session key, with no deposit and the gas its tool attaches. */
function callInput(session: Session, method: string): AttemptInput {
  const tool = session.tools.find((t) => t.kind === "call" && t.method === method);
  return { sessionId: session.id, receiverId: session.receiverId, action: "FunctionCall", method, args: {}, depositYocto: "0", gasTGas: tool?.gasTGas ?? NaN, violates: "none" };
}

/** The landed tx hash of an attempt, if it landed. */
const landedHash = (attempt?: Attempt): string | undefined => (attempt && attempt.outcome.kind !== "Refusal" ? attempt.outcome.txHash : undefined);

/** [16]: TxSuccess, and get_value read before and after moved by exactly +1. */
async function incrementStep(session: Session): Promise<Pick<DemoStep, "attempt" | "txHash" | "pass" | "note">> {
  const before = await guarded(() => getValue(session));
  if (!before.ok) return { pass: false, note: `FAIL: not sent: ${before.error}` };
  const { attempt, error } = await send(session, callInput(session, "increment"));
  const txHash = landedHash(attempt);
  if (error !== undefined) return { attempt, txHash, pass: false, note: `FAIL: ${error}` };
  const o = attempt?.outcome;
  const after = await guarded(() => getValue(session));
  const problems: string[] = [];
  if (o?.kind !== "TxSuccess") problems.push(`expected increment to land as TxSuccess, got ${o?.kind === "Refusal" ? `a refusal (${o.errorName})` : o?.kind}`);
  if (!after.ok) problems.push(after.error);
  else if (after.value !== before.value + 1) problems.push(`get_value ${before.value} -> ${after.value}, not +1`);
  return { attempt, txHash, ...verdict(problems, after.ok ? `get_value ${before.value} -> ${after.value} (view before and after)` : undefined) };
}

/**
 * [17]: a ContractPanic in a block whose message holds RESET_PANIC (any other outcome or panic text is a FAIL), and
 * get_value unchanged. The step log prints the panic text and PASS_RUNTIME from the outcome.
 */
async function resetStep(session: Session): Promise<Pick<DemoStep, "attempt" | "txHash" | "pass" | "note">> {
  const before = await guarded(() => getValue(session));
  if (!before.ok) return { pass: false, note: `FAIL: not sent: ${before.error}` };
  const { attempt, error } = await send(session, callInput(session, "reset"));
  const txHash = landedHash(attempt);
  if (error !== undefined) return { attempt, txHash, pass: false, note: `FAIL: ${error}` };
  const o = attempt?.outcome;
  const after = await guarded(() => getValue(session));
  const problems: string[] = [];
  if (o?.kind !== "ContractPanic") problems.push(`expected reset to panic in a block, got ${o?.kind === "Refusal" ? `a refusal (${o.errorName})` : o?.kind}`);
  else if (!o.message.includes(RESET_PANIC)) problems.push(`the panic text lacks "${RESET_PANIC}"`);
  if (!after.ok) problems.push(after.error);
  else if (after.value !== before.value) problems.push(`get_value ${before.value} -> ${after.value}: the failed call changed state`);
  return { attempt, txHash, ...verdict(problems, after.ok ? `get_value still ${after.value} (view before and after)` : undefined) };
}

// ---------------------------------------------------------------------------------------------------
// [18] [19] [20]

/**
 * [18]'s key: AddKey (function call: the session's receiver and methods, 0.01 NEAR), signed as the session sub-account
 * with the operator's full-access key, then read back from chain. Its private half is held in memory for sendAttempt.
 */
async function addTinyKey(sb: SandboxHandle, session: Session): Promise<{ ok: true; session: Session; txHash: string } | { ok: false; error: string; txHash?: string }> {
  const keyPair = KeyPair.fromRandom("ed25519");
  const tiny: Session = { ...session, publicKey: keyPair.getPublicKey().toString(), allowanceYocto: TINY_ALLOWANCE_YOCTO.toString() };
  let txHash: string | undefined;
  const added = await guarded(async () => {
    const add = actions.addFunctionCallAccessKey(keyPair.getPublicKey(), session.receiverId, [...session.methodNames], TINY_ALLOWANCE_YOCTO);
    const sent = await signAndSend("sandbox", session.accountId, sb.rootKey, session.accountId, [add]);
    if (sent.json?.result?.status) txHash = sent.txHash;
    mustSucceed(`AddKey of a second key on ${session.accountId}`, sent);
    return keyProblems(await viewScopedKey(tiny), tiny);
  });
  if (!added.ok) return { ok: false, error: added.error, txHash };
  if (added.value.length) return { ok: false, error: `the second key is not on chain as planned: ${added.value.join("; ")}`, txHash };
  holdSessionKey(tiny, keyPair);
  return { ok: true, session: tiny, txHash: txHash as string };
}

/** [18]'s note: where the second key came from. */
const tinyKeyNote = (txHash: string): string => `AddKey (${formatNear(TINY_ALLOWANCE_YOCTO)} NEAR) by the operator key · tx ${txHash}`;

/** [19]: after the burn, the account and every key on it are gone (view_account, view_access_key). */
async function goneProblems(session: Session, tiny: Session | undefined): Promise<string[]> {
  const problems: string[] = [];
  if ((await viewAccount("sandbox", session.accountId)) !== null) problems.push(`${session.accountId} still exists (view_account)`);
  for (const s of tiny ? [session, tiny] : [session]) {
    if ((await viewScopedKey(s)) !== null) problems.push(`key ${s.publicKey} is still on ${s.accountId} (view_access_key)`);
  }
  return problems;
}

/** A pack test against the session's receiver, signed with `session`'s key. */
function testInput(session: Session, test: NegativeTest): AttemptInput {
  return {
    sessionId: session.id,
    receiverId: session.receiverId,
    action: test.action,
    ...(test.method === undefined ? {} : { method: test.method }),
    args: structuredClone(test.args),
    depositYocto: test.depositYocto,
    gasTGas: test.gasTGas,
    violates: test.violates,
  };
}

/** A pack test's step: PASS when the body parsed to the name the pack expects. */
function refusalFields(test: NegativeTest, attempt: Attempt | undefined, error: string | undefined): Fields {
  const o = attempt?.outcome;
  const signer: DemoSigner = "session";
  const base = { label: test.label, signer, attempt, txHash: landedHash(attempt), fixture: attempt ? `sandbox.${PACK_ID}.${test.id}.json` : undefined };
  if (error !== undefined) return { ...base, pass: false, note: `FAIL: ${error}` };
  const pass = o?.kind === "Refusal" && o.errorName === test.expected;
  return { ...base, pass, note: pass ? undefined : failExpected(test.expected, o?.kind === "Refusal" ? o.errorName : `no refusal (landed: ${o?.kind})`) };
}
