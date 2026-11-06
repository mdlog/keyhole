/**
 * Task 3: near-cli-rs's legacy keychain (src/core/credentials.ts), and the order in which sessionKeyPair
 * (src/core/keys.ts) finds a session key: held → KEYHOLE_SESSION_KEY → keychain file → EnvironmentError.
 *
 * Every test runs against tmpEnv() dirs, never the real ~/.near-credentials, with keys made in memory by
 * KeyPair.fromRandom("ed25519"). Assertions handle public keys and booleans only. An error's text reaches
 * expect() only through shown(), which withholds it if it holds key material, so a failing test never
 * prints a private key.
 */
import { execFileSync } from "node:child_process";
import { type Stats, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import { KeyPair, baseDecode, baseEncode } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import {
  type KeyRef,
  credentialsDir,
  deleteSessionKey,
  fullAccessKeyLoadCount,
  loadFullAccessKey,
  readSessionKey,
  saveAccountKey,
  saveSessionKey,
} from "../src/core/credentials.js";
import { EnvironmentError, InputError, KeyholeError } from "../src/core/errors.js";
import { SESSION_KEY_ENV, dropHeldKeys, heldPrivateKeyCount, holdSessionKey, sessionKeyPair } from "../src/core/keys.js";
import type { Network } from "../src/core/types.js";
import { type TmpEnv, sampleSession, tmpEnv } from "./helpers.js";

afterEach(() => dropHeldKeys());

/** The fix the missing-key error offers (Task 3 Step 3, verbatim). */
const MISSING_TRY = "near account import-account … save-to-legacy-keychain (near-cli-rs), or set KEYHOLE_CREDENTIALS_DIR";

const pubOf = (kp: KeyPair): string => kp.getPublicKey().toString();
const refFor = (kp: KeyPair, accountId = "seat.op.testnet", network: Network = "testnet"): KeyRef => ({ network, accountId, publicKey: pubOf(kp) });
/** NETWORK/ACCOUNT/ed25519_PUBKEY.json under the tmp keychain. */
const keyFile = (env: TmpEnv, ref: KeyRef): string =>
  join(env.KEYHOLE_CREDENTIALS_DIR, ref.network, ref.accountId, `${ref.publicKey.replace(":", "_")}.json`);

/** Writes a file into the tmp keychain the way another tool would (test setup only). */
function plant(env: TmpEnv, rel: string, body: unknown): string {
  const p = join(env.KEYHOLE_CREDENTIALS_DIR, rel);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  return p;
}

/** A stand-in for a 12-word seed phrase: secret in a real file, so it must never be echoed either. */
const PHRASE = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");

/** What near-cli-rs 0.30.1 `save-to-legacy-keychain` writes (its KeyPairProperties): no account_id, plus seed-phrase fields. */
const nearCliRsBody = (kp: KeyPair) => ({
  seed_phrase_hd_path: "m/44'/397'/0'",
  master_seed_phrase: PHRASE,
  implicit_account_id: Buffer.from(kp.getPublicKey().data).toString("hex"),
  public_key: pubOf(kp),
  private_key: kp.toString(),
});

/**
 * Every 8-character window of a key's secret encodings (the extended key and the bare seed), plus any
 * extra secrets. V8 quotes about 10 characters of input in a JSON.parse error, so a window this short
 * catches a partial leak too.
 */
function secretWindows(kp: KeyPair, ...more: string[]): string[] {
  const extended = kp.toString().slice(kp.toString().indexOf(":") + 1);
  const seed = baseEncode(baseDecode(extended).slice(0, 32));
  const out: string[] = [];
  for (const s of [extended, seed, ...more]) for (let i = 0; i + 8 <= s.length; i++) out.push(s.slice(i, i + 8));
  return out;
}

/** Everything a caught error could print: name and message, line(), and inspect() (stack, own fields, cause). */
function errorTexts(err: unknown): string[] {
  const texts = [String(err), inspect(err, { depth: 5 })];
  if (err instanceof Error) texts.push(err.message, String(err.stack));
  if (err instanceof KeyholeError) texts.push(err.line());
  return texts;
}

const leaks = (err: unknown, windows: readonly string[]): boolean => errorTexts(err).some((t) => windows.some((w) => t.includes(w)));

/** The error as `Name: message`, or a placeholder if it holds key material: safe to hand to expect(). */
const shown = (err: unknown, windows: readonly string[] = []): string =>
  leaks(err, windows) ? "<withheld: holds private key material>" : err instanceof Error ? `${err.name}: ${err.message}` : `not an Error: ${typeof err}`;

/** The fix an EnvironmentError offers: constant text from src, never key material. */
const tryOf = (err: unknown): string => (err instanceof EnvironmentError ? err.tryThis : "not an EnvironmentError");

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("credentialsDir", () => {
  it("is $KEYHOLE_CREDENTIALS_DIR, resolved; else ~/.near-credentials (a path only: nothing is read)", () => {
    const env = tmpEnv();
    expect(credentialsDir(env)).toBe(env.KEYHOLE_CREDENTIALS_DIR);
    expect(credentialsDir({ KEYHOLE_CREDENTIALS_DIR: "rel/creds" })).toBe(resolve("rel/creds"));
    expect(credentialsDir({})).toBe(join(homedir(), ".near-credentials"));
    expect(credentialsDir({ KEYHOLE_CREDENTIALS_DIR: "" })).toBe(join(homedir(), ".near-credentials"));
  });

  it("under npm test, ~ is test/home-guard.ts's throwaway HOME, so even an empty env cannot reach the real keychain", () => {
    const home = process.env.HOME ?? "";
    expect(basename(home).startsWith("keyhole-test-home-")).toBe(true);
    expect(dirname(home)).toBe(tmpdir());
    expect(homedir()).toBe(home);
    expect(credentialsDir({})).toBe(join(home, ".near-credentials"));
    expect(credentialsDir()).toBe(join(home, ".near-credentials"));
  });
});

describe("session key files: NETWORK/ACCOUNT/ed25519_PUBKEY.json", () => {
  it("saveSessionKey writes the per-key file 0600 in 0700 dirs and never overwrites; read and delete round-trip", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const pub = pubOf(kp);
    const ref: KeyRef = { network: "testnet", accountId: "seat.op.testnet", publicKey: pub };
    expect(readSessionKey(ref, env) === null).toBe(true); // no network dir yet
    expect(deleteSessionKey(ref, env)).toBe(false);

    const p = saveSessionKey(ref, kp, env);
    expect(p).toBe(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "seat.op.testnet", `${pub.replace(":", "_")}.json`));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(p))).mode & 0o777).toBe(0o700);
    const file = JSON.parse(readFileSync(p, "utf8"));
    expect(Object.keys(file).sort()).toEqual(["account_id", "private_key", "public_key"]);
    expect([file.account_id, file.public_key]).toEqual(["seat.op.testnet", pub]);
    expect(file.private_key === kp.toString()).toBe(true); // a boolean: a failure never prints the key

    const bytes = readFileSync(p);
    expect(caught(() => saveSessionKey(ref, kp, env)) instanceof EnvironmentError).toBe(true); // never overwrites
    expect(readFileSync(p).equals(bytes)).toBe(true);

    expect(readSessionKey(ref, env)?.getPublicKey().toString()).toBe(pub);
    expect(deleteSessionKey(ref, env)).toBe(true);
    expect(deleteSessionKey(ref, env)).toBe(false);
    expect(readSessionKey(ref, env) === null).toBe(true);
    expect(existsSync(dirname(p))).toBe(true); // the account dir stays: near-cli-rs keeps the account's other keys there
  });

  it("first run: a keychain dir that does not exist yet is created 0700", () => {
    const env = { ...tmpEnv() };
    env.KEYHOLE_CREDENTIALS_DIR = join(env.KEYHOLE_HOME, "absent", "near-credentials");
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    expect(readSessionKey(ref, env) === null).toBe(true);
    expect(deleteSessionKey(ref, env)).toBe(false);
    expect(existsSync(env.KEYHOLE_CREDENTIALS_DIR)).toBe(false); // reads create nothing
    saveSessionKey(ref, kp, env);
    expect(statSync(env.KEYHOLE_CREDENTIALS_DIR).mode & 0o777).toBe(0o700);
    expect(readSessionKey(ref, env)?.getPublicKey().toString()).toBe(ref.publicKey);
  });

  it("a write that fails part-way leaves no key file behind, so a retry is not blocked", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    // Fault injection: writes to an open fd store 20 bytes, then fail as a full disk would. The patched
    // CommonJS export reaches credentials.ts's `node:fs` import through syncBuiltinESMExports.
    const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const real = fs.writeFileSync;
    fs.writeFileSync = ((file: unknown, data: unknown, ...rest: unknown[]) => {
      if (typeof file !== "number") return (real as (...args: unknown[]) => void)(file, data, ...rest);
      real(file, String(data).slice(0, 20));
      throw Object.assign(new Error("injected: no space left on device"), { code: "ENOSPC" });
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    let err: unknown;
    try {
      err = caught(() => saveSessionKey(ref, kp, env));
    } finally {
      fs.writeFileSync = real;
      syncBuiltinESMExports();
    }
    expect(shown(err, secretWindows(kp))).toMatch(/^EnvironmentError: cannot write .*\(ENOSPC\)/);
    expect(existsSync(keyFile(env, ref))).toBe(false);
    expect(saveSessionKey(ref, kp, env)).toBe(keyFile(env, ref));
    expect(readSessionKey(ref, env)?.getPublicKey().toString()).toBe(ref.publicKey);
  });

  it("the key file is fsynced after its write and before its close, so a crash cannot leave it empty", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    // Spies on the CommonJS exports, which reach credentials.ts's `node:fs` import through
    // syncBuiltinESMExports. Only calls on the key file's own fd are recorded.
    const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
    const calls: string[] = [];
    let keyFd = -1;
    fs.openSync = ((path: unknown, ...rest: unknown[]) => {
      const fd = (real.openSync as (...args: unknown[]) => number)(path, ...rest);
      if (path === keyFile(env, ref)) keyFd = fd;
      return fd;
    }) as typeof fs.openSync;
    fs.writeFileSync = ((file: unknown, ...rest: unknown[]) => {
      if (file === keyFd) calls.push("write");
      return (real.writeFileSync as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync;
    fs.fsyncSync = ((fd: number) => {
      if (fd === keyFd) calls.push("fsync");
      return real.fsyncSync(fd);
    }) as typeof fs.fsyncSync;
    fs.closeSync = ((fd: number) => {
      if (fd === keyFd) calls.push("close");
      return real.closeSync(fd);
    }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    try {
      saveSessionKey(ref, kp, env);
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    expect(keyFd).toBeGreaterThanOrEqual(0);
    expect(calls).toEqual(["write", "fsync", "close"]);
  });

  it("saveSessionKey refuses a key pair that is not ref.publicKey's, before creating anything", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519");
    const err = caught(() => saveSessionKey(refFor(kp), other, env));
    expect(err instanceof EnvironmentError).toBe(true);
    expect(shown(err, secretWindows(other))).toContain(pubOf(other));
    expect(leaks(err, secretWindows(other))).toBe(false);
    expect(readdirSync(env.KEYHOLE_CREDENTIALS_DIR)).toEqual([]);
  });

  it("readSessionKey accepts near-cli-rs's body (no account_id, seed-phrase fields) and secret_key as an alias", () => {
    const env = tmpEnv();
    const a = KeyPair.fromRandom("ed25519");
    plant(env, `testnet/seat.op.testnet/${pubOf(a).replace(":", "_")}.json`, nearCliRsBody(a));
    expect(readSessionKey(refFor(a), env)?.getPublicKey().toString()).toBe(pubOf(a));
    const b = KeyPair.fromRandom("ed25519");
    plant(env, `testnet/seat.op.testnet/${pubOf(b).replace(":", "_")}.json`, { account_id: "seat.op.testnet", public_key: pubOf(b), secret_key: b.toString() });
    expect(readSessionKey(refFor(b), env)?.getPublicKey().toString()).toBe(pubOf(b));
  });

  it("readSessionKey refuses a file that holds another key or names another account, without echoing it", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    const windows = secretWindows(other);
    // The other key under this key's name, labelled honestly: the private key is not ref.publicKey's.
    const p = plant(env, keyFile(env, ref).slice(env.KEYHOLE_CREDENTIALS_DIR.length + 1), { account_id: ref.accountId, public_key: pubOf(other), private_key: other.toString() });
    let err = caught(() => readSessionKey(ref, env));
    expect(shown(err, windows)).toMatch(/^EnvironmentError: /);
    expect(shown(err, windows)).toContain(pubOf(other));
    expect(leaks(err, windows)).toBe(false);
    // Labelled with this key's public key: the label and the private key disagree.
    writeFileSync(p, JSON.stringify({ account_id: ref.accountId, public_key: ref.publicKey, private_key: other.toString() }));
    err = caught(() => readSessionKey(ref, env));
    expect(shown(err, windows)).toMatch(/^EnvironmentError: .*public_key/);
    expect(leaks(err, windows)).toBe(false);
    // The right key, for another account.
    writeFileSync(p, JSON.stringify({ account_id: "other.op.testnet", public_key: ref.publicKey, private_key: kp.toString() }));
    err = caught(() => readSessionKey(ref, env));
    expect(shown(err, secretWindows(kp))).toMatch(/^EnvironmentError: .*other\.op\.testnet/);
    expect(leaks(err, secretWindows(kp))).toBe(false);
  });
});

describe("full-access keys: NETWORK/ACCOUNT.json", () => {
  it("saveAccountKey writes NETWORK/ACCOUNT.json 0600 and never overwrites; loadFullAccessKey reads it and counts the load", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const p = saveAccountKey("testnet", "op.testnet", kp, env);
    expect(p).toBe(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "op.testnet.json"));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
    const file = JSON.parse(readFileSync(p, "utf8"));
    expect(Object.keys(file).sort()).toEqual(["account_id", "private_key", "public_key"]);
    expect([file.account_id, file.public_key]).toEqual(["op.testnet", pubOf(kp)]);
    expect(file.private_key === kp.toString()).toBe(true);

    const bytes = readFileSync(p);
    expect(caught(() => saveAccountKey("testnet", "op.testnet", KeyPair.fromRandom("ed25519"), env)) instanceof EnvironmentError).toBe(true);
    expect(readFileSync(p).equals(bytes)).toBe(true);

    const n = fullAccessKeyLoadCount();
    expect(pubOf(loadFullAccessKey("testnet", "op.testnet", env))).toBe(pubOf(kp));
    expect(fullAccessKeyLoadCount()).toBe(n + 1);
  });

  it("a missing key names the account, the network dir and the near-cli-rs fix", () => {
    const env = tmpEnv();
    expect(() => loadFullAccessKey("testnet", "missing.testnet", env)).toThrow(/missing\.testnet.*save-to-legacy-keychain/s);
    const err = caught(() => loadFullAccessKey("testnet", "missing.testnet", env));
    expect(err instanceof EnvironmentError).toBe(true);
    expect((err as EnvironmentError).what).toBe(`no full-access key for missing.testnet in ${join(env.KEYHOLE_CREDENTIALS_DIR, "testnet")}`);
    expect((err as EnvironmentError).tryThis).toBe(MISSING_TRY);
    // The sandbox root account is a bare "sandbox": a valid id, so this is the missing-key error, not an input error.
    expect(shown(caught(() => loadFullAccessKey("sandbox", "sandbox", env)))).toMatch(/^EnvironmentError: no full-access key for sandbox in /);
  });

  it("reads only NETWORK/ACCOUNT.json: a per-key file of the same account is not a full-access key", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    saveSessionKey(refFor(kp, "op.testnet"), kp, env);
    expect(shown(caught(() => loadFullAccessKey("testnet", "op.testnet", env)), secretWindows(kp))).toMatch(/^EnvironmentError: no full-access key for op\.testnet/);
  });

  it("accepts near-cli-rs's save-to-legacy-keychain body (no account_id) and secret_key as an alias", () => {
    const env = tmpEnv();
    const a = KeyPair.fromRandom("ed25519");
    plant(env, "testnet/op.testnet.json", nearCliRsBody(a));
    expect(pubOf(loadFullAccessKey("testnet", "op.testnet", env))).toBe(pubOf(a));
    const b = KeyPair.fromRandom("ed25519");
    plant(env, "testnet/alias.testnet.json", { account_id: "alias.testnet", public_key: pubOf(b), secret_key: b.toString() });
    expect(pubOf(loadFullAccessKey("testnet", "alias.testnet", env))).toBe(pubOf(b));
    const c = KeyPair.fromRandom("ed25519");
    plant(env, "testnet/both.testnet.json", { account_id: "both.testnet", public_key: pubOf(c), private_key: c.toString(), secret_key: c.toString() });
    expect(pubOf(loadFullAccessKey("testnet", "both.testnet", env))).toBe(pubOf(c));
  });

  it("a file whose account_id differs is refused without echoing its key", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    plant(env, "testnet/op.testnet.json", { account_id: "other.testnet", public_key: pubOf(kp), private_key: kp.toString() });
    const err = caught(() => loadFullAccessKey("testnet", "op.testnet", env));
    expect(err instanceof EnvironmentError).toBe(true);
    expect(shown(err, secretWindows(kp))).toMatch(/other\.testnet.*op\.testnet/);
    expect(leaks(err, secretWindows(kp))).toBe(false);
  });

  it("refuses a public_key that is not its private key's, two different private keys, and a value that is not a key", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519");
    const windows = secretWindows(kp).concat(secretWindows(other));
    const cases: Array<[string, unknown, RegExp]> = [
      ["mislabelled", { public_key: pubOf(other), private_key: kp.toString() }, /public_key/],
      ["two keys", { public_key: pubOf(kp), private_key: kp.toString(), secret_key: other.toString() }, /private_key and secret_key/],
      ["no key", { account_id: "op.testnet", public_key: pubOf(kp) }, /no private_key/],
      ["not a key", { private_key: `ed25519:${kp.toString().slice(8, 40)}0OIl` }, /not a NEAR private key/],
      ["a number", { private_key: 7 }, /private_key/],
    ];
    for (const [label, body, re] of cases) {
      plant(env, "testnet/op.testnet.json", body);
      const err = caught(() => loadFullAccessKey("testnet", "op.testnet", env));
      expect(err instanceof EnvironmentError, label).toBe(true);
      expect(shown(err, windows), label).toMatch(re);
      expect(leaks(err, windows), label).toBe(false);
    }
  });

  it("counts every request for a full-access key, refused ones too (it can over-report, never under-report); session-key calls never count", () => {
    const env = tmpEnv();
    const n = fullAccessKeyLoadCount();
    caught(() => loadFullAccessKey("testnet", "missing.testnet", env));
    caught(() => loadFullAccessKey("testnet", "alice.near", env));
    expect(fullAccessKeyLoadCount()).toBe(n + 2);
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    saveSessionKey(ref, kp, env);
    readSessionKey(ref, env);
    deleteSessionKey(ref, env);
    saveAccountKey("testnet", "x.testnet", kp, env);
    expect(fullAccessKeyLoadCount()).toBe(n + 2);
  });
});

