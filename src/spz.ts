/**
 * SPZパーサ(設計書3.2)
 *
 * バイトレイアウトは公式実装 github.com/nianticlabs/spz の
 * src/cc/load-spz.cc / splat-utils.h / README.md で確認済み(2026-07-09時点 main)。
 *
 * 形式判定(公式のload path準拠):
 *  - 先頭2バイト 0x1f 0x8b → レガシーgzip形式(version 1〜3、単一ストリーム)
 *  - 先頭4バイト "NGSP"    → version 4(32Bヘッダ平文 + 属性別ZSTDストリーム)
 *
 * レガシー形式(gzip展開後):
 *   16Bヘッダ: magic u32 / version u32 / numPoints u32 / shDegree u8
 *              / fractionalBits u8 / flags u8 / reserved u8(全てLE)
 *   続けて属性ストリームを連結: positions, alphas, colors, scales, rotations, sh
 *
 * デコード(公式 splat-utils.h / PackedGaussian::unpack 準拠):
 *  - position: 24bit固定小数点LE、符号拡張して / 2^fractionalBits(v1のfloat16は未リリース形式のため非対応)
 *  - alpha: u8(sigmoid適用済みの値がそのまま格納されている)
 *  - color: f_dc = (u8/255 - 0.5) / 0.15、表示RGB = 0.5 + C0 * f_dc
 *  - scale: log値 = u8/16 - 10、線形値 = exp(log値)
 *  - rotation v2: (x,y,z) = u8/127.5 - 1、w = sqrt(1-|xyz|²)(first-three)
 *  - rotation v3+: smallest-three。u32の上位2bitが最大成分のindex、
 *    残り成分をLSB側からi=3..0の順に10bit(下位9bit=絶対値/511*√½、bit9=符号)
 *  - SH係数: (u8 - 128) / 128(Phase 2では次数の記録のみ、係数は読み飛ばし)
 *
 * SPZの座標系はRUB(OpenGL/three.js準拠、Y上)なので上下反転は不要。
 */
import {
  SplatData,
  ProgressCallback,
  createSplatBuffer,
  FLOATS_PER_POINT,
  OFFSET_COLOR,
  OFFSET_SCALE,
  OFFSET_ROTATION,
} from "./types";
import { SH_C0 } from "./ply";

/** 公式実装のcolorScale(f_dc量子化スケール) */
export const SPZ_COLOR_SCALE = 0.15;
const NGSP_MAGIC = 0x5053474e; // "NGSP"
const LATEST_VERSION = 4;
const MIN_SMALLEST_THREE_VERSION = 3;

export type DecompressFn = (data: Uint8Array) => Promise<Uint8Array>;

export interface SpzDecompressors {
  gzip: DecompressFn;
  /** 未対応環境ではundefined(v4読込時に明示エラー) */
  zstd?: DecompressFn;
}

