/**
 * ChunkGenerationQueue — logika murni antrian job untuk Roadmap A.2 (Chunk
 * Generation ke Worker Pool).
 * ---------------------------------------------------------------------------
 * Sengaja dipisah dari `ChunkGenerationWorkerPool` (yang menyentuh `Worker`
 * browser API dan tidak bisa di-unit-test di Node) supaya urutan prioritas
 * bisa diuji tanpa worker sungguhan sama sekali -- mengikuti pola yang sama
 * dengan `ChunkStreamer.js` (Roadmap A.1): kelas kecil yang murni menghitung,
 * dipakai oleh kelas lain yang tahu cara menyambungkannya ke Worker nyata.
 *
 * Tanggung jawab HANYA:
 *   1. Menyimpan job generation yang menunggu (belum dikirim ke worker mana
 *      pun) berikut `priorityDistance`-nya.
 *   2. `dequeueNearest()` -- selalu keluarkan job dengan `priorityDistance`
 *      TERKECIL dulu (chunk terdekat ke pemain diproses duluan), BUKAN FIFO
 *      -- sesuai anjuran roadmap A.2, supaya chunk yang langsung terlihat
 *      tidak antre di belakang chunk yang baru saja masuk radius terluar.
 *   3. `removeByKey()` -- membatalkan job yang belum sempat dikirim ke
 *      worker (mis. chunk di-unload lagi sebelum job-nya diproses, karena
 *      pemain jalan cepat bolak-balik lewat batas radius).
 */
export class ChunkGenerationQueue {
  constructor() {
    /** @type {Array<object>} job = { key, priorityDistance, ...payload apapun } */
    this._jobs = [];
  }

  /** Kunci kanonik "cx,cz" dipakai konsisten oleh queue & worker pool. */
  static key(cx, cz) {
    return `${cx},${cz}`;
  }

  /** Jumlah job yang masih menunggu (belum dikirim ke worker manapun). */
  get size() {
    return this._jobs.length;
  }

  /** True kalau ada job menunggu untuk key ini. */
  hasKey(key) {
    return this._jobs.some((j) => j.key === key);
  }

  enqueue(job) {
    if (!job || typeof job.key !== 'string') {
      throw new Error('[ChunkGenerationQueue] job harus punya field `key` (string).');
    }
    this._jobs.push(job);
  }

  /**
   * Keluarkan & hapus job dengan `priorityDistance` terkecil. Tie-break:
   * job yang di-enqueue lebih dulu menang (stable terhadap urutan insersi
   * di antara jarak yang sama), supaya urutan tetap deterministik untuk
   * pengujian.
   * @returns {object|null} job, atau null kalau antrian kosong.
   */
  dequeueNearest() {
    if (this._jobs.length === 0) return null;
    let bestIdx = 0;
    for (let i = 1; i < this._jobs.length; i++) {
      if (this._jobs[i].priorityDistance < this._jobs[bestIdx].priorityDistance) bestIdx = i;
    }
    const [job] = this._jobs.splice(bestIdx, 1);
    return job;
  }

  /**
   * Batalkan job yang masih menunggu (belum dikirim ke worker) untuk key
   * ini. Kalau job-nya sudah terlanjur dikirim ke worker (tidak ada lagi di
   * queue ini), return null -- caller (ChunkGenerationWorkerPool) yang
   * bertanggung jawab menangani kasus "sudah in-flight" lewat jobId.
   * @returns {object|null} job yang dibatalkan, atau null kalau tidak ada di queue.
   */
  removeByKey(key) {
    const idx = this._jobs.findIndex((j) => j.key === key);
    if (idx === -1) return null;
    const [job] = this._jobs.splice(idx, 1);
    return job;
  }
}
