import { addEntity, removeEntity, addComponent, observe, onRemove } from "https://esm.sh/bitecs@0.4.0";
import { world, growableComponent, addGrowable, Renderable, RenderMesh } from "../core/ecs/components.js";
import { VoxelEngine } from "../core/index.js";
import { Transform, ColorComp, NodeMeta, NameComp, EditorContext } from "./state.js";
import History from "./history.js";
import { buildCubeMesh, buildGridLines, interleaveLine, buildOutlineForEid, buildGizmoGeometry, gizmoArmLength, GIZMO_AXES } from "./geometry.js";
import { uploadMesh, rebuildMesh, readTransform, writeTransform, hexToRgb01, rgb01ToHex, addCube, addGroup, deleteSelected, duplicateSelected, renameNode, commitTransform, selectNode } from "./scene-ops.js";
import { vAdd, vSub, vScale, vCross, vDot, vNorm, rotationMat3, mat3Apply, mat4Perspective, mat4LookAt, mat4Multiply } from "../core/utils/math.js?v=2";

EditorContext.refreshOutliner = () => refreshOutliner();
EditorContext.refreshOutlinerSelection = () => refreshOutlinerSelection();
EditorContext.refreshProperties = () => refreshProperties();

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

// Math functions dipindah ke core/utils/math.js

// -----------------------------------------------------------------------
// 3. ECS: world + component
// -----------------------------------------------------------------------
// growableComponent dan Renderable kini diambil dari VoxelEngine core

// origin = sudut "from" kubus, size = lebar/tinggi/dalam, pivot = titik
// rotasi (biasanya tengah kubus), rotation = euler derajat.
// ECS components, EditorContext.sceneOrder, dan EditorContext.selectedEid sudah dipindah ke state.js

// History dipindah ke history.js

// -----------------------------------------------------------------------
// 5. Cube mesh builder — bake rotasi-di-sekitar-pivot langsung ke
//    world-space vertex (sama seperti chunk voxel-engine yang bake origin
//    offset saat build), jadi shader tidak perlu uniform model-matrix
//    per-objek. Simpel di GPU, gampang diaudit di CPU.
// -----------------------------------------------------------------------
// interleave dan buildCubeMesh dipindah ke geometry.js

// -----------------------------------------------------------------------
// 6. Scene ops — semua mutasi lewat sini supaya History konsisten.
// -----------------------------------------------------------------------
// EditorContext.engineRef dipindah ke EditorContext

