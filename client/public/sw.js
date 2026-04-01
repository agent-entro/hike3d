/**
 * hike3d Service Worker — offline tile caching.
 *
 * CACHE_NAME is a placeholder replaced at build time by the sw-hash-inject
 * Vite plugin (vite.config.js). In development the plugin's dev-server
 * middleware serves this file with the hash already substituted, so the
 * literal string '__VITE_BUILD_HASH__' never reaches the browser.
 *
 * Cache strategy: cache-first for map tiles (immutable at a given URL),
 * network-only for everything else.
 */

const CACHE_NAME = `hike3d-tiles-__VITE_BUILD_HASH__`;

/** Map tile hostnames we want to cache. */
const TILE_HOSTS = new Set([
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'elevation-tiles-prod.s3.amazonaws.com',
]);

// ---------------------------------------------------------------------------
// Install — skip waiting so new SW activates immediately on next reload
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activate — delete every cache that doesn't match the current version name
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => {
            console.log(`[SW] Deleting stale cache: ${n}`);
            return caches.delete(n);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — cache-first for tiles, pass-through for everything else
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return; // malformed URL, don't intercept
  }

  if (!TILE_HOSTS.has(url.hostname)) return; // not a tile request

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        if (!response.ok) return response;

        // Clone before consuming — a Response body can only be read once
        const toCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
        return response;
      });
    })
  );
});
