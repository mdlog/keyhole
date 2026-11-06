/**
 * Suite "key hygiene" (LAYOUT R7; PRD §6): the repo holds 0 private keys, a process holds only the
 * session key it was given, and npm test opens no socket. Private keys here are generated in memory
 * and never written outside a tmpEnv() dir or printed: every sessionKeyPair call gets a tmpEnv()
 * keychain, so no test reads the real ~/.near-credentials (R9a).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KeyPair, baseDecode, baseEncode } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanRepo } from "../scripts/scan-secrets.js";
import { buildMcpServer } from "../src/cli/serve.js";
import { deleteSessionKey, fullAccessKeyLoadCount, loadFullAccessKey, readSessionKey, saveAccountKey, saveSessionKey } from "../src/core/credentials.js";
import { EnvironmentError, KeyholeError } from "../src/core/errors.js";
import { KEY_NOT_SHOWN, KEY_WINDOW, SESSION_KEY_ENV, TEXT_WITHHELD, dropHeldKeys, heldPrivateKeyCount, holdSessionKey, keyTextRedactor, privateKeyTexts, redactHeldKeys, sessionKeyPair } from "../src/core/keys.js";
import { keyGlue, sampleCageCard, sampleSession, tmpEnv } from "./helpers.js";
import { replayLine } from "./replay-meta.js";

afterEach(() => {
  dropHeldKeys();
  vi.unstubAllEnvs();
});

/** Every 8-character window of a private key's encodings (extended key, bare seed) and of any extra secret. */
function secretWindows(kp: KeyPair, ...more: string[]): string[] {
  const extended = kp.toString().slice(kp.toString().indexOf(":") + 1);
  const out: string[] = [];
  for (const s of [extended, baseEncode(baseDecode(extended).slice(0, 32)), ...more]) for (let i = 0; i + 8 <= s.length; i++) out.push(s.slice(i, i + 8));
  return out;
}

