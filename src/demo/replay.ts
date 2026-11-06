/**
 * DATA CONTRACT #16 `loadDemoRunFixture` (path: fixture-replay). Reads committed files only and opens
 * no socket. Every outcome goes through the same parser as the live path (outcomeFromBody →
 * parseRefusal).
 *
 * Three inputs (R7, Task 14):
 *
 * (a) A capture directory (demo/fixtures/sandbox/, spike/negative-control/, spike/compat-sputnikv2-3.31/):
 *     the Day-1 spike capture, `NNN-STEP.json` response bodies plus `index.json`, the request log with each
 *     signed transaction in base64. Every Attempt field is decoded from that signed transaction.
 * (b) A manifest, `demo/fixtures/manifest.json` = `{ "refusals": [{ network, pack, test }] }`: one step per
 *     entry, in order, the outcome parsed from `demo/fixtures/NETWORK.PACK.TEST.json`. The manifest holds no
 *     live arguments, so the Attempt fields (action, method, args, deposit, gas, the rule broken) come from
 *     the pack's `negativeTests` (C-T12e: only this branch reads them from the pack).
 * (c) A run file, `demo/run.NETWORK.json`: a DemoRun a live run wrote. Its steps are kept as recorded, with
 *     their phases (C-T8d: the burn proof's phase decides whether SignerDoesNotExist is a proof), and what
 *     was signed comes from the file (C-T12e), but every outcome is re-derived from its `rawRpcJson`.
 *
 * A fixture that is missing never rejects the load (R12): the step is a FAIL, the run exits 1.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSignedTransaction } from "near-api-js";
import { outcomeFromBody } from "../core/attempt.js";
import { EnvironmentError, InputError } from "../core/errors.js";
import type { Attempt, AttemptAction, AttemptOutcome, DemoPhase, DemoRun, DemoStep, NegativeTest, Network, TargetPack } from "../core/types.js";
import { listPackIds, loadTargetPack } from "../packs/index.js";
import { chainCheckNote } from "../render/demo-log.js";
import { NOTE_IN_SCOPE, failExpected } from "../render/strings.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** What the rpc line of a step prints its fixture relative to (`demo/fixtures/<step.fixture>`). */
const FIXTURES = join(REPO, "demo", "fixtures");

interface CaptureStep {
  /** spike/spike.ts step id; its send_tx body is `NNN-STEP.send_tx.json`. */
  step: string;
  phase: DemoPhase;
  /** Pack negative test this attempt instantiates; absent for in-scope votes. */
  testId?: string;
  label?: string;
  note?: string;
}

/** The pack the spike capture exercises. */
export const SPIKE_CAPTURE_PACK = "sputnik-v2";

/** Session-key attempts of the spike capture, in run order (spike/spike.ts steps e–j). */
export const SPIKE_CAPTURE: readonly CaptureStep[] = [
  { step: "e-fc-vote-approve-0", phase: "in-scope", label: "approve #0 (grant payout)" },
  { step: "f-fc-vote-approve-1", phase: "in-scope", label: "approve #1 (the injected proposal)", note: NOTE_IN_SCOPE },
  { step: "f2-fc-vote-approve-2-newsig", phase: "in-scope", label: "approve #2 with the 4-arg act_proposal form" },
  { step: "g1-method-add_proposal", phase: "refusals", testId: "refuse-method" },
  { step: "g2-transfer-1yocto-attacker", phase: "refusals", testId: "refuse-action" },
  { step: "g3-receiver-other-dao", phase: "refusals", testId: "refuse-receiver" },
  { step: "g4-deposit-1yocto", phase: "refusals", testId: "refuse-deposit" },
  { step: "g2b-transfer-1yocto-dao", phase: "refusals", testId: "refuse-action-own-receiver" },
  { step: "i-attempt-after-burn", phase: "burn", testId: "after-burn" },
  { step: "j-attempt-1yocto-key", phase: "smoke", testId: "refuse-allowance" },
  ...[5, 10, 30, 48, 50, 100].map(
    (tgas): CaptureStep => ({ step: `j-measure-${tgas}tgas`, phase: "smoke", testId: "refuse-allowance", label: `measure the up-front allowance cost at ${tgas} TGas` }),
  ),
];

interface IndexEntry {
  file: string;
  step: string;
  method: string;
  params?: { signed_tx_base64?: string };
  ms?: number;
}

