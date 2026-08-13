import { vAdd, vSub, vScale, vNorm, rayPlaneIntersect, rotationMat3, mat3Transpose, mat3Apply } from "../core/utils/math.js?v=2";
import { raycastWorld } from "./picking.js";
import { screenToRay, closestParamsBetweenLines } from "./camera-input.js";
import { createNodeRaw, destroyNodeRaw, selectNode } from "./scene-ops.js";
import { getPrimarySelection, NodeMeta, EditorContext } from "./state.js";
import History from "./history.js";
import { loadAddToolSettings, saveAddToolSettings, DEFAULT_PALETTE, DEFAULT_UNIT_SIZE } from "./settings.js";

const settings = loadAddToolSettings();
let PALETTE = settings.palette;
let paletteIdx = 0;

/** Current palette (read-only view for the settings UI to render swatches from). */
export function getPalette() {
  return PALETTE;
}
/** Replaces the palette (from the settings UI), persists it, and resets the cycle index so the next cube starts from PALETTE[0]. */
export function setPalette(colors) {
  PALETTE = colors.length > 0 ? colors : [...DEFAULT_PALETTE];
  paletteIdx = 0;
  saveAddToolSettings({ unitSize: AddToolState.baseUnitSize, palette: PALETTE });
}
export function resetAddToolSettingsToDefault() {
  PALETTE = [...DEFAULT_PALETTE];
  paletteIdx = 0;
  AddToolState.baseUnitSize = DEFAULT_UNIT_SIZE;
  saveAddToolSettings({ unitSize: DEFAULT_UNIT_SIZE, palette: PALETTE });
  updateAddToolHud();
}

