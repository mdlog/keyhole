/**
 * The operator console (dashboard/, built into docs/ for GitHub Pages). Offline: these tests read files only.
 *   - its data (dashboard/public/data/keyhole.json) is what scripts/dashboard-data.ts writes from demo/, and every
 *     record in it traces back to a committed file;
 *   - docs/ is a build of the current dashboard source (docs/build.json) with its CSP intact;
 *   - the source talks to the network only through data/rpc.ts, with read-only requests, and holds no mock data.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceHash } from "../dashboard/source-hash.mjs";
import { DATA_FILE, dashboardData, renderData } from "../scripts/dashboard-data.js";
import { parseRefusal } from "../src/core/refusal.js";
import { REPO } from "./helpers.js";

const read = (f: string) => readFileSync(join(REPO, f), "utf8");
const rel = (f: string) => relative(REPO, f).split(sep).join("/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const SRC = walk(join(REPO, "dashboard/src")).filter((f) => /\.(ts|tsx)$/.test(f));
const ALL = SRC.map((f) => readFileSync(f, "utf8")).join("\n");
const RPC_HOSTS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];

describe("dashboard data (npm run site:data)", () => {
  it("is fresh: the committed JSON is the generator's output, and docs/ serves the same bytes", async () => {
    const out = renderData(await dashboardData());
    expect(read(DATA_FILE)).toBe(out);
    expect(read("docs/data/keyhole.json")).toBe(out);
  });

  it("the judging session is demo/judging-session.json, field for field, and it is the only session without a burn", async () => {
    const d = await dashboardData();
    const judging = JSON.parse(read("demo/judging-session.json")) as Record<string, unknown>;
    const s = d.sessions.find((x) => x.id === d.judgingSessionId)!;
    for (const k of ["id", "network", "accountId", "receiverId", "methodNames", "allowanceYocto", "publicKey", "codeHashPin", "createdAt"]) {
      expect(s[k as keyof typeof s], k).toEqual(judging[k]);
    }
    expect(s.wrap.txHash).toBe(judging.wrapTxHash);
    expect(d.sessions.filter((x) => !x.burn).map((x) => x.id)).toEqual([d.judgingSessionId]);
  });

  it("every refusal is the manifest's, its body byte for byte the fixture, named by parseRefusal, tied to one run step", async () => {
    const d = await dashboardData();
    const manifest = JSON.parse(read("demo/fixtures/manifest.json")) as { refusals: { network: string; pack: string; test: string }[] };
    expect(d.refusals.map((r) => r.fixture).sort()).toEqual(manifest.refusals.map((r) => `${r.network}.${r.pack}.${r.test}.json`).sort());
    for (const r of d.refusals) {
      const body = read(`demo/fixtures/${r.fixture}`);
      expect(r.body, r.fixture).toBe(body);
      expect(r.errorName, r.fixture).toBe(parseRefusal(body)!.errorName);
      const step = d.runs.find((run) => run.id === r.runId)!.steps.find((s) => s.n === r.step)!;
      expect(step.fixture, r.fixture).toBe(r.fixture);
    }
  });

  it("every testnet tx hash from a run is in demo/transcript.md (explorer links); every sandbox one in that run's record", async () => {
    const d = await dashboardData();
    for (const run of d.runs) {
      // The sandbox capture prints some hashes shortened (step 18's AddKey); its run file holds them whole.
      const log = run.network === "testnet" ? read(run.transcript) : read(run.transcript) + read(run.file);
      const hashes = [
        ...run.steps.flatMap((s) => s.txHashes),
        ...d.sessions.filter((s) => s.runId === run.id).flatMap((s) => [s.wrap.txHash, ...(s.burn ? [s.burn.txHash] : [])]),
      ];
      expect(hashes.length, run.id).toBeGreaterThan(5);
      for (const h of hashes) expect(log, `${run.id} ${h}`).toContain(h);
    }
    expect(read("demo/transcript.md")).toContain(d.dao.create.txHash);
  });

  it("each run's RESULT line is the one its transcript prints", async () => {
    const d = await dashboardData();
    for (const run of d.runs) {
      expect(read(run.transcript)).toContain(`RESULT ${[run.result.pass, ...run.result.parts].join(" · ")}`);
    }
  });
});

describe("docs/ (the console's build)", () => {
  const html = read("docs/index.html");

  it("is built from the current dashboard source (docs/build.json); rebuild with npm run site:build", () => {
    expect(JSON.parse(read("docs/build.json")).source).toBe(sourceHash(join(REPO, "dashboard")));
  });

  it("carries dashboard/public/ byte for byte, .nojekyll included", () => {
    const pub = join(REPO, "dashboard/public");
    const files = walk(pub).map((f) => relative(pub, f).split(sep).join("/"));
    expect(files).toContain(".nojekyll");
    for (const f of files) expect(read(`docs/${f}`), f).toBe(read(`dashboard/public/${f}`));
  });

  it("one CSP: scripts only from the site; it connects only to itself and the two testnet RPCs", () => {
    const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g)];
    expect(metas).toHaveLength(1);
    const csp = Object.fromEntries(metas[0][1].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["connect-src"]).toEqual(["'self'", ...[...RPC_HOSTS].reverse()]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
  });

  it("no inline script, and every asset it names exists", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(s[1]).toMatch(/\bsrc="\.\/assets\//);
      expect(s[2].trim()).toBe("");
    }
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const r of refs) expect(() => statSync(join(REPO, "docs", r)), r).not.toThrow();
  });

  it("names no local path", () => {
    expect(html).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:\\/);
    expect(ALL).not.toMatch(/\/home\/|\/Users\//);
  });
});

describe("dashboard source", () => {
  it("reaches the network only through data/rpc.ts, and its own data file through data/DataContext.tsx", () => {
    expect(SRC.filter((f) => /\bfetch\(/.test(readFileSync(f, "utf8"))).map(rel).sort()).toEqual(["dashboard/src/data/DataContext.tsx", "dashboard/src/data/rpc.ts"]);
    expect(read("dashboard/src/data/DataContext.tsx")).toContain("fetch('./data/keyhole.json'");
  });

  it("RPC: the two testnet hosts; read-only requests only (query views and the latest block)", () => {
    const rpc = read("dashboard/src/data/rpc.ts");
    expect([...new Set([...rpc.matchAll(/https:\/\/rpc\.[a-z.]+/g)].map((m) => m[0]))].sort()).toEqual([...RPC_HOSTS].sort());
    expect(new Set([...ALL.matchAll(/request_type: '(\w+)'/g)].map((m) => m[1]))).toEqual(new Set(["view_access_key", "view_account", "call_function"]));
    expect(new Set([...ALL.matchAll(/\brpc\('(\w+)'/g)].map((m) => m[1]))).toEqual(new Set(["query", "block"]));
    expect(new Set([...ALL.matchAll(/callView<[^>]*>\([^,]+, '(\w+)'/g)].map((m) => m[1]))).toEqual(new Set(["get_proposals", "get_policy"]));
    expect(ALL).not.toMatch(/send_tx|broadcast_tx|sign(Transaction|AndSend)|KeyPair\b|localStorage|sessionStorage/);
  });

  it("holds no mock data", () => {
    expect(ALL).not.toMatch(/mock|illustrative|sample|ks-42cd|ks-a719|ks-f881|PROP-10\d|RF-20\d|EV-8\d\d/i);
    expect(SRC.map(rel)).not.toContain("dashboard/src/data/mockData.ts");
  });

  it("the key inspector clears a private key before any read, and labels its inputs", () => {
    const page = read("dashboard/src/pages/InspectPage.tsx");
    expect(page).toContain("That looks like a private key, so it was cleared and nothing was sent.");
    const guard = page.indexOf("SECRET_RE.test(k)");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(page.indexOf("await readAccessKey("));
    expect(page).toContain(`htmlFor="kh-account"`);
    expect(page).toContain(`htmlFor="kh-key"`);
  });

  it("every `npm run SCRIPT` the command guide names exists in package.json", () => {
    const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);
    const named = [...read("dashboard/src/pages/CommandsPage.tsx").matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
    expect(named).toContain("keyhole");
    for (const s of named) expect(scripts, s).toContain(s);
  });
});
