/**
 * The CLI surface that holds from scaffold to build: `keyhole --help` (Navigation "Global header"), the
 * argument checks every subcommand makes before it does anything (exit 2, nothing signed), the exact
 * string contracts, processIo and the bin entry. No later task edits this file: each command's own
 * behaviour lives in test/cli-{wrap,inspect-burn,serve,demo}.test.ts, which its task replaces.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type Io } from "../src/cli/args.js";
import { COMMANDS, REPEAT_SIGNAL_WINDOW_MS, abortSignalHandler, main } from "../src/cli/main.js";
import { NOT_SIGNED, NOT_SIGNED_NON_TTY, confirmPrompt } from "../src/cli/wrap.js";
import * as S from "../src/render/strings.js";
import { REPO } from "./helpers.js";

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => void out.push(t), err: (t) => void err.push(t) };
  const code = await main(argv, io, {});
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const HEADER = "KEYHOLE - any NEAR contract's methods as MCP tools behind a burnable function-call key";
const T9 = "ERROR (input): allowance must be explicit and non-zero (T9)";

describe("keyhole --help", () => {
  it("prints the global header to stdout and exits 0", async () => {
    const { code, out, err } = await run("--help");
    expect(code).toBe(0);
    expect(err).toBe("");
    const lines = out.split("\n");
    expect(lines[0]).toBe(HEADER);
    // COMMAND / KEYS IT LOADS table, lifecycle order.
    const start = lines.indexOf("COMMAND   KEYS IT LOADS");
    expect(lines.slice(start + 1, start + 6).map((l) => l.split(/\s+/)[0])).toEqual(["wrap", "serve", "inspect", "burn", "demo"]);
    expect(out).toContain("wrap      operator full-access key, 1 tx");
    expect(out).toContain("serve     1 session key");
    expect(out).toContain("npm run keyhole -- COMMAND ARGS");
    expect(out).not.toContain("npx");
    // Plain ASCII, at most 100 columns.
    for (const l of lines) {
      expect(l.length, l).toBeLessThanOrEqual(100);
      expect(/^[\x20-\x7e]*$/.test(l), l).toBe(true);
    }
  });

  it("-h and help are the same", async () => {
    expect((await run("-h")).out).toBe((await run("--help")).out);
    expect((await run("help")).out).toBe((await run("--help")).out);
  });

  it("no arguments: help on stderr, exit 2", async () => {
    const { code, out, err } = await run();
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err.split("\n")[0]).toBe(HEADER);
  });

  it("an unknown command exits 2", async () => {
    expect(await run("frobnicate")).toEqual({ code: 2, out: "", err: 'ERROR (input): unknown command "frobnicate" · run: keyhole --help' });
  });

  it("one bin, five subcommands", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(["wrap", "serve", "inspect", "burn", "demo"]);
  });
});

describe("subcommand arguments: input errors exit 2, nothing signed", () => {
  it.each([[[]], [["--gas", "0"]], [["--gas", "0.0N"]], [["--gas", "0NEAR"]]])("wrap with no allowance %j is refused (T9)", async (gas) => {
    const { code, err } = await run("wrap", "dao.sandbox", "--allow", "act_proposal", ...gas);
    expect(code).toBe(2);
    expect(err).toBe(T9);
  });

  it("wrap lists every input problem, one line each", async () => {
    const { code, err } = await run("wrap", "Not_An_Account!", "--allow", "act_proposal,bad-name", "--gas", "lots");
    expect(code).toBe(2);
    expect(err.split("\n")).toEqual([
      'ERROR (input): CONTRACT "Not_An_Account!" is not a NEAR account id',
      'ERROR (input): --allow: "bad-name" is not a method name',
      'ERROR (input): --gas "lots" is not an amount: NEAR with up to 24 decimals, e.g. 0.05N',
    ]);
  });

  it("an unknown flag is an input error", async () => {
    const { code, err } = await run("wrap", "dao.sandbox", "--allow", "act_proposal", "--gas", "0.05N", "--yes");
    expect(code).toBe(2);
    expect(err).toMatch(/^ERROR \(input\): .*--yes/);
  });

  it.each([[["demo"]], [["demo", "--sandbox", "--testnet"]]])("demo needs exactly one network flag %j", async (argv) => {
    expect(await run(...argv)).toEqual({ code: 2, out: "", err: "ERROR (input): demo needs exactly one of --sandbox or --testnet (there is no default network)" });
  });

  it.each(["serve", "inspect", "burn"])("%s needs exactly one well-formed session id", async (cmd) => {
    expect((await run(cmd)).err).toBe(`ERROR (input): ${cmd} takes exactly one session ID (usage: keyhole ${cmd} ID)`);
    expect((await run(cmd, "../etc")).err).toBe('ERROR (input): not a session id: "../etc" (expected ks- and 4 lowercase hex digits, e.g. ks-7f3a)');
    expect((await run(cmd, "../etc")).code).toBe(2);
  });

  it("COMMAND --help prints its usage and exits 0", async () => {
    expect(await run("wrap", "--help")).toEqual({
      code: 0,
      out: "usage: keyhole wrap CONTRACT --allow METHODS --gas AMOUNT [--on-account ACCOUNT]\nkeys:  operator full-access key, 1 tx",
      err: "",
    });
  });
});

describe("string contracts (exact)", () => {
  it("result tokens", () => {
    expect(S.passRefused("MethodNameMismatch")).toBe("PASS: refused by protocol (MethodNameMismatch)");
    expect(S.REPLAY).toBe("REPLAY");
    expect(S.PASS_IN_SCOPE).toBe("PASS: in scope, landed");
    expect(S.NOTE_IN_SCOPE).toBe("NOTE: in scope — the key does not judge votes; the quorum does");
    expect(S.REFUSED_SERVER_SIDE).toBe("REFUSED (SERVER-SIDE, not the protocol)");
    expect(S.ERROR_ENVIRONMENT).toBe("ERROR (environment)");
    expect(S.failExpected("A", "B")).toBe("FAIL: expected A, parsed B from the body");
  });

  it("the wrap confirm is a typed yes", () => {
    expect(confirmPrompt("seat.testnet")).toBe(`Sign 1 transaction with seat.testnet's full-access key? Only "yes" continues:`);
    expect(NOT_SIGNED).toBe("not signed");
    expect(NOT_SIGNED_NON_TTY).toBe("not signed — confirmation needs an interactive terminal; the scripted path is keyhole demo");
  });

  it("the R7 suite line says six of eight (PRD §6), word for word", () => {
    expect(S.SIX_OF_EIGHT).toBe("six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope");
  });

  it("the strings locked in Task 1 (Global Constraints → Copy and output)", () => {
    expect(S.PASS_RUNTIME).toBe("PASS: runtime failure in a block, gas charged (contrast: the contract refused, not the protocol)");
    expect(S.passChainCheck(4)).toBe("PASS: key state unchanged by 4 refusals");
    expect(S.failChainCheck("nonce 3 → 4")).toBe("FAIL: key state changed by refusals (nonce 3 → 4)");
    expect(S.PASS_KEY_GONE).toBe("PASS: no such key on chain (view_access_key)");
    expect(S.CAPTION).toBe("rejected at validation — never in a block; the RPC response is the evidence");
    expect(S.NOTE_SIGNER_GONE).toBe("InvalidTxError: the account itself is gone, not an access-key error (sub-account mode)");
    expect(S.OFFLINE_ALTERNATIVE).toBe("offline alternative: npm test (REPLAY)");
    expect(S.ALREADY_BURNED).toBe("already burned");
    expect(S.MAINNET_OUT_OF_SCOPE).toBe("mainnet is out of scope: CONTRACT must end in .testnet or .sandbox");
    expect(S.noTools(["counter", "sputnik-v2"])).toBe("no tools: no near-abi and no target pack — available packs: counter, sputnik-v2");
    expect(S.aborted("07", "ks-7f3a")).toBe("ABORTED at [07] · session ks-7f3a is still live · run: keyhole burn ks-7f3a");
    expect(S.abortedSandbox("07")).toBe("ABORTED at [07] · sandbox stopped; nothing persists");
    expect(S.burnedNothingToServe("ks-7f3a")).toBe("session ks-7f3a is burned; nothing to serve");
    expect(S.codeChanged("dao.sandbox", "PIN", "NOW")).toBe(
      "REFUSED (SERVER-SIDE, not the protocol): code_hash of dao.sandbox changed since wrap (pinned PIN, now NOW). Nothing was signed.",
    );
    expect(S.warnRuntime("add_proposal")).toBe(
      "WARN  add_proposal — fails-without-deposit (runtime): a function-call key can never attach a deposit, so every call fails on-chain and still costs gas.",
    );
    expect(S.warnInconclusive("add_proposal")).toBe("WARN  add_proposal — inconclusive: the dry-run could not classify it; raw panic text below.");
    expect(S.exposureVote("seat.kh-op.testnet", "act_proposal", "kh-1a2b.sputnik-v2.testnet")).toBe(
      "The agent acts as seat.kh-op.testnet for act_proposal on kh-1a2b.sputnik-v2.testnet only: any vote on any proposal of this DAO until burn. It cannot transfer, change keys, propose, or reach another contract.",
    );
    expect(S.exposureOnAccount("seat.testnet", "increment, reset", "counter.testnet")).toBe(
      "The agent acts as seat.testnet for increment, reset on counter.testnet only, with any arguments, until burn. It cannot transfer, change keys, attach a deposit, or reach another contract.",
    );
    expect(S.EXPOSURE_SUBACCOUNT).toBe("The agent controls only the session sub-account: what that account owns in the target, plus its gas.");
    expect(S.replayBanner(12, [["testnet", "demo/transcript.md"]])).toBe(
      "REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (12 files, verbatim RPC responses; capture log demo/transcript.md)",
    );
    expect(
      S.replayBanner(15, [
        ["testnet", "demo/transcript.md"],
        ["sandbox", "demo/capture.sandbox.md"],
      ]),
    ).toBe(
      "REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (15 files, verbatim RPC responses; capture logs demo/transcript.md (testnet), demo/capture.sandbox.md (sandbox))",
    );
    expect(S.replayBanner(3)).toBe("REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (3 files, verbatim RPC responses)");
    // C-T16b: the dry-run fixtures' own command, after the logs.
    expect(S.replayBanner(15, [["sandbox", "demo/capture.sandbox.md"]], true)).toBe(
      "REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (15 files, verbatim RPC responses; capture log demo/capture.sandbox.md; dry-runs: npm run capture:sandbox -- --classifier)",
    );
    expect(S.replayBanner(3, [], true)).toBe("REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (3 files, verbatim RPC responses; dry-runs: npm run capture:sandbox -- --classifier)");
    expect(S.displayInvariant(5, 6)).toBe("display invariant: raw block on screen equals fixture bytes (5/6)");
    expect(S.BEATS).toEqual({
      setup: "SETUP",
      wrap: "1/5 WRAP · one AddKey, scope fixed on chain",
      "in-scope": "2/5 IN SCOPE · the key votes; the quorum decides",
      refusals: "3/5 ASSUME THE INJECTION WORKS · 4 attempts via keyhole_attempt",
      inspect: "4/5 INSPECT · the cage card, read from chain",
      burn: "5/5 BURN · DeleteKey, then the same key again",
      smoke: "SMOKE · sandbox only · counter in sub-account mode",
      result: "RESULT",
    });
  });
});

describe("processIo (the real terminal, in a child process)", () => {
  /** Runs `body` as an ES module in a child node with tsx; `io` is processIo from src/cli/main.ts. */
  const node = ["--import", "tsx", "--input-type=module", "-e"];
  const script = (body: string) => `const { processIo: io } = await import("./src/cli/main.ts");\n${body}`;

  it("readLine: one stdin line per call, without its newline, then null at end of input", () => {
    const r = spawnSync(process.execPath, [...node, script("for (let i = 0; i < 3; i++) console.log(JSON.stringify(await io.readLine()));")], {
      cwd: REPO,
      encoding: "utf8",
      input: "yes\nno\n",
      timeout: 15_000,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe('"yes"\n"no"\nnull\n');
  });

  it("readLine lets the process exit while stdin stays open (a TTY never ends)", async () => {
    const child = spawn(process.execPath, [...node, script("console.log(JSON.stringify(await io.readLine()));")], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stdin.write("yes\n"); // stdin is not ended until the child is gone
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => (child.kill(), resolve(null)), 15_000);
      child.on("exit", (c) => (clearTimeout(timer), resolve(c)));
    });
    child.stdin.end();
    expect(code).toBe(0);
    expect(out).toBe('"yes"\n');
  });

  it("signal: aborted by Ctrl-C (SIGINT); importing main.ts installs no handler; a second signal exits at once, 130, through the exit hooks", () => {
    // M1: the exit hooks are how near-sandbox is stopped when the run cannot finish (sandbox.ts SIGKILLs its node in
    // one), so the second signal is process.exit(130), never a death by signal, which would skip them.
    const body = [
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      'console.log(process.listenerCount("SIGINT"));',
      "const signal = io.signal;",
      'console.log(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP"), signal.aborted, io.signal === signal);',
      'process.on("exit", (code) => console.log(`exit hook ${code}`));',
      // Last words set, then cleared: the hard exit has nothing to say, and writes nothing.
      'io.lastWords(() => "never written"); io.lastWords(undefined);',
      'process.kill(process.pid, "SIGINT"); await sleep(200);',
      'console.log(signal.aborted, process.listenerCount("SIGINT"));',
      'process.kill(process.pid, "SIGTERM"); await sleep(2000);',
      'console.log("still running");',
    ].join("\n");
    const r = spawnSync(process.execPath, [...node, script(body)], { cwd: REPO, encoding: "utf8", timeout: 15_000 });
    expect(r.stdout).toBe("0\n1 1 1 false true\ntrue 1\nexit hook 130\n");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(130);
    expect(r.signal).toBeNull();
  });

  it("a repeat within 100 ms of the first signal is the same Ctrl-C and is ignored; one after that is the hard exit, which writes the command's last words on stderr before exit 130 (M1)", () => {
    // tsx's parent relays a Ctrl-C its node child has not acknowledged within 30 ms, so one Ctrl-C under `npm run`
    // can arrive twice (npm forwards it too where /bin/sh execs the script). Here the two land back to back.
    const body = [
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
      "const signal = io.signal;",
      'process.on("exit", (code) => console.log(`exit hook ${code}`));',
      'io.lastWords(() => "STOPPED during [03] the AddKey · the last words");',
      'process.kill(process.pid, "SIGINT"); process.kill(process.pid, "SIGTERM"); await sleep(50);',
      'console.log("repeat ignored", signal.aborted);',
      "await sleep(300);",
      'process.kill(process.pid, "SIGINT"); await sleep(2000);',
      'console.log("still running");',
    ].join("\n");
    const r = spawnSync(process.execPath, [...node, script(body)], { cwd: REPO, encoding: "utf8", timeout: 15_000 });
    expect(r.stdout).toBe("repeat ignored true\nexit hook 130\n");
    expect(r.stderr).toBe("STOPPED during [03] the AddKey · the last words\n");
    expect(r.status).toBe(130);
    expect(r.signal).toBeNull();
  });

  it("last words that throw do not stop the hard exit: still 130, through the exit hooks", () => {
    const body = [
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
      "const signal = io.signal;",
      'process.on("exit", (code) => console.log(`exit hook ${code}`));',
      'io.lastWords(() => { throw new Error("no words"); });',
      'process.kill(process.pid, "SIGTERM"); await sleep(300);',
      'process.kill(process.pid, "SIGTERM"); await sleep(2000);',
      'console.log("still running");',
    ].join("\n");
    const r = spawnSync(process.execPath, [...node, script(body)], { cwd: REPO, encoding: "utf8", timeout: 15_000 });
    expect(r.stdout).toBe("exit hook 130\n");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(130);
  });

  it("abortSignalHandler: the first signal aborts; a repeat is ignored until REPEAT_SIGNAL_WINDOW_MS (100) after the first, then each one is the hard exit", () => {
    expect(REPEAT_SIGNAL_WINDOW_MS).toBe(100);
    let now = 5_000;
    const controller = new AbortController();
    const hardExit = vi.fn();
    const onSignal = abortSignalHandler(controller, hardExit, () => now);
    onSignal();
    expect(controller.signal.aborted).toBe(true);
    for (const at of [5_000, 5_030, 5_099.9]) {
      now = at;
      onSignal(); // measured from the first signal, not from the last repeat
    }
    expect(hardExit).not.toHaveBeenCalled();
    now = 5_100;
    onSignal();
    expect(hardExit).toHaveBeenCalledTimes(1);
    now = 9_000;
    onSignal();
    expect(hardExit).toHaveBeenCalledTimes(2);
  });

  it("Ctrl-C settles a pending readLine with null and lets the process exit while stdin stays open", async () => {
    // As src/cli/index.ts does: the command returns 130 after an abort, and index.ts sets process.exitCode.
    const body = [
      "const signal = io.signal;",
      "const pending = io.readLine();",
      'console.log("reading");',
      "const line = await pending;",
      "console.log(JSON.stringify(line), signal.aborted, JSON.stringify(await io.readLine()));",
      "process.exitCode = signal.aborted ? 130 : 0;",
    ].join("\n");
    const child = spawn(process.execPath, [...node, script(body)], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let sentAt = 0;
    child.stderr.on("data", (d) => (err += String(d)));
    child.stdout.on("data", (d) => {
      out += String(d);
      if (!sentAt && out.includes("reading\n")) {
        sentAt = Date.now();
        child.kill("SIGINT"); // one Ctrl-C; stdin stays open
      }
    });
    const exit = await new Promise<{ code: number | null; ms: number }>((resolve) => {
      const timer = setTimeout(() => (child.kill("SIGKILL"), resolve({ code: null, ms: Number.NaN })), 5_000);
      child.on("exit", (code) => (clearTimeout(timer), resolve({ code, ms: Date.now() - sentAt })));
    });
    child.stdin.end();
    expect(err).toBe("");
    expect(out).toBe("reading\nnull true null\n"); // the pending read, then any later read: null once aborted
    expect(exit.code).toBe(130);
    expect(exit.ms).toBeLessThan(1_000);
  });

  it("a spread copy ({ ...io, out: io.err }) installs no SIGINT handler and does not carry signal", () => {
    const body = [
      "const copy = { ...io, out: io.err };",
      'console.log(process.listenerCount("SIGINT"), "signal" in copy, typeof copy.readLine);',
      'console.log(io.signal.aborted, process.listenerCount("SIGINT"));',
    ].join("\n");
    const r = spawnSync(process.execPath, [...node, script(body)], { cwd: REPO, encoding: "utf8", input: "", timeout: 15_000 });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("0 false function\nfalse 1\n");
  });

  it("fills the other members from the process", () => {
    const body = "console.log(io.env === process.env, io.stdout === process.stdout, io.stdinIsTTY, typeof io.write); io.write('no newline');";
    const r = spawnSync(process.execPath, [...node, script(body)], { cwd: REPO, encoding: "utf8", input: "", timeout: 15_000 });
    expect(r.stdout).toBe("true true false function\nno newline");
  });
});

