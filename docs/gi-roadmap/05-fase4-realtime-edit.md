# Fase 4 — Update Real-time Saat Voxel Diedit

## Tujuan
Fase 1-3 diam-diam mengasumsikan `light_injection` + `bounce_gather` bisa dijalankan ulang penuh
tiap frame untuk seluruh dunia. Itu tidak scalable. Fase ini membangun **dirty tracking** supaya
hanya region yang benar-benar terdampak `editVoxel` yang dihitung ulang.

## Prasyarat
Fase 3 selesai. Fase ini murni soal *scheduling* komputasi yang sudah ada, bukan menambah
algoritma pencahayaan baru.

## Kontrak Data

### Dirty brick queue untuk GI (terpisah dari `dirtyBrickPoolQueue` yang sudah ada)
```js
// compute_rt.js — dirtyBrickPoolQueue yang sudah ada (baris 17) untuk UPLOAD DATA ke GPU.
// Ini BEDA: untuk menandai brick mana yang perlu di-RECOMPUTE (light_injection, mip, bounce).
let dirtyGIBrickSet = new Set(); // isi: brickId yang perlu direcompute frame ini/berikutnya
const GI_RECOMPUTE_BUDGET_PER_FRAME = 8; // brick, cek Fase 5 untuk tuning berbasis profiling
```

### Radius pengaruh bounce
Karena cone tracing Fase 2 punya jangkauan (`t > 24.0` di `coneTrace`, lihat `03-fase2`), edit di
1 brick bisa mempengaruhi bounce di brick TETANGGA dalam radius itu — bukan cuma brick yang
diedit sendiri.

## Item Kerja

### 4.1 — Tandai dirty saat `editVoxel`
**File:** `compute_rt.js`

```js
editVoxel(x, y, z, type) {
  // ... kode existing set voxel & dirtyBrickPoolQueue ...

  // BARU: tandai brick ini + brick tetangga dalam radius bounce sebagai dirty untuk GI
  const affectedRadius = 3; // dalam satuan brick (8 voxel), cek terhadap CONE jangkauan 24 voxel = 3 brick
  const gx = Math.floor(x / 8), gy = Math.floor(y / 8), gz = Math.floor(z / 8);
  for (let dz = -affectedRadius; dz <= affectedRadius; dz++) {
    for (let dy = -affectedRadius; dy <= affectedRadius; dy++) {
      for (let dx = -affectedRadius; dx <= affectedRadius; dx++) {
        const nx = gx+dx, ny = gy+dy, nz = gz+dz;
        if (nx<0||nx>=12||ny<0||ny>=5||nz<0||nz>=12) continue;
        const sectorIdx = nx + ny*12 + nz*60;
        const brickId = globalTopGridData[sectorIdx];
        if (brickId > 0) dirtyGIBrickSet.add(brickId);
      }
    }
  }
}
```
**Catatan:** radius 3-brick (~24 voxel) di semua arah untuk tiap edit itu berpotensi menandai
banyak brick sekaligus untuk edit tunggal. Ini trade-off sadar — kalau terlalu mahal di praktik,
turunkan radius dan terima sedikit "GI stale" di pinggir jangkauan cone sebagai kompromi
(dokumentasikan keputusan setelah diukur, jangan ditebak dari awal).

### 4.2 — Proses dirty queue dengan budget per frame
**File:** `compute_rt.js`, dalam `draw()`

```js
// Di dalam draw(), sebelum dispatch light_injection & bounce_gather:
if (dirtyGIBrickSet.size > 0) {
  const toProcess = Array.from(dirtyGIBrickSet).slice(0, GI_RECOMPUTE_BUDGET_PER_FRAME);
  toProcess.forEach(id => dirtyGIBrickSet.delete(id));

  // Dispatch light_injection & bounce_gather HANYA untuk brick di `toProcess`,
  // bukan seluruh 96x96 grid seperti sebelumnya. Ini butuh entry point WGSL varian
  // yang menerima daftar brick ID via buffer, bukan dispatch grid penuh berbasis x,z dunia.
  dispatchGIForBricks(pass, toProcess);
}
```
**Perubahan struktural yang diperlukan:** `light_injection` dan `bounce_gather` versi asli
(Fase 1-2) dispatch berdasarkan koordinat dunia `(x, z)` secara penuh. Untuk mendukung "hanya
brick tertentu", perlu varian shader yang menerima **daftar brick ID sebagai storage buffer**
input, lalu tiap workgroup memetakan dirinya ke 1 brick dari daftar itu — bukan ke koordinat
dunia langsung. Ini perubahan non-trivial pada struktur dispatch, rencanakan sebagai sub-task
tersendiri, bukan tempelan kecil di akhir fase.

### 4.3 — Rebuild mip chain mengikuti dirty set yang sama
**File:** `compute_rt.js`

`rebuild_mip_l1`/`rebuild_mip_l2` dari Fase 2 juga harus dipicu oleh `dirtyGIBrickSet` yang sama
(union dengan brick yang datanya benar-benar berubah dari `editVoxel`, bukan cuma brick tetangga
yang butuh recompute lighting). Pisahkan 2 kategori dirty:
- **`dirtyDataBrickSet`**: brick yang datanya (voxel) berubah → perlu rebuild mip.
- **`dirtyGIBrickSet`**: brick yang perlu recompute direct+indirect lighting (superset dari yang
  di atas, termasuk tetangga dalam radius bounce).

## Anti-Mock Checklist
- [ ] Instrumentasi counter: berapa brick diproses per frame saat idle (harus 0) vs saat editing
      aktif (harus ≤ `GI_RECOMPUTE_BUDGET_PER_FRAME`, bukan seluruh dunia terhitung ulang).
- [ ] Edit voxel jauh dari kamera (di luar frustum) → pastikan tetap masuk dirty queue dan
      diproses (bukan cuma yang kelihatan kamera) — GI harus tetap benar saat kamera berputar
      kembali ke area itu nanti, bukan cuma "kelihatan benar" karena kebetulan tidak pernah dilihat.
- [ ] Edit voxel massal (mis. simulasi ledakan, banyak `editVoxel` sekaligus dalam 1 frame) →
      frame time TIDAK melonjak drastis; budget per frame benar-benar membatasi, sisa pekerjaan
      diproses bertahap di frame-frame berikutnya (verifikasi lewat counter dari poin pertama).

## Acceptance Test
1. Bangun/hancurkan 1 voxel di scene `gi-box` → pencahayaan sekitarnya (radius sesuai 4.1)
   ter-update dalam ≤ beberapa frame, area jauh di luar radius TIDAK ikut dihitung ulang
   (buktikan lewat counter, bukan cuma "kelihatan benar").
2. Simulasikan 50 edit voxel berturut-turut dalam 1 frame (loop `editVoxel` di console) → frame
   time tidak melonjak lebih dari budget yang ditentukan; sisa dirty diproses di frame berikutnya.
3. Edit voxel di luar frustum kamera, putar kamera balik ke sana setelah beberapa detik →
   pencahayaan sudah benar (bukan masih menunggu "dilihat" dulu baru dihitung).

**Lanjut ke `06-fase5-performance.md` hanya jika ketiga poin di atas lolos.**
