"""素の Python だけで動く手続き的ジオメトリ生成ヘルパ。

bpy に依存しないので単体でテストできる。生成物は
(verts, faces) のタプルで、verts は (x, y, z) のリスト、
faces は頂点インデックスのタプルのリスト。
"""

import math


# --- 基本ベクトル演算 -----------------------------------------------------

def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def length(a):
    return math.sqrt(dot(a, a))


def normalize(a):
    n = length(a)
    return (0.0, 0.0, 1.0) if n < 1e-12 else scale(a, 1.0 / n)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


def basis_from_axis(axis):
    """axis を法線とする平面の正規直交基底 (u, v) を返す。"""
    n = normalize(axis)
    ref = (0.0, 0.0, 1.0) if abs(n[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = normalize(cross(ref, n))
    v = cross(n, u)
    return u, v


# --- リングとロフト -------------------------------------------------------

def ring(center, u, v, ru, rv, segments, phase=0.0):
    """center を中心に、基底 (u, v) の平面上へ楕円リングを作る。"""
    pts = []
    for i in range(segments):
        t = phase + 2.0 * math.pi * i / segments
        c, s = math.cos(t), math.sin(t)
        pts.append(add(center, add(scale(u, ru * c), scale(v, rv * s))))
    return pts


def loft(sections, cap_start=True, cap_end=True):
    """同じ頂点数のリング列を順に繋いでチューブ状のメッシュを作る。"""
    n = len(sections[0])
    verts = []
    for s in sections:
        if len(s) != n:
            raise ValueError("loft: 全リングの頂点数が一致していません")
        verts.extend(s)
    faces = []
    for r in range(len(sections) - 1):
        a, b = r * n, (r + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a + i, a + j, b + j, b + i))
    if cap_start:
        faces.append(tuple(reversed(range(n))))
    if cap_end:
        off = (len(sections) - 1) * n
        faces.append(tuple(off + i for i in range(n)))
    return verts, faces


def tube(path, radii, segments=12, cap_start=True, cap_end=True):
    """折れ線 path に沿って半径 radii のチューブを作る。

    各節点でのリング法線は前後のセグメント方向の平均にして、
    関節部分が潰れないようにする。
    """
    if len(path) != len(radii):
        raise ValueError("tube: path と radii の長さが違います")
    sections = []
    for i, p in enumerate(path):
        if i == 0:
            axis = sub(path[1], path[0])
        elif i == len(path) - 1:
            axis = sub(path[-1], path[-2])
        else:
            axis = add(normalize(sub(path[i], path[i - 1])),
                       normalize(sub(path[i + 1], path[i])))
        u, v = basis_from_axis(axis)
        r = radii[i]
        ru, rv = (r, r) if isinstance(r, (int, float)) else r
        sections.append(ring(p, u, v, ru, rv, segments))
    return loft(sections, cap_start, cap_end)


def vertical_profile(profile, segments=16):
    """(z, rx, ry) の断面列から Z 軸に沿った胴体状のメッシュを作る。"""
    sections = []
    for z, rx, ry in profile:
        sections.append(ring((0.0, 0.0, z), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0),
                             rx, ry, segments))
    return loft(sections)


# --- 楕円体 ---------------------------------------------------------------

def ellipsoid(center, radii, segments=24, rings=16):
    """UV 球ベースの楕円体。極を ±Z に置く。"""
    cx, cy, cz = center
    rx, ry, rz = radii
    verts = [(cx, cy, cz + rz)]
    for r in range(1, rings):
        theta = math.pi * r / rings
        st, ct = math.sin(theta), math.cos(theta)
        for s in range(segments):
            phi = 2.0 * math.pi * s / segments
            verts.append((cx + rx * st * math.cos(phi),
                          cy + ry * st * math.sin(phi),
                          cz + rz * ct))
    verts.append((cx, cy, cz - rz))
    bottom = len(verts) - 1

    faces = []
    for s in range(segments):
        faces.append((0, 1 + (s + 1) % segments, 1 + s))
    for r in range(rings - 2):
        a = 1 + r * segments
        b = 1 + (r + 1) * segments
        for s in range(segments):
            t = (s + 1) % segments
            faces.append((a + s, a + t, b + t, b + s))
    a = 1 + (rings - 2) * segments
    for s in range(segments):
        faces.append((bottom, a + s, a + (s + 1) % segments))
    return verts, faces


