/**
 * アプリ本体: キャンバス初期化、ファイル読込、UI配線、描画ループ
 */
import { parsePly } from "./ply";
import { parseSpz } from "./spz";
import { SplatData, FLOATS_PER_POINT } from "./types";
import { OrbitCamera, attachCameraControls } from "./camera";
import { PointRenderer } from "./pointRenderer";
import { SplatRenderer } from "./splatRenderer";
import { mat4Identity, mat4Multiply } from "./math";
import SortWorker from "./sortWorker?worker&inline";

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
const splatRenderer = new SplatRenderer(gl);

let scene: SplatData | null = null;
let bgColor: [number, number, number] = [0, 0, 0];
let pointSize = 2;
let attenuation = true;
let flipY = false;
let mode: "points" | "splats" = "points";
let splatScale = 1;

// ─── デプスソートWorker(設計書4章: カメラ移動閾値超過時のみ再ソート) ───
const sortWorker = new SortWorker();
let sortInFlight = false;
let sortQueued = false;
let sortEpoch = 0;
/** 前回ソート時の視線方向(view*modelのz行)。nullなら未ソート */
let lastSortRowZ: [number, number, number] | null = null;
/** 視線方向の変化がこの内積を下回ったら再ソート(≈1.1°) */
const RESORT_DOT_THRESHOLD = 0.9998;

sortWorker.onmessage = (e: MessageEvent<{ type: string; indices: Uint32Array; epoch: number }>) => {
  if (e.data.type !== "sorted") return;
  splatRenderer.updateSortOrder(e.data.indices);
  sortInFlight = false;
  if (sortQueued) {
    sortQueued = false;
    requestSort();
  }
};

function currentRowZ(): [number, number, number] {
  const vm = mat4Multiply(new Float32Array(16), camera.viewMatrix(), currentModel());
  return [vm[2], vm[6], vm[10]];
}

function requestSort(): void {
  if (!scene) return;
  if (sortInFlight) {
    sortQueued = true;
    return;
  }
  const rowZ = currentRowZ();
  lastSortRowZ = rowZ;
  sortInFlight = true;
  sortWorker.postMessage({ type: "sort", rowZ, epoch: ++sortEpoch });
}

/** 平行移動はz順序を変えないため、視線方向(回転)の変化だけを再ソート条件にする */
function maybeResort(): void {
  if (!scene || mode !== "splats") return;
  if (!lastSortRowZ) {
    requestSort();
    return;
  }
  const r = currentRowZ();
  const dot =
    r[0] * lastSortRowZ[0] + r[1] * lastSortRowZ[1] + r[2] * lastSortRowZ[2];
  if (dot < RESORT_DOT_THRESHOLD) requestSort();
}

// モデル行列: 3DGSデータは一般にY下向きのため上下反転(Y,Z符号反転)を適用
const modelIdentity = mat4Identity();
const modelFlipped = mat4Identity();
modelFlipped[5] = -1;
modelFlipped[10] = -1;

function currentModel(): Float32Array {
  return flipY ? modelFlipped : modelIdentity;
}

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
($("splat-scale") as HTMLInputElement).addEventListener("input", (e) => {
  splatScale = parseFloat((e.target as HTMLInputElement).value);
});

// ─── モード切替(設計書4章: シェーダプログラムのみ切替、再アップロードなし) ───
const modePointsBtn = $("mode-points") as HTMLButtonElement;
const modeSplatsBtn = $("mode-splats") as HTMLButtonElement;

function setMode(next: "points" | "splats"): void {
  if (next === "splats" && modeSplatsBtn.disabled) return;
  mode = next;
  modePointsBtn.classList.toggle("active", mode === "points");
  modeSplatsBtn.classList.toggle("active", mode === "splats");
}
modePointsBtn.addEventListener("click", () => setMode("points"));
modeSplatsBtn.addEventListener("click", () => setMode("splats"));

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
    const onProgress = (done: number, total: number) => {
      progressFill.style.width = `${Math.round((done / total) * 100)}%`;
    };
    let parsed: SplatData;
    if (ext === "ply") {
      parsed = await parsePly(data, onProgress);
    } else if (ext === "spz") {
      parsed = await parseSpz(data, onProgress);
    } else {
      throw new Error(`未対応の拡張子です: .${ext}`);
    }

    scene = parsed;
    pointRenderer.setData(parsed);
    splatRenderer.setData(parsed);
    camera.fitToBounds(parsed.bounds.min, parsed.bounds.max);
    pointRenderer.refDistance = camera.distance;

    // Workerへ点座標を転送(ソート用にxyzのみ抽出)
    const f32 = new Float32Array(parsed.buffer);
    const positions = new Float32Array(parsed.numPoints * 3);
    for (let i = 0; i < parsed.numPoints; i++) {
      positions[i * 3] = f32[i * FLOATS_PER_POINT];
      positions[i * 3 + 1] = f32[i * FLOATS_PER_POINT + 1];
      positions[i * 3 + 2] = f32[i * FLOATS_PER_POINT + 2];
    }
    sortWorker.postMessage({ type: "data", positions: positions.buffer }, [positions.buffer]);
    lastSortRowZ = null; // 次フレームで初回ソート

    // ガウシアン属性を持たないRGB点群ではスプラットモードを無効化
    const hasGaussians = parsed.format !== "ply-points";
    modeSplatsBtn.disabled = !hasGaussians;
    modeSplatsBtn.title = hasGaussians ? "" : "RGB点群にはガウシアン属性がありません";
    if (!hasGaussians) setMode("points");

    // 3DGS PLYはY下向き規約が多いのでデフォルトで上下反転をON。
    // SPZはRUB(Y上)なので反転不要
    flipY = parsed.format === "ply-3dgs";
    ($("flip-y") as HTMLInputElement).checked = flipY;

    infoEl.innerHTML = [
      escapeHtml(file.name),
      `${parsed.numPoints.toLocaleString()} 点 · ${FORMAT_LABELS[parsed.format]}`,
      parsed.format !== "ply-points" ? `SH次数 ${parsed.shDegree}` : null,
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
    const aspect = canvas.width / canvas.height;
    if (mode === "splats") {
      maybeResort();
      const viewModel = mat4Multiply(new Float32Array(16), camera.viewMatrix(), currentModel());
      const focalPx = (0.5 * canvas.height) / Math.tan(((camera.fovYDeg / 2) * Math.PI) / 180);
      splatRenderer.draw(viewModel, camera.projMatrix(aspect), {
        splatScale,
        focalPx,
        viewportWidth: canvas.width,
        viewportHeight: canvas.height,
      });
    } else {
      pointRenderer.draw(camera.viewProjMatrix(aspect), {
        pointSize,
        attenuation,
        model: currentModel(),
      });
    }
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
