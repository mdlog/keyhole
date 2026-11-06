/**
 * Read-only testnet check of the claims in VENDORED.md. View calls only: no transactions, no keys.
 *
 *   npm run verify-vendored
 *
 * 1. sputnik-v2.testnet (the factory named in the PRD): which methods it exports, whether it has a
 *    default-code-hash/version view, which DAO wasm it embeds, and the code_hash of every DAO it created.
 * 2. sputnikv2.testnet (the maintained factory): its default code hash/version and that code's bytes.
 * Both are compared with the wasm files in vendor/. Raw small responses go to
 * demo/fixtures/sandbox/testnet-readonly/ (the copy of the Day-1 spike's fixtures/testnet-readonly/).
 * Copied from project-b/spike/; only paths changed: run from the repo root.
 */
import dns from "node:dns";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseEncode } from "near-api-js";

dns.setDefaultResultOrder("ipv4first"); // the dev box blackholes IPv6 (Cloudflare WARP)

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, "..");
const OUT = join(REPO, "demo", "fixtures", "sandbox", "testnet-readonly");
const RPC = process.env.TESTNET_RPC ?? "https://rpc.testnet.near.org";
const RPC_BULK = process.env.TESTNET_RPC_BULK ?? "https://test.rpc.fastnear.com"; // per-DAO loop (rate limits)
const FACTORY_A = "sputnik-v2.testnet";
const FACTORY_B = "sputnikv2.testnet";
const VENDORED = join(REPO, "vendor", "sputnikdao2-v2.0.0.wasm");
const COMPAT = join(REPO, "vendor", "compat-testnet-fetched", "sputnikdao2-sputnikv2.testnet-3.31.wasm");

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();
const codeHash = (b: Uint8Array) => baseEncode(sha(b));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const verdict = (ok: boolean, msg: string) => {
  console.log(`${ok ? "MATCH" : "MISMATCH"}: ${msg}`);
  if (!ok) failures++;
};

async function rpc(url: string, method: string, params: unknown, save?: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }) });
    const raw = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(1000 * attempt);
      continue;
    }
    if (save) writeFileSync(join(OUT, `${save}.json`), raw);
    return JSON.parse(raw);
  }
}
const call = (url: string, account: string, method: string, args: object, save?: string) =>
  rpc(url, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, save);
const resultText = (j: any) => (j.result?.result ? Buffer.from(j.result.result).toString("utf8") : `ERROR ${j.result?.error ?? JSON.stringify(j.error)}`);

function leb(b: Uint8Array, i: number): [number, number] {
  let r = 0;
  let s = 0;
  for (;;) {
    const x = b[i++];
    r += (x & 0x7f) * 2 ** s;
    s += 7;
    if (!(x & 0x80)) return [r, i];
  }
}
/** Exported function names of a wasm module. */
function wasmExports(b: Uint8Array): string[] {
  const out: string[] = [];
  let i = 8;
  while (i < b.length) {
    const id = b[i];
    const [size, j] = leb(b, i + 1);
    if (id === 7) {
      let [n, k] = leb(b, j);
      while (n--) {
        const [len, k2] = leb(b, k);
        const name = Buffer.from(b.subarray(k2, k2 + len)).toString("utf8");
        const kind = b[k2 + len];
        k = leb(b, k2 + len + 1)[1];
        if (kind === 0) out.push(name);
      }
    }
    i = j + size;
  }
  return out.sort();
}
/** Finds a wasm module embedded in `container` whose sha256 equals `target` (walks section boundaries). */
function findEmbedded(container: Uint8Array, target: Buffer): { offset: number; length: number } | null {
  const magic = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const buf = Buffer.from(container);
  for (let off = buf.indexOf(magic, 1); off > 0; off = buf.indexOf(magic, off + 1)) {
    let i = off + 8;
    while (i < buf.length && buf[i] <= 12) {
      const [size, j] = leb(buf, i + 1);
      const end = j + size;
      if (end > buf.length) break;
      if (sha(buf.subarray(off, end)).equals(target)) return { offset: off, length: end - off };
      i = end;
    }
  }
  return null;
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".json")) rmSync(join(OUT, f));
const analysis: Record<string, unknown> = { generated: new Date().toISOString(), rpc: RPC, rpcBulk: RPC_BULK };

// ------------------------------------------------------------------ vendored files
const vend = readFileSync(VENDORED);
const compat = readFileSync(COMPAT);
console.log(`vendored  ${VENDORED.replace(REPO + "/", "")}: ${vend.length} bytes, sha256 ${sha(vend).toString("hex")}, code_hash ${codeHash(vend)}`);
console.log(`compat    ${COMPAT.replace(REPO + "/", "")}: ${compat.length} bytes, sha256 ${sha(compat).toString("hex")}, code_hash ${codeHash(compat)}`);
const status = await rpc(RPC, "status", [], "testnet-status");
console.log(`testnet   ${RPC}: neard ${status.result.version.version}, protocol ${status.result.protocol_version}, height ${status.result.sync_info.latest_block_height}`);

