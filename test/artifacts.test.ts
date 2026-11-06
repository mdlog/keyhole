/**
 * Task 12 offline suite (no socket, no sandbox, no key file).
 *
 * 1. writeRunArtifacts on the Day-1 spike capture (loadDemoRunFixture(SANDBOX_FIXTURES)): every step's RPC body is
 *    written byte for byte under its fixture name, run.json round-trips and passes the secret scan, the transcript
 *    is written only when both its path and its text are given, and an input it refuses writes nothing.
 * 2. runDemo with the chain mocked. Every chain-facing function the driver calls is a vi.fn backed by a small fake
 *    DAO (FakeChain below); everything else is the real code (actProposalArgs, proposalStatus, buildCageCard,
 *    mustSucceed, outcomeFromBody). Refusal and landed bodies are the spike's committed captures.
 *    - The testnet branch end to end: row 01 is the factory create (state.daoCreateTx, `created DATE`), proposal ids
 *      come from add_proposal (5 and 6 here, because the DAO already holds proposals), KEYHOLE_DEMO_PRESEED is
 *      ignored, the testnet receivers come from the state, wrap and burn persist, and every row fits 100 columns.
 *    - A failed step never stops the run: a vote that landed unsettled and a send whose fate is unknown are FAIL
 *      steps (never re-sent), and the burn still runs. A failed read or burn is a FAIL too; after a failed burn,
 *      [14] is not sent (the key may still be live).
 *    - Every PASS is measured: the code hash and council ([01]), the policy's bond ([02]), the key read back ([03]),
 *      each proposal's status and approvals ([04]–[06]), the grantee's balance ([05]), nonce and allowance ([11]),
 *      the allowance spent ([12]) and the one DeleteKey ([13]). The injected text is the spike's, read from its source.
 *    - Anything that fails before the key exists ends the run; the sandbox is stopped whatever happens.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Action, KeyPair, baseEncode } from "near-api-js";
import { type Mock, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanText } from "../scripts/scan-secrets.js";
import { NEAR } from "../src/core/amounts.js";
import { LandedUnsettledError, outcomeFromBody, sendAttempt } from "../src/core/attempt.js";
import { signBurn } from "../src/core/burn.js";
import { loadFullAccessKey } from "../src/core/credentials.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import { NO_CODE_HASH, callView, rpcCall, viewAccount, viewCodeHash, viewScopedKey } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import { SendFateUnknownError, type SentTx, settle, signAndSend } from "../src/core/tx.js";
import type { Attempt, AttemptInput, DemoRun, DemoStep, Refusal, TargetPack, WrapOptions, WrapPlan } from "../src/core/types.js";
import { planWrap, sessionFromPlan, signWrap } from "../src/core/wrap.js";
import { createDemoCommand } from "../src/cli/demo.js";
import { writeRunArtifacts } from "../src/demo/artifacts.js";
import { HERO_STEPS, PRESEED_ENV, injectionDescription, payoutExecuted, proposalsLabel, runDemo } from "../src/demo/driver.js";
import { loadDemoRunFixture } from "../src/demo/replay.js";
import { type TestnetDemoState, ensureTestnetDemo } from "../src/demo/testnet-setup.js";
import { loadTargetPack } from "../src/packs/index.js";
import { addProposal, councilInitArgs, deployDaoSandbox } from "../src/packs/sputnik-setup.js";
import { rpcUrlFor, useRpcUrl } from "../src/core/config.js";
import { createStepPrinter, noRefusalEarned } from "../src/render/demo-log.js";
import { counter } from "../src/render/refusal-block.js";
import { NOTE_IN_SCOPE, OFFLINE_ALTERNATIVE } from "../src/render/strings.js";
import { displayWidth } from "../src/render/style.js";
import { SANDBOX_FIXTURES, plain100, readFixture, sampleCageCard } from "./helpers.js";

// Every chain-facing function the driver reaches, replaced; the rest of each module stays real.
vi.mock("../src/core/sandbox.js", async (io) => ({ ...(await io<typeof import("../src/core/sandbox.js")>()), startSandbox: vi.fn() }));
// useRpcUrl passes through, watched: nothing in a run may set the testnet override.
vi.mock("../src/core/config.js", async (io) => {
  const real = await io<typeof import("../src/core/config.js")>();
  return { ...real, useRpcUrl: vi.fn(real.useRpcUrl) };
});
vi.mock("../src/demo/testnet-setup.js", async (io) => ({ ...(await io<typeof import("../src/demo/testnet-setup.js")>()), ensureTestnetDemo: vi.fn() }));
vi.mock("../src/core/credentials.js", async (io) => ({ ...(await io<typeof import("../src/core/credentials.js")>()), loadFullAccessKey: vi.fn() }));
vi.mock("../src/core/wrap.js", async (io) => ({ ...(await io<typeof import("../src/core/wrap.js")>()), planWrap: vi.fn(), signWrap: vi.fn() }));
vi.mock("../src/core/burn.js", async (io) => ({ ...(await io<typeof import("../src/core/burn.js")>()), signBurn: vi.fn() }));
vi.mock("../src/core/attempt.js", async (io) => ({ ...(await io<typeof import("../src/core/attempt.js")>()), sendAttempt: vi.fn() }));
vi.mock("../src/core/tx.js", async (io) => ({ ...(await io<typeof import("../src/core/tx.js")>()), signAndSend: vi.fn(), settle: vi.fn() }));
vi.mock("../src/core/rpc.js", async (io) => ({
  ...(await io<typeof import("../src/core/rpc.js")>()),
  viewAccount: vi.fn(),
  viewCodeHash: vi.fn(),
  viewScopedKey: vi.fn(),
  callView: vi.fn(),
  rpcCall: vi.fn(),
}));
vi.mock("../src/packs/sputnik-setup.js", async (io) => ({ ...(await io<typeof import("../src/packs/sputnik-setup.js")>()), addProposal: vi.fn(), deployDaoSandbox: vi.fn() }));

/** An absolute fixture name: refused, so never created. */
const ABSOLUTE_ESCAPE = join(tmpdir(), `keyhole-artifacts-escape-${process.pid}.json`);

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "keyhole-artifacts-"));
  tmpRoots.push(dir);
  return dir;
}

/** Every file under `dir`, relative to it, sorted. */
function filesUnder(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])).sort();
}

// ---------------------------------------------------------------------------------------------------
// 1. writeRunArtifacts

