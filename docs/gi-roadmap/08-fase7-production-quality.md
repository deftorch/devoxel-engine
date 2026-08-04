# Fase 7 (Opsional) — Menuju Kualitas Produksi

Fase ini menjawab pertanyaan "apakah ini setara engine profesional?" — item-item di sini yang
membedakan prototype teknis dari fitur yang siap dipakai pemain sungguhan. Bisa dikerjakan
paralel dengan Fase 6 (tidak saling bergantung), tapi **prioritaskan 7.1 (emissive)** kalau target
akhirnya game voxel gaya Minecraft — obor/lava adalah fitur gameplay inti, bukan nice-to-have.

## Prasyarat
Fase 5 selesai minimal (profiling & quality tier). Fase 6 tidak wajib.

## 7.1 — Emissive Voxel Sebagai Sumber Cahaya (PRIORITAS TERTINGGI di fase ini)

**Kenapa prioritas:** game voxel tanpa obor/lava sebagai sumber cahaya kehilangan gameplay loop
penting (build shelter + light di malam hari). Ini lebih penting secara gameplay dibanding
specular reflection.

**Kontrak Data:**
```js
// src/data/blocks.js — tambahkan field emissive ke definisi block
export const BLOCK_COLORS_BY_ID = {
  // ... existing entries
  [BLOCK_IDS.TORCH]: { top: [1.0, 0.8, 0.3], side: [1.0, 0.8, 0.3], emissive: 2.5 },
  [BLOCK_IDS.LAVA]:  { top: [1.0, 0.4, 0.1], side: [1.0, 0.4, 0.1], emissive: 4.0 },
};
```
```js
// compute_rt.js — daftar posisi voxel emissive, di-maintain terpisah dari brickPool
// (supaya tidak perlu scan seluruh dunia tiap frame cari mana yang emissive)
let emissiveVoxelList = []; // [{x,y,z,color,intensity}, ...]
```

**Implementasi:**
1. Saat `editVoxel(x,y,z,type)` dipanggil dengan `type` yang emissive (cek dari `BLOCK_COLORS_BY_ID[type].emissive`),
   tambahkan/hapus entry di `emissiveVoxelList`.
2. Pass baru `emissive_injection` (dijalankan bersamaan `light_injection`): untuk tiap voxel di
   `emissiveVoxelList`, tulis `radiancePool[offset] += emissive.intensity * emissive.color` pada
   voxel itu sendiri, LALU biarkan `bounce_gather` (Fase 2) menyebarkannya secara alami lewat cone
   tracing yang sudah ada — **tidak perlu algoritma baru**, cukup titik emisi tambahan sebagai
   sumber energi.
3. Perhatikan falloff jarak: cahaya obor harus melemah dengan jarak (inverse-square atau linear
   sederhana untuk voxel), beda dengan matahari yang directional infinite. Cone tracing di Fase 2
   sudah men-sample `getDirectRadianceAt` di sepanjang march — pastikan fungsi itu memperhitungkan
   jarak ke sumber emissive, bukan cuma occupancy.

**Anti-Mock Checklist khusus item ini:**
- [ ] Taruh 1 obor di ruangan gelap tertutup (`gi-box` tanpa lubang atap) → ruangan jadi terang
      TANPA matahari sama sekali. Kalau masih gelap total, emissive tidak benar-benar terhubung
      ke `bounce_gather`.
- [ ] Hapus obor → cahaya hilang dalam waktu wajar (mengikuti dirty tracking Fase 4, bukan instan
      atau malah permanen menyala/leak seperti bug freelist di Fase 0).

## 7.2 — Screen-Space Reflection (SSR) sebagai layer tambahan

Untuk permukaan mengkilap (air, es, logam) — cone tracing diffuse dari Fase 2 tidak menangani
refleksi tajam dengan baik (cone terlalu lebar). SSR lebih murah dan cukup untuk kebanyakan kasus.

