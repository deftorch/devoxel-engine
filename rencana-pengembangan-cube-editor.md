# Rencana Pengembangan: Devoxel Cube Editor

**Tujuan utama:** menghilangkan ketergantungan langsung `editor.js` terhadap API GPU low-level (WebGPU `device`), sekaligus merestrukturisasi `editor.js` agar siap menampung fitur editor yang lebih kompleks di masa depan.

**Prinsip kerja:** setiap fase harus meninggalkan aplikasi dalam keadaan _tetap bisa dijalankan_ (tidak ada fase yang memecah build/runtime di tengah jalan). Urutan fase disusun agar risiko tinggi diselesaikan lebih dulu.

---

## Fase 0 — Baseline & Safety Net

Sebelum menyentuh arsitektur apa pun.

- [ ] Tambahkan smoke test manual/otomatis minimal: buka editor, tambah cube, pilih objek, geser gizmo, undo/redo, export JSON — pastikan semua berjalan di baseline saat ini (WebGPU only).
- [ ] Catat/screenshot perilaku visual saat ini (warna grid, outline, gizmo) sebagai referensi pembanding visual setelah refactor.
- [ ] Pastikan `npm run test` (VoxelEngine, PluginRegistry) tetap hijau sepanjang proses — jangan sampai regresi di core lolos tanpa disadari.

---

## Fase 1 — Deteksi & Inisialisasi Renderer yang Aman

**Tujuan:** editor bisa boot dengan WebGPU maupun WebGL tanpa crash, sebelum fitur grid/outline/gizmo ikut dibenahi.

- [x] Modifikasi `main()` di `editor.js`: coba `new VoxelEngine({ ..., renderer: 'webgpu' })`, jika gagal (`catch`), retry dengan `renderer: 'webgl'`.
- [x] Tambahkan flag `const isWebGPU = engineRef.rendererPlugin.name === 'webgpu';` yang bisa dipakai bagian lain kode.
- [x] Update `setStatus(...)` agar pesan loading mencerminkan backend yang benar-benar terpakai (bukan selalu "Menginisialisasi GPU…" generik).
- [x] **Checkpoint:** di browser tanpa WebGPU (atau dengan `navigator.gpu` di-disable manual), editor harus tetap boot dan menampilkan chunk mesh (tanpa grid/outline/gizmo dulu — itu urusan fase berikutnya, biarkan sementara error/ke-skip dengan aman).

---

## Fase 2 — Abstraksi "Debug/Immediate Draw" di Level Renderer Plugin _(inti dari refactor ini)_

**Tujuan:** ini yang menyelesaikan akar masalah, bukan cuma menambal WebGL. Grid, outline, dan gizmo naik status dari "kode ad-hoc di editor" menjadi bagian resmi dari kontrak `VoxelRenderer`.

- [x] Tambahkan method baru di `VoxelRenderer` (base class): `drawDebugPrimitives(cameraState, { lines, tris })` — kontrak seragam untuk kedua backend.
- [x] **`webgpu/engine.js`**: refactor `LINE_SHADER`, pipeline garis, pipeline gizmo (line + tri) yang saat ini hidup di `editor.js` → pindahkan ke sini, dibungkus di belakang `drawDebugPrimitives()`. Tetap pakai `onPostDraw(pass)` di dalam pass yang sama seperti sekarang.
- [x] **`webgl/engine.js`**:
  - Tulis vertex/fragment shader GLSL versi garis (port langsung dari `LINE_SHADER` WGSL — logikanya sederhana, tinggal `position * uViewProj` + passthrough warna).
  - Buat VAO/VBO khusus untuk data garis dan data triangle gizmo (terpisah dari VAO mesh voxel utama).
  - Implementasikan `gl.LINES` untuk grid+outline+gizmo-line, dan `gl.TRIANGLES` untuk gizmo arrow-head.
  - **Kelola state eksplisit** (poin kritis karena WebGL adalah state machine, bukan per-pass seperti WebGPU):
    - Grid & outline: depth test aktif, `depthFunc(LESS)` (default, tidak perlu diubah).
    - Gizmo: `gl.disable(DEPTH_TEST)` (atau `depthFunc(ALWAYS)`) + `gl.disable(CULL_FACE)` saat digambar, lalu **wajib** `gl.enable(DEPTH_TEST)` + `gl.enable(CULL_FACE)` sebelum frame berikutnya, supaya tidak bocor ke render chunk voxel.
