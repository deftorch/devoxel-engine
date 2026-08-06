import { defaultRegistry } from '../registry/PluginRegistry.js';
import { VoxelRenderer } from './VoxelRenderer.js';
import {
  VoxelRendererAdapter,
  createWebGLVoxelRenderer,
  createWebGPUVoxelRenderer,
  createRaytraceVoxelRenderer,
} from './VoxelRendererAdapter.js';

defaultRegistry.registerRenderer('webgl', createWebGLVoxelRenderer, {
  label: 'WebGL2 (Raster)',
  description: 'Broadest compatibility rasterizer, used as fallback when WebGPU is unavailable.',
});

defaultRegistry.registerRenderer('webgpu', createWebGPUVoxelRenderer, {
  label: 'WebGPU (Raster)',
  description: 'Modern rasterizer using the WebGPU API.',
});

defaultRegistry.registerRenderer('raytrace', createRaytraceVoxelRenderer, {
  label: 'WebGPU Compute Raytracer',
  description: 'Voxel-native raytracing via WebGPU compute shaders.',
});

/**
 * Legacy helper, kept for backward compatibility with existing code
 * (e.g. src/game/main.js) that calls `createRenderer(canvas, mode)`
 * directly instead of going through VoxelEngine/PluginRegistry.
 *
 * New code should prefer:
 *   engine.useRenderer(await registry.createRenderer('webgpu', canvas))
 * or simply configure `{ renderer: 'webgpu' }` in VoxelEngine's options
 * and let the engine resolve + init it automatically.
 */
export async function createRenderer(canvas, renderMode = 'raster') {
  console.log(`[Renderer] Memulai inisialisasi mesin: ${renderMode}`);

  if (renderMode === 'raytrace') {
    return await createRaytraceVoxelRenderer(canvas);
  }

  if (navigator.gpu) {
    try {
      return await createWebGPUVoxelRenderer(canvas);
    } catch (e) {
      console.warn('WebGPU gagal, beralih ke WebGL', e);
    }
  }

  return await createWebGLVoxelRenderer(canvas);
}

export { VoxelRenderer, VoxelRendererAdapter };
