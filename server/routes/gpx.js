/**
 * GPX routes: import GPX files, export trail as GPX.
 *
 * POST /api/gpx/import  — multipart upload, max 10 MB (enforced by multer +
 *                         express.raw limit). Parses GPX, inserts track data,
 *                         saves raw file to /data/gpx/<uuid>.gpx
 *
 * GET  /api/gpx/export/:trail_id — streams a synthesised GPX file from the
 *                                  stored trail geometry + elevation data.
 */

import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import { XMLParser } from 'fast-xml-parser';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the GPX data directory */
const GPX_DIR = resolve(__dirname, '..', '..', 'data', 'gpx');

/** Maximum upload size enforced at every layer */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Ensure data directory exists at startup
if (!existsSync(GPX_DIR)) {
  mkdirSync(GPX_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Multer: memory storage, hard 10 MB limit
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    if (
      file.mimetype === 'application/gpx+xml' ||
      file.mimetype === 'application/xml' ||
      file.mimetype === 'text/xml' ||
      file.originalname.toLowerCase().endsWith('.gpx')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only .gpx files are accepted'));
    }
  },
});

// ---------------------------------------------------------------------------
// GPX parse helpers
// ---------------------------------------------------------------------------
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
});

/**
 * Extract track points from parsed GPX object.
 * Handles both single-segment and multi-segment tracks.
 *
 * @param {object} gpxObj  Result of fast-xml-parser on a GPX document
 * @returns {{ name: string, points: Array<{ lat, lon, ele, time }> }[]}
 */
function extractTracks(gpxObj) {
  const gpx = gpxObj?.gpx;
  if (!gpx) throw new Error('Missing <gpx> root element');

  const rawTracks = gpx.trk
    ? Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk]
    : [];

  return rawTracks.map((trk) => {
    const name = trk.name ?? 'Unnamed Track';
    const rawSegs = trk.trkseg
      ? Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg]
      : [];

    const points = rawSegs.flatMap((seg) => {
      const rawPts = seg.trkpt
        ? Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt]
        : [];
      return rawPts.map((pt) => ({
        lat: Number(pt['@_lat']),
        lon: Number(pt['@_lon']),
        ele: Number(pt.ele ?? 0),
        time: pt.time ?? null,
      }));
    });

    return { name, points };
  });
}

/**
 * Simple Douglas-Peucker downsampler — keeps at most `maxPoints` points
 * using uniform stride when the track is over the limit.
 *
 * @param {Array<object>} points
 * @param {number} maxPoints
 */
function downsample(points, maxPoints = 5000) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  return points.filter((_, i) => i % stride === 0);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Router}
 */
