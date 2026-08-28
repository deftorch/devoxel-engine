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

describe('VoxelEngine — Persistensi Chunk yang Diedit (Roadmap A.3)', () => {
  function makeFakePersistenceStore() {
    const saved = new Map(); // key "cx,cy,cz" -> storage instance yang di-save
    return {
      saved,
      saveCalls: 0,
      async save(cx, cy, cz, storage) {
        this.saveCalls++;
        saved.set(`${cx},${cy},${cz}`, storage);
      },
      async load(cx, cy, cz) {
        return saved.get(`${cx},${cy},${cz}`) || null;
      },
    };
  }

  test('chunk baru mulai dengan everEdited = false', () => {
    const engine = makeEngine();
    const chunk = engine.getOrCreateChunk(0, 0, 0);
    assert.equal(chunk.everEdited, false);
  });

  test('setVoxel menandai chunk everEdited = true', () => {
    const engine = makeEngine();
    engine.setVoxel(1, 1, 1, 5);
    assert.equal(engine.getChunk(0, 0, 0).everEdited, true);
  });

  test('tanpa persistenceStore (default null), unloadChunk tidak mencoba menyimpan apapun (tidak error)', () => {
    const engine = makeEngine();
    engine.setVoxel(1, 1, 1, 5);
    assert.doesNotThrow(() => engine.unloadChunk(0, 0, 0));
  });

  test('setPersistenceStore(null) menonaktifkan persistensi lagi', () => {
    const engine = makeEngine();
    const store = makeFakePersistenceStore();
    engine.setPersistenceStore(store);
    engine.setPersistenceStore(null);

    engine.setVoxel(1, 1, 1, 5);
    engine.unloadChunk(0, 0, 0);

    assert.equal(store.saveCalls, 0);
  });

  test('unloadChunk memanggil persistenceStore.save() HANYA untuk chunk yang everEdited', async () => {
    const engine = makeEngine();
    const store = makeFakePersistenceStore();
    engine.setPersistenceStore(store);

    engine.getOrCreateChunk(1, 0, 1); // TIDAK pernah diedit
    engine.setVoxel(0, 0, 0, 5); // chunk (0,0,0) -- diedit

    engine.unloadChunk(1, 0, 1);
    engine.unloadChunk(0, 0, 0);

    // save() dipanggil async (fire-and-forget) -- beri kesempatan microtask
    // queue jalan sebelum diperiksa.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(store.saveCalls, 1, 'cuma chunk yang everEdited yang boleh disimpan');
    assert.ok(store.saved.has('0,0,0'));
    assert.ok(!store.saved.has('1,0,1'));
  });

  test('unloadChunk mengirim storage yang BENAR (sesuai state terakhir) ke persistenceStore.save()', async () => {
    const engine = makeEngine();
    const store = makeFakePersistenceStore();
    engine.setPersistenceStore(store);

    engine.setVoxel(2, 2, 2, 7);
    engine.unloadChunk(0, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const savedStorage = store.saved.get('0,0,0');
    assert.equal(savedStorage.get(2, 2, 2), 7);
  });

  test('emit "chunkPersisted" setelah save() selesai', async () => {
    const engine = makeEngine();
    const store = makeFakePersistenceStore();
    engine.setPersistenceStore(store);
    engine.setVoxel(1, 1, 1, 5);

    let persistedPayload = null;
    engine.on('chunkPersisted', (payload) => {
      persistedPayload = payload;
    });

    engine.unloadChunk(0, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(persistedPayload, { cx: 0, cy: 0, cz: 0 });
  });

  test('persistenceStore.save() yang reject tidak melempar error tak tertangani (degradasi anggun)', async () => {
    const engine = makeEngine();
    engine.setPersistenceStore({
      save: async () => {
        throw new Error('simulasi IndexedDB gagal');
      },
      load: async () => null,
    });
    engine.setVoxel(1, 1, 1, 5);

    assert.doesNotThrow(() => engine.unloadChunk(0, 0, 0));
    await new Promise((resolve) => setTimeout(resolve, 0)); // beri waktu .catch() internal jalan
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

describe('VoxelEngine — remeshDirtyChunks budget & prioritas (Hardening A.5)', () => {
  test('tanpa budget (default), semua chunk dirty di-rebuild sekaligus -- perilaku lama tidak berubah', () => {
    const engine = makeEngine();
    for (let i = 0; i < 5; i++) engine.getOrCreateChunk(i, 0, 0);

    const rebuilt = engine.remeshDirtyChunks();

    assert.equal(rebuilt.length, 5);
    for (const chunk of engine.chunks.values()) assert.equal(chunk.dirty, false);
  });

  test('dengan budget, hanya sejumlah `budget` chunk yang di-rebuild per panggilan', () => {
    const engine = makeEngine();
    for (let i = 0; i < 5; i++) engine.getOrCreateChunk(i, 0, 0);

    const rebuilt = engine.remeshDirtyChunks(2);

    assert.equal(rebuilt.length, 2);
    const stillDirty = [...engine.chunks.values()].filter((c) => c.dirty).length;
    assert.equal(stillDirty, 3, 'sisa chunk yang belum di-remesh harus tetap dirty untuk panggilan berikutnya');
  });

  test('backlog dirty akhirnya habis setelah beberapa panggilan budget berturut-turut (simulasi beberapa frame)', () => {
    const engine = makeEngine();
    for (let i = 0; i < 10; i++) engine.getOrCreateChunk(i, 0, 0);

    let totalRebuilt = 0;
    for (let frame = 0; frame < 10; frame++) {
      totalRebuilt += engine.remeshDirtyChunks(3, { cx: 0, cz: 0 }).length;
    }

    assert.equal(totalRebuilt, 10, 'total chunk yang di-rebuild across semua frame harus sama dengan jumlah chunk');
    for (const chunk of engine.chunks.values()) assert.equal(chunk.dirty, false);
  });

  test('dengan priorityOrigin, chunk TERDEKAT (Chebyshev) selalu di-remesh lebih dulu', () => {
    const engine = makeEngine();
    // Sengaja dibuat TIDAK berurutan supaya urutan Map iterasi (insertion
    // order) tidak kebetulan sama dengan urutan jarak -- membuktikan sort
    // prioritasnya benar-benar bekerja, bukan cuma insertion order.
    engine.getOrCreateChunk(10, 0, 10); // jarak 10 dari origin (0,0)
    engine.getOrCreateChunk(1, 0, 0);   // jarak 1 -- harus diproses PERTAMA
    engine.getOrCreateChunk(5, 0, -5);  // jarak 5

    const rebuilt = engine.remeshDirtyChunks(1, { cx: 0, cz: 0 });

    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0].cx, 1);
    assert.equal(rebuilt[0].cz, 0);
  });

  test('tanpa priorityOrigin (budget saja), tetap membatasi jumlah tanpa error', () => {
    const engine = makeEngine();
    for (let i = 0; i < 4; i++) engine.getOrCreateChunk(i, 0, 0);

    const rebuilt = engine.remeshDirtyChunks(2, null);

    assert.equal(rebuilt.length, 2);
  });

  test('budget lebih besar dari jumlah chunk dirty -- semua tetap ter-rebuild, tidak error', () => {
    const engine = makeEngine();
    for (let i = 0; i < 3; i++) engine.getOrCreateChunk(i, 0, 0);

    const rebuilt = engine.remeshDirtyChunks(999, { cx: 0, cz: 0 });

    assert.equal(rebuilt.length, 3);
  });

  test('budget 0 -- tidak ada yang di-rebuild, semua tetap dirty', () => {
    const engine = makeEngine();
    for (let i = 0; i < 3; i++) engine.getOrCreateChunk(i, 0, 0);

    const rebuilt = engine.remeshDirtyChunks(0, { cx: 0, cz: 0 });

    assert.equal(rebuilt.length, 0);
    for (const chunk of engine.chunks.values()) assert.equal(chunk.dirty, true);
  });

  test('acceptance: rebase (setOriginChunk) mass-dirty diserap bertahap, bukan sekali frame besar', () => {
    // Simulasi konkret skenario yang jadi alasan fitur ini dibuat: view
    // distance besar (banyak chunk loaded), lalu terjadi rebase yang
    // menandai SEMUA-nya dirty sekaligus. Tanpa budget, remeshDirtyChunks()
    // akan me-rebuild seluruhnya dalam satu panggilan (satu frame). Dengan
    // budget, setiap panggilan (frame) hanya memproses sebagian.
    const engine = makeEngine();
    const N = 25;
    for (let i = 0; i < N; i++) engine.getOrCreateChunk(i, 0, 0);
    for (const chunk of engine.chunks.values()) chunk.dirty = false;

    engine.setOriginChunk(12, 0, 0); // rebase -- semua N chunk jadi dirty lagi

    const firstFrame = engine.remeshDirtyChunks(4, { cx: 12, cz: 0 });
    assert.equal(firstFrame.length, 4, 'satu frame TIDAK boleh me-remesh semua chunk sekaligus setelah rebase');

    const stillDirtyAfterFirstFrame = [...engine.chunks.values()].filter((c) => c.dirty).length;
    assert.equal(stillDirtyAfterFirstFrame, N - 4);
  });
});

describe('VoxelEngine — Partial Remeshing wiring (Roadmap B.2)', () => {
  test('setVoxel mengakumulasi pendingDirtyBounds dengan padding di sekitar voxel yang diedit', () => {
    const engine = makeEngine();
    engine.setVoxel(3, 3, 3, 1);
    const chunk = engine.getChunk(0, 0, 0);
    assert.ok(chunk.pendingDirtyBounds, 'pendingDirtyBounds harus terisi setelah setVoxel');
    const b = chunk.pendingDirtyBounds;
    // PADDING=2 di sekitar local coord (3,3,3) -- lihat _unionDirtyBounds().
    assert.deepEqual(b, { minX: 1, maxX: 5, minY: 1, maxY: 5, minZ: 1, maxZ: 5 });
  });

  test('beberapa setVoxel sebelum remesh ter-UNION jadi satu AABB gabungan, bukan ditimpa/direset', () => {
    const engine = makeEngine();
    engine.setVoxel(1, 1, 1, 1);
    engine.setVoxel(6, 6, 6, 1);
    const b = engine.getChunk(0, 0, 0).pendingDirtyBounds;
    // Union dari [1-2,1+2]=[-1,3] dan [6-2,6+2]=[4,8] -> [-1,8] di tiap sumbu.
    assert.deepEqual(b, { minX: -1, maxX: 8, minY: -1, maxY: 8, minZ: -1, maxZ: 8 });
  });

  test('remeshChunk mereset pendingDirtyBounds & forceFullRemesh setelah dikonsumsi', () => {
    const engine = makeEngine();
    engine.setVoxel(2, 2, 2, 1);
    const chunk = engine.getChunk(0, 0, 0);
    assert.ok(chunk.pendingDirtyBounds);

    engine.remeshChunk(0, 0, 0);

    assert.equal(chunk.pendingDirtyBounds, null, 'harus direset supaya siklus edit berikutnya mulai bersih');
    assert.equal(chunk.forceFullRemesh, false);
  });

  test('remeshChunk mem-persist cellCache dari hasil mesher (FakeMesher tidak mengembalikannya -> tetap null, tidak error)', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(0, 0, 0);
    engine.remeshChunk(0, 0, 0);
    // FakeMesher (lihat makeEngine() di atas) tidak mengembalikan cellCache
    // sama sekali -- pastikan wiring ini tidak error dan chunk.cellCache
    // tetap null (bukan undefined liar), supaya canPartial di remesh
    // berikutnya otomatis false (fallback full rebuild) untuk mesher lain.
    assert.equal(engine.getChunk(0, 0, 0).cellCache, null);
  });

  test('_dirtyBoundaryNeighbors (dipicu setVoxel dekat batas chunk) memasang forceFullRemesh=true di tetangga', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(0, 0, 0);
    const neighbor = engine.getOrCreateChunk(1, 0, 0);
    neighbor.dirty = false;
    neighbor.forceFullRemesh = false;

    engine.setVoxel(15, 3, 3, 1); // lx=15 = sisi kanan chunk 16-lebar default

    assert.equal(neighbor.dirty, true);
    assert.equal(
      neighbor.forceFullRemesh,
      true,
      'tetangga yang di-dirty-kan sebagai efek SAMPING (bukan diedit langsung) harus dipaksa full rebuild'
    );
  });

  test('markChunkLoaded juga memasang forceFullRemesh=true di semua tetangga yang sudah ada', () => {
    const engine = makeEngine();
    engine.getOrCreateChunk(0, 0, 0);
    const neighbor = engine.getOrCreateChunk(1, 0, 0);
    neighbor.dirty = false;
    neighbor.forceFullRemesh = false;

    engine.markChunkLoaded(0, 0, 0);

    assert.equal(neighbor.forceFullRemesh, true);
  });

  test('setDebugChunkBounds memasang forceFullRemesh=true di SEMUA chunk (hindari warna cache campur aduk)', () => {
    const engine = makeEngine();
    for (let i = 0; i < 3; i++) engine.getOrCreateChunk(i, 0, 0);
    for (const chunk of engine.chunks.values()) chunk.forceFullRemesh = false;

    engine.setDebugChunkBounds(true);

    for (const chunk of engine.chunks.values()) assert.equal(chunk.forceFullRemesh, true);
  });

  describe('acceptance end-to-end dengan SurfaceNetsMesher asli', () => {
    function makeSurfaceNetsEngine(size) {
      const registry = new PluginRegistry();
      registry.registerStorage('sdf', (sx, sy, sz) => new SDFStorage(sx, sy, sz));
      registry.registerMesher('surfacenets', () => new SurfaceNetsMesher());
      return new VoxelEngine({ registry, storage: 'sdf', mesher: 'surfacenets', chunkSize: [size, size, size] });
    }

    function fillSphere(storage, size) {
      const c = size / 2;
      for (let x = 0; x < size; x++)
        for (let y = 0; y < size; y++)
          for (let z = 0; z < size; z++) {
            const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) - size * 0.3;
            storage.setSDF(x, y, z, dist);
          }
    }

    test('setelah build awal + satu edit voxel jauh dari batas chunk, remesh partial menghasilkan mesh valid & IDENTIK dengan full rebuild', () => {
      const size = 8;
      const engine = makeSurfaceNetsEngine(size);
      const chunk = engine.getOrCreateChunk(0, 0, 0);
      fillSphere(chunk.storage, size);
      engine.remeshDirtyChunks(); // build awal (full, populates cellCache)
      assert.ok(chunk.cellCache, 'build awal harus menghasilkan cellCache untuk dipakai partial berikutnya');

      // Edit satu voxel dekat permukaan sphere, JAUH dari batas chunk
      // (supaya tidak memicu forceFullRemesh lewat _dirtyBoundaryNeighbors).
      const c = size / 2;
      engine.setVoxel(c, c, Math.floor(c + size * 0.3), 0);
      assert.ok(chunk.pendingDirtyBounds, 'edit jauh dari batas harus mengakumulasi pendingDirtyBounds (partial-eligible)');
      assert.equal(chunk.forceFullRemesh, false, 'edit jauh dari batas TIDAK boleh memicu forceFullRemesh');

      engine.remeshDirtyChunks(); // ini PARTIAL (cellCache + pendingDirtyBounds tersedia)

      assert.ok(chunk.mesh.vertexData.length > 0, 'mesh setelah partial remesh tidak boleh kosong');
      let badCount = 0;
      for (let i = 0; i < chunk.mesh.vertexData.length; i++) {
        if (!Number.isFinite(chunk.mesh.vertexData[i])) badCount++;
      }
      assert.equal(badCount, 0, 'mesh hasil partial remesh tidak boleh mengandung NaN/Infinity');

      // Ground truth: full rebuild langsung dari storage yang SAMA (setelah
      // edit yang sama). Dibandingkan sebagai HIMPUNAN posisi vertex, BUKAN
      // array mentah -- urutan insersi partial (seed-dari-cache dulu, baru
      // cell baru) berbeda dari urutan full (nested loop dari awal), jadi
      // array mentah TIDAK akan sama persis walau geometrinya identik
      // (lihat catatan yang sama di SurfaceNetsMesher.test.js).
      const fullRebuild = new SurfaceNetsMesher().generateMesh(chunk.storage, { chunkCoord: [0, 0, 0] });

      function vertexPositionSet(vertexData) {
        const set = new Set();
        for (let i = 0; i < vertexData.length; i += 9) {
          set.add(`${vertexData[i].toFixed(4)},${vertexData[i + 1].toFixed(4)},${vertexData[i + 2].toFixed(4)}`);
        }
        return set;
      }

      assert.equal(
        chunk.mesh.vertexData.length,
        fullRebuild.vertexData.length,
        'jumlah vertex hasil partial remesh (via VoxelEngine) harus sama dengan full rebuild langsung'
      );
      assert.deepEqual(
        [...vertexPositionSet(chunk.mesh.vertexData)].sort(),
        [...vertexPositionSet(fullRebuild.vertexData)].sort(),
        'himpunan posisi vertex hasil partial remesh (via VoxelEngine, wiring end-to-end) harus identik dengan full rebuild'
      );
    });

    test('edit voxel TEPAT di batas chunk tetap memicu full rebuild di tetangga (border stitching A.4/Fase-0 tidak rusak oleh B.2)', () => {
      const size = 8;
      const engine = makeSurfaceNetsEngine(size);
      const chunkA = engine.getOrCreateChunk(0, 0, 0);
      const chunkB = engine.getOrCreateChunk(1, 0, 0);
      fillSphere(chunkA.storage, size);
      fillSphere(chunkB.storage, size);
      engine.remeshDirtyChunks(); // build awal keduanya

      // Edit A tepat di sisi kanan (lx = size-1) -- harus memicu forceFullRemesh di B.
      engine.setVoxel(size - 1, 3, 3, 1);
      assert.equal(chunkB.forceFullRemesh, true);

      engine.remeshDirtyChunks();

      assert.equal(chunkB.dirty, false);
      let badCount = 0;
      for (let i = 0; i < chunkB.mesh.vertexData.length; i++) {
        if (!Number.isFinite(chunkB.mesh.vertexData[i])) badCount++;
      }
      assert.equal(badCount, 0);
    });
  });
});
