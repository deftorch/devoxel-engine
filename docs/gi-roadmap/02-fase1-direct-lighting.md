# Fase 1 — Direct Lighting yang Akurat (Prasyarat Kualitas GI)

## Tujuan
Mengganti `light_injection` yang saat ini biner-per-kolom-vertikal menjadi shadow ray sungguhan
ke arah matahari, dengan hasil kontinu 0.0-1.0 (bukan 0 atau 1 saja), plus soft penumbra.

## Prasyarat
Fase 0 selesai — khususnya item 0.3 (debug view) dan 0.4 (scene uji) WAJIB ada, karena fase ini
tidak bisa divalidasi tanpa keduanya.

## Masalah Pada Implementasi Saat Ini
`compute_rt.wgsl.js`, fungsi `light_injection` (baris 51-77):
```wgsl
for (var y = 39; y >= 0; y--) {
    ...
    if (voxel > 0u) {
        if (!hitSun) { radiancePool[offset] = 1.0; hitSun = true; }
        else { radiancePool[offset] = 0.0; }
    }
}
```
Tiga masalah: (1) arah selalu lurus ke bawah, tidak mengikuti `sunDir` aktual yang dipakai di
`fn main()` baris 186 (`normalize(vec3f(1.0, 1.0, 0.5))`) — jadi shadow dan sun direction di
shading TIDAK KONSISTEN dengan cara cahaya "diinjeksi"; (2) hasil biner, tidak ada penumbra;
(3) permukaan vertikal (dinding) tidak pernah dapat direct light sama sekali karena ray selalu
vertikal.

## Kontrak Data

### Uniform baru: arah matahari eksplisit
```wgsl
struct Camera {
  eye: vec4f,
  forward: vec4f,
  right: vec4f,
  up: vec4f,
  resolution: vec2f,
  debugMode: f32,
  padding: f32,
}
struct SunUniform {
  direction: vec4f,   // xyz = arah normalisasi MENUJU matahari, w = unused
  color: vec4f,       // xyz = warna/intensitas, w = unused
}
```
Tambahkan sebagai binding baru: `@group(0) @binding(5) var<uniform> sun: SunUniform;`. Di JS
(`compute_rt.js`), buat buffer 32 byte terpisah, di-update dari `main.js` (bukan hardcode di
shader) supaya sudut matahari bisa diubah live untuk keperluan testing.

### `radiancePool` — semantik diubah
Sebelumnya: `0.0` atau `1.0` saja. **Baru:** float kontinu `[0.0, 1.0]` = fraksi visibility ke
matahari (1.0 = full lit, 0.0 = full shadow, di antaranya = penumbra). Ukuran buffer tidak
berubah (`50000 * 512` floats, sudah cukup untuk semantik baru ini).

## Item Kerja

### 1.1 — Ganti arah shadow ray jadi mengikuti `sunDir`
**File:** `compute_rt.wgsl.js`

Pass `light_injection` sekarang harus jalan **per-voxel permukaan** (bukan per-kolom), karena
arah shadow ray bisa miring. Ini mengubah dispatch grid dari `(96/8, 96/8)` 2D jadi 3D atau tetap
per-kolom tapi shadow ray dari titik permukaan yang ditemukan (bukan dari "atas ke bawah" secara
harfiah):

```wgsl
@compute @workgroup_size(8, 8, 1)
fn light_injection(@builtin(global_invocation_id) id: vec3u) {
   let x = i32(id.x);
   let z = i32(id.y);
   if (x >= 96 || z >= 96) { return; }

   for (var y = 0; y < 40; y++) {
       let offset = getVoxelOffset(x, y, z);
       if (offset == 0xFFFFFFFFu) { continue; }
       let voxel = getVoxel(x, y, z);
       if (voxel == 0u) { continue; }

       // Titik permukaan: pusat voxel + sedikit offset ke arah sun untuk hindari self-shadowing
       let surfacePos = vec3f(f32(x), f32(y), f32(z)) + vec3f(0.5) + sun.direction.xyz * 0.5;
       radiancePool[offset] = shadowRayDDA(surfacePos, sun.direction.xyz);
   }
}
```

