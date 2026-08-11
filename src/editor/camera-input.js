import { vAdd, vSub, vScale, vCross, vNorm, vDot } from "../core/utils/math.js?v=2";
import { EditorContext, Transform, NodeMeta, getPrimarySelection } from "./state.js";
import { readTransform, writeTransform, commitTransform, rebuildMesh } from "./scene-ops.js";
import { syncPropertyInputs } from "./ui/properties.js";
import { GIZMO_AXES, gizmoArmLength } from "./geometry.js";
import { pickAtScreen } from "./picking.js";

export function cameraBasis() {
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
export function getFovY() { return FOV_Y; }

export function screenToRay(clientX, clientY, canvas) {
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

export function closestParamsBetweenLines(p0, d1, ro, d2) {
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

function pickGizmoAxis(clientX, clientY, canvas) {
  const primaryEid = getPrimarySelection();
  if (primaryEid < 0 || NodeMeta.isGroup[primaryEid]) return null;
  const { ro, rd } = screenToRay(clientX, clientY, canvas);
  const pivot = [Transform.px[primaryEid], Transform.py[primaryEid], Transform.pz[primaryEid]];
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

export function initCameraInput(canvas) {
  let inputMode = null; // 'orbit' | 'pan' | 'gizmo' | null
  let lastMouse = [0, 0];
  let mouseDownPos = [0, 0];
  let gizmoDrag = null; // { axis, dir, startS, startT }

  canvas.addEventListener('mousedown', (e) => {
    mouseDownPos = [e.clientX, e.clientY];
    lastMouse = [e.clientX, e.clientY];
    const primaryEid = getPrimarySelection();
    const hit = e.button === 0 ? pickGizmoAxis(e.clientX, e.clientY, canvas) : null;
    if (hit && primaryEid >= 0) {
      inputMode = 'gizmo';
      gizmoDrag = { axis: hit.axis, dir: hit.dir, startS: hit.s, startT: readTransform(primaryEid), eid: primaryEid };
    } else {
      inputMode = e.button === 2 ? 'pan' : 'orbit';
    }
    canvas.classList.add('dragging');
  });

  window.addEventListener('mouseup', (e) => {
    const moved = Math.hypot(e.clientX - mouseDownPos[0], e.clientY - mouseDownPos[1]);
    if (inputMode === 'gizmo' && gizmoDrag) {
      const newT = readTransform(gizmoDrag.eid);
      if (moved > 1)
        commitTransform(gizmoDrag.eid, gizmoDrag.startT, newT);
      else {
        writeTransform(gizmoDrag.eid, gizmoDrag.startT);
        rebuildMesh(gizmoDrag.eid);
        EditorContext.refreshProperties();
      }
      gizmoDrag = null;
    } else if (moved < 4 && e.button === 0) {
      pickAtScreen(e.clientX, e.clientY, canvas, e.shiftKey);
    }
    inputMode = null;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    if (inputMode === 'gizmo' && gizmoDrag) {
      const { ro, rd } = screenToRay(e.clientX, e.clientY, canvas);
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
        writeTransform(gizmoDrag.eid, t);
        rebuildMesh(gizmoDrag.eid);
        syncPropertyInputs(gizmoDrag.eid);
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
}
