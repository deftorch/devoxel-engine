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

- [ ] Modifikasi `main()` di `editor.js`: coba `new VoxelEngine({ ..., renderer: 'webgpu' })`, jika gagal (`catch`), retry dengan `renderer: 'webgl'`.
- [ ] Tambahkan flag `const isWebGPU = engineRef.rendererPlugin.name === 'webgpu';` yang bisa dipakai bagian lain kode.
- [ ] Update `setStatus(...)` agar pesan loading mencerminkan backend yang benar-benar terpakai (bukan selalu "Menginisialisasi GPU…" generik).
- [ ] **Checkpoint:** di browser tanpa WebGPU (atau dengan `navigator.gpu` di-disable manual), editor harus tetap boot dan menampilkan chunk mesh (tanpa grid/outline/gizmo dulu — itu urusan fase berikutnya, biarkan sementara error/ke-skip dengan aman).

---

## Fase 2 — Abstraksi "Debug/Immediate Draw" di Level Renderer Plugin _(inti dari refactor ini)_

**Tujuan:** ini yang menyelesaikan akar masalah, bukan cuma menambal WebGL. Grid, outline, dan gizmo naik status dari "kode ad-hoc di editor" menjadi bagian resmi dari kontrak `VoxelRenderer`.

- [ ] Tambahkan method baru di `VoxelRenderer` (base class): `drawDebugPrimitives(cameraState, { lines, tris })` — kontrak seragam untuk kedua backend.
- [ ] **`webgpu/engine.js`**: refactor `LINE_SHADER`, pipeline garis, pipeline gizmo (line + tri) yang saat ini hidup di `editor.js` → pindahkan ke sini, dibungkus di belakang `drawDebugPrimitives()`. Tetap pakai `onPostDraw(pass)` di dalam pass yang sama seperti sekarang.
- [ ] **`webgl/engine.js`**:
  - Tulis vertex/fragment shader GLSL versi garis (port langsung dari `LINE_SHADER` WGSL — logikanya sederhana, tinggal `position * uViewProj` + passthrough warna).
  - Buat VAO/VBO khusus untuk data garis dan data triangle gizmo (terpisah dari VAO mesh voxel utama).
  - Implementasikan `gl.LINES` untuk grid+outline+gizmo-line, dan `gl.TRIANGLES` untuk gizmo arrow-head.
  - **Kelola state eksplisit** (poin kritis karena WebGL adalah state machine, bukan per-pass seperti WebGPU):
    - Grid & outline: depth test aktif, `depthFunc(LESS)` (default, tidak perlu diubah).
    - Gizmo: `gl.disable(DEPTH_TEST)` (atau `depthFunc(ALWAYS)`) + `gl.disable(CULL_FACE)` saat digambar, lalu **wajib** `gl.enable(DEPTH_TEST)` + `gl.enable(CULL_FACE)` sebelum frame berikutnya, supaya tidak bocor ke render chunk voxel.
- [ ] Expose `gl` (dan `canvas` bila perlu) di return object `initWebGL()` — otomatis ter-expose lewat `VoxelRendererAdapter` tanpa perubahan tambahan di adapter.
- [ ] **Checkpoint:** grid, outline seleksi, dan gizmo translate tampil identik secara visual di WebGPU (regresi = 0) dan mulai berfungsi di WebGL.

---

## Fase 3 — Bersihkan `editor.js` dari Akses GPU Langsung

**Tujuan:** setelah Fase 2 selesai, `editor.js` seharusnya tidak punya baris `device.create...` atau `gl.` sama sekali.

- [ ] Ganti seluruh blok pipeline/shader/buffer manual di `main()` (baris ~1200-1300 saat ini) dengan pemanggilan `engineRef.rendererPlugin.drawDebugPrimitives(cameraState, { lines: [...], tris: [...] })`.
- [ ] Hapus `deviceRef`, akses `renderer.device` langsung, dan `LINE_SHADER` (WGSL) dari `editor.js` — semuanya sudah pindah ke Fase 2.
- [ ] Update `rebuildMesh(eid)` (baris ~396, saat ini pakai `if (deviceRef) rebuildMesh(eid)`) agar tidak lagi bergantung pada `deviceRef` sebagai penanda "renderer siap" — pakai flag generik (`engineRef.rendererPlugin.ready`).
- [ ] **Checkpoint:** cari `grep -n "device\.\|gl\." src/editor/editor.js` → hasilnya harus kosong.

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

- [ ] Pindahkan section demi section (bukan sekaligus) — setiap pemindahan 1 modul, jalankan aplikasi, pastikan tidak ada regresi, baru lanjut ke modul berikutnya.
- [ ] Ganti variabel module-scope global (`deviceRef`, `engineRef`, `camera`, dst) dengan satu objek `EditorContext`/`EditorState` eksplisit yang di-pass ke tiap modul — memudahkan testing dan menghindari _hidden coupling_ lewat closure.

---

## Fase 5 — Test Coverage untuk Logic Editor

**Tujuan:** saat ini hanya core engine (`VoxelEngine`, `PluginRegistry`, raytrace) yang punya test; logic editor (history, scene-ops, picking) nol coverage — risiko regresi tinggi begitu makin kompleks.

- [ ] Unit test untuk `History` (undo/redo command pattern) — mudah karena sudah dipisah modulnya di Fase 4.
- [ ] Unit test untuk `scene-ops.js` (add/remove/transform node, termasuk efeknya ke `NodeMeta`/`sceneOrder`).
- [ ] Unit test untuk raycast/OBB picking dengan kasus-kasus geometris yang diketahui hasilnya.
- [ ] (Opsional, nice-to-have) Test rendering non-visual: pastikan `drawDebugPrimitives()` dipanggil dengan data yang benar (mock renderer), tanpa perlu render GPU sungguhan.

---

## Fase 6 — Fondasi untuk Fitur Editor Kompleks Berikutnya

Setelah Fase 1-5 selesai, `editor.js` (kini kumpulan modul) siap dipakai untuk fitur lanjutan tanpa mengulang masalah yang sama:

- [ ] Dokumentasikan kontrak `drawDebugPrimitives()` sebagai _extension point_ resmi — fitur visual baru (misal: bounding box multi-select, snap guide, path/spline tool) tinggal menambah data ke kontrak ini, tidak perlu sentuh backend GPU lagi.
- [ ] Evaluasi apakah `EditorContext` dari Fase 4 perlu naik jadi event-driven (memakai `engine.on()/emit()` yang sudah ada di `VoxelEngine`) supaya modul UI (outliner, properties) tidak saling panggil langsung.
- [ ] Backlog fitur besar (multi-select, grouping lanjutan, snapping, material/texture editor, dll) baru dibuka setelah fondasi ini stabil — supaya fitur baru dibangun di atas struktur yang bersih, bukan di atas monolit lama.

---

## Ringkasan Prioritas

1. **Fase 1-3 = wajib, tidak bisa ditunda** — ini yang menyelesaikan bug WebGL fallback secara benar (lewat abstraksi), bukan tambal sulam.
2. **Fase 4-5 = sangat direkomendasikan sebelum menambah fitur baru** — biaya refactor makin mahal kalau ditunda sampai `editor.js` makin gemuk.
3. **Fase 6 = pintu masuk untuk roadmap fitur** — mulai setelah fondasi di atas beres.
