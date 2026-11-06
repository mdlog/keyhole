/**
 * Key files in near-cli-rs's legacy keychain (Task 3), synchronous fs. `$KEYHOLE_CREDENTIALS_DIR`,
 * default `~/.near-credentials`:
 *   full-access key  NETWORK/ACCOUNT.json
 *   other keys       NETWORK/ACCOUNT/ed25519_PUBKEY.json   (the session keys wrap writes)
 *
 * Writes: JSON `{account_id, public_key, private_key}`, file mode 0600, new directories 0700. A file is
 * created exclusively (flag "wx"): Keyhole never overwrites a key file, and a file or link already at the
 * path is an error. Existing directories keep their mode.
 *
 * Reads accept near-cli-rs's own body too. Its save-to-legacy-keychain writes `{seed_phrase_hd_path,
 * master_seed_phrase, implicit_account_id, public_key, private_key}`, with no account_id, so account_id is
 * checked only when present. `secret_key` is accepted as an alias of `private_key` (as near-api-js does).
 * The key in a file must match the file's own public_key, and a session key must be the session's.
 *
 * Safety:
 * - network, account id and public key are checked before they become path components;
 * - nothing below the keychain root is followed: a symbolic link (or a file) in place of the NETWORK or
 *   ACCOUNT directory, or a link or non-regular file at a key path, is an EnvironmentError. The root itself
 *   may be a link (a relocated ~/.near-credentials);
 * - a private key is never printed, logged or echoed in an error. Errors name paths, account ids and
 *   public keys only; never file contents, and never an underlying error, whose message can quote its
 *   input (V8's JSON.parse quotes the start of bad JSON), not even as `cause`.
 */
import { type Stats, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { KeyPair, type KeyPairString, PublicKey, baseDecode } from "near-api-js";
import { networkOfAccount } from "./amounts.js";
import { EnvironmentError, InputError } from "./errors.js";
import type { Network, Session } from "./types.js";

/** Which key file: the session key's account and public key on a network. */
export type KeyRef = Pick<Session, "network" | "accountId" | "publicKey">;

/** The fix for a missing full-access key (the plan's exact wording). */
const MISSING_TRY = "near account import-account … save-to-legacy-keychain (near-cli-rs), or set KEYHOLE_CREDENTIALS_DIR";
const DIR_TRY = "check KEYHOLE_CREDENTIALS_DIR and its permissions";
const LINK_TRY = "Keyhole follows no link inside the keychain: put the real directory or key file there";
const NOT_DIR_TRY = "NETWORK and ACCOUNT inside the keychain must be directories: move this entry out of the keychain";
const NOT_FILE_TRY = "a key file must be a regular file: move this entry out of the keychain";
const FILE_TRY = "expected JSON {account_id, public_key, private_key}, as near-cli-rs save-to-legacy-keychain writes it";

const NETWORKS: readonly string[] = ["sandbox", "testnet"] satisfies Network[];
/** NEAR account id syntax: lowercase alphanumeric parts joined by `.`, `-` or `_` (2–64 characters). No `/`, no `..`. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** `ed25519:` and base58 (whose alphabet has no `/`, `.`, `:` or `_`), so the file name is safe. */
const ED25519_PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A run this long of base58 characters may be an encoded key: such a value is never echoed. */
const KEY_LIKE = /[1-9A-HJ-NP-Za-km-z]{30,}/;
/** Larger than any NEAR key file (an ML-DSA-65 pair is about 9 KB); anything bigger is not one. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

/** `$KEYHOLE_CREDENTIALS_DIR`, default `~/.near-credentials`. */
export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KEYHOLE_CREDENTIALS_DIR ? resolve(env.KEYHOLE_CREDENTIALS_DIR) : join(homedir(), ".near-credentials");
}

let fullAccessKeyLoads = 0;

