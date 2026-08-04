# Fase 2 — Single-Bounce Indirect Lighting (Voxel Cone Tracing)

**Ini fase paling kompleks di seluruh roadmap.** Titik di mana sistem baru sah disebut GI
(indirect/bounce lighting sungguhan mulai ada).

## Tujuan
Voxel permukaan yang tidak punya line-of-sight langsung ke matahari tetap menerima cahaya lewat
1 kali pantulan dari voxel tetangga yang lit.

## Prasyarat
Fase 1 selesai — `radiancePool` (direct) harus sudah kontinu & akurat, karena bounce di fase ini
membaca nilai itu sebagai sumber energi.

## Kontrak Data

### Mip chain brick (baru)
Alasan perlu mip: cone tracing yang men-sample voxel individual (8³ per brick) untuk setiap
langkah march akan sangat lambat. Mip level lebih kasar dipakai untuk langkah jauh, mip halus
untuk langkah dekat permukaan — pola standar cone tracing.

```
Level 0: brickPool asli, 8x8x8 voxel/brick (SUDAH ADA)
Level 1: downsample 4x4x4 per brick — 1 sel = rata-rata 2x2x2 voxel level 0
Level 2: downsample 2x2x2 per brick — 1 sel = rata-rata 2x2x2 sel level 1
```

**Ukuran buffer:**
```js
// compute_rt.js — tambahan di samping globalBrickPoolData
// Tiap sel mip menyimpan: occupancy (0-1 float) + warna rata-rata (rgb) = 4 float = 16 byte
let globalMipL1Data = new Float32Array(50000 * (4*4*4) * 4); // 50000 brick slot x 64 sel x 4 float
let globalMipL2Data = new Float32Array(50000 * (2*2*2) * 4); // 50000 brick slot x 8 sel x 4 float
```
**Catatan:** ini menambah ~410MB (L1) + ~51MB (L2) di atas alokasi yang sudah ada
(`brickPool` 50000*512 = 25.6MB, `radiancePool` 50000*512*4 = 102MB). Total GPU memory footprint
jadi signifikan. **Wajib** dicek terhadap batas `maxStorageBufferBindingSize` device sebelum
alokasi — kalau device tidak sanggup, turunkan `50000` slot brick jadi lebih kecil dulu (world
lebih kecil) daripada silent-fail.

**Rebuild trigger:** mip chain di-rebuild PER-BRICK, hanya untuk brick yang dirty (baru
diserialisasi atau diedit), lewat compute pass terpisah `rebuild_mip` — bukan setiap frame untuk
semua brick.

### `radiancePool` dipecah jadi 2 komponen
```wgsl
// Alih-alih 1 float per voxel, sekarang 2:
// radiancePool[offset]         = direct visibility (sudah ada dari Fase 1)
// radianceIndirectPool[offset] = hasil cone-gather (BARU)
```
```js
let globalRadianceIndirectData = new Float32Array(50000 * 512); // buffer storage baru, terpisah
```
Dipisah (bukan ditimpa/dijumlah langsung di buffer yang sama) supaya debug mode Fase 0.3 bisa
menampilkan direct-only vs indirect-only secara independen — kalau digabung dari awal, tidak
bisa didiagnosis komponen mana yang salah saat hasil akhir aneh.

## Item Kerja

### 2.1 — Compute pass `rebuild_mip`
**File:** `compute_rt.wgsl.js` (entry point baru), `compute_rt.js`

