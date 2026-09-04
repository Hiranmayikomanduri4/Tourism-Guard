const CACHE = "tourism-guardian-v5";
const OFFLINE_HTML = "/index.html";

async function putBoth(cache, url, response) {
  try {
    await cache.put(url, response.clone());
    const u = new URL(url, self.location.origin);
    if (u.origin === self.location.origin && (u.search || u.hash)) {
      u.search = "";
      u.hash = "";
      await cache.put(u.href, response.clone());
    }
  } catch (_) {}
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch("/", { cache: "no-store" });
    if (!response.ok) return;
    await putBoth(cache, "/", response);
    await putBoth(cache, "/index.html", response);

    const html = await response.clone().text();
    const urls = new Set([
      "/",
      "/index.html",
      "/manifest.webmanifest",
      "/sw.js"
    ]);
    const re = /(?:src|href)=["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(html))) {
      try {
        const u = new URL(match[1], self.location.origin);
        if (u.origin === self.location.origin) urls.add(u.href);
      } catch (_) {}
    }

    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) await putBoth(cache, url, r);
      } catch (_) {}
    }
  } catch (_) {}
}

self.addEventListener("install", event => {
  event.waitUntil(cacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data?.type !== "CACHE_OFFLINE") return;

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cacheAppShell();

    const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
    for (const raw of urls) {
      try {
        const u = new URL(raw, self.location.origin);
        if (u.origin !== self.location.origin) continue;
        const r = await fetch(u.href, { cache: "no-store" });
        if (r.ok) await putBoth(cache, u.href, r);
      } catch (_) {}
    }

    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "OFFLINE_READY" });
    }
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Exact request first, then clean URL without query parameters.
    const exact = await cache.match(request);
    if (exact) return exact;

    const clean = new URL(request.url);
    clean.search = "";
    clean.hash = "";
    const cleanCached = await cache.match(clean.href);
    if (cleanCached) return cleanCached;

    try {
      const response = await fetch(request);
      if (response.ok) {
        // Cache same-origin app resources so later visits can work offline.
        await putBoth(cache, request.url, response.clone());
      }
      return response;
    } catch (_) {
      if (request.mode === "navigate") {
        return (await cache.match(OFFLINE_HTML)) || (await cache.match("/"));
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
