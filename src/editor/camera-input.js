import { vAdd, vSub, vScale, vCross, vNorm, vDot, rayPlaneIntersect, mat3ToEulerXYZ, mat3Mul, mat3Apply, rotationMat3 } from "../core/utils/math.js?v=2";
import { EditorContext, NodeMeta, getSelection } from "./state.js";
import { readTransform, writeTransform, rebuildMesh, getVirtualPivot } from "./scene-ops.js";
import { syncPropertyInputs } from "./ui/properties.js";
import { GIZMO_AXES, gizmoArmLength } from "./geometry.js";
import { pickAtScreen, frustumSelect } from "./picking.js";
import History from "./history.js";

let gizmoMode = 'translate'; // 'translate' | 'rotate' | 'scale'
export function getGizmoMode() { return gizmoMode; }
export function setGizmoMode(mode) {
  if (mode === 'translate' || mode === 'rotate' || mode === 'scale') gizmoMode = mode;
}

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
  const pivot = getVirtualPivot();
  if (!pivot) return null;
  const { ro, rd } = screenToRay(clientX, clientY, canvas);
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

function pickRotateRing(clientX, clientY, canvas) {
  const pivot = getVirtualPivot();
  if (!pivot) return null;
  const { ro, rd } = screenToRay(clientX, clientY, canvas);
  const armLen = gizmoArmLength();
  const radius = armLen * 0.85;
  const threshold = armLen * 0.12;
  let best = null;
  for (const ax of GIZMO_AXES) {
    const hitPoint = rayPlaneIntersect(ro, rd, pivot, ax.dir);
    if (!hitPoint) continue;
    const dist = Math.abs(Math.hypot(...vSub(hitPoint, pivot)) - radius);
    if (dist < threshold && (!best || dist < best.dist)) best = { axis: ax.key, dir: ax.dir, dist, hitPoint };
  }
  return best;
}

function pickScaleHandle(clientX, clientY, canvas) {
  // Scale handles sit on the same shafts as translate arrows, just
  // rendered with a cube tip instead of a cone — reuse the same
  // axis-line hit test.
  return pickGizmoAxis(clientX, clientY, canvas);
}

/** Signed angle (radians) of vector `v` around `axisDir`, measured from reference plane basis (p1, p2). */
function angleAroundAxis(v, p1, p2) {
  return Math.atan2(vDot(v, p2), vDot(v, p1));
}

