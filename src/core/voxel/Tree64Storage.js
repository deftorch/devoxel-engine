import { VoxelStorage } from './VoxelStorage.js';

class Tree64Node {
  constructor(val = 0) {
    this.val = val; 
    // Bitmask okupansi untuk 64 anak. 
    // Menggunakan dua u32 untuk mempermudah passing ke WebGPU.
    this.maskLow = 0;  // merepresentasikan okupansi anak 0-31
    this.maskHigh = 0; // merepresentasikan okupansi anak 32-63
    this.children = null; 
  }
}

export class Tree64Storage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);
    // Tree64 biasanya beroperasi maksimal pada dimensi berpangkat 4 (misal 64)
    // Depth: 64 -> 16 -> 4 -> 1 (hanya 3 level kedalaman)
    this.rootSize = 64; 
    this.root = new Tree64Node(0); 
    this.nodeCount = 1;
  }

  _isHomogeneous(children) {
    if (!children) return true;
    const first = children[0].val;
    if (first === -1) return false;
    for (let i = 1; i < 64; i++) {
      if (children[i].val !== first || children[i].val === -1) return false;
    }
    return true;
  }

  _getIndex(cx, cy, cz, size) {
    const quarter = size / 4;
    const segX = Math.floor(cx / quarter);
    const segY = Math.floor(cy / quarter);
    const segZ = Math.floor(cz / quarter);
    return segX + (segY * 4) + (segZ * 16);
  }

  _updateMask(node) {
    if (!node.children) {
      node.maskLow = 0;
      node.maskHigh = 0;
      return;
    }
    node.maskLow = 0;
    node.maskHigh = 0;
    for (let i = 0; i < 64; i++) {
      // Kita asumsikan val > 0 adalah blok/benda padat (okupansi = 1)
      if (node.children[i].val !== 0) { 
        if (i < 32) {
          node.maskLow = (node.maskLow | (1 << i)) >>> 0;
        } else {
          node.maskHigh = (node.maskHigh | (1 << (i - 32))) >>> 0;
        }
      }
    }
  }

  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this._setRec(this.root, 0, 0, 0, this.rootSize, x, y, z, val);
  }

  _setRec(node, nx, ny, nz, size, x, y, z, val) {
    // Basis kasus: tingkat voxel tunggal (ukuran 1)
    if (size === 1) {
      node.val = val;
      return;
    }
    
    // Jika tidak ada perubahan
    if (node.val === val) return;

    // Jika node tadinya homogen/kosong, pecah jadi 64 anak
    if (node.children === null) {
      node.children = new Array(64);
      for (let i = 0; i < 64; i++) {
        node.children[i] = new Tree64Node(node.val);
        this.nodeCount++;
      }
      node.val = -1; // -1 = flag untuk heterogen
    }

    const quarter = size / 4;
    const cidx = this._getIndex(x - nx, y - ny, z - nz, size);
    
    const childNx = nx + (cidx % 4) * quarter;
    const childNy = ny + (Math.floor(cidx / 4) % 4) * quarter;
    const childNz = nz + (Math.floor(cidx / 16)) * quarter;

    this._setRec(node.children[cidx], childNx, childNy, childNz, quarter, x, y, z, val);

    // Coba gabungkan (simplify) jika seluruh 64 anak kini identik
    if (this._isHomogeneous(node.children)) {
      node.val = node.children[0].val;
      node.children = null;
      node.maskLow = 0;
      node.maskHigh = 0;
      this.nodeCount -= 64;
    } else {
      // Perbarui bitmask okupansi untuk export ke WebGPU nanti
      this._updateMask(node);
    }
  }

  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    return this._getRec(this.root, 0, 0, 0, this.rootSize, x, y, z);
  }

  _getRec(node, nx, ny, nz, size, x, y, z) {
    if (node.children === null) return node.val;
    const quarter = size / 4;
    const cidx = this._getIndex(x - nx, y - ny, z - nz, size);
    const childNx = nx + (cidx % 4) * quarter;
    const childNy = ny + (Math.floor(cidx / 4) % 4) * quarter;
    const childNz = nz + (Math.floor(cidx / 16)) * quarter;
    return this._getRec(node.children[cidx], childNx, childNy, childNz, quarter, x, y, z);
  }
}
