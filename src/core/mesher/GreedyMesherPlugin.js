import { MesherPlugin } from './MesherPlugin.js';
// Mengambil algoritma greedy klasik dari folder game/world milikmu sebelumnya
import { greedyMesh, buildMeshFromQuads } from '../../game/world/meshing.js';

/**
 * Implementasi Mesher "Gaya Minecraft" (Blocky/Cubic) yang mengkalkulasi penggabungan poligon.
 * Sangat optimal untuk merender bangunan arsitektur atau terrain kotak statis.
 */
export class GreedyMesherPlugin extends MesherPlugin {
  constructor() {
    super('GreedyMesher');
  }

  /**
   * Mengubah data voxel mentah menjadi geometri siap-render.
   * @param {Object} chunkStorage - Objek VoxelStorage (Bisa FlatGrid, Tree64, dll)
   */
  generateMesh(chunkStorage) {
    const dims = chunkStorage.dims;
    
    // Langkah 1: Ekstrak "wajah" kubus dan gabungkan menjadi Quad besar (Greedy)
    // Karena kita tidak tahu apakah storage itu FlatGrid atau Tree64,
    // kita cukup panggil fungsi abstrak .get(x,y,z) yang dimiliki semua storage!
    const quads = greedyMesh(dims, (x, y, z) => chunkStorage.get(x, y, z));
    
    // Langkah 2: Ubah array quad menjadi Vertex Buffer dan Index Buffer
    // Origin 0,0 digunakan di sini karena perhitungan offset posisi global per-chunk 
    // idealnya dilakukan di GPU (Vertex Shader) menggunakan Uniforms, bukan di-hardcode ke mesh.
    const meshData = buildMeshFromQuads(quads, 0, 0);
    
    return meshData;
  }
}
