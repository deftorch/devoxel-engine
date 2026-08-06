/**
 * Base class/interface for Voxel Storage Abstraction.
 * Any voxel data structure (Flat Grid, Octree, BrickMap) must implement these methods.
 */
export class VoxelStorage {
  constructor(dims) {
    this.dims = dims; // [sizeX, sizeY, sizeZ]
  }

  /**
   * Get the block ID at local chunk coordinates
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} Block ID
   */
  get(x, y, z) {
    throw new Error('Not implemented');
  }

  /**
   * Set the block ID at local chunk coordinates
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} val - Block ID
   */
  set(x, y, z, val) {
    throw new Error('Not implemented');
  }
}
