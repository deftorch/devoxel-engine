import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SDFStorage } from '../core/voxel/SDFStorage.js';
import { QuantizedSDFStorage } from '../core/voxel/QuantizedSDFStorage.js';
import { SurfaceNetsMesher } from '../core/mesher/SurfaceNetsMesher.js';

describe('QuantizedSDFStorage — interface parity dengan SDFStorage', () => {
  test('constructor + dims sama seperti SDFStorage', () => {
    const storage = new QuantizedSDFStorage(4, 8, 4);
    assert.deepEqual(storage.dims, [4, 8, 4]);
  });

  test('default value adalah udara (SDF > 0) di semua sel, sama seperti SDFStorage', () => {
    const storage = new QuantizedSDFStorage(4, 4, 4);
    assert.ok(storage.getSDF(1, 1, 1) > 0);
    assert.equal(storage.get(1, 1, 1), 0); // 0 = udara di API blocky
  });

  test('get()/set() blocky (kompatibilitas mundur) berperilaku identik dengan SDFStorage', () => {
    const quant = new QuantizedSDFStorage(4, 4, 4);
    const full = new SDFStorage(4, 4, 4);

    quant.set(1, 1, 1, 1);
    full.set(1, 1, 1, 1);
    assert.equal(quant.get(1, 1, 1), full.get(1, 1, 1));

    quant.set(2, 2, 2, 0);
    full.set(2, 2, 2, 0);
    assert.equal(quant.get(2, 2, 2), full.get(2, 2, 2));
  });

  test('out-of-bounds access aman (tidak throw), sama seperti SDFStorage', () => {
    const storage = new QuantizedSDFStorage(4, 4, 4);
    assert.equal(storage.getSDF(-1, 0, 0), 1.0);
    assert.equal(storage.getSDF(100, 0, 0), 1.0);
    assert.doesNotThrow(() => storage.setSDF(-1, 0, 0, -5.0)); // no-op, tidak error
    assert.equal(storage.get(-1, 0, 0), 0);
  });
});

describe('QuantizedSDFStorage — presisi kuantisasi', () => {
  test('nilai dekat nol (yang paling penting untuk kehalusan permukaan) presisinya <= 1/512', () => {
    const storage = new QuantizedSDFStorage(2, 2, 2);
    const testValues = [0.001, -0.001, 0.1, -0.1, 0.4999, -0.4999];
    for (const v of testValues) {
      storage.setSDF(0, 0, 0, v);
      const error = Math.abs(storage.getSDF(0, 0, 0) - v);
      assert.ok(error <= 1 / 512, `error untuk nilai ${v} adalah ${error}, harus <= 1/512`);
    }
  });

  test('nilai ekstrem di luar rentang clamp tetap mempertahankan SIGN yang benar', () => {
    const storage = new QuantizedSDFStorage(2, 2, 2);
    storage.setSDF(0, 0, 0, 1000.0); // jauh di luar clamp -- tapi harus tetap POSITIF (udara)
    storage.setSDF(1, 0, 0, -1000.0); // harus tetap NEGATIF (solid)

    assert.ok(storage.getSDF(0, 0, 0) > 0, 'nilai positif ekstrem harus tetap positif setelah clamp');
    assert.ok(storage.getSDF(1, 0, 0) < 0, 'nilai negatif ekstrem harus tetap negatif setelah clamp');
  });

  test('round-trip encode/decode konsisten untuk rentang nilai realistis (-8..8, amplitudo noise gua)', () => {
    const storage = new QuantizedSDFStorage(2, 2, 2);
    for (let v = -8; v <= 8; v += 0.37) {
      storage.setSDF(0, 0, 0, v);
      assert.ok(Math.abs(storage.getSDF(0, 0, 0) - v) <= 1 / 512 + 1e-9);
    }
  });
});

