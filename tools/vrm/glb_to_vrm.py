"""GLB に VRM 1.0 拡張を注入して .vrm を書き出す。

    python3 tools/vrm/glb_to_vrm.py build/avatar.glb -o build/avatar.vrm

VRM は glTF 2.0 に VRMC_vrm 拡張を足したものなので、Blender が吐いた GLB の
JSON チャンクへヒューマノイド定義・表情定義・メタ情報を書き込めば .vrm になる。
bpy には依存しないので、素の Python だけで実行できる。
"""

import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette  # noqa: E402
import rig  # noqa: E402
from vrm_spec import MORPH_EXPRESSIONS, REQUIRED_BONES, all_bones  # noqa: E402

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

VRM_EXT = "VRMC_vrm"
MTOON_EXT = "VRMC_materials_mtoon"
SPRING_EXT = "VRMC_springBone"

# 揺れ骨チェーンのボーン名接頭辞（hair.py と揃える）。
SPRING_PREFIX = "sp_"


# --- GLB の読み書き -------------------------------------------------------

def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path} は GLB ではありません")
    if version != 2:
        raise ValueError(f"未対応の GLB バージョン: {version}")

    gltf, binary = None, b""
    offset = 12
    while offset < min(total, len(data)):
        length, kind = struct.unpack_from("<II", data, offset)
        payload = data[offset + 8:offset + 8 + length]
        if kind == CHUNK_JSON:
            gltf = json.loads(payload.decode("utf-8"))
        elif kind == CHUNK_BIN:
            binary = payload
        offset += 8 + length + (-length % 4)
    if gltf is None:
        raise ValueError("JSON チャンクが見つかりません")
    return gltf, binary


