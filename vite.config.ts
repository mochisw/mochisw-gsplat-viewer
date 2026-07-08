import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    // 単一HTML出力(設計書2章): すべてインライン化
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
  },
});
