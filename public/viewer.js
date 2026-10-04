import * as THREE from 'three';
import {SparkRenderer,SplatMesh} from '@sparkjsdev/spark';

export async function createBackhoeViewer({canvas,startArgs,setStatus,log,fatal,onReady}){
const q=id=>document.getElementById(id);
const action=q('action'),info=q('info'),hint=q('hint'),play=q('play'),replace=q('replace'),ground=q('ground'),jsonInput=q('jsonInput'),touch=q('touch'),touchLabel=touch.querySelector('.label');
let renderer,scene,camera,spark,rigRoot,contentRoot,reticle,groundMesh,cfg;
let joints={},axes={},frames=[],duration=0,loaded=0,ready=false,placed=false,groundVisible=true,playing=false,playStart=0;
let gesture='none',oneStart=null,oneMoved=false,twoDist=0,twoAngle=0,twoScale=1,twoYaw=0,touchRAF=0,pendingTouch=null;
const raycaster=new THREE.Raycaster(),floorPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0),hit=new THREE.Vector3(),ndc=new THREE.Vector2();

const wrap180=v=>((v+180)%360+360)%360-180;
function normalizeAction(data){
  if(data?.format&&data.format!=='backhoe-rig-action-v1') throw new Error('未対応format: '+data.format);
  if(!Array.isArray(data?.frames)||!data.frames.length) throw new Error('frames がありません');
  const names=['turntable','boom','arm','bucket'];
  const out=data.frames.map((f,i)=>{
    const o={t:Number(f.t)};
    if(!Number.isFinite(o.t)) throw new Error('frame '+i+': 不正な時刻');
    for(const n of names){
      const v=Number(f[n]);
      if(!Number.isFinite(v)) throw new Error('frame '+i+': '+n+' が不正');
      const j=cfg.joints[n];
      o[n]=THREE.MathUtils.clamp(v,j.minDeg,j.maxDeg);
    }
    return o;
  }).sort((a,b)=>a.t-b.t);
  const t0=out[0].t;
  out.forEach(f=>f.t=Math.max(0,f.t-t0));
  return out;
}
function setAction(data,name){
  frames=normalizeAction(data);
  duration=frames[frames.length-1].t;
  action.textContent='JSON: '+name;
  applyState(frames[0]);
  updateButtons();
}
function interp(t){
  if(!frames.length) return null;
  if(t<=frames[0].t) return frames[0];
  const last=frames[frames.length-1];
  if(t>=last.t) return last;
  let hi=1;
  while(hi<frames.length&&frames[hi].t<t) hi++;
  const a=frames[hi-1],b=frames[hi],u=(t-a.t)/Math.max(.0001,b.t-a.t),d=wrap180(b.turntable-a.turntable);
  return {t,turntable:wrap180(a.turntable+d*u),boom:THREE.MathUtils.lerp(a.boom,b.boom,u),arm:THREE.MathUtils.lerp(a.arm,b.arm,u),bucket:THREE.MathUtils.lerp(a.bucket,b.bucket,u)};
}
function applyState(s){
  if(!s||!cfg||!Object.keys(joints).length) return;
  for(const n of ['turntable','boom','arm','bucket']){
    let v=Number(s[n]??0);
    if(n==='turntable') v=wrap180(v);
    else v=THREE.MathUtils.clamp(v,cfg.joints[n].minDeg,cfg.joints[n].maxDeg);
    joints[n].quaternion.setFromAxisAngle(axes[n],THREE.MathUtils.degToRad(v));
  }
}
function updateButtons(){
  play.disabled=!(ready&&placed&&frames.length);
  replace.disabled=!(ready&&placed);
  ground.disabled=!ready;
}
function stop(reset=false){
  playing=false;play.classList.remove('playing');play.textContent='▶ 再生';
  if(reset&&frames.length) applyState(frames[0]);
}
function startPlayback(){
  if(!ready||!placed||!frames.length) return;
  playing=true;playStart=performance.now();play.classList.add('playing');play.textContent='■ 停止';
}
function tickPlayback(now){
  if(!playing) return;
  const t=(now-playStart)/1000;
  applyState(interp(Math.min(t,duration)));
  if(t>=duration){playing=false;play.classList.remove('playing');play.textContent='↻ 再生'}
}
play.addEventListener('click',()=>playing?stop(false):startPlayback());
replace.addEventListener('click',()=>{
  stop(true);placed=false;rigRoot.visible=false;hint.style.display='block';setStatus('配置位置を選択',true);updateButtons();
});
ground.addEventListener('click',()=>{
  groundVisible=!groundVisible;if(groundMesh) groundMesh.visible=groundVisible;
  ground.textContent='地面 '+(groundVisible?'ON':'OFF');ground.classList.toggle('on',groundVisible);
});
jsonInput.addEventListener('change',async()=>{
  const f=jsonInput.files?.[0];if(!f)return;
  try{setAction(JSON.parse(await f.text()),f.name)}catch(e){fatal('JSON読込エラー',e)}
  jsonInput.value='';
});

