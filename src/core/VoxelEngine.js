import { CommandBus } from './api/CommandBus.js';
import { defaultRegistry } from './registry/PluginRegistry.js';

/**
 * Universal Voxel Engine Core
 * ---------------------------------------------------------------------------
 * Bertindak sebagai 'Otak Utama' (Hub) yang menghubungkan Storage, Mesher,
 * dan Renderer. Semua tiga peran itu adalah PLUGIN: bisa diganti lewat
 * config (resolve dari PluginRegistry by id) ATAU di-inject langsung
 * sebagai instance, tanpa mengubah kode engine ini sama sekali.
 *
 * Config-driven:
 *   const engine = new VoxelEngine({
 *     registry,                              // opsional, default: defaultRegistry
 *     storage: 'octree',                     // id plugin storage
 *     mesher: 'greedy',                      // id plugin mesher
 *     renderer: 'webgpu',                    // id plugin renderer (di-init saat start(canvas))
 *     chunkSize: [16, 40, 16],
 *   });
 *
 * Manual injection (masih didukung penuh):
 *   const engine = new VoxelEngine({ chunkSize: [16, 40, 16] })
 *     .useStorageProvider((sx, sy, sz) => new MyCustomStorage(sx, sy, sz))
 *     .useMesher(new MyCustomMesher())
 *     .useRenderer(myRendererInstance);
 */
export class VoxelEngine {
  constructor(options = {}) {
    this.registry = options.registry || defaultRegistry;

    // 1. Sistem Komunikasi (Event Bus & MCP Commands)
    this.commands = new CommandBus();
    this.events = new Map();

    // 2. Skema Data (Data-Driven Voxel Payload)
    this.storageSchema = options.storageSchema || { type: 'Uint8', name: 'MaterialID' };
    this.chunkSize = options.chunkSize || [16, 40, 16];

    // 3. Plugin slots
    this.mesherPlugin = null;
    this.rendererPlugin = null;
    this.storageFactory = null; // (sx, sy, sz) => VoxelStorage instance

    // State Dunia: chunkKey ("cx,cy,cz") -> { storage, dirty, mesh }
    this.chunks = new Map();

    // DEBUG: kalau true, mesher (yang mendukungnya) akan mewarnai vertex di
    // dekat batas chunk supaya robekan/seam antar chunk gampang diperiksa
    // secara visual. Lihat SurfaceNetsMesher + ctx.debugChunkBounds.
    this.debugChunkBounds = false;

    // Roadmap A.5 -- Origin Rebasing: referensi chunk yang dipakai mesher
    // untuk membakar posisi vertex RELATIF (bukan absolut dari (0,0,0)).
    // Default [0,0,0] = perilaku lama (posisi absolut) persis, dipakai oleh
    // SEMUA konsumer engine ini kecuali jalur streaming (main.js) yang
    // menggesernya lewat setOriginChunk() saat pemain jalan cukup jauh.
    // Lihat OriginRebase.js untuk penjelasan lengkap kenapa ini diperlukan.
    this.originChunk = [0, 0, 0];

    // Resolve plugins declared by id in the config, if any.
    if (options.storage) this.useStorageProvider(this._resolveStorageFactory(options.storage));
    if (options.mesher) this.useMesher(this._resolveMesher(options.mesher));
    this._pendingRendererId = options.renderer || null;
  }

  // --- PLUGIN RESOLUTION (by id, via registry) --------------------------

  _resolveStorageFactory(id) {
    if (typeof id === 'function') return id; // already a factory
    return (sx, sy, sz) => this.registry.createStorage(id, sx, sy, sz);
  }

  _resolveMesher(id) {
    if (typeof id === 'object') return id; // already an instance
    return this.registry.createMesher(id);
  }

  async _resolveRenderer(id, canvas, rendererOptions) {
    if (id && typeof id === 'object' && typeof id.render === 'function') return id; // already an instance
    return this.registry.createRenderer(id, canvas, rendererOptions);
  }

  // --- PLUGIN INJECTION (manual / direct instance) -----------------------

  useMesher(mesherInstance) {
    this.mesherPlugin = mesherInstance;
    console.log(`[Engine] Mesher diatur ke: ${mesherInstance.constructor.name}`);
    this.emit('mesherChanged', mesherInstance);
    return this; // Method chaining
  }

