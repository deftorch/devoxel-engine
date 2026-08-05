import { VoxelStorage } from './VoxelStorage.js';

/**
 * SDF (Signed Distance Field) Storage
 * Mendemonstrasikan betapa mahalnya update data, namun super cepat untuk traversal.
 */
export class SDFStorage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);
    this.data = new Uint8Array(sx * sy * sz);
    this.sdf = new Float32Array(sx * sy * sz); // Menyimpan jarak ke solid terdekat
    this.needsUpdate = true;
  }

  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    return this.data[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]];
  }

  getSDF(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    return this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]];
  }

  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    const idx = x + y * this.dims[0] + z * this.dims[0] * this.dims[1];
    if (this.data[idx] !== val) {
      this.data[idx] = val;
      // Kapanpun ada 1 blok yang diubah, SDF menjadi invalid dan harus dihitung ulang!
      this.needsUpdate = true;
    }
  }

  /**
   * Mengkalkulasi ulang seluruh nilai jarak (SDF) dalam Grid.
   * Ini menggunakan pendekatan "Manhattan Distance Transform" 2-pass O(N^3)
   * sebagai demonstrasi betapa beratnya rekonstruksi SDF.
   */
  buildSDF() {
    if (!this.needsUpdate) return;
    
    const [sx, sy, sz] = this.dims;
    const maxDist = Math.max(sx, sy, sz) + 1;
    const len = sx * sy * sz;
    
    // Tahap 1: Inisialisasi - Jika padat = 0, jika udara = max (infinity)
    for (let i = 0; i < len; i++) {
      this.sdf[i] = (this.data[i] > 0) ? 0 : maxDist;
    }

    // Tahap 2: Forward Sweep (+x, +y, +z)
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          const idx = x + y * sx + z * sx * sy;
          if (this.sdf[idx] === 0) continue;

          let minDist = this.sdf[idx];
          if (x > 0) minDist = Math.min(minDist, this.sdf[idx - 1] + 1);
          if (y > 0) minDist = Math.min(minDist, this.sdf[idx - sx] + 1);
          if (z > 0) minDist = Math.min(minDist, this.sdf[idx - sx * sy] + 1);
          this.sdf[idx] = minDist;
        }
      }
    }

    // Tahap 3: Backward Sweep (-x, -y, -z)
    for (let z = sz - 1; z >= 0; z--) {
      for (let y = sy - 1; y >= 0; y--) {
        for (let x = sx - 1; x >= 0; x--) {
          const idx = x + y * sx + z * sx * sy;
          let minDist = this.sdf[idx];
          if (x < sx - 1) minDist = Math.min(minDist, this.sdf[idx + 1] + 1);
          if (y < sy - 1) minDist = Math.min(minDist, this.sdf[idx + sx] + 1);
          if (z < sz - 1) minDist = Math.min(minDist, this.sdf[idx + sx * sy] + 1);
          this.sdf[idx] = minDist;
        }
      }
    }
    
    this.needsUpdate = false;
  }
}