function screenToFloor(x,y,target){
  if(!camera)return false;
  const r=canvas.getBoundingClientRect();
  ndc.x=((x-r.left)/r.width)*2-1;ndc.y=-((y-r.top)/r.height)*2+1;
  raycaster.setFromCamera(ndc,camera);
  if(!raycaster.ray.intersectPlane(floorPlane,target)) return false;
  const d=target.distanceTo(camera.position);
  return Number.isFinite(d)&&d>.08&&d<12;
}
function placeAt(p){
  rigRoot.position.copy(p);rigRoot.visible=true;placed=true;reticle.visible=false;hint.style.display='none';
  setStatus('配置済み｜JSON再生できます',true);updateButtons();
}
function updateReticle(){
  if(!reticle||!ready||placed){if(reticle)reticle.visible=false;return}
  const r=canvas.getBoundingClientRect();
  if(screenToFloor(r.left+r.width/2,r.top+r.height/2,hit)){reticle.position.copy(hit);reticle.position.y+=.004;reticle.visible=true}else reticle.visible=false;
}
function queueTouch(touches){
  if(new URLSearchParams(location.search).get('touchviz')==='0') return;
  if(!touches||!touches.length){pendingTouch=null;touch.classList.remove('show','two');return}
  let x,y,two=false;
  if(touches.length>=2){x=(touches[0].clientX+touches[1].clientX)/2;y=(touches[0].clientY+touches[1].clientY)/2;two=true}
  else{x=touches[0].clientX;y=touches[0].clientY}
  pendingTouch={x,y,two};
  if(touchRAF)return;
  touchRAF=requestAnimationFrame(()=>{
    touchRAF=0;if(!pendingTouch)return;
    touch.classList.toggle('two',pendingTouch.two);
    touchLabel.textContent=pendingTouch.two?'2本指：回転 / 拡大縮小':(placed?'1本指：移動中':'床をタップ');
    touch.style.transform='translate3d('+(pendingTouch.x-34)+'px,'+(pendingTouch.y-34)+'px,0)';
    touch.classList.add('show');
  });
}
function setupTouch(){
  canvas.addEventListener('touchstart',e=>{
    if(!ready)return;queueTouch(e.touches);
    if(e.touches.length>=2&&placed){
      gesture='two';const a=e.touches[0],b=e.touches[1];
      twoDist=Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY);twoAngle=Math.atan2(b.clientY-a.clientY,b.clientX-a.clientX);twoScale=rigRoot.scale.x;twoYaw=rigRoot.rotation.y;e.preventDefault();return;
    }
    if(e.touches.length===1){gesture='one';oneMoved=false;const t=e.touches[0];oneStart={x:t.clientX,y:t.clientY}}
  },{passive:false});
  canvas.addEventListener('touchmove',e=>{
    if(!ready)return;queueTouch(e.touches);
    if(gesture==='two'&&e.touches.length>=2&&placed){
      const a=e.touches[0],b=e.touches[1],d=Math.max(1,Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY)),ang=Math.atan2(b.clientY-a.clientY,b.clientX-a.clientX);
      const s=THREE.MathUtils.clamp(twoScale*d/Math.max(1,twoDist),cfg.ar.minScale,cfg.ar.maxScale);
      rigRoot.scale.setScalar(s);rigRoot.rotation.y=twoYaw-(ang-twoAngle);info.textContent=Math.round(s*100)+'% ｜ 約'+(cfg.ar.sourceMaxDimensionM*s).toFixed(1)+'m';e.preventDefault();return;
    }
    if(gesture==='one'&&e.touches.length===1&&placed){
      const t=e.touches[0];if(oneStart&&Math.hypot(t.clientX-oneStart.x,t.clientY-oneStart.y)>5)oneMoved=true;
      if(screenToFloor(t.clientX,t.clientY,hit))rigRoot.position.copy(hit);e.preventDefault();
    }
  },{passive:false});
  canvas.addEventListener('touchend',e=>{
    queueTouch(e.touches);
    if(gesture==='one'&&!oneMoved&&e.changedTouches.length&&!placed){const t=e.changedTouches[0];if(screenToFloor(t.clientX,t.clientY,hit))placeAt(hit)}
    if(!e.touches.length){gesture='none';oneStart=null;oneMoved=false}else if(e.touches.length===1)gesture='none';
  },{passive:false});
  canvas.addEventListener('touchcancel',()=>{gesture='none';oneStart=null;oneMoved=false;queueTouch(null)},{passive:true});
}

