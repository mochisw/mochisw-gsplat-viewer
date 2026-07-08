/**
 * 読み込んだシーンの内部表現。
 *
 * 点表示・スプラット表示の両モードで同じGPUバッファを共有するため
 * (設計書4章)、interleaved な単一 ArrayBuffer に全属性を詰める。
 *
 * レイアウト(1点あたり STRIDE_BYTES = 44 バイト):
 *   offset  0: position  float32 x3 (12B)
 *   offset 12: color     uint8   x4 (RGBA, 4B) — αは3DGSのopacity、点群は255
 *   offset 16: scale     float32 x3 (12B) — 線形値(exp適用済)。点群は0
 *   offset 28: rotation  float32 x4 (16B) — 正規化クォータニオン(w,x,y,z)。点群は(1,0,0,0)
 */
export const STRIDE_BYTES = 44;
export const OFFSET_POSITION = 0;
export const OFFSET_COLOR = 12;
export const OFFSET_SCALE = 16;
export const OFFSET_ROTATION = 28;

export type SourceFormat = "ply-3dgs" | "ply-points" | "spz";

export interface SplatData {
  numPoints: number;
  /** interleaved 頂点データ(STRIDE_BYTES × numPoints) */
  buffer: ArrayBuffer;
  format: SourceFormat;
  /** 入力ファイルが持っていたSH次数(f_restの本数から算出)。点群は0 */
  shDegree: number;
  /** バウンディングボックス(カメラ初期化用) */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** interleaved バッファへの書き込みヘルパを作る */
export function createSplatBuffer(numPoints: number): {
  buffer: ArrayBuffer;
  f32: Float32Array;
  u8: Uint8Array;
} {
  const buffer = new ArrayBuffer(numPoints * STRIDE_BYTES);
  return { buffer, f32: new Float32Array(buffer), u8: new Uint8Array(buffer) };
}

export const FLOATS_PER_POINT = STRIDE_BYTES / 4;

/** 進捗通知(処理済み件数, 総件数) */
export type ProgressCallback = (done: number, total: number) => void;
