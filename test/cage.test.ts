/**
 * Task 5 offline: buildCageCard ("preview" opens no socket; "chain" reads the key and the code hash) and
 * signBurn (DeleteKey / DeleteAccount, idempotent, local files only after the chain confirms), against the
 * committed spike capture through replayFetch. Keys are generated in memory for each test and never printed:
 * assertions about key text compare to booleans, so a failure cannot echo one.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, type PublicKey, baseEncode, decodeSignedTransaction } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signBurn } from "../src/core/burn.js";
import { buildCageCard, cardExposure } from "../src/core/cage.js";
import { useRpcUrl } from "../src/core/config.js";
import { fullAccessKeyLoadCount, readSessionKey, saveAccountKey, saveSessionKey, sessionKeyPath } from "../src/core/credentials.js";
import { EnvironmentError, InputError } from "../src/core/errors.js";
import { dropHeldKeys, heldPrivateKeyCount, holdSessionKey } from "../src/core/keys.js";
import { saveSession } from "../src/core/session.js";
import type { CageCard, Session, ToolSchema } from "../src/core/types.js";
import { loadTargetPack } from "../src/packs/index.js";
import { renderCageCard } from "../src/render/cage-card.js";
import { CAPS, type ReplayedRequest, SANDBOX_FIXTURES, readFixture, replayFetch, sampleCageCard, sampleSession, tmpEnv } from "./helpers.js";

// loadTargetPack stays the real one; a test can make the next call return a pack without an exposure.
vi.mock("../src/packs/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/packs/index.js")>();
  return { ...real, loadTargetPack: vi.fn(real.loadTargetPack) };
});

const fx = (file: string) => readFixture(SANDBOX_FIXTURES, file);

const STATUS = fx("001-0-status.json");
const DAO_ACCOUNT = fx("015-b-view-dao-account.json"); // code_hash ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq
const KEY_PRESENT = fx("024-d-view-fc-key.json"); // act_proposal on dao.sandbox, 0.05 NEAR, nonce 51000000
const KEY_GONE = fx("070-i-view-burned-key.json"); // the legacy `result.error: ... does not exist` body
const FULL_ACCESS_KEY = fx("068-i-burn-delete-key.nonce.json"); // a FullAccess key read (nonce + block hash)
const DELETE_OK = fx("069-i-burn-delete-key.send_tx.json"); // a landed DeleteKey
const REFUSED = fx("061-g4-deposit-1yocto.send_tx.json"); // InvalidTxError, never in a block
const PIN = "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq";
const POLICY = fx("017-b-get-policy.json"); // the spike DAO's get_policy: council {seat, cosigner}, [1, 2] → 2-of-2
/** The sputnik packs' VOTE row before the receiver's quorum is read (src/packs/sputnik-v2.pack.json). */
const VOTE_BASE = "any proposal here, either way, until burn";

/** A call_function reply carrying `value` as its result bytes, shaped like the recorded ones. */
const viewBody = (value: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: "x", result: { block_hash: "x", block_height: 1, logs: [], result: [...Buffer.from(JSON.stringify(value))] } });
/** A get_policy result whose council Group has `size` members (RoleWeight, threshold [1, 2]); `extra` roles after it. */
const councilPolicy = (size: number, extra: unknown[] = []) => ({
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: Array.from({ length: size }, (_, i) => `m${i}.sandbox`) }, permissions: ["*:Finalize", "*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove"], vote_policy: {} },
    ...extra,
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: "100000000000000000000000",
  proposal_period: "604800000000000",
  bounty_bond: "100000000000000000000000",
  bounty_forgiveness_period: "86400000000000",
});

let urls = 0;
beforeEach(() => {
  useRpcUrl("sandbox", `http://cage-${++urls}.replay.invalid`); // assertChain remembers a check per URL
});
afterEach(() => {
  dropHeldKeys();
  vi.unstubAllEnvs();
});

/** The spike's key read with other scope: `view_access_key` body for a function-call key. */
function keyBody(scope: { methodNames?: string[]; receiverId?: string; allowance?: string | null }): string {
  const json = JSON.parse(KEY_PRESENT);
  const fc = json.result.permission.FunctionCall;
  if (scope.methodNames) fc.method_names = scope.methodNames;
  if (scope.receiverId) fc.receiver_id = scope.receiverId;
  if (scope.allowance === null) delete fc.allowance;
  else if (scope.allowance) fc.allowance = scope.allowance;
  return JSON.stringify(json);
}

/** The pack's tools as wrap classified them (callable dao_vote, add_proposal not in allowlist), on a sandbox session. */
function sessionWithTools(overrides: Partial<Session> = {}): Session {
  return sampleSession({ tools: sampleCageCard().tools, ...overrides });
}

const callTools = (tools: readonly ToolSchema[]) => tools.filter((t) => t.kind === "call").map((t) => [t.method, t.classification] as const);

describe("buildCageCard: preview", () => {
  it("opens no socket: the requested scope as a key, the pin as the code hash, the pack's exposure", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("preview reached for the network");
    };
    const session = sampleSession();
    const card = await buildCageCard(session, "preview");
    expect(card).toMatchObject({ source: "preview", codeHashNow: session.codeHashPin, key: { allowanceRemainingYocto: "50000000000000000000000", nonce: 0 }, exposure: { label: "VOTE" } });
    expect(card.key).toEqual({ publicKey: session.publicKey, accountId: "seat.sandbox", receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowanceRemainingYocto: "50000000000000000000000", nonce: 0 });
    expect(card.session).toBe(session);
    expect(new Date(card.readAt).toISOString()).toBe(card.readAt);
    expect(calls).toBe(0);
  });

  it("keeps the wrap-time classifications when they agree with the requested scope", async () => {
    const session = sessionWithTools();
    const card = await buildCageCard(session, "preview");
    expect(card.tools).toEqual(session.tools);
  });
});

