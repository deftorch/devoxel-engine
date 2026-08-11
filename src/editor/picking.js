import { vSub, vAdd, rotationMat3, mat3Transpose, mat3Apply, mat4Multiply, mat4LookAt, mat4Perspective, projectToScreen } from "../core/utils/math.js?v=2";
import { EditorContext, NodeMeta, Transform, setSelection, getSelection } from "./state.js";
import { readTransform, selectNode } from "./scene-ops.js";
import { screenToRay, cameraBasis, getFovY } from "./camera-input.js";

export function pickAtScreen(clientX, clientY, canvas, shiftKey = false) {
  const { ro, rd } = screenToRay(clientX, clientY, canvas);
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
  selectNode(bestEid, shiftKey);
}

/**
 * Selects entities whose projected on-screen bounding box overlaps a
 * marquee rectangle (drag-select). Mirrors the exact view/projection
 * construction used by the WebGL/WebGPU renderers (fovY=PI/3, near=0.1,
 * far=500) so screen coordinates match what the user actually sees.
 * @param {{x0:number,y0:number,x1:number,y1:number}} rect - marquee rectangle in canvas CSS-pixel space (unordered corners)
 * @param {HTMLCanvasElement} canvas
 * @param {boolean} [shiftKey=false] - true = add to current selection, false = replace it
 */
export function frustumSelect(rect, canvas, shiftKey = false) {
  const minX = Math.min(rect.x0, rect.x1), maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1), maxY = Math.max(rect.y0, rect.y1);

  const { eye, forward } = cameraBasis();
  const center = vAdd(eye, forward);
  const view = mat4LookAt(eye, center, [0, 1, 0]);
  const aspect = canvas.width / canvas.height;
  const proj = mat4Perspective(getFovY(), aspect, 0.1, 500);
  const viewProj = mat4Multiply(proj, view);

  const rectEl = canvas.getBoundingClientRect();
  const screenW = rectEl.width, screenH = rectEl.height;

  const hits = [];
  for (const eid of EditorContext.sceneOrder) {
    if (NodeMeta.isGroup[eid]) continue;
    const t = readTransform(eid);
    const R = rotationMat3(t.rx, t.ry, t.rz);
    // 8 corners of the local AABB [0..sx]x[0..sy]x[0..sz], rotated + placed in world space
    let boxMinX = Infinity, boxMinY = Infinity, boxMaxX = -Infinity, boxMaxY = -Infinity;
    let anyVisible = false;
    for (let cx = 0; cx <= 1; cx++) {
      for (let cy = 0; cy <= 1; cy++) {
        for (let cz = 0; cz <= 1; cz++) {
          const local = [cx * t.sx, cy * t.sy, cz * t.sz];
          const worldLocal = vAdd(mat3Apply(R, vSub(local, [t.px - t.ox, t.py - t.oy, t.pz - t.oz])), [t.px, t.py, t.pz]);
          const screenPt = projectToScreen(viewProj, worldLocal, screenW, screenH);
          if (!screenPt) continue; // behind camera — skip this corner (see math.js projectToScreen)
          anyVisible = true;
          boxMinX = Math.min(boxMinX, screenPt.x);
          boxMinY = Math.min(boxMinY, screenPt.y);
          boxMaxX = Math.max(boxMaxX, screenPt.x);
          boxMaxY = Math.max(boxMaxY, screenPt.y);
        }
      }
    }
    if (!anyVisible) continue; // fully behind camera, can't be in the marquee
    const overlaps = boxMinX <= maxX && boxMaxX >= minX && boxMinY <= maxY && boxMaxY >= minY;
    if (overlaps) hits.push(eid);
  }

  if (shiftKey) setSelection([...new Set([...getSelection(), ...hits])]);
  else setSelection(hits);
}

export function rayAABB(ro, rd, mn, mx) {
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
