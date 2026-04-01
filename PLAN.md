# hike3d — Technical Plan

**Date**: 2026-04-01
**Source**: hike3d Design Document v1.0
**Scope**: Local-dev prototype, zero cloud dependencies

---

## 1. Tech Stack

### Frontend

| Technology | Role | Justification |
|---|---|---|
| **React 18** | UI framework | Component model maps cleanly to the split-pane layout (3D viewport, elevation chart, side panel). Hooks handle async state (trail loading, GPS stream) without extra state libraries. |
| **Vite 5** | Build/dev server | Sub-second HMR. Zero config for React + JSX. Proxies API calls to Express during dev. No Webpack overhead. |
| **Tailwind CSS 3** | Styling | Utility classes allow rapid iteration without writing CSS files. Built-in dark mode via `dark:` prefix — critical for outdoor use. Purges unused styles at build time. |
| **MapLibre GL JS** | Base map + terrain mesh | Open-source Mapbox GL fork. Renders terrain-RGB tiles as 3D mesh client-side. No API key needed for self-hosted or public tile sources. ~200KB gzipped — heavy, but there is no lighter alternative for GPU-accelerated 3D terrain. |
| **deck.gl** | Trail path + waypoint layers + camera | Provides `PathLayer` (trail polyline), `IconLayer` (waypoints), and `FlyToInterpolator` for smooth camera transitions. Integrates directly with MapLibre as an overlay. This is the one "heavy" dependency — justified because writing a WebGL trail renderer from scratch would take weeks. |
| **Canvas 2D API** | Elevation profile chart | Custom ~150-line renderer. No Chart.js or D3. Full control over scrubber synchronization with the 3D camera. |

**Tradeoff: MapLibre + deck.gl vs. raw Three.js**
- MapLibre/deck.gl: handles terrain tile decoding, map projections, LOD, and tile management out of the box. Downside: two large dependencies (~400KB combined gzipped).
- Raw Three.js: smaller bundle if we only needed a 3D scene, but we'd need to build tile fetching, terrain mesh generation, coordinate projection, and LOD from scratch — easily 2,000+ lines of geometry code.
- **Decision**: MapLibre + deck.gl. The terrain rendering problem is genuinely hard and these libraries solve it well. Everything else is hand-built.

### Backend

| Technology | Role | Justification |
|---|---|---|
| **Node.js 20 LTS** | Runtime | Matches frontend language. Async I/O handles concurrent tile fetching well. |
| **Express 4** | HTTP framework | Minimal, well-understood. ~30KB. Route handlers map 1:1 to API endpoints. No magic. |
| **better-sqlite3** | Database driver | Synchronous API simplifies Express handlers — no callback/promise nesting for DB reads. 5-10x faster than async `sqlite3` for read-heavy workloads. Zero-config, file-based. |
| **ws** | WebSocket server | ~50KB. Raw WebSocket for the GPS live companion stream. No Socket.io overhead — we need a simple JSON message channel at 1Hz. |
| **jsonwebtoken** | JWT signing/verification | ~20KB. HS256 signing for anonymous session tokens. No OAuth, no auth providers. |
| **uuid** | ID generation | UUIDv4 for all primary keys. Tiny, no dependencies. |
| **fast-xml-parser** | GPX parsing (server-side) | ~40KB. GPX is XML. While the design doc suggests a custom parser, `fast-xml-parser` is small, fast, and avoids writing an XML state machine. The tradeoff (one extra dep vs. 200 lines of parser code) favors the library — XML edge cases are real. |
| **multer** | File upload handling | ~30KB. Handles `multipart/form-data` for GPX uploads. The alternative is parsing multipart boundaries by hand, which is error-prone for no benefit. |

**Tradeoff: Express vs. Fastify vs. no framework**
- Express: battle-tested, huge ecosystem knowledge, trivial to debug. Slightly slower than Fastify but irrelevant at localhost scale.
- Fastify: faster, schema validation built-in. But adds learning overhead and plugin conventions that add friction in a prototype.
- Raw `http.createServer`: possible, but route matching and middleware (CORS, body parsing, static files) would need to be hand-rolled for no real gain.
- **Decision**: Express. Fastest time to working prototype.

### Database

| Technology | Role | Justification |
|---|---|---|
| **SQLite** (via better-sqlite3) | All persistent storage | Single file (`hike3d.sqlite`). No daemon, no configuration, no connection string. Handles thousands of trails without strain. WAL mode enables concurrent reads during tile cache writes. |

**Tradeoff: SQLite vs. JSON files**
- SQLite: indexed queries on trail name, source, session. Atomic writes. Foreign keys enforce referential integrity. SQL migration files version the schema.
- JSON files: simpler initially but becomes a mess for querying (e.g., "find all saved trails for session X sorted by save date"). No transactions, no indexes.
- **Decision**: SQLite. The data model has 6 related tables — this is a relational problem.

