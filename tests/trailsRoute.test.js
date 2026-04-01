/**
 * Tests for GET /api/trails/search and GET /api/trails/:id routes.
 * searchAndBuild is mocked to avoid hitting external APIs.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';
import express from 'express';
import { trailsRouter } from '../server/routes/trails.js';
import { v4 as uuidv4 } from 'uuid';

// Minimal HTTP test helper
async function req(app, method, path, opts = {}) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  await new Promise((resolve) => server.close(resolve));
  return { status: res.status, json };
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/trails', trailsRouter(db));
  return app;
}

function seedTrail(db, overrides = {}) {
  const id = uuidv4();
  const now = Date.now();
  const trail = {
    id,
    name: 'Test Trail',
    source: 'osm',
    osm_relation_id: '123456',
    country_code: 'US',
    region: null,
    geojson: JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }),
    elevation_profile: JSON.stringify([{ lat: 37.0, lon: -122.0, elevation_m: 100 }]),
    distance_m: 5000,
    elevation_gain_m: 200,
    elevation_loss_m: 150,
    max_elev_m: 500,
    min_elev_m: 300,
    difficulty: 'moderate',
    surface: 'dirt',
    tags: JSON.stringify({ route: 'hiking' }),
    created_at: now,
    updated_at: now,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO trails
      (id, name, source, osm_relation_id, country_code, region, geojson,
       elevation_profile, distance_m, elevation_gain_m, elevation_loss_m,
       max_elev_m, min_elev_m, difficulty, surface, tags, created_at, updated_at)
    VALUES
      (@id, @name, @source, @osm_relation_id, @country_code, @region, @geojson,
       @elevation_profile, @distance_m, @elevation_gain_m, @elevation_loss_m,
       @max_elev_m, @min_elev_m, @difficulty, @surface, @tags, @created_at, @updated_at)
  `).run(trail);

  return trail;
}

// --- Tests ---

describe('GET /api/trails/:id', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test('returns 400 for non-UUID id', async () => {
    const app = buildApp(db);
    const { status } = await req(app, 'GET', '/api/trails/not-a-uuid');
    assert.equal(status, 400);
  });

  test('returns 404 for unknown trail id', async () => {
    const app = buildApp(db);
    const { status } = await req(app, 'GET', `/api/trails/${uuidv4()}`);
    assert.equal(status, 404);
  });

  test('returns 200 with trail data for known id', async () => {
    const trail = seedTrail(db);
    const app = buildApp(db);
    const { status, json } = await req(app, 'GET', `/api/trails/${trail.id}`);

    assert.equal(status, 200);
    assert.equal(json.id, trail.id);
    assert.equal(json.name, 'Test Trail');
    assert.equal(json.difficulty, 'moderate');
    assert.equal(json.distance_m, 5000);
  });

  test('returns parsed geojson object (not string)', async () => {
    const trail = seedTrail(db);
    const app = buildApp(db);
    const { json } = await req(app, 'GET', `/api/trails/${trail.id}`);

    assert.equal(typeof json.geojson, 'object', 'geojson should be parsed object');
    assert.equal(json.geojson?.type, 'Feature');
  });

  test('returns parsed elevation_profile array', async () => {
    const trail = seedTrail(db);
    const app = buildApp(db);
    const { json } = await req(app, 'GET', `/api/trails/${trail.id}`);

    assert.ok(Array.isArray(json.elevation_profile), 'elevation_profile should be array');
    assert.equal(json.elevation_profile.length, 1);
    assert.equal(json.elevation_profile[0].elevation_m, 100);
  });

  test('returns waypoints array (empty if none)', async () => {
    const trail = seedTrail(db);
    const app = buildApp(db);
    const { json } = await req(app, 'GET', `/api/trails/${trail.id}`);

    assert.ok(Array.isArray(json.waypoints), 'waypoints should be array');
    assert.equal(json.waypoints.length, 0);
  });

  test('returns waypoints when they exist', async () => {
    const trail = seedTrail(db);
    db.prepare(`
      INSERT INTO waypoints (id, trail_id, name, type, source, lat, lon, created_at)
      VALUES (?, ?, 'Summit', 'summit', 'osm', 37.5, -122.5, ?)
    `).run(uuidv4(), trail.id, Date.now());

    const app = buildApp(db);
    const { json } = await req(app, 'GET', `/api/trails/${trail.id}`);
    assert.equal(json.waypoints.length, 1);
    assert.equal(json.waypoints[0].name, 'Summit');
  });
});

describe('GET /api/trails/search', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test('returns 400 when ?q is missing', async () => {
    const app = buildApp(db);
    const { status, json } = await req(app, 'GET', '/api/trails/search');
    assert.equal(status, 400);
    assert.ok(json.error);
  });

  test('returns 400 when ?q is too short', async () => {
    const app = buildApp(db);
    const { status } = await req(app, 'GET', '/api/trails/search?q=a');
    assert.equal(status, 400);
  });
});
