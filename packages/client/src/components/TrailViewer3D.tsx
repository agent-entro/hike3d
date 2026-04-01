/**
 * TrailViewer3D.tsx
 *
 * MapLibre GL JS + deck.gl terrain viewer for a single hiking trail.
 * Renders a PathLayer (trail polyline) and IconLayer (waypoints) via a
 * MapboxOverlay that survives dark-mode style swaps.
 *
 * Key fix: after map.setStyle() clears all layers/sources, the deck.gl
 * MapboxOverlay must be re-added on the subsequent 'style.load' event.
 */

import { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, IconLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrailPoint {
  lon: number;
  lat: number;
  elev_m: number;
}

export interface Waypoint {
  id: string;
  name: string;
  type: 'trailhead' | 'summit' | 'water' | 'viewpoint' | 'generic';
  lon: number;
  lat: number;
  elev_m: number;
  notes?: string;
}

export interface TrailViewer3DProps {
  /** Ordered list of trail coordinates */
  trailPoints: TrailPoint[];
  /** Optional waypoint markers */
  waypoints?: Waypoint[];
  /** Terrain exaggeration multiplier (default 1.5) */
  terrainExaggeration?: number;
  /** Dark-mode basemap when true; light basemap when false */
  darkMode?: boolean;
  /** Called when a waypoint marker is clicked */
  onWaypointClick?: (waypoint: Waypoint) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIGHT_STYLE =
  'https://demotiles.maplibre.org/style.json'; // public, no key needed

const DARK_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const TERRAIN_TILES_URL = '/tiles/terrain/{z}/{x}/{y}.png';

const TRAIL_COLOR: [number, number, number, number] = [255, 100, 0, 220]; // orange-ish
const TRAIL_WIDTH_METERS = 6;
const TRAIL_ELEV_OFFSET_M = 2; // lift path above terrain to avoid z-fighting

// Icon atlas — small SVG-based sprite rendered to a canvas at load time
const WAYPOINT_ICON_SIZE = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert TrailPoint[] into the flat [lon, lat, elev] tuples deck.gl expects,
 * with the elevation offset applied so the polyline floats above the terrain.
 */
function buildPathData(
  points: TrailPoint[]
): Array<{ path: [number, number, number][] }> {
  if (points.length < 2) return [];
  const path: [number, number, number][] = points.map((p) => [
    p.lon,
    p.lat,
    p.elev_m + TRAIL_ELEV_OFFSET_M,
  ]);
  return [{ path }];
}

/** Waypoint icon colour by type */
function iconColor(type: Waypoint['type']): [number, number, number] {
  const palette: Record<Waypoint['type'], [number, number, number]> = {
    trailhead: [34, 197, 94],  // green
    summit:    [239, 68, 68],  // red
    water:     [59, 130, 246], // blue
    viewpoint: [234, 179, 8],  // yellow
    generic:   [148, 163, 184], // slate
  };
  return palette[type];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TrailViewer3D({
  trailPoints,
  waypoints = [],
  terrainExaggeration = 1.5,
  darkMode = false,
  onWaypointClick,
}: TrailViewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Keep a stable ref to the overlay so we can reattach it after style swaps.
  const overlayRef = useRef<MapboxOverlay | null>(null);

  // ------------------------------------------------------------------
  // Build deck.gl layers from current props.
  // Called both on initial mount and whenever trailPoints/waypoints change.
  // ------------------------------------------------------------------
  const buildLayers = useCallback(() => {
    const pathData = buildPathData(trailPoints);

    const pathLayer = new PathLayer({
      id: 'trail-path',
      data: pathData,
      getPath: (d: { path: [number, number, number][] }) => d.path,
      getColor: TRAIL_COLOR,
      getWidth: TRAIL_WIDTH_METERS,
      widthUnits: 'meters',
      widthMinPixels: 2,
      pickable: false,
    });

    const iconLayer = new IconLayer<Waypoint>({
      id: 'waypoints',
      data: waypoints,
      getPosition: (d) => [d.lon, d.lat, d.elev_m + TRAIL_ELEV_OFFSET_M],
      getColor: (d) => iconColor(d.type),
      getSize: WAYPOINT_ICON_SIZE,
      sizeUnits: 'pixels',
      // Simple circle icon rendered inline — no external atlas required.
      getIcon: () => ({
        url: buildCircleIconUrl(),
        width: WAYPOINT_ICON_SIZE,
        height: WAYPOINT_ICON_SIZE,
        anchorY: WAYPOINT_ICON_SIZE,
      }),
      pickable: true,
      onClick: onWaypointClick
        ? ({ object }: { object?: Waypoint }) => {
            if (object) onWaypointClick(object);
          }
        : undefined,
    });

    return [pathLayer, iconLayer];
  }, [trailPoints, waypoints, onWaypointClick]);

  // ------------------------------------------------------------------
  // Attach (or reattach) the overlay to the map.
  // Safe to call multiple times — reuses the existing overlay instance.
  // ------------------------------------------------------------------
  const attachOverlay = useCallback(
    (map: maplibregl.Map) => {
      if (!overlayRef.current) {
        overlayRef.current = new MapboxOverlay({
          interleaved: false,
          layers: buildLayers(),
        });
      } else {
        overlayRef.current.setProps({ layers: buildLayers() });
      }
      // addControl is idempotent in MapboxOverlay — if already attached to
      // this map it's a no-op; if attached to a previous map it detaches first.
      map.addControl(overlayRef.current as unknown as maplibregl.IControl);
    },
    [buildLayers]
  );

  // ------------------------------------------------------------------
  // Add terrain + satellite raster sources after style has loaded.
  // Must be re-run every time the style is swapped.
  // ------------------------------------------------------------------
  const addTerrainSources = useCallback((map: maplibregl.Map) => {
    // Terrain-RGB elevation tiles (proxied locally to avoid CORS + add cache)
    if (!map.getSource('terrain-rgb')) {
      map.addSource('terrain-rgb', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES_URL],
        tileSize: 512,
        maxzoom: 14,
      });
    }

    map.setTerrain({
      source: 'terrain-rgb',
      exaggeration: terrainExaggeration,
    });

    // Optional satellite overlay (semi-transparent, under the trail)
    if (!map.getSource('satellite')) {
      map.addSource('satellite', {
        type: 'raster',
        tiles: ['/tiles/satellite/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 15,
      });
      map.addLayer(
        {
          id: 'satellite-layer',
          type: 'raster',
          source: 'satellite',
          paint: { 'raster-opacity': 0.4 },
        },
        undefined // insert before nothing = on top, but deck.gl renders above anyway
      );
    }
  }, [terrainExaggeration]);

  // ------------------------------------------------------------------
  // Initial map mount
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: darkMode ? DARK_STYLE : LIGHT_STYLE,
      center: trailPoints.length
        ? [trailPoints[0].lon, trailPoints[0].lat]
        : [0, 0],
      zoom: 12,
      pitch: 60,
      maxZoom: 15,
      antialias: true,
    });

    mapRef.current = map;

    map.on('load', () => {
      addTerrainSources(map);
      attachOverlay(map);

      // Fly to trail bounds if we have points
      if (trailPoints.length >= 2) {
        const bounds = trailPoints.reduce(
          (acc, p) => acc.extend([p.lon, p.lat]),
          new maplibregl.LngLatBounds(
            [trailPoints[0].lon, trailPoints[0].lat],
            [trailPoints[0].lon, trailPoints[0].lat]
          )
        );
        map.fitBounds(bounds, { padding: 60, duration: 1200 });
      }
    });

    // ---------------------------------------------------------------
    // THE CORE FIX: reattach deck.gl overlay after every style swap.
    //
    // map.setStyle() destroys all sources, layers, and WebGL state
    // that were added outside the style spec (including deck.gl's
    // canvas overlay).  The 'style.load' event fires once the new
    // style is fully applied.  We re-add terrain sources and
    // re-attach the MapboxOverlay here.
    // ---------------------------------------------------------------
    map.on('style.load', () => {
      addTerrainSources(map);
      attachOverlay(map);
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    return () => {
      overlayRef.current?.finalize();
      overlayRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount; style & data changes handled by separate effects

  // ------------------------------------------------------------------
  // Dark-mode toggle: swap basemap style.
  // The 'style.load' listener above handles overlay reattachment.
  // ------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targetStyle = darkMode ? DARK_STYLE : LIGHT_STYLE;
    // Guard: don't reload the same style (can happen on first render)
    const current = map.getStyle();
    if (current?.name !== targetStyle) {
      map.setStyle(targetStyle);
    }
  }, [darkMode]);

  // ------------------------------------------------------------------
  // Terrain exaggeration changes (no style swap needed)
  // ------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('terrain-rgb')) return;
    map.setTerrain({ source: 'terrain-rgb', exaggeration: terrainExaggeration });
  }, [terrainExaggeration]);

  // ------------------------------------------------------------------
  // Trail/waypoint data changes: update deck.gl layers in place
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!overlayRef.current) return;
    overlayRef.current.setProps({ layers: buildLayers() });
  }, [buildLayers]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%' }}
      aria-label="3D trail map"
    />
  );
}

// ---------------------------------------------------------------------------
// Tiny inline icon: a filled circle encoded as a data-URL.
// Avoids needing an external sprite atlas for waypoint markers.
// ---------------------------------------------------------------------------
let _cachedIconUrl: string | null = null;

function buildCircleIconUrl(): string {
  if (_cachedIconUrl) return _cachedIconUrl;

  const size = WAYPOINT_ICON_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // White circle with a thin border — colour tinted per-instance via getColor
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = 'white';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  _cachedIconUrl = canvas.toDataURL();
  return _cachedIconUrl;
}