/**
 * The DemoRun a replay path reads back: (a) a capture directory, (b) `manifest.json` or (c) a `run.NETWORK.json`
 * file. A path ending in `.json` is read as (b) or (c) by its shape (a missing or mistyped one is `no such file:
 * <path>`, never a capture-directory error); anything else is a capture directory.
 */
export async function loadDemoRunFixture(path: string): Promise<DemoRun> {
  return path.endsWith(".json") ? loadJsonFile(path) : loadCaptureDir(path);
}

/** (a) The spike capture directory. */
async function loadCaptureDir(dir: string): Promise<DemoRun> {
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) {
    throw new InputError([`no capture log at ${indexPath} (a capture directory holds an index.json; a manifest or a run file is passed as its .json path)`]);
  }
  const index = JSON.parse(await readFile(indexPath, "utf8")) as IndexEntry[];
  const network = await captureNetwork(dir, index);
  const pack = await loadTargetPack(SPIKE_CAPTURE_PACK);
  const tests = new Map(pack.negativeTests.map((t) => [t.id, t]));

  const steps: DemoStep[] = [];
  for (const c of SPIKE_CAPTURE) {
    const test = c.testId === undefined ? undefined : tests.get(c.testId);
    if (c.testId !== undefined && !test) throw new EnvironmentError(`pack ${pack.id} has no negative test ${c.testId}`, "fix src/packs or SPIKE_CAPTURE");
    const base = { n: steps.length + 1, total: 0, phase: c.phase, label: c.label ?? test?.label ?? c.step, signer: "session" as const };
    const sent = index.find((e) => e.step === `${c.step}.send_tx`);
    const raw = sent ? await readFile(join(dir, sent.file), "utf8").catch(() => null) : null;
    // C-T8a: `demo/fixtures/<fixture>` is printed, so the capture's own subdirectory is part of the name.
    const fixture = sent ? fixtureRef(dir, sent.file) : undefined;
    if (!sent || raw === null) {
      steps.push({ ...base, pass: false, note: fixture ? missingNote(fixture) : `FAIL: fixture missing ${c.step}.send_tx in ${indexPath}`, fixture });
      continue;
    }
    const attempt = attemptFromCapture(sent, raw, test);
    if (!attempt) {
      steps.push({ ...base, pass: false, note: neitherNote(sent.file), fixture });
      continue;
    }
    const o = attempt.outcome;
    const verdict = test ? verdictFor(test, o) : { pass: o.kind === "TxSuccess" };
    steps.push({
      ...base,
      attempt,
      txHash: o.kind === "Refusal" ? undefined : o.txHash,
      pass: verdict.pass,
      note: verdict.note ?? c.note,
      fixture,
    });
  }
  for (const s of steps) s.total = steps.length;

  return {
    id: `replay-${captureName(dir)}`,
    network,
    mode: "replay",
    steps,
    // RPC time recorded in the capture log (not wall time, which only the transcript states).
    durationMs: index.reduce((t, e) => t + (e.ms ?? 0), 0),
    exitCode: steps.every((s) => s.pass) ? 0 : 1,
    transcriptPath: transcriptFor(dir, network),
  };
}

/** What was signed, decoded from the capture's signed transaction; the outcome parsed from the body. */
function attemptFromCapture(sent: IndexEntry, raw: string, test: NegativeTest | undefined): Attempt | null {
  const b64 = sent.params?.signed_tx_base64;
  if (typeof b64 !== "string" || b64.startsWith("<omitted")) {
    throw new EnvironmentError(`capture log has no signed transaction for ${sent.step}`, "re-run the capture");
  }
  const tx = decodeSignedTransaction(Buffer.from(b64, "base64")).transaction;
  const outcome = outcomeFromBody(raw);
  if (!outcome) return null;
  const a = tx.actions[0] as { functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }; transfer?: { deposit: bigint } };
  let action: AttemptAction;
  let method: string | undefined;
  let args: Record<string, unknown> = {};
  let depositYocto = "0";
  let gasTGas = 0;
  if (a.functionCall) {
    action = "FunctionCall";
    method = a.functionCall.methodName;
    args = parseArgs(a.functionCall.args);
    depositYocto = a.functionCall.deposit.toString();
    gasTGas = Number(a.functionCall.gas) / 1e12;
  } else if (a.transfer) {
    action = "Transfer";
    depositYocto = a.transfer.deposit.toString();
  } else {
    throw new EnvironmentError(`unexpected action in ${sent.step}: ${Object.keys(a).join(",")}`, "extend attemptFromCapture");
  }
  return {
    sessionId: "spike",
    receiverId: tx.receiverId,
    action,
    ...(method === undefined ? {} : { method }),
    args,
    depositYocto,
    gasTGas,
    violates: test?.violates ?? "none",
    outcome,
  };
}

