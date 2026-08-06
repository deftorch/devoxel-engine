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
      chunk = { cx, cy, cz, storage, dirty: true, mesh: null };
      this.chunks.set(key, chunk);
      this.emit('chunkCreated', chunk);
    }
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

    this.emit('afterVoxelEdit', { x, y, z, value });

    // Beritahu Mesher bahwa chunk ini 'kotor' dan harus di-rebuild
    if (this.mesherPlugin) {
      this.mesherPlugin.markChunkDirty(cx, cy, cz);
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

    const ctx = {
      chunkCoord: [cx, cy, cz],
      getNeighbor: (dx, dy, dz) => this.getChunk(cx + dx, cy + dy, cz + dz)?.storage ?? null,
    };

    this.emit('beforeMesh', chunk);
    const meshData = this.mesherPlugin.generateMesh(chunk.storage, ctx);
    chunk.mesh = meshData;
    chunk.dirty = false;
    this.emit('afterMesh', { chunk, meshData });
    return meshData;
  }

  /** Rebuild every chunk currently marked dirty. */
  remeshDirtyChunks() {
    const rebuilt = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) {
        this.remeshChunk(chunk.cx, chunk.cy, chunk.cz);
        rebuilt.push(chunk);
      }
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
