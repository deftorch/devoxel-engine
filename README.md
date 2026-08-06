# Devoxel — Universal Voxel Framework

Engine voxel yang **pluggable**: storage, mesher, dan renderer masing-masing
adalah plugin yang bisa diganti lewat konfigurasi, tanpa menyentuh kode
engine (`src/core/`) sama sekali.

## Fitur

- **Pluggable Storage** — FlatGrid, Octree, SVDAG, Tree64, BrickMap, SDF (semua implement kontrak `VoxelStorage` yang sama)
- **Pluggable Mesher** — Greedy Mesher bawaan, tinggal `extends MesherPlugin` untuk algoritma sendiri (Marching Cubes, Dual Contouring, dll)
- **Pluggable Renderer** — WebGL2, WebGPU (raster), WebGPU Compute Raytracer
- **PluginRegistry** — daftarkan plugin custom dengan `registry.registerStorage/registerMesher/registerRenderer(id, factory)`, lalu resolve cukup lewat string id
- Entity Component System (ECS)
- CommandBus bergaya MCP tool (untuk kontrol eksternal/AI)
- Standalone Voxel Editor

## Pluggable System — Cara Pakai

```js
import { VoxelEngine } from './src/core/index.js';

const engine = new VoxelEngine({
  chunkSize: [16, 40, 16],
  storage: 'brickmap', // 'flatgrid' | 'octree' | 'svdag' | 'tree64' | 'brickmap' | 'sdf'
  mesher: 'greedy',
  renderer: 'webgpu', // 'webgl' | 'webgpu' | 'raytrace'
});

engine.setVoxel(0, 0, 0, 1);
engine.remeshDirtyChunks();
await engine.start(canvas);
```

Ganti backend cukup dengan mengganti string id — tidak perlu refactor kode
lain. Lihat `src/core/devoxel.config.example.js` untuk contoh lengkap.

### Membuat plugin sendiri

Tiga base class dengan penamaan seragam (`Voxel<Peran>`), tinggal `extends`:

```js
import { VoxelStorage, VoxelMesher, VoxelRenderer, defaultRegistry } from './src/core/index.js';

class MyStorage extends VoxelStorage {
  get(x, y, z) {
    /* ... */
  }
  set(x, y, z, val) {
    /* ... */
  }
}
defaultRegistry.registerStorage('my-storage', (sx, sy, sz) => new MyStorage(sx, sy, sz));

class MyMesher extends VoxelMesher {
  generateMesh(chunkStorage) {
    /* ... */
  }
}
defaultRegistry.registerMesher('my-mesher', () => new MyMesher());

class MyRenderer extends VoxelRenderer {
  async init(canvas, options) {
    /* ... */
  }
  render(time) {
    /* ... */
  }
}
defaultRegistry.registerRenderer('my-renderer', (canvas, opts) => new MyRenderer().init(canvas, opts));

const engine = new VoxelEngine({ storage: 'my-storage', mesher: 'my-mesher', renderer: 'my-renderer' });
```

### Konvensi penamaan

| Peran    | Base class      | Contoh implementasi                                                                                  |
| -------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Storage  | `VoxelStorage`  | `FlatGridStorage`, `OctreeStorage`, `SVDAGStorage`, `Tree64Storage`, `BrickMapStorage`, `SDFStorage` |
| Mesher   | `VoxelMesher`   | `GreedyMesher`                                                                                       |
| Renderer | `VoxelRenderer` | `VoxelRendererAdapter` (wraps WebGL/WebGPU/raytrace)                                                 |

Pola nama: `<Nama><Peran>` — tanpa suffix "Plugin" berulang, karena sifat pluggable-nya sudah tersirat dari arsitektur registry.

## Persyaratan

- Browser dengan dukungan WebGPU (misalnya Chrome/Edge versi terbaru) — WebGL2 dipakai sebagai fallback otomatis
- Node.js (jika ada build tools)

## Setup

1. Clone repositori ini.
2. Buka `index.html` atau `editor.html` (atau gunakan server lokal untuk menghindari isu CORS).

## Verifikasi & Testing

Proyek ini tanpa build step (pure ESM), tapi tetap punya script verifikasi:

```bash
npm run check       # syntax-check semua file di src/
npm run check-deps  # pastikan versi bitecs konsisten di semua import CDN
npm test            # jalankan test di src/test/
npm run verify       # jalankan ketiganya sekaligus (dipakai CI)
```

## License

MIT — lihat [LICENSE](./LICENSE).
