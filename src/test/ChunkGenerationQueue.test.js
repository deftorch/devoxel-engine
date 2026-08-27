import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkGenerationQueue } from '../core/world/ChunkGenerationQueue.js';

function job(cx, cz, priorityDistance) {
  return { key: ChunkGenerationQueue.key(cx, cz), cx, cz, priorityDistance, resolve: () => {} };
}

describe('ChunkGenerationQueue — dequeueNearest() memprioritaskan jarak, bukan FIFO', () => {
  test('chunk yang di-enqueue belakangan tapi lebih dekat keluar duluan', () => {
    const q = new ChunkGenerationQueue();
    q.enqueue(job(10, 10, 8)); // jauh, masuk duluan
    q.enqueue(job(1, 1, 1)); // dekat, masuk belakangan
    q.enqueue(job(5, 5, 4)); // sedang

    const first = q.dequeueNearest();
    assert.equal(first.key, '1,1');
    const second = q.dequeueNearest();
    assert.equal(second.key, '5,5');
    const third = q.dequeueNearest();
    assert.equal(third.key, '10,10');
    assert.equal(q.dequeueNearest(), null);
  });

  test('urutan insersi dipertahankan untuk priorityDistance yang sama (tie-break stabil)', () => {
    const q = new ChunkGenerationQueue();
    q.enqueue(job(0, 0, 2));
    q.enqueue(job(1, 0, 2));
    q.enqueue(job(0, 1, 2));

    assert.equal(q.dequeueNearest().key, '0,0');
    assert.equal(q.dequeueNearest().key, '1,0');
    assert.equal(q.dequeueNearest().key, '0,1');
  });

  test('size mengikuti jumlah job yang masih menunggu', () => {
    const q = new ChunkGenerationQueue();
    assert.equal(q.size, 0);
    q.enqueue(job(0, 0, 0));
    q.enqueue(job(1, 1, 1));
    assert.equal(q.size, 2);
    q.dequeueNearest();
    assert.equal(q.size, 1);
  });

  test('dequeueNearest() pada queue kosong return null, bukan throw', () => {
    const q = new ChunkGenerationQueue();
    assert.equal(q.dequeueNearest(), null);
  });
});

describe('ChunkGenerationQueue — removeByKey() untuk pembatalan job', () => {
  test('menghapus & mengembalikan job yang masih menunggu', () => {
    const q = new ChunkGenerationQueue();
    q.enqueue(job(2, 3, 5));
    const removed = q.removeByKey('2,3');
    assert.notEqual(removed, null);
    assert.equal(removed.cx, 2);
    assert.equal(removed.cz, 3);
    assert.equal(q.size, 0);
  });

  test('return null kalau key tidak ada di antrian (mis. sudah in-flight ke worker)', () => {
    const q = new ChunkGenerationQueue();
    q.enqueue(job(0, 0, 0));
    assert.equal(q.removeByKey('99,99'), null);
    assert.equal(q.size, 1); // job lain tidak ikut terhapus
  });

  test('hasKey() mencerminkan isi antrian setelah enqueue/removeByKey', () => {
    const q = new ChunkGenerationQueue();
    const key = ChunkGenerationQueue.key(7, -3);
    assert.equal(q.hasKey(key), false);
    q.enqueue(job(7, -3, 0));
    assert.equal(q.hasKey(key), true);
    q.removeByKey(key);
    assert.equal(q.hasKey(key), false);
  });
});

describe('ChunkGenerationQueue — enqueue() validasi input', () => {
  test('menolak job tanpa field key', () => {
    const q = new ChunkGenerationQueue();
    assert.throws(() => q.enqueue({ cx: 0, cz: 0, priorityDistance: 0 }));
  });
});