- [x] Expose `gl` (dan `canvas` bila perlu) di return object `initWebGL()` — otomatis ter-expose lewat `VoxelRendererAdapter` tanpa perubahan tambahan di adapter.
- [x] **Checkpoint:** grid, outline seleksi, dan gizmo translate tampil identik secara visual di WebGPU (regresi = 0) dan mulai berfungsi di WebGL.

---

## Fase 3 — Bersihkan `editor.js` dari Akses GPU Langsung

**Tujuan:** setelah Fase 2 selesai, `editor.js` seharusnya tidak punya baris `device.create...` atau `gl.` sama sekali.

- [x] Ganti seluruh blok pipeline/shader/buffer manual di `main()` (baris ~1200-1300 saat ini) dengan pemanggilan `engineRef.rendererPlugin.drawDebugPrimitives(cameraState, { lines: [...], tris: [...] })`.
- [x] Hapus `deviceRef`, akses `renderer.device` langsung, dan `LINE_SHADER` (WGSL) dari `editor.js` — semuanya sudah pindah ke Fase 2.
- [x] Update `rebuildMesh(eid)` (baris ~396, saat ini pakai `if (deviceRef) rebuildMesh(eid)`) agar tidak lagi bergantung pada `deviceRef` sebagai penanda "renderer siap" — pakai flag generik (`engineRef.rendererPlugin.ready`).
- [x] **Checkpoint:** cari `grep -n "device\.\|gl\." src/editor/editor.js` → hasilnya harus kosong.

---

## Fase 4 — Restrukturisasi `editor.js` Jadi Modul

**Tujuan:** dari 1 file 1300+ baris (13 tanggung jawab) menjadi modul-modul kecil yang fokus, mengikuti batas yang sudah tersirat dari komentar section yang ada sekarang.

| Modul baru                | Isi (dipindah dari section `editor.js` saat ini)                                            |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `editor/state.js`         | ECS world, `Transform`/`ColorComp`/`NodeMeta`/`NameComp`, `sceneOrder`, `selectedEid`       |
| `editor/history.js`       | Undo/redo command pattern                                                                   |
| `editor/scene-ops.js`     | Semua mutasi scene (add/remove/transform cube, dll — "lewat sini supaya History konsisten") |
| `editor/geometry.js`      | Cube mesh builder, grid lines, outline builder, gizmo geometry                              |
| `editor/ui/outliner.js`   | Panel outliner                                                                              |
| `editor/ui/properties.js` | Panel properti objek                                                                        |
| `editor/camera-input.js`  | Kamera orbit + input handling + gizmo drag                                                  |
| `editor/picking.js`       | Raycast/OBB picking                                                                         |
| `editor/io.js`            | Export/import JSON                                                                          |
| `editor/main.js`          | Wiring antar modul + render loop (jauh lebih ramping)                                       |

- [x] Pindahkan section demi section (bukan sekaligus) — setiap pemindahan 1 modul, jalankan aplikasi, pastikan tidak ada regresi, baru lanjut ke modul berikutnya.
- [x] Ganti variabel module-scope global (`deviceRef`, `engineRef`, `camera`, dst) dengan satu objek `EditorContext`/`EditorState` eksplisit yang di-pass ke tiap modul — memudahkan testing dan menghindari _hidden coupling_ lewat closure.

---

## Fase 5 — Test Coverage untuk Logic Editor

**Tujuan:** saat ini hanya core engine (`VoxelEngine`, `PluginRegistry`, raytrace) yang punya test; logic editor (history, scene-ops, picking) nol coverage — risiko regresi tinggi begitu makin kompleks.

- [x] Unit test untuk `History` (undo/redo command pattern) — mudah karena sudah dipisah modulnya di Fase 4.
- [x] Unit test untuk `scene-ops.js` (add/remove/transform node, termasuk efeknya ke `NodeMeta`/`sceneOrder`).
- [x] Unit test untuk raycast/OBB picking dengan kasus-kasus geometris yang diketahui hasilnya.
- [x] (Opsional, nice-to-have) Test rendering non-visual: pastikan `drawDebugPrimitives()` dipanggil dengan data yang benar (mock renderer), tanpa perlu render GPU sungguhan.

