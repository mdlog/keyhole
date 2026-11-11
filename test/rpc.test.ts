/**
 * src/core/rpc.ts offline: the DATA CONTRACT views (#7 viewScopedKey, #8 viewCodeHash, #12 callView),
 * viewAccount, the mainnet guard (assertChain) and rpcCall's retry rule.
 *
 * Replies come from the committed spike capture (demo/fixtures/sandbox/) through replayFetch. A few bodies
 * no capture holds are written inline, each copied from what near-sandbox 2.14.0 answered (the live suite,
 * test-sandbox/chain.sandbox.test.ts, reads the same shapes). Tests that need an HTTP status other than
 * 200 use a local fetch stub.
 */
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcUrlFor, useRpcUrl } from "../src/core/config.js";
import { EnvironmentError } from "../src/core/errors.js";
import { KEY_NOT_SHOWN, dropHeldKeys, holdSessionKey, privateKeyTexts } from "../src/core/keys.js";
import {
  NO_CODE_HASH,
  RPC_MAX_BODY_BYTES,
  RPC_TIMEOUT_MS,
  RpcTimeoutError,
  SEND_HINT,
  assertChain,
  callView,
  redactUrl,
  rpcCall,
  rpcErrorText,
  rpcErrorTextAt,
  viewAccount,
  viewCodeHash,
  viewScopedKey,
} from "../src/core/rpc.js";
import type { Network } from "../src/core/types.js";
import { SANDBOX_FIXTURES, keyGlue, readFixture, replayFetch, sampleSession } from "./helpers.js";

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);

let urls = 0;
/** assertChain remembers a passed check per network and RPC URL for the process, so every test gets fresh URLs. */
function freshUrl(network: Network): string {
  const url = `http://${network}-${++urls}.replay.invalid`;
  useRpcUrl(network, url);
  return url;
}
beforeEach(() => {
  freshUrl("sandbox");
  freshUrl("testnet");
});

/** The captured sandbox status body with another chain_id (no capture holds a mainnet or testnet status). */
const statusWith = (chainId: string) => fx("001-0-status.json").replace('"chain_id":"test-chain-FSZ71"', `"chain_id":${JSON.stringify(chainId)}`);
/** view_account / call_function on a missing account, as near-sandbox 2.14.0 answers it (HTTP 200). */
const unknownAccount = (id: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    error: {
      name: "HANDLER_ERROR",
      cause: { info: { block_hash: "ArXAzRAmGzNu5jAhSs3LPRsaFzAR1ydGtpo8STKpXRLX", block_height: 1, requested_account_id: id }, name: "UNKNOWN_ACCOUNT" },
      code: -32000,
      message: "Server error",
      data: `account ${id} does not exist while viewing`,
    },
    id: "keyhole-1",
  });

