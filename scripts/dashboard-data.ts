/**
 * dashboard/public/data/keyhole.json, the recorded half of the operator console (dashboard/, built into docs/).
 *
 *   npm run site:data       rewrites the JSON and prints `dashboard/public/data/keyhole.json (N KB)`
 *
 * The console reads this file, then reads the chain itself (view_access_key, view_account, the DAO's views).
 * Everything here comes from committed files, cross-checked on the way:
 *   - sessions  the judging session (demo/judging-session.json) and the three sessions the recorded runs wrapped,
 *               each from the cage card its run printed, with the burn transaction that ended it;
 *   - runs      demo/run.testnet.json and demo/run.sandbox.json step by step, with the RESULT line of each transcript;
 *   - refusals  the manifest's seven refusals, each body byte for byte from its fixture, named by parseRefusal (the
 *               parser the live path uses) and tied to the run step that produced it;
 *   - packs     each target pack's tools and pinned code hash;
 *   - dao       the judging session's receiver, the transaction that created it and the proposals the run seeded.
 * No clock, no path, no network: the output depends on the committed files alone. Importing this module writes nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRefusal } from "../src/core/refusal.js";
import { listPackIds, loadTargetPack } from "../src/packs/index.js";
import { REPO_ROOT } from "./status-html.js";

export const DATA_FILE = "dashboard/public/data/keyhole.json";
export const REPO_URL = "https://github.com/mdlog/keyhole";

/** The ledger, in reading order: the five single-rule refusals, then the two burns. Attempt text: `code` in backticks. */
const LEDGER: readonly { fixture: string; attempt: string; rule: string; boundary: string }[] = [
  { fixture: "testnet.sputnik-v2.refuse-method.json", attempt: "`add_proposal` on the DAO", rule: "method: the key names `act_proposal` only", boundary: "method" },
  { fixture: "testnet.sputnik-v2.refuse-action.json", attempt: "Transfer of 1 yoctoNEAR to `attacker.kh-op-021e.testnet`", rule: "action: a function-call key signs one FunctionCall, nothing else", boundary: "action" },
  { fixture: "testnet.sputnik-v2.refuse-receiver.json", attempt: "`act_proposal` on `genesis.sputnik-v2.testnet`, another DAO", rule: "receiver: the key names `kh-2c19.sputnik-v2.testnet` only", boundary: "receiver" },
  { fixture: "testnet.sputnik-v2.refuse-deposit.json", attempt: "`act_proposal` with 1 yoctoNEAR attached", rule: "deposit: a function-call key attaches 0", boundary: "deposit" },
  { fixture: "sandbox.counter.refuse-allowance.json", attempt: "`increment` from a second key whose 0.0100 NEAR allowance is below the up-front cost of 30 TGas (0.0309 NEAR)", rule: "allowance: it must cover the gas bought up front", boundary: "allowance" },
  { fixture: "testnet.sputnik-v2.after-burn.json", attempt: "`act_proposal` after the key was deleted (burn, on-account mode)", rule: "none: the key is gone", boundary: "burn" },
  { fixture: "sandbox.counter.after-burn.json", attempt: "`increment` after the session sub-account was deleted (burn, sub-account mode)", rule: "none: the account is gone", boundary: "burn" },
];

const RUNS: readonly { file: string; label: string }[] = [
  { file: "demo/run.testnet.json", label: "Testnet run" },
  { file: "demo/run.sandbox.json", label: "Sandbox run" },
];

const SESSION_FIELDS = ["id", "network", "accountId", "receiverId", "methodNames", "allowanceYocto", "publicKey", "codeHashPin", "createdAt", "wrapTxHash"] as const;

