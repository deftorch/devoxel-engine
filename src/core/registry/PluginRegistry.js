/**
 * PluginRegistry
 * ---------------------------------------------------------------------------
 * Central registry for the three plugin kinds that make Devoxel a
 * "Universal Voxel Framework": storage backends, meshers, and renderers.
 *
 * Instead of importing a concrete class and wiring it by hand, plugins
 * register themselves (or are registered by an app) under a string id.
 * VoxelEngine then resolves plugins by id from a config object, so the
 * whole engine can be reconfigured without touching engine internals.
 *
 * Usage:
 *   registry.registerStorage('flatgrid', (sx, sy, sz) => new FlatGridStorage(sx, sy, sz));
 *   registry.registerMesher('greedy', () => new GreedyMesher());
 *   registry.registerRenderer('webgl', (canvas, opts) => WebGLRenderer.create(canvas, opts));
 *
 *   const storage = registry.createStorage('flatgrid', 16, 40, 16);
 */
export class PluginRegistry {
  constructor() {
    this._storage = new Map();
    this._mesher = new Map();
    this._renderer = new Map();
  }

  // --- STORAGE -------------------------------------------------------------
  registerStorage(id, factory, meta = {}) {
    this._register(this._storage, 'storage', id, factory, meta);
    return this;
  }
  createStorage(id, ...args) {
    return this._create(this._storage, 'storage', id, args);
  }

  // --- MESHER ----------------------------------------------------------------
  registerMesher(id, factory, meta = {}) {
    this._register(this._mesher, 'mesher', id, factory, meta);
    return this;
  }
  createMesher(id, ...args) {
    return this._create(this._mesher, 'mesher', id, args);
  }

  // --- RENDERER --------------------------------------------------------------
  registerRenderer(id, factory, meta = {}) {
    this._register(this._renderer, 'renderer', id, factory, meta);
    return this;
  }
  createRenderer(id, ...args) {
    return this._create(this._renderer, 'renderer', id, args);
  }

  // --- INTROSPECTION ---------------------------------------------------------
  list(kind) {
    const map = this._mapFor(kind);
    return Array.from(map.entries()).map(([id, entry]) => ({ id, ...entry.meta }));
  }

  has(kind, id) {
    return this._mapFor(kind).has(id);
  }

  // --- INTERNALS ---------------------------------------------------------------
  _mapFor(kind) {
    if (kind === 'storage') return this._storage;
    if (kind === 'mesher') return this._mesher;
    if (kind === 'renderer') return this._renderer;
    throw new Error(`[PluginRegistry] Unknown plugin kind: ${kind}`);
  }

  _register(map, kind, id, factory, meta) {
    if (typeof factory !== 'function') {
      throw new Error(`[PluginRegistry] ${kind} "${id}" must be registered with a factory function.`);
    }
    if (map.has(id)) {
      console.warn(`[PluginRegistry] Overwriting ${kind} plugin: "${id}"`);
    }
    map.set(id, { factory, meta });
  }

  _create(map, kind, id, args) {
    const entry = map.get(id);
    if (!entry) {
      const available = Array.from(map.keys()).join(', ') || '(none registered)';
      throw new Error(`[PluginRegistry] Unknown ${kind} plugin: "${id}". Available: ${available}`);
    }
    return entry.factory(...args);
  }
}

// Singleton registry shared by the whole framework. Apps can also
// `new PluginRegistry()` themselves if they need isolated instances
// (e.g. for tests or multiple engines with different plugin sets).
export const defaultRegistry = new PluginRegistry();