---

## Fase 6 — Fondasi Lanjutan & Fitur Editor Kompleks (Tahap Saat Ini)

Setelah Fase 1-5 selesai, `editor.js` (kini kumpulan modul) siap dipakai untuk fitur lanjutan tanpa mengulang masalah yang sama. Fase ini akan berfokus pada stabilitas UI, interaktivitas tingkat lanjut, dan ekspansi sistem *rendering*.

> **Catatan audit (sebelum menulis kode):** sebagian isi Fase 6 versi awal ternyata sudah terselesaikan sebagian oleh Fase 1-5 tanpa disadari, dan sebagian lagi butuh diriset ulang karena asumsi awalnya kurang tepat untuk arsitektur ECS proyek ini (bitECS, tanpa scene graph). Poin-poin di bawah sudah direvisi berdasarkan audit kode aktual + riset eksternal (pola Three.js `TransformControls`, kapabilitas `bitecs@0.4.0`, desain `History.js` yang sudah ada).
>
> - Gizmo **translate** untuk single-selection **sudah berjalan penuh** (`geometry.js: buildGizmoGeometry`, `camera-input.js: pickGizmoAxis/gizmoDrag/closestParamsBetweenLines`, `scene-ops.js: commitTransform`). Sisa pekerjaan Fase 6 di area ini murni **multi-seleksi** dan **rotate/scale**, bukan gizmo dari nol.
> - "Circular dependency" yang disebut sebagai alasan Pub/Sub sebenarnya **sudah diputus** sejak Fase 4 lewat pola callback-injection (`EditorContext.refreshOutliner = () => refreshOutliner()`). Motivasi Pub/Sub direvisi jadi: mengurangi boilerplate (8+ titik pemanggilan manual di `scene-ops.js`) dan mendukung >1 listener per event, bukan memperbaiki sirkularitas yang sudah tidak ada.
> - `History.js` (command pattern berbasis closure `redo()`/`undo()`) **sudah cukup** untuk batch/macro command multi-objek tanpa kelas abstraksi baru — cukup loop di dalam satu closure.
> - `bitecs@0.4.0` (versi yang dipakai proyek ini, lihat `package.json` / `scripts/check-bitecs-version.js`) mendukung tag/marker component + `query()`, sehingga state seleksi sebaiknya hidup di ECS (konsisten dengan pola `observe(world, onRemove(...))` yang sudah dipakai untuk `RenderMesh`/`VoxelVolume`), bukan sebagai array terpisah di `EditorContext`.

### 6.1 — `Selected` Tag Component (fondasi data seleksi)

**Tujuan:** memindahkan status seleksi dari scalar `EditorContext.selectedEid` menjadi komponen ECS yang query-able, agar siap menampung multi-seleksi tanpa struktur data paralel.

- [x] Tambahkan `export const Selected = {}` (tag/marker component kosong) di `src/core/ecs/components.js`.
- [x] Tambahkan helper di `state.js`/modul baru kecil: `getSelection()` (balikin array eid dari `query(world, [Selected])`), `getPrimarySelection()` (balikin eid pertama/terakhir untuk kasus yang masih butuh 1 eid, misalnya field input Properties saat seleksi tunggal), `setSelection(eids)`, `clearSelection()`.
- [x] Pastikan entity yang dihapus otomatis lepas dari `Selected` (bitECS sudah menangani ini otomatis lewat `removeEntity`, cukup diverifikasi lewat test).
- [x] **Checkpoint:** belum ada perubahan perilaku yang terlihat di UI — ini murni pergantian struktur data internal.

### 6.2 — Migrasi Titik Pemakai `selectedEid` Lama

**Tujuan:** semua kode yang membaca `EditorContext.selectedEid` (± 24 lokasi) beralih ke `Selected`/`getSelection()` tanpa regresi pada alur single-select yang sudah berjalan.

File yang terdampak (urutan pengerjaan disarankan satu-per-satu + jalankan aplikasi setelah tiap file, bukan sekaligus):

