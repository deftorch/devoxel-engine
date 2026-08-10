import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock DOM
global.document = {
  getElementById: (id) => ({ disabled: false }),
};

import { addCube, addGroup, deleteSelected, duplicateSelected, renameNode, readTransform } from '../editor/scene-ops.js';
import { EditorContext, NodeMeta, NameComp } from '../editor/state.js';
import History from '../editor/history.js';

describe('Editor Scene Ops', () => {
  beforeEach(() => {
    // Reset global state for tests
    EditorContext.sceneOrder = [];
    EditorContext.selectedEid = -1;
    History.undoStack.length = 0;
    History.redoStack.length = 0;
    EditorContext.refreshOutliner = () => {};
    EditorContext.refreshOutlinerSelection = () => {};
    EditorContext.refreshProperties = () => {};
    EditorContext.engineRef = {
      rendererPlugin: { ready: false, createMesh: () => ({ destroy: () => {} }) }
    };
  });

  test('addCube adds a cube to sceneOrder and selects it', () => {
    addCube();
    assert.equal(EditorContext.sceneOrder.length, 1);
    assert.ok(EditorContext.selectedEid >= 0);
    assert.equal(NodeMeta.isGroup[EditorContext.selectedEid], 0);
  });

  test('addGroup adds a group to sceneOrder', () => {
    addGroup();
    assert.equal(EditorContext.sceneOrder.length, 1);
    assert.equal(NodeMeta.isGroup[EditorContext.selectedEid], 1);
  });

  test('deleteSelected removes the selected entity from sceneOrder', () => {
    addCube();
    assert.equal(EditorContext.sceneOrder.length, 1);
    
    deleteSelected();
    assert.equal(EditorContext.sceneOrder.length, 0);
    assert.equal(EditorContext.selectedEid, -1);
  });

  test('deleteSelected and undo restores the entity to sceneOrder', () => {
    addCube();
    const oldName = NameComp.value[EditorContext.selectedEid];
    
    deleteSelected();
    assert.equal(EditorContext.sceneOrder.length, 0);
    
    History.undo(); // Undo delete
    assert.equal(EditorContext.sceneOrder.length, 1);
    assert.equal(NameComp.value[EditorContext.selectedEid], oldName);
  });

  test('duplicateSelected copies a cube', () => {
    addCube();
    const originalEid = EditorContext.selectedEid;
    
    duplicateSelected();
    assert.equal(EditorContext.sceneOrder.length, 2);
    assert.notEqual(EditorContext.selectedEid, originalEid);
    assert.ok(NameComp.value[EditorContext.selectedEid].includes('copy'));
  });

  test('renameNode modifies the name and supports undo', () => {
    addCube();
    const eid = EditorContext.selectedEid;
    const oldName = NameComp.value[eid];
    
    renameNode(eid, 'Test Node');
    assert.equal(NameComp.value[eid], 'Test Node');
    
    History.undo();
    assert.equal(NameComp.value[eid], oldName);
  });
});