### Storage

| Technology | Role | Justification |
|---|---|---|
| **Local filesystem** | Tile cache, GPX files, exports | Tiles stored as `/{z}/{x}/{y}.png` under `/cache/tiles/`. GPX files under `/data/gpx/`. Node `fs/promises` handles all I/O. No object storage abstraction needed. |

### External APIs (read-only, no accounts)

| API | Purpose | Rate Limits | Failure Mode |
|---|---|---|---|
| **Overpass API** (overpass-api.de) | Query OSM for hiking trails | Fair use (~10K requests/day) | Retry with backoff; return cached results if available |
| **Nominatim** (nominatim.openstreetmap.org) | Geocode trail names → bounding boxes | 1 req/sec | Debounce on client; cache geocode results in SQLite |
| **OpenTopoData** (api.opentopodata.org) | Elevation data (SRTM 30m) | 100 pts/request, no hard limit | Batch points; cache elevations per trail in SQLite |
| **OSM Raster Tiles** (tile.openstreetmap.org) | Satellite/map imagery | Standard tile usage policy | Cache locally; serve from cache when offline |
| **AWS Terrain Tiles** (elevation-tiles-prod S3) | Terrain-RGB elevation tiles | Public, no key | Cache locally; tiles are immutable |

---

## 2. Entity Relations

### ER Diagram (text)

```
user_sessions
    PK id (TEXT, UUID)
    display_name (TEXT, nullable)
    jwt_secret (TEXT)
    created_at, last_active_at, expires_at
    ip_address, user_agent
    │
    │ 1
    │
    ├────────< saved_trails >────────┐
    │   PK id                        │
    │   FK session_id ───────────┘   │
    │   FK trail_id ─────────────────┤
    │   nickname, notes              │
    │   cache_status, cache_path     │
    │   UNIQUE(session_id, trail_id) │
    │                                │
    ├────────< gpx_tracks            │
    │   PK id                        │
    │   FK session_id ───────────┘   │
    │   FK trail_id ─────────────────┤
    │   original_filename, file_path │
    │   point_count, has_elevation   │
    │   start_lat/lon, end_lat/lon   │
    │                                │
    ├────────< waypoints (user)      │
    │   PK id                        │
    │   FK trail_id ─────────────────┤
    │   FK session_id (nullable)     │
    │   name, type, lat, lon, elev   │
    │   dist_from_start_m, notes     │
    │                                │
    └────────< gps_sessions          │
        PK id                        │
        FK session_id ───────────┘   │
        FK trail_id ─────────────────┘
        started_at, ended_at
        track_points (JSON)
        distance_m, duration_s, status

trails
    PK id (TEXT, UUID)
    name, source ('osm'|'gpx')
    osm_relation_id (nullable)
    country_code, region
    geojson (TEXT, serialized JSON)
    elevation_profile (TEXT, JSON array)
    distance_m, elevation_gain_m, elevation_loss_m
    max_elev_m, min_elev_m
    difficulty, surface, tags
    created_at, updated_at
```

### Relationship Summary

| Parent | Child | Cardinality | FK | On Delete |
|---|---|---|---|---|
| `user_sessions` | `saved_trails` | 1:N | `session_id` | CASCADE |
| `user_sessions` | `gpx_tracks` | 1:N | `session_id` | CASCADE |
| `user_sessions` | `waypoints` | 1:N | `session_id` | CASCADE |
| `user_sessions` | `gps_sessions` | 1:N | `session_id` | CASCADE |
| `trails` | `saved_trails` | 1:N | `trail_id` | CASCADE |
| `trails` | `gpx_tracks` | 1:N | `trail_id` | SET NULL |
| `trails` | `waypoints` | 1:N | `trail_id` | CASCADE |
| `trails` | `gps_sessions` | 1:N | `trail_id` | (nullable) |

### Key Design Decisions

1. **`trails` is the hub entity.** Every user-facing feature (3D view, elevation profile, flythrough, GPX import) resolves to a `trails` record. OSM-sourced and GPX-sourced trails share the same schema — differentiated by `source` column.

2. **`saved_trails` is a junction table**, not a boolean flag on `trails`. A single trail can be saved by multiple sessions. Cache status tracks the tile-download lifecycle per save.

3. **`waypoints` serves double duty.** System/OSM waypoints have `session_id = NULL` and `source = 'osm'|'system'`. User waypoints have a non-null `session_id` and `source = 'user'`. This avoids two separate tables for the same spatial data.

