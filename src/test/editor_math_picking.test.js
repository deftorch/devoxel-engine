import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Mock DOM
global.document = {
  getElementById: (id) => ({ disabled: false }),
};
global.alert = () => {};

import { rayAABB } from '../editor/picking.js';
import { closestParamsBetweenLines } from '../editor/camera-input.js';

describe('Editor Math & Picking', () => {
  test('rayAABB hits exactly on the front face', () => {
    const min = [-1, -1, -1];
    const max = [1, 1, 1];
    const ro = [0, 0, 5]; // ray origin
    const rd = [0, 0, -1]; // ray direction
    
    const hit = rayAABB(ro, rd, min, max);
    assert.equal(hit, 4); // Hits Z=1 at distance 4
  });
  
  test('rayAABB misses the box completely', () => {
    const min = [-1, -1, -1];
    const max = [1, 1, 1];
    const ro = [5, 5, 5];
    const rd = [0, 1, 0]; // pointing away
    
    const hit = rayAABB(ro, rd, min, max);
    assert.equal(hit, null);
  });

  test('rayAABB hits from inside the box', () => {
    const min = [-1, -1, -1];
    const max = [1, 1, 1];
    const ro = [0, 0, 0]; // Inside
    const rd = [1, 0, 0]; // Pointing right
    
    const hit = rayAABB(ro, rd, min, max);
    assert.equal(hit, 1); // Hits X=1 at distance 1
  });

  test('closestParamsBetweenLines calculates correct parameters between skewed lines', () => {
    // Line 1: x-axis
    const p0 = [0, 0, 0];
    const d1 = [1, 0, 0];
    // Line 2: y-axis offset by z=5
    const ro = [0, 0, 5];
    const d2 = [0, 1, 0];
    
    const result = closestParamsBetweenLines(p0, d1, ro, d2);
    // Closest points should be (0,0,0) and (0,0,5)
    // Parameter s for line 1 should be 0
    // Parameter t for line 2 should be 0
    assert.ok(result);
    assert.equal(result.s, 0);
    assert.equal(result.t, 0);
  });

  test('closestParamsBetweenLines returns null for parallel lines', () => {
    // Line 1: x-axis
    const p0 = [0, 0, 0];
    const d1 = [1, 0, 0];
    // Line 2: parallel to x-axis, offset by y=2
    const ro = [0, 2, 0];
    const d2 = [1, 0, 0];
    
    const result = closestParamsBetweenLines(p0, d1, ro, d2);
    assert.equal(result, null);
  });
});