describe("buildCageCard: preview reclassifies against the requested scope", () => {
  it("an empty methodNames (any method) puts every tool in scope and adds the `*` row", async () => {
    const card = await buildCageCard(sessionWithTools({ methodNames: [] }), "preview");
    expect(card.tools.some((t) => t.classification === "not in allowlist")).toBe(false);
    expect(card.tools.find((t) => t.method === "*")).toMatchObject({ kind: "call", classification: "inconclusive" });
  });

  it("a requested scope that lacks a tool's method demotes it; one that lists a tool wrap saw outside the allowlist makes it `inconclusive`", async () => {
    const card = await buildCageCard(sessionWithTools({ methodNames: ["add_proposal"] }), "preview");
    expect(card.tools.find((t) => t.name === "dao_vote")?.classification).toBe("not in allowlist");
    expect(card.tools.find((t) => t.method === "add_proposal")?.classification).toBe("inconclusive");
  });
});

describe("buildCageCard: chain", () => {
  it("reads the key, the code hash and the DAO's policy (view_access_key + view_account + get_policy) and chain wins", async () => {
    const log = replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT, "query:call_function": POLICY });
    const session = sampleSession();
    const card = await buildCageCard(session, "chain");
    expect(card).toMatchObject({ source: "chain", codeHashNow: PIN });
    expect(card.key).toEqual({ publicKey: session.publicKey, accountId: "seat.sandbox", receiverId: "dao.sandbox", methodNames: ["act_proposal"], allowanceRemainingYocto: "50000000000000000000000", nonce: 51000000 });
    expect(new Date(card.readAt).toISOString()).toBe(card.readAt);
    expect(card.exposure).toEqual({ label: "VOTE", value: `${VOTE_BASE}; quorum 2-of-2` });
    expect(log.map((r) => r.params.request_type).sort()).toEqual(["call_function", "view_access_key", "view_account"]);
    expect(log.find((r) => r.params.request_type === "view_access_key")?.params).toMatchObject({ account_id: "seat.sandbox", public_key: session.publicKey, finality: "final" });
    expect(log.find((r) => r.params.request_type === "view_account")?.params).toMatchObject({ account_id: "dao.sandbox", finality: "final" });
    expect(log.find((r) => r.params.request_type === "call_function")?.params).toMatchObject({ account_id: "dao.sandbox", method_name: "get_policy", finality: "final" });
  });

  it("makes its three reads in parallel: all requests are out before any answer comes back", async () => {
    const bodies: Record<string, string> = { view_access_key: KEY_PRESENT, view_account: DAO_ACCOUNT, call_function: POLICY };
    let out = 0;
    let allOut!: () => void;
    const all = new Promise<void>((resolve) => {
      allOut = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      const req = JSON.parse(String(init?.body));
      if (++out === 3) allOut();
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a read was not issued while the others were pending")), 1500));
      await Promise.race([all, timeout]);
      return new Response(bodies[req.params.request_type], { status: 200 });
    };
    const card = await buildCageCard(sampleSession(), "chain");
    expect(card.codeHashNow).toBe(PIN);
    expect(card.exposure.value).toBe(`${VOTE_BASE}; quorum 2-of-2`);
  });

  it("passes a null allowance through (the renderer says NO CAP ON CHAIN)", async () => {
    replayFetch({ "query:view_access_key": keyBody({ allowance: null }), "query:view_account": DAO_ACCOUNT });
    const card = await buildCageCard(sessionWithTools(), "chain");
    expect(card.key?.allowanceRemainingYocto).toBeNull();
    expect(renderCageCard(card, "mcp", CAPS.plain100)).toContain("NO CAP ON CHAIN");
  });

  it("a code hash that changed is reported as read, not as the pin", async () => {
    replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT.replace(PIN, "11111111111111111111111111111111") });
    expect((await buildCageCard(sampleSession(), "chain")).codeHashNow).toBe("11111111111111111111111111111111");
  });

  it("exposure: the pack's; the VALUE default for a pack that declares none, or none that can be loaded", async () => {
    const DEFAULT = { label: "VALUE", value: "anything the signer owns inside the receiver" };
    replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT });
    const real = (await vi.importActual<typeof import("../src/packs/index.js")>("../src/packs/index.js")).loadTargetPack;
    const declared = (await real("sputnik-v2")).exposure;
    expect(declared?.label).toBe("VOTE");
    expect((await buildCageCard(sampleSession({ packId: "sputnik-v2" }), "chain")).exposure).toEqual(declared);
    vi.mocked(loadTargetPack).mockImplementationOnce(async (id, live) => {
      const { exposure: _declared, ...pack } = await real(id, live);
      return pack;
    });
    expect((await buildCageCard(sampleSession({ packId: "sputnik-v2" }), "chain")).exposure).toEqual(DEFAULT);
    expect((await buildCageCard(sampleSession({ packId: "no-such-pack" }), "chain")).exposure).toEqual(DEFAULT);
  });

  it("a public key that is not 32 bytes is refused before any read, and never echoed", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("reached for the network");
    };
    const shaped = `ed25519:${baseEncode(randomBytes(64))}`; // a private key's shape; random bytes, not a key
    for (const source of ["chain", "preview"] as const) {
      const err = await buildCageCard(sampleSession({ publicKey: shaped }), source).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).message.includes(shaped.slice(8))).toBe(false);
    }
    expect(calls).toBe(0);
  });
});

