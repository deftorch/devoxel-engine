import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock DOM
global.document = {
  getElementById: (id) => ({ disabled: false }),
};

import History from '../editor/history.js';

describe('Editor History', () => {
  beforeEach(() => {
    History.undoStack.length = 0;
    History.redoStack.length = 0;
  });

  test('push executes command and adds to undoStack', () => {
    let redoCount = 0;
    let undoCount = 0;
    const cmd = {
      redo: () => redoCount++,
      undo: () => undoCount++
    };
    
    History.push(cmd);
    assert.equal(redoCount, 1);
    assert.equal(undoCount, 0);
    assert.equal(History.undoStack.length, 1);
    assert.equal(History.redoStack.length, 0);
  });

  test('push clears redoStack', () => {
    History.undoStack.length = 0;
    History.redoStack = [{ redo: () => {}, undo: () => {} }];
    
    History.push({ redo: () => {}, undo: () => {} });
    assert.equal(History.redoStack.length, 0);
  });

  test('undo moves command from undoStack to redoStack and calls undo', () => {
    let redoCount = 0;
    let undoCount = 0;
    const cmd = {
      redo: () => redoCount++,
      undo: () => undoCount++
    };
    
    History.push(cmd);
    assert.equal(redoCount, 1); // pushed
    
    History.undo();
    assert.equal(undoCount, 1);
    assert.equal(History.undoStack.length, 0);
    assert.equal(History.redoStack.length, 1);
  });

  test('redo moves command from redoStack to undoStack and calls redo', () => {
    let redoCount = 0;
    let undoCount = 0;
    const cmd = {
      redo: () => redoCount++,
      undo: () => undoCount++
    };
    
    History.push(cmd);
    History.undo();
    
    // reset for redo test
    redoCount = 0; 
    
    History.redo();
    assert.equal(redoCount, 1);
    assert.equal(History.undoStack.length, 1);
    assert.equal(History.redoStack.length, 0);
  });
  
  test('undo with empty stack does nothing', () => {
    assert.doesNotThrow(() => History.undo());
  });
  
  test('redo with empty stack does nothing', () => {
    assert.doesNotThrow(() => History.redo());
  });
});
