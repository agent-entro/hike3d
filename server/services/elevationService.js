/**
 * elevationService.js — Fetch and cache elevation data from OpenTopoData.
 *
 * Features:
 *   - Batch fetching: splits points into 100-pt chunks, respects API limits
 *   - In-memory LRU cache: up to 1000 individual lat/lon lookups
 *   - SQLite trail cache: stores complete elevation profiles to avoid re-fetching
 *
 * External API: https://api.opentopodata.org/v1/srtm30m (no key needed)
 */

const OPENTOPODATA_URL = 'https://api.opentopodata.org/v1/srtm30m';
const BATCH_SIZE = 100;      // API max
const LRU_MAX_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// --- In-memory LRU cache (Map preserves insertion order) ---

/** @type {Map<string, number>} key → elevation_m */
const lruCache = new Map();

/**
 * Get a cached elevation value.
 * @param {number} lat
 * @param {number} lon
 * @returns {number|undefined}
 */
function lruGet(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (!lruCache.has(key)) return undefined;
  // Move to end (most recently used)
  const val = lruCache.get(key);
  lruCache.delete(key);
  lruCache.set(key, val);
  return val;
}

/**
 * Store an elevation value in the LRU cache.
 * @param {number} lat
 * @param {number} lon
 * @param {number} elevM
 */
function lruSet(lat, lon, elevM) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (lruCache.has(key)) lruCache.delete(key);
  if (lruCache.size >= LRU_MAX_SIZE) {
    // Evict oldest entry (first in Map)
    lruCache.delete(lruCache.keys().next().value);
  }
  lruCache.set(key, elevM);
}

// --- OpenTopoData API ---

/**
 * Fetch elevation for a single batch of ≤100 points from OpenTopoData.
 *
 * @param {{lat: number, lon: number}[]} points
 * @returns {Promise<{lat: number, lon: number, elevation_m: number}[]>}
 */
async function fetchBatch(points) {
  const locationStr = points.map((p) => `${p.lat},${p.lon}`).join('|');
  const url = `${OPENTOPODATA_URL}?locations=${encodeURIComponent(locationStr)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'hike3d/0.1 (local-dev prototype)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`OpenTopoData error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (data.status !== 'OK') {
    throw new Error(`OpenTopoData status: ${data.status}`);
  }

  return (data.results ?? []).map((r, i) => ({
    lat: points[i].lat,
    lon: points[i].lon,
    elevation_m: typeof r.elevation === 'number' ? r.elevation : 0,
  }));
}

/**
 * Fetch elevations for an array of points, using the LRU cache when possible.
 * Points are batched into chunks of 100 and fetched sequentially with a small
 * delay to be polite to the free API.
 *
 * @param {{lat: number, lon: number}[]} points
 * @returns {Promise<{lat: number, lon: number, elevation_m: number}[]>}
 */
export async function fetchElevation(points) {
  if (!points.length) return [];

  const results = new Array(points.length);
  const toFetch = [];  // {index, lat, lon}

  // Check LRU cache first
  for (let i = 0; i < points.length; i++) {
    const cached = lruGet(points[i].lat, points[i].lon);
    if (cached !== undefined) {
      results[i] = { lat: points[i].lat, lon: points[i].lon, elevation_m: cached };
    } else {
      toFetch.push({ index: i, ...points[i] });
    }
  }

  // Fetch uncached points in batches
  for (let start = 0; start < toFetch.length; start += BATCH_SIZE) {
    const batch = toFetch.slice(start, start + BATCH_SIZE);
    const batchPoints = batch.map(({ lat, lon }) => ({ lat, lon }));

    let batchResults;
    try {
      batchResults = await fetchBatch(batchPoints);
    } catch (err) {
      console.warn('[elevationService] Batch fetch failed, using 0m fallback:', err.message);
      batchResults = batchPoints.map((p) => ({ ...p, elevation_m: 0 }));
    }

    for (let j = 0; j < batch.length; j++) {
      const { index } = batch[j];
      const result = batchResults[j] ?? { lat: batch[j].lat, lon: batch[j].lon, elevation_m: 0 };
      results[index] = result;
      lruSet(result.lat, result.lon, result.elevation_m);
    }

    // Be polite: small delay between batches (except last)
    if (start + BATCH_SIZE < toFetch.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return results;
}

// --- SQLite elevation profile cache ---

/**
 * Check if a trail's elevation profile is already cached in SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} trailId
 * @returns {{lat: number, lon: number, elevation_m: number}[]|null}
 */
export function getCachedElevationProfile(db, trailId) {
  const row = db.prepare('SELECT elevation_profile FROM trails WHERE id = ?').get(trailId);
  if (!row?.elevation_profile) return null;
  try {
    return JSON.parse(row.elevation_profile);
  } catch {
    return null;
  }
}

/**
 * Store an elevation profile in the trails table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} trailId
 * @param {{lat: number, lon: number, elevation_m: number}[]} profile
 */
export function saveElevationProfile(db, trailId, profile) {
  db.prepare('UPDATE trails SET elevation_profile = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(profile),
    Date.now(),
    trailId
  );
}

/**
 * Expose LRU cache size for testing.
 * @returns {number}
 */
export function getLruCacheSize() {
  return lruCache.size;
}

/**
 * Clear the in-memory LRU cache (for testing).
 */
export function clearLruCache() {
  lruCache.clear();
}
