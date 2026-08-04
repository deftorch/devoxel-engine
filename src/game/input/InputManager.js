export class InputManager {
  constructor(canvas) {
    this.keys = new Set();
    this.canvas = canvas;
    this.onMouseMove = null;
    this.onKeyDown = null;

    window.addEventListener('keydown', e => {
      this.keys.add(e.code);
      if (this.onKeyDown) this.onKeyDown(e.code);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));

    canvas.addEventListener('click', () => canvas.requestPointerLock());
    
    canvas.addEventListener('mousedown', e => {
      if (document.pointerLockElement === canvas && this.onMouseDown) {
         this.onMouseDown(e.button);
      }
    });
    
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== canvas) return;
      if (this.onMouseMove) this.onMouseMove(e.movementX, e.movementY);
    });
  }
}
