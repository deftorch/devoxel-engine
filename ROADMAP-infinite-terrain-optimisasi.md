# Devoxel — Roadmap: Infinite Terrain & Optimisasi

Dokumen ini merangkum rencana pengembangan lanjutan setelah perbaikan bug seam
antar-chunk (`fix(engine): tandai chunk tetangga dirty saat edit voxel di
batas chunk`, lihat `git log`). Fokus dokumen ini ada dua yang saling
berkaitan erat: **(A) infinite terrain** dan **(B) optimisasi performa** —
keduanya digabung karena sebagian besar item optimisasi jadi *prasyarat*,
bukan sekadar "nice to have", begitu dunia tidak lagi berukuran tetap.

## Cara Pakai Dokumen Ini

1. Kerjakan **Fase 0** dulu (sudah selesai) sebagai baseline — jangan mulai
   fase lain sebelum ini solid, karena partial remeshing & border stitching
   di fase berikutnya bergantung pada dirty-tracking yang benar.
2. Fase A (infinite terrain) dan Fase B (optimisasi) punya dependensi
   silang — lihat **"Peta Ketergantungan"** di bawah sebelum memilih urutan
   sendiri.
3. Tiap fase punya **Prasyarat**, **Kerjaan**, dan **Acceptance Test** —
   jangan tandai fase selesai kalau acceptance test-nya belum bisa
   dibuktikan (bukan cuma "kelihatan jalan").

---

## Status Saat Ini (Baseline)

- Dunia **berukuran tetap**: `WORLD_CHUNKS × WORLD_CHUNKS` di-generate
  sekaligus di awal (`src/game/main.js`), disimpan di `VoxelEngine.chunks`
  (`Map` tanpa eviction).
- Meshing per-chunk sudah benar untuk seam antar-chunk yang **sudah ada**
  (fix `_dirtyBoundaryNeighbors`), tapi belum diuji untuk skenario chunk
  yang **baru muncul belakangan** (streaming) — lihat Fase A.4.
- Ada worker pool untuk meshing (`AsyncWorkerMesher.js` +
  `mesher.worker.js`), tapi world generation (`noise.js` + SDF fill di
  `chunk.js`) masih jalan di main thread.
- Render loop (`webgpu/engine.js`) menggambar **semua** chunk ter-load
  tiap frame lewat `drawIndexed()` satu-satu — tidak ada frustum culling,
  occlusion culling, atau instancing.
- `VoxelMesher.markChunkDirty()` masih stub kosong — tiap edit voxel =
  full-chunk remesh, bukan partial.
- Storage default belum tentu representasi terkompresi (`FlatGridStorage`
  simpan tiap voxel penuh); `BrickMapStorage`/`SVDAGStorage`/`Tree64Storage`
  sudah ada tapi belum jadi default untuk chunk jauh.

---

## Peta Ketergantungan

```
Fase 0: Seam fix (SELESAI)
        │
        ▼
Fase B.1: Frustum culling ──────────────┐  (independen, kerjakan kapan saja,
        │                               │   dampak langsung terlihat)
        ▼                               │
Fase A.1: Chunk streaming (sync)         │
        │                               │
        ▼                               │
Fase A.4: Border stitching utk streaming │  ← WAJIB sebelum A.2/A.3, karena
        │                               │     chunk baru = neighbor baru
        ▼                               │
Fase A.2: Generation ke worker  ◄────────┘  ← butuh B.3 (transferable) biar
        │                                     tidak nge-block
        ▼
Fase A.5: Origin rebasing (precision)   ← independen, tapi lebih murah
        │                                 dikerjakan sebelum radius chunk besar
        ▼
Fase A.3: Persistensi (save/load chunk edit)
        │
        ▼
Fase B.2: Partial remeshing              ← makin penting begitu A.1 aktif
        │                                   (banyak chunk baru = banyak remesh)
        ▼
Fase B.4: Storage terkompresi utk chunk jauh
        │
        ▼
Fase A.6 / B.5: LOD chunk jauh           ← paling kompleks, kerjakan terakhir,
                                            hanya kalau radius besar terbukti
                                            jadi bottleneck nyata (profil dulu)
```

