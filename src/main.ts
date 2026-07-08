/**
 * アプリ本体: キャンバス初期化、ファイル読込、UI配線、描画ループ
 */
import { parsePly } from "./ply";
import { SplatData } from "./types";
import { OrbitCamera, attachCameraControls } from "./camera";
import { PointRenderer } from "./pointRenderer";
import { mat4Identity } from "./math";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const gl = canvas.getContext("webgl2", { antialias: false });
if (!gl) {
  document.getElementById("empty-hint")!.textContent =
    "WebGL2が利用できません。ブラウザ/デバイスを確認してください。";
  throw new Error("WebGL2 unavailable");
}

const camera = new OrbitCamera();
attachCameraControls(canvas, camera);
const pointRenderer = new PointRenderer(gl);

let scene: SplatData | null = null;
let bgColor: [number, number, number] = [0, 0, 0];
let pointSize = 2;
let attenuation = true;
let flipY = false;

// モデル行列: 3DGSデータは一般にY下向きのため上下反転(Y,Z符号反転)を適用
const modelIdentity = mat4Identity();
const modelFlipped = mat4Identity();
modelFlipped[5] = -1;
modelFlipped[10] = -1;

// ─── DPI対応リサイズ ───
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener("resize", resize);

// ─── UI要素 ───
const $ = (id: string) => document.getElementById(id)!;
const infoEl = $("info");
const fpsEl = $("fps");
const progressEl = $("progress");
const progressLabel = $("progress-label");
const progressFill = $("progress-fill");
const emptyHint = $("empty-hint");

$("panel-header").addEventListener("click", () => {
  const panel = $("panel");
  panel.classList.toggle("collapsed");
  $("panel-toggle").textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
});

$("file-button").addEventListener("click", () => ($("file-input") as HTMLInputElement).click());
$("file-input").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
});

($("point-size") as HTMLInputElement).addEventListener("input", (e) => {
  pointSize = parseFloat((e.target as HTMLInputElement).value);
});
($("attenuation") as HTMLInputElement).addEventListener("change", (e) => {
  attenuation = (e.target as HTMLInputElement).checked;
});
($("flip-y") as HTMLInputElement).addEventListener("change", (e) => {
  flipY = (e.target as HTMLInputElement).checked;
});

$("bg-black").addEventListener("click", () => {
  bgColor = [0, 0, 0];
  $("bg-black").classList.add("active");
  $("bg-white").classList.remove("active");
});
$("bg-white").addEventListener("click", () => {
  bgColor = [1, 1, 1];
  $("bg-white").classList.add("active");
  $("bg-black").classList.remove("active");
});

// ─── ドラッグ&ドロップ ───
const dropOverlay = $("drop-overlay");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("visible");
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove("visible"); }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("visible");
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

// ─── ファイル読込 ───
const FORMAT_LABELS: Record<SplatData["format"], string> = {
  "ply-3dgs": "PLY (3DGS)",
  "ply-points": "PLY (点群)",
  "spz": "SPZ",
};

async function loadFile(file: File): Promise<void> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  progressLabel.textContent = `読込中… ${file.name}`;
  progressFill.style.width = "0%";
  progressEl.classList.add("visible");
  try {
    const data = await file.arrayBuffer();
    let parsed: SplatData;
    if (ext === "ply") {
      parsed = await parsePly(data, (done, total) => {
        progressFill.style.width = `${Math.round((done / total) * 100)}%`;
      });
    } else if (ext === "spz") {
      throw new Error("SPZはPhase 2で対応予定です");
    } else {
      throw new Error(`未対応の拡張子です: .${ext}`);
    }

    scene = parsed;
    pointRenderer.setData(parsed);
    camera.fitToBounds(parsed.bounds.min, parsed.bounds.max);
    pointRenderer.refDistance = camera.distance;

    // 3DGSデータはY下向き規約が多いのでデフォルトで上下反転をON
    flipY = parsed.format === "ply-3dgs";
    ($("flip-y") as HTMLInputElement).checked = flipY;

    infoEl.innerHTML = [
      escapeHtml(file.name),
      `${parsed.numPoints.toLocaleString()} 点 · ${FORMAT_LABELS[parsed.format]}`,
      parsed.format === "ply-3dgs" ? `SH次数 ${parsed.shDegree}` : null,
    ].filter(Boolean).join("<br>");
    emptyHint.style.display = "none";
  } catch (err) {
    infoEl.textContent = `エラー: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    progressEl.classList.remove("visible");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ─── FPSカウンタ ───
let frameCount = 0;
let fpsWindowStart = performance.now();

// ─── 描画ループ ───
function frame(now: number): void {
  resize();
  gl!.viewport(0, 0, canvas.width, canvas.height);
  gl!.clearColor(bgColor[0], bgColor[1], bgColor[2], 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);

  if (scene) {
    const viewProj = camera.viewProjMatrix(canvas.width / canvas.height);
    pointRenderer.draw(viewProj, {
      pointSize,
      attenuation,
      model: flipY ? modelFlipped : modelIdentity,
    });
  }

  frameCount++;
  if (now - fpsWindowStart >= 500) {
    fpsEl.textContent = `${Math.round((frameCount * 1000) / (now - fpsWindowStart))} fps`;
    frameCount = 0;
    fpsWindowStart = now;
  }
  requestAnimationFrame(frame);
}
resize();
requestAnimationFrame(frame);
