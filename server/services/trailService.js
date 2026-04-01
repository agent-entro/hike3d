/**
 * trailService.js — Trail search orchestrator.
 *
 * searchAndBuild(query, db):
 *   geocode → Overpass search → GeoJSON build → sample points →
 *   fetch elevation → compute stats → insert into DB → return results
 */

import { v4 as uuidv4 } from 'uuid';
import { geocode, searchTrails, buildGeoJSON, extractTaggedNodes } from './osmService.js';
import { fetchElevation } from './elevationService.js';

const MAX_RESULTS = 5;
const SAMPLE_POINTS = 200;  // max elevation sample points per trail

// Haversine distance in meters between two lat/lon pairs
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Sample N evenly-spaced points from a GeoJSON LineString coordinate array.
 *
 * @param {number[][]} coords - Array of [lon, lat] pairs
 * @param {number} maxPoints
 * @returns {{lat: number, lon: number}[]}
 */
function sampleCoordinates(coords, maxPoints) {
  if (coords.length <= maxPoints) {
    return coords.map(([lon, lat]) => ({ lat, lon }));
  }

  const step = (coords.length - 1) / (maxPoints - 1);
  const sampled = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    const [lon, lat] = coords[Math.min(idx, coords.length - 1)];
    sampled.push({ lat, lon });
  }
  return sampled;
}

/**
 * Compute trail statistics from an elevation profile.
 *
 * @param {{lat: number, lon: number, elevation_m: number}[]} elevProfile
 * @returns {{
 *   distance_m: number,
 *   elevation_gain_m: number,
 *   elevation_loss_m: number,
 *   max_elev_m: number,
 *   min_elev_m: number,
 *   difficulty: string
 * }}
 */
export function computeStats(elevProfile) {
  if (!elevProfile.length) {
    return {
      distance_m: 0,
      elevation_gain_m: 0,
      elevation_loss_m: 0,
      max_elev_m: 0,
      min_elev_m: 0,
      difficulty: 'easy',
    };
  }

  let distance_m = 0;
  let elevation_gain_m = 0;
  let elevation_loss_m = 0;
  let max_elev_m = -Infinity;
  let min_elev_m = Infinity;

  for (let i = 0; i < elevProfile.length; i++) {
    const pt = elevProfile[i];
    max_elev_m = Math.max(max_elev_m, pt.elevation_m);
    min_elev_m = Math.min(min_elev_m, pt.elevation_m);

    if (i > 0) {
      const prev = elevProfile[i - 1];
      distance_m += haversine(prev.lat, prev.lon, pt.lat, pt.lon);
      const dElev = pt.elevation_m - prev.elevation_m;
      if (dElev > 0) elevation_gain_m += dElev;
      else elevation_loss_m += Math.abs(dElev);
    }
  }

  // Difficulty: gain per km of distance
  const gainPerKm = distance_m > 0 ? (elevation_gain_m / distance_m) * 1000 : 0;
  let difficulty;
  if (gainPerKm < 100) difficulty = 'easy';
  else if (gainPerKm < 300) difficulty = 'moderate';
  else if (gainPerKm < 600) difficulty = 'hard';
  else difficulty = 'expert';

  return {
    distance_m: Math.round(distance_m),
    elevation_gain_m: Math.round(elevation_gain_m),
    elevation_loss_m: Math.round(elevation_loss_m),
    max_elev_m: max_elev_m === -Infinity ? 0 : Math.round(max_elev_m),
    min_elev_m: min_elev_m === Infinity ? 0 : Math.round(min_elev_m),
    difficulty,
  };
}

/**
 * Extract and insert waypoints from OSM data for a given trail.
 *
 * @param {{relation: Object, ways: Map, nodes: Map}} osmData
 * @param {string} trailId
 * @param {number[][]} coords - Trail coordinates [lon, lat]
 * @param {import('better-sqlite3').Database} db
 */
