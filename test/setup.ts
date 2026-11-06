/**
 * Runs before every `npm test` file and makes two rules structural, not a matter of each test's care.
 *
 * No real keychain: test/home-guard.ts (shared with the sandbox suite) points HOME, KEYHOLE_HOME and
 * KEYHOLE_CREDENTIALS_DIR into a throwaway dir, and fails the file if that does not take.
 *
 * Offline: `npm test` opens no socket. Every RPC path in src/ calls globalThis.fetch at call time
 * (src/core/rpc.ts), and here fetch always fails. A test that needs RPC replies stubs fetch itself,
 * from committed fixtures, inside the test (beforeEach restores this one).
 */
import "./home-guard.js";
import { beforeEach } from "vitest";

export const OFFLINE_MESSAGE = "offline: npm test opens no socket";

export const offlineFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`${OFFLINE_MESSAGE} (fetch ${url})`);
};

globalThis.fetch = offlineFetch;

beforeEach(() => {
  globalThis.fetch = offlineFetch;
});
