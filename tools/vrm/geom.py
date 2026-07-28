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


def rotate_about(v, axis, cos_a, sin_a):
    """ロドリゲスの回転公式。axis は単位ベクトル。"""
    return add(add(scale(v, cos_a), scale(cross(axis, v), sin_a)),
               scale(axis, dot(axis, v) * (1.0 - cos_a)))


def path_tangents(path):
    """折れ線の各節点での進行方向。関節では前後の平均を取る。"""
    n = len(path)
    tangents = []
    for i in range(n):
        if i == 0:
            axis = sub(path[1], path[0])
        elif i == n - 1:
            axis = sub(path[-1], path[-2])
        else:
            axis = add(normalize(sub(path[i], path[i - 1])),
                       normalize(sub(path[i + 1], path[i])))
        tangents.append(normalize(axis))
    return tangents


def parallel_frames(path):
    """折れ線に沿って捻れない正規直交フレーム (u, v) を求める。

    節点ごとに basis_from_axis() を独立に呼ぶと、進行方向が参照軸の
    切り替え閾値をまたいだ瞬間に基底が不連続に反転し、チューブが
    ねじれて板状に潰れたりギザギザになる。前の点のフレームを
    「今の接線へ最小回転で運ぶ」ことで、その不連続を無くす。
    """
    tangents = path_tangents(path)
    u, _ = basis_from_axis(tangents[0])
    frames = []
    for i, t in enumerate(tangents):
        if i > 0:
            prev = tangents[i - 1]
            axis = cross(prev, t)
            sin_a = length(axis)
            cos_a = dot(prev, t)
            if sin_a > 1e-9:
                u = rotate_about(u, scale(axis, 1.0 / sin_a), cos_a, sin_a)
        # 数値誤差で接線から外れるので毎回直交化しておく。
        u = sub(u, scale(t, dot(u, t)))
        n = length(u)
        u = basis_from_axis(t)[0] if n < 1e-9 else scale(u, 1.0 / n)
        frames.append((u, cross(t, u)))
    return frames


def tube(path, radii, segments=12, cap_start=True, cap_end=True):
    """折れ線 path に沿って半径 radii のチューブを作る。"""
    if len(path) != len(radii):
        raise ValueError("tube: path と radii の長さが違います")
    frames = parallel_frames(path)
    sections = []
    for i, p in enumerate(path):
        u, v = frames[i]
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

def tube_uvs(sections, segments, v_values=None):
    """tube() が返す頂点並びに対応する UV を作る。

    u はリング方向、v はパス方向。v_values を渡すと毛先グラデーション等に使える。
    """
    if v_values is None:
        v_values = [i / max(1, sections - 1) for i in range(sections)]
    return [(s / segments, v_values[r])
            for r in range(sections) for s in range(segments)]


class MeshBuilder:
    """複数パーツを 1 つのメッシュに統合し、面ごとのタグを保持する。"""

    def __init__(self):
        self.verts = []
        self.uvs = []        # verts と 1 対 1
        self.faces = []      # (indices, tag)
        self.groups = {}     # name -> [vertex index]

    def add(self, verts, faces, tag, group=None, uvs=None):
        off = len(self.verts)
        self.verts.extend(verts)
        if uvs is None:
            uvs = [(0.5, 0.5)] * len(verts)
        elif len(uvs) != len(verts):
            raise ValueError(f"UV 数 {len(uvs)} が頂点数 {len(verts)} と一致しません")
        self.uvs.extend(uvs)
        for f in faces:
            self.faces.append((tuple(i + off for i in f), tag))
        idx = list(range(off, off + len(verts)))
        if group:
            self.groups.setdefault(group, []).extend(idx)
        return off

    def add_mirrored(self, verts, faces, tag, group=None, uvs=None):
        """X 反転したコピーを追加する。面の巻き方向も反転させる。"""
        mv = [(-v[0], v[1], v[2]) for v in verts]
        mf = [tuple(reversed(f)) for f in faces]
        return self.add(mv, mf, tag, group, uvs)

    def adjacency(self):
        """頂点隣接リスト（ウェイトのスムージングで使う）。"""
        adj = [set() for _ in self.verts]
        for f, _ in self.faces:
            for i in range(len(f)):
                a, b = f[i], f[(i + 1) % len(f)]
                adj[a].add(b)
                adj[b].add(a)
        return [sorted(s) for s in adj]
