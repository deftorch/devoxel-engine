import { vAdd, vSub, vScale, vNorm, rayPlaneIntersect, rotationMat3, mat3Transpose, mat3Apply } from "../core/utils/math.js?v=2";
import { raycastWorld } from "./picking.js";
import { screenToRay, closestParamsBetweenLines } from "./camera-input.js";
import { createNodeRaw, destroyNodeRaw, selectNode } from "./scene-ops.js";
import { getPrimarySelection, NodeMeta, EditorContext } from "./state.js";
import History from "./history.js";
import { interleaveLine } from "./geometry.js";
import { loadAddToolSettings, saveAddToolSettings, DEFAULT_PALETTE, DEFAULT_UNIT_SIZE, DEFAULT_SNAP_ENABLED } from "./settings.js";

const settings = loadAddToolSettings();
let PALETTE = settings.palette;
let paletteIdx = 0;

/**
 * Current palette (read-only view for the settings UI to render swatches
 * from). Returns a COPY, not the live internal array - callers must go
 * through setPalette() to mutate, which also persists + resets the cycle
 * index. Returning the live reference previously would've let a caller
 * mutate internal state without triggering persistence, silently
 * desyncing localStorage from what's actually in use.
 */
export function getPalette() {
  return [...PALETTE];
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
  AddToolState.snapEnabled = DEFAULT_SNAP_ENABLED;
  saveAddToolSettings({ unitSize: DEFAULT_UNIT_SIZE, palette: PALETTE, snapEnabled: DEFAULT_SNAP_ENABLED });
  updateAddToolHud();
}

/**
 * Toggles the persisted default snap state (from the settings panel
 * checkbox). Separate from the transient per-drag Ctrl-hold inversion in
 * handleAddToolPointerMove - this changes what snapping defaults to when
 * Ctrl ISN'T held, not a one-off override.
 */
