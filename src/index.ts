import { assertSameOrigin, errorJson, HttpError, withSecurityHeaders } from "./http.ts";
import { cleanupExpired } from "./storage.ts";
import {
  completeMultipart,
  createTransfer,
  downloadFile,
  finalizeTransfer,
  getSession,
  getTransfer,
  login,
  logout,
  putFile,
  putPart,
  removeTransfer,
  startMultipart,
  type Ctx,
} from "./transfers.ts";
import { isShareId } from "./util.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const c: Ctx = { request, env, url, https: url.protocol === "https:", now: Date.now() };
    let response: Response;
    try {
      response = url.pathname.startsWith("/api/") ? await routeApi(c) : await routePage(c);
    } catch (err) {
      if (err instanceof HttpError) {
        response = errorJson(err.status, err.message);
      } else {
        console.error(JSON.stringify({ event: "error", path: url.pathname.split("/").slice(0, 3).join("/"), error: String(err) }));
        response = errorJson(500, "Something went wrong. Please try again.");
      }
    }
    return withSecurityHeaders(response, c.https);
  },

  async scheduled(_controller, env): Promise<void> {
    const { deleted, remaining } = await cleanupExpired(env.BUCKET, Date.now());
    console.log(JSON.stringify({ event: "cleanup", deleted: deleted.length, remaining }));
  },
} satisfies ExportedHandler<Env>;

async function routeApi(c: Ctx): Promise<Response> {
  const method = c.request.method;
  if (method !== "GET" && method !== "HEAD") assertSameOrigin(c.request, c.url);

  // ["api", "transfers", id, "files", index, ...]
  const s = c.url.pathname.split("/").filter(Boolean).slice(1);
  const route = `${method} ${s.map((part, i) => (i === 1 || i === 3 || i === 5 ? ":" : part)).join("/")}`;
  const [, id = "", , index = "", , part = ""] = s;

  switch (route) {
    case "GET session":
      return getSession(c);
    case "POST login":
      return login(c);
    case "POST logout":
      return logout(c);

    case "POST transfers":
      return createTransfer(c);
    case "GET transfers/:":
      return getTransfer(c, id);
    case "DELETE transfers/:":
      return removeTransfer(c, id);
    case "POST transfers/:/finalize":
      return finalizeTransfer(c, id);

    case "PUT transfers/:/files/:":
      return putFile(c, id, index);
    case "GET transfers/:/files/:":
    case "HEAD transfers/:/files/:":
      return downloadFile(c, id, index);
    case "POST transfers/:/files/:/multipart":
      return startMultipart(c, id, index);
    case "PUT transfers/:/files/:/parts/:":
      return putPart(c, id, index, part);
    case "POST transfers/:/files/:/complete":
      return completeMultipart(c, id, index);
  }
  throw new HttpError(404, "Not found.");
}

async function routePage(c: Ctx): Promise<Response> {
  const { request, url, env } = c;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const path = url.pathname;
  if (path === "/") return page(c, "/index.html", 200);
  if (isShareId(path.slice(1))) return page(c, "/share.html", 200);

  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return page(c, "/404.html", 404);
  return asset;
}

async function page(c: Ctx, assetPath: string, status: number): Promise<Response> {
  const asset = await c.env.ASSETS.fetch(new Request(new URL(assetPath, c.url), { method: c.request.method }));
  const res = new Response(asset.body, { status, headers: asset.headers });
  res.headers.set("Cache-Control", "no-store");
  res.headers.delete("ETag");
  return res;
}
