/**
 * docs/index.html: the hosted page (GitHub Pages, branch main, folder /docs). Hand-written HTML, CSS and one
 * script; the data-driven parts (the recorded cage card, the run results, the refusal ledger, the inspector's
 * data and the CSP script hashes) are written by scripts/site-html.ts from the committed evidence.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRefusal } from "../src/core/refusal.js";
import { listPackIds, loadTargetPack } from "../src/packs/index.js";
import { SITE_FILE, inlineScripts, renderSite, siteData } from "../scripts/site-html.js";
import { REPO } from "./helpers.js";

const html = readFileSync(join(REPO, SITE_FILE), "utf8");
const manifest = JSON.parse(readFileSync(join(REPO, "demo/fixtures/manifest.json"), "utf8")) as {
  refusals: { network: string; pack: string; test: string }[];
};
const session = JSON.parse(readFileSync(join(REPO, "demo/judging-session.json"), "utf8")) as Record<string, unknown>;
const region = (name: string): string => {
  const m = new RegExp(`<!-- kh:${name} -->([\\s\\S]*?)<!-- /kh:${name} -->`).exec(html);
  if (!m) throw new Error(`no kh:${name} region`);
  return m[1];
};
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

describe("docs/index.html: what it is", () => {
  it("is fresh: the generator, run on the committed page, returns it byte for byte, twice", async () => {
    const data = await siteData();
    const once = renderSite(html, data);
    expect(once).toBe(html);
    expect(renderSite(once, data)).toBe(once);
  });

  it("has a .nojekyll next to it, so Pages serves the folder as it is", () => {
    expect(existsSync(join(REPO, "docs/.nojekyll"))).toBe(true);
  });

  it("is one English page with one h1, which is the session's method", () => {
    expect(html).toMatch(/<html lang="en"/);
    const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    expect(h1s).toHaveLength(1);
    expect(h1s[0][1].trim()).toBe((session.methodNames as string[])[0]);
  });

  it("names the judging session's receiver and account in the hero", () => {
    const hero = /<section id="top"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(hero).toContain(session.receiverId as string);
    expect(hero).toContain(session.accountId as string);
  });
});

describe("docs/index.html: the evidence it shows", () => {
  it("lists every refusal of the manifest once, each body exactly as the fixture file holds it", () => {
    const ledger = region("ledger");
    const rows = [...ledger.matchAll(/data-fixture="([^"]+)"/g)].map((m) => m[1]);
    expect(rows.sort()).toEqual(manifest.refusals.map((r) => `${r.network}.${r.pack}.${r.test}.json`).sort());
    for (const file of rows) {
      const body = readFileSync(join(REPO, "demo/fixtures", file), "utf8");
      expect(ledger).toContain(`<pre>${escape(body)}</pre>`);
    }
  });

  it("names each refusal with the name parseRefusal reads from its body, in the inverse cell", () => {
    for (const r of manifest.refusals) {
      const file = `${r.network}.${r.pack}.${r.test}.json`;
      const parsed = parseRefusal(readFileSync(join(REPO, "demo/fixtures", file), "utf8"));
      expect(parsed, file).not.toBeNull();
      const row = new RegExp(`data-fixture="${file.replace(/\./g, "\\.")}"[\\s\\S]*?</details>`).exec(region("ledger"))?.[0] ?? "";
      expect(row).toContain(`<code class="inv">${parsed?.errorName}</code>`);
      expect(row).toContain(`>${r.network.toUpperCase()}<`);
    }
  });

  it("quotes the RESULT line of the testnet transcript and of the sandbox capture", () => {
    const runs = region("runs");
    for (const file of ["demo/transcript.md", "demo/capture.sandbox.md"]) {
      const line = readFileSync(join(REPO, file), "utf8").split("\n").find((l) => l.startsWith("RESULT "));
      const [pass, ...rest] = (line ?? "").replace(/^RESULT /, "").split(" · transcript ")[0].split(" · ");
      expect(runs).toContain(pass);
      for (const part of rest) expect(runs).toContain(escape(part));
    }
  });

  it("carries the judging session's public fields, and every pack's pinned code hash, as the inspector's data", async () => {
    const data = JSON.parse(region("data").replace(/^[\s\S]*?<script id="kh-data" type="application\/json">/, "").replace(/<\/script>[\s\S]*$/, ""));
    for (const k of ["id", "accountId", "receiverId", "methodNames", "allowanceYocto", "publicKey", "codeHashPin", "wrapTxHash"]) {
      expect(data.session[k], k).toEqual(session[k]);
    }
    const pins = await Promise.all((await listPackIds()).map(async (id) => ({ id, codeHash: (await loadTargetPack(id)).sandboxFixture?.codeHash })));
    expect(data.pins).toEqual(pins.filter((p) => p.codeHash));
  });

  it("shows the recorded cage card of the judging session with the whole key and the whole code hash", () => {
    const card = region("card");
    expect(card).toContain(session.publicKey as string);
    expect(card).toContain(session.codeHashPin as string);
    expect(card).toContain(session.receiverId as string);
    expect(card).toContain("[RECORDED]");
    expect(card).toContain(`https://testnet.nearblocks.io/txns/${session.wrapTxHash as string}`);
  });
});

describe("docs/index.html: what it loads and runs", () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
  const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

  it("has a CSP whose script-src is exactly the hashes of its inline scripts", () => {
    const hashes = inlineScripts(html).map((s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`);
    expect(hashes.length).toBeGreaterThan(0);
    expect(directive("script-src").split(/\s+/).slice(1).sort()).toEqual(hashes.sort());
    expect(directive("default-src")).toBe("default-src 'none'");
  });

  it("connects only to the two testnet RPCs, with read-only queries", () => {
    expect(directive("connect-src")).toBe("connect-src https://rpc.testnet.near.org https://rpc.testnet.fastnear.com");
    const methods = [...html.matchAll(/request_type:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(methods)).toEqual(new Set(["view_access_key", "view_account"]));
    expect(html).not.toMatch(/send_tx|broadcast_tx|signTransaction|privateKey/);
  });

  it("refuses to send what looks like a private key, before any request", () => {
    expect(html).toMatch(/looks like a private key/);
  });

  it("every link goes to the repo, the sibling, an explorer, a cited source, or an anchor on the page", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const allowed = [/^https:\/\/github\.com\/mdlog\/(keyhole|verdict)\b/, /^https:\/\/testnet\.nearblocks\.io\//, /^https:\/\/fonts\.(googleapis|gstatic)\.com/,
      /^https:\/\/github\.com\/nearai\/near-mcp\b/, /^https:\/\/cdn\.jsdelivr\.net\/gh\/nearai\/near-mcp@main\/TOOLS\.md$/, /^data:image\/svg\+xml,/];
    for (const h of hrefs) {
      if (h.startsWith("#")) expect(ids.has(h.slice(1)), h).toBe(true);
      else expect(allowed.some((re) => re.test(h)), h).toBe(true);
    }
    expect(hrefs).not.toContain("#");
  });

  it("names no local path and no user", () => {
    expect(html).not.toMatch(/\/home\/|file:\/\/|\/tmp\/|mdlog@|\.near-credentials\/[a-z]/);
  });

  it("labels every input", () => {
    for (const m of html.matchAll(/<(input|textarea)\b[^>]*\sid="([^"]+)"/g)) {
      expect(html, m[2]).toContain(`<label for="${m[2]}"`);
    }
  });
});
