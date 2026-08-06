/**
 * Kelas Dasar (Interface/Kontrak) untuk semua jenis Mesher di Universal Voxel Engine.
 * Semua pembuat poligon (Greedy, Marching Cubes, dll) harus mewarisi kelas ini.
 */
export class VoxelMesher {
  constructor(name) {
    this.name = name || 'BaseMesher';
  }

  /**
   * Dipanggil oleh VoxelEngine saat sebuah chunk harus dibangun ulang poligonnya.
   * @param {Object} chunkStorage - Objek penyimpanan voxel (contoh: FlatGridStorage, Tree64Storage)
   * @returns {Object} Data Mesh (vertexData, indexData, indexCount)
   */
  generateMesh(chunkStorage) {
    throw new Error(`[VoxelMesher] generateMesh() belum diimplementasikan di ${this.name}!`);
  }

  /**
   * Dipanggil oleh VoxelEngine saat ada blok yang ditaruh/dihancurkan
   * Berguna untuk mesher pintar yang hanya me-rebuild sebagian area (Partial Remeshing).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  markChunkDirty(x, y, z) {
    // Override fungsi ini di kelas anak (subclass) jika diperlukan
  }
}
