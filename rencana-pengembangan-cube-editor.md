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
- [x] `outliner.js` dan `properties.js` sudah mendukung multi-highlight & mode "Mixed".
- [x] Kotak marquee digambar via elemen DOM (`<div id="marquee-box">`).

### 6.4 — Virtual Pivot + Gizmo Translate untuk Multi-Seleksi

**Tujuan:** menggerakkan banyak objek terpilih sekaligus lewat satu gizmo, mengadaptasi pola industri (Three.js `TransformControls` memakai grup sementara + pivot di titik tengah objek terpilih) ke arsitektur ECS flat proyek ini — tanpa parenting/scene graph literal.

- [x] Hitung `virtualPivot = {x,y,z}` dari rata-rata posisi pivot seluruh entity di `Selected`.
- [x] Gambar & drag gizmo relatif ke `virtualPivot` — reuse `pickGizmoAxis()` dan `closestParamsBetweenLines()`, ganti sumber titik pivot dari `Transform[selectedEid]` menjadi `virtualPivot`.
- [x] Saat drag berlangsung, delta pergerakan diterapkan ke transform **setiap** entity di `Selected` secara paralel.
- [x] Bungkus hasil akhir drag jadi **satu** `History.push()` (macro command via closure loop).
- [x] **Checkpoint:** blok 5 kubus, geser sumbu X, kelima kubus bergerak bersama, dan Ctrl+Z mengembalikan kelimanya serentak.

### 6.5 — Rotate & Scale Gizmo

**Tujuan:** melengkapi gizmo translate yang sudah ada dengan mode rotate dan scale, untuk single maupun multi-seleksi (reuse `virtualPivot` dari 6.4).

- [ ] Tambah geometri gizmo rotate (ring per sumbu) dan scale (kubus kecil di ujung arm) di `geometry.js`, mengikuti pola `buildGizmoGeometry()`/`GIZMO_AXES` yang sudah ada.
- [ ] Math rotasi: proyeksi drag mouse ke sudut rotasi terhadap `virtualPivot` (trackball atau per-sumbu, mulai dari per-sumbu dulu karena lebih sederhana), lalu update `Transform.rx/ry/rz`.
- [ ] Math scale: drag sepanjang arm mengubah `Transform.sx/sy/sz` relatif terhadap `virtualPivot`.
- [ ] Tambah UI toggle mode gizmo (Translate/Rotate/Scale), mirip pola hotkey Blender (`G`/`R`/`S`) jika ingin konsisten dengan software 3D standar.
- [ ] **Checkpoint:** rotate & scale bekerja untuk single dan multi-seleksi, undo/redo tetap 1 langkah per aksi drag.

### 6.6 — Event-Driven `EditorContext` (Pub/Sub)

**Tujuan:** mengurangi boilerplate pemanggilan manual (`EditorContext.refreshOutliner()` dkk. di 8+ lokasi) dan mendukung lebih dari satu listener per event — dikerjakan **bersamaan** dengan 6.1-6.4 karena titik-titik pemanggilan itu toh akan berubah saat multi-select masuk, bukan sebagai langkah terpisah di awal.

- [ ] Buat event emitter kecil (bisa manual atau reuse pola `CommandBus.js` yang sudah ada sebagai referensi API) yang dipasang di `EditorContext`: `on(event, handler)`, `emit(event, payload)`.
- [ ] Event minimal yang dibutuhkan: `selectionChanged`, `sceneMutated` (add/remove/rename node), `transformChanged`.
- [ ] Ganti pemanggilan langsung `EditorContext.refreshOutliner()`/`refreshProperties()`/`refreshOutlinerSelection()` di `scene-ops.js`, `camera-input.js`, `io.js` menjadi `EditorContext.emit('sceneMutated')` dkk.
- [ ] `outliner.js` dan `properties.js` mendaftarkan diri sebagai listener saat inisialisasi, alih-alih diwire manual satu-satu di `editor.js`.
- [ ] **Checkpoint:** perilaku UI tidak berubah dari sisi pengguna, tapi menambah listener baru (misal panel statistik baru di masa depan) tidak lagi butuh mengubah `scene-ops.js`.

### 6.7 — Riset Dual-Mode Renderer / Babylon.js (Opsional, Spike Saja)

**Tujuan:** dieksplorasi paling akhir, setelah 6.1-6.6 selesai, dan **tanpa komitmen integrasi penuh** di iterasi ini.

- [ ] `PluginRegistry.registerRenderer()` sudah generic dan mendukung ini tanpa menyentuh WebGPU/WebGL yang ada — validasi ini lewat prototipe kecil (bukan integrasi produksi).
- [ ] Perhatikan biaya nyata sebelum lanjut: (a) ukuran dependency Babylon.js yang signifikan untuk fitur opsional, (b) `createMesh(vertexData, indexData)` perlu adapter untuk membungkus jadi `BABYLON.VertexData` per mesh, perlu divalidasi layout vertex (posisi/normal/UV/warna) cocok 1:1.
- [ ] Sebelum menulis kode integrasi, evaluasi ulang: apakah kebutuhan sebenarnya (Gizmo + `UtilityLayerRenderer` bawaan Babylon) sudah cukup terjawab oleh gizmo custom hasil 6.4-6.5 — jika ya, turunkan prioritas poin ini lebih jauh lagi.
- [ ] **Checkpoint:** cukup berupa catatan riset/prototipe terpisah (mis. `sandbox.html` atau branch eksperimen), tidak mem-block rilis fitur 6.1-6.6.

---

## Ringkasan Prioritas

1. **Fase 1-3 = wajib, tidak bisa ditunda** — ini yang menyelesaikan bug WebGL fallback secara benar (lewat abstraksi), bukan tambal sulam.
2. **Fase 4-5 = sangat direkomendasikan sebelum menambah fitur baru** — biaya refactor makin mahal kalau ditunda sampai `editor.js` makin gemuk.
3. **Fase 6 = pintu masuk untuk roadmap fitur** — mulai setelah fondasi di atas beres. Urutan internal Fase 6: **6.1 → 6.2 → 6.3 → 6.4 → 6.5**, wajib berurutan karena masing-masing bergantung pada fondasi data (`Selected` tag component) dari langkah sebelumnya. **6.6** dikerjakan menyatu dengan 6.1-6.4, bukan langkah terpisah. **6.7** paling akhir dan bersifat opsional/spike, tidak boleh memblokir 6.1-6.6.