**Prinsip:** Fase B.1 (frustum culling) berdiri sendiri dan paling murah —
kerjakan duluan berapa pun urutan lainnya. Selebihnya ikuti panah di atas;
melompat urutan (misal A.2 sebelum A.4) akan menghasilkan bug seam yang
mirip dengan yang sudah diperbaiki di Fase 0, tapi lebih sulit dilacak
karena kondisinya asinkron/race condition.

---

# Bagian A — Infinite Terrain

## A.1 — Chunk Streaming Berbasis Posisi Pemain (sinkron dulu) — ✅ SELESAI

**Prasyarat:** Fase 0 (seam fix) selesai.

**Kerjaan:**
- Hitung `(cx, cz)` chunk pemain tiap interval (bukan tiap frame — cukup
  tiap kali pemain pindah chunk, pakai perbandingan `cx,cz` sebelumnya).
- Load chunk dalam radius `viewDistance` (mulai dari radius kecil, mis. 4–6
  chunk, sebelum dibesarkan) memakai `engine.getOrCreateChunk()` yang sudah
  lazy.
- Unload chunk yang keluar radius: hapus dari `engine.chunks`, dispose GPU
  buffer terkait (`Renderable`/`RenderMesh` di ECS), tapi **jangan** hapus
  storage permanen — lihat A.3 untuk kapan harus disimpan dulu.
- Masih boleh generate di main thread di fase ini — tujuannya cuma
  validasi logic radius & unload, bukan performa.

**Acceptance Test:**
- Pemain jalan lurus jauh (>10x radius) tanpa freeze berkepanjangan.
- Memory chunk count (`engine.chunks.size`) stabil di sekitar luas radius,
  tidak terus naik.
- Tidak ada chunk "bocor" tertinggal ter-render padahal sudah di luar
  radius (cek lewat `engine.chunks.size` vs jumlah draw call).

## A.2 — Generation ke Worker Pool — ✅ SELESAI

**Prasyarat:** A.1 selesai dan radius mulai terasa bikin stutter di main
thread saat chunk baru masuk.

**Kerjaan:**
- Duplikasi pola `AsyncWorkerMesher.js` untuk generation: worker menerima
  `(cx, cz, storageType, terrainType)`, menjalankan `generateChunkVoxels()`
  di dalam worker, kirim balik storage data.
- Pastikan payload dikirim balik pakai **Transferable Objects**
  (`postMessage(data, [buffer])`) bukan structured clone penuh — lihat B.3.
- Job queue diprioritaskan berdasar jarak ke pemain (chunk terdekat
  diproses duluan), bukan FIFO — supaya chunk yang langsung terlihat tidak
  antre di belakang chunk yang baru saja masuk radius terluar.

**Acceptance Test:**
- Frame time main thread tidak melonjak signifikan saat >1 chunk baru
  di-generate bersamaan (ukur lewat `performance.now()` sebelum/sesudah
  frame yang memicu load chunk baru).
- Chunk yang paling dekat pemain konsisten muncul lebih dulu daripada
  chunk di tepi radius.

## A.3 — Persistensi Chunk yang Diedit — ✅ SELESAI

**Prasyarat:** A.1 selesai (butuh event unload yang jelas sebagai trigger
save).

**Kerjaan:**
- Tandai chunk yang pernah kena `setVoxel()` (beda dari default generation)
  dengan flag `everEdited` di level chunk, bukan cuma `dirty` (yang
  reset-nya beda konteks — `dirty` untuk remesh, ini untuk persistensi).
- Sebelum unload chunk dengan `everEdited === true`, serialize
  `storage` (typed array/struktur internalnya) ke IndexedDB dengan key
  `world_id:cx,cy,cz`.