function parseArgs(bytes: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { argsBase64: Buffer.from(bytes).toString("base64") };
  }
}

/** demo/fixtures/sandbox → "sandbox"; spike/negative-control/fixtures → "negative-control". */
function captureName(dir: string): string {
  const abs = resolve(dir);
  return basename(abs) === "fixtures" ? basename(dirname(abs)) : basename(abs);
}

/** Network from the capture's own `status` response (chain_id), not from the directory name. */
async function captureNetwork(dir: string, index: IndexEntry[]): Promise<Network> {
  const status = index.find((e) => e.method === "status");
  if (!status) throw new EnvironmentError(`capture ${dir} has no status response`, "re-run the capture");
  const chainId: unknown = JSON.parse(await readFile(join(dir, status.file), "utf8"))?.result?.chain_id;
  if (chainId === "testnet") return "testnet";
  if (typeof chainId === "string" && /^(test-chain-|sandbox|localnet)/.test(chainId)) return "sandbox";
  throw new EnvironmentError(`capture ${dir} has chain_id ${JSON.stringify(chainId)}`, "expected testnet or a near-sandbox chain");
}

/** demo/fixtures/sandbox → demo/transcript.sandbox.md; spike-style OUT/fixtures → OUT/transcript.md. */
function transcriptFor(dir: string, network: Network): string {
  const candidates = [join(dir, "..", "..", `transcript.${network}.md`), join(dir, "..", "transcript.md"), join(dir, "..", "..", "transcript.md")];
  return candidates.find((p) => existsSync(p)) ?? "";
}

// ---------------------------------------------------------------------------------------------------
// Shared by the three inputs

/** R12: the note of a step whose fixture file is not there. `fixture` is relative to demo/fixtures/. */
const missingNote = (fixture: string): string => `FAIL: fixture missing demo/fixtures/${fixture}`;
const neitherNote = (what: string): string => `FAIL: ${what} holds neither a transaction result nor a refusal`;

/** The pack's expectation against what the body parsed to. The expected name lives in the pack alone (R4 (e)). */
function verdictFor(test: NegativeTest, o: AttemptOutcome): { pass: boolean; note?: string } {
  if (o.kind === "Refusal" && o.errorName === test.expected) return { pass: true };
  return { pass: false, note: failExpected(test.expected, o.kind === "Refusal" ? o.errorName : `no refusal (landed: ${o.kind})`) };
}

/**
 * The file `dir/file` as the path `demo/fixtures/<it>` names on disk (C-T8a): relative to demo/fixtures/, with
 * `/` separators, so a capture in demo/fixtures/sandbox/ is `sandbox/052-….json` and one in spike/ climbs out
 * with `../../spike/…`. A capture outside the repo keeps its bare file name.
 */
function fixtureRef(dir: string, file: string): string {
  const abs = resolve(dir, file);
  const fromRepo = relative(REPO, abs);
  if (fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo)) return file;
  return relative(FIXTURES, abs).split(sep).join("/");
}

/** `dir/name` when it stays inside `dir`; null for an empty, absolute or climbing name. */
function inside(dir: string, name: string): string | null {
  if (name === "" || isAbsolute(name)) return null;
  const path = resolve(dir, name);
  const rel = relative(resolve(dir), path);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : path;
}

/** The text of a file, or null when it is not there. Any other failure is an environment error, not a missing fixture. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new EnvironmentError(`cannot read ${path} (${code ?? "error"})`, "check the file and its permissions");
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNetwork = (v: unknown): v is Network => v === "sandbox" || v === "testnet";
const ID = /^[a-z0-9][a-z0-9-]*$/;

/** (b) or (c), by the shape of the JSON. */
async function loadJsonFile(path: string): Promise<DemoRun> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new InputError([`no such file: ${path}`]);
    if (code === "EISDIR") throw new InputError([`not a file: ${path}`]);
    throw new EnvironmentError(`cannot read ${path} (${code ?? "error"})`, "check the file and its permissions");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InputError([`${path} is not JSON`]);
  }
  if (isRecord(json) && "refusals" in json) return replayManifest(path, json);
  if (isRecord(json) && "steps" in json) return replayRunFile(path, json);
  throw new InputError([`${path} is neither a manifest ({ "refusals": [...] }) nor a run file ({ "steps": [...] })`]);
}