4. **`gps_sessions` stores track points as a JSON array** in a TEXT column. This is a deliberate denormalization — storing each GPS fix as a row would create 3,600 rows per hour of hiking. A JSON blob is simpler to export as GPX and simpler to replay. The tradeoff is no SQL queries against individual points, but that's not needed for this prototype.

5. **Per-session JWT secrets.** Each `user_sessions` row has its own `jwt_secret`. If one session's token leaks, it can't be used to forge tokens for other sessions. This is cheap insurance for a no-auth system.

---

## 3. User Flows

### Flow 1: Search and Preview a Trail (Primary Happy Path)

```
[User opens localhost:5173]
        │
        ▼
[Check for JWT cookie]──── missing ────► [POST /api/session/create]
        │                                       │
        │ valid                                 │ set httpOnly cookie
        ▼                                       ▼
[Render: search panel + empty 3D viewport with default terrain]
        │
        ▼
[User types trail name, e.g. "Half Dome"]
        │
        ├─► Debounce 300ms
        │
        ▼
[GET /api/trails/search?q=Half+Dome&limit=5]
        │
        ├─► Backend: Nominatim geocode → bounding box
        ├─► Backend: Overpass API query for hiking routes
        ├─► Backend: Sample 200 points, fetch elevation from OpenTopoData
        ├─► Backend: Compute stats (distance, gain, difficulty)
        ├─► Backend: Cache result in SQLite `trails` table
        │
        ▼
[Render search results with mini elevation sparklines]
        │
        ▼
[User clicks a result]
        │
        ▼
[GET /api/trails/:id → full trail record]
        │
        ├─► MapLibre: load terrain-RGB tiles via /tiles/terrain/{z}/{x}/{y}
        ├─► deck.gl: PathLayer renders trail polyline on terrain
        ├─► deck.gl: IconLayer renders waypoint markers
        ├─► Canvas: draw elevation profile with gradient coloring
        ├─► Side panel: trail stats, waypoint list, "Save Offline" button
        │
        ▼
[User clicks Play → flythrough begins]
        │
        ├─► Catmull-Rom spline interpolation through trail coordinates
        ├─► Camera: first-person (60° pitch) or chase cam (45° pitch)
        ├─► requestAnimationFrame loop at 60fps
        ├─► Elevation profile scrubber syncs to camera position
        │
        ▼
[User can: pause, scrub, change speed (0.5x/1x/2x/4x), toggle camera mode]
```

**Failure modes:**
- Overpass API timeout → show "Search timed out, try a more specific query" with retry button
- Nominatim rate limit (1 req/s) → client-side debounce + server-side queue
- OpenTopoData returns partial elevation → interpolate gaps from neighboring points
- Terrain tiles fail to load → MapLibre falls back to flat terrain with error toast
- No search results → suggest "Near me" search or GPX import

### Flow 2: Import a GPX File

```
[User clicks "Import GPX" or drags .gpx file onto viewport]
        │
        ├─► Client: validate extension (.gpx), warn if >10MB
        ├─► Client: parse first 500 bytes — confirm XML + <gpx> root
        │
        ▼
[POST /api/gpx/import (multipart/form-data)]
        │
        ├─► Server: save raw file → /data/gpx/<uuid>.gpx
        ├─► Server: parse GPX XML → extract <trkpt> lat/lon/ele/time
        ├─► Server: if no elevation data → batch fetch from OpenTopoData
        ├─► Server: compute distance, gain/loss, bounding box
        ├─► Server: insert into gpx_tracks + trails (source='gpx')
        ├─► Server: auto-generate waypoints (trailhead = first pt, endpoint = last pt)
        │
        ▼
[Response: { trail_id, stats }]
        │
        ▼
[GET /api/trails/:trail_id → load into 3D viewport identically to OSM trails]
```

**Failure modes:**
- Invalid GPX XML → return 400 with parse error location
- GPX has no `<trkpt>` elements → return 400 "No track points found"
- GPX file >50MB → reject with 413 (server-side limit in multer config)
- Elevation backfill fails → store trail anyway with `has_elevation=false`, show warning in UI

### Flow 3: Save Trail for Offline Access

```
[User viewing a trail, clicks "Save for Offline"]
        │
        ▼
[POST /api/saved_trails { trail_id, cache_offline: true }]
        │
        ├─► Insert saved_trails record (cache_status='pending')
        ├─► Compute bounding box + zoom levels needed (z12–z15 typically)
        ├─► Estimate tile count and size, return to client
        │
        ▼
[UI shows: "Downloading ~45MB (1,200 tiles)..." with progress]
        │
        ▼
[POST /api/cache/trail/:trail_id]
        │
        ├─► Server: iterate tile coordinates within bounding box
        ├─► For each tile: check /cache/tiles/{type}/{z}/{x}/{y}.png
        │   ├─► Hit: skip
        │   └─► Miss: fetch from upstream, save to filesystem
        ├─► Save trail GeoJSON + elevation JSON + waypoints to /cache/trails/<id>/
        ├─► Update saved_trails.cache_status = 'cached'
        │
        ▼
[UI: "Saved! Available offline."]
```