function decompressionStreamFn(format: string): DecompressFn {
  return async (data) => {
    const ds = new DecompressionStream(format as CompressionFormat);
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
}

/** ブラウザ/Node標準のDecompressionStreamベースの既定デコンプレッサ */
export function defaultDecompressors(): SpzDecompressors {
  let zstd: DecompressFn | undefined;
  try {
    new DecompressionStream("zstd" as CompressionFormat); // 機能検出(Chrome系のみ対応)
    zstd = decompressionStreamFn("zstd");
  } catch {
    zstd = undefined;
  }
  return { gzip: decompressionStreamFn("gzip"), zstd };
}

/** SH次数ごとの係数本数(RGBチャンネルあたり)。公式dimForDegree準拠 */
export function spzDimForDegree(degree: number): number {
  switch (degree) {
    case 0: return 0;
    case 1: return 3;
    case 2: return 8;
    case 3: return 15;
    case 4: return 24;
    default: throw new Error(`SPZ: 未対応のSH次数です: ${degree}`);
  }
}

interface SpzStreams {
  numPoints: number;
  shDegree: number;
  fractionalBits: number;
  version: number;
  positions: Uint8Array; // numPoints * 9 (24bit×3)
  alphas: Uint8Array;    // numPoints
  colors: Uint8Array;    // numPoints * 3
  scales: Uint8Array;    // numPoints * 3
  rotations: Uint8Array; // numPoints * (v3+: 4 / v2: 3)
}

/** レガシー(gzip展開後)のヘッダ+連結ストリームを切り出す */
function parseLegacyPayload(bytes: Uint8Array): SpzStreams {
  if (bytes.length < 16) throw new Error("SPZ: ヘッダが短すぎます");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== NGSP_MAGIC) throw new Error("SPZ: magicが不正です(NGSPではありません)");
  const version = view.getUint32(4, true);
  if (version < 1 || version > LATEST_VERSION) {
    throw new Error(`SPZ: 未対応のversionです: ${version}`);
  }
  if (version === 1) {
    throw new Error("SPZ: version 1(float16位置)は未リリース形式のため非対応です");
  }
  const numPoints = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  // flags(bit0: antialiased, bit1: 拡張レコードあり)は表示に影響しないため読み飛ばす
  if (numPoints === 0) throw new Error("SPZ: 点数が0です");
  const shDim = spzDimForDegree(shDegree);
  const rotBytes = version >= MIN_SMALLEST_THREE_VERSION ? 4 : 3;

  const sizes = [numPoints * 9, numPoints, numPoints * 3, numPoints * 3, numPoints * rotBytes];
  const shSize = numPoints * shDim * 3;
  const totalNeeded = 16 + sizes.reduce((a, b) => a + b, 0) + shSize;
  if (bytes.length < totalNeeded) {
    throw new Error("SPZ: データが宣言された点数より短くファイルが壊れています");
  }
  let o = 16;
  const take = (n: number) => {
    const s = bytes.subarray(o, o + n);
    o += n;
    return s;
  };
  return {
    numPoints, shDegree, fractionalBits, version,
    positions: take(sizes[0]),
    alphas: take(sizes[1]),
    colors: take(sizes[2]),
    scales: take(sizes[3]),
    rotations: take(sizes[4]),
    // sh(shSize分)は読み飛ばし
  };
}

/** version 4: 32Bヘッダ + TOC + 属性別ZSTDストリーム */
async function parseV4(
  bytes: Uint8Array,
  zstd: DecompressFn | undefined
): Promise<SpzStreams> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 4) throw new Error(`SPZ: 未対応のversionです: ${version}`);
  if (!zstd) {
    throw new Error(
      "SPZ v4はZSTD圧縮ですが、このブラウザはZSTD展開(DecompressionStream)に非対応です。" +
      "公式ツール nianticlabs.github.io/spz でPLYに変換してください"
    );
  }
  if (bytes.length < 32) throw new Error("SPZ: ヘッダが短すぎます");
  const numPoints = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  const numStreams = view.getUint8(15);
  const tocByteOffset = view.getUint32(16, true);
  if (numPoints === 0) throw new Error("SPZ: 点数が0です");
  const shDim = spzDimForDegree(shDegree);
  if (tocByteOffset < 32 || tocByteOffset + numStreams * 16 > bytes.length) {
    throw new Error("SPZ: TOCの位置が不正でファイルが壊れています");
  }
  // 期待する非圧縮サイズ(公式の属性順。サイズ0のストリームは省略される)
  const expected = [
    numPoints * 9,      // positions
    numPoints,          // alphas
    numPoints * 3,      // colors
    numPoints * 3,      // scales
    numPoints * 4,      // rotations(v4は常にsmallest-three)
    numPoints * shDim * 3, // sh
  ].filter((s) => s > 0);
  if (expected.length !== numStreams) {
    throw new Error(`SPZ: ストリーム数が不正です(期待${expected.length}, 実際${numStreams})`);
  }

  const streams: Uint8Array[] = [];
  let dataOffset = tocByteOffset + numStreams * 16;
  for (let i = 0; i < numStreams; i++) {
    const e = tocByteOffset + i * 16;
    const compressedSize = Number(view.getBigUint64(e, true));
    const uncompressedSize = Number(view.getBigUint64(e + 8, true));
    if (uncompressedSize !== expected[i]) {
      throw new Error("SPZ: ストリームサイズがヘッダと矛盾しファイルが壊れています");
    }
    if (dataOffset + compressedSize > bytes.length) {
      throw new Error("SPZ: ストリームがファイル末尾を越えておりファイルが壊れています");
    }
    const decompressed = await zstd(bytes.subarray(dataOffset, dataOffset + compressedSize));
    if (decompressed.length !== uncompressedSize) {
      throw new Error("SPZ: 展開後サイズがTOCと一致しません");
    }
    streams.push(decompressed);
    dataOffset += compressedSize;
  }

  return {
    numPoints, shDegree, fractionalBits, version,
    positions: streams[0],
    alphas: streams[1],
    colors: streams[2],
    scales: streams[3],
    rotations: streams[4],
    // streams[5](SH)は読み飛ばし
  };
}

