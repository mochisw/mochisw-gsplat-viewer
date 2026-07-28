import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMMetaLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import fs from 'fs';

const file = process.argv[2];
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser, {
  // Node には画像デコーダが無いのでサムネイル読み込みだけ無効化する
  metaPlugin: new VRMMetaLoaderPlugin(parser, { needThumbnailImage: false }),
}));

const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

loader.parse(ab, '', (gltf) => {
  const vrm = gltf.userData.vrm;
  if (!vrm) { console.error('FAIL: userData.vrm が無い'); process.exit(1); }
  console.log('OK  three-vrm がロード成功');
  console.log('  meta.name        :', vrm.meta.name);
  console.log('  meta.licenseUrl  :', vrm.meta.licenseUrl);
  console.log('  metaVersion      :', vrm.meta.metaVersion);
  const hb = vrm.humanoid.humanBones;
  const bones = Object.keys(hb);
  console.log('  humanoid bones   :', bones.length);
  for (const req of ['hips','spine','head','leftHand','rightHand','leftFoot','rightFoot']) {
    if (!hb[req]) { console.error('FAIL: 必須ボーン欠落', req); process.exit(1); }
  }
  const exprNames = vrm.expressionManager.expressions.map(e => e.expressionName);
  console.log('  expressions      :', exprNames.join(', '));
  for (const req of ['aa','blink','happy','surprised']) {
    if (!exprNames.includes(req)) { console.error('FAIL: 表情欠落', req); process.exit(1); }
  }
  console.log('  lookAt type      :', vrm.lookAt ? vrm.lookAt.applier.constructor.name : 'なし');
  // 表情を適用して実際に頂点が動くか確認
  const mesh = [];
  vrm.scene.traverse(o => { if (o.isSkinnedMesh) mesh.push(o); });
  console.log('  skinned meshes   :', mesh.length, '/ morphs:', mesh[0].morphTargetInfluences.length);
  vrm.expressionManager.setValue('blink', 1.0);
  vrm.expressionManager.update();
  const infl = mesh[0].morphTargetInfluences.filter(v => v > 0).length;
  if (infl === 0) { console.error('FAIL: blink がモーフを動かさない'); process.exit(1); }
  console.log('  blink=1 で影響を受けた morph 数:', infl);
  // MToon
  const mats = new Set();
  vrm.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => mats.add(m.type)); });
  console.log('  material types   :', [...mats].join(', '));
  console.log('\nすべての検査を通過');
}, (err) => { console.error('FAIL: パースエラー', err); process.exit(1); });
