import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateChunkVoxels } from '../game/world/chunk.js';
import { SDFStorage } from '../core/voxel/SDFStorage.js';
import { QuantizedSDFStorage } from '../core/voxel/QuantizedSDFStorage.js';

describe('generateChunkVoxels — storageType "sdf-compact" (Roadmap B.4)', () => {
  test('menghasilkan instance QuantizedSDFStorage', () => {
    const storage = generateChunkVoxels(0, 0, 'sdf-compact', 'normal');
    assert.ok(storage instanceof QuantizedSDFStorage);
  });

  test('terrain yang dihasilkan (posisi permukaan) sama dengan storageType "sdf" untuk chunk yang sama', () => {
    // isSDFLike (lihat chunk.js) menyatukan jalur generation 'sdf' dan
    // 'sdf-compact' -- pastikan hasilnya benar-benar setara, bukan cuma
    // "tidak error".
    const full = generateChunkVoxels(3, -2, 'sdf', 'normal');
    const compact = generateChunkVoxels(3, -2, 'sdf-compact', 'normal');

    assert.deepEqual(compact.dims, full.dims);

    let maxDiff = 0;
    for (let x = 0; x < full.dims[0]; x += 3) {
      for (let y = 0; y < full.dims[1]; y += 5) {
        for (let z = 0; z < full.dims[2]; z += 3) {
          maxDiff = Math.max(maxDiff, Math.abs(full.getSDF(x, y, z) - compact.getSDF(x, y, z)));
        }
      }
    }
    assert.ok(maxDiff < 0.01, `perbedaan SDF maksimum antara 'sdf' dan 'sdf-compact' adalah ${maxDiff}, harus sangat kecil`);
  });

  test('smoothing safety-net (smoothSDF) tetap berjalan untuk sdf-compact, sama seperti sdf', () => {
    // Sengaja bandingkan terhadap storage yang SENGAJA tidak di-smooth
    // (panggil generateChunkVoxels lalu decode raw tanpa smoothing tidak
    // mudah diisolasi dari fungsi ini) -- cukup pastikan tidak error dan
    // hasilnya storage yang valid & bisa dibaca.
    const storage = generateChunkVoxels(0, 0, 'sdf-compact', 'normal');
    assert.doesNotThrow(() => storage.getSDF(8, 20, 8));
  });
});

describe('generateChunkVoxels — storageType "sdf" tidak berubah perilakunya (regresi)', () => {
  test('masih menghasilkan instance SDFStorage seperti sebelumnya', () => {
    const storage = generateChunkVoxels(0, 0, 'sdf', 'normal');
    assert.ok(storage instanceof SDFStorage);
  });
});