describe("ids become path components only once they are valid", () => {
  const kp = KeyPair.fromRandom("ed25519");

  it.each<[string, string, string]>([
    ["a .. segment", "testnet", "../x.testnet"],
    ["a slash", "testnet", "a/b.testnet"],
    ["upper case", "testnet", "Seat.testnet"],
    ["an empty id", "testnet", ""],
    ["a mainnet id", "testnet", "alice.near"],
    ["another network's suffix", "sandbox", "seat.op.testnet"],
    ["mainnet as the network", "mainnet", "alice.near"],
    ["a network with a slash", "../testnet", "seat.testnet"],
    ["a NUL", "testnet", "seat\u0000.testnet"],
    ["65 characters, one over NEAR's limit", "testnet", `${"a".repeat(57)}.testnet`],
    ["a network name in another case", "Testnet", "seat.testnet"],
  ])("%s (network %j, account %j) is an InputError, and nothing is created", (_label, network, accountId) => {
    const env = tmpEnv();
    const ref = { network, accountId, publicKey: pubOf(kp) } as KeyRef;
    const calls: Array<[string, () => unknown]> = [
      ["saveSessionKey", () => saveSessionKey(ref, kp, env)],
      ["readSessionKey", () => readSessionKey(ref, env)],
      ["deleteSessionKey", () => deleteSessionKey(ref, env)],
      ["saveAccountKey", () => saveAccountKey(ref.network, ref.accountId, kp, env)],
      ["loadFullAccessKey", () => loadFullAccessKey(ref.network, ref.accountId, env)],
    ];
    for (const [name, call] of calls) expect(caught(call) instanceof InputError, name).toBe(true);
    expect(readdirSync(env.KEYHOLE_CREDENTIALS_DIR)).toEqual([]);
  });

  it("64 characters, NEAR's limit, is still a valid id", () => {
    const env = tmpEnv();
    const ref = refFor(kp, `${"a".repeat(56)}.testnet`);
    expect(ref.accountId).toHaveLength(64);
    expect(saveSessionKey(ref, kp, env)).toBe(keyFile(env, ref));
  });

  it.each<[string, string]>([
    ["path characters", "ed25519:../../../../etc/passwd"],
    ["characters outside base58", "ed25519:0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OI"],
    ["no curve prefix", pubOf(kp).slice("ed25519:".length)],
    ["another curve", `secp256k1:${pubOf(kp).slice("ed25519:".length)}`],
    ["too few bytes", `ed25519:${pubOf(kp).slice(8, 30)}`],
  ])("a public key with %s is an InputError for the session-key functions", (_label, publicKey) => {
    const env = tmpEnv();
    const ref: KeyRef = { network: "testnet", accountId: "seat.op.testnet", publicKey };
    for (const call of [() => saveSessionKey(ref, kp, env), () => readSessionKey(ref, env), () => deleteSessionKey(ref, env)]) {
      const err = caught(call);
      expect(err instanceof InputError).toBe(true);
      expect(leaks(err, secretWindows(kp))).toBe(false);
    }
    expect(readdirSync(env.KEYHOLE_CREDENTIALS_DIR)).toEqual([]);
  });
});