describe("views (replayed RPC)", () => {
  it("viewScopedKey reads the session's key from view_access_key (024-d-view-fc-key.json)", async () => {
    const s = sampleSession();
    const log = replayFetch({ "query:view_access_key": fx("024-d-view-fc-key.json") });
    expect(await viewScopedKey(s)).toMatchObject({ receiverId: "dao.sandbox", methodNames: ["act_proposal"] });
    expect(await viewScopedKey(s)).toEqual({
      publicKey: s.publicKey,
      accountId: "seat.sandbox",
      receiverId: "dao.sandbox",
      methodNames: ["act_proposal"],
      allowanceRemainingYocto: "50000000000000000000000",
      nonce: 51000000,
    });
    expect(log[0].params).toEqual({ request_type: "view_access_key", finality: "final", account_id: "seat.sandbox", public_key: s.publicKey });
  });

  it("viewScopedKey is null once the key is deleted (070-i-view-burned-key.json: result.error, not error)", async () => {
    replayFetch({ "query:view_access_key": fx("070-i-view-burned-key.json") });
    expect(await viewScopedKey(sampleSession())).toBeNull();
  });

  it("viewScopedKey is null when the account is gone too (sub-account burn)", async () => {
    // near-sandbox 2.14.0 answers view_access_key on a missing account with the same legacy result.error.
    const body = fx("070-i-view-burned-key.json");
    replayFetch({ "query:view_access_key": body });
    expect(await viewScopedKey(sampleSession({ accountId: "ks-7f3a.op.sandbox" }))).toBeNull();
    replayFetch({ "query:view_access_key": unknownAccount("ks-7f3a.op.sandbox") });
    expect(await viewScopedKey(sampleSession({ accountId: "ks-7f3a.op.sandbox" }))).toBeNull();
  });

  it("viewScopedKey refuses to present a full-access key as a session key", async () => {
    // 003 is the root account's own key: permission "FullAccess".
    replayFetch({ "query:view_access_key": fx("003-a-create-seat.nonce.json") });
    await expect(viewScopedKey(sampleSession())).rejects.toThrow(/full-access key/);
  });

  it("viewScopedKey: any other RPC error is an environment error, not a burned key", async () => {
    replayFetch({ "query:view_access_key": fx("053-g1-method-add_proposal.tx_status.json") });
    await expect(viewScopedKey(sampleSession())).rejects.toBeInstanceOf(EnvironmentError);
  });

  it("viewCodeHash reads code_hash from view_account (015-b-view-dao-account.json)", async () => {
    const log = replayFetch({ "query:view_account": fx("015-b-view-dao-account.json") });
    expect(await viewCodeHash("sandbox", "dao.sandbox")).toBe("ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq");
    expect(log[0].params).toEqual({ request_type: "view_account", finality: "final", account_id: "dao.sandbox" });
  });

  it("viewCodeHash: a missing account is an environment error naming it", async () => {
    replayFetch({ "query:view_account": unknownAccount("nobody.sandbox") });
    await expect(viewCodeHash("sandbox", "nobody.sandbox")).rejects.toThrow(/nobody\.sandbox does not exist on sandbox/);
  });

  it("viewAccount: balance and code hash, NO_CODE_HASH for a plain account, null for a missing one", async () => {
    replayFetch({ "query:view_account": [fx("015-b-view-dao-account.json"), fx("030-e-grantee-balance-before.json"), unknownAccount("nobody.sandbox")] });
    expect(await viewAccount("sandbox", "dao.sandbox")).toEqual({ amountYocto: "14996380700593303500000000", codeHash: "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq" });
    expect((await viewAccount("sandbox", "grantee.sandbox"))?.codeHash).toBe(NO_CODE_HASH);
    expect(await viewAccount("sandbox", "nobody.sandbox")).toBeNull();
  });

  it("callView calls call_function on the session's receiver and returns the result untouched (017-b-get-policy.json)", async () => {
    const s = sampleSession();
    const log = replayFetch({ "query:call_function": fx("017-b-get-policy.json") });
    const policy = await callView(s, "get_policy", {});
    expect(policy).toMatchObject({ proposal_bond: "100000000000000000000000" });
    expect(policy).toEqual(JSON.parse(Buffer.from(JSON.parse(fx("017-b-get-policy.json")).result.result).toString("utf8")));
    expect(log[0].params).toMatchObject({ request_type: "call_function", finality: "final", account_id: "dao.sandbox", method_name: "get_policy" });
    expect(Buffer.from(log[0].params.args_base64, "base64").toString()).toBe("{}");
  });

  it("callView passes its args as base64 JSON and returns any JSON value (016-b-version.json)", async () => {
    const log = replayFetch({ "query:call_function": fx("016-b-version.json") });
    expect(await callView(sampleSession(), "version", { id: 0, note: "ünïcode" })).toBe("2.0.0");
    expect(JSON.parse(Buffer.from(log[0].params.args_base64, "base64").toString("utf8"))).toEqual({ id: 0, note: "ünïcode" });
  });

  it("callView: a contract error in result.error is an environment error with the node's text", async () => {
    // A read-only testnet body: get_owner does not exist on the legacy factory.
    replayFetch({ "query:call_function": readFixture(join(SANDBOX_FIXTURES, "testnet-readonly"), "A-factory-get_owner.json") });
    await expect(callView(sampleSession(), "get_owner", {})).rejects.toThrow(/MethodResolveError\(MethodNotFound\)/);
    replayFetch({ "query:call_function": unknownAccount("dao.sandbox") });
    await expect(callView(sampleSession(), "get_policy", {})).rejects.toThrow(/UNKNOWN_ACCOUNT/);
  });
});

