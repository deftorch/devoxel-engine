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

  /**
   * Safety-net smoothing pass: box blur 3x3x3 ringan (1 pass) pada seluruh
   * field SDF untuk "menutup" sliver/celah setipis 1 voxel yang mungkin
   * lolos dari tuning noise (lihat CAVE_START_DEPTH/CAVE_FULL_DEPTH di
   * chunk.js). Blend ringan (bukan full-replace) supaya detail terrain asli
   * tidak ikut hilang. Catatan: belum menangani smoothing lintas-chunk --
   * blur di tepi chunk terpotong di batas array lokal (tidak mengambil data
   * tetangga), jadi masih mungkin ada sedikit sliver tepat di garis chunk.
   */
  smoothSDF(strength = 0.15) {
    const [sx, sy, sz] = this.dims;
    const src = this.sdf;
    const dst = new Float32Array(src.length);

    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          const idx = x + y * sx + z * sx * sy;
          let sum = 0,
            count = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx,
                  ny = y + dy,
                  nz = z + dz;
                if (nx < 0 || nx >= sx || ny < 0 || ny >= sy || nz < 0 || nz >= sz) continue;
                sum += src[nx + ny * sx + nz * sx * sy];
                count++;
              }
            }
          }
          const avg = sum / count;
          dst[idx] = src[idx] * (1 - strength) + avg * strength;
        }
      }
    }
    this.sdf = dst;
  }
}
