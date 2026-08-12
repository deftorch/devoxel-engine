import { ColorComp, NodeMeta, NameComp, EditorContext, getSelection } from "../state.js";
import { renameNode, selectNode, rgb01ToHex } from "../scene-ops.js";

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function depthOf(eid) {
  let d = 0,
    p = NodeMeta.parent[eid];
  while (p >= 0) {
    d++;
    p = NodeMeta.parent[p];
  }
  return d;
}

export function refreshOutliner() {
  const outlinerList = document.getElementById('outliner-list');
  const statCount = document.getElementById('stat-count');
  
  outlinerList.innerHTML = '';
  if (EditorContext.sceneOrder.length === 0) {
    outlinerList.innerHTML = `<div id="outliner-empty">Kosong. Klik "＋ Cube" di toolbar untuk mulai.</div>`;
  } else {
    for (const eid of EditorContext.sceneOrder) {
      const isSelected = Array.from(getSelection()).includes(eid);
      const row = document.createElement('div');
      row.className = 'node-row' + (isSelected ? ' selected' : '');
      row.style.paddingLeft = 10 + depthOf(eid) * 14 + 'px';
      row.dataset.eid = eid;
      const isGroup = !!NodeMeta.isGroup[eid];
      row.innerHTML = isGroup
        ? `<span class="icon">▸</span><span class="name">${escapeHtml(NameComp.value[eid])}</span>`
        : `<span class="swatch" style="background:${rgb01ToHex(ColorComp.r[eid], ColorComp.g[eid], ColorComp.b[eid])}"></span><span class="name">${escapeHtml(NameComp.value[eid])}</span>`;
      row.addEventListener('click', () => selectNode(eid));
      const nameEl = row.querySelector('.name');
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        nameEl.contentEditable = 'true';
        nameEl.focus();
        document.execCommand('selectAll', false, null);
      });
      nameEl.addEventListener('blur', () => {
        nameEl.contentEditable = 'false';
        renameNode(eid, nameEl.textContent.trim());
      });
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          nameEl.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          nameEl.textContent = NameComp.value[eid];
          nameEl.blur();
        }
      });
      outlinerList.appendChild(row);
    }
  }
  if(statCount) statCount.textContent = EditorContext.sceneOrder.length;
}

export function refreshOutlinerSelection() {
  const outlinerList = document.getElementById('outliner-list');
  const selection = Array.from(getSelection());
  outlinerList.querySelectorAll('.node-row').forEach((row) => {
    row.classList.toggle('selected', selection.includes(Number(row.dataset.eid)));
  });
}

EditorContext.on('sceneMutated', refreshOutliner);
EditorContext.on('selectionChanged', refreshOutlinerSelection);
