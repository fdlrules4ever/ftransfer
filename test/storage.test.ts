import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanupExpired,
  cleanupExpiredLinks,
  cleanupExpiredSecrets,
  isExpired,
  isExpiredAt,
  linksExist,
  linksKey,
  readLinks,
  secretKey,
  takeSecret,
  UPLOAD_WINDOW_MS,
  writeLinks,
  writeSecret,
  type LinksRecord,
  type ManifestSummary,
  type SecretRecord,
} from "../src/storage.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 12);

test("expiry rules", () => {
  const ready = (expiresAt: number | null): ManifestSummary => ({ id: "x", status: "ready", createdAt: NOW - DAY, expiresAt, totalBytes: 1 });
  assert.equal(isExpired(ready(NOW + 1), NOW), false);
  assert.equal(isExpired(ready(NOW), NOW), true);
  assert.equal(isExpired(ready(null), NOW), true);

  const uploading = (createdAt: number): ManifestSummary => ({ id: "x", status: "uploading", createdAt, expiresAt: null, totalBytes: 1 });
  assert.equal(isExpired(uploading(NOW - UPLOAD_WINDOW_MS + 1000), NOW), false);
  assert.equal(isExpired(uploading(NOW - UPLOAD_WINDOW_MS), NOW), true);
});

