/**
 * osmService.js — Nominatim geocoding + Overpass API trail search + GeoJSON conversion.
 *
 * External APIs (no accounts required):
 *   - Nominatim: https://nominatim.openstreetmap.org (1 req/sec limit)
 *   - Overpass:  https://overpass-api.de/api/interpreter
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'hike3d/0.1 (local-dev prototype)';
const OVERPASS_TIMEOUT_S = 25;

/**
 * Geocode a text query to a bounding box using Nominatim.
 *
 * @param {string} query - Trail name or location (e.g. "Mount Tamalpais")
 * @returns {Promise<{south: number, west: number, north: number, east: number}|null>}
 */
export async function geocode(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '0');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Nominatim error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.length) return null;

  // Nominatim bbox format: [south, north, west, east] (string values)
  const [south, north, west, east] = data[0].boundingbox.map(Number);

  // Expand bbox slightly (0.1°) so trails near the edges are included
  const pad = 0.1;
  return {
    south: south - pad,
    west: west - pad,
    north: north + pad,
    east: east + pad,
    display_name: data[0].display_name,
    country_code: data[0].address?.country_code?.toUpperCase() ?? null,
  };
}

/**
 * Query Overpass API for hiking route relations within a bounding box.
 * Optionally filter by name substring.
 *
 * @param {{south: number, west: number, north: number, east: number}} bbox
 * @param {string} [nameFilter] - Optional name substring to filter results
 * @returns {Promise<Array>} Array of Overpass relation elements with geometry
 */