/**
 * The full-access key of `accountId` from `NETWORK/ACCOUNT.json`, the only file it reads. Counted by
 * fullAccessKeyLoadCount. A missing file is an EnvironmentError that names the account, the dir and the fix.
 */
export function loadFullAccessKey(network: Network, accountId: string, env: NodeJS.ProcessEnv = process.env): KeyPair {
  // Every request counts, refused ones too: the count can over-report, never under-report.
  fullAccessKeyLoads++;
  checkIds(network, accountId);
  const root = credentialsDir(env);
  const path = join(root, network, `${accountId}.json`);
  const file = realDirs(root, [network]) ? readKeyFile(path) : null;
  if (!file) throw new EnvironmentError(`no full-access key for ${accountId} in ${join(root, network)}`, MISSING_TRY);
  return keyPairIn(path, file, accountId);
}

/** How many times this process asked for a full-access key (loadFullAccessKey calls, failed ones included). serve must ask for none. */
export function fullAccessKeyLoadCount(): number {
  return fullAccessKeyLoads;
}

/** `DIR/NETWORK/ACCOUNT/ed25519_PUBKEY.json`, the key file of a session key; InputError for an invalid ref. No I/O. */
export function sessionKeyPath(ref: KeyRef, env: NodeJS.ProcessEnv = process.env): string {
  checkIds(ref.network, ref.accountId);
  checkPublicKey(ref.publicKey);
  return join(credentialsDir(env), ref.network, ref.accountId, `${ref.publicKey.replace(":", "_")}.json`);
}

/** Writes the session key to `NETWORK/ACCOUNT/ed25519_PUBKEY.json` (0600) and returns the path. Never overwrites. */
export function saveSessionKey(ref: KeyRef, keyPair: KeyPair, env: NodeJS.ProcessEnv = process.env): string {
  const path = sessionKeyPath(ref, env);
  const pub = keyPair.getPublicKey().toString();
  if (pub !== ref.publicKey) {
    throw new EnvironmentError(`the key offered for ${ref.accountId} has public key ${pub}, not ${ref.publicKey}`, "save the key pair whose public key the session names");
  }
  makeDirs(credentialsDir(env), [ref.network, ref.accountId]);
  writeKeyFile(path, ref.accountId, keyPair);
  return path;
}

/** The session key from its key file, or null when there is no file. A file that holds another key is an EnvironmentError. */
export function readSessionKey(ref: KeyRef, env: NodeJS.ProcessEnv = process.env): KeyPair | null {
  const path = sessionKeyPath(ref, env);
  if (!realDirs(credentialsDir(env), [ref.network, ref.accountId])) return null;
  const file = readKeyFile(path);
  return file && keyPairIn(path, file, ref.accountId, ref.publicKey);
}

/** Deletes the session key file; false when there was none. The account directory stays (near-cli-rs keeps other keys there). */
export function deleteSessionKey(ref: KeyRef, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = sessionKeyPath(ref, env);
  if (!realDirs(credentialsDir(env), [ref.network, ref.accountId])) return false;
  const st = lstatOrNull(path);
  if (!st) return false;
  if (st.isSymbolicLink()) throw new EnvironmentError(`${path} is a symbolic link`, LINK_TRY);
  if (!st.isFile()) throw new EnvironmentError(`${path} is not a regular file`, NOT_FILE_TRY);
  try {
    unlinkSync(path);
  } catch (e) {
    if (errno(e) === "ENOENT") return false;
    throw new EnvironmentError(`cannot delete ${path} (${errno(e)})`, DIR_TRY);
  }
  return true;
}

/** Writes `NETWORK/ACCOUNT.json` (0600), only for the demo accounts Keyhole creates itself (Task 15). Returns the path. Never overwrites. */
export function saveAccountKey(network: Network, accountId: string, keyPair: KeyPair, env: NodeJS.ProcessEnv = process.env): string {
  checkIds(network, accountId);
  const root = credentialsDir(env);
  makeDirs(root, [network]);
  const path = join(root, network, `${accountId}.json`);
  writeKeyFile(path, accountId, keyPair);
  return path;
}

