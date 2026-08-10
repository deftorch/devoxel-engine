import { VoxelMesher } from './VoxelMesher.js';

/**
 * AsyncWorkerMesher
 * ---------------------------------------------------------------------------
 * Plugin mesher yang mengirimkan pekerjaan pembuatan polygon ke Web Worker pool.
 * Ini mencegah Main Thread dari macet saat merender dunia besar.
 */
export class AsyncWorkerMesher extends VoxelMesher {
  constructor() {
    super('AsyncWorkerMesher');
    const poolSize = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = [];
    this.freeWorkers = [];
    this.jobQueue = [];
    this.callbacks = new Map();
    this.jobIdCounter = 0;

    for (let i = 0; i < poolSize; i++) {
      const w = new Worker(new URL('../../game/workers/mesher.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this.onWorkerMessage(e, w);
      w.onerror = (e) => console.error('[AsyncWorkerMesher] Worker error:', e);
      this.workers.push(w);
      this.freeWorkers.push(w);
    }
  }

  onWorkerMessage(e, worker) {
    const { cx, cz, vertexData, indexData, indexCount, rtData, stats, jobId } = e.data;
    this.freeWorkers.push(worker);

    const resolve = this.callbacks.get(jobId);
    if (resolve) {
      this.callbacks.delete(jobId);
      // PENTING: Karena worker digunakan oleh mode WebGPU dan Raytrace,
      // kita harus mereturn format mesh yang sesuai. 
      // VoxelEngine tidak peduli isinya apa, ia hanya menyimpannya di chunk.mesh
      let meshData;
      if (rtData) {
        meshData = { rtData, stats };
      } else {
        meshData = { vertexData, indexData, indexCount, stats };
      }
      resolve(meshData);
    }

    this.processQueue();
  }

  processQueue() {
    if (this.jobQueue.length === 0 || this.freeWorkers.length === 0) return;

    const worker = this.freeWorkers.pop();
    const job = this.jobQueue.shift();
    
    // Simpan id job supaya tahu saat worker selesai
    const jobId = this.jobIdCounter++;
    this.callbacks.set(jobId, job.resolve);

    const payload = {
      jobId,
      cx: job.chunkCoord[0],
      cz: job.chunkCoord[2],
      storagePayload: job.storagePayload,
      renderMode: job.renderMode
    };

    // Kita copy buffer data agar cepat
    let transfer = [];
    if (payload.storagePayload.data && payload.storagePayload.data.buffer) {
      transfer.push(payload.storagePayload.data.buffer);
    } else if (payload.storagePayload.topGrid && payload.storagePayload.topGrid.buffer) {
      transfer.push(payload.storagePayload.topGrid.buffer);
      transfer.push(payload.storagePayload.brickPool.buffer);
    }

    // Perhatian: Karena kita men-transfer buffer, storage asli di Main Thread
    // mungkin kehilangan buffernya jika tidak di-copy! 
    // Oleh karena itu, kita lebih baik tidak men-transfer, biarkan ter-copy.
    // Jika data terlepas (detached), render utama akan rusak.
    // Jadi HAPUS TRANSFER ARRAY.
    
    worker.postMessage(payload);
  }

  generateMesh(chunkStorage, ctx) {
    return new Promise((resolve, reject) => {
      // Dapatkan mode dari elemen UI saat ini (karena engine ini tadinya di game/main.js)
      // Idealnya VoxelEngine menyimpan state currentRenderMode, 
      // tapi untuk sementara kita membacanya dari DOM (seperti sebelumnya).
      let renderMode = 'raster';
      const renderSelect = document.getElementById('render-select');
      if (renderSelect) renderMode = renderSelect.value;

      if (!chunkStorage.serialize) {
        console.error('[AsyncWorkerMesher] Storage tidak memiliki metode serialize(). Async meshing dibatalkan.');
        resolve(null);
        return;
      }

      this.jobQueue.push({
        chunkCoord: ctx.chunkCoord,
        storagePayload: chunkStorage.serialize(),
        renderMode,
        resolve
      });
      
      this.processQueue();
    });
  }

  destroy() {
    for (const w of this.workers) w.terminate();
  }
}
