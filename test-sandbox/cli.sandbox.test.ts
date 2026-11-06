/**
 * Task 18 live suite (`npm run test:sandbox`): the real `keyhole wrap`, `inspect` and `burn` commands, run through
 * main against a real near-sandbox (nearcore 2.14.0) with the Sputnik DAO deployed by deployDaoSandbox, in both
 * modes. Nothing is faked: planWrap dry-runs on a sandbox of its own, signWrap and signBurn sign with keys from a
 * tmpEnv() keychain, and the burn PROOF is signed with the deleted session key.
 *
 * Local only: the sandbox root key is never saved anywhere; seat, cosigner and op are fresh accounts whose keys are
 * generated in memory and written only under tmpEnv(). Output holds public keys only. Set KEYHOLE_PRINT_CLI=FILE to
 * append each command's output to FILE (the samples in the task report).
 */
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Io } from "../src/cli/args.js";
import { main } from "../src/cli/main.js";
import { NEAR } from "../src/core/amounts.js";
import { saveAccountKey } from "../src/core/credentials.js";
import { dropHeldKeys } from "../src/core/keys.js";
import { viewAccount, viewScopedKey } from "../src/core/rpc.js";
import { type SandboxHandle, startSandbox } from "../src/core/sandbox.js";
import { loadSession } from "../src/core/session.js";
import { deployDaoSandbox } from "../src/packs/sputnik-setup.js";
import { ALREADY_BURNED, EXPOSURE_SUBACCOUNT, NOTE_SIGNER_GONE, PASS_KEY_GONE, passRefused } from "../src/render/strings.js";
import { tmpEnv } from "../test/helpers.js";
import { createAccount, repoSandboxProcesses, sandboxHomeEntries } from "./helpers.js";

let sb: SandboxHandle;
let seat: string;
let dao: string;
let operator: string;
const env = tmpEnv();
const nodesAtStart = repoSandboxProcesses();
const homeAtStart = sandboxHomeEntries();

beforeAll(async () => {
  sb = await startSandbox();
  seat = `seat.${sb.rootId}`;
  dao = `dao.${sb.rootId}`;
  operator = `op.${sb.rootId}`;
  const seatKey = await createAccount(sb, "seat", 10n * NEAR);
  await createAccount(sb, "cosigner", 10n * NEAR);
  const operatorKey = await createAccount(sb, "op", 10n * NEAR);
  // The keychain the commands read (tmpEnv, never ~/.near-credentials). loadSession reads process.env.
  saveAccountKey("sandbox", seat, seatKey, env);
  saveAccountKey("sandbox", operator, operatorKey, env);
  vi.stubEnv("KEYHOLE_HOME", env.KEYHOLE_HOME);
  vi.stubEnv("KEYHOLE_CREDENTIALS_DIR", env.KEYHOLE_CREDENTIALS_DIR);
  await deployDaoSandbox(sb, { daoId: dao, seat, cosigner: `cosigner.${sb.rootId}` });
});

afterAll(async () => {
  dropHeldKeys();
  vi.unstubAllEnvs();
  await sb?.stop();
  expect(repoSandboxProcesses()).toEqual(nodesAtStart); // no node left running, planWrap's dry-run sandboxes included
  expect(sandboxHomeEntries()).toEqual(homeAtStart);
});

/** Runs `keyhole ARGV` through main with a scripted terminal: stdin a TTY that answers `answer`. */
async function keyhole(argv: string[], answer = "yes"): Promise<{ code: number; out: string; lines: string[]; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (t) => void out.push(`${t}\n`),
    err: (t) => void err.push(t),
    write: (t) => void out.push(t),
    stdinIsTTY: true,
    readLine: async () => answer,
    env: process.env,
  };
  const code = await main(argv, io, {});
  const text = out.join("");
  const sample = process.env.KEYHOLE_PRINT_CLI;
  if (sample) appendFileSync(sample, `$ keyhole ${argv.join(" ")}  (exit ${code})\n${text}${err.length ? `[stderr]\n${err.join("\n")}\n` : ""}\n`);
  return { code, out: text, lines: text.split("\n"), err: err.join("\n") };
}

/** The session id from wrap's `session ks-XXXX · live · PATH` line. */
function sessionIdOf(lines: string[]): string {
  const line = lines.find((l) => /^session ks-[0-9a-f]{4} · live · /.test(l));
  expect(line, "wrap printed a session line").toBeDefined();
  return (line as string).split(" ")[1];
}

