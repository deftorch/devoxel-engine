export function hash2(x, z) {
  let n = (x * 374761393 + z * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295;
}
export function smooth(t) {
  return t * t * (3 - 2 * t);
}
export function valueNoise2D(x, z) {
  const x0 = Math.floor(x),
    z0 = Math.floor(z);
  const x1 = x0 + 1,
    z1 = z0 + 1;
  const sx = smooth(x - x0),
    sz = smooth(z - z0);
  const n00 = hash2(x0, z0),
    n10 = hash2(x1, z0);
  const n01 = hash2(x0, z1),
    n11 = hash2(x1, z1);
  const ix0 = n00 + (n10 - n00) * sx;
  const ix1 = n01 + (n11 - n01) * sx;
  return ix0 + (ix1 - ix0) * sz;
}
export function fbm(x, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5,
    freq = 1.0,
    sum = 0,
    norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
export function heightRaw(worldX, worldZ) {
  const n = fbm(worldX * 0.035, worldZ * 0.035, 4);
  return 10 + n * 22;
}
export function heightAt(worldX, worldZ, chunk_sy) {
  let sum = 0,
    wsum = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const w = dx === 0 && dz === 0 ? 4 : dx === 0 || dz === 0 ? 2 : 1;
      sum += heightRaw(worldX + dx, worldZ + dz) * w;
      wsum += w;
    }
  }
  const h = Math.floor(sum / wsum);
  return Math.max(2, Math.min(chunk_sy - 2, h));
}

// --- 3D Noise for SDF ---
export function hash3(x, y, z) {
  let n = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295;
}

export function valueNoise3D(x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  const sx = smooth(x - x0), sy = smooth(y - y0), sz = smooth(z - z0);
  
  const n000 = hash3(x0, y0, z0), n100 = hash3(x1, y0, z0);
  const n010 = hash3(x0, y1, z0), n110 = hash3(x1, y1, z0);
  const n001 = hash3(x0, y0, z1), n101 = hash3(x1, y0, z1);
  const n011 = hash3(x0, y1, z1), n111 = hash3(x1, y1, z1);

  const ix00 = n000 + (n100 - n000) * sx;
  const ix10 = n010 + (n110 - n010) * sx;
  const ix01 = n001 + (n101 - n001) * sx;
  const ix11 = n011 + (n111 - n011) * sx;

  const iy0 = ix00 + (ix10 - ix00) * sy;
  const iy1 = ix01 + (ix11 - ix01) * sy;

  return iy0 + (iy1 - iy0) * sz;
}
