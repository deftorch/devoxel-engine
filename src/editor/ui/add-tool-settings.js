import { EditorContext } from "../state.js";
import { AddToolState, getPalette, setPalette, resetAddToolSettingsToDefault } from "../tool-add.js";
import { saveAddToolSettings } from "../settings.js";

function persist() {
  saveAddToolSettings({ unitSize: AddToolState.baseUnitSize, palette: getPalette() });
}

function renderPaletteSwatches() {
  const list = document.getElementById('settings-palette-list');
  if (!list) return;
  list.innerHTML = '';
  const palette = getPalette();

  palette.forEach((color, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'palette-swatch-wrap';

    const input = document.createElement('input');
    input.type = 'color';
    input.value = color;
    input.title = color;
    input.addEventListener('input', () => {
      const next = [...getPalette()];
      next[idx] = input.value;
      setPalette(next);
    });
    wrap.appendChild(input);

    // Keep at least one color - an empty palette would make hexToRgb01
    // index into undefined and throw the next time a cube is placed.
    if (palette.length > 1) {
      const remove = document.createElement('div');
      remove.className = 'palette-swatch-remove';
      remove.textContent = '×';
      remove.title = 'Hapus warna ini';
      remove.addEventListener('click', () => {
        setPalette(getPalette().filter((_, i) => i !== idx));
        renderPaletteSwatches();
      });
      wrap.appendChild(remove);
    }

    list.appendChild(wrap);
  });
}

function syncUnitSizeInput() {
  const input = document.getElementById('settings-unit-size');
  if (input && document.activeElement !== input) input.value = AddToolState.baseUnitSize;
}

export function initAddToolSettingsPanel() {
  const modal = document.getElementById('add-tool-settings-modal');
  const openBtn = document.getElementById('btn-add-tool-settings');
  const closeBtn = document.getElementById('settings-close');
  const backdrop = document.getElementById('add-tool-settings-backdrop');
  const resetBtn = document.getElementById('settings-reset');
  const addColorBtn = document.getElementById('settings-palette-add');
  const unitInput = document.getElementById('settings-unit-size');

  function open() {
    syncUnitSizeInput();
    renderPaletteSwatches();
    modal.classList.remove('hidden');
  }
  function close() {
    modal.classList.add('hidden');
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  unitInput.addEventListener('change', () => {
    const v = Math.max(1, Math.min(16, Math.round(Number(unitInput.value)) || 1));
    AddToolState.baseUnitSize = v;
    unitInput.value = v;
    persist();
  });

  addColorBtn.addEventListener('click', () => {
    setPalette([...getPalette(), '#ffffff']);
    renderPaletteSwatches();
  });

  resetBtn.addEventListener('click', () => {
    resetAddToolSettingsToDefault();
    syncUnitSizeInput();
    renderPaletteSwatches();
  });

  // If the base unit size changes from elsewhere (Ctrl+Scroll while
  // drawing), keep the panel's number input in sync in case it's open.
  EditorContext.on('addToolSettingsChanged', syncUnitSizeInput);
}
