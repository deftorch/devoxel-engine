import { ColorComp, NodeMeta, NameComp, EditorContext, getSelection, setSelection } from "../state.js";
import { renameNode, selectNode, rgb01ToHex, reparentNodes, syncSelectionUI, duplicateSelected, deleteSelected, addGroup } from "../scene-ops.js";
import { createPrefabFromSelection } from "./prefabs.js";

const collapsedGroups = new Set();
let lastSelectedEid = -1;

function isHidden(eid) {
  let p = NodeMeta.parent[eid];
  while (p >= 0) {
    if (collapsedGroups.has(p)) return true;
    p = NodeMeta.parent[p];
  }
  return false;
}

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
      if (isHidden(eid)) continue;

      const isSelected = Array.from(getSelection()).includes(eid);
      const row = document.createElement('div');
      row.className = 'node-row' + (isSelected ? ' selected' : '');
      row.style.paddingLeft = 10 + depthOf(eid) * 14 + 'px';
      row.dataset.eid = eid;
      const isGroup = !!NodeMeta.isGroup[eid];
      
      const arrow = collapsedGroups.has(eid) ? '▸' : '▾';
      row.innerHTML = isGroup
        ? `<span class="icon group-toggle">${arrow}</span><span class="name">${escapeHtml(NameComp.value[eid])}</span>`
        : `<span class="swatch" style="background:${rgb01ToHex(ColorComp.r[eid], ColorComp.g[eid], ColorComp.b[eid])}"></span><span class="name">${escapeHtml(NameComp.value[eid])}</span>`;
      
      row.addEventListener('click', (e) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? e.metaKey : e.ctrlKey;
        
        if (e.shiftKey && lastSelectedEid >= 0) {
          // Range selection
          const visibleEids = [];
          for (const ev of EditorContext.sceneOrder) {
            if (!isHidden(ev)) visibleEids.push(ev);
          }
          const idx1 = visibleEids.indexOf(lastSelectedEid);
          const idx2 = visibleEids.indexOf(eid);
          
          if (idx1 >= 0 && idx2 >= 0) {
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);
            const newSel = new Set(ctrlKey ? getSelection() : []);
            for (let i = start; i <= end; i++) newSel.add(visibleEids[i]);
            setSelection(Array.from(newSel));
            syncSelectionUI();
          } else {
            selectNode(eid, ctrlKey);
            lastSelectedEid = eid;
          }
        } else {
          selectNode(eid, ctrlKey);
          lastSelectedEid = eid;
        }
      });
      
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        
        if (!Array.from(getSelection()).includes(eid)) {
          selectNode(eid, false);
          lastSelectedEid = eid;
        }

        const ctxMenu = document.getElementById('context-menu');
        ctxMenu.style.display = 'block';
        
        let x = e.clientX;
        let y = e.clientY;
        if (x + 150 > window.innerWidth) x -= 150;
        if (y + 120 > window.innerHeight) y -= 120;
        
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        ctxMenu.dataset.targetEid = eid;
      });
      
      const toggleEl = row.querySelector('.group-toggle');
      if (toggleEl) {
        toggleEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (collapsedGroups.has(eid)) collapsedGroups.delete(eid);
          else collapsedGroups.add(eid);
          refreshOutliner();
        });
      }

      // Drag and drop
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', eid);
        e.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '0.5';
      });
      row.addEventListener('dragend', () => {
        row.style.opacity = '1';
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.style.borderBottom = '1px solid #7fd4ff';
        row.style.paddingBottom = '1px';
      });
      row.addEventListener('dragleave', () => {
        row.style.borderBottom = 'none';
        row.style.paddingBottom = '2px';
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.style.borderBottom = 'none';
        row.style.paddingBottom = '2px';
        const draggedEid = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (isNaN(draggedEid) || draggedEid === eid) return;
        
        // Anti-cyclic logic inside UI before calling reparentNodes
        const newParent = isGroup ? eid : NodeMeta.parent[eid];
        let p = newParent;
        let isCyclic = false;
        while (p >= 0) {
          if (p === draggedEid) { isCyclic = true; break; }
          p = NodeMeta.parent[p];
        }
        
        if (!isCyclic && NodeMeta.parent[draggedEid] !== newParent) {
          reparentNodes([draggedEid], newParent);
        }
      });

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

// Global context menu hide listener
window.addEventListener('click', (e) => {
  const ctxMenu = document.getElementById('context-menu');
  if (ctxMenu && ctxMenu.style.display === 'block') {
    ctxMenu.style.display = 'none';
  }
});

// Init context menu actions once
export function initContextMenu() {
  const ctxMenu = document.getElementById('context-menu');
  if (!ctxMenu) return;

  document.getElementById('ctx-create-prefab').addEventListener('click', () => {
    const eid = parseInt(ctxMenu.dataset.targetEid, 10);
    if (!isNaN(eid)) createPrefabFromSelection(eid);
  });

  document.getElementById('ctx-group').addEventListener('click', () => {
    addGroup(); // operates on current selection
  });

  document.getElementById('ctx-duplicate').addEventListener('click', () => {
    duplicateSelected();
  });

  document.getElementById('ctx-delete').addEventListener('click', () => {
    deleteSelected();
  });
}

EditorContext.on('sceneMutated', refreshOutliner);
EditorContext.on('selectionChanged', refreshOutlinerSelection);
