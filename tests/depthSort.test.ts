import { describe, it, expect } from "vitest";
import { depthSort } from "../src/depthSort";

/** 参照実装: 通常のソートでback-to-front順を作る */
function referenceSort(positions: Float32Array, count: number, rowZ: [number, number, number]): number[] {
  const idx = Array.from({ length: count }, (_, i) => i);
  const depth = (i: number) =>
    rowZ[0] * positions[i * 3] + rowZ[1] * positions[i * 3 + 1] + rowZ[2] * positions[i * 3 + 2];
  return idx.sort((a, b) => depth(a) - depth(b));
}

function randomPositions(count: number, seed = 42): Float32Array {
  let s = seed;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
  const p = new Float32Array(count * 3);
  for (let i = 0; i < p.length; i++) p[i] = rand() * 200 - 100;
  return p;
}

describe("depthSort", () => {
  it("Z軸沿いの点を奥(z最小)から手前の順に並べる", () => {
    // カメラが-z方向を向く標準view(rowZ = [0,0,1])のとき、
    // カメラ空間z = ワールドz。最も負(遠い)が先頭
    const positions = new Float32Array([
      0, 0, 5, // 手前
      0, 0, -10, // 最奥
      0, 0, 0, // 中間
    ]);
    const order = Array.from(depthSort(positions, 3, [0, 0, 1]));
    expect(order).toEqual([1, 2, 0]);
  });

  it("任意の視線方向でも参照ソートと同順(バケット精度内)", () => {
    const count = 5000;
    const positions = randomPositions(count);
    const rowZ: [number, number, number] = [0.267, -0.535, 0.802]; // 正規化済み
    const got = depthSort(positions, count, rowZ);
    const ref = referenceSort(positions, count, rowZ);
    const depth = (i: number) =>
      rowZ[0] * positions[i * 3] + rowZ[1] * positions[i * 3 + 1] + rowZ[2] * positions[i * 3 + 2];
    // counting sortはバケット内順序が入れ替わりうるので、深度値の単調性で検証
    for (let i = 1; i < count; i++) {
      // 1バケット分(値域/65536)の許容誤差
      const tolerance = (200 * Math.sqrt(3)) / 65536 + 1e-4;
      expect(depth(got[i])).toBeGreaterThanOrEqual(depth(got[i - 1]) - tolerance);
    }
    // 全インデックスが1回ずつ現れる
    expect(new Set(got).size).toBe(count);
    // 端点は参照実装と一致
    expect(got[0]).toBe(ref[0]);
    expect(got[count - 1]).toBe(ref[count - 1]);
  });

  it("全点同一深度でも壊れない", () => {
    const positions = new Float32Array([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    const order = Array.from(depthSort(positions, 3, [0, 0, 1]));
    expect(order.sort()).toEqual([0, 1, 2]);
  });

  it("1点でも動く", () => {
    const order = depthSort(new Float32Array([5, 5, 5]), 1, [0, 0, 1]);
    expect(Array.from(order)).toEqual([0]);
  });
});
