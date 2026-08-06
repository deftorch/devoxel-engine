/**
 * @typedef {Object} BlockDefinition
 * @property {number} id - Unique numeric ID for the voxel data array.
 * @property {string} name - Human-readable name.
 * @property {Object} color - RGB color array [R,G,B].
 * @property {number[]} color.top - Color for the top face.
 * @property {number[]} color.side - Color for the side/bottom faces.
 */

/**
 * Registry of all available blocks in the engine.
 * @type {Object.<string, BlockDefinition>}
 */
export const Blocks = {
  AIR: { id: 0, name: 'Air', color: { top: [0, 0, 0], side: [0, 0, 0] } },
  GRASS: { id: 1, name: 'Grass', color: { top: [0.38, 0.66, 0.27], side: [0.42, 0.3, 0.17] } },
  DIRT: { id: 2, name: 'Dirt', color: { top: [0.42, 0.3, 0.17], side: [0.42, 0.3, 0.17] } },
  STONE: { id: 3, name: 'Stone', color: { top: [0.52, 0.52, 0.55], side: [0.52, 0.52, 0.55] } },
  // id=4 sudah dipakai sebagai warna "Salju/Lainnya" hardcode di raytrace.wgsl.js
  // (lihat cabang `else if (voxelColor == 4u)`) — didefinisikan resmi di sini.
  SNOW: { id: 4, name: 'Snow', color: { top: [0.92, 0.92, 0.95], side: [0.92, 0.92, 0.95] } },
  // Dipakai skenario uji `gi-colorwall` (color bleeding, Fase 2 roadmap GI).
  BRICK_RED: { id: 5, name: 'Brick Red', color: { top: [0.72, 0.14, 0.12], side: [0.72, 0.14, 0.12] } },
};

// Auto-generate reverse lookups for mesher optimization
export const BLOCK_IDS = {
  AIR: Blocks.AIR.id,
  GRASS: Blocks.GRASS.id,
  DIRT: Blocks.DIRT.id,
  STONE: Blocks.STONE.id,
  SNOW: Blocks.SNOW.id,
  BRICK_RED: Blocks.BRICK_RED.id,
};

export const BLOCK_COLORS_BY_ID = {};
for (const key in Blocks) {
  BLOCK_COLORS_BY_ID[Blocks[key].id] = Blocks[key].color;
}
