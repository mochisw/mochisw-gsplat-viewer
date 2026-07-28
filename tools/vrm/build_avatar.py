"""Blender(bpy) でヒューマノイドアバターを手続き生成し GLB として書き出す。

    python3 tools/vrm/build_avatar.py --out build/avatar.glb

GUI は使わないので、bpy モジュール版 Blender でもフル Blender の
`blender --background --python` でも同じように動く。
"""

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402

import face as facedef  # noqa: E402
import geom  # noqa: E402
import rig  # noqa: E402
from vrm_spec import MORPH_EXPRESSIONS, all_bones  # noqa: E402


# --- マテリアル -----------------------------------------------------------
# 名前 -> (ベースカラー RGB, ラフネス)
MATERIALS = {
    "Skin":     ((1.00, 0.84, 0.76), 0.62),
    "Hair":     ((0.24, 0.17, 0.22), 0.48),
    "Top":      ((0.29, 0.44, 0.72), 0.72),
    "Bottom":   ((0.19, 0.21, 0.28), 0.75),
    "Shoes":    ((0.13, 0.13, 0.16), 0.55),
    "EyeWhite": ((0.97, 0.97, 0.98), 0.35),
    "Iris":     ((0.20, 0.47, 0.66), 0.28),
    "Mouth":    ((0.42, 0.18, 0.22), 0.60),
}
MATERIAL_ORDER = list(MATERIALS)

# 服の切り替え高さ。
SHOES_TOP = 0.130
SHORTS_BOTTOM = 0.700
TOP_BOTTOM = 1.020
NECK_LINE = 1.348
SLEEVE_END = 0.300


def material_for(tag, centroid):
    """面のタグと重心位置からマテリアルを決める。"""
    x, _, z = centroid
    if tag in ("head", "neck", "hand"):
        return "Skin"
    if tag == "hair":
        return "Hair"
    if tag in ("lash", "brow"):
        return "Hair"
    if tag == "eyeWhite":
        return "EyeWhite"
    if tag == "iris":
        return "Iris"
    if tag == "mouth":
        return "Mouth"
    if tag == "foot":
        return "Shoes"
    if tag == "torso":
        if z >= NECK_LINE:
            return "Skin"
        return "Top" if z >= TOP_BOTTOM else "Bottom"
    if tag == "arm":
        return "Top" if abs(x) < SLEEVE_END else "Skin"
    if tag == "leg":
        if z < SHOES_TOP:
            return "Shoes"
        return "Bottom" if z >= SHORTS_BOTTOM else "Skin"
    return "Skin"


# --- パーツ生成 -----------------------------------------------------------

TORSO_PROFILE = [
    (0.858, 0.104, 0.078),
    (0.900, 0.124, 0.092),
    (0.955, 0.116, 0.086),
    (1.005, 0.098, 0.074),
    (1.075, 0.104, 0.077),
    (1.150, 0.122, 0.087),
    (1.225, 0.133, 0.090),
    (1.290, 0.130, 0.086),
    (1.330, 0.112, 0.077),
    (1.362, 0.072, 0.062),
]


def build_torso(mb):
    verts, faces = geom.vertical_profile(TORSO_PROFILE, segments=20)
    mb.add(verts, faces, "torso")


def build_neck(mb):
    path = [(0.0, 0.004, 1.320), (0.0, 0.004, 1.380), (0.0, 0.006, 1.440)]
    radii = [(0.050, 0.046), (0.045, 0.042), (0.043, 0.041)]
    verts, faces = geom.tube(path, radii, segments=14)
    mb.add(verts, faces, "neck")


def build_head(mb):
    verts, faces = geom.ellipsoid(rig.HEAD_CENTER, rig.HEAD_RADII,
                                  segments=28, rings=20)
    mb.add(verts, faces, "head", group="head")


