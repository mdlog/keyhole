/**
 * Task 2 live suite (`npm run test:sandbox`): chain I/O against a real near-sandbox (nearcore 2.14.0).
 * Local only: every key is the sandbox root's or generated in memory here, and none is printed.
 *
 * The main flow follows the brief. Boot, check the chain, create seat and cosigner, deploy the vendored
 * Sputnik v2 DAO with the pack's `new` args, add proposal #0 as the cosigner, add a seat FC key
 * (act_proposal, 0.05 NEAR) and send two FC votes back to back. The second lands and panics
 * ERR_ALREADY_VOTED, where a vote sent before the first one's refund would be refused NotEnoughAllowance
 * (0.05 − 0.030919 < 0.030919). That fits settle, but it does not prove it: on one local node the refund can
 * land before the next nonce read anyway. The proof that sendAttempt waits for the receipt tree is the
 * offline fake-timer tests in test/tx.test.ts and test/attempt.test.ts. Then stop: the RPC refuses connections.
 *
 * The last block replaces near-sandbox with a stand-in (vi.doMock) for the boot edges no real node can show:
 * a Sandbox without a childProcess, and a genesis key that does not parse after the node was spawned.
 */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { KeyPair, actions, baseDecode } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEAR, TGAS, minAllowanceYocto } from "../src/core/amounts.js";
import { predictViolation, sendAttempt } from "../src/core/attempt.js";
import { EnvironmentError } from "../src/core/errors.js";
import { dropHeldKeys, holdSessionKey } from "../src/core/keys.js";
import { NO_CODE_HASH, assertChain, callView, rpcCall, viewAccount, viewCodeHash, viewScopedKey } from "../src/core/rpc.js";
import { sandboxBootSeconds, startSandbox } from "../src/core/sandbox.js";
import { mustSucceed, signAndSend, successValue } from "../src/core/tx.js";
import type { AttemptInput } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { sampleSession } from "../test/helpers.js";
import { REPO, createAccount, repoSandboxProcesses, sandboxHomeEntries, withSandbox } from "./helpers.js";

/** The session allowance the PRD uses (MH4): room for one 30 TGas vote in flight. */
const ALLOWANCE = 5n * 10n ** 22n;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  dropHeldKeys();
  vi.unstubAllEnvs();
});

