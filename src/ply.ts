/**
 * PLYパーサ(設計書3.1)
 *
 * 対応バリアント(headerのproperty構成で自動判定):
 *  - 3DGS標準PLY: x,y,z, f_dc_0..2, (f_rest_*), opacity, scale_0..2, rot_0..3
 *  - RGB点群PLY:  x,y,z, red,green,blue (nx,ny,nz等は無視)
 *  - 色情報なしのxyz PLYは白点として読む
 *
 * ascii / binary_little_endian 対応。binary_big_endian はエラー。
 * 未知のpropertyは読み飛ばす。
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

/** 3DGSのSH 0次係数→色変換定数(設計書3.1) */
export const SH_C0 = 0.28209479177387814;

type PlyScalarType =
  | "char" | "uchar" | "short" | "ushort" | "int" | "uint"
  | "float" | "double";

const TYPE_ALIASES: Record<string, PlyScalarType> = {
  char: "char", int8: "char",
  uchar: "uchar", uint8: "uchar",
  short: "short", int16: "short",
  ushort: "ushort", uint16: "ushort",
  int: "int", int32: "int",
  uint: "uint", uint32: "uint",
  float: "float", float32: "float",
  double: "double", float64: "double",
};

const TYPE_SIZES: Record<PlyScalarType, number> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
};

interface PlyProperty {
  name: string;
  type: PlyScalarType;
  /** element内の先頭からのバイトオフセット(binary用) */
  byteOffset: number;
  /** 何番目のプロパティか(ascii用) */
  index: number;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
  strideBytes: number;
  hasListProperty: boolean;
}

export interface PlyHeader {
  format: "ascii" | "binary_little_endian" | "binary_big_endian";
  elements: PlyElement[];
  /** ヘッダ末尾("end_header\n"直後)のバイトオフセット */
  dataOffset: number;
}

export function parsePlyHeader(bytes: Uint8Array): PlyHeader {
  // end_header を探す(ヘッダはASCIIなのでバイト走査で安全)
  const marker = "end_header";
  const limit = Math.min(bytes.length, 64 * 1024);
  let headerEnd = -1;
  for (let i = 0; i + marker.length <= limit; i++) {
    if (bytes[i] === 0x65 /* e */) {
      let ok = true;
      for (let j = 0; j < marker.length; j++) {
        if (bytes[i + j] !== marker.charCodeAt(j)) { ok = false; break; }
      }
      if (ok) { headerEnd = i; break; }
    }
  }
  if (headerEnd < 0) throw new Error("PLY: end_header が見つかりません");
  // end_header 行の改行の次がデータ先頭
  let dataOffset = headerEnd + marker.length;
  while (dataOffset < bytes.length && bytes[dataOffset] !== 0x0a) dataOffset++;
  dataOffset++;

  const headerText = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  const lines = headerText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines[0] !== "ply") throw new Error("PLY: magicが不正です(plyで始まっていません)");

  let format: PlyHeader["format"] | null = null;
  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;

  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case "format": {
        const f = parts[1];
        if (f !== "ascii" && f !== "binary_little_endian" && f !== "binary_big_endian") {
          throw new Error(`PLY: 未知のformat: ${f}`);
        }
        format = f;
        break;
      }
      case "comment":
      case "obj_info":
        break;
      case "element": {
        current = {
          name: parts[1],
          count: parseInt(parts[2], 10),
          properties: [],
          strideBytes: 0,
          hasListProperty: false,
        };
        elements.push(current);
        break;
      }
      case "property": {
        if (!current) throw new Error("PLY: element宣言前のproperty");
        if (parts[1] === "list") {
          current.hasListProperty = true;
          break;
        }
        const type = TYPE_ALIASES[parts[1]];
        if (!type) throw new Error(`PLY: 未知のproperty型: ${parts[1]}`);
        current.properties.push({
          name: parts[2],
          type,
          byteOffset: current.strideBytes,
          index: current.properties.length,
        });
        current.strideBytes += TYPE_SIZES[type];
        break;
      }
      default:
        break; // 未知のヘッダ行は無視
    }
  }
  if (!format) throw new Error("PLY: format行がありません");
  return { format, elements, dataOffset };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp255 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x);

