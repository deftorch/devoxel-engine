import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../core/VoxelEngine.js';
import { PluginRegistry } from '../core/registry/PluginRegistry.js';
import { SurfaceNetsMesher } from '../core/mesher/SurfaceNetsMesher.js';
import { SDFStorage } from '../core/voxel/SDFStorage.js';

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
    this.lastCtx = null;
  }
  markChunkDirty(cx, cy, cz) {
    this.markCalls.push([cx, cy, cz]);
  }
  generateMesh(storage, ctx = null) {
    this.lastCtx = ctx;
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

  test('remeshChunk passes ctx with working getNeighbor function', () => {
    const engine = makeEngine();
    // Buat chunk A (0,0,0)
    engine.setVoxel(0, 0, 0, 1);
    // Buat chunk B (1,0,0) di sebelahnya persis
    engine.setVoxel(20, 0, 0, 7); 
    
    engine.remeshChunk(0, 0, 0);
    const ctx = engine.mesherPlugin.lastCtx;
    
    assert.ok(ctx, 'ctx object harus dikirimkan ke generateMesh');
    assert.deepEqual(ctx.chunkCoord, [0, 0, 0], 'chunkCoord harus menunjuk ke chunk yang sedang di-remesh');
    
    // Test 1: Intip ke sebelah kanan (Chunk B harusnya ada)
    const neighborRight = ctx.getNeighbor(1, 0, 0);
    assert.ok(neighborRight, 'getNeighbor(1,0,0) harus mereturn storage tetangga');
    assert.equal(neighborRight.get(4, 0, 0), 7, 'Isi tetangga harus sesuai dengan yang kita buat (lokal x=4, val=7)');
    
    // Test 2: Intip ke sebelah kiri (Belum ada chunk yang dibuat)
    const neighborLeft = ctx.getNeighbor(-1, 0, 0);
    assert.equal(neighborLeft, null, 'getNeighbor(-1,0,0) harus mereturn null jika chunk belum ada');
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

// Roadmap A.1 -- Chunk Streaming: unloadChunk() adalah primitive yang dipakai
// ChunkStreamer (lewat main.js) untuk membuang chunk yang keluar radius,
// tanpa menyentuh storage permanen apapun (persistensi ke IndexedDB adalah
// tanggung jawab Fase A.3, bukan bagian ini).
describe('VoxelEngine — unloadChunk (Roadmap A.1)', () => {
  test('menghapus chunk dari this.chunks', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(2, 0, 3);
    assert.notEqual(engine.getChunk(2, 0, 3), null);

    engine.unloadChunk(2, 0, 3);
    assert.equal(engine.getChunk(2, 0, 3), null);
  });

  test('return chunk record yang baru di-unload', () => {
    const engine = makeEngine();
    const chunk = engine.getOrCreateChunk(1, 0, 1);
    const unloaded = engine.unloadChunk(1, 0, 1);
    assert.equal(unloaded, chunk);
  });

  test('unload chunk yang tidak pernah ada adalah no-op aman (return null, tidak throw)', () => {
    const engine = makeEngine();
    assert.doesNotThrow(() => {
      const result = engine.unloadChunk(99, 0, 99);
      assert.equal(result, null);
    });
  });

  test('emit "chunkUnloaded" dengan chunk record SEBELUM entry dihapus dari map', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(5, 0, 5);
    let sawChunkInMapDuringEvent = false;
    engine.on('chunkUnloaded', (chunk) => {
      assert.equal(chunk.cx, 5);
      // Selama listener berjalan, chunk record harus masih bisa dibaca
      // lewat getChunk() -- penting untuk Fase A.3 (serialize sebelum hilang).
      sawChunkInMapDuringEvent = engine.getChunk(5, 0, 5) === chunk;
    });
    engine.unloadChunk(5, 0, 5);
    assert.equal(sawChunkInMapDuringEvent, true);
    assert.equal(engine.getChunk(5, 0, 5), null);
  });

  test('chunk yang di-unload lalu diminta lagi lewat getOrCreateChunk menghasilkan chunk baru (data lama hilang)', () => {
    const engine = makeEngine();
    const original = engine.getOrCreateChunk(0, 0, 0);
    original.storage.set(1, 1, 1, 42);

    engine.unloadChunk(0, 0, 0);
    const recreated = engine.getOrCreateChunk(0, 0, 0);

    assert.notEqual(recreated, original);
    assert.equal(recreated.storage.get(1, 1, 1), 0);
  });
});

// Roadmap A.4 -- Border Stitching untuk Chunk yang Load Asinkron (dipakai
// oleh streaming A.1, karena di sana chunk load bertahap antar frame, beda
// dengan buildWorld() yang membuat semua chunk sekaligus sebelum mesh
// pertama kali dijalankan).
describe('VoxelEngine — markChunkLoaded / border stitching (Roadmap A.4)', () => {
  test('menandai dirty tepat 26 tetangga (6 face + 12 edge + 8 corner) yang sudah ada, bukan chunk itu sendiri', () => {
    const engine = makeEngine();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) engine.getOrCreateChunk(dx, dy, dz);
      }
    }
    // getOrCreateChunk() mulai dengan dirty=true -- reset dulu supaya efek
    // markChunkLoaded() di bawah bisa diukur secara terisolasi.
    for (const chunk of engine.chunks.values()) chunk.dirty = false;
    engine.mesherPlugin.markCalls.length = 0;

    engine.markChunkLoaded(0, 0, 0);

    let dirtyNeighborCount = 0;
    for (const [key, chunk] of engine.chunks) {
      if (key === '0,0,0') {
        assert.equal(chunk.dirty, false, 'chunk itu sendiri tidak boleh ikut ditandai dirty oleh markChunkLoaded()');
      } else if (chunk.dirty) {
        dirtyNeighborCount++;
      }
    }
    assert.equal(dirtyNeighborCount, 26);
    assert.equal(engine.mesherPlugin.markCalls.length, 26);
  });

  test('mengabaikan tetangga yang belum pernah dibuat -- tidak throw, tidak auto-create chunk baru', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(5, 5, 5); // sendirian, tanpa tetangga
    const sizeBefore = engine.chunks.size;
    assert.doesNotThrow(() => engine.markChunkLoaded(5, 5, 5));
    assert.equal(engine.chunks.size, sizeBefore);
  });

  function makeSurfaceNetsEngine(size) {
    const registry = new PluginRegistry();
    registry.registerStorage('sdf', (sx, sy, sz) => new SDFStorage(sx, sy, sz));
    registry.registerMesher('surfacenets', () => new SurfaceNetsMesher());
    return new VoxelEngine({ registry, storage: 'sdf', mesher: 'surfacenets', chunkSize: [size, size, size] });
  }

  // Medan miring sederhana (sama seperti makeSlopeChunk di
  // SurfaceNetsMesher.test.js) supaya permukaannya melintasi batas chunk
  // dengan sudut berbeda di tiap sisi -- kalau seam TIDAK di-stitch ulang,
  // jumlah vertex di sisi yang berubah akan tetap sama persis (mesh stale).
  function fillSlope(storage, chunkX, size) {
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          const wx = chunkX * size + x;
          const h = wx * 0.3 + 3;
          storage.setSDF(x, y, z, y - h);
        }
      }
    }
  }

  test('acceptance test A.4: chunk A yang sudah di-mesh sendirian ikut ter-update setelah tetangga B baru di-load', () => {
    const size = 8;
    const engine = makeSurfaceNetsEngine(size);

    // 1. Chunk A (cx=0) di-load & di-mesh SENDIRIAN dulu -- pada titik ini
    //    tetangganya (cx=1) belum pernah dibuat sama sekali, persis seperti
    //    chunk di tepi radius streaming sebelum pemain bergerak lebih jauh.
    const chunkA = engine.getOrCreateChunk(0, 0, 0);
    fillSlope(chunkA.storage, 0, size);
    chunkA.dirty = true;
    engine.remeshDirtyChunks();
    const vertexCountBefore = engine.getChunk(0, 0, 0).mesh.vertexData.length;
    assert.ok(vertexCountBefore > 0, 'chunk A seharusnya menghasilkan geometri (medan miring melintasi chunk)');

    // 2. Chunk B (cx=1) baru saja di-load (mis. pemain jalan lebih jauh).
    const chunkB = engine.getOrCreateChunk(1, 0, 0);
    fillSlope(chunkB.storage, 1, size);
    chunkB.dirty = true;
    engine.markChunkLoaded(1, 0, 0);

    assert.equal(
      engine.getChunk(0, 0, 0).dirty,
      true,
      'chunk A harus ikut ditandai dirty setelah B di-load (border stitching A.4) -- tanpa ini mesh A tetap stale'
    );

    // 3. Setelah remesh, mesh A harus berubah (dibangun ulang dengan data B
    //    yang sekarang nyata ada, bukan lagi asumsi "kosong" lama).
    engine.remeshDirtyChunks();
    const vertexCountAfter = engine.getChunk(0, 0, 0).mesh.vertexData.length;
    assert.notEqual(
      vertexCountAfter,
      vertexCountBefore,
      'mesh A harus berubah setelah remesh dengan data tetangga B (regression: chunk A tetap stale di seam)'
    );
  });

  test('demonstrasi bug yang diperbaiki A.4: TANPA markChunkLoaded, chunk A tetap dianggap bersih (mesh stale)', () => {
    const size = 8;
    const engine = makeSurfaceNetsEngine(size);

    const chunkA = engine.getOrCreateChunk(0, 0, 0);
    fillSlope(chunkA.storage, 0, size);
    chunkA.dirty = true;
    engine.remeshDirtyChunks();

    // Load B TANPA memanggil engine.markChunkLoaded() -- simulasi kode
    // sebelum fix A.4 diterapkan.
    const chunkB = engine.getOrCreateChunk(1, 0, 0);
    fillSlope(chunkB.storage, 1, size);
    chunkB.dirty = true;

    assert.equal(
      engine.getChunk(0, 0, 0).dirty,
      false,
      'tanpa border stitching, chunk A tidak pernah ditandai dirty walau tetangganya baru saja punya data nyata'
    );
  });
});

