import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from '../../core/config.js';
import { greedyMesh, buildMeshFromQuads } from '../world/meshing.js';
import { FlatGridStorage } from '../../core/voxel/FlatGridStorage.js';
import { BrickMapStorage } from '../../core/voxel/BrickMapStorage.js';

self.onmessage = (e) => {
  const { cx, cz, storagePayload, renderMode } = e.data;

  const t1 = performance.now();
  let storage;
  if (storagePayload.type === 'flatgrid') {
    storage = FlatGridStorage.deserialize(storagePayload);
  } else if (storagePayload.type === 'brickmap') {
    storage = BrickMapStorage.deserialize(storagePayload);
  } else {
    throw new Error('Unsupported storage type in worker: ' + storagePayload.type);
  }

  const nodes = storage.nodeCount || storage.dims[0] * storage.dims[1] * storage.dims[2];

  if (renderMode === 'raytrace') {
    let rtData = null;
    let transfer = [];
    if (storage.serialize) {
      rtData = storage.serialize();
      transfer = [rtData.topGrid.buffer, rtData.brickPool.buffer];
    }
    self.postMessage(
      { jobId: e.data.jobId, cx, cz, vertexData: null, indexData: null, indexCount: 0, rtData, stats: { genMs: 0, meshMs: performance.now() - t1, nodes } },
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
      jobId: e.data.jobId,
      cx,
      cz,
      vertexData: mesh.vertexData,
      indexData: mesh.indexData,
      indexCount: mesh.indexCount,
      stats: { genMs: 0, meshMs: t2 - t1, nodes },
    },
    [mesh.vertexData.buffer, mesh.indexData.buffer]
  );
};
