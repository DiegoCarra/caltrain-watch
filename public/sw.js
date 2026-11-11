const CACHE = "caltrain-watch-v3";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./core.mjs", "./icon.svg", "./manifest.webmanifest"];
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) => event.waitUntil(
  Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim()
  ])
));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  // Network first: an installed app must not keep serving old JavaScript forever.
  const cacheKey = url.pathname.endsWith("/data/caltrain.json") ? url.origin + url.pathname : event.request;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      throw error;
    }
  }));
});
