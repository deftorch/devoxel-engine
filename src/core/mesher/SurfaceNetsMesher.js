import { VoxelMesher } from './VoxelMesher.js';

// Lookup table untuk 8 sudut sebuah kubus/sel
const CUBE_CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
];

// 12 rusuk kubus, masing-masing menghubungkan 2 sudut
const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], // Bawah
  [4, 5], [5, 6], [6, 7], [7, 4], // Atas
  [0, 4], [1, 5], [2, 6], [3, 7]  // Vertikal
];

// DEBUG: palet warna berbeda per chunk (checkerboard hash) supaya batas
// antar chunk gampang dibedakan secara visual di layar. Dipakai hanya
// saat ctx.debugChunkBounds === true (lihat VoxelEngine.setDebugChunkBounds).
const DEBUG_CHUNK_PALETTE = [
  [1.0, 0.35, 0.35], // merah
  [0.35, 1.0, 0.45], // hijau
  [0.4, 0.55, 1.0], // biru
  [1.0, 0.9, 0.3], // kuning
  [1.0, 0.4, 1.0], // magenta
  [0.35, 1.0, 1.0], // cyan
];
// Warna terang khusus untuk vertex yang cell-nya di tepi/padding chunk
// (x/y/z <= 0 atau >= dims-1 -- termasuk cell padding -1 yang dipakai
// Pass 1 untuk stitching, lihat komentar di generateMesh). Kalau ada
// robekan/seam antar chunk (mis. karena chunk tetangga tidak ikut
// di-remesh setelah edit voxel di dekat batas), garis putih terang ini
// akan terlihat terputus/ada celah di sisi yang robek -- jadi gampang
// diperiksa secara visual.
const DEBUG_EDGE_COLOR = [1.0, 1.0, 1.0];

/**
 * Implementasi Surface Nets untuk menghasilkan smooth mesh dari data SDF.
 */
export class SurfaceNetsMesher extends VoxelMesher {
  constructor() {
    super('SurfaceNetsMesher');
  }

  /**
   * DEBUG: pilih warna tint untuk sebuah chunk berdasar koordinatnya,
   * supaya chunk yang bersebelahan konsisten mendapat warna berbeda
   * (checkerboard-style hash, bukan cuma ganjil/genap).
   */
  _chunkDebugTint(chunkCoord) {
    if (!chunkCoord) return DEBUG_CHUNK_PALETTE[0];
    const [cx, cy, cz] = chunkCoord;
    let n = (cx * 374761393 + cy * 668265263 + cz * 1274126177) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    n = (n ^ (n >>> 16)) >>> 0;
    return DEBUG_CHUNK_PALETTE[n % DEBUG_CHUNK_PALETTE.length];
  }

  /**
   * Helper untuk mendapatkan nilai SDF dengan mempertimbangkan neighbor chunk
   */
  _getSDF(storage, ctx, x, y, z, dims) {
    if (x >= 0 && x < dims[0] && y >= 0 && y < dims[1] && z >= 0 && z < dims[2]) {
      return storage.getSDF(x, y, z);
    }
    
    // Keluar batas chunk, coba ambil dari tetangga
    if (ctx && ctx.getNeighbor) {
      let nx = 0, ny = 0, nz = 0;
      let lx = x, ly = y, lz = z;
      
      if (x < 0) { nx = -1; lx = x + dims[0]; } else if (x >= dims[0]) { nx = 1; lx = x - dims[0]; }
      if (y < 0) { ny = -1; ly = y + dims[1]; } else if (y >= dims[1]) { ny = 1; ly = y - dims[1]; }
      if (z < 0) { nz = -1; lz = z + dims[2]; } else if (z >= dims[2]) { nz = 1; lz = z - dims[2]; }
      
      const neighbor = ctx.getNeighbor(nx, ny, nz);
      if (neighbor && typeof neighbor.getSDF === 'function') {
        return neighbor.getSDF(lx, ly, lz);
      }
    }
    return 1.0; // Default: udara jika tidak ada data
  }

  /**
   * Helper untuk sampling SDF di koordinat PECAHAN (fractional) memakai
   * trilinear interpolation dari 8 titik grid terdekat.
   *
   * PENTING: _getSDF() hanya valid untuk koordinat integer karena ujungnya
   * mengindeks TypedArray (mis. Float32Array). Mengindeks TypedArray dengan
   * angka pecahan di JavaScript diam-diam mengembalikan `undefined`, bukan
   * error/exception, sehingga bug ini tidak pernah terlihat lewat crash —
   * cuma menghasilkan NaN yang menjalar ke normal & shading.
   */
  _getSDFTrilinear(storage, ctx, fx, fy, fz, dims) {
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;

    const c000 = this._getSDF(storage, ctx, x0, y0, z0, dims);
    const c100 = this._getSDF(storage, ctx, x0 + 1, y0, z0, dims);
    const c010 = this._getSDF(storage, ctx, x0, y0 + 1, z0, dims);
    const c110 = this._getSDF(storage, ctx, x0 + 1, y0 + 1, z0, dims);
    const c001 = this._getSDF(storage, ctx, x0, y0, z0 + 1, dims);
    const c101 = this._getSDF(storage, ctx, x0 + 1, y0, z0 + 1, dims);
    const c011 = this._getSDF(storage, ctx, x0, y0 + 1, z0 + 1, dims);
    const c111 = this._getSDF(storage, ctx, x0 + 1, y0 + 1, z0 + 1, dims);

    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;

    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;

    return c0 * (1 - tz) + c1 * tz;
  }

