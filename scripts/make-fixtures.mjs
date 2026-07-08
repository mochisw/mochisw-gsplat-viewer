/**
 * 手動動作確認用のサンプルPLYを fixtures/ に書き出すスクリプト
 * 使い方: npm run fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  buildAsciiPointCloudPly,
  buildBinaryPointCloudPly,
  buildBinary3dgsPly,
  randomRgbPoints,
} from "./fixtures.mjs";

mkdirSync("fixtures", { recursive: true });

// カラフルな球殻状の点群(10万点)
const sphere = randomRgbPoints(100000).map((p) => {
  const n = Math.hypot(p.x, p.y, p.z) || 1;
  const r = 3 + (p.r / 255) * 0.2; // わずかな厚み
  return {
    x: (p.x / n) * r,
    y: (p.y / n) * r,
    z: (p.z / n) * r,
    r: Math.floor(((p.x / n) * 0.5 + 0.5) * 255),
    g: Math.floor(((p.y / n) * 0.5 + 0.5) * 255),
    b: Math.floor(((p.z / n) * 0.5 + 0.5) * 255),
  };
});
writeFileSync("fixtures/sphere-binary.ply", new Uint8Array(buildBinaryPointCloudPly(sphere)));
writeFileSync(
  "fixtures/sphere-ascii-small.ply",
  new Uint8Array(buildAsciiPointCloudPly(sphere.slice(0, 5000)))
);

// 3DGS標準PLY: 格子状に並んだガウシアン(1万個)
const splats = [];
for (let i = 0; i < 10000; i++) {
  const gx = i % 100, gy = Math.floor(i / 100);
  splats.push({
    x: (gx - 50) * 0.1,
    y: (gy - 50) * 0.1,
    z: Math.sin(gx * 0.2) * Math.cos(gy * 0.2),
    dc: [(gx / 100 - 0.5) / 0.28209479, (gy / 100 - 0.5) / 0.28209479, 0.5],
    opacity: 2.0, // sigmoid(2.0) ≈ 0.88
    scale: [-4, -4, -4], // exp(-4) ≈ 0.018
    rot: [1, 0, 0, 0],
  });
}
writeFileSync(
  "fixtures/grid-3dgs.ply",
  new Uint8Array(buildBinary3dgsPly(splats, { shDegree: 1 }))
);

console.log("fixtures/ に書き出しました:");
console.log("  sphere-binary.ply      (RGB点群 binary_little_endian, 10万点)");
console.log("  sphere-ascii-small.ply (RGB点群 ascii, 5千点)");
console.log("  grid-3dgs.ply          (3DGS標準 binary, 1万点, SH1)");