export function gpxRouter(db) {
  const router = Router();

  // ------------------------------------------------------------------
  // POST /api/gpx/import
  // Accepts multipart/form-data with a single `file` field.
  // Also accepts application/octet-stream or text/xml as raw body via the
  // express.raw middleware (for programmatic clients that skip multipart).
  // ------------------------------------------------------------------
  router.post(
    '/import',
    // Raw body fallback for clients that POST the file as a plain body
    express.raw({ type: ['application/gpx+xml', 'application/xml', 'text/xml'], limit: '10mb' }),
    upload.single('file'),
    async (req, res) => {
      try {
        // Determine GPX content regardless of how it was sent
        let gpxBuffer;
        if (req.file) {
          gpxBuffer = req.file.buffer;          // multer multipart
        } else if (Buffer.isBuffer(req.body)) {
          gpxBuffer = req.body;                 // express.raw
        } else {
          return res.status(400).json({ error: 'No GPX file provided. Send as multipart field "file" or as raw body.' });
        }

        // Enforce size limit for raw-body path (multer already handles multipart)
        if (gpxBuffer.byteLength > MAX_UPLOAD_BYTES) {
          return res.status(413).json({
            error: `GPX file too large. Maximum size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
          });
        }

        const gpxText = gpxBuffer.toString('utf-8');

        // Parse XML
        let parsed;
        try {
          parsed = xmlParser.parse(gpxText);
        } catch (xmlErr) {
          return res.status(422).json({ error: `Invalid XML: ${xmlErr.message}` });
        }

        let tracks;
        try {
          tracks = extractTracks(parsed);
        } catch (gpxErr) {
          return res.status(422).json({ error: gpxErr.message });
        }

        if (tracks.length === 0) {
          return res.status(422).json({ error: 'GPX file contains no tracks (<trk> elements).' });
        }

        // Downsample to ≤5 000 points to guard against ultra-marathon recordings
        const processedTracks = tracks.map((t) => ({
          ...t,
          points: downsample(t.points),
        }));

        // Persist raw file
        const fileId = uuidv4();
        const filePath = resolve(GPX_DIR, `${fileId}.gpx`);
        writeFileSync(filePath, gpxBuffer);

        // Insert into DB (gpx_tracks — 001 schema + 002 extensions)
        // session_id NOT NULL: fall back to a sentinel when no session exists
        const sessionId = req.session?.id ?? 'anonymous';
        const originalFilename = req.file?.originalname ?? 'upload.gpx';
        const now = Date.now();

        const insertTrack = db.prepare(`
          INSERT INTO gpx_tracks
            (id, session_id, original_filename, file_path, track_name,
             point_count, has_elevation, raw_json, imported_at)
          VALUES
            (@id, @session_id, @original_filename, @file_path, @track_name,
             @point_count, @has_elevation, @raw_json, @imported_at)
        `);

        const insertedIds = processedTracks.map((track) => {
          const id = uuidv4();
          const hasElevation = track.points.some((p) => p.ele !== 0) ? 1 : 0;
          insertTrack.run({
            id,
            session_id: sessionId,
            original_filename: originalFilename,
            file_path: filePath,
            track_name: track.name,
            point_count: track.points.length,
            has_elevation: hasElevation,
            raw_json: JSON.stringify(track.points),
            imported_at: now,
          });
          return { id, name: track.name, point_count: track.points.length };
        });

        res.status(201).json({
          ok: true,
          file_id: fileId,
          tracks: insertedIds,
        });
      } catch (err) {
        console.error('[gpx/import]', err);
        res.status(500).json({ error: 'Failed to import GPX file' });
      }
    }
  );

  // ------------------------------------------------------------------
  // GET /api/gpx/export/:track_id
  // Generates a GPX XML document from stored track data and streams it.
  // ------------------------------------------------------------------
  router.get('/export/:track_id', (req, res) => {
    try {
      const { track_id } = req.params;
      if (!/^[0-9a-f-]{36}$/.test(track_id)) {
        return res.status(400).json({ error: 'Invalid track ID format' });
      }

      const getTrack = db.prepare('SELECT * FROM gpx_tracks WHERE id = ?');
      const track = getTrack.get(track_id);
      if (!track) {
        return res.status(404).json({ error: 'Track not found' });
      }

      const points = JSON.parse(track.raw_json);
      const trkpts = points
        .map(
          (p) =>
            `    <trkpt lat="${p.lat}" lon="${p.lon}">` +
            `<ele>${p.ele}</ele>` +
            (p.time ? `<time>${p.time}</time>` : '') +
            `</trkpt>`
        )
        .join('\n');

      const gpxXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="hike3d" xmlns="http://www.topografix.com/GPX/1/1">',
        `  <trk><name>${escapeXml(track.track_name)}</name>`,
        '  <trkseg>',
        trkpts,
        '  </trkseg></trk>',
        '</gpx>',
      ].join('\n');

      res.setHeader('Content-Type', 'application/gpx+xml');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${track.track_name.replace(/[^a-z0-9]/gi, '_')}.gpx"`
      );
      res.send(gpxXml);
    } catch (err) {
      console.error('[gpx/export]', err);
      res.status(500).json({ error: 'Failed to export GPX' });
    }
  });

  return router;
}

/** Minimal XML escaping for attribute/text content */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
