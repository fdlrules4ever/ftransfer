import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DecryptError,
  decryptSecret,
  deriveFromEasyCode,
  encryptSecret,
  formatEasyCode,
  isSecretKey,
  newEasyCode,
  normalizeEasyCode,
} from "../client/crypto.ts";
import { formatEasyId, normalizeEasyId } from "../src/util.ts";

test("encrypt/decrypt round trip keeps unicode, newlines and whitespace", async () => {
  for (const text of ["hunter2", "  spaced  \n\tline two\r\n", "pässwörd € 密码 🔑👨‍👩‍👧", "x".repeat(10_000)]) {
    const enc = await encryptSecret(text);
    assert.equal(await decryptSecret(enc), text);
  }
});

test("every secret gets a fresh key and iv; the ciphertext doesn't contain the text", async () => {
  const a = await encryptSecret("same text");
  const b = await encryptSecret("same text");
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.ok(isSecretKey(a.key));
  assert.equal(a.iv.length, 16); // 12 bytes base64url
  assert.ok(!Buffer.from(a.ciphertext, "base64url").toString("latin1").includes("same text"));
});

test("a wrong key, damaged key or tampered ciphertext fails instead of returning garbage", async () => {
  const enc = await encryptSecret("top secret");
  const other = await encryptSecret("other");
  await assert.rejects(decryptSecret({ ...enc, key: other.key }), DecryptError);
  await assert.rejects(decryptSecret({ ...enc, key: enc.key.slice(0, 40) }), DecryptError);
  await assert.rejects(decryptSecret({ ...enc, iv: other.iv }), DecryptError);

  const bytes = Buffer.from(enc.ciphertext, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  await assert.rejects(decryptSecret({ ...enc, ciphertext: bytes.toString("base64url") }), DecryptError);
});

test("isSecretKey only accepts a complete 256-bit base64url key", () => {
  assert.ok(isSecretKey("A".repeat(43)));
  assert.ok(!isSecretKey("A".repeat(42)));
  assert.ok(!isSecretKey("A".repeat(44)));
  assert.ok(!isSecretKey(`${"A".repeat(42)}=`));
  assert.ok(!isSecretKey(""));
});

test("an easy code derives the same id and key however it's typed, and encrypts end to end", async () => {
  const code = newEasyCode();
  assert.match(code, /^[0-9a-hjkmnp-tv-z]{16}$/);
  const a = await deriveFromEasyCode(code);
  const b = await deriveFromEasyCode(formatEasyCode(code).toUpperCase().replace(/-/g, " "));
  assert.deepEqual(a, b);
  assert.match(a.id, /^[A-Za-z0-9_-]{22}$/); // same shape as a random id
  assert.ok(isSecretKey(a.key));

  const other = await deriveFromEasyCode(newEasyCode());
  assert.notEqual(a.id, other.id);
  assert.notEqual(a.key, other.key);

  const enc = await encryptSecret("via code", a.key);
  assert.equal(enc.key, a.key);
  assert.equal(await decryptSecret({ ...enc, key: b.key }), "via code");
  await assert.rejects(decryptSecret({ ...enc, key: other.key }), DecryptError);
  await assert.rejects(deriveFromEasyCode("too-short"), DecryptError);
});

test("client and server read easy codes the same way", () => {
  for (const typed of ["k7m2-qpx9-vtd4-8hrw", "K7M2 QPX9 VTD4 8HRW", "ab0O-1iIl-LLLL-0000", "k7m2-qpx9-vtd4-8hru", "short"]) {
    assert.equal(normalizeEasyCode(typed), normalizeEasyId(typed), typed);
  }
  assert.equal(formatEasyCode("k7m2qpx9vtd48hrw"), formatEasyId("k7m2qpx9vtd48hrw"));
});
