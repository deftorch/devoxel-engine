export class UIManager {
  constructor() {
    this.overlay = document.getElementById('overlay');
    this.statusEl = document.getElementById('status');
    this.fillEl = document.getElementById('fill');
    this.hud = document.getElementById('hud');
    this.crosshair = document.getElementById('crosshair');
    this.canvas = document.getElementById('gpu-canvas');
    
    window.addEventListener('error', e => this.fail('Runtime error:\n' + (e.error?.stack || e.message)));
    window.addEventListener('unhandledrejection', e => this.fail('Unhandled promise rejection:\n' + (e.reason?.stack || e.reason)));
  }

  setStatus(t, pct) {
    this.statusEl.textContent = t;
    if (pct != null) this.fillEl.style.width = (pct * 100).toFixed(0) + '%';
  }

  fail(msg) {
    this.overlay.classList.remove('hidden');
    this.overlay.innerHTML = `<div id="err">${msg}</div>`;
  }

  hideOverlay() {
    this.overlay.classList.add('hidden');
  }

  showHUD() {
    this.hud.classList.remove('hidden');
    this.crosshair.classList.remove('hidden');
  }

  updateHUD(fps, chunkCount, workerCount, cameraState, lastRemovedInfo, benchmarkStats) {
    let benchHTML = '';
    if (benchmarkStats) {
      benchHTML = `<b>Storage:</b> ${benchmarkStats.type.toUpperCase()} &middot; ` +
                  `<b>Nodes/Mem:</b> ${(benchmarkStats.nodes/1000).toFixed(1)}k &middot; ` +
                  `<b>Gen:</b> ${benchmarkStats.genMs.toFixed(1)}ms &middot; ` +
                  `<b>Mesh:</b> ${benchmarkStats.meshMs.toFixed(1)}ms<br>`;
    }
    
    this.hud.innerHTML =
        `<b>FPS</b> ${fps} &nbsp; <b>Chunks</b> ${chunkCount} &nbsp; <b>Workers</b> ${workerCount}<br>` +
        benchHTML +
        `<b>Posisi</b> x:${cameraState.eye[0].toFixed(1)} y:${cameraState.eye[1].toFixed(1)} z:${cameraState.eye[2].toFixed(1)}<br>` +
        (lastRemovedInfo ? `<b style="color:#7fffb0">✓ Entity ${lastRemovedInfo.eid} dihapus, buffer di-destroy() lewat observer</b><br>` : '') +
        `WASD gerak &middot; Space/Ctrl naik-turun &middot; Shift lari &middot; mouse arah &middot; T = uji hapus 1 chunk &middot; klik canvas untuk pointer-lock`;
  }
}