**Failure modes:**
- Tile download fails mid-cache → set `cache_status='error'`, store partial progress, allow retry
- Disk space exhausted → check `MAX_CACHE_SIZE_MB` before starting, reject if limit exceeded
- Client disconnects during caching → server continues in background, status queryable via `GET /api/cache/status`

### Flow 4: Offline Usage

```
[App loads with no network connectivity]
        │
        ├─► JWT validation fails (no server) → use cached session from localStorage
        ├─► Search is disabled → show saved trails list only
        │
        ▼
[User selects a cached trail]
        │
        ├─► Load trail GeoJSON from /cache/trails/<id>/trail.geojson
        ├─► Load elevation from /cache/trails/<id>/elevation.json
        ├─► MapLibre serves tiles from /cache/tiles/ (Express tile route)
        │
        ▼
[Full 3D flythrough works identically to online mode]
```

**Failure modes:**
- Cache corrupted (missing tiles) → show terrain with gaps + warning "Some tiles unavailable"
- SQLite file locked → WAL mode prevents this for concurrent reads; if corrupted, show "Database error" with instructions to reset

### Flow 5: Live GPS Companion (Post-MVP)

```
[User has trail loaded, clicks "Start Hike"]
        │
        ├─► Request browser Geolocation permission
        ├─► POST /api/gps/session/start → { gps_session_id, ws_token }
        ├─► Open WebSocket: ws://localhost:3000/ws/gps?token=<ws_token>
        │
        ▼
[GPS polling loop — navigator.geolocation.watchPosition at ~1Hz]
        │
        ├─► Send via WS: { type:'position', lat, lon, altitude_m, heading, ts }
        │
        ▼
[Server processes]
        ├─► Snap GPS fix to nearest point on trail geometry
        ├─► Compute: distance remaining, next waypoint, ETA, pace
        ├─► Append to gps_sessions.track_points JSON
        ├─► Send back: { type:'update', snapped_lat/lon, dist_remaining, eta, ... }
        │
        ▼
[Client updates]
        ├─► 3D camera follows snapped position
        ├─► Breadcrumb trail renders via deck.gl PathLayer
        ├─► HUD overlay: elevation, pace, distance, ETA, next waypoint
        │
        ▼
[User taps "End Hike"]
        ├─► WS: { type:'end_session' }
        ├─► POST /api/gps/session/end/:id → compute final stats
        ├─► Show post-hike summary with replay option
```

---

## 4. MVP Implementation

### What's In (P0 + P1)

| # | Feature | Priority | Complexity |
|---|---------|----------|------------|
| 1 | Express server + SQLite schema + session JWT | P0 | Low |
| 2 | Trail search via Overpass API + Nominatim geocoding | P0 | Medium |
| 3 | 3D terrain rendering (MapLibre + deck.gl) | P0 | High |
| 4 | Trail path overlay on terrain (deck.gl PathLayer) | P0 | Medium |
| 5 | First-person / third-person camera flythrough | P0 | High |
| 6 | Synchronized elevation profile (Canvas 2D) | P0 | Medium |
| 7 | OSM waypoint extraction + display | P0 | Low |
| 8 | Trail stats panel (distance, gain, difficulty) | P0 | Low |
| 9 | Tile proxy with local filesystem cache | P1 | Medium |
| 10 | Save trails to SQLite | P1 | Low |
| 11 | Offline tile caching + offline detection | P1 | High |
| 12 | GPX file import + elevation backfill | P1 | Medium |

### What's Out (Post-MVP)

- Live GPS companion mode (WebSocket + GPS stream)
- Social sharing / shareable URLs
- Community annotations / moderation
- Multi-day route planner
- AR overlay (WebXR)
- Account system / email auth
- User-added custom waypoints (P2, deferred)
- Data export ZIP (P2, deferred)

### Phase Plan

#### Phase 1 — Skeleton (Days 1–3) [DONE]

**Goal**: Express serves React app, SQLite initialized, anonymous sessions work.

