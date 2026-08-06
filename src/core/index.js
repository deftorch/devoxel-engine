/**
 * Devoxel — Universal Voxel Framework
 * ---------------------------------------------------------------------------
 * Single entrypoint for the core, engine-agnostic framework layer.
 * Importing this file registers all built-in storage/mesher/renderer
 * plugins with the default registry as a side effect.
 */
export { VoxelEngine } from './VoxelEngine.js';
export { PluginRegistry, defaultRegistry } from './registry/PluginRegistry.js';
export { CommandBus } from './api/CommandBus.js';

// Base contracts (extend these to build your own plugins)
export { VoxelStorage } from './voxel/VoxelStorage.js';
export { VoxelMesher } from './mesher/VoxelMesher.js';
export { VoxelRenderer } from './renderer/VoxelRenderer.js';

// Built-in plugins (importing these registers them with defaultRegistry)
export * from './voxel/index.js';
export * from './mesher/index.js';
export { createRenderer, VoxelRendererAdapter } from './renderer/index.js';
