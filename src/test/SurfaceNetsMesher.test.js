import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceNetsMesher } from '../core/mesher/SurfaceNetsMesher.js';
import { SDFStorage } from '../core/voxel/SDFStorage.js';

const CS = 8;

function makeSphereChunk(size = CS) {
  const storage = new SDFStorage(size, size, size);
  const c = size / 2;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) - size * 0.3;
        storage.setSDF(x, y, z, dist);
      }
    }
  }
  return storage;
}

function makeSlopeChunk(chunkX, size = CS) {
  const storage = new SDFStorage(size, size, size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const wx = chunkX * size + x;
        const h = wx * 0.3 + 3;
        storage.setSDF(x, y, z, y - h);
      }
    }
  }
  return storage;
}

describe('SurfaceNetsMesher', () => {
  test('generateMesh never produces NaN/Infinity in position or normal data', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    const result = mesher.generateMesh(storage, null);

    assert.ok(result.vertexData.length > 0, 'expected some geometry from a sphere SDF');

    let badVertexCount = 0;
    for (let i = 0; i < result.vertexData.length; i++) {
      if (!Number.isFinite(result.vertexData[i])) badVertexCount++;
    }
    assert.equal(
      badVertexCount,
      0,
      `expected no NaN/Infinity values in vertexData, found ${badVertexCount}. ` +
        'This regresses the bug where fractional vertex positions were used to ' +
        'index the SDF TypedArray directly in _getNormal (undefined -> NaN).'
    );
  });

  test('normals returned by _getNormal are always finite unit vectors', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    // Sample a handful of fractional (non-integer) positions, which is what
    // generateMesh actually feeds into _getNormal for interpolated vertices.
    const samples = [
      [4.3, 4.3, 6.9],
      [1.7, 4.0, 4.0],
      [4.0, 1.25, 4.0],
    ];
    for (const [x, y, z] of samples) {
      const [nx, ny, nz] = mesher._getNormal(storage, null, x, y, z, storage.dims);
      assert.ok(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), `normal at (${x},${y},${z}) should be finite, got [${nx},${ny},${nz}]`);
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      assert.ok(Math.abs(len - 1) < 1e-6 || len === 0, `normal at (${x},${y},${z}) should be unit-length, got length ${len}`);
    }
  });

  test('adjacent chunks both produce vertices at the shared boundary (no seam gap)', () => {
    const mesher = new SurfaceNetsMesher();
    const chunkA = makeSlopeChunk(0);
    const chunkB = makeSlopeChunk(1);
    const chunks = { '0,0,0': chunkA, '1,0,0': chunkB };
    const makeCtx = (cx) => ({
      chunkCoord: [cx, 0, 0],
      getNeighbor: (dx, dy, dz) => chunks[`${cx + dx},${dy},${dz}`] ?? null,
    });

    const meshA = mesher.generateMesh(chunkA, makeCtx(0));
    const meshB = mesher.generateMesh(chunkB, makeCtx(1));

    const boundaryWorldX = CS; // chunk A ends / chunk B starts here in world space
    const nearBoundary = (mesh, tol = 0.6) => {
      let count = 0;
      for (let i = 0; i < mesh.vertexData.length / 9; i++) {
        if (Math.abs(mesh.vertexData[i * 9] - boundaryWorldX) < tol) count++;
      }
      return count;
    };

    assert.ok(
      nearBoundary(meshA) > 0,
      'chunk A should generate vertices right at its shared edge with chunk B (regression: cell -1 was never computed, so boundary quads were silently skipped)'
    );
    assert.ok(nearBoundary(meshB) > 0, 'chunk B should generate vertices right at its shared edge with chunk A');
  });

  // Roadmap A.5 -- Origin Rebasing: ctx.originChunk membakar posisi vertex
  // RELATIF terhadap sebuah origin, bukan selalu absolut dari (0,0,0).
  describe('generateMesh — ctx.originChunk (Roadmap A.5)', () => {
    // Medan LOKAL (tidak bergantung pada chunkCoord) -- beda dengan
    // makeSlopeChunk() di atas yang sengaja height-nya mengikuti posisi
    // WORLD (dipakai untuk uji kontinuitas antar chunk). Di sini kita cuma
    // perlu permukaan yang selalu ada di dalam rentang y lokal (0..size)
    // berapa pun chunkCoord yang dipakai untuk baking offset, termasuk
    // chunkCoord yang sangat jauh dari (0,0,0).
    function makeLocalSlopeChunk(size = CS) {
      const storage = new SDFStorage(size, size, size);
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          for (let z = 0; z < size; z++) {
            const h = x * 0.3 + size * 0.4;
            storage.setSDF(x, y, z, y - h);
          }
        }
      }
      return storage;
    }

    test('tanpa ctx.originChunk, posisi vertex tetap absolut persis seperti sebelumnya (backward compatible)', () => {
      const mesher = new SurfaceNetsMesher();
      const chunk = makeLocalSlopeChunk(CS);
      const ctx = { chunkCoord: [5, 0, 0], getNeighbor: () => null };

      const mesh = mesher.generateMesh(chunk, ctx);
      assert.ok(mesh.vertexData.length > 0, 'medan lokal seharusnya menghasilkan geometri');
      // Vertex x pertama harus berada di sekitar world-absolute x = 5*CS = 40
      // (toleransi 1 unit untuk sel batas -1 yang disengaja disampel mesher,
      // lihat test "adjacent chunks" di atas), BUKAN chunk-local (0..CS) --
      // identik dengan perilaku sebelum A.5.
      assert.ok(mesh.vertexData[0] >= 5 * CS - 1 && mesh.vertexData[0] < 6 * CS);
    });

    test('ctx.originChunk menggeser posisi vertex relatif terhadap origin tsb (selisih persis = jarak origin dalam unit dunia)', () => {
      const mesher = new SurfaceNetsMesher();
      const chunk = makeLocalSlopeChunk(CS);
      const ctxAbsolute = { chunkCoord: [5, 0, 0], getNeighbor: () => null };
      const ctxRelative = { chunkCoord: [5, 0, 0], originChunk: [5, 0, 0], getNeighbor: () => null };

      const meshAbsolute = mesher.generateMesh(chunk, ctxAbsolute);
      const meshRelative = mesher.generateMesh(chunk, ctxRelative);

      // Origin == chunkCoord -> offset jadi nol -> vertex jadi chunk-local
      // (sekitar 0..CS, dengan sedikit overshoot negatif dari sel batas -1).
      const diff = meshAbsolute.vertexData[0] - meshRelative.vertexData[0];
      assert.ok(Math.abs(diff - 5 * CS) < 1e-4, `selisih offset harus persis 5*CS, dapat ${diff}`);
      assert.ok(meshRelative.vertexData[0] >= -1 && meshRelative.vertexData[0] < CS + 1);
    });

    test('originChunk tidak mengubah BENTUK mesh, cuma translasinya (vertex count & index count identik)', () => {
      const mesher = new SurfaceNetsMesher();
      const chunk = makeLocalSlopeChunk(CS);
      const ctxAbsolute = { chunkCoord: [5, 0, 0], getNeighbor: () => null };
      const ctxRelative = { chunkCoord: [5, 0, 0], originChunk: [2, 0, 0], getNeighbor: () => null };

      const meshAbsolute = mesher.generateMesh(chunk, ctxAbsolute);
      const meshRelative = mesher.generateMesh(chunk, ctxRelative);
      assert.equal(meshAbsolute.vertexData.length, meshRelative.vertexData.length);
      assert.equal(meshAbsolute.indexData.length, meshRelative.indexData.length);
    });

    test('acceptance test A.5: dengan origin di-rebase, magnitude vertex tetap kecil meski chunk aslinya jauh dari (0,0,0); tanpa rebase, magnitude ikut tumbuh sebesar posisi absolut', () => {
      const mesher = new SurfaceNetsMesher();
      const farChunkX = 125000; // >100.000 unit dengan CS=8 -> 1.000.000 unit
      const chunk = makeLocalSlopeChunk(CS);

      const ctxAbsolute = { chunkCoord: [farChunkX, 0, 0], getNeighbor: () => null };
      const meshAbsolute = mesher.generateMesh(chunk, ctxAbsolute);
      assert.ok(meshAbsolute.vertexData.length > 0);
      assert.ok(
        Math.abs(meshAbsolute.vertexData[0]) > farChunkX * CS - CS * 2,
        'tanpa origin rebase, magnitude vertex tumbuh sebesar posisi absolut dunia -- inilah akar masalah presisi float32 yang diperbaiki A.5'
      );

      const ctxRelative = {
        chunkCoord: [farChunkX, 0, 0],
        originChunk: [farChunkX, 0, 0],
        getNeighbor: () => null,
      };
      const meshRelative = mesher.generateMesh(chunk, ctxRelative);
      const stride = 9; // posisi(3) + normal(3) + warna(3) per vertex, lihat generateMesh()
      for (let i = 0; i < meshRelative.vertexData.length; i += stride) {
        assert.ok(
          Math.abs(meshRelative.vertexData[i]) < CS * 2,
          `dengan origin di-rebase, magnitude vertex tetap kecil (bounded ke skala chunk) meski chunk aslinya di x=${farChunkX}`
        );
      }
    });

    test('demonstrasi langsung akar masalah presisi float32 pada magnitude besar (independen dari mesher)', () => {
      // Membuktikan klaim umum yang mendasari fix A.5: menyimpan posisi
      // ABSOLUT (offset besar + detail sub-unit kecil) ke Float32Array
      // kehilangan detail kecil itu, sedangkan menyimpan versi RELATIF
      // (origin sudah dikurangi, jadi kecil) tidak -- persis yang terjadi
      // saat vertex data di-upload ke GPU vertex buffer (Float32Array).
      const farOffset = 1_000_000; // >100.000 unit, sesuai acceptance test roadmap
      const smallDetail = 0.35; // presisi sub-unit yang seharusnya tetap terjaga

      const absoluteStored = new Float32Array([farOffset + smallDetail])[0];
      const absoluteError = Math.abs(absoluteStored - (farOffset + smallDetail));

      const relativeStored = new Float32Array([smallDetail])[0];
      const relativeError = Math.abs(relativeStored - smallDetail);

      assert.ok(
        absoluteError > 1e-3,
        `pada magnitude besar (${farOffset}), Float32Array kehilangan detail sub-unit (error=${absoluteError})`
      );
      assert.ok(relativeError < 1e-6, `versi relatif (origin sudah dikurangi) tetap presisi (error=${relativeError})`);
    });
  });
});

