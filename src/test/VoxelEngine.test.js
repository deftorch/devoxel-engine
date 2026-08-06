import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../core/VoxelEngine.js';
import { PluginRegistry } from '../core/registry/PluginRegistry.js';

// Minimal fake storage: a flat Map keyed by "x,y,z", good enough to test
// VoxelEngine's chunk/coordinate logic without depending on a real backend.
class FakeStorage {
  constructor(sx, sy, sz) {
    this.dims = [sx, sy, sz];
    this.data = new Map();
  }
  get(x, y, z) {
    return this.data.get(`${x},${y},${z}`) ?? 0;
  }
  set(x, y, z, val) {
    this.data.set(`${x},${y},${z}`, val);
  }
}

class FakeMesher {
  constructor() {
    this.markCalls = [];
  }
  markChunkDirty(cx, cy, cz) {
    this.markCalls.push([cx, cy, cz]);
  }
  generateMesh(storage) {
    return { vertexData: new Float32Array([1]), indexData: new Uint32Array([0]), voxelCount: storage.data.size };
  }
}

function makeEngine(overrides = {}) {
  const registry = new PluginRegistry();
  registry.registerStorage('fake', (sx, sy, sz) => new FakeStorage(sx, sy, sz));
  registry.registerMesher('fake', () => new FakeMesher());
  return new VoxelEngine({
    registry,
    storage: 'fake',
    mesher: 'fake',
    chunkSize: [16, 40, 16],
    ...overrides,
  });
}

describe('VoxelEngine — voxel get/set', () => {
  test('setVoxel then getVoxel returns the same value', () => {
    const engine = makeEngine();
    engine.setVoxel(3, 4, 5, 9);
    assert.equal(engine.getVoxel(3, 4, 5), 9);
  });

  test('getVoxel on an unset coordinate returns 0', () => {
    const engine = makeEngine();
    assert.equal(engine.getVoxel(100, 100, 100), 0);
  });

  test('getVoxel in a chunk that was never created does not throw', () => {
    const engine = makeEngine();
    assert.doesNotThrow(() => engine.getVoxel(-50, -50, -50));
  });
});

describe('VoxelEngine — chunk lifecycle', () => {
  test('setVoxel in a new region creates exactly one chunk', () => {
    const engine = makeEngine();
    assert.equal(engine.chunks.size, 0);
    engine.setVoxel(0, 0, 0, 1);
    assert.equal(engine.chunks.size, 1);
  });

  test('setVoxel twice in the same chunk does not create a second chunk', () => {
    const engine = makeEngine();
    engine.setVoxel(1, 1, 1, 1);
    engine.setVoxel(2, 2, 2, 1);
    assert.equal(engine.chunks.size, 1);
  });

  test('setVoxel in two different chunks creates two chunks', () => {
    const engine = makeEngine();
    engine.setVoxel(0, 0, 0, 1);
    engine.setVoxel(20, 0, 0, 1); // chunkSize[0] = 16, so x=20 is chunk cx=1
    assert.equal(engine.chunks.size, 2);
  });

  test('getOrCreateChunk without a storage factory throws a clear error', () => {
    const engine = new VoxelEngine({ chunkSize: [16, 40, 16] });
    assert.throws(() => engine.getOrCreateChunk(0, 0, 0), /Tidak ada Storage Provider/);
  });
});

describe('VoxelEngine — worldToChunkCoords', () => {
  test('positive coordinates within the first chunk', () => {
    const engine = makeEngine();
    const { cx, cy, cz, lx, ly, lz } = engine.worldToChunkCoords(5, 10, 3);
    assert.deepEqual([cx, cy, cz, lx, ly, lz], [0, 0, 0, 5, 10, 3]);
  });

  test('positive coordinates past the first chunk boundary', () => {
    const engine = makeEngine();
    const { cx, lx } = engine.worldToChunkCoords(20, 0, 0);
    assert.equal(cx, 1);
    assert.equal(lx, 4); // 20 - 1*16
  });

  test('negative coordinates resolve to a negative chunk index with a valid local offset', () => {
    const engine = makeEngine();
    const { cx, lx } = engine.worldToChunkCoords(-1, 0, 0);
    // -1 should fall in chunk cx = -1, with local x = 15 (last voxel of that chunk),
    // NOT cx = 0 with a negative local index.
    assert.equal(cx, -1);
    assert.equal(lx, 15);
  });

  test('negative coordinate exactly on a chunk boundary', () => {
    const engine = makeEngine();
    const { cx, lx } = engine.worldToChunkCoords(-16, 0, 0);
    assert.equal(cx, -1);
    assert.equal(lx, 0);
  });
});