describe("assertChain (mainnet is forbidden)", () => {
  it("accepts the sandbox's chain id, reads status once per process, and resolves to the URL it verified (001-0-status.json)", async () => {
    const log = replayFetch({ status: fx("001-0-status.json") });
    expect(await assertChain("sandbox")).toBe(rpcUrlFor("sandbox"));
    expect(await assertChain("sandbox")).toBe(rpcUrlFor("sandbox"));
    expect(log.map((r) => r.method)).toEqual(["status"]);
    expect(log[0].url).toBe(rpcUrlFor("sandbox"));
  });

  it("assertChain refuses a mainnet chain_id on either network, and a refusal is not remembered", async () => {
    const log = replayFetch({ status: statusWith("mainnet") });
    await expect(assertChain("sandbox")).rejects.toThrow(/mainnet/);
    await expect(assertChain("sandbox")).rejects.toBeInstanceOf(EnvironmentError);
    await expect(assertChain("testnet")).rejects.toThrow(/mainnet/);
    expect(log.map((r) => r.method)).toEqual(["status", "status", "status"]);
  });

  it("testnet requires chain_id testnet", async () => {
    replayFetch({ status: fx("001-0-status.json") });
    await expect(assertChain("testnet")).rejects.toThrow(/"test-chain-FSZ71", not "testnet"/);
    replayFetch({ status: statusWith("testnet") });
    await expect(assertChain("testnet")).resolves.toBe(rpcUrlFor("testnet"));
  });

  it("a status reply without a chain_id is an environment error", async () => {
    replayFetch({ status: fx("053-g1-method-add_proposal.tx_status.json") });
    await expect(assertChain("sandbox")).rejects.toThrow(/no chain_id/);
  });

  it("a new RPC URL for the same network is checked again", async () => {
    const log = replayFetch({ status: fx("001-0-status.json") });
    await assertChain("sandbox");
    freshUrl("sandbox");
    await assertChain("sandbox");
    expect(log.map((r) => r.url)).toHaveLength(2);
    expect(new Set(log.map((r) => r.url)).size).toBe(2);
  });
});

