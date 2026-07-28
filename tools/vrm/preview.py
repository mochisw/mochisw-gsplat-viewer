"""生成したアバターを画像に焼いて目視確認するためのスクリプト。

    python3 tools/vrm/preview.py --out build/preview

正面・側面・斜め・顔アップ・表情一覧を PNG で出力する。
GPU の要らない Workbench レンダラを使うのでヘッドレスでも動く。
"""

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

import build_avatar as ba  # noqa: E402
import face as facedef  # noqa: E402
from vrm_spec import MORPH_EXPRESSIONS  # noqa: E402


def add_light(name, location, rotation, energy, size):
    data = bpy.data.lights.new(name, type='AREA')
    data.energy = energy
    data.size = size
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = rotation
    bpy.context.collection.objects.link(obj)
    return obj


def setup_scene():
    """Cycles(CPU) で組む。EGL が無いヘッドレス環境でも描画できる。"""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'Khronos PBR Neutral'

    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.18, 0.19, 0.22, 1.0)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.5
    scene.world = world

    # キー / フィル / リムの三点照明。白飛びしない強さに抑える。
    add_light("Key", (-1.6, -2.2, 2.6), (math.radians(52), 0, math.radians(-36)), 90, 3.0)
    add_light("Fill", (2.2, -1.8, 1.2), (math.radians(78), 0, math.radians(52)), 35, 3.0)
    add_light("Rim", (0.6, 2.6, 2.2), (math.radians(128), 0, math.radians(12)), 70, 2.5)

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new("Camera", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    return cam


def shot(cam, path, location, rotation, ortho_scale, res=(480, 720)):
    cam.location = location
    cam.rotation_euler = rotation
    cam.data.ortho_scale = ortho_scale
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="build/preview")
    parser.add_argument("--thumbnail", default=None,
                        help="VRM 埋め込み用の正方形サムネイルだけを書き出す")
    args, _ = parser.parse_known_args(ba.argv_after_dashes())
    outdir = os.path.abspath(args.out)
    os.makedirs(outdir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    mb, patches = ba.build_mesh_data()
    obj = ba.create_mesh_object(mb)
    arm = ba.create_armature()
    ba.apply_skinning(obj, mb, arm)
    ba.add_shape_keys(obj, patches)
    arm.hide_viewport = True
    arm.hide_render = True

    cam = setup_scene()
    mid = 0.81   # 体の中心高さ

    if args.thumbnail:
        # VRM のサムネイルは正方形が推奨。胸から上を写す。
        path = os.path.abspath(args.thumbnail)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        shot(cam, path, (0, -2.0, 1.415), (math.pi / 2, 0, 0), 0.46,
             res=(512, 512))
        print(f"[preview] サムネイル: {path}")
        return

    shot(cam, f"{outdir}/front.png", (0, -4, mid), (math.pi / 2, 0, 0), 1.85)
    shot(cam, f"{outdir}/side.png", (4, 0, mid), (math.pi / 2, 0, math.pi / 2), 1.85)
    shot(cam, f"{outdir}/three_quarter.png",
         (-2.6, -3.0, mid + 0.35), (math.radians(83), 0, math.radians(-41)), 1.9)
    shot(cam, f"{outdir}/face.png", (0, -1.0, 1.487),
         (math.pi / 2, 0, 0), 0.30, res=(480, 480))
    shot(cam, f"{outdir}/hand.png", (0.66, -0.6, 1.313),
         (math.pi / 2, 0, 0), 0.26, res=(480, 480))

    # 表情ごとの顔アップ。
    keys = obj.data.shape_keys.key_blocks
    expr_dir = os.path.join(outdir, "expressions")
    os.makedirs(expr_dir, exist_ok=True)
    for name in MORPH_EXPRESSIONS:
        for k in keys:
            if k.name != "Basis":
                k.value = 0.0
        keys[name].value = 1.0
        shot(cam, f"{expr_dir}/{name}.png", (0, -1.0, 1.487),
             (math.pi / 2, 0, 0), 0.30, res=(300, 300))
    for k in keys:
        if k.name != "Basis":
            k.value = 0.0

    print(f"[preview] 出力先: {outdir}")


if __name__ == "__main__":
    main()
