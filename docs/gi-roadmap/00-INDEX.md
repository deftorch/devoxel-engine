# Devoxel Engine — GI Implementation Spec (Modular)

Dokumen ini dipecah per fase supaya tiap fase bisa dikerjakan, diuji, dan di-*merge* sebagai unit
kerja terpisah — bukan satu checklist raksasa yang cuma dicoret satu-satu. Tiap file fase berisi
**spek implementasi konkret**: layout buffer, signature fungsi, formula, dan file yang harus
disentuh — bukan deskripsi abstrak.

## Cara Pakai Dokumen Ini

1. **Jangan baca semua sekaligus.** Buka satu file fase, kerjakan sampai "Acceptance Test"-nya
   lolos, baru buka fase berikutnya.
2. Tiap file fase punya bagian **"Prasyarat"** — kalau prasyarat belum dipenuhi (fase sebelumnya
   belum selesai), jangan mulai fase ini. Ini mencegah kerja bolak-balik.
3. Bagian **"Kontrak Data"** di tiap file adalah *sumber kebenaran* untuk layout buffer/struct.
   Kalau implementasi menyimpang dari kontrak ini, update dokumennya juga — supaya dokumen dan
   kode tidak pernah out-of-sync.
4. Bagian **"Anti-Mock Checklist"** di tiap file adalah verifikasi eksplisit bahwa sesuatu benar-benar
   berjalan (bukan stub/placeholder yang keliatan hidup tapi sebenarnya no-op).

## Daftar Dokumen

| File | Fase | Status Prasyarat | Estimasi Kompleksitas |
|---|---|---|---|
| `01-fase0-baseline.md` | Perbaikan bug + scene uji | Tidak ada (mulai di sini) | Sedang |
| `02-fase1-direct-lighting.md` | Soft shadow, sun ray akurat | Fase 0 selesai | Sedang |
| `03-fase2-single-bounce.md` | Cone tracing 1-bounce | Fase 1 selesai | **Tinggi** |
| `04-fase3-temporal-denoise.md` | Stabilisasi hasil Fase 2 | Fase 2 selesai | Sedang-Tinggi |
| `05-fase4-realtime-edit.md` | GI reaktif saat `editVoxel` | Fase 3 selesai | Sedang |
| `06-fase5-performance.md` | Profiling, budget, fallback | Fase 4 selesai | Sedang |
| `07-fase6-multibounce-raster.md` | Bounce ke-2, bridging rasterizer | Fase 5 selesai | Tinggi |
| `08-fase7-production-quality.md` | Emissive, SSR, tone mapping, test otomatis | Fase 6 selesai (atau paralel jika tim terpisah) | Tinggi |

## Peta Ketergantungan Buffer (Ringkas)

```
topGrid, brickPool           (sudah ada — BrickMapStorage.js, compute_rt.js)
        │
        ▼
radiancePool[direct]         ← Fase 1
        │
        ▼
mipChain (L1, L2)             ← Fase 2   (baru)
radiancePool[indirect]        ← Fase 2   (baru)
        │
        ▼
radianceHistory                ← Fase 3   (baru)
dirtyBrickQueueGI              ← Fase 4   (baru)
        │
        ▼
radiancePool[bounce2]          ← Fase 6   (baru, opsional)
emissiveSourceList             ← Fase 7   (baru, opsional)
```

Setiap buffer baru WAJIB didaftarkan di file fase yang memperkenalkannya, lengkap ukuran byte
dan formula alokasinya — lihat bagian "Kontrak Data" masing-masing.

## Prinsip Non-Negosiasi di Semua Fase

- **Tidak ada fase yang boleh selesai dengan hasil "kelihatan jalan" tanpa Acceptance Test lolos.**
  Kalau cone tracing menghasilkan warna abu-abu rata karena bug tapi tetap "terlihat seperti ada
  GI", itu gagal — bukan lolos.
- **Tidak ada angka ajaib tanpa justifikasi.** Kalau menulis `alpha = 0.08` untuk temporal blend,
  harus ada catatan kenapa 0.08 (hasil percobaan A/B di scene uji), bukan ditebak.
- **Tiap fase menyentuh file yang eksplisit disebutkan.** Kalau ternyata perlu menyentuh file lain
  di luar yang tercantum, itu sinyal scope fase ini kurang tepat — catat sebagai penyimpangan.
