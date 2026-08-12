import { vSub, vAdd, vScale, rotationMat3, mat3Transpose, mat3Apply, mat4Multiply, mat4LookAt, mat4Perspective, projectToScreen } from "../core/utils/math.js?v=2";
import { EditorContext, NodeMeta, Transform, setSelection, getSelection } from "./state.js";
import { readTransform, selectNode, syncSelectionUI } from "./scene-ops.js";
import { screenToRay, cameraBasis, getFovY } from "./camera-input.js";

export function rayAABBWithNormal(ro, rd, mn, mx) {
  let tmin = -Infinity, tmax = Infinity;
  let normalMin = [0, 0, 0];
  let normalMax = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    let n1 = [0, 0, 0]; n1[i] = -1;
    let n2 = [0, 0, 0]; n2[i] = 1;

    if (Math.abs(rd[i]) < 1e-8) {
      if (ro[i] < mn[i] || ro[i] > mx[i]) return null;
    } else {
      let t1 = (mn[i] - ro[i]) / rd[i];
      let t2 = (mx[i] - ro[i]) / rd[i];
      let tmpN1 = n1;
      let tmpN2 = n2;

      if (t1 > t2) {
        const tmp = t1; t1 = t2; t2 = tmp;
        tmpN1 = n2; tmpN2 = n1;
      }

      if (t1 > tmin) {
        tmin = t1;
        normalMin = tmpN1;
      }
      if (t2 < tmax) {
        tmax = t2;
        normalMax = tmpN2;
      }
      if (tmin > tmax) return null;
    }
  }
  
  if (tmin >= 0) return { t: tmin, normal: normalMin };
  if (tmax >= 0) return { t: tmax, normal: normalMax };
  return null;
}

export function raycastWorld(clientX, clientY, canvas) {
  const { ro, rd } = screenToRay(clientX, clientY, canvas);
  let bestT = Infinity, bestEid = -1, bestNormal = null, bestLocalNormal = null, bestHitPoint = null, bestRotation = [0, 0, 0], bestPivot = [0, 0, 0];
  
  for (const eid of EditorContext.sceneOrder) {
    if (NodeMeta.isGroup[eid]) continue;
    const t = readTransform(eid);
    const R = rotationMat3(t.rx, t.ry, t.rz);
    const Rinv = mat3Transpose(R);
    const roShift = mat3Apply(Rinv, vSub(ro, [t.px, t.py, t.pz]));
    const roLocal = vSub(vAdd(roShift, [t.px, t.py, t.pz]), [t.ox, t.oy, t.oz]);
    const rdLocal = mat3Apply(Rinv, rd);
    
    const hit = rayAABBWithNormal(roLocal, rdLocal, [0, 0, 0], [t.sx, t.sy, t.sz]);
    if (hit != null && hit.t < bestT) {
      bestT = hit.t;
      bestEid = eid;
      bestNormal = mat3Apply(R, hit.normal);
      bestLocalNormal = hit.normal;
      bestHitPoint = vAdd(ro, vScale(rd, hit.t));
      bestRotation = [t.rx, t.ry, t.rz];
      // The target's own pivot in world space - the fixed anchor point
      // callers must rotate AROUND (not the world origin) when converting
      // points to/from this target's local frame. Rotating about the
      // origin instead of the target's own center only happens to work
      // when the target sits exactly on the rotation axis (e.g. at world
      // x=0,z=0 for a Y rotation) - for any other position it produces a
      // visibly wrong offset.
      bestPivot = [t.px, t.py, t.pz];
    }
  }
  
  if (bestEid !== -1) {
    return { eid: bestEid, t: bestT, normal: bestNormal, localNormal: bestLocalNormal, point: bestHitPoint, rotation: bestRotation, pivot: bestPivot };
  }
  
  // Intersect with ground plane y=0 if no box hit. The ground is never
  // rotated (R=I), so the pivot choice is mathematically irrelevant here -
  // [0,0,0] is fine.
  if (Math.abs(rd[1]) > 1e-6) {
    const t = -ro[1] / rd[1];
    if (t > 0) {
      const point = vAdd(ro, vScale(rd, t));
      return { eid: -1, t, normal: [0, 1, 0], localNormal: [0, 1, 0], point, rotation: [0, 0, 0], pivot: [0, 0, 0] };
    }
  }
  
  return null;
}

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

  syncSelectionUI();
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
