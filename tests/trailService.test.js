/**
 * Tests for trailService.js — computeStats and extractWaypoints (no API calls).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';
import { computeStats, extractWaypoints } from '../server/services/trailService.js';

// --- computeStats ---

describe('computeStats', () => {
  test('returns zeros for empty profile', () => {
    const stats = computeStats([]);
    assert.equal(stats.distance_m, 0);
    assert.equal(stats.elevation_gain_m, 0);
    assert.equal(stats.elevation_loss_m, 0);
    assert.equal(stats.max_elev_m, 0);
    assert.equal(stats.min_elev_m, 0);
    assert.equal(stats.difficulty, 'easy');
  });

  test('flat trail: no gain or loss', () => {
    const profile = [
      { lat: 37.0, lon: -122.0, elevation_m: 100 },
      { lat: 37.001, lon: -122.0, elevation_m: 100 },
      { lat: 37.002, lon: -122.0, elevation_m: 100 },
    ];
    const stats = computeStats(profile);
    assert.equal(stats.elevation_gain_m, 0);
    assert.equal(stats.elevation_loss_m, 0);
    assert.equal(stats.max_elev_m, 100);
    assert.equal(stats.min_elev_m, 100);
    assert.ok(stats.distance_m > 0, 'should have positive distance');
  });

  test('uphill trail: gain equals total rise', () => {
    const profile = [
      { lat: 37.0, lon: -122.0, elevation_m: 0 },
      { lat: 37.01, lon: -122.0, elevation_m: 500 },
    ];
    const stats = computeStats(profile);
    assert.equal(stats.elevation_gain_m, 500);
    assert.equal(stats.elevation_loss_m, 0);
    assert.equal(stats.max_elev_m, 500);
    assert.equal(stats.min_elev_m, 0);
  });

  test('downhill trail: loss equals total drop', () => {
    const profile = [
      { lat: 37.0, lon: -122.0, elevation_m: 800 },
      { lat: 37.01, lon: -122.0, elevation_m: 300 },
    ];
    const stats = computeStats(profile);
    assert.equal(stats.elevation_gain_m, 0);
    assert.equal(stats.elevation_loss_m, 500);
  });

  test('up-and-down trail: gain and loss tracked separately', () => {
    const profile = [
      { lat: 37.00, lon: -122.0, elevation_m: 0 },
      { lat: 37.01, lon: -122.0, elevation_m: 400 },
      { lat: 37.02, lon: -122.0, elevation_m: 200 },
    ];
    const stats = computeStats(profile);
    assert.equal(stats.elevation_gain_m, 400);
    assert.equal(stats.elevation_loss_m, 200);
    assert.equal(stats.max_elev_m, 400);
    assert.equal(stats.min_elev_m, 0);
  });

  test('difficulty: easy for flat/gentle trail', () => {
    // Very long flat profile → near 0 gain/km → easy
    const profile = Array.from({ length: 10 }, (_, i) => ({
      lat: 37.0 + i * 0.01,
      lon: -122.0,
      elevation_m: 10, // minimal gain
    }));
    const stats = computeStats(profile);
    assert.equal(stats.difficulty, 'easy');
  });

  test('difficulty: expert for very steep trail', () => {
    // 2km, 1500m gain → 750m/km → expert
    const profile = [
      { lat: 37.0, lon: -122.0, elevation_m: 0 },
      { lat: 37.018, lon: -122.0, elevation_m: 1500 }, // ~2km
    ];
    const stats = computeStats(profile);
    assert.equal(stats.difficulty, 'expert');
  });

  test('distance is computed using haversine', () => {
    // 1 degree of latitude ≈ 111,000m
    const profile = [
      { lat: 0.0, lon: 0.0, elevation_m: 0 },
      { lat: 1.0, lon: 0.0, elevation_m: 0 },
    ];
    const stats = computeStats(profile);
    // Should be approximately 111km
    assert.ok(stats.distance_m > 110_000 && stats.distance_m < 113_000,
      `Expected ~111km, got ${stats.distance_m}m`);
  });
});

// --- extractWaypoints ---

describe('extractWaypoints', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Insert a trail to satisfy FK constraint
    db.prepare(`
      INSERT INTO trails (id, name, source, geojson, created_at, updated_at)
      VALUES ('trail-1', 'Test Trail', 'osm', '{}', 0, 0)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  test('inserts trailhead and trail-end waypoints for simple coords', () => {
    const relation = {
      id: 1,
      type: 'relation',
      members: [],
      tags: {},
    };
    const coords = [
      [-122.0, 37.0],
      [-122.1, 37.1],
      [-122.2, 37.2],
    ];
    const osmData = { relation, ways: new Map(), nodes: new Map() };

    extractWaypoints(osmData, 'trail-1', coords, db);

    const wps = db.prepare('SELECT * FROM waypoints WHERE trail_id = ?').all('trail-1');
    assert.ok(wps.length >= 2, 'should have at least trailhead + trail end');

    const trailhead = wps.find((w) => w.type === 'trailhead');
    assert.ok(trailhead, 'should have a trailhead waypoint');
    assert.equal(trailhead.name, 'Trailhead');
    assert.equal(trailhead.dist_from_start_m, 0);
    assert.equal(trailhead.source, 'system');
  });

  test('inserts OSM-tagged node waypoints', () => {
    const relation = {
      id: 2,
      type: 'relation',
      members: [{ type: 'node', ref: 99, role: 'summit' }],
      tags: {},
    };
    const nodes = new Map([
      [99, { lat: 37.15, lon: -122.15, tags: { natural: 'peak', name: 'Test Peak' } }],
    ]);
    const coords = [[-122.0, 37.0], [-122.2, 37.2]];
    const osmData = { relation, ways: new Map(), nodes };

    extractWaypoints(osmData, 'trail-1', coords, db);

    const wps = db.prepare('SELECT * FROM waypoints WHERE trail_id = ?').all('trail-1');
    const summit = wps.find((w) => w.type === 'summit');
    assert.ok(summit, 'should have summit waypoint');
    assert.equal(summit.name, 'Test Peak');
  });

  test('is idempotent with INSERT OR IGNORE', () => {
    const relation = { id: 3, type: 'relation', members: [], tags: {} };
    const coords = [[-122.0, 37.0], [-122.1, 37.1]];
    const osmData = { relation, ways: new Map(), nodes: new Map() };

    extractWaypoints(osmData, 'trail-1', coords, db);
    // Running twice should not throw (INSERT OR IGNORE handles duplicates by UUID)
    assert.doesNotThrow(() => {
      extractWaypoints(osmData, 'trail-1', coords, db);
    });
  });
});
