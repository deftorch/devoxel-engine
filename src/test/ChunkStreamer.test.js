import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkStreamer } from '../core/world/ChunkStreamer.js';

describe('ChunkStreamer — konstruksi', () => {
  test('menolak viewDistance negatif atau bukan integer', () => {
    assert.throws(() => new ChunkStreamer(-1));
    assert.throws(() => new ChunkStreamer(1.5));
  });

  test('viewDistance 0 valid (cuma chunk pemain sendiri)', () => {
    const s = new ChunkStreamer(0);
    const delta = s.update(0, 0);
    assert.equal(delta.toLoad.length, 1);
    assert.deepEqual(delta.toLoad[0], [0, 0]);
  });
});

describe('ChunkStreamer — no-op selama masih di chunk yang sama', () => {
  test('update() dengan (cx, cz) yang sama berturut-turut return null setelah panggilan pertama', () => {
    const s = new ChunkStreamer(2);
    const first = s.update(5, 5);
    assert.notEqual(first, null);

    // Sesuai anjuran roadmap: "Hitung (cx, cz) chunk pemain tiap interval
    // (bukan tiap frame -- cukup tiap kali pemain pindah chunk)". Panggilan
    // berulang dengan koordinat sama (simulasi banyak frame tanpa pemain
    // pindah chunk) tidak boleh menghasilkan kerja load/unload apapun.
    assert.equal(s.update(5, 5), null);
    assert.equal(s.update(5, 5), null);
  });

  test('bergerak sedikit tapi tetap di chunk yang sama (posisi sub-chunk berubah) tidak memicu apapun', () => {
    // Simulasikan caller yang sudah membagi world-pos dengan chunk size --
    // artinya voxel-level movement dalam 1 chunk yang sama harus sudah
    // menghasilkan (cx, cz) yang identik SEBELUM sampai ke streamer ini.
    const s = new ChunkStreamer(1);
    s.update(0, 0);
    assert.equal(s.update(0, 0), null);
  });
});

describe('ChunkStreamer — jumlah chunk sesuai radius (bujur sangkar)', () => {
  test('viewDistance r menghasilkan (2r+1)^2 chunk ter-load setelah update pertama', () => {
    for (const r of [0, 1, 2, 4, 6]) {
      const s = new ChunkStreamer(r);
      const delta = s.update(100, -50); // titik awal sembarang, jauh dari origin
      assert.equal(delta.toLoad.length, (2 * r + 1) ** 2);
      assert.equal(delta.toUnload.length, 0);
      assert.equal(s.loadedCount, (2 * r + 1) ** 2);
    }
  });

  test('chunk yang loaded persis membentuk bujur sangkar berpusat di pemain', () => {
    const s = new ChunkStreamer(1);
    s.update(10, 10);
    const expected = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) expected.add(`${10 + dx},${10 + dz}`);
    }
    assert.equal(s.loadedKeys.size, expected.size);
    for (const key of expected) assert.ok(s.loadedKeys.has(key), `${key} seharusnya loaded`);
  });
});

describe('ChunkStreamer — acceptance test A.1: jalan jauh, jumlah chunk stabil, tidak ada yang bocor', () => {
  test('pemain jalan lurus jauh (>10x radius): loadedCount tetap konstan di tiap langkah', () => {
    const r = 4;
    const s = new ChunkStreamer(r);
    const expectedCount = (2 * r + 1) ** 2;

    s.update(0, 0);
    assert.equal(s.loadedCount, expectedCount);

    // >10x radius, jalan 1 chunk per langkah searah +x.
    for (let step = 1; step <= r * 12; step++) {
      const delta = s.update(step, 0);
      assert.notEqual(delta, null, `langkah ${step} seharusnya memicu load/unload (pindah chunk)`);
      assert.equal(s.loadedCount, expectedCount, `loadedCount harus tetap ${expectedCount} di langkah ${step}`);
    }
  });

  test('jalan 1 chunk per langkah: tepat 1 kolom chunk baru masuk, 1 kolom lama keluar (tidak lebih tidak kurang)', () => {
    const r = 3;
    const s = new ChunkStreamer(r);
    s.update(0, 0);

    const delta = s.update(1, 0); // pindah 1 chunk ke arah +x
    // Kolom baru di x = 0+r+1, lebar (2r+1) di sumbu z.
    assert.equal(delta.toLoad.length, 2 * r + 1);
    // Kolom lama di x = 0-r, ikut keluar radius.
    assert.equal(delta.toUnload.length, 2 * r + 1);

    for (const [cx] of delta.toLoad) assert.equal(cx, 1 + r);
    for (const [cx] of delta.toUnload) assert.equal(cx, -r);
  });

  test('tidak ada chunk "bocor": setiap chunk ter-load berada persis dalam radius Chebyshev dari posisi pemain saat ini', () => {
    const r = 3;
    const s = new ChunkStreamer(r);

    const path = [
      [0, 0],
      [2, 0],
      [2, 3],
      [-4, 3],
      [-4, -8],
      [10, -8],
    ];
    for (const [pcx, pcz] of path) {
      s.update(pcx, pcz);
      for (const key of s.loadedKeys) {
        const [cx, cz] = key.split(',').map(Number);
        const dist = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
        assert.ok(dist <= r, `chunk ${key} bocor -- jarak ${dist} > radius ${r} dari pemain (${pcx},${pcz})`);
      }
    }
  });

  test('diagonal besar (>10x radius di x dan z sekaligus) tetap stabil tanpa freeze/growth', () => {
    const r = 2;
    const s = new ChunkStreamer(r);
    const expectedCount = (2 * r + 1) ** 2;
    let totalLoadOps = 0;
    let totalUnloadOps = 0;

    for (let step = 0; step <= r * 15; step++) {
      const delta = s.update(step, step);
      if (delta) {
        totalLoadOps += delta.toLoad.length;
        totalUnloadOps += delta.toUnload.length;
      }
    }

    assert.equal(s.loadedCount, expectedCount);
    // Tiap langkah diagonal me-load lebih dari satu chunk baru (2 kolom L),
    // tapi jumlah unload harus mengimbangi supaya total tidak pernah "terus
    // naik" (bagian dari acceptance test roadmap: memory chunk count stabil).
    assert.ok(totalUnloadOps > 0);
    assert.ok(Math.abs(totalLoadOps - totalUnloadOps) <= expectedCount);
  });
});

describe('ChunkStreamer — reset()', () => {
  test('reset() mengosongkan loadedKeys dan membuat update() berikutnya seperti pertama kali', () => {
    const s = new ChunkStreamer(2);
    s.update(5, 5);
    assert.ok(s.loadedCount > 0);

    s.reset();
    assert.equal(s.loadedCount, 0);

    // Setelah reset, update() dengan koordinat SAMA seperti sebelum reset
    // tetap harus menghasilkan delta baru (bukan null), karena
    // lastPlayerChunk juga direset.
    const delta = s.update(5, 5);
    assert.notEqual(delta, null);
    assert.equal(delta.toLoad.length, (2 * 2 + 1) ** 2);
  });
});
