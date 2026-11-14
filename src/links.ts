// Links API. Like secrets, the browser encrypts the list before it gets here and keeps the key in
// the link's #fragment (never sent to the server), so this code only ever handles ciphertext.
// Unlike secrets, links are never one-time, so they're fetched with a plain GET.

import { HttpError, json, readJson } from "./http.ts";
import { chooseId, readEncrypted } from "./secrets.ts";
import { linksExist, linksKey, readLinks, writeLinks, type LinksRecord } from "./storage.ts";
import { getLimits, requireAuth, type Ctx } from "./transfers.ts";
import { isRecord, isShareId } from "./util.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TAG_BYTES = 16;
const NOT_FOUND = "These links don't exist, were deleted, or have expired.";

/**
 * The plaintext is JSON, {"v":1,"links":[...]}, holding at most `maxChars` UTF-16 code units of
 * link text. JSON-escaped, one code unit takes at most 6 bytes (a lone surrogate becomes \uXXXX).
 * Add the list's own punctuation and the GCM tag.
 */
export function maxLinksCiphertextBytes(maxChars: number, maxLinks: number): number {
  return maxChars * 6 + maxLinks * 3 + 64 + TAG_BYTES;
}

function linksId(id: string): string {
  if (!isShareId(id)) throw new HttpError(404, NOT_FOUND);
  return id;
}

/** Stores an encrypted list of links (requires login). Body: { iv, ciphertext, expiryDays }. */
export async function createLinks(c: Ctx): Promise<Response> {
  await requireAuth(c);
  const limits = getLimits(c.env);
  const body = await readJson(c.request, 256 * 1024);
  if (!isRecord(body)) throw new HttpError(400, "Expected an encrypted list of links.");

  const expiryDays = body.expiryDays ?? limits.defaultLinkExpiryDays;
  if (typeof expiryDays !== "number" || !limits.linkExpiryDays.includes(expiryDays)) {
    throw new HttpError(400, "Choose one of the offered expiry periods.");
  }
  const { iv, ciphertext } = readEncrypted(body, maxLinksCiphertextBytes(limits.maxLinksChars, limits.maxLinks), {
    invalid: "The encrypted links are invalid.",
    tooLarge: `You can share at most ${limits.maxLinks} links, ${limits.maxLinksChars.toLocaleString("en")} characters in total.`,
  });

  const record: LinksRecord = {
    v: 1,
    id: await chooseId(body, async (id) => (await c.env.BUCKET.head(linksKey(id))) !== null),
    createdAt: c.now,
    expiresAt: c.now + expiryDays * DAY_MS,
    iv,
    ciphertext,
  };
  await writeLinks(c.env.BUCKET, record);
  return json({ id: record.id, expiresAt: record.expiresAt }, { status: 201 });
}

/** Returns the ciphertext. Nothing is used up, so a GET is fine here. */
export async function getLinks(c: Ctx, id: string): Promise<Response> {
  const record = await readLinks(c.env.BUCKET, linksId(id), c.now);
  if (!record) throw new HttpError(404, NOT_FOUND);
  return json({ id, iv: record.iv, ciphertext: record.ciphertext, expiresAt: record.expiresAt });
}

/** Anyone with the link can delete, same as for files and secrets. */
export async function removeLinks(c: Ctx, id: string): Promise<Response> {
  if (!(await linksExist(c.env.BUCKET, linksId(id), c.now))) throw new HttpError(404, NOT_FOUND);
  await c.env.BUCKET.delete(linksKey(id));
  return json({ ok: true });
}
