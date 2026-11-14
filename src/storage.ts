// R2 layout
//   manifests/{shareId}.json   transfer metadata (custom metadata mirrors status/expiry/size for cheap listing)
//   files/{shareId}/{index}    the uploaded files
//   secrets/{secretId}.json    an end-to-end encrypted secret (custom metadata mirrors expiry for cheap listing)
//   links/{linksId}.json       an end-to-end encrypted list of links (custom metadata mirrors expiry)

export type TransferStatus = "uploading" | "ready";

export interface FileEntry {
  name: string;
  size: number;
  type: string;
}

export interface Manifest {
  v: 1;
  id: string;
  status: TransferStatus;
  createdAt: number; // epoch ms
  expiryDays: number;
  /** Set when the upload is finalized; until then the upload window applies. */
  expiresAt: number | null;
  totalBytes: number;
  files: FileEntry[];
}

export interface ManifestSummary {
  id: string;
  status: TransferStatus;
  createdAt: number;
  expiresAt: number | null;
  totalBytes: number;
}

/** How long an unfinished upload may take before it is treated as abandoned. */
export const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

const MANIFEST_PREFIX = "manifests/";

export const manifestKey = (id: string) => `${MANIFEST_PREFIX}${id}.json`;
export const filePrefix = (id: string) => `files/${id}/`;
export const fileKey = (id: string, index: number) => `files/${id}/${index}`;

export async function readManifest(bucket: R2Bucket, id: string): Promise<Manifest | null> {
  const obj = await bucket.get(manifestKey(id));
  if (!obj) return null;
  return obj.json<Manifest>();
}

export async function writeManifest(bucket: R2Bucket, m: Manifest): Promise<void> {
  await bucket.put(manifestKey(m.id), JSON.stringify(m), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      status: m.status,
      createdAt: String(m.createdAt),
      expiresAt: m.expiresAt === null ? "" : String(m.expiresAt),
      totalBytes: String(m.totalBytes),
    },
  });
}

/** A transfer still takes up space (and may be used) until this returns true. */
export function isExpired(m: ManifestSummary, now: number): boolean {
  if (m.status === "ready") return m.expiresAt === null || m.expiresAt <= now;
  return m.createdAt + UPLOAD_WINDOW_MS <= now;
}

export function isDownloadable(m: Manifest, now: number): boolean {
  return m.status === "ready" && !isExpired(m, now);
}

export function isUploadOpen(m: Manifest, now: number): boolean {
  return m.status === "uploading" && !isExpired(m, now);
}

export async function* listManifests(bucket: R2Bucket): AsyncGenerator<ManifestSummary> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: MANIFEST_PREFIX, include: ["customMetadata"], cursor });
    for (const obj of page.objects) {
      const meta = obj.customMetadata ?? {};
      yield {
        id: obj.key.slice(MANIFEST_PREFIX.length, -".json".length),
        status: meta.status === "ready" ? "ready" : "uploading",
        createdAt: Number(meta.createdAt) || obj.uploaded.getTime(),
        expiresAt: meta.expiresAt ? Number(meta.expiresAt) : null,
        totalBytes: Number(meta.totalBytes) || 0,
      };
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Bytes reserved by transfers that are ready or still uploading. */
export async function usedBytes(bucket: R2Bucket, now: number): Promise<number> {
  let total = 0;
  for await (const m of listManifests(bucket)) {
    if (!isExpired(m, now)) total += m.totalBytes;
  }
  return total;
}

/** Deletes the files first and the manifest last, so a half-finished delete is retried by the cleanup job. */
export async function deleteTransfer(bucket: R2Bucket, id: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: filePrefix(id), cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await bucket.delete(manifestKey(id));
}

/**
 * Removes expired and abandoned transfers. Capped per run to stay well inside the
 * subrequest limit; anything left over is picked up by the next hourly run.
 */
export async function cleanupExpired(
  bucket: R2Bucket,
  now: number,
  maxDeletes = 100,
): Promise<{ deleted: string[]; remaining: boolean }> {
  const deleted: string[] = [];
  for await (const m of listManifests(bucket)) {
    if (!isExpired(m, now)) continue;
    if (deleted.length >= maxDeletes) return { deleted, remaining: true };
    await deleteTransfer(bucket, m.id);
    deleted.push(m.id);
  }
  return { deleted, remaining: false };
}

// ---------------------------------------------------------------------------
// Secrets

/**
 * A secret as stored in R2. The browser encrypts it (AES-256-GCM) and keeps the key in the
 * link's #fragment, so this record only ever holds ciphertext the Worker can't read.
 */
export interface SecretRecord {
  v: 1;
  id: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  /** Deleted as soon as someone reveals it. */
  oneTime: boolean;
  iv: string; // base64url, 12 bytes
  ciphertext: string; // base64url, includes the 16-byte GCM tag
}

const SECRET_PREFIX = "secrets/";

export const secretKey = (id: string) => `${SECRET_PREFIX}${id}.json`;

/** For secrets and links. Missing or unparseable expiry counts as expired, so leftovers never live forever. */
export function isExpiredAt(expiresAt: number, now: number): boolean {
  return !(expiresAt > now);
}

export async function writeSecret(bucket: R2Bucket, s: SecretRecord): Promise<void> {
  await bucket.put(secretKey(s.id), JSON.stringify(s), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: String(s.expiresAt), oneTime: s.oneTime ? "1" : "0" },
  });
}

