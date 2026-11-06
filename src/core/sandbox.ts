/**
 * near-sandbox (Task 2): a local nearcore for the demo driver, the dry-run classifier and
 * `npm run test:sandbox`. Nothing started here persists after `stop()`.
 *
 * near-sandbox writes its home dir (genesis, validator and root keys, chain data) and its port lock files
 * to os.tmpdir(). While it starts, TMPDIR points at a fresh `<repo>/.sandbox-home/run-XXXXXX/` (gitignored),
 * so one run's files sit in one dir: stop() deletes it, and so does the process `exit` hook. The binary is
 * read from `<repo>/.sandbox-bin` unless DIR_TO_DOWNLOAD_BINARY says otherwise. near-sandbox is imported
 * dynamically, so `npm test` never loads it.
 */
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, type KeyPairString } from "near-api-js";
import { useRpcUrl } from "./config.js";
import { EnvironmentError } from "./errors.js";
import { sleep } from "./rpc.js";

export interface SandboxHandle {
  rpcUrl: string;
  /** The root account (`sandbox`), whose key creates every demo account. */
  rootId: string;
  rootKey: KeyPair;
  stop(): Promise<void>;
}

type NearSandbox = typeof import("near-sandbox");
type Sandbox = Awaited<ReturnType<NearSandbox["Sandbox"]["start"]>>;

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Seconds to wait for the node to answer /status when NEAR_RPC_TIMEOUT_SECS (near-sandbox's own knob) is unset. */
const READY_SECS = 60;
/** near-sandbox's own default for NEAR_RPC_TIMEOUT_SECS, used when the variable is set but empty or unusable. */
const NEAR_SANDBOX_DEFAULT_SECS = 10;
/** stop() sends SIGTERM; a node still running this long after gets SIGKILL. */
const KILL_AFTER_MS = 10_000;

/** One boot at a time per process: TMPDIR is swapped while near-sandbox starts. */
let booting: Promise<unknown> = Promise.resolve();

/** Boots near-sandbox (nearcore 2.14.0, protocol 88), points the `sandbox` network's RPC at it, and returns its handle. */
export function startSandbox(): Promise<SandboxHandle> {
  const run = booting.then(boot);
  booting = run.catch(() => undefined);
  return run;
}

async function boot(): Promise<SandboxHandle> {
  const home = join(REPO, ".sandbox-home");
  mkdirSync(home, { recursive: true });
  const runDir = mkdtempSync(join(home, "run-"));
  process.env.DIR_TO_DOWNLOAD_BINARY ??= join(REPO, ".sandbox-bin");

  let child: ChildProcess | undefined;
  // Last resort when the process ends without stop(): only synchronous work runs in an `exit` handler.
  const onExit = () => {
    child?.kill("SIGKILL");
    try {
      rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // the node may still be writing as it dies; an exit handler must not throw
    }
  };
  process.on("exit", onExit);

  const savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = runDir;
  let ns: NearSandbox;
  let sb: Sandbox;
  try {
    ns = await import("near-sandbox");
    // Sandbox.start ends with its own readiness wait, which throws without stopping the node or releasing the
    // port locks it took. Starting through an object whose waitUntilReady is a no-op keeps the instance even
    // when the node never answers; waitReady below does the waiting, and stop() can then clean up.
    const lenient = Object.assign(Object.create(ns.Sandbox), { waitUntilReady: async () => {} }) as NearSandbox["Sandbox"];
    sb = await lenient.start({});
  } catch (e) {
    // A port lock may be held, and proper-lockfile keeps refreshing its `.lock` dir: deleting that dir now
    // would crash the process. Keep the lock entries (the exit hook removes them with the run dir).
    if (removeAllBut(runDir, /\.lock$/) === 0) {
      rmSync(runDir, { recursive: true, force: true });
      process.off("exit", onExit);
    }
    throw new EnvironmentError(`near-sandbox did not start: ${(e as Error).message}`, "check .sandbox-bin/near-sandbox-2.14.0 and the free disk space under .sandbox-home");
  } finally {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  }

  const node = (sb as unknown as { childProcess?: ChildProcess }).childProcess;
  if (!node || typeof node.kill !== "function") {
    // Sandbox.stop still works with whatever handle it keeps; without one of ours the node cannot be watched.
    await sb.stop().then(
      () => {
        rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
        process.off("exit", onExit);
      },
      () => undefined,
    );
    throw new EnvironmentError("near-sandbox started, but its Sandbox has no childProcess to watch or stop (not the pinned 0.3.5?)", "reinstall the pinned dependencies (npm ci), then retry");
  }
  // The node is the exit hook's from here (C-T17c). near-sandbox 0.3.5 exposes it only on the Sandbox that start()
  // returns, so it cannot be registered earlier; nor does it need to be. spawnWithArgsAndVersion spawns it and returns
  // it with no await in between, and from there to this line only microtasks run: start()'s waitUntilReady (our no-op
  // above), its return, this function's resumption and the finally block. A signal is handled from the event loop,
  // never between microtasks, so the hard exit (process.exit(130), then this exit hook) cannot run while the node
  // exists and `child` is unset. test/cli.test.ts pins that shape of the installed near-sandbox.
  child = node;
  const stderrTail = drainStderr(node);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      await stopNode(sb, node);
      rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
      process.off("exit", onExit);
    })());

  let rootKey: KeyPair;
  try {
    rootKey = genesisKey(ns.DEFAULT_PRIVATE_KEY);
    await waitReady(sb.rpcUrl, node, stderrTail);
  } catch (e) {
    await stop().catch(() => undefined); // the boot error is the one to report; a failed stop keeps the exit hook
    throw e;
  }
  useRpcUrl("sandbox", sb.rpcUrl);
  const handle = { rpcUrl: sb.rpcUrl, rootId: ns.DEFAULT_ACCOUNT_ID, stop } as SandboxHandle;
  // Not enumerable: console.log, JSON.stringify and test diffs of a handle never show the key.
  Object.defineProperty(handle, "rootKey", { value: rootKey, enumerable: false });
  return handle;
}

