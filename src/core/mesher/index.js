import { defaultRegistry } from '../registry/PluginRegistry.js';

import { VoxelMesher } from './VoxelMesher.js';
import { GreedyMesher } from './GreedyMesher.js';
import { AsyncWorkerMesher } from './AsyncWorkerMesher.js';
import { SurfaceNetsMesher } from './SurfaceNetsMesher.js';

defaultRegistry.registerMesher('greedy', () => new GreedyMesher(), {
  label: 'Greedy Mesher',
  description: 'Merges adjacent block faces into large quads. Best for blocky/cubic terrain.',
});

defaultRegistry.registerMesher('greedy_async', () => new AsyncWorkerMesher('greedy'), {
  label: 'Greedy Mesher (Async/Worker)',
  description: 'Offloads greedy meshing to a background thread to prevent UI freezing.'
});

defaultRegistry.registerMesher('surfacenets', () => new SurfaceNetsMesher(), {
  label: 'Surface Nets',
  description: 'Extracts smooth isosurfaces from SDF/density storage.'
});

// Add more built-in meshers here as they're implemented, e.g.:
// defaultRegistry.registerMesher('marching-cubes', () => new MarchingCubesVoxelMesher(), {...});
// defaultRegistry.registerMesher('dual-contouring', () => new DualContouringVoxelMesher(), {...});

export { VoxelMesher, GreedyMesher, AsyncWorkerMesher, SurfaceNetsMesher };