// ---------------------------------------------------------------------------------------------------
// (b) the manifest

interface ManifestEntry {
  network: Network;
  pack: string;
  test: string;
}

function manifestEntries(path: string, json: Record<string, unknown>): ManifestEntry[] {
  const list = json.refusals;
  if (!Array.isArray(list) || list.length === 0) throw new InputError([`${path}: "refusals" must be a non-empty list of { network, pack, test }`]);
  const problems: string[] = [];
  list.forEach((e: unknown, i) => {
    const bad = !isRecord(e) || !isNetwork(e.network) || typeof e.pack !== "string" || !ID.test(e.pack) || typeof e.test !== "string" || !ID.test(e.test);
    if (bad) problems.push(`${path}: refusals[${i}] must be { network: "sandbox" | "testnet", pack: pack id, test: test id }`);
  });
  // One fixture is one send (C-T14d): a manifest that lists the same refusal twice would prove two with one body.
  const seen = new Set<string>();
  (list as ManifestEntry[]).forEach((e, i) => {
    const key = `${e.network}.${e.pack}.${e.test}`;
    if (seen.has(key)) problems.push(`${path}: refusals[${i}] repeats ${key}: one fixture is one send`);
    seen.add(key);
  });
  if (problems.length) throw new InputError(problems);
  return list as ManifestEntry[];
}

/** The beat a recorded refusal sits in: beat 3, the SMOKE for a small allowance or the sub-account burn, else BURN. */
function phaseOf(test: NegativeTest): DemoPhase {
  if (test.keyState === "session-key") return "refusals";
  if (test.keyState === "tiny-allowance-key") return "smoke";
  return test.expected === "SignerDoesNotExist" ? "smoke" : "burn";
}

async function replayManifest(path: string, json: Record<string, unknown>): Promise<DemoRun> {
  const entries = manifestEntries(path, json);
  const dir = dirname(path);
  const packs = new Map<string, TargetPack>();
  const steps: DemoStep[] = [];
  for (const [i, e] of entries.entries()) {
    let pack = packs.get(e.pack);
    if (!pack) packs.set(e.pack, (pack = await loadTargetPack(e.pack)));
    const test = pack.negativeTests.find((t) => t.id === e.test);
    if (!test) throw new InputError([`${path}: pack ${pack.id} has no negative test ${e.test}`]);
    const fixture = `${e.network}.${e.pack}.${e.test}.json`;
    const base = { n: i + 1, total: entries.length, phase: phaseOf(test), label: test.label, signer: "session" as const, fixture };
    const raw = await readIfPresent(join(dir, fixture));
    if (raw === null) {
      steps.push({ ...base, pass: false, note: missingNote(fixture) });
      continue;
    }
    const outcome = outcomeFromBody(raw);
    if (!outcome) {
      steps.push({ ...base, pass: false, note: neitherNote(fixture) });
      continue;
    }
    // The manifest records no live arguments (the driver fills them in at run time), so what the attempt was
    // comes from the pack's negative test. `{receiver}` names the account the pack means; no id is invented.
    const attempt: Attempt = {
      sessionId: "replay",
      receiverId: `{${test.receiver}}`,
      action: test.action,
      ...(test.method === undefined ? {} : { method: test.method }),
      args: structuredClone(test.args),
      depositYocto: test.depositYocto,
      gasTGas: test.gasTGas,
      violates: test.violates,
      outcome,
    };
    const verdict = verdictFor(test, outcome);
    steps.push({ ...base, attempt, txHash: outcome.kind === "Refusal" ? undefined : outcome.txHash, ...verdict });
  }
  // One run has one network. A manifest of both (the recorded testnet hero run and the sandbox-only refusals)
  // is the testnet run: each step's own network is in its fixture name.
  const networks = new Set(entries.map((e) => e.network));
  return { id: "replay-manifest", network: networks.size === 1 ? entries[0].network : "testnet", mode: "replay", steps, durationMs: 0, exitCode: steps.every((s) => s.pass) ? 0 : 1, transcriptPath: "" };
}

