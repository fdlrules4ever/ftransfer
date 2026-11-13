import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupExpired, isExpired, UPLOAD_WINDOW_MS, type ManifestSummary } from "../src/storage.ts";

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