  /**
   * Helper untuk menghitung normal dengan gradien (turunan parsial).
   * x, y, z di sini boleh berupa koordinat PECAHAN (posisi vertex hasil
   * interpolasi edge), makanya wajib pakai _getSDFTrilinear, bukan _getSDF.
   */
  _getNormal(storage, ctx, x, y, z, dims) {
    const d = 0.5; // Jarak sampling (setengah sel, cocok untuk sampler trilinear)
    const nx =
      this._getSDFTrilinear(storage, ctx, x + d, y, z, dims) -
      this._getSDFTrilinear(storage, ctx, x - d, y, z, dims);
    const ny =
      this._getSDFTrilinear(storage, ctx, x, y + d, z, dims) -
      this._getSDFTrilinear(storage, ctx, x, y - d, z, dims);
    const nz =
      this._getSDFTrilinear(storage, ctx, x, y, z + d, dims) -
      this._getSDFTrilinear(storage, ctx, x, y, z - d, dims);

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!Number.isFinite(len) || len === 0) return [0, 1, 0];
    return [nx / len, ny / len, nz / len];
  }

  generateMesh(chunkStorage, ctx = null) {
    const dims = chunkStorage.dims;
    let offsetX = 0, offsetY = 0, offsetZ = 0;
    if (ctx && ctx.chunkCoord) {
      offsetX = ctx.chunkCoord[0] * dims[0];
      offsetY = ctx.chunkCoord[1] * dims[1];
      offsetZ = ctx.chunkCoord[2] * dims[2];
    }

    const vertexData = [];
    const indices = [];

    // Map untuk melacak index vertex dari setiap cell
    // Menyederhanakan penjahitan (stitching) wajah quad
    const cellVertices = new Map();
    const getCellKey = (x, y, z) => `${x},${y},${z}`;

    // DEBUG: pewarnaan batas chunk (lihat DEBUG_CHUNK_PALETTE di atas)
    const debugChunkBounds = !!(ctx && ctx.debugChunkBounds);
    const debugTint = debugChunkBounds ? this._chunkDebugTint(ctx.chunkCoord) : null;

    // Pass 1: Identifikasi permukaan dan hitung posisi vertex tiap cell
    //
    // Loop di sini SENGAJA dimulai dari -1 (bukan 0), memberi "padding" 1 sel
    // ke arah negatif. Alasannya: Pass 2 (stitching) butuh vertex dari cell
    // (x-1,y,z), (x,y-1,z), dst untuk menjahit quad di tepi chunk (x=0/y=0/z=0).
    // Sebelumnya cell -1 tidak pernah dihitung, jadi lookup-nya selalu
    // `undefined` dan quad di baris/kolom pertama tiap sumbu dilewati begitu
    // saja -> muncul celah/retakan mengikuti garis batas chunk. Cell padding
    // ini disampling dari data tetangga lewat ctx.getNeighbor (SDF-nya sama
    // persis dengan yang dipakai neighbor chunk itu sendiri), jadi posisinya
    // konsisten dan tidak menimbulkan seam baru.
    for (let z = -1; z < dims[2]; z++) {
      for (let y = -1; y < dims[1]; y++) {
        for (let x = -1; x < dims[0]; x++) {
          
          let mask = 0;
          const cornerSDF = [];
          for (let i = 0; i < 8; i++) {
            const cx = x + CUBE_CORNERS[i][0];
            const cy = y + CUBE_CORNERS[i][1];
            const cz = z + CUBE_CORNERS[i][2];
            const sdf = this._getSDF(chunkStorage, ctx, cx, cy, cz, dims);
            cornerSDF.push(sdf);
            if (sdf <= 0) mask |= (1 << i);
          }

          // Jika semua sudut padat (mask 255) atau semua udara (mask 0), lewati.
          if (mask === 0 || mask === 255) continue;

          // Temukan pusat dari potongan (intersections) tepi
          let vx = 0, vy = 0, vz = 0;
          let edgeCount = 0;

          for (let i = 0; i < 12; i++) {
            const c1 = CUBE_EDGES[i][0];
            const c2 = CUBE_EDGES[i][1];
            const s1 = cornerSDF[c1];
            const s2 = cornerSDF[c2];

            // Cek apakah tepi ini memotong permukaan (perubahan sign)
            if ((s1 <= 0 && s2 > 0) || (s1 > 0 && s2 <= 0)) {
              // Interpolasi linear di sepanjang tepi
              const t = s1 / (s1 - s2);
              const px = x + CUBE_CORNERS[c1][0] + t * (CUBE_CORNERS[c2][0] - CUBE_CORNERS[c1][0]);
              const py = y + CUBE_CORNERS[c1][1] + t * (CUBE_CORNERS[c2][1] - CUBE_CORNERS[c1][1]);
              const pz = z + CUBE_CORNERS[c1][2] + t * (CUBE_CORNERS[c2][2] - CUBE_CORNERS[c1][2]);
              vx += px; vy += py; vz += pz;
              edgeCount++;
            }
          }

          if (edgeCount > 0) {
            vx /= edgeCount;
            vy /= edgeCount;
            vz /= edgeCount;

            const norm = this._getNormal(chunkStorage, ctx, vx, vy, vz, dims);

            // Warna vertex: default gray, atau (kalau debugChunkBounds aktif)
            // tint per-chunk + putih terang tepat di cell tepi/padding chunk
            // (x/y/z <= 0 atau >= dims-1, termasuk cell padding -1 di atas)
            // supaya seam antar chunk gampang diperiksa secara visual.
            let color = [0.8, 0.8, 0.8];
            if (debugChunkBounds) {
              const atChunkBoundary =
                x <= 0 || x >= dims[0] - 1 || y <= 0 || y >= dims[1] - 1 || z <= 0 || z >= dims[2] - 1;
              color = atChunkBoundary ? DEBUG_EDGE_COLOR : debugTint;
            }

            // Generate vertex data yang di-interleave (Pos 3, Nor 3, Col 3 = 9 float per vertex)
            const vIndex = vertexData.length / 9;
            vertexData.push(
              vx + offsetX, vy + offsetY, vz + offsetZ, // Position
              norm[0], norm[1], norm[2],                // Normal
              color[0], color[1], color[2]              // Color (default gray, atau debug tint)
            );
            
            cellVertices.set(getCellKey(x, y, z), vIndex);
          }
        }
      }
    }

    // Pass 2: Jahit vertex menjadi quad (lalu triangle) berdasar tepi antar cell
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          
          // Cek tepi X (menghubungkan point ini dengan x+1)
          const s0 = this._getSDF(chunkStorage, ctx, x, y, z, dims);
          const sX = this._getSDF(chunkStorage, ctx, x + 1, y, z, dims);
          if ((s0 <= 0 && sX > 0) || (s0 > 0 && sX <= 0)) {
            const v1 = cellVertices.get(getCellKey(x, y, z));
            const v2 = cellVertices.get(getCellKey(x, y - 1, z));
            const v3 = cellVertices.get(getCellKey(x, y - 1, z - 1));
            const v4 = cellVertices.get(getCellKey(x, y, z - 1));
            
            if (v1 !== undefined && v2 !== undefined && v3 !== undefined && v4 !== undefined) {
              if (s0 <= 0) {
                indices.push(v1, v2, v3, v1, v3, v4);
              } else {
                indices.push(v1, v4, v3, v1, v3, v2);
              }
            }
          }

          // Cek tepi Y (menghubungkan point ini dengan y+1)
          const sY = this._getSDF(chunkStorage, ctx, x, y + 1, z, dims);
          if ((s0 <= 0 && sY > 0) || (s0 > 0 && sY <= 0)) {
            const v1 = cellVertices.get(getCellKey(x, y, z));
            const v2 = cellVertices.get(getCellKey(x, y, z - 1));
            const v3 = cellVertices.get(getCellKey(x - 1, y, z - 1));
            const v4 = cellVertices.get(getCellKey(x - 1, y, z));

            if (v1 !== undefined && v2 !== undefined && v3 !== undefined && v4 !== undefined) {
              if (s0 <= 0) {
                indices.push(v1, v2, v3, v1, v3, v4);
              } else {
                indices.push(v1, v4, v3, v1, v3, v2);
              }
            }
          }

          // Cek tepi Z (menghubungkan point ini dengan z+1)
          const sZ = this._getSDF(chunkStorage, ctx, x, y, z + 1, dims);
          if ((s0 <= 0 && sZ > 0) || (s0 > 0 && sZ <= 0)) {
            const v1 = cellVertices.get(getCellKey(x, y, z));
            const v2 = cellVertices.get(getCellKey(x - 1, y, z));
            const v3 = cellVertices.get(getCellKey(x - 1, y - 1, z));
            const v4 = cellVertices.get(getCellKey(x, y - 1, z));

            if (v1 !== undefined && v2 !== undefined && v3 !== undefined && v4 !== undefined) {
              if (s0 <= 0) {
                indices.push(v1, v2, v3, v1, v3, v4);
              } else {
                indices.push(v1, v4, v3, v1, v3, v2);
              }
            }
          }

        }
      }
    }

    return {
      vertexData: new Float32Array(vertexData),
      indexData: (vertexData.length / 9) > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
      indexCount: indices.length
    };
  }
}