// ------------------------------------------------------------------ factory A
console.log(`\n== ${FACTORY_A} (factory named in the PRD)`);
const accA = await rpc(RPC, "query", { request_type: "view_account", finality: "final", account_id: FACTORY_A }, "A-factory-view_account");
const codeA = await rpc(RPC, "query", { request_type: "view_code", finality: "final", account_id: FACTORY_A }); // ~0.9 MB: not saved
const factoryWasm = Buffer.from(codeA.result.code_base64, "base64");
const exportsA = wasmExports(factoryWasm);
console.log(`code_hash ${accA.result.code_hash} (${factoryWasm.length} bytes, sha256-check ${codeHash(factoryWasm) === accA.result.code_hash ? "ok" : "BAD"})`);
console.log(`exported methods (${exportsA.length}): ${exportsA.join(", ")}`);
const viewsA: Record<string, string> = {};
for (const m of ["get_default_code_hash", "get_default_version", "get_contracts_metadata", "get_owner", "get_number_daos"]) {
  viewsA[m] = resultText(await call(RPC, FACTORY_A, m, {}, `A-factory-${m}`));
  console.log(`  ${m.padEnd(24)} -> ${viewsA[m]}`);
}
const emb = findEmbedded(factoryWasm, sha(vend));
verdict(!!emb, `the wasm embedded in ${FACTORY_A}'s own code ${emb ? `(offset ${emb.offset}, ${emb.length} bytes)` : ""} is byte-identical to the vendored wasm`);
const daos: string[] = JSON.parse(resultText(await call(RPC, FACTORY_A, "get_dao_list", {}, "A-factory-get_dao_list")));
const hist: Record<string, string[]> = {};
for (const d of daos) {
  const a = await rpc(RPC_BULK, "query", { request_type: "view_account", finality: "final", account_id: d });
  const h = a.result?.code_hash ?? `ERROR ${JSON.stringify(a.error?.cause?.name ?? a.error)}`;
  (hist[h] ??= []).push(d);
  await sleep(120);
}
console.log(`DAOs created by ${FACTORY_A}: ${daos.length}`);
for (const [h, list] of Object.entries(hist)) console.log(`  ${String(list.length).padStart(3)} x code_hash ${h}${h === codeHash(vend) ? "  (= vendored)" : ""}`);
verdict(hist[codeHash(vend)]?.length === daos.length, `${hist[codeHash(vend)]?.length ?? 0}/${daos.length} DAOs of ${FACTORY_A} run the vendored code`);
const sampleDao = hist[codeHash(vend)]?.[0];
if (sampleDao) console.log(`  version() on ${sampleDao}: ${resultText(await call(RPC, sampleDao, "version", {}, "A-dao-version"))}`);
analysis.factoryA = { account: FACTORY_A, codeHash: accA.result.code_hash, exports: exportsA, views: viewsA, embeddedDao: emb, daoCount: daos.length, daoCodeHashes: hist };

// ------------------------------------------------------------------ factory B
console.log(`\n== ${FACTORY_B} (maintained factory, not named in the PRD)`);
const defHash: string = JSON.parse(resultText(await call(RPC, FACTORY_B, "get_default_code_hash", {}, "B-factory-get_default_code_hash")));
const defVer = resultText(await call(RPC, FACTORY_B, "get_default_version", {}, "B-factory-get_default_version"));
const meta = JSON.parse(resultText(await call(RPC, FACTORY_B, "get_contracts_metadata", {}, "B-factory-get_contracts_metadata")));
const nB = resultText(await call(RPC, FACTORY_B, "get_number_daos", {}, "B-factory-get_number_daos"));
console.log(`get_default_code_hash -> ${defHash} | get_default_version -> ${defVer} | get_number_daos -> ${nB}`);
console.log(`get_contracts_metadata: ${meta.map((m: any) => `${JSON.stringify(m[1].version)}=${m[1].commit_id.slice(0, 12)}`).join(" ")}`);
const got = await call(RPC, FACTORY_B, "get_code", { code_hash: defHash }); // ~1.5 MB: not saved
const defWasm = Uint8Array.from(got.result.result as number[]);
console.log(`get_code(default): ${defWasm.length} bytes, code_hash ${codeHash(defWasm)}`);
verdict(codeHash(defWasm) === defHash && sha(defWasm).equals(sha(compat)), `vendor/compat-testnet-fetched wasm = ${FACTORY_B} default code (${defHash})`);
console.log(`vendored v2.0.0 vs ${FACTORY_B} default: ${codeHash(vend) === defHash ? "same" : "DIFFERENT build"} (v2.0.0 is listed in its metadata as ${JSON.stringify(meta.find((m: any) => JSON.stringify(m[1].version) === "[2,0]")?.[0] ?? "absent")})`);
analysis.factoryB = { account: FACTORY_B, defaultCodeHash: defHash, defaultVersion: JSON.parse(defVer), numberDaos: Number(nB), metadata: meta, defaultCodeExports: wasmExports(defWasm) };
analysis.vendored = { file: "vendor/sputnikdao2-v2.0.0.wasm", sha256: sha(vend).toString("hex"), codeHash: codeHash(vend) };
writeFileSync(join(OUT, "analysis.json"), JSON.stringify(analysis, null, 2));
console.log(`\n${failures ? `${failures} MISMATCH` : "all MATCH"} — derived summary in demo/fixtures/sandbox/testnet-readonly/analysis.json`);
process.exitCode = failures ? 1 : 0;