- [x] `src/editor/scene-ops.js` — `selectNode`, `addCube`, `addGroup`, `deleteSelected`, `duplicateSelected`.
- [x] `src/editor/picking.js` — `pickAtScreen` (hasil klik tunggal → `setSelection([eid])`, atau tambah ke seleksi jika modifier Shift ditekan).
- [x] `src/editor/camera-input.js` — `pickGizmoAxis`, alur `gizmoDrag` (lihat 6.4 untuk detail pivot multi-select).
- [x] `src/editor/editor.js` — shortcut `Delete`/`Backspace`, alur `drawDebugPrimitives` untuk outline & gizmo.
- [x] `src/editor/ui/outliner.js` — highlight baris terpilih (harus mendukung multi-highlight).
- [x] `src/editor/ui/properties.js` — mode tampilan saat seleksi > 1 objek (lihat catatan "Mixed value" di 6.3).
- [x] **Checkpoint:** semua fitur lama (single select, translate gizmo, delete, duplicate, undo/redo) harus identik perilakunya dengan sebelum migrasi. Jalankan `npm run test` + smoke test manual dari Fase 0.

### 6.3 — Marquee Select (Drag Rectangle Multi-Seleksi)

**Tujuan:** memilih banyak objek sekaligus lewat drag rectangle di viewport, sebagai pelengkap klik tunggal yang sudah ada.

> **Perubahan skema input kamera (disengaja, bukan regresi):** Left-drag di area kosong sebelumnya dipakai untuk Orbit. Karena Left-button sekarang didedikasikan penuh untuk interaksi editor (klik pilih, marquee select, gizmo drag), Orbit dipindah ke **Middle-drag**, Pan tetap di **Right-drag**. Klik kiri tanpa drag berarti (di bawah `MARQUEE_THRESHOLD = 4px`) tetap berperilaku seperti klik biasa. Hint toolbar sudah diperbarui.

- [x] Deteksi drag di area viewport kosong (bukan di atas gizmo/objek) → mulai mode `marquee` di `camera-input.js`. Disambiguasi klik-vs-drag memakai threshold 4px yang sama dengan pola gizmo/pick yang sudah ada sebelumnya.
- [x] Proyeksikan bounding-box tiap entity (8 sudut OBB, bukan cuma titik pusat, untuk akurasi terhadap objek yang dirotasi) ke screen space. Ditambahkan primitif baru `mat4Apply()`/`projectToScreen()` di `math.js` (sebelumnya proyek ini murni ray-based picking, belum ada proyeksi titik 3D→2D) dengan guard `w <= epsilon` untuk titik di belakang kamera. `frustumSelect()` baru ditambahkan di `picking.js`, memakai view/proj matrix yang identik dengan yang dipakai renderer WebGL/WebGPU (fovY=PI/3, near=0.1, far=500) agar hasil seleksi sesuai apa yang terlihat di layar.
- [x] Dukung modifier: `Shift` = tambah ke seleksi berjalan, tanpa modifier = ganti seleksi.
- [x] `outliner.js` dan `properties.js` sudah mendukung multi-highlight & mode "Mixed" sejak 6.2 — tidak perlu perubahan tambahan.
- [x] Kotak marquee digambar via elemen DOM (`<div id="marquee-box">`, `pointer-events: none`) di atas kanvas, bukan lewat GPU — lebih murah dan tidak mengganggu event mouse kanvas.
- [x] **Bug ditemukan & diperbaiki saat implementasi:** commit sebelumnya (`c72b7ad`, shift-click toggle) memanggil `toggleSelection()` di `scene-ops.js` tanpa mengimpornya dari `state.js` — akan throw `ReferenceError` begitu shift-klik dipakai. Sudah diperbaiki.
- [x] **Checkpoint:** `npm test` → 48/49 lolos (1 gagal pra-eksisting: `setup.js` memakai skema URL `bun:` yang tidak didukung `node --test`, tidak terkait perubahan ini). Drag-select di area kosong menghasilkan seleksi yang benar secara visual, klik tunggal dan Delete/Duplicate tetap bekerja terhadap seluruh seleksi.

### 6.4 — Virtual Pivot + Gizmo Translate untuk Multi-Seleksi

**Tujuan:** menggerakkan banyak objek terpilih sekaligus lewat satu gizmo, mengadaptasi pola industri (Three.js `TransformControls` memakai grup sementara + pivot di titik tengah objek terpilih) ke arsitektur ECS flat proyek ini — tanpa parenting/scene graph literal.

