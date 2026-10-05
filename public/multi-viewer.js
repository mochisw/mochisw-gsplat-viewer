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

async function loadSplat(url,checkpoint,label,index){
  checkpoint('fetch '+index+'/6: '+label);
  const response=await fetch(url,{cache:'no-store'});
  checkpoint('HTTP '+response.status+': '+label);
  if(!response.ok) throw new Error(label+' HTTP '+response.status);

  const buffer=await response.arrayBuffer();
  checkpoint(label+' bytes: '+buffer.byteLength);
  if(buffer.byteLength<64) throw new Error(label+' asset too small: '+buffer.byteLength+' bytes');

  return new Promise((resolve,reject)=>{
    let settled=false;
    const timeout=setTimeout(()=>{
      if(settled)return;
      settled=true;
      reject(new Error(label+' decode timeout 30s'));
    },30000);

    checkpoint('decode '+index+'/6: '+label);
    const mesh=new SplatMesh({
      fileBytes:new Uint8Array(buffer),
      fileName:label+'.spz',
      onProgress:e=>{
        if(e?.total>0){
          const pct=Math.round((e.loaded/e.total)*100);
          if(pct===25||pct===50||pct===75) checkpoint('decode '+label+': '+pct+'%');
        }
      },
      onLoad:()=>{
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        checkpoint('loaded '+index+'/6: '+label);
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
  root.visible=false;
  scene.add(root);

  const showBtn=document.getElementById('showModel');
  const recenterBtn=document.getElementById('recenter');
  const groundBtn=document.getElementById('ground');
  let groundMesh=null;

  const placeInFront=()=>{
    const forward=new THREE.Vector3(0,-0.35,-2.0).applyQuaternion(camera.quaternion);
    root.position.copy(camera.position).add(forward);
    root.quaternion.identity();
    root.visible=true;
    checkpoint('model visible');
  };

  showBtn?.addEventListener('click',placeInFront);
  recenterBtn?.addEventListener('click',placeInFront);
  groundBtn?.addEventListener('click',()=>{
    if(!groundMesh)return;
    groundMesh.visible=!groundMesh.visible;
    groundBtn.textContent='地面 '+(groundMesh.visible?'ON':'OFF');
    groundBtn.classList.toggle('on',groundMesh.visible);
  });

  // Split-v3 SPZs retain the original scan coordinate system,
  // so zero local transforms reconstruct the static machine.
  for(let i=0;i<PARTS.length;i++){
    const [label,url]=PARTS[i];
    checkpoint('loading '+(i+1)+'/6: '+label);
    const mesh=await loadSplat(url,checkpoint,label,i+1);
    if(label==='ground') groundMesh=mesh;
    root.add(mesh);
  }

  checkpoint('6/6 static ready');
  showBtn.disabled=false;
  recenterBtn.disabled=false;
  groundBtn.disabled=false;
  document.body.classList.add('ready');
}