describe("buildCageCard: the VOTE row's quorum is the receiver's, read with get_policy, never the pack's (final review I1)", () => {
  /** The chain card of a sputnik session whose DAO answers get_policy with `policyBody`, and its full plate. */
  async function cardWith(policyBody: string, session: Session = sessionWithTools()): Promise<{ card: CageCard; plate: string }> {
    replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT, "query:call_function": policyBody });
    const card = await buildCageCard(session, "chain");
    return { card, plate: renderCageCard(card, "full", CAPS.plain100) };
  }
  const voteRow = (plate: string) => plate.split("\n").find((l) => l.startsWith("| VOTE "));

  it("a 1-of-1 DAO: the card says quorum 1-of-1", async () => {
    const { card, plate } = await cardWith(viewBody(councilPolicy(1)));
    expect(card.exposure).toEqual({ label: "VOTE", value: `${VOTE_BASE}; quorum 1-of-1` });
    expect(voteRow(plate)).toBe(`| VOTE       ${`${VOTE_BASE}; quorum 1-of-1`.padEnd(58)}   ${"NOT A KEY LIMIT".padEnd(21)}  |`);
    expect(plate).not.toContain("2-of-2");
  });

  it("a 3-of-5 DAO: the card says quorum 3-of-5", async () => {
    const { card, plate } = await cardWith(viewBody(councilPolicy(5)));
    expect(card.exposure.value).toBe(`${VOTE_BASE}; quorum 3-of-5`);
    expect(voteRow(plate)).toContain(`${VOTE_BASE}; quorum 3-of-5`);
    expect(renderCageCard(card, "mcp", CAPS.plain100)).toContain(`VOTE: ${VOTE_BASE}; quorum 3-of-5 (NOT A KEY LIMIT)`);
    expect(plate).not.toContain("2-of-2");
  });

  it("the demo DAO still prints quorum 2-of-2 (the README's card)", async () => {
    const { plate } = await cardWith(POLICY);
    expect(voteRow(plate)).toBe("| VOTE       any proposal here, either way, until burn; quorum 2-of-2     NOT A KEY LIMIT        |");
  });

  it("no quorum is printed that was not read: a failed get_policy, or a policy where no one count decides", async () => {
    const failed = '{"jsonrpc":"2.0","result":{"block_hash":"x","block_height":1,"error":"wasm execution failed with error: MethodResolveError(MethodNotFound)","logs":[]},"id":"x"}';
    const another = viewBody(councilPolicy(3, [{ name: "fastlane", kind: { Group: ["f.sandbox"] }, permissions: ["transfer:VoteApprove"], vote_policy: {} }]));
    const noCouncil = viewBody({ ...councilPolicy(1), roles: [{ name: "Team", kind: { Group: ["t.sandbox"] }, permissions: ["*:*"], vote_policy: {} }] });
    for (const body of [failed, another, noCouncil, "not json"]) {
      const { card, plate } = await cardWith(body);
      expect(card.exposure, body).toEqual({ label: "VOTE", value: VOTE_BASE });
      expect(plate, body).not.toContain("quorum");
      expect(card.codeHashNow, body).toBe(PIN); // the rest of the card is read as before
    }
  });

  it("a pack with no quorum reads no policy: counter's card makes only the key and code-hash reads", async () => {
    const log = replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT });
    const card = await buildCageCard(sampleSession({ packId: "counter" }), "chain");
    expect(log.map((r) => r.params.request_type).sort()).toEqual(["view_access_key", "view_account"]);
    expect(card.exposure).toEqual({ label: "VALUE", value: "anything the signer owns inside the receiver" });
  });

  it("an exposure the caller already read is used as given, with no policy read (offline and replay paths)", async () => {
    const log = replayFetch({ "query:view_access_key": KEY_PRESENT, "query:view_account": DAO_ACCOUNT });
    const given = { label: "VOTE" as const, value: `${VOTE_BASE}; quorum 3-of-5` };
    expect((await buildCageCard(sessionWithTools(), "chain", { exposure: given })).exposure).toEqual(given);
    expect(log.map((r) => r.params.request_type).sort()).toEqual(["view_access_key", "view_account"]);
  });

  it("preview opens no socket: the pack's row without a quorum, or the exposure wrap read", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("preview reached for the network");
    };
    expect((await buildCageCard(sessionWithTools(), "preview")).exposure).toEqual({ label: "VOTE", value: VOTE_BASE });
    const read = { label: "VOTE" as const, value: `${VOTE_BASE}; quorum 1-of-1` };
    expect((await buildCageCard(sessionWithTools(), "preview", { exposure: read })).exposure).toEqual(read);
    expect(calls).toBe(0);
  });

  it("cardExposure: the pack's row completed by the receiver's quorum; the base row when the read fails", async () => {
    replayFetch({ "query:call_function": viewBody(councilPolicy(5)) });
    expect(await cardExposure(sessionWithTools())).toEqual({ label: "VOTE", value: `${VOTE_BASE}; quorum 3-of-5` });
    globalThis.fetch = async () => {
      throw new Error("unreachable");
    };
    expect(await cardExposure(sessionWithTools())).toEqual({ label: "VOTE", value: VOTE_BASE });
  });
});

