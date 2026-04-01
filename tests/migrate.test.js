/**
 * Tests for the migration runner and database schema.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';

describe('Migration Runner', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  test('creates schema_version table on first run', () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .all();
    assert.equal(tables.length, 1, 'schema_version table should exist');
  });

  test('creates all 6 domain tables', () => {
    runMigrations(db);
    const expected = [
      'user_sessions',
      'trails',
      'saved_trails',
      'gpx_tracks',
      'waypoints',
      'gps_sessions',
    ];
    for (const tableName of expected) {
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .all(tableName);
      assert.equal(rows.length, 1, `Table '${tableName}' should exist`);
    }
  });

  test('records migration in schema_version', () => {
    runMigrations(db);
    const rows = db.prepare('SELECT filename FROM schema_version ORDER BY filename').all();
    assert.ok(rows.length >= 1, 'At least one migration should be recorded');
    assert.ok(rows[0].filename.endsWith('.sql'), 'Filename should end with .sql');
  });

  test('is idempotent — running twice does not error', () => {
    runMigrations(db);
    // Running again should skip already-applied migrations silently
    assert.doesNotThrow(() => runMigrations(db));
  });

  test('schema_version tracks applied_at timestamp', () => {
    const before = Date.now();
    runMigrations(db);
    const after = Date.now();
    const rows = db.prepare('SELECT applied_at FROM schema_version').all();
    for (const row of rows) {
      assert.ok(row.applied_at >= before, 'applied_at should be >= before');
      assert.ok(row.applied_at <= after, 'applied_at should be <= after');
    }
  });
});

describe('Schema Integrity', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test('can insert a user_session', () => {
    db.prepare(`
      INSERT INTO user_sessions (id, jwt_secret, created_at, last_active_at, expires_at)
      VALUES ('test-uuid', 'secret', 0, 0, 9999999999999)
    `).run();
    const row = db.prepare('SELECT id FROM user_sessions WHERE id = ?').get('test-uuid');
    assert.equal(row.id, 'test-uuid');
  });

  test('can insert a trail and saved_trail', () => {
    const sessionId = 'sess-1';
    const trailId = 'trail-1';

    db.prepare(`
      INSERT INTO user_sessions (id, jwt_secret, created_at, last_active_at, expires_at)
      VALUES (?, 'secret', 0, 0, 9999999999999)
    `).run(sessionId);

    db.prepare(`
      INSERT INTO trails (id, name, source, geojson, created_at, updated_at)
      VALUES (?, 'Test Trail', 'osm', '{}', 0, 0)
    `).run(trailId);

    db.prepare(`
      INSERT INTO saved_trails (id, session_id, trail_id, saved_at)
      VALUES ('st-1', ?, ?, 0)
    `).run(sessionId, trailId);

    const row = db.prepare('SELECT * FROM saved_trails WHERE id = ?').get('st-1');
    assert.equal(row.session_id, sessionId);
    assert.equal(row.trail_id, trailId);
    assert.equal(row.cache_status, 'none');
  });

  test('saved_trails UNIQUE constraint prevents duplicate saves', () => {
    const sessionId = 'sess-2';
    const trailId = 'trail-2';

    db.prepare(`
      INSERT INTO user_sessions (id, jwt_secret, created_at, last_active_at, expires_at)
      VALUES (?, 'secret', 0, 0, 9999999999999)
    `).run(sessionId);

    db.prepare(`
      INSERT INTO trails (id, name, source, geojson, created_at, updated_at)
      VALUES (?, 'Trail 2', 'osm', '{}', 0, 0)
    `).run(trailId);

    db.prepare(`
      INSERT INTO saved_trails (id, session_id, trail_id, saved_at)
      VALUES ('st-a', ?, ?, 0)
    `).run(sessionId, trailId);

    assert.throws(() => {
      db.prepare(`
        INSERT INTO saved_trails (id, session_id, trail_id, saved_at)
        VALUES ('st-b', ?, ?, 0)
      `).run(sessionId, trailId);
    }, /UNIQUE constraint failed/i);
  });

  test('CASCADE delete: removing session removes saved_trails', () => {
    const sessionId = 'sess-3';
    const trailId = 'trail-3';

    db.prepare(`
      INSERT INTO user_sessions (id, jwt_secret, created_at, last_active_at, expires_at)
      VALUES (?, 'secret', 0, 0, 9999999999999)
    `).run(sessionId);

    db.prepare(`
      INSERT INTO trails (id, name, source, geojson, created_at, updated_at)
      VALUES (?, 'Trail 3', 'osm', '{}', 0, 0)
    `).run(trailId);

    db.prepare(`
      INSERT INTO saved_trails (id, session_id, trail_id, saved_at)
      VALUES ('st-c', ?, ?, 0)
    `).run(sessionId, trailId);

    db.prepare('DELETE FROM user_sessions WHERE id = ?').run(sessionId);

    const rows = db.prepare('SELECT * FROM saved_trails WHERE session_id = ?').all(sessionId);
    assert.equal(rows.length, 0, 'saved_trails should be cascade-deleted');
  });
});
