import { ColorComp, NodeMeta, NameComp, EditorContext } from "../state.js";
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
  if (EditorContext.selectedEid < 0) {
    propertiesBody.innerHTML = `<div id="properties-empty">Tidak ada elemen terpilih.<br>Tambahkan cube dari toolbar.</div>`;
    return;
  }
  const eid = EditorContext.selectedEid;
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
  }
  let colorStartT = null;
  document.getElementById('p-color').addEventListener('mousedown', () => {
    colorStartT = readTransform(eid);
  });
  document.getElementById('p-color').addEventListener('input', () => {
    if (!colorStartT) colorStartT = readTransform(eid);
    const t = readTransform(eid);
    const [r, g, b] = hexToRgb01(document.getElementById('p-color').value);
    t.r = r; t.g = g; t.b = b;
    writeTransform(eid, t);
    rebuildMesh(eid);
  });
  document.getElementById('p-color').addEventListener('change', () => {
    const newT = readTransform(eid);
    if (colorStartT) commitTransform(eid, colorStartT, newT);
    colorStartT = null;
  });
}
