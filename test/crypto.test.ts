import assert from "node:assert/strict";
import { test } from "node:test";
import { DecryptError, decryptSecret, encryptSecret, isSecretKey } from "../client/crypto.ts";

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
