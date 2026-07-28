# mochisw-gsplat-viewer

Quest 3 向けの 3D Gaussian Splatting ビューア (`index.html`)。WebXR に対応。

## VRM アバター生成ツール

`tools/vrm/` に、Blender をスクリプトから動かして VRM 1.0 のアバターを
手続き生成するパイプラインが入っている。GUI 作業なしで `.vrm` が作れる。

```bash
pip install bpy
tools/vrm/build.sh
```

生成物: [`assets/avatar.vrm`](assets/avatar.vrm) — 詳細は
[`tools/vrm/README.md`](tools/vrm/README.md) を参照。
