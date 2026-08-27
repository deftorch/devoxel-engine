import { ChunkGenerationQueue } from './ChunkGenerationQueue.js';

/**
 * ChunkGenerationWorkerPool — Roadmap A.2 (Generation ke Worker Pool).
 * ---------------------------------------------------------------------------
 * Duplikasi pola `AsyncWorkerMesher` (lihat `src/core/mesher/AsyncWorkerMesher.js`)
 * tapi untuk WORLD GENERATION, bukan meshing: worker menerima
 * `(cx, cz, storageType, terrainType)`, menjalankan `generateChunkVoxels()`
 * di dalam worker (`src/game/workers/generator.worker.js`), lalu kirim balik
 * data storage yang sudah jadi lewat Transferable Object (lihat B.3 --
 * `postMessage(payload, [buffer])`, bukan structured-clone penuh).
 *
 * Job queue diprioritaskan berdasar jarak ke pemain (`priorityDistance`),
 * bukan FIFO -- didelegasikan ke `ChunkGenerationQueue` supaya urutannya
 * bisa diuji tanpa Worker sungguhan (lihat komentar di sana).
 *
 * PENTING soal race condition (dicatat juga di commit A.4 / `main.js`):
 * class ini TIDAK menyentuh `engine.chunks` sama sekali -- dia cuma
 * menghasilkan storage yang sudah jadi lewat Promise. Titik pemanggilan
 * `engine.markChunkLoaded()` tetap sama seperti versi sinkron (A.1): begitu
 * storage chunk siap, dari sumber manapun (generate sinkron, worker ini,
 * atau nanti IndexedDB di A.3). Yang berubah cuma window waktu antara
 * `getOrCreateChunk()` (chunk placeholder kosong masuk `engine.chunks`) dan
 * storage aslinya siap -- jadi lebih lebar karena async, tapi TIDAK
 * berbahaya: `SurfaceNetsMesher._getSDF()` fallback ke 1.0 (udara) baik
 * untuk neighbor yang belum ada MAUPUN yang ada tapi storage-nya masih
 * placeholder kosong (SDFStorage default constructor mengisi 1.0 di semua
 * sel) -- jadi mesh yang sempat dibangun dari placeholder itu identik
 * dengan mesh yang dibangun seolah neighbor-nya belum ada, dan begitu data
 * asli tiba, `markChunkLoaded()` tetap menandai dirty semua tetangga yang
 * sudah ada, memaksa remesh ulang yang benar.
 */
