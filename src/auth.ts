// Shared-passphrase login with a signed, stateless session cookie.
// Pure Web Crypto, so it runs both in Workers and in Node (unit tests).

import { base64url, base64urlDecode, utf8 } from "./util.ts";

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;

/** `__Host-` stops other *.franklippes.com sites from setting or overriding this cookie. It needs HTTPS. */
export function cookieName(https: boolean): string {
  return https ? "__Host-ft_session" : "ft_session";
}

export function isConfigured(password: string | undefined, secret: string | undefined): boolean {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    typeof secret === "string" &&
    secret.length >= MIN_SECRET_LENGTH
  );
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)));
}

/** Compares fixed-length digests, so the time taken doesn't reveal how much of the input matched. */
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  if (expected.length === 0) return false;
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// The signing key mixes in the passphrase: changing the passphrase logs every device out.
async function signingKey(secret: string, password: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", base, utf8(`ftransfer-session-v1\0${password}`));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionToken(
  secret: string,
  password: string,
  now = Date.now(),
): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `v1.${exp}`;
  const key = await signingKey(secret, password);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(payload)));
  return `${payload}.${base64url(sig)}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  password: string,
  now = Date.now(),
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return false;
  const sig = base64urlDecode(parts[2]!);
  if (!sig || sig.length !== 32) return false;
  const key = await signingKey(secret, password);
  return crypto.subtle.verify("HMAC", key, sig, utf8(`v1.${parts[1]}`));
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, https: boolean): string {
  const secure = https ? "; Secure" : "";
  return `${cookieName(https)}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secure}`;
}

export function clearSessionCookie(https: boolean): string {
  const secure = https ? "; Secure" : "";
  return `${cookieName(https)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}
