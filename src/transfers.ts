import {
  clearSessionCookie,
  cookieName,
  createSessionToken,
  isConfigured,
  passwordMatches,
  readCookie,
  sessionCookie,
  verifySessionToken,
} from "./auth.ts";
import { HttpError, json, readJson } from "./http.ts";
import {
  deleteTransfer,
  fileKey,
  isDownloadable,
  isUploadOpen,
  readManifest,
  usedBytes,
  writeManifest,
  type FileEntry,
  type Manifest,
} from "./storage.ts";
import {
  attachmentDisposition,
  expectedPartSize,
  formatBytes,
  isRecord,
  isShareId,
  newShareId,
  parseDayList,
  parseIntList,
  parsePositiveInt,
  parseRange,
  partCount,
  safeContentType,
  sanitizeFilename,
} from "./util.ts";

export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  https: boolean;
  now: number;
}

/**
 * 32 MiB parts: well under the 100 MB request body limit, few enough requests for big files,
 * and R2 requires every part except the last to have the same size.
 */
export const CHUNK_SIZE = 32 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND = "This transfer doesn't exist, was deleted, or has expired.";

/** Longest secret, in UTF-16 code units: what a textarea's maxlength and String#length count. */
export const MAX_SECRET_CHARS = 10_000;

/** Secrets live at most 7 days, which the 8-day R2 lifecycle rule on secrets/ relies on. */
export const MAX_SECRET_EXPIRY_HOURS = 7 * 24;

export interface Limits {
  chunkSize: number;
  maxTotalBytes: number;
  maxFiles: number;
  expiryDays: number[];
  defaultExpiryDays: number;
  maxSecretChars: number;
  secretExpiryHours: number[];
  defaultSecretExpiryHours: number;
}

export function getLimits(env: Env): Limits {
  const expiryDays = parseDayList(env.EXPIRY_DAYS, [1, 3, 7, 14, 30]);
  const wanted = parsePositiveInt(env.DEFAULT_EXPIRY_DAYS, 7);
  const secretHours = parseIntList(env.SECRET_EXPIRY_HOURS, [1, 24, 168], MAX_SECRET_EXPIRY_HOURS);
  const wantedHours = parsePositiveInt(env.DEFAULT_SECRET_EXPIRY_HOURS, 24);
  return {
    chunkSize: CHUNK_SIZE,
    maxTotalBytes: parsePositiveInt(env.MAX_TOTAL_BYTES, 9_500_000_000),
    maxFiles: parsePositiveInt(env.MAX_FILES, 200),
    expiryDays,
    defaultExpiryDays: expiryDays.includes(wanted) ? wanted : expiryDays[0]!,
    maxSecretChars: MAX_SECRET_CHARS,
    secretExpiryHours: secretHours,
    defaultSecretExpiryHours: secretHours.includes(wantedHours) ? wantedHours : secretHours[0]!,
  };
}

// ---------------------------------------------------------------------------
// Session

async function isAuthenticated(c: Ctx): Promise<boolean> {
  const { UPLOAD_PASSWORD, SESSION_SECRET } = c.env;
  if (!isConfigured(UPLOAD_PASSWORD, SESSION_SECRET)) return false;
  const token = readCookie(c.request.headers.get("Cookie"), cookieName(c.https));
  if (!token) return false;
  return verifySessionToken(token, SESSION_SECRET, UPLOAD_PASSWORD, c.now);
}

export async function requireAuth(c: Ctx): Promise<void> {
  if (!(await isAuthenticated(c))) throw new HttpError(401, "Please sign in first.");
}

export async function getSession(c: Ctx): Promise<Response> {
  const configured = isConfigured(c.env.UPLOAD_PASSWORD, c.env.SESSION_SECRET);
  if (!(await isAuthenticated(c))) return json({ authenticated: false, configured });
  const limits = getLimits(c.env);
  const used = await usedBytes(c.env.BUCKET, c.now);
  return json({
    authenticated: true,
    configured,
    limits,
    usage: { usedBytes: used, freeBytes: Math.max(0, limits.maxTotalBytes - used) },
  });
}