export class ChunkGenerationWorkerPool {
  /**
   * @param {object} [options]
   * @param {number} [options.poolSize] - jumlah worker. Default: sama
   *   dengan heuristik AsyncWorkerMesher (hardwareConcurrency - 1, dibatasi 1..8).
   */
  constructor(options = {}) {
    const poolSize = options.poolSize || Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

    this.workers = [];
    this.freeWorkers = [];
    this.queue = new ChunkGenerationQueue();

    /** jobId -> resolve() dari Promise yang dikembalikan requestChunk() */
    this.callbacks = new Map();

    /**
     * jobId yang sudah terlanjur dikirim ke worker TAPI dibatalkan
     * (cancel() dipanggil setelah job tidak lagi ada di this.queue) --
     * hasilnya nanti dibuang begitu worker selesai, bukan diterapkan.
     */
    this.cancelledJobIds = new Set();

    /** key ("cx,cz") -> jobId TERBARU yang masih relevan untuk key ini. */
    this.jobIdByKey = new Map();

    this.jobIdCounter = 0;

    for (let i = 0; i < poolSize; i++) {
      const w = new Worker(new URL('../../game/workers/generator.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onWorkerMessage(e, w);
      w.onerror = (e) => {
        console.error('[ChunkGenerationWorkerPool] Worker error:', e.message, e.filename, e.lineno);
        // Worker ini masih hidup (error di dalam handler, bukan crash proses) --
        // kembalikan ke freeWorkers supaya pool tidak diam-diam menyusut, lalu
        // lanjutkan proses antrian dengan worker lain jika ada.
        this.freeWorkers.push(w);
        this._processQueue();
      };
      this.workers.push(w);
      this.freeWorkers.push(w);
    }
  }

  /**
   * Minta 1 chunk digenerate di background. Boleh dipanggil untuk banyak
   * chunk sekaligus (mis. saat pemain baru masuk radius besar) -- semuanya
   * masuk antrian dan diproses menurut `priorityDistance`, dibatasi oleh
   * jumlah worker yang tersedia.
   *
   * @param {number} cx
   * @param {number} cz
   * @param {string} storageType
   * @param {string} terrainType
   * @param {number} [priorityDistance] - makin kecil makin diprioritaskan
   *   (mis. jarak Chebyshev/Euclidean ke chunk pemain saat ini).
   * @returns {Promise<object|null>} payload hasil `storage.serialize()`
   *   (lihat `deserializeStorage()` untuk membalikkannya jadi instance
   *   VoxelStorage), atau `null` kalau job dibatalkan sebelum sempat
   *   diproses (lihat `cancel()`).
   */
  requestChunk(cx, cz, storageType, terrainType, priorityDistance = 0) {
    return new Promise((resolve) => {
      const key = ChunkGenerationQueue.key(cx, cz);
      const jobId = this.jobIdCounter++;
      this.jobIdByKey.set(key, jobId);
      this.queue.enqueue({ jobId, key, cx, cz, storageType, terrainType, priorityDistance, resolve });
      this._processQueue();
    });
  }

  /**
   * Batalkan permintaan generation untuk (cx, cz), dipanggil saat chunk itu
   * di-unload (ChunkStreamer) sebelum job-nya sempat selesai -- mencegah
   * chunk yang sudah di-unload "hidup lagi" gara-gara hasil worker yang
   * datang telat diterapkan ke `engine.chunks` (lihat pemanggil di
   * `main.js#unloadStreamedChunk`).
   *
   * - Kalau job masih menunggu di antrian (belum dikirim ke worker manapun):
   *   dihapus langsung, promise-nya di-resolve(null).
   * - Kalau job sudah terlanjur dikirim ke worker (in-flight): tidak bisa
   *   dibatalkan di tengah jalan (Worker API tidak mendukung itu), jadi
   *   cuma ditandai supaya hasilnya DIBUANG saat kembali nanti.
   */
  cancel(cx, cz) {
    const key = ChunkGenerationQueue.key(cx, cz);
    const removed = this.queue.removeByKey(key);
    if (removed) {
      removed.resolve(null);
    } else {
      const jobId = this.jobIdByKey.get(key);
      if (jobId != null) this.cancelledJobIds.add(jobId);
    }
    this.jobIdByKey.delete(key);
  }

  _processQueue() {
    while (this.queue.size > 0 && this.freeWorkers.length > 0) {
      const worker = this.freeWorkers.pop();
      const job = this.queue.dequeueNearest();
      this.callbacks.set(job.jobId, job.resolve);
      worker.postMessage({
        jobId: job.jobId,
        cx: job.cx,
        cz: job.cz,
        storageType: job.storageType,
        terrainType: job.terrainType,
      });
    }
  }

  _onWorkerMessage(e, worker) {
    this.freeWorkers.push(worker);
    const { jobId, storagePayload, error } = e.data;

    if (this.cancelledJobIds.has(jobId)) {
      this.cancelledJobIds.delete(jobId);
      this.callbacks.delete(jobId);
      this._processQueue();
      return;
    }

    const resolve = this.callbacks.get(jobId);
    this.callbacks.delete(jobId);
    if (resolve) {
      if (error) {
        console.error('[ChunkGenerationWorkerPool] Worker gagal generate chunk:', error);
        resolve(null);
      } else {
        resolve(storagePayload);
      }
    }

    this._processQueue();
  }

  /** Hentikan semua worker. Dipanggil kalau pool ini tidak akan dipakai lagi. */
  destroy() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.freeWorkers = [];
    this.callbacks.clear();
    this.cancelledJobIds.clear();
    this.jobIdByKey.clear();
  }
}
