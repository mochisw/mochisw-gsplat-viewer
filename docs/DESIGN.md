# 自作3DGS/点群ビュワー 設計書

- 作成日: 2026-07-08
- 発注者: mochisw
- ステータス: 承認済み・Phase 1実装中

---

## 1. 目的とゴール

SPZ / PLY を読み込める**ブラウザ完結・ゼロコスト・インストール不要**の3DGSビュワーを自作する。
レンダリングは「点表示モード」と「ガウシアンスプラッティングモード」の**両方切替式**。

### ゴール(完成条件)
- 単一HTMLファイルとして配布可能(ビルド成果物が1ファイル)
- SPZ / PLY(3DGS標準・RGB点群)をドラッグ&ドロップで表示できる
- 点表示 ⇔ スプラット表示をUIで即時切替できる
- iPhone Safari / PCのChrome・Edgeで動作する

### 非ゴール(スコープ外)
- メッシュ化(Poisson等)— 初期スコープ外
- 編集機能(表示専用)
- サーバー・クラウドGPU・有料API(ゼロコスト原則)

---

## 2. 技術方針(固定)

| 項目 | 決定 |
|---|---|
| 言語 | TypeScript |
| レンダリング | WebGL2(WebGPUは不採用。iOS Safari互換を優先) |
| ビルド | Vite + vite-plugin-singlefile → 単一HTML出力 |
| 外部ランタイム依存 | なし(three.js等のライブラリ不使用、自前実装) |
| ソート | Web Worker でデプスソート(counting sort) |
| 展開 | SPZのgzipは `DecompressionStream('gzip')`(ブラウザ標準API) |

---

## 3. 対応フォーマット仕様

### 3.1 PLY
対応バリアント(判定はheaderのproperty構成で自動分岐):

1. **3DGS標準PLY**: `x,y,z, f_dc_0..2, f_rest_*, opacity, scale_0..2, rot_0..3`
   - opacity は sigmoid、scale は exp、色は SH0(C0=0.28209479177387814)で変換
2. **RGB点群PLY**(Scaniverse等): `x,y,z, red,green,blue`(+nx,ny,nz は無視)
3. ascii / binary_little_endian 両対応。binary_big_endian はエラー表示のみ

未知のpropertyは読み飛ばす。

### 3.2 SPZ(Niantic)

✅ **確定済み(Phase 2)**: 公式リポジトリ `github.com/nianticlabs/spz` の
`src/cc/load-spz.cc` / `splat-utils.h` / `README.md`(2026-07-09時点main)で以下を確認した。

- 形式判定: 先頭 `1f 8b` → レガシーgzip(v1〜3)/ 先頭 `NGSP` → v4(**ZSTD圧縮**)
  - 設計当初の「gzip」前提はレガシー形式のみ。v4はZSTDで、ブラウザ標準APIでは
    `DecompressionStream('zstd')` 対応環境(Chrome系)のみ展開可能 → 非対応環境では明示エラー
- レガシー: gzip展開後、16Bヘッダ(magic/version/numPoints/shDegree/fractionalBits/flags)+
  属性ストリーム連結(positions → alphas → colors → scales → rotations → sh)
- v4: 32B平文ヘッダ + TOC(ストリームごとの圧縮/非圧縮サイズ)+ 属性別ZSTDストリーム(同順)
- デコード: 位置=24bit固定小数点(符号拡張, /2^fractionalBits)、α=u8(sigmoid適用済)、
  色=f_dc復元 `(u8/255−0.5)/0.15`、scale=`exp(u8/16−10)`、
  回転=v2: first-three(u8/127.5−1, w再構成)/ v3+: smallest-three(2bit最大成分index +
  10bit×3, 最大成分が正になるよう符号正規化)、SH=`(u8−128)/128`
- v1(float16位置)は未リリース形式のため非対応(明示エラー)
- 座標系: SPZはRUB(Y上、OpenGL準拠)。PLY(3DGS標準, Y下)と異なり上下反転不要

### 3.3 XGRIDS対策(オプション)
- XGRIDS出力SPZは先頭約10,242点が外れ値マーカー(過去実測)
- 「先頭N点スキップ」をUIオプションとして実装(デフォルトOFF、N=10242初期値、調整可能)

---

## 4. レンダリング設計

### モードA: 点表示(軽量)
- `gl.POINTS` + gl_PointSize(距離減衰オプション)
- ソート不要・不透明描画。読込直後のデフォルトモード