describe("no symbolic link below the keychain root is followed; only regular files are read", () => {
  it("a link at the session key path: save refuses to write through it, read and delete refuse; the target is untouched", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    const p = keyFile(env, ref);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const target = join(env.KEYHOLE_HOME, "target.json");
    symlinkSync(target, p); // dangling: a write through it would create the target
    expect(shown(caught(() => saveSessionKey(ref, kp, env)), secretWindows(kp))).toMatch(/^EnvironmentError: /);
    expect(existsSync(target)).toBe(false);
    writeFileSync(target, "{}", { mode: 0o600 });
    expect(shown(caught(() => readSessionKey(ref, env)))).toMatch(/^EnvironmentError: .*symbolic link/);
    expect(shown(caught(() => deleteSessionKey(ref, env)))).toMatch(/^EnvironmentError: .*symbolic link/);
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  it("a link in place of the NETWORK dir: no key is written, read or deleted through it", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    const outside = join(env.KEYHOLE_HOME, "outside");
    mkdirSync(join(outside, ref.accountId), { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, ref.accountId, `${ref.publicKey.replace(":", "_")}.json`), JSON.stringify({ public_key: ref.publicKey, private_key: kp.toString() }), { mode: 0o600 });
    writeFileSync(join(outside, "op.testnet.json"), JSON.stringify({ public_key: ref.publicKey, private_key: kp.toString() }), { mode: 0o600 });
    symlinkSync(outside, join(env.KEYHOLE_CREDENTIALS_DIR, "testnet"));
    const before = readdirSync(outside).sort();
    const fresh = KeyPair.fromRandom("ed25519"); // a new session key for the same account
    const calls: Array<[string, () => unknown]> = [
      ["saveSessionKey", () => saveSessionKey(refFor(fresh), fresh, env)],
      ["saveAccountKey", () => saveAccountKey("testnet", "new.testnet", kp, env)],
      ["readSessionKey", () => readSessionKey(ref, env)],
      ["deleteSessionKey", () => deleteSessionKey(ref, env)],
      ["loadFullAccessKey", () => loadFullAccessKey("testnet", "op.testnet", env)],
    ];
    for (const [name, call] of calls) {
      const err = caught(call);
      expect(shown(err, secretWindows(kp).concat(secretWindows(fresh))), name).toMatch(/^EnvironmentError: .*symbolic link/);
      expect(leaks(err, secretWindows(kp)), name).toBe(false);
    }
    expect(readdirSync(outside).sort()).toEqual(before);
    expect(readdirSync(join(outside, ref.accountId))).toHaveLength(1);
  });

  it("a link in place of the ACCOUNT dir: no session key is written, read or deleted through it", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    const outside = join(env.KEYHOLE_HOME, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, `${ref.publicKey.replace(":", "_")}.json`), JSON.stringify({ public_key: ref.publicKey, private_key: kp.toString() }), { mode: 0o600 });
    mkdirSync(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet"), { mode: 0o700 });
    symlinkSync(outside, join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", ref.accountId));
    const fresh = KeyPair.fromRandom("ed25519"); // a new session key for the same account
    for (const call of [() => saveSessionKey(refFor(fresh), fresh, env), () => readSessionKey(ref, env), () => deleteSessionKey(ref, env)]) {
      const err = caught(call);
      expect(shown(err, secretWindows(kp).concat(secretWindows(fresh)))).toMatch(/^EnvironmentError: .*symbolic link/);
    }
    expect(readdirSync(outside)).toHaveLength(1);
  });

  it("loadFullAccessKey refuses a link or a directory at NETWORK/ACCOUNT.json", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const real = plant(env, "elsewhere/op.testnet.json", { account_id: "op.testnet", public_key: pubOf(kp), private_key: kp.toString() });
    mkdirSync(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet"), { mode: 0o700 });
    symlinkSync(real, join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "op.testnet.json"));
    expect(shown(caught(() => loadFullAccessKey("testnet", "op.testnet", env)), secretWindows(kp))).toMatch(/^EnvironmentError: .*symbolic link/);
    mkdirSync(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "dir.testnet.json"));
    const dirErr = caught(() => loadFullAccessKey("testnet", "dir.testnet", env));
    expect(shown(dirErr)).toMatch(/^EnvironmentError: .*not a regular file/);
    expect(tryOf(dirErr)).toMatch(/must be a regular file/);
    expect(tryOf(dirErr)).not.toMatch(/link/);
  });

  it("a directory at the session key path: read and delete refuse it as not a regular file, and it stays", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    mkdirSync(keyFile(env, ref), { recursive: true, mode: 0o700 });
    for (const [name, call] of [["readSessionKey", () => readSessionKey(ref, env)], ["deleteSessionKey", () => deleteSessionKey(ref, env)]] as const) {
      const err = caught(call);
      expect(shown(err), name).toMatch(/^EnvironmentError: .*not a regular file/);
      expect(tryOf(err), name).toMatch(/must be a regular file/);
      expect(tryOf(err), name).not.toMatch(/link/);
    }
    expect(statSync(keyFile(env, ref)).isDirectory()).toBe(true);
  });

  it("a file in place of the NETWORK or ACCOUNT dir: refused as not a directory, nothing written, read or deleted below it", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const ref = refFor(kp);
    const env = tmpEnv();
    writeFileSync(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet"), "", { mode: 0o600 });
    const atNetwork: Array<[string, () => unknown]> = [
      ["saveSessionKey", () => saveSessionKey(ref, kp, env)],
      ["readSessionKey", () => readSessionKey(ref, env)],
      ["deleteSessionKey", () => deleteSessionKey(ref, env)],
      ["saveAccountKey", () => saveAccountKey("testnet", "op.testnet", kp, env)],
      ["loadFullAccessKey", () => loadFullAccessKey("testnet", "op.testnet", env)],
    ];
    for (const [name, call] of atNetwork) {
      const err = caught(call);
      expect(shown(err, secretWindows(kp)), name).toMatch(/^EnvironmentError: .*\/testnet is not a directory/);
      expect(tryOf(err), name).toMatch(/must be directories/);
      expect(tryOf(err), name).not.toMatch(/link/);
    }
    expect(readFileSync(join(env.KEYHOLE_CREDENTIALS_DIR, "testnet"), "utf8")).toBe("");
    const env2 = tmpEnv();
    mkdirSync(join(env2.KEYHOLE_CREDENTIALS_DIR, "testnet"), { mode: 0o700 });
    writeFileSync(join(env2.KEYHOLE_CREDENTIALS_DIR, "testnet", ref.accountId), "", { mode: 0o600 });
    const atAccount: Array<[string, () => unknown]> = [
      ["saveSessionKey", () => saveSessionKey(ref, kp, env2)],
      ["readSessionKey", () => readSessionKey(ref, env2)],
      ["deleteSessionKey", () => deleteSessionKey(ref, env2)],
    ];
    for (const [name, call] of atAccount) {
      const err = caught(call);
      expect(shown(err, secretWindows(kp)), name).toMatch(/^EnvironmentError: .*\/seat\.op\.testnet is not a directory/);
      expect(tryOf(err), name).toMatch(/must be directories/);
    }
    expect(readFileSync(join(env2.KEYHOLE_CREDENTIALS_DIR, "testnet", ref.accountId), "utf8")).toBe("");
  });

  it("loadFullAccessKey reads only a regular file of key size: an oversized file or a FIFO is refused unread", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    plant(env, "testnet/big.testnet.json", { account_id: "big.testnet", public_key: pubOf(kp), private_key: kp.toString(), padding: "x".repeat(70_000) });
    expect(shown(caught(() => loadFullAccessKey("testnet", "big.testnet", env)), secretWindows(kp))).toMatch(/^EnvironmentError: .*not a key file \(more than 65536 bytes\)/);
    const fifo = join(env.KEYHOLE_CREDENTIALS_DIR, "testnet", "fifo.testnet.json");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    // Opened non-blocking: the open does not wait for a writer, and fstat refuses the FIFO.
    const fifoErr = caught(() => loadFullAccessKey("testnet", "fifo.testnet", env));
    expect(shown(fifoErr)).toMatch(/^EnvironmentError: .*not a regular file/);
    expect(tryOf(fifoErr)).toMatch(/must be a regular file/);
  });

  it("a key file of exactly 64 KiB is still read: the cap refuses only what is over it", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const body = { account_id: "edge.testnet", public_key: pubOf(kp), private_key: kp.toString(), padding: "" };
    body.padding = "x".repeat(64 * 1024 - JSON.stringify(body).length);
    const p = plant(env, "testnet/edge.testnet.json", body);
    expect(statSync(p).size).toBe(64 * 1024);
    expect(pubOf(loadFullAccessKey("testnet", "edge.testnet", env))).toBe(pubOf(kp));
  });

  it("the size cap holds even if the file grows after the fstat: the read itself stops past 64 KiB", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    // Valid JSON holding a valid key, so only the cap can refuse it.
    plant(env, "testnet/grown.testnet.json", { account_id: "grown.testnet", public_key: pubOf(kp), private_key: kp.toString(), padding: "x".repeat(70_000) });
    // fstat reports the size the file had before it grew: a stale 100 bytes.
    const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const real = fs.fstatSync;
    fs.fstatSync = ((fd: number, ...rest: unknown[]) => {
      const st = (real as (...args: unknown[]) => Stats)(fd, ...rest);
      st.size = 100;
      return st;
    }) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    let err: unknown;
    try {
      err = caught(() => loadFullAccessKey("testnet", "grown.testnet", env));
    } finally {
      fs.fstatSync = real;
      syncBuiltinESMExports();
    }
    expect(shown(err, secretWindows(kp))).toMatch(/^EnvironmentError: .*not a key file \(more than 65536 bytes\)/);
  });

  it("the keychain root itself may be a link (a relocated ~/.near-credentials)", () => {
    const env = { ...tmpEnv() };
    const real = join(env.KEYHOLE_HOME, "real-keychain");
    mkdirSync(real, { mode: 0o700 });
    env.KEYHOLE_CREDENTIALS_DIR = join(env.KEYHOLE_HOME, "linked-keychain");
    symlinkSync(real, env.KEYHOLE_CREDENTIALS_DIR);
    const kp = KeyPair.fromRandom("ed25519");
    saveSessionKey(refFor(kp), kp, env);
    expect(readSessionKey(refFor(kp), env)?.getPublicKey().toString()).toBe(pubOf(kp));
    expect(readdirSync(join(real, "testnet", "seat.op.testnet"))).toEqual([`${pubOf(kp).replace(":", "_")}.json`]);
  });
});