- Saat chunk diminta lagi (masuk radius), cek IndexedDB dulu sebelum
  generate dari noise — kalau ada data tersimpan, load itu, skip generation.

**Acceptance Test:**
- Gali blok, jalan keluar radius sampai chunk itu ter-unload, jalan balik
  — hasil galian tetap ada (bukan balik ke terrain asli).
- Reload halaman (kalau world_id persist antar sesi) — chunk yang pernah
  diedit tetap sesuai state terakhir.

## A.4 — Border Stitching untuk Chunk yang Load Asinkron — ✅ SELESAI

**Prasyarat:** A.1 aktif. **Ini bagian paling kritis** — perluasan
langsung dari fix Fase 0.

**Kerjaan:**
- Fix Fase 0 menjamin: edit voxel dekat batas chunk → neighbor yang
  **sudah ada** ikut di-dirty-kan. Tapi di dunia streaming, skenario baru
  muncul: chunk A sudah di-mesh (dengan asumsi neighbor B belum ada →
  padding dianggap kosong/default), lalu **B baru saja di-load**. Mesh A
  yang lama jadi stale terhadap data B yang sekarang nyata ada.
- Solusi: saat chunk baru selesai di-load (baik dari generation atau
  dari IndexedDB di A.3), panggil ulang `_dirtyBoundaryNeighbors()`-style
  check terhadap chunk itu sendiri sebagai "chunk yang baru muncul" — cek
  6+diagonal neighbor yang **sudah ada**, dan tandai dirty semuanya
  (bukan cuma yang barusan di-edit voxel-nya, tapi tiap kali chunk baru
  masuk `engine.chunks`).
- Pertimbangkan: chunk yang baru di-load sebaiknya ditunda mesh-nya kalau
  ada kemungkinan besar neighbor pentingnya akan segera menyusul dalam
  batch load yang sama (mis. beberapa chunk di-load bersamaan saat pemain
  pindah radius) — supaya tidak remesh 2x (sekali saat A load sendirian,
  sekali lagi saat B menyusul).

**Acceptance Test:**
- Reproduksi skrip mirip Fase 0: load chunk A sendirian dulu, mesh, lalu
  load chunk B di sebelahnya belakangan (simulasikan delay). Setelah B
  load, mesh A harus ikut ter-update di seam (bandingkan vertex count
  sebelum/sesudah B muncul).
- Streaming radius besar (>8 chunk) berjalan tanpa flap/robekan yang
  terlihat di boundary manapun, termasuk saat pemain jalan cepat
  (banyak chunk load/unload berurutan).

## A.5 — Origin Rebasing (Precision) — ✅ SELESAI

**Catatan implementasi (update pasca-roadmap ini ditulis):** dievaluasi 2
pendekatan berbeda — "floating-origin per-frame" (origin digeser ke kamera
tiap frame, butuh perubahan pipeline WGSL/bind-group) vs "rebase berkala"
(origin digeser hanya saat pemain melewati `DEFAULT_REBASE_THRESHOLD_CHUNKS`
= 32 chunk, nol perubahan GPU/shader). **Dipilih rebase berkala**, karena
sepenuhnya bisa diverifikasi lewat `node --test` di sandbox tanpa browser,
sementara floating-origin per-frame butuh verifikasi visual GPU sungguhan
yang tidak tersedia. Implementasi: `src/core/world/OriginRebase.js` +
`VoxelEngine.setOriginChunk()`.

Trade-off yang diakui dari pendekatan ini (rebase memicu dirty massal ke
SEMUA chunk loaded) sudah **di-hardening** lewat
`VoxelEngine.remeshDirtyChunks(budget, priorityOrigin)` — spike diserap
bertahap lintas beberapa frame (nearest-first ke posisi pemain), bukan
sekali lonjakan penuh. Lihat commit "Hardening A.5" untuk detail & test.

