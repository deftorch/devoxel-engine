import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from '../../core/config.js';
import { BLOCK_IDS } from '../../data/blocks.js';
import { heightAt } from './noise.js';
import { FlatGridStorage } from '../../core/voxel/FlatGridStorage.js';
import { OctreeStorage } from '../../core/voxel/OctreeStorage.js';
import { BrickMapStorage } from '../../core/voxel/BrickMapStorage.js';
import { SVDAGStorage } from '../../core/voxel/SVDAGStorage.js';

export function generateChunkVoxels(chunkX, chunkZ, storageType = 'flat', terrainType = 'normal') {
  let storage;
  if (storageType === 'octree') storage = new OctreeStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else if (storageType === 'brickmap') storage = new BrickMapStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else if (storageType === 'svdag') storage = new SVDAGStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  else storage = new FlatGridStorage(CHUNK_SX, CHUNK_SY, CHUNK_SZ);
  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      const wx = chunkX * CHUNK_SX + x;
      const wz = chunkZ * CHUNK_SZ + z;
      
      if (terrainType === 'normal') {
        const h = heightAt(wx, wz, CHUNK_SY);
        for (let y = 0; y < CHUNK_SY; y++) {
          let b = BLOCK_IDS.AIR;
          if (y < h) b = (y > h - 4) ? BLOCK_IDS.DIRT : BLOCK_IDS.STONE;
          else if (y === h) b = BLOCK_IDS.GRASS;
          storage.set(x, y, z, b);
        }
      } 
      else if (terrainType === 'checkerboard') {
        for (let y = 0; y < CHUNK_SY; y++) {
          // Pola selang-seling (mimpi buruk untuk Octree, mudah untuk Flat Grid)
          const b = (x + y + z) % 2 === 0 ? BLOCK_IDS.STONE : BLOCK_IDS.AIR;
          storage.set(x, y, z, b);
        }
      } 
      else if (terrainType === 'homogeneous') {
        for (let y = 0; y < CHUNK_SY; y++) {
          // Solid rata setengah bawah (sangat optimal untuk Octree)
          storage.set(x, y, z, y < 20 ? BLOCK_IDS.STONE : BLOCK_IDS.AIR);
        }
      }
    }
  }
  return storage;
}
