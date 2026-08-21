import { mat3RotX, mat3RotY, mat3RotZ, mat3Mul, mat3Apply, vAdd, vSub, vScale, vCross, vNorm } from '../core/utils/math.js?v=2';
import { Transform, ColorComp, NodeMeta, EditorContext } from './state.js';

// --- Math Helpers for local use ---
function rotationMat3(rx, ry, rz) {
  const d = Math.PI / 180;
  return mat3Mul(mat3Mul(mat3RotZ(rz * d), mat3RotY(ry * d)), mat3RotX(rx * d));
}

function interleave(positions, normals, colors) {
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

export function buildCubeMesh(t) {
  const { ox, oy, oz, sx, sy, sz, px, py, pz, rx, ry, rz, r, g, b } = t;
  const R = rotationMat3(rx, ry, rz);
  const corner = (lx, ly, lz) => {
    const wx = ox + lx,
      wy = oy + ly,
      wz = oz + lz;
    const rel = mat3Apply(R, [wx - px, wy - py, wz - pz]);
    return [rel[0] + px, rel[1] + py, rel[2] + pz];
  };
  const c000 = corner(0, 0, 0),
    c100 = corner(sx, 0, 0),
    c010 = corner(0, sy, 0),
    c001 = corner(0, 0, sz);
  const c110 = corner(sx, sy, 0),
    c101 = corner(sx, 0, sz),
    c011 = corner(0, sy, sz),
    c111 = corner(sx, sy, sz);

  const faces = [
    { n: [1, 0, 0], q: [c100, c110, c111, c101] },
    { n: [-1, 0, 0], q: [c000, c001, c011, c010] },
    { n: [0, 1, 0], q: [c010, c011, c111, c110] },
    { n: [0, -1, 0], q: [c000, c100, c101, c001] },
    { n: [0, 0, 1], q: [c001, c101, c111, c011] },
    { n: [0, 0, -1], q: [c000, c010, c110, c100] },
  ];
  const nWorld = (n) => mat3Apply(R, n);
  const positions = [],
    normals = [],
    colors = [],
    indices = [];
  let vi = 0;
  for (const f of faces) {
    const wn = nWorld(f.n);
    for (const p of f.q) {
      positions.push(p[0], p[1], p[2]);
      normals.push(wn[0], wn[1], wn[2]);
      colors.push(r, g, b);
    }
    indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
  return {
    vertexData: interleave(positions, normals, colors),
    indexData: new Uint32Array(indices),
    indexCount: indices.length,
  };
}

export function buildDynamicGrid(target, distance, yaw = 0, pitch = Math.PI/4) {
  // Determine plane based on camera orientation
  let plane = 'XZ'; // default (Top/Bottom or diagonal)
  
  const pYaw = ((yaw % (Math.PI*2)) + Math.PI*2) % (Math.PI*2); 
  const eps = 0.05;
  const isZero = v => Math.abs(v) < eps || Math.abs(v - Math.PI*2) < eps;
  const isHalfPi = v => Math.abs(v - Math.PI/2) < eps || Math.abs(v - Math.PI*1.5) < eps;
  const isPi = v => Math.abs(v - Math.PI) < eps;
  
  if (Math.abs(pitch) < eps) {
    if (isZero(pYaw) || isPi(pYaw)) plane = 'XY';
    else if (isHalfPi(pYaw)) plane = 'YZ';
  } else if (Math.abs(Math.abs(pitch) - Math.PI/2) < eps) {
    plane = 'XZ';
  }

  const positions = [], colors = [];
  const logDist = Math.log10(Math.max(1, distance / 8));
  const order = Math.floor(logDist);
  const blend = logDist - order; 
  
  const stepMajor = Math.pow(10, order + 1);
  const stepMinor = Math.pow(10, order);
  
  const cgx = Math.floor(target[plane === 'YZ' ? 2 : 0] / stepMinor) * stepMinor; 
  const cgy = Math.floor(target[plane === 'XZ' ? 2 : 1] / stepMinor) * stepMinor; 
  
  const gridSize = Math.max(40, distance * 5);
  const half = gridSize / 2;
  
  const bg = [0.53, 0.72, 0.86]; 
  const mixCol = (col, a) => [
    col[0] * a + bg[0] * (1 - a),
    col[1] * a + bg[1] * (1 - a),
    col[2] * a + bg[2] * (1 - a)
  ];

  const baseDim = [0.35, 0.45, 0.55]; 
  const baseMajor = [0.2, 0.3, 0.45];
  const axisColorX = [0.85, 0.25, 0.25];
  const axisColorY = [0.25, 0.85, 0.25];
  const axisColorZ = [0.25, 0.45, 0.85];

  let cAxisGx, cAxisGy;
  if (plane === 'XZ') { cAxisGx = axisColorZ; cAxisGy = axisColorX; }
  else if (plane === 'XY') { cAxisGx = axisColorY; cAxisGy = axisColorX; }
  else { /* YZ */ cAxisGx = axisColorY; cAxisGy = axisColorZ; }
  
  const start = -Math.ceil(half / stepMinor) * stepMinor;
  const end = Math.ceil(half / stepMinor) * stepMinor;

  const pushLine = (gx1, gy1, gx2, gy2, c1, c2) => {
    if (plane === 'XY') positions.push(gx1, gy1, 0, gx2, gy2, 0);
    else if (plane === 'YZ') positions.push(0, gy1, gx1, 0, gy2, gx2);
    else positions.push(gx1, 0, gy1, gx2, 0, gy2);
    colors.push(...c1, ...c2);
  };

  const getFade = (dx, dy) => {
    const dist = Math.hypot(dx, dy) / half;
    return Math.max(0, 1.0 - dist * dist * dist); 
  };
  
  const off = Math.max(0.01, distance * 0.002); // Thickness offset based on camera distance

  for (let i = start; i <= end; i += stepMinor) {
    const ngx = cgx + i;
    const ngy = cgy + i;
    
    // --- Grid X lines (parallel to Gy) ---
    const isMajorGx = Math.abs(ngx % stepMajor) < 1e-4;
    const isAxisGy = Math.abs(ngx) < 1e-4; 
    const lineAlphaGx = isMajorGx ? 1.0 : Math.max(0, 1.0 - blend * 1.5); 
    const colGx = isAxisGy ? cAxisGx : isMajorGx ? baseMajor : baseDim;
    
    const fadeGx_start = getFade(ngx - cgx, start);
    const fadeGx_mid = getFade(ngx - cgx, 0);
    const fadeGx_end = getFade(ngx - cgx, end);
    
    const cgx_c1 = mixCol(colGx, lineAlphaGx * fadeGx_start);
    const cgx_c2 = mixCol(colGx, lineAlphaGx * fadeGx_mid);
    const cgx_c3 = mixCol(colGx, lineAlphaGx * fadeGx_end);
    
    pushLine(ngx, cgy + start, ngx, cgy, cgx_c1, cgx_c2);
    pushLine(ngx, cgy, ngx, cgy + end, cgx_c2, cgx_c3);
    
    if (isAxisGy) {
      pushLine(ngx - off, cgy + start, ngx - off, cgy, cgx_c1, cgx_c2);
      pushLine(ngx - off, cgy, ngx - off, cgy + end, cgx_c2, cgx_c3);
      pushLine(ngx + off, cgy + start, ngx + off, cgy, cgx_c1, cgx_c2);
      pushLine(ngx + off, cgy, ngx + off, cgy + end, cgx_c2, cgx_c3);
    }

    // --- Grid Y lines (parallel to Gx) ---
    const isMajorGy = Math.abs(ngy % stepMajor) < 1e-4;
    const isAxisGx = Math.abs(ngy) < 1e-4;
    const lineAlphaGy = isMajorGy ? 1.0 : Math.max(0, 1.0 - blend * 1.5);
    const colGy = isAxisGx ? cAxisGy : isMajorGy ? baseMajor : baseDim;
    
    const fadeGy_start = getFade(start, ngy - cgy);
    const fadeGy_mid = getFade(0, ngy - cgy);
    const fadeGy_end = getFade(end, ngy - cgy);
    
    const cgy_c1 = mixCol(colGy, lineAlphaGy * fadeGy_start);
    const cgy_c2 = mixCol(colGy, lineAlphaGy * fadeGy_mid);
    const cgy_c3 = mixCol(colGy, lineAlphaGy * fadeGy_end);
    
    pushLine(cgx + start, ngy, cgx, ngy, cgy_c1, cgy_c2);
    pushLine(cgx, ngy, cgx + end, ngy, cgy_c2, cgy_c3);
    
    if (isAxisGx) {
      pushLine(cgx + start, ngy - off, cgx, ngy - off, cgy_c1, cgy_c2);
      pushLine(cgx, ngy - off, cgx + end, ngy - off, cgy_c2, cgy_c3);
      pushLine(cgx + start, ngy + off, cgx, ngy + off, cgy_c1, cgy_c2);
      pushLine(cgx, ngy + off, cgx + end, ngy + off, cgy_c2, cgy_c3);
    }
  }
  return interleaveLine(positions, colors);
}

export function interleaveLine(positions, colors) {
  const count = positions.length / 3;
  const out = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    out[i * 6 + 0] = positions[i * 3 + 0];
    out[i * 6 + 1] = positions[i * 3 + 1];
    out[i * 6 + 2] = positions[i * 3 + 2];
    out[i * 6 + 3] = colors[i * 3 + 0];
    out[i * 6 + 4] = colors[i * 3 + 1];
    out[i * 6 + 5] = colors[i * 3 + 2];
  }
  return out;
}

export function buildOutlineForTransform(t) {
  const sx = t.sx, sy = t.sy, sz = t.sz;
  const ox = t.ox, oy = t.oy, oz = t.oz;
  const px = t.px, py = t.py, pz = t.pz;
  const R = rotationMat3(t.rx, t.ry, t.rz);
  const c = (lx, ly, lz) => {
    const rel = mat3Apply(R, [ox + lx - px, oy + ly - py, oz + lz - pz]);
    return [rel[0] + px, rel[1] + py, rel[2] + pz];
  };
  const pts = [
    c(0, 0, 0), c(sx, 0, 0), c(sx, sy, 0), c(0, sy, 0),
    c(0, 0, sz), c(sx, 0, sz), c(sx, sy, sz), c(0, sy, sz),
  ];
  const edges = [
    0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6,
    6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7,
  ];
  const pos = [], col = [];
  const yellow = [1, 0.9, 0.2];
  for (const i of edges) {
    pos.push(...pts[i]);
    col.push(...yellow);
  }
  return interleaveLine(pos, col);
}

export function buildOutlineForEid(eid) {
  return buildOutlineForTransform({
    sx: Transform.sx[eid], sy: Transform.sy[eid], sz: Transform.sz[eid],
    ox: Transform.ox[eid], oy: Transform.oy[eid], oz: Transform.oz[eid],
    px: Transform.px[eid], py: Transform.py[eid], pz: Transform.pz[eid],
    rx: Transform.rx[eid], ry: Transform.ry[eid], rz: Transform.rz[eid],
  });
}

export const GIZMO_AXES = [
  { key: 'x', dir: [1, 0, 0], color: [0.95, 0.35, 0.35] },
  { key: 'y', dir: [0, 1, 0], color: [0.4, 0.9, 0.4] },
  { key: 'z', dir: [0, 0, 1], color: [0.4, 0.6, 0.95] },
];

export function gizmoArmLength() {
  return Math.max(1.5, Math.min(45, EditorContext.camera.distance * 0.18));
}

const GIZMO_HEAD_SEGMENTS = 12;
const ROTATE_RING_SEGMENTS = 48;
export function buildRotateGizmoGeometry(pivot, hoveredAxis = null) {
  const linePos = [], lineCol = [];
  const armLen = gizmoArmLength();
  const radius = armLen * 0.85;

  for (const ax of GIZMO_AXES) {
    const isHovered = ax.key === hoveredAxis;
    const color = isHovered ? [1, 1, 0.4] : ax.color;
    const ref = Math.abs(ax.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const p1 = vNorm(vCross(ax.dir, ref));
    const p2 = vCross(ax.dir, p1);
    for (let i = 0; i < ROTATE_RING_SEGMENTS; i++) {
      const a0 = (i / ROTATE_RING_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / ROTATE_RING_SEGMENTS) * Math.PI * 2;
      const p0 = vAdd(pivot, vAdd(vScale(p1, Math.cos(a0) * radius), vScale(p2, Math.sin(a0) * radius)));
      const p3 = vAdd(pivot, vAdd(vScale(p1, Math.cos(a1) * radius), vScale(p2, Math.sin(a1) * radius)));
      linePos.push(...p0, ...p3);
      lineCol.push(...color, ...color);
    }
  }
  return { lineData: interleaveLine(new Float32Array(linePos), new Float32Array(lineCol)) };
}

export function buildScaleGizmoGeometry(pivot, hoveredAxis = null) {
  const linePos = [], lineCol = [];
  const triPos = [], triCol = [];
  const armLen = gizmoArmLength();
  const shaftEndFrac = 0.8, handleSize = armLen * 0.08;

  for (const ax of GIZMO_AXES) {
    const isHovered = ax.key === hoveredAxis;
    const color = isHovered ? [1, 1, 0.4] : ax.color;
    const tip = vAdd(pivot, vScale(ax.dir, armLen * shaftEndFrac));
    linePos.push(...pivot, ...tip);
    lineCol.push(...color, ...color);

    // Small cube handle centered on the tip, to visually distinguish
    // Scale mode from Translate's cone-tipped arrows.
    const ref = Math.abs(ax.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = vNorm(vCross(ax.dir, ref));
    const v = vCross(ax.dir, u);
    const h = handleSize;
    const corners = [];
    for (const su of [-1, 1]) for (const sv of [-1, 1]) for (const sw of [-1, 1]) {
      corners.push(vAdd(tip, vAdd(vAdd(vScale(u, su * h), vScale(v, sv * h)), vScale(ax.dir, sw * h))));
    }
    // corners index: su,sv,sw each in {-1,1} mapped to bit pattern (su=0/1, sv=0/1, sw=0/1) -> idx = su*4+sv*2+sw
    const idx = (su, sv, sw) => ((su + 1) / 2) * 4 + ((sv + 1) / 2) * 2 + (sw + 1) / 2;
    const faces = [
      [idx(-1, -1, 1), idx(1, -1, 1), idx(1, 1, 1), idx(-1, 1, 1)],   // +axis face
      [idx(-1, -1, -1), idx(-1, 1, -1), idx(1, 1, -1), idx(1, -1, -1)], // -axis face
      [idx(-1, -1, -1), idx(1, -1, -1), idx(1, -1, 1), idx(-1, -1, 1)],
      [idx(-1, 1, -1), idx(-1, 1, 1), idx(1, 1, 1), idx(1, 1, -1)],
      [idx(-1, -1, -1), idx(-1, -1, 1), idx(-1, 1, 1), idx(-1, 1, -1)],
      [idx(1, -1, -1), idx(1, 1, -1), idx(1, 1, 1), idx(1, -1, 1)],
    ];
    for (const f of faces) {
      const [a, b, c, d] = f.map((i) => corners[i]);
      triPos.push(...a, ...b, ...c, ...a, ...c, ...d);
      triCol.push(...color, ...color, ...color, ...color, ...color, ...color);
    }
  }
  return {
    lineData: interleaveLine(new Float32Array(linePos), new Float32Array(lineCol)),
    triData: interleaveLine(new Float32Array(triPos), new Float32Array(triCol)),
  };
}
export function buildGizmoGeometry(pivot, hoveredAxis = null) {
  const linePos = [], lineCol = [];
  const triPos = [], triCol = [];
  const armLen = gizmoArmLength();
  const shaftEndFrac = 0.8, tipFrac = 1.0, headRadius = armLen * 0.05;

  for (const ax of GIZMO_AXES) {
    const isHovered = ax.key === hoveredAxis;
    const color = isHovered ? [1, 1, 0.4] : ax.color;
    
    const shaftEnd = vAdd(pivot, vScale(ax.dir, armLen * shaftEndFrac));
    linePos.push(...pivot, ...shaftEnd);
    lineCol.push(...color, ...color);

    const tip = vAdd(pivot, vScale(ax.dir, armLen * tipFrac));
    const ref = Math.abs(ax.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const p1 = vNorm(vCross(ax.dir, ref));
    const p2 = vCross(ax.dir, p1);
    const basePts = [];
    for (let i = 0; i < GIZMO_HEAD_SEGMENTS; i++) {
      const angle = (i / GIZMO_HEAD_SEGMENTS) * Math.PI * 2;
      basePts.push(
        vAdd(shaftEnd, vAdd(vScale(p1, Math.cos(angle) * headRadius), vScale(p2, Math.sin(angle) * headRadius)))
      );
    }
    for (let i = 0; i < GIZMO_HEAD_SEGMENTS; i++) {
      const a = basePts[i],
        b = basePts[(i + 1) % GIZMO_HEAD_SEGMENTS];
      triPos.push(...tip, ...a, ...b);
      triCol.push(...color, ...color, ...color);
    }
  }
  return {
    lineData: interleaveLine(new Float32Array(linePos), new Float32Array(lineCol)),
    triData: interleaveLine(new Float32Array(triPos), new Float32Array(triCol)),
  };
}
