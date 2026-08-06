# Contributing to Devoxel

Terima kasih sudah tertarik berkontribusi. Dokumen ini singkat — cukup untuk
memulai. Untuk aturan arsitektur/konvensi kode yang lebih detail (termasuk
kalau kamu memakai AI coding agent), baca **[`AGENTS.md`](./AGENTS.md)**.

## Setup

Tidak ada build step — ini project ESM murni.

```bash
git clone https://github.com/deftorch/devoxel-engine.git
cd devoxel-engine
```

Buka `index.html` atau `editor.html` lewat local server (hindari `file://`
langsung karena masalah CORS pada ES modules), misal:

```bash
npx serve .
```

## Sebelum membuat Pull Request

Jalankan verifikasi lengkap:

```bash
npm run verify
```

Ini menjalankan tiga hal sekaligus:

1. `npm run check` — syntax-check semua file `.js` di `src/`
2. `npm run check-deps` — memastikan versi `bitecs` konsisten di semua import CDN
3. `npm test` — menjalankan test di `src/test/`

PR yang gagal salah satu dari tiga ini tidak akan lolos CI.

## Menambah fitur baru

- **Storage/mesher/renderer baru?** Baca bagian "Pluggable Plugin System" di
  `AGENTS.md` — jangan menambah branch kondisional di `VoxelEngine.js`,
  daftarkan sebagai plugin lewat `PluginRegistry`.
- **Ikuti konvensi penamaan** yang sudah ada: base class `Voxel<Role>`,
  implementasi `<Nama><Role>` (tanpa suffix "Plugin" berulang), id registry
  lowercase tanpa spasi/tanda hubung.
- **Tambahkan test.** Kalau perubahanmu ada di `src/core/`, tambahkan test di
  `src/test/` menggunakan `node:test` (lihat `PluginRegistry.test.js` atau
  `VoxelEngine.test.js` sebagai contoh pola: helper `makeEngine()`/fake
  storage untuk isolasi, tanpa dependency ke backend WebGL/WebGPU asli).
- **JSDoc** untuk API publik di `src/core/` — ini bagaimana orang lain (dan
  AI agent) memahami kontrak tanpa membaca implementasi.

## Melaporkan bug

Sertakan: langkah reproduksi, browser + versi (khususnya kalau terkait
WebGPU), dan storage/mesher/renderer plugin apa yang aktif saat bug terjadi
(banyak bug voxel engine spesifik ke kombinasi plugin tertentu).

## Lisensi

Dengan berkontribusi, kamu setuju kontribusimu dilisensikan di bawah
[MIT License](./LICENSE) yang sama dengan proyek ini.