### モードB: ガウシアンスプラッティング
- インスタンス化クアッド(1スプラット=4頂点)
- scale+rot → 3D共分散 → ヤコビアン投影 → 2D共分散 → 楕円描画(EWA)
- back-to-front デプスソート(Worker、カメラ移動閾値超過時のみ再ソート)
- ブレンド: `ONE, ONE_MINUS_SRC_ALPHA`(premultiplied)
- SHはまず degree 0 のみ(視点依存色はPhase 4のストレッチゴール)

### 切替
- 同一バッファ(interleaved)を両モードで共有し、シェーダプログラムのみ切替。再アップロードなし
- 実装レイアウトは `src/types.ts` を参照(1点48バイト: pos f32x3 / RGBA u8x4 / scale f32x3 / pad 4B / rot f32x4)
- **実装詳細(Phase 3)**: 48B/点 = RGBA32UIテクセル16B×3に揃えてあり、スプラットモードは
  CPUバッファを無変換でデータテクスチャに一度だけアップロードし、頂点シェーダが
  ソート済みインデックス(インスタンス属性)経由でtexelFetchする。
  ソート結果の反映は4B/点のインデックスVBO更新のみで、本体データの再転送は発生しない。
  ソートはカメラの平行移動では順序が変わらないため、視線方向の回転(内積閾値≈1.1°)のみで再実行

---

## 5. UI仕様(引き算デザイン)

- 全画面キャンバス + 左上に折りたたみ式ミニパネル1枚のみ
- パネル内容: ファイル情報(名前/点数/形式/SH次数)、モード切替、点サイズ、スプラットスケール、背景色(黒/白)、XGRIDSスキップ、FPS
- 操作: orbit(ドラッグ)、pan(右ドラッグ/2本指)、zoom(ホイール/ピンチ)。タッチ対応必須
- ドラッグ&ドロップ + ファイル選択ボタンの両方

---

## 6. 実装フェーズ(段階実行・各Phase末に動作確認ゲート)

| Phase | 内容 | 完了条件 |
|---|---|---|
| 1 | 骨格+PLYパーサ+点表示 | RGB点群PLYと3DGS PLYが点で表示・orbit操作可 |
| 2 | SPZパーサ | 公式仕様確認→パース→点表示。合成フィクスチャでラウンドトリップ検証 |
| 3 | スプラッティング+Workerソート | モード切替動作、50万スプラットで実用フレームレート |
| 4 | 仕上げ | タッチ操作、XGRIDSスキップ、単一HTMLビルド、iPhone Safari実機確認 |

- 各Phaseはテスト付き(パーサはNode側でvitest、合成フィクスチャ生成スクリプト同梱)
- **Phase間で必ず停止し、動作確認と承認を得てから次へ進むこと**

## 7. 性能目標

- 100万点(点表示): 60fps目安 / 50万スプラット(スプラット表示): 30fps以上(RTX 3060 Ti基準)
- 読込: 100MB PLYで進捗表示付き、UIフリーズなし(パースのWorker化はPhase 3で判断)

---

## 8. ADR(固定決定)

- **ADR-001**: WebGL2採用、WebGPU不採用(iOS Safari互換優先)。再検討条件: iOS SafariのWebGPU安定化
- **ADR-002**: 外部3Dライブラリ不使用(自前実装)。理由: 学習目的+既存EWA資産流用+単一HTML最小化
- **ADR-003**: メッシュ化はスコープ外。再検討条件: なし(別プロジェクトとする)
- **ADR-004**: SH視点依存色はdegree 0のみ先行。理由: バッファ設計とシェーダ複雑度の抑制
- **ADR-005**: XGRIDS先頭スキップはオプション実装・デフォルトOFF。理由: 点数10,242は固定仕様と未確認のため

## 9. 未確定・要確認事項(推測禁止リスト)

1. ~~SPZの正確なバイトレイアウト~~ → **確定済み**(3.2参照)
2. XGRIDSスキップ点数の普遍性 → 手持ちファイル複数で実測してから既定値を確定
3. .rad / .splat 対応 → 本設計では不明・スコープ外。需要が出たら別途ADR
4. ~~パースのWorker化要否~~ → **判断済み(Phase 3)**: パーサはチャンクごとにメインスレッドを
   解放(進捗表示付き)しており、実測でUIフリーズは発生しないためWorker化は見送り。
   デプスソートのみWorker化(counting sort、実測50万点7.4ms/回)