def write_glb(path, gltf, binary):
    json_bytes = json.dumps(gltf, separators=(",", ":"),
                            ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    binary = binary + b"\x00" * (-len(binary) % 4)

    total = 12 + 8 + len(json_bytes) + (8 + len(binary) if binary else 0)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", GLB_MAGIC, 2, total))
        fh.write(struct.pack("<II", len(json_bytes), CHUNK_JSON))
        fh.write(json_bytes)
        if binary:
            fh.write(struct.pack("<II", len(binary), CHUNK_BIN))
            fh.write(binary)
    return total


# --- glTF 内の索引 --------------------------------------------------------

def node_index_by_name(gltf):
    index = {}
    for i, node in enumerate(gltf.get("nodes", [])):
        name = node.get("name")
        if name is None:
            continue
        if name in index:
            raise ValueError(f"ノード名 {name} が重複しています")
        index[name] = i
    return index


def find_avatar_mesh_node(gltf):
    """スキン付きメッシュを持つノードのインデックスを返す。"""
    candidates = [i for i, n in enumerate(gltf.get("nodes", []))
                  if "mesh" in n and "skin" in n]
    if not candidates:
        candidates = [i for i, n in enumerate(gltf.get("nodes", [])) if "mesh" in n]
    if len(candidates) != 1:
        raise ValueError(f"メッシュノードを一意に特定できません: {candidates}")
    return candidates[0]


def morph_target_names(gltf, node_index):
    mesh = gltf["meshes"][gltf["nodes"][node_index]["mesh"]]
    names = (mesh.get("extras") or {}).get("targetNames")
    if names:
        return list(names)
    # targetNames が無ければ生成時の順序を信じる。
    count = len(mesh["primitives"][0].get("targets", []))
    if count != len(MORPH_EXPRESSIONS):
        raise ValueError("morph target 名を特定できません")
    return list(MORPH_EXPRESSIONS)


# --- VRM 各セクションの構築 -----------------------------------------------

def build_meta(args):
    return {
        "name": args.name,
        "version": args.version,
        "authors": [a.strip() for a in args.author.split(",") if a.strip()],
        "copyrightInformation": args.copyright or "",
        "contactInformation": args.contact or "",
        "references": [],
        "thirdPartyLicenses": "",
        "licenseUrl": "https://vrm.dev/licenses/1.0/",
        "avatarPermission": args.avatar_permission,
        "allowExcessivelyViolentUsage": False,
        "allowExcessivelySexualUsage": False,
        "commercialUsage": args.commercial_usage,
        "allowPoliticalOrReligiousUsage": False,
        "allowAntisocialOrHateUsage": False,
        "creditNotation": args.credit_notation,
        "allowRedistribution": args.allow_redistribution,
        "modification": args.modification,
    }


def build_humanoid(nodes_by_name):
    human_bones = {}
    missing = []
    for name, _ in all_bones():
        if name in nodes_by_name:
            human_bones[name] = {"node": nodes_by_name[name]}
        else:
            missing.append(name)
    absent_required = [b for b in REQUIRED_BONES if b not in human_bones]
    if absent_required:
        raise ValueError(f"VRM 必須ボーンが GLB にありません: {absent_required}")
    return {"humanBones": human_bones}, missing


def look_at_offset():
    """頭ボーンから両目中点までのオフセットを glTF 座標系で返す。

    Blender (x, y, z) -> glTF (x, z, -y)。
    視線の中心は左右対称なので x は 0 にする。
    """
    head = rig.JOINTS["head"]
    eye = rig.EYE_ORIGIN
    dx, dy, dz = 0.0, eye[1] - head[1], eye[2] - head[2]
    return [round(dx, 5), round(dz, 5), round(-dy, 5)]


def build_look_at():
    return {
        "type": "bone",
        "offsetFromHeadBone": look_at_offset(),
        "rangeMapHorizontalInner": {"inputMaxValue": 90.0, "outputScale": 8.0},
        "rangeMapHorizontalOuter": {"inputMaxValue": 90.0, "outputScale": 12.0},
        "rangeMapVerticalDown": {"inputMaxValue": 90.0, "outputScale": 10.0},
        "rangeMapVerticalUp": {"inputMaxValue": 90.0, "outputScale": 10.0},
    }


# 目を閉じる表情はまばたきを、口を使う表情はリップシンクを打ち消す。
OVERRIDES = {
    "happy": {"overrideBlink": "block"},
    "relaxed": {"overrideBlink": "block"},
}


def build_expressions(mesh_node, target_names):
    index_of = {name: i for i, name in enumerate(target_names)}
    preset = {}
    for name in MORPH_EXPRESSIONS:
        if name not in index_of:
            raise ValueError(f"morph target に {name} がありません")
        entry = {
            "isBinary": False,
            "morphTargetBinds": [{
                "node": mesh_node,
                "index": index_of[name],
                "weight": 1.0,
            }],
            "materialColorBinds": [],
            "textureTransformBinds": [],
            "overrideBlink": "none",
            "overrideLookAt": "none",
            "overrideMouth": "none",
        }
        entry.update(OVERRIDES.get(name, {}))
        preset[name] = entry

    # 差分の無い neutral も定義しておく（未定義だと警告を出す実装がある）。
    preset["neutral"] = {
        "isBinary": False,
        "morphTargetBinds": [],
        "materialColorBinds": [],
        "textureTransformBinds": [],
        "overrideBlink": "none",
        "overrideLookAt": "none",
        "overrideMouth": "none",
    }
    return {"preset": preset, "custom": {}}


def build_first_person(mesh_node):
    # auto にしておくと実行環境が一人称用の頭無しメッシュを自動生成する。
    return {"meshAnnotations": [{"node": mesh_node, "type": "auto"}]}


# --- MToon ----------------------------------------------------------------

def apply_mtoon(gltf, outline_width):
    """各マテリアルにトゥーンシェーダ設定を足す。"""
    for material in gltf.get("materials", []):
        spec = palette.MATERIALS.get(material.get("name"))
        # アルファ抜きの板ポリ（髪・睫毛など）に輪郭線を付けると
        # 抜いた形の外周ではなく板の外周に線が出るので無効にする。
        width = 0.0 if (spec and spec.alpha) else outline_width
        pbr = material.setdefault("pbrMetallicRoughness", {})
        base = pbr.get("baseColorFactor", [1.0, 1.0, 1.0, 1.0])
        rgb = base[:3]
        # 陰色はベースカラーをやや暗く・わずかに青寄りにする。
        shade = [round(min(1.0, c * 0.72 + 0.02 * i), 4)
                 for i, c in enumerate(rgb)]
        outline_color = [round(c * 0.25, 4) for c in rgb]

        material.setdefault("alphaMode", "OPAQUE")
        pbr["metallicFactor"] = 0.0
        pbr.setdefault("roughnessFactor", 0.9)

        material.setdefault("extensions", {})[MTOON_EXT] = {
            "specVersion": "1.0",
            "transparentWithZWrite": False,
            "renderQueueOffsetNumber": 0,
            "shadeColorFactor": shade,
            "shadingShiftFactor": -0.05,
            "shadingToonyFactor": 0.9,
            "giEqualizationFactor": 0.9,
            "matcapFactor": [0.0, 0.0, 0.0],
            "parametricRimColorFactor": [0.0, 0.0, 0.0],
            "parametricRimFresnelPowerFactor": 5.0,
            "parametricRimLiftFactor": 0.0,
            "rimLightingMixFactor": 1.0,
            "outlineWidthMode": "worldCoordinates" if width > 0 else "none",
            "outlineWidthFactor": width,
            "outlineColorFactor": outline_color,
            "outlineLightingMixFactor": 1.0,
        }
    return len(gltf.get("materials", []))


def apply_alpha_modes(gltf):
    """palette の定義に従って alphaMode / doubleSided を書き込む。

    Blender の書き出しはアルファリンクを BLEND にしがちなので、
    最終的なモードはここで palette を単一の情報源として確定させる。
    """
    for material in gltf.get("materials", []):
        spec = palette.MATERIALS.get(material.get("name"))
        if spec is None:
            continue
        if spec.alpha:
            material["alphaMode"] = spec.alpha
            if spec.alpha == "MASK":
                material["alphaCutoff"] = 0.5
        else:
            material["alphaMode"] = "OPAQUE"
            material.pop("alphaCutoff", None)
        if spec.double_sided:
            material["doubleSided"] = True


# --- springBone -------------------------------------------------------------

def build_spring_bone(gltf, nodes_by_name):
    """sp_* ボーンから VRMC_springBone 拡張を組み立てる。

    チェーンは sp_<名前>_<番号> の連番ノード。番号順に 1 本のスプリングになる。
    見つからなければ None（揺れもの無しのモデルとして成立させる）。
    """
    chains = {}
    for name, index in nodes_by_name.items():
        if not name.startswith(SPRING_PREFIX):
            continue
        chain, _, seq = name.rpartition("_")
        try:
            chains.setdefault(chain, []).append((int(seq), index))
        except ValueError:
            continue
    if not chains:
        return None

    # 髪が体をすり抜けないよう、頭と胸に球コライダを置く。
    # オフセットは Blender 座標の差分を glTF 系 (x, z, -y) に直したもの。
    colliders = [
        {"node": nodes_by_name["head"],
         "shape": {"sphere": {"offset": [0.0, 0.075, -0.008], "radius": 0.11}}},
        {"node": nodes_by_name["chest"],
         "shape": {"sphere": {"offset": [0.0, 0.10, 0.0], "radius": 0.13}}},
    ]
    collider_groups = [{"name": "body", "colliders": [0, 1]}]

    # 根元は硬く、毛先ほど柔らかく。
    stiffness = [1.1, 0.9, 0.7, 0.5]
    springs = []
    for chain in sorted(chains):
        joints = []
        for seq, node in sorted(chains[chain]):
            joints.append({
                "node": node,
                "hitRadius": 0.02,
                "stiffness": stiffness[min(seq, len(stiffness) - 1)],
                "gravityPower": 0.05,
                "gravityDir": [0.0, -1.0, 0.0],
                "dragForce": 0.4,
            })
        springs.append({
            "name": chain,
            "joints": joints,
            "colliderGroups": [0],
        })

    return {
        "specVersion": "1.0",
        "colliders": colliders,
        "colliderGroups": collider_groups,
        "springs": springs,
    }


# --- サムネイル -----------------------------------------------------------

def embed_thumbnail(gltf, binary, png_path):
    """PNG を BIN チャンクに追記して meta.thumbnailImage 用の image を作る。"""
    with open(png_path, "rb") as fh:
        png = fh.read()
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{png_path} は PNG ではありません")

    binary = binary + b"\x00" * (-len(binary) % 4)
    offset = len(binary)
    binary += png
    binary += b"\x00" * (-len(binary) % 4)

    gltf.setdefault("bufferViews", []).append({
        "buffer": 0, "byteOffset": offset, "byteLength": len(png),
    })
    gltf["buffers"][0]["byteLength"] = len(binary)

    gltf.setdefault("images", []).append({
        "name": "thumbnail",
        "mimeType": "image/png",
        "bufferView": len(gltf["bufferViews"]) - 1,
    })
    return binary, len(gltf["images"]) - 1


# --- メイン ---------------------------------------------------------------

def convert(args):
    gltf, binary = read_glb(args.input)

    nodes_by_name = node_index_by_name(gltf)
    mesh_node = find_avatar_mesh_node(gltf)
    target_names = morph_target_names(gltf, mesh_node)

    humanoid, missing = build_humanoid(nodes_by_name)
    meta = build_meta(args)

    if args.thumbnail:
        binary, image_index = embed_thumbnail(gltf, binary, args.thumbnail)
        meta["thumbnailImage"] = image_index

    vrm = {
        "specVersion": "1.0",
        "meta": meta,
        "humanoid": humanoid,
        "firstPerson": build_first_person(mesh_node),
        "lookAt": build_look_at(),
        "expressions": build_expressions(mesh_node, target_names),
    }

    gltf.setdefault("extensions", {})[VRM_EXT] = vrm
    used = gltf.setdefault("extensionsUsed", [])
    for name in (VRM_EXT, MTOON_EXT):
        if name not in used:
            used.append(name)

    spring = build_spring_bone(gltf, nodes_by_name)
    if spring is not None:
        gltf["extensions"][SPRING_EXT] = spring
        if SPRING_EXT not in used:
            used.append(SPRING_EXT)

    material_count = apply_mtoon(gltf, args.outline_width)
    apply_alpha_modes(gltf)
    size = write_glb(args.output, gltf, binary)

    spring_note = (f"揺れ骨 {len(spring['springs'])} 本" if spring
                   else "揺れ骨なし")
    print(f"[glb_to_vrm] ボーン {len(humanoid['humanBones'])} / "
          f"表情 {len(vrm['expressions']['preset'])} / "
          f"マテリアル {material_count} / {spring_note}")
    if missing:
        print(f"[glb_to_vrm] 未割当の任意ボーン: {', '.join(missing)}")
    print(f"[glb_to_vrm] 出力: {args.output} ({size / 1024:.0f} KiB)")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="GLB を VRM 1.0 に変換する")
    p.add_argument("input", help="入力 GLB")
    p.add_argument("-o", "--output", default="build/avatar.vrm")
    p.add_argument("--name", default="Procedural Avatar")
    p.add_argument("--version", default="1.0.0")
    p.add_argument("--author", default="mochisw",
                   help="カンマ区切りで複数指定できる")
    p.add_argument("--copyright", default="")
    p.add_argument("--contact", default="")
    p.add_argument("--thumbnail", default=None, help="埋め込む正方形 PNG")
    p.add_argument("--outline-width", type=float, default=0.0012,
                   help="MToon の輪郭線の太さ(m)。0 で輪郭線なし")
    p.add_argument("--avatar-permission", default="onlyAuthor",
                   choices=["onlyAuthor", "onlySeparatelyLicensedPerson", "everyone"])
    p.add_argument("--commercial-usage", default="personalNonProfit",
                   choices=["personalNonProfit", "personalProfit", "corporation"])
    p.add_argument("--credit-notation", default="required",
                   choices=["required", "unnecessary"])
    p.add_argument("--modification", default="prohibited",
                   choices=["prohibited", "allowModification",
                            "allowModificationRedistribution"])
    p.add_argument("--allow-redistribution", action="store_true")
    return p.parse_args(argv)


if __name__ == "__main__":
    convert(parse_args())
