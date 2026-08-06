import { VoxelStorage } from './VoxelStorage.js';

const BRICK_SIZE = 8;
const BRICK_VOLUME = BRICK_SIZE * BRICK_SIZE * BRICK_SIZE; // 512 voxel per brick

export class BrickMapStorage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);

    // Menghitung jumlah sektor 8x8x8
    this.sectorsX = Math.ceil(sx / BRICK_SIZE);
    this.sectorsY = Math.ceil(sy / BRICK_SIZE);
    this.sectorsZ = Math.ceil(sz / BRICK_SIZE);

    // Top Grid (Peta Sektor). Uint16 memungkinkan hingga 65.535 brick per chunk
    this.topGrid = new Uint16Array(this.sectorsX * this.sectorsY * this.sectorsZ);

    // Brick Pool (Gudang Data). Index 0 adalah Udara Murni.
    this.brickPool = [null];
  }

  // Statistik untuk HUD Benchmarking
  get nodeCount() {
    return this.brickPool.length;
  }

  _getSectorIndex(x, y, z) {
    const sx = Math.floor(x / BRICK_SIZE);
    const sy = Math.floor(y / BRICK_SIZE);
    const sz = Math.floor(z / BRICK_SIZE);
    return sx + sy * this.sectorsX + sz * this.sectorsX * this.sectorsY;
  }

  _getBrickLocalIndex(x, y, z) {
    const lx = x % BRICK_SIZE;
    const ly = y % BRICK_SIZE;
    const lz = z % BRICK_SIZE;
    return lx + ly * BRICK_SIZE + lz * BRICK_SIZE * BRICK_SIZE;
  }

  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;

    const sectorIdx = this._getSectorIndex(x, y, z);
    const brickId = this.topGrid[sectorIdx];

    // Space Skipping: Jika sektor kosong, lompat dan langsung kembalikan udara! (O(1))
    if (brickId === 0) return 0;

    const localIdx = this._getBrickLocalIndex(x, y, z);
    return this.brickPool[brickId][localIdx];
  }

  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;

    const sectorIdx = this._getSectorIndex(x, y, z);
    let brickId = this.topGrid[sectorIdx];

    if (brickId === 0) {
      if (val === 0) return; // Menaruh udara di udara, lewati.

      // Alokasikan memori Flat Grid kecil (Brick) baru ke dalam gudang!
      brickId = this.brickPool.length;
      this.brickPool.push(new Uint8Array(BRICK_VOLUME));
      this.topGrid[sectorIdx] = brickId;
    }

    const localIdx = this._getBrickLocalIndex(x, y, z);
    this.brickPool[brickId][localIdx] = val;
  }

  // Meratakan (Flatten) data untuk dikirim ke VRAM GPU
  serialize() {
    const poolSize = this.brickPool.length;
    const flatPool = new Uint8Array(poolSize * BRICK_VOLUME);

    // Index 0 kosong (udara), kita mulai dari 1
    for (let i = 1; i < poolSize; i++) {
      flatPool.set(this.brickPool[i], i * BRICK_VOLUME);
    }

    return {
      topGrid: this.topGrid,
      brickPool: flatPool,
      dimensions: this.dims,
    };
  }
}
