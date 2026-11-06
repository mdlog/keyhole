/**
 * Run artifacts (Task 12): what a live demo run leaves behind as evidence, and where.
 *
 * writeRunArtifacts writes, in this order:
 * 1. each step's RPC body (`step.attempt.outcome.rawRpcJson`), byte for byte, to `fixturesDir/<step.fixture>`;
 * 2. the DemoRun as JSON to `runJsonPath` (Task 14 replays it: every outcome is re-derived from its rawRpcJson);
 * 3. the transcript to `transcriptPath`, when both it and `transcript` are given.
 *
 * Everything it can refuse is refused before the first write (InputError): a fixture name that is empty, absolute
 * or leaves `fixturesDir`, two steps that name one fixture with different bodies (one would overwrite the other's
 * evidence), and a transcript path without its text or the reverse. Each file is written to a temp file beside it
 * and renamed into place, so a reader never sees half a fixture. A DemoRun carries public chain data only (session
 * public keys, never a private key); the sandbox suite runs every written file through the secret scan.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvironmentError, InputError } from "../core/errors.js";
import type { DemoRun, Network } from "../core/types.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The transcript's path relative to the output root, as a DemoRun records it (`run.transcriptPath`): a committed
 * run.json names `demo/transcript.md`, never a local absolute path.
 */
export function transcriptRelPath(network: Network): string {
  return network === "testnet" ? "demo/transcript.md" : "demo/capture.sandbox.md";
}

/**
 * Where a live run's evidence goes: `<KEYHOLE_DEMO_OUT, else the repo>/demo` (Task 17 writes `--testnet` there).
 * - fixtures: `demo/fixtures/NETWORK.PACK.TEST.json` (GC 8: flat files);
 * - the DemoRun: `demo/run.NETWORK.json`;
 * - the log: `demo/transcript.md` on testnet; `demo/capture.sandbox.md` for a sandbox capture (GC 8).
 * The paths are absolute (for writing); `transcriptRelPath` is what the DemoRun stores.
 */
export function demoArtifactPaths(network: Network, env: NodeJS.ProcessEnv = process.env): { fixturesDir: string; runJsonPath: string; transcriptPath: string } {
  const root = env.KEYHOLE_DEMO_OUT ? resolve(env.KEYHOLE_DEMO_OUT) : REPO;
  const demo = join(root, "demo");
  return {
    fixturesDir: join(demo, "fixtures"),
    runJsonPath: join(demo, `run.${network}.json`),
    transcriptPath: join(root, transcriptRelPath(network)),
  };
}

/** `name` under `dir`, or null when it is empty, absolute, or resolves outside `dir`. */
function inside(dir: string, name: string): string | null {
  if (name === "" || isAbsolute(name)) return null;
  const path = resolve(dir, name);
  const rel = relative(resolve(dir), path);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : path;
}

/**
 * Writes each step's RPC body byte for byte to `fixturesDir/<step.fixture>`, the DemoRun JSON to `runJsonPath`,
 * and `transcript` to `transcriptPath` when both are given. Returns the written paths, in that order (fixtures in
 * step order). A step that names a fixture but holds no body (a replay step whose fixture is missing) has nothing
 * to save and is skipped.
 */
export async function writeRunArtifacts(
  run: DemoRun,
  out: { fixturesDir: string; runJsonPath: string; transcriptPath?: string; transcript?: string },
): Promise<string[]> {
  const problems: string[] = [];
  const fixtures = new Map<string, string>();
  for (const s of run.steps) {
    if (s.fixture === undefined) continue;
    const body = s.attempt?.outcome.rawRpcJson;
    if (body === undefined) continue;
    const path = inside(out.fixturesDir, s.fixture);
    if (path === null) {
      problems.push(`step ${s.n}: fixture name ${JSON.stringify(s.fixture)} is not a file name inside ${out.fixturesDir}`);
      continue;
    }
    const earlier = fixtures.get(path);
    if (earlier !== undefined && earlier !== body) problems.push(`step ${s.n}: fixture ${s.fixture} is named by an earlier step with a different body`);
    else fixtures.set(path, body);
  }
  if ((out.transcriptPath === undefined) !== (out.transcript === undefined)) {
    problems.push(out.transcriptPath === undefined ? "a transcript was given without transcriptPath" : "transcriptPath was given without the transcript text");
  }
  if (problems.length) throw new InputError(problems);

  const files: Array<[path: string, text: string]> = [...fixtures, [out.runJsonPath, `${JSON.stringify(run, null, 2)}\n`]];
  if (out.transcriptPath !== undefined && out.transcript !== undefined) files.push([out.transcriptPath, out.transcript]);
  for (const [path, text] of files) await writeAtomically(path, text);
  return files.map(([path]) => path);
}

/** `text` as UTF-8, through a temp file beside `path` and a rename. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new EnvironmentError(`cannot write ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`, "check the output directory and its permissions");
  }
}
