/**
 * Structural secret scan (PRD §6: "a secret scan finds 0 keys in the repo").
 *
 *   npm run scan:secrets      exit 0 when no key is found, 1 on any hit
 *
 * A pattern match is not enough: the fixtures hold dozens of public `ed25519:` values (transaction,
 * chunk and header signatures, block approvals, public keys). Each value is base58-decoded and judged
 * by its bytes:
 * - 64 bytes: a NEAR ed25519 private key is seed ‖ public key. It is flagged only if
 *   ed25519.getPublicKey(bytes[0..32]) equals bytes[32..64]. A signature (R ‖ S) never passes this.
 * - 32 bytes: a public key or a bare seed look the same, so it is flagged only when its own field
 *   name (JSON key, YAML/TOML/JS assignment) names private, secret or seed; for a value with no field
 *   name, the rest of the line decides (with the ed25519 values themselves blanked, so a base58 value
 *   that happens to spell "seed" cannot decide for itself).
 * Hits print `path:line` and the kind; the value is always REDACTED.
 * Skipped: node_modules, .sandbox-bin and .sandbox-home (near-sandbox's own genesis and validator keys),
 * .git, cargo's `target` build output (contracts/counter/target, gitignored), and binary files.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { baseDecode } from "near-api-js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".sandbox-bin", ".sandbox-home", ".git", "target"]);

const ED25519_VALUE = /ed25519:([1-9A-HJ-NP-Za-km-z]{30,100})/g;
const NAMES_A_SECRET = /private|secret|seed/i;
/** The field a value is assigned to: `"name": "`, `name: `, `name = "`, `name="` right before it. */
const FIELD_BEFORE_VALUE = /["']?([A-Za-z0-9_$.-]+)["']?\s*[:=]\s*["']?$/;

export type HitKind = "ed25519-keypair" | "ed25519-named-32";

export interface Hit {
  path: string;
  line: number;
  kind: HitKind;
}

export interface ScanResult {
  files: number;
  binarySkipped: number;
  /** Decoded ed25519 values by byte length. */
  values64: number;
  values32: number;
  valuesOther: number;
  hits: Hit[];
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Judges one decoded `ed25519:` value. `fieldName` is null when the value has no field of its own;
 * `lineContext` is its line with every ed25519 value blanked.
 */
export function judgeEd25519(bytes: Uint8Array, fieldName: string | null, lineContext: string): HitKind | null {
  if (bytes.length === 64) {
    return equalBytes(ed25519.getPublicKey(bytes.subarray(0, 32)), bytes.subarray(32, 64)) ? "ed25519-keypair" : null;
  }
  if (bytes.length === 32) {
    return NAMES_A_SECRET.test(fieldName ?? lineContext) ? "ed25519-named-32" : null;
  }
  return null;
}

/** Scans text from one file. Never returns or prints the matched values. */
export function scanText(path: string, text: string): Omit<ScanResult, "files" | "binarySkipped"> {
  const result = { values64: 0, values32: 0, valuesOther: 0, hits: [] as Hit[] };
  text.split("\n").forEach((line, i) => {
    if (!line.includes("ed25519:")) return;
    const lineContext = line.replace(ED25519_VALUE, "ed25519:");
    for (const m of line.matchAll(ED25519_VALUE)) {
      let bytes: Uint8Array;
      try {
        bytes = baseDecode(m[1]);
      } catch {
        continue;
      }
      if (bytes.length === 64) result.values64++;
      else if (bytes.length === 32) result.values32++;
      else result.valuesOther++;
      // A field name and its separator sit right before the value; 200 chars is plenty and keeps the regex linear.
      const before = line.slice(Math.max(0, (m.index ?? 0) - 200), m.index);
      const fieldName = FIELD_BEFORE_VALUE.exec(before)?.[1] ?? null;
      const kind = judgeEd25519(bytes, fieldName, lineContext);
      if (kind) result.hits.push({ path, line: i + 1, kind });
    }
  });
  return result;
}

/** Regular files under `dir`. Dirent types come from lstat, so symlinks are neither followed nor read. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(p);
    } else if (entry.isFile()) {
      yield p;
    }
  }
}

export function scanRepo(root: string = REPO_ROOT): ScanResult {
  const total: ScanResult = { files: 0, binarySkipped: 0, values64: 0, values32: 0, valuesOther: 0, hits: [] };
  for (const file of walk(root)) {
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) {
      total.binarySkipped++;
      continue;
    }
    total.files++;
    const r = scanText(relative(root, file), buf.toString("utf8"));
    total.values64 += r.values64;
    total.values32 += r.values32;
    total.valuesOther += r.valuesOther;
    total.hits.push(...r.hits);
  }
  return total;
}

export function formatHit(h: Hit): string {
  const what = h.kind === "ed25519-keypair" ? "ed25519 private key (64 bytes; its seed derives its own public half)" : "ed25519 32-byte value in a field named private/secret/seed";
  return `${h.path}:${h.line}  ${what}  value REDACTED`;
}

function main(): void {
  const r = scanRepo();
  for (const h of r.hits) console.log(formatHit(h));
  const checked = `${r.files} text files · ${r.values64 + r.values32 + r.valuesOther} ed25519 values decoded (${r.values64} × 64 bytes, ${r.values32} × 32 bytes) · ${r.binarySkipped} binary files skipped`;
  if (r.hits.length) {
    console.log(`secret scan: ${r.hits.length} key${r.hits.length === 1 ? "" : "s"} in repo · ${checked}`);
    process.exitCode = 1;
  } else {
    console.log(`secret scan: 0 keys in repo · ${checked}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
