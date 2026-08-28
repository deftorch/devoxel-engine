import { defaultRegistry } from '../registry/PluginRegistry.js';

import { VoxelStorage } from './VoxelStorage.js';
import { FlatGridStorage } from './FlatGridStorage.js';
import { OctreeStorage } from './OctreeStorage.js';
import { SVDAGStorage } from './SVDAGStorage.js';
import { Tree64Storage } from './Tree64Storage.js';
import { BrickMapStorage } from './BrickMapStorage.js';
import { SDFStorage } from './SDFStorage.js';
import { QuantizedSDFStorage } from './QuantizedSDFStorage.js';
import { deserializeStorage } from './deserializeStorage.js';

// Register every built-in storage backend under a short id so VoxelEngine
// can resolve them purely from config, e.g. `{ storage: 'octree' }`.
defaultRegistry.registerStorage('flatgrid', (sx, sy, sz) => new FlatGridStorage(sx, sy, sz), {
  label: 'Flat Grid',
  description: 'Dense array. Fastest access, highest memory usage.',
});

defaultRegistry.registerStorage('octree', (sx, sy, sz) => new OctreeStorage(sx, sy, sz), {
  label: 'Octree',
  description: 'Sparse hierarchical storage, good for large homogeneous regions.',
});

defaultRegistry.registerStorage('svdag', (sx, sy, sz) => new SVDAGStorage(sx, sy, sz), {
  label: 'SVDAG',
  description: 'Sparse Voxel DAG, deduplicates identical subtrees for compact static scenes.',
});

defaultRegistry.registerStorage('tree64', (sx, sy, sz) => new Tree64Storage(sx, sy, sz), {
  label: 'Tree64 (64-tree)',
  description: 'Wide branching factor tree with bitmask occupancy, GPU-friendly.',
});

defaultRegistry.registerStorage('brickmap', (sx, sy, sz) => new BrickMapStorage(sx, sy, sz), {
  label: 'BrickMap',
  description: 'Sectorized 8^3 bricks, good balance of edit speed and memory.',
});

defaultRegistry.registerStorage('sdf', (sx, sy, sz) => new SDFStorage(sx, sy, sz), {
  label: 'Signed Distance Field',
  description: 'Stores distance-to-surface, ideal for smooth/organic terrain and raymarching.',
});

defaultRegistry.registerStorage('sdf-compact', (sx, sy, sz) => new QuantizedSDFStorage(sx, sy, sz), {
  label: 'Signed Distance Field (Compact, Int16)',
  description:
    'Roadmap B.4 -- setengah memori dari SDF biasa (Int16 vs Float32), drop-in compatible untuk SurfaceNetsMesher. Dipakai untuk chunk jauh dari pemain di jalur streaming.',
});

export {
  VoxelStorage,
  FlatGridStorage,
  OctreeStorage,
  SVDAGStorage,
  Tree64Storage,
  BrickMapStorage,
  SDFStorage,
  QuantizedSDFStorage,
  deserializeStorage,
};
