// End-to-end encryption for secrets, with the browser's built-in Web Crypto (no libraries).
//
// AES-256-GCM with a fresh random key and IV per secret. The key only ever travels in the link's
// #fragment, which browsers never send to the server, so R2 and the Worker only see ciphertext.
// GCM also authenticates: a damaged link or tampered ciphertext fails to decrypt instead of
// producing garbage.
//
// No imports, so the unit tests and the smoke test can load this file directly in Node.

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptedSecret {
  /** base64url, 43 characters: goes in the link after the #. */
  key: string;
  /** base64url, sent to the server. */
  iv: string;
  /** base64url, sent to the server. */
  ciphertext: string;
}

export class DecryptError extends Error {}

function toBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** True if `s` looks like a key from encryptSecret, i.e. the link wasn't cut off. */
export function isSecretKey(s: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(s);
}

function importKey(raw: Uint8Array<ArrayBuffer>, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

/** Encrypts with a new random key, or with `key` (base64url, from deriveFromEasyCode) for an easy link. */
export async function encryptSecret(text: string, key?: string): Promise<EncryptedSecret> {
  const given = key !== undefined && isSecretKey(key) ? fromBase64url(key) : null;
  if (key !== undefined && !given) throw new DecryptError("Invalid key.");
  const raw = given ?? crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await importKey(raw, "encrypt");
  const plaintext = new TextEncoder().encode(text);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext));
  return { key: toBase64url(raw), iv: toBase64url(iv), ciphertext: toBase64url(ciphertext) };
}

export async function decryptSecret(secret: EncryptedSecret): Promise<string> {
  const raw = isSecretKey(secret.key) ? fromBase64url(secret.key) : null;
  const iv = fromBase64url(secret.iv);
  const ciphertext = fromBase64url(secret.ciphertext);
  if (!raw || raw.length !== KEY_BYTES || !iv || iv.length !== IV_BYTES || !ciphertext) {
    throw new DecryptError("The link or the stored secret is damaged.");
  }
  try {
    const key = await importKey(raw, "decrypt");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new DecryptError("This secret couldn't be decrypted. The link may be incomplete or damaged.");
  }
}

// ---------------------------------------------------------------------------
// Easy-to-type links: 16 characters from Crockford's base32 alphabet (80 random bits), written like
// a credit card number, k7m2-qpx9-vtd4-8hrw. No i, l, o or u, so nothing looks alike, and reading is
// forgiving: any case, dashes or spaces, and O/I/L read as 0/1/1. Keep in sync with src/util.ts.
//
// For secrets and links the code is all there is: the storage ID and the AES key are both derived
// from it, and only the ID is sent to the server. 80 bits is less than a normal link's 256-bit key,
// so the derivation is deliberately slow (PBKDF2, 600,000 rounds): someone holding the stored
// ciphertext would need about 2^99 hash operations to find the code by trying them all.

export const EASY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const EASY_LENGTH = 16;
const EASY_ITERATIONS = 600_000;
const EASY_SALT = "ftransfer easy link v1";

export function newEasyCode(): string {
  // 256 is a multiple of 32, so taking each byte mod 32 keeps every character equally likely.
  return Array.from(crypto.getRandomValues(new Uint8Array(EASY_LENGTH)), (b) => EASY_ALPHABET[b % 32]).join("");
}

/** Reads a typed code into its canonical form (16 lowercase characters), or null if it isn't one. */
export function normalizeEasyCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]|%20/g, "").replace(/o/g, "0").replace(/[il]/g, "1");
  return /^[0-9a-hjkmnp-tv-z]{16}$/.test(s) ? s : null;
}

/** k7m2qpx9vtd48hrw → k7m2-qpx9-vtd4-8hrw */
export function formatEasyCode(code: string): string {
  return code.replace(/(.{4})(?!$)/g, "$1-");
}

/** The storage ID (base64url, same shape as a random ID) and AES key (base64url) for an easy code. */
export async function deriveFromEasyCode(code: string): Promise<{ id: string; key: string }> {
  const canonical = normalizeEasyCode(code);
  if (!canonical) throw new DecryptError("This code isn't complete.");
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(canonical), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(EASY_SALT), iterations: EASY_ITERATIONS }, base, 8 * (16 + KEY_BYTES)),
  );
  return { id: toBase64url(bits.subarray(0, 16)), key: toBase64url(bits.subarray(16)) };
}
