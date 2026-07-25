/*
 * Minimal QR encoder, used only to print the doctor's phone URL on the
 * console at startup. Written in-repo because the zero-dependency rule
 * applies to niceties too.
 *
 * Scope is deliberately narrow: byte mode, error-correction level L,
 * versions 1-5 (a single error-correction block, no interleaving). That
 * caps the payload at 106 bytes - several times any LAN URL - and keeps
 * the whole encoder small enough to read. Structure follows ISO/IEC 18004.
 */

'use strict';

/* ---------- GF(256) arithmetic for Reed-Solomon ---------- */

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

/* Remainder of the data polynomial divided by the RS generator for nEcc. */
function rsEcc(data, nEcc) {
  let gen = [1];
  for (let i = 0; i < nEcc; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];                   // times x
      next[j + 1] ^= gmul(gen[j], EXP[i]); // times alpha^i
    }
    gen = next;
  }
  const res = new Uint8Array(nEcc);
  for (const b of data) {
    const factor = b ^ res[0];
    res.copyWithin(0, 1);
    res[nEcc - 1] = 0;
    if (factor) for (let j = 0; j < nEcc; j++) res[j] ^= gmul(gen[j + 1], factor);
  }
  return Array.from(res);
}

/* ---------- bit stream ---------- */

// versions 1-5 at level L: data codewords and ecc codewords per symbol
const DATA_BYTES = [19, 34, 55, 80, 108];
const ECC_BYTES = [7, 10, 15, 20, 26];

function codewordsFor(bytes) {
  let version = 0;
  // 4-bit mode + 8-bit length header round up to two extra codewords
  while (version < DATA_BYTES.length && bytes.length > DATA_BYTES[version] - 2) version++;
  if (version >= DATA_BYTES.length) throw new Error('text too long for a small QR');

  const nData = DATA_BYTES[version];
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

  push(4, 4);                 // byte mode
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, nData * 8 - bits.length));   // terminator
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xEC; data.length < nData; pad ^= 0xFD) data.push(pad); // EC 11 EC 11 ...

  return { version: version + 1, codewords: data.concat(rsEcc(data, ECC_BYTES[version])) };
}

/* ---------- matrix ---------- */

// 15-bit format info: level L (01) + mask, BCH-protected, standard XOR mask
function formatBits(mask) {
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r * c) % 2 + (r * c) % 3 === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
  }
}

function penalty(m) {
  const s = m.length;
  let pen = 0;

  const runs = get => {          // rule 1: runs of 5+ same-colour modules
    for (let a = 0; a < s; a++) {
      let run = 1;
      for (let b = 1; b <= s; b++) {
        if (b < s && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) pen += run - 2; run = 1; }
      }
    }
  };
  runs((a, b) => m[a][b]);
  runs((a, b) => m[b][a]);

  for (let r = 0; r < s - 1; r++)   // rule 2: 2x2 blocks of one colour
    for (let c = 0; c < s - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) pen += 3;

  const finderish = get => {        // rule 3: finder-lookalike sequences
    for (let a = 0; a < s; a++) {
      let line = '';
      for (let b = 0; b < s; b++) line += get(a, b);
      for (const pat of ['10111010000', '00001011101']) {
        for (let i = line.indexOf(pat); i !== -1; i = line.indexOf(pat, i + 1)) pen += 40;
      }
    }
  };
  finderish((a, b) => m[a][b]);
  finderish((a, b) => m[b][a]);

  let dark = 0;                     // rule 4: dark/light balance
  for (const row of m) for (const v of row) dark += v;
  pen += 10 * Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5);
  return pen;
}

/* Returns a 2D array of 0 (light) / 1 (dark) modules, quiet zone not included. */
function qrMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const { version, codewords } = codewordsFor(bytes);
  const size = 4 * version + 17;

  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fun = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => { m[r][c] = dark ? 1 : 0; fun[r][c] = true; };

  // finder patterns with their separators, clipped at the edges
  for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = cr + dr, c = cc + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(r, c, dist <= 3 && dist !== 2);
      }
    }
  }

  if (version >= 2) {               // one alignment pattern on small versions
    const a = 4 * version + 10;
    for (let dr = -2; dr <= 2; dr++)
      for (let dc = -2; dc <= 2; dc++)
        set(a + dr, a + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }

  for (let i = 8; i < size - 8; i++) {   // timing patterns
    if (!fun[6][i]) set(6, i, i % 2 === 0);
    if (!fun[i][6]) set(i, 6, i % 2 === 0);
  }

  const drawFormat = mask => {
    const bits = formatBits(mask);
    const bit = i => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
    set(7, 8, bit(6)); set(8, 8, bit(7)); set(8, 7, bit(8));
    for (let i = 9; i <= 14; i++) set(8, 14 - i, bit(i));
    for (let i = 0; i <= 7; i++) set(8, size - 1 - i, bit(i));
    for (let i = 8; i <= 14; i++) set(size - 15 + i, 8, bit(i));
    set(size - 8, 8, 1);            // the always-dark module
  };
  drawFormat(0);                    // reserves the format areas before data placement

  // data bits, zigzagged upward/downward in two-module columns from the right
  let bitIndex = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;     // the vertical timing pattern is skipped whole
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!fun[r][c] && bitIndex < total) {
          m[r][c] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
      }
    }
  }

  const applyMask = mask => {
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!fun[r][c] && maskBit(mask, r, c)) m[r][c] ^= 1;
  };

  let best = 0, bestPen = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(m);
    if (p < bestPen) { bestPen = p; best = mask; }
    applyMask(mask);                // XOR is its own undo
  }
  applyMask(best);
  drawFormat(best);
  return m;
}

module.exports = { qrMatrix };
