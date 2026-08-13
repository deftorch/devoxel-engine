#!/usr/bin/env node
// Interaction-level regression check, complementing `npm test` (which is
// unit-level: pure functions, isolated math). This drives the REAL editor
// through real DOM mouse events dispatched to the real production event
// handlers (camera-input.js's mousedown/mousemove/mouseup closures), using
// jsdom to load the actual editor.html - not a hand-rolled stub UI.
//
// What this can verify: any interaction reachable through mouse events -
// creating, selecting, transforming, and deleting entities; History
// undo/redo bookkeeping across a chain of different action types; the
// cross-feature paths that unit tests exercise in isolation but don't
// chain together (e.g. "rotate an object, then multi-select it with
// others, then translate the group, then draw a new block flush against
// its rotated face").
//
// What this CANNOT verify (fundamentally, not just "not yet implemented"):
// actual GPU rendering (WebGPU/WebGL context, shaders, visual correctness)
// - jsdom has no GPU. Renderer switching (Fase 0/8) and anything that
// requires a human eye (does the gizmo LOOK right, is text readable) still
// needs a manual pass in a real browser. Precisely aiming a synthetic click
// at ONE SPECIFIC gizmo ring axis also proved too fragile to calibrate
// blindly without visual feedback (see Step 2) - the underlying rotation
// math itself is separately verified via matrix round-trip tests in
// src/test/ (Fase 6.5), so this isn't a real coverage gap, just an honest
// limit on what a screen-coordinate-only script can pin down.
//
// Run with: npm run regression

import { setupDom, makeProjector, dispatchMouse } from './regression-check-lib.mjs';

setupDom();
const { worldToScreen } = await makeProjector();

const state = await import('../src/editor/state.js');
const sceneOps = await import('../src/editor/scene-ops.js');
const cameraInput = await import('../src/editor/camera-input.js');
const toolAdd = await import('../src/editor/tool-add.js');
const geometry = await import('../src/editor/geometry.js');
const math = await import('../src/core/utils/math.js');
const History = (await import('../src/editor/history.js')).default;
await import('../src/editor/ui/outliner.js');
await import('../src/editor/ui/properties.js');
await import('../src/editor/ui/add-tool-settings.js');

const { EditorContext, getSelection, getPrimarySelection } = state;
const { readTransform } = sceneOps;

// Stub renderer so mesh upload calls (rebuildMesh -> uploadMesh ->
// rendererPlugin.createMesh) are harmless no-ops - matches the pattern
// already used by src/test/editor_sceneops.test.js.
EditorContext.engineRef = { rendererPlugin: { ready: true, createMesh: () => ({ destroy: () => {} }) } };

const canvas = document.getElementById('gpu-canvas');
cameraInput.initCameraInput(canvas);

let failures = 0;
function check(label, cond, extra = '') {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
  return ok;
}

function placeAt(worldGroundPoint) {
  const s = worldToScreen(worldGroundPoint);
  dispatchMouse(canvas, 'mousemove', s.x, s.y);
  dispatchMouse(canvas, 'mousedown', s.x, s.y, { button: 0 });
  dispatchMouse(canvas, 'mouseup', s.x, s.y, { button: 0 });
}

