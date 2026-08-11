import { addEntity, removeEntity, addComponent } from "bitecs";
import { world, addGrowable, Renderable, RenderMesh } from "../core/ecs/components.js";
import { Transform, ColorComp, NodeMeta, NameComp, EditorContext, getSelection, getPrimarySelection, setSelection, clearSelection, toggleSelection } from "./state.js";
import History from "./history.js";
import { buildCubeMesh } from "./geometry.js";

const PALETTE = ['#7fd4ff', '#ffb27f', '#b6ff7f', '#ff7fd4', '#7fffcf', '#d4ff7f', '#ff9f7f', '#9f7fff'];
let paletteIdx = 0;
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
  return eid;
}

export function destroyNodeRaw(eid) {
  const idx = EditorContext.sceneOrder.indexOf(eid);
  if (idx >= 0) EditorContext.sceneOrder.splice(idx, 1);
  removeEntity(world, eid);
}

export function selectNode(eid, shiftKey = false) {
  if (shiftKey && eid >= 0) {
    toggleSelection(eid);
  } else {
    if (eid < 0) clearSelection();
    else setSelection([eid]);
  }

  const primaryEid = getPrimarySelection();
  const btnDelete = document.getElementById('btn-delete');
  const btnDuplicate = document.getElementById('btn-duplicate');
  const statSelected = document.getElementById('stat-selected');
  
  if (btnDelete) btnDelete.disabled = primaryEid < 0;
  if (btnDuplicate) btnDuplicate.disabled = primaryEid < 0 || !!NodeMeta.isGroup[primaryEid];
  if (statSelected) statSelected.textContent = primaryEid < 0 ? '—' : NameComp.value[primaryEid];
  
  EditorContext.refreshOutlinerSelection();
  EditorContext.refreshProperties();
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
      EditorContext.refreshOutliner();
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      EditorContext.refreshOutliner();
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
      EditorContext.refreshOutliner();
    },
    undo() {
      destroyNodeRaw(data.eid);
      selectNode(-1);
      EditorContext.refreshOutliner();
    },
  });
}

export function deleteSelected() {
  const targets = getSelection();
  if (targets.length === 0) return;

  const snapshots = Array.from(targets).map((eid) => ({
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
      for (const s of snapshots) destroyNodeRaw(s.eid);
      clearSelection();
      EditorContext.refreshOutliner();
    },
    undo() {
      for (const s of snapshots) createNodeRaw(s); 
      setSelection(snapshots.map((s) => s.eid));
      EditorContext.refreshOutliner();
    },
  });
}

export function duplicateSelected() {
  const targets = getSelection();
  const validTargets = Array.from(targets).filter(eid => !NodeMeta.isGroup[eid]); // Only non-groups for now
  if (validTargets.length === 0) return;

  const newDatas = validTargets.map(eid => {
    const src = readTransform(eid);
    const t = { ...src, ox: src.ox + 1, oz: src.oz + 1, px: src.px + 1, pz: src.pz + 1 };
    return {
      name: NameComp.value[eid] + ' copy',
      parent: NodeMeta.parent[eid],
      isGroup: false,
      transform: t,
    };
  });

  History.push({
    label: validTargets.length > 1 ? `Duplicate ${validTargets.length} Elements` : 'Duplicate',
    redo() {
      const createdEids = newDatas.map(data => createNodeRaw(data));
      setSelection(createdEids);
      EditorContext.refreshOutliner();
    },
    undo() {
      for (const data of newDatas) destroyNodeRaw(data.eid);
      setSelection(validTargets);
      EditorContext.refreshOutliner();
    },
  });
}

export function renameNode(eid, newName) {
  const oldName = NameComp.value[eid];
  if (newName === oldName || !newName.trim()) {
    EditorContext.refreshOutliner();
    return;
  }
  History.push({
    label: 'Rename',
    redo() {
      NameComp.value[eid] = newName;
      EditorContext.refreshOutliner();
    },
    undo() {
      NameComp.value[eid] = oldName;
      EditorContext.refreshOutliner();
    },
  });
}

export function commitTransform(eid, oldT, newT) {
  History.push({
    label: 'Edit Transform',
    redo() {
      writeTransform(eid, newT);
      rebuildMesh(eid);
      EditorContext.refreshProperties();
    },
    undo() {
      writeTransform(eid, oldT);
      rebuildMesh(eid);
      EditorContext.refreshProperties();
    },
  });
}
