import * as THREE from 'three';
import {SparkRenderer} from '@sparkjsdev/spark';

export async function mountSparkOnly(checkpoint){
  const {scene,camera,renderer}=XR8.Threejs.xrScene();
  checkpoint('SparkRenderer create');
  const spark=new SparkRenderer({renderer});
  scene.add(spark);
  checkpoint('SparkRenderer ready');

  const marker=new THREE.Mesh(
    new THREE.BoxGeometry(0.12,0.12,0.12),
    new THREE.MeshBasicMaterial({color:0x67e298})
  );
  const forward=new THREE.Vector3(0,0,-1.0).applyQuaternion(camera.quaternion);
  marker.position.copy(camera.position).add(forward);
  scene.add(marker);
  checkpoint('Three marker ready');
}