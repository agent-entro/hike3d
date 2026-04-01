-- Migration 001: Create all core tables with indexes
-- Enable WAL mode for concurrent read performance (set at runtime, not here)

-- Anonymous user sessions with per-session JWT secrets
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,                     -- UUIDv4
    display_name TEXT,                       -- nullable, user-set name
    jwt_secret TEXT NOT NULL,                -- 32-byte hex, per-session
    created_at INTEGER NOT NULL,             -- Unix epoch ms
    last_active_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- Hiking trail records: both OSM-sourced and GPX-imported
CREATE TABLE IF NOT EXISTS trails (
    id TEXT PRIMARY KEY,                     -- UUIDv4
    name TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('osm', 'gpx')),
    osm_relation_id TEXT,                    -- nullable, only for source='osm'
    country_code TEXT,
    region TEXT,
    geojson TEXT NOT NULL,                   -- serialized GeoJSON LineString
    elevation_profile TEXT,                  -- JSON array of {lat, lon, elevation_m}
    distance_m REAL,
    elevation_gain_m REAL,
    elevation_loss_m REAL,
    max_elev_m REAL,
    min_elev_m REAL,
    difficulty TEXT,                         -- 'easy'|'moderate'|'hard'|'expert'
    surface TEXT,
    tags TEXT,                               -- JSON object of OSM tags
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trails_source ON trails(source);
CREATE INDEX IF NOT EXISTS idx_trails_name ON trails(name);
CREATE INDEX IF NOT EXISTS idx_trails_osm_relation ON trails(osm_relation_id) WHERE osm_relation_id IS NOT NULL;

-- Junction: a session has saved a trail (with optional offline caching)
CREATE TABLE IF NOT EXISTS saved_trails (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
    trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
    nickname TEXT,
    notes TEXT,
    cache_status TEXT NOT NULL DEFAULT 'none' CHECK(cache_status IN ('none', 'pending', 'cached', 'error')),
    cache_path TEXT,                         -- filesystem path to cached data dir
    saved_at INTEGER NOT NULL,
    UNIQUE(session_id, trail_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_trails_session ON saved_trails(session_id);
CREATE INDEX IF NOT EXISTS idx_saved_trails_trail ON saved_trails(trail_id);

-- GPX file imports (separate from trails table, holds raw file metadata)
CREATE TABLE IF NOT EXISTS gpx_tracks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
    trail_id TEXT REFERENCES trails(id) ON DELETE SET NULL,
    original_filename TEXT NOT NULL,
    file_path TEXT NOT NULL,                 -- path under /data/gpx/
    point_count INTEGER NOT NULL DEFAULT 0,
    has_elevation INTEGER NOT NULL DEFAULT 0,  -- boolean: 1/0
    start_lat REAL,
    start_lon REAL,
    end_lat REAL,
    end_lon REAL,
    imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gpx_tracks_session ON gpx_tracks(session_id);

-- User-placed and system waypoints
CREATE TABLE IF NOT EXISTS waypoints (
    id TEXT PRIMARY KEY,
    trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES user_sessions(id) ON DELETE CASCADE,  -- null = system/OSM
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'generic',    -- 'trailhead'|'summit'|'water'|'shelter'|'user'|'generic'
    source TEXT NOT NULL DEFAULT 'system'    CHECK(source IN ('osm', 'system', 'user')),
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    elev_m REAL,
    dist_from_start_m REAL,
    notes TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waypoints_trail ON waypoints(trail_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_session ON waypoints(session_id) WHERE session_id IS NOT NULL;

-- Live GPS companion sessions (hiking companion phone sends fixes at 1Hz)
CREATE TABLE IF NOT EXISTS gps_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
    trail_id TEXT REFERENCES trails(id),     -- nullable: may hike without selected trail
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    track_points TEXT,                       -- JSON array of {lat, lon, ele, t} — denormalized
    distance_m REAL,
    duration_s REAL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed'))
);

CREATE INDEX IF NOT EXISTS idx_gps_sessions_session ON gps_sessions(session_id);