describe("rpcCall retries (fake timers)", () => {
  type Reply = { status: number; body: string };
  /** fetch stub: replies in order with an HTTP status; records each request's method and the (fake) time. */
  function httpReplies(replies: Reply[]): { method: string; at: number }[] {
    const calls: { method: string; at: number }[] = [];
    globalThis.fetch = async (_input, init) => {
      calls.push({ method: JSON.parse(String(init?.body)).method, at: Date.now() });
      const r = replies.shift();
      if (!r) throw new Error("httpReplies: no reply left");
      return new Response(r.body, { status: r.status });
    };
    return calls;
  }
  /** Advances fake time in small steps until `p` settles (at most 20 s), then returns it. */
  async function drive<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(100);
    return p;
  }
  const gaps = (calls: { at: number }[]) => calls.slice(1).map((c, i) => c.at - calls[i].at);
  const tooMany: Reply = { status: 429, body: "Too Many Requests" };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rpcCall retries a view on 429 twice then succeeds; never retries send_tx", async () => {
    const view = httpReplies([tooMany, tooMany, { status: 200, body: fx("015-b-view-dao-account.json") }]);
    const reply = await drive(rpcCall("http://x.invalid", "query", { request_type: "view_account", finality: "final", account_id: "dao.sandbox" }));
    expect(view.map((c) => c.method)).toEqual(["query", "query", "query"]);
    expect(gaps(view)).toEqual([500, 1000]);
    expect(reply.raw).toBe(fx("015-b-view-dao-account.json"));

    const send = httpReplies([tooMany, { status: 200, body: fx("027-e-fc-vote-approve-0.send_tx.json") }]);
    const err = await drive(rpcCall("http://x.invalid", "send_tx", { signed_tx_base64: "AA==", wait_until: "FINAL" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toMatch(/HTTP 429.*send_tx.*never re-sent/);
    expect(send).toHaveLength(1);
  });

  it("502 and 503 are retried too, after 0.5, 1, 2 and 4 s; then an environment error", async () => {
    const calls = httpReplies([502, 503, 503, 502, 503].map((status) => ({ status, body: "<html>bad gateway</html>" })));
    const err = await drive(rpcCall("http://x.invalid", "block", { finality: "final" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).message).toMatch(/HTTP 503 for block after 5 attempts/);
    expect(gaps(calls)).toEqual([500, 1000, 2000, 4000]);
  });

  it("when the retries run out on 429, 502 or 503, the hint names the variable that changes the RPC, and keeps the offline alternative (T21c)", async () => {
    for (const status of [429, 502, 503]) {
      httpReplies(Array.from({ length: 5 }, () => ({ status, body: "" })));
      const err = await drive(rpcCall("http://x.invalid", "query", { request_type: "view_account", finality: "final", account_id: "dao.sandbox" })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EnvironmentError);
      // rpcCall is not told the network, so the hint names both variables; testnet's comes with one example value.
      expect((err as EnvironmentError).tryThis).toBe(
        "wait and retry, or use another RPC endpoint (testnet: set KEYHOLE_TESTNET_RPC, for example https://rpc.testnet.fastnear.com; sandbox: set KEYHOLE_SANDBOX_RPC); offline alternative: npm test (REPLAY)",
      );
    }
  });

  it("a send that got 429 never suggests a retry or another RPC: its hint is SEND_HINT, look it up first (T21c)", async () => {
    for (const method of ["send_tx", "broadcast_tx_commit", "broadcast_tx_async"]) {
      httpReplies([{ status: 429, body: "" }]);
      const err = await drive(rpcCall("http://x.invalid", method, ["AA=="])).catch((e: unknown) => e);
      expect((err as EnvironmentError).tryThis).toBe(SEND_HINT);
      expect((err as EnvironmentError).line()).not.toMatch(/KEYHOLE_|retry|another RPC/);
    }
  });

  it("broadcast_tx_commit and broadcast_tx_async are never retried", async () => {
    for (const method of ["broadcast_tx_commit", "broadcast_tx_async"]) {
      const calls = httpReplies([{ status: 503, body: "" }]);
      await expect(drive(rpcCall("http://x.invalid", method, ["AA=="]))).rejects.toBeInstanceOf(EnvironmentError);
      expect(calls).toHaveLength(1);
    }
  });

  it("other statuses come back as the reply: nearcore answers TIMEOUT_ERROR with HTTP 408", async () => {
    const timeout = '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"cause":"NOT_OBSERVED"},"name":"TIMEOUT_ERROR"},"code":-32000,"message":"Server error","data":"Timeout"},"id":"p"}';
    const calls = httpReplies([{ status: 408, body: timeout }]);
    const reply = await drive(rpcCall("http://x.invalid", "tx", { tx_hash: "x", sender_account_id: "seat.sandbox", wait_until: "FINAL" }));
    expect(reply).toEqual({ raw: timeout, json: JSON.parse(timeout), httpStatus: 408 });
    expect(calls).toHaveLength(1);
  });

  it("an unreachable endpoint is an environment error at once (no retry)", async () => {
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    await expect(rpcCall("http://127.0.0.1:9", "status", [])).rejects.toThrow(/RPC http:\/\/127\.0\.0\.1:9 unreachable \(status\)/);
    expect(n).toBe(1);
  });
});

describe("rpcCall limits: client-side timeout, body cap, URL redaction (Task 2 fix round 1)", () => {
  /** fetch stub that never answers: it rejects only when the request is aborted. Returns the methods asked for. */
  function silentNode(): string[] {
    const calls: string[] = [];
    globalThis.fetch = (_input, init) => {
      calls.push(JSON.parse(String(init?.body)).method);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))));
    };
    return calls;
  }
  /** Advances fake time in 1 s steps until `p` settles (at most 300 s). */
  async function driveLong<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 300 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
    return p;
  }

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a read the node never answers is a timeout error after 30 s, asked once", async () => {
      const calls = silentNode();
      const t0 = Date.now();
      const err = await driveLong(rpcCall("http://x.invalid", "block", { finality: "final" })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcTimeoutError);
      expect(err).toBeInstanceOf(EnvironmentError);
      expect((err as RpcTimeoutError).message).toMatch(/^RPC http:\/\/x\.invalid did not answer block within 30 s/);
      expect(calls).toEqual(["block"]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(RPC_TIMEOUT_MS.other);
      expect(Date.now() - t0).toBeLessThan(RPC_TIMEOUT_MS.other + 2000);
    });

    it("send_tx and tx get 120 s; a send that times out says it may have reached the node", async () => {
      for (const method of ["send_tx", "tx"]) {
        const calls = silentNode();
        const t0 = Date.now();
        const err = await driveLong(rpcCall("http://x.invalid", method, {})).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RpcTimeoutError);
        expect((err as RpcTimeoutError).method).toBe(method);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(RPC_TIMEOUT_MS.waiting);
        expect(Date.now() - t0).toBeLessThan(RPC_TIMEOUT_MS.waiting + 2000);
        expect(calls).toEqual([method]);
      }
      silentNode();
      const err = await driveLong(rpcCall("http://x.invalid", "send_tx", {})).catch((e: unknown) => e);
      expect((err as RpcTimeoutError).tryThis).toBe(SEND_HINT);
    });
  });

  it("a body larger than 32 MiB is refused as it streams in, without reading the rest", async () => {
    const mib = new Uint8Array(1024 * 1024);
    let pulls = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (++pulls > 64) controller.close();
            else controller.enqueue(mib);
          },
        }),
      );
    await expect(rpcCall("http://x.invalid", "query", { request_type: "view_account" })).rejects.toThrow(/answered more than 32 MiB for query/);
    expect(RPC_MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
    expect(pulls).toBeGreaterThan(32);
    expect(pulls).toBeLessThan(40);
  });

  it("a body that declares more than 32 MiB is refused before it is read; a send gets the send hint", async () => {
    let pulls = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.close();
          },
        }),
        { headers: { "content-length": String(64 * 1024 * 1024) } },
      );
    const err = await rpcCall("http://x.invalid", "send_tx", {}).catch((e: unknown) => e);
    expect((err as EnvironmentError).message).toMatch(/answered more than 32 MiB for send_tx/);
    expect((err as EnvironmentError).tryThis).toBe(SEND_HINT);
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("redactUrl keeps scheme, host and port only: a path or query (where a provider puts its API key) prints as /…", () => {
    expect(redactUrl("https://alice:hunter2@rpc.example.invalid/v1/near?apiKey=s3cr3tvalue#frag")).toBe("https://rpc.example.invalid/…");
    expect(redactUrl("https://mainnet.infura.io/v3/0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe("https://mainnet.infura.io/…");
    expect(redactUrl("https://rpc.example.invalid/k3yt0ken/")).toBe("https://rpc.example.invalid/…");
    expect(redactUrl("https://rpc.example.invalid/?apiKey=s3cr3tvalue")).toBe("https://rpc.example.invalid/…");
    expect(redactUrl("http://127.0.0.1:3030")).toBe("http://127.0.0.1:3030");
    expect(redactUrl("http://127.0.0.1:3030/")).toBe("http://127.0.0.1:3030");
    expect(redactUrl("https://rpc.example.invalid#frag")).toBe("https://rpc.example.invalid");
    expect(redactUrl("not a url")).toBe("<unparsable RPC URL>");
  });

  it("errors name the RPC by scheme, host and port only: never its userinfo, path, query or fragment", async () => {
    const cases = [
      { url: "https://alice:hunter2@rpc.example.invalid/v1/near?apiKey=s3cr3tvalue#frag", printed: "https://rpc.example.invalid/…", secrets: ["alice", "hunter2", "v1/near", "s3cr3tvalue", "apiKey", "#frag"] },
      { url: "https://mainnet.infura.io/v3/0f1e2d3c4b5a69788796a5b4c3d2e1f0", printed: "https://mainnet.infura.io/…", secrets: ["/v3", "0f1e2d3c4b5a69788796a5b4c3d2e1f0"] },
      { url: "https://rpc.example.invalid/k3yt0ken/", printed: "https://rpc.example.invalid/…", secrets: ["k3yt0ken"] },
    ];
    for (const { url, printed, secrets } of cases) {
      const clean = (e: unknown) => {
        const text = `${(e as EnvironmentError).message} ${(e as EnvironmentError).tryThis}`;
        return secrets.every((secret) => !text.includes(secret));
      };
      // fetch itself may echo the URL (undici does, for a URL with credentials), or only its path.
      globalThis.fetch = async (input) => {
        throw new TypeError(`Request to ${String(input)} failed (path ${new URL(String(input)).pathname}${new URL(String(input)).search})`);
      };
      for (const method of ["status", "send_tx"]) {
        const unreachable = await rpcCall(url, method, []).catch((e: unknown) => e);
        expect((unreachable as Error).message.startsWith(`RPC ${printed} unreachable (${method})`)).toBe(true);
        expect(clean(unreachable)).toBe(true);
      }

      globalThis.fetch = async () => new Response("<html>gateway</html>");
      const nonJson = await rpcCall(url, "query", {}).catch((e: unknown) => e);
      expect((nonJson as Error).message.includes(`RPC ${printed} returned non-JSON for query (HTTP 200)`)).toBe(true);
      expect(clean(nonJson)).toBe(true);

      globalThis.fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
      const badGateway = await rpcCall(url, "send_tx", {}).catch((e: unknown) => e);
      expect((badGateway as Error).message.startsWith(`RPC ${printed} answered HTTP 502 for send_tx`)).toBe(true);
      expect(clean(badGateway)).toBe(true);

      expect(clean(new RpcTimeoutError("send_tx", url, 120_000))).toBe(true);

      useRpcUrl("sandbox", url);
      replayFetch({ status: statusWith("mainnet") });
      const refused = await assertChain("sandbox").catch((e: unknown) => e);
      expect((refused as Error).message.includes(`RPC ${printed} serves chain_id "mainnet"`)).toBe(true);
      expect(clean(refused)).toBe(true);
    }
  });

  it("a fetch that rejects with something other than an Error is still an unreachable error, and a send keeps the send hint", async () => {
    const url = "https://mainnet.infura.io/v3/0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const rejections: unknown[] = [`socket closed: ${url}`, undefined, null, { code: "ECONNRESET" }, 42, { message: 7 }, Object.create(null)];
    for (const reason of rejections) {
      globalThis.fetch = () => Promise.reject(reason);
      const send = await rpcCall(url, "send_tx", {}).catch((e: unknown) => e);
      expect(send).toBeInstanceOf(EnvironmentError);
      expect((send as EnvironmentError).message.startsWith("RPC https://mainnet.infura.io/… unreachable (send_tx): ")).toBe(true);
      expect((send as EnvironmentError).message.includes("0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe(false);
      expect((send as EnvironmentError).tryThis).toBe(SEND_HINT);
      const read = await rpcCall(url, "query", {}).catch((e: unknown) => e);
      expect(read).toBeInstanceOf(EnvironmentError);
      expect((read as EnvironmentError).tryThis).not.toBe(SEND_HINT);
    }
  });
});

describe("an RPC's JSON error never prints the RPC URL's path or query (fix round 4)", () => {
  it("the chain check and the views scrub the reply's error text, before it is cut to 300 characters", async () => {
    const url = "https://rpc-views.example.invalid/v3/k3yt0ken?apiKey=s3cr3tvalue";
    const secrets = ["/v3", "k3yt0ken", "s3cr3tvalue", "apiKey"];
    useRpcUrl("sandbox", url);
    /**
     * A gateway's JSON error echoing the request, `pad` characters in. At 236 the URL starts at character 260 of
     * the text ("GATEWAY_ERROR: " + pad + "upstream "), so a cut at 300 before the scrub would keep `…invalid/v3/k3y`.
     */
    const echo = (pad: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: `${"x".repeat(pad)}upstream ${url} failed: POST /v3/k3yt0ken?apiKey=s3cr3tvalue` },
        id: "p",
      });
    const session = sampleSession({ network: "sandbox" });
    for (const pad of [0, 236]) {
      replayFetch({ status: echo(pad), "query:view_account": echo(pad), "query:view_access_key": echo(pad), "query:call_function": echo(pad) });
      const errors = [
        await assertChain("sandbox").catch((e: unknown) => e),
        await viewAccount("sandbox", "seat.sandbox").catch((e: unknown) => e),
        await viewScopedKey(session).catch((e: unknown) => e),
        await callView(session, "get_policy", {}).catch((e: unknown) => e),
      ];
      for (const e of errors) {
        expect(e).toBeInstanceOf(EnvironmentError);
        const text = `${(e as EnvironmentError).message} ${(e as EnvironmentError).tryThis}`;
        expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
        if (pad === 0) expect(text).toContain("GATEWAY_ERROR: upstream https://rpc-views.example.invalid/… failed: POST /…");
      }
    }
  });
});

