// End-to-end smoke test against a running `wrangler dev` (or any deployment).
//   pnpm dev           (in one terminal)
//   pnpm smoke         (in another)
// Env: BASE_URL (default http://localhost:8787), UPLOAD_PASSWORD (default: read from .dev.vars)

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const PASSWORD = process.env.UPLOAD_PASSWORD ?? readDevVar("UPLOAD_PASSWORD");
const COOKIE_NAME = BASE.startsWith("https:") ? "__Host-ft_session" : "ft_session";

function readDevVar(name: string): string {
  const line = readFileSync(".dev.vars", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in .dev.vars`);
  return line.slice(name.length + 1).trim();
}

let cookie = "";

async function req(method: string, path: string, body?: BodyInit | object, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { Origin: BASE, ...headers };
  if (cookie) h.Cookie = cookie;
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array || typeof body === "string") payload = body as BodyInit;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  return fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.log(`  ✘ ${name}`);
    throw err;
  }
}

console.log(`Smoke test against ${BASE}`);

await step("upload page is served with security headers", async () => {
  const res = await req("GET", "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Drop files here/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
});

await step("unknown paths return 404", async () => {
  const res = await req("GET", "/nope");
  assert.equal(res.status, 404);
});

await step("anonymous session is not authenticated", async () => {
  const res = await req("GET", "/api/session");
  const data = (await res.json()) as { authenticated: boolean; configured: boolean };
  assert.equal(data.authenticated, false);
  assert.equal(data.configured, true);
});

await step("uploading without login is refused", async () => {
  const res = await req("POST", "/api/transfers", { files: [{ name: "a", size: 1 }] });
  assert.equal(res.status, 401);
});

await step("wrong passphrase is refused", async () => {
  const res = await req("POST", "/api/login", { password: "definitely wrong" });
  assert.equal(res.status, 401);
});

await step("cross-origin login is refused", async () => {
  const res = await req("POST", "/api/login", { password: PASSWORD }, { Origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

await step("correct passphrase sets an HttpOnly session cookie", async () => {
  const res = await req("POST", "/api/login", { password: PASSWORD });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0]!;
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
});

type Limits = { chunkSize: number; maxTotalBytes: number; expiryDays: number[] };
let limits!: Limits;
await step("session reports limits and usage", async () => {
  const data = (await (await req("GET", "/api/session")).json()) as { authenticated: boolean; limits: Limits; usage: { freeBytes: number } };
  assert.equal(data.authenticated, true);
  limits = data.limits;
  assert.ok(limits.chunkSize >= 5 * 1024 * 1024);
  assert.ok(data.usage.freeBytes > 0);
});

await step("a transfer larger than the cap is refused", async () => {
  const res = await req("POST", "/api/transfers", { expiryDays: 7, files: [{ name: "huge.bin", size: limits.maxTotalBytes + 1 }] });
  assert.equal(res.status, 413);
});

const small = randomBytes(1234);
const empty = new Uint8Array(0);
const big = randomBytes(limits.chunkSize * 2 + 54321); // 3 parts
const files = [
  { name: "hello €.txt", bytes: small, type: "text/plain" },
  { name: "empty.dat", bytes: empty, type: "" },
  { name: "big.bin", bytes: big, type: "application/octet-stream" },
];

let id = "";
let created!: { id: string; chunkSize: number; files: { index: number; multipart: boolean; parts: number }[] };
await step("create transfer", async () => {
  const res = await req("POST", "/api/transfers", {
    expiryDays: 1,
    files: files.map((f) => ({ name: f.name, size: f.bytes.length, type: f.type })),
  });
  assert.equal(res.status, 201, await res.clone().text());
  created = (await res.json()) as typeof created;
  id = created.id;
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(created.files.map((f) => f.multipart), [false, false, true]);
  assert.equal(created.files[2]!.parts, 3);
});

await step("transfer is not visible before it is finalized", async () => {
  assert.equal((await req("GET", `/api/transfers/${id}`)).status, 404);
});

await step("upload small and empty files", async () => {
  for (const i of [0, 1]) {
    const res = await req("PUT", `/api/transfers/${id}/files/${i}`, files[i]!.bytes);
    assert.equal(res.status, 200, await res.clone().text());
  }
});

await step("finalize refuses while files are missing", async () => {
  const res = await req("POST", `/api/transfers/${id}/finalize`);
  assert.equal(res.status, 409);
  assert.deepEqual(((await res.json()) as { missing: number[] }).missing, [2]);
});

await step("upload large file in parts", async () => {
  const base = `/api/transfers/${id}/files/2`;
  const { uploadId } = (await (await req("POST", `${base}/multipart`)).json()) as { uploadId: string };
  assert.ok(uploadId);

  const wrong = await req("PUT", `${base}/parts/1?uploadId=${encodeURIComponent(uploadId)}`, big.subarray(0, 100));
  assert.equal(wrong.status, 400, "a part with the wrong size must be refused");

  const parts: { partNumber: number; etag: string }[] = [];
  await Promise.all(
    [1, 2, 3].map(async (n) => {
      const chunk = big.subarray((n - 1) * created.chunkSize, Math.min(n * created.chunkSize, big.length));
      const res = await req("PUT", `${base}/parts/${n}?uploadId=${encodeURIComponent(uploadId)}`, chunk);
      assert.equal(res.status, 200, await res.clone().text());
      parts[n - 1] = (await res.json()) as { partNumber: number; etag: string };
    }),
  );
  const done = await req("POST", `${base}/complete`, { uploadId, parts });
  assert.equal(done.status, 200, await done.clone().text());
});

await step("finalize makes the transfer downloadable", async () => {
  const res = await req("POST", `/api/transfers/${id}/finalize`);
  assert.equal(res.status, 200, await res.clone().text());
  const data = (await res.json()) as { expiresAt: number };
  const day = 24 * 3600 * 1000;
  assert.ok(Math.abs(data.expiresAt - (Date.now() + day)) < 60_000);
});

cookie = ""; // everything below is what a recipient (no login) can do

await step("share page and metadata are public with the link", async () => {
  const page = await req("GET", `/${id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Files shared with you/);
  const data = (await (await req("GET", `/api/transfers/${id}`)).json()) as { files: { name: string; size: number }[] };
  assert.deepEqual(data.files.map((f) => f.name), files.map((f) => f.name));
});

