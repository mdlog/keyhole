/**
 * Shared test paths, samples and helpers (locked in Task 1). Every value here is public chain data from
 * the committed sandbox capture (demo/transcript.sandbox.md): no private key appears in any test file.
 * Tests that need a private key generate one in memory and never write it outside a tmpEnv() dir.
 *
 * Imports from src/ are type-only, so loading this file registers no stub (test/contract.test.ts).
 *
 * vitest only: loading this module registers an afterAll hook (tmpEnv cleanup), so scripts/ and src/
 * must never import it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import type { CageCard, Session, TargetPack, ToolSchema } from "../src/core/types.js";
import type { TermCaps } from "../src/render/term.js";

export const REPO = fileURLToPath(new URL("..", import.meta.url));

/** Day-1 spike capture, copied verbatim: the hero run (27/27 PASS). */
export const SANDBOX_FIXTURES = join(REPO, "demo", "fixtures", "sandbox");
/** Same run against the sputnikv2.testnet factory's default DAO code (v3.31). */
export const COMPAT_FIXTURES = join(REPO, "spike", "compat-sputnikv2-3.31", "fixtures");
/** Same run with add_proposal ADDED to method_names: g1 lands and the contract panics (ERR_MIN_BOND). */
export const NEGATIVE_CONTROL_FIXTURES = join(REPO, "spike", "negative-control", "fixtures");

export const readFixture = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

/** The session the spike's FC key would have, had wrap minted it (public values only). */
export function sampleSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ks-7f3a",
    mode: "on-account",
    network: "sandbox",
    accountId: "seat.sandbox",
    receiverId: "dao.sandbox",
    methodNames: ["act_proposal"],
    allowanceYocto: "50000000000000000000000",
    codeHashPin: "ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq",
    publicKey: "ed25519:6Cg1xR924ox82u6nKx1X3iDc2Xj3CVhEE4THQgKsmMr",
    createdAt: "2026-11-06T00:00:00.000Z",
    status: "live",
    packId: "sputnik-v2",
    tools: [
      {
        name: "dao_vote",
        kind: "call",
        method: "act_proposal",
        argsSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        gasTGas: 30,
      },
    ],
    ...overrides,
  };
}

/** One JSON-RPC request as replayFetch saw it. */
export interface ReplayedRequest {
  url: string;
  method: string;
  params: any;
}

/**
 * Replaces globalThis.fetch with replies from recorded RPC bodies; test/setup.ts restores the offline
 * guard before the next test. A request is keyed by its method, or `query:REQUEST_TYPE` for `query`.
 * A string answers every request with that key; an array answers them in order, one element each, and a
 * request past its end fails. A key with no entry fails too. Returns the request log, in order.
 */
export function replayFetch(bodies: Record<string, string | readonly string[]>): ReplayedRequest[] {
  const log: ReplayedRequest[] = [];
  const served = new Map<string, number>();
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = JSON.parse(String(init?.body));
    log.push({ url, method: req.method, params: req.params });
    const key = req.method === "query" ? `query:${req.params?.request_type}` : String(req.method);
    const entry = bodies[key];
    if (entry === undefined) throw new Error(`replay: no fixture for ${key}`);
    let raw: string;
    if (typeof entry === "string") raw = entry;
    else {
      const i = served.get(key) ?? 0;
      if (i >= entry.length) throw new Error(`replay: all ${entry.length} replies for ${key} already served`);
      served.set(key, i + 1);
      raw = entry[i];
    }
    return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
  };
  return log;
}

/** The env tmpEnv() returns: pass it as `env`, or vi.stubEnv each value for code that reads process.env. */
export type TmpEnv = { KEYHOLE_HOME: string; KEYHOLE_CREDENTIALS_DIR: string };

