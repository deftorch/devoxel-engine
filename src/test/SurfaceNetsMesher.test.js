import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceNetsMesher } from '../core/mesher/SurfaceNetsMesher.js';
import { SDFStorage } from '../core/voxel/SDFStorage.js';

const CS = 8;

function makeSphereChunk(size = CS) {
  const storage = new SDFStorage(size, size, size);
  const c = size / 2;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) - size * 0.3;
        storage.setSDF(x, y, z, dist);
      }
    }
  }
  return storage;
}

function makeSlopeChunk(chunkX, size = CS) {
  const storage = new SDFStorage(size, size, size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const wx = chunkX * size + x;
        const h = wx * 0.3 + 3;
        storage.setSDF(x, y, z, y - h);
      }
    }
  }
  return storage;
}

describe('SurfaceNetsMesher', () => {
  test('generateMesh never produces NaN/Infinity in position or normal data', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    const result = mesher.generateMesh(storage, null);

    assert.ok(result.vertexData.length > 0, 'expected some geometry from a sphere SDF');

    let badVertexCount = 0;
    for (let i = 0; i < result.vertexData.length; i++) {
      if (!Number.isFinite(result.vertexData[i])) badVertexCount++;
    }
    assert.equal(
      badVertexCount,
      0,
      `expected no NaN/Infinity values in vertexData, found ${badVertexCount}. ` +
        'This regresses the bug where fractional vertex positions were used to ' +
        'index the SDF TypedArray directly in _getNormal (undefined -> NaN).'
    );
  });

  test('normals returned by _getNormal are always finite unit vectors', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    // Sample a handful of fractional (non-integer) positions, which is what
    // generateMesh actually feeds into _getNormal for interpolated vertices.
    const samples = [
      [4.3, 4.3, 6.9],
      [1.7, 4.0, 4.0],
      [4.0, 1.25, 4.0],
    ];
    for (const [x, y, z] of samples) {
      const [nx, ny, nz] = mesher._getNormal(storage, null, x, y, z, storage.dims);
      assert.ok(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), `normal at (${x},${y},${z}) should be finite, got [${nx},${ny},${nz}]`);
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      assert.ok(Math.abs(len - 1) < 1e-6 || len === 0, `normal at (${x},${y},${z}) should be unit-length, got length ${len}`);
    }
  });

  test('adjacent chunks both produce vertices at the shared boundary (no seam gap)', () => {
    const mesher = new SurfaceNetsMesher();
    const chunkA = makeSlopeChunk(0);
    const chunkB = makeSlopeChunk(1);
    const chunks = { '0,0,0': chunkA, '1,0,0': chunkB };
    const makeCtx = (cx) => ({
      chunkCoord: [cx, 0, 0],
      getNeighbor: (dx, dy, dz) => chunks[`${cx + dx},${dy},${dz}`] ?? null,
    });

    const meshA = mesher.generateMesh(chunkA, makeCtx(0));
    const meshB = mesher.generateMesh(chunkB, makeCtx(1));

    const boundaryWorldX = CS; // chunk A ends / chunk B starts here in world space
    const nearBoundary = (mesh, tol = 0.6) => {
      let count = 0;
      for (let i = 0; i < mesh.vertexData.length / 9; i++) {
        if (Math.abs(mesh.vertexData[i * 9] - boundaryWorldX) < tol) count++;
      }
      return count;
    };

    assert.ok(
      nearBoundary(meshA) > 0,
      'chunk A should generate vertices right at its shared edge with chunk B (regression: cell -1 was never computed, so boundary quads were silently skipped)'
    );
    assert.ok(nearBoundary(meshB) > 0, 'chunk B should generate vertices right at its shared edge with chunk A');
  });
});