**Tasks:**
- [x] Initialize project: `npm init`, install `express`, `better-sqlite3`, `jsonwebtoken`, `uuid`, `ws`, `cors`
- [x] Create Express server entry point (`server/index.js`) with CORS middleware for Vite dev proxy
- [x] Write SQL migration `001_create_tables.sql` — create all 6 tables with indexes
- [x] Build migration runner: reads `.sql` files from `server/db/migrations/`, applies in order, tracks in `schema_version` table
- [x] Implement `POST /api/session/create` — generate UUID, random 32-byte hex secret, sign JWT, set httpOnly cookie
- [x] Implement `POST /api/session/validate` — verify JWT, update `last_active_at`
- [x] Scaffold Vite + React + Tailwind project in `client/`
- [x] Create `useSession` hook — check JWT on load, create if missing
- [x] Build app shell layout: left panel (search), center (3D viewport placeholder), bottom (elevation profile placeholder)
- [x] Configure Vite proxy: `/api/*` and `/tiles/*` → `localhost:3000`

**Validation**: `npm run dev` starts both servers, browser shows app shell, JWT cookie is set.

**Risks**: None significant. This is boilerplate.

#### Phase 2 — Trail Data Pipeline (Days 4–7) [DONE]

**Goal**: Search for a trail by name and get structured data back.

**Tasks:**
- [x] Build `osmService.js`:
   - `geocode(query)` — Nominatim HTTP request, return bounding box
   - `searchTrails(bbox, nameFilter)` — Overpass API query for `relation["route"="hiking"]`, parse JSON response
   - `buildGeoJSON(osmRelation)` — convert OSM ways/nodes into GeoJSON LineString
- [x] Build `elevationService.js`:
   - `fetchElevation(points[])` — batch POST to OpenTopoData (100 pts/request), return `[{lat, lon, elevation_m}]`
   - In-memory LRU cache (Map, 1000 entries) for individual elevation lookups
   - SQLite cache: store elevation profile per trail to avoid re-fetching
- [x] Build `trailService.js`:
   - `searchAndBuild(query)` — orchestrate: geocode → Overpass → sample points → fetch elevation → compute stats → insert into `trails` table → return
   - `computeStats(elevationProfile)` — distance, gain, loss, max, min, difficulty classification
   - `extractWaypoints(osmData, trailId)` — find tagged nodes (trailhead, summit, etc.), insert into `waypoints`
- [x] Implement `GET /api/trails/search` — calls `trailService.searchAndBuild`, returns result list
- [x] Implement `GET /api/trails/:id` — fetch full trail record from SQLite
- [x] Build `SearchPanel.jsx` — debounced input, result list with loading skeleton
- [x] Wire search results to display: name, distance, elevation gain, difficulty badge

**Validation**: Type "Mount Tamalpais" → get 3-5 results with real distance/elevation data.

**Risks:**
- Overpass API can be slow (5-15s for complex queries). **Mitigation**: show loading state, cache aggressively, set 25s timeout.
- Nominatim rate limit (1 req/s). **Mitigation**: debounce search input at 500ms, never fire concurrent geocode requests.
- OpenTopoData batching edge cases (points at sea, outside SRTM coverage). **Mitigation**: fallback to 0m elevation with a warning flag.

#### Phase 3 — 3D Terrain Rendering (Days 8–12) [DONE]

**Goal**: Select a trail from search results and see it rendered on 3D terrain.

**Tasks:**
1. [x] Build tile proxy (`server/routes/tiles.js`):
   - `GET /tiles/terrain/:z/:x/:y` — check `cache/tiles/terrain/{z}/{x}/{y}.png`, if miss → fetch from AWS terrain tiles S3 bucket, save to filesystem, serve
   - `GET /tiles/satellite/:z/:x/:y` — same pattern for OSM raster tiles
   - Set `Cache-Control: max-age=86400` on responses
2. [x] Build `Viewport3D.jsx`:
   - Initialize MapLibre GL JS with `terrain` source pointing to `/tiles/terrain/{z}/{x}/{y}`
   - Set `terrain` property with exaggeration factor (default 1.5)
   - Add raster source pointing to `/tiles/satellite/{z}/{x}/{y}`
3. [x] Add deck.gl overlay to MapLibre:
   - `PathLayer` — trail polyline from GeoJSON coordinates, elevated 2m above terrain
   - `IconLayer` — waypoint markers with type-specific icons (SVG sprites: trailhead, summit, water, etc.)
4. [x] Build `useTrail` hook:
   - Fetch trail data from API
   - Parse GeoJSON, compute bounding box
   - Fly camera to trail extent on load (`map.fitBounds`)
5. [x] Implement trail selection: click search result → `useTrail` fetches → `Viewport3D` renders

**Validation**: Click a search result → 3D terrain loads with trail line and waypoint markers visible.

