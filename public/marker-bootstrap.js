(() => {
  'use strict';
  const canvas = document.getElementById('camerafeed');
  const go = document.getElementById('go');
  const status = document.getElementById('status');
  const panel = document.getElementById('panel');
  const KEY = 'backhoe-marker-ar-v01';
  const checkpoint = text => {
    status.textContent = text;
    console.log('[marker]', text);
    try { sessionStorage.setItem(KEY, text); } catch {}
  };
  try { document.getElementById('prev').textContent = '前回: ' + (sessionStorage.getItem(KEY) || '記録なし'); } catch {}
  let failed = false;
  const fail = error => {
    failed = true;
    checkpoint('停止');
    document.getElementById('err').textContent = error?.stack || error?.message || String(error);
    document.getElementById('error').classList.add('show');
    window.XR8?.stop();
  };
  window.addEventListener('unhandledrejection', event => fail(event.reason));
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    fail(new Error('描画コンテキストが失われました。再読み込みしてください。'));
  });
  const xrReady = new Promise(resolve => window.XR8 ? resolve() : window.addEventListener('xrloaded', resolve, {once: true}));
  let started = false, controller = null;
  go.addEventListener('click', async () => {
    if (started) return;
    started = true;
    go.disabled = true;
    try {
      checkpoint('権限確認');
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        if (await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('Motion permission denied');
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('Orientation permission denied');
      }
      const THREE = await import('three');
      window.THREE = THREE;
      const {mountMarker} = await import('./marker-viewer.js');
      const response = await fetch('/image-targets/takumi-card.json');
      if (!response.ok) throw new Error('Image target JSON: HTTP ' + response.status);
      const target = await response.json();
      target.imagePath = new URL(target.imagePath, location.origin).href;
      checkpoint('XR8初期化');
      await xrReady;
      await XR8.loadChunk('slam');
      if (!window.XRExtras?.FullWindowCanvas) throw new Error('XRExtras not loaded');
      // Must precede construction of XrController.pipelineModule() and run().
      XR8.XrController.configure({disableWorldTracking: true, imageTargetData: [target]});
      const markerModule = {
        name: 'backhoe-marker-v01',
        onStart: () => {
          // mountMarker executes synchronously up to its return; load is separate
          // so image events are accepted while the SPZ is still loading.
          mountMarker(checkpoint, target.name).then(value => {
            if (failed) return;
            controller = value;
            return value.load();
          }).catch(fail);
        },
        onCameraStatusChange: ({status: cameraStatus}) => {
          if (cameraStatus === 'hasVideo') panel.classList.add('hide');
          if (cameraStatus === 'failed') fail(new Error('Camera startup failed'));
        },
        listeners: [
          {event: 'reality.imagefound', process: event => controller?.update(event)},
          {event: 'reality.imageupdated', process: event => controller?.update(event)},
          {event: 'reality.imagelost', process: event => controller?.lose(event)}
        ],
        onException: fail
      };
      XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        XRExtras.FullWindowCanvas.pipelineModule(),
        markerModule
      ]);
      await XR8.run({canvas, webgl2: true});
    } catch (error) { fail(error); }
  });
})();