/** f_rest_* の本数からSH次数を求める(0,9,24,45本 → 0,1,2,3次) */
export function shDegreeFromRestCount(restCount: number): number {
  const perChannel = restCount / 3;
  if (perChannel >= 15) return 3;
  if (perChannel >= 8) return 2;
  if (perChannel >= 3) return 1;
  return 0;
}

/** パース中にUIを固めないためのyield間隔(点数) */
const CHUNK_POINTS = 65536;

export async function parsePly(
  data: ArrayBuffer,
  onProgress?: ProgressCallback
): Promise<SplatData> {
  const bytes = new Uint8Array(data);
  const header = parsePlyHeader(bytes);

  if (header.format === "binary_big_endian") {
    throw new Error("PLY: binary_big_endian は非対応です");
  }

  const vertexIndex = header.elements.findIndex((e) => e.name === "vertex");
  if (vertexIndex < 0) throw new Error("PLY: vertex要素がありません");
  const vertex = header.elements[vertexIndex];
  if (vertex.hasListProperty) {
    throw new Error("PLY: vertex要素のlistプロパティは非対応です");
  }
  if (vertex.count <= 0) throw new Error("PLY: 頂点数が0です");

  const prop = new Map(vertex.properties.map((p) => [p.name, p]));
  const need = (name: string): PlyProperty => {
    const p = prop.get(name);
    if (!p) throw new Error(`PLY: 必須プロパティ ${name} がありません`);
    return p;
  };

  const px = need("x"), py = need("y"), pz = need("z");
  const is3dgs = prop.has("f_dc_0");
  const hasRgb = prop.has("red") && prop.has("green") && prop.has("blue");

  const restCount = vertex.properties.filter((p) => p.name.startsWith("f_rest_")).length;
  const shDegree = is3dgs ? shDegreeFromRestCount(restCount) : 0;

  const { buffer, f32, u8 } = createSplatBuffer(vertex.count);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  // 3DGS用プロパティ(存在する場合のみ)
  const gs = is3dgs
    ? {
        dc: [need("f_dc_0"), need("f_dc_1"), need("f_dc_2")],
        opacity: need("opacity"),
        scale: [need("scale_0"), need("scale_1"), need("scale_2")],
        rot: [need("rot_0"), need("rot_1"), need("rot_2"), need("rot_3")],
      }
    : null;
  const rgb = !is3dgs && hasRgb
    ? { r: need("red"), g: need("green"), b: need("blue") }
    : null;

  // 値の読み出し方(ascii: トークン列 / binary: DataView)を関数に抽象化
  let readValue: (pointIndex: number, p: PlyProperty) => number;

  if (header.format === "ascii") {
    const text = new TextDecoder().decode(bytes.subarray(header.dataOffset));
    // vertexより前のelementの行数をスキップ
    let skipRows = 0;
    for (let i = 0; i < vertexIndex; i++) skipRows += header.elements[i].count;
    const rows = text.split("\n");
    const propsPerRow = vertex.properties.length;
    // 空行を除いた実データ行を抽出
    const dataRows: string[] = [];
    for (const row of rows) {
      const t = row.trim();
      if (t.length > 0) dataRows.push(t);
    }
    if (dataRows.length < skipRows + vertex.count) {
      throw new Error("PLY: データ行数が頂点数より少なくファイルが壊れています");
    }
    const tokensCache: string[][] = new Array(vertex.count);
    readValue = (i, p) => {
      let tokens = tokensCache[i];
      if (!tokens) {
        tokens = dataRows[skipRows + i].split(/\s+/);
        if (tokens.length < propsPerRow) {
          throw new Error(`PLY: ${skipRows + i}行目の列数が不足しています`);
        }
        tokensCache[i] = tokens;
      }
      return parseFloat(tokens[p.index]);
    };
  } else {
    // binary_little_endian: vertexより前のelementはlistが無ければ固定長スキップ可能
    let offset = header.dataOffset;
    for (let i = 0; i < vertexIndex; i++) {
      const e = header.elements[i];
      if (e.hasListProperty) {
        throw new Error("PLY: vertexより前のlistプロパティ付きelementは非対応です");
      }
      offset += e.count * e.strideBytes;
    }
    const stride = vertex.strideBytes;
    if (offset + vertex.count * stride > bytes.length) {
      throw new Error("PLY: データがヘッダ宣言の頂点数より短くファイルが壊れています");
    }
    const view = new DataView(data, offset);
    readValue = (i, p) => {
      const at = i * stride + p.byteOffset;
      switch (p.type) {
        case "float": return view.getFloat32(at, true);
        case "double": return view.getFloat64(at, true);
        case "uchar": return view.getUint8(at);
        case "char": return view.getInt8(at);
        case "ushort": return view.getUint16(at, true);
        case "short": return view.getInt16(at, true);
        case "uint": return view.getUint32(at, true);
        case "int": return view.getInt32(at, true);
      }
    };
  }

  // 色プロパティがfloat型(0..1)ならスケールする
  const colorScale = rgb && rgb.r.type === "float" ? 255 : 1;

  for (let start = 0; start < vertex.count; start += CHUNK_POINTS) {
    const end = Math.min(start + CHUNK_POINTS, vertex.count);
    for (let i = start; i < end; i++) {
      const fo = i * FLOATS_PER_POINT;
      const x = readValue(i, px), y = readValue(i, py), z = readValue(i, pz);
      f32[fo] = x; f32[fo + 1] = y; f32[fo + 2] = z;
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;

      const co = i * FLOATS_PER_POINT * 4 + OFFSET_COLOR;
      if (gs) {
        u8[co] = clamp255(Math.round((0.5 + SH_C0 * readValue(i, gs.dc[0])) * 255));
        u8[co + 1] = clamp255(Math.round((0.5 + SH_C0 * readValue(i, gs.dc[1])) * 255));
        u8[co + 2] = clamp255(Math.round((0.5 + SH_C0 * readValue(i, gs.dc[2])) * 255));
        u8[co + 3] = clamp255(Math.round(sigmoid(readValue(i, gs.opacity)) * 255));

        const so = fo + OFFSET_SCALE / 4;
        f32[so] = Math.exp(readValue(i, gs.scale[0]));
        f32[so + 1] = Math.exp(readValue(i, gs.scale[1]));
        f32[so + 2] = Math.exp(readValue(i, gs.scale[2]));

        // 3DGS PLYのrot_0..3は(w,x,y,z)。正規化して格納
        let qw = readValue(i, gs.rot[0]);
        let qx = readValue(i, gs.rot[1]);
        let qy = readValue(i, gs.rot[2]);
        let qz = readValue(i, gs.rot[3]);
        const n = Math.hypot(qw, qx, qy, qz) || 1;
        const ro = fo + OFFSET_ROTATION / 4;
        f32[ro] = qw / n; f32[ro + 1] = qx / n; f32[ro + 2] = qy / n; f32[ro + 3] = qz / n;
      } else {
        if (rgb) {
          u8[co] = clamp255(Math.round(readValue(i, rgb.r) * colorScale));
          u8[co + 1] = clamp255(Math.round(readValue(i, rgb.g) * colorScale));
          u8[co + 2] = clamp255(Math.round(readValue(i, rgb.b) * colorScale));
        } else {
          u8[co] = 255; u8[co + 1] = 255; u8[co + 2] = 255;
        }
        u8[co + 3] = 255;
        // scaleは0のまま、rotationは単位クォータニオン
        f32[fo + OFFSET_ROTATION / 4] = 1;
      }
    }
    onProgress?.(end, vertex.count);
    if (end < vertex.count) {
      // メインスレッドを解放(ブラウザでのUIフリーズ防止。Node/vitestでも動作)
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return {
    numPoints: vertex.count,
    buffer,
    format: is3dgs ? "ply-3dgs" : "ply-points",
    shDegree,
    bounds: { min, max },
  };
}
