/**
 * Records the sandbox fixtures that the demo and the offline tests replay. Fixtures are verbatim RPC bodies and
 * are never regenerated at test time (Global Constraints → Fixtures). Run it under the sandbox lock:
 *
 *   flock ../.superpowers/sandbox.lock npm run capture:sandbox -- --classifier
 *
 * --classifier (Task 10) boots one near-sandbox and runs classifyTools over the sputnik-v2 pack twice, in that
 * sandbox:
 *   1. the pack's DAO (its 0.1 NEAR proposal bond), scope [act_proposal];
 *   2. the zero-bond DAO (policyOverride `proposal_bond: "0"`, prefix `zero-bond-`), scope [act_proposal, add_proposal].
 * Task 11 adds a third run, over the counter pack (scope [increment, reset]), which also stages the
 * `__contract_abi` view body of the counter it dry-ran (the pinned wasm, code hash checked) as sandbox.counter.abi.json.
 * The bodies are captured into a temp dir first. Only when every run has succeeded do they replace
 * demo/fixtures/sandbox.sputnik-v2.{,zero-bond-}dryrun-*.json and sandbox.counter.{abi,dryrun-*}.json, so a failed
 * run leaves the committed fixtures as they were. Prints each path with its byte count, and the labels each run gave.
 *
 * Prints no key: the classifier signs with the sandbox root key and with keys it generates in memory. Exit 0 on
 * success, 2 on an input or environment error, 130 on Ctrl-C (the sandbox is stopped first).
 *
 *   flock ../.superpowers/sandbox.lock npm run capture:sandbox -- --driver
 *
 * --driver (Task 13) runs the whole sandbox demo, runDemo({ network: "sandbox" }): the hero [01]–[14] and the smoke
 * phase [15]–[20], in one near-sandbox it boots and stops. It prints one line per step as the step finishes. Only
 * when every step passed does it call writeRunArtifacts, which writes:
 *   - the seven refusal bodies, verbatim: demo/fixtures/sandbox.sputnik-v2.{refuse-method,refuse-action,
 *     refuse-receiver,refuse-deposit,after-burn}.json and demo/fixtures/sandbox.counter.{refuse-allowance,after-burn}.json;
 *   - the DemoRun as demo/run.sandbox.json (live args included: Task 14 replays from it);
 *   - its transcript (renderTranscript) as demo/capture.sandbox.md, which the DemoRun names as its transcriptPath.
 * It touches no other fixture. A run with a FAIL step writes nothing and exits 1. Either way the last line printed is
 * the RESULT line. $KEYHOLE_HOME and the keychain point at a temp dir for the run: a sandbox demo persists nothing,
 * and this mode never reads the real ones. Ctrl-C exits 130; the sandbox's own exit hook kills the node.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClassifyOptions, classifyTools } from "../src/classify/dry-run.js";
import { rpcUrlFor } from "../src/core/config.js";
import { EnvironmentError, KeyholeError } from "../src/core/errors.js";
import { viewCodeHash } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import type { DemoRun, DemoStep, TargetPack, ToolSchema } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { abiToolPrefix, readContractAbiBody, toolsFromAbi } from "../src/packs/near-abi.js";
import { demoArtifactPaths, transcriptRelPath, writeRunArtifacts } from "../src/demo/artifacts.js";
import { PRESEED_ENV, runDemo } from "../src/demo/driver.js";
import { resultLines } from "../src/render/demo-log.js";
import { counter } from "../src/render/refusal-block.js";
import { renderTranscript } from "../src/render/transcript.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO, "demo", "fixtures");
const USAGE = "usage: npm run capture:sandbox -- --classifier | --driver";

/** One classifyTools run whose bodies become fixtures. */
interface ClassifierRun {
  title: string;
  packId: string;
  scope: { receiverId: string; methodNames: string[] };
  prefix: string;
  policyOverride?: Record<string, unknown>;
  /** Task 11: also stage the dry-run contract's `__contract_abi` view body as `sandbox.PACK.abi.json`. */
  abi?: boolean;
}