describe('VoxelEngine — dirty tracking & meshing', () => {
  test('setVoxel marks the chunk dirty and notifies the mesher', () => {
    const engine = makeEngine();
    engine.setVoxel(0, 0, 0, 1);
    const chunk = engine.getChunk(0, 0, 0);
    assert.equal(chunk.dirty, true);
    assert.deepEqual(engine.mesherPlugin.markCalls, [[0, 0, 0]]);
  });

  test('remeshChunk builds a mesh and clears the dirty flag', () => {
    const engine = makeEngine();
    engine.setVoxel(0, 0, 0, 1);
    const mesh = engine.remeshChunk(0, 0, 0);
    assert.ok(mesh);
    assert.equal(engine.getChunk(0, 0, 0).dirty, false);
    assert.equal(engine.getChunk(0, 0, 0).mesh, mesh);
  });

  test('remeshChunk on a nonexistent chunk returns null', () => {
    const engine = makeEngine();
    assert.equal(engine.remeshChunk(9, 9, 9), null);
  });

  test('remeshDirtyChunks only rebuilds chunks marked dirty', () => {
    const engine = makeEngine();
    engine.setVoxel(0, 0, 0, 1);
    engine.setVoxel(20, 0, 0, 1);
    engine.remeshChunk(0, 0, 0); // clears dirty on chunk (0,0,0)

    const rebuilt = engine.remeshDirtyChunks();
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0].cx, 1);
  });
});

describe('VoxelEngine — event hooks', () => {
  test('chunkCreated fires exactly once per new chunk', () => {
    const engine = makeEngine();
    const created = [];
    engine.on('chunkCreated', (chunk) => created.push([chunk.cx, chunk.cy, chunk.cz]));

    engine.setVoxel(0, 0, 0, 1);
    engine.setVoxel(1, 1, 1, 1); // same chunk, should not fire again
    engine.setVoxel(20, 0, 0, 1); // new chunk

    assert.deepEqual(created, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });

  test('beforeVoxelEdit and afterVoxelEdit fire with the correct payload, in order', () => {
    const engine = makeEngine();
    const log = [];
    engine.on('beforeVoxelEdit', (p) => log.push(['before', p]));
    engine.on('afterVoxelEdit', (p) => log.push(['after', p]));

    engine.setVoxel(1, 2, 3, 7);

    assert.deepEqual(log, [
      ['before', { x: 1, y: 2, z: 3, value: 7 }],
      ['after', { x: 1, y: 2, z: 3, value: 7 }],
    ]);
  });

  test('beforeMesh and afterMesh fire around remeshChunk', () => {
    const engine = makeEngine();
    const log = [];
    engine.on('beforeMesh', (chunk) => log.push(['before', chunk.cx, chunk.cy, chunk.cz]));
    engine.on('afterMesh', ({ chunk }) => log.push(['after', chunk.cx, chunk.cy, chunk.cz]));

    engine.setVoxel(0, 0, 0, 1);
    engine.remeshChunk(0, 0, 0);

    assert.deepEqual(log, [
      ['before', 0, 0, 0],
      ['after', 0, 0, 0],
    ]);
  });

  test('off() removes a previously registered listener', () => {
    const engine = makeEngine();
    let count = 0;
    const listener = () => count++;
    engine.on('afterVoxelEdit', listener);
    engine.setVoxel(0, 0, 0, 1);
    engine.off('afterVoxelEdit', listener);
    engine.setVoxel(0, 0, 0, 2);
    assert.equal(count, 1);
  });
});
