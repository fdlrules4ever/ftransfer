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

export async function encryptSecret(text: string): Promise<EncryptedSecret> {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(raw, "encrypt");
  const plaintext = new TextEncoder().encode(text);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
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
