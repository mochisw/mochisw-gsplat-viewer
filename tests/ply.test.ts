import { describe, it, expect } from "vitest";
import { parsePly, parsePlyHeader, SH_C0, shDegreeFromRestCount } from "../src/ply";
import {
  FLOATS_PER_POINT,
  STRIDE_BYTES,
  OFFSET_COLOR,
  OFFSET_SCALE,
  OFFSET_ROTATION,
} from "../src/types";
import {
  buildAsciiPointCloudPly,
  buildBinaryPointCloudPly,
  buildBinary3dgsPly,
  buildXyzOnlyPly,
  buildFloatColorPly,
  buildBigEndianPly,
  randomRgbPoints,
} from "../scripts/fixtures.mjs";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

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
function rotationOf(data: { buffer: ArrayBuffer }, i: number): [number, number, number, number] {
  const f32 = new Float32Array(data.buffer);
  const o = i * FLOATS_PER_POINT + OFFSET_ROTATION / 4;
  return [f32[o], f32[o + 1], f32[o + 2], f32[o + 3]];
}

describe("parsePlyHeader", () => {
  it("ascii/binaryのformatとvertex数を読める", () => {
    const buf = buildAsciiPointCloudPly(randomRgbPoints(3));
    const h = parsePlyHeader(new Uint8Array(buf));
    expect(h.format).toBe("ascii");
    expect(h.elements[0].name).toBe("vertex");
    expect(h.elements[0].count).toBe(3);
  });

  it("plyマジックがないとエラー", () => {
    const bytes = new TextEncoder().encode("not_a_ply\nend_header\n");
    expect(() => parsePlyHeader(bytes)).toThrow(/magic/);
  });

  it("end_headerがないとエラー", () => {
    const bytes = new TextEncoder().encode("ply\nformat ascii 1.0\n");
    expect(() => parsePlyHeader(bytes)).toThrow(/end_header/);
  });
});

describe("parsePly: RGB点群", () => {
  it("ascii点群をラウンドトリップできる", async () => {
    const pts = randomRgbPoints(100);
    const data = await parsePly(buildAsciiPointCloudPly(pts));
    expect(data.format).toBe("ply-points");
    expect(data.numPoints).toBe(100);
    expect(data.shDegree).toBe(0);
    for (const i of [0, 50, 99]) {
      const [x, y, z] = positionOf(data, i);
      expect(x).toBeCloseTo(pts[i].x, 4);
      expect(y).toBeCloseTo(pts[i].y, 4);
      expect(z).toBeCloseTo(pts[i].z, 4);
      expect(colorOf(data, i)).toEqual([pts[i].r, pts[i].g, pts[i].b, 255]);
    }
  });

  it("binary_little_endian点群(法線付き)は法線を読み飛ばして読める", async () => {
    const pts = randomRgbPoints(200);
    const data = await parsePly(buildBinaryPointCloudPly(pts, { withNormals: true }));
    expect(data.format).toBe("ply-points");
    expect(data.numPoints).toBe(200);
    for (const i of [0, 123, 199]) {
      const [x, y, z] = positionOf(data, i);
      expect(x).toBeCloseTo(pts[i].x, 4);
      expect(y).toBeCloseTo(pts[i].y, 4);
      expect(z).toBeCloseTo(pts[i].z, 4);
      expect(colorOf(data, i)).toEqual([pts[i].r, pts[i].g, pts[i].b, 255]);
    }
  });

  it("バウンディングボックスを計算する", async () => {
    const pts = [
      { x: -1, y: -2, z: -3, r: 0, g: 0, b: 0 },
      { x: 4, y: 5, z: 6, r: 0, g: 0, b: 0 },
      { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 },
    ];
    const data = await parsePly(buildAsciiPointCloudPly(pts));
    expect(data.bounds.min).toEqual([-1, -2, -3]);
    expect(data.bounds.max).toEqual([4, 5, 6]);
  });

  it("xyzのみのPLYは白点になる", async () => {
    const data = await parsePly(buildXyzOnlyPly([{ x: 1, y: 2, z: 3 }]));
    expect(data.format).toBe("ply-points");
    expect(colorOf(data, 0)).toEqual([255, 255, 255, 255]);
  });

  it("float型RGB(0..1)は255スケールされる", async () => {
    const data = await parsePly(
      buildFloatColorPly([{ x: 0, y: 0, z: 0, r: 1.0, g: 0.5, b: 0.0 }])
    );
    expect(colorOf(data, 0)).toEqual([255, 128, 0, 255]);
  });

  it("進捗コールバックが呼ばれ、最後にdone=totalになる", async () => {
    const calls: [number, number][] = [];
    await parsePly(buildAsciiPointCloudPly(randomRgbPoints(10)), (d, t) => calls.push([d, t]));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toEqual([10, 10]);
  });
});