export function hexToRgb01(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
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
  baseUnitSize: settings.unitSize, // adjustable via Ctrl+Scroll while Add mode is active; persisted (settings.js).
  extrudeStartScreenPos: [0, 0], // screen position when EXTRUDE phase began,
                                  // used to require deliberate mouse movement
                                  // before trusting the height computation.

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

  /**
   * Snaps a local-frame point to the placement grid. The axis aligned with
   * localNormal (the flat plane being drawn on) is rounded to the nearest
   * unit multiple - it's already an exact face coordinate in practice, so
   * this is just float-noise cleanup. The two IN-PLANE axes are FLOORED to
   * the nearest unit multiple below the point, not rounded to the nearest
   * one: rounding was the root cause of the "drag starts one cell late"
   * bug - a cursor anywhere in the second half of cell N (e.g. local x in
   * [N+0.5, N+1)) would round to vertex N+1 instead of resolving to cell N,
   * silently starting the drag one cell over from where the user was
   * actually aiming. Flooring instead means EVERY point inside cell N
   * consistently resolves to N, matching how block-placement tools
   * (Minecraft etc.) resolve "which cell is under the cursor".
   */
  snapToCell(v) {
    const unit = this.baseUnitSize;
    return v.map((coord, i) => {
      const onNormalAxis = Math.abs(this.localNormal[i]) > 0.5;
      return onNormalAxis ? Math.round(coord / unit) * unit : Math.floor(coord / unit) * unit;
    });
  },

  getCubeTransform() {
    if (!this.startPoint || !this.currentPoint) return null;
    const unit = this.baseUnitSize;
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
    //
    // Both in-plane axes always get +unit added to their max, regardless of
    // whether min===max: since startPoint/currentPoint are now FLOORED cell
    // indices (see snapToCell), min/max represent an INCLUSIVE cell-index
    // range that must always be converted to an EXCLUSIVE grid-line span by
    // adding one unit to the far end - for a single cell (min===max) that's
    // exactly the old "+1 if equal" behavior; for a multi-cell drag
    // (min!==max) it now ALSO correctly includes the last dragged cell,
    // which the old code silently failed to do (that mismatch, combined
    // with the rounding bug above, is what produced the off-by-one).
    if (Math.abs(this.localNormal[0]) > 0.5) {
      maxY += unit;
      maxZ += unit;
      if (this.height >= 0) maxX += this.height;
      else minX += this.height;
    } else if (Math.abs(this.localNormal[1]) > 0.5) {
      maxX += unit;
      maxZ += unit;
      if (this.height >= 0) maxY += this.height;
      else minY += this.height;
    } else {
      maxX += unit;
      maxY += unit;
      if (this.height >= 0) maxZ += this.height;
      else minZ += this.height;
    }

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

/**
 * Updates the on-screen HUD showing the current base unit size, and (while
 * actively drawing) the in-progress box dimensions. Kept simple/direct DOM
 * writes here, colocated with the state it displays - same pattern as
 * outliner.js/properties.js self-managing their own DOM.
 */
export function updateAddToolHud() {
  const hud = document.getElementById('add-tool-hud');
  if (!hud) return;
  if (!AddToolState.active) {
    hud.style.display = 'none';
    return;
  }
  hud.style.display = 'block';
  const unit = AddToolState.baseUnitSize;
  if (AddToolState.phase === 'HOVER') {
    hud.textContent = `Ukuran dasar: ${unit}×${unit}×${unit}  (Ctrl+Scroll untuk ubah, klik-kanan untuk batal)`;
  } else {
    const t = AddToolState.getCubeTransform();
    if (t) {
      hud.textContent = AddToolState.phase === 'DRAW_BASE'
        ? `Alas: ${t.sx}×${t.sz}  (unit dasar ${unit})`
        : `${t.sx}×${t.sy}×${t.sz}  (unit dasar ${unit}) — klik untuk selesai, klik-kanan untuk batal`;
    }
  }
}

const EXTRUDE_MOVE_THRESHOLD = 6; // px — below this, height stays at its last stable value rather than trusting a possibly near-parallel (numerically unstable) ray/axis-line intersection

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
      AddToolState.currentPoint = AddToolState.snapToCell(localPoint);
      AddToolState.startPoint = AddToolState.currentPoint;
      AddToolState.height = AddToolState.baseUnitSize;
    } else {
      AddToolState.currentPoint = null;
    }
  } else if (AddToolState.phase === 'DRAW_BASE') {
    const { ro, rd } = screenToRay(clientX, clientY, canvas);
    const roLocal = AddToolState.worldToTarget(ro);
    const rdLocal = mat3Apply(AddToolState.targetRinv(), rd);
    const planeHit = rayPlaneIntersect(roLocal, rdLocal, AddToolState.startPoint, AddToolState.localNormal);
    if (planeHit) {
      AddToolState.currentPoint = AddToolState.snapToCell(planeHit);
      AddToolState.height = AddToolState.baseUnitSize;
    }
  } else if (AddToolState.phase === 'EXTRUDE') {
    const movedSinceExtrudeStart = Math.hypot(clientX - AddToolState.extrudeStartScreenPos[0], clientY - AddToolState.extrudeStartScreenPos[1]);
    if (movedSinceExtrudeStart < EXTRUDE_MOVE_THRESHOLD) {
      updateAddToolHud();
      return true; // not enough deliberate movement yet - keep height stable
    }
    const { ro, rd } = screenToRay(clientX, clientY, canvas);
    const roLocal = AddToolState.worldToTarget(ro);
    const rdLocal = mat3Apply(AddToolState.targetRinv(), rd);
    // Project ray to the normal axis passing through startPoint
    const cp = closestParamsBetweenLines(AddToolState.startPoint, AddToolState.localNormal, roLocal, rdLocal);
    if (cp) {
      const unit = AddToolState.baseUnitSize;
      let h = Math.round(cp.s / unit) * unit;
      if (h === 0) h = unit;
      AddToolState.height = h;
    }
  }
  updateAddToolHud();
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
    updateAddToolHud();
    return true;
  }
  return false;
}

/** Cancels any in-progress DRAW_BASE/EXTRUDE placement without creating anything. */
export function cancelAddTool() {
  AddToolState.phase = 'HOVER';
  updateAddToolHud();
}

export function handleAddToolPointerUp(clientX, clientY, canvas, isClick) {
  if (!AddToolState.active) return false;
  
  if (AddToolState.phase === 'DRAW_BASE') {
    if (isClick) {
      // Just a click: startPoint === currentPoint already (no drag
      // happened), and getCubeTransform() always adds +unit to the max
      // extent on the two in-plane axes now, so a single default-size cell
      // falls out automatically - no manual offset needed here anymore.
      AddToolState.height = AddToolState.baseUnitSize;
      const t = AddToolState.getCubeTransform();
      finalizeCube(t);
      AddToolState.phase = 'HOVER';
      updateAddToolHud();
    } else {
      // Move to extrude
      AddToolState.phase = 'EXTRUDE';
      AddToolState.extrudeStartScreenPos = [clientX, clientY];
      AddToolState.height = AddToolState.baseUnitSize;
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
