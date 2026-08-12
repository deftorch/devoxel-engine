import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock DOM
global.document = {
  getElementById: (id) => ({ disabled: false }),
};

import { addCube, addGroup, deleteSelected, duplicateSelected, renameNode, readTransform } from '../editor/scene-ops.js';
import { EditorContext, NodeMeta, NameComp, getPrimarySelection, clearSelection } from '../editor/state.js';
import History from '../editor/history.js';

describe('Editor Scene Ops', () => {
  beforeEach(() => {
    // Reset global state for tests
    EditorContext.sceneOrder = [];
    clearSelection();
    History.undoStack.length = 0;
    History.redoStack.length = 0;
    EditorContext._listeners = {};
    EditorContext.engineRef = {
      rendererPlugin: { ready: false, createMesh: () => ({ destroy: () => {} }) }
    };
  });

  test('addCube adds a cube to sceneOrder and selects it', () => {
    addCube();
    assert.equal(EditorContext.sceneOrder.length, 1);
    assert.ok(getPrimarySelection() >= 0);
    assert.equal(NodeMeta.isGroup[getPrimarySelection()], 0);
  });

  test('addGroup adds a group to sceneOrder', () => {
    addGroup();
    assert.equal(EditorContext.sceneOrder.length, 1);
    assert.equal(NodeMeta.isGroup[getPrimarySelection()], 1);
  });

  test('deleteSelected removes the selected entity from sceneOrder', () => {
    addCube();
    assert.equal(EditorContext.sceneOrder.length, 1);
    
    deleteSelected();
    assert.equal(EditorContext.sceneOrder.length, 0);
    assert.equal(getPrimarySelection(), -1);
  });

  test('deleteSelected and undo restores the entity to sceneOrder', () => {
    addCube();
    const oldName = NameComp.value[getPrimarySelection()];
    
    deleteSelected();
    assert.equal(EditorContext.sceneOrder.length, 0);
    
    History.undo(); // Undo delete
    assert.equal(EditorContext.sceneOrder.length, 1);
    assert.equal(NameComp.value[getPrimarySelection()], oldName);
  });

  test('duplicateSelected copies a cube', () => {
    addCube();
    const originalEid = getPrimarySelection();
    
    duplicateSelected();
    assert.equal(EditorContext.sceneOrder.length, 2);
    assert.notEqual(getPrimarySelection(), originalEid);
    assert.ok(NameComp.value[getPrimarySelection()].includes('copy'));
  });

  test('renameNode modifies the name and supports undo', () => {
    addCube();
    const eid = getPrimarySelection();
    const oldName = NameComp.value[eid];
    
    renameNode(eid, 'Test Node');
    assert.equal(NameComp.value[eid], 'Test Node');
    
    History.undo();
    assert.equal(NameComp.value[eid], oldName);
  });
});

describe('EditorContext pub/sub (Fase 6.6)', () => {
  beforeEach(() => {
    EditorContext._listeners = {};
  });

  test('emit calls every registered listener for that event', () => {
    let aCalls = 0, bCalls = 0;
    EditorContext.on('sceneMutated', () => aCalls++);
    EditorContext.on('sceneMutated', () => bCalls++);
    EditorContext.emit('sceneMutated');
    assert.equal(aCalls, 1);
    assert.equal(bCalls, 1);
  });

  test('emit does not cross-fire listeners registered for a different event', () => {
    let selectionCalls = 0, transformCalls = 0;
    EditorContext.on('selectionChanged', () => selectionCalls++);
    EditorContext.on('transformChanged', () => transformCalls++);
    EditorContext.emit('selectionChanged');
    assert.equal(selectionCalls, 1);
    assert.equal(transformCalls, 0);
  });

  test('emit on an event with no listeners does not throw', () => {
    assert.doesNotThrow(() => EditorContext.emit('sceneMutated'));
  });

  test('emit passes the payload through to listeners', () => {
    let received = null;
    EditorContext.on('sceneMutated', (payload) => { received = payload; });
    EditorContext.emit('sceneMutated', { eid: 42 });
    assert.deepEqual(received, { eid: 42 });
  });
});
