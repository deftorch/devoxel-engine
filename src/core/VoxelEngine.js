import { CommandBus } from './api/CommandBus.js';

/**
 * Universal Voxel Engine Core
 * Bertindak sebagai 'Otak Utama' (Hub) yang menghubungkan Storage, Mesher, dan Renderer.
 * Ini memastikan game tidak hardcoded ke satu jenis rendering atau meshing.
 */
export class VoxelEngine {
  constructor(options = {}) {
    // 1. Sistem Komunikasi (Event Bus & MCP Commands)
    this.commands = new CommandBus();
    this.events = new Map();
    
    // 2. Skema Data (Data-Driven Voxel Payload)
    // Pengguna bisa mendefinisikan bentuk memori mereka sendiri (misal: Float32 untuk SDF)
    this.storageSchema = options.storageSchema || { type: 'Uint8', name: 'MaterialID' };
    
    // 3. Plugin System
    this.mesherPlugin = null;    // Algoritma pembuat 3D (Greedy, Marching Cubes, dll)
    this.rendererPlugin = null;  // Mesin gambar (WebGPU, WebGL, Raytracer)
    this.storageFactory = null;  // Fungsi untuk membuat chunk (SVDAG, Octree, dll)
    
    // State Dunia
    this.chunks = new Map();
  }

  // --- PLUGIN INJECTION ---

  useMesher(mesherInstance) {
    this.mesherPlugin = mesherInstance;
    console.log(`[Engine] Mesher diatur ke: ${mesherInstance.constructor.name}`);
    return this; // Method chaining
  }

  useRenderer(rendererInstance) {
    this.rendererPlugin = rendererInstance;
    console.log(`[Engine] Renderer diatur ke: ${rendererInstance.constructor.name}`);
    return this;
  }

  useStorageProvider(factoryFunction) {
    this.storageFactory = factoryFunction;
    return this;
  }

  // --- EVENT SYSTEM (HOOKS) ---

  on(eventName, callback) {
    if (!this.events.has(eventName)) this.events.set(eventName, []);
    this.events.get(eventName).push(callback);
  }

  emit(eventName, payload) {
    if (this.events.has(eventName)) {
      for (const cb of this.events.get(eventName)) {
        cb(payload);
      }
    }
  }

  // --- ENGINE API ---

  setVoxel(x, y, z, value) {
    this.emit('beforeVoxelEdit', { x, y, z, value });
    
    // Logika mutasi chunk sebenarnya ditaruh di sini
    // (misalnya mencari chunk berdasarkan koordinat global)
    
    this.emit('afterVoxelEdit', { x, y, z, value });
    
    // Beritahu Mesher bahwa chunk ini 'kotor' dan harus di-rebuild
    if (this.mesherPlugin) {
      this.mesherPlugin.markChunkDirty(x, y, z);
    }
  }

  start() {
    if (!this.rendererPlugin) throw new Error("Tidak ada Renderer Plugin yang di-inject!");
    this.emit('engineStarted', this);
    // Mulai render loop
    requestAnimationFrame((time) => this.rendererPlugin.render(time));
  }
}
