import { vAdd, vSub, vScale, vNorm, rayPlaneIntersect } from "../core/utils/math.js?v=2";
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
  startPoint: null, 
  currentPoint: null,
  normal: [0, 1, 0],
  height: 1,

  getCubeTransform() {
    if (!this.startPoint || !this.currentPoint) return null;
    let minX = Math.min(this.startPoint[0], this.currentPoint[0]);
    let maxX = Math.max(this.startPoint[0], this.currentPoint[0]);
    let minY = Math.min(this.startPoint[1], this.currentPoint[1]);
    let maxY = Math.max(this.startPoint[1], this.currentPoint[1]);
    let minZ = Math.min(this.startPoint[2], this.currentPoint[2]);
    let maxZ = Math.max(this.startPoint[2], this.currentPoint[2]);

    if (Math.abs(this.normal[0]) > 0.5) {
      if (minY === maxY) maxY += 1;
      if (minZ === maxZ) maxZ += 1;
      if (this.height >= 0) maxX += this.height;
      else minX += this.height;
    } else if (Math.abs(this.normal[1]) > 0.5) {
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
    const px = minX + sx/2;
    const py = minY + sy/2;
    const pz = minZ + sz/2;

    const [r, g, b] = hexToRgb01(PALETTE[paletteIdx % PALETTE.length]);

    return {
      ox: minX, oy: minY, oz: minZ,
      sx, sy, sz,
      px, py, pz,
      rx: 0, ry: 0, rz: 0,
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
      AddToolState.currentPoint = snapVector(hit.point);
      AddToolState.startPoint = AddToolState.currentPoint;
      AddToolState.height = 1;
    } else {
      AddToolState.currentPoint = null;
    }
  } else if (AddToolState.phase === 'DRAW_BASE') {
    const { ro, rd } = screenToRay(clientX, clientY, canvas);
    const planeHit = rayPlaneIntersect(ro, rd, AddToolState.startPoint, AddToolState.normal);
    if (planeHit) {
      AddToolState.currentPoint = snapVector(planeHit);
      AddToolState.height = 1;
    }
  } else if (AddToolState.phase === 'EXTRUDE') {
    const { ro, rd } = screenToRay(clientX, clientY, canvas);
    // Project ray to the normal axis passing through startPoint
    const cp = closestParamsBetweenLines(AddToolState.startPoint, AddToolState.normal, ro, rd);
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
        Math.abs(AddToolState.normal[0]) > 0.5 ? 0 : 1,
        Math.abs(AddToolState.normal[1]) > 0.5 ? 0 : 1,
        Math.abs(AddToolState.normal[2]) > 0.5 ? 0 : 1
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
