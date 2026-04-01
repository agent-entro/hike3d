/**
 * trails.js — Trail search and retrieval routes.
 *
 *   GET /api/trails/search?q=<query>&limit=<n>
 *   GET /api/trails/:id
 */

import { Router } from 'express';
import { searchAndBuild } from '../services/trailService.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Router}
 */
export function trailsRouter(db) {
  const router = Router();

  const getTrailById = db.prepare('SELECT * FROM trails WHERE id = ?');
  const getWaypointsByTrail = db.prepare(
    'SELECT * FROM waypoints WHERE trail_id = ? ORDER BY dist_from_start_m ASC NULLS LAST'
  );

  /**
   * GET /api/trails/search?q=<query>
   *
   * Geocode + Overpass search. Results are cached in SQLite so repeat queries
   * are near-instant. Returns up to 5 trail summaries.
   */
  router.get('/search', async (req, res) => {
    const q = (req.query.q ?? '').trim();
    if (!q) {
      return res.status(400).json({ error: 'Missing query parameter ?q=' });
    }
    if (q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    try {
      const trails = await searchAndBuild(q, db);
      res.json({ trails, query: q });
    } catch (err) {
      console.error('[GET /api/trails/search]', err);

      // Distinguish timeout vs other errors for the client
      if (err.name === 'TimeoutError' || err.message?.includes('timeout')) {
        return res.status(504).json({
          error: 'Search timed out. Try a more specific trail name.',
        });
      }

      res.status(502).json({ error: 'Trail search failed. Please try again.' });
    }
  });

  /**
   * GET /api/trails/:id
   *
   * Returns full trail record including GeoJSON, elevation profile, and waypoints.
   * The trail must already exist in SQLite (created by /search).
   */
  router.get('/:id', (req, res) => {
    const { id } = req.params;

    // Basic UUID format validation
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid trail ID format' });
    }

    try {
      const trail = getTrailById.get(id);
      if (!trail) {
        return res.status(404).json({ error: 'Trail not found' });
      }

      const waypoints = getWaypointsByTrail.all(id);

      // Parse JSON fields before sending
      const response = {
        ...trail,
        geojson: parseJsonField(trail.geojson),
        elevation_profile: parseJsonField(trail.elevation_profile),
        tags: parseJsonField(trail.tags),
        waypoints,
      };

      res.json(response);
    } catch (err) {
      console.error('[GET /api/trails/:id]', err);
      res.status(500).json({ error: 'Failed to retrieve trail' });
    }
  });

  return router;
}

/**
 * Safely parse a JSON string field, returning null on failure.
 * @param {string|null} str
 * @returns {any}
 */
function parseJsonField(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
