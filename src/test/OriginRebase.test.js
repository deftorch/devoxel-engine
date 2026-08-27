import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OriginRebase } from '../core/world/OriginRebase.js';

describe('OriginRebase — konstruksi', () => {
  test('menolak rebaseThresholdChunks < 1 atau bukan integer', () => {
    assert.throws(() => new OriginRebase(0));
    assert.throws(() => new OriginRebase(-5));
    assert.throws(() => new OriginRebase(2.5));
  });

  test('origin mulai di (0, 0)', () => {
    const o = new OriginRebase(10);
    assert.equal(o.originChunkX, 0);
    assert.equal(o.originChunkZ, 0);
  });
});

describe('OriginRebase — tidak rebase selama masih dalam threshold', () => {
  test('update() dalam radius threshold return false, origin tidak berubah', () => {
    const o = new OriginRebase(10);
    assert.equal(o.update(5, 5), false);
    assert.equal(o.update(10, -10), false); // persis di threshold (<=), belum melampaui
    assert.equal(o.originChunkX, 0);
    assert.equal(o.originChunkZ, 0);
  });
});

describe('OriginRebase — rebase tepat saat threshold dilampaui', () => {
  test('melampaui threshold di satu sumbu memicu rebase, origin pindah PERSIS ke posisi pemain', () => {
    const o = new OriginRebase(10);
    const rebased = o.update(11, 0);
    assert.equal(rebased, true);
    assert.equal(o.originChunkX, 11);
    assert.equal(o.originChunkZ, 0);
  });

  test('setelah rebase, panggilan berikutnya dalam threshold BARU tidak rebase lagi', () => {
    const o = new OriginRebase(10);
    o.update(11, 0);
    assert.equal(o.update(15, 5), false); // jarak dari (11,0) = max(4,5) = 5 <= 10
    assert.equal(o.originChunkX, 11);
  });

  test('jarak dihitung Chebyshev (bukan Euclidean) -- diagonal jauh tetap memicu di sumbu manapun dulu tercapai', () => {
    const o = new OriginRebase(10);
    assert.equal(o.distanceFromOrigin(7, 7), 7); // Chebyshev, bukan sqrt(7^2+7^2)
    assert.equal(o.update(7, 7), false);
    assert.equal(o.update(11, 11), true);
    assert.equal(o.originChunkX, 11);
    assert.equal(o.originChunkZ, 11);
  });
});

describe('OriginRebase — acceptance test A.5: jarak dari origin tetap terbatas sepanjang perjalanan jauh', () => {
  test('jalan lurus jauh (>>100.000 unit setara) -- jarak ke origin tidak pernah melebihi threshold', () => {
    const threshold = 32;
    const o = new OriginRebase(threshold);

    // Simulasikan pemain jalan 1 chunk per langkah sejauh 20,000 chunk
    // (>>100.000 unit dengan chunk size berapa pun yang masuk akal, mis.
    // 16 unit/chunk -> 320.000 unit) searah +x.
    for (let step = 1; step <= 20000; step++) {
      o.update(step, 0);
      assert.ok(
        o.distanceFromOrigin(step, 0) <= threshold,
        `di langkah ${step}, jarak ke origin (${o.originChunkX},${o.originChunkZ}) melebihi threshold ${threshold}`
      );
    }
  });

  test('rebase terjadi secara berkala (bukan tiap langkah, bukan tidak pernah) saat jalan lurus jauh', () => {
    const threshold = 32;
    const o = new OriginRebase(threshold);
    let rebaseCount = 0;
    for (let step = 1; step <= 1000; step++) {
      if (o.update(step, 0)) rebaseCount++;
    }
    // Jalan 1000 chunk dengan threshold 32 -- rebase seharusnya terjadi
    // kira-kira tiap (threshold+1) langkah, jadi sekitar 1000/33 ≈ 30 kali.
    // Bukan 1000 kali (setiap langkah) dan bukan 0 kali (tidak pernah).
    assert.ok(rebaseCount > 10 && rebaseCount < 100, `rebaseCount=${rebaseCount} di luar rentang wajar`);
  });

  test('diagonal jauh juga tetap terbatas', () => {
    const threshold = 16;
    const o = new OriginRebase(threshold);
    for (let step = 1; step <= 5000; step++) {
      o.update(step, -step);
      assert.ok(o.distanceFromOrigin(step, -step) <= threshold);
    }
  });
});
