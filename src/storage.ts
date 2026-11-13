// R2 layout
//   manifests/{shareId}.json   transfer metadata (custom metadata mirrors status/expiry/size for cheap listing)
//   files/{shareId}/{index}    the uploaded files

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
