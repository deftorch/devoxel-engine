import { createWorld, addComponent, removeEntity, observe, onRemove } from 'https://esm.sh/bitecs@0.4.0';

export const world = createWorld();

/**
 * Creates a component backed by TypedArrays that auto-doubles its capacity
 * when a new entity exceeds the current limit. This prevents silent overflows.
 * @param {Object.<string, Function>} fields - Mapping of field names to TypedArray constructors (e.g., { x: Float32Array })
 * @param {number} [initialCapacity=64] - Starting entity limit
 * @returns {Object} The component store
 */
export function growableComponent(fields, initialCapacity = 64) {
  const store = { __capacity: initialCapacity };
  for (const [name, Ctor] of Object.entries(fields)) store[name] = new Ctor(initialCapacity);
  store.__ensure = function (eid) {
    if (eid < store.__capacity) return;
    let newCap = store.__capacity;
    while (newCap <= eid) newCap *= 2;
    for (const [name, Ctor] of Object.entries(fields)) {
      const grown = new Ctor(newCap);
      grown.set(store[name]);
      store[name] = grown;
    }
    store.__capacity = newCap;
  };
  return store;
}

/**
 * Safely adds a growable component to an entity, resizing the backing arrays if necessary.
 * @param {Object} world - bitECS world
 * @param {number} eid - Entity ID
 * @param {Object} component - Component created via growableComponent
 */
export function addGrowable(world, eid, component) {
  component.__ensure(eid);
  addComponent(world, eid, component);
}

/** @type {{cx: Int32Array, cz: Int32Array, __ensure: Function}} */
export const ChunkCoord = growableComponent({ cx: Int32Array, cz: Int32Array }, 64);

/** @type {{indexCount: Int32Array, __ensure: Function}} */
export const Renderable = growableComponent({ indexCount: Int32Array }, 64);

/** @type {{x: Float32Array, y: Float32Array, z: Float32Array, __ensure: Function}} */
export const Position = growableComponent({ x: Float32Array, y: Float32Array, z: Float32Array }, 8);

/** @type {{yaw: Float32Array, pitch: Float32Array, __ensure: Function}} */
export const Look = growableComponent({ yaw: Float32Array, pitch: Float32Array }, 8);

/** 
 * Non-TypedArray component for storing complex objects (like WebGPU buffers). 
 * @type {{meshes: Array<Object>}} 
 */
export const RenderMesh = { meshes: [] };

// Automatically clean up GPU resources when the RenderMesh component is removed
observe(world, onRemove(RenderMesh), (eid) => {
  RenderMesh.meshes[eid]?.destroy();
  RenderMesh.meshes[eid] = null;
});

/**
 * Component for storing the VoxelRT volume handle returned by renderer.createVoxelVolume().
 * Menyimpan objek `volume` itu sendiri (bukan .topGridBuffer/.brickPoolBuffer terpisah — untuk
 * mode raytrace, storage-nya global/shared, jadi yang relevan per-entity hanya handle destroy()-nya).
 * @type {{volume: Array<Object>}}
 */
export const VoxelVolume = { volume: [] };

// Automatically free the entity's brick pool slots (freeChunkVolume) when the component is removed
observe(world, onRemove(VoxelVolume), (eid) => {
  VoxelVolume.volume[eid]?.destroy();
  VoxelVolume.volume[eid] = null;
});

/**
 * Completely removes an entity, triggering cleanup observers.
 * @param {Object} world - bitECS world
 * @param {number} eid - Entity ID
 */
export function destroyChunkEntity(world, eid) {
  removeEntity(world, eid);
}
