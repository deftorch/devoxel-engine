import { vAdd, vSub, vScale, vNorm, rayPlaneIntersect, rotationMat3, mat3Transpose, mat3Apply } from "../core/utils/math.js?v=2";
import { raycastWorld } from "./picking.js";
import { screenToRay, closestParamsBetweenLines } from "./camera-input.js";
import { createNodeRaw, destroyNodeRaw, selectNode } from "./scene-ops.js";
import { getPrimarySelection, NodeMeta, EditorContext } from "./state.js";
import History from "./history.js";

const PALETTE = ['#7fd4ff', '#ffb27f', '#b6ff7f', '#ff7fd4', '#7fffcf', '#d4ff7f', '#ff9f7f', '#9f7fff'];
let paletteIdx = 0;

export function hexToRgb01(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function snapVector(v) {
  return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
}

export const AddToolState = {
  active: false,
  phase: 'HOVER', // 'HOVER', 'DRAW_BASE', 'EXTRUDE'
  startPoint: null, // all points/normals below are in the TARGET SURFACE's
  currentPoint: null, // own local (de-rotated, and re-anchored at the
  normal: [0, 1, 0], // target's own pivot) frame, not world space - see
  localNormal: [0, 1, 0], // targetRinv()/worldToTarget() below. `normal` is
  targetRotation: [0, 0, 0], // kept in world space only for potential future
  targetPivot: [0, 0, 0], // display use; all actual math uses localNormal
  height: 1, // (always exactly axis-aligned) and targetPivot (the fixed
             // anchor point the de-rotation must pivot around).

  /** Inverse rotation matrix of the surface currently being drawn on. */
  targetRinv() {
    return mat3Transpose(rotationMat3(...this.targetRotation));
  },
  /**
   * World-space point -> the target surface's local (de-rotated) frame,
   * anchored at the target's OWN pivot - not the world origin. Rotating
   * about the origin instead only happens to give the right answer when
   * the target sits exactly on the rotation axis; for a target positioned
   * anywhere else it silently produces a wrong, offset result (this was a
   * real bug: the "ghost" cube would render somewhere unrelated to the
   * cursor for any target not sitting on the world's rotation axis).
   */
  worldToTarget(worldPoint) {
    return mat3Apply(this.targetRinv(), vSub(worldPoint, this.targetPivot));
  },

  getCubeTransform() {
    if (!this.startPoint || !this.currentPoint) return null;
    let minX = Math.min(this.startPoint[0], this.currentPoint[0]);
    let maxX = Math.max(this.startPoint[0], this.currentPoint[0]);
    let minY = Math.min(this.startPoint[1], this.currentPoint[1]);
    let maxY = Math.max(this.startPoint[1], this.currentPoint[1]);
    let minZ = Math.min(this.startPoint[2], this.currentPoint[2]);
    let maxZ = Math.max(this.startPoint[2], this.currentPoint[2]);

    // localNormal is always exactly one of +-X/+-Y/+-Z (a raw AABB face
    // normal from the target's own local space), so this classification is
    // exact regardless of how the target is rotated in the world - unlike
    // thresholding the world-space normal, which can be diagonal (e.g.
    // [0.7,0,0.7] on a 45-degree-rotated target) and get misclassified.
    if (Math.abs(this.localNormal[0]) > 0.5) {
      if (minY === maxY) maxY += 1;
      if (minZ === maxZ) maxZ += 1;
      if (this.height >= 0) maxX += this.height;
      else minX += this.height;
    } else if (Math.abs(this.localNormal[1]) > 0.5) {
      if (minX === maxX) maxX += 1;
      if (minZ === maxZ) maxZ += 1;
      if (this.height >= 0) maxY += this.height;
      else minY += this.height;
    } else {
      if (minX === maxX) maxX += 1;
      if (minY === maxY) maxY += 1;
      if (this.height >= 0) maxZ += this.height;
      else minZ += this.height;
    }

    if (maxX === minX) maxX += 1;
    if (maxY === minY) maxY += 1;
    if (maxZ === minZ) maxZ += 1;

    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;
    // Local-frame (target-pivot-relative, de-rotated) centroid.
    const Lpx = minX + sx / 2, Lpy = minY + sy / 2, Lpz = minZ + sz / 2;

    const [r, g, b] = hexToRgb01(PALETTE[paletteIdx % PALETTE.length]);

    // Re-anchor: rotate the local-frame centroid offset by the target's
    // rotation and add back the target's own pivot, to get the new box's
    // TRUE world-space pivot. ox/oy/oz are then re-derived so that
    // buildCubeMesh's corner formula - worldCorner = R*((ox+lx)-px,...)+
    // px,py,pz, which rotates around THIS box's own px/py/pz, not the
    // target's - reproduces exactly the local-frame shape that was drawn.
    // (See Fase 6.8 notes in the roadmap for the full derivation; the
    // earlier version of this function skipped the re-anchoring step and
    // only coincidentally looked correct for targets sitting exactly on
    // their own rotation axis.)
    const R = rotationMat3(...this.targetRotation);
    const worldCentroidOffset = mat3Apply(R, [Lpx, Lpy, Lpz]);
    const px = this.targetPivot[0] + worldCentroidOffset[0];
    const py = this.targetPivot[1] + worldCentroidOffset[1];
    const pz = this.targetPivot[2] + worldCentroidOffset[2];
    const ox = px + (minX - Lpx);
    const oy = py + (minY - Lpy);
    const oz = pz + (minZ - Lpz);

    return {
      ox, oy, oz,
      sx, sy, sz,
      px, py, pz,
      rx: this.targetRotation[0], ry: this.targetRotation[1], rz: this.targetRotation[2],
      r, g, b
    };
  }
};

let lastMousePos = [0, 0];

export function handleAddToolPointerMove(clientX, clientY, canvas) {
  if (!AddToolState.active) return false;
  lastMousePos = [clientX, clientY];

  if (AddToolState.phase === 'HOVER') {
    const hit = raycastWorld(clientX, clientY, canvas);
    if (hit) {
      AddToolState.normal = hit.normal;
      AddToolState.localNormal = hit.localNormal;
      AddToolState.targetRotation = hit.rotation;
      AddToolState.targetPivot = hit.pivot;
      const localPoint = AddToolState.worldToTarget(hit.point);
      AddToolState.currentPoint = snapVector(localPoint);
      AddToolState.startPoint = AddToolState.currentPoint;
      AddToolState.height = 1;
    } else {
      AddToolState.currentPoint = null;
    }
  } else if (AddToolState.phase === 'DRAW_BASE') {
    const { ro, rd } = screenToRay(clientX, clientY, canvas);
    const roLocal = AddToolState.worldToTarget(ro);
    const rdLocal = mat3Apply(AddToolState.targetRinv(), rd);
    const planeHit = rayPlaneIntersect(roLocal, rdLocal, AddToolState.startPoint, AddToolState.localNormal);
    if (planeHit) {
      AddToolState.currentPoint = snapVector(planeHit);
      AddToolState.height = 1;
    }
  } else if (AddToolState.phase === 'EXTRUDE') {
    const { ro, rd } = screenToRay(clientX, clientY, canvas);
    const roLocal = AddToolState.worldToTarget(ro);
    const rdLocal = mat3Apply(AddToolState.targetRinv(), rd);
    // Project ray to the normal axis passing through startPoint
    const cp = closestParamsBetweenLines(AddToolState.startPoint, AddToolState.localNormal, roLocal, rdLocal);
    if (cp) {
      let h = Math.round(cp.s);
      if (h === 0) h = 1;
      AddToolState.height = h;
    }
  }
  return true;
}

let nextNameCube = 1;

export function handleAddToolPointerDown(clientX, clientY, canvas) {
  if (!AddToolState.active) return false;
  
  if (AddToolState.phase === 'HOVER' && AddToolState.currentPoint) {
    AddToolState.phase = 'DRAW_BASE';
    return true;
  } else if (AddToolState.phase === 'EXTRUDE') {
    const t = AddToolState.getCubeTransform();
    if (t) finalizeCube(t);
    AddToolState.phase = 'HOVER';
    return true;
  }
  return false;
}

export function handleAddToolPointerUp(clientX, clientY, canvas, isClick) {
  if (!AddToolState.active) return false;
  
  if (AddToolState.phase === 'DRAW_BASE') {
    if (isClick) {
      // Just a click, spawn default size
      AddToolState.currentPoint = vAdd(AddToolState.startPoint, [
        Math.abs(AddToolState.localNormal[0]) > 0.5 ? 0 : 1,
        Math.abs(AddToolState.localNormal[1]) > 0.5 ? 0 : 1,
        Math.abs(AddToolState.localNormal[2]) > 0.5 ? 0 : 1
      ]);
      AddToolState.height = 1;
      
      const t = AddToolState.getCubeTransform();
      finalizeCube(t);
      AddToolState.phase = 'HOVER';
    } else {
      // Move to extrude
      AddToolState.phase = 'EXTRUDE';
    }
    return true;
  }
  return false;
}

function finalizeCube(t) {
  const primaryEid = getPrimarySelection();
  const parent = primaryEid >= 0 && NodeMeta.isGroup[primaryEid] ? primaryEid : -1;
  const data = {
    name: `Cube ${nextNameCube++}`,
    parent,
    isGroup: false,
    transform: t,
  };
  paletteIdx++;
  
  History.push({
    label: 'Add Box (Draw)',
    redo() {
      createNodeRaw(data);
      selectNode(data.eid);
      EditorContext.emit('sceneMutated');
    },
    undo() {
      if (data.eid >= 0) {
        destroyNodeRaw(data.eid);
        selectNode(-1);
        EditorContext.emit('sceneMutated');
      }
    }
  });
}
