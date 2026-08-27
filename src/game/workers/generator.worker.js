import { generateChunkVoxels } from '../world/chunk.js';

/**
 * generator.worker.js — Roadmap A.2 (Generation ke Worker Pool).
 * ---------------------------------------------------------------------------
 * Menjalankan `generateChunkVoxels()` (noise.js + SDF fill di chunk.js) di
 * luar Main Thread, dipakai oleh `ChunkGenerationWorkerPool`. Sebelumnya
 * (Fase A.1) fungsi yang sama dipanggil langsung di Main Thread lewat
 * `loadStreamedChunk()` di `main.js` -- pindah ke sini TIDAK mengubah
 * hasilnya sama sekali (fungsi generation-nya identik), cuma memindahkan DI
 * MANA ia berjalan.
 *
 * Sesuai AGENTS.md §6: worker cuma menghitung data mentah dan
 * mengembalikannya -- tidak pernah menyentuh WebGPU/WebGL.
 */
self.onmessage = (e) => {
  const { jobId, cx, cz, storageType, terrainType } = e.data;
  try {
    const storage = generateChunkVoxels(cx, cz, storageType, terrainType);

    if (typeof storage.serialize !== 'function') {
      // Lihat catatan di deserializeStorage.js: cuma storage berbasis typed
      // array murni (sdf, flatgrid) yang didukung di jalur worker ini.
      throw new Error(
        `Storage '${storageType}' belum punya serialize() -- generation di worker ini cuma didukung untuk ` +
          `storage yang representasinya typed array murni (mis. 'sdf', 'flatgrid'). Storage berbasis ` +
          `tree/pointer (octree, svdag, tree64) belum didukung di jalur streaming worker.`
      );
    }

    const storagePayload = storage.serialize();

    // Roadmap B.3 (prasyarat A.2): kirim balik pakai Transferable Objects,
    // bukan structured-clone penuh, supaya postMessage() balik nyaris
    // instan berapapun ukuran chunk-nya. Cari semua TypedArray di payload
    // secara generik (bukan hardcode nama field) supaya kompatibel dengan
    // storage type manapun yang punya serialize() sekarang atau nanti,
    // selama representasinya typed array.
    const transfer = [];
    for (const value of Object.values(storagePayload)) {
      if (value && value.buffer instanceof ArrayBuffer) transfer.push(value.buffer);
    }

    self.postMessage({ jobId, storagePayload }, transfer);
  } catch (err) {
    self.postMessage({ jobId, error: err.message || 'Worker crash saat generate chunk' });
  }
};
