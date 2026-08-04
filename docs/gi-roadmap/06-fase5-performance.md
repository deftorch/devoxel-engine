# Fase 5 — Performa & Kualitas Produksi

## Tujuan
Mengubah "kelihatan lancar di laptop saya" jadi angka konkret yang bisa diaudit, plus mekanisme
otomatis untuk menjaga frame rate saat beban GI melebihi budget.

## Prasyarat
Fase 4 selesai — profiling sebelum dirty tracking ada tidak berguna (semua akan terlihat "lambat"
karena recompute penuh tiap frame, bukan gambaran kondisi nyata).

## Kontrak Data

### Query set untuk timestamp GPU
```js
// compute_rt.js
const querySet = device.createQuerySet({ type: 'timestamp', count: 8 });
// Slot: 0=start light_injection, 1=end light_injection, 2=start bounce_gather,
//       3=end bounce_gather, 4=start denoise, 5=end denoise, 6=start main, 7=end main
const queryResolveBuffer = device.createBuffer({
  size: 8 * 8, // 8 timestamp x 8 byte (u64)
  usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
});
const queryReadBuffer = device.createBuffer({
  size: 8 * 8,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
```
**Prasyarat device:** fitur `timestamp-query` harus diminta eksplisit saat
`adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })` — cek dukungan lewat
`adapter.features.has('timestamp-query')` dan sediakan fallback (profiling manual pakai
`performance.now()` di sisi JS, kurang akurat tapi tetap berguna) untuk device yang tidak
mendukung.

### Quality tier state
```js
let currentQualityTier = 2; // 0=low, 1=medium, 2=high — index ke tabel di bawah
const QUALITY_TIERS = [
  { coneCount: 2, mipMaxLevel: 1, shadowSamples: 1, giUpdateBudget: 4 },  // low
  { coneCount: 3, mipMaxLevel: 2, shadowSamples: 2, giUpdateBudget: 6 },  // medium
  { coneCount: 5, mipMaxLevel: 2, shadowSamples: 4, giUpdateBudget: 8 },  // high
];
let frameTimeHistory = []; // rolling window, mis. 30 frame terakhir
```

## Item Kerja

### 5.1 — Instrumentasi timestamp per pass
**File:** `compute_rt.js`

```js
pass.writeTimestamp(querySet, 0);
pass.setPipeline(lightInjectionPipeline);
pass.dispatchWorkgroups(...);
pass.writeTimestamp(querySet, 1);

pass.setPipeline(bounceGatherPipeline);
pass.writeTimestamp(querySet, 2);
pass.dispatchWorkgroups(...);
pass.writeTimestamp(querySet, 3);
// ... dst untuk denoise & main raymarch

pass.end();
encoder.resolveQuerySet(querySet, 0, 8, queryResolveBuffer, 0);
encoder.copyBufferToBuffer(queryResolveBuffer, 0, queryReadBuffer, 0, 64);
```
Baca hasil secara ASYNC (jangan blocking main thread): `queryReadBuffer.mapAsync(GPUMapMode.READ)`
di frame N+2 atau N+3 (GPU timestamp query butuh beberapa frame delay sebelum data siap dibaca
tanpa stall) — dokumentasikan delay yang dipakai setelah diuji, karena ini bervariasi antar driver.

### 5.2 — Tampilkan breakdown di HUD
**File:** `src/game/ui/UIManager.js`

Tambahkan baris di HUD yang sudah ada (`updateHUD` menerima `benchmarkStats` — extend struktur ini):
```
Light Injection: 0.8ms | Bounce Gather: 2.1ms | Denoise: 0.4ms | Raymarch: 3.2ms | Total GI: 3.3ms
```
Ini WAJIB terlihat di HUD produksi (bisa toggle show/hide), bukan cuma console.log — supaya siapa
pun yang menjalankan build bisa langsung lihat breakdown tanpa buka DevTools.

### 5.3 — Frame budget & adaptive quality
**File:** `compute_rt.js`

