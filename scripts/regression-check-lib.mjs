// Shared setup for scripts/regression-check.mjs: loads the real editor.html
// into jsdom (so every module's `document.getElementById(...)` call finds
// the exact same elements it would in a browser), and provides a
// world-to-screen projector (reusing the same view/proj math verified in
// Fase 6.3's frustumSelect()) so synthetic mouse events can be aimed at
// precise 3D points instead of guessed screen pixels.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

export function setupDom() {
  const html = readFileSync(join(ROOT, 'editor.html'), 'utf-8');
  const dom = new JSDOM(html, { url: 'http://localhost/editor.html', pretendToBeVisual: true });

  global.window = dom.window;
  global.document = dom.window.document;
  global.MouseEvent = dom.window.MouseEvent;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.WheelEvent = dom.window.WheelEvent;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  if (!global.localStorage) global.localStorage = dom.window.localStorage;

  const canvas = document.getElementById('gpu-canvas');
  canvas.width = 800;
  canvas.height = 600;
  // jsdom has no real layout engine, so getBoundingClientRect() is
  // zero by default - pin it to the canvas buffer size (no
  // devicePixelRatio/scroll offset complications) so screen coordinates
  // from worldToScreen() line up 1:1 with clientX/clientY.
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });

  return { dom, canvas };
}

export async function makeProjector() {
  const math = await import(join(ROOT, 'src/core/utils/math.js'));
  const cameraInput = await import(join(ROOT, 'src/editor/camera-input.js'));

  /** Projects a world-space point to canvas-relative screen pixel coords. */
  function worldToScreen(worldPoint) {
    const { eye, forward } = cameraInput.cameraBasis();
    const center = math.vAdd(eye, forward);
    const view = math.mat4LookAt(eye, center, [0, 1, 0]);
    const proj = math.mat4Perspective(cameraInput.getFovY(), 800 / 600, 0.1, 500);
    const viewProj = math.mat4Multiply(proj, view);
    return math.projectToScreen(viewProj, worldPoint, 800, 600);
  }

  return { worldToScreen };
}

export function dispatchMouse(canvas, type, x, y, opts = {}) {
  const ev = new MouseEvent(type, {
    clientX: x, clientY: y, bubbles: true, cancelable: true,
    button: opts.button ?? 0, buttons: opts.buttons,
    shiftKey: !!opts.shiftKey, ctrlKey: !!opts.ctrlKey,
  });
  const target = opts.onWindow ? window : canvas;
  target.dispatchEvent(ev);
}
