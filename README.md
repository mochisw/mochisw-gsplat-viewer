# mochisw-gsplat-viewer

Quest 3 向けの 3D Gaussian Splatting ビューア（[Spark](https://sparkjs.dev/) + Three.js + WebXR）。

- `index.html` — ビューア本体。`.ply` / `.spz` / `.splat` / `.ksplat` / `.rad` の読み込み、WebXR VR（テレポート移動）対応。
- `remote.html` — リモコンページ。スマホやPCからビューアを遠隔操作できます。

## リモコンの使い方

1. ビューア（`index.html`）を開くと、オーバーレイに6桁のリモコンコードが表示されます。
2. 別のデバイスで `remote.html` を開き、コードを入力して「接続」を押します
   （ビューア側の「リモコンページを開く」リンクにはコードが埋め込まれています）。
3. 接続後、リモコンから以下の操作ができます:
   - URL指定でのモデル読み込み / サンプル読み込み
   - モデルのY軸回転・スケール・高さの調整
   - モデル変換とカメラのリセット
   - ビューアの状態表示の確認

通信は [PeerJS](https://peerjs.com/) の公開シグナリングサーバー経由で確立される
WebRTC データチャネルを使用しており、サーバー側の設置は不要です。
