import { WORLD_CHUNKS } from '../../core/config.js';

export class ChunkMesherPool {
  constructor(poolSize) {
    this.poolSize = poolSize;
    this.workers = [];
    for(let i = 0; i < poolSize; i++) {
      this.workers.push(new Worker(new URL('../workers/mesher.worker.js', import.meta.url), { type: 'module' }));
    }
  }

  async processAllChunks(onProgress, onChunkMesh, storageType = 'flat', terrainType = 'normal', renderMode = 'raster') {
    const totalChunks = WORLD_CHUNKS * WORLD_CHUNKS;
    let received = 0;
    
    const totalStats = { genMs: 0, meshMs: 0, nodes: 0 };

    return new Promise((resolve, reject) => {
      const jobs = [];
      for (let cx = 0; cx < WORLD_CHUNKS; cx++)
        for (let cz = 0; cz < WORLD_CHUNKS; cz++)
          jobs.push({ cx, cz, storageType, terrainType, renderMode });

      this.workers.forEach(w => {
        w.onerror = (e) => reject(new Error('Worker error: ' + e.message));
        w.onmessage = (e) => {
          const { cx, cz, vertexData, indexData, indexCount, stats, rtData } = e.data;
          
          if (stats) {
            totalStats.genMs += stats.genMs;
            totalStats.meshMs += stats.meshMs;
            totalStats.nodes += stats.nodes;
          }
          
          onChunkMesh(cx, cz, vertexData, indexData, indexCount, rtData);
          received++;
          
          if (onProgress) onProgress(received, totalChunks);
          
          const next = jobs.pop();
          if (next) w.postMessage(next);
          else if (received === totalChunks) resolve(totalStats);
        };
        const first = jobs.pop();
        if (first) w.postMessage(first);
      });
    });
  }
}