describe("buildCageCard: classifications agree with the chain (C-T7a)", () => {
  async function chainCard(scope: Parameters<typeof keyBody>[0], session: Session = sessionWithTools()): Promise<CageCard> {
    replayFetch({ "query:view_access_key": keyBody(scope), "query:view_account": DAO_ACCOUNT });
    return buildCageCard(session, "chain");
  }

  it("the key as wrap minted it: nothing changes", async () => {
    const session = sessionWithTools();
    const card = await chainCard({});
    expect(card.tools).toEqual(session.tools);
    expect(callTools(card.tools)).toEqual([
      ["act_proposal", "callable"],
      ["add_proposal", "not in allowlist"],
    ]);
  });

  it("a method the chain key lacks is `not in allowlist`, whatever the wrap-time dry-run said", async () => {
    const card = await chainCard({ methodNames: ["add_proposal"] });
    const vote = card.tools.find((t) => t.name === "dao_vote");
    expect(vote?.classification).toBe("not in allowlist");
    expect(vote?.evidence?.startsWith("absent from the key's method_names (chain)")).toBe(true);
    expect(vote?.evidence).toContain("dry-run at wrap: succeeded with 0 deposit"); // the wrap-time evidence is kept, after the chain's
  });

  it("a method the chain key has, which wrap saw outside the allowlist, is `inconclusive`: it was never dry-run in scope", async () => {
    const card = await chainCard({ methodNames: ["act_proposal", "add_proposal"] });
    const add = card.tools.find((t) => t.method === "add_proposal");
    expect(add?.classification).toBe("inconclusive");
    expect(add?.evidence).toContain("method_names (chain)");
    expect(add?.evidence).toContain("ERR_MIN_BOND"); // the raw wrap-time text stays
    expect(card.tools.find((t) => t.name === "dao_vote")?.classification).toBe("callable");
  });

  it("a method on the chain key that no tool covers gets a row of its own, `inconclusive`", async () => {
    const card = await chainCard({ methodNames: ["act_proposal", "sweep_all"] });
    const extra = card.tools.find((t) => t.method === "sweep_all");
    expect(extra).toMatchObject({ kind: "call", classification: "inconclusive" });
    expect(extra?.evidence).toContain("method_names (chain)");
    expect(renderCageCard(card, "mcp", CAPS.plain100)).toMatch(/METHOD: sweep_all \.+ inconclusive/);
  });

  it("an empty method_names is any method: every tool is in scope and a `*` row says so", async () => {
    const card = await chainCard({ methodNames: [] });
    expect(card.tools.some((t) => t.classification === "not in allowlist")).toBe(false);
    const any = card.tools.find((t) => t.method === "*");
    expect(any).toMatchObject({ kind: "call", classification: "inconclusive" });
    expect(any?.evidence).toMatch(/ANY method/);
  });

  it("a key whose receiver is not the session's: the session's own tools are `not in allowlist`, and the key's methods get rows of their own, on its receiver", async () => {
    const card = await chainCard({ receiverId: "other.sandbox" });
    // The session's tools target dao.sandbox, which this key cannot reach.
    const own = card.tools.filter((t) => t.kind === "call" && !t.name.startsWith("chain:"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((t) => t.classification === "not in allowlist")).toBe(true);
    expect(own.find((t) => t.name === "dao_vote")?.evidence).toContain("other.sandbox");
    // But on chain the key CAN call act_proposal on other.sandbox: the card never claims less than the chain shows.
    const reach = card.tools.filter((t) => t.method === "act_proposal" && t.classification === "inconclusive");
    expect(reach).toHaveLength(1);
    expect(reach[0]).toMatchObject({ name: "chain:act_proposal", kind: "call" });
    expect(reach[0].evidence).toContain("(on other.sandbox)");
    expect(card.key?.receiverId).toBe("other.sandbox");
  });

  it("a key whose receiver is not the session's, rendered: act_proposal is reachable on other.sandbox and the card never says it may call nothing", async () => {
    const card = await chainCard({ receiverId: "other.sandbox" });
    const mcp = renderCageCard(card, "mcp", CAPS.plain100);
    expect(mcp).toContain("RECEIVER: other.sandbox");
    expect(mcp).toMatch(/METHOD: act_proposal \.+ inconclusive/);
    expect(mcp).not.toMatch(/METHOD: act_proposal \.+ not in allowlist/);
    expect(mcp).toContain("(on other.sandbox)");
    expect(mcp).toMatch(/METHOD: add_proposal \.+ not in allowlist/); // not in the key's list on chain either
    const compact = renderCageCard(card, "compact", CAPS.plain100);
    expect(compact).toContain("act_proposal (inconclusive)");
    expect(compact).not.toContain("may call nothing");
  });

  it("a key with an empty method_names on another receiver: the `*` row says ANY method of that receiver, and the card does not say it may call nothing", async () => {
    const card = await chainCard({ receiverId: "other.sandbox", methodNames: [] });
    const any = card.tools.find((t) => t.method === "*");
    expect(any?.evidence).toContain("ANY method of other.sandbox");
    expect(renderCageCard(card, "compact", CAPS.plain100)).not.toContain("may call nothing");
    expect(renderCageCard(card, "mcp", CAPS.plain100)).toMatch(/METHOD: \* \.+ inconclusive/);
  });

  it("a tool moved out of `not in allowlist` carries no stale chain reason, whichever way the chain moved it", async () => {
    // As wrap leaves it (sampleCageCard): add_proposal's evidence begins with the chain reason it had then.
    expect(sessionWithTools().tools.find((t) => t.method === "add_proposal")?.evidence).toMatch(/^absent from the key's method_names \(chain\)/);
    for (const scope of [{ methodNames: ["act_proposal", "add_proposal"] }, { methodNames: [] }]) {
      const add = (await chainCard(scope)).tools.find((t) => t.method === "add_proposal");
      expect(add?.classification).toBe("inconclusive");
      expect(add?.evidence).not.toMatch(/absent from/);
      expect(add?.evidence).toContain("ERR_MIN_BOND"); // the wrap-time dry-run text stays
    }
    // Still `not in allowlist`, for another reason: that reason replaces the old one, it does not stack on it.
    const mismatch = (await chainCard({ receiverId: "other.sandbox" })).tools.find((t) => t.method === "add_proposal");
    expect(mismatch?.classification).toBe("not in allowlist");
    expect(mismatch?.evidence?.startsWith("the key's receiver on chain is other.sandbox")).toBe(true);
    expect(mismatch?.evidence).not.toMatch(/absent from/);
    replayFetch({ "query:view_access_key": KEY_GONE, "query:view_account": DAO_ACCOUNT });
    const burned = (await buildCageCard(sessionWithTools(), "chain")).tools.find((t) => t.method === "add_proposal");
    expect(burned?.evidence?.startsWith("no such key on chain")).toBe(true);
    expect(burned?.evidence).not.toMatch(/absent from/);
  });

  it("views and meta tools are left alone, and the session's own tools are not mutated", async () => {
    const session = sessionWithTools();
    const before = JSON.stringify(session);
    const card = await chainCard({ methodNames: ["add_proposal"] }, session);
    expect(JSON.stringify(session)).toBe(before);
    expect(card.tools.filter((t) => t.kind !== "call")).toEqual(session.tools.filter((t) => t.kind !== "call"));
  });

  it("no key on chain: key null, source chain, every call tool `not in allowlist`, rendered as burned", async () => {
    replayFetch({ "query:view_access_key": KEY_GONE, "query:view_account": DAO_ACCOUNT });
    const card = await buildCageCard(sessionWithTools(), "chain");
    expect(card).toMatchObject({ key: null, source: "chain", codeHashNow: PIN });
    expect(callTools(card.tools).every(([, c]) => c === "not in allowlist")).toBe(true);
    const text = renderCageCard(card, "mcp", CAPS.plain100);
    expect(text).toContain("[BURNED]");
    expect(text).toContain("key burned");
    expect(text).not.toContain("callable");
  });

  it("the card for a chain key with the session's scope renders its methods as the chain has them", async () => {
    const card = await chainCard({ methodNames: ["act_proposal"] });
    const text = renderCageCard(card, "mcp", CAPS.plain100);
    expect(text).toMatch(/METHOD: act_proposal \.+ callable/);
    expect(text).toMatch(/METHOD: add_proposal \.+ not in allowlist/);
  });

  // C-T5c (T5 re-review test debt): each test below kills a mutation that survived the T5 suite.

  /** The hero session with each call tool's evidence replaced by `evidence(tool)`. */
  const withEvidence = (evidence: (t: ToolSchema) => string): Session => {
    const s = sessionWithTools();
    return { ...s, tools: s.tools.map((t) => (t.kind === "call" ? { ...t, evidence: evidence(t) } : t)) };
  };

  it("C-T5c: a stale `no such key on chain` reason in the evidence is replaced, never stacked (the NO_KEY strip in withReason)", async () => {
    const stale = withEvidence((t) => `no such key on chain (view_access_key); ${t.method === "act_proposal" ? "dry-run at wrap: succeeded with 0 deposit" : "ERR_MIN_BOND"}`);
    // dao_vote demoted: the chain's reason first, the wrap-time text kept, the stale reason gone.
    const vote = (await chainCard({ methodNames: ["add_proposal"] }, stale)).tools.find((t) => t.name === "dao_vote");
    expect(vote?.evidence).toBe("absent from the key's method_names (chain); dry-run at wrap: succeeded with 0 deposit");
    // add_proposal promoted to inconclusive: same.
    const add = (await chainCard({ methodNames: ["act_proposal", "add_proposal"] }, stale)).tools.find((t) => t.method === "add_proposal");
    expect(add?.classification).toBe("inconclusive");
    expect(add?.evidence).toBe("listed in the key's method_names (chain); not dry-run in scope at wrap; ERR_MIN_BOND");
  });

  it("C-T5c: a stale receiver reason in the evidence is replaced, never stacked (the WRONG_RECEIVER strip in withReason)", async () => {
    const stale = withEvidence((t) => `the key's receiver on chain is other.sandbox, not dao.sandbox; ${t.method === "act_proposal" ? "dry-run at wrap: succeeded with 0 deposit" : "ERR_MIN_BOND"}`);
    const vote = (await chainCard({ methodNames: ["add_proposal"] }, stale)).tools.find((t) => t.name === "dao_vote");
    expect(vote?.evidence).toBe("absent from the key's method_names (chain); dry-run at wrap: succeeded with 0 deposit");
  });

  it("C-T5c: the receiver reason this module writes is the one it strips (WRONG_RECEIVER is built from the same text): re-reading a mismatched card does not stack it", async () => {
    const first = await chainCard({ receiverId: "other.sandbox" });
    const reread = await chainCard({ receiverId: "third.sandbox" }, { ...sessionWithTools(), tools: first.tools.filter((t) => !t.name.startsWith("chain:")) });
    const vote = reread.tools.find((t) => t.name === "dao_vote");
    expect(vote?.evidence?.startsWith("the key's receiver on chain is third.sandbox, not dao.sandbox; ")).toBe(true);
    expect(vote?.evidence?.split("the key's receiver on chain is")).toHaveLength(2); // once
    expect(vote?.evidence).not.toContain("other.sandbox");
  });

  it("C-T5c: a mismatched receiver whose key lists a method no session tool has still gets a row for it, on its receiver", async () => {
    const card = await chainCard({ receiverId: "other.sandbox", methodNames: ["act_proposal", "sweep_all"] });
    const sweep = card.tools.filter((t) => t.method === "sweep_all");
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatchObject({ name: "chain:sweep_all", kind: "call", classification: "inconclusive" });
    expect(sweep[0].evidence).toContain("(on other.sandbox)");
    expect(renderCageCard(card, "mcp", CAPS.plain100)).toMatch(/METHOD: sweep_all \.+ inconclusive/);
  });

  it("C-T5c: a session with two tools for one method, on a mismatched receiver, gets one chain row for that method (the covered guard)", async () => {
    const s = sessionWithTools();
    const vote = s.tools.find((t) => t.name === "dao_vote") as ToolSchema;
    const twice: Session = { ...s, tools: [...s.tools, { ...vote, name: "dao_vote_again" }] };
    const card = await chainCard({ receiverId: "other.sandbox" }, twice);
    expect(card.tools.filter((t) => t.name === "chain:act_proposal")).toHaveLength(1);
    expect(card.tools.filter((t) => t.method === "act_proposal" && t.classification === "not in allowlist").map((t) => t.name)).toEqual(["dao_vote", "dao_vote_again"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// signBurn

const OPERATOR = "op.sandbox";
const SUB = "ks-7f3a.op.sandbox";

/** The session of a live key; `fcKey` is the session key (its public half is the session's). */
function liveSession(fcKey: KeyPair, overrides: Partial<Session> = {}): Session {
  return sampleSession({ publicKey: fcKey.getPublicKey().toString(), ...overrides });
}

function sendTxRequests(log: ReplayedRequest[]): ReplayedRequest[] {
  return log.filter((r) => r.method === "send_tx" || r.method === "broadcast_tx_commit" || r.method === "broadcast_tx_async");
}

/** `view_access_key` for an account that no longer exists (UNKNOWN_ACCOUNT). */
const gone = (accountId: string): string =>
  `{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"requested_account_id":"${accountId}"},"name":"UNKNOWN_ACCOUNT"},"code":-32000,"message":"Server error","data":"x"},"id":"1"}`;

/** The key nearcore puts on a balance refund: ed25519, 32 zero bytes. */
const EMPTY_KEY = `ed25519:${"1".repeat(32)}`;

/**
 * A DeleteKey + DeleteAccount of the sub-account itself, shaped like near-sandbox 2.14.0's answer (see
 * test/tx.test.ts deleteOwnAccount): the tx's own status is SuccessValue; the main receipt spawns DeleteAccount's
 * balance transfer to the operator and the gas refund to the signer, both sent by `system`; the refund fails,
 * because the signer is gone. `exp` is the EXPERIMENTAL_tx_status body, the same plus `receipts`, where
 * predecessor_id lives. As nearcore builds them, and as the T2 fix round 4 probe saw live (C-T5c), the gas refund
 * carries the signer as its signer_id, with the signer's key; the beneficiary transfer (a balance refund) carries
 * signer_id `system` and the empty key. Built from 069 (a landed DeleteKey).
 */
function deleteSubAccount(): { body: string; exp: string; refundId: string } {
  const json = JSON.parse(DELETE_OK);
  const r = json.result;
  r.transaction.signer_id = SUB;
  r.transaction.receiver_id = SUB;
  r.transaction.actions = [{ DeleteKey: { public_key: r.transaction.public_key } }, { DeleteAccount: { beneficiary_id: OPERATOR } }];
  const [main, refund] = r.receipts_outcome;
  const transfer = JSON.parse(JSON.stringify(refund));
  transfer.id = "De36CxHy6zAD4h1gjjmumy2WShyXavhHhwBm8qnffskL";
  transfer.outcome.executor_id = OPERATOR;
  main.outcome.executor_id = SUB;
  main.outcome.receipt_ids = [transfer.id, refund.id];
  refund.outcome.executor_id = SUB;
  refund.outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: SUB } } } } };
  r.receipts_outcome = [main, transfer, refund];
  const systemReceipt = (id: string, receiver: string, signerId: string) => ({
    predecessor_id: "system",
    receiver_id: receiver,
    receipt_id: id,
    receipt: {
      Action: {
        signer_id: signerId,
        signer_public_key: signerId === "system" ? EMPTY_KEY : r.transaction.public_key,
        gas_price: "0",
        output_data_receivers: [],
        input_data_ids: [],
        actions: [{ Transfer: { deposit: "1" } }],
        is_promise_yield: false,
      },
    },
    priority: 0,
  });
  // The beneficiary transfer is a balance refund (signer_id system); the refund to the deleted signer is its gas refund.
  const exp = JSON.stringify({ ...json, result: { ...r, receipts: [systemReceipt(transfer.id, OPERATOR, "system"), systemReceipt(refund.id, SUB, SUB)] } });
  return { body: JSON.stringify(json), exp, refundId: refund.id };
}

/** The signed transaction inside a send_tx request. */
function signedTx(req: ReplayedRequest) {
  return decodeSignedTransaction(Buffer.from(req.params.signed_tx_base64, "base64")).transaction;
}

/** True when a decoded (borsh) public key is `pub`. A boolean, so no failure can print a key. */
function isKey(decoded: { ed25519Key: { data: ArrayLike<number> } }, pub: PublicKey): boolean {
  return `ed25519:${baseEncode(Uint8Array.from(decoded.ed25519Key.data))}` === pub.toString();
}

/** The session file as saveSession wrote it. */
const sessionFile = (env: { KEYHOLE_HOME: string }, id: string) => JSON.parse(readFileSync(join(env.KEYHOLE_HOME, "sessions", `${id}.json`), "utf8"));

describe("signBurn: on-account", () => {
  it("one DeleteKey, signed by the account's full-access key as the account, for the session key", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const faKey = KeyPair.fromRandom("ed25519");
    saveAccountKey("sandbox", "seat.sandbox", faKey, env); // the keychain path: signBurn loads the key itself
    const session = liveSession(fcKey);
    const log = replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });
    const loadsBefore = fullAccessKeyLoadCount();

    const result = await signBurn(session, { persist: false, env });

    expect(fullAccessKeyLoadCount()).toBe(loadsBefore + 1);
    const sent = sendTxRequests(log);
    expect(sent).toHaveLength(1);
    const tx = signedTx(sent[0]);
    expect(tx.signerId).toBe("seat.sandbox");
    expect(tx.receiverId).toBe("seat.sandbox");
    expect(tx.actions).toHaveLength(1);
    expect(isKey((tx.actions[0] as any).deleteKey.publicKey, fcKey.getPublicKey())).toBe(true);
    expect(tx.publicKey.toString() === faKey.getPublicKey().toString()).toBe(true);
    expect(sent[0].params.wait_until).toBe("FINAL");
    expect(result.txHashes).toHaveLength(1);
    expect(result.session).toMatchObject({ id: session.id, status: "burned", burnTxHashes: result.txHashes });
    expect(new Date(result.session.burnedAt ?? "").toISOString()).toBe(result.session.burnedAt);
    expect(session.status).toBe("live"); // the argument is not mutated
  });

  it("`signerKey` replaces the keychain's key: nothing is loaded from the keychain", async () => {
    const env = tmpEnv(); // empty
    const faKey = KeyPair.fromRandom("ed25519");
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });
    const loadsBefore = fullAccessKeyLoadCount();
    const result = await signBurn(liveSession(KeyPair.fromRandom("ed25519")), { persist: false, signerKey: faKey, env });
    expect(result.txHashes).toHaveLength(1);
    expect(fullAccessKeyLoadCount()).toBe(loadsBefore);
  });

  it("a session key that is a full-access key on chain is never burned: viewScopedKey refuses it, nothing is signed", async () => {
    // A session file that names the account's own full-access key must not turn a burn into a lock-out.
    const log = replayFetch({ status: STATUS, "query:view_access_key": FULL_ACCESS_KEY });
    const err = await signBurn(liveSession(KeyPair.fromRandom("ed25519")), { persist: false, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toContain("is a full-access key, not a function-call key");
    expect(sendTxRequests(log)).toHaveLength(0);
  });

  it("the operator key missing: EnvironmentError, nothing sent, the session file stays live and the key file stays", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    const log = replayFetch({ status: STATUS, "query:view_access_key": KEY_PRESENT });
    const err = await signBurn(session, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toContain("no full-access key for seat.sandbox");
    expect(sendTxRequests(log)).toHaveLength(0);
    expect(sessionFile(env, session.id).status).toBe("live");
    expect(readSessionKey(session, env) !== null).toBe(true);
  });
});

