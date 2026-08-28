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
 * Roadmap B.2 -- buffer Float32 yang tumbuh sendiri (dobel kapasitas saat
 * penuh), dipakai untuk vertexData alih-alih push() ke Array biasa lalu
 * di-convert ke Float32Array di akhir. Menghindari boxed-number overhead
 * dari Array JS biasa DAN alokasi ganda (array + typed array konversi) --
 * cuma ada satu alokasi tambahan (grow, jarang terjadi) plus satu slice()
 * final ke ukuran pas.
 */
class GrowableFloat32 {
  constructor(initialCapacity = 2048) {
    this.buffer = new Float32Array(initialCapacity);
    this.count = 0; // jumlah FLOAT tersimpan (bukan jumlah vertex)
  }
  _ensure(extra) {
    if (this.count + extra <= this.buffer.length) return;
    let newCap = this.buffer.length * 2 || 16;
    while (newCap < this.count + extra) newCap *= 2;
    const next = new Float32Array(newCap);
    next.set(this.buffer.subarray(0, this.count));
    this.buffer = next;
  }
  push9(a, b, c, d, e, f, g, h, i) {
    this._ensure(9);
    const buf = this.buffer, n = this.count;
    buf[n] = a; buf[n + 1] = b; buf[n + 2] = c;
    buf[n + 3] = d; buf[n + 4] = e; buf[n + 5] = f;
    buf[n + 6] = g; buf[n + 7] = h; buf[n + 8] = i;
    this.count += 9;
  }
  toFinalArray() {
    return this.buffer.slice(0, this.count);
  }
}