describe("parsePly: 3DGS標準", () => {
  const splat = {
    x: 1, y: -2, z: 3,
    dc: [0.5, -0.5, 0.0] as [number, number, number],
    opacity: 1.5,
    scale: [-3, -2, -1] as [number, number, number],
    rot: [2, 0, 0, 0] as [number, number, number, number], // 非正規化
  };

  it("f_dc/opacity/scale/rotが規定どおり変換される", async () => {
    const data = await parsePly(buildBinary3dgsPly([splat], { shDegree: 0 }));
    expect(data.format).toBe("ply-3dgs");
    expect(data.numPoints).toBe(1);

    // 色: 0.5 + C0 * f_dc をclampして255スケール
    const [r, g, b, a] = colorOf(data, 0);
    expect(r).toBe(Math.round((0.5 + SH_C0 * 0.5) * 255));
    expect(g).toBe(Math.round((0.5 + SH_C0 * -0.5) * 255));
    expect(b).toBe(Math.round(0.5 * 255));
    // α: sigmoid(opacity)
    expect(a).toBe(Math.round(sigmoid(1.5) * 255));

    // scale: exp適用済み
    const [sx, sy, sz] = scaleOf(data, 0);
    expect(sx).toBeCloseTo(Math.exp(-3), 5);
    expect(sy).toBeCloseTo(Math.exp(-2), 5);
    expect(sz).toBeCloseTo(Math.exp(-1), 5);

    // rot: 正規化済みクォータニオン(w,x,y,z)
    expect(rotationOf(data, 0)).toEqual([1, 0, 0, 0]);
  });

  it("f_dcの範囲外値はclampされる", async () => {
    const data = await parsePly(
      buildBinary3dgsPly([{ ...splat, dc: [10, -10, 0] }], { shDegree: 0 })
    );
    const [r, g] = colorOf(data, 0);
    expect(r).toBe(255);
    expect(g).toBe(0);
  });

  it("f_rest本数からSH次数を判定する", async () => {
    for (const deg of [0, 1, 2, 3]) {
      const data = await parsePly(buildBinary3dgsPly([splat], { shDegree: deg }));
      expect(data.shDegree).toBe(deg);
    }
  });

  it("shDegreeFromRestCountの境界値", () => {
    expect(shDegreeFromRestCount(0)).toBe(0);
    expect(shDegreeFromRestCount(9)).toBe(1);
    expect(shDegreeFromRestCount(24)).toBe(2);
    expect(shDegreeFromRestCount(45)).toBe(3);
  });
});

describe("parsePly: エラー処理", () => {
  it("binary_big_endianは明示的なエラー", async () => {
    await expect(parsePly(buildBigEndianPly())).rejects.toThrow(/big_endian/);
  });

  it("頂点数より短い(切り詰められた)binaryはエラー", async () => {
    const full = buildBinaryPointCloudPly(randomRgbPoints(100));
    const truncated = full.slice(0, full.byteLength - 50);
    await expect(parsePly(truncated)).rejects.toThrow(/壊れて/);
  });

  it("頂点数より行が少ないasciiはエラー", async () => {
    const full = buildAsciiPointCloudPly(randomRgbPoints(10));
    const text = new TextDecoder().decode(full);
    const lines = text.trimEnd().split("\n");
    lines.pop(); // 1行削る
    const broken = new TextEncoder().encode(lines.join("\n") + "\n").buffer;
    await expect(parsePly(broken as ArrayBuffer)).rejects.toThrow(/壊れて/);
  });

  it("vertex要素がないPLYはエラー", async () => {
    const bytes = new TextEncoder().encode(
      "ply\nformat ascii 1.0\nelement face 0\nend_header\n"
    );
    await expect(parsePly(bytes.buffer as ArrayBuffer)).rejects.toThrow(/vertex/);
  });
});
