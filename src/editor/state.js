import { observe, onRemove, query, addComponent, removeComponent, hasComponent } from "bitecs";
import { world, growableComponent, Selected } from "../core/ecs/components.js";

// origin = sudut "from" kubus, size = lebar/tinggi/dalam, pivot = titik
// rotasi (biasanya tengah kubus), rotation = euler derajat.
export const Transform = growableComponent(
  {
    ox: Float32Array,
    oy: Float32Array,
    oz: Float32Array,
    sx: Float32Array,
    sy: Float32Array,
    sz: Float32Array,
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    rx: Float32Array,
    ry: Float32Array,
    rz: Float32Array,
  },
  32
);

export const ColorComp = growableComponent({ r: Float32Array, g: Float32Array, b: Float32Array }, 32);

// parent = -1 berarti root. isGroup: node organisasi tanpa geometri sendiri
export const NodeMeta = growableComponent({ parent: Int32Array, isGroup: Uint8Array }, 32);

export const NameComp = { value: [] };
observe(world, onRemove(NameComp), (eid) => {
  NameComp.value[eid] = null;
});

// Single Editor Context
export const EditorContext = {
  engineRef: null,
  sceneOrder: [],
  camera: { target: [0, 3, 0], yaw: 0.9, pitch: -0.5, distance: 26 },
  refreshOutliner: () => {},
  refreshProperties: () => {},
  refreshOutlinerSelection: () => {},
};

export const getSelection = () => query(world, [Selected]);

export const getPrimarySelection = () => {
  const sel = getSelection();
  return sel.length > 0 ? sel[0] : -1;
};

export const clearSelection = () => {
  for (const eid of getSelection()) removeComponent(world, eid, Selected);
};

export const setSelection = (eids) => {
  clearSelection();
  for (const eid of eids) addComponent(world, eid, Selected);
};

export const toggleSelection = (eid) => {
  if (hasComponent(world, eid, Selected)) removeComponent(world, eid, Selected);
  else addComponent(world, eid, Selected);
};

Object.defineProperty(EditorContext, 'selectedEid', {
  get: function() { return getPrimarySelection(); },
  set: function(val) {
    if (val === -1) clearSelection();
    else setSelection([val]);
  }
});
