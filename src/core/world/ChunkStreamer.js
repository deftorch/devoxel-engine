/**
 * ChunkStreamer — logika murni untuk Roadmap A.1 (Chunk Streaming Berbasis
 * Posisi Pemain, versi sinkron).
 * ---------------------------------------------------------------------------
 * Sengaja dipisah dari VoxelEngine dan dari render loop supaya bisa diuji
 * tanpa dependency apapun (tidak menyentuh storage, mesher, atau ECS) --
 * mengikuti pola yang sama dengan computeFrustumPlanes()/aabbOutsideFrustum()
 * di core/utils/math.js (Optimisasi B.1): fungsi/kelas kecil yang murni
 * menghitung, dipanggil dari main.js yang tahu cara menyambungkannya ke
 * dunia nyata (engine.getOrCreateChunk / engine.unloadChunk / ECS).
 *
 * Tanggung jawab ChunkStreamer HANYA:
 *   1. Melacak chunk (cx, cz) tempat pemain berada saat ini.
 *   2. Kalau pemain pindah chunk (dibandingkan panggilan update()
 *      sebelumnya), hitung ulang chunk mana yang seharusnya "load" (masuk
 *      radius) dan mana yang seharusnya "unload" (keluar radius).
 *   3. Kalau pemain masih di chunk yang sama, return null (no-op) --
 *      sesuai anjuran roadmap: "Hitung (cx, cz) chunk pemain tiap
 *      interval (bukan tiap frame -- cukup tiap kali pemain pindah
 *      chunk)".
 *
 * Catatan desain:
 * - Radius berbentuk BUJUR SANGKAR (Chebyshev distance), bukan lingkaran --
 *   lebih murah dihitung dan lebih mudah diverifikasi jumlah chunk-nya
 *   secara pasti: (2*viewDistance + 1)^2. Border stitching untuk chunk yang
 *   baru muncul (Fase A.4) belum ditangani di sini -- itu tanggung jawab
 *   VoxelEngine._dirtyBoundaryNeighbors()-style check saat chunk baru
 *   selesai di-load, bukan tanggung jawab streamer ini.
 * - `y` (chunk vertikal) sengaja tidak dilibatkan -- dunia saat ini cuma
 *   1 layer chunk vertikal (lihat WORLD_CHUNKS di config.js), sama seperti
 *   asumsi yang sudah dipakai di buildWorld() (selalu cy = 0).
 */
export class ChunkStreamer {
  /**
   * @param {number} viewDistance - radius dalam satuan chunk (bukan voxel).
   *   Roadmap menganjurkan mulai kecil (4-6) sebelum dibesarkan.
   */
  constructor(viewDistance) {
    if (!Number.isInteger(viewDistance) || viewDistance < 0) {
      throw new Error(`[ChunkStreamer] viewDistance harus integer >= 0, dapat: ${viewDistance}`);
    }
    this.viewDistance = viewDistance;

    /** Chunk (cx, cz) tempat pemain terakhir kali terdeteksi. Null = belum pernah update(). */
    this.lastPlayerChunk = null;

    /** Set semua chunk key ("cx,cz") yang saat ini dianggap "loaded" oleh streamer ini. */
    this.loadedKeys = new Set();
  }

  static _key(cx, cz) {
    return `${cx},${cz}`;
  }

  static _parseKey(key) {
    const [cx, cz] = key.split(',').map(Number);
    return [cx, cz];
  }

  /** Jumlah chunk yang sedang dianggap loaded oleh streamer ini. */
  get loadedCount() {
    return this.loadedKeys.size;
  }

  /** True kalau (cx, cz) sedang dianggap loaded oleh streamer ini. */
  isLoaded(cx, cz) {
    return this.loadedKeys.has(ChunkStreamer._key(cx, cz));
  }

  /**
   * Set chunk key yang SEHARUSNYA loaded untuk pemain di chunk (pcx, pcz):
   * bujur sangkar (2*viewDistance+1) sisi, berpusat di (pcx, pcz).
   */
  _desiredKeySet(pcx, pcz) {
    const desired = new Set();
    const r = this.viewDistance;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        desired.add(ChunkStreamer._key(pcx + dx, pcz + dz));
      }
    }
    return desired;
  }

  /**
   * Panggil dengan chunk coordinate pemain saat ini (BUKAN posisi world --
   * caller bertanggung jawab konversi lewat Math.floor(worldPos / chunkSize),
   * sama seperti VoxelEngine.worldToChunkCoords()).
   *
   * @param {number} pcx
   * @param {number} pcz
   * @returns {null | { toLoad: [number, number][], toUnload: [number, number][] }}
   *   null kalau pemain masih di chunk yang sama dengan panggilan
   *   sebelumnya (no-op, tidak ada yang perlu load/unload). Selain itu,
   *   daftar chunk yang harus di-load dan di-unload supaya set chunk
   *   loaded sesuai radius baru di sekitar pemain.
   */
  update(pcx, pcz) {
    if (this.lastPlayerChunk && this.lastPlayerChunk.cx === pcx && this.lastPlayerChunk.cz === pcz) {
      return null;
    }
    this.lastPlayerChunk = { cx: pcx, cz: pcz };

    const desired = this._desiredKeySet(pcx, pcz);
    const toLoad = [];
    const toUnload = [];

    for (const key of desired) {
      if (!this.loadedKeys.has(key)) toLoad.push(ChunkStreamer._parseKey(key));
    }
    for (const key of this.loadedKeys) {
      if (!desired.has(key)) toUnload.push(ChunkStreamer._parseKey(key));
    }

    for (const [cx, cz] of toLoad) this.loadedKeys.add(ChunkStreamer._key(cx, cz));
    for (const [cx, cz] of toUnload) this.loadedKeys.delete(ChunkStreamer._key(cx, cz));

    return { toLoad, toUnload };
  }

  /** Reset total (dipakai saat world di-rebuild/dibersihkan dari luar). */
  reset() {
    this.lastPlayerChunk = null;
    this.loadedKeys.clear();
  }
}
