import assert from "node:assert/strict";
import { test } from "node:test";
import { qrMatrix } from "../client/qr.ts";

// Decoding is checked by hand with an independent decoder; these tests guard the structure.

test("picks the smallest version that fits, up to version 10", () => {
  const size = (text: string) => qrMatrix(text)?.length;
  assert.equal(size("x".repeat(14)), 21); // version 1 holds 14 bytes at level M
  assert.equal(size("x".repeat(15)), 25);
  assert.equal(size("https://transfer.example.com/s#k7m2-qpx9-vtd4-8hrw"), 33); // version 3
  assert.equal(size("x".repeat(213)), 57); // version 10
  assert.equal(qrMatrix("x".repeat(214)), null);
});

test("has finder patterns in three corners and the dark module", () => {
  const m = qrMatrix("https://transfer.example.com/k7m2-qpx9-vtd4-8hrw")!;
  const n = m.length;
  const finder = (x0: number, y0: number) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(m[y0 + dy]![x0 + dx], ring !== 2, `finder at ${x0},${y0}`);
      }
    }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  assert.equal(m[n - 8]![8], true);
});

test("is deterministic", () => {
  assert.deepEqual(qrMatrix("same"), qrMatrix("same"));
});