describe("signBurn: sub-account", () => {
  it("DeleteKey + DeleteAccount(beneficiary = the parent) in one tx, signed as the sub-account with the operator's key", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const operatorKey = KeyPair.fromRandom("ed25519");
    saveAccountKey("sandbox", OPERATOR, operatorKey, env); // the operator's file; the sub-account has none
    const session = liveSession(fcKey, { mode: "subaccount", accountId: SUB });
    const log = replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });

    const result = await signBurn(session, { persist: false, env });

    const sent = sendTxRequests(log);
    expect(sent).toHaveLength(1);
    const tx = signedTx(sent[0]);
    expect(tx.signerId).toBe(SUB);
    expect(tx.receiverId).toBe(SUB);
    expect(tx.publicKey.toString() === operatorKey.getPublicKey().toString()).toBe(true);
    expect(tx.actions).toHaveLength(2);
    expect(isKey((tx.actions[0] as any).deleteKey.publicKey, fcKey.getPublicKey())).toBe(true);
    expect((tx.actions[1] as any).deleteAccount.beneficiaryId).toBe(OPERATOR);
    expect(result.txHashes).toHaveLength(1);
    expect(result.session.status).toBe("burned");
    // The nonce was read for the operator's key on the sub-account, the key read for the session key on the sub-account.
    expect(log.filter((r) => r.params?.request_type === "view_access_key").map((r) => r.params.account_id)).toEqual([SUB, SUB]);
  });

  it("a sub-account id with no parent is an input error before any read", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("reached for the network");
    };
    const err = await signBurn(liveSession(KeyPair.fromRandom("ed25519"), { mode: "subaccount", accountId: "sandbox" }), { persist: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect(calls).toBe(0);
  });

  it("the gas refund to the deleted sub-account fails (AccountDoesNotExist) and the burn still counts: mustSucceed reads who sent that receipt", async () => {
    const { body, exp, refundId } = deleteSubAccount();
    const log = replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: body, EXPERIMENTAL_tx_status: exp });
    const result = await signBurn(liveSession(KeyPair.fromRandom("ed25519"), { mode: "subaccount", accountId: SUB }), { persist: false, signerKey: KeyPair.fromRandom("ed25519") });
    expect(result.txHashes).toHaveLength(1);
    expect(result.session.status).toBe("burned");
    expect(JSON.parse(body).result.receipts_outcome.some((o: { id: string }) => o.id === refundId)).toBe(true); // the failed refund is in the body
    expect(log.filter((r) => r.method === "send_tx")).toHaveLength(1);
    expect(log.filter((r) => r.method === "EXPERIMENTAL_tx_status")).toHaveLength(1);
  });

  it("the refund check unreadable: T2 counts every failed receipt, so the burn that worked is reported as an error; running it again finishes without a tx", async () => {
    const env = tmpEnv();
    const session = liveSession(KeyPair.fromRandom("ed25519"), { mode: "subaccount", accountId: SUB });
    await saveSession(session, env);
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: deleteSubAccount().body }); // no EXPERIMENTAL_tx_status answer
    const err = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(/^burn ks-7f3a: failed in a block: .*AccountDoesNotExist.*gas refunds could not be read/);
    expect(sessionFile(env, session.id).status).toBe("live"); // nothing local changed on an error

    const log = replayFetch({ "query:view_access_key": gone("ks-7f3a.op.sandbox") }); // the sub-account is gone: the chain says the burn happened
    const retry = await signBurn(session, { env });
    expect(retry.txHashes).toEqual([]);
    expect(sendTxRequests(log)).toHaveLength(0);
    expect(sessionFile(env, session.id).status).toBe("burned");
  });

  it("a tx whose own status is Failure is not a burn: EnvironmentError, no local change", async () => {
    const env = tmpEnv();
    const json = JSON.parse(DELETE_OK);
    json.result.status = { Failure: { ActionError: { index: 1, kind: { DeleteAccountStaking: { account_id: SUB } } } } };
    const session = liveSession(KeyPair.fromRandom("ed25519"), { mode: "subaccount", accountId: SUB });
    await saveSession(session, env);
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: JSON.stringify(json) });
    const err = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(/^burn ks-7f3a: failed in a block/);
    expect(sessionFile(env, session.id).status).toBe("live");
  });
});