/** The sandbox's genesis root key: a well-known test key that near-sandbox publishes. Never echoed. */
function genesisKey(encoded: string): KeyPair {
  try {
    return KeyPair.fromString(encoded as KeyPairString);
  } catch {
    throw new EnvironmentError("near-sandbox's genesis key did not parse (value not shown)", "reinstall the pinned dependencies (npm ci), then retry");
  }
}

/**
 * Seconds to wait for the node's /status. Unset: 60. Set: read as near-sandbox reads it
 * (`parseInt(NEAR_RPC_TIMEOUT_SECS || "10")`), so "" is its default of 10, not 0, and "15" or "15s" is 15.
 * A value that does not parse to a whole number >= 0 ("abc", "-1"), with which near-sandbox would not
 * wait at all, also gets its default of 10.
 */
export function sandboxBootSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NEAR_RPC_TIMEOUT_SECS;
  if (raw === undefined) return READY_SECS;
  const secs = Number.parseInt(raw || String(NEAR_SANDBOX_DEFAULT_SECS), 10);
  return Number.isInteger(secs) && secs >= 0 ? secs : NEAR_SANDBOX_DEFAULT_SECS;
}

/** Polls the node's /status until it answers, it exits, or the deadline passes. */
async function waitReady(rpcUrl: string, node: ChildProcess, stderrTail: () => string): Promise<void> {
  const secs = sandboxBootSeconds();
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    if (exited(node)) {
      throw new EnvironmentError(`near-sandbox exited while booting (${node.signalCode ?? `exit code ${node.exitCode}`})${tail(stderrTail())}`, "check .sandbox-bin/near-sandbox-2.14.0, then retry");
    }
    try {
      const res = await fetch(`${rpcUrl}/status`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new EnvironmentError(`near-sandbox did not answer ${rpcUrl}/status within ${secs} s${tail(stderrTail())}`, "on a slow machine set NEAR_RPC_TIMEOUT_SECS higher, then retry");
}

/** SIGTERM, wait for exit (SIGKILL after KILL_AFTER_MS), then release the two port locks: Sandbox.stop. */
async function stopNode(sb: Sandbox, node: ChildProcess): Promise<void> {
  const alreadyExited = exited(node);
  const escalate = setTimeout(() => node.kill("SIGKILL"), KILL_AFTER_MS);
  try {
    const stopped = sb.stop();
    // Sandbox.stop waits for an "exit" event; a node that already exited emitted it before stop was called.
    if (alreadyExited) node.emit("exit", node.exitCode, node.signalCode);
    await stopped;
  } finally {
    clearTimeout(escalate);
  }
}

const exited = (node: ChildProcess) => node.exitCode !== null || node.signalCode !== null;

/**
 * Reads the node's stderr as it comes (near-sandbox pipes it and never reads it, so a full pipe would stall
 * nearcore) and keeps the last 2 KB for a boot error. nearcore logs no private keys.
 */
function drainStderr(node: ChildProcess): () => string {
  let kept = "";
  node.stderr?.on("data", (chunk: Buffer) => {
    kept = (kept + chunk.toString("utf8")).slice(-2048);
  });
  return () => kept;
}

const tail = (text: string) => {
  const lines = text.replace(/[^\n\x20-\x7e]/g, "").trim().split("\n").slice(-5).join(" | ");
  return lines ? `; last stderr: ${lines.slice(-600)}` : "";
};

/** Deletes every entry of `dir` whose name does not match `keep`; returns how many entries are left. */
function removeAllBut(dir: string, keep: RegExp): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) if (!keep.test(name)) rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 3 });
  return names.filter((name) => keep.test(name)).length;
}