def project_to_ellipsoid_front(x, z, center, radii, offset=0.0):
    """(x, z) を与えて楕円体の前面（-Y 側）の点を求める。

    offset だけ法線方向に押し出す。顔パーツを頭の曲面に貼るために使う。
    """
    cx, cy, cz = center
    rx, ry, rz = radii
    nx = (x - cx) / rx
    nz = (z - cz) / rz
    k = 1.0 - nx * nx - nz * nz
    ny = -math.sqrt(k) if k > 0.0 else 0.0
    p = (cx + rx * nx, cy + ry * ny, cz + rz * nz)
    if offset:
        n = normalize((nx / rx, ny / ry, nz / rz))
        p = add(p, scale(n, offset))
    return p


# --- 顔パーツ用の平面パッチ -----------------------------------------------

def face_patch(cx, cz, rx, rz, center, radii, segments=16,
               rot=0.0, curve=0.0, offset=0.002, lift=0.0):
    """頭部前面に貼り付ける楕円パッチの頂点列を返す。

    rot   : パッチの傾き（ラジアン）。眉や笑顔の目に使う。
    curve : 上方向への反り。正で「へ」の字が上に凸のアーチになる。
    lift  : パッチ全体の上下移動。まばたきで瞼を下ろすのに使う。

    戻り値の最後の要素が扇の中心頂点。
    """
    pts = []
    cr, sr = math.cos(rot), math.sin(rot)
    for i in range(segments):
        t = 2.0 * math.pi * i / segments
        lx, lz = rx * math.cos(t), rz * math.sin(t)
        x = lx * cr - lz * sr
        z = lx * sr + lz * cr
        if curve and rx > 1e-9:
            z += curve * (1.0 - (lx / rx) ** 2)
        pts.append(project_to_ellipsoid_front(cx + x, cz + z + lift,
                                              center, radii, offset))
    pts.append(project_to_ellipsoid_front(cx, cz + curve * 0.5 + lift,
                                          center, radii, offset))
    return pts


def fan_faces(segments):
    """face_patch の頂点列に対応する三角形扇のインデックスを返す。"""
    c = segments
    return [(c, i, (i + 1) % segments) for i in range(segments)]


# --- メッシュ組み立て -----------------------------------------------------

class MeshBuilder:
    """複数パーツを 1 つのメッシュに統合し、面ごとのタグを保持する。"""

    def __init__(self):
        self.verts = []
        self.faces = []      # (indices, tag)
        self.groups = {}     # name -> [vertex index]

    def add(self, verts, faces, tag, group=None):
        off = len(self.verts)
        self.verts.extend(verts)
        for f in faces:
            self.faces.append((tuple(i + off for i in f), tag))
        idx = list(range(off, off + len(verts)))
        if group:
            self.groups.setdefault(group, []).extend(idx)
        return off

    def add_mirrored(self, verts, faces, tag, group=None):
        """X 反転したコピーを追加する。面の巻き方向も反転させる。"""
        mv = [(-v[0], v[1], v[2]) for v in verts]
        mf = [tuple(reversed(f)) for f in faces]
        return self.add(mv, mf, tag, group)

    def adjacency(self):
        """頂点隣接リスト（ウェイトのスムージングで使う）。"""
        adj = [set() for _ in self.verts]
        for f, _ in self.faces:
            for i in range(len(f)):
                a, b = f[i], f[(i + 1) % len(f)]
                adj[a].add(b)
                adj[b].add(a)
        return [sorted(s) for s in adj]