/** Reads only the metadata (no ciphertext). Null if missing or expired. */
export async function headSecret(
  bucket: R2Bucket,
  id: string,
  now: number,
): Promise<{ expiresAt: number; oneTime: boolean } | null> {
  const head = await bucket.head(secretKey(id));
  if (!head) return null;
  const expiresAt = Number(head.customMetadata?.expiresAt);
  if (isExpiredAt(expiresAt, now)) return null;
  return { expiresAt, oneTime: head.customMetadata?.oneTime === "1" };
}

/**
 * Returns the secret, or null if it's missing or expired. A one-time secret is claimed and
 * deleted before it is returned: the claim is a conditional write on the object's etag, so when
 * two requests race for the same secret only one of them gets it.
 */
export async function takeSecret(bucket: R2Bucket, id: string, now: number): Promise<SecretRecord | null> {
  const key = secretKey(id);
  const obj = await bucket.get(key);
  if (!obj) return null;
  if (isExpiredAt(Number(obj.customMetadata?.expiresAt), now)) {
    await obj.text(); // drain the body before the next call
    await bucket.delete(key);
    return null;
  }
  const record = await obj.json<SecretRecord>();
  if (!record.oneTime) return record;

  // Overwrite this exact version with an already-expired tombstone. If someone else got here
  // first, the etag no longer matches and the put returns null.
  const claimed = await bucket.put(key, "", {
    onlyIf: { etagMatches: obj.etag },
    customMetadata: { expiresAt: "0", oneTime: "1" },
  });
  if (!claimed) return null;
  await bucket.delete(key); // if this fails, the tombstone is expired and the cleanup job removes it
  return record;
}

/** Deletes expired secrets (and tombstones) in batches. Leftovers are picked up by the next run. */
export function cleanupExpiredSecrets(bucket: R2Bucket, now: number, maxDeletes = 1000): Promise<CleanupResult> {
  return cleanupExpiredObjects(bucket, SECRET_PREFIX, now, maxDeletes);
}

// ---------------------------------------------------------------------------
// Links

/**
 * A shared list of links as stored in R2. Encrypted in the browser like a secret, so this record
 * only holds ciphertext. Links are never one-time: they stay readable until they expire or are deleted.
 */
export interface LinksRecord {
  v: 1;
  id: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  iv: string; // base64url, 12 bytes
  ciphertext: string; // base64url, includes the 16-byte GCM tag
}

const LINKS_PREFIX = "links/";

export const linksKey = (id: string) => `${LINKS_PREFIX}${id}.json`;

export async function writeLinks(bucket: R2Bucket, r: LinksRecord): Promise<void> {
  await bucket.put(linksKey(r.id), JSON.stringify(r), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: String(r.expiresAt) },
  });
}

/** Returns the links, or null if they're missing or expired. Expired links are deleted on the spot. */
export async function readLinks(bucket: R2Bucket, id: string, now: number): Promise<LinksRecord | null> {
  const key = linksKey(id);
  const obj = await bucket.get(key);
  if (!obj) return null;
  if (isExpiredAt(Number(obj.customMetadata?.expiresAt), now)) {
    await obj.text(); // drain the body before the next call
    await bucket.delete(key);
    return null;
  }
  return obj.json<LinksRecord>();
}

/** Whether links exist and haven't expired, without reading them. */
export async function linksExist(bucket: R2Bucket, id: string, now: number): Promise<boolean> {
  const head = await bucket.head(linksKey(id));
  return head !== null && !isExpiredAt(Number(head.customMetadata?.expiresAt), now);
}

/** Deletes expired links in batches. Leftovers are picked up by the next run. */
export function cleanupExpiredLinks(bucket: R2Bucket, now: number, maxDeletes = 1000): Promise<CleanupResult> {
  return cleanupExpiredObjects(bucket, LINKS_PREFIX, now, maxDeletes);
}

// ---------------------------------------------------------------------------
// Expiry cleanup for secrets and links

export interface CleanupResult {
  deleted: number;
  remaining: boolean;
}

/** Deletes objects under `prefix` whose `expiresAt` metadata has passed, at most `maxDeletes` per run. */
async function cleanupExpiredObjects(bucket: R2Bucket, prefix: string, now: number, maxDeletes: number): Promise<CleanupResult> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, include: ["customMetadata"], cursor });
    const expired = page.objects
      .filter((o) => isExpiredAt(Number(o.customMetadata?.expiresAt), now))
      .map((o) => o.key);
    const batch = expired.slice(0, maxDeletes - deleted);
    if (batch.length > 0) await bucket.delete(batch);
    deleted += batch.length;
    if (batch.length < expired.length) return { deleted, remaining: true };
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { deleted, remaining: false };
}