// ---------------------------------------------------------------------------------------------------
// (c) a run file

const PHASES = ["setup", "wrap", "in-scope", "refusals", "chain-check", "inspect", "burn", "smoke"] as const satisfies readonly DemoPhase[];

/** A key read as a chain check records it: what chainCheckNote compares (the nonce and the allowance). */
const isKeyRead = (v: unknown): boolean => isRecord(v) && typeof v.nonce === "number" && (v.allowanceRemainingYocto === null || typeof v.allowanceRemainingYocto === "string");

/** What the replay reads from a run file, checked. The rest of a step is carried as recorded. */
function runFileProblems(path: string, json: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof json.id !== "string") problems.push(`${path}: "id" must be a string`);
  if (!isNetwork(json.network)) problems.push(`${path}: "network" must be "sandbox" or "testnet"`);
  if (!Array.isArray(json.steps) || json.steps.length === 0) return [...problems, `${path}: "steps" must be a non-empty list`];
  json.steps.forEach((s: unknown, i) => {
    const o = isRecord(s) && isRecord(s.attempt) ? s.attempt.outcome : undefined;
    const bad =
      !isRecord(s) ||
      typeof s.n !== "number" ||
      typeof s.total !== "number" ||
      !(PHASES as readonly unknown[]).includes(s.phase) ||
      typeof s.pass !== "boolean" ||
      (s.fixture !== undefined && typeof s.fixture !== "string") ||
      (s.attempt !== undefined && !(isRecord(s.attempt) && isRecord(o) && typeof o.rawRpcJson === "string")) ||
      (s.chainCheck !== undefined && !(isRecord(s.chainCheck) && isKeyRead(s.chainCheck.before) && isKeyRead(s.chainCheck.after)));
    if (bad) problems.push(`${path}: steps[${i}] is not a DemoStep (n, total, phase, pass, an attempt.outcome.rawRpcJson when it has an attempt, and a chainCheck of two key reads when it has one)`);
  });
  return problems;
}

/** The outcome in words, for a disagreement: a refusal by its parsed name, anything else by its kind. */
const claimOf = (o: AttemptOutcome): string => (o.kind === "Refusal" ? o.errorName : o.kind);

/**
 * The check for an attempt that no pack test judges (an in-scope vote, the contrast call, or any step whose
 * fixture names no pack test), so its recorded `pass` is never taken on trust. It needs no pack, so the
 * run file stays the only source of what was signed (C-T12e):
 * - the chain refused it: a refusal is proved against its pack test's expected name, so one with no such test
 *   (or no fixture at all) is a FAIL, not a pass;
 * - it landed but broke a rule (`violates` is not `none`): a refusal slot that was not refused;
 * - an in-scope call must have landed (TxSuccess), as the live verdict requires.
 * A call that breaks no rule and lands (an increment, the reset that panics) passes with the recorded `pass`.
 */
function shapeProblem(step: DemoStep, o: AttemptOutcome): string | undefined {
  const rule = step.attempt!.violates;
  if (o.kind === "Refusal") {
    return `FAIL: step ${step.n} was refused by the chain, but ${step.fixture === undefined ? "names no fixture" : `its fixture ${step.fixture} names no pack test`} to check the refusal against`;
  }
  if (rule !== "none") return `FAIL: step ${step.n} broke the ${rule} rule but landed (${o.kind})`;
  if (step.phase === "in-scope" && o.kind !== "TxSuccess") return `FAIL: step ${step.n} is an in-scope call but ${o.kind}`;
  return undefined;
}

/**
 * The pack test a step's fixture belongs to, and how the step must agree with it (C-T14d). The fixture's body decides
 * which refusal happened; the test says what was signed to earn it and in which beat, so the step's own account of
 * itself must match: the rule it broke, what it signed (the receiver and the arguments are filled in per run, the rest
 * is the test's), its phase (which decides whether SignerDoesNotExist is a burn proof, C-T8d) and its signer.
 */
