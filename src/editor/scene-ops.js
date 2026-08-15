import { addEntity, removeEntity, addComponent } from "bitecs";
import { world, addGrowable, Renderable, RenderMesh } from "../core/ecs/components.js";
import { Transform, ColorComp, NodeMeta, NameComp, EditorContext, getSelection, getPrimarySelection, setSelection, clearSelection, toggleSelection } from "./state.js";
import History from "./history.js";
import { buildCubeMesh } from "./geometry.js";

const PALETTE = ['#7fd4ff', '#ffb27f', '#b6ff7f', '#ff7fd4', '#7fffcf', '#d4ff7f', '#ff9f7f', '#9f7fff'];
let paletteIdx = 0;

export function getVirtualPivot() {
  const selection = getAllDescendants(Array.from(getSelection()));
  if (selection.length === 0) return null;
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const eid of selection) {
    if (NodeMeta.isGroup[eid]) continue;
    cx += Transform.px[eid];
    cy += Transform.py[eid];
    cz += Transform.pz[eid];
    count++;
  }
  if (count === 0) return null;
  return [cx / count, cy / count, cz / count];
}
export function hexToRgb01(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
export function rgb01ToHex(r, g, b) {
  const c = (x) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

let nextName = { cube: 1, group: 1 };

export function uploadMesh(eid, mesh) {
  RenderMesh.meshes[eid]?.destroy();
  const created = EditorContext.engineRef.rendererPlugin.createMesh(mesh.vertexData, mesh.indexData);
  RenderMesh.meshes[eid] = created;
  Renderable.indexCount[eid] = mesh.indexCount;
}

export function rebuildMesh(eid) {
  if (NodeMeta.isGroup[eid]) return; // group tidak punya geometri
  const t = readTransform(eid);
  uploadMesh(eid, buildCubeMesh(t));
}

export function readTransform(eid) {
  return {
    ox: Transform.ox[eid],
    oy: Transform.oy[eid],
    oz: Transform.oz[eid],
    sx: Transform.sx[eid],
    sy: Transform.sy[eid],
    sz: Transform.sz[eid],
    px: Transform.px[eid],
    py: Transform.py[eid],
    pz: Transform.pz[eid],
    rx: Transform.rx[eid],
    ry: Transform.ry[eid],
    rz: Transform.rz[eid],
    r: ColorComp.r[eid],
    g: ColorComp.g[eid],
    b: ColorComp.b[eid],
  };
}

export function writeTransform(eid, t) {
  Transform.ox[eid] = t.ox;
  Transform.oy[eid] = t.oy;
  Transform.oz[eid] = t.oz;
  Transform.sx[eid] = t.sx;
  Transform.sy[eid] = t.sy;
  Transform.sz[eid] = t.sz;
  Transform.px[eid] = t.px;
  Transform.py[eid] = t.py;
  Transform.pz[eid] = t.pz;
  Transform.rx[eid] = t.rx;
  Transform.ry[eid] = t.ry;
  Transform.rz[eid] = t.rz;
  ColorComp.r[eid] = t.r;
  ColorComp.g[eid] = t.g;
  ColorComp.b[eid] = t.b;
}

export function createNodeRaw(data) {
  // data: {eid?, name, parent, isGroup, transform?, color?, orderIndex?}
  const eid = addEntity(world);
  addGrowable(world, eid, NodeMeta);
  addComponent(world, eid, NameComp);
  NodeMeta.parent[eid] = data.parent;
  NodeMeta.isGroup[eid] = data.isGroup ? 1 : 0;
  NameComp.value[eid] = data.name;
  if (!data.isGroup) {
    addGrowable(world, eid, Transform);
    addGrowable(world, eid, ColorComp);
    addGrowable(world, eid, Renderable);
    addComponent(world, eid, RenderMesh);
    writeTransform(eid, data.transform);
    if (EditorContext.engineRef && EditorContext.engineRef.rendererPlugin && EditorContext.engineRef.rendererPlugin.ready) rebuildMesh(eid);
  }
  const idx = data.orderIndex != null ? data.orderIndex : EditorContext.sceneOrder.length;
  EditorContext.sceneOrder.splice(idx, 0, eid);
  data.eid = eid;
  // Auto-sort to group children together
  rebuildSceneOrder();
  return eid;
}

export function destroyNodeRaw(eid) {
  const idx = EditorContext.sceneOrder.indexOf(eid);
  if (idx >= 0) EditorContext.sceneOrder.splice(idx, 1);
  removeEntity(world, eid);
}

export function rebuildSceneOrder() {
  const newOrder = [];
  const map = new Map();
  // Build parent -> children mapping based on current sceneOrder
  for (const eid of EditorContext.sceneOrder) {
    const parent = NodeMeta.parent[eid];
    if (!map.has(parent)) map.set(parent, []);
    map.get(parent).push(eid);
  }
  
  // Traverse recursively preserving original sibling order
  const traverse = (parent) => {
    if (map.has(parent)) {
      for (const child of map.get(parent)) {
        newOrder.push(child);
        traverse(child);
      }
    }
  }
  traverse(-1);
  EditorContext.sceneOrder = newOrder;
}

export function reparentNodes(eids, newParent) {
  const oldParents = eids.map(eid => ({ eid, parent: NodeMeta.parent[eid] }));
  History.push({
    label: `Reparent ${eids.length} Elements`,
    redo() {
      for (const eid of eids) NodeMeta.parent[eid] = newParent;
      rebuildSceneOrder();
      EditorContext.emit('sceneMutated');
    },
    undo() {
      for (const { eid, parent } of oldParents) NodeMeta.parent[eid] = parent;
      rebuildSceneOrder();
      EditorContext.emit('sceneMutated');
    }
  });
}

/**
 * Syncs every UI element that depends on the current selection:
 * Delete/Duplicate button enabled-state, the "Terpilih" status-bar text,
 * and the Outliner/Properties panels. Call this after ANY code path that
 * mutates selection directly (setSelection/toggleSelection/clearSelection)
 * — do not call setSelection() and reimplement a subset of this inline,
 * that's exactly how frustumSelect() ended up missing the button/status
 * updates in an earlier pass.
 */
export function syncSelectionUI() {
  const primaryEid = getPrimarySelection();
  const btnDelete = document.getElementById('btn-delete');
  const btnDuplicate = document.getElementById('btn-duplicate');
  const statSelected = document.getElementById('stat-selected');

  if (btnDelete) btnDelete.disabled = primaryEid < 0;
  if (btnDuplicate) btnDuplicate.disabled = primaryEid < 0 || !!NodeMeta.isGroup[primaryEid];
  if (statSelected) {
    const sel = getSelection();
    statSelected.textContent = sel.length === 0 ? '—' : sel.length === 1 ? NameComp.value[primaryEid] : `${sel.length} elemen`;
  }

  EditorContext.emit('selectionChanged');
}

export function selectNode(eid, shiftKey = false) {
  if (shiftKey && eid >= 0) {
    toggleSelection(eid);
  } else {
    if (eid < 0) clearSelection();
    else setSelection([eid]);
  }

  syncSelectionUI();
}

export function addCube() {
  const primaryEid = getPrimarySelection();
  const parent = primaryEid >= 0 && NodeMeta.isGroup[primaryEid] ? primaryEid : -1;
  const [r, g, b] = hexToRgb01(PALETTE[paletteIdx++ % PALETTE.length]);
  const data = {
    name: `Cube ${nextName.cube++}`,
    parent,
    isGroup: false,
    transform: { ox: -4, oy: 0, oz: -4, sx: 8, sy: 8, sz: 8, px: 0, py: 4, pz: 0, rx: 0, ry: 0, rz: 0, r, g, b },
  };
  History.push({
    label: 'Add Cube',
    redo() {
      createNodeRaw(data);
      selectNode(data.eid);
      EditorContext.emit('sceneMutated');
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      EditorContext.emit('sceneMutated');
    },
  });
}

export function addGroup() {
  const primaryEid = getPrimarySelection();
  const parent = primaryEid >= 0 && NodeMeta.isGroup[primaryEid] ? primaryEid : -1;
  const data = { name: `Group ${nextName.group++}`, parent, isGroup: true };
  History.push({
    label: 'Add Group',
    redo() {
      createNodeRaw(data);
      selectNode(data.eid);
      EditorContext.emit('sceneMutated');
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      EditorContext.emit('sceneMutated');
    },
  });
}

export function getMirroredEids(eids) {
  const mirror = EditorContext.mirror;
  if (!mirror.x && !mirror.y && !mirror.z) return eids;

  const results = new Set(eids);
  const pivot = mirror.pivotOffset;

  for (const eid of eids) {
    if (NodeMeta.isGroup[eid]) continue;
    const src = readTransform(eid);

    let transforms = [src];
    
    const applyMirror = (axis, sizeKey, posKey, rotKeys, rotSigns) => {
      const newTransforms = [];
      for (const t of transforms) {
        const mirrored = { ...t };
        const pPlane = pivot[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
        mirrored[posKey] = pPlane * 2 - t[posKey] - t[sizeKey];
        const pivotKey = 'p' + axis;
        mirrored[pivotKey] = pPlane * 2 - t[pivotKey];

        mirrored.rx *= rotSigns[0];
        mirrored.ry *= rotSigns[1];
        mirrored.rz *= rotSigns[2];

        newTransforms.push(mirrored);
      }
      transforms = transforms.concat(newTransforms);
    };

    if (mirror.x) applyMirror('x', 'sx', 'ox', ['rx', 'ry', 'rz'], [1, -1, -1]);
    if (mirror.y) applyMirror('y', 'sy', 'oy', ['rx', 'ry', 'rz'], [-1, 1, -1]);
    if (mirror.z) applyMirror('z', 'sz', 'oz', ['rx', 'ry', 'rz'], [-1, -1, 1]);

    for (let i = 1; i < transforms.length; i++) {
      const targetT = transforms[i];
      for (const otherEid of EditorContext.sceneOrder) {
        if (results.has(otherEid) || NodeMeta.isGroup[otherEid]) continue;
        const t = readTransform(otherEid);
        
        // Match position and size to find counterpart
        if (Math.abs(t.px - targetT.px) < 0.01 &&
            Math.abs(t.py - targetT.py) < 0.01 &&
            Math.abs(t.pz - targetT.pz) < 0.01 &&
            Math.abs(t.sx - targetT.sx) < 0.01 &&
            Math.abs(t.sy - targetT.sy) < 0.01 &&
            Math.abs(t.sz - targetT.sz) < 0.01) {
              results.add(otherEid);
        }
      }
    }
  }

  return Array.from(results);
}

export function getAllDescendants(eids) {
  const result = new Set();
  const queue = [...eids];
  
  while (queue.length > 0) {
    const eid = queue.shift();
    if (!result.has(eid)) {
      result.add(eid);
      for (const childEid of EditorContext.sceneOrder) {
        if (NodeMeta.parent[childEid] === eid) {
          queue.push(childEid);
        }
      }
    }
  }
  return Array.from(result);
}

export function getMirrorCounterpartsMap(eids) {
  const mirror = EditorContext.mirror;
  if (!mirror.x && !mirror.y && !mirror.z) return [];
  
  const pivot = mirror.pivotOffset;
  const mappings = [];
  
  for (const eid of eids) {
    if (NodeMeta.isGroup[eid]) continue;
    const src = readTransform(eid);
    
    let transforms = [src];
    const applyMirror = (axis, sizeKey, posKey, rotKeys, rotSigns) => {
      const newTransforms = [];
      for (const t of transforms) {
        const mirrored = { ...t };
        const pPlane = pivot[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
        mirrored[posKey] = pPlane * 2 - t[posKey] - t[sizeKey];
        const pivotKey = 'p' + axis;
        mirrored[pivotKey] = pPlane * 2 - t[pivotKey];

        mirrored.rx *= rotSigns[0];
        mirrored.ry *= rotSigns[1];
        mirrored.rz *= rotSigns[2];
        newTransforms.push(mirrored);
      }
      transforms = transforms.concat(newTransforms);
    };

    if (mirror.x) applyMirror('x', 'sx', 'ox', ['rx', 'ry', 'rz'], [1, -1, -1]);
    if (mirror.y) applyMirror('y', 'sy', 'oy', ['rx', 'ry', 'rz'], [-1, 1, -1]);
    if (mirror.z) applyMirror('z', 'sz', 'oz', ['rx', 'ry', 'rz'], [-1, -1, 1]);

    for (let i = 1; i < transforms.length; i++) {
      const targetT = transforms[i];
      for (const otherEid of EditorContext.sceneOrder) {
        if (NodeMeta.isGroup[otherEid] || eids.includes(otherEid)) continue;
        const t = readTransform(otherEid);
        if (Math.abs(t.px - targetT.px) < 0.01 &&
            Math.abs(t.py - targetT.py) < 0.01 &&
            Math.abs(t.pz - targetT.pz) < 0.01 &&
            Math.abs(t.sx - targetT.sx) < 0.01 &&
            Math.abs(t.sy - targetT.sy) < 0.01 &&
            Math.abs(t.sz - targetT.sz) < 0.01) {
              mappings.push({ sourceEid: eid, counterpartEid: otherEid, transformIndex: i });
              break;
        }
      }
    }
  }
  return mappings;
}

export function deleteSelected() {
  let targets = Array.from(getSelection());
  if (targets.length === 0) return;

  // Hapus semua keturunan agar tidak ada anak yatim
  targets = getAllDescendants(targets);

  // Jika mirror aktif, temukan semua kembarannya
  const mirror = EditorContext.mirror;
  if (mirror.x || mirror.y || mirror.z) {
    targets = getMirroredEids(targets);
  }

  // Sort targets so parents come before children for safe reconstruction
  targets.sort((a, b) => EditorContext.sceneOrder.indexOf(a) - EditorContext.sceneOrder.indexOf(b));

  const snapshots = targets.map((eid) => ({
    eid,
    name: NameComp.value[eid],
    parent: NodeMeta.parent[eid],
    isGroup: !!NodeMeta.isGroup[eid],
    transform: NodeMeta.isGroup[eid] ? null : readTransform(eid),
    orderIndex: EditorContext.sceneOrder.indexOf(eid),
  }));

  History.push({
    label: targets.length > 1 ? `Delete ${targets.length} Elements` : 'Delete Element',
    redo() {
      // Hapus dari belakang agar tidak menggeser orderIndex yang belum diproses
      for (let i = snapshots.length - 1; i >= 0; i--) {
        destroyNodeRaw(snapshots[i].eid);
      }
      clearSelection();
      syncSelectionUI();
      EditorContext.emit('sceneMutated');
    },
    undo() {
      const eidMap = new Map();
      for (const s of snapshots) {
        const oldEid = s.eid;
        if (s.parent >= 0 && eidMap.has(s.parent)) {
          s.parent = eidMap.get(s.parent);
        }
        createNodeRaw(s); // mutates s.eid
        eidMap.set(oldEid, s.eid);
      }
      setSelection(snapshots.map((s) => s.eid));
      syncSelectionUI();
      EditorContext.emit('sceneMutated');
    },
  });
}

export function duplicateSelected() {
  let targets = Array.from(getSelection());
  if (targets.length === 0) return;

  targets = getAllDescendants(targets);
  targets.sort((a, b) => EditorContext.sceneOrder.indexOf(a) - EditorContext.sceneOrder.indexOf(b));

  const newDatas = targets.map(eid => {
    const isGroup = !!NodeMeta.isGroup[eid];
    let t = null;
    if (!isGroup) {
      const src = readTransform(eid);
      // Offset sedikit agar terlihat berbeda
      t = { ...src, ox: src.ox + 1, oz: src.oz + 1, px: src.px + 1, pz: src.pz + 1 };
    }
    return {
      originalEid: eid,
      name: NameComp.value[eid] + ' copy',
      parent: NodeMeta.parent[eid],
      isGroup,
      transform: t,
      eid: -1
    };
  });

  History.push({
    label: targets.length > 1 ? `Duplicate ${targets.length} Elements` : 'Duplicate',
    redo() {
      const eidMap = new Map();
      const createdEids = [];
      for (const data of newDatas) {
        if (data.parent >= 0 && eidMap.has(data.parent)) {
          data.parent = eidMap.get(data.parent);
        }
        createNodeRaw(data);
        eidMap.set(data.originalEid, data.eid);
        createdEids.push(data.eid);
      }
      setSelection(createdEids);
      syncSelectionUI();
      EditorContext.emit('sceneMutated');
    },
    undo() {
      for (let i = newDatas.length - 1; i >= 0; i--) {
        if (newDatas[i].eid >= 0) destroyNodeRaw(newDatas[i].eid);
      }
      setSelection(targets);
      syncSelectionUI();
      EditorContext.emit('sceneMutated');
    },
  });
}

export function symmetrizeSelected() {
  const targets = getSelection();
  const validTargets = Array.from(targets).filter(eid => !NodeMeta.isGroup[eid]);
  if (validTargets.length === 0) return;
  
  const mirror = EditorContext.mirror;
  if (!mirror.x && !mirror.y && !mirror.z) return; // No mirror active

  const newDatas = [];
  const pivot = mirror.pivotOffset;

  for (const eid of validTargets) {
    const src = readTransform(eid);
    const parent = NodeMeta.parent[eid];
    const baseName = NameComp.value[eid];
    
    let transforms = [src];
    
    const applyMirror = (axis, sizeKey, posKey, rotKeys, rotSigns) => {
      const newTransforms = [];
      for (const t of transforms) {
        const mirrored = { ...t };
        const pPlane = pivot[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
        mirrored[posKey] = pPlane * 2 - t[posKey] - t[sizeKey];
        const pivotKey = 'p' + axis;
        mirrored[pivotKey] = pPlane * 2 - t[pivotKey];

        mirrored.rx *= rotSigns[0];
        mirrored.ry *= rotSigns[1];
        mirrored.rz *= rotSigns[2];

        newTransforms.push(mirrored);
      }
      transforms = transforms.concat(newTransforms);
    };

    if (mirror.x) applyMirror('x', 'sx', 'ox', ['rx', 'ry', 'rz'], [1, -1, -1]);
    if (mirror.y) applyMirror('y', 'sy', 'oy', ['rx', 'ry', 'rz'], [-1, 1, -1]);
    if (mirror.z) applyMirror('z', 'sz', 'oz', ['rx', 'ry', 'rz'], [-1, -1, 1]);

    // Skip the first one since it's the original `src`
    for (let i = 1; i < transforms.length; i++) {
      newDatas.push({
        name: baseName + ' (Mirrored)',
        parent,
        isGroup: false,
        transform: transforms[i],
      });
    }
  }

  if (newDatas.length === 0) return;

  History.push({
    label: `Symmetrize ${validTargets.length} Elements`,
    redo() {
      const createdEids = newDatas.map(data => createNodeRaw(data));
      // Select the newly created mirrored objects along with the originals
      setSelection([...validTargets, ...createdEids]);
      syncSelectionUI();
      EditorContext.emit('sceneMutated');
    },
    undo() {
      for (const data of newDatas) destroyNodeRaw(data.eid);
      setSelection(validTargets);
      syncSelectionUI();
      EditorContext.emit('sceneMutated');
    },
  });
}

export function renameNode(eid, newName) {
  const oldName = NameComp.value[eid];
  if (newName === oldName || !newName.trim()) {
    EditorContext.emit('sceneMutated');
    return;
  }
  History.push({
    label: 'Rename',
    redo() {
      NameComp.value[eid] = newName;
      EditorContext.emit('sceneMutated');
    },
    undo() {
      NameComp.value[eid] = oldName;
      EditorContext.emit('sceneMutated');
    },
  });
}

export function commitTransform(eid, oldT, newT) {
  History.push({
    label: 'Edit Transform',
    redo() {
      writeTransform(eid, newT);
      rebuildMesh(eid);
      EditorContext.emit('transformChanged');
    },
    undo() {
      writeTransform(eid, oldT);
      rebuildMesh(eid);
      EditorContext.emit('transformChanged');
    },
  });
}
