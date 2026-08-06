/**
 * Contoh konfigurasi pluggable untuk Devoxel — Universal Voxel Framework.
 * Copy file ini, sesuaikan, lalu pakai untuk membuat VoxelEngine tanpa
 * menyentuh kode engine sama sekali.
 */
import { VoxelEngine } from './index.js';

export const config = {
  chunkSize: [16, 40, 16],

  // Ganti salah satu id di bawah untuk mengganti backend, tanpa refactor:
  //   storage : 'flatgrid' | 'octree' | 'svdag' | 'tree64' | 'brickmap' | 'sdf'
  //   mesher  : 'greedy' | ...plugin custom Anda...
  //   renderer: 'webgl' | 'webgpu' | 'raytrace'
  storage: 'brickmap',
  mesher: 'greedy',
  renderer: 'webgpu',
};

export function createConfiguredEngine(overrides = {}) {
  return new VoxelEngine({ ...config, ...overrides });
}

// --- Contoh pemakaian --------------------------------------------------
//
// import { createConfiguredEngine } from './devoxel.config.example.js';
//
// const engine = createConfiguredEngine();
// engine.setVoxel(0, 0, 0, 1);          // otomatis membuat chunk lewat storageFactory
// engine.remeshDirtyChunks();           // rebuild mesh untuk semua chunk yang berubah
// await engine.start(canvas);           // init renderer 'webgpu' & mulai render loop
//
// Mengganti seluruh tumpukan (storage/mesher/renderer) tinggal ganti string
// id di atas — VoxelEngine akan resolve-nya lewat PluginRegistry.
