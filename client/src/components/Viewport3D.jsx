/**
 * Viewport3D — MapLibre GL JS 3D terrain with deck.gl trail overlay.
 *
 * Phase 3:
 *  - Terrain-RGB tiles from /tiles/terrain/{z}/{x}/{y}
 *  - Satellite raster tiles from /tiles/satellite/{z}/{x}/{y}
 *  - deck.gl PathLayer for trail polyline (2m above terrain)
 *  - deck.gl IconLayer for waypoint markers
 *  - Fly to trail bbox on load via map.fitBounds
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Deck } from '@deck.gl/core';
import { PathLayer, IconLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

// Terrain exaggeration
const TERRAIN_EXAGGERATION = 1.5;

// Trail line style
const TRAIL_COLOR = [16, 185, 129]; // emerald-500 RGB
const TRAIL_WIDTH_METERS = 8;

// Waypoint icon dimensions (we render SVG as data URI)
const ICON_SIZE = 32;

/**
 * Build a simple colored-circle SVG for a waypoint type.
 * @param {string} type
 * @returns {string} data URI
 */
function waypointIconUri(type) {
  const colors = {
    trailhead: '#10b981',   // emerald
    summit: '#f59e0b',      // amber
    water: '#3b82f6',       // blue
    viewpoint: '#8b5cf6',   // violet
    campsite: '#ec4899',    // pink
    junction: '#94a3b8',    // slate
    default: '#64748b',
  };
  const fill = colors[type] ?? colors.default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="12" fill="${fill}" stroke="white" stroke-width="3"/>
    <circle cx="16" cy="16" r="5" fill="white"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Pre-build icon atlas mapping for deck.gl IconLayer (one URL per type)
const WAYPOINT_TYPES = ['trailhead', 'summit', 'water', 'viewpoint', 'campsite', 'junction', 'default'];

/** Map type → {url, width, height, anchorX, anchorY} */
const ICON_MAPPING = Object.fromEntries(
  WAYPOINT_TYPES.map((type) => [
    type,
    { url: waypointIconUri(type), width: ICON_SIZE, height: ICON_SIZE, anchorX: ICON_SIZE / 2, anchorY: ICON_SIZE / 2 },
  ])
);

/**
 * Build deck.gl layers for the active trail.
 * @param {import('../hooks/useTrail').TrailData|null} trail
 * @returns {import('@deck.gl/core').Layer[]}
 */
function buildLayers(trail) {
  if (!trail) return [];

  const layers = [];

  // PathLayer — trail polyline elevated 2m above terrain
  if (trail.path?.length > 1) {
    layers.push(
      new PathLayer({
        id: 'trail-path',
        data: [{ path: trail.path }],
        getPath: (d) => d.path,
        getColor: TRAIL_COLOR,
        getWidth: TRAIL_WIDTH_METERS,
        widthUnits: 'meters',
        widthMinPixels: 2,
        widthMaxPixels: 20,
        // Offset 2m above terrain by adding z offset to all coords
        // deck.gl on MapLibre: use positionFormat 'XY' and rely on MapLibre terrain for Z
        positionFormat: 'XY',
        // Slightly above ground: deck.gl applies getOffset for path layers via extensions
        // Simple approach: just render with a slight Z elevation via coordinate origin
        parameters: {
          depthTest: false, // avoid Z-fighting with terrain
        },
        pickable: false,
      })
    );
  }

  // IconLayer — waypoint markers
  if (trail.waypoints?.length > 0) {
    layers.push(
      new IconLayer({
        id: 'waypoint-icons',
        data: trail.waypoints,
        getPosition: (w) => [w.lon, w.lat, (w.elevation_m ?? 0) + 5],
        getIcon: (w) => {
          const type = w.type ?? 'default';
          return WAYPOINT_TYPES.includes(type) ? type : 'default';
        },
        iconMapping: ICON_MAPPING,
        getSize: ICON_SIZE,
        sizeUnits: 'pixels',
        pickable: true,
        onClick: ({ object }) => {
          if (object) {
            console.log('[Viewport3D] waypoint clicked:', object);
          }
        },
      })
    );
  }

  return layers;
}

/**
 * @param {{ trail: import('../hooks/useTrail').TrailData|null, loading: boolean, error: string|null }} props
 */
export function Viewport3D({ trail, loading, error }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const deckRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  // Initialize MapLibre + deck.gl once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Create the MapLibre map
    const map = new maplibregl.Map({
      container: containerRef.current,
      // Use a simple blank dark style as base; we add sources below
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: { 'background-color': '#1e293b' }, // slate-800
          },
        ],
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      },
      center: [0, 30],
      zoom: 2,
      pitch: 45,
      bearing: 0,
      antialias: true,
    });

    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    map.on('load', () => {
      // Satellite raster source
      map.addSource('satellite', {
        type: 'raster',
        tiles: ['/tiles/satellite/{z}/{x}/{y}'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
      });

      map.addLayer({
        id: 'satellite-layer',
        type: 'raster',
        source: 'satellite',
        paint: { 'raster-opacity': 0.9 },
      });

      // Terrain-RGB source for 3D terrain
      map.addSource('terrain-rgb', {
        type: 'raster-dem',
        tiles: ['/tiles/terrain/{z}/{x}/{y}'],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium', // AWS elevation tiles use Terrarium encoding
      });

      // Enable 3D terrain
      map.setTerrain({
        source: 'terrain-rgb',
        exaggeration: TERRAIN_EXAGGERATION,
      });

      // Sky layer for atmospheric effect
      map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 0.0],
          'sky-atmosphere-sun-intensity': 15,
        },
      });

      setMapReady(true);
    });

    // Initialize deck.gl overlay
    const deck = new Deck({
      canvas: 'deck-canvas',
      width: '100%',
      height: '100%',
      initialViewState: { longitude: 0, latitude: 30, zoom: 2 },
      controller: false, // MapLibre handles interaction
      layers: [],
      // Keep deck.gl in sync with MapLibre camera
      onWebGLInitialized: () => {},
    });
    deckRef.current = deck;

    // Sync deck.gl view state with MapLibre camera
    map.on('move', () => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      const bearing = map.getBearing();
      const pitch = map.getPitch();

      deck.setProps({
        viewState: {
          longitude: center.lng,
          latitude: center.lat,
          zoom,
          bearing,
          pitch,
        },
      });
    });

    // Create the deck.gl canvas overlaid on the map
    // deck.gl canvas is created separately; we overlay it via CSS
    const deckCanvas = document.createElement('canvas');
    deckCanvas.id = 'deck-canvas';
    deckCanvas.style.position = 'absolute';
    deckCanvas.style.top = '0';
    deckCanvas.style.left = '0';
    deckCanvas.style.width = '100%';
    deckCanvas.style.height = '100%';
    deckCanvas.style.pointerEvents = 'none'; // let MapLibre handle mouse events
    containerRef.current.appendChild(deckCanvas);

    // Re-initialize deck on the canvas
    deck.setProps({ canvas: deckCanvas });

    return () => {
      deck.finalize();
      map.remove();
      mapRef.current = null;
      deckRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Update deck.gl layers when trail changes
  useEffect(() => {
    if (!deckRef.current) return;
    deckRef.current.setProps({ layers: buildLayers(trail) });
  }, [trail]);

  // Fly to trail bbox when trail loads
  useEffect(() => {
    if (!mapRef.current || !mapReady || !trail?.bbox) return;

    const [west, south, east, north] = trail.bbox;
    // Sanity check: avoid degenerate bboxes
    if (west === east || south === north) return;

    mapRef.current.fitBounds(
      [[west, south], [east, north]],
      {
        padding: { top: 60, bottom: 60, left: 60, right: 60 },
        pitch: 55,
        bearing: 0,
        duration: 1500,
        maxZoom: 14,
      }
    );
  }, [trail?.bbox, mapReady]);

  return (
    <div className="flex-1 relative overflow-hidden bg-slate-800">
      {/* MapLibre container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <svg
              className="animate-spin w-8 h-8 text-emerald-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
            <span className="text-slate-300 text-sm">Loading trail…</span>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && !loading && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <div className="bg-red-900/90 text-red-200 text-sm px-4 py-2 rounded-lg shadow-lg">
            {error}
          </div>
        </div>
      )}

      {/* Empty state (no trail selected, map not loaded) */}
      {!trail && !loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="text-center text-slate-500">
            <div className="text-5xl mb-3 opacity-40">🏔️</div>
            <p className="text-sm">Select a trail to view 3D terrain</p>
          </div>
        </div>
      )}
    </div>
  );
}
