import { addEntity, removeEntity, addComponent, observe, onRemove } from "bitecs";
import { world, growableComponent, addGrowable, Renderable, RenderMesh } from "../core/ecs/components.js";
import { VoxelEngine } from "../core/index.js";
import { Transform, ColorComp, NodeMeta, NameComp, EditorContext, getSelection, getPrimarySelection } from "./state.js";
import History from "./history.js";
import { buildCubeMesh, buildGridLines, interleaveLine, buildOutlineForEid, buildOutlineForTransform, buildGizmoGeometry, buildRotateGizmoGeometry, buildScaleGizmoGeometry, gizmoArmLength, GIZMO_AXES } from "./geometry.js";
import { AddToolState, spawnInstantCube, buildHoverFaceGrid, setSnapEnabled } from "./tool-add.js";
import { uploadMesh, rebuildMesh, readTransform, writeTransform, hexToRgb01, rgb01ToHex, addCube, addGroup, deleteSelected, duplicateSelected, renameNode, commitTransform, selectNode, getVirtualPivot } from "./scene-ops.js";
import { refreshOutliner } from "./ui/outliner.js";
import { syncPropertyInputs } from "./ui/properties.js";
import { initAddToolSettingsPanel } from "./ui/add-tool-settings.js";
import { cameraBasis, getFovY, initCameraInput, getGizmoMode, setGizmoMode } from "./camera-input.js";
import { exportScene, importScene } from "./io.js";
import { vAdd, vSub, vScale, vCross, vDot, vNorm, rotationMat3, mat3Apply, mat4Perspective, mat4LookAt, mat4Multiply } from "../core/utils/math.js?v=2";

// Outliner and Properties register themselves as EditorContext listeners
// (see the bottom of ui/outliner.js and ui/properties.js) — importing them
// above is what triggers that registration. No manual wiring needed here
// anymore (Fase 6.6: replaced the old single-callback
// EditorContext.refreshX = fn pattern with EditorContext.on/emit).

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

// Outliner dan Properties UI dipindah ke ui/outliner.js dan ui/properties.js
// -----------------------------------------------------------------------
// 9. WebGPU init
// -----------------------------------------------------------------------
// WebGPU init dan SOLID_SHADER sudah dikelola oleh VoxelEngine
// LINE_SHADER dipindahkan ke webgpu/engine.js (Fase 2)

// -----------------------------------------------------------------------
// 10. Grid & selection outline (line-list, dibangun di CPU tiap kali perlu)
// -----------------------------------------------------------------------
// buildGridLines, interleaveLine, buildOutlineForEid dipindah ke geometry.js

// Camera, Picking, dan IO dipindah ke modul masing-masing

// -----------------------------------------------------------------------
// Toolbar wiring
// -----------------------------------------------------------------------
$('btn-add-cube').addEventListener('click', () => activateAddTool(false));
$('btn-add-group').addEventListener('click', addGroup);
$('btn-delete').addEventListener('click', deleteSelected);
$('btn-duplicate').addEventListener('click', duplicateSelected);
$('btn-undo').addEventListener('click', () => History.undo());
$('btn-redo').addEventListener('click', () => History.redo());
$('btn-export').addEventListener('click', exportScene);

// activateAddTool sets snap state (which persists) and activates gizmo mode
function activateAddTool(snap) {
  setSnapEnabled(snap);
  setGizmoModeAndSync('add');
}

function setGizmoModeAndSync(mode) {
  setGizmoMode(mode);
  for (const [id, m] of [['btn-gizmo-translate', 'translate'], ['btn-gizmo-rotate', 'rotate'], ['btn-gizmo-scale', 'scale']]) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('gizmo-mode-active', m === mode);
  }
  const addBtn = document.getElementById('btn-add-cube');
  if (addBtn) addBtn.classList.toggle('gizmo-mode-active', mode === 'add');
}
$('btn-gizmo-translate').addEventListener('click', () => setGizmoModeAndSync('translate'));
$('btn-gizmo-rotate').addEventListener('click', () => setGizmoModeAndSync('rotate'));
$('btn-gizmo-scale').addEventListener('click', () => setGizmoModeAndSync('scale'));
initAddToolSettingsPanel();
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && getSelection().length > 0) {
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
  // Blender-style instant add: works from ANY mode (doesn't require
  // switching into Add mode / hovering a surface first) - spawns a
  // default-size cube at the camera's orbit target, same role as
  // Blender's "3D Cursor" as the implicit spawn point.
  if (!e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    spawnInstantCube();
  }
  if (!e.ctrlKey && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'g') setGizmoModeAndSync('translate');
    else if (key === 'r') setGizmoModeAndSync('rotate');
    else if (key === 's') setGizmoModeAndSync('scale');
  }
});

// -----------------------------------------------------------------------
// 13. Main / render loop
// -----------------------------------------------------------------------
async function main() {
  initCameraInput(canvas);
  setStatus('Mendeteksi GPU...', 0);
  const urlParams = new URLSearchParams(window.location.search);
  let targetRenderer = urlParams.get('renderer') || (navigator.gpu ? 'webgpu' : 'webgl');

  const rendererSelect = document.getElementById('renderer-select');
  if (rendererSelect) {
    rendererSelect.value = targetRenderer;
    rendererSelect.addEventListener('change', (e) => {
      urlParams.set('renderer', e.target.value);
      window.location.search = urlParams.toString();
    });
  }

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
      const proj = mat4Perspective(getFovY(), aspect, 0.1, 500);
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
      const selectedEids = getSelection();
      for (const eid of selectedEids) {
        if (NodeMeta.isGroup[eid]) continue;
        const outlineData = buildOutlineForEid(eid);
        debugData.lines.push({ data: outlineData, depthTest: true });
      }

      const virtualPivot = getVirtualPivot();
      if (virtualPivot) {
        const mode = getGizmoMode();
        if (mode !== 'add') {
          const gizmoGeo =
            mode === 'rotate' ? buildRotateGizmoGeometry(virtualPivot) :
            mode === 'scale' ? buildScaleGizmoGeometry(virtualPivot) :
            buildGizmoGeometry(virtualPivot);
          debugData.lines.push({ data: gizmoGeo.lineData, depthTest: false }); // X-ray
          if (gizmoGeo.triData) debugData.tris.push({ data: gizmoGeo.triData, depthTest: false });
        }
      }

      if (AddToolState.active && AddToolState.currentPoint) {
        // Blender-style hover overlay: only relevant during HOVER (before a
        // drag defines an actual box), so it doesn't fight visually with
        // the box outline drawn below once DRAW_BASE/EXTRUDE take over.
        if (AddToolState.phase === 'HOVER') {
          const hoverGrid = buildHoverFaceGrid();
          if (hoverGrid) {
            if (hoverGrid.lines) debugData.lines.push({ data: hoverGrid.lines, depthTest: true });
            else debugData.lines.push({ data: hoverGrid, depthTest: true });
            if (hoverGrid.tris) debugData.tris.push({ data: hoverGrid.tris, depthTest: true });
          }
        }
        const t = AddToolState.getCubeTransform();
        if (t) {
          const outline = buildOutlineForTransform(t);
          debugData.lines.push({ data: outline, depthTest: true });
        }
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