- [x] Hitung `virtualPivot = {x,y,z}` dari rata-rata posisi pivot seluruh entity di `Selected`.
- [x] Gambar & drag gizmo relatif ke `virtualPivot` — reuse `pickGizmoAxis()` dan `closestParamsBetweenLines()`, ganti sumber titik pivot dari `Transform[selectedEid]` menjadi `virtualPivot`.
- [x] Saat drag berlangsung, delta pergerakan diterapkan ke transform **setiap** entity di `Selected` secara paralel.
- [x] Bungkus hasil akhir drag jadi **satu** `History.push()` (macro command via closure loop).
- [x] **Checkpoint:** blok 5 kubus, geser sumbu X, kelima kubus bergerak bersama, dan Ctrl+Z mengembalikan kelimanya serentak.
- [x] **Bug ditemukan & diperbaiki saat review:** `camera-input.js` memanggil `getSelection()` di handler `mousedown` tanpa mengimpornya dari `state.js` — `ReferenceError` yang hanya muncul saat user klik gizmo arm dengan seleksi aktif (marquee-select biasa tidak kena, karena jalur itu lewat `getVirtualPivot()` yang sudah benar diimpor). Tidak tertangkap `npm test` karena tidak ada test yang men-trigger `mousedown` DOM sungguhan. Sudah diperbaiki, sekalian dibersihkan 2 impor mati (`getPrimarySelection`, `Transform`) yang tersisa dari refactor virtual pivot.

### 6.5 — Rotate & Scale Gizmo

**Tujuan:** melengkapi gizmo translate yang sudah ada dengan mode rotate dan scale, untuk single maupun multi-seleksi (reuse `virtualPivot` dari 6.4).

- [x] Geometri gizmo rotate (48-segmen ring per sumbu, `buildRotateGizmoGeometry`) dan scale (shaft + kubus kecil di ujung, `buildScaleGizmoGeometry`) ditambahkan di `geometry.js`, mengikuti pola `GIZMO_AXES`/warna yang sudah ada.
- [x] Math rotasi (per-sumbu, bukan trackball, sesuai catatan roadmap): sudut drag dilacak lewat `rayPlaneIntersect()` (baru, primitif ray-vs-plane di `math.js`) terhadap bidang tegak lurus sumbu yang melewati pivot. Delta sudut dikonversi jadi `deltaR` (rotasi elementer sumbu-dunia via `rotationMat3`), lalu dikomposisikan `R_new = deltaR * R_old` dan didekomposisi kembali ke `rx/ry/rz` derajat lewat `mat3ToEulerXYZ()` (baru, formula ekstraksi ZYX standar — **diverifikasi manual** lewat script round-trip: 9 kombinasi sudut + 1 uji urutan komposisi, semua cocok hingga presisi floating-point).
  - **Batasan yang didokumentasikan (bukan bug):** posisi pivot tiap objek di-orbit di sekitar `virtualPivot` dengan `pivot_new = P_ext + deltaR*(pivot_old - P_ext)` — ini **eksak** untuk seleksi tunggal (pivot objek == virtual pivot) dan untuk objek yang belum pernah dirotasi (default `rx=ry=rz=0` saat `addCube`), tapi merupakan **aproksimasi kecil** untuk rotate multi-seleksi pada objek yang sudah punya rotasi sebelumnya (keterbatasan yang melekat pada representasi Euler murni tanpa quaternion — dialami semua gizmo rotate berbasis Euler, bukan cuma implementasi ini).
- [x] Math scale: drag di-ukur lewat rasio jarak handle saat ini terhadap jarak saat mousedown (reuse `closestParamsBetweenLines` yang sama dengan translate), diterapkan ke `ox/sx` (atau `oy/sy`, `oz/sz` sesuai sumbu) **relatif terhadap pivot objek itu sendiri** — karena `ox/px` hidup di ruang lokal pra-rotasi (sebelum `R` diterapkan di `buildCubeMesh`), formula ini **eksak tanpa risiko shearing** berapa pun rotasi objeknya.
  - **Batasan yang didokumentasikan:** untuk multi-seleksi, tiap objek scale di tempatnya sendiri (pivot masing-masing), bukan memekar keluar dari `virtualPivot` bersama seperti di software profesional — cukup untuk MVP, expand-outward-dari-grup didokumentasikan sebagai follow-up potensial jika dibutuhkan nanti.
