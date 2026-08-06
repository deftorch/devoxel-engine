export class SVDAGStorage {
  constructor(sx, sy, sz) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.data = new Uint8Array(sx * sy * sz);
    this._nodeCount = 0;
  }

  set(x, y, z, val) {
    this.data[x + y * this.sx + z * this.sx * this.sy] = val;
  }

  get(x, y, z) {
    return this.data[x + y * this.sx + z * this.sx * this.sy];
  }

  get dims() {
    return [this.sx, this.sy, this.sz];
  }

  get nodeCount() {
    if (this._nodeCount === 0) {
      this._nodeCount = this.buildDAG();
    }
    return this._nodeCount;
  }

  // Simulasi Pembangunan DAG Bottom-Up untuk menghitung seberapa ekstrem kompresinya
  buildDAG() {
    let hashMap = new Map();
    let uniqueNodes = 0;

    const getVoxel = (x, y, z) => {
      // Out of bounds is AIR (0)
      if (x >= this.sx || y >= this.sy || z >= this.sz) return 0;
      return this.data[x + y * this.sx + z * this.sx * this.sy];
    };

    const buildNode = (x, y, z, size) => {
      // Base case: Leaf Voxel
      if (size === 1) {
        return getVoxel(x, y, z);
      }

      const half = size / 2;
      const children = [
        buildNode(x, y, z, half),
        buildNode(x + half, y, z, half),
        buildNode(x, y + half, z, half),
        buildNode(x + half, y + half, z, half),
        buildNode(x, y, z + half, half),
        buildNode(x + half, y, z + half, half),
        buildNode(x, y + half, z + half, half),
        buildNode(x + half, y + half, z + half, half),
      ];

      // Optimasi Octree Biasa: Jika ke-8 anak identik, gabungkan jadi 1 Node Raksasa
      let allSame = true;
      let first = children[0];
      for (let i = 1; i < 8; i++) {
        if (children[i] !== first) {
          allSame = false;
          break;
        }
      }
      if (allSame) return first;

      // Keajaiban SVDAG: Deduplikasi cabang yang polanya sama persis!
      // Kita gabungkan 8 pointer anak jadi 1 string unik.
      let hashStr = children.join(',');

      // Jika pola cabang ini sudah pernah dibuat sebelumnya, pakai ulang (Pointer)
      if (hashMap.has(hashStr)) {
        return hashMap.get(hashStr);
      }

      // Jika belum ada, kita catat ini sebagai 1 Node unik baru di Memori GPU
      uniqueNodes++;
      let pointer = 'PTR_' + uniqueNodes;
      hashMap.set(hashStr, pointer);
      return pointer;
    };

    // Karena ukuran chunk 16x40x16, kita harus membuat root node ukuran kelipatan 2 terdekat
    // yaitu 64x64x64. (Udara di luar batas 40 akan otomatis dikompresi SVDAG dengan sempurna)
    buildNode(0, 0, 0, 64);

    // Minimal selalu ada 1 node jika tidak 100% homogen
    return uniqueNodes === 0 ? 1 : uniqueNodes;
  }
}
