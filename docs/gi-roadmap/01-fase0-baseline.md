# Fase 0 — Baseline & Prasyarat

## Tujuan
Menutup celah struktural yang ada SEBELUM menambah kompleksitas GI, dan menyiapkan alat ukur
(debug view + scene uji tetap) yang akan dipakai di semua fase berikutnya.

## Prasyarat
Tidak ada. Ini titik mulai.

## Item Kerja

### 0.1 — Validasi kombinasi storage × render mode
**File:** `src/game/main.js`, `index.html`

**Masalah konkret:** hanya `BrickMapStorage.serialize()` yang ada (`src/core/voxel/BrickMapStorage.js:74`).
Kalau `renderMode==='raytrace'` tapi `storageType!=='brickmap'`, `mesher.worker.js` mengirim
`rtData: null`, dan `uploadChunkMesh` di `main.js:43` diam-diam skip upload.

**Implementasi konkret:**
```js
// main.js, di dalam buildWorld() sebelum memanggil pool.processAllChunks
async function buildWorld(storageType, terrainType, renderMode) {
  if (renderMode === 'raytrace' && storageType !== 'brickmap') {
    ui.fail(`Mode VoxelRT hanya mendukung storage 'brickmap'. ` +
            `Storage '${storageType}' tidak punya serialize().`);
    return;
  }
  // ... lanjut seperti biasa
}
```
Tambahkan juga guard yang sama di event listener `render-select` (baris ~93-101), karena
`buildWorld` dipanggil dari sana juga dengan `storageType` yang mungkin sudah tidak cocok.

**Alternatif (lebih ramah user):** auto-switch `storage-select` ke `brickmap` dan disable opsi
lain saat `render-select` diganti ke `raytrace`, daripada menampilkan error. Pilih salah satu —
dokumentasikan pilihannya di sini setelah diputuskan.

### 0.2 — Freelist brick pool untuk mode raytrace
**File:** `src/core/renderer/webgpu/compute_rt.js`

**Masalah konkret:** `createVoxelVolume()` (baris 94-139) selalu mengembalikan
`{ topGridBuffer: null, brickPoolBuffer: null }`. Observer `onRemove(VoxelVolume)` di
`components.js:71-76` memanggil `.destroy()` pada `null` — no-op. Brick yang dialokasikan lewat
`globalBrickCount++` tidak pernah dilepas.

**Kontrak Data — Freelist:**
```js
// Tambahan state di compute_rt.js, sejajar dengan globalBrickCount
let freeBrickList = [];        // stack of brick indices yang bisa dipakai ulang
```

**Implementasi konkret:**
```js
// Fungsi alokasi baru, gantikan pemakaian langsung `globalBrickCount++`
function allocBrick() {
  if (freeBrickList.length > 0) return freeBrickList.pop();
  return globalBrickCount++;
}

// Fungsi baru: dipanggil saat chunk (cx, cz) dihapus
function freeChunkVolume(cx, cz) {
  for (let sz = 0; sz < 2; sz++) {
    for (let sy = 0; sy < 5; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const gx = cx * 2 + sx, gz = cz * 2 + sz;
        const globalIdx = gx + sy * 12 + gz * 60;
        const brickId = globalTopGridData[globalIdx];
        if (brickId > 0) {
          freeBrickList.push(brickId);
          globalTopGridData[globalIdx] = 0;
          // Opsional: nol-kan brickPoolData di slot ini untuk mencegah data lama
          // "bocor" kalau brickId dipakai ulang sebelum di-overwrite penuh.
          globalBrickPoolData.fill(0, brickId * 512, brickId * 512 + 512);
        }
      }
    }
  }
  isTopGridDirty = true;
}
```
`createVoxelVolume` harus mengembalikan objek dengan `destroy: () => freeChunkVolume(cx, cz)`
(bind `cx, cz` lewat closure), bukan `destroy: () => {}`.

**Wiring ke ECS:** `VoxelVolume.topGridBuffer[eid]` di `components.js` saat ini menyimpan
`null`. Ganti pendekatan: simpan objek `volume` itu sendiri (bukan `.topGridBuffer`/`.brickPoolBuffer`
yang memang tidak relevan untuk mode raytrace), lalu observer memanggil `volume.destroy()`.
Ini perubahan kontrak component — sesuaikan `main.js:44-48` dan `components.js:71-76` bersamaan.

### 0.3 — Debug view mode di compute shader
**File:** `compute_rt.wgsl.js`, `compute_rt.js`