function testProblem(step: DemoStep, test: NegativeTest): string | undefined {
  const a = step.attempt!;
  if (a.violates !== test.violates) return `FAIL: step ${step.n} says it broke the ${a.violates} rule, but its pack test ${test.id} breaks the ${test.violates} rule`;
  const signs = (x: { action: string; method?: string; depositYocto: string; gasTGas: number }) => `${x.action}${x.method === undefined ? "" : ` ${x.method}`} with deposit ${x.depositYocto} yocto and ${x.gasTGas} TGas`;
  if (signs(a) !== signs(test)) return `FAIL: step ${step.n} signed ${signs(a)}, but its pack test ${test.id} signs ${signs(test)}`;
  if (step.phase !== phaseOf(test)) return `FAIL: step ${step.n} is in phase ${step.phase}, but its pack test ${test.id} belongs to phase ${phaseOf(test)}`;
  if (step.signer !== "session") return `FAIL: step ${step.n} was signed by ${step.signer}, but its pack test ${test.id} is signed with the session key`;
  return undefined;
}

/** What a run file's replay carries from step to step: its network, and which step named each fixture. */
interface RunContext {
  network: Network;
  fixtureOwners: Map<string, number>;
}

/**
 * One recorded step, replayed. Phase, label, signer and whatever was signed stay as recorded. The outcome is
 * parsed again from `rawRpcJson` and replaces the recorded one; a step fails (pass false, a FAIL note) when
 * - its fixture is missing from demo/fixtures/ (R12), or differs from the body the run file carries, or an earlier
 *   step names it too (one fixture is one send),
 * - it names a fixture but records no attempt,
 * - the body is neither a transaction result nor a refusal,
 * - the run file's own claim about the outcome is not what the body parses to, or
 * - its fixture is named like a pack test's (`NETWORK.PACK.TEST.json`) and that network is not the run's, or no such pack
 *   or test exists, or the body is not the name the pack expects, or the step does not agree with the test (testProblem), or
 * - it is any other attempt whose outcome does not fit what it was (shapeProblem).
 * A step with no attempt (setup, wrap, inspect, the DeleteKey) has nothing to re-derive and carries over as recorded,
 * `pass` included. The chain check is the exception: replayRunFile judges it again from its recorded reads (C-T14c).
 */
async function replayStep(recorded: DemoStep, fixturesDir: string, packs: ReadonlySet<string>, run: RunContext): Promise<DemoStep> {
  const step = structuredClone(recorded);
  // A card read from chain is a replay card here; a preview stays a preview (nothing was signed then either).
  // A chain card with no key is the burn proof ("no such key on chain"): the step log prints PASS_KEY_GONE only
  // for source "chain" (render/demo-log.ts), so that card keeps it. Its footer reads as the chain read it.
  if (step.card?.source === "chain" && step.card.key !== null) step.card = { ...step.card, source: "replay" };
  const a = step.attempt;
  if (!a) return step.fixture === undefined ? step : { ...step, pass: false, note: `FAIL: step ${step.n} names the fixture ${step.fixture}, but records no attempt` };

  let problem: string | undefined;
  let fixtureBytes: string | null | undefined;
  if (step.fixture !== undefined) {
    const file = inside(fixturesDir, step.fixture);
    const owner = run.fixtureOwners.get(step.fixture);
    run.fixtureOwners.set(step.fixture, owner ?? step.n);
    if (file === null) problem = `FAIL: fixture name ${JSON.stringify(step.fixture)} is not a file name inside demo/fixtures`;
    else if (owner !== undefined) problem = `FAIL: step ${step.n} names the fixture ${step.fixture}, which step ${owner} already names`;
    else if ((fixtureBytes = await readIfPresent(file)) === null) problem = missingNote(step.fixture);
  }

  const claimed = a.outcome;
  const derived = outcomeFromBody(claimed.rawRpcJson, "txHash" in claimed && typeof claimed.txHash === "string" ? claimed.txHash : undefined);
  if (!derived) {
    delete step.attempt;
    return { ...step, pass: false, note: problem ?? neitherNote(step.fixture ?? `step ${step.n}`) };
  }
  a.outcome = derived;
  step.txHash = derived.kind === "Refusal" ? undefined : derived.txHash;

  if (problem === undefined && (claimed.kind !== derived.kind || claimOf(claimed) !== claimOf(derived))) {
    problem = `FAIL: the run file says ${claimOf(claimed)}, its rawRpcJson parses as ${claimOf(derived)}`;
  }
  const named = step.fixture === undefined ? null : SLOT_FIXTURE.exec(step.fixture);
  let test: NegativeTest | undefined;
  if (problem === undefined && named) {
    // A name shaped like a pack test's fixture must be one, of this run's network: it is the evidence the step rests on.
    if (named[1] !== run.network) problem = `FAIL: step ${step.n} names the ${named[1]} fixture ${step.fixture}, but this is a ${run.network} run`;
    else if (!packs.has(named[2])) problem = `FAIL: step ${step.n} names the fixture ${step.fixture}, but there is no pack ${named[2]}`;
    else if (!(test = (await loadTargetPack(named[2])).negativeTests.find((t) => t.id === named[3]))) problem = `FAIL: step ${step.n} names the fixture ${step.fixture}, but pack ${named[2]} has no test ${named[3]}`;
  }
  // A step with a pack test is judged by the pack's expectation and by how well it agrees with the test; every other
  // attempt by what it was (see shapeProblem).
  if (problem === undefined) problem = test ? (verdictFor(test, derived).note ?? testProblem(step, test)) : shapeProblem(step, derived);
  if (problem === undefined && fixtureBytes !== undefined && fixtureBytes !== derived.rawRpcJson) {
    problem = `FAIL: demo/fixtures/${step.fixture} differs from the run file's rawRpcJson`;
  }
  return problem === undefined ? step : { ...step, pass: false, note: problem };
}

