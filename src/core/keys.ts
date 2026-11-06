/**
 * The session's private key: the ONE private key `serve` loads (PRD §3; §6 key hygiene).
 *
 * This module is the only place a session private key is held in memory, so the key-hygiene test
 * can count what a process loaded (heldPrivateKeyCount). Nothing here writes a key to disk or prints it.
 * The session key's file in near-cli-rs's legacy keychain belongs to credentials.ts: wrap saves it
 * (saveSessionKey), sessionKeyPair reads it (readSessionKey), burn deletes it (deleteSessionKey).
 * Operator full-access keys (wrap, burn) never come through here: credentials.ts loadFullAccessKey
 * loads them and counts them (fullAccessKeyLoadCount).
 */
import { KeyPair, type KeyPairString, baseDecode, baseEncode } from "near-api-js";
import { readSessionKey, sessionKeyPath } from "./credentials.js";
import { EnvironmentError } from "./errors.js";
import type { Session } from "./types.js";

/** What a private key's text is replaced with wherever it would be printed. */
export const KEY_NOT_SHOWN = "(private key not shown)";

/**
 * The shortest run of a private key's text that counts as that key (C-T19h): any run of KEY_WINDOW or more characters
 * that also occurs in one of its text forms is replaced, so a cut that leaves part of a key behind leaves at most 11
 * characters of it. Base58 runs that long are random enough (58^12 ≈ 1.4·10^21) never to match by chance.
 */
export const KEY_WINDOW = 12;
/**
 * A run of base58 characters: the only text keyTextRedactor looks into; runs shorter than KEY_WINDOW are kept as they
 * are. `+`, never `{12,}`: V8 overflows its stack on a `{12,}` run of a few million characters, which an RPC body under
 * the 32 MiB cap can hold (sweep A fix round 1, I1). `+` is linear and stack-safe.
 */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;

/**
 * What a text becomes when it could not be checked for key text. Redaction never throws (sweep A fix round 1): a
 * failure inside it withholds the whole text instead, so the error that carries the text keeps its class and fields
 * (SendFateUnknownError's tx hash, say), and nothing unchecked is printed.
 */
export const TEXT_WITHHELD = "(text withheld: it could not be checked for key text)";

/** A private key's two text forms, base58: the extended key (seed and public key, 64 bytes) and its 32-byte seed. */
export function privateKeyTexts(keyPair: KeyPair): string[] {
  const encoded = keyPair.toString();
  const secret = encoded.slice(encoded.indexOf(":") + 1);
  return [secret, baseEncode(baseDecode(secret).slice(0, 32))].filter((f) => f.length >= KEY_WINDOW);
}

/**
 * Every KEY_WINDOW-character window of these key texts (privateKeyTexts), as a plain Set: what keyTextRedactor looks for.
 * Exported so a check that must not depend on the redactor (serve's withheldTxHash, sweep B m3) can look windows up
 * itself: a text that shares one of them with a held key is, in part, that key.
 */
export function keyTextWindows(forms: readonly string[]): ReadonlySet<string> {
  const windows = new Set<string>();
  for (const f of forms) for (let i = 0; i + KEY_WINDOW <= f.length; i++) windows.add(f.slice(i, i + KEY_WINDOW));
  return windows;
}

/**
 * A redactor for these key texts (privateKeyTexts): every run of KEY_WINDOW or more characters of the text that also
 * occurs in one of them becomes one KEY_NOT_SHOWN. Only base58 runs are searched (a key's text is base58), so a JSON
 * text stays JSON: the runs it replaces sit inside its strings.
 *
 * Only the base58 forms are known (Minor 4): the same key written another way (base64, hex, a byte array) is not
 * recognised. No keyhole path writes a key in any form, and the RPC never sees one, so an echo of another form is not
 * expected; the guarantee is "no 12 base58 characters of a held key's two text forms", nothing wider.
 *
 * The redactor never throws: on any failure inside it the whole text becomes TEXT_WITHHELD.
 */
