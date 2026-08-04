import { VoxelStorage } from './VoxelStorage.js';

/**
 * A dense 1D array implementation of VoxelStorage.
 * Fast O(1) access, but high O(n^3) memory usage.
 */
export class FlatGridStorage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);
    this.data = new Uint8Array(sx * sy * sz);
  }

  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    return this.data[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]];
  }

  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this.data[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]] = val;
  }
}
