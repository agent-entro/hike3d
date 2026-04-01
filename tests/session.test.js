/**
 * Tests for session create/validate API endpoints.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import { sessionRouter } from '../server/routes/session.js';

/** Build a test Express app with an in-memory DB */
function buildTestApp() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/session', sessionRouter(db));

  return { app, db };
}

/**
 * Minimal fetch wrapper for testing (uses Node 24 built-in fetch).
 * Handles cookies via a simple jar.
 */
async function testRequest(app, method, path, { cookieJar = {}, body } = {}) {
  // Start server on random port
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const port = server.address().port;
  const cookieHeader = Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  const json = await res.json();

  await new Promise((resolve) => server.close(resolve));

  return { status: res.status, json, setCookie };
}

describe('POST /api/session/create', () => {
  test('returns 200 with session_id and expires_at', async () => {
    const { app } = buildTestApp();
    const { status, json } = await testRequest(app, 'POST', '/api/session/create');
    assert.equal(status, 200);
    assert.ok(json.session_id, 'should have session_id');
    assert.ok(json.expires_at > Date.now(), 'should expire in the future');
  });

  test('sets httpOnly cookie', async () => {
    const { app } = buildTestApp();
    const { setCookie } = await testRequest(app, 'POST', '/api/session/create');
    assert.ok(setCookie, 'should set a cookie');
    assert.ok(setCookie.includes('hike3d_session='), 'cookie should be hike3d_session');
    assert.ok(setCookie.toLowerCase().includes('httponly'), 'cookie should be httpOnly');
  });

  test('each call creates a unique session_id', async () => {
    const { app } = buildTestApp();
    const r1 = await testRequest(app, 'POST', '/api/session/create');
    const r2 = await testRequest(app, 'POST', '/api/session/create');
    assert.notEqual(r1.json.session_id, r2.json.session_id);
  });
});

describe('POST /api/session/validate', () => {
  test('returns 401 with no cookie', async () => {
    const { app } = buildTestApp();
    const { status } = await testRequest(app, 'POST', '/api/session/validate');
    assert.equal(status, 401);
  });

  test('validates a freshly created session', async () => {
    const { app } = buildTestApp();

    // Create session — extract cookie value
    const createRes = await testRequest(app, 'POST', '/api/session/create');
    assert.equal(createRes.status, 200);

    // Parse cookie from set-cookie header
    const cookieMatch = createRes.setCookie?.match(/hike3d_session=([^;]+)/);
    assert.ok(cookieMatch, 'should have parseable cookie');
    const cookieJar = { hike3d_session: cookieMatch[1] };

    const validateRes = await testRequest(app, 'POST', '/api/session/validate', { cookieJar });
    assert.equal(validateRes.status, 200);
    assert.equal(validateRes.json.session_id, createRes.json.session_id);
  });

  test('returns 401 for tampered token', async () => {
    const { app } = buildTestApp();
    const cookieJar = { hike3d_session: 'invalid.token.value' };
    const { status } = await testRequest(app, 'POST', '/api/session/validate', { cookieJar });
    assert.equal(status, 401);
  });
});