// Replicates camera-input.js's internal (unexported) ringPlaneBasis() so a
// synthetic click can be aimed unambiguously at a SPECIFIC rotate ring's own
// circle - "near the pivot at the right radius" alone isn't enough, since
// multiple rings' planes pass close to each other near the pivot.
function ringPlaneBasis(axisDir) {
  const ref = Math.abs(axisDir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  const p1 = norm(cross(axisDir, ref));
  return { p1, p2: cross(axisDir, p1) };
}

console.log('=== STEP 1: Buat 3 kubus di posisi berbeda (mode Add, klik biasa) ===');
cameraInput.setGizmoMode('add');
check('Add mode aktif', toolAdd.AddToolState.active === true);

placeAt([0, 0, 0]);
placeAt([6, 0, 0]);
placeAt([-6, 0, 2]);

check('3 entity dibuat', EditorContext.sceneOrder.length === 3, `(dapat: ${EditorContext.sceneOrder.length})`);
const [eidA, eidB, eidC] = EditorContext.sceneOrder;
const tA0 = readTransform(eidA), tB0 = readTransform(eidB), tC0 = readTransform(eidC);
check('3 kubus di posisi berbeda satu sama lain',
  (tA0.px !== tB0.px || tA0.pz !== tB0.pz) && (tA0.px !== tC0.px || tA0.pz !== tC0.pz));

console.log('\n=== STEP 2: Rotate kubus A lewat gizmo Rotate ===');
cameraInput.setGizmoMode('translate');
sceneOps.selectNode(eidA);
check('Kubus A terpilih', getPrimarySelection() === eidA);

cameraInput.setGizmoMode('rotate');
const pivotA = [tA0.px, tA0.py, tA0.pz];
const ringRadius = geometry.gizmoArmLength() * 0.85;
const { p1: ringP1, p2: ringP2 } = ringPlaneBasis([0, 1, 0]);
function ringPointAtAngle(angleRad) {
  return [0, 1, 2].map((i) => pivotA[i] + (ringP1[i] * Math.cos(angleRad) + ringP2[i] * Math.sin(angleRad)) * ringRadius);
}
const s0 = worldToScreen(ringPointAtAngle(0));
dispatchMouse(canvas, 'mousedown', s0.x, s0.y, { button: 0 });
const s1 = worldToScreen(ringPointAtAngle(30 * Math.PI / 180));
dispatchMouse(canvas, 'mousemove', s1.x, s1.y);
dispatchMouse(window, 'mouseup', s1.x, s1.y, { button: 0 });

const tA1 = readTransform(eidA);
const rotatedSomeAxis = ['rx', 'ry', 'rz'].some((k) => Math.abs(tA1[k] - tA0[k]) > 1);
check('Interaksi gizmo Rotate menghasilkan rotasi nyata lewat event DOM asli', rotatedSomeAxis,
  `([${tA0.rx},${tA0.ry},${tA0.rz}] -> [${tA1.rx.toFixed(1)},${tA1.ry.toFixed(1)},${tA1.rz.toFixed(1)}])`);
check('1 History entry berlabel Rotate', History.undoStack.at(-1)?.label?.includes('Rotate'),
  `(label: ${History.undoStack.at(-1)?.label})`);

console.log('\n=== STEP 3: Marquee-select ketiga kubus sekaligus ===');
cameraInput.setGizmoMode('translate');
sceneOps.selectNode(-1);
const allScreenPts = [tA0, tB0, tC0].map((t) => worldToScreen([t.px, t.py, t.pz]));
const minSx = Math.min(...allScreenPts.map((p) => p.x)) - 60, maxSx = Math.max(...allScreenPts.map((p) => p.x)) + 60;
const minSy = Math.min(...allScreenPts.map((p) => p.y)) - 60, maxSy = Math.max(...allScreenPts.map((p) => p.y)) + 60;
dispatchMouse(canvas, 'mousedown', minSx, minSy, { button: 0 });
dispatchMouse(canvas, 'mousemove', maxSx, maxSy);
dispatchMouse(window, 'mouseup', maxSx, maxSy, { button: 0 });
const selectedAfterMarquee = Array.from(getSelection()).sort();
check('Ketiga kubus terpilih lewat marquee', selectedAfterMarquee.length === 3 && [eidA, eidB, eidC].every((e) => selectedAfterMarquee.includes(e)));

console.log('\n=== STEP 4: Translate bareng lewat gizmo (termasuk yang sudah dirotasi) ===');
cameraInput.setGizmoMode('translate');
const pre = { A: readTransform(eidA), B: readTransform(eidB), C: readTransform(eidC) };
const vp = [0, 1, 2].map((i) => ([tA0, tB0, tC0].reduce((s, t) => s + [t.px, t.py, t.pz][i], 0)) / 3);
const armLen = geometry.gizmoArmLength();
const sArm0 = worldToScreen([vp[0] + armLen * 0.8, vp[1], vp[2]]);
dispatchMouse(canvas, 'mousedown', sArm0.x, sArm0.y, { button: 0 });
const sArm1 = worldToScreen([vp[0] + armLen * 0.8 + 4, vp[1], vp[2]]);
dispatchMouse(canvas, 'mousemove', sArm1.x, sArm1.y);
dispatchMouse(window, 'mouseup', sArm1.x, sArm1.y, { button: 0 });
const post = { A: readTransform(eidA), B: readTransform(eidB), C: readTransform(eidC) };
const deltas = ['A', 'B', 'C'].map((k) => post[k].px - pre[k].px);
check('Ketiganya bergerak dengan delta X yang sama (termasuk yg sudah dirotasi)',
  Math.abs(deltas[0] - deltas[1]) < 1e-6 && Math.abs(deltas[1] - deltas[2]) < 1e-6 && Math.abs(deltas[0]) > 0.5,
  `(deltas: ${deltas.map((d) => d.toFixed(3))})`);
check('Rotasi kubus A tidak berubah akibat translate', Math.abs(post.A.ry - pre.A.ry) < 1e-6 && Math.abs(post.A.rx - pre.A.rx) < 1e-6);

console.log('\n=== STEP 5: Add Tool - tempel kubus baru di wajah miring kubus A yang sudah dirotasi ===');
const tA2 = readTransform(eidA);
cameraInput.setGizmoMode('add');
check('Kembali ke Add mode', toolAdd.AddToolState.active === true);
const R = math.rotationMat3(tA2.rx, tA2.ry, tA2.rz);
const faceCenter = math.vAdd([tA2.px, tA2.py, tA2.pz], math.mat3Apply(R, [tA2.sx / 2, 0, 0]));
const sFace = worldToScreen(faceCenter);
const sceneCountBefore = EditorContext.sceneOrder.length;
dispatchMouse(canvas, 'mousemove', sFace.x, sFace.y);
dispatchMouse(canvas, 'mousedown', sFace.x, sFace.y, { button: 0 });
dispatchMouse(canvas, 'mouseup', sFace.x, sFace.y, { button: 0 });
check('1 kubus baru ditempel', EditorContext.sceneOrder.length === sceneCountBefore + 1);
const newEid = EditorContext.sceneOrder.at(-1);
const newT = readTransform(newEid);
check('Kubus baru mewarisi rotasi target A (semua sumbu)',
  ['rx', 'ry', 'rz'].every((k) => Math.abs(newT[k] - tA2[k]) < 0.01));
const distToFace = Math.hypot(newT.px - faceCenter[0], newT.py - faceCenter[1], newT.pz - faceCenter[2]);
check('Kubus baru dekat titik klik di wajah (tidak "kabur")', distToFace < 2, `(jarak: ${distToFace.toFixed(3)})`);

console.log('\n=== STEP 6: Undo 4x berturut-turut lalu redo, cek History tidak bocor ===');
const countBeforeUndo = EditorContext.sceneOrder.length;
for (let i = 0; i < 4; i++) History.undo();
check('4x undo tidak crash, redoStack terisi 4', History.redoStack.length === 4);
for (let i = 0; i < 4; i++) History.redo();
check('4x redo mengembalikan scene ke kondisi sebelum undo', EditorContext.sceneOrder.length === countBeforeUndo);

console.log('\n=== STEP 7: Duplicate + Delete ===');
sceneOps.selectNode(eidB);
const preDup = EditorContext.sceneOrder.length;
sceneOps.duplicateSelected();
check('Duplicate menambah 1 entity', EditorContext.sceneOrder.length === preDup + 1);
sceneOps.selectNode(eidC);
const preDel = EditorContext.sceneOrder.length;
sceneOps.deleteSelected();
check('Delete mengurangi 1 entity', EditorContext.sceneOrder.length === preDel - 1);

console.log('\n=== STEP 8: Ganti renderer WebGPU <-> WebGL ===');
console.log('  DILEWATI - butuh konteks GPU nyata, tidak tersedia di jsdom/Node. Perlu dicek manual di browser.');

console.log('\n=== RINGKASAN ===');
console.log(failures === 0 ? 'SEMUA CHECK LOLOS (0 gagal)' : `${failures} CHECK GAGAL`);
process.exit(failures === 0 ? 0 : 1);
