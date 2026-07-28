/**
 * 生成した .vrm を実装リファレンス (three-vrm) で読み込めるか確認する。
 *
 *   npm install three @pixiv/three-vrm playwright
 *   node tools/vrm/compat_test.mjs build/avatar.vrm
 *
 * Node 単体の GLTFLoader は画像デコードに DOM を要求するため、テクスチャ付きの
 * モデルは読めない。ここでは Chromium を立ち上げて実際の WebGL 環境で読むので、
 * MToon のシェーダが実際にコンパイルできるところまで確かめられる。
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.argv[2] || 'build/avatar.vrm';
const vrmPath = path.resolve(ROOT, target);

if (!fs.existsSync(vrmPath)) {
  console.error(`FAIL: ${vrmPath} がありません`);
  process.exit(1);
}

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.html': 'text/html', '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.json': 'application/json',
};

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{
  "three":"/node_modules/three/build/three.module.js",
  "three/":"/node_modules/three/",
  "@pixiv/three-vrm":"/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js"
}}</script>
<canvas id="c" width="64" height="64"></canvas>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMMetaLoaderPlugin } from '@pixiv/three-vrm';

window.__run = async (url) => {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser, {
    // needThumbnailImage は既定 false。サムネイルまで検証したいので有効にする。
    metaPlugin: new VRMMetaLoaderPlugin(parser, { needThumbnailImage: true }),
  }));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('userData.vrm が無い');

  const meshes = [];
  vrm.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });

  const result = {
    metaName: vrm.meta.name,
    metaVersion: vrm.meta.metaVersion,
    licenseUrl: vrm.meta.licenseUrl,
    hasThumbnail: !!vrm.meta.thumbnailImage,
    bones: Object.keys(vrm.humanoid.humanBones),
    expressions: vrm.expressionManager.expressions.map((e) => e.expressionName),
    lookAt: vrm.lookAt ? vrm.lookAt.applier.constructor.name : null,
    skinnedMeshes: meshes.length,
    morphCount: meshes[0].morphTargetInfluences.length,
    materialTypes: [],
    mtoonMaterials: 0,
    texturedMaterials: 0,
    emissiveMaterials: 0,
  };

  const types = new Set();
  vrm.scene.traverse((o) => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      // MToonMaterial は ShaderMaterial を継承していて .type は
      // 'ShaderMaterial' のまま。判別には isMToonMaterial を見る。
      types.add(m.isMToonMaterial ? 'MToonMaterial' : m.type);
      if (m.isMToonMaterial) result.mtoonMaterials++;
      if (m.map) result.texturedMaterials++;
      if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.001) {
        result.emissiveMaterials++;
      }
    }
  });
  result.materialTypes = [...types];

  // 表情を適用してモーフが動くか
  vrm.expressionManager.setValue('blink', 1.0);
  vrm.expressionManager.update();
  result.blinkDrivesMorphs =
    meshes[0].morphTargetInfluences.filter((v) => v > 0).length;
  vrm.expressionManager.setValue('blink', 0.0);
  vrm.expressionManager.update();

  // 実際に 1 フレーム描画してシェーダのコンパイルまで確かめる
  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') });
  const scene = new THREE.Scene();
  scene.add(vrm.scene);
  scene.add(new THREE.DirectionalLight(0xffffff, 1.0));
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 1.2, 3);
  camera.lookAt(0, 1.0, 0);
  renderer.render(scene, camera);
  result.renderedWithoutError = true;
  result.programCount = renderer.info.programs.length;
  return result;
};
</script>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)
      || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
  });
  fs.createReadStream(file).pipe(res);
});

const REQUIRED_BONES = ['hips', 'spine', 'head', 'leftHand', 'rightHand',
  'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm'];
const REQUIRED_EXPRESSIONS = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink',
  'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

/**
 * インストール済み Playwright の想定するビルド番号と、環境に置かれている
 * Chromium のビルド番号がずれていることがある。その場合は既存のバイナリを
 * 直接指す（環境変数 CHROMIUM_PATH でも上書きできる）。
 */
function chromiumExecutable() {
  const candidates = [process.env.CHROMIUM_PATH].filter(Boolean);
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      candidates.push(
        path.join(base, dir, 'chrome-linux', 'chrome'),
        path.join(base, dir, 'chrome-linux', 'headless_shell'),
      );
    }
  }
  return candidates.find((p) => p && fs.existsSync(p)) || undefined;
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  args: ['--use-gl=swiftshader', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => failures.push(`ページ内エラー: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.__run === 'function');

  const rel = path.relative(ROOT, vrmPath).split(path.sep).join('/');
  const r = await page.evaluate((u) => window.__run(u), `/${rel}`);

  console.log('three-vrm + WebGL での読み込み結果');
  console.log('  meta.name         :', r.metaName);
  console.log('  metaVersion       :', r.metaVersion);
  console.log('  licenseUrl        :', r.licenseUrl);
  console.log('  サムネイル        :', r.hasThumbnail ? 'あり' : 'なし');
  console.log('  humanoid bones    :', r.bones.length);
  console.log('  expressions       :', r.expressions.join(', '));
  console.log('  lookAt            :', r.lookAt);
  console.log('  skinned meshes    :', r.skinnedMeshes, '/ morphs:', r.morphCount);
  console.log('  material types    :', r.materialTypes.join(', '));
  console.log('  MToon マテリアル  :', r.mtoonMaterials);
  console.log('  テクスチャ付き    :', r.texturedMaterials);
  console.log('  発光あり          :', r.emissiveMaterials);
  console.log('  blink で動く morph:', r.blinkDrivesMorphs);
  console.log('  描画              :',
    r.renderedWithoutError ? `OK (シェーダ ${r.programCount} 本)` : 'NG');

  check(r.metaVersion === '1', `metaVersion が 1 ではない: ${r.metaVersion}`);
  for (const b of REQUIRED_BONES) {
    check(r.bones.includes(b), `必須ボーン欠落: ${b}`);
  }
  for (const e of REQUIRED_EXPRESSIONS) {
    check(r.expressions.includes(e), `表情欠落: ${e}`);
  }
  check(r.lookAt === 'VRMLookAtBoneApplier',
    `lookAt が bone 方式でない: ${r.lookAt}`);
  check(r.blinkDrivesMorphs > 0, 'blink がモーフを動かさない');
  check(r.mtoonMaterials > 0,
    `MToon マテリアルが 0 個: ${r.materialTypes.join(', ')}`);
  check(r.hasThumbnail, 'サムネイルが読み込めない');
  check(r.texturedMaterials > 0, 'テクスチャ付きマテリアルが無い');
  check(r.emissiveMaterials > 0, '発光マテリアルが 1 つも無い');
  check(r.renderedWithoutError, '描画に失敗した');
} catch (err) {
  failures.push(`例外: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error('\nFAIL:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log('\nすべての検査を通過');
