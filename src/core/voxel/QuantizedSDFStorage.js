import { VoxelStorage } from './VoxelStorage.js';

// Skala kuantisasi: nilai float SDF dikali SCALE lalu dibulatkan ke Int16.
// Dipilih 512 (bukan sekadar 1000) supaya pembagian saat decode adalah
// operasi power-of-two yang murah, dan rentang yang dihasilkan (+-64.0
// dengan presisi 1/512 ~= 0.00195) jauh melebihi kebutuhan nyata:
//   - Amplitudo noise gua di chunk.js cuma +-4.0 (`noise * 8.0 - 4.0`).
//   - Presisi HANYA penting di dekat permukaan (SDF mendekati 0), karena
//     SurfaceNetsMesher cuma menginterpolasi linear ANTARA 2 sudut cell
//     yang bertetangga (`t = s1 / (s1 - s2)`, lihat generateMesh()) --
//     tidak pernah membandingkan 2 titik yang jauh terpisah. Presisi
//     0.00195 di dekat nol jauh lebih halus dari 1 unit voxel manapun.
//   - Magnitude JAUH dari 0 (mis. jauh di bawah/atas permukaan) tidak
//     memengaruhi geometri sama sekali -- cuma SIGN-nya yang dipakai untuk
//     menentukan solid/udara di cell yang tidak berpotongan permukaan.
//     Clamping ke +-64 di kasus ekstrem (chunk sangat tinggi) tetap aman
//     karena sign-nya tetap benar.
const SCALE = 512;
const QUANT_MIN = -32768;
const QUANT_MAX = 32767;

/**
 * QuantizedSDFStorage — varian SDFStorage yang menyimpan signed distance
 * sebagai Int16 (2 byte/voxel) alih-alih Float32 (4 byte/voxel) --
 * setengah memori per chunk, dipakai untuk chunk JAUH dari pemain di jalur
 * streaming (Roadmap B.4) yang kecil kemungkinan diedit dalam waktu dekat.
 *
 * SENGAJA bukan "downgrade ke BrickMapStorage/SVDAGStorage/Tree64Storage"
 * seperti draf awal roadmap B.4 -- storage-storage itu menyimpan material
 * ID blocky (Uint8, 0-255), TIDAK implement getSDF()/setSDF() sama sekali.
 * SurfaceNetsMesher._getSDF() memanggil `storage.getSDF(x,y,z)` tanpa
 * fallback -- kalau storage itu dipasang untuk chunk yang di-mesh smooth
 * (SurfaceNetsMesher), hasilnya crash langsung (TypeError), bukan sekadar
 * "kurang detail". Kelas ini adalah drop-in replacement SEBENARNYA untuk
 * SDFStorage (interface identik: get/set/getSDF/setSDF/smoothSDF/
 * serialize/deserialize) -- cuma representasi internalnya yang beda.
 *
 * Trade-off presisi: SDFStorage (Float32) presisinya ~7 digit desimal;
 * kelas ini presisinya tetap 1/512 di SELURUH rentang (bukan floating-point
 * relatif) -- lebih dari cukup untuk terrain (lihat penjelasan SCALE di
 * atas), TIDAK ada perbedaan visual yang terlihat pada jarak render tempat
 * storage ini dipakai (chunk jauh -- lihat acceptance test roadmap B.4).
 */
export class QuantizedSDFStorage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);
    this.sdf = new Int16Array(sx * sy * sz);
    // Default: udara di mana-mana (SDF = +1.0), sama seperti SDFStorage.
    this.sdf.fill(QuantizedSDFStorage._encode(1.0));
  }

  static _encode(v) {
    const q = Math.round(v * SCALE);
    // Clamp, BUKAN wrap -- nilai ekstrem tetap dapat sign yang benar
    // (lihat penjelasan SCALE di atas), tidak overflow jadi sign terbalik.
    return q < QUANT_MIN ? QUANT_MIN : q > QUANT_MAX ? QUANT_MAX : q;
  }

  static _decode(q) {
    return q / SCALE;
  }

  /** Kompatibilitas mundur blocky -- semantik identik dengan SDFStorage.get(). */
  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    const val = this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]];
    return val <= 0 ? 1 : 0;
  }

  /** Kompatibilitas mundur blocky -- semantik identik dengan SDFStorage.set(). */
  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]] = QuantizedSDFStorage._encode(val > 0 ? -1.0 : 1.0);
  }

  /** Nilai float kontinu (SDF asli), di-decode dari Int16 tersimpan. */
  getSDF(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 1.0;
    return QuantizedSDFStorage._decode(this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]]);
  }

  /** Menyeting nilai float kontinu (SDF asli), di-encode ke Int16 sebelum disimpan. */
  setSDF(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this.sdf[x + y * this.dims[0] + z * this.dims[0] * this.dims[1]] = QuantizedSDFStorage._encode(val);
  }

  /**
   * Sama seperti SDFStorage.smoothSDF() (box blur 3x3x3 1 pass) -- decode
   * ke float untuk perhitungan blend, lalu encode balik hasilnya. Presisi
   * quantization (1/512) jauh lebih halus dari strength blend manapun yang
   * masuk akal, jadi round-trip encode/decode di sini tidak menambah error
   * yang terlihat dibanding smoothing di storage Float32.
   */
  smoothSDF(strength = 0.15) {
    const [sx, sy, sz] = this.dims;
    const src = this.sdf;
    const dst = new Int16Array(src.length);

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
                sum += QuantizedSDFStorage._decode(src[nx + ny * sx + nz * sx * sy]);
                count++;
              }
            }
          }
          const avg = sum / count;
          const srcVal = QuantizedSDFStorage._decode(src[idx]);
          dst[idx] = QuantizedSDFStorage._encode(srcVal * (1 - strength) + avg * strength);
        }
      }
    }
    this.sdf = dst;
  }

  /**
   * Sama seperti SDFStorage.serialize() (Roadmap A.2 -- transferable ke/dari
   * worker, dan Roadmap A.3 -- persistensi IndexedDB) -- `type: 'sdf-compact'`
   * membedakannya dari 'sdf' biasa supaya deserializeStorage() tahu harus
   * membangun instance kelas MANA.
   */
  serialize() {
    return {
      type: 'sdf-compact',
      dims: this.dims,
      sdf: this.sdf,
    };
  }

  /** Kebalikan dari serialize() -- lihat catatan di sana. */
  static deserialize(payload) {
    const storage = new QuantizedSDFStorage(payload.dims[0], payload.dims[1], payload.dims[2]);
    storage.sdf = new Int16Array(payload.sdf);
    return storage;
  }
}