- [x] Toggle mode gizmo: 3 tombol toolbar (`btn-gizmo-translate/rotate/scale`) + hotkey `G`/`R`/`S` (pola Blender, sesuai rencana awal), disatukan lewat `setGizmoModeAndSync()` supaya tombol & state selalu sinkron dari kedua jalur input.
- [x] **Checkpoint:** rotate & scale bekerja untuk single dan multi-seleksi, undo/redo tetap 1 langkah per aksi drag (label History otomatis menyesuaikan verb: "Translate"/"Rotate"/"Scale").

### 6.6 — Event-Driven `EditorContext` (Pub/Sub)

**Tujuan:** mengurangi boilerplate pemanggilan manual (`EditorContext.refreshOutliner()` dkk. di 8+ lokasi) dan mendukung lebih dari satu listener per event. (Dikerjakan setelah 6.5, bukan bersamaan dengan 6.1-6.4 seperti rencana awal — karena titik-titik pemanggilan refresh terus berubah selama 6.1-6.5 berjalan, lebih aman menyatukan refactor-nya sekali di akhir setelah semua titik pemanggilan stabil, daripada mengejar target yang terus bergerak.)

- [x] Event emitter kecil dipasang langsung di `EditorContext` (`state.js`): `on(event, handler)`, `emit(event, payload)`, mendukung banyak listener per event.
- [x] 3 event yang dipakai: `selectionChanged` (seleksi berubah — highlight outliner + panel Properties), `sceneMutated` (node ditambah/dihapus/di-rename — outliner perlu rebuild penuh), `transformChanged` (posisi/rotasi/skala/warna berubah — panel Properties refresh, tanpa rebuild outliner).
- [x] Semua pemanggilan `EditorContext.refreshOutliner()`/`refreshProperties()`/`refreshOutlinerSelection()` di `scene-ops.js`, `camera-input.js`, `io.js` diganti `EditorContext.emit(...)` yang sesuai. Wiring manual 3-baris di `editor.js` (`EditorContext.refreshOutliner = () => ...` dkk.) dihapus total — `outliner.js` dan `properties.js` sekarang mendaftarkan diri sendiri lewat `EditorContext.on(...)` di akhir file masing-masing, otomatis terpasang saat modul itu diimpor.
- [x] `syncPropertyInputs(eid)` (update langsung nilai input tanpa rebuild DOM, dipakai saat drag gizmo aktif tiap `mousemove`) **sengaja tidak** dipindah ke sistem event — tetap pemanggilan langsung karena ini hot-path frekuensi tinggi yang beda kebutuhan dari refresh berbasis event (commit-time), bukan oversight.
- [x] **Bug ditemukan & diperbaiki saat menulis test verifikasi:** `deleteSelected()` dan `duplicateSelected()` memanggil `clearSelection()`/`setSelection()` langsung (bukan lewat `syncSelectionUI()`), sehingga cuma emit `sceneMutated` — panel Properties (yang mendengarkan `selectionChanged`, bukan `sceneMutated`) tidak pernah diberi tahu setelah Delete/Duplicate/undo-nya. **Ini bug pre-existing** (sudah ada sejak sebelum 6.6, kode lama juga tidak pernah memanggil `refreshProperties()` di situ) yang baru ketahuan karena sistem pub/sub baru ini membuatnya mudah ditest secara eksplisit (lihat suite `EditorContext pub/sub` di `editor_sceneops.test.js`). Diperbaiki dengan menambah `syncSelectionUI()` di kedua fungsi.
- [x] **Checkpoint:** perilaku UI tidak berubah dari sisi pengguna (malah 1 bug lama ikut hilang), 4 test baru khusus untuk mekanisme `on`/`emit` (banyak listener per event, tidak nyasar ke event lain, aman tanpa listener, payload diteruskan), plus 1 script verifikasi end-to-end manual (bukan bagian test suite) yang mensimulasikan graf modul asli (`outliner.js`+`properties.js` benar-benar diimpor) untuk membuktikan wiring nyata bekerja, bukan cuma emitter-nya sendiri yang benar secara terisolasi.

### 6.7 — Riset Dual-Mode Renderer / Babylon.js (Opsional, Spike Saja)