export interface DashTool { name: string; kind: string; method: string; gasTGas: number; classification?: string; evidence?: string }
export interface DashSession {
  id: string;
  network: string;
  mode: "on-account" | "subaccount";
  accountId: string;
  receiverId: string;
  methodNames: string[];
  allowanceYocto: string;
  publicKey: string;
  codeHashPin: string;
  packId: string;
  createdAt: string;
  role: string;
  source: string;
  runId: string | null;
  wrap: { txHash: string; step: number | null };
  burn: { txHash: string; step: number; label: string; note: string | null } | null;
  lastRead: { allowanceRemainingYocto: string; codeHashNow: string; readAt: string; step: number } | null;
  tools: DashTool[] | null;
}
export interface DashStep {
  n: number;
  total: number;
  phase: string;
  label: string;
  signer: string;
  pass: boolean;
  txHashes: string[];
  note: string | null;
  fixture: string | null;
  sessionId: string | null;
  proposal: { id: number; status: string; approvals: number; required: number } | null;
  attempt: { receiverId: string; action: string; method: string | null; depositYocto: string | null; gasTGas: number | null; violates: string | null } | null;
  chainCheck: { before: string; after: string } | null;
}
export interface DashRun {
  id: string;
  label: string;
  network: string;
  file: string;
  transcript: string;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  result: { pass: string; parts: string[] };
  steps: DashStep[];
}
export interface DashRefusal {
  n: number;
  fixture: string;
  network: string;
  pack: string;
  test: string;
  attempt: string;
  rule: string;
  boundary: string;
  errorName: string;
  family: string;
  path: string[];
  body: string;
  runId: string;
  step: number;
  sessionId: string | null;
}
export interface DashPack { id: string; description: string; codeHash: string | null; notEnforced: string; exposure: { label: string; value: string } | null; tools: DashTool[]; outOfScope: string[] }
export interface DashDao { accountId: string; network: string; packId: string; codeHashPin: string; create: { txHash: string; runId: string; step: number; label: string }; seeded: { id: number; note: string }[] }
export interface DashboardData {
  repo: string;
  judgingSessionId: string;
  sessions: DashSession[];
  runs: DashRun[];
  refusals: DashRefusal[];
  packs: DashPack[];
  dao: DashDao;
}

type Obj = Record<string, unknown>;
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function fail(why: string): never {
  throw new Error(`dashboard data: ${why}`);
}

