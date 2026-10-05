const SIZE = 8222670;
const PARTS = 16;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/assets/backhoe.spz') return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status: 405});
    const headers = {'Content-Type': 'application/octet-stream', 'Content-Length': String(SIZE), 'Cache-Control': 'public, max-age=86400'};
    if (request.method === 'HEAD') return new Response(null, {headers});
    // One SPZ response; storage chunks are concatenated without modifying bytes.
    let index = 0, reader = null;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            if (!reader) {
              if (index === PARTS) { controller.close(); return; }
              const partUrl = new URL('/assets/backhoe.part-' + String(index++).padStart(2, '0'), url.origin);
              const part = await env.ASSETS.fetch(new Request(partUrl));
              if (!part.ok || !part.body) throw new Error('Missing SPZ part');
              reader = part.body.getReader();
            }
            const {done, value} = await reader.read();
            if (done) { reader.releaseLock(); reader = null; continue; }
            controller.enqueue(value); return;
          }
        } catch (error) { controller.error(error); }
      },
      async cancel(reason) { if (reader) await reader.cancel(reason); }
    });
    return new Response(stream, {headers});
  }
};