function ringPlaneBasis(axisDir) {
  const ref = Math.abs(axisDir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const p1 = vNorm(vCross(axisDir, ref));
  const p2 = vCross(axisDir, p1);
  return { p1, p2 };
}

const MARQUEE_THRESHOLD = 4; // px — below this, a left-button interaction is treated as a click, not a drag

function getMarqueeBox() {
  return document.getElementById('marquee-box');
}

function showMarquee(x, y) {
  const box = getMarqueeBox();
  if (!box) return;
  box.style.display = 'block';
  box.style.left = x + 'px';
  box.style.top = y + 'px';
  box.style.width = '0px';
  box.style.height = '0px';
}

function updateMarquee(x0, y0, x1, y1) {
  const box = getMarqueeBox();
  if (!box) return;
  const left = Math.min(x0, x1), top = Math.min(y0, y1);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  box.style.width = Math.abs(x1 - x0) + 'px';
  box.style.height = Math.abs(y1 - y0) + 'px';
}

function hideMarquee() {
  const box = getMarqueeBox();
  if (box) box.style.display = 'none';
}

export function initCameraInput(canvas) {
  let inputMode = null; // 'orbit' | 'pan' | 'gizmo' | 'marquee' | null
  let lastMouse = [0, 0];
  let mouseDownPos = [0, 0];
  let mouseDownCanvasPos = [0, 0]; // clientX/Y minus canvas rect, for marquee rect math
  let gizmoDrag = null; // { axis, dir, startS, startT }

  canvas.addEventListener('mousedown', (e) => {
    mouseDownPos = [e.clientX, e.clientY];
    lastMouse = [e.clientX, e.clientY];
    const rect = canvas.getBoundingClientRect();
    mouseDownCanvasPos = [e.clientX - rect.left, e.clientY - rect.top];

    if (e.button === 0) {
      const selection = Array.from(getSelection());
      const pivot = getVirtualPivot();
      let hit = null;
      if (pivot) {
        if (gizmoMode === 'translate') hit = pickGizmoAxis(e.clientX, e.clientY, canvas);
        else if (gizmoMode === 'rotate') hit = pickRotateRing(e.clientX, e.clientY, canvas);
        else if (gizmoMode === 'scale') hit = pickScaleHandle(e.clientX, e.clientY, canvas);
      }
      if (hit) {
        inputMode = 'gizmo';
        const startTransforms = [];
        for (const eid of selection) {
          if (!NodeMeta.isGroup[eid]) {
            startTransforms.push({ eid, t: readTransform(eid) });
          }
        }
        if (gizmoMode === 'translate') {
          gizmoDrag = { mode: 'translate', axis: hit.axis, dir: hit.dir, startS: hit.s, startTransforms, pivot };
        } else if (gizmoMode === 'rotate') {
          const { p1, p2 } = ringPlaneBasis(hit.dir);
          const startAngle = angleAroundAxis(vSub(hit.hitPoint, pivot), p1, p2);
          gizmoDrag = { mode: 'rotate', axis: hit.axis, dir: hit.dir, p1, p2, startAngle, startTransforms, pivot };
        } else if (gizmoMode === 'scale') {
          gizmoDrag = { mode: 'scale', axis: hit.axis, dir: hit.dir, startS: hit.s, startTransforms, pivot };
        }
      } else {
        // Not yet known whether this is a click or a marquee drag — resolved
        // on mousemove (once past MARQUEE_THRESHOLD) / mouseup (see below).
        inputMode = 'marquee';
      }
    } else if (e.button === 1) {
      e.preventDefault(); // stop the browser's native middle-click autoscroll cursor
      inputMode = 'orbit';
    } else if (e.button === 2) {
      inputMode = 'pan';
    }
    canvas.classList.add('dragging');
  });

  window.addEventListener('mouseup', (e) => {
    const moved = Math.hypot(e.clientX - mouseDownPos[0], e.clientY - mouseDownPos[1]);
    if (inputMode === 'gizmo' && gizmoDrag) {
      if (moved > 1) {
        const snapshots = gizmoDrag.startTransforms.map(st => ({ eid: st.eid, startT: st.t, newT: readTransform(st.eid) }));
        const verb = gizmoDrag.mode === 'translate' ? 'Translate' : gizmoDrag.mode === 'rotate' ? 'Rotate' : 'Scale';
        const label = snapshots.length > 1 ? `${verb} ${snapshots.length} Elements` : `${verb} Element`;

        History.push({
            label,
            redo() {
                for (const s of snapshots) writeTransform(s.eid, s.newT);
                for (const s of snapshots) rebuildMesh(s.eid);
                EditorContext.refreshProperties();
            },
            undo() {
                for (const s of snapshots) writeTransform(s.eid, s.startT);
                for (const s of snapshots) rebuildMesh(s.eid);
                EditorContext.refreshProperties();
            }
        });
      } else {
        for (const st of gizmoDrag.startTransforms) {
          writeTransform(st.eid, st.t);
          rebuildMesh(st.eid);
        }
        EditorContext.refreshProperties();
      }
      gizmoDrag = null;
    } else if (inputMode === 'marquee') {
      if (moved < MARQUEE_THRESHOLD) {
        // Plain click, no meaningful drag — single-object pick (existing behavior).
        pickAtScreen(e.clientX, e.clientY, canvas, e.shiftKey);
      } else {
        const rect = canvas.getBoundingClientRect();
        const x1 = e.clientX - rect.left, y1 = e.clientY - rect.top;
        frustumSelect({ x0: mouseDownCanvasPos[0], y0: mouseDownCanvasPos[1], x1, y1 }, canvas, e.shiftKey);
      }
      hideMarquee();
    }
    inputMode = null;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    if (inputMode === 'gizmo' && gizmoDrag) {
      const { ro, rd } = screenToRay(e.clientX, e.clientY, canvas);
      if (gizmoDrag.mode === 'translate') {
        const cp = closestParamsBetweenLines(gizmoDrag.pivot, gizmoDrag.dir, ro, rd);
        if (cp) {
          const delta = cp.s - gizmoDrag.startS;
          for (const st of gizmoDrag.startTransforms) {
            const t = { ...st.t };
            t.ox += gizmoDrag.dir[0] * delta;
            t.oy += gizmoDrag.dir[1] * delta;
            t.oz += gizmoDrag.dir[2] * delta;
            t.px += gizmoDrag.dir[0] * delta;
            t.py += gizmoDrag.dir[1] * delta;
            t.pz += gizmoDrag.dir[2] * delta;
            writeTransform(st.eid, t);
            rebuildMesh(st.eid);
          }
          if (gizmoDrag.startTransforms.length === 1) syncPropertyInputs(gizmoDrag.startTransforms[0].eid);
        }
      } else if (gizmoDrag.mode === 'rotate') {
        const hitPoint = rayPlaneIntersect(ro, rd, gizmoDrag.pivot, gizmoDrag.dir);
        if (hitPoint) {
          const currentAngle = angleAroundAxis(vSub(hitPoint, gizmoDrag.pivot), gizmoDrag.p1, gizmoDrag.p2);
          const deltaAngle = currentAngle - gizmoDrag.startAngle;
          // deltaR is an elementary world-axis rotation (axis is always a
          // unit X/Y/Z gizmo axis), so we can build it directly instead of
          // a general Rodrigues axis-angle formula.
          const deltaR =
            gizmoDrag.axis === 'x' ? rotationMat3(deltaAngle * 180 / Math.PI, 0, 0) :
            gizmoDrag.axis === 'y' ? rotationMat3(0, deltaAngle * 180 / Math.PI, 0) :
            rotationMat3(0, 0, deltaAngle * 180 / Math.PI);
          for (const st of gizmoDrag.startTransforms) {
            const t = { ...st.t };
            const R_old = rotationMat3(st.t.rx, st.t.ry, st.t.rz);
            const R_new = mat3Mul(deltaR, R_old);
            const euler = mat3ToEulerXYZ(R_new);
            t.rx = euler.rx; t.ry = euler.ry; t.rz = euler.rz;
            // Orbit this object's own pivot around the shared virtual pivot.
            // Exact for single-selection (pivot === virtual pivot, no orbit
            // term) and for un-rotated objects; a small approximation for
            // multi-select rotation of already-rotated objects (documented
            // in Fase 6.5 of the roadmap) — every plain-Euler rotate gizmo
            // shares this limitation.
            const rel = [st.t.px - gizmoDrag.pivot[0], st.t.py - gizmoDrag.pivot[1], st.t.pz - gizmoDrag.pivot[2]];
            const relRotated = mat3Apply(deltaR, rel);
            t.px = gizmoDrag.pivot[0] + relRotated[0];
            t.py = gizmoDrag.pivot[1] + relRotated[1];
            t.pz = gizmoDrag.pivot[2] + relRotated[2];
            writeTransform(st.eid, t);
            rebuildMesh(st.eid);
          }
          if (gizmoDrag.startTransforms.length === 1) syncPropertyInputs(gizmoDrag.startTransforms[0].eid);
        }
      } else if (gizmoDrag.mode === 'scale') {
        const cp = closestParamsBetweenLines(gizmoDrag.pivot, gizmoDrag.dir, ro, rd);
        if (cp) {
          // Ratio of current handle distance to where the drag started —
          // dragging away from the pivot grows the box, dragging past it
          // shrinks/flips it. Clamped so k never collapses to <= 0.
          const k = Math.max(0.05, cp.s / gizmoDrag.startS);
          for (const st of gizmoDrag.startTransforms) {
            // Scale is applied in the object's own PRE-rotation local space
            // (ox/sx live there, same as px — see readTransform/writeTransform),
            // so this is exact regardless of the object's rx/ry/rz: no
            // shearing risk. Each object scales about its OWN pivot
            // (st.t.px/py/pz), not the shared virtual pivot — a group of
            // objects scales in place rather than fanning outward. Documented
            // as the Fase 6.5 MVP scope in the roadmap.
            const t = { ...st.t };
            if (gizmoDrag.axis === 'x') { t.ox = st.t.px + (st.t.ox - st.t.px) * k; t.sx = st.t.sx * k; }
            else if (gizmoDrag.axis === 'y') { t.oy = st.t.py + (st.t.oy - st.t.py) * k; t.sy = st.t.sy * k; }
            else { t.oz = st.t.pz + (st.t.oz - st.t.pz) * k; t.sz = st.t.sz * k; }
            writeTransform(st.eid, t);
            rebuildMesh(st.eid);
          }
          if (gizmoDrag.startTransforms.length === 1) syncPropertyInputs(gizmoDrag.startTransforms[0].eid);
        }
      }
      lastMouse = [e.clientX, e.clientY];
      return;
    }
    if (inputMode === 'marquee') {
      const moved = Math.hypot(e.clientX - mouseDownPos[0], e.clientY - mouseDownPos[1]);
      if (moved >= MARQUEE_THRESHOLD) {
        const rect = canvas.getBoundingClientRect();
        const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
        showMarquee(mouseDownCanvasPos[0], mouseDownCanvasPos[1]);
        updateMarquee(mouseDownCanvasPos[0], mouseDownCanvasPos[1], curX, curY);
      }
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
