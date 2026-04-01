/**
 * tiles.js — Tile proxy with filesystem cache.
 *
 *   GET /tiles/terrain/:z/:x/:y  — terrain-RGB tiles from AWS S3
 *   GET /tiles/satellite/:z/:x/:y — OSM raster tiles
 *
 * Cache stored at: cache/tiles/{type}/{z}/{x}/{y}.png
 * Response includes Cache-Control: max-age=86400
 */

import { Router } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// Upstream tile sources
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SATELLITE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Cache directory default (relative to project root)
const DEFAULT_CACHE_BASE = path.resolve(process.cwd(), 'cache', 'tiles');

/** @param {string} template @param {string} z @param {string} x @param {string} y */
function buildUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/**
 * Resolve filesystem cache path for a tile.
 * @param {string} cacheBase
 */
function cachePath(cacheBase, type, z, x, y) {
  return path.join(cacheBase, type, String(z), String(x), `${y}.png`);
}

/**
 * Validate tile coordinates:
 *  - z: 0–20 integer
 *  - x, y: 0 to 2^z − 1
 * @returns {boolean}
 */
function validCoords(z, x, y) {
  const zi = parseInt(z, 10);
  const xi = parseInt(x, 10);
  const yi = parseInt(y, 10);
  if (isNaN(zi) || isNaN(xi) || isNaN(yi)) return false;
  if (zi < 0 || zi > 20) return false;
  const maxTile = Math.pow(2, zi);
  if (xi < 0 || xi >= maxTile) return false;
  if (yi < 0 || yi >= maxTile) return false;
  return true;
}

/**
 * Fetch a tile from an upstream URL and return the raw Buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function fetchUpstream(url) {
  const res = await fetch(url, {
    headers: {
      // OSM tile policy requires a user-agent
      'User-Agent': 'hike3d/0.1.0 (local dev prototype)',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Upstream tile fetch failed: ${res.status} ${url}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Serve a tile: hit cache → hit upstream → cache → respond.
 * @param {'terrain'|'satellite'} type
 * @param {string} upstream  URL template
 * @param {string} cacheBase  Base directory for tile cache
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function serveTile(type, upstream, cacheBase, req, res) {
  const { z, x, y } = req.params;

  if (!validCoords(z, x, y)) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  const filePath = cachePath(cacheBase, type, z, x, y);

  try {
    // Cache hit — stream the file directly
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Tile-Cache', 'HIT');
      return fs.createReadStream(filePath).pipe(res);
    }

    // Cache miss — fetch from upstream
    const buf = await fetchUpstream(buildUrl(upstream, z, x, y));

    // Persist to cache (create directories as needed)
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, buf);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Tile-Cache', 'MISS');
    res.end(buf);
  } catch (err) {
    console.error(`[tiles/${type}] ${z}/${x}/${y} error:`, err.message);
    // If upstream failed but we somehow have a corrupt partial file, clean it up
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath).catch(() => {});
    }
    res.status(502).json({ error: 'Tile fetch failed', detail: err.message });
  }
}

/**
 * @param {{ cacheBase?: string }} [options]
 * @returns {Router}
 */
export function tilesRouter({ cacheBase = DEFAULT_CACHE_BASE } = {}) {
  const router = Router();

  router.get('/terrain/:z/:x/:y', (req, res) =>
    serveTile('terrain', TERRAIN_URL, cacheBase, req, res)
  );

  router.get('/satellite/:z/:x/:y', (req, res) =>
    serveTile('satellite', SATELLITE_URL, cacheBase, req, res)
  );

  return router;
}
