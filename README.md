# mochisw-gsplat-viewer

自作3DGS/点群ビュワー。ブラウザ完結・ゼロコスト・インストール不要。
SPZ / PLY(3DGS標準・RGB点群)対応、点表示 ⇔ ガウシアンスプラッティング切替式。

設計書: [docs/DESIGN.md](docs/DESIGN.md)

## 開発

```bash
npm install
npm run dev        # 開発サーバー
npm test           # PLYパーサ等のユニットテスト(vitest)
npm run fixtures   # 動作確認用の合成PLYを fixtures/ に生成
npm run build      # 型チェック + 単一HTMLビルド → dist/index.html
```

`dist/index.html` が配布物(単一ファイル、外部依存なし)。

## 実装状況

- [x] **Phase 1**: 骨格 + PLYパーサ(3DGS標準 / RGB点群、ascii / binary_little_endian)+ 点表示 + orbit/pan/zoom操作 + D&D読込
- [x] **Phase 2**: SPZパーサ(レガシーgzip v2/v3対応。v4はZSTD圧縮のため `DecompressionStream('zstd')` 対応ブラウザのみ、非対応環境では明示エラー)
- [x] **Phase 3**: ガウシアンスプラッティング(EWA・インスタンス化クアッド)+ Workerデプスソート(counting sort、視線回転時のみ再ソート)+ モード即時切替
- [ ] **Phase 4**: 仕上げ(XGRIDSスキップ、iPhone Safari実機確認)

## 旧ビュワー

three.js + Spark 利用の旧実装は [legacy/spark-viewer.html](legacy/spark-viewer.html) に保存。