describe("signBurn: already burned", () => {
  it("the chain has no such key: no send_tx, no status read, no operator key asked for, txHashes []", async () => {
    const env = tmpEnv(); // no operator key anywhere: it must not be needed
    const log = replayFetch({ "query:view_access_key": KEY_GONE });
    const loadsBefore = fullAccessKeyLoadCount();
    const result = await signBurn(liveSession(KeyPair.fromRandom("ed25519")), { persist: false, env });
    expect(result.txHashes).toEqual([]);
    expect(result.session).toMatchObject({ status: "burned", burnTxHashes: [] });
    expect(result.session.burnedAt).toBeTruthy();
    expect(log.map((r) => r.method)).toEqual(["query"]);
    expect(fullAccessKeyLoadCount()).toBe(loadsBefore);
  });

  it("a sub-account that is gone reads as burned too (UNKNOWN_ACCOUNT)", async () => {
    const log = replayFetch({ "query:view_access_key": gone(SUB) });
    const result = await signBurn(liveSession(KeyPair.fromRandom("ed25519"), { mode: "subaccount", accountId: SUB }), { persist: false });
    expect(result.txHashes).toEqual([]);
    expect(sendTxRequests(log)).toHaveLength(0);
  });

  it("a session file that already says burned keeps its burnedAt and its tx hashes; the chain is still asked", async () => {
    const env = tmpEnv();
    const session = liveSession(KeyPair.fromRandom("ed25519"), { status: "burned", burnedAt: "2026-11-01T10:00:00.000Z", burnTxHashes: ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] });
    const log = replayFetch({ "query:view_access_key": KEY_GONE });
    const result = await signBurn(session, { env });
    expect(result.txHashes).toEqual([]);
    expect(result.session).toMatchObject({ status: "burned", burnedAt: "2026-11-01T10:00:00.000Z", burnTxHashes: ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] });
    expect(log).toHaveLength(1);
    expect(sessionFile(env, session.id)).toMatchObject({ status: "burned", burnedAt: "2026-11-01T10:00:00.000Z" });
  });

  it("a session file that says burned while the chain still has the key: the chain wins and the burn is sent", async () => {
    const log = replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });
    const session = liveSession(KeyPair.fromRandom("ed25519"), { status: "burned", burnedAt: "2026-11-01T10:00:00.000Z", burnTxHashes: [] });
    const result = await signBurn(session, { persist: false, signerKey: KeyPair.fromRandom("ed25519") });
    expect(sendTxRequests(log)).toHaveLength(1);
    expect(result.txHashes).toHaveLength(1);
    expect(result.session.burnedAt).not.toBe("2026-11-01T10:00:00.000Z");
  });
});

