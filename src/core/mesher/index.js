import { defaultRegistry } from '../registry/PluginRegistry.js';

import { VoxelMesher } from './VoxelMesher.js';
import { GreedyMesher } from './GreedyMesher.js';

defaultRegistry.registerMesher('greedy', () => new GreedyMesher(), {
  label: 'Greedy Mesher',
  description: 'Merges adjacent block faces into large quads. Best for blocky/cubic terrain.',
});

// Add more built-in meshers here as they're implemented, e.g.:
// defaultRegistry.registerMesher('marching-cubes', () => new MarchingCubesVoxelMesher(), {...});
// defaultRegistry.registerMesher('dual-contouring', () => new DualContouringVoxelMesher(), {...});

export { VoxelMesher, GreedyMesher };