// ---------------------------------------------------------------------------------------------------
// Checks and file access

const errno = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? "unknown error");

/** An input value for an error message, or a placeholder if it could be an encoded key. */
const quoted = (v: unknown): string => {
  const s = String(v);
  return s.length <= 100 && !KEY_LIKE.test(s) ? JSON.stringify(s) : "(value not shown)";
};

const isAccountId = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT_ID.test(v);

/** The network and the account id become path components: both must be valid, and the account must be on that network. */
function checkIds(network: Network, accountId: string): void {
  let problem: string | null = null;
  if (!NETWORKS.includes(network)) problem = `network ${quoted(network)} is not sandbox or testnet`;
  else if (!isAccountId(accountId)) problem = `${quoted(accountId)} is not a NEAR account id`;
  else if (networkOfAccount(accountId) !== network && accountId !== network) problem = `${accountId} is not a ${network} account (expected *.${network})`;
  if (problem) throw new InputError([`keychain: ${problem}`]);
}

/**
 * THE 32-byte public-key check (C-T2b): `ed25519:` and the canonical base58 of exactly 32 bytes. near-api-js's
 * PublicKey.fromString also takes a 64-byte value, the shape of a private key, so every public key Keyhole takes as
 * text goes through this one function: a key file name here, an attempt's AddKey / DeleteKey / Stake argument
 * (attempt.ts), a session file's publicKey (session.ts). A caller that refuses never echoes the value.
 */
export function isEd25519PublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !ED25519_PUBLIC_KEY.test(value)) return false;
  try {
    return baseDecode(value.slice("ed25519:".length)).length === 32 && PublicKey.fromString(value).toString() === value;
  } catch {
    return false;
  }
}

/** The public key becomes the file name: it must be a canonical ed25519 key. Never echoed, since a malformed one could be anything. */
function checkPublicKey(publicKey: string): void {
  if (!isEd25519PublicKey(publicKey)) throw new InputError(["keychain: the session public key is not ed25519: followed by the base58 of 32 bytes (value not shown)"]);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    throw new EnvironmentError(`cannot read ${path} (${errno(e)})`, DIR_TRY);
  }
}

/**
 * Checks each directory below the keychain root, top down: it must be a real directory (never a link)
 * or absent. False when one is absent: there is nothing below it.
 */
function realDirs(root: string, parts: string[]): boolean {
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    const st = lstatOrNull(dir);
    if (!st) return false;
    if (st.isSymbolicLink()) throw new EnvironmentError(`${dir} is a symbolic link`, LINK_TRY);
    if (!st.isDirectory()) throw new EnvironmentError(`${dir} is not a directory`, NOT_DIR_TRY);
  }
  return true;
}

/** Creates the missing directories (0700, the root too if needed), after refusing any link on the way. */
function makeDirs(root: string, parts: string[]): void {
  realDirs(root, parts);
  const dir = join(root, ...parts);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new EnvironmentError(`cannot create ${dir} (${errno(e)})`, DIR_TRY);
  }
}

/** Creates the key file exclusively (0600, flag "wx": never an overwrite, never through a link), synced to disk. */
function writeKeyFile(path: string, accountId: string, keyPair: KeyPair): void {
  const body = JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if (errno(e) !== "EEXIST") throw new EnvironmentError(`cannot create ${path} (${errno(e)})`, DIR_TRY);
    if (lstatOrNull(path)?.isSymbolicLink()) throw new EnvironmentError(`${path} is a symbolic link`, LINK_TRY);
    throw new EnvironmentError(`${path} already exists`, "Keyhole never overwrites a key file");
  }
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // already failing: report the write error below
    }
    // The file is ours (created exclusively above): never leave a partial key behind.
    try {
      unlinkSync(path);
    } catch {
      // nothing more to remove
    }
    throw new EnvironmentError(`cannot write ${path} (${errno(e)})`, DIR_TRY);
  }
  closeSync(fd);
}

