/**
 * Tests for elevationService.js — LRU cache and SQLite caching.
 * External API calls are not tested here (no mocking infrastructure).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';
import {
  getCachedElevationProfile,
  saveElevationProfile,
  getLruCacheSize,
  clearLruCache,
} from '../server/services/elevationService.js';

describe('LRU cache', () => {
  beforeEach(() => {
    clearLruCache();
  });

  test('starts empty', () => {
    assert.equal(getLruCacheSize(), 0);
  });

  test('clearLruCache resets size to 0', () => {
    clearLruCache();
    assert.equal(getLruCacheSize(), 0);
  });
});

describe('SQLite elevation profile cache', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    db.prepare(`
      INSERT INTO trails (id, name, source, geojson, created_at, updated_at)
      VALUES ('trail-1', 'Test Trail', 'osm', '{}', 0, 0)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  test('getCachedElevationProfile returns null when no profile stored', () => {
    const result = getCachedElevationProfile(db, 'trail-1');
    assert.equal(result, null);
  });

  test('getCachedElevationProfile returns null for unknown trail', () => {
    const result = getCachedElevationProfile(db, 'nonexistent');
    assert.equal(result, null);
  });

  test('saveElevationProfile then getCachedElevationProfile returns the profile', () => {
    const profile = [
      { lat: 37.0, lon: -122.0, elevation_m: 100 },
      { lat: 37.1, lon: -122.1, elevation_m: 200 },
    ];

    saveElevationProfile(db, 'trail-1', profile);
    const retrieved = getCachedElevationProfile(db, 'trail-1');

    assert.ok(retrieved, 'should return a profile');
    assert.equal(retrieved.length, 2);
    assert.equal(retrieved[0].elevation_m, 100);
    assert.equal(retrieved[1].elevation_m, 200);
    assert.equal(retrieved[0].lat, 37.0);
  });

  test('saveElevationProfile updates updated_at', () => {
    const before = Date.now();
    const profile = [{ lat: 37.0, lon: -122.0, elevation_m: 50 }];
    saveElevationProfile(db, 'trail-1', profile);
    const after = Date.now();

    const row = db.prepare('SELECT updated_at FROM trails WHERE id = ?').get('trail-1');
    assert.ok(row.updated_at >= before, 'updated_at should be >= before');
    assert.ok(row.updated_at <= after, 'updated_at should be <= after');
  });

  test('getCachedElevationProfile handles malformed JSON gracefully', () => {
    db.prepare('UPDATE trails SET elevation_profile = ? WHERE id = ?')
      .run('not-valid-json', 'trail-1');

    const result = getCachedElevationProfile(db, 'trail-1');
    assert.equal(result, null);
  });
});
