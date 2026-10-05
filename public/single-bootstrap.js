(()=>{'use strict';
const c=document.getElementById('camerafeed'),go=document.getElementById('go'),panel=document.getElementById('panel'),status=document.getElementById('status'),prev=document.getElementById('prev'),error=document.getElementById('error'),err=document.getElementById('err');
const KEY='ar-control-b-checkpoint';
const cp=t=>{sessionStorage.setItem(KEY,t);status.textContent=t;console.log('[B]',t)};
const old=sessionStorage.getItem(KEY);prev.textContent=old?'前回: '+old:'前回記録なし';
const fail=e=>{cp('ERROR');err.textContent=e?.stack||e?.message||String(e);error.classList.add('show')};
const xrReady=new Promise(r=>window.XR8?r():window.addEventListener('xrloaded',r,{once:true}));
async function perms(){
  if(typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function'){
    const v=await DeviceMotionEvent.requestPermission(); if(v!=='granted') throw new Error('Motion permission denied');
  }
  if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function'){
    const v=await DeviceOrientationEvent.requestPermission(); if(v!=='granted') throw new Error('Orientation permission denied');
  }
  const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false}); s.getTracks().forEach(t=>t.stop());
}
let loading=false;
async function loadViewer(){
  if(loading)return; loading=true;
  cp('Spark import');
  const m=await import('./single-viewer.js');
  cp('SPZ loading');
  await m.mountSingleSplat(cp);
  cp('SPZ ready');
}
const probe={
  name:'control-b-probe',
  onCameraStatusChange:({status:s})=>{cp('camera:'+s);if(s==='hasVideo')panel.classList.add('hide')},
  listeners:[{event:'reality.trackingstatus',process:({detail})=>{cp('tracking:'+detail.status);if(detail.status==='NORMAL')loadViewer().catch(fail)}}],
  onException:fail
};
go.addEventListener('click',async()=>{
  go.disabled=true;
  try{
    cp('permissions'); await perms();
    cp('Three import'); const THREE=await import('three'); window.THREE=THREE;
    cp('xr.js'); await xrReady; await XR8.loadChunk('slam');
    cp('XR8.run');
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.Threejs.pipelineModule(),
      XR8.XrController.pipelineModule(),
      XRExtras.FullWindowCanvas.pipelineModule(),
      probe
    ]);
    XR8.run({canvas:c});
  }catch(e){go.disabled=false;fail(e)}
});
})();