describe('SurfaceNetsMesher — Partial Remeshing (Roadmap B.2)', () => {
  // Helper: ubah SATU voxel di storage sphere, lalu kembalikan koordinat
  // lokal-nya beserta AABB cell (dengan padding sama seperti
  // VoxelEngine._unionDirtyBounds()) supaya test bisa memanggil generateMesh
  // dengan ctx.dirtyBounds yang REALISTIS (bukan cuma AABB penuh chunk).
  function editVoxelAndGetDirtyBounds(storage, lx, ly, lz, newSDF) {
    storage.setSDF(lx, ly, lz, newSDF);
    const PADDING = 2;
    return {
      minX: lx - PADDING, maxX: lx + PADDING,
      minY: ly - PADDING, maxY: ly + PADDING,
      minZ: lz - PADDING, maxZ: lz + PADDING,
    };
  }

  test('build pertama (tanpa dirtyBounds/previousCellCache) tetap mengembalikan cellCache untuk dipakai berikutnya', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    const result = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0] });

    assert.ok(result.cellCache instanceof Map);
    assert.ok(result.cellCache.size > 0, 'sphere SDF harus menghasilkan beberapa cell aktif');
  });

  test('build partial (dirtyBounds sempit) menghasilkan mesh yang SECARA GEOMETRIS IDENTIK dengan full rebuild', () => {
    // Ini test PALING KRITIS untuk B.2: cache-reuse tidak boleh mengubah
    // hasil akhir sama sekali, cuma cara menghitungnya yang beda.
    const mesher = new SurfaceNetsMesher();

    // 1. Build FULL awal (baseline, sebelum ada edit apapun).
    const storageBefore = makeSphereChunk();
    const initialResult = mesher.generateMesh(storageBefore, { chunkCoord: [0, 0, 0] });

    // 2. Terapkan SATU edit voxel kecil dekat permukaan sphere (bukan di
    //    tengah solid/di luar udara -- supaya benar-benar mengubah topologi
    //    beberapa cell, bukan no-op).
    const c = CS / 2;
    const lx = c, ly = c, lz = Math.floor(c + CS * 0.3); // dekat permukaan +Z sphere
    const dirtyBounds = editVoxelAndGetDirtyBounds(storageBefore, lx, ly, lz, 5.0); // jadi udara

    // 3a. Build PARTIAL: pakai cellCache dari build sebelumnya + dirtyBounds sempit.
    const partialResult = mesher.generateMesh(storageBefore, {
      chunkCoord: [0, 0, 0],
      dirtyBounds,
      previousCellCache: initialResult.cellCache,
    });

    // 3b. Build FULL dari storage yang SAMA (setelah edit), sebagai ground truth.
    const fullResult = mesher.generateMesh(storageBefore, { chunkCoord: [0, 0, 0] });

    // Bandingkan sebagai HIMPUNAN posisi vertex (bukan urutan array mentah
    // -- urutan insersi partial vs full BOLEH beda, lihat komentar di
    // SurfaceNetsMesher.generateMesh(), yang penting geometri akhirnya
    // sama).
    function vertexPositionSet(vertexData) {
      const set = new Set();
      for (let i = 0; i < vertexData.length; i += 9) {
        // Bulatkan supaya perbandingan floating-point stabil.
        const key = `${vertexData[i].toFixed(4)},${vertexData[i + 1].toFixed(4)},${vertexData[i + 2].toFixed(4)}`;
        set.add(key);
      }
      return set;
    }

    const partialPositions = vertexPositionSet(partialResult.vertexData);
    const fullPositions = vertexPositionSet(fullResult.vertexData);

    assert.equal(
      partialResult.vertexData.length / 9,
      fullResult.vertexData.length / 9,
      'jumlah vertex partial harus SAMA PERSIS dengan full rebuild'
    );
    assert.deepEqual(
      [...partialPositions].sort(),
      [...fullPositions].sort(),
      'himpunan posisi vertex partial harus IDENTIK dengan full rebuild (partial-rebuild tidak boleh mengubah geometri)'
    );
    assert.equal(
      partialResult.indexData.length,
      fullResult.indexData.length,
      'jumlah index (triangle) partial harus sama dengan full rebuild'
    );
  });

  test('build partial BENAR-BENAR melewati komputasi cell di luar dirtyBounds (bukan cuma berlabel partial)', () => {
    // Buktikan ini genuinely partial, bukan cuma full rebuild yang diberi
    // nama lain: cell YANG SAMA (posisi identik) di luar dirtyBounds harus
    // memakai instance object CACHE PERSIS (sama reference), bukan
    // dihitung ulang -- kalau dihitung ulang, hasil floating-point BISA
    // saja identik (deterministik), jadi cara paling meyakinkan adalah
    // membandingkan REFERENCE cellCache record-nya, bukan cuma nilainya.
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    const initialResult = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0] });

    // dirtyBounds SANGAT sempit, jauh di sudut chunk -- pasti tidak overlap
    // sebagian besar cell aktif sphere yang ada di tengah.
    const dirtyBounds = { minX: -1, maxX: 0, minY: -1, maxY: 0, minZ: -1, maxZ: 0 };

    const partialResult = mesher.generateMesh(storage, {
      chunkCoord: [0, 0, 0],
      dirtyBounds,
      previousCellCache: initialResult.cellCache,
    });

    let reusedCount = 0;
    let recomputedCount = 0;
    for (const [key, rec] of partialResult.cellCache) {
      if (initialResult.cellCache.get(key) === rec) {
        reusedCount++; // reference SAMA -> dipakai ulang dari cache, tidak dihitung ulang
      } else {
        recomputedCount++;
      }
    }

    assert.ok(reusedCount > 0, 'harus ada cell yang dipakai ulang langsung dari cache (reference sama)');
    assert.ok(
      reusedCount > recomputedCount,
      `dengan dirtyBounds sempit di sudut chunk, mayoritas cell (${initialResult.cellCache.size} total) ` +
        `harus dipakai ulang dari cache, bukan dihitung ulang (reused=${reusedCount}, recomputed=${recomputedCount})`
    );
  });

  test('cell yang berubah dari AKTIF menjadi TIDAK AKTIF (mask 0/255) benar-benar hilang dari mesh partial', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = new SDFStorage(CS, CS, CS);
    // Isi solid PENUH kecuali satu lubang kecil di tengah (SDF negatif =
    // solid, positif = udara) -- gampang diprediksi cell mana yang aktif.
    for (let x = 0; x < CS; x++)
      for (let y = 0; y < CS; y++)
        for (let z = 0; z < CS; z++) storage.setSDF(x, y, z, -1.0);
    const hx = CS / 2, hy = CS / 2, hz = CS / 2;
    storage.setSDF(hx, hy, hz, 1.0); // satu voxel jadi udara -> permukaan kecil di sekitarnya

    // PENTING: sediakan getNeighbor yang mengembalikan SOLID (-1.0) juga,
    // konsisten dengan isi chunk ini -- tanpa ini, _getSDF() akan
    // menganggap SEMUA yang di luar chunk sebagai udara (default), membuat
    // seluruh permukaan LUAR chunk (batas solid vs "udara" di luar) ikut
    // jadi geometri -- test ini cuma peduli pada perilaku di sekitar
    // lubang, jadi boundary shell itu perlu dihilangkan dari persamaan.
    const fakeSolidNeighborStorage = { getSDF: () => -1.0 };
    const ctxBase = { chunkCoord: [0, 0, 0], getNeighbor: () => fakeSolidNeighborStorage };

    const initialResult = mesher.generateMesh(storage, ctxBase);
    assert.ok(initialResult.vertexData.length > 0, 'lubang kecil harus menghasilkan beberapa vertex permukaan');

    // Tutup lagi lubangnya (kembali solid penuh) -> seharusnya TIDAK ada
    // permukaan sama sekali di sekitar situ lagi.
    const dirtyBounds = editVoxelAndGetDirtyBounds(storage, hx, hy, hz, -1.0);
    const partialResult = mesher.generateMesh(storage, {
      ...ctxBase,
      dirtyBounds,
      previousCellCache: initialResult.cellCache,
    });

    assert.equal(
      partialResult.vertexData.length,
      0,
      'setelah lubang ditutup, tidak boleh ada vertex tersisa (termasuk dari cache lama yang seharusnya sudah tidak aktif)'
    );
  });

  test('previousCellCache tanpa dirtyBounds (atau sebaliknya) -- fallback ke full rebuild, tidak error', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    const initialResult = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0] });

    // Cuma previousCellCache tanpa dirtyBounds
    const resultA = mesher.generateMesh(storage, {
      chunkCoord: [0, 0, 0],
      previousCellCache: initialResult.cellCache,
    });
    // Cuma dirtyBounds tanpa previousCellCache
    const resultB = mesher.generateMesh(storage, {
      chunkCoord: [0, 0, 0],
      dirtyBounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
    });

    assert.equal(resultA.vertexData.length, initialResult.vertexData.length);
    assert.equal(resultB.vertexData.length, initialResult.vertexData.length);
  });

  test('cellCache tetap valid dipakai ulang meski originChunk berubah antar build (posisi tetap benar)', () => {
    // Cache menyimpan koordinat LOKAL (tanpa offset) -- pastikan offset
    // BARU tetap diterapkan dengan benar ke cell yang di-reuse dari cache.
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk();
    const initialResult = mesher.generateMesh(storage, {
      chunkCoord: [5, 0, 0],
      originChunk: [0, 0, 0],
    });

    const dirtyBounds = editVoxelAndGetDirtyBounds(storage, 1, 1, 1, 5.0);
    const partialResult = mesher.generateMesh(storage, {
      chunkCoord: [5, 0, 0],
      originChunk: [3, 0, 0], // origin baru -- offset chunk 5 relatif ke origin 3 beda dari sebelumnya
      dirtyBounds,
      previousCellCache: initialResult.cellCache,
    });

    const fullResultWithNewOrigin = mesher.generateMesh(storage, {
      chunkCoord: [5, 0, 0],
      originChunk: [3, 0, 0],
    });

    function vertexPositionSet(vertexData) {
      const set = new Set();
      for (let i = 0; i < vertexData.length; i += 9) {
        set.add(`${vertexData[i].toFixed(4)},${vertexData[i + 1].toFixed(4)},${vertexData[i + 2].toFixed(4)}`);
      }
      return set;
    }

    assert.deepEqual(
      [...vertexPositionSet(partialResult.vertexData)].sort(),
      [...vertexPositionSet(fullResultWithNewOrigin.vertexData)].sort(),
      'posisi vertex hasil partial (dengan origin baru) harus sama persis dengan full rebuild di origin baru yang sama'
    );
  });
});