**Prasyarat:** independen, tapi kerjakan sebelum menguji radius besar di
jarak jauh dari `(0,0,0)`.

**Kerjaan:**
- Simpan posisi dunia sebagai kombinasi `chunkCoord (integer)` +
  `localOffset (float, kecil, dekat 0)`, bukan satu `float` besar.
- Untuk rendering: geser origin kamera ke `(0,0,0)` tiap frame, render
  semua objek relatif terhadap kamera (bukan world-absolute), supaya
  `float32` GPU buffer tidak pernah jauh dari nol.

**Acceptance Test:**
- Pemain jalan ke koordinat >100,000 unit dari origin awal — tidak ada
  jitter/getaran visual pada mesh statis saat kamera diam.

## A.6 — LOD Chunk Jauh (opsional, terakhir) — ⬜ BELUM

**Prasyarat:** A.1–A.5 selesai dan **terbukti lewat profiling** (bukan
asumsi) bahwa vertex count/draw call chunk jauh jadi bottleneck nyata.

**Kerjaan:** lihat detail teknis di B.5 (digabung, karena ini murni
masalah performa, bukan lagi soal "infinite"-nya).

---

# Bagian B — Optimisasi

## B.1 — Frustum Culling & Draw Call *(paling murah, kerjakan duluan)* — ✅ SELESAI

**Prasyarat:** tidak ada — bisa dikerjakan kapan saja, independen dari
Bagian A.

**Kerjaan:**
- Hitung AABB tiap chunk (sudah tahu dari `chunkSize` + `cx,cy,cz`).
- Sebelum loop draw di `webgpu/engine.js`, filter `chunkEids` terhadap
  frustum kamera (6-plane test) — skip `drawIndexed()` untuk chunk yang
  di luar frustum.
- Tandai/skip chunk yang **full-air** (semua voxel kosong) saat generate
  — jangan buat GPU buffer sama sekali untuk chunk seperti ini.
- (Lanjutan, opsional) Occlusion culling kasar: skip chunk yang tertutup
  penuh oleh chunk solid di depannya relatif ke kamera.

**Acceptance Test:**
- FPS meningkat terukur saat kamera menghadap area dengan banyak chunk di
  belakang/luar pandangan (bandingkan sebelum/sesudah, radius sama).
- Chunk kosong tidak menghasilkan draw call sama sekali (cek jumlah
  `drawIndexed()` per frame vs jumlah chunk ter-load).

## B.2 — Partial Remeshing Sungguhan — ✅ SELESAI

**Prasyarat:** Fase 0 selesai (dirty-tracking benar). Makin penting
begitu A.1 aktif (frekuensi remesh naik karena chunk baru terus muncul).

**Kerjaan:**
- Implementasikan `markChunkDirty()` di `VoxelMesher`/`SurfaceNetsMesher`
  agar remesh hanya membangun ulang region yang berubah (mis. per-brick
  kalau storage-nya `BrickMapStorage`), bukan seluruh chunk 16³.
- Debounce: kalau banyak `setVoxel()` terjadi dalam 1 frame (drag-gali
  beruntun), tunda remesh sampai akhir frame — bukan remesh tiap panggilan
  `setVoxel`.
- Pre-alokasi typed array di mesher (estimasi ukuran dari pass pertama)
  alih-alih `push()` ke `Array` biasa lalu convert di akhir.

**Acceptance Test:**
- Edit voxel beruntun (drag gali 20+ voxel dalam 1 frame) menghasilkan
  1 remesh per chunk terdampak, bukan 20.
- Waktu remesh untuk 1 edit kecil di chunk besar terukur lebih cepat
  dibanding full-chunk remesh sebelumnya (profiling before/after).

## B.3 — Worker: Transferable Objects & Prioritas — ✅ SEBAGIAN SELESAI

