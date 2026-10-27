// QR コードを、ブラウザの中だけで作る小さな部品（マイページの［スマホに保存する］。設計 4.9「QR はブラウザの中で作る。外部のサービスに URL を送らない」）。
// 範囲：バイトモードだけ・型番 1〜10（誤り訂正のレベル L・M・Q・H）。保存用のリンク（約 85 文字）は型番 5〜6（M）に収まる。入りきらない文字列は例外にする。
// 仕組みは ISO/IEC 18004 のとおり（リード・ソロモン符号・8 種のマスクの減点の比べ・形式情報・型番情報）。外のライブラリは使わない。
// 試験：scripts/qr_code_nodetest.mjs（構造の確かめと、決まった文字列の行列の指紋）。実際に読めることは、別のデコーダ（OpenCV）で全型番・全レベルを確かめた（MANIFEST）。
// 出力は行列（true＝黒）と、<img src> に入れる data URL。画面に出すときは innerHTML に入れず、<img> の src に入れる（CSP の img-src data: で通る）。

// 型番ごとの全コード語数
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
// 位置あわせの模様の中心の座標
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
// 誤り訂正のレベルごと：[ブロックあたりの誤り訂正語数, 前半のブロック数, 前半の 1 ブロックのデータ語数, 後半のブロック数, 後半の 1 ブロックのデータ語数]。型番 1〜10
const EC_TABLE = {
  L: [null, [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
  M: [null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
  Q: [null, [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
  H: [null, [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
};
// 形式情報に入れるレベルの 2 ビット
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
export const MAX_VERSION = 10;

// ---- GF(256)（既約多項式 0x11D）----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 誤り訂正語数 n の生成多項式（最高次の係数 1 を除く n 個の係数） */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** データ語列の誤り訂正語（リード・ソロモン符号の余り） */
function reedSolomon(data, n) {
  const gen = generator(n);
  const rem = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i += 1) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

function dataCodewords(version, ecc) {
  const [, g1, d1, g2, d2] = EC_TABLE[ecc][version];
  return g1 * d1 + g2 * d2;
}

function utf8(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

/** 文字列 → データ語列（バイトモード・終端・詰め物まで）と型番。入らなければ例外 */
function encodeData(text, ecc) {
  const bytes = utf8(text);
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewords(version, ecc) * 8;
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 > capacityBits) continue;
    const bits = [];
    const put = (value, len) => {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    };
    put(0b0100, 4);
    put(bytes.length, countBits);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let pad = 0xec; out.length < capacityBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
    return { version, codewords: out };
  }
  throw new RangeError(`QR コードに入りきりません（${bytes.length} バイト。型番 ${MAX_VERSION} のレベル ${ecc} は ${dataCodewords(MAX_VERSION, ecc) - 3} バイトまで）`);
}

/** データ語列 → ブロックに分けて誤り訂正語を付け、交互に並べた全コード語 */
function interleave(version, ecc, data) {
  const [ecLen, g1, d1, g2, d2] = EC_TABLE[ecc][version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1 + g2; i += 1) {
    const size = i < g1 ? d1 : d2;
    const chunk = data.slice(at, at + size);
    at += size;
    blocks.push({ data: chunk, ec: reedSolomon(chunk, ecLen) });
  }
  const out = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  if (out.length !== TOTAL_CODEWORDS[version]) throw new Error("QR の符号語の数が合いません");
  return out;
}

const bit = (v, i) => ((v >>> i) & 1) === 1;

/** 模様（探索・位置あわせ・タイミング・形式／型番の置き場）を描いた、まだデータの無い行列 */
function baseMatrix(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const pos = ALIGNMENT[version];
  for (let a = 0; a < pos.length; a += 1) {
    for (let b = 0; b < pos.length; b += 1) {
      const onFinder = (a === 0 && b === 0) || (a === 0 && b === pos.length - 1) || (a === pos.length - 1 && b === 0);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(pos[a] + dx, pos[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // 形式情報の場所を先に取る（中身はマスクを選んでから）
  drawFormat(modules, fn, size, "M", 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  return { size, modules, fn };
}

function drawFormat(modules, fn, size, ecc, mask) {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true);
}

function placeData(modules, fn, size, codewords) {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        modules[y][x] = i < total ? bit(codewords[i >>> 3], 7 - (i & 7)) : false;
        i += 1;
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules, fn, size, mask) {
  const out = modules.map((row) => row.slice());
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fn[y][x] && MASKS[mask](x, y)) out[y][x] = !out[y][x];
  return out;
}

/** マスクの減点（規格の 4 つの規則）。小さいほど読みやすい */
function penalty(m, size) {
  let score = 0;
  const lines = [];
  for (let y = 0; y < size; y += 1) lines.push(m[y]);
  for (let x = 0; x < size; x += 1) lines.push(m.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const s = line.map((v) => (v ? "1" : "0")).join("");
    for (const pat of ["10111010000", "00001011101"]) {
      for (let at = s.indexOf(pat); at !== -1; at = s.indexOf(pat, at + 1)) score += 40;
    }
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * 文字列から QR の行列を作る。
 * @param {string} text UTF-8 のバイトで入れる
 * @param {{ ecc?: "L"|"M"|"Q"|"H" }} [opts] 誤り訂正のレベル（既定 M）
 * @returns {{ size: number, version: number, mask: number, ecc: string, modules: boolean[][] }} modules[y][x] が true なら黒
 */
export function qrMatrix(text, opts = {}) {
  const ecc = opts.ecc ?? "M";
  if (!EC_TABLE[ecc]) throw new RangeError(`誤り訂正のレベルは L・M・Q・H のどれかです：${ecc}`);
  const { version, codewords } = encodeData(text, ecc);
  const all = interleave(version, ecc, codewords);
  const { size, modules, fn } = baseMatrix(version);
  placeData(modules, fn, size, all);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const masked = applyMask(modules, fn, size, mask);
    drawFormat(masked, fn.map((r) => r.slice()), size, ecc, mask);
    const p = penalty(masked, size);
    if (best === null || p < best.p) best = { p, mask, modules: masked };
  }
  return { size, version, mask: best.mask, ecc, modules: best.modules };
}

/**
 * 行列 → <img src> に入れる data URL（SVG。黒の部分は 1 本の path。周りの白い余白 border は規格の 4 モジュール）。
 * 画面に出すときは innerHTML に入れず、img.src に代入する。
 */
export function qrSvgDataUrl(qr, { border = 4 } = {}) {
  const n = qr.size + border * 2;
  let d = "";
  for (let y = 0; y < qr.size; y += 1) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (end < qr.size && qr.modules[y][end]) end += 1;
      d += `M${x + border},${y + border}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
