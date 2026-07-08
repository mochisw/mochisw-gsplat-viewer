/**
 * モードA: 点表示レンダラー(設計書4章)
 * gl.POINTS + gl_PointSize。ソート不要・不透明描画。
 *
 * interleaved バッファ(types.ts のレイアウト)をそのままVBOに载せ、
 * 点表示では position + color のみを attribute として参照する。
 * Phase 3 のスプラットレンダラーも同じVBOを共有する前提。
 */
import { Mat4 } from "./math";
import { SplatData, STRIDE_BYTES, OFFSET_POSITION, OFFSET_COLOR } from "./types";

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uPointSize;      // 基準サイズ(px)
uniform float uAttenuation;    // 0: 固定サイズ, 1: 距離減衰
uniform float uRefDistance;    // 減衰の基準距離
out vec4 vColor;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  gl_Position = uViewProj * world;
  float size = uPointSize;
  if (uAttenuation > 0.5) {
    size = uPointSize * uRefDistance / max(gl_Position.w, 1e-4);
  }
  gl_PointSize = clamp(size, 1.0, 64.0);
  vColor = aColor;
}
`;

const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor.rgb, 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("シェーダコンパイル失敗: " + gl.getShaderInfoLog(s));
  }
  return s;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("シェーダリンク失敗: " + gl.getProgramInfoLog(p));
  }
  return p;
}

export interface PointRenderOptions {
  pointSize: number;
  attenuation: boolean;
  /** モデル行列(3DGSの上下反転などに使用) */
  model: Mat4;
}

export class PointRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private numPoints = 0;
  private uViewProj: WebGLUniformLocation;
  private uModel: WebGLUniformLocation;
  private uPointSize: WebGLUniformLocation;
  private uAttenuation: WebGLUniformLocation;
  private uRefDistance: WebGLUniformLocation;
  /** fitToBoundsで決めた基準距離。減衰モードでこの距離のとき等倍表示 */
  refDistance = 5;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.uModel = gl.getUniformLocation(this.program, "uModel")!;
    this.uPointSize = gl.getUniformLocation(this.program, "uPointSize")!;
    this.uAttenuation = gl.getUniformLocation(this.program, "uAttenuation")!;
    this.uRefDistance = gl.getUniformLocation(this.program, "uRefDistance")!;
  }

  /** シーンをGPUへアップロード(モード切替時は再アップロード不要) */
  setData(data: SplatData): void {
    const gl = this.gl;
    this.dispose();
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.buffer, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE_BYTES, OFFSET_POSITION);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE_BYTES, OFFSET_COLOR);
    gl.bindVertexArray(null);

    this.numPoints = data.numPoints;
  }

  draw(viewProj: Mat4, opts: PointRenderOptions): void {
    if (!this.vao || this.numPoints === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(this.uModel, false, opts.model);
    gl.uniform1f(this.uPointSize, opts.pointSize);
    gl.uniform1f(this.uAttenuation, opts.attenuation ? 1 : 0);
    gl.uniform1f(this.uRefDistance, this.refDistance);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.POINTS, 0, this.numPoints);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.vbo) { this.gl.deleteBuffer(this.vbo); this.vbo = null; }
    if (this.vao) { this.gl.deleteVertexArray(this.vao); this.vao = null; }
    this.numPoints = 0;
  }
}