**Catatan:** sudah terpasang di jalur generation (`generator.worker.js`,
lewat Roadmap A.2) dan jalur greedy-mesh (`mesher.worker.js`, transferable
sudah dipakai untuk arah worker→main). `AsyncWorkerMesher.js` (arah
main→worker) sengaja TIDAK memakai transferable — storage buffer harus
tetap dipegang main thread untuk akses langsung, jadi trade-off ini
disengaja, bukan celah yang terlewat.

**Prasyarat:** tidak ada, tapi jadi prasyarat A.2.

**Kerjaan:**
- Audit `postMessage()` di `mesher.worker.js`/`AsyncWorkerMesher.js` —
  pastikan `ArrayBuffer` dikirim sebagai transferable
  (`postMessage(data, [buffer])`), bukan di-copy penuh.
- Job queue dengan prioritas jarak-ke-pemain (dipakai bareng A.2).

**Acceptance Test:**
- Ukur waktu `postMessage` untuk chunk besar sebelum/sesudah pakai
  transferable — harus mendekati instan (bukan proporsional ke ukuran
  data).

## B.4 — Storage Terkompresi untuk Chunk Jauh — ⬜ BELUM

**Prasyarat:** A.6/B.5 (LOD) mulai relevan, atau memory jadi masalah
nyata di A.1 dengan radius besar.

**Kerjaan:**
- Chunk dekat pemain: storage penuh (`SDFStorage`/`FlatGridStorage`) untuk
  presisi edit.
- Chunk jauh (dekat batas radius, kemungkinan besar tidak akan diedit
  dalam waktu dekat): downgrade ke `BrickMapStorage`/`SVDAGStorage`/
  `Tree64Storage` yang sudah ada di codebase — tinggal pilih lewat
  `PluginRegistry`, bukan bikin baru.
- Quantize vertex (posisi/normal `Int16` alih-alih `Float32`) untuk
  kurangi ukuran GPU buffer per chunk jauh.

**Acceptance Test:**
- Memory per chunk jauh terukur turun signifikan dibanding storage penuh,
  tanpa perbedaan visual yang terlihat pada jarak render itu.

## B.5 — LOD untuk Chunk Jauh — ⬜ BELUM

**Prasyarat:** semua di atas selesai **dan** profiling membuktikan ini
memang bottleneck (jangan desain di awal berdasar asumsi).

**Kerjaan:**
- Downsample SDF 2x/4x untuk chunk di level jauh sebelum di-surface-nets.
- Skema transisi antar level (transvoxel-style stitching atau skirt
  geometry) supaya tidak ada gap visual di batas LOD.
- Surface Nets relatif LOD-friendly dibanding Marching Cubes murni —
  manfaatkan itu, jangan re-desain algoritma dari nol.

**Acceptance Test:**
- Radius render bisa diperbesar 2x tanpa penurunan FPS proporsional
  (vertex count total tidak naik linear terhadap radius).
- Tidak ada gap/seam terlihat di batas transisi LOD manapun.

---

## Prinsip Non-Negosiasi

- **Jangan lompat ke A.2/A.6/B.5 sebelum prasyaratnya settle dan
  acceptance test-nya lolos** — item-item ini paling gampang menyembunyikan
  bug yang "kelihatan jalan" (chunk kelihatan ter-load tapi datanya stale,
  atau FPS naik tapi cuma karena occlusion salah skip chunk yang
  seharusnya kelihatan).
- **Fase B.1 (frustum culling) dan B.3 (transferable objects) boleh
  dikerjakan kapan saja** di antara fase lain — keduanya independen dan
  berdampak langsung terlihat/terukur, cocok jadi "quick win" di sela
  fase yang lebih besar.
- **Semua acceptance test harus diverifikasi dengan pengukuran nyata**
  (profiling, vertex count, chunk count) — bukan sekadar "terlihat lancar
  di layar", mengikuti prinsip yang sama dengan fix seam di Fase 0
  (dibuktikan lewat skrip reproduksi, bukan cuma screenshot).
