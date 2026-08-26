import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mat4Perspective,
  mat4LookAt,
  mat4Multiply,
  computeFrustumPlanes,
  aabbOutsideFrustum,
} from '../core/utils/math.js';

// Kamera di origin, menghadap +Z, fov 90 derajat, near 0.1 far 500.
function makePlanes(eye = [0, 0, 0], target = [0, 0, 1], fov = Math.PI / 2, aspect = 1.0) {
  const proj = mat4Perspective(fov, aspect, 0.1, 500);
  const view = mat4LookAt(eye, target, [0, 1, 0]);
  return computeFrustumPlanes(mat4Multiply(proj, view));
}

describe('computeFrustumPlanes', () => {
  test('menghasilkan 6 plane', () => {
    const planes = makePlanes();
    assert.equal(planes.length, 6);
  });

  test('tiap plane sudah dinormalisasi (panjang normal ~1)', () => {
    const planes = makePlanes();
    for (const [a, b, c] of planes) {
      const len = Math.hypot(a, b, c);
      assert.ok(Math.abs(len - 1) < 1e-5, `panjang normal ${len} harus mendekati 1`);
    }
  });
});

describe('aabbOutsideFrustum — kasus dasar (kamera di origin, menghadap +Z)', () => {
  const planes = makePlanes();

  test('box di depan kamera TIDAK dianggap outside (harus tetap digambar)', () => {
    assert.equal(aabbOutsideFrustum(planes, [-8, -8, 10], [8, 8, 26]), false);
  });

  test('box di belakang kamera DIANGGAP outside (aman untuk di-cull)', () => {
    assert.equal(aabbOutsideFrustum(planes, [-8, -8, -100], [8, 8, -84]), true);
  });

  test('box jauh di luar sudut pandang horizontal DIANGGAP outside', () => {
    assert.equal(aabbOutsideFrustum(planes, [500, -8, 10], [516, 8, 26]), true);
  });

  test('box besar yang overlap frustum TIDAK di-cull (tidak boleh ada false negative)', () => {
    // Box ini melintang sangat lebar melewati frustum -- sebagian ada di
    // dalam, sebagian di luar. Test konservatif: tidak boleh dianggap
    // "outside" karena itu akan membuat geometri yang seharusnya
    // kelihatan malah hilang (popping).
    assert.equal(aabbOutsideFrustum(planes, [-1000, -8, 10], [1000, 8, 26]), false);
  });
});

describe('aabbOutsideFrustum — simulasi dunia voxel nyata (chunk 16x40x16)', () => {
  const csx = 16, csy = 40, csz = 16;
  // Kamera di tengah dunia (world pos 160,20,160), menghadap +Z.
  const planes = makePlanes([160, 20, 160], [160, 20, 161], Math.PI / 3, 16 / 9);

  function chunkAABB(cx, cz) {
    return [
      [cx * csx, 0, cz * csz],
      [cx * csx + csx, csy, cz * csz + csz],
    ];
  }

  test('chunk di depan kamera tidak di-cull', () => {
    const [min, max] = chunkAABB(10, 12); // z=192, di depan kamera (z=160)
    assert.equal(aabbOutsideFrustum(planes, min, max), false);
  });

  test('chunk tepat di belakang kamera di-cull', () => {
    const [min, max] = chunkAABB(10, 4); // z=64, di belakang kamera
    assert.equal(aabbOutsideFrustum(planes, min, max), true);
  });

  test('chunk yang berisi posisi kamera sendiri tidak pernah di-cull', () => {
    const [min, max] = chunkAABB(10, 10); // 160..176, mencakup eye di x=160,z=160
    assert.equal(aabbOutsideFrustum(planes, min, max), false);
  });
});
