# Fase 6 (Opsional) — Multi-Bounce & Integrasi Rasterizer

**Hanya kerjakan fase ini kalau Fase 0-5 sudah solid dan Acceptance Test lolos semua.** Jangan
mulai di sini karena "bounce ke-2 kedengarannya keren" — ini penambahan biaya komputasi signifikan
untuk gain visual yang sering kali marginal di scene voxel kecil (kontribusi bounce ke-3+ mengecil
cepat, hukum inverse-square + albedo <1 tiap pantulan).

## Prasyarat
Fase 5 selesai (quality tier & profiling wajib ada — bounce ke-2 tanpa itu berisiko frame drop
yang tidak diketahui akar sebabnya).

## 6.1 — Bounce ke-2 via double-buffer radiance

**Kontrak Data:**
```js
// Dua buffer terpisah, ditukar (ping-pong) tiap iterasi bounce
let radianceBufferA = new Float32Array(50000 * 512 * 3);
let radianceBufferB = new Float32Array(50000 * 512 * 3);
let currentReadBuffer = 'A'; // toggle tiap iterasi bounce
```

**Alur:**
1. Bounce 1 (Fase 2): baca `radiancePool` (direct only) → tulis ke `radianceBufferA`.
2. Bounce 2: baca `radianceBufferA` sebagai sumber energi (bukan `radiancePool` direct lagi) →
   tulis ke `radianceBufferB`.
3. Hasil akhir yang dipakai shading = `radianceBufferA + radianceBufferB` (dengan attenuasi —
   bounce ke-2 biasanya diberi bobot lebih kecil, mis. 0.5x, karena energi yang hilang tiap
   pantulan sesuai albedo material).

**Biaya:** ini secara kasar 2x biaya `bounce_gather` dari Fase 2. WAJIB diukur lewat mekanisme
Fase 5 (timestamp query) sebelum diputuskan aktif secara default atau jadi opsi tambahan di
quality tier tertinggi saja.

**Keputusan yang harus didokumentasikan setelah implementasi:** apakah gain visual bounce ke-2
sepadan dengan biayanya di scene test (`gi-box`, `gi-lshape`)? Kalau perbedaannya nyaris tidak
kelihatan di screenshot A/B, JANGAN diaktifkan default — simpan sebagai fitur opsional saja.

## 6.2 — Bridging GI ke Rasterizer

Saat ini rasterizer (`engine.js` + `shader.wgsl.js`) memakai ambient hemisphere statis hardcode
(`groundAmbient`/`skyColor`, `shader.wgsl.js` baris 33-34) — GI dari VoxelRT tidak menyentuh jalur
ini sama sekali. Dua mode render (`raster` vs `raytrace`) sekarang **sepenuhnya independen**.

### Opsi A — Bake radiance jadi vertex color tambahan
**File:** `src/game/world/meshing.js`, `mesher.worker.js`, `shader.wgsl.js`

Saat greedy meshing membangun quad, sample `radiancePool`/`radianceIndirectPool` (dari mode
raytrace yang sudah dihitung untuk world yang sama) di posisi tiap quad, simpan sebagai atribut
vertex tambahan (`ambientOcclusion`/`giColor`), lalu rasterizer men-sample nilai itu alih-alih
ambient hardcode.

**Masalah struktural yang harus diselesaikan dulu:** ini mengharuskan world SELALU disimulasikan
lewat compute path (untuk hasilkan radiance data) bahkan saat user memilih mode render `raster`.
Artinya `createRenderer(canvas, 'raster')` di `index.js` perlu tetap menjalankan sebagian compute
pipeline di background — perubahan arsitektur, bukan penambahan kecil. Evaluasi dulu apakah ini
sepadan, atau cukup terima bahwa GI cuma untuk mode VoxelRT (banyak game production melakukan ini
— GI baked terpisah dari real-time raster path).

### Opsi B — Precompute/bake sekali, bukan real-time
Kalau world statis (bukan sering diedit), radiance bisa di-bake SEKALI (bukan tiap frame) lalu
disimpan sebagai bagian dari `BrickMapStorage`. Ini jauh lebih murah tapi kehilangan sifat
real-time dari Fase 4. **Rekomendasi:** kalau target akhirnya game dengan editing voxel intensif
(gaya Minecraft), Opsi B kontradiktif dengan tujuan proyek — skip opsi ini kecuali ada mode
"world statis" eksplisit (mis. diorama viewer, bukan gameplay).

## Anti-Mock Checklist
- [ ] Screenshot A/B bounce-1-only vs bounce-1+bounce-2 di scene `gi-box` — kalau perbedaannya
      tidak terlihat tanpa di-zoom drastis, dokumentasikan itu sebagai temuan (bukan alasan untuk
      menyembunyikan hasil negatif).
- [ ] Kalau Opsi A (bridging raster) diimplementasi: pastikan mode `raster` MURNI (tanpa compute
      path aktif) masih tersedia sebagai fallback cepat — jangan sampai semua mode jadi bergantung
      compute shader, itu menghilangkan tujuan awal `raster` sebagai jalur ringan/fallback.

## Acceptance Test
1. Bounce ke-2 terukur biayanya lewat HUD Fase 5, dan ada keputusan tertulis (aktif default atau
   opsional) berdasar rasio gain-visual/biaya.
2. Kalau bridging rasterizer dikerjakan: mode `raster` dan `raytrace` menunjukkan pencahayaan yang
   VISUALLY KONSISTEN untuk scene yang sama (bukan identik piksel-per-piksel, tapi arah dan
   intensitas bayangan cocok) — screenshot berdampingan sebagai bukti.
