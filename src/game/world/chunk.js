import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from '../../core/config.js';
import { BLOCK_IDS } from '../../data/blocks.js';
import { heightAt, heightRaw, fbm3D } from './noise.js';
import { FlatGridStorage } from '../../core/voxel/FlatGridStorage.js';
import { OctreeStorage } from '../../core/voxel/OctreeStorage.js';
import { BrickMapStorage } from '../../core/voxel/BrickMapStorage.js';
import { SVDAGStorage } from '../../core/voxel/SVDAGStorage.js';
import { Tree64Storage } from '../../core/voxel/Tree64Storage.js';
import { SDFStorage } from '../../core/voxel/SDFStorage.js';
import { QuantizedSDFStorage } from '../../core/voxel/QuantizedSDFStorage.js';

export function generateChunkVoxels(chunkX, chunkZ, storageType = 'flat', terrainType = 'normal') {
  let storage;
  if (storageType === 'octree') storage = new OctreeStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else if (storageType === 'brickmap') storage = new BrickMapStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else if (storageType === 'svdag') storage = new SVDAGStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else if (storageType === 'tree64') storage = new Tree64Storage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else if (storageType === 'sdf') storage = new SDFStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  // Roadmap B.4 -- storage SDF terkompresi (Int16, setengah memori) untuk
  // chunk jauh di jalur streaming. Interface identik dengan 'sdf' (lihat
  // QuantizedSDFStorage.js), jadi generation di bawah TIDAK perlu tahu
  // bedanya -- itu sebabnya cek `storageType === 'sdf'` di bawah diperluas
  // jadi `isSDFLike` alih-alih ditambah cabang if/else baru untuk tiap
  // varian SDF.
  else if (storageType === 'sdf-compact') storage = new QuantizedSDFStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else storage = new FlatGridStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);

  const isSDFLike = storageType === 'sdf' || storageType === 'sdf-compact';

  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      const wx = chunkX * CHUNK_SX + x;
      const wz = chunkZ * CHUNK_SZ + z;

      if (isSDFLike && terrainType === 'normal') {
        const h = heightRaw(wx, wz);
        for (let y = 0; y < CHUNK_SY; y++) {
          // SDF base: jarak dari ketinggian permukaan. <0 artinya di dalam tanah.
          let dist = y - h;

          // Seberapa jauh voxel ini dari permukaan (0 = tepat di permukaan,
          // makin besar makin jauh -- baik di bawah maupun di atas h, supaya
          // overhang juga tertangani). Noise gua HANYA diaktifkan setelah
          // jarak tertentu, dan di-fade in secara bertahap -- bukan on/off
          // tiba-tiba -- supaya tidak ada celah tipis tepat di kulit
          // permukaan yang bikin terrain terlihat "robek".
          const distFromSurface = Math.abs(y - h);
          const CAVE_START_DEPTH = 3.0; // mulai fade in noise gua
          const CAVE_FULL_DEPTH = 6.0; // noise gua full strength

          const caveFadeLinear = Math.max(
            0,
            Math.min(1, (distFromSurface - CAVE_START_DEPTH) / (CAVE_FULL_DEPTH - CAVE_START_DEPTH))
          );
          // Smoothstep supaya transisi lebih halus daripada fade linear.
          const caveFade = caveFadeLinear * caveFadeLinear * (3 - 2 * caveFadeLinear);

          if (caveFade > 0) {
            // FBM 3D (multi-oktaf) supaya bentuk gua/overhang organik,
            // bukan pita-pita tajam acak seperti noise 1-oktaf.
            const noise = fbm3D(wx * 0.08, y * 0.08, wz * 0.08, 3) * 8.0 - 4.0;
            dist += noise * caveFade;
          }

          storage.setSDF(x, y, z, dist);
        }
      } else if (terrainType === 'normal') {
        const h = heightAt(wx, wz, CHUNK_SY);
        for (let y = 0; y < CHUNK_SY; y++) {
          let b = BLOCK_IDS.AIR;
          if (y < h) b = y > h - 4 ? BLOCK_IDS.DIRT : BLOCK_IDS.STONE;
          else if (y === h) b = BLOCK_IDS.GRASS;
          storage.set(x, y, z, b);
        }
      } else if (terrainType === 'checkerboard') {
        for (let y = 0; y < CHUNK_SY; y++) {
          // Pola selang-seling (mimpi buruk untuk Octree, mudah untuk Flat Grid)
          const b = (x + y + z) % 2 === 0 ? BLOCK_IDS.STONE : BLOCK_IDS.AIR;
          storage.set(x, y, z, b);
        }
      } else if (terrainType === 'homogeneous') {
        for (let y = 0; y < CHUNK_SY; y++) {
          // Solid rata setengah bawah (sangat optimal untuk Octree)
          storage.set(x, y, z, y < 20 ? BLOCK_IDS.STONE : BLOCK_IDS.AIR);
        }
      } else if (terrainType === 'gi-box') {
        // Kotak tertutup solid dengan 1 lubang 2x2 di langit-langit (y=CHUNK_SY-1)
        // untuk uji cahaya masuk & menyebar ke dinding yang tidak line-of-sight ke lubang.
        for (let y = 0; y < CHUNK_SY; y++) {
          const isShell =
            x === 0 || x === CHUNK_SX - 1 || z === 0 || z === CHUNK_SZ - 1 || y === 0 || y === CHUNK_SY - 1;
          const isHole = y === CHUNK_SY - 1 && x >= 7 && x <= 8 && z >= 7 && z <= 8;
          storage.set(x, y, z, isShell && !isHole ? BLOCK_IDS.STONE : BLOCK_IDS.AIR);
        }
      } else if (terrainType === 'gi-lshape') {
        // Terowongan L: lorong lurus dari (0,y,8) belok 90 derajat ke (8,y,15).
        // Titik di ujung lorong kedua TIDAK punya line-of-sight ke sumber cahaya
        // manapun kecuali lewat bounce. Lubang cahaya (2x2, langit-langit) ada di
        // dekat mulut lorong pertama, bukan di ujung lorong kedua — jadi ujung
        // lorong kedua hanya bisa terang lewat pantulan (bounce) di tikungan.
        const corridorYMin = 1,
          corridorYMax = 3; // tinggi lorong: y=1..3
        const holeXMin = 1,
          holeXMax = 2; // lubang cahaya 2x2 di langit-langit
        const holeZMin = 8,
          holeZMax = 9;
        for (let y = 0; y < CHUNK_SY; y++) {
          let b = BLOCK_IDS.STONE; // default: blok padat di sekeliling lorong
          const inCorridorHeight = y >= corridorYMin && y <= corridorYMax;
          // Segmen 1: lurus sepanjang sumbu X, di z=8..9, dari x=0 sampai x=8
          const inSegmentA = inCorridorHeight && z >= 8 && z <= 9 && x >= 0 && x <= 8;
          // Segmen 2: belok 90 derajat, lurus sepanjang sumbu Z, di x=8..9, dari z=8 sampai z=15
          const inSegmentB = inCorridorHeight && x >= 8 && x <= 9 && z >= 8 && z <= 15;
          const isHole = y === CHUNK_SY - 1 && x >= holeXMin && x <= holeXMax && z >= holeZMin && z <= holeZMax;
          if (inSegmentA || inSegmentB || isHole) b = BLOCK_IDS.AIR;
          storage.set(x, y, z, b);
        }
      } else if (terrainType === 'gi-colorwall') {
        // Dua dinding solid berhadapan jarak 3 voxel, satu merah (BRICK_RED),
        // satunya putih/salju (SNOW). Untuk uji color bleeding di Fase 2.
        // Dinding di x=6 (merah) dan x=10 (salju), celah udara x=7..9 di antaranya.
        for (let y = 0; y < CHUNK_SY; y++) {
          let b = BLOCK_IDS.AIR;
          if (y === 0) {
            b = BLOCK_IDS.STONE; // lantai
          } else if (y >= 1 && y <= 6) {
            if (x === 6) b = BLOCK_IDS.BRICK_RED;
            else if (x === 10) b = BLOCK_IDS.SNOW;
          }
          storage.set(x, y, z, b);
        }
      }
    }
  }

  // Tidak perlu memanggil buildSDF karena SDF sudah diisi secara native oleh setSDF.
  // if (typeof storage.buildSDF === 'function') {
  //   storage.buildSDF();
  // }

  // Safety net: smoothing pass ringan pada SDF untuk menutup sliver/celah
  // setipis 1 voxel yang mungkin lolos dari tuning noise di atas (lihat
  // §2.3 rencana perbaikan robekan terrain). 1 pass, blend ringan supaya
  // detail terrain asli tidak ikut hilang.
  if (isSDFLike && terrainType === 'normal' && typeof storage.smoothSDF === 'function') {
    storage.smoothSDF(0.15);
  }

  return storage;
}
