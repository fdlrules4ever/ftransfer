import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentDisposition,
  base64url,
  base64urlDecode,
  expectedPartSize,
  formatBytes,
  isShareId,
  newShareId,
  parseDayList,
  parseIntList,
  parseRange,
  partCount,
  safeContentType,
  sanitizeFilename,
} from "../src/util.ts";

test("share ids are 22 url-safe chars and unique", () => {
  const ids = new Set(Array.from({ length: 1000 }, newShareId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.ok(isShareId(id), id);
  assert.equal(isShareId("short"), false);
  assert.equal(isShareId("a".repeat(21) + "/"), false);
  assert.equal(isShareId("styles.css"), false);
});

test("base64url round trip", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  assert.deepEqual(base64urlDecode(base64url(bytes)), bytes);
  assert.equal(base64urlDecode("not base64!"), null);
});

test("sanitizeFilename strips paths, control and bidi characters", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Users\\me\\photo.jpg"), "photo.jpg");
  assert.equal(sanitizeFilename("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(sanitizeFilename("invoice\u202Efdp.exe"), "invoicefdp.exe");
  assert.equal(sanitizeFilename("  spaced.txt  "), "spaced.txt");
  assert.equal(sanitizeFilename(".."), null);
  assert.equal(sanitizeFilename(""), null);
  assert.equal(sanitizeFilename(42), null);
});

test("sanitizeFilename truncates long names but keeps the extension", () => {
  const name = sanitizeFilename("x".repeat(500) + ".tar.gz")!;
  assert.equal(Array.from(name).length, 200);
  assert.ok(name.endsWith(".gz"));
  const emoji = sanitizeFilename("😀".repeat(300) + ".png")!;
  assert.equal(Array.from(emoji).length, 200);
  assert.ok(emoji.endsWith(".png"));
});

test("attachmentDisposition always forces a download and encodes unicode", () => {
  assert.equal(attachmentDisposition("a.txt"), `attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
  const header = attachmentDisposition('Prijs "€100" (v2).pdf');
  assert.ok(header.startsWith("attachment;"));
  assert.ok(header.includes(`filename="Prijs __100_ (v2).pdf"`));
  assert.ok(header.includes("filename*=UTF-8''Prijs%20%22%E2%82%AC100%22%20%28v2%29.pdf"));
});

test("safeContentType", () => {
  assert.equal(safeContentType("image/PNG"), "image/png");
  assert.equal(safeContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(safeContentType(""), "application/octet-stream");
  assert.equal(safeContentType("text/html\r\nX-Evil: 1"), "application/octet-stream");
  assert.equal(safeContentType(undefined), "application/octet-stream");
});

test("multipart part sizes", () => {
  const chunk = 10;
  assert.equal(partCount(0, chunk), 1);
  assert.equal(partCount(10, chunk), 1);
  assert.equal(partCount(11, chunk), 2);
  assert.equal(expectedPartSize(25, chunk, 1), 10);
  assert.equal(expectedPartSize(25, chunk, 2), 10);
  assert.equal(expectedPartSize(25, chunk, 3), 5);
  assert.equal(expectedPartSize(30, chunk, 3), 10);
  assert.equal(expectedPartSize(25, chunk, 4), -1);
  assert.equal(expectedPartSize(25, chunk, 0), -1);
  assert.equal(expectedPartSize(25, chunk, 1.5), -1);
});

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { offset: 0, length: 100 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { offset: 900, length: 100 });
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { offset: 900, length: 100 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { offset: 900, length: 100 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { offset: 0, length: 1000 });
  assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=50-10", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-6", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
  assert.equal(parseRange("bytes=-", 1000), null);
});

test("parseDayList", () => {
  assert.deepEqual(parseDayList("7, 1,30,7", [9]), [1, 7, 30]);
  assert.deepEqual(parseDayList("abc", [9]), [9]);
  assert.deepEqual(parseDayList(undefined, [9]), [9]);
});

test("parseIntList drops values above the maximum", () => {
  assert.deepEqual(parseIntList("1,24,168,169,720", [24], 168), [1, 24, 168]);
  assert.deepEqual(parseIntList("720", [24], 168), [24]);
  assert.deepEqual(parseIntList("0,-1,1.5", [24], 168), [24]);
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1500), "1.50 KB");
  assert.equal(formatBytes(9_500_000_000), "9.50 GB");
  assert.equal(formatBytes(123_400_000), "123 MB");
});