**Tujuan:** dieksplorasi paling akhir, setelah 6.1-6.6 selesai, dan **tanpa komitmen integrasi penuh** di iterasi ini.

- [ ] `PluginRegistry.registerRenderer()` sudah generic dan mendukung ini tanpa menyentuh WebGPU/WebGL yang ada — validasi ini lewat prototipe kecil (bukan integrasi produksi).
- [ ] Perhatikan biaya nyata sebelum lanjut: (a) ukuran dependency Babylon.js yang signifikan untuk fitur opsional, (b) `createMesh(vertexData, indexData)` perlu adapter untuk membungkus jadi `BABYLON.VertexData` per mesh, perlu divalidasi layout vertex (posisi/normal/UV/warna) cocok 1:1.
- [ ] Sebelum menulis kode integrasi, evaluasi ulang: apakah kebutuhan sebenarnya (Gizmo + `UtilityLayerRenderer` bawaan Babylon) sudah cukup terjawab oleh gizmo custom hasil 6.4-6.5 — jika ya, turunkan prioritas poin ini lebih jauh lagi.
- [ ] **Checkpoint:** cukup berupa catatan riset/prototipe terpisah (mis. `sandbox.html` atau branch eksperimen), tidak mem-block rilis fitur 6.1-6.6.

---

### 6.8 — Add-Cube Tool: Draw & Extrude (di luar rencana awal, ditambahkan langsung oleh pengembang)

**Catatan:** fitur ini tidak ada di rencana 6.1-6.7 di atas — ditambahkan langsung sebagai `tool-add.js` (raycasting ke permukaan objek/ground plane, preview outline interaktif, alur klik-cepat untuk kubus 1×1×1 atau drag-untuk-gambar-alas-lalu-extrude-tinggi). Didokumentasikan di sini untuk konsistensi riwayat proyek.