const CLASSIFIER_RUNS: readonly ClassifierRun[] = [
  { title: "sputnik-v2 DAO (pack bond 0.1 NEAR)", packId: "sputnik-v2", scope: { receiverId: "dao.sandbox", methodNames: ["act_proposal"] }, prefix: "" },
  {
    title: "sputnik-v2 zero-bond DAO",
    packId: "sputnik-v2",
    scope: { receiverId: "dao.sandbox", methodNames: ["act_proposal", "add_proposal"] },
    prefix: "zero-bond-",
    policyOverride: { proposal_bond: "0" },
  },
  // Task 11: the counter (contracts/counter; tools from its embedded near-abi).
  { title: "counter (cargo-near, embedded ABI)", packId: "counter", scope: { receiverId: "counter.sandbox", methodNames: ["increment", "reset"] }, prefix: "", abi: true },
];

/** The fixture names a run may write: `sandbox.PACK.PREFIXdryrun-METHOD-zero|deposit.json`. */
const familyOf = (run: ClassifierRun) => new RegExp(`^sandbox\\.${run.packId}\\.${run.prefix}dryrun-[A-Za-z0-9_]+-(zero|deposit)\\.json$`);

const out = (line: string) => process.stdout.write(`${line}\n`);

async function captureClassifier(): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), "keyhole-capture-"));
  let sb: SandboxHandle | undefined;
  const interrupted = async () => {
    await sb?.stop().catch(() => undefined);
    rmSync(staging, { recursive: true, force: true });
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    try {
      sb = await startSandbox();
      for (const run of CLASSIFIER_RUNS) {
        const pack = await loadTargetPack(run.packId);
        const opts: ClassifyOptions = { sandbox: sb, capture: { dir: staging, prefix: run.prefix } };
        if (run.policyOverride) opts.policyOverride = run.policyOverride;
        const started = Date.now();
        const tools = await classifyTools(pack, run.scope, opts);
        out(`${run.title} · scope ${run.scope.methodNames.join(", ")} · ${Date.now() - started} ms`);
        for (const t of tools.filter((x: ToolSchema) => x.kind === "call")) out(`  ${t.name} (${t.method}): ${t.classification}`);
        if (run.abi) await stageAbi(run, pack, staging);
      }
    } finally {
      await sb?.stop();
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
    }

    // Every run succeeded: replace each run's family of fixtures with what was captured.
    const staged = readdirSync(staging).sort();
    for (const run of CLASSIFIER_RUNS) {
      const family = familyOf(run);
      for (const old of readdirSync(FIXTURES).filter((f) => family.test(f) && !staged.includes(f))) {
        unlinkSync(join(FIXTURES, old));
        out(`removed stale ${relative(REPO, join(FIXTURES, old))}`);
      }
    }
    for (const name of staged) {
      const dest = join(FIXTURES, name);
      copyFileSync(join(staging, name), dest);
      out(`${relative(REPO, dest)}  ${statSync(dest).size} bytes`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Task 11: stages the `__contract_abi` view body, verbatim, of the one contract `run`'s captures went to (the
 * classifier's dry-run copy). That contract must run the pack's pinned code (code hash checked first), and its
 * ABI must yield tools (toolsFromAbi), so the fixture is the pinned wasm's own ABI.
 */
async function stageAbi(run: ClassifierRun, pack: TargetPack, staging: string): Promise<void> {
  const family = familyOf(run);
  const receivers = new Set(readdirSync(staging).filter((f) => family.test(f)).map((f) => JSON.parse(readFileSync(join(staging, f), "utf8"))?.result?.transaction?.receiver_id));
  const [contract] = receivers;
  if (receivers.size !== 1 || typeof contract !== "string") {
    throw new EnvironmentError(`the ${run.packId} dry-run captures name ${receivers.size} receivers, not one dry-run contract`, "check the classifier's capture");
  }
  const codeHash = await viewCodeHash("sandbox", contract);
  if (codeHash !== pack.sandboxFixture?.codeHash) {
    throw new EnvironmentError(`${contract} runs code ${codeHash}, not the ${run.packId} pack's pinned ${pack.sandboxFixture?.codeHash}`, "rebuild the pinned wasm (npm run build:counter) and update the pack");
  }
  const { abi, raw } = await readContractAbiBody("sandbox", contract);
  toolsFromAbi(abi, abiToolPrefix(pack.id)); // refuses an ABI that no tool can be made from
  writeFileSync(join(staging, `sandbox.${run.packId}.abi.json`), raw);
}

/** The plain 100-column step log and transcript style: no escapes, ASCII glyphs (the capture is a file, not a TTY). */
const PLAIN = { color: false, unicode: false, width: 100, tty: false } as const;

/**
 * Task 13: runs the sandbox demo once and, when every step passed, writes its refusal bodies, run.sandbox.json and
 * capture.sandbox.md through writeRunArtifacts. Returns the exit code: 0 written, 1 a FAIL step (nothing written).
 */
async function captureDriver(): Promise<number> {
  const scratchHome = mkdtempSync(join(tmpdir(), "keyhole-capture-home-"));
  const saved = { home: process.env.KEYHOLE_HOME, creds: process.env.KEYHOLE_CREDENTIALS_DIR };
  process.env.KEYHOLE_HOME = join(scratchHome, ".keyhole");
  process.env.KEYHOLE_CREDENTIALS_DIR = join(scratchHome, ".near-credentials");
  // Ctrl-C: exit 130; the `exit` hook startSandbox installed kills the node and removes its run dir.
  const interrupted = () => {
    rmSync(scratchHome, { recursive: true, force: true });
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const startedAt = new Date().toISOString();
    const env = { ...process.env };
    delete env[PRESEED_ENV]; // test only: a capture is never pre-seeded
    const steps: DemoStep[] = [];
    let rpc = "";
    const gen = runDemo({ network: "sandbox", env });
    let r: IteratorResult<DemoStep, DemoRun>;
    while (!(r = await gen.next()).done) {
      const s = r.value;
      steps.push(s);
      if (rpc === "") rpc = rpcUrlFor("sandbox"); // this run's node, registered when it booted
      out(`${counter(s)} ${s.pass ? "PASS" : "FAIL"} ${s.label}`);
    }
    // The committed run names its committed log (repo-relative), so the RESULT line points at it too.
    const run: DemoRun = { ...r.value, transcriptPath: transcriptRelPath("sandbox") };
    const [result, ...more] = resultLines(run, PLAIN);
    if (run.exitCode !== 0) {
      for (const s of steps.filter((x) => !x.pass)) out(`${counter(s)} ${s.note ?? "FAIL"}`);
      out("nothing written: a capture is committed only from a run in which every step passed");
      out(result);
      return 1;
    }
    const paths = demoArtifactPaths("sandbox", {});
    const transcript = renderTranscript(run, { rpc, operator: "sandbox", startedAt });
    // demoArtifactPaths with no KEYHOLE_DEMO_OUT: a capture always lands in this repo's demo/ (fixtures in FIXTURES).
    const written = await writeRunArtifacts(run, { fixturesDir: paths.fixturesDir, runJsonPath: paths.runJsonPath, transcriptPath: paths.transcriptPath, transcript });
    for (const p of written) out(`${relative(REPO, p)}  ${statSync(p).size} bytes`);
    for (const line of more) out(line);
    out(result);
    return 0;
  } finally {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    if (saved.home === undefined) delete process.env.KEYHOLE_HOME;
    else process.env.KEYHOLE_HOME = saved.home;
    if (saved.creds === undefined) delete process.env.KEYHOLE_CREDENTIALS_DIR;
    else process.env.KEYHOLE_CREDENTIALS_DIR = saved.creds;
    rmSync(scratchHome, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1 || (argv[0] !== "--classifier" && argv[0] !== "--driver")) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    if (argv[0] === "--driver") return await captureDriver();
    await captureClassifier();
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof KeyholeError ? e.line() : `ERROR: ${(e as Error).message}`}\n`);
    return e instanceof KeyholeError ? e.exitCode : 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
