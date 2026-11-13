export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/** Reads a small JSON body, refusing anything larger than `maxBytes`. */
export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "Request too large.");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Adds security headers to every response. A response may set its own (stricter) CSP first. */
export function withSecurityHeaders(response: Response, https: boolean): Response {
  const res = new Response(response.body, response);
  const h = res.headers;
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", PAGE_CSP);
  // The share link is the secret, so never leak it to other sites through the Referer header.
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (https) h.set("Strict-Transport-Security", "max-age=31536000");
  return res;
}

/**
 * CSRF guard for state-changing requests: browsers always send Origin / Sec-Fetch-Site
 * on cross-site POST/PUT/DELETE, so anything that says "not us" is rejected.
 */
export function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) throw new HttpError(403, "Cross-origin request refused.");
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-origin request refused.");
  }
}
