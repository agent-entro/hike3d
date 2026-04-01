/**
 * Tests for the tile proxy route (server/routes/tiles.js).
 *
 * Tests the Express endpoints using supertest against an in-process server.
 * Upstream fetch calls are intercepted by mocking global fetch.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import express from 'express';
import request from 'supertest';
import { tilesRouter } from '../server/routes/tiles.js';

// A minimal 1×1 transparent PNG (68 bytes)
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000000200e221bc330000000049454e44ae426082',
  'hex'
);

/** Build a fake successful fetch response returning TINY_PNG */
function fakeFetchOk() {
  return async (_url, _opts) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
  });
}

describe('GET /tiles/terrain/:z/:x/:y', () => {
  let app;
  let tmpDir;
  let originalFetch;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hike3d-terrain-'));
    const cacheBase = path.join(tmpDir, 'cache', 'tiles');
    fs.mkdirSync(cacheBase, { recursive: true });

    app = express();
    app.use('/tiles', tilesRouter({ cacheBase }));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = fakeFetchOk();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns 200 with image/png content-type on cache miss', async () => {
    const res = await request(app).get('/tiles/terrain/5/10/15');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['x-tile-cache'], 'MISS');
    assert.equal(res.headers['cache-control'], 'public, max-age=86400');
  });

  test('returns 200 from cache on second request (HIT)', async () => {
    // First request seeds the cache
    await request(app).get('/tiles/terrain/5/10/15');
    // Second request should hit cache
    const res = await request(app).get('/tiles/terrain/5/10/15');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tile-cache'], 'HIT');
  });

  test('returns 400 for invalid z coordinate (too large)', async () => {
    const res = await request(app).get('/tiles/terrain/99/0/0');
    assert.equal(res.status, 400);
  });

  test('returns 400 for non-numeric tile coordinates', async () => {
    const res = await request(app).get('/tiles/terrain/abc/0/0');
    assert.equal(res.status, 400);
  });

  test('returns 400 when x is out of range for zoom level', async () => {
    // At z=0, only tile (0,0) is valid; x=1 is out of range
    const res = await request(app).get('/tiles/terrain/0/1/0');
    assert.equal(res.status, 400);
  });

  test('returns 502 when upstream fails', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    const res = await request(app).get('/tiles/terrain/6/20/25');
    assert.equal(res.status, 502);
  });
});

describe('GET /tiles/satellite/:z/:x/:y', () => {
  let app;
  let tmpDir;
  let originalFetch;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hike3d-satellite-'));
    const cacheBase = path.join(tmpDir, 'cache', 'tiles');
    fs.mkdirSync(cacheBase, { recursive: true });

    app = express();
    app.use('/tiles', tilesRouter({ cacheBase }));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = fakeFetchOk();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('satellite returns 200 with png on cache miss', async () => {
    const res = await request(app).get('/tiles/satellite/5/10/15');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['x-tile-cache'], 'MISS');
  });

  test('satellite returns HIT on second request', async () => {
    await request(app).get('/tiles/satellite/5/10/15');
    const res = await request(app).get('/tiles/satellite/5/10/15');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tile-cache'], 'HIT');
  });

  test('satellite returns 400 for invalid coords', async () => {
    const res = await request(app).get('/tiles/satellite/25/0/0');
    assert.equal(res.status, 400);
  });

  test('satellite returns 502 when upstream fails', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    const res = await request(app).get('/tiles/satellite/7/30/40');
    assert.equal(res.status, 502);
  });
});