/** Sama seperti GrowableFloat32, tapi untuk indexData (integer, per-quad). */
class GrowableUint32 {
  constructor(initialCapacity = 4096) {
    this.buffer = new Uint32Array(initialCapacity);
    this.count = 0;
  }
  _ensure(extra) {
    if (this.count + extra <= this.buffer.length) return;
    let newCap = this.buffer.length * 2 || 16;
    while (newCap < this.count + extra) newCap *= 2;
    const next = new Uint32Array(newCap);
    next.set(this.buffer.subarray(0, this.count));
    this.buffer = next;
  }
  push6(a, b, c, d, e, f) {
    this._ensure(6);
    const buf = this.buffer, n = this.count;
    buf[n] = a; buf[n + 1] = b; buf[n + 2] = c;
    buf[n + 3] = d; buf[n + 4] = e; buf[n + 5] = f;
    this.count += 6;
  }
  toUint16Array() {
    const out = new Uint16Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.buffer[i];
    return out;
  }
  toUint32Array() {
    return this.buffer.slice(0, this.count);
  }
}

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
      // Roadmap A.5 -- Origin Rebasing: posisi vertex dibakar RELATIF
      // terhadap ctx.originChunk (default [0,0,0], 100% backward compatible
      // untuk caller yang tidak menyetelnya -- editor, landing.js, dan mode
      // benchmark dunia tetap semuanya tetap mendapat posisi absolut persis
      // seperti sebelumnya). VoxelEngine.setOriginChunk() dipakai jalur
      // streaming (main.js) untuk menggeser referensi ini secara BERKALA
      // (bukan tiap frame) supaya angka yang dibakar ke Float32Array vertex
      // buffer tidak pernah tumbuh sebesar posisi absolut pemain dari
      // (0,0,0) -- itulah akar masalah jitter/robekan mesh pada jarak jauh
      // (lihat OriginRebase.js untuk penjelasan lengkap root-cause-nya).
      const [ox, oy, oz] = ctx.originChunk || [0, 0, 0];
      offsetX = (ctx.chunkCoord[0] - ox) * dims[0];
      offsetY = (ctx.chunkCoord[1] - oy) * dims[1];
      offsetZ = (ctx.chunkCoord[2] - oz) * dims[2];
    }

    // Map untuk melacak index vertex dari setiap cell
    // Menyederhanakan penjahitan (stitching) wajah quad
    const cellVertices = new Map();
    const getCellKey = (x, y, z) => `${x},${y},${z}`;

    // DEBUG: pewarnaan batas chunk (lihat DEBUG_CHUNK_PALETTE di atas)
    const debugChunkBounds = !!(ctx && ctx.debugChunkBounds);
    const debugTint = debugChunkBounds ? this._chunkDebugTint(ctx.chunkCoord) : null;

    // Roadmap B.2 -- Partial Remeshing.
    //
    // Pass 1 (di bawah) adalah bagian termahal dari mesher ini: tiap cell
    // butuh 8x _getSDF (corner) DAN, kalau cell-nya aktif, sampai 6x
    // _getSDFTrilinear (masing-masing 8x _getSDF lagi) untuk normal
    // gradient -- total puluhan pembacaan SDF per cell aktif. Untuk satu
    // edit voxel kecil di tengah chunk besar, hampir semua cell TIDAK
    // terpengaruh sama sekali oleh edit itu, tapi tanpa caching tetap
    // dihitung ulang dari nol tiap remesh.
    //
    // Kalau caller (VoxelEngine.remeshChunk(), lihat komentar di sana)
    // menyediakan `ctx.dirtyBounds` (AABB cell, dalam ruang koordinat cell
    // yang SAMA dengan loop di bawah ini: -1..dims-1) DAN
    // `ctx.previousCellCache` (hasil `cellCache` dari build SEBELUMNYA
    // untuk chunk yang SAMA), Pass 1 cukup menghitung ulang cell yang ada
    // di dalam `dirtyBounds` -- cell di luar itu dipakai ulang langsung
    // dari cache, melewati SEMUA pembacaan SDF untuk cell tersebut.
    //
    // Kalau salah satu tidak diberikan (mis. build pertama untuk chunk
    // ini, atau VoxelEngine sengaja minta full rebuild lewat
    // `chunk.forceFullRemesh` -- dipakai saat chunk ini jadi TETANGGA dari
    // edit/chunk-baru, bukan yang diedit langsung, sehingga AABB tepat
    // tidak diketahui), jalur di bawah otomatis menghitung SEMUA cell
    // seperti sebelumnya -- 100% backward compatible untuk caller yang
    // tidak tahu-menahu soal field ctx ini (editor, benchmark, test lama).
    //
    // PENTING soal urutan: Pass 2 selalu mencari index vertex lewat
    // `cellVertices.get(key)`, TIDAK PERNAH mengasumsikan urutan insersi
    // tertentu -- jadi cell yang di-seed dari cache (index vertex BARU,
    // beda dari build sebelumnya) tetap menghasilkan mesh yang benar.
    // Untuk build FULL (canPartial === false), fase seed di bawah
    // dilewati seluruhnya sehingga urutan insersi Pass 1 IDENTIK dengan
    // sebelum perubahan ini -- refactor ini tidak mengubah output apapun
    // untuk jalur non-partial.
    const canPartial = !!(ctx && ctx.dirtyBounds && ctx.previousCellCache);
    const dirtyMinX = canPartial ? Math.max(-1, ctx.dirtyBounds.minX) : -1;
    const dirtyMinY = canPartial ? Math.max(-1, ctx.dirtyBounds.minY) : -1;
    const dirtyMinZ = canPartial ? Math.max(-1, ctx.dirtyBounds.minZ) : -1;
    const dirtyMaxX = canPartial ? Math.min(dims[0] - 1, ctx.dirtyBounds.maxX) : dims[0] - 1;
    const dirtyMaxY = canPartial ? Math.min(dims[1] - 1, ctx.dirtyBounds.maxY) : dims[1] - 1;
    const dirtyMaxZ = canPartial ? Math.min(dims[2] - 1, ctx.dirtyBounds.maxZ) : dims[2] - 1;

    const inDirtyRange = (x, y, z) =>
      x >= dirtyMinX && x <= dirtyMaxX &&
      y >= dirtyMinY && y <= dirtyMaxY &&
      z >= dirtyMinZ && z <= dirtyMaxZ;

    const vbuf = new GrowableFloat32();
    // cellCache: HASIL build ini (koordinat LOKAL, tanpa offsetX/Y/Z --
    // supaya tetap valid dipakai ulang meski originChunk berubah di build
    // berikutnya, lihat VoxelEngine.remeshChunk()). Dikembalikan ke
    // VoxelEngine untuk dipersist sebagai `chunk.cellCache`, jadi input
    // `ctx.previousCellCache` untuk remesh partial berikutnya.
    const cellCache = new Map();

    if (canPartial) {
      // Seed dari cache: pakai ulang SEMUA cell aktif dari build
      // sebelumnya yang BUKAN ada di dalam dirtyBounds (yang di dalam akan
      // dihitung ulang fresh di loop bawah).
      for (const [key, rec] of ctx.previousCellCache) {
        const [cxk, cyk, czk] = key.split(',').map(Number);
        if (inDirtyRange(cxk, cyk, czk)) continue;
        const vIndex = vbuf.count / 9;
        vbuf.push9(
          rec.vx + offsetX, rec.vy + offsetY, rec.vz + offsetZ,
          rec.nx, rec.ny, rec.nz,
          rec.r, rec.g, rec.b
        );
        cellVertices.set(key, vIndex);
        cellCache.set(key, rec);
      }
    }

    // Pass 1: Identifikasi permukaan dan hitung posisi vertex tiap cell
    // dalam rentang [dirtyMin..dirtyMax] (seluruh chunk untuk build full,
    // atau cuma area yang berubah untuk build partial).
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
    for (let z = dirtyMinZ; z <= dirtyMaxZ; z++) {
      for (let y = dirtyMinY; y <= dirtyMaxY; y++) {
        for (let x = dirtyMinX; x <= dirtyMaxX; x++) {
          
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
            const key = getCellKey(x, y, z);
            const vIndex = vbuf.count / 9;
            vbuf.push9(
              vx + offsetX, vy + offsetY, vz + offsetZ, // Position
              norm[0], norm[1], norm[2],                // Normal
              color[0], color[1], color[2]              // Color (default gray, atau debug tint)
            );

            cellVertices.set(key, vIndex);
            // Simpan LOKAL (tanpa offset) supaya cache tetap valid dipakai
            // ulang meski originChunk (dan karenanya offsetX/Y/Z) berubah
            // di build berikutnya.
            cellCache.set(key, { vx, vy, vz, nx: norm[0], ny: norm[1], nz: norm[2], r: color[0], g: color[1], b: color[2] });
          }
        }
      }
    }

    // Pass 2: Jahit vertex menjadi quad (lalu triangle) berdasar tepi antar
    // cell. SELALU loop PENUH 0..dims-1 (tidak dibatasi dirtyBounds) --
    // benar untuk build partial maupun full karena `cellVertices` di titik
    // ini sudah lengkap (gabungan cache + hasil Pass 1 fresh), dan Pass 2
    // cuma melihat SDF LIVE (bukan cache) lewat _getSDF() langsung, jadi
    // konektivitas quad selalu akurat terhadap data terbaru.
    const ibuf = new GrowableUint32();
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
                ibuf.push6(v1, v2, v3, v1, v3, v4);
              } else {
                ibuf.push6(v1, v4, v3, v1, v3, v2);
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
                ibuf.push6(v1, v2, v3, v1, v3, v4);
              } else {
                ibuf.push6(v1, v4, v3, v1, v3, v2);
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
                ibuf.push6(v1, v2, v3, v1, v3, v4);
              } else {
                ibuf.push6(v1, v4, v3, v1, v3, v2);
              }
            }
          }

        }
      }
    }

    const vertexCount = vbuf.count / 9;
    return {
      vertexData: vbuf.toFinalArray(),
      indexData: vertexCount > 65535 ? ibuf.toUint32Array() : ibuf.toUint16Array(),
      indexCount: ibuf.count,
      // Roadmap B.2 -- dipersist VoxelEngine sebagai chunk.cellCache, jadi
      // input ctx.previousCellCache untuk remesh partial berikutnya.
      cellCache,
    };
  }
}