Buat fungsi `shadowRayDDA` terpisah — **gunakan ulang logika DDA yang sudah ada di `fn main()`**
(baris 89-179), tapi versi ringkas yang cuma butuh hit/miss, bukan kalkulasi warna:
```wgsl
fn shadowRayDDA(ro: vec3f, rd: vec3f) -> f32 {
  var mapPos = vec3i(floor(ro));
  let deltaDist = abs(vec3f(1.0) / rd);
  let rayStep = vec3i(sign(rd));
  var sideDist = (sign(rd) * (vec3f(mapPos) - ro) + (sign(rd) * 0.5) + 0.5) * deltaDist;

  for (var i = 0; i < 80; i++) { // batas lebih pendek dari primary ray (cukup sampai keluar chunk)
    if (mapPos.y >= 40 || mapPos.y < 0) { return 1.0; } // keluar dunia ke atas/bawah = kena matahari
    if (getVoxel(mapPos.x, mapPos.y, mapPos.z) > 0u) { return 0.0; } // tertutup
    if (sideDist.x <= sideDist.y && sideDist.x <= sideDist.z) {
      sideDist.x += deltaDist.x; mapPos.x += rayStep.x;
    } else if (sideDist.y <= sideDist.z) {
      sideDist.y += deltaDist.y; mapPos.y += rayStep.y;
    } else {
      sideDist.z += deltaDist.z; mapPos.z += rayStep.z;
    }
  }
  return 1.0; // tidak ketemu penghalang dalam batas iterasi = anggap kena matahari
}
```
**Catatan performa:** ini menjalankan DDA penuh per voxel permukaan per frame — jauh lebih mahal
dari versi lama. Untuk world statis, ini WAJIB di-cache (hanya dihitung ulang saat `isTopGridDirty`
atau ada `editVoxel` di sekitar voxel itu), bukan dihitung tiap frame. Tandai ini eksplisit sebagai
technical debt yang harus dibereskan di Fase 4 (dirty tracking) — jangan optimasi prematur di sini,
tapi jangan lupa juga.

### 1.2 — Soft penumbra via multi-sample cone kecil
**File:** `compute_rt.wgsl.js`

Ganti pemanggilan tunggal jadi rata-rata beberapa sample dalam cone kecil di sekitar `sun.direction`:
```wgsl
const SUN_ANGULAR_RADIUS = 0.02; // radian, ~cone kecil untuk soft shadow tipis

fn sampleSunVisibility(surfacePos: vec3f, baseDir: vec3f, seed: u32) -> f32 {
  var sum = 0.0;
  let tangent = normalize(cross(baseDir, vec3f(0.0, 1.0, 0.0) + vec3f(0.001)));
  let bitangent = cross(baseDir, tangent);
  for (var i = 0u; i < 4u; i++) {
    let jitter = hash2(seed + i) * 2.0 - 1.0; // -1..1, ganti hash2 dengan PRNG sederhana
    let dir = normalize(baseDir + (tangent * jitter.x + bitangent * jitter.y) * SUN_ANGULAR_RADIUS);
    sum += shadowRayDDA(surfacePos, dir);
  }
  return sum / 4.0;
}
```
4 sample per voxel cukup untuk penumbra tipis tanpa noise berlebihan mengingat ini masih fase
direct-only (belum ada temporal accumulation dari Fase 3).

### 1.3 — Pakai `sun.direction` yang sama di shading akhir
**File:** `compute_rt.wgsl.js`, `fn main()` baris ~186

Ganti:
```wgsl
let sunDir = normalize(vec3f(1.0, 1.0, 0.5));
```
menjadi:
```wgsl
let sunDir = sun.direction.xyz;
```
Ini memastikan shadow yang diinjeksi dan arah cahaya yang dipakai untuk shading N·L **konsisten**
— sebelumnya ini dua sumber kebenaran terpisah yang kebetulan cocok karena keduanya hardcode nilai
yang sama.

## Anti-Mock Checklist
- [ ] Ubah `sun.direction` dari JS (mis. slider di UI) dan lihat bayangan **sungguhan bergerak**
      real-time di scene `gi-lshape` — kalau tidak bergerak, berarti masih ada hardcode tersisa.
- [ ] Screenshot tepi bayangan di-zoom — harus ada gradasi beberapa piksel (bukan garis tajam 1px)
      di antara area lit dan shadow.
- [ ] Uji sudut matahari nyaris horizontal (`sun.direction.y` kecil) — dinding vertikal harus
      mulai menerima direct light, sesuatu yang mustahil terjadi di implementasi lama (yang selalu
      vertikal-only).

## Acceptance Test
1. Scene `gi-lshape`: matahari dari sudut miring 45° → dinding lorong pertama menunjukkan
   gradien terang-gelap yang mengikuti sudut, bukan biner.
2. Ganti `sun.direction.y` mendekati 0 (matahari nyaris horizontal) → permukaan vertikal
   menghadap matahari jadi terang, permukaan horizontal (lantai) jadi gelap — kebalikan dari
   default. Ini membuktikan arah shadow ray benar-benar dipakai, bukan hardcode vertikal.
3. Bandingkan frame time sebelum/sesudah (lewat debug HUD) — dokumentasikan angkanya walau belum
   dioptimasi (optimasi caching baru masuk Fase 4), supaya ada baseline pembanding.

**Lanjut ke `03-fase2-single-bounce.md` hanya jika ketiga poin di atas lolos.**