/** live-testnet-20261106T150556Z → 2026-11-06T15:05:56Z: the run id carries its start time. */
export function runStart(id: string): string {
  const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (!m) fail(`run id ${id} carries no start time`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

const toolOf = (t: Obj): DashTool => ({
  name: String(t.name),
  kind: String(t.kind),
  method: String(t.method),
  gasTGas: Number(t.gasTGas ?? 0),
  ...(typeof t.classification === "string" ? { classification: t.classification } : {}),
  ...(typeof t.evidence === "string" ? { evidence: t.evidence } : {}),
});

function stepOf(raw: Obj): DashStep {
  const a = isObj(raw.attempt) ? raw.attempt : null;
  const p = isObj(raw.proposal) ? raw.proposal : null;
  const c = isObj(raw.chainCheck) && isObj(raw.chainCheck.before) && isObj(raw.chainCheck.after) ? raw.chainCheck : null;
  const card = isObj(raw.card) && isObj(raw.card.session) ? raw.card.session : null;
  const txHashes = [str(raw.txHash), ...(Array.isArray(raw.moreTxHashes) ? raw.moreTxHashes.map(str) : [])].filter((h): h is string => !!h);
  return {
    n: Number(raw.n),
    total: Number(raw.total),
    phase: String(raw.phase),
    label: String(raw.label),
    signer: String(raw.signer),
    pass: raw.pass === true,
    txHashes,
    note: str(raw.note),
    fixture: str(raw.fixture),
    sessionId: str(a?.sessionId) ?? str(card?.id),
    proposal: p ? { id: Number(p.id), status: String(p.status), approvals: Number(p.approvals), required: Number(p.required) } : null,
    attempt: a
      ? { receiverId: String(a.receiverId), action: String(a.action), method: str(a.method), depositYocto: str(a.depositYocto), gasTGas: num(a.gasTGas), violates: str(a.violates) }
      : null,
    chainCheck: c
      ? { before: String((c.before as Obj).allowanceRemainingYocto), after: String((c.after as Obj).allowanceRemainingYocto) }
      : null,
  };
}

const ROLE: Record<string, string> = { testnet: "testnet demo run", sandbox: "sandbox demo run" };

/** Every session a run wrapped, from the cage card it printed; its burn and its last chain read from later steps. */
function runSessions(file: string, run: Obj): DashSession[] {
  const steps = run.steps as Obj[];
  const out: DashSession[] = [];
  for (const step of steps) {
    if (!isObj(step.card) || !isObj(step.card.session)) continue;
    const s = step.card.session;
    const id = String(s.id);
    if (out.some((o) => o.id === id)) continue; // the inspect step prints the same session again
    const wrapStep = Number(step.n);
    const later = steps.filter((x) => Number(x.n) > wrapStep);
    const burnStep = later.find((x) => x.signer === "operator" && typeof x.label === "string" && x.label.includes("DeleteKey") && (x.label.includes(id) || x.label.includes(String(s.accountId))));
    const inspect = steps.find((x) => x.phase === "inspect" && isObj(x.card) && isObj(x.card.session) && x.card.session.id === id);
    const card = isObj(inspect?.card) ? inspect.card : null;
    const key = card && isObj(card.key) ? card.key : null;
    const mode = s.mode === "subaccount" ? "subaccount" : "on-account";
    out.push({
      id,
      network: String(s.network),
      mode,
      accountId: String(s.accountId),
      receiverId: String(s.receiverId),
      methodNames: (s.methodNames as unknown[]).map(String),
      allowanceYocto: String(s.allowanceYocto),
      publicKey: String(s.publicKey),
      codeHashPin: String(s.codeHashPin),
      packId: String(s.packId),
      createdAt: String(s.createdAt),
      role: step.phase === "smoke" ? `${s.network} smoke test (${s.packId} pack)` : ROLE[String(s.network)] ?? `${s.network} run`,
      source: `${file} step ${wrapStep}`,
      runId: String(run.id),
      wrap: { txHash: str(step.txHash) ?? fail(`${file} step ${wrapStep} has no wrap tx`), step: wrapStep },
      burn: burnStep ? { txHash: String(burnStep.txHash), step: Number(burnStep.n), label: String(burnStep.label), note: str(burnStep.note) } : null,
      lastRead: card && key ? { allowanceRemainingYocto: String(key.allowanceRemainingYocto), codeHashNow: String(card.codeHashNow), readAt: String(card.readAt), step: Number(inspect!.n) } : null,
      tools: Array.isArray(s.tools) ? (s.tools as Obj[]).map(toolOf) : null,
    });
  }
  return out;
}

export async function dashboardData(root: string = REPO_ROOT): Promise<DashboardData> {
  // The judging session: the one key judges can read on testnet right now.
  const raw = JSON.parse(read(root, "demo/judging-session.json")) as Obj;
  for (const k of SESSION_FIELDS) if (raw[k] === undefined) fail(`demo/judging-session.json has no ${k}`);

  const packs: DashPack[] = [];
  for (const id of await listPackIds()) {
    const p = await loadTargetPack(id);
    packs.push({
      id,
      description: p.description,
      codeHash: p.sandboxFixture?.codeHash ?? null,
      notEnforced: p.notEnforced,
      exposure: p.exposure ? { label: p.exposure.label, value: p.exposure.value } : null,
      tools: p.tools.map((t) => toolOf(t as unknown as Obj)),
      outOfScope: p.outOfScope.map((o) => o.method),
    });
  }
  const judgingPack = packs.find((p) => p.codeHash === raw.codeHashPin) ?? fail(`no pack pins the judging session's code hash ${String(raw.codeHashPin)}`);

  const judging: DashSession = {
    id: String(raw.id),
    network: String(raw.network),
    mode: /^ks-[0-9a-f]{4}\./.test(String(raw.accountId)) ? "subaccount" : "on-account",
    accountId: String(raw.accountId),
    receiverId: String(raw.receiverId),
    methodNames: (raw.methodNames as unknown[]).map(String),
    allowanceYocto: String(raw.allowanceYocto),
    publicKey: String(raw.publicKey),
    codeHashPin: String(raw.codeHashPin),
    packId: judgingPack.id,
    createdAt: String(raw.createdAt),
    role: "judging session",
    source: "demo/judging-session.json",
    runId: null,
    wrap: { txHash: String(raw.wrapTxHash), step: null },
    burn: null,
    lastRead: null,
    tools: null,
  };

  const runsRaw = RUNS.map(({ file, label }) => ({ file, label, run: JSON.parse(read(root, file)) as Obj }));
  const runs: DashRun[] = runsRaw.map(({ file, label, run }) => {
    const transcript = String(run.transcriptPath);
    const line = read(root, transcript).split("\n").find((l) => l.startsWith("RESULT ")) ?? fail(`${transcript} has no RESULT line`);
    const [pass, ...parts] = line.slice("RESULT ".length).split(" · transcript ")[0].split(" · ");
    const steps = (run.steps as Obj[]).map(stepOf);
    if (!steps.every((s) => s.pass)) fail(`${file} has a step that did not pass`);
    return {
      id: String(run.id),
      label,
      network: String(run.network),
      file,
      transcript,
      startedAt: runStart(String(run.id)),
      durationMs: Number(run.durationMs),
      exitCode: Number(run.exitCode),
      result: { pass, parts },
      steps,
    };
  });

  const sessions = [judging, ...runsRaw.flatMap(({ file, run }) => runSessions(file, run))];
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length) fail("two sessions share an id");

  const manifest = JSON.parse(read(root, "demo/fixtures/manifest.json")) as { refusals: { network: string; pack: string; test: string }[] };
  const listed = manifest.refusals.map((r) => `${r.network}.${r.pack}.${r.test}.json`).sort();
  const ours = LEDGER.map((l) => l.fixture).sort();
  if (listed.join() !== ours.join()) fail(`the ledger (${ours.join(", ")}) is not the manifest's refusals (${listed.join(", ")})`);
  const refusals: DashRefusal[] = LEDGER.map((l, i) => {
    const body = read(root, `demo/fixtures/${l.fixture}`);
    const refusal = parseRefusal(body) ?? fail(`demo/fixtures/${l.fixture} is not a refusal body`);
    const hits = runs.flatMap((r) => r.steps.filter((s) => s.fixture === l.fixture).map((s) => ({ run: r, step: s })));
    if (hits.length !== 1) fail(`demo/fixtures/${l.fixture} is the evidence of ${hits.length} run steps, not 1`);
    const [network, pack, test] = l.fixture.replace(/\.json$/, "").split(".");
    return {
      n: i + 1,
      fixture: l.fixture,
      network,
      pack,
      test,
      attempt: l.attempt,
      rule: l.rule,
      boundary: l.boundary,
      errorName: refusal.errorName,
      family: refusal.family,
      path: [...refusal.path],
      body,
      runId: hits[0].run.id,
      step: hits[0].step.n,
      sessionId: hits[0].step.sessionId,
    };
  });

  // The DAO: created by the testnet run's first step, the receiver of the judging session.
  const testnet = runs.find((r) => r.network === "testnet") ?? fail("no testnet run");
  const create = testnet.steps.find((s) => s.phase === "setup" && s.label.includes(judging.receiverId)) ?? fail(`the testnet run never created ${judging.receiverId}`);
  const seed = testnet.steps.find((s) => s.phase === "setup" && /adds proposal/.test(s.label)) ?? fail("the testnet run seeded no proposal");
  const seeded = [...seed.label.matchAll(/#(\d+) \(([^)]+)\)/g)].map((m) => ({ id: Number(m[1]), note: m[2] }));
  if (!seeded.length) fail(`cannot read the seeded proposals from ${JSON.stringify(seed.label)}`);
  const dao: DashDao = {
    accountId: judging.receiverId,
    network: judging.network,
    packId: judging.packId,
    codeHashPin: judging.codeHashPin,
    create: { txHash: create.txHashes[0], runId: testnet.id, step: create.n, label: create.label },
    seeded,
  };

  return { repo: REPO_URL, judgingSessionId: judging.id, sessions, runs, refusals, packs, dao };
}

/** The file as written: two-space JSON and a final newline. */
export const renderData = (d: DashboardData): string => `${JSON.stringify(d, null, 2)}\n`;

async function main(): Promise<void> {
  const out = renderData(await dashboardData());
  const file = join(REPO_ROOT, DATA_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
  process.stdout.write(`${DATA_FILE} (${Math.round(Buffer.byteLength(out) / 1024)} KB)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
