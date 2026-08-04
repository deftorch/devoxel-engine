# Fase 3 — Temporal Accumulation & Denoising

## Tujuan
Hasil cone-gather dari Fase 2 (5 cone/voxel) cukup bernoise di sudut tajam. Alih-alih menaikkan
jumlah cone (mahal), sebar biaya sampling lewat waktu — kualitas setara sample count lebih tinggi
tanpa biaya per-frame yang sama.

## Prasyarat
Fase 2 selesai dan Acceptance Test-nya lolos — temporal accumulation di atas hasil bounce yang
masih salah cuma akan "menstabilkan kesalahan", bukan memperbaikinya.

## Kontrak Data

### History buffer
```js
// compute_rt.js
let globalRadianceHistoryData = new Float32Array(50000 * 512 * 3); // rgb per voxel, frame sebelumnya
```
Disimpan terpisah dari `radianceIndirectPool` (yang jadi hasil frame SAAT INI sebelum blend) —
pola standar: baca history, blend dengan current, tulis hasil blend ke history untuk frame
berikutnya.

### Dirty/reset flag per voxel (ringkas)
Tidak perlu buffer baru — reuse mekanisme dirty brick dari Fase 0.2/0.4. Saat brick ditandai
dirty (diedit), history untuk voxel di brick itu di-reset ke 0 sebelum blend pertama.

## Item Kerja

### 3.1 — Blend temporal
**File:** `compute_rt.wgsl.js`, di akhir `bounce_gather`

```wgsl
const TEMPORAL_ALPHA = 0.08; // rasio "current" masuk ke history tiap frame

// Ganti baris terakhir bounce_gather:
let newIndirect = totalColor / 5.0;
let history = vec3f(radianceHistory[offset*3u], radianceHistory[offset*3u+1u], radianceHistory[offset*3u+2u]);
let blended = mix(history, newIndirect, TEMPORAL_ALPHA);
radianceIndirectPool[offset] = blended;
radianceHistory[offset*3u]    = blended.r;
radianceHistory[offset*3u+1u] = blended.g;
radianceHistory[offset*3u+2u] = blended.b;
```
`TEMPORAL_ALPHA = 0.08` adalah TITIK AWAL, bukan final — harus di-tuning dengan uji langsung:
alpha kecil = lebih stabil tapi lambat merespon perubahan cahaya; alpha besar = responsif tapi
noise kembali terlihat. Dokumentasikan nilai final + video/gif before-after saat tuning selesai.

### 3.2 — Reset history saat disoklusi (voxel diedit)
**File:** `compute_rt.wgsl.js`, `compute_rt.js`

Saat `editVoxel` dipanggil (lihat `05-fase4-realtime-edit.md` untuk mekanisme dirty tracking
lengkap — fase ini cuma butuh hook sederhana dulu):
```js
// compute_rt.js, di dalam editVoxel(), setelah update brickPoolData
const historyOffset = voxelOffset * 3;
globalRadianceHistoryData[historyOffset]     = 0;
globalRadianceHistoryData[historyOffset + 1] = 0;
globalRadianceHistoryData[historyOffset + 2] = 0;
// Tandai untuk di-upload ulang ke GPU (pola sama dengan dirtyBrickPoolQueue yang sudah ada)
```
Tanpa ini, voxel yang baru dibangun akan "mewarisi" history dari sebelum-diedit (biasanya 0 dari
inisialisasi, jadi kelihatan gelap sesaat sebelum accumulate naik lagi — beri catatan visual
"pop-in" ini sebagai known behavior, bisa diterima di fase ini).

### 3.3 — (Opsional, hanya jika noise masih kasar setelah 3.1) Spatial denoise ringan
**File:** `compute_rt.wgsl.js` (pass baru `spatial_denoise`)

Blur 3×3 di ruang voxel dengan bobot berdasar kesamaan normal, dipakai HANYA jika noise dari
Fase 2 masih terlihat mengganggu setelah temporal blend aktif:
```wgsl
fn spatialDenoise(x: i32, y: i32, z: i32, centerNormal: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  var weightSum = 0.0;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = x + dx; let nz = z + dz;
      let offset = getVoxelOffset(nx, y, nz);
      if (offset == 0xFFFFFFFFu) { continue; }
      let neighborNormal = estimateSurfaceNormal(nx, y, nz);
      let normalWeight = max(dot(centerNormal, neighborNormal), 0.0);
      sum += vec3f(radianceIndirectPool[offset]) * normalWeight; // perhatikan: radianceIndirectPool
                                                                   // perlu jadi vec3 per elemen, cek layout
      weightSum += normalWeight;
    }
  }
  return sum / max(weightSum, 0.001);
}
```
**Keputusan eksplisit yang harus diambil sebelum implementasi:** apakah pass ini jalan tiap frame
(cost tambahan tiap frame) atau cuma untuk brick yang baru selesai bounce-gather (dirty)? Default:
ikuti dirty tracking yang sama seperti pass lain.

## Anti-Mock Checklist
- [ ] Rekam video 5 detik kamera diam menghadap area indirect-lit — hitung variance piksel antar
      frame. Sebelum Fase 3: variance tinggi (flicker terlihat mata). Sesudah: mendekati nol.
- [ ] Gerakkan kamera cepat melewati area GI — pastikan TIDAK ada jejak "ghosting" (cahaya lama
      menempel di posisi yang sudah tidak seharusnya terang). Kalau ada, berarti reset disoklusi
      (3.2) belum benar atau kurang agresif.
- [ ] Ukur berapa cone per voxel yang bisa diturunkan (dari 5 ke berapa) di Fase 2 setelah
      temporal accumulation aktif TANPA kualitas visual terlihat turun — dokumentasikan angka ini,
      dipakai sebagai input tuning performa di Fase 5.

## Acceptance Test
1. Kamera diam 5 detik di scene `gi-box` → tidak ada flicker kasat mata di area indirect.
2. Kamera pan cepat (>90°/detik) melewati `gi-lshape` → tidak ada ghosting yang bertahan >0.5 detik.
3. Edit voxel (bangun/hancurkan) di dekat area GI → pencahayaan menyesuaikan dalam waktu wajar
   (idealnya <1 detik dengan `TEMPORAL_ALPHA` yang sudah di-tuning), tanpa "pop" yang sangat kasar.
4. Dokumentasikan: cone count final, `TEMPORAL_ALPHA` final, dan apakah spatial denoise (3.3)
   ternyata dibutuhkan atau tidak (dengan alasan).

**Lanjut ke `05-fase4-realtime-edit.md` hanya jika keempat poin di atas lolos.**
