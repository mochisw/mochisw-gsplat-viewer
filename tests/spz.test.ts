import { describe, it, expect } from "vitest";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import { parseSpz, SPZ_COLOR_SCALE, SpzDecompressors } from "../src/spz";
import { SH_C0 } from "../src/ply";
import {
  FLOATS_PER_POINT,
  STRIDE_BYTES,
  OFFSET_COLOR,
  OFFSET_SCALE,
  OFFSET_ROTATION,
} from "../src/types";
import {
  buildSpzPayload,
  buildSpzLegacy,
  buildSpzV4,
} from "../scripts/fixtures.mjs";

// Node標準のDecompressionStreamはzstd非対応なので、v4テストにはnode:zlibを注入する
const nodeDecompressors: SpzDecompressors = {
  gzip: async (d) => {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([d as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },
  zstd: async (d) => new Uint8Array(zstdDecompressSync(d)),
};

/** Bufferはプール共有のため.bufferを直接使わず正確な範囲をコピーする */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function positionOf(data: { buffer: ArrayBuffer }, i: number): [number, number, number] {
  const f32 = new Float32Array(data.buffer);
  return [f32[i * FLOATS_PER_POINT], f32[i * FLOATS_PER_POINT + 1], f32[i * FLOATS_PER_POINT + 2]];
}
function colorOf(data: { buffer: ArrayBuffer }, i: number): [number, number, number, number] {
  const u8 = new Uint8Array(data.buffer);
  const o = i * STRIDE_BYTES + OFFSET_COLOR;
  return [u8[o], u8[o + 1], u8[o + 2], u8[o + 3]];
}
function scaleOf(data: { buffer: ArrayBuffer }, i: number): [number, number, number] {
  const f32 = new Float32Array(data.buffer);
  const o = i * FLOATS_PER_POINT + OFFSET_SCALE / 4;
  return [f32[o], f32[o + 1], f32[o + 2]];
}
/** (w,x,y,z)で返す */
function rotationOf(data: { buffer: ArrayBuffer }, i: number): [number, number, number, number] {
  const f32 = new Float32Array(data.buffer);
  const o = i * FLOATS_PER_POINT + OFFSET_ROTATION / 4;
  return [f32[o], f32[o + 1], f32[o + 2], f32[o + 3]];
}

interface Gaussian {
  x: number; y: number; z: number;
  alpha: number;
  dc: [number, number, number];
  scale: [number, number, number];
  rot: [number, number, number, number]; // (x,y,z,w)
}

const norm = (q: number[]) => {
  const n = Math.hypot(...q);
  return q.map((v) => v / n);
};

const g1: Gaussian = {
  x: 1.25, y: -2.5, z: 3.0625,
  alpha: 0.75,
  dc: [0.5, -0.5, 0],
  scale: [-3, -2, -1],
  rot: norm([0.1, 0.2, 0.3, 0.9]) as Gaussian["rot"],
};
const g2: Gaussian = {
  x: -100.5, y: 0.001, z: 55.25,
  alpha: 0.1,
  dc: [2, -2, 1],
  scale: [-6, -5, -4],
  rot: norm([-0.7, 0.1, -0.1, 0.05]) as Gaussian["rot"],
};

function expectDecoded(data: Awaited<ReturnType<typeof parseSpz>>, i: number, g: Gaussian, rotTol: number) {
  // 位置: 12bit固定小数点(1/4096刻み)
  const [x, y, z] = positionOf(data, i);
  expect(x).toBeCloseTo(g.x, 3);
  expect(y).toBeCloseTo(g.y, 3);
  expect(z).toBeCloseTo(g.z, 3);

  // 色: f_dc → 表示RGB、α: そのまま8bit
  const [r, gr, b, a] = colorOf(data, i);
  const expectByte = (dc: number) => {
    const quantized = (Math.round((dc * SPZ_COLOR_SCALE + 0.5) * 255) / 255 - 0.5) / SPZ_COLOR_SCALE;
    return Math.max(0, Math.min(255, Math.round((0.5 + SH_C0 * quantized) * 255)));
  };
  expect(r).toBe(expectByte(g.dc[0]));
  expect(gr).toBe(expectByte(g.dc[1]));
  expect(b).toBe(expectByte(g.dc[2]));
  expect(a).toBe(Math.round(g.alpha * 255));

  // scale: 1/16刻みのlog符号化 → exp
  const [sx, sy, sz] = scaleOf(data, i);
  expect(sx).toBeCloseTo(Math.exp(g.scale[0]), 4);
  expect(sy).toBeCloseTo(Math.exp(g.scale[1]), 4);
  expect(sz).toBeCloseTo(Math.exp(g.scale[2]), 4);

  // rot: (w,x,y,z)で格納。q≡-qの等価性があるため内積で符号を揃えて比較
  // (v2はw≥0、v3+は最大成分≥0に正規化されて格納される)
  const [w, qx, qy, qz] = rotationOf(data, i);
  const decoded = [qx, qy, qz, w];
  const dot = decoded.reduce((s, v, k) => s + v * g.rot[k], 0);
  const expected = dot < 0 ? g.rot.map((v) => -v) : [...g.rot];
  expect(qx).toBeCloseTo(expected[0], rotTol);
  expect(qy).toBeCloseTo(expected[1], rotTol);
  expect(qz).toBeCloseTo(expected[2], rotTol);
  expect(w).toBeCloseTo(expected[3], rotTol);
}

describe("parseSpz: レガシーgzip形式", () => {
  it("version 2(first-threeクォータニオン)をラウンドトリップできる", async () => {
    const data = await parseSpz(await buildSpzLegacy([g1, g2], { version: 2 }));
    expect(data.format).toBe("spz");
    expect(data.numPoints).toBe(2);
    expect(data.shDegree).toBe(0);
    expectDecoded(data, 0, g1, 1); // 8bit量子化: 精度1桁
    expectDecoded(data, 1, g2, 1);
  });

  it("version 3(smallest-threeクォータニオン)をラウンドトリップできる", async () => {
    const data = await parseSpz(await buildSpzLegacy([g1, g2], { version: 3 }));
    expect(data.numPoints).toBe(2);
    expectDecoded(data, 0, g1, 2); // 10bit量子化: 精度2桁
    expectDecoded(data, 1, g2, 2);
  });

  it("smallest-three: 最大成分がx/y/z/wどれでも復元できる", async () => {
    const gs: Gaussian[] = [
      [0.9, 0.1, -0.2, 0.3],
      [0.1, -0.9, 0.2, 0.3],
      [-0.1, 0.2, 0.95, 0.1],
      [0.1, 0.2, 0.1, -0.95],
    ].map((rot) => ({ ...g1, rot: norm(rot) as Gaussian["rot"] }));
    const data = await parseSpz(await buildSpzLegacy(gs, { version: 3 }));
    for (let i = 0; i < 4; i++) {
      const [w, x, y, z] = rotationOf(data, i);
      const dot = [x, y, z, w].reduce((s, v, k) => s + v * gs[i].rot[k], 0);
      const e = dot < 0 ? gs[i].rot.map((v) => -v) : [...gs[i].rot];
      expect(x).toBeCloseTo(e[0], 2);
      expect(y).toBeCloseTo(e[1], 2);
      expect(z).toBeCloseTo(e[2], 2);
      expect(w).toBeCloseTo(e[3], 2);
      // 単位クォータニオンであること
      expect(Math.hypot(w, x, y, z)).toBeCloseTo(1, 5);
    }
  });

  it("SH次数を記録し、SH係数分のデータを正しく読み飛ばす", async () => {
    for (const shDegree of [0, 1, 2, 3]) {
      const data = await parseSpz(await buildSpzLegacy([g1, g2], { version: 3, shDegree }));
      expect(data.shDegree).toBe(shDegree);
      // SHの後にもデータ破損がない=末尾の点が正しく読める
      expectDecoded(data, 1, g2, 2);
    }
  });

  it("バウンディングボックスを計算する", async () => {
    const data = await parseSpz(await buildSpzLegacy([g1, g2], { version: 3 }));
    expect(data.bounds.min[0]).toBeCloseTo(-100.5, 3);
    expect(data.bounds.max[0]).toBeCloseTo(1.25, 3);
    expect(data.bounds.min[1]).toBeCloseTo(-2.5, 3);
    expect(data.bounds.max[2]).toBeCloseTo(55.25, 3);
  });

  it("進捗コールバックが呼ばれる", async () => {
    const calls: [number, number][] = [];
    await parseSpz(await buildSpzLegacy([g1, g2], { version: 2 }), (d, t) => calls.push([d, t]));
    expect(calls[calls.length - 1]).toEqual([2, 2]);
  });
});

describe("parseSpz: version 4(ZSTD)", () => {
  it("v4をラウンドトリップできる(zstdデコンプレッサ注入)", async () => {
    const data = await parseSpz(await buildSpzV4([g1, g2], { shDegree: 1 }), undefined, nodeDecompressors);
    expect(data.format).toBe("spz");
    expect(data.numPoints).toBe(2);
    expect(data.shDegree).toBe(1);
    expectDecoded(data, 0, g1, 2);
    expectDecoded(data, 1, g2, 2);
  });

  it("zstd非対応環境では明示エラー", async () => {
    const noZstd: SpzDecompressors = { gzip: nodeDecompressors.gzip };
    await expect(parseSpz(await buildSpzV4([g1]), undefined, noZstd)).rejects.toThrow(/ZSTD/);
  });

  it("TOCのサイズ矛盾はエラー", async () => {
    const buf = new Uint8Array(await buildSpzV4([g1, g2]));
    // 最初のストリームのuncompressedSizeを改ざん
    new DataView(buf.buffer).setBigUint64(32 + 8, 12345n, true);
    await expect(parseSpz(buf.buffer, undefined, nodeDecompressors)).rejects.toThrow(/壊れて/);
  });
});

describe("parseSpz: エラー処理", () => {
  it("gzipでもNGSPでもないデータはエラー", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    await expect(parseSpz(junk)).rejects.toThrow(/未知の形式/);
  });

  it("gzip内のmagicが不正ならエラー", async () => {
    const payload = new Uint8Array(buildSpzPayload([g1], { version: 2 }));
    payload[0] = 0x00; // magic破壊
    await expect(parseSpz(toArrayBuffer(gzipSync(payload)))).rejects.toThrow(/magic/);
  });

  it("version 1は明示エラー(未リリース形式)", async () => {
    await expect(parseSpz(await buildSpzLegacy([g1], { version: 1 }))).rejects.toThrow(/version 1/);
  });

  it("未対応versionはエラー", async () => {
    const payload = new Uint8Array(buildSpzPayload([g1], { version: 2 }));
    new DataView(payload.buffer).setUint32(4, 9, true);
    await expect(parseSpz(toArrayBuffer(gzipSync(payload)))).rejects.toThrow(/version/);
  });

  it("点数に対してデータが短ければエラー", async () => {
    const payload = new Uint8Array(buildSpzPayload([g1, g2], { version: 2 }));
    const truncated = payload.subarray(0, payload.length - 10);
    await expect(parseSpz(toArrayBuffer(gzipSync(truncated)))).rejects.toThrow(/壊れて/);
  });

  it("壊れたgzipはエラー", async () => {
    const broken = new Uint8Array([0x1f, 0x8b, 0xff, 0xff, 0, 0, 0, 0, 1, 2, 3]).buffer;
    await expect(parseSpz(broken)).rejects.toThrow(/gzip/);
  });
});
