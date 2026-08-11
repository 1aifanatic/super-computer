/**
 * Service worker for Super.
 *
 * Three rules, in priority order:
 *
 *  1. Never touch /api/*. Caching an agent's state, spend total or turn history
 *     would show stale data that looks live, which is worse than being offline.
 *     WebSockets bypass the worker entirely.
 *  2. Build assets under /assets/* are content-hashed and therefore immutable,
 *     so they are cache-first. A new build produces new filenames.
 *  3. Navigations are network-first with a cached shell as the fallback, so a
 *     deploy is picked up immediately rather than after a hard refresh -- the
 *     usual PWA complaint.
 */
// Bump on any change to this file's strategy. Old caches are purged on activate.
const VERSION = "super-v2";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(["/", "/icon.svg", "/manifest.webmanifest"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // rule 1

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? new Response("Offline", { status: 503 }))),
    );
    return;
  }

  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
