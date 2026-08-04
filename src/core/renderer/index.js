import { initWebGPU } from './webgpu/engine.js';
import { initWebGL } from './webgl/engine.js';

export async function createRenderer(canvas, renderMode = 'raster') {
  console.log(`[Renderer] Memulai inisialisasi mesin: ${renderMode}`);
  
  if (renderMode === 'raytrace') {
    const { initComputeRT } = await import('./webgpu/compute_rt.js');
    return await initComputeRT(canvas);
  }

  // Fallback ke Rasterisasi (Poligon)
  if (navigator.gpu) {
    try {
      const gpuRenderer = await initWebGPU(canvas);
      return gpuRenderer;
    } catch(e) {
      console.warn("WebGPU gagal, beralih ke WebGL", e);
    }
  }
  
  return await initWebGL(canvas);
}
