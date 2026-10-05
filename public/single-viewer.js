import * as THREE from 'three';
import {SparkRenderer,SplatMesh} from '@sparkjsdev/spark';

export async function mountSingleSplat(checkpoint){
  const {scene,camera,renderer}=XR8.Threejs.xrScene();
  checkpoint('SparkRenderer');
  const spark=new SparkRenderer({renderer});
  scene.add(spark);

  const root=new THREE.Group();
  root.scale.setScalar(0.23);
  scene.add(root);

  let resolveLoaded,rejectLoaded;
  const loaded=new Promise((res,rej)=>{resolveLoaded=res;rejectLoaded=rej});
  const splat=new SplatMesh({
    url:'/assets/03_upper.spz',
    onLoad:()=>{checkpoint('SPZ onLoad');resolveLoaded();}
  });
  root.add(splat);

  // Put the single static splat in front of the current AR camera.
  const forward=new THREE.Vector3(0,-0.15,-1.35).applyQuaternion(camera.quaternion);
  root.position.copy(camera.position).add(forward);

  const timeout=setTimeout(()=>rejectLoaded(new Error('SPZ load timeout 20s')),20000);
  try{await loaded}finally{clearTimeout(timeout)}
}