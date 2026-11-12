// Serves the page from the cache so it opens offline. The Docker build puts a hash of the page's
// files into CACHE, so a new version installs a fresh cache and the page reloads into it.
// API requests always go to the network; the page keeps its own copy of the entries.
const CACHE = "overtime-__VERSION__";
const FILES = [
  "./",
  "index.js",
  "index.css",
  "web.css",
  "theme.js",
  "manifest.json",
  "icon.png",
  "icon-256.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;
  const cached = request.mode === "navigate" ? caches.match("./") : caches.match(request);
  event.respondWith(cached.then((response) => response ?? fetch(request)));
});