/** Just enough of R2Bucket for list + delete. */
function fakeBucket(objects: Map<string, Record<string, string>>) {
  return {
    async list(opts: { prefix?: string }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      return {
        objects: keys.map((key) => ({ key, customMetadata: objects.get(key), uploaded: new Date(NOW) })),
        truncated: false,
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  } as unknown as R2Bucket;
}

test("cleanup deletes expired and abandoned transfers, keeps active ones", async () => {
  const objects = new Map<string, Record<string, string>>([
    ["manifests/active.json", { status: "ready", createdAt: String(NOW - DAY), expiresAt: String(NOW + DAY), totalBytes: "10" }],
    ["files/active/0", {}],
    ["manifests/expired.json", { status: "ready", createdAt: String(NOW - 8 * DAY), expiresAt: String(NOW - 1), totalBytes: "10" }],
    ["files/expired/0", {}],
    ["files/expired/1", {}],
    ["manifests/abandoned.json", { status: "uploading", createdAt: String(NOW - 2 * DAY), expiresAt: "", totalBytes: "10" }],
    ["files/abandoned/0", {}],
    ["manifests/inprogress.json", { status: "uploading", createdAt: String(NOW - 60_000), expiresAt: "", totalBytes: "10" }],
  ]);
  const result = await cleanupExpired(fakeBucket(objects), NOW);
  assert.deepEqual(result.deleted.sort(), ["abandoned", "expired"]);
  assert.equal(result.remaining, false);
  assert.deepEqual([...objects.keys()].sort(), ["files/active/0", "manifests/active.json", "manifests/inprogress.json"]);
});

test("cleanup respects its per-run budget", async () => {
  const objects = new Map<string, Record<string, string>>();
  for (let i = 0; i < 5; i++) {
    objects.set(`manifests/t${i}.json`, { status: "ready", createdAt: "1", expiresAt: "2", totalBytes: "1" });
  }
  const result = await cleanupExpired(fakeBucket(objects), NOW, 3);
  assert.equal(result.deleted.length, 3);
  assert.equal(result.remaining, true);
  assert.equal(objects.size, 2);
});

// ---------------------------------------------------------------------------
// Secrets

test("secret and link expiry treats missing or unparseable dates as expired", () => {
  assert.equal(isExpiredAt(NOW + 1, NOW), false);
  assert.equal(isExpiredAt(NOW, NOW), true);
  assert.equal(isExpiredAt(Number(undefined), NOW), true);
  assert.equal(isExpiredAt(Number("0"), NOW), true);
});

test("secret cleanup deletes expired secrets and tombstones only", async () => {
  const objects = new Map<string, Record<string, string>>([
    ["secrets/live.json", { expiresAt: String(NOW + 60_000), oneTime: "1" }],
    ["secrets/old.json", { expiresAt: String(NOW - 1), oneTime: "0" }],
    ["secrets/tombstone.json", { expiresAt: "0", oneTime: "1" }],
    ["secrets/nometa.json", {}],
    ["manifests/unrelated.json", { status: "ready", createdAt: "1", expiresAt: "2", totalBytes: "1" }],
  ]);
  const result = await cleanupExpiredSecrets(fakeBucket(objects), NOW);
  assert.deepEqual(result, { deleted: 3, remaining: false });
  assert.deepEqual([...objects.keys()].sort(), ["manifests/unrelated.json", "secrets/live.json"]);
});

test("secret cleanup respects its per-run budget", async () => {
  const objects = new Map<string, Record<string, string>>();
  for (let i = 0; i < 5; i++) objects.set(`secrets/s${i}.json`, { expiresAt: "1" });
  const result = await cleanupExpiredSecrets(fakeBucket(objects), NOW, 2);
  assert.deepEqual(result, { deleted: 2, remaining: true });
  assert.equal(objects.size, 3);
});

test("link cleanup deletes expired links only, and leaves secrets alone", async () => {
  const objects = new Map<string, Record<string, string>>([
    ["links/live.json", { expiresAt: String(NOW + 60_000) }],
    ["links/old.json", { expiresAt: String(NOW - 1) }],
    ["links/nometa.json", {}],
    ["secrets/old.json", { expiresAt: String(NOW - 1) }],
  ]);
  const result = await cleanupExpiredLinks(fakeBucket(objects), NOW);
  assert.deepEqual(result, { deleted: 2, remaining: false });
  assert.deepEqual([...objects.keys()].sort(), ["links/live.json", "secrets/old.json"]);
});

/** Just enough of R2Bucket for head / get / conditional put / delete, with etags that change on every write. */
function fakeSecretBucket() {
  const store = new Map<string, { body: string; etag: string; meta: Record<string, string> }>();
  let version = 0;
  const bucket = {
    async head(key: string) {
      const o = store.get(key);
      return o ? { etag: o.etag, customMetadata: o.meta } : null;
    },
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return { etag: o.etag, customMetadata: o.meta, json: async () => JSON.parse(o.body), text: async () => o.body };
    },
    async put(key: string, body: string, opts: { onlyIf?: { etagMatches?: string }; customMetadata?: Record<string, string> } = {}) {
      const current = store.get(key);
      if (opts.onlyIf?.etagMatches !== undefined && current?.etag !== opts.onlyIf.etagMatches) return null;
      store.set(key, { body, etag: `v${++version}`, meta: opts.customMetadata ?? {} });
      return { key };
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { store, bucket: bucket as unknown as R2Bucket };
}

const secret = (id: string, oneTime: boolean, expiresAt = NOW + 60_000): SecretRecord => ({
  v: 1,
  id,
  createdAt: NOW,
  expiresAt,
  oneTime,
  iv: "iv",
  ciphertext: "ct",
});

test("a one-time secret is handed out once, even when two requests race for it", async () => {
  const { store, bucket } = fakeSecretBucket();
  await writeSecret(bucket, secret("once", true));
  const results = await Promise.all([takeSecret(bucket, "once", NOW), takeSecret(bucket, "once", NOW)]);
  assert.equal(results.filter((r) => r !== null).length, 1);
  assert.equal(store.has(secretKey("once")), false);
  assert.equal(await takeSecret(bucket, "once", NOW), null);
});

test("a reusable secret can be revealed repeatedly; expired secrets are removed", async () => {
  const { store, bucket } = fakeSecretBucket();
  await writeSecret(bucket, secret("multi", false));
  assert.equal((await takeSecret(bucket, "multi", NOW))?.id, "multi");
  assert.equal((await takeSecret(bucket, "multi", NOW))?.id, "multi");

  await writeSecret(bucket, secret("stale", false, NOW - 1));
  assert.equal(await takeSecret(bucket, "stale", NOW), null);
  assert.equal(store.has(secretKey("stale")), false);
});

// ---------------------------------------------------------------------------
// Links

const links = (id: string, expiresAt = NOW + 60_000): LinksRecord => ({ v: 1, id, createdAt: NOW, expiresAt, iv: "iv", ciphertext: "ct" });

test("links can be read any number of times until they expire; expired links are removed on read", async () => {
  const { store, bucket } = fakeSecretBucket();
  await writeLinks(bucket, links("live"));
  assert.equal(store.get(linksKey("live"))?.meta.expiresAt, String(NOW + 60_000));
  for (let i = 0; i < 3; i++) assert.equal((await readLinks(bucket, "live", NOW))?.id, "live");
  assert.equal(await linksExist(bucket, "live", NOW), true);
  assert.equal(await linksExist(bucket, "missing", NOW), false);

  await writeLinks(bucket, links("stale", NOW - 1));
  assert.equal(await linksExist(bucket, "stale", NOW), false);
  assert.equal(await readLinks(bucket, "stale", NOW), null);
  assert.equal(store.has(linksKey("stale")), false);
});