  useRenderer(rendererInstance) {
    this.rendererPlugin = rendererInstance;
    console.log(`[Engine] Renderer diatur ke: ${rendererInstance.constructor.name}`);
    this.emit('rendererChanged', rendererInstance);
    return this;
  }

  useStorageProvider(factoryFunction) {
    this.storageFactory = factoryFunction;
    return this;
  }

  /** Register a new plugin kind at runtime (e.g. a third-party storage backend). */
  registerPlugin(kind, id, factory, meta) {
    if (kind === 'storage') this.registry.registerStorage(id, factory, meta);
    else if (kind === 'mesher') this.registry.registerMesher(id, factory, meta);
    else if (kind === 'renderer') this.registry.registerRenderer(id, factory, meta);
    else throw new Error(`[Engine] Unknown plugin kind: ${kind}`);
    return this;
  }

  // --- EVENT SYSTEM (HOOKS) ----------------------------------------------

  on(eventName, callback) {
    if (!this.events.has(eventName)) this.events.set(eventName, []);
    this.events.get(eventName).push(callback);
    return this;
  }

  off(eventName, callback) {
    const list = this.events.get(eventName);
    if (!list) return this;
    const idx = list.indexOf(callback);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }

  emit(eventName, payload) {
    if (this.events.has(eventName)) {
      for (const cb of this.events.get(eventName)) {
        cb(payload);
      }
    }
  }

  // --- CHUNK / STORAGE MANAGEMENT -----------------------------------------

  _chunkKey(cx, cy, cz) {
    return `${cx},${cy},${cz}`;
  }

  worldToChunkCoords(x, y, z) {
    const [sx, sy, sz] = this.chunkSize;
    const cx = Math.floor(x / sx);
    const cy = Math.floor(y / sy);
    const cz = Math.floor(z / sz);
    const lx = x - cx * sx;
    const ly = y - cy * sy;
    const lz = z - cz * sz;
    return { cx, cy, cz, lx, ly, lz };
  }

  getChunk(cx, cy, cz) {
    return this.chunks.get(this._chunkKey(cx, cy, cz)) || null;
  }

  getOrCreateChunk(cx, cy, cz) {
    const key = this._chunkKey(cx, cy, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      if (!this.storageFactory) {
        throw new Error(
          '[Engine] Tidak ada Storage Provider yang di-inject! Panggil useStorageProvider() atau set `storage` di config.'
        );
      }
      const [sx, sy, sz] = this.chunkSize;
      const storage = this.storageFactory(sx, sy, sz);
      // Roadmap B.2 -- Partial Remeshing: `cellCache` menyimpan hasil Pass 1
      // dari build TERAKHIR (opaque, dikelola SurfaceNetsMesher -- lihat
      // komentar di sana), `pendingDirtyBounds` adalah AABB cell yang
      // terakumulasi dari setVoxel() sejak remesh terakhir (null = tidak
      // ada edit langsung, atau baru saja di-reset setelah remesh), dan
      // `forceFullRemesh` memaksa build FULL berikutnya walau
      // pendingDirtyBounds ada (dipakai saat chunk ini jadi TETANGGA dari
      // edit/chunk-baru, bukan yang diedit langsung -- lihat
      // _dirtyBoundaryNeighbors()/markChunkLoaded()). Semuanya mulai null
      // untuk chunk baru, artinya build PERTAMA selalu full (aman, tidak
      // ada cache untuk dipakai ulang).
      chunk = { cx, cy, cz, storage, dirty: true, mesh: null, cellCache: null, pendingDirtyBounds: null, forceFullRemesh: false };
      this.chunks.set(key, chunk);
      this.emit('chunkCreated', chunk);
    }
    return chunk;
  }