describe('SurfaceNetsMesher — LOD via ctx.cellScale (Roadmap A.6/B.5)', () => {
  test('cellScale=1 (default) menghasilkan output IDENTIK dengan sebelum cellScale ditambahkan (regresi)', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16);

    const withoutCellScale = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0] });
    const withCellScale1 = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 1 });

    assert.deepEqual(Array.from(withCellScale1.vertexData), Array.from(withoutCellScale.vertexData));
    assert.deepEqual(Array.from(withCellScale1.indexData), Array.from(withoutCellScale.indexData));
  });

  test('cellScale=2 menghasilkan JAUH LEBIH SEDIKIT vertex daripada cellScale=1 untuk storage yang sama (bukti penghematan nyata)', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16);

    const fine = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 1 });
    const coarse = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 2 });

    const fineVertexCount = fine.vertexData.length / 9;
    const coarseVertexCount = coarse.vertexData.length / 9;

    assert.ok(coarseVertexCount > 0, 'cellScale=2 tetap harus menghasilkan geometri (sphere tidak boleh hilang total)');
    assert.ok(
      coarseVertexCount < fineVertexCount,
      `cellScale=2 (${coarseVertexCount} vertex) harus lebih sedikit dari cellScale=1 (${fineVertexCount} vertex)`
    );
  });

  test('ukuran fisik (bounding box) geometri SAMA antara cellScale=1 dan cellScale=2 -- LOD tidak boleh mengecilkan/membesarkan chunk', () => {
    // Ini test PALING KRITIS untuk LOD: cellScale cuma boleh mengurangi
    // DETAIL, bukan mengubah ukuran fisik chunk di dunia. Kalau bounding
    // box beda, berarti ada bug scaling posisi vertex.
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16);

    function boundingBox(vertexData) {
      let min = [Infinity, Infinity, Infinity];
      let max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < vertexData.length; i += 9) {
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], vertexData[i + a]);
          max[a] = Math.max(max[a], vertexData[i + a]);
        }
      }
      return { min, max };
    }

    const fine = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 1 });
    const coarse = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 2 });

    const bboxFine = boundingBox(fine.vertexData);
    const bboxCoarse = boundingBox(coarse.vertexData);

    // Toleransi longgar (2 unit -- setengah dari cellScale terbesar yang
    // diuji) karena sampling coarse SECARA INHEREN tidak menangkap detail
    // permukaan setepat fine -- yang penting bounding box TIDAK menyusut/
    // membesar drastis (yang menandakan bug scaling, bukan sekadar
    // perbedaan detail permukaan).
    for (let a = 0; a < 3; a++) {
      assert.ok(
        Math.abs(bboxFine.min[a] - bboxCoarse.min[a]) < 2,
        `sisi min sumbu ${a}: fine=${bboxFine.min[a]}, coarse=${bboxCoarse.min[a]} -- beda terlalu jauh, kemungkinan bug scaling posisi`
      );
      assert.ok(
        Math.abs(bboxFine.max[a] - bboxCoarse.max[a]) < 2,
        `sisi max sumbu ${a}: fine=${bboxFine.max[a]}, coarse=${bboxCoarse.max[a]} -- beda terlalu jauh, kemungkinan bug scaling posisi`
      );
    }
  });

  test('geometri cellScale>1 tetap valid (tidak ada NaN/Infinity) dan offsetX/Y/Z chunk tetap diterapkan dengan benar', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16);

    const result = mesher.generateMesh(storage, { chunkCoord: [3, 0, -2], cellScale: 4 });

    assert.ok(result.vertexData.length > 0);
    let badCount = 0;
    for (let i = 0; i < result.vertexData.length; i++) {
      if (!Number.isFinite(result.vertexData[i])) badCount++;
    }
    assert.equal(badCount, 0, 'tidak boleh ada NaN/Infinity di geometri cellScale>1');

    // Posisi X rata-rata harus di sekitar offsetX + pusat sphere LOKAL
    // (chunkCoord[0]*dims[0] + size/2 = 3*16 + 8 = 56), BUKAN di sekitar
    // offsetX saja (48, yang berarti bagian +size/2 hilang) atau di
    // sekitar 48*cellScale (yang berarti offset ikut ke-scale, bug lain).
    let sumX = 0;
    const vertexCount = result.vertexData.length / 9;
    for (let i = 0; i < result.vertexData.length; i += 9) sumX += result.vertexData[i];
    const avgX = sumX / vertexCount;
    assert.ok(avgX > 48 && avgX < 64, `posisi X rata-rata (${avgX}) harus di sekitar 56 (offset 48 + pusat sphere lokal 8), bukan ter-scale ikut cellScale`);
  });

  test('cellScale yang TIDAK membagi habis dims tidak crash (degradasi anggun, bukan exception)', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16); // 16 tidak habis dibagi 3
    assert.doesNotThrow(() => mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 3 }));
  });

  test('cellScale tidak valid (0, negatif, pecahan, undefined) fallback ke 1 (default aman)', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16);
    const baseline = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0] });

    for (const invalid of [0, -1, 1.5, undefined, null, NaN]) {
      const result = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: invalid });
      assert.deepEqual(
        Array.from(result.vertexData),
        Array.from(baseline.vertexData),
        `cellScale=${invalid} harus fallback ke perilaku cellScale=1 (default aman), bukan crash atau perilaku aneh`
      );
    }
  });

  test('partial remeshing (B.2) otomatis nonaktif untuk cellScale>1 -- tidak crash walau ctx.dirtyBounds/previousCellCache diberikan', () => {
    const mesher = new SurfaceNetsMesher();
    const storage = makeSphereChunk(16);
    const initial = mesher.generateMesh(storage, { chunkCoord: [0, 0, 0], cellScale: 2 });

    // Coba "bujuk" partial remeshing dengan cellScale>1 -- harus DIABAIKAN
    // (canPartial dipaksa false), full rebuild tetap terjadi, tidak crash.
    const attempted = mesher.generateMesh(storage, {
      chunkCoord: [0, 0, 0],
      cellScale: 2,
      dirtyBounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
      previousCellCache: initial.cellCache,
    });

    assert.ok(attempted.vertexData.length > 0);
    // Hasilnya harus SAMA seperti full rebuild biasa (bukan partial yang salah).
    assert.deepEqual(Array.from(attempted.vertexData), Array.from(initial.vertexData));
  });
});