export async function login(c: Ctx): Promise<Response> {
  const { UPLOAD_PASSWORD, SESSION_SECRET } = c.env;
  if (!isConfigured(UPLOAD_PASSWORD, SESSION_SECRET)) {
    throw new HttpError(503, "Uploading isn't set up yet: the passphrase or session secret is missing or too short.");
  }
  const ip = c.request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
  if (!success) throw new HttpError(429, "Too many attempts. Wait a minute and try again.");

  const body = await readJson(c.request, 4096);
  const password = isRecord(body) && typeof body.password === "string" ? body.password : "";
  if (!(await passwordMatches(password, UPLOAD_PASSWORD))) {
    throw new HttpError(401, "That passphrase isn't right.");
  }
  const token = await createSessionToken(SESSION_SECRET, UPLOAD_PASSWORD, c.now);
  return json({ authenticated: true }, { headers: { "Set-Cookie": sessionCookie(token, c.https) } });
}

export function logout(c: Ctx): Response {
  return json({ authenticated: false }, { headers: { "Set-Cookie": clearSessionCookie(c.https) } });
}

// ---------------------------------------------------------------------------
// Uploading (requires login)

export async function createTransfer(c: Ctx): Promise<Response> {
  await requireAuth(c);
  const limits = getLimits(c.env);
  const body = await readJson(c.request);
  if (!isRecord(body) || !Array.isArray(body.files)) throw new HttpError(400, "Expected a list of files.");

  const expiryDays = body.expiryDays ?? limits.defaultExpiryDays;
  if (typeof expiryDays !== "number" || !limits.expiryDays.includes(expiryDays)) {
    throw new HttpError(400, "Choose one of the offered expiry periods.");
  }
  if (body.files.length === 0) throw new HttpError(400, "Add at least one file.");
  if (body.files.length > limits.maxFiles) {
    throw new HttpError(400, `You can send at most ${limits.maxFiles} files at once.`);
  }

  const files: FileEntry[] = body.files.map((f: unknown, i: number) => {
    if (!isRecord(f)) throw new HttpError(400, `File ${i + 1} is invalid.`);
    const name = sanitizeFilename(f.name);
    if (!name) throw new HttpError(400, `File ${i + 1} has an invalid name.`);
    if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) {
      throw new HttpError(400, `"${name}" has an invalid size.`);
    }
    return { name, size: f.size, type: safeContentType(f.type) };
  });

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new HttpError(
      413,
      `This transfer is ${formatBytes(totalBytes)}; the maximum is ${formatBytes(limits.maxTotalBytes)}.`,
    );
  }
  const free = Math.max(0, limits.maxTotalBytes - (await usedBytes(c.env.BUCKET, c.now)));
  if (totalBytes > free) {
    throw new HttpError(
      413,
      `Not enough space: ${formatBytes(free)} is free and this transfer needs ${formatBytes(totalBytes)}. ` +
        `Delete an older transfer or wait for one to expire.`,
    );
  }

  const manifest: Manifest = {
    v: 1,
    id: newShareId(),
    status: "uploading",
    createdAt: c.now,
    expiryDays,
    expiresAt: null,
    totalBytes,
    files,
  };
  await writeManifest(c.env.BUCKET, manifest);

  return json(
    {
      id: manifest.id,
      chunkSize: CHUNK_SIZE,
      files: files.map((f, index) => ({
        index,
        name: f.name,
        size: f.size,
        multipart: f.size > CHUNK_SIZE,
        parts: partCount(f.size, CHUNK_SIZE),
      })),
    },
    { status: 201 },
  );
}