def build_hair(mb):
    """頭部を覆う髪。後ろほど深く垂らしてボブ状のシルエットにする。"""
    center, radii = rig.HEAD_CENTER, rig.HEAD_RADII
    segments, rings = 28, 12
    outer_k, inner_k = 1.052, 1.004
    # theta_max(phi) = base + amp * sin(phi)。+Y(後頭部) で深く、-Y(顔) で浅く。
    base_theta, amp_theta = 1.68, 0.66

    def shell(k):
        rx, ry, rz = (r * k for r in radii)
        pts = [(center[0], center[1], center[2] + rz)]
        for r in range(1, rings + 1):
            for s in range(segments):
                phi = 2.0 * math.pi * s / segments
                theta = (base_theta + amp_theta * math.sin(phi)) * r / rings
                st, ct = math.sin(theta), math.cos(theta)
                pts.append((center[0] + rx * st * math.cos(phi),
                            center[1] + ry * st * math.sin(phi),
                            center[2] + rz * ct))
        return pts

    outer = shell(outer_k)
    inner = shell(inner_k)
    n_shell = len(outer)
    verts = outer + inner
    faces = []

    def grid(base, flip):
        f = []
        for s in range(segments):
            t = (s + 1) % segments
            tri = (base, base + 1 + t, base + 1 + s)
            f.append(tuple(reversed(tri)) if flip else tri)
        for r in range(rings - 1):
            a = base + 1 + r * segments
            b = base + 1 + (r + 1) * segments
            for s in range(segments):
                t = (s + 1) % segments
                quad = (a + s, a + t, b + t, b + s)
                f.append(tuple(reversed(quad)) if flip else quad)
        return f

    faces += grid(0, flip=False)
    faces += grid(n_shell, flip=True)
    # 外殻と内殻の縁を繋いで厚みを閉じる。
    rim_o = 1 + (rings - 1) * segments
    rim_i = n_shell + rim_o
    for s in range(segments):
        t = (s + 1) % segments
        faces.append((rim_o + s, rim_o + t, rim_i + t, rim_i + s))

    mb.add(verts, faces, "hair", group="head")


def build_arm(mb, side):
    s = rig.side_sign(side)
    a = rig.ARM
    path = [
        (0.088 * s, 0.0, 1.310),
        (a["upperArm"][0] * s, 0.0, 1.315),
        (0.245 * s, 0.0, 1.315),
        (a["lowerArm"][0] * s, 0.0, 1.315),
        (0.490 * s, 0.0, 1.315),
        (a["hand"][0] * s, 0.0, 1.315),
    ]
    radii = [(0.062, 0.062), (0.052, 0.052), (0.045, 0.045),
             (0.040, 0.040), (0.036, 0.036), (0.033, 0.033)]
    verts, faces = geom.tube(path, radii, segments=12)
    mb.add(verts, faces, "arm")


def build_hand(mb, side):
    s = rig.side_sign(side)
    # 手のひら。X 軸方向のチューブなので (ru, rv) = (Y 方向の幅, Z 方向の厚み)。
    palm_path = [
        (0.598 * s, 0.0, 1.315),
        (0.630 * s, -0.003, 1.314),
        (0.660 * s, -0.005, 1.313),
        (0.680 * s, -0.006, 1.313),
    ]
    palm_radii = [(0.034, 0.017), (0.042, 0.018), (0.043, 0.017), (0.040, 0.015)]
    verts, faces = geom.tube(palm_path, palm_radii, segments=12)
    mb.add(verts, faces, "hand")

    for finger, _ in facedef_fingers():
        root = rig.FINGER_ROOTS[finger]
        segs = rig.FINGER_SEGMENTS[finger]
        radius = rig.FINGER_RADII[finger]
        path = [(root[0] * s, root[1], root[2])]
        cur = path[0]
        for d in segs:
            cur = (cur[0] + d[0] * s, cur[1] + d[1], cur[2] + d[2])
            path.append(cur)
        radii = [radius, radius * 0.94, radius * 0.86, radius * 0.72]
        verts, faces = geom.tube(path, radii, segments=6)
        mb.add(verts, faces, "hand")


def facedef_fingers():
    from vrm_spec import FINGERS
    return FINGERS