describe("chain I/O on near-sandbox", () => {
  it("boots, deploys the DAO, votes twice with an FC key (settled in between), and stops", async () => {
    const homeBefore = sandboxHomeEntries();
    const nodesBefore = repoSandboxProcesses();

    const rpcUrl = await withSandbox(async (sb) => {
      expect(sandboxHomeEntries()).toHaveLength(homeBefore.length + 1); // this run's dir, while it is up
      // The genesis root key is usable but never enumerated, so a logged, serialized or diffed handle has no
      // key in it. Booleans only: a failing check must not print the key either.
      const rootSecret = sb.rootKey.toString();
      expect(sb.rootKey.getPublicKey().toString().startsWith("ed25519:")).toBe(true);
      expect(Object.keys(sb).includes("rootKey")).toBe(false);
      expect(Object.getOwnPropertyDescriptor(sb, "rootKey")?.enumerable === false).toBe(true);
      expect(JSON.stringify(sb).includes(rootSecret)).toBe(false);
      expect(inspect(sb, { depth: 8 }).includes(rootSecret)).toBe(false);
      expect(JSON.stringify({ ...sb }).includes(rootSecret)).toBe(false);
      expect(await assertChain("sandbox")).toBe(sb.rpcUrl);
      const seat = `seat.${sb.rootId}`;
      const cosigner = `cosigner.${sb.rootId}`;
      const dao = `dao.${sb.rootId}`;
      const seatKey = await createAccount(sb, "seat", 10n * NEAR);
      const cosignerKey = await createAccount(sb, "cosigner", 10n * NEAR);
      const daoKey = await createAccount(sb, dao, 15n * NEAR);

      // Views on plain and missing accounts, as near-sandbox answers them.
      expect((await viewAccount("sandbox", seat))?.codeHash).toBe(NO_CODE_HASH);
      expect(await viewAccount("sandbox", `nobody.${sb.rootId}`)).toBeNull();
      await expect(viewCodeHash("sandbox", `nobody.${sb.rootId}`)).rejects.toThrow(/nobody\.sandbox does not exist on sandbox/);

      // The vendored DAO, deployed with `new` and the pack's init args ({seat}, {cosigner} filled in).
      const fixture = (await loadTargetPack("sputnik-v2")).sandboxFixture;
      if (!fixture) throw new Error("sputnik-v2 pack has no sandboxFixture");
      const initArgs = JSON.parse(JSON.stringify(fixture.init.args).replaceAll('"{seat}"', JSON.stringify(seat)).replaceAll('"{cosigner}"', JSON.stringify(cosigner)));
      const wasm = new Uint8Array(readFileSync(join(REPO, fixture.wasmPath)));
      mustSucceed("deploy + new", await signAndSend("sandbox", dao, daoKey, dao, [actions.deployContract(wasm), actions.functionCall(fixture.init.method, initArgs, 100n * TGAS, 0n)]));
      expect(await viewCodeHash("sandbox", dao)).toBe(fixture.codeHash);

      const fcKey = KeyPair.fromRandom("ed25519");
      const session = sampleSession({
        accountId: seat,
        receiverId: dao,
        methodNames: ["act_proposal"],
        allowanceYocto: ALLOWANCE.toString(),
        codeHashPin: fixture.codeHash,
        publicKey: fcKey.getPublicKey().toString(),
      });
      const policy = (await callView(session, "get_policy", {})) as { proposal_bond: string; roles: Array<{ name: string; kind: { Group?: string[] } }> };
      expect(policy.proposal_bond).toBe((NEAR / 10n).toString());
      expect([...(policy.roles.find((r) => r.name === "council")?.kind.Group ?? [])].sort()).toEqual([cosigner, seat]); // the contract keeps a sorted set

      // Proposal #0, added by the cosigner with the 0.1 NEAR bond.
      const added = await signAndSend("sandbox", cosigner, cosignerKey, dao, [
        actions.functionCall("add_proposal", { proposal: { description: "Keyhole T2 live suite: poll #0", kind: "Vote" } }, 100n * TGAS, BigInt(policy.proposal_bond)),
      ]);
      expect(successValue(mustSucceed("add_proposal #0", added))).toBe(0);

      // The seat's FC key: act_proposal on the DAO only, 0.05 NEAR allowance (on-account mode).
      mustSucceed("add FC key", await signAndSend("sandbox", seat, seatKey, seat, [actions.addFunctionCallAccessKey(fcKey.getPublicKey(), dao, ["act_proposal"], ALLOWANCE)]));
      expect(await viewScopedKey(session)).toMatchObject({ accountId: seat, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: ALLOWANCE.toString() });
      holdSessionKey(session, fcKey);

      const stored = (await callView(session, "get_proposal", { id: 0 })) as { kind: unknown };
      const vote = (action: "VoteApprove" | "VoteReject"): AttemptInput => ({
        sessionId: session.id,
        receiverId: dao,
        action: "FunctionCall",
        method: "act_proposal",
        args: { id: 0, action, proposal: stored.kind, memo: `keyhole T2 ${action}` },
        depositYocto: "0",
        gasTGas: 30,
        violates: "none",
      });

      const approve = await sendAttempt(session, vote("VoteApprove"));
      expect(approve.outcome.kind).toBe("TxSuccess");
      // Settled: the refund is back on the key, enough for one more 30 TGas call.
      const afterApprove = await viewScopedKey(session);
      expect(BigInt(afterApprove?.allowanceRemainingYocto ?? "0") >= minAllowanceYocto(30)).toBe(true);

      const reject = await sendAttempt(session, vote("VoteReject"));
      expect(reject.outcome.kind).toBe("ContractPanic"); // landed, never a Refusal
      expect(reject.outcome.kind === "ContractPanic" ? reject.outcome.message : "").toMatch(/ERR_ALREADY_VOTED/);
      expect(((await callView(session, "get_proposal", { id: 0 })) as { votes: Record<string, string> }).votes).toEqual({ [seat]: "Approve" });

      // Out of scope: the protocol refuses it at validation, and predictViolation named the same rule.
      const outOfScope: AttemptInput = { ...vote("VoteApprove"), method: "add_proposal", args: { proposal: { description: "x", kind: "Vote" } }, violates: "method" };
      expect(predictViolation(session, outOfScope)).toBe("method");
      const refused = await sendAttempt(session, outOfScope);
      expect(refused.outcome.kind === "Refusal" ? refused.outcome.errorName : refused.outcome.kind).toBe("MethodNameMismatch");

      // Burn: once the key is deleted, view_access_key has nothing for it.
      mustSucceed("delete FC key", await signAndSend("sandbox", seat, seatKey, seat, [actions.deleteKey(fcKey.getPublicKey())]));
      expect(await viewScopedKey(session)).toBeNull();

      // Fix round 3: a DeleteAccount of the signer itself. The gas refund to the now-deleted signer fails
      // (AccountDoesNotExist); it is a gas refund to the signer, so it is not the tx's failure and mustSucceed passes.
      const doomed = `doomed.${sb.rootId}`;
      const doomedKey = await createAccount(sb, "doomed", 2n * NEAR);
      const deleted = await signAndSend("sandbox", doomed, doomedKey, doomed, [actions.deleteAccount(sb.rootId)]);
      const failedIds: string[] = deleted.json.result.receipts_outcome.filter((o: { outcome: { status: object } }) => "Failure" in o.outcome.status).map((o: { id: string }) => o.id);
      expect(failedIds).toHaveLength(1); // the refund really failed on chain: the case is live
      expect(mustSucceed("delete doomed", deleted)).toBe(deleted);
      // Fix round 4: only that gas refund is skipped, never the beneficiary transfer `system` also sent.
      expect(deleted.refundReceiptIds).toEqual(failedIds);
      // Fix round 4 probe: the receipts EXPERIMENTAL_tx_status lists, as nearcore builds them. A key is described,
      // never shown: "empty" (32 zero bytes), "the signer's" or "another".
      const listed = await rpcCall(sb.rpcUrl, "EXPERIMENTAL_tx_status", { tx_hash: deleted.json.result.transaction.hash, sender_account_id: doomed, wait_until: "FINAL" });
      const signerPk = doomedKey.getPublicKey().toString();
      const keyOf = (k: unknown) =>
        typeof k !== "string" ? typeof k : k === signerPk ? "the signer's" : k.startsWith("ed25519:") && baseDecode(k.slice(8)).every((b) => b === 0) ? "empty" : "another";
      type Listed = { predecessor_id: string; receiver_id: string; receipt_id: string; receipt: { Action?: { signer_id: string; signer_public_key: unknown } } };
      const shapes = (listed.json.result.receipts as Listed[])
        .map((x) => ({ predecessor: x.predecessor_id, receiver: x.receiver_id, signerId: x.receipt.Action?.signer_id, key: keyOf(x.receipt.Action?.signer_public_key), failed: failedIds.includes(x.receipt_id) }))
        .sort((a, b) => a.receiver.localeCompare(b.receiver));
      expect(shapes).toEqual([
        { predecessor: "system", receiver: doomed, signerId: doomed, key: "the signer's", failed: true }, // the gas refund
        { predecessor: "system", receiver: sb.rootId, signerId: "system", key: "empty", failed: false }, // the beneficiary transfer
      ]);
      expect(await viewAccount("sandbox", doomed)).toBeNull();
      return sb.rpcUrl;
    });

    // Stopped: the RPC refuses connections, and nothing of the run is left.
    await expect(rpcCall(rpcUrl, "status", [])).rejects.toThrow(/unreachable/);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  });

  it("a boot that fails stops the node and removes its files (NEAR_RPC_TIMEOUT_SECS=0: no time to answer)", async () => {
    const homeBefore = sandboxHomeEntries();
    const nodesBefore = repoSandboxProcesses();
    vi.stubEnv("NEAR_RPC_TIMEOUT_SECS", "0");
    const err = await startSandbox().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toMatch(/near-sandbox did not answer http:\/\/127\.0\.0\.1:[0-9]+\/status within 0 s/);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  });

  it("a process that exits without stop() takes its node and files with it (exit hook)", async () => {
    const homeBefore = sandboxHomeEntries();
    const nodesBefore = repoSandboxProcesses();
    const script = 'const { startSandbox } = await import("./src/core/sandbox.ts"); const sb = await startSandbox(); console.log(sb.rpcUrl); process.exit(0);';
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO, timeout: 150_000 });
    const rpcUrl = stdout.trim().split("\n").pop() ?? "";
    expect(rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    // SIGKILL went out at exit; give the kernel a moment to reap the node.
    for (let i = 0; i < 50 && JSON.stringify(repoSandboxProcesses()) !== JSON.stringify(nodesBefore); i++) await pause(100);
    expect(repoSandboxProcesses()).toEqual(nodesBefore);
    await expect(rpcCall(rpcUrl, "status", [])).rejects.toThrow(/unreachable/);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
  });
});

