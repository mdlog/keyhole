/**
 * Task 21: demo/judging-session.json, the one testnet session left live for judging (never burned before 2026-11-25).
 * It was projected from the session file and the wrap's own output, public fields only: the private key is in the
 * keychain and never in this file. Offline: the committed file only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanText } from "../scripts/scan-secrets.js";
import { networkOfAccount } from "../src/core/amounts.js";
import { isSessionId } from "../src/core/session.js";
import { REPO } from "./helpers.js";

const FILE = "demo/judging-session.json";
const KEYS = ["id", "network", "accountId", "receiverId", "methodNames", "allowanceYocto", "publicKey", "codeHashPin", "createdAt", "wrapTxHash"];
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

const text = readFileSync(join(REPO, FILE), "utf8");

describe(FILE, () => {
  const session = JSON.parse(text) as Record<string, unknown>;

  it("parses and has exactly the public keys, in order", () => {
    expect(Object.keys(session)).toEqual(KEYS);
  });

  it("holds no private key (the repo's own secret scan)", () => {
    expect(scanText(FILE, text).hits).toEqual([]);
  });

  it("is a testnet session: networkOfAccount(accountId) is testnet, and so are the network and the receiver", () => {
    expect(networkOfAccount(session.accountId as string)).toBe("testnet");
    expect(session.network).toBe("testnet");
    expect(networkOfAccount(session.receiverId as string)).toBe("testnet");
  });

  it("each value has its form: a session id, a public key, base58 hashes, a positive yocto amount, an ISO time", () => {
    expect(isSessionId(session.id as string)).toBe(true);
    expect(session.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(session.codeHashPin).toMatch(BASE58);
    expect(session.wrapTxHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(session.allowanceYocto).toMatch(/^[1-9][0-9]*$/);
    expect(new Date(session.createdAt as string).toISOString()).toBe(session.createdAt);
    expect(session.methodNames).toEqual(["act_proposal"]);
  });

  it("names no local path", () => {
    expect(text).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:\\Users\\/);
  });
});