async function loadForUpload(c: Ctx, id: string, indexParam: string): Promise<{ manifest: Manifest; file: FileEntry; index: number }> {
  await requireAuth(c);
  const manifest = isShareId(id) ? await readManifest(c.env.BUCKET, id) : null;
  if (!manifest) throw new HttpError(404, "Upload not found.");
  if (!isUploadOpen(manifest, c.now)) throw new HttpError(410, "This upload is closed. Please start a new transfer.");
  const index = Number(indexParam);
  const file = Number.isInteger(index) ? manifest.files[index] : undefined;
  if (!file) throw new HttpError(404, "File not found in this transfer.");
  return { manifest, file, index };
}

function contentLength(request: Request): number {
  const value = request.headers.get("Content-Length");
  if (value === null || !/^\d+$/.test(value)) throw new HttpError(411, "Content-Length is required.");
  return Number(value);
}

/** Single request upload for files up to one chunk. */
export async function putFile(c: Ctx, id: string, indexParam: string): Promise<Response> {
  const { file, index } = await loadForUpload(c, id, indexParam);
  if (file.size > CHUNK_SIZE) throw new HttpError(400, "This file is large; upload it in parts.");
  if (contentLength(c.request) !== file.size) throw new HttpError(400, "File size doesn't match what was announced.");
  await c.env.BUCKET.put(fileKey(id, index), file.size === 0 || !c.request.body ? "" : c.request.body, {
    httpMetadata: { contentType: file.type },
  });
  return json({ ok: true });
}

export async function startMultipart(c: Ctx, id: string, indexParam: string): Promise<Response> {
  const { file, index } = await loadForUpload(c, id, indexParam);
  if (file.size <= CHUNK_SIZE) throw new HttpError(400, "This file is small; upload it in one request.");
  const upload = await c.env.BUCKET.createMultipartUpload(fileKey(id, index), {
    httpMetadata: { contentType: file.type },
  });
  return json({ uploadId: upload.uploadId });
}