describe("keyhole wrap → inspect → burn on near-sandbox", () => {
  it("on-account: wrap adds the key, inspect reads it LIVE, burn deletes it and the deleted key is refused (AccessKeyNotFound)", async () => {
    const wrapped = await keyhole(["wrap", dao, "--allow", "act_proposal", "--gas", "0.05N", "--on-account", seat]);
    expect(wrapped.err).toBe("");
    expect(wrapped.code).toBe(0);
    expect(wrapped.lines[0]).toBe("KEYHOLE wrap · sandbox · on-account · pack sputnik-v2 (pack-json)");
    expect(wrapped.out).toContain("[PREVIEW]");
    expect(wrapped.lines).toContain("TX PLAN");
    expect(wrapped.lines.some((l) => /^tx \S+ · final · sandbox \(no explorer\)$/.test(l))).toBe(true);
    const id = sessionIdOf(wrapped.lines);
    const session = await loadSession(id);
    expect(session).toMatchObject({ mode: "on-account", accountId: seat, receiverId: dao, methodNames: ["act_proposal"], status: "live" });
    expect(await viewScopedKey(session)).toMatchObject({ accountId: seat, receiverId: dao, methodNames: ["act_proposal"], allowanceRemainingYocto: "50000000000000000000000" });

    const live = await keyhole(["inspect", id]);
    expect(live.code).toBe(0);
    expect(live.lines[0]).toBe(`KEYHOLE inspect · ${id} · sandbox · on-account`);
    expect(live.out).toContain("[LIVE]");
    expect(live.out).toMatch(/act_proposal \.+ callable/);
    expect(live.lines).toContain(`verify independently: RPC query, request_type view_access_key, account_id ${seat}, public_key ${session.publicKey}`);
    expect(live.lines.slice(-3, -1)).toEqual(["NEXT", `  keyhole burn ${id}`]);

    const burned = await keyhole(["burn", id]);
    expect(burned.err).toBe("");
    expect(burned.code).toBe(0);
    expect(burned.lines.slice(0, 3)).toEqual([`KEYHOLE burn · ${id} · sandbox · on-account`, "PLAN", `- DeleteKey(${session.publicKey}) on ${seat}, signed with ${seat}'s full-access key`]);
    expect(burned.lines.filter((l) => l === `        ${passRefused("AccessKeyNotFound")}`)).toHaveLength(1);
    expect(burned.lines.some((l) => l.includes("breaks"))).toBe(false);
    expect(burned.lines.at(-2)).toMatch(new RegExp(`^session ${id} · burned · \\d{2}:\\d{2}:\\d{2}Z$`));
    expect(await viewScopedKey(session)).toBeNull();
    expect((await loadSession(id)).status).toBe("burned");

    const gone = await keyhole(["inspect", id]);
    expect(gone.code).toBe(0);
    expect(gone.lines[1]).toBe("BURNED · no such key on chain (view_access_key)");
    expect(gone.lines[2]).toMatch(/^DeleteKey tx \S+ · final · sandbox \(no explorer\)$/);
    expect(gone.out).not.toContain("source of truth");

    // Again, as a new process would (no key held, the key file deleted): no tx; the proof is the chain's answer.
    dropHeldKeys();
    const again = await keyhole(["burn", id]);
    expect(again.code).toBe(0);
    expect(again.lines[1]).toBe(ALREADY_BURNED);
    expect(again.lines).toContain(`        ${PASS_KEY_GONE}`);
    expect(again.out).not.toMatch(/^tx /m);
  });

  it("sub-account (KEYHOLE_OPERATOR): burn deletes the account, and the deleted key is refused as SignerDoesNotExist with its note", async () => {
    vi.stubEnv("KEYHOLE_OPERATOR", operator);
    const wrapped = await keyhole(["wrap", dao, "--allow", "act_proposal", "--gas", "0.05N"]);
    expect(wrapped.err).toBe("");
    expect(wrapped.code).toBe(0);
    expect(wrapped.lines[0]).toBe("KEYHOLE wrap · sandbox · sub-account · pack sputnik-v2 (pack-json)");
    expect(wrapped.out.replace(/\n {10}/g, " ")).toContain(`EXPOSURE  ${EXPOSURE_SUBACCOUNT}`);
    const id = sessionIdOf(wrapped.lines);
    const session = await loadSession(id);
    expect(session).toMatchObject({ mode: "subaccount", accountId: `${id}.${operator}` });
    expect(await viewAccount("sandbox", session.accountId)).not.toBeNull();

    const burned = await keyhole(["burn", id]);
    expect(burned.err).toBe("");
    expect(burned.code).toBe(0);
    expect(burned.lines.slice(1, 4)).toEqual([
      "PLAN",
      `- DeleteKey(${session.publicKey}) on ${session.accountId}, signed with ${operator}'s full-access key`,
      `- DeleteAccount -> ${operator} (beneficiary)`,
    ]);
    const pass = burned.lines.indexOf(`        ${passRefused("SignerDoesNotExist")}`);
    expect(pass).toBeGreaterThan(0);
    expect(burned.lines[pass + 1]).toBe(`        ${NOTE_SIGNER_GONE}`);
    expect(await viewAccount("sandbox", session.accountId)).toBeNull();
    expect((await loadSession(id)).status).toBe("burned");
  });
});