await step("downloads are byte-identical and forced as attachments", async () => {
  for (const [i, f] of files.entries()) {
    const res = await req("GET", `/api/transfers/${id}/files/${i}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(sha(body), sha(f.bytes), `${f.name} differs`);
  }
});

await step("range requests (resumable downloads)", async () => {
  const res = await req("GET", `/api/transfers/${id}/files/2`, undefined, { Range: "bytes=100-199" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 100-199/${big.length}`);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(big.subarray(100, 200)));
  const tail = await req("GET", `/api/transfers/${id}/files/2`, undefined, { Range: "bytes=-10" });
  assert.equal(tail.status, 206);
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), new Uint8Array(big.subarray(big.length - 10)));
  const beyond = await req("GET", `/api/transfers/${id}/files/2`, undefined, { Range: `bytes=${big.length}-` });
  assert.equal(beyond.status, 416);
});

await step("a guessed id is not found", async () => {
  assert.equal((await req("GET", `/api/transfers/${"A".repeat(22)}`)).status, 404);
});

await step("recipient can delete; the link stops working", async () => {
  const res = await req("DELETE", `/api/transfers/${id}`);
  assert.equal(res.status, 200);
  assert.equal((await req("GET", `/api/transfers/${id}`)).status, 404);
  assert.equal((await req("GET", `/api/transfers/${id}/files/0`)).status, 404);
});

console.log("All smoke tests passed.");
