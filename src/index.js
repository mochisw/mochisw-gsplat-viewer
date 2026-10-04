const SPZ_ORIGIN = "https://3dgsrig-ar-v0-1.mochisw.workers.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/")) {
      const upstream = new URL(url.pathname + url.search, SPZ_ORIGIN);
      const upstreamResponse = await fetch(upstream, {
        method: request.method,
        headers: request.headers,
        redirect: "follow"
      });

      const headers = new Headers(upstreamResponse.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers
      });
    }

    return env.ASSETS.fetch(request);
  }
};
