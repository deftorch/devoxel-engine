import { EditorContext, NodeMeta, NameComp } from "../state.js";
import { readTransform, createNodeRaw, selectNode, getAllDescendants } from "../scene-ops.js";
import History from "../history.js";

const PREFABS_STORAGE_KEY = 'devoxel_prefabs_v1';

export function getPrefabs() {
  try {
    const raw = localStorage.getItem(PREFABS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error("Gagal membaca prefabs dari localStorage", e);
  }
  return [];
}

export function savePrefabs(list) {
  localStorage.setItem(PREFABS_STORAGE_KEY, JSON.stringify(list));
  renderAssetBrowser();
}

function serializeSubtree(rootEid) {
  const descendants = getAllDescendants([rootEid]);
  const elements = descendants.map((eid) => {
    // We store the original parent ID, but if it's the root, we set it to -1
    // so when spawning, it becomes a top-level node (or child of currently selected if we want)
    const originalParent = NodeMeta.parent[eid];
    const isRoot = eid === rootEid;
    const parentId = isRoot ? -1 : originalParent;

    const base = { id: eid, name: NameComp.value[eid], parent: parentId, isGroup: !!NodeMeta.isGroup[eid] };
    if (!base.isGroup) {
      const t = readTransform(eid);
      base.origin = [t.ox, t.oy, t.oz];
      base.size = [t.sx, t.sy, t.sz];
      base.pivot = [t.px, t.py, t.pz];
      base.rotation = [t.rx, t.ry, t.rz];
      base.color = [t.r, t.g, t.b];
    }
    return base;
  });
  return elements;
}

export function createPrefabFromSelection(eid) {
  const prefabs = getPrefabs();
  const name = prompt("Beri nama Prefab baru:", NameComp.value[eid] + " Prefab");
  if (!name) return;

  const data = serializeSubtree(eid);
  prefabs.push({ name, data, timestamp: Date.now() });
  savePrefabs(prefabs);
}

export function spawnPrefab(prefab) {
  const createdIds = [];
  
  // Undo/Redo logic
  History.push({
    label: `Spawn Prefab: ${prefab.name}`,
    redo() {
      const idRemap = new Map();
      createdIds.length = 0;
      
      for (const el of prefab.data) {
        const nd = createNodeRaw({
          name: el.name,
          isGroup: el.isGroup,
          parent: idRemap.has(el.parent) ? idRemap.get(el.parent) : -1,
          transform: el.isGroup
            ? null
            : {
                ox: el.origin[0], oy: el.origin[1], oz: el.origin[2],
                sx: el.size[0], sy: el.size[1], sz: el.size[2],
                px: el.pivot[0], py: el.pivot[1], pz: el.pivot[2],
                rx: el.rotation[0], ry: el.rotation[1], rz: el.rotation[2],
                r: el.color[0], g: el.color[1], b: el.color[2],
              },
        });
        idRemap.set(el.id, nd);
        createdIds.push(nd);
      }
      if (createdIds.length > 0) selectNode(createdIds[0]);
      EditorContext.emit('sceneMutated');
    },
    undo() {
      // Import circular dependencies safely
      import("../scene-ops.js").then(({ destroyNodeRaw }) => {
          for (const eid of createdIds) destroyNodeRaw(eid);
          selectNode(-1);
          EditorContext.emit('sceneMutated');
      });
    }
  });
}

export function renderAssetBrowser() {
  const container = document.getElementById('prefab-list');
  if (!container) return;

  const prefabs = getPrefabs();
  container.innerHTML = '';

  if (prefabs.length === 0) {
    container.innerHTML = '<div style="color: #7f93ad; font-size: 12px; font-style: italic;">Belum ada prefab. Klik kanan objek di Outliner lalu pilih "Save as Prefab".</div>';
    return;
  }

  prefabs.forEach((pf, idx) => {
    const card = document.createElement('div');
    card.className = 'prefab-card';
    card.title = `Spawn ${pf.name}`;
    
    // Icon based on content
    const isGroup = pf.data[0] && pf.data[0].isGroup;
    const iconText = isGroup ? '[G]' : '[C]';

    card.innerHTML = `
      <div class="icon" style="font-size: 16px; font-weight: bold; margin-bottom: 4px;">${iconText}</div>
      <div class="name">${pf.name}</div>
      <button class="del-btn" title="Hapus Prefab">✕</button>
    `;

    card.addEventListener('click', (e) => {
      // Ignore click if clicking delete button
      if (e.target.classList.contains('del-btn')) return;
      spawnPrefab(pf);
    });

    const delBtn = card.querySelector('.del-btn');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Hapus prefab "${pf.name}" secara permanen dari browser?`)) {
        const list = getPrefabs();
        list.splice(idx, 1);
        savePrefabs(list);
      }
    });

    container.appendChild(card);
  });
}