// Sweep A fix round 1 (Minor 1): rpcErrorText and rpcErrorTextAt redact, then cut. A held key placed so that 11 of its
// characters sit before the cut at 300 is replaced first, and the cut falls in KEY_NOT_SHOWN; cutting first would
// leave those 11 characters (too few for a key window) in the text. Key text is compared with booleans only.
describe("fix round 1 (Minor 1): the order is redact, then cut at 300", () => {
  afterEach(() => dropHeldKeys());
  /**
   * A node error whose errorText is `GATEWAY_ERROR: ` + filler + `key`, with exactly 11 characters of `key` before 300.
   * The filler is "f", or another base58 letter where the key's text continues into "f" (helpers keyGlue; sweep A fix
   * round 2, I2), so the replacement starts exactly at `key` for every key.
   */
  function errorAtCut(key: string, windows: readonly string[]) {
    const lead = "GATEWAY_ERROR: ";
    const filler = keyGlue(key, windows, { before: "f" }).before.repeat(300 - 11 - lead.length);
    const json = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "GATEWAY_ERROR", info: {} }, code: -32000, message: "Server error", data: `${filler}${key} after` }, id: "p" };
    return { json, expected: `${lead}${filler}${KEY_NOT_SHOWN.slice(0, 11)}` };
  }

  it.each([
    ["rpcErrorText", (json: unknown) => rpcErrorText(json)],
    ["rpcErrorTextAt", (json: unknown) => rpcErrorTextAt(json, "https://rpc-cut.example.invalid/v3/k3y")],
  ])("%s: the 11 characters before the cut are KEY_NOT_SHOWN's, never the key's (both forms)", (_name, read) => {
    const kp = KeyPair.fromRandom("ed25519");
    holdSessionKey(sampleSession({ publicKey: kp.getPublicKey().toString() }), kp);
    const windows = privateKeyTexts(kp).flatMap((t) => Array.from({ length: t.length - 11 }, (_, i) => t.slice(i, i + 12)));
    for (const form of privateKeyTexts(kp)) {
      const { json, expected } = errorAtCut(form, windows);
      const out = read(json);
      expect(out.length).toBe(300);
      expect(out === expected).toBe(true);
    }
  });
});
