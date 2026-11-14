// QR code generator for share links (byte mode, error correction level M, versions 1–10, so up to
// 213 bytes). Small on purpose: share links are short ASCII, so the other modes and versions
// aren't needed. Follows ISO/IEC 18004; the structure mirrors Project Nayuki's reference encoder.
//
// No imports and no DOM in qrMatrix, so the unit tests can load this file directly in Node.

const MAX_VERSION = 10;
/** Error correction codewords per block, and number of blocks, for level M, indexed by version. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format information bits for level M. */
const ECL_BITS = 0;

/** Returns the modules (true = dark), row by row, without the quiet zone. Null if the text is too long. */
export function qrMatrix(text: string): boolean[][] | null {
  const data = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + data.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > MAX_VERSION) return null;

  // Data bits: byte mode, length, the bytes, a terminator, then padding to fill the capacity.
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  const capacity = dataCodewords(version) * 8;
  push(0b0100, 4);
  push(data.length, version <= 9 ? 8 : 16);
  for (const b of data) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  const qr = new Matrix(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(codewords, version));

  // Pick the mask with the lowest penalty (applying a mask twice undoes it).
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const penalty = qr.penalty();
    if (penalty < bestPenalty) {
      best = mask;
      bestPenalty = penalty;
    }
    qr.applyMask(mask);
  }
  qr.applyMask(best);
  qr.drawFormatBits(best);
  return qr.modules;
}

/** An SVG of the QR code with a 4-module quiet zone, or null if the text is too long. */
export function qrSvg(text: string): SVGSVGElement | null {
  const modules = qrMatrix(text);
  if (!modules) return null;
  const border = 4;
  const size = modules.length + border * 2;
  let d = "";
  modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + border} ${y + border}h1v1h-1z`)));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}

// ---------------------------------------------------------------------------

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version]! * NUM_BLOCKS[version]!;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// Reed–Solomon over GF(2^8) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)));
  }
  return result;
}

/** Splits the data into blocks, adds error correction to each, and interleaves them. */
function addEccAndInterleave(data: number[], version: number): number[] {
  const numBlocks = NUM_BLOCKS[version]!;
  const eccLen = ECC_PER_BLOCK[version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      // Skip the placeholder byte in the short blocks.
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  readonly version: number;

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    // Finder patterns, with their separators.
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) this.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((cx, i) =>
      positions.forEach((cy, j) => {
        // Not where the finder patterns are.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }),
    );
    this.drawFormatBits(0); // placeholder, so the area counts as a function pattern
    this.drawVersion();
  }

  drawFormatBits(mask: number): void {
    const data = (ECL_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const size = this.size;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true); // the dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** Places the codewords in the zigzag order, two columns at a time from the bottom right. */
  drawCodewords(codewords: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing pattern
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert && !this.isFunction[y]![x]) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** The standard's penalty score: runs, 2×2 blocks, finder-like patterns and dark/light balance. */
  penalty(): number {
    const size = this.size;
    const m = this.modules;
    let result = 0;
    const lines: boolean[][] = [...m, ...m.map((_, x) => m.map((row) => row[x]!))];
    const finderLike = [true, false, true, true, true, false, true];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) result += run - 2;
          run = 1;
        }
      }
      for (let i = 0; i + 7 <= size; i++) {
        if (!finderLike.every((v, k) => line[i + k] === v)) continue;
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
        const lightAfter = i + 11 <= size && [7, 8, 9, 10].every((k) => !line[i + k]);
        if (lightBefore || lightAfter) result += 40;
      }
    }
    for (let y = 0; y + 1 < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3;
      }
    }
    const dark = m.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}
