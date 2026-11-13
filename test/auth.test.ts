import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionToken,
  isConfigured,
  passwordMatches,
  readCookie,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
  verifySessionToken,
} from "../src/auth.ts";

const SECRET = "s".repeat(40);
const PASSWORD = "correct horse battery staple";

test("password comparison", async () => {
  assert.equal(await passwordMatches(PASSWORD, PASSWORD), true);
  assert.equal(await passwordMatches("wrong", PASSWORD), false);
  assert.equal(await passwordMatches("", PASSWORD), false);
  assert.equal(await passwordMatches("", ""), false);
});

test("session tokens verify until they expire", async () => {
  const now = Date.UTC(2026, 10, 13);
  const token = await createSessionToken(SECRET, PASSWORD, now);
  assert.equal(await verifySessionToken(token, SECRET, PASSWORD, now), true);
  assert.equal(await verifySessionToken(token, SECRET, PASSWORD, now + (SESSION_MAX_AGE_SECONDS - 60) * 1000), true);
  assert.equal(await verifySessionToken(token, SECRET, PASSWORD, now + (SESSION_MAX_AGE_SECONDS + 1) * 1000), false);
});

test("session tokens are invalidated by a new passphrase or secret", async () => {
  const token = await createSessionToken(SECRET, PASSWORD);
  assert.equal(await verifySessionToken(token, SECRET, "a new passphrase!", Date.now()), false);
  assert.equal(await verifySessionToken(token, "t".repeat(40), PASSWORD, Date.now()), false);
});

test("tampered tokens are rejected", async () => {
  const token = await createSessionToken(SECRET, PASSWORD);
  const [v, exp, sig] = token.split(".");
  const later = `${v}.${Number(exp) + 999999}.${sig}`;
  assert.equal(await verifySessionToken(later, SECRET, PASSWORD), false);
  assert.equal(await verifySessionToken("garbage", SECRET, PASSWORD), false);
  assert.equal(await verifySessionToken("v1.1.", SECRET, PASSWORD), false);
});

test("cookies", () => {
  assert.equal(readCookie("a=1; __Host-ft_session=abc.def; b=2", "__Host-ft_session"), "abc.def");
  assert.equal(readCookie("a=1", "__Host-ft_session"), null);
  assert.equal(readCookie(null, "x"), null);
  const https = sessionCookie("tok", true);
  assert.ok(https.startsWith("__Host-ft_session=tok;"));
  assert.ok(https.includes("HttpOnly") && https.includes("Secure") && https.includes("SameSite=Strict") && https.includes("Path=/"));
  assert.ok(!https.includes("Domain"));
  assert.ok(!sessionCookie("tok", false).includes("Secure"));
});

test("configuration guard", () => {
  assert.equal(isConfigured(PASSWORD, SECRET), true);
  assert.equal(isConfigured("short", SECRET), false);
  assert.equal(isConfigured(PASSWORD, "short"), false);
  assert.equal(isConfigured(undefined, undefined), false);
});
