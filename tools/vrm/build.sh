#!/usr/bin/env bash
# アバター .vrm をワンコマンドで生成する。
#
#   tools/vrm/build.sh                  # build/avatar.vrm を作る
#   tools/vrm/build.sh --preview        # 確認用レンダリングも出す
#   OUT_DIR=dist tools/vrm/build.sh     # 出力先を変える
#
# 必要なもの: Python 3.11+ と bpy (pip install bpy)。
# フル Blender を使う場合は BLENDER=/path/to/blender を指定する。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/build}"

NAME="${AVATAR_NAME:-mochisw Avatar}"
AUTHOR="${AVATAR_AUTHOR:-mochisw}"

WITH_PREVIEW=0
for arg in "$@"; do
  case "$arg" in
    --preview) WITH_PREVIEW=1 ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

# bpy モジュール版と Blender 本体のどちらでも動くようにする。
run_bpy() {
  local script="$1"; shift
  if [ -n "${BLENDER:-}" ]; then
    "$BLENDER" --background --python "$script" -- "$@"
  else
    python3 "$script" "$@"
  fi
}

mkdir -p "$OUT_DIR"

echo "==> メッシュ・リグ・表情を生成して GLB を書き出す"
run_bpy "$HERE/build_avatar.py" --out "$OUT_DIR/avatar.glb"

echo "==> サムネイルをレンダリングする"
run_bpy "$HERE/preview.py" --thumbnail "$OUT_DIR/thumbnail.png"

echo "==> VRM 1.0 拡張を注入する"
python3 "$HERE/glb_to_vrm.py" "$OUT_DIR/avatar.glb" \
  -o "$OUT_DIR/avatar.vrm" \
  --name "$NAME" \
  --author "$AUTHOR" \
  --thumbnail "$OUT_DIR/thumbnail.png"

echo "==> 検証する"
python3 "$HERE/validate_vrm.py" "$OUT_DIR/avatar.vrm"

if [ "$WITH_PREVIEW" -eq 1 ]; then
  echo "==> 確認用レンダリング"
  run_bpy "$HERE/preview.py" --out "$OUT_DIR/preview"
fi

echo
echo "完成: $OUT_DIR/avatar.vrm"
