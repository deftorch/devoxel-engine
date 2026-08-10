import { addEntity, removeEntity, addComponent, observe, onRemove } from "https://esm.sh/bitecs@0.4.0";
import { world, growableComponent, addGrowable, Renderable, RenderMesh } from "../core/ecs/components.js";
import { VoxelEngine } from "../core/index.js";

// =============================================================================
// Cube Editor Prototype — dibangun dengan mengadaptasi pola dari voxel-engine
// (WebGPU init, ECS lewat bitECS, growable component, observer cleanup GPU
// buffer). Bedanya: di sini tiap elemen adalah SATU cube yang bisa
// ditransformasi independen (origin/size/pivot/rotation), bukan chunk
// terrain yang di-greedy-mesh jadi satu buffer besar.
//
// Struktur file (cari header di bawah untuk lompat):
//   1. DOM refs & util kecil
//   2. Math (vec3, mat3 rotasi euler, mat4 kamera)
//   3. ECS: world + component (Transform, ColorComp, NodeMeta, Name, GPUMesh)
//   4. History (undo/redo, command pattern)
//   5. Cube mesh builder (bake rotasi-di-sekitar-pivot ke world-space vertex)
//   6. Scene ops: add/delete/duplicate/rename/update — semua lewat History
//   7. Outliner UI
//   8. Properties panel UI
//   9. WebGPU init + shader (solid pipeline, line pipeline)
//  10. Grid & selection outline
//  11. Kamera orbit + input
//  12. Raycast picking (OBB di local-space, benar walau elemen dirotasi)
//  13. Render loop
//  14. Export / Import JSON
//
// Titik ekstensi yang sudah disiapkan (lihat komentar "EXTENSION POINT"):
//  - per-face UV/texture (sekarang tiap elemen cuma warna flat)
//  - nested group dengan drag-drop reorder di outliner (parent sudah ada di
//    data model, tinggal UI drag-nya)
//  - multi-select
//  - animasi keyframe (Transform sudah terpisah dari mesh, tinggal tambah
//    komponen Keyframe + interpolator yang menulis ke Transform tiap frame)
// =============================================================================

// -----------------------------------------------------------------------
// 1. DOM refs & util kecil
// -----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('gpu-canvas');
const overlay = $('overlay');
const statusEl = $('status');
const fillEl = $('fill');
const outlinerList = $('outliner-list');
const propertiesBody = $('properties-body');
const statFps = $('stat-fps');
const statCount = $('stat-count');
const statSelected = $('stat-selected');