/** The JSON object in a key file, or null when there is none. Never follows a link; never echoes the contents. */
function readKeyFile(path: string): Record<string, unknown> | null {
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO at the path must not hang the open (fstat refuses it below).
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    if (errno(e) === "ELOOP" || errno(e) === "EMLINK") throw new EnvironmentError(`${path} is a symbolic link`, LINK_TRY);
    throw new EnvironmentError(`cannot read ${path} (${errno(e)})`, DIR_TRY);
  }
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) throw new EnvironmentError(`${path} is not a regular file`, NOT_FILE_TRY);
    // The cap is on what is read, not on what fstat said: a file that grows after the fstat is still
    // read at most one byte past the cap, and that byte refuses it.
    const buf = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got > MAX_KEY_FILE_BYTES) throw new EnvironmentError(`${path} is not a key file (more than ${MAX_KEY_FILE_BYTES} bytes)`, FILE_TRY);
    text = buf.toString("utf8", 0, got);
  } catch (e) {
    if (e instanceof EnvironmentError) throw e;
    throw new EnvironmentError(`cannot read ${path} (${errno(e)})`, DIR_TRY);
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnvironmentError(`${path} is not JSON (contents not shown)`, FILE_TRY);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EnvironmentError(`${path} is not a key file: not a JSON object (contents not shown)`, FILE_TRY);
  }
  return parsed as Record<string, unknown>;
}

function samePublicKey(value: unknown, derived: string): boolean {
  if (typeof value !== "string") return false;
  try {
    return PublicKey.fromString(value).toString() === derived;
  } catch {
    return false;
  }
}

/**
 * The key pair in a parsed key file, after these checks: account_id, when present, is `accountId`; there is
 * one private key (private_key, or secret_key as an alias); public_key, when present, is that key's; and
 * for a session key, the key is `publicKey`. Errors show the key's derived public key at most; no value
 * read from the file is echoed, except an account_id that is a valid account id.
 */
function keyPairIn(path: string, file: Record<string, unknown>, accountId: string, publicKey?: string): KeyPair {
  const { account_id, public_key, private_key, secret_key } = file;
  if (account_id !== undefined && account_id !== accountId) {
    const named = isAccountId(account_id) ? account_id : "another account (value not shown)";
    throw new EnvironmentError(`${path} holds a key for ${named}, not ${accountId}`, FILE_TRY);
  }
  if (private_key !== undefined && typeof private_key !== "string") throw new EnvironmentError(`${path}: private_key is not a string`, FILE_TRY);
  if (secret_key !== undefined && typeof secret_key !== "string") throw new EnvironmentError(`${path}: secret_key is not a string`, FILE_TRY);
  if (private_key !== undefined && secret_key !== undefined && private_key !== secret_key) {
    throw new EnvironmentError(`${path} has both private_key and secret_key, and they differ (values not shown)`, FILE_TRY);
  }
  const encoded = private_key ?? secret_key;
  if (!encoded) throw new EnvironmentError(`${path} has no private_key`, FILE_TRY);
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(encoded as KeyPairString);
  } catch {
    throw new EnvironmentError(`${path}: private_key is not a NEAR private key (value not shown)`, FILE_TRY);
  }
  const derived = keyPair.getPublicKey().toString();
  if (public_key !== undefined && !samePublicKey(public_key, derived)) {
    throw new EnvironmentError(`${path}: its public_key does not match its private key (values not shown)`, FILE_TRY);
  }
  if (publicKey !== undefined && derived !== publicKey) {
    throw new EnvironmentError(`${path} holds the key ${derived}, not ${publicKey}`, "the file belongs to another key: restore this session's key file");
  }
  return keyPair;
}