export async function putPart(c: Ctx, id: string, indexParam: string, partParam: string): Promise<Response> {
  const { file, index } = await loadForUpload(c, id, indexParam);
  const uploadId = c.url.searchParams.get("uploadId");
  if (!uploadId) throw new HttpError(400, "uploadId is required.");
  const partNumber = Number(partParam);
  const expected = expectedPartSize(file.size, CHUNK_SIZE, partNumber);
  if (expected < 0) throw new HttpError(400, "Invalid part number.");
  if (contentLength(c.request) !== expected || !c.request.body) {
    throw new HttpError(400, `Part ${partNumber} must be exactly ${expected} bytes.`);
  }
  const upload = c.env.BUCKET.resumeMultipartUpload(fileKey(id, index), uploadId);
  const part = await upload.uploadPart(partNumber, c.request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

export async function completeMultipart(c: Ctx, id: string, indexParam: string): Promise<Response> {
  const { file, index } = await loadForUpload(c, id, indexParam);
  const body = await readJson(c.request);
  if (!isRecord(body) || typeof body.uploadId !== "string" || !Array.isArray(body.parts)) {
    throw new HttpError(400, "Expected uploadId and parts.");
  }
  const count = partCount(file.size, CHUNK_SIZE);
  if (body.parts.length !== count) throw new HttpError(400, `Expected ${count} parts.`);
  const parts: R2UploadedPart[] = body.parts.map((p: unknown, i: number) => {
    if (!isRecord(p) || p.partNumber !== i + 1 || typeof p.etag !== "string" || p.etag.length > 256) {
      throw new HttpError(400, `Part ${i + 1} is invalid.`);
    }
    return { partNumber: i + 1, etag: p.etag };
  });

  const key = fileKey(id, index);
  const object = await c.env.BUCKET.resumeMultipartUpload(key, body.uploadId).complete(parts);
  if (object.size !== file.size) {
    await c.env.BUCKET.delete(key);
    throw new HttpError(400, "The uploaded file size doesn't match. Please try again.");
  }
  return json({ ok: true });
}

/** Checks every file arrived intact, then makes the transfer downloadable and starts the expiry clock. */
export async function finalizeTransfer(c: Ctx, id: string): Promise<Response> {
  await requireAuth(c);
  const manifest = isShareId(id) ? await readManifest(c.env.BUCKET, id) : null;
  if (!manifest) throw new HttpError(404, "Upload not found.");
  if (manifest.status === "ready") return json(publicView(manifest));
  if (!isUploadOpen(manifest, c.now)) throw new HttpError(410, "This upload is closed. Please start a new transfer.");

  const heads = await Promise.all(manifest.files.map((_, i) => c.env.BUCKET.head(fileKey(id, i))));
  const missing = manifest.files.flatMap((f, i) => (heads[i]?.size === f.size ? [] : [i]));
  if (missing.length > 0) {
    return json({ error: "Some files didn't finish uploading.", missing }, { status: 409 });
  }

  manifest.status = "ready";
  manifest.expiresAt = c.now + manifest.expiryDays * DAY_MS;
  await writeManifest(c.env.BUCKET, manifest);
  return json(publicView(manifest));
}

// ---------------------------------------------------------------------------
// Downloading and deleting (anyone with the link)

function publicView(m: Manifest) {
  return {
    id: m.id,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    totalBytes: m.totalBytes,
    files: m.files.map((f, index) => ({ index, name: f.name, size: f.size })),
  };
}

async function loadDownloadable(c: Ctx, id: string): Promise<Manifest> {
  const manifest = isShareId(id) ? await readManifest(c.env.BUCKET, id) : null;
  if (!manifest || !isDownloadable(manifest, c.now)) throw new HttpError(404, NOT_FOUND);
  return manifest;
}

export async function getTransfer(c: Ctx, id: string): Promise<Response> {
  return json(publicView(await loadDownloadable(c, id)));
}

export async function downloadFile(c: Ctx, id: string, indexParam: string): Promise<Response> {
  const manifest = await loadDownloadable(c, id);
  const index = Number(indexParam);
  const file = Number.isInteger(index) ? manifest.files[index] : undefined;
  if (!file) throw new HttpError(404, "File not found.");

  const key = fileKey(id, index);
  const headers = new Headers({
    "Content-Type": file.type,
    // Always a download, never rendered on this origin, even for HTML or SVG uploads.
    "Content-Disposition": attachmentDisposition(file.name),
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  });

  if (c.request.method === "HEAD") {
    const head = await c.env.BUCKET.head(key);
    if (!head) throw new HttpError(404, "File not found.");
    headers.set("Content-Length", String(head.size));
    headers.set("ETag", head.httpEtag);
    return new Response(null, { headers });
  }

  // Range support lets browsers and download managers resume large downloads.
  const rangeHeader = c.request.headers.get("Range");
  if (rangeHeader) {
    const head = await c.env.BUCKET.head(key);
    if (!head) throw new HttpError(404, "File not found.");
    const range = parseRange(rangeHeader, head.size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}` } });
    }
    if (range) {
      const object = await c.env.BUCKET.get(key, { range });
      if (!object) throw new HttpError(404, "File not found.");
      headers.set("ETag", object.httpEtag);
      headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
      headers.set("Content-Length", String(range.length));
      return new Response(object.body, { status: 206, headers });
    }
    // Unsupported range syntax (e.g. multiple ranges): fall through and send the whole file.
  }

  const object = await c.env.BUCKET.get(key);
  if (!object) throw new HttpError(404, "File not found.");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

export async function removeTransfer(c: Ctx, id: string): Promise<Response> {
  const manifest = isShareId(id) ? await readManifest(c.env.BUCKET, id) : null;
  if (!manifest) throw new HttpError(404, NOT_FOUND);
  await deleteTransfer(c.env.BUCKET, id);
  return json({ ok: true });
}
