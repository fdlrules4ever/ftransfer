// Secrets API. The browser encrypts the text before it gets here and keeps the key in the link's
// #fragment (never sent to the server), so this code only ever handles ciphertext.

import { HttpError, json, readJson } from "./http.ts";
import { headSecret, secretKey, takeSecret, writeSecret, type SecretRecord } from "./storage.ts";
import { getLimits, requireAuth, type Ctx } from "./transfers.ts";
import { base64url, base64urlDecode, isRecord, isShareId, newShareId } from "./util.ts";

const HOUR_MS = 60 * 60 * 1000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NOT_FOUND = "This secret doesn't exist, was already viewed, was deleted, or has expired.";

/** UTF-8 needs at most 3 bytes per UTF-16 code unit (4 per surrogate pair), plus the GCM tag. */
export function maxCiphertextBytes(maxChars: number): number {
  return maxChars * 3 + TAG_BYTES;
}

/**
 * Checks the { iv, ciphertext } of an encrypted secret or list of links. Only the shape and size
 * can be checked: the server never has the key. Returns both re-encoded as base64url.
 */
export function readEncrypted(
  body: Record<string, unknown>,
  maxBytes: number,
  messages: { invalid: string; tooLarge: string },
): { iv: string; ciphertext: string } {
  const iv = typeof body.iv === "string" ? base64urlDecode(body.iv) : null;
  const ciphertext = typeof body.ciphertext === "string" ? base64urlDecode(body.ciphertext) : null;
  if (!iv || iv.length !== IV_BYTES || !ciphertext || ciphertext.length <= TAG_BYTES) {
    throw new HttpError(400, messages.invalid);
  }
  if (ciphertext.length > maxBytes) throw new HttpError(413, messages.tooLarge);
  return { iv: base64url(iv), ciphertext: base64url(ciphertext) };
}

/**
 * The ID for a new secret or list of links. Normally random, but an easy link's ID is derived in the
 * browser from its code (the server never sees the code), so the browser sends it along. It has the
 * same shape as a random ID. Taken IDs are refused with 409, so the browser picks a new code.
 */
export async function chooseId(body: Record<string, unknown>, exists: (id: string) => Promise<boolean>): Promise<string> {
  if (body.id === undefined) return newShareId();
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.id)) throw new HttpError(400, "The ID is invalid.");
  if (await exists(body.id)) throw new HttpError(409, "This code is already in use. Please try again.");
  return body.id;
}

function secretId(id: string): string {
  if (!isShareId(id)) throw new HttpError(404, NOT_FOUND);
  return id;
}

/** Stores an encrypted secret (requires login). Body: { iv, ciphertext, expiryHours, oneTime }. */
export async function createSecret(c: Ctx): Promise<Response> {
  await requireAuth(c);
  const limits = getLimits(c.env);
  const body = await readJson(c.request, 64 * 1024);
  if (!isRecord(body)) throw new HttpError(400, "Expected an encrypted secret.");

  const expiryHours = body.expiryHours ?? limits.defaultSecretExpiryHours;
  if (typeof expiryHours !== "number" || !limits.secretExpiryHours.includes(expiryHours)) {
    throw new HttpError(400, "Choose one of the offered expiry periods.");
  }
  const oneTime = body.oneTime ?? true;
  if (typeof oneTime !== "boolean") throw new HttpError(400, "oneTime must be true or false.");

  const { iv, ciphertext } = readEncrypted(body, maxCiphertextBytes(limits.maxSecretChars), {
    invalid: "The encrypted secret is invalid.",
    tooLarge: `A secret can be at most ${limits.maxSecretChars.toLocaleString("en")} characters.`,
  });

  const record: SecretRecord = {
    v: 1,
    id: await chooseId(body, async (id) => (await c.env.BUCKET.head(secretKey(id))) !== null),
    createdAt: c.now,
    expiresAt: c.now + expiryHours * HOUR_MS,
    oneTime,
    iv,
    ciphertext,
  };
  await writeSecret(c.env.BUCKET, record);
  return json({ id: record.id, expiresAt: record.expiresAt, oneTime }, { status: 201 });
}

/** Whether a secret exists, without revealing (or using up) it. Safe for link previews. */
export async function getSecretInfo(c: Ctx, id: string): Promise<Response> {
  const info = await headSecret(c.env.BUCKET, secretId(id), c.now);
  if (!info) throw new HttpError(404, NOT_FOUND);
  return json({ id, ...info });
}

/**
 * Returns the ciphertext. POST rather than GET, so link previews and prefetchers never
 * use up a one-time secret; a one-time secret is deleted before the response is sent.
 */
export async function revealSecret(c: Ctx, id: string): Promise<Response> {
  const record = await takeSecret(c.env.BUCKET, secretId(id), c.now);
  if (!record) throw new HttpError(404, NOT_FOUND);
  return json({
    id,
    iv: record.iv,
    ciphertext: record.ciphertext,
    oneTime: record.oneTime,
    expiresAt: record.expiresAt,
  });
}

/** Anyone with the link can delete, same as for files. */
export async function removeSecret(c: Ctx, id: string): Promise<Response> {
  const info = await headSecret(c.env.BUCKET, secretId(id), c.now);
  if (!info) throw new HttpError(404, NOT_FOUND);
  await c.env.BUCKET.delete(secretKey(id));
  return json({ ok: true });
}