```wgsl
@compute @workgroup_size(4, 4, 4)
fn rebuild_mip_l1(@builtin(global_invocation_id) id: vec3u) {
  // Dipanggil per-brick yang dirty. id.xyz = koordinat sel L1 (4x4x4) dalam 1 brick.
  // brickId di-passing lewat uniform/push constant terpisah (1 brick per dispatch).
  let baseX = id.x * 2u; let baseY = id.y * 2u; let baseZ = id.z * 2u;
  var occupancy = 0.0;
  var colorSum = vec3f(0.0);
  for (var dz = 0u; dz < 2u; dz++) {
    for (var dy = 0u; dy < 2u; dy++) {
      for (var dx = 0u; dx < 2u; dx++) {
        let voxel = getVoxel(i32(baseX+dx), i32(baseY+dy), i32(baseZ+dz)); // relatif ke origin brick
        if (voxel > 0u) {
          occupancy += 1.0;
          colorSum += voxelIdToColor(voxel); // fungsi lookup warna dari block id, buat baru
        }
      }
    }
  }
  let cellIdx = id.x + id.y*4u + id.z*16u;
  let outOffset = (currentBrickId * 64u + cellIdx) * 4u;
  mipL1[outOffset + 0u] = occupancy / 8.0; // 0.0-1.0
  mipL1[outOffset + 1u] = colorSum.r / max(occupancy, 1.0);
  mipL1[outOffset + 2u] = colorSum.g / max(occupancy, 1.0);
  mipL1[outOffset + 3u] = colorSum.b / max(occupancy, 1.0);
}
```
`rebuild_mip_l2` sama polanya, membaca dari `mipL1` bukan voxel mentah. Fungsi `voxelIdToColor`
harus dibuat konsisten dengan palet yang sudah ada di `fn main()` baris 189-193 (`BLOCK_IDS` 1-4
→ RGB) — idealnya di-refactor jadi 1 fungsi dipakai di kedua tempat, bukan diduplikasi.

### 2.2 — Cone sampling kernel (cosine-weighted hemisphere)
**File:** `compute_rt.wgsl.js`

Gunakan kernel tetap (bukan random) supaya deterministik dan gampang di-debug — 5 arah cone
relatif terhadap normal permukaan `N`:
```wgsl
// 5 arah cone dalam koordinat lokal (Z = arah normal), cosine-weighted,
// sudut cone masing-masing ~30 derajat (setengah-sudut) untuk cakupan hemisphere yang wajar.
const CONE_DIR_LOCAL = array<vec3f, 5>(
  vec3f(0.0, 0.0, 1.0),                  // lurus ke depan normal
  vec3f(0.707, 0.0, 0.707),
  vec3f(-0.707, 0.0, 0.707),
  vec3f(0.0, 0.707, 0.707),
  vec3f(0.0, -0.707, 0.707),
);
const CONE_APERTURE = 0.577; // tan(30 deg), menentukan seberapa cepat radius cone membesar per jarak

fn buildTangentBasis(N: vec3f) -> mat3x3f {
  let up = select(vec3f(0,1,0), vec3f(1,0,0), abs(N.y) > 0.99);
  let T = normalize(cross(up, N));
  let B = cross(N, T);
  return mat3x3f(T, B, N);
}
```

### 2.3 — Fungsi cone march terhadap mip chain
**File:** `compute_rt.wgsl.js`

```wgsl
fn coneTrace(origin: vec3f, dir: vec3f, aperture: f32) -> vec3f {
  var t = 1.0; // mulai sedikit di depan permukaan, hindari self-intersect
  var accumColor = vec3f(0.0);
  var accumAlpha = 0.0;
  for (var i = 0; i < 16; i++) {
    if (accumAlpha >= 0.95) { break; } // early-out, sudah cukup buram/tersaturasi
    let coneRadius = t * aperture;
    let samplePos = origin + dir * t;

    // Pilih mip level berdasar radius cone dibanding ukuran sel voxel
    var occupancy: f32; var color: vec3f;
    if (coneRadius < 1.0) {
      occupancy = sampleVoxelOccupancy(samplePos); color = sampleVoxelColor(samplePos); // level 0
    } else if (coneRadius < 2.0) {
      occupancy = sampleMipL1(samplePos); color = sampleMipL1Color(samplePos);
    } else {
      occupancy = sampleMipL2(samplePos); color = sampleMipL2Color(samplePos);
    }

    let stepSize = max(coneRadius, 0.5);
    let a = occupancy * (1.0 - accumAlpha);
    accumColor += color * a * getDirectRadianceAt(samplePos); // kalikan dgn direct light di titik itu
    accumAlpha += a;
    t += stepSize;
    if (t > 24.0) { break; } // batas jarak cone, dunia kecil jadi cukup
  }
  return accumColor;
}
```
`getDirectRadianceAt(samplePos)` membaca `radiancePool` (dari Fase 1) di posisi voxel terdekat —
ini yang membuat bounce "membawa" energi dari voxel yang benar-benar disinari matahari, bukan
sekadar occupancy kosong.

