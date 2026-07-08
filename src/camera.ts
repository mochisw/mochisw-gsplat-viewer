/**
 * Orbitカメラ + 入力ハンドリング(設計書5章)
 *  - orbit: 左ドラッグ / 1本指
 *  - pan:   右ドラッグ or Shift+ドラッグ / 2本指ドラッグ
 *  - zoom:  ホイール / ピンチ
 */
import { Mat4, Vec3, mat4Identity, mat4LookAt, mat4Multiply, mat4Perspective } from "./math";

export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  distance = 5;
  /** 方位角(rad)。0でZ+方向から見る */
  azimuth = 0;
  /** 仰角(rad) */
  elevation = 0.3;
  fovYDeg = 60;
  near = 0.01;
  far = 10000;

  minDistance = 0.01;
  maxDistance = 10000;

  /** カメラが動いたフレームを検知するためのカウンタ(Phase 3の再ソート判定用) */
  version = 0;

  private proj = mat4Identity();
  private view = mat4Identity();
  private viewProj = mat4Identity();

  eye(): Vec3 {
    const ce = Math.cos(this.elevation);
    return [
      this.target[0] + this.distance * ce * Math.sin(this.azimuth),
      this.target[1] + this.distance * Math.sin(this.elevation),
      this.target[2] + this.distance * ce * Math.cos(this.azimuth),
    ];
  }

  viewProjMatrix(aspect: number): Mat4 {
    mat4Perspective(this.proj, (this.fovYDeg * Math.PI) / 180, aspect, this.near, this.far);
    mat4LookAt(this.view, this.eye(), this.target, [0, 1, 0]);
    return mat4Multiply(this.viewProj, this.proj, this.view);
  }

  /** バウンディングボックスに合わせて位置をリセット */
  fitToBounds(min: Vec3, max: Vec3): void {
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
    const radius = Math.max(Math.hypot(dx, dy, dz) / 2, 1e-3);
    this.distance = radius * 1.8;
    this.minDistance = radius * 0.01;
    this.maxDistance = radius * 20;
    this.near = Math.max(radius * 0.001, 1e-4);
    this.far = radius * 100;
    this.azimuth = 0;
    this.elevation = 0.3;
    this.version++;
  }

  orbit(dxPx: number, dyPx: number): void {
    this.azimuth -= dxPx * 0.005;
    this.elevation += dyPx * 0.005;
    const lim = Math.PI / 2 - 0.001;
    this.elevation = Math.max(-lim, Math.min(lim, this.elevation));
    this.version++;
  }

  pan(dxPx: number, dyPx: number, viewportHeight: number): void {
    // 画面上のピクセル移動量をtarget平面でのワールド移動量に変換
    const worldPerPx =
      (2 * this.distance * Math.tan(((this.fovYDeg / 2) * Math.PI) / 180)) / viewportHeight;
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const sa = Math.sin(this.azimuth), ca = Math.cos(this.azimuth);
    // カメラ右方向・上方向
    const right: Vec3 = [ca, 0, -sa];
    const up: Vec3 = [-se * sa, ce, -se * ca];
    const mx = -dxPx * worldPerPx, my = dyPx * worldPerPx;
    this.target[0] += right[0] * mx + up[0] * my;
    this.target[1] += right[1] * mx + up[1] * my;
    this.target[2] += right[2] * mx + up[2] * my;
    this.version++;
  }

  zoom(factor: number): void {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * factor));
    this.version++;
  }
}

/** マウス・タッチ入力をOrbitCameraに接続する */
export function attachCameraControls(canvas: HTMLCanvasElement, camera: OrbitCamera): void {
  // --- マウス ---
  let dragging = false;
  let panning = false;
  let lastX = 0, lastY = 0;

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    panning = e.button === 2 || e.shiftKey;
    lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (panning) camera.pan(dx, dy, canvas.clientHeight);
    else camera.orbit(dx, dy);
  });
  window.addEventListener("mouseup", () => { dragging = false; });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      camera.zoom(Math.pow(1.0015, e.deltaY));
    },
    { passive: false }
  );

  // --- タッチ(1本指orbit / 2本指ピンチzoom+pan) ---
  interface TouchPoint { id: number; x: number; y: number }
  let touches: TouchPoint[] = [];
  const syncTouches = (e: TouchEvent) => {
    touches = Array.from(e.touches).map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
  };

  canvas.addEventListener("touchstart", (e) => { e.preventDefault(); syncTouches(e); }, { passive: false });
  canvas.addEventListener("touchend", (e) => { syncTouches(e); });
  canvas.addEventListener("touchcancel", (e) => { syncTouches(e); });
  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      const now = Array.from(e.touches).map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
      if (now.length === 1 && touches.length === 1 && now[0].id === touches[0].id) {
        camera.orbit(now[0].x - touches[0].x, now[0].y - touches[0].y);
      } else if (now.length >= 2 && touches.length >= 2) {
        const prev0 = touches.find((t) => t.id === now[0].id);
        const prev1 = touches.find((t) => t.id === now[1].id);
        if (prev0 && prev1) {
          const prevDist = Math.hypot(prev1.x - prev0.x, prev1.y - prev0.y);
          const nowDist = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y);
          if (prevDist > 0 && nowDist > 0) camera.zoom(prevDist / nowDist);
          // 2本指の中点移動でpan
          const pcx = (prev0.x + prev1.x) / 2, pcy = (prev0.y + prev1.y) / 2;
          const ncx = (now[0].x + now[1].x) / 2, ncy = (now[0].y + now[1].y) / 2;
          camera.pan(ncx - pcx, ncy - pcy, canvas.clientHeight);
        }
      }
      touches = now;
    },
    { passive: false }
  );
}