  /**
   * Unload sebuah chunk (Roadmap A.1): hapus dari `this.chunks` sehingga
   * tidak lagi ikut ter-remesh/ter-render, TANPA menyentuh storage permanen
   * apapun. Emit 'chunkUnloaded' SEBELUM entry-nya dihapus dari map supaya
   * listener (mis. ECS di main.js untuk dispose GPU buffer, atau nanti
   * Fase A.3 untuk serialize `everEdited` chunk ke IndexedDB sebelum
   * datanya hilang) masih bisa membaca chunk.storage/chunk.mesh.
   *
   * Tidak melempar error kalau chunk tidak ada -- unload dari chunk yang
   * sudah tidak ter-load (atau tidak pernah ada) adalah no-op yang aman,
   * supaya caller (ChunkStreamer) tidak perlu cek existence dulu.
   *
   * @returns {object|null} chunk record yang baru saja di-unload, atau null.
   */
  unloadChunk(cx, cy, cz) {
    const key = this._chunkKey(cx, cy, cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return null;

    this.emit('chunkUnloaded', chunk);
    this.chunks.delete(key);
    return chunk;
  }

  // --- ENGINE API ----------------------------------------------------------

  getVoxel(x, y, z) {
    const { cx, cy, cz, lx, ly, lz } = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(cx, cy, cz);
    if (!chunk) return 0;
    return chunk.storage.get(lx, ly, lz);
  }

  setVoxel(x, y, z, value) {
    this.emit('beforeVoxelEdit', { x, y, z, value });

    const { cx, cy, cz, lx, ly, lz } = this.worldToChunkCoords(x, y, z);
    const chunk = this.getOrCreateChunk(cx, cy, cz);
    chunk.storage.set(lx, ly, lz, value);
    chunk.dirty = true;

    // Roadmap B.2 -- Partial Remeshing: akumulasi AABB cell (dalam ruang
    // koordinat CELL yang dipakai SurfaceNetsMesher, -1..dims-1, BUKAN
    // ruang voxel) yang datanya benar-benar mungkin berubah akibat edit
    // ini, supaya remesh berikutnya untuk chunk INI (bukan tetangga --
    // lihat _dirtyBoundaryNeighbors() untuk itu) bisa membatasi Pass 1
    // hanya ke area ini alih-alih seluruh chunk. Dipanggil SETELAH
    // storage.set() supaya voxel barunya sudah kebaca kalau ada logic lain
    // yang butuh itu duluan (tidak ada saat ini, tapi urutan aman).
    this._unionDirtyBounds(chunk, lx, ly, lz);

    this.emit('afterVoxelEdit', { x, y, z, value });

    // Beritahu Mesher bahwa chunk ini 'kotor' dan harus di-rebuild
    if (this.mesherPlugin) {
      this.mesherPlugin.markChunkDirty(cx, cy, cz);
    }

    // Root cause fix (lihat commit 541858b): SurfaceNetsMesher membaca 1 sel
    // padding dari chunk TETANGGA (termasuk diagonal/corner, karena
    // _getSDF() bisa butuh nx/ny/nz != 0 di semua sumbu sekaligus) untuk
    // stitching seam. Kalau voxel yang diedit ada di/dekat batas chunk
    // (lx/ly/lz == 0 atau == dims-1), mesh chunk tetangga yang SUDAH
    // dibangun sebelumnya jadi stale -- dia tidak tahu data sumbernya
    // berubah karena tidak ikut ditandai dirty. Ini yang menyebabkan
    // robekan/flap mengambang di seam saat menggali dekat batas chunk.
    // Fix: tandai juga semua chunk tetangga (termasuk diagonal) yang
    // datanya ikut disampling oleh cell padding di sisi voxel yang diedit.
    this._dirtyBoundaryNeighbors(cx, cy, cz, lx, ly, lz);
  }

  /**
   * Roadmap B.2 -- Partial Remeshing: satukan (union) AABB cell yang perlu
   * dihitung ulang akibat edit voxel di (lx, ly, lz) ke dalam
   * `chunk.pendingDirtyBounds`, dipakai `remeshChunk()` sebagai
   * `ctx.dirtyBounds` untuk SurfaceNetsMesher.
   *
   * Padding: sebuah voxel di posisi v adalah SUDUT dari cell (v-1) dan cell
   * v (cell x punya sudut di x DAN x+1) -- jadi dampak minimal ke ruang
   * cell adalah [lx-1, lx]. Normal vertex dihitung lewat trilinear gradient
   * (_getNormal, d=0.5) yang bisa menjangkau ~1 cell lagi dari posisi
   * vertex. PADDING=2 dipilih generous di kedua arah supaya kedua efek itu
   * (mapping voxel->cell DAN jangkauan gradient) pasti tercakup penuh --
   * lebih baik sedikit boros (cell tak terpengaruh ikut dihitung ulang)
   * daripada kurang (cell terpengaruh terlewat -> mesh salah).
   *
   * Beberapa edit sebelum remesh berikutnya (mis. drag-gali multi-voxel
   * dalam 1 frame) ter-akumulasi jadi SATU AABB gabungan yang membungkus
   * semuanya -- bukan di-reset tiap panggilan.
   */
  _unionDirtyBounds(chunk, lx, ly, lz) {
    const PADDING = 2;
    const minX = lx - PADDING, maxX = lx + PADDING;
    const minY = ly - PADDING, maxY = ly + PADDING;
    const minZ = lz - PADDING, maxZ = lz + PADDING;

    if (!chunk.pendingDirtyBounds) {
      chunk.pendingDirtyBounds = { minX, minY, minZ, maxX, maxY, maxZ };
    } else {
      const b = chunk.pendingDirtyBounds;
      b.minX = Math.min(b.minX, minX); b.maxX = Math.max(b.maxX, maxX);
      b.minY = Math.min(b.minY, minY); b.maxY = Math.max(b.maxY, maxY);
      b.minZ = Math.min(b.minZ, minZ); b.maxZ = Math.max(b.maxZ, maxZ);
    }
  }

  /**
   * Menandai dirty semua chunk tetangga (termasuk diagonal/corner) yang
   * mesh-nya bergantung pada voxel di (lx, ly, lz) dalam chunk (cx, cy, cz).
   * SurfaceNetsMesher membaca padding 1 sel dari tetangga di sisi manapun
   * voxel itu berada tepat di tepi (lx/ly/lz == 0 atau == dims-1), dan bisa
   * butuh kombinasi sumbu sekaligus (edge/corner neighbor), bukan cuma 6
   * face neighbor. Chunk yang belum pernah dibuat (belum ada di this.chunks)
   * otomatis diabaikan -- tidak perlu di-dirty-kan karena belum punya mesh.
   */
  _dirtyBoundaryNeighbors(cx, cy, cz, lx, ly, lz) {
    const [sx, sy, sz] = this.chunkSize;

    // Untuk tiap sumbu, tentukan offset tetangga mana saja yang relevan:
    // - jika voxel di sisi bawah (local == 0) -> tetangga di dx/dy/dz = -1
    // - jika voxel di sisi atas (local == dim-1) -> tetangga di dx/dy/dz = +1
    // - selain itu -> tidak menyentuh tetangga di sumbu itu (offset 0 saja)
    const dxOptions = lx === 0 ? [-1, 0] : lx === sx - 1 ? [0, 1] : [0];
    const dyOptions = ly === 0 ? [-1, 0] : ly === sy - 1 ? [0, 1] : [0];
    const dzOptions = lz === 0 ? [-1, 0] : lz === sz - 1 ? [0, 1] : [0];

    for (const dx of dxOptions) {
      for (const dy of dyOptions) {
        for (const dz of dzOptions) {
          if (dx === 0 && dy === 0 && dz === 0) continue; // chunk asal, sudah dirty
          const neighbor = this.getChunk(cx + dx, cy + dy, cz + dz);
          if (!neighbor) continue; // belum pernah dibuat -> tidak ada mesh stale untuk diperbaiki
          neighbor.dirty = true;
          // Roadmap B.2 -- tetangga ini di-dirty-kan karena efek SAMPING
          // dari edit/chunk baru di CHUNK LAIN, bukan karena diedit
          // langsung -- kita TIDAK tahu AABB cell mana persisnya di
          // tetangga ini yang terpengaruh (bisa di sepanjang seluruh sisi
          // yang bersebelahan). forceFullRemesh memaksa remeshChunk()
          // melakukan build FULL untuk tetangga ini di remesh berikutnya,
          // bukan partial berdasar pendingDirtyBounds (yang mungkin ada
          // dari edit LANGSUNG lain di tetangga ini pada siklus yang sama
          // -- tanpa flag ini, partial-nya cuma akan menutupi editnya
          // sendiri dan MELEWATKAN efek samping dari sini, seam bisa
          // robek lagi).
          neighbor.forceFullRemesh = true;
          if (this.mesherPlugin) {
            this.mesherPlugin.markChunkDirty(cx + dx, cy + dy, cz + dz);
          }
        }
      }
    }
  }

  /**
   * Roadmap A.4 -- Border stitching untuk chunk yang baru "muncul" (dari
   * generation ataupun nanti dari IndexedDB di A.3), dipakai oleh streaming
   * (A.1) karena chunk di sana di-load bertahap antar frame, bukan sekaligus
   * seperti dunia tetap (buildWorld() membuat semua chunk dulu, baru mesh
   * semuanya sekali jalan -- jadi tidak kena masalah ini).
   *
   * Skenario: chunk A sudah di-mesh dengan asumsi tetangganya B belum ada
   * (padding disampel sebagai kosong/default oleh mesher). Beberapa frame
   * kemudian B benar-benar di-load (mis. pemain jalan lebih jauh sehingga B
   * masuk radius). Mesh A yang lama sekarang stale terhadap data B yang
   * nyata ada -- geometri di seam antara A dan B jadi tidak sinkron
   * (robekan/flap), persis pola bug yang sama dengan yang diperbaiki di
   * _dirtyBoundaryNeighbors(), tapi dipicu oleh CHUNK BARU, bukan EDIT VOXEL.
   *
   * Panggil method ini SETELAH storage chunk (cx, cy, cz) benar-benar terisi
   * data asli (bukan cuma getOrCreateChunk() yang membuat storage kosong).
   * Semua 26 kemungkinan tetangga (6 face + 12 edge + 8 corner) yang SUDAH
   * ADA ditandai dirty -- konservatif secara sengaja (bukan cuma 6 face),
   * karena chunk baru ini mengubah SELURUH sisi batasnya sekaligus (beda
   * dengan _dirtyBoundaryNeighbors() yang cuma perlu tandai tetangga di sisi
   * voxel yang diedit), dan SurfaceNetsMesher._getSDF() bisa butuh kombinasi
   * sumbu sekaligus untuk sample dekat sudut chunk.
   */
  markChunkLoaded(cx, cy, cz) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue; // chunk itu sendiri, bukan tetangga
          const neighbor = this.getChunk(cx + dx, cy + dy, cz + dz);
          if (!neighbor) continue; // belum pernah dibuat -> tidak ada mesh stale untuk diperbaiki
          neighbor.dirty = true;
          // Roadmap B.2 -- tetangga ini di-dirty-kan karena efek SAMPING
          // dari edit/chunk baru di CHUNK LAIN, bukan karena diedit
          // langsung -- kita TIDAK tahu AABB cell mana persisnya di
          // tetangga ini yang terpengaruh (bisa di sepanjang seluruh sisi
          // yang bersebelahan). forceFullRemesh memaksa remeshChunk()
          // melakukan build FULL untuk tetangga ini di remesh berikutnya,
          // bukan partial berdasar pendingDirtyBounds (yang mungkin ada
          // dari edit LANGSUNG lain di tetangga ini pada siklus yang sama
          // -- tanpa flag ini, partial-nya cuma akan menutupi editnya
          // sendiri dan MELEWATKAN efek samping dari sini, seam bisa
          // robek lagi).
          neighbor.forceFullRemesh = true;
          if (this.mesherPlugin) {
            this.mesherPlugin.markChunkDirty(cx + dx, cy + dy, cz + dz);
          }
        }
      }
    }
  }

  /**
   * Rebuild the mesh for a single chunk using the active VoxelMesher.
   * Returns the generated mesh data (or null if there's nothing to build).
   */
  remeshChunk(cx, cy, cz) {
    if (!this.mesherPlugin) throw new Error('[Engine] Tidak ada Mesher Plugin yang di-inject!');
    const chunk = this.getChunk(cx, cy, cz);
    if (!chunk) return null;

    // Roadmap B.2 -- Partial Remeshing: hanya minta mesher melakukan build
    // PARTIAL kalau SEMUA syarat berikut terpenuhi:
    //   1. Chunk ini TIDAK sedang dipaksa full rebuild (forceFullRemesh --
    //      lihat _dirtyBoundaryNeighbors()/markChunkLoaded(): dipasang saat
    //      chunk ini jadi TETANGGA dari edit/chunk baru, di mana AABB cell
    //      yang terpengaruh tidak diketahui persis).
    //   2. Ada cellCache dari build SEBELUMNYA untuk chunk ini (kalau belum
    //      pernah di-build, tidak ada apa-apa untuk dipakai ulang).
    //   3. Ada pendingDirtyBounds -- akumulasi AABB dari edit LANGSUNG di
    //      chunk ini sejak remesh terakhir (lihat _unionDirtyBounds()).
    // Kalau salah satu tidak terpenuhi (termasuk: chunk baru pertama kali
    // di-build, originChunk/debugChunkBounds baru saja berubah sehingga
    // SEMUA chunk didirty-kan TANPA pendingDirtyBounds -- lihat
    // setOriginChunk()/setDebugChunkBounds()), dirtyBounds/previousCellCache
    // dikirim sebagai null dan SurfaceNetsMesher otomatis melakukan build
    // FULL seperti sebelumnya -- aman secara default.
    const canPartial = !chunk.forceFullRemesh && !!chunk.cellCache && !!chunk.pendingDirtyBounds;

    const ctx = {
      chunkCoord: [cx, cy, cz],
      getNeighbor: (dx, dy, dz) => this.getChunk(cx + dx, cy + dy, cz + dz)?.storage ?? null,
      debugChunkBounds: this.debugChunkBounds,
      originChunk: this.originChunk,
      dirtyBounds: canPartial ? chunk.pendingDirtyBounds : null,
      previousCellCache: canPartial ? chunk.cellCache : null,
    };

    this.emit('beforeMesh', chunk);
    const result = this.mesherPlugin.generateMesh(chunk.storage, ctx);

    // Reset state partial-remeshing SEGERA setelah dikonsumsi (baik jalur
    // sync maupun async di bawah) -- siklus edit berikutnya mulai bersih.
    chunk.pendingDirtyBounds = null;
    chunk.forceFullRemesh = false;

    if (result instanceof Promise) {
      chunk.dirty = false;
      result.then(meshData => {
        chunk.mesh = meshData;
        // Mesher lain (mis. GreedyMesher lewat AsyncWorkerMesher) tidak
        // mengembalikan cellCache sama sekali -- meshData.cellCache
        // otomatis undefined, chunk.cellCache jadi null, dan canPartial di
        // remesh berikutnya otomatis false (full rebuild) untuk mesher
        // itu. Tidak ada perubahan perilaku untuk mesher selain
        // SurfaceNetsMesher.
        chunk.cellCache = meshData && meshData.cellCache ? meshData.cellCache : null;
        this.emit('afterMesh', { chunk, meshData });
      }).catch(e => console.error('[VoxelEngine] Error saat async meshing:', e));
      return result;
    } else {
      chunk.mesh = result;
      chunk.dirty = false;
      chunk.cellCache = result && result.cellCache ? result.cellCache : null;
      this.emit('afterMesh', { chunk, meshData: result });
      return result;
    }
  }

  /**
   * Roadmap A.5 -- Origin Rebasing: pindahkan referensi origin yang dipakai
   * mesher untuk membakar posisi vertex (lihat komentar lengkap di
   * OriginRebase.js dan SurfaceNetsMesher.generateMesh()). Menandai SEMUA
   * chunk yang sedang loaded sebagai dirty -- persis pola yang sama dengan
   * setDebugChunkBounds() -- supaya remesh berikutnya membakar ulang posisi
   * vertex relatif terhadap origin BARU (vertex data yang sudah terlanjur
   * dibakar relatif ke origin lama tidak valid lagi begitu origin berubah).
   *
   * Default this.originChunk = [0,0,0] dan method ini TIDAK PERNAH dipanggil
   * kecuali oleh jalur streaming (main.js) -- engine untuk editor/benchmark/
   * landing.js tidak pernah memanggilnya, jadi originChunk-nya tetap [0,0,0]
   * selamanya dan perilaku baking mesh 100% tidak berubah untuk mereka.
   */
  setOriginChunk(ocx, ocy, ocz) {
    this.originChunk = [ocx, ocy, ocz];
    for (const chunk of this.chunks.values()) chunk.dirty = true;
  }

  /**
   * DEBUG: nyalakan/matikan pewarnaan batas chunk (lihat catatan di
   * constructor). Menandai semua chunk sebagai dirty supaya efeknya
   * langsung terlihat di remesh berikutnya (mis. dipanggil dari
   * remeshDirtyChunks() di render loop).
   */
  setDebugChunkBounds(enabled) {
    this.debugChunkBounds = !!enabled;
    for (const chunk of this.chunks.values()) {
      chunk.dirty = true;
      // Roadmap B.2 -- warna vertex ikut di-cache per-cell (tergantung
      // debugChunkBounds SAAT dihitung). Kalau toggle ini kebetulan
      // terjadi di siklus yang sama dengan edit voxel langsung di sebuah
      // chunk (pendingDirtyBounds-nya sudah terisi), remesh partial
      // berikutnya akan memakai ulang cache LAMA (warna dari sebelum
      // toggle) untuk cell di luar area edit -- warna jadi campur aduk
      // (sebagian lama, sebagian baru) sampai remesh full berikutnya.
      // Cuma cacat kosmetik di alat debug (tidak memengaruhi gameplay),
      // tapi dihindari sepenuhnya dengan memaksa build FULL di sini.
      chunk.forceFullRemesh = true;
    }
  }

  /**
   * Rebuild every chunk currently marked dirty, opsional dibatasi ke budget
   * per-panggilan dan diprioritaskan nearest-first.
   *
   * Hardening A.5: setOriginChunk()/setDebugChunkBounds() menandai SEMUA
   * chunk loaded dirty sekaligus. Tanpa budget, panggilan
   * remeshDirtyChunks() berikutnya (main.js render loop, sekali per frame)
   * membangun ulang SEMUANYA secara sinkron dalam satu frame -- untuk
   * mesher 'surfacenets' (sinkron, dipakai jalur SDF/Infinite Terrain) ini
   * frame hitch yang nyata dan tumbuh sebanding view distance. Memberi
   * `budget` menyebar beban yang sama ke beberapa frame: hanya `budget`
   * chunk dirty TERDEKAT (jarak Chebyshev ke `priorityOrigin`, meniru
   * prioritas dequeueNearest() di ChunkGenerationQueue -- Roadmap A.2) yang
   * di-remesh per panggilan; sisanya tetap dirty dan diambil di panggilan
   * berikutnya. Nearest-first juga berarti chunk yang benar-benar terlihat
   * pemain diperbaiki lebih dulu daripada yang lebih jauh.
   *
   * Caller yang menginginkan perilaku lama (semua sekaligus, tanpa
   * throttle -- editor, mode benchmark, test yang sudah ada) cukup tidak
   * memberi `budget` (default Infinity) -- 100% backward compatible.
   *
   * @param {number} [budget=Infinity] - jumlah maksimum chunk yang di-remesh
   *   dalam panggilan ini.
   * @param {{cx:number, cz:number}|null} [priorityOrigin=null] - kalau
   *   diberikan, chunk dirty diproses nearest-first (jarak Chebyshev)
   *   sebelum budget memotong; kalau tidak, dipakai urutan iterasi Map
   *   (lebih murah, cukup dipakai kalau budget Infinity atau urutan tidak
   *   penting).
   * @returns {Array} chunk yang benar-benar di-rebuild pada panggilan ini.
   */
  remeshDirtyChunks(budget = Infinity, priorityOrigin = null) {
    let dirtyChunks = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) dirtyChunks.push(chunk);
    }

    if (priorityOrigin && dirtyChunks.length > 1) {
      const { cx: ox, cz: oz } = priorityOrigin;
      dirtyChunks.sort((a, b) => {
        const da = Math.max(Math.abs(a.cx - ox), Math.abs(a.cz - oz));
        const db = Math.max(Math.abs(b.cx - ox), Math.abs(b.cz - oz));
        return da - db;
      });
    }

    if (Number.isFinite(budget) && dirtyChunks.length > budget) {
      dirtyChunks = dirtyChunks.slice(0, Math.max(0, budget));
    }

    const rebuilt = [];
    for (const chunk of dirtyChunks) {
      this.remeshChunk(chunk.cx, chunk.cy, chunk.cz);
      rebuilt.push(chunk);
    }
    return rebuilt;
  }

  /**
   * Initialize (or reuse) the configured renderer against a canvas and
   * start the render loop. Accepts either a canvas (if `renderer` was set
   * via config as a string id) or nothing (if useRenderer() was already
   * called with a ready instance).
   */
  async start(canvas, rendererOptions = {}) {
    if (!this.rendererPlugin) {
      if (this._pendingRendererId) {
        const rendererInstance = await this._resolveRenderer(this._pendingRendererId, canvas, rendererOptions);
        this.useRenderer(rendererInstance);
      } else {
        throw new Error(
          '[Engine] Tidak ada Renderer Plugin yang di-inject! Panggil useRenderer() atau set `renderer` di config.'
        );
      }
    } else if (canvas && this.rendererPlugin.ready === false && typeof this.rendererPlugin.init === 'function') {
      await this.rendererPlugin.init(canvas, rendererOptions);
    }

    this.emit('engineStarted', this);
    requestAnimationFrame((time) => this.rendererPlugin.render(time));
    return this;
  }
}
