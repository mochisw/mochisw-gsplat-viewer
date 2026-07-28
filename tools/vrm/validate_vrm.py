"""生成した .vrm を検証する。

    python3 tools/vrm/validate_vrm.py build/avatar.vrm

VRM 1.0 として成立しているか（必須ボーン、表情の参照先、向き、スケール、
スキンウェイトの正規化など）を機械的に確認する。bpy には依存しない。
"""

import argparse
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from glb_to_vrm import MTOON_EXT, VRM_EXT, read_glb  # noqa: E402
from vrm_spec import MORPH_EXPRESSIONS, REQUIRED_BONES  # noqa: E402

COMPONENT_FORMAT = {
    5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
    5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4),
}
TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.info = []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def note(self, msg):
        self.info.append(msg)

    def ok(self):
        return not self.errors


def read_accessor(gltf, binary, index):
    """アクセサを Python のタプルのリストとして読む（sparse 非対応）。"""
    acc = gltf["accessors"][index]
    if "sparse" in acc:
        raise ValueError("sparse アクセサには未対応です")
    fmt, size = COMPONENT_FORMAT[acc["componentType"]]
    ncomp = TYPE_COUNT[acc["type"]]
    count = acc["count"]
    if "bufferView" not in acc:
        return [(0,) * ncomp] * count

    view = gltf["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride") or size * ncomp

    out = []
    for i in range(count):
        offset = base + i * stride
        out.append(struct.unpack_from("<" + fmt * ncomp, binary, offset))
    return out


def check_structure(gltf, rep):
    ext = gltf.get("extensions", {}).get(VRM_EXT)
    if ext is None:
        rep.error(f"{VRM_EXT} 拡張がありません")
        return None
    if ext.get("specVersion") != "1.0":
        rep.error(f"specVersion が 1.0 ではありません: {ext.get('specVersion')}")
    for name in (VRM_EXT, MTOON_EXT):
        if name not in gltf.get("extensionsUsed", []):
            rep.error(f"extensionsUsed に {name} がありません")
    return ext


def check_meta(ext, rep):
    meta = ext.get("meta")
    if not meta:
        rep.error("meta がありません")
        return
    for key in ("name", "version", "authors", "licenseUrl", "avatarPermission",
                "commercialUsage", "creditNotation", "modification"):
        if key not in meta:
            rep.error(f"meta.{key} がありません")
    if not meta.get("authors"):
        rep.error("meta.authors が空です")
    if "thumbnailImage" in meta:
        rep.note(f"サムネイル埋め込み済み (image #{meta['thumbnailImage']})")


def check_humanoid(gltf, ext, rep):
    bones = ext.get("humanoid", {}).get("humanBones", {})
    if not bones:
        rep.error("humanBones がありません")
        return
    node_count = len(gltf.get("nodes", []))
    for name in REQUIRED_BONES:
        if name not in bones:
            rep.error(f"必須ボーン {name} がありません")
    seen = {}
    for name, entry in bones.items():
        node = entry.get("node")
        if node is None or not (0 <= node < node_count):
            rep.error(f"ボーン {name} のノード参照が不正です: {node}")
            continue
        if node in seen:
            rep.error(f"ボーン {name} と {seen[node]} が同じノードを指しています")
        seen[node] = name
    rep.note(f"ヒューマノイドボーン {len(bones)} 本")


def check_expressions(gltf, ext, rep):
    preset = ext.get("expressions", {}).get("preset", {})
    if not preset:
        rep.error("expressions.preset がありません")
        return
    for name in MORPH_EXPRESSIONS:
        entry = preset.get(name)
        if entry is None:
            rep.error(f"表情 {name} が定義されていません")
            continue
        binds = entry.get("morphTargetBinds") or []
        if not binds:
            rep.error(f"表情 {name} に morphTargetBinds がありません")
            continue
        for bind in binds:
            node = gltf["nodes"][bind["node"]]
            mesh = gltf["meshes"][node["mesh"]]
            targets = mesh["primitives"][0].get("targets", [])
            if not (0 <= bind["index"] < len(targets)):
                rep.error(f"表情 {name} の morph index {bind['index']} が範囲外です")
    rep.note(f"表情 {len(preset)} 種（うちモーフ {len(MORPH_EXPRESSIONS)} 種）")


def check_orientation(gltf, binary, ext, rep):
    """VRM 1.0 が要求する『+Z を向いた Y-up』になっているか確かめる。"""
    bones = ext.get("humanoid", {}).get("humanBones", {})
    if "leftToes" not in bones or "head" not in bones:
        rep.warn("向きの検証に必要なボーンが無いためスキップします")
        return

    world = node_world_positions(gltf)
    toes = world[bones["leftToes"]["node"]]
    hips = world[bones["hips"]["node"]]
    head = world[bones["head"]["node"]]
    left_hand = world[bones["leftHand"]["node"]]

    if head[1] <= hips[1]:
        rep.error("頭が腰より上にありません（Y-up になっていない可能性）")
    if toes[2] <= hips[2]:
        rep.error(f"つま先が前(+Z)を向いていません: toes.z={toes[2]:.3f} "
                  f"hips.z={hips[2]:.3f}")
    if left_hand[0] <= 0:
        rep.error(f"左手が +X 側にありません: x={left_hand[0]:.3f}")

    lo, hi = mesh_bounds(gltf)
    height = hi[1] - lo[1]
    rep.note(f"全高 約 {height:.3f} m / つま先 z={toes[2]:+.3f} "
             f"/ 左手 x={left_hand[0]:+.3f}")
    if not (0.5 <= height <= 3.0):
        rep.warn(f"全高 {height:.2f} m は一般的な範囲から外れています")
    if abs(lo[1]) > 0.05:
        rep.warn(f"足元が原点にありません (最下点 y={lo[1]:+.3f})")


