/**
 * モードB: ガウシアンスプラッティングレンダラー(設計書4章)
 *
 * - 1スプラット = インスタンス化クアッド(TRIANGLE_STRIP 4頂点)
 * - scale+rot → 3D共分散 → ヤコビアン投影 → 2D共分散 → 楕円描画(EWA)
 * - ブレンド: ONE, ONE_MINUS_SRC_ALPHA(premultiplied)、デプステスト無効
 * - スプラット本体データはロード時にRGBA32UIテクスチャへ一度だけアップロード
 *   (interleaved CPUバッファ48B/点 = テクセル16B×3をそのまま転送)。
 *   Workerのソート結果は4B/点のインデックスVBOの更新のみ → 本体の再アップロードなし
 */
import { Mat4 } from "./math";
import { SplatData, STRIDE_BYTES } from "./types";
import { createProgram } from "./pointRenderer";

/** テクスチャ幅(テクセル)。3の倍数にして1スプラット3テクセルが行を跨がないようにする */
const TEX_WIDTH = 3072;
const SPLATS_PER_ROW = TEX_WIDTH / 3;

/** ガウシアンを描画する範囲(σ単位) */
const CUTOFF_SIGMA = "3.0";

const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
layout(location=0) in vec2 aCorner;  // クアッド角 [-1,1]
layout(location=1) in uint aIndex;   // ソート済みスプラットindex(インスタンスごと)
uniform usampler2D uData;
uniform mat4 uView;      // view * model
uniform mat4 uProj;
uniform vec2 uFocal;     // 焦点距離(px)
uniform vec2 uViewport;  // キャンバスサイズ(px)
uniform float uSplatScale;
out vec4 vColor;
out vec2 vUv;

const float CUTOFF = ${CUTOFF_SIGMA};

void main() {
  int base = int(aIndex) * 3;
  ivec2 tc = ivec2(base % ${TEX_WIDTH}, base / ${TEX_WIDTH});
  uvec4 d0 = texelFetch(uData, tc, 0);
  uvec4 d1 = texelFetch(uData, ivec2(tc.x + 1, tc.y), 0);
  uvec4 d2 = texelFetch(uData, ivec2(tc.x + 2, tc.y), 0);

  vec3 pos = uintBitsToFloat(d0.xyz);
  vec4 color = vec4(
    float(d0.w & 0xffu), float((d0.w >> 8) & 0xffu),
    float((d0.w >> 16) & 0xffu), float((d0.w >> 24) & 0xffu)) / 255.0;
  vec3 scale = uintBitsToFloat(d1.xyz) * uSplatScale;
  vec4 q = uintBitsToFloat(d2); // (w,x,y,z)

  vec4 cam = uView * vec4(pos, 1.0);
  vec4 clip = uProj * cam;
  // カメラ背後・画面大きく外は退避(全4頂点が同条件なので破綻しない)
  vec3 ndc = clip.xyz / clip.w;
  if (clip.w <= 0.0 || abs(ndc.x) > 1.3 || abs(ndc.y) > 1.3) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // クォータニオン(w,x,y,z) → 回転行列
  float qw = q.x, qx = q.y, qy = q.z, qz = q.w;
  mat3 R = mat3(
    1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy + qw * qz), 2.0 * (qx * qz - qw * qy),
    2.0 * (qx * qy - qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz + qw * qx),
    2.0 * (qx * qz + qw * qy), 2.0 * (qy * qz - qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy));

  // 3D共分散 Σ = R S Sᵀ Rᵀ
  mat3 M = R * mat3(scale.x, 0, 0, 0, scale.y, 0, 0, 0, scale.z);
  mat3 sigma3d = M * transpose(M);

  // ヤコビアン(透視投影の局所線形化)
  float invZ = 1.0 / cam.z;
  float invZ2 = invZ * invZ;
  mat3 J = mat3(
    uFocal.x * invZ, 0.0, 0.0,
    0.0, uFocal.y * invZ, 0.0,
    -uFocal.x * cam.x * invZ2, -uFocal.y * cam.y * invZ2, 0.0);
  mat3 T = J * mat3(uView);
  mat3 cov = T * sigma3d * transpose(T);

  // 2D共分散の固有分解 → 楕円の主軸・副軸(px)
  // +0.3pxの膨張は元論文実装と同じ(サブピクセルのちらつき防止)
  float a = cov[0][0] + 0.3;
  float d = cov[1][1] + 0.3;
  float b = cov[0][1];
  float mid = 0.5 * (a + d);
  float disc = sqrt(max(mid * mid - (a * d - b * b), 1e-7));
  float l1 = mid + disc;
  float l2 = max(mid - disc, 1e-7);
  vec2 dir = (abs(b) < 1e-9) ? (a >= d ? vec2(1, 0) : vec2(0, 1)) : normalize(vec2(b, l1 - a));
  vec2 major = dir * sqrt(l1) * CUTOFF;
  vec2 minor = vec2(-dir.y, dir.x) * sqrt(l2) * CUTOFF;

  vec2 offsetPx = aCorner.x * major + aCorner.y * minor;
  gl_Position = vec4(ndc.xy + offsetPx / uViewport * 2.0, ndc.z, 1.0);
  vUv = aCorner * CUTOFF; // σ単位
  vColor = color;
}
`;

const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
in vec2 vUv;
out vec4 outColor;
void main() {
  float r2 = dot(vUv, vUv);
  float alpha = vColor.a * exp(-0.5 * r2);
  if (alpha < 1.0 / 255.0) discard;
  outColor = vec4(vColor.rgb * alpha, alpha); // premultiplied
}
`;

