/**
 * C-T18c: what `keyhole serve` loads. serve holds one key and runs unattended under an MCP host, so its module
 * graph is kept to what it needs: ABSENT_EVIDENCE lives in render/strings.ts (a leaf) so that the cage card, which
 * serve loads, no longer pulls in the classifier, its label rules, the sandbox and the DAO setup code (4 modules).
 * This reads the source's static imports (import / export … from, import "x", import("x")); nothing is executed.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./helpers.js";

/** Every src file reachable from `entry` by a relative import, as repo-relative paths. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const specs = [
      ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/g),
      ...text.matchAll(/(?:^|\n)\s*import\s+"(\.[^"]+)"/g),
      ...text.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) walk(target);
    }
  };
  walk(resolve(REPO, entry));
  return new Set([...seen].map((f) => relative(REPO, f)));
}

describe("the module graph of keyhole serve (C-T18c)", () => {
  const serve = reachable("src/cli/serve.ts");

  it("reads the graph it is about: serve loads the cage card, the packs and the RPC code", () => {
    for (const file of ["src/cli/serve.ts", "src/core/cage.ts", "src/core/keys.ts", "src/core/rpc.ts", "src/core/tx.ts", "src/packs/index.ts", "src/render/strings.ts"]) expect(serve.has(file), file).toBe(true);
  });

  it("serve does not load the classifier, its label rules, the sandbox or the DAO setup code", () => {
    for (const file of ["src/classify/dry-run.ts", "src/classify/label.ts", "src/core/sandbox.ts", "src/packs/sputnik-setup.ts"]) expect(serve.has(file), file).toBe(false);
  });

  it("nor the other commands (wrap, burn, demo, inspect) or the demo driver", () => {
    for (const file of ["src/cli/wrap.ts", "src/cli/burn.ts", "src/cli/demo.ts", "src/cli/inspect.ts", "src/demo/driver.ts", "src/core/wrap.ts", "src/core/burn.ts"]) expect(serve.has(file), file).toBe(false);
  });

  it("burn does not load the wrap command for its word wrap", () => {
    const burn = reachable("src/cli/burn.ts");
    expect(burn.has("src/cli/wrap.ts")).toBe(false);
    expect(burn.has("src/render/style.ts")).toBe(true);
  });
});

describe("the layers (final review M8)", () => {
  /** The repo-relative src files `file` imports directly (relative specifiers only). */
  const directImports = (file: string): string[] => {
    const text = readFileSync(resolve(REPO, file), "utf8");
    const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/g), ...text.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g)].map((m) => m[1]);
    return specs.map((spec) => relative(REPO, resolve(dirname(resolve(REPO, file)), spec.replace(/\.js$/, ".ts"))));
  };

  it("serve keeps no private copy of wrapWords: it uses render/style.ts's (final review M9, n-1); inspect's comment names m-2 (n-5)", () => {
    const serve = readFileSync(resolve(REPO, "src/cli/serve.ts"), "utf8");
    expect(serve).not.toMatch(/function wrapWords\b/);
    expect(serve).toMatch(/import \{[^}]*\bwrapWords\b[^}]*\} from "\.\.\/render\/style\.js";/);
    const inspect = readFileSync(resolve(REPO, "src/cli/inspect.ts"), "utf8");
    expect(inspect).toContain("(m-2 of Sweep B fix round 1, C-T18d)");
    expect(inspect).not.toContain("m-1 of fix round 1");
  });

  it("no src/core module imports from src/cli: core/wrap.ts takes isAccountId and isMethodName from core/ids.ts", () => {
    const core = readdirSync(resolve(REPO, "src/core")).filter((f) => f.endsWith(".ts")).map((f) => `src/core/${f}`);
    expect(core).toContain("src/core/wrap.ts");
    for (const file of core) for (const target of directImports(file)) expect(target, `${file} → ${target}`).not.toMatch(/^src\/cli\//);
    expect(directImports("src/core/wrap.ts")).toContain("src/core/ids.ts");
    expect(directImports("src/cli/wrap.ts")).toContain("src/core/ids.ts");
    expect(readFileSync(resolve(REPO, "src/cli/args.ts"), "utf8")).not.toMatch(/export function is(AccountId|MethodName)\b/);
  });
});