// Scene ops dipindah ke scene-ops.js

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
  if (EditorContext.sceneOrder.length === 0) {
    outlinerList.innerHTML = `<div id="outliner-empty">Kosong. Klik "＋ Cube" di toolbar untuk mulai.</div>`;
  } else {
    for (const eid of EditorContext.sceneOrder) {
      const row = document.createElement('div');
      row.className = 'node-row' + (eid === EditorContext.selectedEid ? ' selected' : '');
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
  statCount.textContent = EditorContext.sceneOrder.length;
}
function refreshOutlinerSelection() {
  outlinerList.querySelectorAll('.node-row').forEach((row) => {
    row.classList.toggle('selected', Number(row.dataset.eid) === EditorContext.selectedEid);
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
  if (EditorContext.selectedEid < 0) {
    propertiesBody.innerHTML = `<div id="properties-empty">Tidak ada elemen terpilih.<br>Tambahkan cube dari toolbar.</div>`;
    return;
  }
  const eid = EditorContext.selectedEid;
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
// buildGridLines, interleaveLine, buildOutlineForEid dipindah ke geometry.js

// -----------------------------------------------------------------------
// 11. Kamera orbit + input + Gizmo translate
// -----------------------------------------------------------------------
// EditorContext.camera state dipindah ke EditorContext
function cameraBasis() {
  const cp = Math.cos(EditorContext.camera.pitch),
    sp = Math.sin(EditorContext.camera.pitch);
  const cy = Math.cos(EditorContext.camera.yaw),
    sy = Math.sin(EditorContext.camera.yaw);
  const forward = vNorm([sy * cp, sp, cy * cp]); // dari eye ke target
  const worldUp = [0, 1, 0];
  const right = vNorm(vCross(forward, worldUp));
  const up = vCross(right, forward);
  const eye = vSub(EditorContext.camera.target, vScale(forward, EditorContext.camera.distance));
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
// GIZMO_AXES dan gizmoArmLength dipindah ke geometry.js
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
  if (EditorContext.selectedEid < 0 || NodeMeta.isGroup[EditorContext.selectedEid]) return null;
  const { ro, rd } = screenToRay(clientX, clientY);
  const pivot = [Transform.px[EditorContext.selectedEid], Transform.py[EditorContext.selectedEid], Transform.pz[EditorContext.selectedEid]];
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
    gizmoDrag = { axis: hit.axis, dir: hit.dir, startS: hit.s, startT: readTransform(EditorContext.selectedEid) };
  } else {
    inputMode = e.button === 2 ? 'pan' : 'orbit';
  }
  canvas.classList.add('dragging');
});
window.addEventListener('mouseup', (e) => {
  const moved = Math.hypot(e.clientX - mouseDownPos[0], e.clientY - mouseDownPos[1]);
  if (inputMode === 'gizmo' && gizmoDrag) {
    const newT = readTransform(EditorContext.selectedEid);
    if (moved > 1)
      commitTransform(EditorContext.selectedEid, gizmoDrag.startT, newT); // cuma commit ke History kalau memang bergeser
    else {
      writeTransform(EditorContext.selectedEid, gizmoDrag.startT);
      rebuildMesh(EditorContext.selectedEid);
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
      writeTransform(EditorContext.selectedEid, t);
      rebuildMesh(EditorContext.selectedEid);
      syncPropertyInputs(EditorContext.selectedEid); // update angka di panel tanpa rebuild DOM (biar tidak lompat fokus)
    }
    lastMouse = [e.clientX, e.clientY];
    return;
  }
  if (!inputMode) return;
  const dx = e.clientX - lastMouse[0],
    dy = e.clientY - lastMouse[1];
  lastMouse = [e.clientX, e.clientY];
  if (inputMode === 'orbit') {
    EditorContext.camera.yaw -= dx * 0.006;
    EditorContext.camera.pitch = Math.max(-1.5, Math.min(1.5, EditorContext.camera.pitch - dy * 0.006));
  } else if (inputMode === 'pan') {
    const { right, up } = cameraBasis();
    const s = EditorContext.camera.distance * 0.0016;
    EditorContext.camera.target = vAdd(EditorContext.camera.target, vAdd(vScale(right, -dx * s), vScale(up, dy * s)));
  }
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    EditorContext.camera.distance = Math.max(3, Math.min(120, EditorContext.camera.distance * (1 + e.deltaY * 0.001)));
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
  for (const eid of EditorContext.sceneOrder) {
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
  const elements = EditorContext.sceneOrder.map((eid) => {
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
  for (const eid of [...EditorContext.sceneOrder]) destroyNodeRaw(eid);
  EditorContext.sceneOrder = [];
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
  if (EditorContext.sceneOrder.length && !confirm('Import akan mengganti scene yang sedang dikerjakan. Lanjutkan?')) {
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && EditorContext.selectedEid >= 0) {
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
    EditorContext.engineRef = new VoxelEngine({ chunkSize: [32, 32, 32], storage: 'flatgrid', mesher: 'greedy', renderer: targetRenderer });
    await EditorContext.engineRef.start(canvas);
  } catch (err) { 
    if (targetRenderer === 'webgpu') {
      console.warn('WebGPU gagal diinisialisasi, mencoba fallback ke WebGL...', err);
      try {
        setStatus('Menginisialisasi WebGL (Fallback)...', 0);
        EditorContext.engineRef = new VoxelEngine({ chunkSize: [32, 32, 32], storage: 'flatgrid', mesher: 'greedy', renderer: 'webgl' });
        await EditorContext.engineRef.start(canvas);
      } catch (fallbackErr) {
        fail(fallbackErr.message);
        return;
      }
    } else {
      fail(err.message); 
      return;
    }
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
        yaw: EditorContext.camera.yaw,
        pitch: EditorContext.camera.pitch,
      };

      // Siapkan data debug primitif
      const debugData = { lines: [], tris: [] };
      
      // 1. Grid
      debugData.lines.push({ data: gridVertexData, depthTest: true });

      // 2. Gizmo & Outline (jika ada seleksi)
      const hasSelection = EditorContext.selectedEid >= 0 && !NodeMeta.isGroup[EditorContext.selectedEid];
      if (hasSelection) {
        const outlineData = buildOutlineForEid(EditorContext.selectedEid);
        debugData.lines.push({ data: outlineData, depthTest: true });

        const pivot = [Transform.px[EditorContext.selectedEid], Transform.py[EditorContext.selectedEid], Transform.pz[EditorContext.selectedEid]];
        const gizmoGeo = buildGizmoGeometry(pivot);
        debugData.lines.push({ data: gizmoGeo.lineData, depthTest: false }); // X-ray
        debugData.tris.push({ data: gizmoGeo.triData, depthTest: false });
      }

      // Kirim ke renderer
      if (typeof EditorContext.engineRef.rendererPlugin.drawDebugPrimitives === 'function') {
        EditorContext.engineRef.rendererPlugin.drawDebugPrimitives(cameraState, debugData);
      }
      
      // Draw frame
      EditorContext.engineRef.rendererPlugin.draw(cameraState, EditorContext.sceneOrder, Renderable, RenderMesh);
      
      requestAnimationFrame(frame);
    } catch (err) {
      fail('Error di render loop:\\n' + (err.stack || err.message));
    }
  }
  requestAnimationFrame(frame);
}

main();
