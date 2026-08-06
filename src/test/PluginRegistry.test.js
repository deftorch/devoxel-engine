import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../core/registry/PluginRegistry.js';

describe('PluginRegistry — storage', () => {
  test('registerStorage + createStorage returns an instance built by the factory', () => {
    const registry = new PluginRegistry();
    class FakeStorage {
      constructor(sx, sy, sz) {
        this.dims = [sx, sy, sz];
      }
    }
    registry.registerStorage('fake', (sx, sy, sz) => new FakeStorage(sx, sy, sz));

    const instance = registry.createStorage('fake', 16, 40, 16);
    assert.ok(instance instanceof FakeStorage);
    assert.deepEqual(instance.dims, [16, 40, 16]);
  });

  test('createStorage with an unknown id throws, listing available ids', () => {
    const registry = new PluginRegistry();
    registry.registerStorage('octree', () => ({}));
    registry.registerStorage('flatgrid', () => ({}));

    assert.throws(
      () => registry.createStorage('nonexistent'),
      (err) => {
        assert.match(err.message, /Unknown storage plugin: "nonexistent"/);
        assert.match(err.message, /octree/);
        assert.match(err.message, /flatgrid/);
        return true;
      }
    );
  });

  test('createStorage with no plugins registered lists "(none registered)"', () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.createStorage('anything'), /\(none registered\)/);
  });

  test('registering a non-function factory throws', () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.registerStorage('bad', {}), /must be registered with a factory function/);
  });

  test('overwriting an existing plugin id warns', () => {
    const registry = new PluginRegistry();
    const warn = mock.method(console, 'warn', () => {});
    registry.registerStorage('dup', () => ({}));
    registry.registerStorage('dup', () => ({}));
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /Overwriting storage plugin: "dup"/);
    warn.mock.restore();
  });
});

describe('PluginRegistry — mesher & renderer', () => {
  test('registerMesher + createMesher roundtrip', () => {
    const registry = new PluginRegistry();
    class FakeMesher {}
    registry.registerMesher('greedy', () => new FakeMesher());
    assert.ok(registry.createMesher('greedy') instanceof FakeMesher);
  });

  test('registerRenderer + createRenderer roundtrip, passing through arguments', () => {
    const registry = new PluginRegistry();
    registry.registerRenderer('webgl', (canvas, opts) => ({ canvas, opts }));
    const result = registry.createRenderer('webgl', 'fake-canvas', { antialias: true });
    assert.equal(result.canvas, 'fake-canvas');
    assert.deepEqual(result.opts, { antialias: true });
  });
});

describe('PluginRegistry — introspection', () => {
  test('list(kind) returns id + meta for every registered plugin', () => {
    const registry = new PluginRegistry();
    registry.registerStorage('octree', () => ({}), { label: 'Octree', description: 'Sparse tree' });
    registry.registerStorage('flatgrid', () => ({}), { label: 'Flat Grid' });

    const list = registry.list('storage');
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.find((p) => p.id === 'octree'),
      { id: 'octree', label: 'Octree', description: 'Sparse tree' }
    );
  });

  test('has(kind, id) reflects registration state', () => {
    const registry = new PluginRegistry();
    assert.equal(registry.has('mesher', 'greedy'), false);
    registry.registerMesher('greedy', () => ({}));
    assert.equal(registry.has('mesher', 'greedy'), true);
  });

  test('an unknown plugin kind throws', () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.list('unknown-kind'), /Unknown plugin kind: unknown-kind/);
  });
});