**Risks:**
- Terrain-RGB tile decoding failures (corrupted tiles, wrong format). **Mitigation**: MapLibre handles this internally; fallback is flat terrain.
- deck.gl PathLayer Z-fighting with terrain mesh. **Mitigation**: offset path 2-5m above terrain; use `getWidth` and `widthUnits: 'meters'` for consistent trail width.
- Memory pressure from terrain tiles at high zoom. **Mitigation**: limit max zoom to 15; use MapLibre's built-in tile management and garbage collection.

#### Phase 4 — Flythrough + Elevation Profile (Days 13–18)

**Goal**: Animated camera flythrough synchronized with an interactive elevation chart.

**Tasks:**
1. Build `camera.js` (Catmull-Rom spline engine):
   - `CatmullRomPath` class: takes array of `[lon, lat, elev]` control points
   - `getPointAtDistance(t)` — returns interpolated `{lon, lat, elev, bearing}` at parameter `t` (0–1)
   - Smooth heading computation from tangent vector at current position
   - Configurable tension parameter (0.5 default)
2. Build `useCamera` hook:
   - `play()`, `pause()`, `seek(t)`, `setSpeed(multiplier)`
   - `requestAnimationFrame` loop: advance `t` by `dt * speed`, get point from spline, update MapLibre camera
   - Camera modes: first-person (pitch 60°, eye height 1.8m above terrain) and chase-cam (pitch 45°, 20m behind and 10m above)
   - Emit `onPositionChange(t, point)` callback for profile sync
3. Build `elevationChart.js` (Canvas 2D renderer):
   - Input: `elevation_profile[]` array of `{dist_m, elev_m}`
   - Render: filled area chart with gradient coloring (green <8%, yellow 8-15%, red >15%)
   - Overlay: waypoint pins at their `dist_from_start_m` positions
   - Scrubber: vertical line at current camera position
   - Stats bar: total gain, loss, max elev, min elev, estimated time
4. Build `ElevationProfile.jsx`:
   - Canvas element, resize observer for responsive width
   - Click handler: compute `t` from click X position, call `useCamera.seek(t)`
   - Receive camera position updates, redraw scrubber line
5. Wire flythrough controls: Play/Pause button, speed selector (0.5x/1x/2x/4x), camera mode toggle
6. Waypoint interaction: click waypoint in 3D → popup with name/type/elevation/notes; camera smoothly animates to waypoint position (500ms ease via `FlyToInterpolator`)

**Validation**: Click Play → camera smoothly flies through trail in first-person; scrubbing the elevation chart moves the 3D camera; clicking a waypoint snaps to it.

**Risks:**
- Catmull-Rom jitter at sharp switchbacks. **Mitigation**: pre-smooth trail coordinates with Douglas-Peucker simplification (keep ~500 points max), then apply spline.
- Camera clipping through terrain at steep sections. **Mitigation**: at each frame, query terrain height at camera position via MapLibre's `queryTerrainElevation`, clamp camera altitude to `max(spline_elev, terrain_elev + 1.8m)`.
- 60fps animation stalls on low-end hardware. **Mitigation**: throttle to 30fps if `requestAnimationFrame` callback time exceeds 20ms; reduce terrain tile resolution.

#### Phase 5 — GPX Import + Offline Caching (Days 19–24)

**Goal**: Import GPX files and cache trails for offline use.

**Tasks:**
1. Build `gpxService.js`:
   - Parse GPX XML using `fast-xml-parser`
   - Extract `<trkpt>` lat/lon/ele/time from all `<trkseg>` elements
   - If `has_elevation === false`, call `elevationService.fetchElevation` in batches
   - Compute stats, insert into `gpx_tracks` + `trails` tables
   - Save raw file to `/data/gpx/<uuid>.gpx`
2. Implement `POST /api/gpx/import` — multer middleware, max 50MB, call `gpxService`
3. Implement `GET /api/gpx/export/:trail_id` — generate GPX XML from trail GeoJSON + elevation, stream as download
4. Build GPX import UI:
   - Drag-and-drop zone over viewport (detect `dragenter`/`dragleave`/`drop`)
   - "Import GPX" button in side panel
   - Upload progress bar, error display
5. Build `cacheService.js`:
   - `cacheTilesForTrail(trailId)` — compute bounding box, enumerate tile coordinates for z12–z15, download missing tiles
   - `estimateCacheSize(trailId)` — estimate MB based on tile count × avg tile size (15KB)
   - `deleteCacheForTrail(trailId)` — remove tile files + trail cache directory
   - Progress tracking: store downloaded/total count in `saved_trails` record, poll from client
6. Implement `POST /api/cache/trail/:trail_id`, `DELETE /api/cache/trail/:trail_id`, `GET /api/cache/status`
7. Build offline detection:
   - Client: `navigator.onLine` + periodic fetch to `/api/health` (1 req/30s)
   - When offline: disable search, show saved trails only, serve tiles from cache
   - `CacheManager.jsx` — list saved trails, show cache size per trail, delete button, total storage used