export function extractWaypoints(osmData, trailId, coords, db) {
  const taggedNodes = extractTaggedNodes(osmData);

  // Add trailhead (first point) and endpoint (last point) if not already present
  const systemWaypoints = [];
  if (coords.length > 0) {
    const [startLon, startLat] = coords[0];
    systemWaypoints.push({
      lat: startLat,
      lon: startLon,
      name: 'Trailhead',
      type: 'trailhead',
      dist_from_start_m: 0,
      tags: {},
    });

    if (coords.length > 1) {
      const [endLon, endLat] = coords[coords.length - 1];
      // Compute distance to endpoint
      let distM = 0;
      for (let i = 1; i < coords.length; i++) {
        distM += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      }
      systemWaypoints.push({
        lat: endLat,
        lon: endLon,
        name: 'Trail End',
        type: 'generic',
        dist_from_start_m: Math.round(distM),
        tags: {},
      });
    }
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO waypoints
      (id, trail_id, session_id, name, type, source, lat, lon, elev_m, dist_from_start_m, notes, created_at)
    VALUES
      (@id, @trail_id, NULL, @name, @type, @source, @lat, @lon, @elev_m, @dist_from_start_m, @notes, @created_at)
  `);

  const insertAll = db.transaction((waypoints) => {
    for (const wp of waypoints) {
      insert.run({
        id: uuidv4(),
        trail_id: trailId,
        name: wp.name,
        type: wp.type,
        source: 'system',
        lat: wp.lat,
        lon: wp.lon,
        elev_m: wp.elev_m ?? null,
        dist_from_start_m: wp.dist_from_start_m ?? null,
        notes: wp.notes ?? null,
        created_at: Date.now(),
      });
    }
  });

  // Compute dist_from_start for tagged OSM nodes
  const allWaypoints = [
    ...systemWaypoints,
    ...taggedNodes.map((n) => ({
      ...n,
      dist_from_start_m: computeDistFromStart(coords, n.lat, n.lon),
      elev_m: null,
    })),
  ];

  insertAll(allWaypoints);
}

/**
 * Find approximate distance from trail start to a given lat/lon (nearest point).
 */
function computeDistFromStart(coords, lat, lon) {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < coords.length; i++) {
    const d = haversine(lat, lon, coords[i][1], coords[i][0]);
    if (d < minDist) { minDist = d; minIdx = i; }
  }
  let distM = 0;
  for (let i = 1; i <= minIdx; i++) {
    distM += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return Math.round(distM);
}

/**
 * Main orchestrator: search for trails matching a query, build full records,
 * persist to DB, and return a list of trail summaries.
 *
 * @param {string} query - User's search query
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<Array>} Array of trail records (up to MAX_RESULTS)
 */
export async function searchAndBuild(query, db) {
  // Step 1: Geocode query → bounding box
  const bbox = await geocode(query);
  if (!bbox) {
    return [];
  }

  // Step 2: Overpass API query for hiking relations
  const osmResults = await searchTrails(bbox, query);
  if (!osmResults.length) {
    return [];
  }

  // Limit to top N results
  const topResults = osmResults.slice(0, MAX_RESULTS);

  const insertTrail = db.prepare(`
    INSERT OR REPLACE INTO trails
      (id, name, source, osm_relation_id, country_code, region, geojson,
       elevation_profile, distance_m, elevation_gain_m, elevation_loss_m,
       max_elev_m, min_elev_m, difficulty, surface, tags, created_at, updated_at)
    VALUES
      (@id, @name, @source, @osm_relation_id, @country_code, @region, @geojson,
       @elevation_profile, @distance_m, @elevation_gain_m, @elevation_loss_m,
       @max_elev_m, @min_elev_m, @difficulty, @surface, @tags, @created_at, @updated_at)
  `);

  const results = [];

  for (const osmData of topResults) {
    try {
      // Step 3: Build GeoJSON
      const feature = buildGeoJSON(osmData);
      if (!feature) continue;

      const coords = feature.geometry.coordinates;
      if (coords.length < 2) continue;

      const props = feature.properties;
      const trailId = uuidv4();

      // Step 4: Sample points for elevation
      const sampledPoints = sampleCoordinates(coords, SAMPLE_POINTS);

      // Step 5: Fetch elevation
      let elevProfile;
      try {
        elevProfile = await fetchElevation(sampledPoints);
      } catch (err) {
        console.warn('[trailService] Elevation fetch failed:', err.message);
        elevProfile = sampledPoints.map((p) => ({ ...p, elevation_m: 0 }));
      }

      // Step 6: Compute stats
      const stats = computeStats(elevProfile);

      // Determine difficulty: OSM tag overrides computed value
      const osmDifficulty = normalizeDifficulty(props.difficulty);
      const difficulty = osmDifficulty ?? stats.difficulty;

      // Step 7: Insert into DB (within transaction)
      const now = Date.now();
      db.transaction(() => {
        insertTrail.run({
          id: trailId,
          name: props.name,
          source: 'osm',
          osm_relation_id: props.osm_relation_id,
          country_code: bbox.country_code ?? null,
          region: null,
          geojson: JSON.stringify(feature),
          elevation_profile: JSON.stringify(elevProfile),
          distance_m: stats.distance_m,
          elevation_gain_m: stats.elevation_gain_m,
          elevation_loss_m: stats.elevation_loss_m,
          max_elev_m: stats.max_elev_m,
          min_elev_m: stats.min_elev_m,
          difficulty,
          surface: props.surface ?? null,
          tags: JSON.stringify(props.tags ?? {}),
          created_at: now,
          updated_at: now,
        });

        // Step 8: Extract waypoints
        extractWaypoints(osmData, trailId, coords, db);
      })();

      results.push({
        id: trailId,
        name: props.name,
        distance_m: stats.distance_m,
        elevation_gain_m: stats.elevation_gain_m,
        elevation_loss_m: stats.elevation_loss_m,
        max_elev_m: stats.max_elev_m,
        min_elev_m: stats.min_elev_m,
        difficulty,
        surface: props.surface ?? null,
        osm_relation_id: props.osm_relation_id,
        elevation_profile: elevProfile,
      });
    } catch (err) {
      console.error('[trailService] Failed to build trail:', err.message);
    }
  }

  return results;
}

/**
 * Normalize OSM trail difficulty tags to our 4-level scale.
 * Returns null if the tag can't be mapped.
 *
 * @param {string|null} osmDifficulty
 * @returns {'easy'|'moderate'|'hard'|'expert'|null}
 */
function normalizeDifficulty(osmDifficulty) {
  if (!osmDifficulty) return null;
  const d = osmDifficulty.toLowerCase();
  if (d.includes('t1') || d.includes('t2') || d === 'hiking') return 'easy';
  if (d.includes('t3') || d === 'mountain_hiking') return 'moderate';
  if (d.includes('t4') || d === 'demanding_mountain_hiking') return 'hard';
  if (d.includes('t5') || d.includes('t6') || d === 'alpine_hiking') return 'expert';
  if (d === '0' || d === '1') return 'easy';
  if (d === '2' || d === '2+') return 'moderate';
  if (d === '3' || d === '3+') return 'hard';
  return null;
}