function setStatus(t, pct) {
  statusEl.textContent = t;
  if (pct != null) fillEl.style.width = (pct * 100).toFixed(0) + '%';
}
function fail(msg) {
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div id="err">${msg}</div>`;
}
window.addEventListener('error', (e) => fail('Runtime error:\n' + (e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) =>
  fail('Unhandled promise rejection:\n' + (e.reason?.stack || e.reason))
);

// -----------------------------------------------------------------------
// 2. Math
// -----------------------------------------------------------------------
function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vNorm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function mat3RotX(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function mat3RotY(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function mat3RotZ(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function mat3Mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3 + 0] * b[0 * 3 + c] + a[r * 3 + 1] * b[1 * 3 + c] + a[r * 3 + 2] * b[2 * 3 + c];
  return o;
}
function mat3Transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
function mat3Apply(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
// Rotasi euler XYZ derajat -> mat3. R = Rz * Ry * Rx (Rx diterapkan duluan ke vektor).
function rotationMat3(rx, ry, rz) {
  const d = Math.PI / 180;
  return mat3Mul(mat3Mul(mat3RotZ(rz * d), mat3RotY(ry * d)), mat3RotX(rx * d));
}

function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0]);
}
function mat4LookAt(eye, center, up) {
  const z = vNorm(vSub(eye, center));
  const x = vNorm(vCross(up, z));
  const y = vCross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -vDot(x, eye),
    -vDot(y, eye),
    -vDot(z, eye),
    1,
  ]);
}
function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
  return out;
}

// -----------------------------------------------------------------------
// 3. ECS: world + component
// -----------------------------------------------------------------------
// growableComponent dan Renderable kini diambil dari VoxelEngine core

// origin = sudut "from" kubus, size = lebar/tinggi/dalam, pivot = titik
// rotasi (biasanya tengah kubus), rotation = euler derajat.
const Transform = growableComponent(
  {
    ox: Float32Array,
    oy: Float32Array,
    oz: Float32Array,
    sx: Float32Array,
    sy: Float32Array,
    sz: Float32Array,
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    rx: Float32Array,
    ry: Float32Array,
    rz: Float32Array,
  },
  32
);
const ColorComp = growableComponent({ r: Float32Array, g: Float32Array, b: Float32Array }, 32);
// parent = -1 berarti root. isGroup: node organisasi tanpa geometri sendiri
// (EXTENSION POINT: cocok jadi "bone" kalau nanti ditambah animasi).
const NodeMeta = growableComponent({ parent: Int32Array, isGroup: Uint8Array }, 32);
// NodeMeta, Transform, ColorComp tidak dihapus.
// Renderable sekarang diimpor dari core.
const NameComp = { value: [] };
observe(world, onRemove(NameComp), (eid) => {
  NameComp.value[eid] = null;
});

// Urutan tampil di outliner dikelola manual (array eid), tidak mengandalkan
// urutan query bitECS — supaya urutan UI stabil walau id di-recycle.
let sceneOrder = [];
let selectedEid = -1;

// -----------------------------------------------------------------------
// 4. History (undo/redo, command pattern)
// -----------------------------------------------------------------------
const History = {
  undoStack: [],
  redoStack: [],
  push(cmd) {
    cmd.redo();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    onHistoryChange();
  },
  undo() {
    const c = this.undoStack.pop();
    if (!c) return;
    c.undo();
    this.redoStack.push(c);
    onHistoryChange();
  },
  redo() {
    const c = this.redoStack.pop();
    if (!c) return;
    c.redo();
    this.undoStack.push(c);
    onHistoryChange();
  },
};
function onHistoryChange() {
  $('btn-undo').disabled = History.undoStack.length === 0;
  $('btn-redo').disabled = History.redoStack.length === 0;
}

// -----------------------------------------------------------------------
// 5. Cube mesh builder — bake rotasi-di-sekitar-pivot langsung ke
//    world-space vertex (sama seperti chunk voxel-engine yang bake origin
//    offset saat build), jadi shader tidak perlu uniform model-matrix
//    per-objek. Simpel di GPU, gampang diaudit di CPU.
// -----------------------------------------------------------------------
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
// 6 sisi kubus, urutan corner CCW dilihat dari luar (cocok dengan
// frontFace:'ccw' + cullMode:'back' di pipeline) — dihitung per-panggilan
// di buildCubeMesh supaya rotasi pivot langsung ter-bake ke posisi corner.
function buildCubeMesh(t) {
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

// -----------------------------------------------------------------------
// 6. Scene ops — semua mutasi lewat sini supaya History konsisten.
// -----------------------------------------------------------------------
let engineRef = null;
let deviceRef = null; // diisi setelah WebGPU siap
let isWebGPU = false;

function uploadMesh(eid, mesh) {
  RenderMesh.meshes[eid]?.destroy();
  const created = engineRef.rendererPlugin.createMesh(mesh.vertexData, mesh.indexData);
  RenderMesh.meshes[eid] = created;
  Renderable.indexCount[eid] = mesh.indexCount;
}
function rebuildMesh(eid) {
  if (NodeMeta.isGroup[eid]) return; // group tidak punya geometri
  const t = readTransform(eid);
  uploadMesh(eid, buildCubeMesh(t));
}
function readTransform(eid) {
  return {
    ox: Transform.ox[eid],
    oy: Transform.oy[eid],
    oz: Transform.oz[eid],
    sx: Transform.sx[eid],
    sy: Transform.sy[eid],
    sz: Transform.sz[eid],
    px: Transform.px[eid],
    py: Transform.py[eid],
    pz: Transform.pz[eid],
    rx: Transform.rx[eid],
    ry: Transform.ry[eid],
    rz: Transform.rz[eid],
    r: ColorComp.r[eid],
    g: ColorComp.g[eid],
    b: ColorComp.b[eid],
  };
}
function writeTransform(eid, t) {
  Transform.ox[eid] = t.ox;
  Transform.oy[eid] = t.oy;
  Transform.oz[eid] = t.oz;
  Transform.sx[eid] = t.sx;
  Transform.sy[eid] = t.sy;
  Transform.sz[eid] = t.sz;
  Transform.px[eid] = t.px;
  Transform.py[eid] = t.py;
  Transform.pz[eid] = t.pz;
  Transform.rx[eid] = t.rx;
  Transform.ry[eid] = t.ry;
  Transform.rz[eid] = t.rz;
  ColorComp.r[eid] = t.r;
  ColorComp.g[eid] = t.g;
  ColorComp.b[eid] = t.b;
}

const PALETTE = ['#7fd4ff', '#ffb27f', '#b6ff7f', '#ff7fd4', '#7fffcf', '#d4ff7f', '#ff9f7f', '#9f7fff'];
let paletteIdx = 0;
function hexToRgb01(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
function rgb01ToHex(r, g, b) {
  const c = (x) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

let nextName = { cube: 1, group: 1 };

function createNodeRaw(data) {
  // data: {eid?, name, parent, isGroup, transform?, color?, orderIndex?}
  const eid = addEntity(world);
  addGrowable(world, eid, NodeMeta);
  addComponent(world, eid, NameComp);
  NodeMeta.parent[eid] = data.parent;
  NodeMeta.isGroup[eid] = data.isGroup ? 1 : 0;
  NameComp.value[eid] = data.name;
  if (!data.isGroup) {
    addGrowable(world, eid, Transform);
    addGrowable(world, eid, ColorComp);
    addGrowable(world, eid, Renderable);
    addComponent(world, eid, RenderMesh);
    writeTransform(eid, data.transform);
    if (deviceRef) rebuildMesh(eid);
  }
  const idx = data.orderIndex != null ? data.orderIndex : sceneOrder.length;
  sceneOrder.splice(idx, 0, eid);
  data.eid = eid;
  return eid;
}
function destroyNodeRaw(eid) {
  const idx = sceneOrder.indexOf(eid);
  if (idx >= 0) sceneOrder.splice(idx, 1);
  removeEntity(world, eid); // otomatis trigger onRemove(GPUMesh) -> destroy buffer
}

function addCube() {
  const parent = selectedEid >= 0 && NodeMeta.isGroup[selectedEid] ? selectedEid : -1;
  const [r, g, b] = hexToRgb01(PALETTE[paletteIdx++ % PALETTE.length]);
  const data = {
    name: `Cube ${nextName.cube++}`,
    parent,
    isGroup: false,
    transform: { ox: -4, oy: 0, oz: -4, sx: 8, sy: 8, sz: 8, px: 0, py: 4, pz: 0, rx: 0, ry: 0, rz: 0, r, g, b },
  };
  History.push({
    label: 'Add Cube',
    redo() {
      createNodeRaw(data);
      selectNode(data.eid);
      refreshOutliner();
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      refreshOutliner();
    },
  });
}
function addGroup() {
  const parent = selectedEid >= 0 && NodeMeta.isGroup[selectedEid] ? selectedEid : -1;
  const data = { name: `Group ${nextName.group++}`, parent, isGroup: true };
  History.push({
    label: 'Add Group',
    redo() {
      createNodeRaw(data);
      selectNode(data.eid);
      refreshOutliner();
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      refreshOutliner();
    },
  });
}
function deleteSelected() {
  if (selectedEid < 0) return;
  const eid = selectedEid;
  const data = {
    name: NameComp.value[eid],
    parent: NodeMeta.parent[eid],
    isGroup: !!NodeMeta.isGroup[eid],
    transform: NodeMeta.isGroup[eid] ? null : readTransform(eid),
    orderIndex: sceneOrder.indexOf(eid),
  };
  History.push({
    label: 'Delete Element',
    redo() {
      destroyNodeRaw(eid);
      selectNode(-1);
      refreshOutliner();
    },
    undo() {
      createNodeRaw(data);
      selectNode(data.eid);
      refreshOutliner();
    },
  });
}
function duplicateSelected() {
  if (selectedEid < 0 || NodeMeta.isGroup[selectedEid]) return; // EXTENSION POINT: duplikat group + children rekursif
  const src = readTransform(selectedEid);
  const t = { ...src, ox: src.ox + 1, oz: src.oz + 1, px: src.px + 1, pz: src.pz + 1 };
  const data = {
    name: NameComp.value[selectedEid] + ' copy',
    parent: NodeMeta.parent[selectedEid],
    isGroup: false,
    transform: t,
  };
  History.push({
    label: 'Duplicate',
    redo() {
      createNodeRaw(data);
      selectNode(data.eid);
      refreshOutliner();
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      refreshOutliner();
    },
  });
}
function renameNode(eid, newName) {
  const oldName = NameComp.value[eid];
  if (newName === oldName || !newName.trim()) {
    refreshOutliner();
    return;
  }
  History.push({
    label: 'Rename',
    redo() {
      NameComp.value[eid] = newName;
      refreshOutliner();
    },
    undo() {
      NameComp.value[eid] = oldName;
      refreshOutliner();
    },
  });
}
function commitTransform(eid, oldT, newT) {
  History.push({
    label: 'Edit Transform',
    redo() {
      writeTransform(eid, newT);
      rebuildMesh(eid);
      refreshProperties();
    },
    undo() {
      writeTransform(eid, oldT);
      rebuildMesh(eid);
      refreshProperties();
    },
  });
}
function selectNode(eid) {
  selectedEid = eid;
  $('btn-delete').disabled = eid < 0;
  $('btn-duplicate').disabled = eid < 0 || !!NodeMeta.isGroup[eid];
  statSelected.textContent = eid < 0 ? '—' : NameComp.value[eid];
  refreshOutlinerSelection();
  refreshProperties();
}

// -----------------------------------------------------------------------
// 7. Outliner UI
// -----------------------------------------------------------------------
function depthOf(eid) {
  let d = 0,
    p = NodeMeta.parent[eid];
  while (p >= 0) {
    d++;
    p = NodeMeta.parent[p];
  }
  return d;
}
function refreshOutliner() {
  outlinerList.innerHTML = '';
  if (sceneOrder.length === 0) {
    outlinerList.innerHTML = `<div id="outliner-empty">Kosong. Klik "＋ Cube" di toolbar untuk mulai.</div>`;
  } else {
    for (const eid of sceneOrder) {
      const row = document.createElement('div');
      row.className = 'node-row' + (eid === selectedEid ? ' selected' : '');
      row.style.paddingLeft = 10 + depthOf(eid) * 14 + 'px';
      row.dataset.eid = eid;
      const isGroup = !!NodeMeta.isGroup[eid];
      row.innerHTML = isGroup
        ? `<span class="icon">▸</span><span class="name">${escapeHtml(NameComp.value[eid])}</span>`
        : `<span class="swatch" style="background:${rgb01ToHex(ColorComp.r[eid], ColorComp.g[eid], ColorComp.b[eid])}"></span><span class="name">${escapeHtml(NameComp.value[eid])}</span>`;
      row.addEventListener('click', () => selectNode(eid));
      const nameEl = row.querySelector('.name');
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        nameEl.contentEditable = 'true';
        nameEl.focus();
        document.execCommand('selectAll', false, null);
      });
      nameEl.addEventListener('blur', () => {
        nameEl.contentEditable = 'false';
        renameNode(eid, nameEl.textContent.trim());
      });
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          nameEl.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          nameEl.textContent = NameComp.value[eid];
          nameEl.blur();
        }
      });
      outlinerList.appendChild(row);
    }
  }
  statCount.textContent = sceneOrder.length;
}
function refreshOutlinerSelection() {
  outlinerList.querySelectorAll('.node-row').forEach((row) => {
    row.classList.toggle('selected', Number(row.dataset.eid) === selectedEid);
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

// -----------------------------------------------------------------------
// 8. Properties panel UI
// -----------------------------------------------------------------------
function numRow(labelChar, id) {
  return `<div class="prop-row"><span class="field-label">${labelChar}</span><input type="number" id="${id}" step="0.1"></div>`;
}
function refreshProperties() {
  if (selectedEid < 0) {
    propertiesBody.innerHTML = `<div id="properties-empty">Tidak ada elemen terpilih.<br>Tambahkan cube dari toolbar.</div>`;
    return;
  }
  const eid = selectedEid;
  const isGroup = !!NodeMeta.isGroup[eid];
  let html = `
    <div class="prop-group">
      <label class="title">Nama</label>
      <input type="text" id="p-name" value="${escapeHtml(NameComp.value[eid])}">
    </div>`;
  if (!isGroup) {
    html += `
    <div class="prop-group">
      <label class="title">Origin (sudut "from")</label>
      ${numRow('X', 'p-ox')}${numRow('Y', 'p-oy')}${numRow('Z', 'p-oz')}
    </div>
    <div class="prop-group">
      <label class="title">Size</label>
      ${numRow('X', 'p-sx')}${numRow('Y', 'p-sy')}${numRow('Z', 'p-sz')}
    </div>
    <div class="prop-group">
      <label class="title">Pivot (pusat rotasi)</label>
      ${numRow('X', 'p-px')}${numRow('Y', 'p-py')}${numRow('Z', 'p-pz')}
    </div>
    <div class="prop-group">
      <label class="title">Rotation (derajat)</label>
      ${numRow('X', 'p-rx')}${numRow('Y', 'p-ry')}${numRow('Z', 'p-rz')}
    </div>
    <div class="prop-group">
      <label class="title">Warna</label>
      <input type="color" id="p-color" value="${rgb01ToHex(ColorComp.r[eid], ColorComp.g[eid], ColorComp.b[eid])}">
    </div>`;
  }
  propertiesBody.innerHTML = html;

  $('p-name').addEventListener('change', (e) => renameNode(eid, e.target.value.trim() || NameComp.value[eid]));
  if (isGroup) return;

  const fieldMap = {
    ox: 'p-ox',
    oy: 'p-oy',
    oz: 'p-oz',
    sx: 'p-sx',
    sy: 'p-sy',
    sz: 'p-sz',
    px: 'p-px',
    py: 'p-py',
    pz: 'p-pz',
    rx: 'p-rx',
    ry: 'p-ry',
    rz: 'p-rz',
  };
  const current = readTransform(eid);
  for (const [key, id] of Object.entries(fieldMap)) $(id).value = current[key].toFixed(2);

  let dragStartT = null; // snapshot sebelum live-edit, buat 1 history-entry per sesi edit
  for (const [key, id] of Object.entries(fieldMap)) {
    const input = $(id);
    input.addEventListener('focus', () => {
      dragStartT = readTransform(eid);
    });
    input.addEventListener('input', () => {
      // Live preview: langsung tulis + rebuild mesh, TANPA push history dulu
      // (history baru di-commit sekali saat 'change'/blur, biar undo tidak
      // kepecah jadi puluhan step per ketukan angka).
      const t = readTransform(eid);
      t[key] = parseFloat(input.value) || 0;
      writeTransform(eid, t);
      rebuildMesh(eid);
    });
    input.addEventListener('change', () => {
      const newT = readTransform(eid);
      if (dragStartT) commitTransform(eid, dragStartT, newT);
      dragStartT = null;
    });
  }
  let colorStartT = null; // snapshot sebelum drag di color picker, sama pola dengan dragStartT
  $('p-color').addEventListener('mousedown', () => {
    colorStartT = readTransform(eid);
  });
  $('p-color').addEventListener('input', () => {
    if (!colorStartT) colorStartT = readTransform(eid);
    const t = readTransform(eid);
    const [r, g, b] = hexToRgb01($('p-color').value);
    t.r = r;
    t.g = g;
    t.b = b;
    writeTransform(eid, t);
    rebuildMesh(eid);
  });
  $('p-color').addEventListener('change', () => {
    const newT = readTransform(eid);
    if (colorStartT) commitTransform(eid, colorStartT, newT);
    colorStartT = null;
  });
}

// -----------------------------------------------------------------------
// 9. WebGPU init
// -----------------------------------------------------------------------
// WebGPU init dan SOLID_SHADER sudah dikelola oleh VoxelEngine
// LINE_SHADER dipindahkan ke webgpu/engine.js (Fase 2)

// -----------------------------------------------------------------------
// 10. Grid & selection outline (line-list, dibangun di CPU tiap kali perlu)
// -----------------------------------------------------------------------
function buildGridLines(size = 32, step = 2) {
  const positions = [],
    colors = [];
  const half = size / 2;
  const dim = [0.3, 0.34, 0.42];
  const axisX = [0.85, 0.35, 0.35];
  const axisZ = [0.35, 0.55, 0.9];
  for (let i = -half; i <= half; i += step) {
    const onAxis = Math.abs(i) < 1e-6;
    const cx = onAxis ? axisZ : dim; // garis sejajar Z, ditandai warna Z-axis saat i=0
    positions.push(i, 0, -half, i, 0, half);
    colors.push(...cx, ...cx);
    const cz = onAxis ? axisX : dim; // garis sejajar X
    positions.push(-half, 0, i, half, 0, i);
    colors.push(...cz, ...cz);
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}
function interleaveLine(positions, colors) {
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
function buildOutlineForEid(eid) {
  const t = readTransform(eid);
  const R = rotationMat3(t.rx, t.ry, t.rz);
  const corner = (lx, ly, lz) => {
    const wx = t.ox + lx,
      wy = t.oy + ly,
      wz = t.oz + lz;
    const rel = mat3Apply(R, [wx - t.px, wy - t.py, wz - t.pz]);
    return [rel[0] + t.px, rel[1] + t.py, rel[2] + t.pz];
  };
  const c = {
    '000': corner(0, 0, 0),
    100: corner(t.sx, 0, 0),
    '010': corner(0, t.sy, 0),
    '001': corner(0, 0, t.sz),
    110: corner(t.sx, t.sy, 0),
    101: corner(t.sx, 0, t.sz),
    '011': corner(0, t.sy, t.sz),
    111: corner(t.sx, t.sy, t.sz),
  };
  const edges = [
    ['000', '100'],
    ['100', '110'],
    ['110', '010'],
    ['010', '000'],
    ['001', '101'],
    ['101', '111'],
    ['111', '011'],
    ['011', '001'],
    ['000', '001'],
    ['100', '101'],
    ['110', '111'],
    ['010', '011'],
  ];
  const positions = [],
    colors = [];
  const col = [1.0, 0.82, 0.25];
  for (const [a, b] of edges) {
    positions.push(...c[a], ...c[b]);
    colors.push(...col, ...col);
  }
  return interleaveLine(new Float32Array(positions), new Float32Array(colors));
}

const GIZMO_HEAD_SEGMENTS = 6;
// Geometri gizmo translate: 3 shaft (line-list) + 3 kepala panah kerucut
// (triangle-list, di-fan dari titik tip). Ukurannya dihitung ulang tiap
// frame dari gizmoArmLength() supaya skala layar tetap konsisten walau zoom.
function buildGizmoGeometry(pivot) {
  const armLen = gizmoArmLength();
  const shaftEndFrac = 0.8,
    tipFrac = 1.05,
    headRadius = armLen * 0.07;
  const linePos = [],
    lineCol = [];
  const triPos = [],
    triCol = [];
  for (const ax of GIZMO_AXES) {
    const shaftEnd = vAdd(pivot, vScale(ax.dir, armLen * shaftEndFrac));
    linePos.push(...pivot, ...shaftEnd);
    lineCol.push(...ax.color, ...ax.color);

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
      triCol.push(...ax.color, ...ax.color, ...ax.color);
    }
  }
  return {
    lineData: interleaveLine(new Float32Array(linePos), new Float32Array(lineCol)),
    triData: interleaveLine(new Float32Array(triPos), new Float32Array(triCol)),
  };
}

// -----------------------------------------------------------------------
// 11. Kamera orbit + input + Gizmo translate
// -----------------------------------------------------------------------
const camera = { target: [0, 3, 0], yaw: 0.9, pitch: -0.5, distance: 26 };
function cameraBasis() {
  const cp = Math.cos(camera.pitch),
    sp = Math.sin(camera.pitch);
  const cy = Math.cos(camera.yaw),
    sy = Math.sin(camera.yaw);
  const forward = vNorm([sy * cp, sp, cy * cp]); // dari eye ke target
  const worldUp = [0, 1, 0];
  const right = vNorm(vCross(forward, worldUp));
  const up = vCross(right, forward);
  const eye = vSub(camera.target, vScale(forward, camera.distance));
  return { eye, forward, right, up };
}
const FOV_Y = Math.PI / 3;
// Konversi koordinat layar -> ray dunia (dipakai buat pick objek maupun pick gizmo).
function screenToRay(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
  const aspect = canvas.width / canvas.height;
  const halfH = Math.tan(FOV_Y / 2),
    halfW = halfH * aspect;
  const { eye, forward, right, up } = cameraBasis();
  const rd = vNorm(vAdd(vAdd(vScale(right, ndcX * halfW), vScale(up, ndcY * halfH)), forward));
  return { ro: eye, rd };
}

// --- Gizmo translate: 3 arrow handle (X merah, Y hijau, Z biru) di pivot
// elemen terpilih. EXTENSION POINT: tambah mode rotate/scale dengan pola
// yang sama (ganti geometri handle + interaksinya, drag-math-nya mirip).
const GIZMO_AXES = [
  { key: 'x', dir: [1, 0, 0], color: [0.95, 0.35, 0.35] },
  { key: 'y', dir: [0, 1, 0], color: [0.4, 0.9, 0.4] },
  { key: 'z', dir: [0, 0, 1], color: [0.4, 0.6, 0.95] },
];
function gizmoArmLength() {
  return Math.max(1.5, Math.min(45, camera.distance * 0.18));
}
// Titik terdekat dua garis 3D (formula closest-point-between-two-lines):
// line1 = p0 + s*d1 (d1 harus unit), line2 = ro + t*d2 (d2 harus unit).
// Return null kalau sejajar (denom ~0).
function closestParamsBetweenLines(p0, d1, ro, d2) {
  const w0 = vSub(p0, ro);
  const b = vDot(d1, d2),
    d = vDot(d1, w0),
    e = vDot(d2, w0);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-7) return null;
  const s = (b * e - d) / denom;
  const t = (e - b * d) / denom;
  return { s, t };
}
function pickGizmoAxis(clientX, clientY) {
  if (selectedEid < 0 || NodeMeta.isGroup[selectedEid]) return null;
  const { ro, rd } = screenToRay(clientX, clientY);
  const pivot = [Transform.px[selectedEid], Transform.py[selectedEid], Transform.pz[selectedEid]];
  const armLen = gizmoArmLength();
  const threshold = armLen * 0.16;
  let best = null;
  for (const ax of GIZMO_AXES) {
    const cp = closestParamsBetweenLines(pivot, ax.dir, ro, rd);
    if (!cp || cp.t < 0) continue;
    const sClamped = Math.max(0, Math.min(armLen * 1.1, cp.s));
    const pointOnAxis = vAdd(pivot, vScale(ax.dir, sClamped));
    const pointOnRay = vAdd(ro, vScale(rd, cp.t));
    const dist = Math.hypot(...vSub(pointOnAxis, pointOnRay));
    if (dist < threshold && (!best || dist < best.dist)) best = { axis: ax.key, dir: ax.dir, dist, s: cp.s };
  }
  return best;
}

let inputMode = null; // 'orbit' | 'pan' | 'gizmo' | null
let lastMouse = [0, 0];
let mouseDownPos = [0, 0];
let gizmoDrag = null; // { axis, dir, startS, startT }
canvas.addEventListener('mousedown', (e) => {
  mouseDownPos = [e.clientX, e.clientY];
  lastMouse = [e.clientX, e.clientY];
  const hit = e.button === 0 ? pickGizmoAxis(e.clientX, e.clientY) : null;
  if (hit) {
    inputMode = 'gizmo';
    gizmoDrag = { axis: hit.axis, dir: hit.dir, startS: hit.s, startT: readTransform(selectedEid) };
  } else {
    inputMode = e.button === 2 ? 'pan' : 'orbit';
  }
  canvas.classList.add('dragging');
});
window.addEventListener('mouseup', (e) => {
  const moved = Math.hypot(e.clientX - mouseDownPos[0], e.clientY - mouseDownPos[1]);
  if (inputMode === 'gizmo' && gizmoDrag) {
    const newT = readTransform(selectedEid);
    if (moved > 1)
      commitTransform(selectedEid, gizmoDrag.startT, newT); // cuma commit ke History kalau memang bergeser
    else {
      writeTransform(selectedEid, gizmoDrag.startT);
      rebuildMesh(selectedEid);
      refreshProperties();
    } // klik doang, batalkan
    gizmoDrag = null;
  } else if (moved < 4 && e.button === 0) {
    pickAtScreen(e.clientX, e.clientY);
  }
  inputMode = null;
  canvas.classList.remove('dragging');
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousemove', (e) => {
  if (inputMode === 'gizmo' && gizmoDrag) {
    const { ro, rd } = screenToRay(e.clientX, e.clientY);
    const pivot = [gizmoDrag.startT.px, gizmoDrag.startT.py, gizmoDrag.startT.pz];
    const cp = closestParamsBetweenLines(pivot, gizmoDrag.dir, ro, rd);
    if (cp) {
      const delta = cp.s - gizmoDrag.startS;
      const t = { ...gizmoDrag.startT };
      t.ox += gizmoDrag.dir[0] * delta;
      t.oy += gizmoDrag.dir[1] * delta;
      t.oz += gizmoDrag.dir[2] * delta;
      t.px += gizmoDrag.dir[0] * delta;
      t.py += gizmoDrag.dir[1] * delta;
      t.pz += gizmoDrag.dir[2] * delta;
      writeTransform(selectedEid, t);
      rebuildMesh(selectedEid);
      syncPropertyInputs(selectedEid); // update angka di panel tanpa rebuild DOM (biar tidak lompat fokus)
    }
    lastMouse = [e.clientX, e.clientY];
    return;
  }
  if (!inputMode) return;
  const dx = e.clientX - lastMouse[0],
    dy = e.clientY - lastMouse[1];
  lastMouse = [e.clientX, e.clientY];
  if (inputMode === 'orbit') {
    camera.yaw -= dx * 0.006;
    camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch - dy * 0.006));
  } else if (inputMode === 'pan') {
    const { right, up } = cameraBasis();
    const s = camera.distance * 0.0016;
    camera.target = vAdd(camera.target, vAdd(vScale(right, -dx * s), vScale(up, dy * s)));
  }
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.distance = Math.max(3, Math.min(120, camera.distance * (1 + e.deltaY * 0.001)));
  },
  { passive: false }
);

// Sinkron field angka di panel properties tanpa rebuild DOM (dipakai saat drag gizmo,
// supaya input yang lagi tidak difokus tetap update live tapi tidak kehilangan listener).
function syncPropertyInputs(eid) {
  const t = readTransform(eid);
  const map = {
    ox: 'p-ox',
    oy: 'p-oy',
    oz: 'p-oz',
    sx: 'p-sx',
    sy: 'p-sy',
    sz: 'p-sz',
    px: 'p-px',
    py: 'p-py',
    pz: 'p-pz',
    rx: 'p-rx',
    ry: 'p-ry',
    rz: 'p-rz',
  };
  for (const [key, id] of Object.entries(map)) {
    const el = $(id);
    if (el) el.value = t[key].toFixed(2);
  }
}

// -----------------------------------------------------------------------
// 12. Raycast picking objek — OBB test di local-space elemen (benar walau
//     elemen dirotasi, tidak cuma AABB dunia yang cuma valid saat rz=0).
// -----------------------------------------------------------------------
function pickAtScreen(clientX, clientY) {
  const { ro, rd } = screenToRay(clientX, clientY);
  let bestT = Infinity,
    bestEid = -1;
  for (const eid of sceneOrder) {
    if (NodeMeta.isGroup[eid]) continue;
    const t = readTransform(eid);
    const R = rotationMat3(t.rx, t.ry, t.rz);
    const Rinv = mat3Transpose(R);
    const roShift = mat3Apply(Rinv, vSub(ro, [t.px, t.py, t.pz]));
    const roLocal = vSub(vAdd(roShift, [t.px, t.py, t.pz]), [t.ox, t.oy, t.oz]);
    const rdLocal = mat3Apply(Rinv, rd);
    const hit = rayAABB(roLocal, rdLocal, [0, 0, 0], [t.sx, t.sy, t.sz]);
    if (hit != null && hit < bestT) {
      bestT = hit;
      bestEid = eid;
    }
  }
  selectNode(bestEid);
}
function rayAABB(ro, rd, mn, mx) {
  let tmin = -Infinity,
    tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rd[i]) < 1e-8) {
      if (ro[i] < mn[i] || ro[i] > mx[i]) return null;
    } else {
      let t1 = (mn[i] - ro[i]) / rd[i],
        t2 = (mx[i] - ro[i]) / rd[i];
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? tmax : null;
}

// -----------------------------------------------------------------------
// 14. Export / Import JSON
// -----------------------------------------------------------------------
function exportScene() {
  const elements = sceneOrder.map((eid) => {
    const base = { id: eid, name: NameComp.value[eid], parent: NodeMeta.parent[eid], isGroup: !!NodeMeta.isGroup[eid] };
    if (!base.isGroup) {
      const t = readTransform(eid);
      base.origin = [t.ox, t.oy, t.oz];
      base.size = [t.sx, t.sy, t.sz];
      base.pivot = [t.px, t.py, t.pz];
      base.rotation = [t.rx, t.ry, t.rz];
      base.color = [t.r, t.g, t.b];
    }
    return base;
  });
  const json = JSON.stringify({ version: 1, elements }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cube-model.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function importScene(json) {
  const data = JSON.parse(json);
  // Bersihkan scene saat ini (import = ganti dokumen, reset history seperti "buka file baru").
  for (const eid of [...sceneOrder]) destroyNodeRaw(eid);
  sceneOrder = [];
  History.undoStack.length = 0;
  History.redoStack.length = 0;
  onHistoryChange();
  const idRemap = new Map();
  for (const el of data.elements) {
    const nd = createNodeRaw({
      name: el.name,
      isGroup: el.isGroup,
      parent: idRemap.has(el.parent) ? idRemap.get(el.parent) : -1,
      transform: el.isGroup
        ? null
        : {
            ox: el.origin[0],
            oy: el.origin[1],
            oz: el.origin[2],
            sx: el.size[0],
            sy: el.size[1],
            sz: el.size[2],
            px: el.pivot[0],
            py: el.pivot[1],
            pz: el.pivot[2],
            rx: el.rotation[0],
            ry: el.rotation[1],
            rz: el.rotation[2],
            r: el.color[0],
            g: el.color[1],
            b: el.color[2],
          },
    });
    idRemap.set(el.id, nd);
  }
  selectNode(-1);
  refreshOutliner();
}

// -----------------------------------------------------------------------
// Toolbar wiring
// -----------------------------------------------------------------------
$('btn-add-cube').addEventListener('click', addCube);
$('btn-add-group').addEventListener('click', addGroup);
$('btn-delete').addEventListener('click', deleteSelected);
$('btn-duplicate').addEventListener('click', duplicateSelected);
$('btn-undo').addEventListener('click', () => History.undo());
$('btn-redo').addEventListener('click', () => History.redo());
$('btn-export').addEventListener('click', exportScene);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (sceneOrder.length && !confirm('Import akan mengganti scene yang sedang dikerjakan. Lanjutkan?')) {
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importScene(reader.result);
    } catch (err) {
      fail('Gagal import JSON:\n' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable;
  if (typing) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEid >= 0) {
    e.preventDefault();
    deleteSelected();
  }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    History.undo();
  }
  if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z') || (e.ctrlKey && e.key.toLowerCase() === 'y')) {
    e.preventDefault();
    History.redo();
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelected();
  }
});

// -----------------------------------------------------------------------
// 13. Main / render loop
// -----------------------------------------------------------------------
async function main() {
  setStatus('Mendeteksi GPU...', 0);
  let targetRenderer = navigator.gpu ? 'webgpu' : 'webgl';

  try {
    setStatus(`Menginisialisasi ${targetRenderer.toUpperCase()}...`, 0);
    engineRef = new VoxelEngine({ chunkSize: [32, 32, 32], storage: 'flatgrid', mesher: 'greedy', renderer: targetRenderer });
    await engineRef.start(canvas);
  } catch (err) { 
    if (targetRenderer === 'webgpu') {
      console.warn('WebGPU gagal diinisialisasi, mencoba fallback ke WebGL...', err);
      try {
        setStatus('Menginisialisasi WebGL (Fallback)...', 0);
        engineRef = new VoxelEngine({ chunkSize: [32, 32, 32], storage: 'flatgrid', mesher: 'greedy', renderer: 'webgl' });
        await engineRef.start(canvas);
      } catch (fallbackErr) {
        fail(fallbackErr.message);
        return;
      }
    } else {
      fail(err.message); 
      return;
    }
  }

  isWebGPU = engineRef.rendererPlugin.name === 'webgpu';
  
  const renderer = engineRef.rendererPlugin.raw;
  let device = null;
  let format = null;
  
  if (isWebGPU) {
    deviceRef = renderer.device;
    device = renderer.device;
    format = renderer.format;
  }

  setStatus('Menyiapkan pipeline…', 0.3);

  // -----------------------------------------------------------------------
  // Pipeline variables (grid statis dihitung sekali)
  // -----------------------------------------------------------------------
  const gridLines = buildGridLines(32, 2);
  const gridVertexData = interleaveLine(gridLines.positions, gridLines.colors);

  addCube();
  overlay.classList.add('hidden');
  refreshOutliner();

  let lastTime = performance.now();
  let fpsAcc = 0, fpsFrames = 0, fpsDisplay = 0;

  function frame(now) {
    try {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      fpsAcc += dt;
      fpsFrames++;
      if (fpsAcc >= 0.4) {
        fpsDisplay = Math.round(fpsFrames / fpsAcc);
        fpsAcc = 0;
        fpsFrames = 0;
        statFps.textContent = fpsDisplay;
      }

      const aspect = canvas.width / canvas.height;
      const proj = mat4Perspective(FOV_Y, aspect, 0.1, 500);
      const { eye, forward } = cameraBasis();
      const center = vAdd(eye, forward);
      const view = mat4LookAt(eye, center, [0, 1, 0]);
      const viewProj = mat4Multiply(proj, view);
      
      const cameraState = {
        eye,
        yaw: camera.yaw,
        pitch: camera.pitch,
      };

      // Siapkan data debug primitif
      const debugData = { lines: [], tris: [] };
      
      // 1. Grid
      debugData.lines.push({ data: gridVertexData, depthTest: true });

      // 2. Gizmo & Outline (jika ada seleksi)
      const hasSelection = selectedEid >= 0 && !NodeMeta.isGroup[selectedEid];
      if (hasSelection) {
        const outlineData = buildOutlineForEid(selectedEid);
        debugData.lines.push({ data: outlineData, depthTest: true });

        const pivot = [Transform.px[selectedEid], Transform.py[selectedEid], Transform.pz[selectedEid]];
        const gizmoGeo = buildGizmoGeometry(pivot);
        debugData.lines.push({ data: gizmoGeo.lineData, depthTest: false }); // X-ray
        debugData.tris.push({ data: gizmoGeo.triData, depthTest: false });
      }

      // Kirim ke renderer
      if (typeof engineRef.rendererPlugin.drawDebugPrimitives === 'function') {
        engineRef.rendererPlugin.drawDebugPrimitives(cameraState, debugData);
      }
      
      // Draw frame
      engineRef.rendererPlugin.draw(cameraState, sceneOrder, Renderable, RenderMesh);
      
      requestAnimationFrame(frame);
    } catch (err) {
      fail('Error di render loop:\\n' + (err.stack || err.message));
    }
  }
  requestAnimationFrame(frame);
}

main();