def build_leg(mb, side):
    s = rig.side_sign(side)
    l = rig.LEG
    path = [
        (l["upperLeg"][0] * s, 0.002, 0.905),
        (0.077 * s, 0.002, 0.760),
        (0.078 * s, 0.001, 0.600),
        (l["lowerLeg"][0] * s, 0.0, 0.470),
        (0.079 * s, -0.004, 0.330),
        (0.080 * s, 0.002, 0.180),
        (l["foot"][0] * s, 0.005, 0.078),
    ]
    radii = [(0.086, 0.084), (0.072, 0.070), (0.060, 0.058),
             (0.052, 0.052), (0.055, 0.052), (0.043, 0.042), (0.034, 0.036)]
    verts, faces = geom.tube(path, radii, segments=12)
    mb.add(verts, faces, "leg")


def build_foot(mb, side):
    s = rig.side_sign(side)
    path = [
        (0.080 * s, 0.010, 0.080),
        (0.080 * s, -0.010, 0.040),
        (0.080 * s, -0.070, 0.030),
        (0.080 * s, -0.130, 0.028),
        (0.080 * s, -0.168, 0.026),
    ]
    radii = [(0.036, 0.038), (0.042, 0.035), (0.043, 0.030),
             (0.040, 0.026), (0.028, 0.020)]
    verts, faces = geom.tube(path, radii, segments=12)
    # 靴底を平らにする。
    verts = [(v[0], v[1], max(v[2], 0.006)) for v in verts]
    mb.add(verts, faces, "foot")


def build_face_patches(mb):
    """顔パーツを追加し、シェイプキー生成用のメタ情報を返す。"""
    patches = {}
    seg = facedef.SEGMENTS
    faces = geom.fan_faces(seg)

    def emit(name, side):
        params = facedef.patch_params(name, side)
        verts = patch_verts(params)
        group = f"{name}_{side}"
        start = mb.add(verts, faces, name, group=group)
        patches[(name, side)] = start

    for name in facedef.SIDED:
        for side in ("left", "right"):
            emit(name, side)
    for name in facedef.CENTERED:
        emit(name, "center")
    return patches


def patch_verts(params):
    return geom.face_patch(
        params["cx"], params["cz"], params["rx"], params["rz"],
        rig.HEAD_CENTER, rig.HEAD_RADII, facedef.SEGMENTS,
        rot=params["rot"], curve=params["curve"],
        offset=params["offset"], lift=params.get("lift", 0.0),
    )


def build_mesh_data():
    mb = geom.MeshBuilder()
    build_torso(mb)
    build_neck(mb)
    build_head(mb)
    build_hair(mb)
    for side in ("left", "right"):
        build_arm(mb, side)
        build_hand(mb, side)
        build_leg(mb, side)
        build_foot(mb, side)
    patches = build_face_patches(mb)
    return mb, patches


# --- Blender オブジェクト化 ------------------------------------------------

def make_materials():
    mats = []
    for name in MATERIAL_ORDER:
        color, roughness = MATERIALS[name]
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (*color, 1.0)
            bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
        mat.diffuse_color = (*color, 1.0)
        mats.append(mat)
    return mats


def create_mesh_object(mb):
    mesh = bpy.data.meshes.new("AvatarMesh")
    mesh.from_pydata(mb.verts, [], [f for f, _ in mb.faces])
    mesh.update()

    obj = bpy.data.objects.new("Avatar", mesh)
    bpy.context.collection.objects.link(obj)

    for mat in make_materials():
        mesh.materials.append(mat)
    index_of = {name: i for i, name in enumerate(MATERIAL_ORDER)}
    for poly, (indices, tag) in zip(mesh.polygons, mb.faces):
        centroid = tuple(sum(mb.verts[i][k] for i in indices) / len(indices)
                         for k in range(3))
        poly.material_index = index_of[material_for(tag, centroid)]

    # 法線の向きを揃え、角度で分割法線を決める。
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    for poly in mesh.polygons:
        poly.use_smooth = True
    mark_sharp_edges(mesh, math.radians(42.0))
    return obj


