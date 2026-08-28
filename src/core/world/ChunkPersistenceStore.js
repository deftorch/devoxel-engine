import { deserializeStorage } from '../voxel/deserializeStorage.js';

/**
 * ChunkPersistenceStore — logika murni untuk Roadmap A.3 (Persistensi Chunk
 * yang Diedit).
 * ---------------------------------------------------------------------------
 * Sengaja dipisah dari mekanisme penyimpanan SEBENARNYA (IndexedDB, lihat
 * IndexedDBAdapter.js) lewat parameter `adapter` -- mengikuti pola yang sama
 * dengan ChunkStreamer.js/ChunkGenerationQueue.js: kelas ini HANYA tahu
 * "kapan menyimpan apa dengan key apa", bukan "bagaimana caranya menyimpan
 * ke disk sungguhan". Ini yang membuatnya bisa diuji penuh lewat `node
 * --test` tanpa browser -- tinggal suntik adapter in-memory palsu di test.
 *
 * `adapter` cuma perlu punya 3 method (semua boleh sync ATAU async/Promise,
 * kelas ini selalu `await` hasilnya):
 *   - get(key)          -> value tersimpan, atau undefined/null kalau tidak ada
 *   - put(key, value)   -> simpan value di bawah key
 *   - delete(key)       -> hapus key (dipakai kalau nanti perlu "reset dunia")
 *
 * Serialisasi voxel data-nya SENGAJA reuse `storage.serialize()` /
 * `deserializeStorage()` yang sudah dibangun untuk Roadmap A.2 (generation
 * di worker) -- payload yang sama persis (`{ type, dims, sdf/materials }`)
 * valid dipakai di kedua konteks, jadi tidak ada logic serialisasi baru
 * yang perlu ditulis/diuji dari nol di sini.
 */
export class ChunkPersistenceStore {
  /**
   * @param {{get: Function, put: Function, delete: Function}} adapter
   * @param {string} [worldId='default'] - namespace key, supaya beberapa
   *   dunia/save-slot bisa berbagi adapter/database yang sama tanpa
   *   bentrok key.
   */
  constructor(adapter, worldId = 'default') {
    if (!adapter || typeof adapter.get !== 'function' || typeof adapter.put !== 'function') {
      throw new Error('[ChunkPersistenceStore] adapter harus punya method get(key) dan put(key, value).');
    }
    this.adapter = adapter;
    this.worldId = worldId;
  }

  _key(cx, cy, cz) {
    return `${this.worldId}:${cx},${cy},${cz}`;
  }

  /**
   * Simpan storage sebuah chunk. `storage` harus punya method
   * `.serialize()` (semua VoxelStorage bawaan engine ini punya).
   * @returns {Promise<void>}
   */
  async save(cx, cy, cz, storage) {
    const payload = storage.serialize();
    await this.adapter.put(this._key(cx, cy, cz), payload);
  }

  /**
   * Muat kembali storage sebuah chunk yang pernah disimpan.
   * @returns {Promise<import('../voxel/VoxelStorage.js').VoxelStorage|null>}
   *   instance storage siap pakai, atau null kalau tidak ada data
   *   tersimpan untuk chunk ini (belum pernah diedit/disimpan).
   */
  async load(cx, cy, cz) {
    const payload = await this.adapter.get(this._key(cx, cy, cz));
    if (!payload) return null;
    return deserializeStorage(payload);
  }

  /**
   * Hapus data tersimpan sebuah chunk (dipakai kalau chunk itu di-reset
   * kembali ke default, atau untuk "hapus save" dunia streaming).
   * @returns {Promise<void>}
   */
  async delete(cx, cy, cz) {
    if (typeof this.adapter.delete !== 'function') return; // adapter minimal (get/put saja) -- delete opsional
    await this.adapter.delete(this._key(cx, cy, cz));
  }
}