describe("writeRunArtifacts", () => {
  it("writes each step's RPC body byte for byte under its fixture name, then run.json; run.json passes the secret scan", async () => {
    const run = await loadDemoRunFixture(SANDBOX_FIXTURES);
    const dir = tmp();
    const paths = await writeRunArtifacts(run, { fixturesDir: dir, runJsonPath: join(dir, "run.json") });

    const withFixture = run.steps.filter((s) => s.fixture);
    expect(withFixture.length).toBe(16);
    for (const s of withFixture) expect(readFileSync(join(dir, s.fixture!), "utf8")).toBe(s.attempt!.outcome.rawRpcJson);
    expect(scanText("run.json", readFileSync(join(dir, "run.json"), "utf8")).hits).toEqual([]);
    for (const p of paths) expect(scanText(basename(p), readFileSync(p, "utf8")).hits).toEqual([]);

    // The written paths, in step order, then run.json; nothing else in the dir (no temp file left behind).
    expect(paths).toEqual([...withFixture.map((s) => join(dir, s.fixture!)), join(dir, "run.json")]);
    expect(filesUnder(dir)).toEqual([...withFixture.map((s) => s.fixture!), "run.json"].sort());
    // The DemoRun JSON reads back as the run.
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toEqual(run);
  });

  it("keeps the exact bytes of a body with non-ASCII text and escapes, and creates missing directories", async () => {
    const raw = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","data":{"note":"caf\u00e9 \u2014 \\u001b[31m","x":"\u{1F512}"}},"id":"k-1"}';
    // The writer copies rawRpcJson as it is; it does not parse it. A real refusal's outcome carries the odd body.
    const step = stepWithBody(1, "sandbox.sputnik-v2.refuse-method.json", readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json"));
    step.attempt!.outcome = { ...step.attempt!.outcome, rawRpcJson: raw };
    const run = runOf([step]);
    const dir = join(tmp(), "a", "b");
    const runJsonPath = join(dir, "..", "run", "run.sandbox.json");
    const paths = await writeRunArtifacts(run, { fixturesDir: join(dir, "fixtures"), runJsonPath });
    expect(paths).toEqual([join(dir, "fixtures", "sandbox.sputnik-v2.refuse-method.json"), runJsonPath]);
    expect(readFileSync(paths[0]).equals(Buffer.from(raw, "utf8"))).toBe(true);
    expect(readFileSync(runJsonPath, "utf8").endsWith("\n")).toBe(true);
  });

  it("writes the transcript last when both its path and its text are given", async () => {
    const run = runOf([stepWithBody(1, "testnet.sputnik-v2.refuse-method.json", readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json"))]);
    const dir = tmp();
    const transcript = "# Keyhole demo transcript\n\nRESULT 1/1 PASS\n";
    const paths = await writeRunArtifacts(run, { fixturesDir: join(dir, "fixtures"), runJsonPath: join(dir, "run.testnet.json"), transcriptPath: join(dir, "transcript.md"), transcript });
    expect(paths.map((p) => basename(p))).toEqual(["testnet.sputnik-v2.refuse-method.json", "run.testnet.json", "transcript.md"]);
    expect(readFileSync(join(dir, "transcript.md"), "utf8")).toBe(transcript);
  });

  it("skips a step that names a fixture but carries no body (nothing was received to save)", async () => {
    const missing: DemoStep = { n: 2, total: 2, phase: "refusals", label: "send NEAR", signer: "session", pass: false, note: "FAIL: fixture missing", fixture: "sandbox.sputnik-v2.refuse-action.json" };
    const run = runOf([stepWithBody(1, "sandbox.sputnik-v2.refuse-method.json", readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json")), missing]);
    const dir = tmp();
    const paths = await writeRunArtifacts(run, { fixturesDir: dir, runJsonPath: join(dir, "run.json") });
    expect(paths.map((p) => basename(p))).toEqual(["sandbox.sputnik-v2.refuse-method.json", "run.json"]);
  });

  it.each([
    ["a fixture name that climbs out of the fixtures dir", { fixture: "../escape.json" }, {}],
    ["an absolute fixture name", { fixture: ABSOLUTE_ESCAPE }, {}],
    ["an empty fixture name", { fixture: "" }, {}],
    ["a transcript path without its text", {}, { transcriptPath: "transcript.md" }],
    ["a transcript without its path", {}, { transcript: "# t\n" }],
  ])("refuses %s before writing anything", async (_what, stepOverride: Partial<DemoStep>, out: { transcriptPath?: string; transcript?: string }) => {
    const step = { ...stepWithBody(1, "sandbox.sputnik-v2.refuse-method.json", readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json")), ...stepOverride };
    const dir = tmp();
    const fullOut = { fixturesDir: join(dir, "fixtures"), runJsonPath: join(dir, "run.json"), ...(out.transcriptPath ? { transcriptPath: join(dir, out.transcriptPath) } : {}), ...(out.transcript ? { transcript: out.transcript } : {}) };
    await expect(writeRunArtifacts(runOf([step]), fullOut)).rejects.toThrow(InputError);
    expect(filesUnder(dir)).toEqual([]);
    expect(existsSync(ABSOLUTE_ESCAPE)).toBe(false);
  });

  it("refuses two steps that name one fixture with different bodies (one would overwrite the other's evidence)", async () => {
    const a = readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json");
    const b = readFixture(SANDBOX_FIXTURES, "055-g2-transfer-1yocto-attacker.send_tx.json");
    const dir = tmp();
    const same = runOf([stepWithBody(1, "x.json", a), stepWithBody(2, "x.json", a)]);
    expect((await writeRunArtifacts(same, { fixturesDir: dir, runJsonPath: join(dir, "run.json") })).map((p) => basename(p))).toEqual(["x.json", "run.json"]);
    const other = tmp();
    await expect(writeRunArtifacts(runOf([stepWithBody(1, "x.json", a), stepWithBody(2, "x.json", b)]), { fixturesDir: other, runJsonPath: join(other, "run.json") })).rejects.toThrow(InputError);
    expect(filesUnder(other)).toEqual([]);
  });

  it("a rename that fails removes its temp file: nothing half-written is left beside the target", async () => {
    const dir = tmp();
    const target = join(dir, "run.json");
    mkdirSync(join(target, "occupied"), { recursive: true }); // a non-empty directory where run.json must go
    const run = runOf([]);
    await expect(writeRunArtifacts(run, { fixturesDir: join(dir, "fixtures"), runJsonPath: target })).rejects.toThrow(EnvironmentError);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("an unwritable target is an EnvironmentError that names the path", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "blocker"), "a file where a directory must go\n");
    const run = runOf([stepWithBody(1, "x.json", readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json"))]);
    await expect(writeRunArtifacts(run, { fixturesDir: join(dir, "blocker", "fixtures"), runJsonPath: join(dir, "run.json") })).rejects.toThrow(EnvironmentError);
    await expect(writeRunArtifacts(run, { fixturesDir: join(dir, "blocker", "fixtures"), runJsonPath: join(dir, "run.json") })).rejects.toThrow(/blocker/);
  });
});

function stepWithBody(n: number, fixture: string, raw: string): DemoStep {
  const outcome = outcomeFromBody(raw);
  if (!outcome) throw new Error("test body is neither a result nor a refusal");
  const attempt: Attempt = { sessionId: "ks-7f3a", receiverId: "dao.sandbox", action: "FunctionCall", method: "add_proposal", args: {}, depositYocto: "0", gasTGas: 30, violates: "method", outcome };
  return { n, total: n, phase: "refusals", label: "open a payout proposal", signer: "session", attempt, pass: true, fixture };
}

function runOf(steps: DemoStep[]): DemoRun {
  return { id: "live-sandbox-test", network: "sandbox", mode: "live", steps, durationMs: 1, exitCode: 0, transcriptPath: "" };
}

// ---------------------------------------------------------------------------------------------------
// 2. runDemo, chain mocked

const OP = "kh-op-021e.testnet";
const STATE: TestnetDemoState = {
  operator: OP,
  seat: `seat.${OP}`,
  cosigner: `cosigner.${OP}`,
  grantee: `grantee.${OP}`,
  dao: "kh-2c19.sputnik-v2.testnet",
  daoCreateTx: "8kvTGeLGQ4dQhXpWG4xkXWRDCz1XfVsaFAptJ4rmX3dN",
  daoCreatedAt: "2026-11-06T09:41:12.000Z",
  otherDao: "genesis.sputnik-v2.testnet",
  attacker: `attacker.${OP}`,
};
const ALLOWANCE = (5n * NEAR) / 100n;
const BODY = {
  vote: readFixture(SANDBOX_FIXTURES, "027-e-fc-vote-approve-0.send_tx.json"),
  cosigner: readFixture(SANDBOX_FIXTURES, "033-e-cosigner-approve-0.send_tx.json"),
  created: readFixture(SANDBOX_FIXTURES, "004-a-create-seat.send_tx.json"),
  afterBurn: readFixture(SANDBOX_FIXTURES, "072-i-attempt-after-burn.send_tx.json"),
  method: readFixture(SANDBOX_FIXTURES, "052-g1-method-add_proposal.send_tx.json"),
  action: readFixture(SANDBOX_FIXTURES, "055-g2-transfer-1yocto-attacker.send_tx.json"),
  receiver: readFixture(SANDBOX_FIXTURES, "058-g3-receiver-other-dao.send_tx.json"),
  deposit: readFixture(SANDBOX_FIXTURES, "061-g4-deposit-1yocto.send_tx.json"),
} as const;

const hash = (label: string): string => baseEncode(Buffer.from(label.padEnd(32, "#").slice(0, 32)));
const sent = (label: string, raw = BODY.created): SentTx => ({ txHash: hash(label), raw, json: JSON.parse(raw) });

/** The fake DAO and session key behind the mocks: proposals, the grantee's balance, the key's nonce and allowance. */
class FakeChain {
  /** The DAO already holds proposals #0–#4 from earlier runs: ids must come from add_proposal, never be assumed. */
  nextId = 5;
  proposals = new Map<number, { kind: unknown; description: string; approvals: number; status: string }>();
  granteeYocto = NEAR / 20n;
  allowance = ALLOWANCE;
  nonce = 191_000_000_007;
  burned = false;
  council: [string, string];
  /** The DAO's code hash (view_account, view_code); the pack's pin unless a test changes it. */
  codeHash = "";
  /** Edits to the DAO's policy (councilInitArgs), applied to every get_policy read: callView and verifyDao's rpcCall. */
  policyEdits: Array<(policy: any) => void> = [];
  /** Approvals at which the fake DAO executes a proposal (a real 2-of-2 DAO: 2). */
  quorum = 2;
  /** Where verifyDao's get_policy reads went. */
  policyUrls: string[] = [];
  constructor(readonly dao: string, readonly grantee: string, seat: string, cosigner: string) {
    this.council = [seat, cosigner];
  }
  policy(): any {
    const policy = structuredClone(councilInitArgs(pack, this.council[0], this.council[1]).policy) as any;
    for (const edit of this.policyEdits) edit(policy);
    return policy;
  }
  approve(id: number): void {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`fake DAO: no proposal ${id}`);
    p.approvals++;
    if (p.approvals >= this.quorum && p.status === "InProgress") {
      p.status = "Approved";
      const t = (p.kind as { Transfer?: { receiver_id: string; amount: string } }).Transfer;
      if (t?.receiver_id === this.grantee) this.granteeYocto += BigInt(t.amount);
    }
  }
}

let chain: FakeChain;
let pack: TargetPack;
const sessionKey = KeyPair.fromRandom("ed25519");

/** Points every mock at a fresh fake chain for these accounts. */
function fakeChain(ids: { dao: string; grantee: string; seat: string; cosigner: string; network: "sandbox" | "testnet" }): void {
  chain = new FakeChain(ids.dao, ids.grantee, ids.seat, ids.cosigner);
  chain.codeHash = pack.sandboxFixture!.codeHash;
  vi.mocked(loadFullAccessKey).mockImplementation(() => KeyPair.fromRandom("ed25519"));
  vi.mocked(viewCodeHash).mockImplementation(async () => chain.codeHash);
  // verifyDao (T15) reads get_policy with a raw call_function query; the fake answers it with the same policy.
  vi.mocked(rpcCall).mockImplementation(async (url, method, params) => {
    const q = params as { request_type?: string; account_id?: string; method_name?: string };
    if (method !== "query" || q.request_type !== "call_function" || q.account_id !== ids.dao || q.method_name !== "get_policy") throw new Error(`fake RPC: unexpected ${method} ${JSON.stringify(params)}`);
    chain.policyUrls.push(url);
    const json = { jsonrpc: "2.0", id: "k", result: { result: [...Buffer.from(JSON.stringify(chain.policy()))], logs: [] } };
    return { json, raw: JSON.stringify(json) } as Awaited<ReturnType<typeof rpcCall>>;
  });
  vi.mocked(callView).mockImplementation(async (_session, method, args) => {
    if (method === "get_policy") return chain.policy();
    if (method === "get_proposal") {
      const id = (args as { id: number }).id;
      const p = chain.proposals.get(id);
      if (!p) throw new EnvironmentError(`view ${ids.dao}.get_proposal failed: ERR_NO_PROPOSAL`, "check");
      return { id, proposer: ids.cosigner, description: p.description, kind: p.kind, status: p.status, vote_counts: p.approvals ? { council: [p.approvals, 0, 0] } : {}, votes: {}, submission_time: "1" };
    }
    throw new Error(`fake DAO: unexpected view ${method}`);
  });
  vi.mocked(addProposal).mockImplementation(async (_network, _signer, _key, _dao, proposal) => {
    const id = chain.nextId++;
    chain.proposals.set(id, { kind: proposal.kind, description: String(proposal.description), approvals: 0, status: "InProgress" });
    return { id, sent: sent(`add-${id}`) };
  });
  vi.mocked(planWrap).mockImplementation(async (opts: WrapOptions): Promise<WrapPlan> => {
    const draft = {
      id: "ks-7f3a",
      mode: "on-account" as const,
      network: opts.network,
      accountId: opts.onAccount!,
      receiverId: opts.contract,
      methodNames: [...opts.allow],
      allowanceYocto: opts.allowanceYocto,
      codeHashPin: pack.sandboxFixture!.codeHash,
      publicKey: sessionKey.getPublicKey().toString(),
      packId: "sputnik-v2",
      tools: sampleCageCard().tools,
    };
    return { draft, txActions: [], tools: draft.tools, warnings: [], signerId: opts.onAccount!, fundingYocto: null, dryRunMs: 5 };
  });
  vi.mocked(signWrap).mockImplementation(async (plan) => ({ session: sessionFromPlan(plan), txHash: hash("wrap") }));
  vi.mocked(viewScopedKey).mockImplementation(async (session) =>
    chain.burned ? null : { publicKey: session.publicKey, accountId: session.accountId, receiverId: ids.dao, methodNames: ["act_proposal"], allowanceRemainingYocto: chain.allowance.toString(), nonce: chain.nonce },
  );
  vi.mocked(sendAttempt).mockImplementation(async (_session, input) => landedOrRefused(input));
  vi.mocked(signAndSend).mockImplementation(async (_network, signerId, _key, receiverId, acts: Action[]) => {
    if (signerId === ids.cosigner && receiverId === ids.dao) {
      chain.approve(argsOf(acts[0]).id as number);
      return sent("cosigner-vote", BODY.cosigner);
    }
    return sent(`create-${receiverId}`);
  });
  vi.mocked(settle).mockResolvedValue(undefined);
  vi.mocked(viewAccount).mockImplementation(async (_network, accountId) => {
    if (accountId === ids.grantee) return { amountYocto: chain.granteeYocto.toString(), codeHash: NO_CODE_HASH };
    if (accountId === ids.dao) return { amountYocto: (15n * NEAR).toString(), codeHash: chain.codeHash };
    return null;
  });
  vi.mocked(signBurn).mockImplementation(async (session) => {
    chain.burned = true;
    return { session: { ...session, status: "burned", burnedAt: "2026-11-06T10:00:00.000Z", burnTxHashes: [hash("burn")] }, txHashes: [hash("burn")] };
  });
}

/** What the fake chain does with a session attempt: an in-scope vote lands; anything else is refused with the captured body. */
function landedOrRefused(input: AttemptInput): Attempt {
  const inScope = input.action === "FunctionCall" && input.method === "act_proposal" && input.receiverId === chain.dao && input.depositYocto === "0";
  let raw: string;
  if (chain.burned) raw = BODY.afterBurn;
  else if (inScope) {
    chain.approve(input.args.id as number);
    chain.nonce++;
    chain.allowance -= 10n ** 20n;
    raw = BODY.vote;
  } else raw = BODY[input.violates as "method" | "action" | "receiver" | "deposit"];
  return { ...input, outcome: outcomeFromBody(raw)! };
}

function argsOf(action: Action): Record<string, unknown> {
  const fc = (action as { functionCall?: { args: Uint8Array } }).functionCall;
  if (!fc) throw new Error("not a function call");
  return JSON.parse(Buffer.from(fc.args).toString("utf8"));
}

async function drain(gen: AsyncGenerator<DemoStep, DemoRun, void>): Promise<{ steps: DemoStep[]; run: DemoRun }> {
  const steps: DemoStep[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { steps, run: r.value };
    steps.push(r.value);
  }
}

describe("runDemo on testnet (chain mocked)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pack = await loadTargetPack("sputnik-v2");
    fakeChain({ ...STATE, network: "testnet" });
    vi.mocked(ensureTestnetDemo).mockResolvedValue({ state: STATE, created: false });
  });

  it("runs the 14 hero steps on the state's accounts: ids from add_proposal, testnet receivers, persisted wrap and burn", async () => {
    const out = tmp();
    const env = { KEYHOLE_OPERATOR: OP, [PRESEED_ENV]: "2", KEYHOLE_DEMO_OUT: out };
    const { steps, run } = await drain(runDemo({ network: "testnet", env }));

    // The run: 14 steps in phase order, every one PASS, exit 0, the transcript under KEYHOLE_DEMO_OUT.
    expect(HERO_STEPS).toBe(14);
    expect(steps.map((s) => [s.n, s.total])).toEqual(Array.from({ length: 14 }, (_, i) => [i + 1, 14]));
    expect(steps.map((s) => s.phase)).toEqual(["setup", "setup", "wrap", "in-scope", "in-scope", "in-scope", "refusals", "refusals", "refusals", "refusals", "chain-check", "inspect", "burn", "burn"]);
    expect(steps.map((s) => s.signer)).toEqual(["operator", "cosigner", "operator", "session", "cosigner", "session", "session", "session", "session", "session", "none", "none", "operator", "session"]);
    expect(steps.filter((s) => !s.pass).map((s) => `${s.n} ${s.note}`)).toEqual([]);
    // The transcript path is repo-relative (the file itself goes under KEYHOLE_DEMO_OUT): no local path in run.json.
    expect(run).toMatchObject({ network: "testnet", mode: "live", exitCode: 0, transcriptPath: "demo/transcript.md" });
    expect(JSON.stringify(run)).not.toContain(out);
    expect(run.steps).toEqual(steps);
    expect(run.id).toMatch(/^live-testnet-/);
    // A step carries only the fields it has (no `key: undefined` in the log or in run.json).
    for (const s of steps) expect(Object.entries(s).filter(([, v]) => v === undefined).map(([k]) => `[${s.n}] ${k}`)).toEqual([]);

    // [01] is the factory's create tx, with the date it was created (R13a); no DAO is created here.
    expect(ensureTestnetDemo).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureTestnetDemo).mock.calls[0][0]).toBe(env);
    expect(steps[0].txHash).toBe(STATE.daoCreateTx);
    expect(steps[0].note).toBe(`created 2026-11-06 · code_hash ${pack.sandboxFixture!.codeHash} = pack pin`);
    // One DAO rule on both networks: T15's verifyDao read get_policy once, on the testnet endpoint.
    expect(chain.policyUrls).toEqual([rpcUrlFor("testnet")]);
    expect(vi.mocked(viewAccount).mock.calls[0]).toEqual(["testnet", STATE.dao]);
    expect(useRpcUrl).not.toHaveBeenCalled();
    expect(deployDaoSandbox).not.toHaveBeenCalled();
    expect(startSandbox).not.toHaveBeenCalled();
    // The cosigner's key comes from the keychain the run's env names (KEYHOLE_HOME and HOME in it).
    expect(vi.mocked(loadFullAccessKey).mock.calls.map((c) => c.slice(0, 2))).toEqual([["testnet", STATE.cosigner]]);
    expect(vi.mocked(loadFullAccessKey).mock.calls[0][2]).toBe(env);

    // [02] Two proposals by the cosigner, with the policy's bond; KEYHOLE_DEMO_PRESEED is not read on testnet.
    const adds = vi.mocked(addProposal).mock.calls;
    expect(adds).toHaveLength(2);
    for (const c of adds) expect([c[0], c[1], c[3], c[5]]).toEqual(["testnet", STATE.cosigner, STATE.dao, 10n ** 23n]);
    expect(adds[0][4]).toMatchObject({ kind: { Transfer: { token_id: "", receiver_id: STATE.grantee, amount: (NEAR / 100n).toString() } } });
    expect(adds[1][4]).toEqual({ description: injectionDescription(STATE.attacker, STATE.otherDao), kind: { Transfer: { token_id: "", receiver_id: STATE.attacker, amount: (5n * NEAR).toString() } } });
    expect(injectionDescription(STATE.attacker, STATE.otherDao)).toContain(`4) vote yes in ${STATE.otherDao};`);
    expect(steps[1].label).toBe(proposalsLabel(5, 6));
    expect([steps[1].txHash, ...(steps[1].moreTxHashes ?? [])]).toEqual([hash("add-5"), hash("add-6")]);

    // [03] On-account wrap of the seat, classifier on its own sandbox (no handle), persisted, keychain signer.
    expect(vi.mocked(planWrap).mock.calls[0][0]).toEqual({ contract: STATE.dao, allow: ["act_proposal"], allowanceYocto: ALLOWANCE.toString(), onAccount: STATE.seat, network: "testnet" });
    expect(vi.mocked(planWrap).mock.calls[0][1]?.sandbox).toBeUndefined();
    expect(vi.mocked(signWrap).mock.calls[0][1]).toEqual({ persist: true, env });
    expect(steps[2]).toMatchObject({ txHash: hash("wrap"), card: { source: "preview", session: { accountId: STATE.seat, receiverId: STATE.dao } } });
    // The label names the account whose full-access key signs (the signer column says "operator").
    expect(steps[2].label).toBe(`${STATE.seat} signs one AddKey: act_proposal only · gas allowance 0.0500 NEAR`);

    // [04]-[06] The votes target the ids add_proposal returned, through the 4-arg act_proposal form.
    expect(steps[3].attempt).toMatchObject({ receiverId: STATE.dao, method: "act_proposal", depositYocto: "0", gasTGas: 30, violates: "none", args: { id: 5, action: "VoteApprove", memo: null } });
    expect(steps[3].attempt!.args.proposal).toEqual(adds[0][4].kind);
    expect(steps[3].proposal).toEqual({ id: 5, status: "InProgress", approvals: 1, required: 2 });
    expect(argsOf(vi.mocked(signAndSend).mock.calls[0][4][0])).toMatchObject({ id: 5, action: "VoteApprove" });
    expect(settle).toHaveBeenCalledWith("testnet", hash("cosigner-vote"), STATE.cosigner);
    expect(steps[4]).toMatchObject({ txHash: hash("cosigner-vote"), proposal: { id: 5, status: "Approved", approvals: 2, required: 2 }, note: payoutExecuted(STATE.grantee, NEAR / 100n) });
    expect(steps[5].attempt!.args).toMatchObject({ id: 6, action: "VoteApprove" });
    expect(steps[5]).toMatchObject({ proposal: { id: 6, status: "InProgress", approvals: 1, required: 2 }, note: NOTE_IN_SCOPE });

    // [07]-[10] and [14]: the pack's tests against the testnet receivers, saved as testnet fixtures.
    const refusals = [6, 7, 8, 9, 13].map((i) => steps[i]);
    expect(refusals.map((s) => s.attempt!.receiverId)).toEqual([STATE.dao, STATE.attacker, STATE.otherDao, STATE.dao, STATE.dao]);
    expect(refusals.map((s) => (s.attempt!.outcome as Refusal).errorName)).toEqual(["MethodNameMismatch", "RequiresFullAccess", "ReceiverMismatch", "DepositWithFunctionCall", "AccessKeyNotFound"]);
    expect(refusals.map((s) => s.fixture)).toEqual(["refuse-method", "refuse-action", "refuse-receiver", "refuse-deposit", "after-burn"].map((t) => `testnet.sputnik-v2.${t}.json`));
    expect(JSON.stringify(steps[6].attempt!.args)).toContain(STATE.attacker);
    expect(JSON.stringify(steps[6].attempt!.args)).not.toContain("{attacker}");
    expect(steps.filter((s) => s.fixture === undefined).length).toBe(9);
    // refuse-deposit and after-burn name this run's #B (6), not the pack's literal #1; the other DAO's attempt
    // keeps the pack's literal id 0.
    expect(steps[9].attempt!.args).toEqual({ id: 6, action: "VoteApprove" });
    expect(steps[13].attempt!.args).toEqual({ id: 6, action: "VoteReject" });
    expect(steps[8].attempt!.args).toEqual({ id: 0, action: "VoteApprove" });

    // [11] measured; [12] the chain card; [13] one DeleteKey, persisted with the keychain signer.
    expect(steps[10].chainCheck!.before).toEqual(steps[10].chainCheck!.after);
    expect(steps[11].card).toMatchObject({ source: "chain", codeHashNow: pack.sandboxFixture!.codeHash });
    expect(BigInt(steps[11].card!.key!.allowanceRemainingYocto!)).toBe(ALLOWANCE - 2n * 10n ** 20n);
    expect(vi.mocked(signBurn).mock.calls[0][1]).toEqual({ persist: true, env });
    expect(steps[12].txHash).toBe(hash("burn"));
    expect(steps[12].label).toBe(`${STATE.seat} signs DeleteKey of ks-7f3a's key`);

    // Every printed row (counter + label, and a passing step's note under the 8-column indent) fits 100 columns
    // with real-length testnet ids.
    for (const s of steps) {
      expect(displayWidth(`${counter(s)} ${s.label}`), s.label).toBeLessThanOrEqual(100);
      if (s.note) expect(displayWidth(`        ${s.note}`), s.note).toBeLessThanOrEqual(100);
    }
  });

  it("a FAIL step never stops the run: a landed-unsettled vote and an unknown-fate refusal are FAIL steps, never re-sent, and the burn still runs", async () => {
    const landedErr = (attempt: Attempt) => new LandedUnsettledError(attempt, attempt.outcome as Extract<Attempt["outcome"], { kind: "TxSuccess" }>, new EnvironmentError("tx X: receipt tree incomplete after 20 tx polls", "it is on chain"));
    const fateErr = new SendFateUnknownError(hash("lost"), STATE.seat, "the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls");
    let votes = 0;
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      if (input.receiverId === STATE.otherDao) throw fateErr;
      const attempt = landedOrRefused(input);
      if (attempt.outcome.kind === "TxSuccess" && ++votes === 1) throw landedErr(attempt);
      return attempt;
    });
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));

    expect(steps).toHaveLength(14);
    expect(run.exitCode).toBe(1);
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([4, 9]);
    // [04] landed: its attempt and tx are reported as landed, with the error's text.
    expect(steps[3].attempt?.outcome.kind).toBe("TxSuccess");
    expect(steps[3].txHash).toBe((steps[3].attempt!.outcome as { txHash: string }).txHash);
    expect(steps[3].note).toContain("receipt tree incomplete");
    expect(steps[3].note).toContain("do not send it again");
    // [09]: the message and the hint verbatim, sent once.
    expect(steps[8].attempt).toBeUndefined();
    expect(steps[8].fixture).toBeUndefined();
    expect(steps[8].note).toContain(fateErr.what);
    expect(steps[8].note).toContain(fateErr.tryThis);
    expect(vi.mocked(sendAttempt).mock.calls.filter((c) => c[1].receiverId === STATE.otherDao)).toHaveLength(1);
    // The rest of the run happened: the cosigner vote, the chain check, the burn and its proof.
    expect(steps[4].pass).toBe(true);
    expect(steps[10].pass).toBe(true);
    expect(signBurn).toHaveBeenCalledTimes(1);
    expect(steps[12]).toMatchObject({ pass: true, txHash: hash("burn") });
    expect(steps[13].attempt!.outcome).toMatchObject({ kind: "Refusal", errorName: "AccessKeyNotFound" });
  });

  it("a measured mismatch is a FAIL with the parsed name, and later steps still run", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      const attempt = landedOrRefused(input);
      return input.violates === "deposit" ? { ...attempt, outcome: outcomeFromBody(BODY.receiver)! } : attempt;
    });
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[9]).toMatchObject({ pass: false, note: "FAIL: expected DepositWithFunctionCall, parsed ReceiverMismatch from the body", fixture: "testnet.sputnik-v2.refuse-deposit.json" });
    expect(steps.slice(10).every((s) => s.pass)).toBe(true);
    expect(run.exitCode).toBe(1);
  });

  it("the chain check is measured: a moved nonce fails [11]", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      if (input.violates === "receiver") chain.nonce++;
      return landedOrRefused(input);
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[10].pass).toBe(false);
    expect(steps[10].chainCheck!.after.nonce).toBe(steps[10].chainCheck!.before.nonce + 1);
    expect(steps[10].note).toMatch(/^FAIL: key state changed by refusals \(nonce /);
  });

  it("once the key exists, a failed read or burn is that step's FAIL (its line verbatim), and every later step still runs", async () => {
    const down = new EnvironmentError("RPC view_access_key: request timed out", "retry when the RPC answers");
    vi.mocked(viewScopedKey).mockRejectedValue(down);
    vi.mocked(signBurn).mockRejectedValue(new EnvironmentError("burn ks-7f3a: DeleteKey failed in a block", "read the tx"));
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps).toHaveLength(HERO_STEPS);
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([3, 11, 12, 13, 14]);
    for (const n of [3, 11, 12]) expect(steps[n - 1].note).toContain(down.line());
    expect(steps[2]).toMatchObject({ txHash: hash("wrap") }); // the wrap landed: its hash is still printed
    expect(steps[12].note).toContain("ERROR (environment): burn ks-7f3a: DeleteKey failed in a block · read the tx");
    // The key may still be live, so the after-burn attempt (an in-scope vote) is not sent: 2 votes + 4 refusals.
    expect(steps[13]).toEqual({ n: 14, total: 14, phase: "burn", label: "vote with the deleted key", signer: "session", pass: false, note: "FAIL: not sent: the burn [13] did not finish, so the key may still be on chain" });
    expect(sendAttempt).toHaveBeenCalledTimes(6);
    expect(signBurn).toHaveBeenCalledTimes(1);
    expect(run.exitCode).toBe(1);
  });

  /** Nothing after [01] happened: no proposal (no bond), no wrap (no key), no vote, no burn. */
  const expectStoppedAfter01 = (steps: DemoStep[], run: DemoRun) => {
    expect(steps.map((s) => [s.n, s.pass])).toEqual([[1, false]]);
    expect(run).toMatchObject({ steps, exitCode: 1 });
    for (const f of [addProposal, planWrap, signWrap, sendAttempt, signAndSend, signBurn]) expect(f).not.toHaveBeenCalled();
  };

  it("a DAO that does not verify fails [01] and ends the run: no proposal, no bond, no key", async () => {
    const off = "11111111111111111111111111111111";
    chain.codeHash = off;
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[0]).toMatchObject({ txHash: STATE.daoCreateTx, note: `FAIL: its code_hash is ${off}, not the pinned ${pack.sandboxFixture!.codeHash}` });
    expectStoppedAfter01(steps, run);
  });

  it.each([
    ["a 1-of-2 default policy", (p: any) => (p.default_vote_policy.threshold = "1"), "it needs 1 of 2 approvals, not 2-of-2"],
    [
      "a 1-of-2 override for transfers (Sputnik would execute #B inside the session's vote)",
      (p: any) => (p.roles.find((r: any) => r.name === "council").vote_policy = { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } }),
      "the council has per-kind vote policies (transfer): the demo needs 2-of-2 on every kind",
    ],
    ["a non-council role that can vote", (p: any) => p.roles[0].permissions.push("*:VoteApprove"), "role all can vote (*:VoteApprove): only the council may"],
    ["a third council member", (p: any) => p.roles[1].kind.Group.push(`mallory.${OP}`), `its council is [seat.${OP}, cosigner.${OP}, mallory.${OP}], not [seat.${OP}, cosigner.${OP}]`],
  ])("[01] applies T15's verifyDao rule: %s fails [01] and ends the run", async (_what, edit, why) => {
    chain.policyEdits.push(edit);
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[0].note).toBe(`FAIL: ${why}`);
    expectStoppedAfter01(steps, run);
  });

  it.each([
    ["0.2 NEAR", (2n * 10n ** 23n).toString(), `FAIL: proposal_bond "200000000000000000000000", not the pack's 0.1000 NEAR`],
    ["not a yocto string", 0.1, "FAIL: proposal_bond 0.1, not the pack's 0.1000 NEAR"],
  ])("a proposal_bond other than the pack's (%s) fails [01] and ends the run: the spend envelope assumes 0.1 NEAR", async (_what, bond, note) => {
    chain.policyEdits.push((p) => (p.proposal_bond = bond));
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[0].note).toBe(note);
    expectStoppedAfter01(steps, run);
  });

  it("the votes are measured: a vote that lands but does not count fails [04] and [06], and [05] says what the chain read", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      if (input.violates !== "none" || chain.burned) return landedOrRefused(input);
      chain.nonce++; // it landed and paid gas, but the DAO did not count it
      chain.allowance -= 10n ** 20n;
      return { ...input, outcome: outcomeFromBody(BODY.vote)! };
    });
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([4, 5, 6]);
    expect(steps[3]).toMatchObject({ attempt: { outcome: { kind: "TxSuccess" } }, proposal: { id: 5, status: "InProgress", approvals: 0, required: 2 } });
    expect(steps[3].txHash).toBe((steps[3].attempt!.outcome as { txHash: string }).txHash); // it landed: its hash is printed
    expect(steps[3].note).toBe("FAIL: expected proposal #5 InProgress (1 of 2), read InProgress (0 of 2)");
    expect(steps[4].note).toBe(`FAIL: expected proposal #5 Approved (2 of 2), read InProgress (1 of 2); ${STATE.grantee} moved 0 yocto, not +${NEAR / 100n}`);
    expect(steps[4]).toMatchObject({ txHash: hash("cosigner-vote"), proposal: { id: 5, status: "InProgress", approvals: 1 } });
    expect(steps[5].note).toBe("FAIL: expected proposal #6 InProgress (1 of 2), read InProgress (0 of 2)");
    expect(run.exitCode).toBe(1);
  });

  it("a vote that panics in a block is a FAIL with its hash, not an in-scope PASS", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) =>
      input.violates === "none" && input.args.id === 5 ? { ...input, outcome: { kind: "ContractPanic", txHash: hash("panic"), message: "ERR_PERMISSION_DENIED", rawRpcJson: BODY.vote } } : landedOrRefused(input),
    );
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[3]).toMatchObject({ pass: false, txHash: hash("panic"), note: "FAIL: expected the vote to land as TxSuccess, got ContractPanic; expected proposal #5 InProgress (1 of 2), read InProgress (0 of 2)" });
  });

  it("the chain check also measures the allowance: refusals that cost gas fail [11]", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      if (input.violates === "deposit") chain.allowance -= 7n;
      return landedOrRefused(input);
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    const before = ALLOWANCE - 2n * 10n ** 20n;
    expect(steps[10]).toMatchObject({ pass: false, note: `FAIL: key state changed by refusals (allowance ${before} -> ${before - 7n} yocto)` });
  });

  it("[12] needs the allowance below the one wrapped, and [13] exactly one DeleteKey tx", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      const attempt = landedOrRefused(input);
      if (input.violates === "none" && !chain.burned) chain.allowance += 10n ** 20n; // votes that cost no gas
      return attempt;
    });
    vi.mocked(signBurn).mockImplementation(async (session) => {
      chain.burned = true;
      return { session: { ...session, status: "burned" }, txHashes: [hash("burn"), hash("burn-2")] };
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([12, 13]);
    expect(steps[11].note).toBe(`FAIL: allowance left ${ALLOWANCE} yocto is not below the ${ALLOWANCE} wrapped`);
    expect(steps[12]).toMatchObject({ txHash: hash("burn"), note: "FAIL: expected one DeleteKey tx, got 2" });
    expect(steps[13].attempt!.outcome).toMatchObject({ kind: "Refusal", errorName: "AccessKeyNotFound" }); // the burn returned: [14] is sent
  });

  it("[03] reads the key back: a key whose scope is not the plan fails [03]", async () => {
    const real = vi.mocked(viewScopedKey).getMockImplementation()!;
    vi.mocked(viewScopedKey).mockImplementation(async (session) => {
      const key = await real(session);
      return key && { ...key, receiverId: "other.testnet", methodNames: ["act_proposal", "add_proposal"], allowanceRemainingYocto: null };
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[2].pass).toBe(false);
    expect(steps[2].note).toBe(
      `FAIL: the key's receiver is other.testnet, not ${STATE.dao}; the key's methods are [act_proposal, add_proposal], not [act_proposal]; the key's allowance is unlimited yocto, not ${ALLOWANCE}`,
    );
    expect(steps[2].txHash).toBe(hash("wrap"));
  });

  it("[02] needs two ids: add_proposal returning one id twice fails [02]", async () => {
    vi.mocked(addProposal).mockImplementation(async (_n, _s, _k, _d, proposal) => {
      chain.proposals.set(5, { kind: proposal.kind, description: String(proposal.description), approvals: 0, status: "InProgress" });
      return { id: 5, sent: sent("add-5") };
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[1]).toMatchObject({ pass: false, note: "FAIL: add_proposal returned id 5 twice" });
  });

  it("a threshold changed after [01] fails the votes: [04]-[06] need required = 2", async () => {
    const add = vi.mocked(addProposal).getMockImplementation()!;
    vi.mocked(addProposal).mockImplementation(async (...a) => {
      const r = await add(...a);
      if (r.id === 6) chain.policyEdits.push((p) => (p.roles.find((x: any) => x.name === "council").vote_policy = { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } }));
      return r;
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps.filter((s) => !s.pass).map((s) => s.n)).toEqual([4, 5, 6]);
    expect(steps[3].note).toBe("FAIL: expected proposal #5 InProgress (1 of 2), read InProgress (1 of 1)");
    expect(steps[4].note).toBe("FAIL: expected proposal #5 Approved (2 of 2), read Approved (2 of 1)");
    expect(steps[5].note).toBe("FAIL: expected proposal #6 InProgress (1 of 2), read InProgress (1 of 1)");
  });

  it("[05] needs both votes: a proposal Approved on the cosigner's vote alone fails [05]", async () => {
    chain.quorum = 1;
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      if (input.violates !== "none" || chain.burned) return landedOrRefused(input);
      return { ...input, outcome: outcomeFromBody(BODY.vote)! }; // lands, but the DAO does not count it
    });
    const { steps } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps[4]).toMatchObject({ pass: false, proposal: { id: 5, status: "Approved", approvals: 1, required: 2 }, note: "FAIL: expected proposal #5 Approved (2 of 2), read Approved (1 of 2)" });
  });

  it("[11] rests on earned refusals: with all four attempts failed locally, [11] FAILs and RESULT agrees with the printer", async () => {
    vi.mocked(sendAttempt).mockImplementation(async (_session, input) => {
      if (input.violates !== "none") throw new InputError([`${input.violates}: rejected before signing`]);
      return landedOrRefused(input);
    });
    const { steps, run } = await drain(runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } }));
    expect(steps.slice(6, 10).every((s) => !s.pass && s.attempt === undefined)).toBe(true);
    expect(steps[10]).toMatchObject({ pass: false, note: noRefusalEarned(4) });
    expect(steps[10].chainCheck!.after).toEqual(steps[10].chainCheck!.before); // unchanged, yet nothing was refused
    expect(run.exitCode).toBe(1);
    const printer = createStepPrinter({ caps: plain100, style: "full", network: "testnet", mode: "live" });
    const out = [...steps.map((s) => printer.step(s)), printer.result(run)].join("\n");
    expect(out).toContain(noRefusalEarned(4));
    // The printer's verdict and the run's count agree: [07]-[10] and [11] FAIL, [14] is the one protocol refusal.
    expect(out).toMatch(/^RESULT 9\/14 PASS · 5 FAIL · 1 protocol refusal · \d+ tx hashes · .* · exit 1 · transcript demo\/transcript\.md$/m);
  });

  it("the injected description is the spike's INJECTION, verbatim (spike/spike.ts)", () => {
    const src = readFileSync(new URL("../spike/spike.ts", import.meta.url), "utf8");
    const literal = /const INJECTION =\s*((?:`[^`]*`\s*\+?\s*)+);/.exec(src)?.[1];
    expect(literal).toBeDefined();
    const text = [...literal!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(injectionDescription(STATE.attacker, STATE.otherDao)).toBe(text.replaceAll("${ATTACKER}", STATE.attacker).replaceAll("${OTHER_DAO}", STATE.otherDao));
  });

  it("a failure before the key exists ends the run: nothing is wrapped, nothing is burned", async () => {
    vi.mocked(ensureTestnetDemo).mockRejectedValue(new EnvironmentError("set KEYHOLE_OPERATOR=<account>.testnet", "its full-access key must be in ~/.near-credentials/testnet/<account>.json"));
    await expect(runDemo({ network: "testnet", env: {} }).next()).rejects.toThrow(/KEYHOLE_OPERATOR/);
    vi.mocked(ensureTestnetDemo).mockResolvedValue({ state: STATE, created: true });
    vi.mocked(addProposal).mockRejectedValueOnce(new EnvironmentError("add_proposal on kh-2c19.sputnik-v2.testnet: failed in a block", "check"));
    const gen = runDemo({ network: "testnet", env: { KEYHOLE_OPERATOR: OP } });
    expect((await gen.next()).value).toMatchObject({ n: 1, pass: true });
    await expect(gen.next()).rejects.toThrow(/add_proposal/);
    expect(planWrap).not.toHaveBeenCalled();
    expect(signBurn).not.toHaveBeenCalled();
  });

  it("I1 (C-T2j): [03]'s AddKey fate unknown reaches the CLI as itself: exit 3, its line, where the key's ID is; no offline alternative, nothing re-sent", async () => {
    // signWrap rethrows SendFateUnknownError untouched (wrap.test.ts); the driver rethrows [01]-[03] errors as they are.
    const fate = new SendFateUnknownError(hash("wrap"), STATE.seat, "the node timed out (TIMEOUT_ERROR); not seen final after 6 tx polls");
    vi.mocked(signWrap).mockRejectedValueOnce(fate);
    const env = { KEYHOLE_OPERATOR: OP, KEYHOLE_DEMO_OUT: tmp() };
    const gen = runDemo({ network: "testnet", env });
    await gen.next();
    await gen.next();
    await expect(gen.next()).rejects.toBe(fate);

    // The real driver through the real command (its default deps): the same error, exit 3.
    vi.mocked(signWrap).mockClear();
    vi.mocked(signWrap).mockRejectedValueOnce(fate);
    const out: string[] = [];
    const err: string[] = [];
    const code = await createDemoCommand({ writeRunArtifacts: vi.fn(), rpcUrlFor: () => "https://rpc.testnet.near.org" }).run(["--testnet"], { out: (t) => void out.push(t), err: (t) => void err.push(t), env });
    expect(code).toBe(3);
    expect(err[0]).toBe(fate.line());
    expect(err[1]).toMatch(/^session key may be live · its ID is in .*sessions · run: keyhole burn ID$/);
    expect(err.join("\n")).not.toContain(OFFLINE_ALTERNATIVE);
    expect(signWrap).toHaveBeenCalledTimes(1);
    expect(signBurn).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("[02/14]");
    expect(out.join("\n")).not.toMatch(/\[03\/14\]|^RESULT/m);
  });
});

describe("runDemo on sandbox (chain mocked)", () => {
  let stop: Mock<() => Promise<void>>;
  let testnetUrl: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    testnetUrl = rpcUrlFor("testnet");
    pack = await loadTargetPack("sputnik-v2");
    fakeChain({ dao: "dao.sandbox", grantee: "grantee.sandbox", seat: "seat.sandbox", cosigner: "cosigner.sandbox", network: "sandbox" });
    stop = vi.fn(async () => undefined);
    const handle = { rpcUrl: "http://127.0.0.1:1", rootId: "sandbox", stop } as unknown as SandboxHandle;
    Object.defineProperty(handle, "rootKey", { value: KeyPair.fromRandom("ed25519"), enumerable: false });
    // Like the real startSandbox (core/sandbox.ts), it registers the node as the sandbox endpoint.
    vi.mocked(startSandbox).mockImplementation(async () => {
      useRpcUrl("sandbox", handle.rpcUrl);
      return handle;
    });
    vi.mocked(deployDaoSandbox).mockResolvedValue(sent("deploy"));
  });

  it(`${PRESEED_ENV} must be a whole number; a bad one is an InputError before the sandbox boots`, async () => {
    for (const bad of ["x", "-1", "1.5", "99"]) {
      await expect(runDemo({ network: "sandbox", env: { [PRESEED_ENV]: bad } }).next()).rejects.toThrow(InputError);
    }
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("[01] on sandbox: the accounts from the root, the pinned DAO, its council read back; the sandbox stops when the consumer stops", async () => {
    const gen = runDemo({ network: "sandbox", env: {} });
    const first = (await gen.next()).value as DemoStep;
    // 20 on sandbox: the hero's 14 and the six smoke steps (Task 13).
    expect(first).toMatchObject({ n: 1, total: 20, phase: "setup", signer: "operator", pass: true, txHash: hash("deploy"), note: `code_hash ${pack.sandboxFixture!.codeHash} = pack pin` });
    // T15's verifyDao read this run's node, as network "sandbox" (the endpoint startSandbox registered); the testnet
    // endpoint was never touched.
    expect(chain.policyUrls).toEqual(["http://127.0.0.1:1"]);
    expect(vi.mocked(viewAccount).mock.calls[0]).toEqual(["sandbox", "dao.sandbox"]);
    expect(vi.mocked(useRpcUrl).mock.calls).toEqual([["sandbox", "http://127.0.0.1:1"]]);
    expect(rpcUrlFor("testnet")).toBe(testnetUrl);
    expect(vi.mocked(deployDaoSandbox).mock.calls[0][1]).toEqual({ daoId: "dao.sandbox", seat: "seat.sandbox", cosigner: "cosigner.sandbox" });
    expect(vi.mocked(signAndSend).mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ["sandbox", "sandbox", "seat.sandbox"],
      ["sandbox", "sandbox", "cosigner.sandbox"],
      ["sandbox", "sandbox", "grantee.sandbox"],
    ]);
    // CreateAccount + Transfer, and an AddKey for the two signers only: the grantee just receives.
    expect(vi.mocked(signAndSend).mock.calls.map((c) => c[4].length)).toEqual([3, 3, 2]);
    expect(stop).not.toHaveBeenCalled();
    await gen.return(undefined as never);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a council that does not match fails [01] with what the chain says and ends the run; the sandbox is stopped", async () => {
    chain.council = ["seat.sandbox", "intruder.sandbox"];
    const { steps, run } = await drain(runDemo({ network: "sandbox", env: {} }));
    expect(steps).toEqual([expect.objectContaining({ n: 1, pass: false, note: "FAIL: its council is [seat.sandbox, intruder.sandbox], not [seat.sandbox, cosigner.sandbox]" })]);
    expect(run.exitCode).toBe(1);
    for (const f of [addProposal, planWrap, signWrap, sendAttempt, signBurn]) expect(f).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(useRpcUrl).mock.calls.filter((c) => c[0] === "testnet")).toEqual([]);
  });

  it("a deploy that fails ends the run, and the sandbox is still stopped", async () => {
    vi.mocked(deployDaoSandbox).mockRejectedValue(new EnvironmentError("create dao.sandbox: failed in a block", "check"));
    await expect(runDemo({ network: "sandbox", env: {} }).next()).rejects.toThrow(/failed in a block/);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it(`${PRESEED_ENV}=2 adds two proposals first, and the votes target the ids that follow`, async () => {
    chain.nextId = 0;
    const steps: DemoStep[] = [];
    for await (const s of runDemo({ network: "sandbox", env: { [PRESEED_ENV]: "2" } })) {
      steps.push(s);
      if (s.n === 6) break;
    }
    expect(vi.mocked(addProposal).mock.calls).toHaveLength(4);
    expect(steps[1].label).toBe(proposalsLabel(2, 3));
    expect([steps[3].attempt!.args.id, steps[4].proposal!.id, steps[5].attempt!.args.id]).toEqual([2, 2, 3]);
    expect(vi.mocked(planWrap).mock.calls[0][1]?.sandbox).toBe(await vi.mocked(startSandbox).mock.results[0].value);
    expect(vi.mocked(signWrap).mock.calls[0][1]).toMatchObject({ persist: false });
    expect(vi.mocked(signWrap).mock.calls[0][1]?.signerKey).toBeDefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
