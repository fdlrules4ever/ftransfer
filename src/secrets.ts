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

  const iv = typeof body.iv === "string" ? base64urlDecode(body.iv) : null;
  const ciphertext = typeof body.ciphertext === "string" ? base64urlDecode(body.ciphertext) : null;
  if (!iv || iv.length !== IV_BYTES || !ciphertext || ciphertext.length <= TAG_BYTES) {
    throw new HttpError(400, "The encrypted secret is invalid.");
  }
  if (ciphertext.length > maxCiphertextBytes(limits.maxSecretChars)) {
    throw new HttpError(413, `A secret can be at most ${limits.maxSecretChars.toLocaleString("en")} characters.`);
  }

  const record: SecretRecord = {
    v: 1,
    id: newShareId(),
    createdAt: c.now,
    expiresAt: c.now + expiryHours * HOUR_MS,
    oneTime,
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
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
