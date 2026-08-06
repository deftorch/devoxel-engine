# Devoxel — Rincian Instruksi Langkah Selanjutnya

Dokumen ini berisi instruksi rinci untuk 4 langkah lanjutan setelah restructure
`src/core` menjadi Universal Voxel Framework. Kerjakan sesuai urutan prioritas,
atau pilih salah satu sesuai kebutuhan — masing-masing independen.

Lihat juga bagian **"0. Evaluasi Fondasi vs `docs/Voxel - berbagai pendekatan.md`"**
di bawah — ini analisis apakah kontrak `VoxelStorage`/`VoxelMesher`/`VoxelRenderer`
saat ini aman dikembangkan ke pendekatan-pendekatan yang dibahas di dokumen itu.

---

## 0. Evaluasi Fondasi vs `docs/Voxel - berbagai pendekatan.md`

**Tujuan:** memastikan kontrak plugin (`VoxelStorage`, `VoxelMesher`,
`VoxelRenderer`) tidak menutup pintu ke pendekatan-pendekatan yang dibahas di
`docs/Voxel - berbagai pendekatan.md`, tanpa over-engineering fitur yang belum
dibutuhkan.

### Sudah aman (terbukti, bukan asumsi)

- **Storage baru** — kontrak `get(x,y,z)/set(x,y,z,val)/dims` cocok untuk
  semua item di tabel struktur data dokumen (flat grid, octree, brickmap,
  SVDAG, 64-tree, SDF). Tambah storage baru = bikin class + daftar ke
  `PluginRegistry`, tidak perlu sentuh `VoxelEngine`.
- **Renderer baru** — `VoxelRenderer` + `VoxelRendererAdapter` sudah cukup
  fleksibel karena expose semua method mentah backend-nya, termasuk gaya
  "GPU raymarching penuh tanpa mesh" (VoxelRT/Octo, disebut di dokumen)
  karena `createMesh()` memang opsional dipanggil.
- **Ganti kombinasi storage/mesher/renderer** — sudah dibuktikan lewat smoke
  test manual, cukup ganti string id di config.

### Titik rawan — akan jadi hambatan begitu maju ke bagian lanjutan dokumen

1. **Mesher tidak punya akses ke chunk tetangga.** `generateMesh(chunkStorage)`
   cuma terima 1 chunk. Dokumen (bagian "Konsekuensi edit voxel: dirty chunk +
   re-mesh + border stitching") menjelaskan greedy mesher (dan smooth mesher
   apapun) butuh baca voxel chunk sebelah untuk border stitching — kalau
   tidak, begitu dunia jadi multi-chunk, permukaan di perbatasan akan
   bolong/dobel.
2. **`storage.get()` cuma balikin 1 integer.** Cukup untuk occupancy/palette
   (level Teardown di dokumen), tapi tidak cukup untuk density/SDF kontinu
   atau multi-atribut (warna+suhu+kepadatan sekaligus, disebut di bagian
   "Cara Merepresentasikan Isi Voxel"). `SDFStorage` kita sudah punya
   `getSDF()` tapi itu belum jadi bagian resmi kontrak `VoxelStorage`.
3. **AO sebagai constraint ke greedy meshing** — dokumen menjelaskan AO
   berinteraksi langsung dengan greedy meshing (cuma facet dengan nilai AO
   sama boleh digabung), tapi kontrak `generateMesh()` sekarang tidak punya
   tempat resmi untuk opsi semacam ini.
4. **`markChunkDirty(x,y,z)` di `VoxelMesher` masih stub kosong** — partial
   remeshing belum benar-benar ada, tiap edit = full chunk remesh. Aman
   untuk sekarang, tapi jadi mahal begitu dunia scaling (lihat bagian
   "Chunk dirty-flagging" di dokumen).
