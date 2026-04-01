/**
 * useTrail — hook that fetches full trail data from the API.
 *
 * Accepts a trail summary object (from useSearch) and fetches the full
 * record including GeoJSON, elevation_profile, and waypoints.
 * Computes a bounding box from the GeoJSON for camera fitBounds.
 */

import { useState, useEffect, useRef } from 'react';

/**
 * Compute [west, south, east, north] bounding box from a GeoJSON object.
 * Works with FeatureCollection, Feature, LineString, and MultiLineString.
 * @param {Object} geojson
 * @returns {[number, number, number, number] | null}
 */
function computeBBox(geojson) {
  if (!geojson) return null;

  const coords = [];

  function collectCoords(geometry) {
    if (!geometry) return;
    switch (geometry.type) {
      case 'Point':
        coords.push(geometry.coordinates);
        break;
      case 'LineString':
        coords.push(...geometry.coordinates);
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates) coords.push(...line);
        break;
      case 'Polygon':
        for (const ring of geometry.coordinates) coords.push(...ring);
        break;
      case 'MultiPolygon':
        for (const poly of geometry.coordinates)
          for (const ring of poly) coords.push(...ring);
        break;
      case 'GeometryCollection':
        for (const g of geometry.geometries ?? []) collectCoords(g);
        break;
      default:
        break;
    }
  }

  function walkFeature(feature) {
    if (!feature) return;
    if (feature.type === 'FeatureCollection') {
      for (const f of feature.features ?? []) walkFeature(f);
    } else if (feature.type === 'Feature') {
      collectCoords(feature.geometry);
    } else {
      // Bare geometry
      collectCoords(feature);
    }
  }

  walkFeature(geojson);

  if (coords.length === 0) return null;

  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  return [west, south, east, north];
}

/**
 * Extract flat array of [lon, lat] (or [lon, lat, elev]) positions from GeoJSON.
 * Returns the first LineString/MultiLineString found.
 * @param {Object} geojson
 * @returns {number[][]}
 */
export function extractPath(geojson) {
  if (!geojson) return [];

  function fromGeometry(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'LineString') return geometry.coordinates;
    if (geometry.type === 'MultiLineString') {
      return geometry.coordinates.flat(1);
    }
    return [];
  }

  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features ?? []) {
      const path = fromGeometry(f.geometry);
      if (path.length) return path;
    }
  }
  if (geojson.type === 'Feature') return fromGeometry(geojson.geometry);
  return fromGeometry(geojson);
}

/**
 * @typedef {Object} TrailData
 * @property {string} id
 * @property {string} name
 * @property {Object|null} geojson
 * @property {Array|null} elevation_profile
 * @property {Array} waypoints
 * @property {[number,number,number,number]|null} bbox  [west,south,east,north]
 * @property {number[][]} path  flat [[lon,lat],...] array for deck.gl PathLayer
 */

/**
 * @typedef {Object} UseTrailResult
 * @property {TrailData|null} trail
 * @property {boolean} loading
 * @property {string|null} error
 */

/**
 * Fetch and manage the active trail.
 * @param {{ id: string } | null} trailSummary  — the trail clicked in search results
 * @returns {UseTrailResult}
 */
export function useTrail(trailSummary) {
  const [trail, setTrail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    // Abort any previous in-flight fetch
    if (abortRef.current) abortRef.current.abort();

    if (!trailSummary?.id) {
      setTrail(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/trails/${trailSummary.id}`, {
          signal: controller.signal,
          credentials: 'include',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Trail fetch failed (${res.status})`);
        }

        const data = await res.json();
        const geojson = data.geojson ?? null;

        setTrail({
          ...data,
          geojson,
          bbox: computeBBox(geojson),
          path: extractPath(geojson),
          waypoints: data.waypoints ?? [],
          elevation_profile: data.elevation_profile ?? null,
        });
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return; // stale fetch
        setError(err.message);
        setTrail(null);
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [trailSummary?.id]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { trail, loading, error };
}
