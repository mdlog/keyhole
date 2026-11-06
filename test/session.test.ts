/**
 * DATA CONTRACT #1 loadSession, and saveSession: session metadata under $KEYHOLE_HOME/sessions (a temp
 * dir here). The file never holds a private key.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, baseEncode } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_TESTNET_RPC, keyholeHome, rpcUrlFor, sessionsDir } from "../src/core/config.js";
import { EnvironmentError, InputError, UnknownSessionError } from "../src/core/errors.js";
import { SESSION_ID_PATTERN, isSessionId, listSessionIds, loadSession, newSessionId, saveSession, sessionProblems } from "../src/core/session.js";
import type { Session } from "../src/core/types.js";
import { sampleSession, tmpEnv } from "./helpers.js";

let home: string;
const write = (name: string, content: unknown) =>
  writeFileSync(join(home, "sessions", name), typeof content === "string" ? content : JSON.stringify(content, null, 2));

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "keyhole-test-"));
  mkdirSync(join(home, "sessions"));
  vi.stubEnv("KEYHOLE_HOME", home);
  write("ks-7f3a.json", sampleSession());
  write("ks-0bad.json", sampleSession({ id: "ks-0bad", allowanceYocto: "0" }));
  write("ks-0007.json", sampleSession({ id: "ks-7f3a" }));
  write("ks-00aa.json", "{ not json");
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("loadSession", () => {
  it("loads a well-formed session file", async () => {
    expect(await loadSession("ks-7f3a")).toEqual(sampleSession());
  });

  it.each(["../ks-7f3a", "ks-7F3A", "ks-7f3ab", "7f3a", ""])("rejects the id %j before touching the disk", async (id) => {
    await expect(loadSession(id)).rejects.toBeInstanceOf(InputError);
  });

  it("an unknown id lists the known sessions and exits 1", async () => {
    const err = await loadSession("ks-ffff").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownSessionError);
    expect((err as UnknownSessionError).exitCode).toBe(1);
    expect((err as UnknownSessionError).line()).toBe("unknown session ks-ffff · known sessions: ks-0007, ks-00aa, ks-0bad, ks-7f3a");
  });

  it("a malformed file is an environment error (the allowance must be explicit and non-zero)", async () => {
    await expect(loadSession("ks-0bad")).rejects.toThrow(/allowanceYocto \(explicit, non-zero\)/);
    await expect(loadSession("ks-00aa")).rejects.toBeInstanceOf(EnvironmentError);
  });

  it("C-T2b: a publicKey that is not ed25519 of exactly 32 bytes never loads or saves; the error names the field, never the value", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const privateShaped = kp.toString(); // "ed25519:" + base58 of 64 bytes: the shape near-api-js would take as a public key
    const bad = [privateShaped, `ed25519:${baseEncode(new Uint8Array(33).fill(7))}`, `ed25519:${baseEncode(new Uint8Array(31).fill(7))}`, "ed25519:0OIl"];
    for (const [i, publicKey] of bad.entries()) {
      const id = `ks-0c2${i}`;
      write(`${id}.json`, sampleSession({ id, publicKey }));
      const err = await loadSession(id).catch((e: unknown) => e);
      rmSync(join(home, "sessions", `${id}.json`)); // the other tests list this dir
      expect(err).toBeInstanceOf(EnvironmentError);
      expect((err as EnvironmentError).what.endsWith("is malformed: publicKey")).toBe(true);
      expect(`${(err as EnvironmentError).message} ${(err as EnvironmentError).tryThis}`.includes(publicKey.slice(8, 20))).toBe(false);
      const saved = await saveSession(sampleSession({ id: "ks-0c2f", publicKey }), tmpEnv()).catch((e: unknown) => e);
      expect(saved).toBeInstanceOf(InputError);
      expect((saved as InputError).message.includes(publicKey.slice(8, 20))).toBe(false);
    }
    expect(sessionProblems(sampleSession({ publicKey: kp.getPublicKey().toString() }))).toEqual([]);
  });

  it("a file whose id does not match its name is refused", async () => {
    await expect(loadSession("ks-0007")).rejects.toThrow("id ks-7f3a does not match the file name ks-0007");
  });

  it("listSessionIds reads the sessions dir", async () => {
    expect(await listSessionIds()).toEqual(["ks-0007", "ks-00aa", "ks-0bad", "ks-7f3a"]);
  });
});

describe("saveSession", () => {
  it("saveSession writes KEYHOLE_HOME/sessions/ID.json that loadSession round-trips, with no private key", async () => {
    const env = tmpEnv();
    vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME); // loadSession reads process.env, as serve, inspect and burn do
    try {
      const s = sampleSession();
      const path = await saveSession(s, env);
      expect(path).toBe(join(env.KEYHOLE_HOME, "sessions", "ks-7f3a.json"));
      expect(await loadSession("ks-7f3a")).toEqual(s);
      expect(readFileSync(path, "utf8")).not.toMatch(/private_key|secret/);
    } finally {
      vi.stubEnv("KEYHOLE_HOME", home);
    }
  });

  it("an invalid session rejects with InputError, and nothing is written", async () => {
    const env = tmpEnv();
    await expect(saveSession(sampleSession({ allowanceYocto: "0" }), env)).rejects.toBeInstanceOf(InputError);
    await expect(saveSession(sampleSession({ id: "../etc" }), env)).rejects.toThrow(/id/);
    await expect(saveSession(sampleSession({ id: "../etc" }), env)).rejects.toBeInstanceOf(InputError);
    expect(existsSync(join(env.KEYHOLE_HOME, "sessions"))).toBe(false);
  });

  it("writes only Session fields: a key pair attached by mistake never reaches the file", async () => {
    const env = tmpEnv();
    const kp = KeyPair.fromRandom("ed25519"); // in memory only; never printed
    const s = sampleSession();
    const path = await saveSession({ ...s, keyPair: kp, privateKey: kp.toString() } as Session, env);
    const text = readFileSync(path, "utf8");
    expect(text.includes(kp.toString().slice("ed25519:".length))).toBe(false); // boolean, so a failure cannot print the key
    expect(/private|secret|keyPair/i.test(text)).toBe(false);
    expect(JSON.parse(text)).toEqual(s);
  });

  it("re-saving replaces the file whole (burned status), leaving no temp file behind", async () => {
    const env = tmpEnv();
    await saveSession(sampleSession(), env);
    const burned = sampleSession({ status: "burned", burnedAt: "2026-11-11T09:20:00.000Z", burnTxHashes: ["9xQe"] });
    const path = await saveSession(burned, env);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(burned);
    expect(readdirSync(join(env.KEYHOLE_HOME, "sessions"))).toEqual(["ks-7f3a.json"]);
  });
});

describe("session ids and shape", () => {
  it("newSessionId matches the fixed format", () => {
    for (let i = 0; i < 50; i++) expect(isSessionId(newSessionId())).toBe(true);
    expect(SESSION_ID_PATTERN.source).toBe("^ks-[0-9a-f]{4}$");
  });

  it("sessionProblems accepts the sample and names each bad field", () => {
    expect(sessionProblems(sampleSession())).toEqual([]);
    expect(sessionProblems({ ...sampleSession(), mode: "x", publicKey: "abc", tools: [{ name: "t" }] })).toEqual(["mode", "publicKey", "tools"]);
    expect(sessionProblems([])).toEqual(["not an object"]);
  });
});

describe("config", () => {
  it("KEYHOLE_HOME, default ~/.keyhole", () => {
    expect(keyholeHome({ KEYHOLE_HOME: "/srv/kh" })).toBe("/srv/kh");
    expect(keyholeHome({})).toMatch(/[/\\]\.keyhole$/);
    expect(sessionsDir({ KEYHOLE_HOME: "/srv/kh" })).toBe("/srv/kh/sessions");
  });

  it("RPC endpoints: testnet has a default, sandbox has none (its port is per run)", () => {
    expect(rpcUrlFor("testnet", {})).toBe(DEFAULT_TESTNET_RPC);
    expect(rpcUrlFor("testnet", { KEYHOLE_TESTNET_RPC: "https://rpc.example" })).toBe("https://rpc.example");
    expect(rpcUrlFor("sandbox", { KEYHOLE_SANDBOX_RPC: "http://127.0.0.1:3030" })).toBe("http://127.0.0.1:3030");
    expect(() => rpcUrlFor("sandbox", {})).toThrow(EnvironmentError);
  });
});