**Implementasi (ringkas — ini pass rendering tambahan, bukan perluasan GI compute):**
1. Setelah `main()` (primary raymarch) selesai, untuk voxel dengan material reflektif (perlu field
   `reflectivity` baru di `BLOCK_COLORS_BY_ID`), pantulkan `rd` terhadap normal permukaan, lakukan
   1x raymarch tambahan (reuse DDA yang sama, `shadowRayDDA`-style tapi ambil warna bukan cuma
   hit/miss) sepanjang arah pantul.
2. Kalau ray keluar dunia atau iterasi habis tanpa hit → fallback ke warna langit (`skyColor`),
   bukan hitam.

**Definition of done:** permukaan air/es di scene uji menunjukkan pantulan kasar dari geometri
sekitarnya (tidak perlu sempurna — SSR punya keterbatasan inheren, tidak bisa refleksi objek di
luar frame kamera, itu wajar dan harus didokumentasikan sebagai limitation, bukan bug).

## 7.3 — Tone Mapping & Exposure

**Masalah konkret yang akan muncul begitu emissive (7.1) aktif:** nilai radiance dari sumber
emissive kuat (`intensity=4.0` untuk lava) bisa dengan mudah melebihi 1.0, menyebabkan clipping
warna yang terlihat murah/pecah kalau langsung di-`textureStore` tanpa tone mapping.

**Implementasi:**
```wgsl
fn acesFilm(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), vec3f(0.0), vec3f(1.0));
}
// Di akhir fn main(), sebelum textureStore:
color = acesFilm(color * exposure); // exposure = uniform, default 1.0, adjustable
```
Tambahkan `exposure` sebagai uniform (bisa di-expose ke UI sebagai slider) — jangan hardcode.

**Anti-Mock Checklist:** nyalakan lava/obor sangat dekat kamera → warna TIDAK pecah jadi putih
solid mentah; ada roll-off natural di area sangat terang (ciri khas tone mapping yang jalan).

## 7.4 — Automated Visual Regression Testing

Studio profesional tidak memverifikasi GI dengan mata tiap kali ada perubahan kode — ada test
otomatis yang membandingkan screenshot terhadap baseline.

**Implementasi minimal (tanpa infrastruktur CI kompleks):**
1. Script Node/Puppeteer yang membuka `index.html`, load salah satu scene uji tetap (`gi-box`,
   dll dari Fase 0), tunggu N frame stabil (history buffer Fase 3 konvergen), screenshot canvas
   via `canvas.toDataURL()`.
2. Bandingkan pixel-diff terhadap baseline image yang disimpan di repo (`tests/gi-baselines/`),
   pakai library sederhana seperti `pixelmatch`. Fail kalau diff melebihi threshold (mis. >2%
   piksel berbeda >10 unit warna — angka ini perlu dikalibrasi, mulai longgar lalu diperketat).
3. Jalankan script ini di setiap perubahan menyentuh file GI (`compute_rt.wgsl.js`, `compute_rt.js`)
   — manual dulu (`npm run test:visual`), baru diintegrasikan ke CI kalau proyek sudah punya
   pipeline CI (belum ada bukti proyek ini punya CI dari struktur yang di-upload — cek dulu
   sebelum berasumsi).

**Definition of done:** ada minimal 3 baseline image (satu per scene uji), dan skenario "sengaja
merusak" satu parameter GI (mis. matikan bounce) BERHASIL terdeteksi oleh script diff sebagai
regression — ini pembuktian bahwa test-nya benar-benar sensitif, bukan cuma ada tapi tidak
pernah gagal.

## Ringkasan Prioritas Fase 7
Kalau waktu terbatas, urutan pengerjaan yang disarankan:
1. **7.1 Emissive** — dampak gameplay langsung, paling terasa oleh pemain.
2. **7.3 Tone mapping** — murah diimplementasi, mencegah 7.1 terlihat murah/pecah.
3. **7.4 Automated testing** — investasi jangka panjang, mencegah regresi diam-diam di fase-fase
   sebelumnya saat refactor.
4. **7.2 SSR** — nice-to-have visual, paling bisa ditunda tanpa dampak gameplay.