const tmpRoots: string[] = [];
// Registered on the importing test file's root suite: each file removes the dirs it made.
afterAll(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fresh, empty temp dirs for $KEYHOLE_HOME and $KEYHOLE_CREDENTIALS_DIR. No test touches the real keychain. */
export function tmpEnv(): TmpEnv {
  const root = mkdtempSync(join(tmpdir(), "keyhole-env-"));
  tmpRoots.push(root);
  const env: TmpEnv = { KEYHOLE_HOME: join(root, "keyhole-home"), KEYHOLE_CREDENTIALS_DIR: join(root, "near-credentials") };
  mkdirSync(env.KEYHOLE_HOME, { mode: 0o700 });
  mkdirSync(env.KEYHOLE_CREDENTIALS_DIR, { mode: 0o700 });
  return env;
}

/** Render caps for tests: plain at 100 and 80 columns (piped output), and a 100-column color TTY. */
export const CAPS: Readonly<{ plain100: TermCaps; plain80: TermCaps; color100: TermCaps }> = Object.freeze({
  plain100: Object.freeze({ color: false, unicode: false, width: 100, tty: false }),
  plain80: Object.freeze({ color: false, unicode: false, width: 80, tty: false }),
  color100: Object.freeze({ color: true, unicode: true, width: 100, tty: true }),
});
export const { plain100, plain80, color100 } = CAPS;

/** The committed pack file, read directly: sampleCageCard is synchronous, and this file loads no src/ module. */
const SPUTNIK_PACK = JSON.parse(readFileSync(join(REPO, "src", "packs", "sputnik-v2.pack.json"), "utf8")) as TargetPack;

/**
 * The hero cage card as `inspect` reads it on testnet: 0.0412 of the session's 0.05 NEAR left, nonce 3,
 * code hash unchanged. Tools as classifyTools returns them: the pack's views unclassified, dao_vote
 * callable, and the out-of-scope add_proposal `not in allowlist`. Overrides replace whole fields.
 */
export function sampleCageCard(overrides: Partial<CageCard> = {}): CageCard {
  const session = sampleSession({ network: "testnet", accountId: "seat.kh-op.testnet", receiverId: "kh-1a2b.sputnik-v2.testnet" });
  if (!SPUTNIK_PACK.exposure) throw new Error("src/packs/sputnik-v2.pack.json has no exposure");
  const tools: ToolSchema[] = [
    ...SPUTNIK_PACK.tools.map(({ dryRun: _dryRun, ...tool }): ToolSchema =>
      tool.kind === "call" ? { ...tool, classification: "callable", evidence: "dry-run at wrap: succeeded with 0 deposit" } : tool,
    ),
    {
      name: "add_proposal",
      kind: "call",
      method: "add_proposal",
      argsSchema: {},
      gasTGas: 30,
      classification: "not in allowlist",
      evidence: "absent from the key's method_names (chain); 0-deposit dry-run: Smart contract panicked: panicked at 'ERR_MIN_BOND', src/proposals.rs:392:9",
    },
  ];
  return {
    session,
    key: {
      publicKey: session.publicKey,
      accountId: session.accountId,
      receiverId: session.receiverId,
      methodNames: ["act_proposal"],
      allowanceRemainingYocto: "41200000000000000000000",
      nonce: 3,
    },
    tools,
    codeHashNow: session.codeHashPin,
    source: "chain",
    readAt: "2026-11-11T09:14:07Z",
    exposure: { ...SPUTNIK_PACK.exposure },
    ...overrides,
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58 glue for a test that puts `part`, a slice of a held key's text, inside a longer base58 run (sweep A fix
 * round 2, I2). The redactor replaces every 12-character window of the key's text it finds (keys.ts KEY_WINDOW; a
 * literal here, since this file imports nothing from src/ at run time). A glue character that is the key's own next
 * character extends a window, so it is replaced with the part, and an expectation that keeps the glue fails for 1 key
 * in 58 per glued side. `before` and `after` are the test's own choice when it is safe for this key, else the first
 * base58 character for which no window over the glue (repeated 1 to 12 times) and the part is in `windows`: the
 * replacement then stops exactly at `part`, for every key.
 *
 * `part` must be at least 12 characters (sweep B, N2): a shorter one could be glued on both sides inside one window,
 * which the per-side check below does not see, so it throws instead of answering for a part it cannot vouch for.
 */
export function keyGlue(part: string, windows: Iterable<string>, prefer: { before?: string; after?: string } = {}): { before: string; after: string } {
  if (part.length < 12) throw new Error(`keyGlue: the part must be at least 12 characters (got ${part.length})`);
  const held = new Set(windows);
  const joins = (c: string, side: "before" | "after") => {
    for (let j = 1; j <= 12; j++) {
      const window = side === "before" ? c.repeat(j) + part.slice(0, 12 - j) : part.slice(part.length - (12 - j)) + c.repeat(j);
      if (held.has(window)) return true;
    }
    return false;
  };
  const pick = (side: "before" | "after") => {
    for (const c of (prefer[side] ?? "") + BASE58) if (!joins(c, side)) return c;
    throw new Error("no base58 character keeps this part apart");
  };
  return { before: pick("before"), after: pick("after") };
}