describe("sessionKeyPair: held → KEYHOLE_SESSION_KEY → keychain file → EnvironmentError", () => {
  it("a held key comes before KEYHOLE_SESSION_KEY: a different valid key there is not read", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: pubOf(kp) });
    holdSessionKey(session, kp);
    let got: KeyPair | undefined;
    const err = caught(() => (got = sessionKeyPair(session, { ...tmpEnv(), [SESSION_KEY_ENV]: other.toString() })));
    expect(shown(err, secretWindows(kp).concat(secretWindows(other)))).toBe("not an Error: undefined");
    expect(got === kp).toBe(true);
    expect(heldPrivateKeyCount()).toBe(1);
  });

  it("a set KEYHOLE_SESSION_KEY comes before the keychain file, which is then not read", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: pubOf(kp) });
    plant(env, keyFile(env, session).slice(env.KEYHOLE_CREDENTIALS_DIR.length + 1), "not JSON: reading this file would throw");
    expect(pubOf(sessionKeyPair(session, { ...env, [SESSION_KEY_ENV]: kp.toString() }))).toBe(session.publicKey);
    expect(heldPrivateKeyCount()).toBe(1);
  });

  it("a set but wrong KEYHOLE_SESSION_KEY is an error, never a fall-through to the keychain file", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: pubOf(kp) });
    saveSessionKey(session, kp, env);
    const err = caught(() => sessionKeyPair(session, { ...env, [SESSION_KEY_ENV]: other.toString() }));
    expect(shown(err, secretWindows(other))).toMatch(/^EnvironmentError: /);
    expect(heldPrivateKeyCount()).toBe(0);
  });

  it("an empty KEYHOLE_SESSION_KEY counts as unset: the keychain file answers", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: pubOf(kp) });
    saveSessionKey(session, kp, env);
    expect(pubOf(sessionKeyPair(session, { ...env, [SESSION_KEY_ENV]: "" }))).toBe(session.publicKey);
  });

  it("no key anywhere: the error names KEYHOLE_SESSION_KEY and the key file it looked for", () => {
    const env = tmpEnv();
    const session = sampleSession();
    const err = caught(() => sessionKeyPair(session, env));
    expect(err instanceof EnvironmentError).toBe(true);
    expect(shown(err)).toContain(SESSION_KEY_ENV);
    expect(shown(err)).toContain(keyFile(env, session));
    expect(heldPrivateKeyCount()).toBe(0);
  });

  it("a corrupt keychain file is reported, not skipped", () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519");
    const session = sampleSession({ publicKey: pubOf(kp) });
    plant(env, keyFile(env, session).slice(env.KEYHOLE_CREDENTIALS_DIR.length + 1), kp.toString().slice(8)); // a bare key, not JSON
    const err = caught(() => sessionKeyPair(session, env));
    expect(shown(err, secretWindows(kp))).toMatch(/^EnvironmentError: .*not JSON/);
    expect(leaks(err, secretWindows(kp))).toBe(false);
    expect(heldPrivateKeyCount()).toBe(0);
  });
});