export function setSnapEnabled(enabled) {
  AddToolState.snapEnabled = !!enabled;
  saveAddToolSettings({ unitSize: AddToolState.baseUnitSize, palette: PALETTE, snapEnabled: AddToolState.snapEnabled });
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
  snapEnabled: settings.snapEnabled, // when true, drag/extrude snap to
    // baseUnitSize increments (old behavior). When false, dimensions are
    // free/continuous - the user can draw non-square, non-integer-sized
    // boxes. Holding Ctrl while dragging temporarily INVERTS this for that
    // drag only (see handleAddToolPointerMove) without changing the
    // persisted default.

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

  /** Inverse of worldToTarget() - maps a point in the target surface's
   * local (de-rotated, re-anchored) frame back to world space. Used for
   * drawing things that live in local space (like the hover face grid
   * overlay) back onto the actual rotated/offset target surface. */
  targetToWorld(localPoint) {
    return vAdd(mat3Apply(rotationMat3(...this.targetRotation), localPoint), this.targetPivot);
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

  /**
   * Resolves a raw local-frame point to what actually gets stored as
   * startPoint/currentPoint, depending on whether snapping applies for
   * this interaction. `snap=true` keeps the old grid-cell behavior
   * (snapToCell). `snap=false` skips grid snapping entirely and just
   * rounds to 3 decimals to kill float noise - so drags/extrudes can land
   * on ANY size and any position, not just unit multiples, enabling
   * non-square/non-integer boxes.
   */
  resolvePoint(localPoint, snap) {
    if (snap) return this.snapToCell(localPoint);
    return localPoint.map(v => Math.round(v * 1000) / 1000);
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

    // A plain click (no drag at all) always lands here with
    // startPoint===currentPoint exactly, regardless of snap mode - the two
    // points were assigned from the very same HOVER-phase value and never
    // diverged. Universally treat that as "give me one default-size box"
    // (same as the old always-snapped behavior), rather than a literal
    // zero-size box, whether or not snapping is on for the drag itself.
    const isPointClick = minX === maxX && minY === maxY && minZ === maxZ;
    const padWithUnit = this.snapEnabled || isPointClick;

    // localNormal is always exactly one of +-X/+-Y/+-Z (a raw AABB face
    // normal from the target's own local space), so this classification is
    // exact regardless of how the target is rotated in the world - unlike
    // thresholding the world-space normal, which can be diagonal (e.g.
    // [0.7,0,0.7] on a 45-degree-rotated target) and get misclassified.
    //
    // When padWithUnit is true, both in-plane axes get +unit added to
    // their max: with snapping on, startPoint/currentPoint are FLOORED
    // cell indices (see snapToCell), so min/max represent an INCLUSIVE
    // cell-index range that must be converted to an EXCLUSIVE grid-line
    // span by adding one unit to the far end. When snapping is off (free
    // drag), min/max are already literal continuous endpoints of the
    // drawn box, so no padding is added - sx/sy/sz come out as whatever
    // size the user actually dragged, including non-square and
    // non-integer dimensions.
    if (Math.abs(this.localNormal[0]) > 0.5) {
      if (padWithUnit) { maxY += unit; maxZ += unit; }
      if (this.height >= 0) maxX += this.height;
      else minX += this.height;
    } else if (Math.abs(this.localNormal[1]) > 0.5) {
      if (padWithUnit) { maxX += unit; maxZ += unit; }
      if (this.height >= 0) maxY += this.height;
      else minY += this.height;
    } else {
      if (padWithUnit) { maxX += unit; maxY += unit; }
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
  const snapLabel = AddToolState.snapEnabled ? 'Snap: ON' : 'Snap: OFF (bebas)';
  // Round for display only - never feeds back into the actual math above.
  const fmt = (n) => AddToolState.snapEnabled ? n : Math.round(n * 100) / 100;

  if (AddToolState.phase === 'HOVER') {
    hud.textContent = `Ukuran dasar: ${unit}×${unit}×${unit}  (${snapLabel} · tahan Ctrl untuk balik sementara · klik untuk kubus instan · drag untuk gambar bebas · Ctrl+Scroll ubah unit · klik-kanan batal)`;
  } else {
    const t = AddToolState.getCubeTransform();
    if (t) {
      hud.textContent = AddToolState.phase === 'DRAW_BASE'
        ? `Alas: ${fmt(t.sx)}×${fmt(t.sz)}  (${snapLabel}, unit ${unit})`
        : `${fmt(t.sx)}×${fmt(t.sy)}×${fmt(t.sz)}  (${snapLabel}, unit ${unit}) — klik untuk selesai, klik-kanan untuk batal`;
    }
  }
}

const EXTRUDE_MOVE_THRESHOLD = 6; // px — below this, height stays at its last stable value rather than trusting a possibly near-parallel (numerically unstable) ray/axis-line intersection

export function handleAddToolPointerMove(clientX, clientY, canvas, ctrlKey = false) {
  if (!AddToolState.active) return false;
  lastMousePos = [clientX, clientY];

  // Ctrl temporarily INVERTS the persisted snap default for this
  // interaction only - matches the same "hold Ctrl to flip snapping"
  // convention as Blender - so users don't have to open Settings just to
  // draw one free-form box while snap-by-default stays on, or vice versa.
  const wantSnap = ctrlKey ? !AddToolState.snapEnabled : AddToolState.snapEnabled;

  if (AddToolState.phase === 'HOVER') {
    const hit = raycastWorld(clientX, clientY, canvas);
    if (hit) {
      AddToolState.normal = hit.normal;
      AddToolState.localNormal = hit.localNormal;
      AddToolState.targetRotation = hit.rotation;
      AddToolState.targetPivot = hit.pivot;
      const localPoint = AddToolState.worldToTarget(hit.point);
      AddToolState.currentPoint = AddToolState.resolvePoint(localPoint, wantSnap);
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
      AddToolState.currentPoint = AddToolState.resolvePoint(planeHit, wantSnap);
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
      let h = wantSnap ? Math.round(cp.s / unit) * unit : Math.round(cp.s * 1000) / 1000;
      if (h === 0) h = wantSnap ? unit : (cp.s >= 0 ? 0.01 : -0.01);
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

/**
 * Instantly spawns a default-size cube, independent of Add mode / hover
 * targeting - analogous to Blender's Shift+A "Add > Cube" from the
 * default (non-interactive) Add menu. Since devoxel has no 3D Cursor
 * concept, the closest equivalent "current point of focus" is the
 * camera's orbit target (EditorContext.camera.target), which is already
 * what the user is looking at/orbiting around.
 */
export function spawnInstantCube() {
  const [px, py, pz] = EditorContext.camera.target;
  const unit = AddToolState.baseUnitSize;
  const [r, g, b] = hexToRgb01(PALETTE[paletteIdx % PALETTE.length]);
  const t = {
    ox: px - unit / 2, oy: py - unit / 2, oz: pz - unit / 2,
    sx: unit, sy: unit, sz: unit,
    px, py, pz,
    rx: 0, ry: 0, rz: 0,
    r, g, b
  };
  finalizeCube(t);
}

/**
 * Builds a small grid patch of line geometry drawn flat on the currently
 * hovered target surface, in world space - purely a visual reference of
 * scale/orientation (like Blender's overlay in its Interactive Add tool),
 * it does NOT enforce or represent actual snapping (drag can still be
 * free-form if snapEnabled is off; see resolvePoint()). Returns null when
 * there's nothing valid to draw on (not hovering, or not in HOVER phase).
 */
export function buildHoverFaceGrid() {
  if (AddToolState.phase !== 'HOVER' || !AddToolState.currentPoint) return null;
  const unit = AddToolState.baseUnitSize;
  const n = AddToolState.localNormal;
  const axisIdx = n.findIndex((v) => Math.abs(v) > 0.5);
  if (axisIdx < 0) return null;
  const [ia, ib] = [0, 1, 2].filter((i) => i !== axisIdx);
  const center = AddToolState.currentPoint;
  const baseA = Math.floor(center[ia] / unit) * unit;
  const baseB = Math.floor(center[ib] / unit) * unit;
  const half = 3; // 3 cells each direction -> 6x6 patch around the cursor
  const pos = [], col = [];
  const gridColor = [0.95, 0.95, 1];

  for (let i = -half; i <= half; i++) {
    const aVal = baseA + i * unit;
    const p0 = [0, 0, 0], p1 = [0, 0, 0];
    p0[axisIdx] = p1[axisIdx] = center[axisIdx];
    p0[ia] = p1[ia] = aVal;
    p0[ib] = baseB - half * unit;
    p1[ib] = baseB + half * unit;
    pos.push(...AddToolState.targetToWorld(p0), ...AddToolState.targetToWorld(p1));
    col.push(...gridColor, ...gridColor);

    const bVal = baseB + i * unit;
    const q0 = [0, 0, 0], q1 = [0, 0, 0];
    q0[axisIdx] = q1[axisIdx] = center[axisIdx];
    q0[ib] = q1[ib] = bVal;
    q0[ia] = baseA - half * unit;
    q1[ia] = baseA + half * unit;
    pos.push(...AddToolState.targetToWorld(q0), ...AddToolState.targetToWorld(q1));
    col.push(...gridColor, ...gridColor);
  }
  return interleaveLine(pos, col);
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
