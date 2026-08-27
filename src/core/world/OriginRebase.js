/**
 * OriginRebase — logika murni untuk Roadmap A.5 (Origin Rebasing / Precision).
 * ---------------------------------------------------------------------------
 * Sengaja dipisah dari VoxelEngine/renderer -- sama seperti ChunkStreamer.js
 * (A.1) dan ChunkGenerationQueue.js (A.2) -- supaya keputusan KAPAN origin
 * harus di-rebase bisa diuji sebagai fungsi murni tanpa mesher/GPU sungguhan.
 *
 * --- Masalah yang diselesaikan ---
 * SurfaceNetsMesher/GreedyMesher membakar posisi vertex sebagai
 * `chunkCoord * dims` (world-absolute) langsung ke `vertexData`, yang
 * akhirnya disimpan sebagai `Float32Array` di GPU vertex buffer (lihat
 * `webgpu/engine.js#createMesh`). Float32 cuma punya ~7 digit desimal
 * presisi -- begitu pemain jalan jauh dari origin awal (>100.000 unit,
 * lihat acceptance test A.5 di roadmap), angka absolut yang dibakar itu
 * sendiri sudah kehilangan presisi SEBELUM sempat disentuh shader apapun,
 * menyebabkan robekan/z-fighting/"jitter" visual pada mesh statis
 * (root-cause diverifikasi lewat skrip di commit ini -- lihat pesan commit).
 *
 * --- Strategi: rebase JARANG, bukan tiap frame ---
 * Solusi paling murah & paling rendah risiko: bakar posisi vertex RELATIF
 * terhadap sebuah "origin chunk" (bukan relatif ke (0,0,0) mutlak), dan
 * geser origin chunk itu HANYA ketika pemain sudah cukup jauh darinya
 * (bukan tiap frame -- itu akan memicu remesh SEMUA chunk yang sedang
 * loaded tiap kali origin bergeser, karena vertex data yang sudah terlanjur
 * dibakar relatif ke origin LAMA jadi tidak valid lagi relatif ke origin
 * BARU). `rebaseThresholdChunks` mengontrol trade-off ini:
 *   - Makin BESAR threshold -> makin JARANG rebase (remesh massal makin
 *     jarang terjadi, biaya performa lebih rendah), tapi angka absolut yang
 *     dibakar di antara rebase juga makin besar (meski tetap jauh lebih
 *     kecil dari "satu float besar" world-absolute yang lama).
 *   - Makin KECIL threshold -> presisi vertex makin bagus, tapi rebase
 *     (dan remesh massal yang menyertainya) lebih sering.
 * Nilai default yang masuk akal ada di config.js (`DEFAULT_REBASE_THRESHOLD_CHUNKS`),
 * dipilih cukup besar (puluhan chunk) supaya rebase jarang terjadi selama
 * gameplay normal, tapi cukup kecil supaya presisi tetap sangat aman
 * (bandingkan dengan ambang 100.000 unit di acceptance test).
 */
export class OriginRebase {
  /**
   * @param {number} rebaseThresholdChunks - jarak Chebyshev (dalam satuan
   *   chunk) dari origin saat ini yang memicu rebase kalau dilampaui.
   */
  constructor(rebaseThresholdChunks) {
    if (!Number.isInteger(rebaseThresholdChunks) || rebaseThresholdChunks < 1) {
      throw new Error(
        `[OriginRebase] rebaseThresholdChunks harus integer >= 1, dapat: ${rebaseThresholdChunks}`
      );
    }
    this.rebaseThresholdChunks = rebaseThresholdChunks;
    this.originChunkX = 0;
    this.originChunkZ = 0;
  }

  /** Jarak Chebyshev pemain saat ini (pcx, pcz) terhadap origin yang sedang dipakai. */
  distanceFromOrigin(pcx, pcz) {
    return Math.max(Math.abs(pcx - this.originChunkX), Math.abs(pcz - this.originChunkZ));
  }

  /**
   * Panggil tiap kali chunk (cx, cz) pemain berubah (sama seperti
   * ChunkStreamer.update() -- dipakai bersamaan di titik yang sama di
   * render loop). Origin di-rebase (dipindah PERSIS ke chunk pemain saat
   * ini, bukan setengah jalan) kalau jaraknya sudah melampaui
   * `rebaseThresholdChunks`.
   *
   * @returns {boolean} true kalau origin baru saja di-rebase. Caller WAJIB
   *   memperlakukan true sebagai sinyal untuk menandai ulang (remesh) semua
   *   chunk yang sedang loaded -- lihat VoxelEngine.setOriginChunk(), yang
   *   mengikuti pola persis yang sama dengan setDebugChunkBounds().
   */
  update(pcx, pcz) {
    if (this.distanceFromOrigin(pcx, pcz) <= this.rebaseThresholdChunks) return false;
    this.originChunkX = pcx;
    this.originChunkZ = pcz;
    return true;
  }
}
