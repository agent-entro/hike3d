/**
 * Tests for osmService.js — GeoJSON building and helper functions.
 * We test buildGeoJSON and extractTaggedNodes without hitting external APIs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeoJSON, extractTaggedNodes } from '../server/services/osmService.js';

// --- Helpers to build fake Overpass data ---

function makeNode(id, lat, lon, tags = {}) {
  return { id, lat, lon, tags };
}

function makeWay(id, nodeIds, tags = {}) {
  return { id, nodes: nodeIds, tags };
}

function makeRelation(id, memberWayIds, tags = {}) {
  return {
    id,
    type: 'relation',
    members: memberWayIds.map((wid) => ({ type: 'way', ref: wid, role: '' })),
    tags,
  };
}

function buildOsmData(relation, waysArr, nodesArr) {
  const ways = new Map(waysArr.map((w) => [w.id, { nodes: w.nodes, tags: w.tags }]));
  const nodes = new Map(nodesArr.map((n) => [n.id, { lat: n.lat, lon: n.lon, tags: n.tags }]));
  return { relation, ways, nodes };
}

// --- buildGeoJSON tests ---

describe('buildGeoJSON', () => {
  test('returns null for relation with no way members', () => {
    const relation = { id: 1, members: [], tags: { name: 'Empty Trail' } };
    const osmData = buildOsmData(relation, [], []);
    const result = buildGeoJSON(osmData);
    assert.equal(result, null);
  });

  test('returns null when way refs not in ways map', () => {
    const relation = makeRelation(1, [999]);
    const osmData = buildOsmData(relation, [], []);
    const result = buildGeoJSON(osmData);
    assert.equal(result, null);
  });

  test('builds a simple two-node LineString from one way', () => {
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);
    const w1 = makeWay(10, [1, 2]);
    const rel = makeRelation(100, [10], { name: 'Simple Trail' });
    const osmData = buildOsmData(rel, [w1], [n1, n2]);

    const result = buildGeoJSON(osmData);
    assert.ok(result, 'should return a feature');
    assert.equal(result.type, 'Feature');
    assert.equal(result.geometry.type, 'LineString');
    assert.equal(result.geometry.coordinates.length, 2);
    assert.deepEqual(result.geometry.coordinates[0], [-122.0, 37.0]);
    assert.deepEqual(result.geometry.coordinates[1], [-122.1, 37.1]);
    assert.equal(result.properties.name, 'Simple Trail');
    assert.equal(result.properties.osm_relation_id, '100');
  });

  test('stitches two sequential ways into one LineString', () => {
    // Way A: node 1 → 2 (ends at lon=-122.1)
    // Way B: node 2 → 3 (starts at lon=-122.1)
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);
    const n3 = makeNode(3, 37.2, -122.2);
    const wA = makeWay(10, [1, 2]);
    const wB = makeWay(11, [2, 3]);
    const rel = makeRelation(200, [10, 11], { name: 'Two-Segment Trail' });
    const osmData = buildOsmData(rel, [wA, wB], [n1, n2, n3]);

    const result = buildGeoJSON(osmData);
    assert.ok(result);
    // Should have 3 unique points (deduplicates the shared endpoint)
    assert.ok(result.geometry.coordinates.length >= 3, 'should stitch to at least 3 coords');
  });

  test('uses "Unnamed Trail" when name tag is missing', () => {
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);
    const w1 = makeWay(10, [1, 2]);
    const rel = makeRelation(300, [10], {});
    const osmData = buildOsmData(rel, [w1], [n1, n2]);

    const result = buildGeoJSON(osmData);
    assert.ok(result);
    assert.equal(result.properties.name, 'Unnamed Trail');
  });

  test('includes surface and tags in properties', () => {
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);
    const w1 = makeWay(10, [1, 2]);
    const rel = makeRelation(400, [10], {
      name: 'Paved Path',
      surface: 'paved',
      route: 'hiking',
    });
    const osmData = buildOsmData(rel, [w1], [n1, n2]);

    const result = buildGeoJSON(osmData);
    assert.ok(result);
    assert.equal(result.properties.surface, 'paved');
    assert.equal(result.properties.tags.route, 'hiking');
  });

  test('handles backward role by reversing segment', () => {
    // Way with nodes 1→2, but member role is 'backward', so expect 2→1 ordering
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);
    const w1 = makeWay(10, [1, 2]);
    const rel = {
      id: 500,
      type: 'relation',
      members: [{ type: 'way', ref: 10, role: 'backward' }],
      tags: { name: 'Backward Trail' },
    };
    const osmData = buildOsmData(rel, [w1], [n1, n2]);

    const result = buildGeoJSON(osmData);
    assert.ok(result);
    // First coordinate should be n2 (reversed)
    assert.deepEqual(result.geometry.coordinates[0], [-122.1, 37.1]);
  });
});

// --- extractTaggedNodes tests ---

describe('extractTaggedNodes', () => {
  test('returns empty array when relation has no node members', () => {
    const rel = makeRelation(1, [10]);
    const w = makeWay(10, [1, 2]);
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);
    const osmData = buildOsmData(rel, [w], [n1, n2]);
    const result = extractTaggedNodes(osmData);
    assert.equal(result.length, 0);
  });

  test('classifies summit node correctly', () => {
    const rel = {
      id: 1,
      type: 'relation',
      members: [
        { type: 'way', ref: 10, role: '' },
        { type: 'node', ref: 99, role: 'summit' },
      ],
      tags: {},
    };
    const summitNode = { id: 99, lat: 37.5, lon: -122.5, tags: { natural: 'peak', name: 'Half Dome' } };
    const w = makeWay(10, [1, 2]);
    const n1 = makeNode(1, 37.0, -122.0);
    const n2 = makeNode(2, 37.1, -122.1);

    const ways = new Map([[10, { nodes: [1, 2], tags: {} }]]);
    const nodes = new Map([
      [1, { lat: 37.0, lon: -122.0, tags: {} }],
      [2, { lat: 37.1, lon: -122.1, tags: {} }],
      [99, { lat: 37.5, lon: -122.5, tags: { natural: 'peak', name: 'Half Dome' } }],
    ]);

    const osmData = { relation: rel, ways, nodes };
    const result = extractTaggedNodes(osmData);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'summit');
    assert.equal(result[0].name, 'Half Dome');
  });

  test('classifies water node correctly', () => {
    const rel = {
      id: 2,
      type: 'relation',
      members: [{ type: 'node', ref: 50, role: '' }],
      tags: {},
    };
    const nodes = new Map([
      [50, { lat: 37.2, lon: -122.2, tags: { amenity: 'drinking_water', name: 'Spring' } }],
    ]);
    const osmData = { relation: rel, ways: new Map(), nodes };
    const result = extractTaggedNodes(osmData);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'water');
  });

  test('skips nodes with no useful tags', () => {
    const rel = {
      id: 3,
      type: 'relation',
      members: [{ type: 'node', ref: 77, role: '' }],
      tags: {},
    };
    const nodes = new Map([
      [77, { lat: 37.3, lon: -122.3, tags: {} }],
    ]);
    const osmData = { relation: rel, ways: new Map(), nodes };
    const result = extractTaggedNodes(osmData);
    assert.equal(result.length, 0);
  });
});
