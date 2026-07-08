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
