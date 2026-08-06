import { BLOCK_IDS, BLOCK_COLORS_BY_ID } from '../../data/blocks.js';

export function greedyMesh(dims, getVoxel) {
  const quads = [];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[d] = 1;
    const mask = new Int32Array(dims[u] * dims[v]);

    for (x[d] = -1; x[d] < dims[d];) {
      let n = 0;
      for (x[v] = 0; x[v] < dims[v]; x[v]++) {
        for (x[u] = 0; x[u] < dims[u]; x[u]++, n++) {
          const a = x[d] >= 0 ? getVoxel(x[0], x[1], x[2]) : 0;
          const xb0 = x[0] + q[0],
            xb1 = x[1] + q[1],
            xb2 = x[2] + q[2];
          const b = x[d] < dims[d] - 1 ? getVoxel(xb0, xb1, xb2) : 0;
          if (!!a === !!b) mask[n] = 0;
          else if (a) mask[n] = a;
          else mask[n] = -b;
        }
      }
      x[d]++;

      n = 0;
      for (let j = 0; j < dims[v]; j++) {
        for (let i = 0; i < dims[u];) {
          const c = mask[n];
          if (c) {
            let w = 1;
            while (i + w < dims[u] && mask[n + w] === c) w++;
            let h = 1,
              done = false;
            while (j + h < dims[v]) {
              for (let k = 0; k < w; k++) {
                if (mask[n + k + h * dims[u]] !== c) {
                  done = true;
                  break;
                }
              }
              if (done) break;
              h++;
            }
            x[u] = i;
            x[v] = j;
            const du = [0, 0, 0];
            du[u] = w;
            const dv = [0, 0, 0];
            dv[v] = h;
            quads.push({ pos: [x[0], x[1], x[2]], du, dv, type: Math.abs(c), backFace: c < 0, axis: d });
            for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * dims[u]] = 0;
            i += w;
            n += w;
          } else {
            i++;
            n++;
          }
        }
      }
    }
  }
  return quads;
}

export function buildMeshFromQuads(quads, originX, originZ) {
  const positions = [],
    normals = [],
    colors = [],
    indices = [];
  let vi = 0;
  const normalFor = (axis, back) => {
    const n = [0, 0, 0];
    n[axis] = back ? -1 : 1;
    return n;
  };
  for (const q of quads) {
    const [px, py, pz] = q.pos;
    const p1 = [px, py, pz];
    const p2 = [px + q.du[0], py + q.du[1], pz + q.du[2]];
    const p3 = [px + q.du[0] + q.dv[0], py + q.du[1] + q.dv[1], pz + q.du[2] + q.dv[2]];
    const p4 = [px + q.dv[0], py + q.dv[1], pz + q.dv[2]];
    const n = normalFor(q.axis, q.backFace);
    const isTop = q.axis === 1 && !q.backFace;
    const palette = BLOCK_COLORS_BY_ID[q.type] || BLOCK_COLORS_BY_ID[BLOCK_IDS.STONE];
    const col = isTop ? palette.top : palette.side;

    for (const p of [p1, p2, p3, p4]) {
      positions.push(p[0] + originX, p[1], p[2] + originZ);
      normals.push(n[0], n[1], n[2]);
      colors.push(col[0], col[1], col[2]);
    }
    if (!q.backFace) {
      indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    } else {
      indices.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
    }
    vi += 4;
  }
  return {
    vertexData: interleave(positions, normals, colors),
    indexData: new Uint32Array(indices),
    indexCount: indices.length,
  };
}

export function interleave(positions, normals, colors) {
  const count = positions.length / 3;
  const out = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    out[i * 9 + 0] = positions[i * 3 + 0];
    out[i * 9 + 1] = positions[i * 3 + 1];
    out[i * 9 + 2] = positions[i * 3 + 2];
    out[i * 9 + 3] = normals[i * 3 + 0];
    out[i * 9 + 4] = normals[i * 3 + 1];
    out[i * 9 + 5] = normals[i * 3 + 2];
    out[i * 9 + 6] = colors[i * 3 + 0];
    out[i * 9 + 7] = colors[i * 3 + 1];
    out[i * 9 + 8] = colors[i * 3 + 2];
  }
  return out;
}
