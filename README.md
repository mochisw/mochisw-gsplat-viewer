# 名刺AR v0.1

名刺上部のImage Targetに、元のbackhoe 2.spzを1個だけ表示するPoCです。
位置・姿勢・スケールはXR8 Image Targetの値をmarkerRootに適用し、モデル補正をmodelRootに分離しています。
World Tracking OFF、公式Three.js pipeline、Spark 2.2.0。失認識で非表示、再認識で再表示します。

## Cloudflare設定

- 新規Worker名: `backhoe-marker-ar`
- GitHub repository: `mochisw/mochisw-gsplat-viewer`
- Production branch: `backhoe-marker-ar`
- Build command: 空欄
- Deploy command: `npx wrangler deploy`
- Root directory: リポジトリのルート
- 既存WorkerのProduction branchは変更しない

Cloudflareに新規Workerを作成し、上記リポジトリ・ブランチへ接続してください。
公開後、Cloudflareが表示するworkers.dev URLをiPhone Safariで開いてください。

## 実機成功条件（未検証）

1. ARを開始し、カメラ比率と安定性を確認（まず60秒）。
2. 印刷済み名刺上部を映し、「名刺認識・表示」を確認。
3. 名刺を移動・傾斜・遠近移動し、位置・姿勢・大きさの追従を確認。
4. 名刺を隠し、非表示になることを確認。
5. 再び映して再表示を確認。

表示寸法は名刺幅55mmを仮定した約15cm。元SPZには周辺地面も含むため、
全体の境界ボックスでサイズ・接地を仮調整しています。機体単体の寸法ではありません。
天地・向き・オフセットは実機で確認後に調整します。

## SPZ配信

大容量のGitHub一括送信を避けるため、元SPZを16個のバイナリ保存ファイルに分割しています。
Workerが順番にストリーム結合し、`/assets/backhoe.spz`として元と同じ8,222,670 bytesを返します。
SplatMeshは1個、SPZも論理的には1個。6分割rigやアニメーションとは無関係です。
既存のアセットWorkerへの依存はありません。

名刺画像は遠近補正後、電話・メールを含まない領域を公式image-target-cliで処理しています。
