import { ColorComp, NodeMeta, NameComp, EditorContext, getSelection } from "../state.js";
import { renameNode, readTransform, writeTransform, rebuildMesh, commitTransform, hexToRgb01, rgb01ToHex } from "../scene-ops.js";

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function numRow(labelChar, id) {
  return `<div class="prop-row"><span class="field-label">${labelChar}</span><input type="number" id="${id}" step="0.1"></div>`;
}

export function syncPropertyInputs(eid) {
  const t = readTransform(eid);
  const map = {
    ox: 'p-ox', oy: 'p-oy', oz: 'p-oz',
    sx: 'p-sx', sy: 'p-sy', sz: 'p-sz',
    px: 'p-px', py: 'p-py', pz: 'p-pz',
    rx: 'p-rx', ry: 'p-ry', rz: 'p-rz',
  };
  for (const [key, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.value = t[key].toFixed(2);
  }
}

export function refreshProperties() {
  const propertiesBody = document.getElementById('properties-body');
  const selection = getSelection();
  if (selection.length === 0) {
    propertiesBody.innerHTML = `<div id="properties-empty">Tidak ada elemen terpilih.<br>Tambahkan cube dari toolbar.</div>`;
    return;
  }
  if (selection.length > 1) {
    propertiesBody.innerHTML = `<div id="properties-empty">${selection.length} elemen terpilih.<br>Mode edit properti massal (Mixed) belum tersedia.</div>`;
    return;
  }
  const eid = selection[0];
  const isGroup = !!NodeMeta.isGroup[eid];
  let html = `
    <div class="prop-group">
      <label class="title">Nama</label>
      <input type="text" id="p-name" value="${escapeHtml(NameComp.value[eid])}">
    </div>`;
  if (!isGroup) {
    html += `
    <div class="prop-group">
      <label class="title">Origin (sudut "from")</label>
      ${numRow('X', 'p-ox')}${numRow('Y', 'p-oy')}${numRow('Z', 'p-oz')}
    </div>
    <div class="prop-group">
      <label class="title">Size</label>
      ${numRow('X', 'p-sx')}${numRow('Y', 'p-sy')}${numRow('Z', 'p-sz')}
    </div>
    <div class="prop-group">
      <label class="title">Pivot (pusat rotasi)</label>
      ${numRow('X', 'p-px')}${numRow('Y', 'p-py')}${numRow('Z', 'p-pz')}
    </div>
    <div class="prop-group">
      <label class="title">Rotation (derajat)</label>
      ${numRow('X', 'p-rx')}${numRow('Y', 'p-ry')}${numRow('Z', 'p-rz')}
    </div>
    <div class="prop-group">
      <label class="title">Warna</label>
      <input type="color" id="p-color" value="${rgb01ToHex(ColorComp.r[eid], ColorComp.g[eid], ColorComp.b[eid])}">
    </div>`;
  }
  propertiesBody.innerHTML = html;

  document.getElementById('p-name').addEventListener('change', (e) => renameNode(eid, e.target.value.trim() || NameComp.value[eid]));
  if (isGroup) return;

  const fieldMap = {
    ox: 'p-ox', oy: 'p-oy', oz: 'p-oz',
    sx: 'p-sx', sy: 'p-sy', sz: 'p-sz',
    px: 'p-px', py: 'p-py', pz: 'p-pz',
    rx: 'p-rx', ry: 'p-ry', rz: 'p-rz',
  };
  const current = readTransform(eid);
  for (const [key, id] of Object.entries(fieldMap)) document.getElementById(id).value = current[key].toFixed(2);

  let dragStartT = null;
  for (const [key, id] of Object.entries(fieldMap)) {
    const input = document.getElementById(id);
    const label = input.previousElementSibling;

    input.addEventListener('focus', () => {
      dragStartT = readTransform(eid);
    });
    input.addEventListener('input', () => {
      const t = readTransform(eid);
      t[key] = parseFloat(input.value) || 0;
      writeTransform(eid, t);
      rebuildMesh(eid);
    });
    input.addEventListener('change', () => {
      const newT = readTransform(eid);
      if (dragStartT) commitTransform(eid, dragStartT, newT);
      dragStartT = null;
    });

    // Figma-style drag scrub on the label
    if (label && label.classList.contains('field-label')) {
      label.style.cursor = 'ew-resize';
      label.title = "Geser kiri/kanan untuk mengubah nilai (Tahan Shift untuk presisi)";
      
      label.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.focus();
        
        const startX = e.clientX;
        const startVal = parseFloat(input.value) || 0;
        let hasMoved = false;

        const onMove = (moveEvent) => {
          hasMoved = true;
          const dx = moveEvent.clientX - startX;
          const multiplier = moveEvent.shiftKey ? 0.05 : 0.5;
          input.value = (startVal + dx * multiplier).toFixed(2);
          input.dispatchEvent(new Event('input'));
        };

        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          if (hasMoved) input.dispatchEvent(new Event('change'));
        };

        document.body.style.cursor = 'ew-resize';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  let colorStartT = null;
  const colorInput = document.getElementById('p-color');
  colorInput.addEventListener('mousedown', () => {
    colorStartT = readTransform(eid);
  });
  colorInput.addEventListener('input', () => {
    if (!colorStartT) colorStartT = readTransform(eid);
    const t = readTransform(eid);
    const [r, g, b] = hexToRgb01(colorInput.value);
    t.r = r; t.g = g; t.b = b;
    writeTransform(eid, t);
    rebuildMesh(eid);
  });
  colorInput.addEventListener('change', () => {
    const newT = readTransform(eid);
    if (colorStartT) commitTransform(eid, colorStartT, newT);
    colorStartT = null;
  });
}

EditorContext.on('selectionChanged', refreshProperties);
EditorContext.on('transformChanged', refreshProperties);