const clamp255 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x);
const CHUNK_POINTS = 65536;

export async function parseSpz(
  data: ArrayBuffer,
  onProgress?: ProgressCallback,
  decompressors: SpzDecompressors = defaultDecompressors()
): Promise<SplatData> {
  const raw = new Uint8Array(data);
  if (raw.length < 4) throw new Error("SPZ: ファイルが短すぎます");

  let s: SpzStreams;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    let inflated: Uint8Array;
    try {
      inflated = await decompressors.gzip(raw);
    } catch {
      throw new Error("SPZ: gzip展開に失敗しました(ファイルが壊れています)");
    }
    s = parseLegacyPayload(inflated);
  } else if (new DataView(data).getUint32(0, true) === NGSP_MAGIC) {
    s = await parseV4(raw, decompressors.zstd);
  } else {
    throw new Error("SPZ: 未知の形式です(gzipでもNGSPでもありません)");
  }

  const { buffer, f32, u8 } = createSplatBuffer(s.numPoints);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const posScale = 1 / (1 << s.fractionalBits);
  const smallestThree = s.version >= MIN_SMALLEST_THREE_VERSION;
  const q = [0, 0, 0, 0]; // (x,y,z,w) 作業用

  for (let start = 0; start < s.numPoints; start += CHUNK_POINTS) {
    const end = Math.min(start + CHUNK_POINTS, s.numPoints);
    for (let i = start; i < end; i++) {
      const fo = i * FLOATS_PER_POINT;

      // 位置: 24bit固定小数点LE + 符号拡張
      for (let k = 0; k < 3; k++) {
        const b = i * 9 + k * 3;
        let fixed = s.positions[b] | (s.positions[b + 1] << 8) | (s.positions[b + 2] << 16);
        if (fixed & 0x800000) fixed -= 0x1000000;
        const v = fixed * posScale;
        f32[fo + k] = v;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }

      // 色: f_dc復元 → SH0で表示RGBへ。αはそのまま
      const co = i * FLOATS_PER_POINT * 4 + OFFSET_COLOR;
      for (let k = 0; k < 3; k++) {
        const fdc = (s.colors[i * 3 + k] / 255 - 0.5) / SPZ_COLOR_SCALE;
        u8[co + k] = clamp255(Math.round((0.5 + SH_C0 * fdc) * 255));
      }
      u8[co + 3] = s.alphas[i];

      // scale: log符号化u8 → 線形値
      const so = fo + OFFSET_SCALE / 4;
      for (let k = 0; k < 3; k++) {
        f32[so + k] = Math.exp(s.scales[i * 3 + k] / 16 - 10);
      }

      // rotation
      if (smallestThree) {
        const b = i * 4;
        const comp =
          (s.rotations[b] | (s.rotations[b + 1] << 8) | (s.rotations[b + 2] << 16) |
            (s.rotations[b + 3] << 24)) >>> 0;
        const iLargest = comp >>> 30;
        let rest = comp;
        let sumSq = 0;
        for (let k = 3; k >= 0; k--) {
          if (k === iLargest) continue;
          const mag = rest & 0x1ff;
          const neg = (rest >>> 9) & 1;
          rest = rest >>> 10;
          let v = (Math.SQRT1_2 * mag) / 511;
          if (neg) v = -v;
          q[k] = v;
          sumSq += v * v;
        }
        q[iLargest] = Math.sqrt(Math.max(0, 1 - sumSq));
      } else {
        const b = i * 3;
        q[0] = s.rotations[b] / 127.5 - 1;
        q[1] = s.rotations[b + 1] / 127.5 - 1;
        q[2] = s.rotations[b + 2] / 127.5 - 1;
        q[3] = Math.sqrt(Math.max(0, 1 - (q[0] * q[0] + q[1] * q[1] + q[2] * q[2])));
      }
      // 内部バッファは(w,x,y,z)順(types.ts)
      const ro = fo + OFFSET_ROTATION / 4;
      f32[ro] = q[3]; f32[ro + 1] = q[0]; f32[ro + 2] = q[1]; f32[ro + 3] = q[2];
    }
    onProgress?.(end, s.numPoints);
    if (end < s.numPoints) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return {
    numPoints: s.numPoints,
    buffer,
    format: "spz",
    shDegree: s.shDegree,
    bounds: { min, max },
  };
}
