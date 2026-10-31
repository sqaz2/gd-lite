importScripts("/incoming-share.js");
const CACHE_PREFIX = "generative-download-";
const CACHE = CACHE_PREFIX + "v5-incoming-files";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        // Keep one previous app cache for tabs that were already open during a
        // deployment. The new page also has one-shot stale-module recovery.
        const previous = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).at(-1);
        return Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE && key !== previous).map((key) => caches.delete(key)));
      }),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/__native-inbox/") || url.pathname.startsWith("/__shared-inbox/")) return;
  // Private API responses are never cached. Phone model parts use their own
  // hash-verified cache to avoid duplicate 67 MB copies in the app-shell cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/models/phone-stems/")) return;

  // The embedded instrument uses stable module URLs. Refresh them together on
  // each visit; cache-first would pin an old UI/worker after an app update.
  if (url.pathname.startsWith('/instruments/amiga/')) {
    const key = url.origin + url.pathname;
    event.respondWith(fetch(event.request).then(response => {
      if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then(cache => cache.put(key, copy)); }
      return response;
    }).catch(async () => (await caches.match(key)) || Response.error()));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      const clone = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, clone));
    }
    return response;
  })));
});