/** True if anything a caught error could print (message, line(), stack, inspect with fields and cause) holds a window. */
function leaks(err: unknown, windows: readonly string[]): boolean {
  const texts = [String(err), inspect(err, { depth: 5 })];
  if (err instanceof Error) texts.push(err.message, String(err.stack));
  if (err instanceof KeyholeError) texts.push(err.line());
  return texts.some((t) => windows.some((w) => t.includes(w)));
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("key hygiene", () => {
  it("secret scan: 0 keys in repo", ({ task }) => {
    const r = scanRepo();
    expect(r.hits).toEqual([]);
    // Not vacuous: the scanner decoded the fixtures' signatures and public keys.
    expect(r.values64).toBeGreaterThanOrEqual(20);
    expect(r.values32).toBeGreaterThanOrEqual(20);
    replayLine(task, "key hygiene", "secret scan: 0 keys in repo");
  });

  it("serve opens exactly one private key", async ({ task }) => {
    // A tmp keychain holds the session key; serve reads process.env, as `keyhole serve ID` does (R9b).
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
    vi.stubEnv("KEYHOLE_CREDENTIALS_DIR", env.KEYHOLE_CREDENTIALS_DIR);
    vi.stubEnv(SESSION_KEY_ENV, "");
    const kp = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: kp.getPublicKey().toString(), tools: sampleCageCard().tools });
    saveSessionKey(session, kp, env);
    dropHeldKeys();
    const fa = fullAccessKeyLoadCount();
    const server = await buildMcpServer(session);
    expect(heldPrivateKeyCount()).toBe(1);
    expect(fullAccessKeyLoadCount()).toBe(fa);
    expect(sessionKeyPair(session, tmpEnv()).getPublicKey().toString()).toBe(session.publicKey); // the one held is the session's
    // What the client is told about the server carries no key material.
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const listed = JSON.stringify([client.getServerVersion(), client.getInstructions() ?? null, await client.listTools()]);
    await client.close();
    expect(secretWindows(kp).some((w) => listed.includes(w))).toBe(false);
    expect(heldPrivateKeyCount()).toBe(1);
    replayLine(task, "key hygiene", "serve opens exactly 1 private key");
  });

  it("sessionKeyPair holds exactly the one key from KEYHOLE_SESSION_KEY", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: kp.getPublicKey().toString() });
    expect(heldPrivateKeyCount()).toBe(0);
    const loaded = sessionKeyPair(session, { ...tmpEnv(), [SESSION_KEY_ENV]: kp.toString() });
    expect(loaded.getPublicKey().toString()).toBe(session.publicKey);
    sessionKeyPair(session, tmpEnv());
    expect(heldPrivateKeyCount()).toBe(1);
  });

  it("refuses a key whose public half is not the session's, without echoing it", () => {
    const other = KeyPair.fromRandom("ed25519");
    const err = caught(() => sessionKeyPair(sampleSession(), { ...tmpEnv(), [SESSION_KEY_ENV]: other.toString() }));
    expect(err instanceof EnvironmentError).toBe(true);
    expect(leaks(err, secretWindows(other))).toBe(false);
    expect(heldPrivateKeyCount()).toBe(0);
    expect(() => holdSessionKey(sampleSession(), other)).toThrow(EnvironmentError);
  });

  it("a malformed KEYHOLE_SESSION_KEY is reported without its value", () => {
    const bogus = "ed25519:thisIsNotAKeyButShouldNeverBeEchoedAnyway";
    expect(() => sessionKeyPair(sampleSession(), { ...tmpEnv(), [SESSION_KEY_ENV]: bogus })).toThrow(/value not shown/);
    try {
      sessionKeyPair(sampleSession(), { ...tmpEnv(), [SESSION_KEY_ENV]: bogus });
    } catch (e) {
      expect((e as Error).message).not.toContain("thisIsNotAKey");
    }
  });

  it("no key at all is an environment error naming the variable", () => {
    expect(() => sessionKeyPair(sampleSession(), tmpEnv())).toThrow(SESSION_KEY_ENV);
  });

  it("sessionKeyPair falls back to the keychain file and holds exactly one key", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: kp.getPublicKey().toString() });
    saveSessionKey(session, kp, env);
    const fullAccessLoads = fullAccessKeyLoadCount();
    expect(heldPrivateKeyCount()).toBe(0);
    expect(sessionKeyPair(session, env).getPublicKey().toString()).toBe(session.publicKey);
    expect(heldPrivateKeyCount()).toBe(1);
    // Held comes first: with the file gone, the held key still answers, and no second key is held.
    expect(deleteSessionKey(session, env)).toBe(true);
    expect(sessionKeyPair(session, env).getPublicKey().toString()).toBe(session.publicKey);
    expect(heldPrivateKeyCount()).toBe(1);
    expect(fullAccessKeyLoadCount()).toBe(fullAccessLoads);
  });

  it("credential errors never contain private key material", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519");
    const pub = kp.getPublicKey().toString();
    const body = kp.toString().slice("ed25519:".length);
    const phrase = Array.from({ length: 12 }, (_, i) => `seed${i}`).join(" ");
    const windows = [...secretWindows(kp, phrase), ...secretWindows(other)];
    const session = sampleSession({ network: "testnet", accountId: "seat.op.testnet", publicKey: pub });
    const sessionFile = join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "seat.op.testnet", `${pub.replace(":", "_")}.json`);
    const fullAccessFile = join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "op.testnet.json");
    const put = (file: string, content: string) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, content, { mode: 0o600 });
    };
    // Bad key files, each holding key material somewhere an error message could pick it up.
    const files: Array<[string, string]> = [
      ["a bare key, not JSON", body],
      // V8's JSON.parse error quotes about 10 characters from an unexpected token: starting the unquoted
      // value at the key's first letter puts key text right there.
      ["an unquoted key", `{"private_key": ${body.slice(body.search(/[A-Za-z]/))}}`],
      ["truncated JSON", `{"private_key": "${kp.toString()}"`],
      ["a JSON string", JSON.stringify(kp.toString())],
      ["a JSON array", JSON.stringify([kp.toString()])],
      ["another account", JSON.stringify({ account_id: "other.testnet", public_key: pub, private_key: kp.toString(), master_seed_phrase: phrase })],
      ["the key in account_id", JSON.stringify({ account_id: kp.toString(), public_key: pub, private_key: kp.toString() })],
      ["the key in public_key", JSON.stringify({ public_key: kp.toString(), private_key: kp.toString() })],
      ["a mislabelled key", JSON.stringify({ public_key: other.getPublicKey().toString(), private_key: kp.toString(), master_seed_phrase: phrase })],
      ["two different keys", JSON.stringify({ private_key: kp.toString(), secret_key: other.toString() })],
      ["a damaged key", JSON.stringify({ private_key: `ed25519:${body.slice(0, -4)}0OIl` })],
      ["a key without its curve", JSON.stringify({ private_key: body })],
    ];
    const errors: Array<[string, unknown]> = [];
    for (const [label, content] of files) {
      put(fullAccessFile, content);
      put(sessionFile, content);
      errors.push([`loadFullAccessKey: ${label}`, caught(() => loadFullAccessKey("testnet", "op.testnet", env))]);
      errors.push([`readSessionKey: ${label}`, caught(() => readSessionKey(session, env))]);
      dropHeldKeys();
      errors.push([`sessionKeyPair (keychain): ${label}`, caught(() => sessionKeyPair(session, env))]);
    }
    // KEYHOLE_SESSION_KEY values, and the write side.
    for (const [label, value] of [["damaged", `ed25519:${body.slice(0, -4)}0OIl`], ["no curve", body], ["another key", other.toString()]]) {
      dropHeldKeys();
      errors.push([`sessionKeyPair (${SESSION_KEY_ENV}): ${label}`, caught(() => sessionKeyPair(session, { ...env, [SESSION_KEY_ENV]: value }))]);
    }
    const fresh = tmpEnv();
    errors.push(["saveSessionKey: another key pair", caught(() => saveSessionKey(session, other, fresh))]);
    saveSessionKey(session, kp, fresh);
    errors.push(["saveSessionKey: the file exists", caught(() => saveSessionKey(session, kp, fresh))]);
    saveAccountKey("testnet", "op.testnet", kp, fresh);
    errors.push(["saveAccountKey: the file exists", caught(() => saveAccountKey("testnet", "op.testnet", kp, fresh))]);

    expect(errors).toHaveLength(files.length * 3 + 3 + 3);
    // Labels only: the error text itself is never handed to expect().
    expect(errors.filter(([, e]) => !(e instanceof KeyholeError)).map(([label]) => label)).toEqual([]);
    expect(errors.filter(([, e]) => leaks(e, windows)).map(([label]) => label)).toEqual([]);
    expect(errors.filter(([, e]) => (e as Error | undefined)?.cause !== undefined).map(([label]) => label)).toEqual([]);
    expect(heldPrivateKeyCount()).toBe(0);
  });

  it("network guard: fetch is offline during npm test", async () => {
    await expect(fetch("https://rpc.testnet.near.org")).rejects.toThrow(/offline/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Final sweep C-T19h: the one redactor core and serve run before they cut a text they print. Key text is compared
// with booleans only, as everywhere in this file: a failing assertion must not print it.

describe("C-T19h: a held key's text is replaced, whole or in part, before anything is cut", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const [extended, seed] = privateKeyTexts(kp);
  const redact = keyTextRedactor(privateKeyTexts(kp));
  const windowsOf = (t: string) => Array.from({ length: t.length - 11 }, (_, i) => t.slice(i, i + 12));
  const survives = (t: string) => [...windowsOf(extended), ...windowsOf(seed)].some((w) => t.includes(w));
  const gives = (input: string, output: string) => redact(input) === output;

  it("privateKeyTexts: the extended key (64 bytes) and its 32-byte seed, base58", () => {
    expect(`ed25519:${extended}` === kp.toString()).toBe(true);
    expect(baseDecode(extended).length).toBe(64);
    expect(baseEncode(baseDecode(extended).slice(0, 32)) === seed).toBe(true);
  });

  it("the whole key, either form, becomes one marker; a 12-character part of it too; an 11-character part is kept", () => {
    expect(KEY_WINDOW).toBe(12);
    expect(gives(`key ${kp.toString()} end`, `key ed25519:${KEY_NOT_SHOWN} end`)).toBe(true);
    expect(gives(`seed=${seed}.`, `seed=${KEY_NOT_SHOWN}.`)).toBe(true);
    expect(gives(`cut ${extended.slice(5, 17)}`, `cut ${KEY_NOT_SHOWN}`)).toBe(true);
    expect(gives(`cut ${seed.slice(-12)}`, `cut ${KEY_NOT_SHOWN}`)).toBe(true);
    const eleven = seed.slice(0, 11);
    expect(gives(`short ${eleven}`, `short ${eleven}`)).toBe(true);
  });

  /**
   * seed[3..20) between base58 glue: "x" and "y", or another letter where this key's own next character is "x" or "y"
   * (helpers keyGlue; sweep A fix round 2, I2). The redactor rightly replaces a glue letter that continues the key, so
   * a fixed "x…y" failed for 1 key in 29 (seed[2] = "x" or seed[20] = "y").
   */
  function gluedBothSides(k: KeyPair) {
    const [ext, sd] = privateKeyTexts(k);
    const part = sd.slice(3, 20);
    const { before, after } = keyGlue(part, [...windowsOf(ext), ...windowsOf(sd)], { before: "x", after: "y" });
    return { kept: keyTextRedactor(privateKeyTexts(k))(`${before}${part}${after}`) === `${before}${KEY_NOT_SHOWN}${after}`, oldGlueJoins: before !== "x" || after !== "y" };
  }

  it("a part glued to other base58 keeps the other characters; text with no key is returned as it is", () => {
    // "0" and "l" are not base58, so they end the run on either side; base58 glue ("x" and "y") stays.
    expect(gives(`0${extended.slice(20, 40)}l`, `0${KEY_NOT_SHOWN}l`)).toBe(true);
    expect(gluedBothSides(kp).kept).toBe(true);
    const other = "1111111111111111111111111111111111111111";
    expect(redact(other)).toBe(other);
    expect(redact("")).toBe("");
  });

  it("keyGlue refuses a part shorter than a window; 12 characters are enough (sweep B, N2)", () => {
    const [ext, sd] = privateKeyTexts(kp);
    const windows = [...windowsOf(ext), ...windowsOf(sd)];
    for (const short of ["", "a", sd.slice(0, 11)]) expect(() => keyGlue(short, windows)).toThrow(/at least 12 characters/);
    expect(() => keyGlue(sd.slice(0, 12), windows)).not.toThrow();
  });

  it("base58 glue stays for 200 random keys and on until 2 keys whose seed[2] is \"x\" or seed[20] is \"y\" (fix round 2, I2)", () => {
    const failing: number[] = [];
    let keys = 0;
    let oldGlueJoins = 0;
    for (; keys < 20_000 && (keys < 200 || oldGlueJoins < 2); keys++) {
      const glued = gluedBothSides(KeyPair.fromRandom("ed25519"));
      if (glued.oldGlueJoins) oldGlueJoins++;
      if (!glued.kept) failing.push(keys); // key indexes only: never a key's text
    }
    expect(failing).toEqual([]);
    expect(keys).toBeGreaterThanOrEqual(200);
    expect(oldGlueJoins).toBeGreaterThanOrEqual(2);
  });

  it("a JSON text stays JSON: the key inside its strings is replaced, nothing else changes", () => {
    const out = redact(JSON.stringify({ result: { logs: [`leaked ${seed}`], note: extended.slice(10, 30), ok: true } }));
    expect(survives(out)).toBe(false);
    expect(out === JSON.stringify({ result: { logs: [`leaked ${KEY_NOT_SHOWN}`], note: KEY_NOT_SHOWN, ok: true } })).toBe(true);
  });

  it("redactHeldKeys: only keys this process holds; none held, the text comes back unchanged", () => {
    const text = `x ${seed} y`;
    expect(redactHeldKeys(text) === text).toBe(true);
    holdSessionKey(sampleSession({ publicKey: kp.getPublicKey().toString() }), kp);
    expect(redactHeldKeys(text) === `x ${KEY_NOT_SHOWN} y`).toBe(true);
    expect(survives(redactHeldKeys(`${kp.toString()} ${seed.slice(7, 30)}`))).toBe(false);
    dropHeldKeys();
    expect(redactHeldKeys(text) === text).toBe(true);
  });
});

// Sweep A fix round 1 (I1): the redactor is linear and stack-safe up to the RPC body cap, and never throws.
describe("fix round 1 (I1): the redactor on a run as long as the body cap, and when it fails", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const redact = keyTextRedactor(privateKeyTexts(kp));

  it("a base58 run of 32 MiB (the RPC body cap) with the seed at its end: no stack overflow, only the seed replaced", () => {
    const [extended, seed] = privateKeyTexts(kp);
    const windowsOf = (t: string) => Array.from({ length: t.length - 11 }, (_, i) => t.slice(i, i + 12));
    const a = keyGlue(seed, [...windowsOf(extended), ...windowsOf(seed)], { before: "A" }).before; // "A" unless the key continues into it (fix round 2, I2)
    const filler = a.repeat(32 * 1024 * 1024 - seed.length);
    const out = redact(`${filler}${seed}`);
    expect(out.length).toBe(filler.length + KEY_NOT_SHOWN.length);
    expect(out.endsWith(`${a.repeat(4)}${KEY_NOT_SHOWN}`)).toBe(true);
  }, 30_000);

  it("redactHeldKeys: a held key whose text cannot be read withholds the whole text, never returns it unchecked (fix round 2, m1)", () => {
    const real = KeyPair.fromRandom("ed25519");
    const unreadable = {
      getPublicKey: () => real.getPublicKey(),
      toString: () => {
        throw new Error("forced: no key text");
      },
    } as unknown as KeyPair;
    holdSessionKey(sampleSession({ publicKey: real.getPublicKey().toString() }), unreadable);
    expect(redactHeldKeys("any text at all")).toBe(TEXT_WITHHELD);
  });

  it("never throws: a failure inside it withholds the whole text (TEXT_WITHHELD)", () => {
    expect(redact(undefined as unknown as string)).toBe(TEXT_WITHHELD);
    expect(redact({ replace: () => { throw new RangeError("forced"); } } as unknown as string)).toBe(TEXT_WITHHELD);
    holdSessionKey(sampleSession({ publicKey: kp.getPublicKey().toString() }), kp);
    expect(redactHeldKeys(undefined as unknown as string)).toBe(TEXT_WITHHELD);
  });
});
