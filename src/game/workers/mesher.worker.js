import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from '../../core/config.js';
import { generateChunkVoxels } from '../world/chunk.js';
import { greedyMesh, buildMeshFromQuads } from '../world/meshing.js';

self.onmessage = (e) => {
  const { cx, cz, storageType, terrainType, renderMode } = e.data;

  const t0 = performance.now();
  const storage = generateChunkVoxels(cx, cz, storageType, terrainType);
  const t1 = performance.now();
  const nodes = storage.nodeCount || CHUNK_SX * CHUNK_SY * CHUNK_SZ;

  if (renderMode === 'raytrace') {
    let rtData = null;
    let transfer = [];
    if (storage.serialize) {
      rtData = storage.serialize();
      transfer = [rtData.topGrid.buffer, rtData.brickPool.buffer];
    }

    self.postMessage(
      { cx, cz, vertexData: null, indexData: null, indexCount: 0, rtData, stats: { genMs: t1 - t0, meshMs: 0, nodes } },
      transfer
    );
    return;
  }

  const get = (x, y, z) => storage.get(x, y, z);

  const quads = greedyMesh(storage.dims, get);
  const t2 = performance.now();

  const mesh = buildMeshFromQuads(quads, cx * CHUNK_SX, cz * CHUNK_SZ);

  self.postMessage(
    {
      cx,
      cz,
      vertexData: mesh.vertexData,
      indexData: mesh.indexData,
      indexCount: mesh.indexCount,
      stats: { genMs: t1 - t0, meshMs: t2 - t1, nodes },
    },
    [mesh.vertexData.buffer, mesh.indexData.buffer]
  );
};
