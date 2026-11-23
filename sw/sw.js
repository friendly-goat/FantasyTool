// The app's service worker, built into dist/sw.js by the plugin in vite.config.ts (which fills in
// the version and the list of built files). It keeps the app itself on the device, so opening it
// (from the home screen especially) shows the app at once, even while the server is waking up or
// the phone is offline; the app then shows the data it saved last time (src/saved.ts) and asks
// the server for newer data. API answers are never kept here, except team logos.

const VERSION = "__VERSION__";
/** Every built file (the page and everything under /assets), kept when this version installs. */
const FILES = __FILES__;
const APP_CACHE = `app-${VERSION}`;
const LOGO_CACHE = "logos";
/** App caches kept besides this version's, for a page still open on an older version. */
const KEEP_OLDER = 1;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Versions are named by build time, so the newest sort last.
      const apps = (await caches.keys()).filter((name) => name.startsWith("app-") && name !== APP_CACHE).sort();
      await Promise.all(apps.slice(0, Math.max(0, apps.length - KEEP_OLDER)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Opening the app: the kept page at once, without waiting on the network.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("/", { cacheName: APP_CACHE }).then((kept) => kept ?? fetch(request).catch(() => caches.match("/"))),
    );
    return;
  }

  // Built files never change under the same name: kept copies first (any version's).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then((kept) => kept ?? fetch(request)));
    return;
  }

  // Team logos: kept copies first, saved the first time they load.
  if (url.pathname.startsWith("/api/logos/")) {
    event.respondWith(
      caches.open(LOGO_CACHE).then(async (cache) => {
        const kept = await cache.match(request);
        if (kept) return kept;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
  }
  // Everything else (the API above all) goes to the server as usual.
});
