import * as THREE from 'three';
import {SparkRenderer, SplatMesh} from '@sparkjsdev/spark';

export async function mountMarker(checkpoint, targetName) {
  const {scene, renderer} = XR8.Threejs.xrScene();
  const spark = new SparkRenderer({renderer});
  scene.add(spark);
  const markerRoot = new THREE.Group();
  markerRoot.visible = false;
  scene.add(markerRoot);
  const modelRoot = new THREE.Group();
  // Image target lies in XY with its outward normal along +Z.
  // Map the model's +Y up axis to the target's +Z normal.
  modelRoot.rotation.x = Math.PI / 2;
  markerRoot.add(modelRoot);
  const splat = new SplatMesh({url: '/assets/backhoe.spz'});
  modelRoot.add(splat);
  let ready = false, tracked = false, last = null, span = 1;
  const apply = () => {
    if (!last) return;
    markerRoot.position.copy(last.position);
    markerRoot.quaternion.copy(last.rotation);
    markerRoot.scale.setScalar(last.scale);
    // Relative sizing: about 15 cm for an assumed 55 mm card width.
    const localWidth = last.scaledWidth;
    modelRoot.scale.setScalar(localWidth * (150 / 55) / span);
    markerRoot.visible = ready && tracked;
  };
  const update = ({detail}) => {
    if (detail.name !== targetName) return;
    if (!Number.isFinite(detail.scale) || detail.scale <= 0 || !Number.isFinite(detail.scaledWidth)) return;
    last = {...detail, position: {...detail.position}, rotation: {...detail.rotation}};
    const wasTracked = tracked;
    tracked = true;
    apply();
    if (!wasTracked) checkpoint(ready ? '名刺認識・表示' : '名刺認識・SPZ読込中');
  };
  const lose = ({detail}) => {
    if (detail.name !== targetName) return;
    tracked = false;
    markerRoot.visible = false;
    checkpoint('名刺を探しています');
  };
  const load = async () => {
    checkpoint('SPZ読込中');
    await splat.initialized;
    const box = splat.getBoundingBox();
    const size = box.getSize(new THREE.Vector3());
    span = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(span) || span <= 0) throw new Error('Invalid SPZ bounds');
    splat.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    ready = true;
    apply();
    checkpoint(tracked ? '名刺認識・表示' : '準備完了・名刺を映してください');
  };
  return {update, lose, load};
}
