import { VoxelRenderer } from './VoxelRenderer.js';
import { initWebGL } from './webgl/engine.js';
import { initWebGPU } from './webgpu/engine.js';

/**
 * VoxelRendererAdapter
 * ---------------------------------------------------------------------------
 * Wraps one of the existing backend initializers (initWebGL, initWebGPU,
 * initComputeRT) so it satisfies the VoxelRenderer contract used by
 * VoxelEngine's pluggable system, WITHOUT breaking the raw API
 * (createMesh, draw, getVoxel, editVoxel, getDiagnostics, ...) that
 * game/main.js already calls directly.
 *
 * All original methods on the raw backend object are copied onto the
 * adapter instance, so `adapter.draw(...)` still works exactly like
 * before, while `adapter.init(canvas)` / `adapter.render(time)` give you
 * the uniform framework contract when driving the engine generically.
 */
export class VoxelRendererAdapter extends VoxelRenderer {
  /**
   * @param {string} name - plugin id, e.g. 'webgl', 'webgpu', 'raytrace'
   * @param {(canvas: HTMLCanvasElement, options: Object) => Promise<Object>} initFn
   */
  constructor(name, initFn) {
    super(name);
    this._initFn = initFn;
    this.raw = null;
  }

  async init(canvas, options = {}) {
    this.canvas = canvas;
    this.raw = await this._initFn(canvas, options);

    // Expose every method/property of the raw backend directly on `this`
    // so existing call sites (renderer.draw(...), renderer.getVoxel(...))
    // keep working unchanged even when obtained through the registry.
    for (const key of Object.keys(this.raw)) {
      if (this[key] === undefined) {
        this[key] = typeof this.raw[key] === 'function' ? this.raw[key].bind(this.raw) : this.raw[key];
      }
    }

    this.ready = true;
    return this;
  }

  createMesh(vertexData, indexData) {
    if (!this.raw) throw new Error(`[${this.name}] Renderer belum di-init(). Panggil init(canvas) dulu.`);
    return this.raw.createMesh(vertexData, indexData);
  }

  /**
   * Generic per-frame hook for engines using VoxelEngine's render loop.
   * Raster backends (WebGL/WebGPU) are normally driven manually via
   * `.draw(cameraState, ...)` from the ECS render system instead, so this
   * is a no-op unless the raw backend exposes its own `render`/`frame`.
   */
  render(time) {
    if (this.raw && typeof this.raw.render === 'function') {
      return this.raw.render(time);
    }
    // No-op: caller is expected to invoke `.draw(...)` themselves each frame.
  }

  drawDebugPrimitives(cameraState, debugData) {
    if (this.raw && typeof this.raw.drawDebugPrimitives === 'function') {
      return this.raw.drawDebugPrimitives(cameraState, debugData);
    }
  }

  destroy() {
    if (this.raw && typeof this.raw.destroy === 'function') {
      this.raw.destroy();
    }
  }
}

export async function createWebGLVoxelRenderer(canvas, options) {
  return new VoxelRendererAdapter('webgl', initWebGL).init(canvas, options);
}

export async function createWebGPUVoxelRenderer(canvas, options) {
  return new VoxelRendererAdapter('webgpu', initWebGPU).init(canvas, options);
}

export async function createRaytraceVoxelRenderer(canvas, options) {
  const { initComputeRT } = await import('./webgpu/raytrace.js');
  return new VoxelRendererAdapter('raytrace', initComputeRT).init(canvas, options);
}