export async function searchTrails(bbox, nameFilter = '') {
  const { south, west, north, east } = bbox;

  // Use [out:json][bbox:...] shorthand so all queries are implicitly bounded
  const bboxStr = `${south},${west},${north},${east}`;
  const nameCondition = nameFilter
    ? `["name"~"${nameFilter.replace(/['"]/g, '')}",i]`
    : '';

  const query = `
[out:json][timeout:${OVERPASS_TIMEOUT_S}][bbox:${bboxStr}];
(
  relation["route"="hiking"]${nameCondition};
  relation["route"="foot"]${nameCondition};
);
out body;
>;
out skel qt;
`.trim();

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout((OVERPASS_TIMEOUT_S + 5) * 1000),
  });

  if (!res.ok) {
    throw new Error(`Overpass error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return parseOverpassResponse(data.elements ?? []);
}

/**
 * Parse the raw Overpass elements array into structured trail objects.
 * Each trail has its ways and nodes organized for GeoJSON conversion.
 *
 * @param {Array} elements - Raw elements from Overpass response
 * @returns {Array<{relation: Object, ways: Map, nodes: Map}>}
 */
function parseOverpassResponse(elements) {
  const nodes = new Map();   // id -> {lat, lon, tags}
  const ways = new Map();    // id -> {nodes: number[], tags}
  const relations = [];

  for (const el of elements) {
    if (el.type === 'node') {
      nodes.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags ?? {} });
    } else if (el.type === 'way') {
      ways.set(el.id, { nodes: el.nodes ?? [], tags: el.tags ?? {} });
    } else if (el.type === 'relation') {
      relations.push(el);
    }
  }

  return relations.map((rel) => ({ relation: rel, ways, nodes }));
}

/**
 * Convert an OSM relation (hiking route) into a GeoJSON LineString feature.
 * Stitches member ways together into a continuous path.
 *
 * @param {{relation: Object, ways: Map, nodes: Map}} osmData
 * @returns {{type: 'Feature', geometry: {type: 'LineString', coordinates: number[][]}, properties: Object}|null}
 */
export function buildGeoJSON(osmData) {
  const { relation, ways, nodes } = osmData;
  const tags = relation.tags ?? {};

  // Collect way members (skip route markers/stops — only 'route' and '' roles)
  const wayMembers = (relation.members ?? []).filter(
    (m) => m.type === 'way' && (m.role === '' || m.role === 'route' || m.role === 'forward' || m.role === 'backward')
  );

  if (!wayMembers.length) return null;

  // Build raw segments: each segment is an array of [lon, lat] coordinate pairs
  const segments = [];
  for (const member of wayMembers) {
    const way = ways.get(member.ref);
    if (!way) continue;

    const coords = way.nodes
      .map((nid) => nodes.get(nid))
      .filter(Boolean)
      .map((n) => [n.lon, n.lat]);

    if (coords.length < 2) continue;

    // Reverse segment if member role is 'backward'
    if (member.role === 'backward') coords.reverse();

    segments.push(coords);
  }

  if (!segments.length) return null;

  // Stitch segments into a continuous LineString
  const stitched = stitchSegments(segments);

  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: stitched,
    },
    properties: {
      osm_relation_id: String(relation.id),
      name: tags.name ?? 'Unnamed Trail',
      network: tags.network ?? null,
      distance: tags.distance ?? null,
      surface: tags.surface ?? null,
      difficulty: tags.sac_scale ?? tags.mtb_scale ?? null,
      description: tags.description ?? null,
      operator: tags.operator ?? null,
      country: tags['addr:country'] ?? null,
      tags,
    },
  };
}

/**
 * Greedy algorithm to stitch way segments into a continuous path.
 * Tries to connect segment endpoints, reversing segments as needed.
 *
 * @param {number[][][]} segments - Array of coordinate arrays
 * @returns {number[][]} Single flat array of [lon, lat] coordinates
 */
function stitchSegments(segments) {
  if (!segments.length) return [];
  if (segments.length === 1) return segments[0];

  const result = [...segments[0]];
  const remaining = segments.slice(1).map((s) => ({ coords: s, used: false }));

  const SNAP_THRESHOLD = 0.001; // ~100m in degrees

  for (let pass = 0; pass < remaining.length; pass++) {
    const tailEnd = result[result.length - 1];
    const tailStart = result[0];
    let bestMatch = null;
    let bestDist = Infinity;
    let bestMode = null;

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].used) continue;
      const seg = remaining[i].coords;
      const segStart = seg[0];
      const segEnd = seg[seg.length - 1];

      // Try all four connection modes
      const modes = [
        { dist: dist2(tailEnd, segStart), mode: 'append-forward', idx: i },
        { dist: dist2(tailEnd, segEnd), mode: 'append-reverse', idx: i },
        { dist: dist2(tailStart, segEnd), mode: 'prepend-forward', idx: i },
        { dist: dist2(tailStart, segStart), mode: 'prepend-reverse', idx: i },
      ];

      for (const m of modes) {
        if (m.dist < bestDist) {
          bestDist = m.dist;
          bestMatch = i;
          bestMode = m.mode;
        }
      }
    }

    if (bestMatch === null || bestDist > SNAP_THRESHOLD) {
      // Gap too large — just append with a small gap accepted
      if (bestMatch === null) break;
    }

    const seg = remaining[bestMatch].coords;
    remaining[bestMatch].used = true;

    if (bestMode === 'append-forward') {
      result.push(...seg.slice(1));
    } else if (bestMode === 'append-reverse') {
      result.push(...[...seg].reverse().slice(1));
    } else if (bestMode === 'prepend-forward') {
      result.unshift(...seg.slice(0, -1));
    } else if (bestMode === 'prepend-reverse') {
      result.unshift(...[...seg].reverse().slice(0, -1));
    }
  }

  return result;
}

/**
 * Squared distance between two [lon, lat] points (good enough for snapping comparison).
 */
function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * Extract named/typed nodes from an OSM relation for use as waypoints.
 * Returns nodes that have useful tags (name, tourism, natural, amenity, etc.)
 *
 * @param {{relation: Object, ways: Map, nodes: Map}} osmData
 * @returns {Array<{lat: number, lon: number, name: string, type: string, tags: Object}>}
 */
export function extractTaggedNodes(osmData) {
  const { relation, nodes } = osmData;
  const waypoints = [];

  for (const member of relation.members ?? []) {
    if (member.type !== 'node') continue;
    const node = nodes.get(member.ref);
    if (!node) continue;
    if (!Object.keys(node.tags).length) continue;

    const tags = node.tags;
    const name = tags.name ?? tags['name:en'] ?? null;
    const type = classifyNode(tags);

    if (!name && type === 'generic') continue; // skip uninteresting unnamed nodes

    waypoints.push({
      lat: node.lat,
      lon: node.lon,
      name: name ?? type,
      type,
      tags,
    });
  }

  return waypoints;
}

/**
 * Classify an OSM node into a waypoint type based on its tags.
 */
function classifyNode(tags) {
  if (tags.natural === 'peak' || tags.peak) return 'summit';
  if (tags.tourism === 'camp_site' || tags.tourism === 'wilderness_hut') return 'shelter';
  if (tags.amenity === 'drinking_water' || tags.natural === 'spring') return 'water';
  if (tags.highway === 'trailhead' || tags.trailhead) return 'trailhead';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  return 'generic';
}
