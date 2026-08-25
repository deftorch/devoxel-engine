import { VoxelStorage } from './VoxelStorage.js';

/**
 * SDF (Signed Distance Field) Storage
 * Menyimpan data kepadatan/jarak kontinu (float) untuk gaya voxel smooth.
 * Nilai <= 0 merepresentasikan area solid (di dalam permukaan), 
 * nilai > 0 merepresentasikan udara (di luar permukaan).
 */
export class SDFStorage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);
    // Array tunggal untuk menyimpan nilai float jarak/density
    this.sdf = new Float32Array(sx * sy * sz);
    
    // Inisialisasi dengan 1.0 (udara kosong) di mana-mana
    this.sdf.fill(1.0);
  }

  /**
   * Mengambil nilai material blocky (Kompatibilitas mundur)
   * Jika SDF <= 0 (solid), kembalikan 1 (material generik). Jika > 0, kembalikan 0 (udara).
   */
  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    const val = this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]];
    return val <= 0.0 ? 1 : 0;
  }

  /**
   * Menyeting nilai material blocky (Kompatibilitas mundur)
   * Jika val > 0 (solid), set SDF ke -1.0. Jika 0 (udara), set SDF ke 1.0.
   */
  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]] = val > 0 ? -1.0 : 1.0;
  }

  /**
   * Mengambil nilai float kontinu (SDF asli)
   */
  getSDF(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 1.0; // Anggap luar batas adalah udara
    return this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]];
  }

  /**
   * Menyeting nilai float kontinu (SDF asli)
   */
  setSDF(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]] = val;
  }
}