```js
const GI_FRAME_BUDGET_MS = 3.0; // target: GI tidak boleh makan lebih dari 3ms di frame 16.6ms (60fps)

function updateQualityTier(giFrameTimeMs) {
  frameTimeHistory.push(giFrameTimeMs);
  if (frameTimeHistory.length > 30) frameTimeHistory.shift();
  if (frameTimeHistory.length < 30) return; // tunggu window penuh dulu

  const avg = frameTimeHistory.reduce((a,b) => a+b, 0) / frameTimeHistory.length;
  if (avg > GI_FRAME_BUDGET_MS * 1.2 && currentQualityTier > 0) {
    currentQualityTier--;
    frameTimeHistory = []; // reset window setelah perubahan tier, hindari oscillation
    console.warn(`[GI] Turun ke quality tier ${currentQualityTier} (avg ${avg.toFixed(2)}ms)`);
  } else if (avg < GI_FRAME_BUDGET_MS * 0.7 && currentQualityTier < QUALITY_TIERS.length - 1) {
    currentQualityTier++;
    frameTimeHistory = [];
    console.warn(`[GI] Naik ke quality tier ${currentQualityTier} (avg ${avg.toFixed(2)}ms)`);
  }
}
```
Parameter `coneCount`, `shadowSamples`, dll dari `QUALITY_TIERS[currentQualityTier]` di-passing ke
shader lewat uniform (bukan hardcode konstanta `const` WGSL seperti di draft Fase 1-2 — perlu
refactor `CONE_DIR_LOCAL` dkk supaya jumlahnya bisa dipotong secara dinamis berdasarkan uniform,
misal selalu alokasikan array 5 tapi loop cuma sampai `min(coneCount, 5)`).

**Indikator di HUD:** tampilkan tier aktif (`Low/Medium/High`) supaya user/QA tahu kenapa kualitas
visual berubah saat frame rate turun — jangan biarkan perubahan ini senyap.

### 5.4 — Uji di hardware kelas bawah
Tidak ada kode untuk item ini — ini murni proses validasi:
- [ ] Jalankan di GPU integrated (Intel Iris/UHD, atau setara) selain GPU discrete.
- [ ] Catat quality tier yang stabil dicapai secara otomatis di tiap kelas hardware.
- [ ] Kalau tier "low" MASIH tidak sanggup 60fps di hardware rendah, itu sinyal perlu tier
      ke-4 (`disabled` — GI mati total, fallback ke ambient statis dari rasterizer) — tambahkan
      eksplisit ke `QUALITY_TIERS` kalau memang dibutuhkan setelah pengujian.

## Anti-Mock Checklist
- [ ] Paksa `GI_FRAME_BUDGET_MS` jadi sangat kecil (mis. 0.1ms) sementara untuk testing → tier
      HARUS turun ke `low` secara otomatis dalam <1 detik, bukan macet di tier tinggi.
- [ ] Breakdown HUD menunjukkan angka yang BERUBAH sesuai kompleksitas scene (scene kosong vs
      scene padat voxel) — kalau angkanya statis/tidak berubah, berarti query timestamp tidak
      benar-benar terhubung ke pass yang sebenarnya.
- [ ] Cek tidak ada oscillation cepat naik-turun tier tiap beberapa detik (tanda `GI_FRAME_BUDGET_MS`
      terlalu ketat relatif terhadap noise pengukuran) — window 30 frame + reset setelah perubahan
      seharusnya mencegah ini, verifikasi dengan mengamati log selama 1 menit.

## Acceptance Test
1. HUD menampilkan breakdown ms per pass yang masuk akal (total pass GI + raymarch ≈ total
   frame time yang diukur `requestAnimationFrame`, dengan toleransi wajar).
2. Turunkan resolusi window drastis (naikkan beban raymarch) → tier otomatis turun, breakdown HUD
   mengonfirmasi `Bounce Gather` waktunya berkurang setelah tier turun.
3. Uji di 2 kelas hardware berbeda (kalau tersedia) → dokumentasikan tier stabil masing-masing
   sebagai baseline untuk keputusan target minimum spec proyek.

**Lanjut ke `07-fase6-multibounce-raster.md` (opsional) atau `08-fase7-production-quality.md`
(opsional) sesuai prioritas — keduanya independen satu sama lain, boleh dikerjakan paralel oleh
anggota tim berbeda kalau ada.**