/** A fixture file named like a pack test's: `NETWORK.PACK.TEST.json` (GC 8). */
const SLOT_FIXTURE = /^(sandbox|testnet)\.([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)\.json$/;

/**
 * A chain check, judged again from the two key reads it recorded and the refusals-phase steps replayed before it
 * (C-T14c): a recorded `pass` is not taken on trust. One that records no reads cannot pass (the driver records none
 * only when the reads themselves failed, and then it has not passed either). Any other step is returned as it is.
 */
function replayChainCheck(step: DemoStep, before: readonly DemoStep[]): DemoStep {
  if (step.phase !== "chain-check" && step.chainCheck === undefined) return step;
  if (step.chainCheck === undefined) return step.pass ? { ...step, pass: false, note: `FAIL: step ${step.n} is a chain check, but the run file records no before/after view_access_key reads` } : step;
  const note = chainCheckNote(step.chainCheck, before.filter((s) => s.phase === "refusals"));
  return note === undefined ? step : { ...step, pass: false, note };
}

/**
 * A run that has refusals-phase steps is a hero run (C-T14c, m-3 of fix round 1): the step right after the last of them
 * is their chain check, in the chain-check phase. replayChainCheck only judges a step that still calls itself a chain
 * check, so without this a forged run could relabel [11] (and delete its reads) and drop the "unchanged by N refusals"
 * claim instead of faking it. The step that should be the chain check fails when it is not; when the run ends on the
 * last refusal, that refusal fails. A step that has already failed keeps its own, more specific, note. (A chain check in its phase without reads is replayChainCheck's.)
 */
function requireChainCheck(steps: DemoStep[]): void {
  const last = steps.map((s) => s.phase).lastIndexOf("refusals");
  if (last < 0) return;
  const next = steps[last + 1];
  if (next === undefined) {
    if (steps[last].pass) steps[last] = { ...steps[last], pass: false, note: `FAIL: step ${steps[last].n} is the last refusal, but no chain check follows it` };
  } else if (next.phase !== "chain-check" && next.pass) {
    steps[last + 1] = { ...next, pass: false, note: `FAIL: step ${next.n} follows the refusals, so it must be their chain check (phase chain-check, with its before/after view_access_key reads), but it is in phase ${next.phase}` };
  }
}

async function replayRunFile(path: string, json: Record<string, unknown>): Promise<DemoRun> {
  const problems = runFileProblems(path, json);
  if (problems.length) throw new InputError(problems);
  const fixturesDir = join(dirname(path), "fixtures");
  const packs = new Set(await listPackIds());
  const run: RunContext = { network: json.network as Network, fixtureOwners: new Map() };
  const steps: DemoStep[] = [];
  for (const recorded of json.steps as DemoStep[]) steps.push(replayChainCheck(await replayStep(recorded, fixturesDir, packs, run), steps));
  requireChainCheck(steps);
  return {
    id: json.id as string,
    network: json.network as Network,
    mode: "replay",
    steps,
    durationMs: typeof json.durationMs === "number" && Number.isFinite(json.durationMs) ? json.durationMs : 0,
    exitCode: steps.every((s) => s.pass) ? 0 : 1,
    transcriptPath: typeof json.transcriptPath === "string" ? json.transcriptPath : "",
  };
}
