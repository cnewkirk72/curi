// Curi service worker.
//
// Scope: hand-rolled (no Workbox). Goals for MVP:
//   1. Make the app installable — a live, non-error SW is the
//      baseline Chrome demands for the "Add to Home Screen" prompt.
//   2. Keep hero images available on flaky subway wifi via a
//      stale-while-revalidate cache.
//   3. Never cache HTML, auth, Supabase, or _next/data routes —
//      those must stay network-first so a signed-in user never
//      sees a stale page after signing out, and the feed is never
//      more than one request out of date.
//   4. Provide a minimal offline fallback for navigation requests
//      when the network is fully dead.
//
// Caching strategies by request type:
//   navigation (HTML)        → network-only, fall back to /offline
//   /_next/static/*          → cache-first (immutable, build-hashed)
//   /_next/data/*            → network-only (RSC payloads)
//   /api/* / supabase.co     → network-only
//   image hosts + /icon-*    → stale-while-revalidate
//   everything else          → network-first with cache fallback
//
// Version bump the cache names whenever the asset shape changes so
// clients evict stale caches on activate. `self.skipWaiting()` +
// `clients.claim()` let a new SW take over without a full reload.

const VERSION = 'v1';
const STATIC_CACHE = `curi-static-${VERSION}`;
const IMAGE_CACHE = `curi-images-${VERSION}`;
const RUNTIME_CACHE = `curi-runtime-${VERSION}`;
const KNOWN_CACHES = new Set([STATIC_CACHE, IMAGE_CACHE, RUNTIME_CACHE]);

// Pre-cache the offline fallback + manifest + app icons on install.
// Everything else is populated on first real use. Keep this list
// minimal — a long precache is a big install tax and invalidates
// on every deploy.
const PRECACHE_URLS = [
  '/offline',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Claim installation before the old SW finishes running, so users
  // get the new assets on next navigation rather than next tab.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch(() => {
        // If any precache URL 404s (common on first deploy before
        // /offline exists), don't abort the whole install — the SW
        // can still be useful for runtime caching.
      }),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !KNOWN_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// ── routing ────────────────────────────────────────────────────────

function isImageRequest(request, url) {
  if (request.destination === 'image') return true;
  // Covers our own hashed icon variants.
  return /\.(png|jpg|jpeg|webp|gif|svg|avif)$/i.test(url.pathname);
}

function isStaticAsset(url) {
  // Build-hashed files under _next/static are content-addressed, so
  // cache-first is always safe.
  return url.pathname.startsWith('/_next/static/');
}

function isNetworkOnly(url) {
  // RSC payloads — must always be fresh so client nav reflects the
  // latest server state.
  if (url.pathname.startsWith('/_next/data/')) return true;
  if (url.pathname.startsWith('/api/')) return true;
  if (url.pathname.startsWith('/auth/')) return true;
  // Any Supabase call — auth + RLS-gated data lives here.
  if (url.hostname.endsWith('.supabase.co')) return true;
  return false;
}

// ── strategies ─────────────────────────────────────────────────────

async function networkOnly(request) {
  return fetch(request);
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network || Promise.reject(new Error('swr miss'));
}

async function networkWithCacheFallback(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match('/offline');
    if (offline) return offline;
    // Last-resort inline response so the user doesn't see the
    // browser's error page. Kept ultra-minimal — the real /offline
    // route picks up styling from the cached app shell.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline — Curi</title><style>body{background:#05070D;color:#fafafa;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}</style><main><h1 style="font-weight:600">You\'re offline.</h1><p style="color:#9ca3af">We\'ll re-fetch the feed as soon as you\'re back on.</p></main>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

// ── fetch handler ─────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // SW only handles same-origin GETs — cross-origin POSTs (OAuth)
  // and non-GET mutations pass through untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isNetworkOnly(url)) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (isImageRequest(request, url)) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  event.respondWith(networkWithCacheFallback(request, RUNTIME_CACHE));
});

// Allow the page to proactively skip the waiting state — useful
// when we ship a fix and want the next nav to pick it up.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
