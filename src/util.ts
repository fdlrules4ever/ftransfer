// Pure helpers (no Workers-only APIs) so they can be unit tested under Node.

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s) as Uint8Array<ArrayBuffer>;
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
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

/** 128 random bits, base64url encoded: 22 characters. This is the share link's secret. */
export function newShareId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function isShareId(s: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(s);
}

/** Makes a user-supplied file name safe to store and to put in a header. Returns null if nothing usable is left. */
export function sanitizeFilename(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let name = input.split(/[\\/]/).pop() ?? "";
  name = name
    // control characters
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    // bidi overrides, which can disguise an extension ("invoice\u202Efdp.exe")
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, "")
    .trim();
  if (name === "" || name === "." || name === "..") return null;

  const chars = Array.from(name); // code points, so surrogate pairs stay intact
  const MAX = 200;
  if (chars.length > MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    const extLen = Array.from(ext).length;
    name = chars.slice(0, MAX - extLen).join("") + ext;
  }
  return name;
}

/** Content-Disposition that forces a download and keeps non-ASCII names intact (RFC 6266 / 5987). */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Accepts a plausible MIME type, otherwise falls back to a generic binary type. */
export function safeContentType(input: unknown): string {
  if (
    typeof input === "string" &&
    input.length <= 127 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input)
  ) {
    return input.toLowerCase();
  }
  return "application/octet-stream";
}

export function partCount(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Expected byte length of a 1-based multipart part. R2 needs equal parts except the last one. */
export function expectedPartSize(size: number, chunkSize: number, partNumber: number): number {
  const count = partCount(size, chunkSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) return -1;
  return partNumber < count ? chunkSize : size - chunkSize * (count - 1);
}

/**
 * Parses a single-range `Range: bytes=...` header against a known size.
 * Returns null for syntax we don't support (the caller then sends the full file).
 */
export function parseRange(
  header: string,
  size: number,
): { offset: number; length: number } | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

/** Decimal units (1 GB = 10^9 bytes), matching how storage is billed and how the cap is configured. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function parseDayList(input: string | undefined, fallback: number[]): number[] {
  const days = (input ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 365);
  return days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : fallback;
}

export function parsePositiveInt(input: string | undefined, fallback: number): number {
  const n = Number(input);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