- [x] `raycastWorld()`/`rayAABBWithNormal()` di `picking.js` — deteksi permukaan objek (dengan normal wajah) atau ground plane `y=0` sebagai fallback. **Diverifikasi terpisah** lewat test numerik manual (box axis-aligned dari 3 arah, plus kasus kubus yang dirotasi 45° — semua hasil `t`/normal sesuai perhitungan tangan) karena ini fondasi matematika baru yang dipakai seluruh tool.
- [x] Preview outline live (`buildOutlineForTransform`, hasil ekstraksi dari `buildOutlineForEid` yang sudah ada) + fix pendukung di `webgpu/engine.js` untuk buffer debug kosong (`getDebugBuffer` sekarang aman menerima data 0-panjang, sebelumnya berpotensi error validasi WebGPU saat tidak ada apa pun untuk digambar).
- [x] **Bug ditemukan & diperbaiki saat review:** kode yang di-push mengandung sisa proses debugging yang belum dibereskan — `handleAddToolPointerDown` punya cabang finalize EXTRUDE dengan `undo()` **kosong** (komentar di kode sendiri: "we need destroyNodeRaw... For now, let's dispatch an event or call it"), DAN ada monkey-patch global `History.push = function(op) {...}` yang menimpa `undo` jadi kosong untuk **setiap** entri berlabel `'Add Box (Draw)'` — termasuk yang berasal dari `finalizeCube()`, implementasi yang sebenarnya sudah benar. Akibatnya **kedua alur pembuatan kubus (klik cepat maupun draw+extrude) sama-sama tidak bisa di-undo**, walau salah satunya sudah ditulis dengan benar. Diverifikasi dengan skrip simulasi terisolasi sebelum dan sesudah perbaikan. Diperbaiki dengan menghapus monkey-patch dan cabang kode mati, menyatukan kedua alur untuk memanggil `finalizeCube()` yang sama.
- **Observasi kecil (belum diperbaiki, tidak mendesak):** `tool-add.js` punya `paletteIdx`/`nextNameCube` sendiri, terpisah dari `paletteIdx`/`nextName.cube` di `scene-ops.js`. Saat ini tidak terlihat sebagai bug karena tombol "+Cube" sekarang mengarah ke tool draw ini (bukan lagi `addCube()` langsung), tapi kalau suatu saat `addCube()` lama dipanggil lagi dari UI, penomoran nama & rotasi warna palet bisa tumpang tindih antar keduanya. Perlu didiskusikan apakah counter-nya sebaiknya disatukan.
- [x] **Checkpoint:** `npm test` → 52/53 lolos (kegagalan pra-eksisting `setup.js`, tidak terkait). Kedua alur (klik cepat & draw+extrude) diverifikasi lewat simulasi end-to-end: buat kubus → undo → `sceneOrder` kembali ke kondisi semula.
- [x] **Perbaikan lanjutan (atas pertanyaan pengembang):** semula kubus baru **selalu** dibuat axis-aligned (`rx=ry=rz=0`) walau target-nya kubus yang sudah dirotasi — dan lebih parah, klasifikasi "sumbu mana yang di-extrude" berbasis threshold `> 0.5` pada normal DUNIA bisa salah baca untuk target yang miring (normal diagonal seperti `[0.7,0,0.7]` pada rotasi 45° lolos threshold X padahal bukan permukaan sumbu-X murni). Diperbaiki dengan pendekatan "ruang lokal ter-derotasi": `raycastWorld()` di `picking.js` sekarang juga mengembalikan `localNormal` (normal AABB mentah sebelum dirotasi — selalu presisi salah satu dari 6 arah ±X/±Y/±Z apapun rotasi targetnya) dan `rotation` (rotasi entity target). `tool-add.js` melacak semua titik/ray dalam ruang yang sudah diputar-balik sesuai rotasi target (`AddToolState.worldToTarget()`), sehingga matematika lama (`getCubeTransform()`) tidak perlu diubah sama sekali — cukup pasang `rx/ry/rz` hasil ke rotasi target di akhir.
- [x] **Bug posisi ditemukan dari laporan langsung pengembang** ("ghost tidak mengikuti cursor saat target dirotasi"): verifikasi pertama di atas cuma mengecek field rotasi ikut berubah, tidak pernah benar-benar mengecek **posisi** untuk target yang tidak kebetulan berada persis di sumbu rotasi dunia. Root cause: `worldToTarget()` memutar titik dunia di sekitar **titik nol dunia** (`Rinv * worldPoint`), bukan di sekitar **titik pusat target itu sendiri** (`Rinv * (worldPoint - targetPivot)`). Test awal kebetulan memakai target yang persis berada di garis sumbu rotasinya (`px=0, pz=0` untuk rotasi sumbu-Y) sehingga bug-nya tersembunyi secara matematis (titik itu adalah *fixed point* dari rotasi, jadi salah-tidaknya rumus tidak kelihatan). Untuk target di posisi manapun yang realistis, ini menghasilkan offset yang sangat terlihat (dibuktikan lewat simulasi terisolasi: error offset 8+ satuan). Diperbaiki dengan: `raycastWorld()` sekarang juga mengembalikan `pivot` (posisi dunia target), `worldToTarget()` mengurangi `targetPivot` dulu sebelum diputar-balik, dan `getCubeTransform()` memakai rumus re-anchor yang benar (`px = targetPivot + R*centroidLokal`, `ox = px + (minLokal - centroidLokal)`, diturunkan secara aljabar dan diverifikasi lewat 2 skrip simulasi independen — satu memakai formula terisolasi, satu lagi lewat alur handler nyata dengan ray yang benar-benar tegak lurus wajah target). Kasus lama (ground plane/axis-aligned) dipastikan sekali lagi tidak berubah hasilnya.

## Ringkasan Prioritas

1. **Fase 1-3 = wajib, tidak bisa ditunda** — ini yang menyelesaikan bug WebGL fallback secara benar (lewat abstraksi), bukan tambal sulam.
2. **Fase 4-5 = sangat direkomendasikan sebelum menambah fitur baru** — biaya refactor makin mahal kalau ditunda sampai `editor.js` makin gemuk.
3. **Fase 6 = pintu masuk untuk roadmap fitur** — mulai setelah fondasi di atas beres. Urutan internal Fase 6: **6.1 → 6.2 → 6.3 → 6.4 → 6.5**, wajib berurutan karena masing-masing bergantung pada fondasi data (`Selected` tag component) dari langkah sebelumnya. **6.6** dikerjakan menyatu dengan 6.1-6.4, bukan langkah terpisah. **6.7** paling akhir dan bersifat opsional/spike, tidak boleh memblokir 6.1-6.6.