def mesh_bounds(gltf):
    """全プリミティブの POSITION アクセサの min/max からバウンディングボックスを得る。"""
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            for k in range(3):
                lo[k] = min(lo[k], acc["min"][k])
                hi[k] = max(hi[k], acc["max"][k])
    return lo, hi


def mat_identity():
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0]


def mat_mul(a, b):
    """行優先 4x4 行列の積 a * b。"""
    out = [0.0] * 16
    for r in range(4):
        for c in range(4):
            out[r * 4 + c] = sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
    return out


def node_local_matrix(node):
    """glTF ノードのローカル行列（行優先）を組み立てる。"""
    if "matrix" in node:
        m = node["matrix"]          # glTF は列優先なので転置する
        return [m[c * 4 + r] for r in range(4) for c in range(4)]

    tx, ty, tz = node.get("translation", [0.0, 0.0, 0.0])
    qx, qy, qz, qw = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    sx, sy, sz = node.get("scale", [1.0, 1.0, 1.0])

    rot = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
        2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
        2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ]
    scale = (sx, sy, sz)
    return [
        rot[0] * scale[0], rot[1] * scale[1], rot[2] * scale[2], tx,
        rot[3] * scale[0], rot[4] * scale[1], rot[5] * scale[2], ty,
        rot[6] * scale[0], rot[7] * scale[1], rot[8] * scale[2], tz,
        0.0, 0.0, 0.0, 1.0,
    ]


def node_world_positions(gltf):
    """各ノードのワールド座標を TRS を正しく合成して求める。"""
    nodes = gltf["nodes"]
    parent = {}
    for i, node in enumerate(nodes):
        for child in node.get("children", []):
            parent[child] = i

    cache = {}

    def world_matrix(i):
        if i in cache:
            return cache[i]
        local = node_local_matrix(nodes[i])
        m = mat_mul(world_matrix(parent[i]), local) if i in parent else local
        cache[i] = m
        return m

    return {i: [world_matrix(i)[3], world_matrix(i)[7], world_matrix(i)[11]]
            for i in range(len(nodes))}


def check_skinning(gltf, binary, rep):
    skins = gltf.get("skins", [])
    if not skins:
        rep.error("skin がありません")
        return
    joint_count = len(skins[0]["joints"])
    rep.note(f"スキンジョイント {joint_count} 本")

    bad_sum, bad_joint, total = 0, 0, 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            attrs = prim["attributes"]
            if "WEIGHTS_0" not in attrs or "JOINTS_0" not in attrs:
                rep.error("WEIGHTS_0 / JOINTS_0 が欠けたプリミティブがあります")
                continue
            weights = read_accessor(gltf, binary, attrs["WEIGHTS_0"])
            joints = read_accessor(gltf, binary, attrs["JOINTS_0"])
            for w, j in zip(weights, joints):
                total += 1
                if abs(sum(w) - 1.0) > 1e-3:
                    bad_sum += 1
                if any(x >= joint_count for x in j):
                    bad_joint += 1
    if bad_sum:
        rep.error(f"ウェイト合計が 1 でない頂点が {bad_sum}/{total} 個あります")
    if bad_joint:
        rep.error(f"ジョイント参照が範囲外の頂点が {bad_joint} 個あります")
    if total and not bad_sum and not bad_joint:
        rep.note(f"スキンウェイト {total} 頂点すべて正規化済み")


def check_morph_weights(gltf, rep):
    """素の状態で表情が適用されていないこと（weights が全て 0）を確かめる。"""
    for i, node in enumerate(gltf.get("nodes", [])):
        weights = node.get("weights")
        if weights and any(abs(w) > 1e-6 for w in weights):
            rep.error(f"ノード #{i} の morph weights が 0 ではありません: {weights}")
    for mesh in gltf.get("meshes", []):
        weights = mesh.get("weights")
        if weights and any(abs(w) > 1e-6 for w in weights):
            rep.error(f"メッシュ {mesh.get('name')} の既定 weights が 0 ではありません")


def check_materials(gltf, rep):
    materials = gltf.get("materials", [])
    if not materials:
        rep.error("マテリアルがありません")
        return
    missing = [m.get("name") for m in materials
               if MTOON_EXT not in m.get("extensions", {})]
    if missing:
        rep.warn(f"MToon 未設定のマテリアル: {', '.join(str(m) for m in missing)}")
    else:
        rep.note(f"MToon 設定済みマテリアル {len(materials)} 種")


def validate(path):
    rep = Report()
    gltf, binary = read_glb(path)
    rep.note(f"ファイルサイズ {os.path.getsize(path) / 1024:.0f} KiB")

    ext = check_structure(gltf, rep)
    if ext is not None:
        check_meta(ext, rep)
        check_humanoid(gltf, ext, rep)
        check_expressions(gltf, ext, rep)
        check_orientation(gltf, binary, ext, rep)
    check_skinning(gltf, binary, rep)
    check_morph_weights(gltf, rep)
    check_materials(gltf, rep)
    return rep


def main():
    parser = argparse.ArgumentParser(description="VRM ファイルを検証する")
    parser.add_argument("path", nargs="?", default="build/avatar.vrm")
    args = parser.parse_args()

    rep = validate(args.path)
    for msg in rep.info:
        print(f"  info : {msg}")
    for msg in rep.warnings:
        print(f"  warn : {msg}")
    for msg in rep.errors:
        print(f"  ERROR: {msg}")

    if rep.ok():
        print(f"\nOK: {args.path} は VRM 1.0 として妥当です"
              f"（警告 {len(rep.warnings)} 件）")
        return 0
    print(f"\nNG: エラー {len(rep.errors)} 件")
    return 1


if __name__ == "__main__":
    sys.exit(main())