export interface SplatRenderOptions {
  splatScale: number;
  focalPx: number;
  viewportWidth: number;
  viewportHeight: number;
}

export class SplatRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private cornerVbo: WebGLBuffer | null = null;
  private indexVbo: WebGLBuffer | null = null;
  private dataTex: WebGLTexture | null = null;
  private numPoints = 0;
  private uView: WebGLUniformLocation;
  private uProj: WebGLUniformLocation;
  private uFocal: WebGLUniformLocation;
  private uViewport: WebGLUniformLocation;
  private uSplatScale: WebGLUniformLocation;
  private uData: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    this.uView = gl.getUniformLocation(this.program, "uView")!;
    this.uProj = gl.getUniformLocation(this.program, "uProj")!;
    this.uFocal = gl.getUniformLocation(this.program, "uFocal")!;
    this.uViewport = gl.getUniformLocation(this.program, "uViewport")!;
    this.uSplatScale = gl.getUniformLocation(this.program, "uSplatScale")!;
    this.uData = gl.getUniformLocation(this.program, "uData")!;
  }

  setData(data: SplatData): void {
    const gl = this.gl;
    this.dispose();
    this.numPoints = data.numPoints;

    const rows = Math.ceil(data.numPoints / SPLATS_PER_ROW);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (rows > maxTex) {
      throw new Error(`スプラット数が多すぎます(最大${SPLATS_PER_ROW * maxTex}点)`);
    }
    // 48B/点 = RGBA32UIテクセル×3。テクスチャ矩形に合わせて末尾をパディング
    const texels = new Uint32Array(rows * TEX_WIDTH * 4);
    texels.set(new Uint32Array(data.buffer, 0, (data.numPoints * STRIDE_BYTES) / 4));
    this.dataTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32UI, TEX_WIDTH, rows, 0,
      gl.RGBA_INTEGER, gl.UNSIGNED_INT, texels
    );

    // クアッド角(全インスタンス共通)
    this.cornerVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // ソート順インデックス(初期値は昇順。Workerの結果で更新)
    const identity = new Uint32Array(data.numPoints);
    for (let i = 0; i < data.numPoints; i++) identity[i] = i;
    this.indexVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexVbo);
    gl.bufferData(gl.ARRAY_BUFFER, identity, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  /** Workerのソート結果を反映(4B/点のみの転送) */
  updateSortOrder(indices: Uint32Array): void {
    if (!this.indexVbo || indices.length !== this.numPoints) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, indices);
  }

  draw(view: Mat4, proj: Mat4, opts: SplatRenderOptions): void {
    if (!this.vao || this.numPoints === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.uniform1i(this.uData, 0);
    gl.uniformMatrix4fv(this.uView, false, view);
    gl.uniformMatrix4fv(this.uProj, false, proj);
    gl.uniform2f(this.uFocal, opts.focalPx, opts.focalPx);
    gl.uniform2f(this.uViewport, opts.viewportWidth, opts.viewportHeight);
    gl.uniform1f(this.uSplatScale, opts.splatScale);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.numPoints);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.dataTex) { gl.deleteTexture(this.dataTex); this.dataTex = null; }
    if (this.cornerVbo) { gl.deleteBuffer(this.cornerVbo); this.cornerVbo = null; }
    if (this.indexVbo) { gl.deleteBuffer(this.indexVbo); this.indexVbo = null; }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    this.numPoints = 0;
  }
}