**Validation**: Import a GPX file → 3D preview loads. Save a trail offline → disconnect network → trail still renders in 3D.

**Risks:**
- Tile enumeration generates thousands of fetches for large trail bounding boxes. **Mitigation**: limit to z12–z15 (4 zoom levels), pad bounding box by only 10%, use concurrent fetch pool (max 6 simultaneous).
- GPX files with millions of points (ultra-marathon recordings). **Mitigation**: downsample to max 5,000 points using Douglas-Peucker before processing.
- Offline mode breaks session validation. **Mitigation**: store session data in localStorage as backup; validate JWT client-side when server unreachable (decode payload, check exp).

#### Phase 6 — Polish + MVP Cutoff (Days 25–30)

**Goal**: Robust error handling, loading states, mobile-responsive layout.

**Tasks:**
1. Loading states: skeleton screens for search results, spinner overlay for 3D loading, progress bar for cache download
2. Error boundaries: React error boundary around Viewport3D (WebGL crashes shouldn't kill the app)
3. Empty states: no search results, no saved trails, no waypoints
4. Mobile responsive: stack layout vertically on screens <768px (search panel slides in as drawer, elevation profile below viewport)
5. Dark mode: Tailwind `dark:` variants, MapLibre dark basemap style, elevation chart dark theme
6. Keyboard shortcuts: Space (play/pause), Left/Right arrows (scrub ±5%), 1/2/3/4 (speed), C (toggle camera mode)
7. Toast notifications for async operations (save complete, cache downloaded, GPX imported)
8. Rate limiting middleware: 60 req/min per IP on search endpoints to avoid hammering Overpass
9. Input sanitization: validate trail IDs as UUID format, sanitize search queries, limit GPX file size

**Validation**: All 6 MVP Definition of Done criteria pass (see design doc section 10).

---

## 5. Architecture Decisions Record

### ADR-1: MapLibre + deck.gl as only heavy dependencies

**Context**: 3D terrain rendering from elevation tiles is the core feature and genuinely hard.

**Decision**: Accept MapLibre GL JS (~200KB) + deck.gl (~200KB) as heavy dependencies. Everything else is hand-built or uses tiny focused utilities.

**Consequence**: Bundle size ~500KB gzipped total (including React). Acceptable for a terrain visualization app — users expect a loading moment.

### ADR-2: Synchronous SQLite via better-sqlite3

**Context**: Express route handlers need to read/write trail data, session data, and cache metadata.

**Decision**: Use `better-sqlite3` synchronous API. Reads block the event loop for <1ms at prototype scale. WAL mode handles the one concurrent-write case (tile caching background task).

**Consequence**: Simpler code (no async/await for DB calls). Would need to revisit if the database grew beyond ~100K rows or if write contention became an issue — neither is plausible for a local prototype.

### ADR-3: Filesystem tile cache, not SQLite BLOBs

**Context**: Terrain and satellite tiles are binary PNG files, 10-30KB each. Thousands per trail.

**Decision**: Store as files at `cache/tiles/{type}/{z}/{x}/{y}.png`. Express static file serving is fast. Filesystem is the natural storage for image tiles.

**Consequence**: Cache invalidation is simple (delete files). Backup is `cp -r`. No BLOB overhead in SQLite. Tradeoff: slightly more complex enumeration than a SQL query, but `fs.readdir` is sufficient.

### ADR-4: Custom Canvas elevation chart, not D3/Chart.js

**Context**: The elevation profile is a single chart type with unique requirements (synchronized scrubber, gradient coloring, waypoint pins).

**Decision**: Build a ~150-line Canvas 2D renderer. Full control over scrubber animation timing, click-to-seek precision, and gradient thresholds.

**Consequence**: No charting library dependency. Chart is purpose-built and tightly coupled to the camera system. Tradeoff: no free tooltip/zoom behaviors — but we don't need them.

### ADR-5: GPX parsing with fast-xml-parser, not hand-rolled

**Context**: Design doc suggests a custom 200-line parser. GPX is XML with namespaces, CDATA, encoding declarations, and vendor extensions.

**Decision**: Use `fast-xml-parser` (~40KB, zero dependencies). Handles XML edge cases correctly. The 200 lines of parsing logic focus on GPX-specific extraction (track segments, elevation, timestamps) rather than XML tokenization.

**Consequence**: One extra dependency, but eliminates an entire class of XML parsing bugs. Net reduction in total code.

---

## 6. File Structure

```
hike3d/
├── client/                          # React frontend (Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── App.jsx              # Root layout: panels + viewport + profile
│   │   │   ├── SearchPanel.jsx      # Trail search input + result list
│   │   │   ├── Viewport3D.jsx       # MapLibre + deck.gl container
│   │   │   ├── ElevationProfile.jsx # Canvas chart wrapper
│   │   │   ├── WaypointPanel.jsx    # Waypoint list + details
│   │   │   ├── TrailStats.jsx       # Distance, gain, difficulty badges
│   │   │   ├── CacheManager.jsx     # Saved trails, storage usage
│   │   │   ├── GpxImport.jsx        # Drag-drop + file picker
│   │   │   ├── FlythroughControls.jsx # Play/pause, speed, camera mode
│   │   │   └── Toast.jsx            # Notification toasts
│   │   ├── hooks/
│   │   │   ├── useSession.js        # JWT lifecycle
│   │   │   ├── useTrail.js          # Fetch + manage active trail
│   │   │   ├── useCamera.js         # Flythrough animation state
│   │   │   ├── useSearch.js         # Debounced search + results
│   │   │   └── useOffline.js        # Connectivity detection
│   │   ├── lib/
│   │   │   ├── camera.js            # CatmullRomPath class
│   │   │   ├── elevationChart.js    # Canvas 2D renderer (~150 lines)
│   │   │   ├── gpxParser.js         # Client-side GPX preview parse
│   │   │   ├── terrain.js           # MapLibre + deck.gl setup helpers
│   │   │   └── api.js               # fetch wrapper with JWT + error handling
│   │   ├── main.jsx                 # Entry point
│   │   └── index.css                # Tailwind directives
│   ├── public/
│   │   └── icons/                   # Waypoint type SVG icons
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── server/
│   ├── index.js                     # Express + ws server entry
│   ├── routes/
│   │   ├── session.js
│   │   ├── trails.js
│   │   ├── savedTrails.js
│   │   ├── gpx.js
│   │   ├── waypoints.js
│   │   ├── elevation.js
│   │   ├── cache.js
│   │   └── tiles.js
│   ├── services/
│   │   ├── osmService.js            # Overpass + Nominatim
│   │   ├── trailService.js          # Search → build → cache orchestrator
│   │   ├── elevationService.js      # OpenTopoData batching + caching
│   │   ├── gpxService.js            # Parse + process GPX files
│   │   ├── cacheService.js          # Tile download + management
│   │   └── sessionService.js        # JWT issue/validate
│   ├── ws/
│   │   └── gpsHandler.js            # WebSocket GPS stream (post-MVP)
│   ├── db/
│   │   ├── index.js                 # better-sqlite3 init + WAL mode + migration runner
│   │   └── migrations/
│   │       ├── 001_create_tables.sql
│   │       └── 002_add_gps_sessions.sql
│   ├── middleware/
│   │   ├── auth.js                  # JWT cookie extraction + validation
│   │   └── rateLimit.js             # Simple in-memory rate limiter
│   └── package.json
│
├── data/
│   ├── gpx/                         # Uploaded GPX files
│   └── exports/                     # Generated ZIP exports
│
├── cache/
│   ├── tiles/
│   │   ├── terrain/                 # terrain-RGB: {z}/{x}/{y}.png
│   │   └── satellite/               # raster: {z}/{x}/{y}.png
│   └── trails/
│       └── <trail_id>/
│           ├── trail.geojson
│           ├── elevation.json
│           └── waypoints.json
│
├── hike3d.sqlite                    # SQLite database
├── .env                             # JWT_SECRET, PORT, tile URLs, API URLs
├── package.json                     # Root workspace (scripts: dev, build)
└── .gitignore                       # data/, cache/, hike3d.sqlite, .env
```

---

## 7. Dependency Budget

### Runtime Dependencies (target: <15)

| Package | Size (gzip) | Purpose |
|---|---|---|
| react | 45KB | UI framework |
| react-dom | 130KB | DOM rendering |
| maplibre-gl | 200KB | 3D terrain map |
| @deck.gl/core + layers + mapbox | 200KB | Trail/waypoint layers |
| express | 30KB | HTTP server |
| better-sqlite3 | native | SQLite driver |
| ws | 15KB | WebSocket server |
| jsonwebtoken | 20KB | JWT auth |
| uuid | 5KB | ID generation |
| fast-xml-parser | 40KB | GPX parsing |
| multer | 30KB | File uploads |
| cors | 5KB | CORS middleware |

**Total runtime deps: 12.** Under budget.

### Dev Dependencies

| Package | Purpose |
|---|---|
| vite | Build + HMR |
| @vitejs/plugin-react | JSX transform |
| tailwindcss + postcss + autoprefixer | Styling |
| nodemon | Server auto-restart |

**Total dev deps: 6.**

---

*End of technical plan.*
