import { EditorContext, NodeMeta, NameComp } from "./state.js";
import { readTransform, createNodeRaw, destroyNodeRaw, selectNode } from "./scene-ops.js";
import History from "./history.js";

export function exportScene() {
  const elements = EditorContext.sceneOrder.map((eid) => {
    const base = { id: eid, name: NameComp.value[eid], parent: NodeMeta.parent[eid], isGroup: !!NodeMeta.isGroup[eid] };
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
  const json = JSON.stringify({ version: 1, elements }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cube-model.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importScene(json) {
  const data = JSON.parse(json);
  // Bersihkan scene saat ini
  for (const eid of [...EditorContext.sceneOrder]) destroyNodeRaw(eid);
  EditorContext.sceneOrder = [];
  History.undoStack.length = 0;
  History.redoStack.length = 0;
  // trigger UI update for history?
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  if(btnUndo) btnUndo.disabled = true;
  if(btnRedo) btnRedo.disabled = true;
  
  const idRemap = new Map();
  for (const el of data.elements) {
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
  }
  selectNode(-1);
  EditorContext.emit('sceneMutated');
}