describe("sandbox boot edges (no node: near-sandbox replaced by a stand-in)", () => {
  /** Not a key: '-' is not base58, so KeyPair.fromString throws on it. */
  const NOT_A_KEY = "ed25519:stand-in-genesis-value";
  let start: () => Promise<unknown> = async () => {
    throw new Error("no stand-in Sandbox.start set");
  };

  /** A spawned node as near-sandbox keeps it: kill() ends it, and "exit" follows. */
  function standInNode() {
    const signals: string[] = [];
    const node = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      stderr: new EventEmitter(),
      kill(signal = "SIGTERM") {
        signals.push(signal);
        if (node.exitCode === null && node.signalCode === null) {
          node.signalCode = signal;
          queueMicrotask(() => node.emit("exit", null, signal));
        }
        return true;
      },
    });
    return { node, signals };
  }

  /** startSandbox with the stand-in; if it boots anyway (the stand-in did not apply), the node is stopped at once. */
  async function bootError(): Promise<unknown> {
    vi.doMock("near-sandbox", () => ({ DEFAULT_ACCOUNT_ID: "sandbox", DEFAULT_PRIVATE_KEY: NOT_A_KEY, Sandbox: { start: () => start() } }));
    vi.stubEnv("NEAR_RPC_TIMEOUT_SECS", "1");
    return startSandbox().then(
      async (handle) => {
        await handle.stop();
        return "booted";
      },
      (e: unknown) => e,
    );
  }

  afterEach(() => {
    vi.doUnmock("near-sandbox");
  });

  it("NEAR_RPC_TIMEOUT_SECS is read as near-sandbox reads it: empty is its default of 10 s, not 0", () => {
    expect(sandboxBootSeconds({})).toBe(60);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "" })).toBe(10);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "0" })).toBe(0);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "15" })).toBe(15);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "15s" })).toBe(15);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "2.5" })).toBe(2);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "abc" })).toBe(10);
    expect(sandboxBootSeconds({ NEAR_RPC_TIMEOUT_SECS: "-1" })).toBe(10);
  });

  it("a Sandbox without a childProcess is a clear error; it is stopped and its run dir and exit hook are gone", async () => {
    const homeBefore = sandboxHomeEntries();
    const exitHooks = process.listenerCount("exit");
    let stops = 0;
    start = async () => ({
      rpcUrl: "http://127.0.0.1:9",
      stop: async () => {
        stops++;
      },
    });
    const err = await bootError();
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toMatch(/^near-sandbox started, but its Sandbox has no childProcess to watch or stop/);
    expect(stops).toBe(1);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
    expect(process.listenerCount("exit")).toBe(exitHooks);
  });

  it("a genesis key that does not parse after the node was spawned stops the node (SIGTERM) and never shows the value", async () => {
    const homeBefore = sandboxHomeEntries();
    const exitHooks = process.listenerCount("exit");
    const { node, signals } = standInNode();
    let stops = 0;
    start = async () => ({
      rpcUrl: "http://127.0.0.1:9",
      childProcess: node,
      // near-sandbox 0.3.5's stop: kill(), then wait for "exit".
      stop: async () => {
        stops++;
        node.kill();
        await new Promise((resolve) => node.once("exit", resolve));
      },
    });
    const err = await bootError();
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toBe("near-sandbox's genesis key did not parse (value not shown)");
    expect((err as EnvironmentError).message.includes("stand-in-genesis-value")).toBe(false);
    expect(stops).toBe(1);
    expect(signals).toEqual(["SIGTERM"]);
    expect(sandboxHomeEntries()).toEqual(homeBefore);
    expect(process.listenerCount("exit")).toBe(exitHooks);
  });
});
