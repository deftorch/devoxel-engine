import { defaultRegistry } from '../registry/PluginRegistry.js';

import { VoxelMesher } from './VoxelMesher.js';
import { GreedyMesher } from './GreedyMesher.js';
import { AsyncWorkerMesher } from './AsyncWorkerMesher.js';

defaultRegistry.registerMesher('greedy', () => new GreedyMesher(), {
  label: 'Greedy Mesher',
  description: 'Merges adjacent block faces into large quads. Best for blocky/cubic terrain.',
});

defaultRegistry.registerMesher('worker-greedy', () => new AsyncWorkerMesher(), {
  label: 'Async Worker Greedy Mesher',
  description: 'Greedy Mesher that runs in background workers to prevent main thread stalls.',
});

// Add more built-in meshers here as they're implemented, e.g.:
// defaultRegistry.registerMesher('marching-cubes', () => new MarchingCubesVoxelMesher(), {...});
// defaultRegistry.registerMesher('dual-contouring', () => new DualContouringVoxelMesher(), {...});

export { VoxelMesher, GreedyMesher, AsyncWorkerMesher };