// Roadmap A.5 -- Origin Rebasing: setOriginChunk() menggeser referensi
// baking posisi vertex mesher & menandai ulang semua chunk loaded.
describe('VoxelEngine — setOriginChunk (Roadmap A.5)', () => {
  test('originChunk default [0, 0, 0]', () => {
    const engine = makeEngine();
    assert.deepEqual(engine.originChunk, [0, 0, 0]);
  });

  test('setOriginChunk mengubah this.originChunk', () => {
    const engine = makeEngine();
    engine.setOriginChunk(5, 0, -3);
    assert.deepEqual(engine.originChunk, [5, 0, -3]);
  });

  test('setOriginChunk menandai SEMUA chunk yang sedang loaded sebagai dirty', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(0, 0, 0);
    engine.getOrCreateChunk(1, 0, 0);
    engine.getOrCreateChunk(2, 0, 0);
    for (const chunk of engine.chunks.values()) chunk.dirty = false;

    engine.setOriginChunk(10, 0, 10);

    for (const chunk of engine.chunks.values()) assert.equal(chunk.dirty, true);
  });

  test('remeshChunk membakar ctx.originChunk yang sesuai dengan this.originChunk saat ini', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(3, 0, 0);
    engine.setOriginChunk(3, 0, 0);
    engine.remeshChunk(3, 0, 0);
    // FakeMesher (lihat makeEngine()) mencatat ctx terakhir yang diterima --
    // pastikan originChunk yang dibakar konsisten dengan this.originChunk.
    assert.deepEqual(engine.mesherPlugin.lastCtx.originChunk, [3, 0, 0]);
  });
});
