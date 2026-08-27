import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SDFStorage } from '../core/voxel/SDFStorage.js';
import { FlatGridStorage } from '../core/voxel/FlatGridStorage.js';
import { deserializeStorage } from '../core/voxel/deserializeStorage.js';

/**
 * Simulasikan apa yang sebenarnya terjadi lewat batas `postMessage()`
 * antara generator.worker.js dan main thread: kalau Transferable Objects
 * dipakai dengan benar, TypedArray-nya "pindah" (buffer di-detach dari
 * pengirim), bukan di-copy. Di sini kita tiru itu dengan sengaja membuat
 * instance TypedArray baru dari buffer yang sama, supaya test tidak diam-
 * diam lolos hanya karena masih memegang referensi objek asli yang sama.
 */
function roundTripViaTransfer(payload) {
  const cloned = { ...payload };
  for (const [k, v] of Object.entries(payload)) {
    if (v && v.buffer instanceof ArrayBuffer) {
      cloned[k] = new v.constructor(v.buffer.slice(0)); // buffer baru, bukan referensi lama
    } else if (Array.isArray(v)) {
      cloned[k] = [...v];
    }
  }
  return cloned;
}

describe('SDFStorage — serialize()/deserialize() round trip (Roadmap A.2)', () => {
  test('nilai SDF yang di-set tetap sama setelah round trip', () => {
    const storage = new SDFStorage(16, 40, 16);
    storage.setSDF(0, 0, 0, -3.5); // batas bawah chunk
    storage.setSDF(15, 39, 15, 2.25); // batas atas chunk
    storage.setSDF(8, 20, 8, -0.125); // representable exactly in Float32

    const restored = deserializeStorage(roundTripViaTransfer(storage.serialize()));

    assert.ok(restored instanceof SDFStorage);
    assert.deepEqual(restored.dims, [16, 40, 16]);
    assert.equal(restored.getSDF(0, 0, 0), -3.5);
    assert.equal(restored.getSDF(15, 39, 15), 2.25);
    assert.equal(restored.getSDF(8, 20, 8), -0.125);
  });

  test('sel yang tidak pernah di-set tetap default 1.0 (udara) setelah round trip', () => {
    const storage = new SDFStorage(4, 4, 4);
    const restored = deserializeStorage(roundTripViaTransfer(storage.serialize()));
    assert.equal(restored.getSDF(1, 1, 1), 1.0);
  });

  test('payload.type === "sdf" dan sdf adalah Float32Array (siap jadi Transferable)', () => {
    const storage = new SDFStorage(4, 4, 4);
    const payload = storage.serialize();
    assert.equal(payload.type, 'sdf');
    assert.ok(payload.sdf instanceof Float32Array);
  });
});

describe('FlatGridStorage — tetap bisa lewat deserializeStorage() generik', () => {
  test('round trip lewat dispatcher yang sama dengan SDF', () => {
    const storage = new FlatGridStorage(4, 4, 4);
    storage.set(1, 2, 3, 7);
    const restored = deserializeStorage(roundTripViaTransfer(storage.serialize()));
    assert.ok(restored instanceof FlatGridStorage);
    assert.equal(restored.get(1, 2, 3), 7);
  });
});

describe('deserializeStorage() — tipe yang belum didukung', () => {
  test('melempar error yang jelas untuk storage berbasis tree/pointer', () => {
    assert.throws(() => deserializeStorage({ type: 'octree', dims: [16, 40, 16] }), /belum didukung/);
  });

  test('melempar error untuk payload tanpa field type', () => {
    assert.throws(() => deserializeStorage({}), /tidak valid/);
    assert.throws(() => deserializeStorage(null), /tidak valid/);
  });
});
