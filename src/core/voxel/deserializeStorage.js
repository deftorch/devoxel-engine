import { FlatGridStorage } from './FlatGridStorage.js';
import { SDFStorage } from './SDFStorage.js';

/**
 * Roadmap A.2 -- dispatch balik payload hasil `storage.serialize()` (dikirim
 * lewat `postMessage()` dari `generator.worker.js`) ke instance VoxelStorage
 * yang sesuai, berdasar `payload.type`. Dipakai di main thread setelah
 * `ChunkGenerationWorkerPool` resolve promise-nya.
 *
 * SENGAJA hanya mendukung storage yang representasi internalnya typed-array
 * murni (bisa "dibungkus balik" dari 1-2 buffer tanpa kehilangan struktur):
 * `sdf` dan `flatgrid`. Storage berbasis tree/pointer (Octree, SVDAG,
 * Tree64) TIDAK didukung untuk generation-di-worker -- serialisasinya perlu
 * membangun ulang seluruh struktur pointer, bukan cuma re-wrap 1 ArrayBuffer,
 * dan jalur streaming (`main.js#loadStreamedChunk`) toh cuma pernah memakai
 * `'sdf'`. Kalau nanti butuh storage lain di jalur ini, tambahkan case baru
 * DI SINI plus method serialize()/deserialize() di storage class-nya --
 * jangan buka cabang if/else storageType di VoxelEngine (lihat AGENTS.md §4).
 *
 * @param {{type: string}} payload
 * @returns {import('./VoxelStorage.js').VoxelStorage}
 */
export function deserializeStorage(payload) {
  if (!payload || typeof payload.type !== 'string') {
    throw new Error('[deserializeStorage] Payload tidak valid (tidak ada field `type`).');
  }
  switch (payload.type) {
    case 'sdf':
      return SDFStorage.deserialize(payload);
    case 'flatgrid':
      return FlatGridStorage.deserialize(payload);
    default:
      throw new Error(
        `[deserializeStorage] Storage type '${payload.type}' belum didukung untuk worker generation ` +
          `(Roadmap A.2) -- lihat komentar di deserializeStorage.js.`
      );
  }
}
