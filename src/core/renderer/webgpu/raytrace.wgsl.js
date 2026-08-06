export const COMPUTE_SHADER = `
struct Camera {
  eye: vec4f,
  forward: vec4f,
  right: vec4f,
  up: vec4f,
  resolution: vec2f,
  debugMode: f32,   // 0=normal, 1=radiance only, 2=normal-as-color, 3=AO only
  padding: f32,
}

struct SunUniform {
  direction: vec4f,   // xyz = arah normalisasi MENUJU matahari, w = unused
  color: vec4f,       // xyz = warna/intensitas, w = unused
}

@group(0) @binding(0) var screen: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read_write> topGrid: array<u32>;
@group(0) @binding(3) var<storage, read_write> brickPool: array<u32>;
@group(0) @binding(4) var<storage, read_write> radiancePool: array<f32>;
@group(0) @binding(5) var<uniform> sun: SunUniform;

// Fungsi utilitas untuk mendapatkan index offset Voxel di BrickPool
fn getVoxelOffset(x: i32, y: i32, z: i32) -> u32 {
  if (x < 0 || x >= 96 || y < 0 || y >= 40 || z < 0 || z >= 96) { return 0xFFFFFFFFu; }
  
  let gx = x / 8;
  let gy = y / 8;
  let gz = z / 8;
  
  let sectorIdx = gx + gy * 12 + gz * 60;
  let brickId = topGrid[sectorIdx];
  
  if (brickId == 0u) { return 0xFFFFFFFFu; } // Ruang Kosong
  
  let lx = x % 8;
  let ly = y % 8;
  let lz = z % 8;
  let localIdx = lx + ly * 8 + lz * 64;
  
  return brickId * 512u + u32(localIdx);
}

// Fungsi untuk membaca Voxel dari struktur Hibrida
fn getVoxel(x: i32, y: i32, z: i32) -> u32 {
  let offset = getVoxelOffset(x, y, z);
  if (offset == 0xFFFFFFFFu) { return 0u; }
  
  let wordIdx = offset / 4u;
  let byteShift = (offset % 4u) * 8u;
  let packedData = brickPool[wordIdx];
  
  return (packedData >> byteShift) & 0xFFu;
}

// Hash 2D sederhana (PCG-ish) untuk jitter sample soft shadow. Bukan PRNG kualitas tinggi,
// tapi cukup untuk 4 sample per voxel di Fase 1 (belum ada temporal accumulation dari Fase 3).
fn hash2(seed: u32) -> vec2f {
  var x = seed;
  x = x ^ (x >> 16u); x = x * 0x7feb352du;
  x = x ^ (x >> 15u); x = x * 0x846ca68bu;
  x = x ^ (x >> 16u);
  let a = f32(x & 0xFFFFu) / 65535.0;
  let b = f32((x >> 16u) & 0xFFFFu) / 65535.0;
  return vec2f(a, b);
}

// Shadow ray murni hit/miss (tanpa kalkulasi warna) - dipakai light_injection.
// Menggunakan ulang logika DDA yang sama dengan fn main(), versi ringkas.
fn shadowRayDDA(ro: vec3f, rd: vec3f) -> f32 {
  var mapPos = vec3i(floor(ro));
  let deltaDist = abs(vec3f(1.0) / rd);
  let rayStep = vec3i(sign(rd));
  var sideDist = (sign(rd) * (vec3f(mapPos) - ro) + (sign(rd) * 0.5) + 0.5) * deltaDist;

  for (var i = 0; i < 250; i++) { // Ditingkatkan ke 250 agar bisa melintasi seluruh map (96+96+40)
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

const SUN_ANGULAR_RADIUS = 0.02; // radian, ~cone kecil untuk soft shadow tipis

// Rata-rata 4 shadow ray dalam cone kecil di sekitar arah matahari -> penumbra lembut,
// bukan bayangan biner bertepi tajam.
fn sampleSunVisibility(surfacePos: vec3f, baseDir: vec3f, seed: u32) -> f32 {
  var sum = 0.0;
  let tangent = normalize(cross(baseDir, vec3f(0.0, 1.0, 0.0) + vec3f(0.001)));
  let bitangent = cross(baseDir, tangent);
  for (var i = 0u; i < 4u; i++) {
    let jitter = hash2(seed + i * 9781u) * 2.0 - 1.0; // -1..1
    let dir = normalize(baseDir + (tangent * jitter.x + bitangent * jitter.y) * SUN_ANGULAR_RADIUS);
    sum += shadowRayDDA(surfacePos, dir);
  }
  return sum / 4.0;
}

// PASS 1: LIGHT INJECTION (Injeksi Cahaya Matahari)
// Fase 1.1: sebelumnya laser SELALU lurus ke bawah, tidak konsisten dengan sun.direction yang
// dipakai fn main() untuk shading, dan permukaan vertikal (dinding) tidak pernah dapat direct
// light. Sekarang setiap voxel permukaan dites langsung ke arah sun.direction sesungguhnya,
// dengan hasil kontinu [0.0, 1.0] (bukan cuma 0 atau 1) lewat sampleSunVisibility (Fase 1.2).
@compute @workgroup_size(8, 8, 1)
fn light_injection(@builtin(global_invocation_id) id: vec3u) {
   let x = i32(id.x);
   let z = i32(id.y);
   if (x >= 96 || z >= 96) { return; } // Batas peta horizontal

   for (var y = 0; y < 40; y++) {
       let offset = getVoxelOffset(x, y, z);
       if (offset == 0xFFFFFFFFu) { continue; }

       let wordIdx = offset / 4u;
       let byteShift = (offset % 4u) * 8u;
       let voxel = (brickPool[wordIdx] >> byteShift) & 0xFFu;
       if (voxel == 0u) { continue; }

       // Cari normal permukaan udara yang paling menghadap matahari
       var bestNormal = vec3f(0.0, 1.0, 0.0);
       var maxDot = -1.0;
       let dirs = array<vec3f, 6>(
           vec3f(0.0, 1.0, 0.0), vec3f(0.0, -1.0, 0.0),
           vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0),
           vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0)
       );
       
       for (var i = 0; i < 6; i++) {
           let n = dirs[i];
           if (getVoxel(x + i32(n.x), y + i32(n.y), z + i32(n.z)) == 0u) {
               let dDot = dot(n, sun.direction.xyz);
               if (dDot > maxDot) {
                   maxDot = dDot;
                   bestNormal = n;
               }
           }
       }
       
       if (maxDot < 0.0) {
           // Permukaan tertutup rapat atau membelakangi matahari = gelap gulita
           radiancePool[offset] = 0.0;
           continue;
       }
       
       // Mulai ray di tengah voxel UDARA terdekat yang menghadap matahari (offset 0.51)
       // Ini mencegah voxel "menabrak" voxel tetangga secara lateral di sudut rendah (seperti 29 derajat)
       let surfacePos = vec3f(f32(x), f32(y), f32(z)) + vec3f(0.5) + bestNormal * 0.51;
       radiancePool[offset] = sampleSunVisibility(surfacePos, sun.direction.xyz, offset);
   }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let res = camera.resolution;
  if (f32(id.x) >= res.x || f32(id.y) >= res.y) { return; }
  
  let uv = vec2f(f32(id.x), f32(id.y)) / res * 2.0 - 1.0;
  let aspect = res.x / res.y;
  let ro = camera.eye.xyz;
  let rd = normalize(camera.forward.xyz + (uv.x * aspect) * camera.right.xyz - uv.y * camera.up.xyz);
  
  // --- INISIALISASI DDA (Digital Differential Analyzer) ---
  var mapPos = vec3i(floor(ro));
  let deltaDist = abs(vec3f(1.0) / rd);
  let rayStep = vec3i(sign(rd));
  var sideDist = (sign(rd) * (vec3f(mapPos) - ro) + (sign(rd) * 0.5) + 0.5) * deltaDist;
  
  var mask = vec3<bool>(false, false, false);
  var hit = false;
  var voxelColor = 0u;
  
  // --- LOOP RAY MARCHING ---
  for(var i=0; i<300; i++) {
    // Keluar jalur jika meleset jauh (Batas diperlebar agar pemain bisa mundur jauh melihat dunia)
    if (mapPos.y < -50 || mapPos.y > 1000 || mapPos.x < -200 || mapPos.x > 300 || mapPos.z < -200 || mapPos.z > 300) {
       break; 
    }
    
    // --- 1. KESADARAN MAKRO (O(1) Space Skipping) ---
    let sgx = i32(floor(f32(mapPos.x) / 8.0));
    let sgy = i32(floor(f32(mapPos.y) / 8.0));
    let sgz = i32(floor(f32(mapPos.z) / 8.0));
    
    var brickId = 0u;
    if (mapPos.x >= 0 && mapPos.x < 96 && mapPos.y >= 0 && mapPos.y < 40 && mapPos.z >= 0 && mapPos.z < 96) {
        let sectorIdx = sgx + sgy * 12 + sgz * 60;
        brickId = topGrid[sectorIdx];
    }
    
    // Jika kita berada di udara kosong (di dalam atau di luar map)
    if (brickId == 0u) {
        var tExit = vec3f(999999.0);
        
        if (rayStep.x > 0) { tExit.x = (f32((sgx + 1) * 8) - ro.x) / rd.x; }
        else if (rayStep.x < 0) { tExit.x = (f32(sgx * 8) - ro.x) / rd.x; }
        
        if (rayStep.y > 0) { tExit.y = (f32((sgy + 1) * 8) - ro.y) / rd.y; }
        else if (rayStep.y < 0) { tExit.y = (f32(sgy * 8) - ro.y) / rd.y; }
        
        if (rayStep.z > 0) { tExit.z = (f32((sgz + 1) * 8) - ro.z) / rd.z; }
        else if (rayStep.z < 0) { tExit.z = (f32(sgz * 8) - ro.z) / rd.z; }
        
        let tJump = min(tExit.x, min(tExit.y, tExit.z));
        
        // Lompat teleportasi (tanpa epsilon yang rawan error)
        let hitPos = ro + rd * tJump;
        mapPos = vec3i(floor(hitPos));
        
        // Paksa mapPos menyeberang batas sektor di SEMUA sumbu yang tersentuh
        // Menggunakan if terpisah agar lompatan diagonal di sudut sektor tetap akurat
        if (abs(tJump - tExit.x) < 0.0001) {
            mask = vec3<bool>(true, false, false);
            mapPos.x = sgx * 8 + select(-1, 8, rayStep.x > 0);
        }
        if (abs(tJump - tExit.y) < 0.0001) {
            mask = vec3<bool>(false, true, false);
            mapPos.y = sgy * 8 + select(-1, 8, rayStep.y > 0);
        }
        if (abs(tJump - tExit.z) < 0.0001) {
            mask = vec3<bool>(false, false, true);
            mapPos.z = sgz * 8 + select(-1, 8, rayStep.z > 0);
        }
        
        // Perbarui state DDA (sideDist) untuk posisi yang baru
        sideDist = (vec3f(rayStep) * (vec3f(mapPos) - ro) + (vec3f(rayStep) * 0.5) + 0.5) * deltaDist;
        
        continue; // Langsung lanjut putaran baru di sektor berikutnya!
    }
    
    // --- 2. KESADARAN MIKRO (Voxel per Voxel) ---
    voxelColor = getVoxel(mapPos.x, mapPos.y, mapPos.z);
    
    if (voxelColor > 0u) {
      hit = true;
      break;
    }
    
    // Penentuan sumbu mana yang akan ditembus selanjutnya (Tie-breaker aman)
    if (sideDist.x <= sideDist.y && sideDist.x <= sideDist.z) {
      mask = vec3<bool>(true, false, false);
      sideDist.x += deltaDist.x;
      mapPos.x += rayStep.x;
    } else if (sideDist.y <= sideDist.z) {
      mask = vec3<bool>(false, true, false);
      sideDist.y += deltaDist.y;
      mapPos.y += rayStep.y;
    } else {
      mask = vec3<bool>(false, false, true);
      sideDist.z += deltaDist.z;
      mapPos.z += rayStep.z;
    }
  }

  var color = vec3f(0.0);
  
  if (hit) {
    // --- VOXEL TERHIT! (Kalkulasi Cahaya & Warna) ---
    let normal = select(vec3f(0.0), vec3f(-rayStep), mask);
    let sunDir = sun.direction.xyz; // Fase 1.3: sama dengan yang dipakai light_injection (konsisten)
    let diff = max(dot(normal, sunDir), 0.0); // N·L asli, 0 kalau permukaan membelakangi matahari
    
    if (voxelColor == 1u) { color = vec3f(0.2, 0.7, 0.2); }      // Rumput Hijau
    else if (voxelColor == 2u) { color = vec3f(0.5, 0.3, 0.1); } // Tanah Cokelat
    else if (voxelColor == 3u) { color = vec3f(0.6, 0.6, 0.6); } // Batu Abu-abu
    else if (voxelColor == 4u) { color = vec3f(0.9, 0.9, 0.9); } // Salju
    else if (voxelColor == 5u) { color = vec3f(0.72, 0.14, 0.12); } // Bata Merah (uji gi-colorwall)
    else { color = vec3f(0.8, 0.1, 0.8); }                       // Error Magenta
    
    let offset = getVoxelOffset(mapPos.x, mapPos.y, mapPos.z);
    let shadow = radiancePool[offset]; 
    
    // --- 1. CAHAYA LANGIT (Sky Ambient) ---
    // Permukaan yang menghadap ke atas mendapat lebih banyak cahaya langit biru
    var ambient = vec3f(0.45, 0.55, 0.7); 
    if (normal.y > 0.0) { ambient *= 1.2; }       // Atas
    else if (normal.y < 0.0) { ambient *= 0.4; }  // Bawah
    else { ambient *= 0.75; }                     // Samping
    
    // --- 2. CAHAYA MATAHARI (Direct Sun) ---
    // Fase 1: sekarang pakai N·L asli (diff) + shadow kontinu (soft shadow) dari
    // sampleSunVisibility — sebelumnya cuma "normal.y > 0.0" yang cuma nyala untuk
    // permukaan menghadap ke atas dan tidak pernah menyalakan dinding vertikal.
    var sunLight = vec3f(0.0);
    if (diff > 0.0) {
        sunLight = sun.color.xyz * diff * shadow;
    }
    
    // --- 3. AMBIENT OCCLUSION (Voxel AO) ---
    // Mengecek 4 blok di sekeliling permukaan sentuh untuk mendeteksi pojokan
    var ao = 1.0;
    var side1 = vec3i(0);
    var side2 = vec3i(0);
    
    if (abs(normal.y) > 0.5) { side1 = vec3i(1,0,0); side2 = vec3i(0,0,1); } 
    else if (abs(normal.x) > 0.5) { side1 = vec3i(0,1,0); side2 = vec3i(0,0,1); } 
    else { side1 = vec3i(1,0,0); side2 = vec3i(0,1,0); }
    
    let cPos = mapPos + vec3i(normal); // Udara tepat di depan permukaan
    if (getVoxel(cPos.x + side1.x, cPos.y + side1.y, cPos.z + side1.z) > 0u) { ao -= 0.15; }
    if (getVoxel(cPos.x - side1.x, cPos.y - side1.y, cPos.z - side1.z) > 0u) { ao -= 0.15; }
    if (getVoxel(cPos.x + side2.x, cPos.y + side2.y, cPos.z + side2.z) > 0u) { ao -= 0.15; }
    if (getVoxel(cPos.x - side2.x, cPos.y - side2.y, cPos.z - side2.z) > 0u) { ao -= 0.15; }
    ao = max(ao, 0.4);
    
    // --- DEBUG VIEW MODES (Fase 0.3) ---
    // Cabang debug ditaruh di sini (bukan di luar if/else) karena 'normal', 'ao', 'offset'
    // dideklarasikan dengan 'let' di dalam blok if(hit) — tidak terlihat di luar blok itu di WGSL.
    if (camera.debugMode > 0.5 && camera.debugMode < 1.5) {
        color = vec3f(radiancePool[offset]); // grayscale radiance mentah
    } else if (camera.debugMode > 1.5 && camera.debugMode < 2.5) {
        color = normal * 0.5 + 0.5; // normal sebagai warna
    } else if (camera.debugMode > 2.5) {
        color = vec3f(ao); // AO saja
    } else {
        // Mode normal (0): pipeline pencahayaan penuh seperti biasa
        // Penggabungan Akhir yang Mulus!
        color = color * (ambient + sunLight) * ao;
        
        // Kabut (Fog) berdasarkan jarak
        var t = 0.0;
        if (mask.x) { t = (f32(mapPos.x) - ro.x + (1.0 - f32(rayStep.x)) * 0.5) / rd.x; }
        else if (mask.y) { t = (f32(mapPos.y) - ro.y + (1.0 - f32(rayStep.y)) * 0.5) / rd.y; }
        else { t = (f32(mapPos.z) - ro.z + (1.0 - f32(rayStep.z)) * 0.5) / rd.z; }
        
        let fog = exp(-t * 0.02);
        let skyColor = vec3f(0.53, 0.81, 0.92); // Sama dengan Rasterisasi (#87ceeb)
        color = mix(skyColor, color, fog); // Campur warna voxel dengan kabut atmosfer
    }
    
  } else {
    // --- MELESET (Render Langit, atau hitam pekat kalau lagi di mode debug) ---
    if (camera.debugMode > 0.5) {
        color = vec3f(0.0); // Hitam: menandakan ray tidak kena apa-apa, biar tidak rancu dgn permukaan
    } else {
        color = vec3f(0.53, 0.81, 0.92); // Warna langit solid (#87ceeb)
    }
  }

  // Tulis ke Piksel Layar
  textureStore(screen, id.xy, vec4f(color, 1.0));
}
`;
