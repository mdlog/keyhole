/**
 * DATA CONTRACT #2 loadTargetPack: packs are data (src/packs/ID.pack.json), and the expected error
 * names of the negative tests live there and nowhere else.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/core/errors.js";
import { NO_CODE_HASH } from "../src/core/rpc.js";
import { INVALID_ACCESS_KEY_ERRORS } from "../src/core/types.js";
import { listPackIds, loadTargetPack, packForCodeHash, packProblems } from "../src/packs/index.js";
import { REPO } from "./helpers.js";

describe("loadTargetPack", () => {
  it("lists the packs in src/packs", async () => {
    expect(await listPackIds()).toEqual(["counter", "sputnik-v2"]);
  });

  it("sputnik-v2: the sandbox fixture pins the vendored wasm by sha256 and NEAR code_hash", async () => {
    const pack = await loadTargetPack("sputnik-v2");
    const fixture = pack.sandboxFixture;
    expect(fixture).not.toBeNull();
    const wasm = readFileSync(join(REPO, fixture?.wasmPath ?? ""));
    const digest = createHash("sha256").update(wasm).digest();
    expect(fixture?.sha256).toBe(digest.toString("hex"));
    expect(fixture?.codeHash).toBe(baseEncode(digest));
  });

  it("sputnik-v2: the agent's only call tool is act_proposal; add_proposal is out of scope", async () => {
    const pack = await loadTargetPack("sputnik-v2");
    expect(pack.tools.filter((t) => t.kind === "call").map((t) => t.method)).toEqual(["act_proposal"]);
    expect(pack.outOfScope.map((m) => m.method)).toEqual(["add_proposal"]);
  });

  it("sputnik-v2: the negative tests expect the six plain-key InvalidAccessKeyError variants", async () => {
    const pack = await loadTargetPack("sputnik-v2");
    const expected = new Set(pack.negativeTests.map((t) => t.expected));
    expect([...expected].sort()).toEqual([...INVALID_ACCESS_KEY_ERRORS].sort());
    // Each refusal test breaks exactly one rule; only after-burn breaks none (the key is gone).
    for (const t of pack.negativeTests) expect(t.violates === "none").toBe(t.id === "after-burn");
  });

  it("counter: loads (sub-account mode, so after-burn expects SignerDoesNotExist)", async () => {
    const pack = await loadTargetPack("counter");
    expect(pack.abiSource).toBe("near-abi");
    expect(pack.negativeTests.find((t) => t.id === "after-burn")?.expected).toBe("SignerDoesNotExist");
  });

  it("rejects an unknown pack and names the available ones", async () => {
    await expect(loadTargetPack("nope")).rejects.toThrow("no target pack nope — available packs: counter, sputnik-v2");
    await expect(loadTargetPack("nope")).rejects.toBeInstanceOf(InputError);
  });

  it.each(["../package", "Sputnik-v2", "", "sputnik-v2.pack", "/etc/passwd"])("rejects the id %j before touching the disk", async (id) => {
    await expect(loadTargetPack(id)).rejects.toThrow("not a target pack id");
  });

  it("packProblems names each malformed field", () => {
    expect(packProblems({ id: "x", abiSource: "other", description: "", notEnforced: "n", tools: [{}], outOfScope: [], sandboxFixture: null, negativeTests: [] }, "x")).toEqual([
      "abiSource",
      "description",
      "tools[0]",
    ]);
  });

  it("sputnik-v2: the exposure row is VOTE (what the key does that the protocol does not limit)", async () => {
    expect((await loadTargetPack("sputnik-v2")).exposure).toEqual({ label: "VOTE", value: "any proposal here, either way, until burn; quorum 2-of-2" });
    expect((await loadTargetPack("counter")).exposure).toBeUndefined();
  });

  it("packProblems checks exposure only when present", () => {
    const base = { id: "x", abiSource: "pack-json", description: "d", notEnforced: "n", tools: [], outOfScope: [], sandboxFixture: null, negativeTests: [] };
    expect(packProblems(base, "x")).toEqual([]);
    expect(packProblems({ ...base, exposure: { label: "VALUE", value: "anything the signer owns inside the receiver" } }, "x")).toEqual([]);
    for (const exposure of [null, "VOTE", { label: "vote", value: "v" }, { label: "VOTE", value: "" }, { label: "VOTE" }]) {
      expect(packProblems({ ...base, exposure }, "x"), JSON.stringify(exposure)).toEqual(["exposure"]);
    }
  });

  it("packProblems: a negative test may expect SignerDoesNotExist only when its key state is after-burn", () => {
    const base = { id: "x", abiSource: "pack-json", description: "d", notEnforced: "n", tools: [], outOfScope: [], sandboxFixture: null };
    const test = (over: Record<string, unknown> = {}) => ({
      id: "t",
      label: "l",
      violates: "none",
      keyState: "after-burn",
      receiver: "receiver",
      action: "FunctionCall",
      method: "m",
      args: {},
      depositYocto: "0",
      gasTGas: 30,
      expected: "SignerDoesNotExist",
      ...over,
    });
    const problems = (t: unknown) => packProblems({ ...base, negativeTests: [t] }, "x");
    // allowed: a deleted sub-account, and an on-account burn that gives AccessKeyNotFound
    expect(problems(test())).toEqual([]);
    expect(problems(test({ expected: "AccessKeyNotFound" }))).toEqual([]);
    // rejected: any other key state, where the signer account still exists
    for (const keyState of ["session-key", "tiny-allowance-key"]) expect(problems(test({ keyState, violates: "method" })), keyState).toEqual(["negativeTests[0]"]);
    // the rule is about this one name: other names do not care about the key state
    expect(problems(test({ keyState: "session-key", expected: "MethodNameMismatch", violates: "method" }))).toEqual([]);
    expect(problems(test({ keyState: "tiny-allowance-key", expected: "NotEnoughAllowance", violates: "allowance" }))).toEqual([]);
  });

  it("the shipped packs still validate: counter and sputnik-v2 expect SignerDoesNotExist only after a burn", async () => {
    for (const id of await listPackIds()) {
      const pack = await loadTargetPack(id);
      for (const t of pack.negativeTests) if (t.expected === "SignerDoesNotExist") expect(t.keyState, `${id} ${t.id}`).toBe("after-burn");
    }
    expect((await loadTargetPack("counter")).negativeTests.map((t) => [t.id, t.keyState, t.expected])).toContainEqual(["after-burn", "after-burn", "SignerDoesNotExist"]);
    expect((await loadTargetPack("sputnik-v2")).negativeTests.map((t) => [t.keyState, t.expected])).toContainEqual(["after-burn", "AccessKeyNotFound"]);
  });

  it("packProblems checks sandboxFixture.setup rows only when present", () => {
    const fixture = { wasmPath: "vendor/x.wasm", sha256: "0".repeat(64), codeHash: "h", init: { method: "new", args: {} } };
    const base = { id: "x", abiSource: "pack-json", description: "d", notEnforced: "n", tools: [], outOfScope: [], sandboxFixture: fixture, negativeTests: [] };
    const row = { signer: "seat", method: "add_proposal", args: { proposal: { description: "d", kind: "Vote" } }, depositYocto: "100000000000000000000000" };
    const withSetup = (setup: unknown) => ({ ...base, sandboxFixture: { ...fixture, setup } });
    expect(packProblems(base, "x")).toEqual([]);
    expect(packProblems(withSetup([]), "x")).toEqual([]);
    expect(packProblems(withSetup([row, { ...row, signer: "cosigner", method: "act_proposal", args: {}, depositYocto: "0" }]), "x")).toEqual([]);
    const malformed = [
      { ...row, signer: "attacker" },
      { ...row, signer: undefined },
      { ...row, method: "" },
      { ...row, args: [] },
      { ...row, args: null },
      { ...row, depositYocto: "0.1" },
      { ...row, depositYocto: 1 },
      { ...row, depositYocto: undefined },
      null,
    ];
    for (const bad of malformed) expect(packProblems(withSetup([row, bad]), "x"), JSON.stringify(bad)).toEqual(["sandboxFixture.setup[1]"]);
    expect(packProblems(withSetup(row), "x")).toEqual(["sandboxFixture.setup"]);
  });
});

describe("packForCodeHash", () => {
  it("selects the pack whose sandbox fixture pins this code hash", async () => {
    expect((await packForCodeHash("ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq"))?.id).toBe("sputnik-v2");
  });

  it("no pack for unknown code, for no code, or for an empty hash", async () => {
    expect(await packForCodeHash("3Zr8gu5Uhm1i9F4Wm9q6UHYaXBhYJpGKmG5cgPq1Y5Ru")).toBeNull();
    expect(await packForCodeHash(NO_CODE_HASH)).toBeNull();
    expect(await packForCodeHash("")).toBeNull();
  });
});
