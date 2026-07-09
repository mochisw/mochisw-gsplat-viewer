/**
 * 合成PLYフィクスチャ生成(テスト用・手動確認用の両方から使用)
 */

/** @typedef {{x:number,y:number,z:number,r:number,g:number,b:number}} RgbPoint */

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : new Uint8Array(p), o);
    o += p.byteLength;
  }
  return out.buffer;
}

/** RGB点群PLY(ascii) */
export function buildAsciiPointCloudPly(points) {
  const header = [
    "ply",
    "format ascii 1.0",
    "comment synthetic fixture",
    `element vertex ${points.length}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
  ].join("\n") + "\n";
  const body = points
    .map((p) => `${p.x} ${p.y} ${p.z} ${p.r} ${p.g} ${p.b}`)
    .join("\n") + "\n";
  return enc.encode(header + body).buffer;
}

/** RGB点群PLY(binary_little_endian、法線nx,ny,nz付き=読み飛ばし対象) */
export function buildBinaryPointCloudPly(points, { withNormals = true } = {}) {
  const props = [
    "property float x",
    "property float y",
    "property float z",
    ...(withNormals
      ? ["property float nx", "property float ny", "property float nz"]
      : []),
    "property uchar red",
    "property uchar green",
    "property uchar blue",
  ];
  const header =
    [
      "ply",
      "format binary_little_endian 1.0",
      `element vertex ${points.length}`,
      ...props,
      "end_header",
    ].join("\n") + "\n";
  const stride = 12 + (withNormals ? 12 : 0) + 3;
  const body = new ArrayBuffer(points.length * stride);
  const view = new DataView(body);
  let o = 0;
  for (const p of points) {
    view.setFloat32(o, p.x, true);
    view.setFloat32(o + 4, p.y, true);
    view.setFloat32(o + 8, p.z, true);
    o += 12;
    if (withNormals) {
      view.setFloat32(o, 0, true);
      view.setFloat32(o + 4, 1, true);
      view.setFloat32(o + 8, 0, true);
      o += 12;
    }
    view.setUint8(o, p.r);
    view.setUint8(o + 1, p.g);
    view.setUint8(o + 2, p.b);
    o += 3;
  }
  return concat([enc.encode(header), body]);
}

const REST_COUNT_BY_DEGREE = [0, 9, 24, 45];

/**
 * 3DGS標準PLY(binary_little_endian)
 * @param {{x,y,z,dc:[number,number,number],opacity:number,scale:[number,number,number],rot:[number,number,number,number]}[]} splats
 *   opacity/scaleは「PLYに書かれる生値」(sigmoid/exp適用前)、rotは非正規化可
 */
export function buildBinary3dgsPly(splats, { shDegree = 0 } = {}) {
  const restCount = REST_COUNT_BY_DEGREE[shDegree];
  const props = [
    "x", "y", "z", "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: restCount }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  const header =
    [
      "ply",
      "format binary_little_endian 1.0",
      `element vertex ${splats.length}`,
      ...props.map((n) => `property float ${n}`),
      "end_header",
    ].join("\n") + "\n";
  const stride = props.length * 4;
  const body = new ArrayBuffer(splats.length * stride);
  const view = new DataView(body);
  let o = 0;
  for (const s of splats) {
    const values = [
      s.x, s.y, s.z, 0, 0, 0,
      ...s.dc,
      ...Array.from({ length: restCount }, () => 0.01),
      s.opacity,
      ...s.scale,
      ...s.rot,
    ];
    for (const v of values) {
      view.setFloat32(o, v, true);
      o += 4;
    }
  }
  return concat([enc.encode(header), body]);
}

/** xyzのみのPLY(ascii) */
export function buildXyzOnlyPly(points) {
  const header =
    [
      "ply",
      "format ascii 1.0",
      `element vertex ${points.length}`,
      "property float x",
      "property float y",
      "property float z",
      "end_header",
    ].join("\n") + "\n";
  const body = points.map((p) => `${p.x} ${p.y} ${p.z}`).join("\n") + "\n";
  return enc.encode(header + body).buffer;
}

/** float色(0..1)のRGB点群PLY(ascii) */
export function buildFloatColorPly(points) {
  const header =
    [
      "ply",
      "format ascii 1.0",
      `element vertex ${points.length}`,
      "property float x",
      "property float y",
      "property float z",
      "property float red",
      "property float green",
      "property float blue",
      "end_header",
    ].join("\n") + "\n";
  const body = points
    .map((p) => `${p.x} ${p.y} ${p.z} ${p.r} ${p.g} ${p.b}`)
    .join("\n") + "\n";
  return enc.encode(header + body).buffer;
}

/** binary_big_endian ヘッダのPLY(エラー確認用) */
export function buildBigEndianPly() {
  const header =
    [
      "ply",
      "format binary_big_endian 1.0",
      "element vertex 1",
      "property float x",
      "property float y",
      "property float z",
      "end_header",
    ].join("\n") + "\n";
  return concat([enc.encode(header), new ArrayBuffer(12)]);
}

// ─────────────────────────────────────────────────────────────
// SPZフィクスチャ(公式 nianticlabs/spz のパック処理を模倣)
// テスト・手動確認用。値は「デコード後の空間」で与える:
//   position: ワールド座標 / alpha: 0..1(sigmoid適用済) / dc: f_dc係数
//   scale: log値(exp適用前) / rot: 正規化クォータニオン(x,y,z,w)
// ─────────────────────────────────────────────────────────────

const SPZ_COLOR_SCALE = 0.15;
const SPZ_DIM_FOR_DEGREE = [0, 3, 8, 15, 24];

const clampByte = (x) => Math.max(0, Math.min(255, Math.round(x)));

function packPosition24(view, offset, v, fractionalBits) {
  let fixed = Math.round(v * (1 << fractionalBits));
  if (fixed < 0) fixed += 0x1000000;
  view.setUint8(offset, fixed & 0xff);
  view.setUint8(offset + 1, (fixed >> 8) & 0xff);
  view.setUint8(offset + 2, (fixed >> 16) & 0xff);
}

/** smallest-three符号化(公式v3+)。qは(x,y,z,w) */
export function packQuaternionSmallestThree(q) {
  let largest = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[largest])) largest = i;
  const sign = q[largest] < 0 ? -1 : 1;
  let comp = largest * 2 ** 30;
  let shift = 0;
  for (let i = 3; i >= 0; i--) {
    if (i === largest) continue;
    const v = q[i] * sign;
    const neg = v < 0 ? 1 : 0;
    const mag = Math.min(511, Math.round((Math.abs(v) / Math.SQRT1_2) * 511));
    comp += (neg * 512 + mag) * 2 ** shift;
    shift += 10;
  }
  return comp >>> 0;
}

/**
 * SPZの「gzip展開前の生ペイロード」を構築(ヘッダ+属性ストリーム連結)
 * @param {{x,y,z,alpha,dc:[number,number,number],scale:[number,number,number],rot:[number,number,number,number]}[]} gaussians
 */
export function buildSpzPayload(gaussians, { version = 2, shDegree = 0, fractionalBits = 12, flags = 0 } = {}) {
  const n = gaussians.length;
  const shDim = SPZ_DIM_FOR_DEGREE[shDegree];
  const rotBytes = version >= 3 ? 4 : 3;
  const total = 16 + n * 9 + n + n * 3 + n * 3 + n * rotBytes + n * shDim * 3;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint32(0, 0x5053474e, true); // NGSP
  view.setUint32(4, version, true);
  view.setUint32(8, n, true);
  view.setUint8(12, shDegree);
  view.setUint8(13, fractionalBits);
  view.setUint8(14, flags);

  let o = 16;
  for (const g of gaussians) {
    packPosition24(view, o, g.x, fractionalBits);
    packPosition24(view, o + 3, g.y, fractionalBits);
    packPosition24(view, o + 6, g.z, fractionalBits);
    o += 9;
  }
  for (const g of gaussians) u8[o++] = clampByte(g.alpha * 255);
  for (const g of gaussians) {
    for (let k = 0; k < 3; k++) u8[o++] = clampByte((g.dc[k] * SPZ_COLOR_SCALE + 0.5) * 255);
  }
  for (const g of gaussians) {
    for (let k = 0; k < 3; k++) u8[o++] = clampByte((g.scale[k] + 10) * 16);
  }
  for (const g of gaussians) {
    // w<0なら全体を反転(qと-qは同じ回転)
    const q = g.rot[3] < 0 ? g.rot.map((v) => -v) : g.rot;
    if (version >= 3) {
      view.setUint32(o, packQuaternionSmallestThree(q), true);
      o += 4;
    } else {
      for (let k = 0; k < 3; k++) u8[o++] = clampByte((q[k] + 1) * 127.5);
    }
  }
  // SH係数は0(=バイト値128)で埋める
  u8.fill(128, o, o + n * shDim * 3);
  return buf;
}

/** レガシーgzip形式のSPZファイル(version 1〜3) */
export async function buildSpzLegacy(gaussians, opts = {}) {
  const { gzipSync } = await import("node:zlib");
  const payload = buildSpzPayload(gaussians, opts);
  const gz = gzipSync(new Uint8Array(payload));
  // Bufferはプール共有のため.bufferを直接返さず正確な範囲をコピーする
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
}

/** version 4(NGSP平文ヘッダ + TOC + 属性別ZSTDストリーム)のSPZファイル */
export async function buildSpzV4(gaussians, { shDegree = 0, fractionalBits = 12, flags = 0 } = {}) {
  const { zstdCompressSync } = await import("node:zlib");
  // レガシーペイロードの構築ロジックを流用してv3(smallest-three)の各ストリームを切り出す
  const payload = new Uint8Array(buildSpzPayload(gaussians, { version: 3, shDegree, fractionalBits, flags }));
  const n = gaussians.length;
  const shDim = SPZ_DIM_FOR_DEGREE[shDegree];
  const sizes = [n * 9, n, n * 3, n * 3, n * 4, n * shDim * 3].filter((s) => s > 0);
  const streams = [];
  let o = 16;
  for (const size of sizes) {
    streams.push(payload.subarray(o, o + size));
    o += size;
  }
  const compressed = streams.map((s) => zstdCompressSync(s));

  const tocByteOffset = 32;
  const totalSize =
    tocByteOffset + streams.length * 16 + compressed.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, n, true);
  view.setUint8(12, shDegree);
  view.setUint8(13, fractionalBits);
  view.setUint8(14, flags);
  view.setUint8(15, streams.length);
  view.setUint32(16, tocByteOffset, true);
  let dataOffset = tocByteOffset + streams.length * 16;
  for (let i = 0; i < streams.length; i++) {
    view.setBigUint64(tocByteOffset + i * 16, BigInt(compressed[i].length), true);
    view.setBigUint64(tocByteOffset + i * 16 + 8, BigInt(streams[i].length), true);
    out.set(compressed[i], dataOffset);
    dataOffset += compressed[i].length;
  }
  return out.buffer;
}

/** ランダムなRGB点群を生成 */
export function randomRgbPoints(n, seed = 12345) {
  let s = seed;
  const rand = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
  return Array.from({ length: n }, () => ({
    x: rand() * 10 - 5,
    y: rand() * 10 - 5,
    z: rand() * 10 - 5,
    r: Math.floor(rand() * 256),
    g: Math.floor(rand() * 256),
    b: Math.floor(rand() * 256),
  }));
}
