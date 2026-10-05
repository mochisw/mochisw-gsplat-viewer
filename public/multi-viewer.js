import * as THREE from 'three';
import {SparkRenderer,SplatMesh} from '@sparkjsdev/spark';

const PARTS=[
  ['ground','/assets/01_ground.spz'],
  ['lower','/assets/02_lower.spz'],
  ['upper','/assets/03_upper.spz'],
  ['boom','/assets/04_boom.spz'],
  ['arm','/assets/05_arm.spz'],
  ['bucket','/assets/06_bucket.spz'],
];

function loadSplat(url,checkpoint,label){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timeout=setTimeout(()=>{
      if(settled)return;
      settled=true;
      reject(new Error(label+' load timeout 20s'));
    },20000);

    const mesh=new SplatMesh({
      url,
      onLoad:()=>{
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        checkpoint('loaded: '+label);
        resolve(mesh);
      }
    });
  });
}

export async function mountSixStatic(checkpoint){
  const {scene,camera,renderer}=XR8.Threejs.xrScene();

  checkpoint('SparkRenderer create');
  const spark=new SparkRenderer({renderer});
  scene.add(spark);
  checkpoint('SparkRenderer ready');

  const root=new THREE.Group();
  root.scale.setScalar(0.23);
  scene.add(root);

  // Split-v3 SPZs retain the original scan coordinate system,
  // so zero local transforms reconstruct the static machine.
  for(let i=0;i<PARTS.length;i++){
    const [label,url]=PARTS[i];
    checkpoint('loading '+(i+1)+'/6: '+label);
    const mesh=await loadSplat(url,checkpoint,label);
    root.add(mesh);
  }

  // Place the reconstructed static set in front of the current AR camera.
  const forward=new THREE.Vector3(0,-0.35,-2.0).applyQuaternion(camera.quaternion);
  root.position.copy(camera.position).add(forward);

  checkpoint('6/6 static ready');
}