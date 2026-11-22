/*
 * Musiccus service worker: makes the app installable and usable offline.
 * The whole build is stored on install. Hashed build assets and the
 * versioned ONNX Runtime files never change, so they are served from cache;
 * pages and unhashed files try the network first so updates arrive.
 * The AI model has its own cache (musiccus-models-*) and is never touched here.
 *
 * This is a template: vite.config.ts writes it to dist/sw.js with the build's
 * version stamped into the SHELL cache name. Every deploy therefore changes
 * this file, so browsers install the new worker, store the new build and drop
 * the old one.
 */
const SHELL = 'musiccus-shell-__BUILD__';
// ONNX Runtime files are versioned in their URL and 28.7 MB, so they live in
// their own cache that survives app updates.
const RUNTIME = 'musiccus-runtime';

// precache.json lists every file of the build (written by vite.config.ts), so
// the first install stores the whole app, including what that first visit
// loaded before this worker took control.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      try {
        const files = await fetch('./precache.json', { cache: 'no-store' }).then((r) => r.json());
        await cache.addAll(files.map((f) => (f.startsWith('./') ? f : `./${f}`)));
      } catch {
        await cache.addAll(['./', './manifest.webmanifest', './favicon.svg']);
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('musiccus-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Hosts often answer with Vary (Origin, Accept-Encoding); module scripts are
// requested with an Origin header the precache requests did not carry, so
// matching must ignore Vary or nothing precached would ever be found.
const MATCH = { ignoreVary: true };

async function cacheFirst(request, cacheName = SHELL) {
  const hit = await caches.match(request, MATCH);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(cacheName)).put(request, res.clone());
  return res;
}

async function networkFirst(request, fallback) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(SHELL)).put(request, res.clone());
    return res;
  } catch {
    return (await caches.match(request, MATCH)) || (fallback && (await caches.match(fallback, MATCH))) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') event.respondWith(networkFirst(req, './'));
    else if (url.pathname.includes('/assets/')) event.respondWith(cacheFirst(req));
    else event.respondWith(networkFirst(req));
  } else if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/onnxruntime-web@')) {
    event.respondWith(cacheFirst(req, RUNTIME));
  }
});