export function keyTextRedactor(forms: readonly string[]): (text: string) => string {
  const windows = keyTextWindows(forms);
  if (windows.size === 0) return (text) => text;
  // The first two characters of every window (base58 is ASCII): a position whose pair is not among them starts no
  // window, so most positions are passed over without a slice (fix round 2, N1). The Set decides every other one.
  const pairs = new Uint8Array(128 * 128);
  for (const w of windows) pairs[w.charCodeAt(0) * 128 + w.charCodeAt(1)] = 1;
  const redact = (text: string) =>
    text.replace(BASE58_RUN, (run) => {
      if (run.length < KEY_WINDOW) return run;
      const hit = new Uint8Array(run.length);
      let any = false;
      for (let i = 0; i + KEY_WINDOW <= run.length; i++) {
        if (pairs[run.charCodeAt(i) * 128 + run.charCodeAt(i + 1)] === 0) continue;
        if (windows.has(run.slice(i, i + KEY_WINDOW))) {
          hit.fill(1, i, i + KEY_WINDOW);
          any = true;
        }
      }
      if (!any) return run;
      // Kept stretches as slices, one KEY_NOT_SHOWN per covered stretch, joined once (fix round 2, N1: building the
      // text a character at a time made a 32 MiB run with a key in it cost ≈3.5 s).
      const parts: string[] = [];
      for (let i = 0; i < run.length; ) {
        const start = i;
        if (hit[i]) {
          while (i < run.length && hit[i]) i++;
          parts.push(KEY_NOT_SHOWN);
        } else {
          while (i < run.length && !hit[i]) i++;
          parts.push(run.slice(start, i));
        }
      }
      return parts.join("");
    });
  return (text) => {
    try {
      return redact(text);
    } catch {
      return TEXT_WITHHELD;
    }
  };
}

/**
 * `text` with the text of every private key this process holds replaced (keyTextRedactor). Core code runs it before
 * it cuts a text it prints (rpc.ts printableRpcText, tx.ts, attempt.ts), so no cut leaves a part of a held key behind
 * (C-T19h). A process that holds no key gets `text` back unchanged. Never throws: a failure gives TEXT_WITHHELD.
 */
export function redactHeldKeys(text: string): string {
  if (held.size === 0) return text;
  try {
    return keyTextRedactor([...held.values()].flatMap(privateKeyTexts))(text);
  } catch {
    return TEXT_WITHHELD;
  }
}

/**
 * The session-key env fallback. Keys live in near-cli-rs's legacy keychain or in this variable (R19a):
 * sessionKeyPair takes a held key first, then this variable, then the session's keychain file.
 */
export const SESSION_KEY_ENV = "KEYHOLE_SESSION_KEY";

const held = new Map<string, KeyPair>();

/**
 * Hold an in-memory key pair for a session (the demo driver mints keys in-process).
 * Refuses a key whose public half is not the session's.
 */
export function holdSessionKey(session: Session, keyPair: KeyPair): void {
  const pub = keyPair.getPublicKey().toString();
  if (pub !== session.publicKey) {
    throw new EnvironmentError(`the key offered for session ${session.id} has public key ${pub}, not ${session.publicKey}`, "use the key that wrap minted for this session");
  }
  held.set(pub, keyPair);
}

/**
 * The session's key pair, from the first of these that has one:
 * 1. the key this process already holds;
 * 2. `KEYHOLE_SESSION_KEY`, when set and not empty. A set value decides: a malformed value, or a key whose
 *    public half is not Session.publicKey, is an error, never a fall-through to the keychain;
 * 3. the session's key file in the legacy keychain, `NETWORK/ACCOUNT/ed25519_PUBKEY.json` (wrap writes it),
 *    checked against Session.publicKey;
 * else an EnvironmentError that names KEYHOLE_SESSION_KEY and the key file. The key found is held, so the
 * next call returns it without reading anything.
 */
export function sessionKeyPair(session: Session, env: NodeJS.ProcessEnv = process.env): KeyPair {
  const already = held.get(session.publicKey);
  if (already) return already;
  const encoded = env[SESSION_KEY_ENV];
  let keyPair: KeyPair | null;
  if (encoded) {
    try {
      keyPair = KeyPair.fromString(encoded as KeyPairString);
    } catch {
      // Never echo the value: it is a private key.
      throw new EnvironmentError(`${SESSION_KEY_ENV} is not a NEAR private key (value not shown)`, "expected ed25519: followed by base58");
    }
  } else {
    keyPair = readSessionKey(session, env);
    if (!keyPair) {
      throw new EnvironmentError(
        `no private key for session ${session.id}: none held, ${SESSION_KEY_ENV} is not set, and there is no key file ${sessionKeyPath(session, env)}`,
        `set ${SESSION_KEY_ENV} in the environment of this process, or restore the session's key file`,
      );
    }
  }
  holdSessionKey(session, keyPair);
  return keyPair;
}

/** How many private keys this process holds. serve must hold exactly 1 (PRD §6). */
export function heldPrivateKeyCount(): number {
  return held.size;
}

/** Forget every held key (tests; also serve shutdown). */
export function dropHeldKeys(): void {
  held.clear();
}
