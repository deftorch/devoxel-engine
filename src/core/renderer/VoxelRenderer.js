/**
 * Base class/interface for all Renderer plugins in the Universal Voxel Framework.
 * A renderer plugin owns the graphics backend (WebGL2, WebGPU raster, WebGPU
 * raytracing, or any future backend) and exposes a uniform surface so
 * VoxelEngine never has to know which one is active.
 *
 * Implementations wrap the existing init-style functions (initWebGL,
 * initWebGPU, initComputeRT) so the underlying rendering code doesn't
 * need to be rewritten.
 */
export class VoxelRenderer {
  constructor(name) {
    this.name = name || 'BaseRenderer';
    this.canvas = null;
    this.ready = false;
  }

  /**
   * Initialize the graphics backend against a canvas. Must be called
   * before render(). Returns `this` for chaining.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [options]
   */
  async init(canvas, options = {}) {
    throw new Error(`[VoxelRenderer] init() not implemented in ${this.name}!`);
  }

  /**
   * Upload mesh data (from a VoxelMesher) to the GPU and return a handle
   * the backend can draw later. Optional — raytracing/voxel-native
   * backends may not need traditional meshes.
   * @param {Float32Array} vertexData
   * @param {Uint32Array|Uint16Array} indexData
   */
  createMesh(vertexData, indexData) {
    throw new Error(`[VoxelRenderer] createMesh() not implemented in ${this.name}!`);
  }

  /**
   * Called once per frame by VoxelEngine's render loop.
   * @param {number} time - timestamp from requestAnimationFrame
   */
  render(time) {
    throw new Error(`[VoxelRenderer] render() not implemented in ${this.name}!`);
  }

  /**
   * Queue debug primitives (lines and triangles) for the next draw call.
   * This provides a standard interface for drawing grids, outlines, and gizmos
   * without tying the app code to WebGPU/WebGL specific buffers.
   * @param {Object} cameraState - Same camera state passed to draw()
   * @param {Object} debugData - { lines: [...], tris: [...] }
   */
  drawDebugPrimitives(cameraState, debugData) {
    // Optional to implement, default no-op if the backend doesn't support debug rendering
    console.warn(`[VoxelRenderer] drawDebugPrimitives() not implemented in ${this.name}!`);
  }

  /** Release GPU resources. */
  destroy() {
    // Override in subclass if cleanup is needed.
  }
}
