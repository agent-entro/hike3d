-- Migration 002: Extend gpx_tracks with track name and raw point JSON.
-- track_name: the <name> element from the GPX <trk> (nullable — some files omit it).
-- raw_json: JSON array of {lat, lon, ele, time} for the downsampled track.
--           Stored here so we can export GPX without re-reading the original file.

ALTER TABLE gpx_tracks ADD COLUMN track_name TEXT;
ALTER TABLE gpx_tracks ADD COLUMN raw_json TEXT;