**Kontrak Data — Uniform tambahan:**
```wgsl
struct Camera {
  eye: vec4f,
  forward: vec4f,
  right: vec4f,
  up: vec4f,
  resolution: vec2f,
  debugMode: f32,   // 0=normal, 1=radiance only, 2=normal-as-color, 3=AO only
  padding: f32,
}
```
Di akhir `fn main()`, sebelum `textureStore`, cabang berdasarkan `camera.debugMode`:
```wgsl
if (camera.debugMode > 0.5 && camera.debugMode < 1.5) {
    color = vec3f(radiancePool[offset]); // grayscale radiance mentah
} else if (camera.debugMode > 1.5 && camera.debugMode < 2.5) {
    color = normal * 0.5 + 0.5; // normal sebagai warna
} else if (camera.debugMode > 2.5) {
    color = vec3f(ao);
}
```
Tambahkan `<select>` di `index.html` untuk memilih mode ini, di-passing lewat `uniformArray[18]`
(cek slot kosong di `compute_rt.js:202-208`, `uniformArray` punya 20 slot, baru terisi 0-17).

### 0.4 — Scene uji tetap
**File:** `src/game/world/chunk.js`, `index.html`

Tambahkan 3 `terrainType` baru di `generateChunkVoxels()`:

```js
else if (terrainType === 'gi-box') {
  // Kotak tertutup solid dengan 1 lubang 2x2 di langit-langit (y=CHUNK_SY-1)
  // untuk uji cahaya masuk & menyebar ke dinding yang tidak line-of-sight ke lubang.
  for (let y = 0; y < CHUNK_SY; y++) {
    const isShell = (x === 0 || x === CHUNK_SX-1 || z === 0 || z === CHUNK_SZ-1
                      || y === 0 || y === CHUNK_SY - 1);
    const isHole = (y === CHUNK_SY - 1 && x >= 7 && x <= 8 && z >= 7 && z <= 8);
    storage.set(x, y, z, (isShell && !isHole) ? BLOCK_IDS.STONE : BLOCK_IDS.AIR);
  }
}
else if (terrainType === 'gi-lshape') {
  // Terowongan L: lorong lurus dari (0,y,8) belok 90 derajat ke (8,y,15).
  // Titik di ujung lorong kedua TIDAK punya line-of-sight ke sumber cahaya
  // manapun kecuali lewat bounce.
}
else if (terrainType === 'gi-colorwall') {
  // Dua dinding solid berhadapan jarak 3 voxel, satu pakai BLOCK_IDS custom
  // "warna merah" (tambahkan entri baru di blocks.js kalau belum ada palet merah),
  // satunya putih/salju. Untuk uji color bleeding di Fase 2.
}
```
Cek `src/data/blocks.js` — kalau belum ada blok dengan warna merah solid di palet, tambahkan satu
(mis. `BLOCK_IDS.BRICK_RED`) supaya scene `gi-colorwall` valid.

## Kontrak Data (Ringkasan Fase Ini)
| Nama | Lokasi | Tipe | Catatan |
|---|---|---|---|
| `freeBrickList` | `compute_rt.js` (module scope) | `Array<number>` (JS heap, bukan GPU buffer) | Stack, LIFO |
| `Camera.debugMode` | uniform, slot `uniformArray[18]` | `f32` | 0-3 |

## Anti-Mock Checklist
- [ ] Pilih `octree` + `raytrace` di UI **sungguhan menampilkan error**, bukan layar kosong senyap.
- [ ] Buka chunk raytrace, tekan T berkali-kali, lalu cek `globalBrickCount` vs `freeBrickList.length`
      di console — total brick teralokasi tidak boleh terus naik tanpa batas untuk world ukuran tetap.
- [ ] Debug mode "radiance only" menunjukkan pola berbeda antara sisi yang kena matahari vs tidak
      (bukan warna solid rata satu ke seluruh layar — itu tanda uniform tidak ke-passing).
- [ ] Ketiga scene uji (`gi-box`, `gi-lshape`, `gi-colorwall`) bisa dipilih dan ter-render tanpa error,
      bahkan sebelum GI ada (di fase ini wajarnya masih terlihat "salah" — gelap total di area yang
      seharusnya nanti kena bounce).

## Acceptance Test
1. Pilih `Octree` + `VoxelRT` di UI → muncul pesan error, bukan world kosong.
2. Bangun 20 chunk, hapus 20 chunk (tombol T) bolak-balik 5 kali di mode raytrace → memori GPU
   (cek lewat `chrome://gpu` atau `performance.memory` proxy) tidak naik linear tanpa batas.
3. Ganti `debugMode` ke 1 (radiance) di scene `gi-box` → terlihat gradasi terang dekat lubang,
   gelap di sudut jauh (masih hard/biner di fase ini, itu wajar — akan diperbaiki Fase 1).
4. Load scene `gi-lshape` dan `gi-colorwall` tanpa crash/console error.

**Lanjut ke `02-fase1-direct-lighting.md` hanya jika keempat poin di atas lolos.**