5. **LOD-per-algoritma dan hybrid mesh+voxel** (dibahas di bagian "Optimisasi
   LOD" dan "Pola A/B: prop mesh vs voxelisasi penuh") — di luar tanggung
   jawab `VoxelEngine`/`VoxelStorage` saat ini. `VoxelEngine` mengasumsikan
   1 mesher + 1 storage type + ukuran chunk seragam untuk seluruh dunia.

### Strategi — buka pintu murah sekarang, tunda sisanya

**Kerjakan sekarang (low-risk, backward compatible):**

Tambah parameter opsional kedua ke `generateMesh`:

```js
// VoxelMesher.js (base class)
generateMesh(chunkStorage, ctx) {
  // ctx = { getNeighbor(dx, dy, dz) => VoxelStorage|null, chunkCoord: [cx, cy, cz] }
  throw new Error(...);
}
```

```js
// VoxelEngine.remeshChunk(cx, cy, cz)
const ctx = {
  chunkCoord: [cx, cy, cz],
  getNeighbor: (dx, dy, dz) => this.getChunk(cx + dx, cy + dy, cz + dz)?.storage ?? null,
};
const meshData = this.mesherPlugin.generateMesh(chunk.storage, ctx);
```

Karena `ctx` adalah parameter opsional, `GreedyMesher` yang belum
memanfaatkannya tetap jalan tanpa perubahan apa pun — ini langsung membuka
jalan untuk poin #1 dan #3 di atas tanpa redesign kontrak.

**Tunda dulu (baru relevan kalau benar-benar dibutuhkan):**

- Density/multi-atribut sebagai bagian resmi kontrak `VoxelStorage` — cukup
  perlakukan sebagai _extended contract_ opsional (mesher smooth-terrain
  mendeteksi `typeof storage.getSDF === 'function'`), jangan paksa semua
  storage mengimplementasikannya.
- LOD-per-algoritma (banyak mesher aktif sekaligus tergantung jarak) dan
  hybrid mesh+voxel (Pola A: prop mesh menumpang lewat ECS) — keduanya lebih
  masuk akal dikerjakan di layer `game/` (ECS), bukan di `core/`, dan baru
  relevan setelah ada kebutuhan nyata (dunia multi-chunk, prop non-voxel).
- Partial remeshing (`markChunkDirty` sungguhan) — implementasikan kalau
  performa edit sudah terbukti jadi bottleneck, bukan sekarang.

**Kesimpulan:** fondasi (`PluginRegistry` + kontrak generik) aman untuk terus
dikembangkan — buktinya sudah menampung 6 varian storage berbeda tanpa
masalah. Satu-satunya perubahan yang disarankan segera adalah menambah `ctx`
opsional ke `generateMesh()`, karena murah dan mencegah technical debt di
border stitching begitu dunia jadi multi-chunk.

---

## 1. Migrasi `src/game/main.js` ke `VoxelEngine`

**Tujuan:** dunia game berjalan 100% lewat `VoxelEngine` + `PluginRegistry`,
bukan lewat `createRenderer()` mentah dan `ChunkMesherPool`/`chunk.js` manual.

**Langkah:**

1. Baca ulang `src/game/world/chunk.js` dan `src/game/world/ChunkMesherPool.js`
   — catat semua tempat yang langsung memanipulasi storage voxel per chunk
   (biasanya array/typed array manual, bukan lewat `VoxelStorage.get/set`).
2. Di `main.js`, ganti inisialisasi renderer:
   ```js
   // SEBELUM
   renderer = await createRenderer(ui.canvas, currentRenderMode);

   // SESUDAH
   import { VoxelEngine } from '../core/index.js';
   const engine = new VoxelEngine({
     chunkSize: [CHUNK_SX, CHUNK_SY, CHUNK_SZ],
     storage: 'brickmap', // atau storage aktif saat ini
     mesher: 'greedy',
     renderer: currentRenderMode === 'raytrace' ? 'raytrace' : 'webgpu',
   });
   await engine.start(ui.canvas);
   renderer = engine.rendererPlugin; // API lama (draw/getVoxel/editVoxel) tetap ada
   ```
3. Ganti semua `renderer.getVoxel(...)` / `renderer.editVoxel(...)` yang
   memanipulasi voxel dunia menjadi `engine.getVoxel(...)` / `engine.setVoxel(...)`.
   Ini penting supaya dirty-chunk tracking & event hooks (`beforeVoxelEdit`,
   `afterVoxelEdit`) benar-benar terpakai.
4. Ganti logic remesh manual (di `ChunkMesherPool`/worker) supaya memanggil
   `engine.remeshChunk(cx, cy, cz)` atau `engine.remeshDirtyChunks()` alih-alih
   mengelola state dirty sendiri. Kalau meshing tetap ingin jalan di Web
   Worker demi performa, biarkan worker menghasilkan `vertexData/indexData`
   lalu simpan hasilnya ke `chunk.mesh` lewat event `afterMesh`.
5. Ganti pemanggilan `renderer.draw(cameraState, chunkEids, Renderable, RenderMesh)`
   di render loop — ini tetap boleh dipanggil manual per frame (raster
   backend memang didesain begitu), cukup pastikan sumber data mesh-nya
   sekarang berasal dari `engine.chunks` bukan ECS array terpisah.
6. Hapus import `createRenderer` yang sudah tidak dipakai, jalankan game di
   browser, dan verifikasi: render awal, edit voxel (place/break block),
   ganti render mode (raster ↔ raytrace) semua masih berfungsi.
7. Hapus/relokasi `WORLD_CHUNKS`, `CHUNK_SX/SY/SZ` dari `config.js` kalau
   sudah sepenuhnya digantikan oleh `engine.chunkSize`.

**Risiko:** render loop & ECS system (`components.js`, `systems.js`) mungkin
menyimpan referensi mesh terpisah dari `engine.chunks` — pastikan single
source of truth setelah migrasi, jangan sampai ada dua tempat yang sama-sama
"memiliki" data mesh.

---

## 2. Setup `package.json` untuk publish `src/core` sebagai library

**Tujuan:** `src/core` bisa di-`npm install` independen dari `src/game`,
supaya proyek lain bisa pakai Devoxel sebagai dependency.

**Langkah:**

1. Buat folder `packages/devoxel-core/` (atau gunakan npm workspaces di root
   kalau mau tetap monorepo).
2. Pindahkan isi `src/core/*` ke `packages/devoxel-core/src/`.
3. Buat `packages/devoxel-core/package.json`:
   ```json
   {
     "name": "@devoxel/core",
     "version": "0.1.0",
     "type": "module",
     "main": "src/index.js",
     "exports": { ".": "./src/index.js" },
     "files": ["src"],
     "keywords": ["voxel", "engine", "webgpu", "webgl", "framework"],
     "license": "MIT"
   }
   ```
4. Di root, buat `package.json` dengan `"workspaces": ["packages/*"]` kalau
   pakai npm/yarn/pnpm workspaces, supaya `src/game` bisa `import` dari
   `@devoxel/core` tanpa publish beneran ke registry saat development.
5. Update semua import di `src/game/*` dari path relatif (`../core/...`)
   menjadi `@devoxel/core` (atau `@devoxel/core/renderer`, dst. kalau mau
   sub-path exports granular).
6. Tambahkan `.npmignore` / field `files` supaya cuma `src/` yang ke-publish
   (bukan test, contoh config, dsb).
7. Tulis `packages/devoxel-core/README.md` khusus (bisa reuse README utama
   bagian "Pluggable System").
8. Tes lokal: `npm pack` di folder core, install hasil tarball-nya di project
   terpisah, pastikan `import { VoxelEngine } from '@devoxel/core'` jalan.
9. (Opsional) Setup CI buat `npm publish` otomatis saat tag versi baru.

**Catatan:** WebGL/WebGPU code (`renderer/webgl`, `renderer/webgpu`) hanya
jalan di browser — dokumentasikan itu jelas di README supaya konsumen
library tidak coba pakai di Node.js tanpa polyfill.

---

## 3. Unit test untuk `PluginRegistry` & `VoxelEngine`

**Tujuan:** pastikan sistem pluggable tidak regresi diam-diam saat ada
perubahan di masa depan.

**Langkah:**

1. Pilih test runner ringan tanpa build step berat — karena project ini
   pure ESM browser-style, `node --test` (built-in Node.js) sudah cukup,
   tidak perlu Jest/Vitest kecuali sudah ada di project.
2. Buat `src/test/PluginRegistry.test.js`:
   - `registerStorage` + `createStorage` mengembalikan instance yang benar
   - `createStorage` dengan id tidak terdaftar → throw error dengan pesan
     yang menyebutkan id yang tersedia
   - overwrite plugin dengan id sama → console.warn terpanggil (pakai
     `mock.method` dari `node:test`)
3. Buat `src/test/VoxelEngine.test.js`:
   - `setVoxel` lalu `getVoxel` mengembalikan nilai yang sama
   - `setVoxel` di luar chunk yang belum ada → otomatis membuat chunk baru
     (assert `engine.chunks.size` bertambah)
   - `setVoxel` menandai chunk `dirty = true`; `remeshChunk` mengembalikan
     `dirty = false` dan `mesh` terisi
   - `remeshDirtyChunks()` cuma me-rebuild chunk yang dirty, bukan semua
   - event hooks (`beforeVoxelEdit`, `afterVoxelEdit`, `chunkCreated`,
     `beforeMesh`, `afterMesh`) terpanggil dengan payload yang benar —
     pakai callback yang push ke array lalu assert isinya
   - `worldToChunkCoords` menghasilkan koordinat lokal & chunk yang benar
     untuk kasus koordinat negatif (edge case yang sering salah di voxel
     engine manapun)
4. Untuk storage backend individual (Octree, SVDAG, Tree64, BrickMap, SDF),
   buat 1 file test generik yang di-loop untuk semua backend — karena semua
   implement kontrak `VoxelStorage` yang sama, cukup satu suite:
   ```js
   for (const id of ['flatgrid', 'octree', 'svdag', 'tree64', 'brickmap', 'sdf']) {
     test(`${id}: set/get roundtrip`, () => {
       /* ... */
     });
   }
   ```
5. Tambahkan script di `package.json`: `"test": "node --test src/test/"`.
6. (Opsional) tambahkan ke CI (GitHub Actions) supaya jalan otomatis tiap PR.

**Catatan:** renderer plugin (WebGL/WebGPU) butuh browser API — jangan
dipaksa unit test di Node.js. Cukup test kontraknya secara struktural
(instance punya method `init`/`render`/`createMesh`) tanpa benar-benar
memanggilnya, atau skip dan andalkan manual/browser test untuk itu.

---

## 4. Cek & benerin `editor.js`

**Tujuan:** pastikan Voxel Editor standalone tetap kompatibel dengan
struktur baru (rename `MesherPlugin`→`VoxelMesher`, dll, dan `compute_rt.js`→
`raytrace.js`).

**Langkah:**

1. `grep -n "MesherPlugin\|RendererPlugin\|compute_rt\|core/renderer/index\|core/mesher/" src/editor/editor.js`
   — cari semua import yang mungkin masih pakai nama/path lama.
2. Kalau editor juga import `createRenderer` langsung (pola sama seperti
   `main.js` sebelum migrasi), putuskan: mau ikut dimigrasi ke `VoxelEngine`
   juga, atau biarkan pakai API lama (tetap didukung lewat
   `VoxelRendererAdapter`).
3. Jalankan editor di browser (`editor.html`), coba semua fitur inti: load
   canvas, render awal, place/break voxel, switch render mode kalau ada.
4. Kalau editor pakai `config.js` (`CHUNK_SX/SY/SZ`, `WORLD_CHUNKS`) untuk
   ukuran dunia editor-nya sendiri (biasanya beda dari game), pastikan itu
   tidak ikut kena rename yang mengasumsikan `engine.chunkSize` dari game.
5. Perbaiki error yang muncul satu per satu, lalu commit terpisah dari
   task lain supaya gampang di-rollback kalau ada regresi editor.

---

## Rekomendasi Urutan Eksekusi

1. **#0 dulu** (tambah `ctx` opsional ke `generateMesh`) — sangat murah,
   backward compatible, dan mencegah technical debt sebelum kode lain
   dibangun di atas kontrak mesher yang sekarang.
2. **#4** (cek editor) — cepat, low-risk, memastikan tidak ada yang
   diam-diam rusak dari rename sebelumnya.
3. **#3** (unit test) — bikin jaring pengaman sebelum melakukan perubahan
   besar berikutnya (migrasi main.js). Sertakan test untuk `ctx.getNeighbor`
   dari #0 begitu diimplementasikan.
4. **#1** (migrasi main.js) — perubahan paling berisiko, tapi paling
   bernilai untuk membuktikan framework-nya benar-benar dipakai "for real".
5. **#2** (package.json/publish) — paling masuk akal dilakukan terakhir,
   setelah API-nya stabil dan sudah dites lewat langkah 0–4.