def mark_sharp_edges(mesh, threshold):
    """面同士の角度が threshold を超える辺をシャープにする。"""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    for edge in bm.edges:
        if len(edge.link_faces) == 2:
            angle = edge.calc_face_angle(0.0)
            edge.smooth = angle <= threshold
        else:
            edge.smooth = False
    bm.to_mesh(mesh)
    bm.free()


def create_armature():
    arm_data = bpy.data.armatures.new("AvatarArmature")
    arm_obj = bpy.data.objects.new("Armature", arm_data)
    bpy.context.collection.objects.link(arm_obj)

    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='EDIT')

    positions = rig.bone_positions()
    created = {}
    for name, parent in all_bones():
        head, tail = positions[name]
        bone = arm_data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if geom.length(geom.sub(tail, head)) < 1e-5:
            raise ValueError(f"ボーン {name} の長さがゼロです")
        created[name] = bone

    for name, parent in all_bones():
        if parent:
            bone = created[name]
            bone.parent = created[parent]
            bone.use_connect = (
                geom.length(geom.sub(bone.head, created[parent].tail)) < 1e-6
            )

    bpy.ops.object.mode_set(mode='OBJECT')
    return arm_obj


# --- スキニング -----------------------------------------------------------

# 頭部・顔パーツは head に固定する。首の曲げで顔が歪むのを防ぐ。
FORCED_BONE = {"head": "head"}
for _name in facedef.SIDED:
    for _side in ("left", "right"):
        FORCED_BONE[f"{_name}_{_side}"] = "head"
FORCED_BONE["mouth_center"] = "head"
# 虹彩だけは目ボーンに追従させて視線移動に使う。
FORCED_BONE["iris_left"] = "leftEye"
FORCED_BONE["iris_right"] = "rightEye"

# 距離ベースの自動ウェイトから除外するボーン。
AUTO_WEIGHT_EXCLUDE = {"leftEye", "rightEye"}

MAX_INFLUENCES = 4
SMOOTH_ITERATIONS = 8


def segment_distances(points, segments):
    """点群と線分群の距離行列 (N, B) を返す。"""
    p = points[:, None, :]                       # (N, 1, 3)
    a = segments[None, :, 0, :]                  # (1, B, 3)
    b = segments[None, :, 1, :]
    ab = b - a
    denom = np.sum(ab * ab, axis=2)
    denom[denom < 1e-12] = 1e-12
    t = np.sum((p - a) * ab, axis=2) / denom     # (N, B)
    t = np.clip(t, 0.0, 1.0)
    closest = a + ab * t[:, :, None]
    return np.linalg.norm(p - closest, axis=2)


def compute_weights(mb, bone_names, positions):
    """距離の逆数ベースでウェイトを作り、隣接頂点で平滑化する。"""
    points = np.array(mb.verts, dtype=np.float64)
    auto_names = [n for n in bone_names if n not in AUTO_WEIGHT_EXCLUDE]
    segments = np.array([[positions[n][0], positions[n][1]] for n in auto_names],
                        dtype=np.float64)

    dist = segment_distances(points, segments)
    weights = 1.0 / np.power(dist + 1e-4, 4.0)
    weights /= weights.sum(axis=1, keepdims=True)

    adjacency = mb.adjacency()
    max_neighbors = max((len(a) for a in adjacency), default=0)
    neighbor_idx = np.zeros((len(points), max_neighbors), dtype=np.int64)
    neighbor_mask = np.zeros((len(points), max_neighbors), dtype=np.float64)
    for i, nb in enumerate(adjacency):
        if nb:
            neighbor_idx[i, :len(nb)] = nb
            neighbor_mask[i, :len(nb)] = 1.0
    counts = neighbor_mask.sum(axis=1, keepdims=True)
    counts[counts == 0] = 1.0

    for _ in range(SMOOTH_ITERATIONS):
        neighbor_sum = (weights[neighbor_idx] * neighbor_mask[:, :, None]).sum(axis=1)
        weights = 0.5 * weights + 0.5 * (neighbor_sum / counts)
        weights /= weights.sum(axis=1, keepdims=True)

    # 影響ボーン数を絞る。
    keep = np.argsort(-weights, axis=1)[:, :MAX_INFLUENCES]
    trimmed = np.zeros_like(weights)
    rows = np.arange(len(points))[:, None]
    trimmed[rows, keep] = weights[rows, keep]
    total = trimmed.sum(axis=1, keepdims=True)
    total[total == 0] = 1.0
    trimmed /= total
    return auto_names, trimmed


