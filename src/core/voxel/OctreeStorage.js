import { VoxelStorage } from './VoxelStorage.js';

class OctreeNode {
  constructor(val = 0) {
    this.val = val;
    this.children = null;
  }
}

export class OctreeStorage extends VoxelStorage {
  constructor(sx, sy, sz) {
    super([sx, sy, sz]);
    this.rootSize = 64;
    this.root = new OctreeNode(0);
    this.nodeCount = 1;
  }

  _isHomogeneous(children) {
    if (!children) return true;
    const first = children[0].val;
    if (first === -1) return false;
    for (let i = 1; i < 8; i++) {
      if (children[i].val !== first || children[i].val === -1) return false;
    }
    return true;
  }

  _getIndex(cx, cy, cz, size) {
    const half = size / 2;
    const x = cx >= half ? 1 : 0;
    const y = cy >= half ? 1 : 0;
    const z = cz >= half ? 1 : 0;
    return x + y * 2 + z * 4;
  }

  set(x, y, z, val) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return;
    this._setRec(this.root, 0, 0, 0, this.rootSize, x, y, z, val);
  }

  _setRec(node, nx, ny, nz, size, x, y, z, val) {
    if (size === 1) {
      node.val = val;
      return;
    }
    if (node.val === val) return;

    if (node.children === null) {
      node.children = new Array(8);
      for (let i = 0; i < 8; i++) {
        node.children[i] = new OctreeNode(node.val);
        this.nodeCount++;
      }
      node.val = -1;
    }

    const half = size / 2;
    const cidx = this._getIndex(x - nx, y - ny, z - nz, size);

    const childNx = nx + (cidx & 1 ? half : 0);
    const childNy = ny + (cidx & 2 ? half : 0);
    const childNz = nz + (cidx & 4 ? half : 0);

    this._setRec(node.children[cidx], childNx, childNy, childNz, half, x, y, z, val);

    if (this._isHomogeneous(node.children)) {
      node.val = node.children[0].val;
      node.children = null;
      this.nodeCount -= 8;
    }
  }

  get(x, y, z) {
    if (x < 0 || x >= this.dims[0] || y < 0 || y >= this.dims[1] || z < 0 || z >= this.dims[2]) return 0;
    return this._getRec(this.root, 0, 0, 0, this.rootSize, x, y, z);
  }

  _getRec(node, nx, ny, nz, size, x, y, z) {
    if (node.children === null) return node.val;
    const half = size / 2;
    const cidx = this._getIndex(x - nx, y - ny, z - nz, size);
    const childNx = nx + (cidx & 1 ? half : 0);
    const childNy = ny + (cidx & 2 ? half : 0);
    const childNz = nz + (cidx & 4 ? half : 0);
    return this._getRec(node.children[cidx], childNx, childNy, childNz, half, x, y, z);
  }
}
