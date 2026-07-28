"""スプラーシュの衣装の造形。

資料の構成に合わせて外側から
  パールコート → ネイビーのインナー → 白フリル → ライトアクアのソックス → 厚底スニーカー
の順に重ねる。

コートの前開きは、ジオメトリを切り欠く代わりに
「正面のくさび形の面だけインナーのマテリアルにする」方式で表現している。
低ポリゴンでも前を開けたシルエットに見え、メッシュが閉じたままなので
スキニングもシェイプキーも扱いやすい。
"""

import math

import geom
import rig

# 正面(-Y)からの角度がこの範囲内ならコートが開いてインナーが見える。
FRONT_OPEN = 0.46
FRONT_TRIM = 0.56

# 服の高さの境目。
COAT_TOP = 1.345
COAT_HEM = 0.660
FRILL_TOP = 0.700
FRILL_HEM = 0.600
SOCK_TOP = 0.430
SOCK_BOTTOM = 0.085
CUFF_START = 0.520


def front_angle(x, y):
    """正面(-Y)方向からの角度差を 0..pi で返す。"""
    phi = math.atan2(y, x)
    d = (phi + math.pi / 2.0 + math.pi) % (2.0 * math.pi) - math.pi
    return abs(d)


# --- コート本体 -----------------------------------------------------------

COAT_PROFILE = [
    (1.345, 0.086, 0.074),
    (1.300, 0.140, 0.098),
    (1.230, 0.150, 0.103),
    (1.150, 0.146, 0.101),
    (1.060, 0.140, 0.098),
    (0.980, 0.146, 0.103),
    (0.900, 0.163, 0.116),
    (0.820, 0.180, 0.128),
    (0.735, 0.196, 0.140),
    (0.660, 0.207, 0.149),
]


def build_coat(mb):
    verts, faces = geom.vertical_profile(COAT_PROFILE, segments=24)
    mb.add(verts, faces, "coat")


def build_frill(mb):
    """コートの裾から覗く白いフリル。裾を波打たせる。"""
    segments = 24
    sections = []
    for z, base_r in ((FRILL_TOP, 0.150), (0.650, 0.176), (FRILL_HEM, 0.196)):
        ring = []
        for s in range(segments):
            t = 2.0 * math.pi * s / segments
            # 裾ほど波を強くする
            wave = 1.0 + 0.055 * math.sin(6.0 * t) * \
                (0.15 if z > 0.66 else 1.0)
            ring.append((base_r * wave * math.cos(t),
                         base_r * 0.72 * wave * math.sin(t),
                         z + (0.006 * math.sin(6.0 * t) if z == FRILL_HEM else 0.0)))
        sections.append(ring)
    verts, faces = geom.loft(sections, cap_start=True, cap_end=True)
    mb.add(verts, faces, "frill")


def build_collar(mb):
    """首まわりの立ち襟。"""
    segments = 20
    sections = []
    for z, r in ((1.332, 0.062), (1.372, 0.066), (1.400, 0.070)):
        sections.append(geom.ring((0.0, 0.006, z), (1.0, 0.0, 0.0),
                                  (0.0, 1.0, 0.0), r, r * 0.86, segments))
    verts, faces = geom.loft(sections, cap_start=False, cap_end=False)
    mb.add(verts, faces, "collar")


# --- 袖 -------------------------------------------------------------------

def build_sleeve(mb, side):
    s = rig.side_sign(side)
    path = [
        (0.075 * s, 0.0, 1.318),
        (0.180 * s, 0.0, 1.316),
        (0.310 * s, 0.0, 1.315),
        (0.430 * s, 0.0, 1.315),
        (0.530 * s, 0.0, 1.315),
        (0.610 * s, 0.0, 1.315),
    ]
    radii = [(0.082, 0.082), (0.070, 0.070), (0.062, 0.062),
             (0.058, 0.058), (0.062, 0.062), (0.070, 0.070)]
    verts, faces = geom.tube(path, radii, segments=12,
                             cap_start=False, cap_end=False)
    mb.add(verts, faces, "sleeve")


