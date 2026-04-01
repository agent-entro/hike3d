# hike3d: 3D Hiking Visualization App

A local-first web app for exploring hiking trails in 3D. Search for trails by name or area, view them rendered on a GPU-accelerated terrain mesh, and inspect elevation profiles — all running entirely on your machine with no cloud dependencies.

## Current Features (Phases 1–3)

- **Phase 1 — App skeleton**: Express API server + React/Vite client, SQLite database, session management via JWT cookies, tile proxy (satellite imagery + terrain-RGB elevation tiles cached locally).
- **Phase 2 — Trail search**: Search trails by name or location using OpenStreetMap's Overpass API and Nominatim geocoder. Results are cached in SQLite. Trail metadata (distance, elevation gain, difficulty) is fetched and stored per trail.
- **Phase 3 — 3D terrain & trail rendering**: Selected trails are rendered as a 3D polyline over a MapLibre GL terrain mesh (deck.gl `PathLayer`). An interactive elevation profile chart (Canvas 2D) syncs with the 3D camera position.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS 4 |
| 3D rendering | MapLibre GL JS + deck.gl |
| Backend | Node.js 20, Express 4 |
| Database | SQLite via better-sqlite3 |
| Tile data | OSM raster tiles + AWS Terrain-RGB (cached locally) |
| Elevation data | OpenTopoData (SRTM 30m, cached in SQLite) |

## Setup

### Prerequisites

- Node.js 20 LTS or newer
- npm 9+

### 1. Clone the repository

```bash
git clone https://github.com/agent-entro/hike3d.git
cd hike3d
```

### 2. Install dependencies

Install root (server) dependencies and client dependencies:

```bash
npm install
cd client && npm install && cd ..
```

### 3. Environment variables

The server reads a few optional variables. No API keys are required — all external data comes from free, public endpoints.

Create a `.env` file in the **repo root** if you want to override defaults:

```bash
# .env (optional — defaults shown)
PORT=3000
DB_PATH=./hike3d.sqlite
CLIENT_ORIGIN=http://localhost:5173
```

The client reads one variable for build versioning (already set for dev):

```bash
# client/.env (already committed with a safe default)
VITE_BUILD_HASH=dev
```

No MapTiler or other paid API key is needed. Tile data is fetched from public OSM and AWS terrain tile endpoints and cached locally under `cache/`.

### 4. Start development servers

```bash
npm run dev
```

This starts both servers concurrently:
- **API server** → `http://localhost:3000`
- **Vite dev server** → `http://localhost:5173` (open this in your browser)

The Vite server proxies `/api/*` and `/tiles/*` to the Express backend automatically.

## Usage

1. Open `http://localhost:5173` in your browser.
2. Type a trail name or location in the search panel (e.g. "Yosemite Falls Trail").
3. Click a result to load the trail — it renders as a 3D polyline over the terrain mesh.
4. Hover the elevation profile chart to fly the camera along the trail.

## Running Tests

```bash
npm test
```

Runs server-side Jest tests under `server/`.

## Project Structure

```
hike3d/
├── client/          # React + Vite frontend
│   └── src/
│       ├── components/
│       │   ├── SearchPanel.jsx     # Trail search UI
│       │   ├── Viewport3D.jsx      # MapLibre GL + deck.gl 3D view
│       │   └── ElevationProfile.jsx# Canvas elevation chart
│       └── hooks/                  # Shared React hooks
├── server/          # Express API server
│   ├── routes/      # /api/trails, /api/gpx, /api/session, /tiles
│   ├── services/    # Overpass, Nominatim, OpenTopoData clients
│   └── db/          # SQLite schema + migrations
├── cache/           # Local tile cache (auto-created)
├── data/            # Uploaded GPX files (auto-created)
└── hike3d.sqlite    # SQLite database (auto-created on first run)
```

## Planned Features

The following phases are in the roadmap but not yet implemented:

- **Phase 4 — Flythrough mode**: Animated camera flight along the trail path with configurable speed and perspective.
- **Phase 5 — GPX import**: Upload your own GPX tracks and visualize them alongside searched trails.
- **Phase 6 — Offline mode**: Service worker tile caching so previously viewed trails work without internet.
- **Phase 7 — Polish**: Waypoint markers, difficulty badges, saved trails list, dark mode, mobile layout.