describe("bin/keyhole.mjs (the npm link entry)", () => {
  const bin = join(REPO, "bin", "keyhole.mjs");
  const exec = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: REPO, encoding: "utf8", timeout: 15_000 });

  it("--help exits 0 with the header", () => {
    const r = exec("--help");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(HEADER);
  });

  it("an input error exits 2 with its message on stderr", () => {
    const r = exec("burn", "../etc");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('ERROR (input): not a session id: "../etc" (expected ks- and 4 lowercase hex digits, e.g. ks-7f3a)\n');
  });
});

// Final sweep C-T17c: core/sandbox.ts hands the near-sandbox node to its exit hook only once Sandbox.start has
// resolved, which is safe while nothing but microtasks run between the spawn and that resolution. This pins the
// installed near-sandbox to that shape, offline: a version that awaits anything else in between fails here.
describe("near-sandbox: no await between the node's spawn and Sandbox.start's return but the readiness wait (C-T17c)", () => {
  const dist = join(REPO, "node_modules", "near-sandbox", "dist", "esm");
  const read = (file: string) => readFileSync(join(dist, file), "utf8");
  /** The text from `from` through `to`, the first `to` after `from` (both must be there). */
  const between = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    expect(start, from).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(to, start + from.length);
    expect(end, to).toBeGreaterThan(start);
    return text.slice(start, end + to.length);
  };

  it("the pinned 0.3.5", () => {
    expect(JSON.parse(readFileSync(join(REPO, "node_modules", "near-sandbox", "package.json"), "utf8")).version).toBe("0.3.5");
  });

  it("Sandbox.start: the spawn's own await, then only `await this.waitUntilReady(rpcUrl)` (core/sandbox.ts makes it a no-op), then the return", () => {
    const start = between(read("index.mjs"), "static async start(params) {", "return new Sandbox(rpcUrl, tmpDir.path, childProcess, rpcPortLock, netPortLock);");
    const afterSpawn = start.slice(start.indexOf("const childProcess = await spawnWithArgsAndVersion("));
    expect(afterSpawn.match(/\bawait\b/g)).toEqual(["await", "await"]);
    expect(afterSpawn).toContain("await this.waitUntilReady(rpcUrl);");
  });

  it("spawnWithArgsAndVersion: the binary check is its one await, before spawn; the child is returned at once", () => {
    const file = readdirSync(dist).find((f) => /^binaryExecution-.*\.mjs$/.test(f));
    expect(file).toBeDefined();
    const body = between(read(file as string), "async function spawnWithArgsAndVersion(", "return child;");
    const afterSpawn = body.slice(body.indexOf("const child = spawn("));
    expect(body.match(/\bawait\b/g)).toEqual(["await"]);
    expect(body.indexOf("await ensureBinWithVersion(version)")).toBeLessThan(body.indexOf("const child = spawn("));
    expect(afterSpawn.includes("await")).toBe(false);
  });
});