# --- リボン ---------------------------------------------------------------

def build_ribbon(mb):
    """胸元のリボン。左右の輪と中央の結び目。"""
    centre = (0.0, -0.086, 1.283)
    for s in (1.0, -1.0):
        points = 9
        path = []
        for i in range(points):
            t = i / (points - 1)
            angle = math.pi * t
            # 中央から外へ出て戻る輪
            path.append((centre[0] + s * 0.052 * math.sin(angle),
                         centre[1] - 0.012 * math.sin(angle),
                         centre[2] + 0.030 * math.sin(angle) * math.cos(angle * 0.9)
                         - 0.016 * (1.0 - math.cos(angle)) * 0.5))
        radii = [0.004 + 0.012 * math.sin(math.pi * (i / (points - 1)))
                 for i in range(points)]
        verts, faces = geom.tube(path, radii, segments=6)
        mb.add(verts, faces, "ribbon")

    knot, faces = geom.ellipsoid(centre, (0.016, 0.012, 0.013),
                                 segments=10, rings=7)
    mb.add(knot, faces, "ribbon")

    # 胸元のエメラルドのアクセント。
    for s in (1.0, -1.0):
        c = (s * 0.034, -0.090, 1.243)
        verts, f = geom.ellipsoid(c, (0.012, 0.006, 0.010), segments=10, rings=6)
        mb.add(verts, f, "coat_trim")


# --- ソックス -------------------------------------------------------------

def build_sock(mb, side):
    s = rig.side_sign(side)
    path = [
        (0.079 * s, -0.004, SOCK_TOP),
        (0.079 * s, -0.004, 0.360),
        (0.080 * s, 0.000, 0.260),
        (0.080 * s, 0.002, 0.170),
        (0.080 * s, 0.005, SOCK_BOTTOM),
    ]
    # 素体の脚より確実に太くしないと肌が突き抜ける。
    radii = [(0.064, 0.062), (0.061, 0.059), (0.057, 0.056),
             (0.051, 0.050), (0.046, 0.047)]
    verts, faces = geom.tube(path, radii, segments=12,
                             cap_start=False, cap_end=False)
    mb.add(verts, faces, "sock")


# --- スニーカー -----------------------------------------------------------

def build_sneaker(mb, side):
    """厚底スニーカー。ソールを分厚く取り、側面にバブル装飾を付ける。"""
    s = rig.side_sign(side)
    path = [
        (0.080 * s, 0.020, 0.105),
        (0.080 * s, -0.010, 0.070),
        (0.080 * s, -0.070, 0.055),
        (0.080 * s, -0.130, 0.050),
        (0.080 * s, -0.175, 0.048),
    ]
    radii = [(0.050, 0.055), (0.058, 0.052), (0.060, 0.048),
             (0.056, 0.044), (0.040, 0.034)]
    verts, faces = geom.tube(path, radii, segments=14)
    # 靴底を平らにする。
    verts = [(v[0], v[1], max(v[2], 0.004)) for v in verts]
    mb.add(verts, faces, "shoe")

    # バブル装飾（外側に 3 つ）。
    bubbles = [
        (0.062 * s, -0.020, 0.075, 0.019),
        (0.060 * s, -0.085, 0.070, 0.016),
        (0.056 * s, -0.140, 0.064, 0.013),
    ]
    for bx, by, bz, r in bubbles:
        v, f = geom.ellipsoid((bx + 0.020 * s, by, bz), (r, r, r),
                              segments=10, rings=7)
        mb.add(v, f, "bubble")


# --- まとめ ---------------------------------------------------------------

def build(mb):
    build_coat(mb)
    build_frill(mb)
    build_collar(mb)
    build_ribbon(mb)
    for side in ("left", "right"):
        build_sleeve(mb, side)
        build_sock(mb, side)
        build_sneaker(mb, side)
