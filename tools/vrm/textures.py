"""手続き生成するテクスチャ。

髪のグラデーションのように単色では表現できないものだけをテクスチャにする。
Pillow だけで書けるので Blender 無しでも生成・確認できる。
"""

import os

from PIL import Image

import palette

WIDTH = 8          # 横方向は一様なので細くてよい
HEIGHT = 256


def _lerp(a, b, t):
    return a + (b - a) * t


def _sample_stops(stops, t):
    """(位置, hex) の並びから sRGB 0..1 の色を補間して取り出す。"""
    if t <= stops[0][0]:
        return palette.hex_to_srgb(stops[0][1])
    for i in range(len(stops) - 1):
        p0, c0 = stops[i][0], stops[i][1]
        p1, c1 = stops[i + 1][0], stops[i + 1][1]
        if p0 <= t <= p1:
            k = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            a, b = palette.hex_to_srgb(c0), palette.hex_to_srgb(c1)
            return tuple(_lerp(a[j], b[j], k) for j in range(3))
    return palette.hex_to_srgb(stops[-1][1])


def _sample_glow(stops, t):
    """(位置, hex, 強度) の並びから発光色を取り出す。"""
    if t <= stops[0][0]:
        c, s = palette.hex_to_srgb(stops[0][1]), stops[0][2]
        return tuple(x * s for x in c)
    for i in range(len(stops) - 1):
        p0, c0, s0 = stops[i]
        p1, c1, s1 = stops[i + 1]
        if p0 <= t <= p1:
            k = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            a, b = palette.hex_to_srgb(c0), palette.hex_to_srgb(c1)
            s = _lerp(s0, s1, k)
            return tuple(_lerp(a[j], b[j], k) * s for j in range(3))
    c, s = palette.hex_to_srgb(stops[-1][1]), stops[-1][2]
    return tuple(x * s for x in c)


def _write(path, sampler):
    """縦グラデーションを書き出す。

    Blender の UV は v=0 が画像の下端なので、t=0（髪の根元）が
    下端に来るように行を反転して書く。こうしないと根元と毛先の色が入れ替わる。
    """
    img = Image.new("RGB", (WIDTH, HEIGHT))
    px = img.load()
    for y in range(HEIGHT):
        t = 1.0 - y / (HEIGHT - 1)
        rgb = tuple(max(0, min(255, round(c * 255))) for c in sampler(t))
        for x in range(WIDTH):
            px[x, y] = rgb
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    img.save(path)
    return path


def generate(outdir):
    """必要なテクスチャを書き出し、キー -> パス の辞書を返す。"""
    return {
        "hair_base": _write(
            os.path.join(outdir, "hair_base.png"),
            lambda t: _sample_stops(palette.HAIR_BASE_STOPS, t)),
        "hair_glow": _write(
            os.path.join(outdir, "hair_glow.png"),
            lambda t: _sample_glow(palette.HAIR_GLOW_STOPS, t)),
    }


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "build/textures"
    for key, path in generate(out).items():
        print(f"{key}: {path}")
