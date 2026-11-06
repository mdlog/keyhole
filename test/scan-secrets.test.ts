/**
 * The structural secret scanner (scripts/scan-secrets.ts). Positive controls use keys generated in
 * memory by this test; they are never written to disk and never printed. Test lines are built at run
 * time, so this file holds no `ed25519:` literal the repo scan could trip on.
 */
import { randomBytes } from "node:crypto";
import { KeyPair, baseDecode, baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { formatHit, judgeEd25519, scanText } from "../scripts/scan-secrets.js";
import { SANDBOX_FIXTURES, readFixture } from "./helpers.js";

const PREFIX = "ed25519:";

describe("secret scanner: 64-byte values", () => {
  it("flags an in-memory private key even under an innocuous field name, and never shows it", () => {
    const secret = KeyPair.fromRandom("ed25519").toString();
    const text = [`{"note": "${secret}"}`, `const x = "${secret}";`, secret].join("\n");
    const r = scanText("in-memory.json", text);
    expect(r.hits.map((h) => [h.line, h.kind])).toEqual([
      [1, "ed25519-keypair"],
      [2, "ed25519-keypair"],
      [3, "ed25519-keypair"],
    ]);
    const shown = r.hits.map(formatHit).join("\n");
    expect(shown).toContain("in-memory.json:1");
    expect(shown).toContain("value REDACTED");
    expect(shown).not.toContain(secret.slice(PREFIX.length, PREFIX.length + 12));
    expect(JSON.stringify(r)).not.toContain(secret.slice(PREFIX.length));
  });

  it("does not flag a real transaction signature from the fixtures (64 bytes, not seed ‖ public key)", () => {
    const raw = readFixture(SANDBOX_FIXTURES, "004-a-create-seat.send_tx.json");
    const signature: string = JSON.parse(raw).result.transaction.signature;
    expect(signature.startsWith(PREFIX)).toBe(true);
    const bytes = baseDecode(signature.slice(PREFIX.length));
    expect(bytes.length).toBe(64);
    expect(judgeEd25519(bytes, "signature", "")).toBeNull();

    const r = scanText("004-a-create-seat.send_tx.json", raw);
    expect(r.values64).toBeGreaterThan(0);
    expect(r.hits).toEqual([]);
  });

  it("does not flag 64 random bytes", () => {
    expect(judgeEd25519(randomBytes(64), "private_key", "private_key")).toBeNull();
  });
});

describe("secret scanner: 32-byte values (a bare seed and a public key look the same)", () => {
  const v = () => PREFIX + baseEncode(randomBytes(32));

  it.each([
    ["a JSON field named seed", () => `{"seed": "${v()}"}`],
    ["a YAML field named private_key", () => `private_key: ${v()}`],
    ["a TOML/env assignment named SECRET_KEY", () => `SECRET_KEY = "${v()}"`],
    ["a value with no field on a line that says secret", () => `# secret ${v()}`],
  ])("flags %s", (_, line) => {
    expect(scanText("t", line()).hits.map((h) => h.kind)).toEqual(["ed25519-named-32"]);
  });

  /** A valid 32-byte value whose base58 text itself spells "seed". */
  const spellsSeed = () => {
    const value = `2seed${"1".repeat(39)}`;
    expect(baseDecode(value).length).toBe(32);
    return PREFIX + value;
  };

  it.each([
    ["a JSON field named public_key", () => `{"public_key": "${v()}"}`],
    ["a field named publicKey on a line that also says private", () => `{"publicKey": "${v()}", "privateNote": "x"}`],
    ["a value with no field", () => `AddKey ${v()} on seat.sandbox`],
    ["a value with no field whose own base58 spells seed", () => `AddKey ${spellsSeed()} on seat.sandbox`],
  ])("does not flag %s", (_, line) => {
    const r = scanText("t", line());
    expect(r.values32).toBe(1);
    expect(r.hits).toEqual([]);
  });
});