describe('QuantizedSDFStorage — smoothSDF() (safety-net smoothing, sama seperti SDFStorage)', () => {
  test('smoothing pass tidak melempar error dan tetap menghasilkan Int16Array', () => {
    const storage = new QuantizedSDFStorage(4, 4, 4);
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++)
        for (let z = 0; z < 4; z++) storage.setSDF(x, y, z, x - 2);

    assert.doesNotThrow(() => storage.smoothSDF(0.15));
    assert.ok(storage.sdf instanceof Int16Array);
  });

  test('hasil smoothing mendekati hasil smoothing SDFStorage (Float32) untuk data yang sama', () => {
    const quant = new QuantizedSDFStorage(4, 4, 4);
    const full = new SDFStorage(4, 4, 4);
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++)
        for (let z = 0; z < 4; z++) {
          const v = (x + y + z) * 0.3 - 1.5;
          quant.setSDF(x, y, z, v);
          full.setSDF(x, y, z, v);
        }

    quant.smoothSDF(0.15);
    full.smoothSDF(0.15);

    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++)
        for (let z = 0; z < 4; z++) {
          const diff = Math.abs(quant.getSDF(x, y, z) - full.getSDF(x, y, z));
          assert.ok(diff < 0.01, `smoothing di (${x},${y},${z}) beda ${diff}, harus hampir identik dengan versi Float32`);
        }
  });
});

describe('QuantizedSDFStorage — memory footprint (alasan utama B.4)', () => {
  test('byteLength buffer internal adalah SETENGAH dari SDFStorage untuk dims yang sama', () => {
    const quant = new QuantizedSDFStorage(16, 40, 16);
    const full = new SDFStorage(16, 40, 16);

    assert.equal(quant.sdf.byteLength, full.sdf.byteLength / 2);
  });
});

describe('QuantizedSDFStorage — kompatibilitas dengan SurfaceNetsMesher (alasan B.4 TIDAK memakai BrickMap/SVDAG/Tree64)', () => {
  function fillSphere(storage, size) {
    const c = size / 2;
    for (let x = 0; x < size; x++)
      for (let y = 0; y < size; y++)
        for (let z = 0; z < size; z++) {
          const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) - size * 0.3;
          storage.setSDF(x, y, z, dist);
        }
  }

  test('generateMesh() tidak error dan menghasilkan geometri untuk QuantizedSDFStorage (tidak seperti BrickMap/SVDAG/Tree64 yang TIDAK implement getSDF())', () => {
    const size = 8;
    const storage = new QuantizedSDFStorage(size, size, size);
    fillSphere(storage, size);

    const mesher = new SurfaceNetsMesher();
    const result = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0] });

    assert.ok(result.vertexData.length > 0, 'harus menghasilkan geometri, bukan crash atau mesh kosong');
    let badCount = 0;
    for (let i = 0; i < result.vertexData.length; i++) {
      if (!Number.isFinite(result.vertexData[i])) badCount++;
    }
    assert.equal(badCount, 0, 'tidak boleh ada NaN/Infinity di vertex data');
  });

  test('geometri dari QuantizedSDFStorage HAMPIR IDENTIK dengan SDFStorage untuk data sumber yang sama (kehilangan presisi tidak terlihat)', () => {
    const size = 8;
    const storageFull = new SDFStorage(size, size, size);
    const storageQuant = new QuantizedSDFStorage(size, size, size);
    fillSphere(storageFull, size);
    fillSphere(storageQuant, size);

    const mesher = new SurfaceNetsMesher();
    const resultFull = mesher.generateMesh(storageFull, { chunkCoord: [0, 0, 0] });
    const resultQuant = mesher.generateMesh(storageQuant, { chunkCoord: [0, 0, 0] });

    // Jumlah vertex HARUS sama persis (topologi permukaan tidak berubah --
    // kuantisasi cuma menggeser posisi vertex sedikit, tidak pernah cukup
    // besar untuk mengubah cell mana yang aktif/tidak aktif untuk data
    // sphere yang halus ini).
    assert.equal(
      resultQuant.vertexData.length,
      resultFull.vertexData.length,
      'jumlah vertex harus identik -- kuantisasi tidak boleh mengubah topologi permukaan'
    );

    // Posisi tiap vertex boleh sedikit beda (presisi kuantisasi), tapi
    // harus SANGAT dekat -- jauh di bawah 1 unit voxel.
    let maxDiff = 0;
    for (let i = 0; i < resultFull.vertexData.length; i += 9) {
      const dx = resultFull.vertexData[i] - resultQuant.vertexData[i];
      const dy = resultFull.vertexData[i + 1] - resultQuant.vertexData[i + 1];
      const dz = resultFull.vertexData[i + 2] - resultQuant.vertexData[i + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      maxDiff = Math.max(maxDiff, dist);
    }
    assert.ok(
      maxDiff < 0.05,
      `pergeseran posisi vertex maksimum akibat kuantisasi adalah ${maxDiff}, harus jauh di bawah 1 unit voxel (tidak terlihat secara visual)`
    );
  });
});
