(() => {
'use strict';
const q=id=>document.getElementById(id);
const canvas=q('camerafeed'),start=q('start'),go=q('go'),boot=q('boot'),status=q('status'),error=q('error'),errorText=q('errorText');
let step='[0] ページ読込',xrRunning=false,tracking=false,startArgs=null,viewer=null,viewerPromise=null,videoSeen=false;
const log=(...a)=>console.log('[BackhoeAR]',...a);
const setStatus=(t,ready=false)=>{status.textContent=t;status.classList.toggle('ready',ready)};
const begin=t=>{step=t;boot.textContent=t;setStatus(t.replace(/^\[\d+\]\s*/,''));log(t)};
const fail=(err,where=step)=>{const e=err instanceof Error?err:new Error(String(err));const d=where+'\n'+e.name+': '+e.message;log('FAIL',d);errorText.textContent=d;error.classList.add('show')};
window.addEventListener('error',e=>fail(e.error||new Error(e.message),step+' / 未捕捉エラー'));
window.addEventListener('unhandledrejection',e=>fail(e.reason||new Error('Unhandled rejection'),step+' / 未処理Promise'));

const xrReady=new Promise(resolve=>{
  if(window.XR8) resolve();
  else window.addEventListener('xrloaded',resolve,{once:true});
});

function requestMotion(){
  const r=[];
  if(typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function') r.push(DeviceMotionEvent.requestPermission());
  if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function') r.push(DeviceOrientationEvent.requestPermission());
  if(!r.length) return Promise.resolve('not-required');
  return Promise.all(r).then(v=>v.every(x=>x==='granted')?'granted':'denied');
}

async function maybeLoadViewer(){
  if(!tracking||!startArgs||viewer||viewerPromise) return;
  begin('[9] SLAM NORMAL → Three/Spark読込');
  viewerPromise=import('./viewer.js').then(async mod=>{
    setStatus('SLAM READY｜3DGS準備中…',true);
    const api=await mod.createBackhoeViewer({
      canvas,startArgs,setStatus,log,
      fatal:(m,e)=>fail(e||new Error(m),m),
      onReady:()=>{document.body.classList.add('ready');setStatus('6/6 READY｜床をタップ',true)}
    });
    viewer=api;
    viewer.onTrackingNormal?.();
    return api;
  }).catch(e=>{viewerPromise=null;fail(e,'[10] Three/Spark / viewer.js読込');throw e});
}

const pipeline={
  name:'backhoe-rig-ar-bootstrap-v012',
  onStart:args=>{
    startArgs=args;
    const {canvasWidth:w,canvasHeight:h}=args;
    if(Number.isFinite(w)&&Number.isFinite(h)&&w>0&&h>0){
      canvas.width=w;canvas.height=h;log('XR8 canvas',w,h);
    }
    setStatus('カメラ起動中…');
    maybeLoadViewer();
  },
  onUpdate:args=>viewer?.onUpdate?.(args),
  onRender:args=>viewer?.onRender?.(args),
  onCanvasSizeChange:args=>{
    const {canvasWidth:w,canvasHeight:h}=args||{};
    if(Number.isFinite(w)&&Number.isFinite(h)&&w>0&&h>0){
      if(canvas.width!==w) canvas.width=w;
      if(canvas.height!==h) canvas.height=h;
      log('XR8 resize',w,h);
    }
    viewer?.onCanvasSizeChange?.(args);
  },
  onCameraStatusChange:({status:s,reason})=>{
    log('camera',s,reason||'');
    if(s==='hasVideo'&&!videoSeen){
      videoSeen=true;
      start.classList.add('hide');
      setStatus('SLAM準備中…');
    }
    if(s==='failed') fail(new Error(reason||'カメラ起動失敗'),'[8] カメラ映像表示');
  },
  onException:e=>fail(e,step+' / 8th Wall内部'),
  listeners:[{
    event:'reality.trackingstatus',
    process:({detail})=>{
      log('tracking',detail.status,detail.reason||'');
      if(detail.status==='NORMAL'){
        tracking=true;
        setStatus('SLAM READY｜viewer準備中…',true);
        maybeLoadViewer();
      }else if(!viewer){
        setStatus('床を探しています…');
      }
    }
  }]
};

go.addEventListener('click',async e=>{
  if(xrRunning) return;
  e.currentTarget.disabled=true;
  begin('[1] AR開始ボタン押下');
  try{
    begin('[2] Motion / Orientation権限要求');
    const motion=await requestMotion();
    if(motion==='denied') throw new Error('モーション / 画面向きの権限が許可されていません');

    begin('[4] Camera権限要求');
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMediaが利用できません');
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
    stream.getTracks().forEach(t=>t.stop());

    begin('[6] 8th Wall初期化');
    await Promise.race([
      xrReady,
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('xr.js timeout 20s')),20000))
    ]);
    await XR8.loadChunk('slam');

    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.XrController.pipelineModule(),
      pipeline
    ]);
    xrRunning=true;
    XR8.run({canvas});
  }catch(err){
    xrRunning=false;
    e.currentTarget.disabled=false;
    fail(err,step);
  }
});
})();