/**
 * DATA CONTRACT #1 `loadSession` (path: local), and `saveSession`. Session metadata only: the file never
 * holds a private key, and a local read never supplies a chain fact (scope is re-read from RPC).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionsDir } from "./config.js";
import { isEd25519PublicKey } from "./credentials.js";
import { EnvironmentError, InputError, UnknownSessionError } from "./errors.js";
import type { Session, ToolSchema } from "./types.js";

/** Session id format, fixed at scaffold (LAYOUT "Session ids … Their format is fixed at scaffold"): `ks-7f3a`. */
export const SESSION_ID_PATTERN = /^ks-[0-9a-f]{4}$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/** A fresh id. wrap re-rolls it on collision with an existing session file (src/core/wrap.ts freshSessionId). */
export function newSessionId(): string {
  return `ks-${randomBytes(2).toString("hex")}`;
}

/** Ids of the session files under `$KEYHOLE_HOME/sessions`, sorted. */
export async function listSessionIds(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .filter(isSessionId)
    .sort();
}

export async function loadSession(id: string): Promise<Session> {
  // The id becomes a file name: validate it first, so no input can point outside the sessions dir.
  if (!isSessionId(id)) {
    throw new InputError([`not a session id: ${JSON.stringify(id)} (expected ks- and 4 lowercase hex digits, e.g. ks-7f3a)`]);
  }
  const file = join(sessionsDir(), `${id}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new UnknownSessionError(id, await listSessionIds());
    throw new EnvironmentError(`cannot read ${file}: ${(e as Error).message}`, "check KEYHOLE_HOME and file permissions");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvironmentError(`session file ${file} is not JSON`, "restore it, or burn and re-wrap the session");
  }
  const problems = sessionProblems(parsed, id);
  if (problems.length) {
    throw new EnvironmentError(`session file ${file} is malformed: ${problems.join(", ")}`, "restore it, or burn and re-wrap the session");
  }
  return parsed as Session;
}

/** The fields a session file holds, in file order. Anything else on the object is never written. */
const SESSION_FIELDS = [
  "id",
  "mode",
  "network",
  "accountId",
  "receiverId",
  "methodNames",
  "allowanceYocto",
  "codeHashPin",
  "publicKey",
  "createdAt",
  "burnedAt",
  "status",
  "packId",
  "tools",
  "burnTxHashes",
] as const satisfies ReadonlyArray<keyof Session>;

/** Compile-time: a Session field missing from SESSION_FIELDS fails typecheck (saveSession would drop it). */
type AssertNoneMissing<Missing extends never> = Missing;
type _SessionFieldsComplete = AssertNoneMissing<Exclude<keyof Session, (typeof SESSION_FIELDS)[number]>>;

/**
 * Writes `$KEYHOLE_HOME/sessions/ID.json` and returns its path. The session is checked first (an invalid
 * one is an InputError and nothing is written); only Session fields are written, so a key pair attached
 * to the object by mistake never reaches the disk. The file is replaced whole (temp file, then rename),
 * so a crash mid-write never leaves a truncated session behind.
 */
export async function saveSession(session: Session, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const problems = sessionProblems(session);
  if (problems.length) throw new InputError([`cannot save session ${JSON.stringify(session?.id)}: malformed ${problems.join(", ")}`]);
  const record: Record<string, unknown> = {};
  for (const k of SESSION_FIELDS) if (session[k] !== undefined) record[k] = session[k];
  const dir = sessionsDir(env);
  const file = join(dir, `${session.id}.json`);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new EnvironmentError(`cannot write ${file}: ${(e as Error).message}`, "check KEYHOLE_HOME and file permissions");
  }
  return file;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Shape check of a parsed session file. Returns one entry per problem; empty means well-formed. */
export function sessionProblems(v: unknown, expectedId?: string): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["not an object"];
  const s = v as Record<string, unknown>;
  const p: string[] = [];
  if (!isStr(s.id) || !isSessionId(s.id)) p.push("id");
  else if (expectedId !== undefined && s.id !== expectedId) p.push(`id ${s.id} does not match the file name ${expectedId}`);
  if (s.mode !== "subaccount" && s.mode !== "on-account") p.push("mode");
  if (s.network !== "sandbox" && s.network !== "testnet") p.push("network");
  for (const k of ["accountId", "receiverId", "codeHashPin", "createdAt", "packId"] as const) if (!isStr(s[k])) p.push(k);
  // The one 32-byte check (C-T2b): a 64-byte value (a private key's shape) never loads, and the problem names the field only.
  if (!isEd25519PublicKey(s.publicKey)) p.push("publicKey");
  if (!isStrArray(s.methodNames)) p.push("methodNames");
  if (!isStr(s.allowanceYocto) || !/^[0-9]+$/.test(s.allowanceYocto) || BigInt(s.allowanceYocto) === 0n) p.push("allowanceYocto (explicit, non-zero)");
  if (s.status !== "live" && s.status !== "burned") p.push("status");
  if (s.burnedAt !== undefined && !isStr(s.burnedAt)) p.push("burnedAt");
  if (s.burnTxHashes !== undefined && !isStrArray(s.burnTxHashes)) p.push("burnTxHashes");
  if (!Array.isArray(s.tools) || !s.tools.every(isToolSchema)) p.push("tools");
  return p;
}

function isToolSchema(t: unknown): t is ToolSchema {
  if (!t || typeof t !== "object") return false;
  const x = t as Record<string, unknown>;
  return (
    isStr(x.name) &&
    (x.kind === "view" || x.kind === "call" || x.kind === "meta") &&
    (x.method === null || isStr(x.method)) &&
    !!x.argsSchema &&
    typeof x.argsSchema === "object" &&
    typeof x.gasTGas === "number"
  );
}