function setupRig(){
  rigRoot=new THREE.Group();rigRoot.visible=false;rigRoot.scale.setScalar(cfg.ar.defaultScale);scene.add(rigRoot);
  contentRoot=new THREE.Group();const [cx,cz]=cfg.ar.centerXZ;contentRoot.position.set(-cx,-cfg.ar.baseY,-cz);rigRoot.add(contentRoot);
  const p0=new THREE.Vector3(...cfg.pivots.turntable),p1=new THREE.Vector3(...cfg.pivots.boom),p2=new THREE.Vector3(...cfg.pivots.arm),p3=new THREE.Vector3(...cfg.pivots.bucket);
  const turn=new THREE.Group();turn.position.copy(p0);contentRoot.add(turn);
  const boomJ=new THREE.Group();boomJ.position.copy(p1).sub(p0);turn.add(boomJ);
  const armJ=new THREE.Group();armJ.position.copy(p2).sub(p1);boomJ.add(armJ);
  const bucketJ=new THREE.Group();bucketJ.position.copy(p3).sub(p2);armJ.add(bucketJ);
  joints={turntable:turn,boom:boomJ,arm:armJ,bucket:bucketJ};
  for(const n of Object.keys(joints))axes[n]=new THREE.Vector3(...cfg.joints[n].axis).normalize();
  return {p0,p1,p2,p3,turn,boomJ,armJ,bucketJ};
}
function addSplat(url,parent,offset,name){
  const m=new SplatMesh({url,onLoad:()=>{
    loaded++;setStatus('3DGSを読み込み中… '+loaded+'/6',true);log('loaded',name,loaded);
    if(loaded===6){ready=true;groundMesh.visible=groundVisible;hint.style.display='block';setStatus('6/6 READY｜床をタップ',true);updateButtons();onReady?.()}
  }});
  m.position.copy(offset);parent.add(m);return m;
}
function initRenderer(){
  const {GLctx,canvasWidth:w,canvasHeight:h}=startArgs;
  renderer=new THREE.WebGLRenderer({canvas,context:GLctx,antialias:false,alpha:true,powerPreference:'high-performance'});
  renderer.autoClear=false;renderer.setPixelRatio(1);renderer.setSize(w,h,false);
  scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(60,w/h,.01,100);camera.matrixAutoUpdate=true;
  spark=new SparkRenderer({renderer});scene.add(spark);
  const g=new THREE.RingGeometry(.065,.080,48),m=new THREE.MeshBasicMaterial({color:0x67e298,side:THREE.DoubleSide,transparent:true,opacity:.9,depthTest:false});
  reticle=new THREE.Mesh(g,m);reticle.rotation.x=-Math.PI/2;reticle.renderOrder=999;reticle.visible=false;scene.add(reticle);
  setupTouch();
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();fatal('WebGL Context Lost。Safariを再読み込みしてください。')},false);
}
async function load(){
  const [cr,sr]=await Promise.all([fetch('./rig_config.json'),fetch('./backhoe_excavation_sample_v1.json')]);
  if(!cr.ok)throw new Error('rig_config.json HTTP '+cr.status);
  if(!sr.ok)throw new Error('sample JSON HTTP '+sr.status);
  cfg=await cr.json();const sample=await sr.json();
  initRenderer();
  const {p0,p1,p2,p3,turn,boomJ,armJ,bucketJ}=setupRig();
  setAction(sample,'掘削サンプル');
  addSplat(cfg.parts.lower,contentRoot,new THREE.Vector3(),'lower');
  addSplat(cfg.parts.upper,turn,p0.clone().multiplyScalar(-1),'upper');
  addSplat(cfg.parts.boom,boomJ,p1.clone().multiplyScalar(-1),'boom');
  addSplat(cfg.parts.arm,armJ,p2.clone().multiplyScalar(-1),'arm');
  addSplat(cfg.parts.bucket,bucketJ,p3.clone().multiplyScalar(-1),'bucket');
  groundMesh=addSplat(cfg.parts.ground,contentRoot,new THREE.Vector3(),'ground');
  applyState(frames[0]);
  const s=cfg.ar.defaultScale;info.textContent=Math.round(s*100)+'% ｜ 約'+(cfg.ar.sourceMaxDimensionM*s).toFixed(1)+'m';
}

function onUpdate({processCpuResult}){
  const r=processCpuResult?.reality;if(!r||!camera)return;
  if(r.intrinsics){for(let i=0;i<16;i++)camera.projectionMatrix.elements[i]=r.intrinsics[i];camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()}
  if(r.rotation)camera.quaternion.set(r.rotation.x,r.rotation.y,r.rotation.z,r.rotation.w);
  if(r.position)camera.position.set(r.position.x,r.position.y,r.position.z);
}
function onRender(){
  if(!renderer||!scene||!camera)return;
  updateReticle();tickPlayback(performance.now());renderer.resetState();renderer.clearDepth();renderer.render(scene,camera);
}
function onCanvasSizeChange({canvasWidth:w,canvasHeight:h}){
  if(!renderer||!camera||!w||!h)return;
  renderer.setSize(w,h,false);camera.aspect=w/h;
}
function onTrackingNormal(){}
await load();
return {onUpdate,onRender,onCanvasSizeChange,onTrackingNormal};
}