/**
 * Banned copy (Global Constraints → Copy and output). Scans README.md, src/**\/*.{ts,json}, examples/**
 * and demo/*.md line by line. Test files are not scanned: this one spells the banned phrases out.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./helpers.js";

/** Never write → write instead: `npm run keyhole -- CMD` · "six of eight" · "gas allowance (gas only)" · "refused at validation — never in a block". */
const BANNED = [/npx keyhole/, /\ball (six|6)\b/i, /\ball (\w+ )?variants\b/i,
  /spending cap|spend(ing)? limit/i, /blocked on-chain|logged on-chain|see it on the explorer/i, /auto-?revoke|\bTTL\b/i, /makes? votes? safe/i];

/**
 * R19(b): the session key lives until `keyhole burn`, not until the process ends. Applied to every scanned
 * file, README.md included (T20 rewrote the README and dropped its exemption).
 */
const BANNED_R19B = [/deleted at (process )?exit/i];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

/** README.md, docs/index.html, src/**\/*.{ts,json}, examples/**, demo/*.md (not demo/fixtures: RPC bodies are verbatim chain data). */
function scannedFiles(): string[] {
  return [
    join(REPO, "README.md"),
    join(REPO, "docs/index.html"),
    ...[...walk(join(REPO, "src"))].filter((f) => /\.(ts|json)$/.test(f)),
    ...walk(join(REPO, "examples")),
    ...readdirSync(join(REPO, "demo"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(REPO, "demo", f)),
  ].map((f) => relative(REPO, f));
}

describe("copy rules", () => {
  it("the scan covers README.md, src/, examples/ and demo/*.md", () => {
    const files = scannedFiles();
    expect(files).toContain("README.md");
    expect(files).toContain(join("src", "render", "strings.ts"));
    expect(files).toContain(join("src", "packs", "sputnik-v2.pack.json"));
    expect(files).toContain(join("examples", "claude-code.mcp.json"));
    expect(files).toContain(join("demo", "transcript.sandbox.md"));
    expect(files.some((f) => f.startsWith(join("demo", "fixtures")))).toBe(false);
  });

  it("no scanned line uses a banned phrase", () => {
    const hits: string[] = [];
    for (const file of scannedFiles()) {
      const patterns = [...BANNED, ...BANNED_R19B];
      readFileSync(join(REPO, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const re of patterns) if (re.test(line)) hits.push(`${file}:${i + 1} ${re} ${line.trim().slice(0, 120)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it.each(["the key is deleted at exit", "Deleted at process exit"])("banned everywhere, README.md included (R19b): %j", (phrase) => {
    expect(BANNED_R19B.some((re) => re.test(phrase))).toBe(true);
  });

  it("R19b allows the burn wording", () => {
    expect(BANNED_R19B.some((re) => re.test("the key lives until keyhole burn deletes it"))).toBe(false);
  });

  it.each([
    "npx keyhole serve ks-7f3a",
    "all six refusals",
    "All 6 of them",
    "all variants",
    "all eight variants",
    "a spending cap",
    "the spend limit",
    "a spending limit",
    "blocked on-chain",
    "logged on-chain",
    "see it on the explorer",
    "auto-revoke",
    "autorevoke",
    "a TTL of 1h",
    "it makes votes safe",
    "make vote safe",
  ])("banned: %j", (phrase) => {
    expect(BANNED.some((re) => re.test(phrase))).toBe(true);
  });

  it.each([
    "npm run keyhole -- serve ks-7f3a",
    "six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope",
    "gas allowance (gas only)",
    "refused at validation — never in a block",
    "call 6 methods; recall all",
    "a shuttle",
  ])("allowed: %j", (phrase) => {
    expect(BANNED.some((re) => re.test(phrase))).toBe(false);
  });
});