### 2.4 — Pass `bounce_gather`
**File:** `compute_rt.wgsl.js` (entry point baru), dijalankan setelah `light_injection`

```wgsl
@compute @workgroup_size(8, 8, 1)
fn bounce_gather(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x); let z = i32(id.y);
  if (x >= 96 || z >= 96) { return; }
  for (var y = 0; y < 40; y++) {
    let offset = getVoxelOffset(x, y, z);
    if (offset == 0xFFFFFFFFu) { continue; }
    if (getVoxel(x, y, z) == 0u) { continue; }

    // Ambil normal permukaan: sisi mana yang menghadap udara (cek 6 tetangga)
    let N = estimateSurfaceNormal(x, y, z); // fungsi baru, cek 6 arah cari yang voxel==0
    if (length(N) < 0.1) { radianceIndirectPool[offset] = vec3f(0.0); continue; } // voxel terkubur penuh

    let basis = buildTangentBasis(N);
    let surfacePos = vec3f(f32(x), f32(y), f32(z)) + vec3f(0.5) + N * 0.5;

    var totalColor = vec3f(0.0);
    for (var i = 0; i < 5; i++) {
      let worldDir = basis * CONE_DIR_LOCAL[i];
      totalColor += coneTrace(surfacePos, worldDir, CONE_APERTURE);
    }
    radianceIndirectPool[offset] = totalColor / 5.0;
  }
}
```

### 2.5 — Composite di shading akhir
**File:** `compute_rt.wgsl.js`, `fn main()`

```wgsl
let directTerm = shadow * sun.color.rgb; // shadow dari radiancePool (Fase 1)
let indirectTerm = radianceIndirectPool[offset] * INDIRECT_BOOST; // konstanta tuning, mulai dari 1.0
color = color * (ambient + directTerm + indirectTerm) * ao;
```
`INDIRECT_BOOST` adalah konstanta yang WAJIB di-tuning visual di scene `gi-box` — dokumentasikan
nilai final beserta alasan (mis. "1.5, karena di bawah itu efek bounce nyaris tidak terlihat, di
atas 2.5 area gelap jadi tidak natural terang").

## Anti-Mock Checklist
- [ ] Matikan `directTerm` sementara (set ke 0 secara manual) di scene `gi-box` — kalau area dekat
      lubang cahaya MASIH terlihat sedikit terang, berarti `indirectTerm` sungguhan berkontribusi,
      bukan cuma dijumlah tapi bernilai nol karena bug.
  - [ ] Ganti warna dinding di `gi-colorwall` jadi merah solid, screenshot dinding putih di
      dekatnya — ada rona kemerahan tipis (color bleeding) yang HILANG kalau dinding merah
      dijauhkan >5 voxel (radius cone terbatas, harus ada attenuasi jarak yang masuk akal).
- [ ] `rebuild_mip` dipanggil HANYA untuk brick dirty — instrumentasi counter jumlah brick yang
      di-rebuild per frame, harus 0 di frame steady-state tanpa edit.

## Acceptance Test
1. Scene `gi-box`: bagian dalam kotak yang tidak line-of-sight ke lubang tapi dekat area yang
   lit menunjukkan pencahayaan non-nol yang terlihat masuk akal (bukan hitam pekat seperti Fase 1).
2. Scene `gi-lshape`: ujung terowongan setelah belokan 90° menerima sedikit cahaya (mustahil di
   Fase 1, karena tidak ada line-of-sight langsung ke matahari sama sekali di titik itu).
3. Scene `gi-colorwall`: color bleeding kelihatan dan melemah sesuai jarak — didokumentasikan
   dengan screenshot jarak 2, 5, 10 voxel untuk menunjukkan falloff yang wajar.
4. Frame time indirect pass didokumentasikan (belum perlu optimal — itu baru Fase 3/5) sebagai
   baseline pembanding sebelum temporal accumulation masuk.

**Lanjut ke `04-fase3-temporal-denoise.md` hanya jika keempat poin di atas lolos.**