def apply_skinning(obj, mb, arm_obj):
    bone_names = [name for name, _ in all_bones()]
    positions = rig.bone_positions()

    groups = {name: obj.vertex_groups.new(name=name) for name in bone_names}

    auto_names, weights = compute_weights(mb, bone_names, positions)

    forced = np.zeros(len(mb.verts), dtype=bool)
    for group_name, bone in FORCED_BONE.items():
        indices = mb.groups.get(group_name)
        if not indices:
            continue
        groups[bone].add(indices, 1.0, 'REPLACE')
        forced[np.array(indices, dtype=np.int64)] = True

    for b, name in enumerate(auto_names):
        column = weights[:, b]
        indices = [i for i in np.nonzero(column > 1e-4)[0].tolist() if not forced[i]]
        group = groups[name]
        for i in indices:
            group.add([i], float(column[i]), 'REPLACE')

    modifier = obj.modifiers.new("Armature", 'ARMATURE')
    modifier.object = arm_obj
    obj.parent = arm_obj


# --- シェイプキー ---------------------------------------------------------

def add_shape_keys(obj, patches):
    basis = obj.shape_key_add(name="Basis", from_mix=False)
    basis.value = 0.0
    created = []
    for expression in MORPH_EXPRESSIONS:
        key = obj.shape_key_add(name=expression, from_mix=False)
        key.slider_min, key.slider_max = 0.0, 1.0
        # shape_key_add は value=1.0 で作る。そのままだと全表情が重なった状態が
        # 素の形状になり、glTF にもその weights が書き出されてしまう。
        key.value = 0.0
        moved = 0
        for name, side in facedef.moved_patches(expression):
            params = facedef.patch_params(name, side, expression)
            if params is None:
                continue
            start = patches[(name, side)]
            for offset, co in enumerate(patch_verts(params)):
                key.data[start + offset].co = co
                moved += 1
        if moved == 0:
            raise ValueError(f"表情 {expression} が頂点を一つも動かしていません")
        created.append(expression)
    return created


# --- 書き出し -------------------------------------------------------------

def export_glb(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=False,          # シェイプキーを残すため必須
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_try_sparse_sk=False,  # 互換性重視で密な morph target にする
        export_normals=True,
        export_materials='EXPORT',
        export_animations=False,
        export_def_bones=False,
        use_selection=False,
    )


def main():
    parser = argparse.ArgumentParser(description="VRM 用アバターの GLB を生成する")
    parser.add_argument("--out", default="build/avatar.glb")
    parser.add_argument("--save-blend", default=None,
                        help="デバッグ用に .blend も保存する")
    args, _ = parser.parse_known_args(argv_after_dashes())

    bpy.ops.wm.read_factory_settings(use_empty=True)

    mb, patches = build_mesh_data()
    obj = create_mesh_object(mb)
    arm_obj = create_armature()
    apply_skinning(obj, mb, arm_obj)
    created = add_shape_keys(obj, patches)

    export_glb(args.out)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))

    print(f"[build_avatar] 頂点数={len(mb.verts)} 面数={len(mb.faces)} "
          f"ボーン数={len(all_bones())} 表情数={len(created)}")
    print(f"[build_avatar] 出力: {args.out}")


def argv_after_dashes():
    """`blender --background --python x.py -- --out ...` の形にも対応する。"""
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1:]
    return sys.argv[1:]


if __name__ == "__main__":
    main()
