import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkPersistenceStore } from '../core/world/ChunkPersistenceStore.js';
import { SDFStorage } from '../core/voxel/SDFStorage.js';
import { FlatGridStorage } from '../core/voxel/FlatGridStorage.js';

/**
 * Adapter in-memory palsu -- pengganti IndexedDB sungguhan (yang cuma ada
 * di browser) supaya ChunkPersistenceStore bisa diuji lewat `node --test`.
 * Sengaja meniru IndexedDB dengan MENYIMPAN REFERENCE OBJECT langsung (mirip
 * structured clone yang mempertahankan tipe typed array), bukan JSON
 * stringify -- konsisten dengan bagaimana IndexedDB sungguhan bekerja.
 */
function makeFakeAdapter() {
  const store = new Map();
  return {
    store, // diekspos supaya test bisa introspeksi langsung kalau perlu
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe('ChunkPersistenceStore — konstruksi', () => {
  test('menolak adapter tanpa method get/put', () => {
    assert.throws(() => new ChunkPersistenceStore({}));
    assert.throws(() => new ChunkPersistenceStore({ get: () => {} })); // tidak ada put
  });

  test('adapter tanpa delete() tetap valid (delete jadi opsional)', () => {
    assert.doesNotThrow(() => new ChunkPersistenceStore({ get: () => {}, put: () => {} }));
  });
});

describe('ChunkPersistenceStore — save/load round-trip (SDFStorage)', () => {
  test('storage yang disimpan lalu dimuat kembali menghasilkan data SDF yang identik', async () => {
    const adapter = makeFakeAdapter();
    const store = new ChunkPersistenceStore(adapter, 'test-world');

    const original = new SDFStorage(4, 4, 4);
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++)
        for (let z = 0; z < 4; z++) original.setSDF(x, y, z, (x + y + z) * 0.1 - 0.5);

    await store.save(2, 0, -3, original);
    const loaded = await store.load(2, 0, -3);

    assert.ok(loaded, 'chunk yang baru disimpan harus bisa dimuat kembali');
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++)
        for (let z = 0; z < 4; z++) {
          assert.equal(
            loaded.getSDF(x, y, z),
            original.getSDF(x, y, z),
            `SDF di (${x},${y},${z}) harus identik setelah round-trip save/load`
          );
        }
  });

  test('storage yang disimpan lalu dimuat kembali menghasilkan data yang identik (FlatGridStorage)', async () => {
    const adapter = makeFakeAdapter();
    const store = new ChunkPersistenceStore(adapter);

    const original = new FlatGridStorage(4, 4, 4);
    original.set(1, 2, 3, 7);
    original.set(0, 0, 0, 5);

    await store.save(0, 0, 0, original);
    const loaded = await store.load(0, 0, 0);

    assert.equal(loaded.get(1, 2, 3), 7);
    assert.equal(loaded.get(0, 0, 0), 5);
    assert.equal(loaded.get(2, 2, 2), 0, 'voxel yang tidak pernah di-set harus tetap default (0)');
  });

  test('load() untuk chunk yang belum pernah disimpan mengembalikan null (bukan error)', async () => {
    const adapter = makeFakeAdapter();
    const store = new ChunkPersistenceStore(adapter);

    const loaded = await store.load(99, 99, 99);
    assert.equal(loaded, null);
  });
});

describe('ChunkPersistenceStore — namespacing worldId', () => {
  test('dua ChunkPersistenceStore dengan worldId berbeda TIDAK bentrok walau berbagi adapter yang sama', async () => {
    const adapter = makeFakeAdapter();
    const storeA = new ChunkPersistenceStore(adapter, 'world-a');
    const storeB = new ChunkPersistenceStore(adapter, 'world-b');

    const storageA = new SDFStorage(2, 2, 2);
    storageA.setSDF(0, 0, 0, -1.0);
    const storageB = new SDFStorage(2, 2, 2);
    storageB.setSDF(0, 0, 0, 1.0);

    // Koordinat chunk SAMA (0,0,0) di kedua dunia -- harus tetap terpisah.
    await storeA.save(0, 0, 0, storageA);
    await storeB.save(0, 0, 0, storageB);

    const loadedA = await storeA.load(0, 0, 0);
    const loadedB = await storeB.load(0, 0, 0);

    assert.equal(loadedA.getSDF(0, 0, 0), -1.0);
    assert.equal(loadedB.getSDF(0, 0, 0), 1.0);
  });

  test('worldId default adalah "default" kalau tidak diberikan', async () => {
    const adapter = makeFakeAdapter();
    const store = new ChunkPersistenceStore(adapter);
    const storage = new SDFStorage(2, 2, 2);
    await store.save(1, 0, 1, storage);

    assert.ok(adapter.store.has('default:1,0,1'));
  });
});

describe('ChunkPersistenceStore — delete', () => {
  test('delete() menghapus data tersimpan, load() berikutnya mengembalikan null lagi', async () => {
    const adapter = makeFakeAdapter();
    const store = new ChunkPersistenceStore(adapter);
    const storage = new SDFStorage(2, 2, 2);
    await store.save(5, 0, 5, storage);
    assert.ok(await store.load(5, 0, 5));

    await store.delete(5, 0, 5);

    assert.equal(await store.load(5, 0, 5), null);
  });

  test('delete() pada adapter tanpa method delete() tidak error (no-op aman)', async () => {
    const store = new ChunkPersistenceStore({ get: async () => null, put: async () => {} });
    await assert.doesNotReject(() => store.delete(0, 0, 0));
  });
});

describe('ChunkPersistenceStore — key format', () => {
  test('key mengikuti format "worldId:cx,cy,cz" (dipakai adapter IndexedDB sungguhan sebagai keyPath)', async () => {
    const adapter = makeFakeAdapter();
    const store = new ChunkPersistenceStore(adapter, 'myworld');
    const storage = new SDFStorage(2, 2, 2);

    await store.save(-3, 7, 12, storage);

    assert.ok(adapter.store.has('myworld:-3,7,12'));
  });
});