describe("signBurn: persist", () => {
  it("after the chain confirms: the session file says burned (burnedAt, burnTxHashes), the key file is deleted, a held key stays held", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    holdSessionKey(session, fcKey);
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);

    // At the moment the tx goes out, nothing local has changed yet.
    const atSend: { status?: string; keyFile?: boolean } = {};
    const inner = replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });
    const replay = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "send_tx") {
        atSend.status = sessionFile(env, session.id).status;
        atSend.keyFile = existsSync(sessionKeyPath(session, env));
      }
      return replay(input, init);
    };

    const result = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") });

    expect(sendTxRequests(inner)).toHaveLength(1);
    expect(atSend).toEqual({ status: "live", keyFile: true });
    const file = sessionFile(env, session.id);
    expect(file).toMatchObject({ status: "burned", burnedAt: result.session.burnedAt, burnTxHashes: result.txHashes });
    expect(result.txHashes).toHaveLength(1);
    expect(existsSync(sessionKeyPath(session, env))).toBe(false);
    expect(Object.keys(file).includes("private_key")).toBe(false);
    expect(heldPrivateKeyCount()).toBe(1); // R11a: signBurn deletes the file, never a key already in memory
  });

  it("run again (the burn is done): no tx, the same burnedAt and hashes, still no key file", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });
    const first = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") });

    const log = replayFetch({ "query:view_access_key": KEY_GONE });
    const second = await signBurn(first.session, { env });
    expect(second.txHashes).toEqual([]);
    expect(sendTxRequests(log)).toHaveLength(0);
    expect(second.session).toEqual(first.session);
    expect(sessionFile(env, session.id)).toMatchObject({ burnedAt: first.session.burnedAt, burnTxHashes: first.txHashes });
    expect(existsSync(sessionKeyPath(session, env))).toBe(false);
  });

  it("`persist: false` touches no file: no session file is written and the key file stays", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    saveSessionKey(session, fcKey, env);
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });
    await signBurn(session, { persist: false, env, signerKey: KeyPair.fromRandom("ed25519") });
    expect(existsSync(join(env.KEYHOLE_HOME, "sessions"))).toBe(false);
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);
    expect(statSync(sessionKeyPath(session, env)).mode & 0o777).toBe(0o600);
  });

  it("the session file is saved before the key file is deleted: a save that fails leaves the key file for the retry", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    saveSessionKey(session, fcKey, env);
    writeFileSync(join(env.KEYHOLE_HOME, "sessions"), ""); // a file where the sessions dir belongs: saveSession cannot write
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: DELETE_OK });

    const err = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(/the key is burned on chain \(tx \w+\)/);
    expect((err as EnvironmentError).tryThis).toContain(`keyhole burn ${session.id} again`);
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);

    // The retry the message promises: nothing to sign, and the local cleanup finishes.
    rmSync(join(env.KEYHOLE_HOME, "sessions"));
    const log = replayFetch({ "query:view_access_key": KEY_GONE });
    const retry = await signBurn(session, { env });
    expect(retry.txHashes).toEqual([]);
    expect(sendTxRequests(log)).toHaveLength(0);
    expect(sessionFile(env, session.id).status).toBe("burned");
    expect(existsSync(sessionKeyPath(session, env))).toBe(false);
  });

  it("a send the chain refuses: EnvironmentError, no local change", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY], send_tx: REFUSED });
    const err = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).what).toMatch(/refused at validation \(DepositWithFunctionCall\)/);
    expect(sessionFile(env, session.id).status).toBe("live");
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);
  });

  it("a send whose fate is unknown: the look-it-up hint comes through verbatim, send_tx is sent once, nothing local changes", async () => {
    const env = tmpEnv();
    const fcKey = KeyPair.fromRandom("ed25519");
    const session = liveSession(fcKey);
    await saveSession(session, env);
    saveSessionKey(session, fcKey, env);
    replayFetch({ status: STATUS, "query:view_access_key": [KEY_PRESENT, FULL_ACCESS_KEY] });
    const replay = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "send_tx") {
        sends++;
        throw new TypeError("fetch failed");
      }
      return replay(input, init);
    };
    const err = await signBurn(session, { env, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).tryThis).toMatch(/look .*up on chain before signing/); // T2's hint, passed through as raised
    expect(sends).toBe(1);
    expect(sessionFile(env, session.id).status).toBe("live");
    expect(existsSync(sessionKeyPath(session, env))).toBe(true);
  });

  it("a malformed session is refused before the chain is touched (it could not be saved afterwards)", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("reached for the network");
    };
    const err = await signBurn(liveSession(KeyPair.fromRandom("ed25519"), { allowanceYocto: "0" }), { env: tmpEnv() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect(calls).toBe(0);
  });
});

describe("signBurn: the session public key", () => {
  it("a value that is not 32 bytes (a private key's shape) is refused before any read, and never echoed", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("reached for the network");
    };
    const shaped = baseEncode(randomBytes(64)); // random bytes in a private key's shape; not a key
    const err = await signBurn(sampleSession({ publicKey: `ed25519:${shaped}` }), { persist: false, signerKey: KeyPair.fromRandom("ed25519") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).message.includes(shaped)).toBe(false);
    expect(calls).toBe(0);
  });
});
