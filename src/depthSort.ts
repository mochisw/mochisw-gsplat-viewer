/**
 * back-to-front デプスソート(counting sort、設計書4章モードB)
 *
 * カメラ空間z(view行列のz行との内積)で奥→手前に並べる。
 * OpenGL規約ではカメラは-z方向を向くため、可視点のzは負であり
 * 「最も負(遠い)」が先頭に来る昇順ソートがback-to-frontになる。
 *
 * 平行移動はzの全点共通オフセットにしかならず順序を変えないため、
 * 再ソートが必要になるのは視線方向(回転)が変わったときのみ。
 */

const BUCKETS = 65536;

/**
 * @param positions 点座標(x,y,z連続、count*3要素)
 * @param count 点数
 * @param rowZ view*model行列のz行(第3行)の回転成分 [m2, m6, m10]
 * @returns 奥から手前の順の点インデックス
 */
export function depthSort(
  positions: Float32Array,
  count: number,
  rowZ: [number, number, number]
): Uint32Array {
  const depths = new Float32Array(count);
  const [a, b, c] = rowZ;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = a * positions[i * 3] + b * positions[i * 3 + 1] + c * positions[i * 3 + 2];
    depths[i] = d;
    if (d < min) min = d;
    if (d > max) max = d;
  }

  const k = max > min ? (BUCKETS - 1) / (max - min) : 0;
  const counts = new Uint32Array(BUCKETS);
  for (let i = 0; i < count; i++) {
    counts[((depths[i] - min) * k) | 0]++;
  }
  // 累積和 → 各バケットの書き込み開始位置
  let sum = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const c0 = counts[i];
    counts[i] = sum;
    sum += c0;
  }

  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    out[counts[((depths[i] - min) * k) | 0]++] = i;
  }
  return out;
}
