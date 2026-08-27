import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GreedyMesher } from '../core/mesher/GreedyMesher.js';
import { FlatGridStorage } from '../core/voxel/FlatGridStorage.js';

const CS = 8;

function makeSolidCube(size = CS) {
  const storage = new FlatGridStorage(size, size, size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) storage.set(x, y, z, 1);
    }
  }
  return storage;
}

describe('GreedyMesher', () => {
  test('generateMesh tanpa ctx menghasilkan mesh chunk-local (offset nol)', () => {
    const mesher = new GreedyMesher();
    const mesh = mesher.generateMesh(makeSolidCube(), null);
    assert.ok(mesh.vertexData.length > 0);
  });

  // Roadmap A.5 -- Origin Rebasing: sama seperti SurfaceNetsMesher,
  // ctx.originChunk membakar posisi vertex RELATIF terhadap sebuah origin.
  describe('generateMesh — ctx.originChunk (Roadmap A.5)', () => {
    test('tanpa ctx.originChunk, posisi vertex tetap absolut persis seperti sebelumnya (backward compatible)', () => {
      const mesher = new GreedyMesher();
      const ctx = { chunkCoord: [5, 0, 0], getNeighbor: () => null };
      const mesh = mesher.generateMesh(makeSolidCube(), ctx);
      assert.ok(mesh.vertexData.length > 0);
      // Kubus solid penuh -- setiap muka luar ada tepat di x=5*CS atau x=6*CS.
      let sawWorldAbsoluteX = false;
      for (let i = 0; i < mesh.vertexData.length; i += 3) {
        if (Math.abs(mesh.vertexData[i] - 5 * CS) < 1e-6 || Math.abs(mesh.vertexData[i] - 6 * CS) < 1e-6) {
          sawWorldAbsoluteX = true;
          break;
        }
      }
      assert.ok(sawWorldAbsoluteX, 'vertex harus dibakar di posisi world-absolute (5*CS..6*CS), bukan chunk-local');
    });

    test('ctx.originChunk menggeser posisi vertex relatif terhadap origin tsb (selisih persis)', () => {
      const mesher = new GreedyMesher();
      const cube = makeSolidCube();
      const ctxAbsolute = { chunkCoord: [5, 0, 0], getNeighbor: () => null };
      const ctxRelative = { chunkCoord: [5, 0, 0], originChunk: [5, 0, 0], getNeighbor: () => null };

      const meshAbsolute = mesher.generateMesh(cube, ctxAbsolute);
      const meshRelative = mesher.generateMesh(cube, ctxRelative);

      assert.equal(meshAbsolute.vertexData.length, meshRelative.vertexData.length);
      const diffX = meshAbsolute.vertexData[0] - meshRelative.vertexData[0];
      assert.ok(Math.abs(diffX - 5 * CS) < 1e-6, `selisih offset X harus persis 5*CS, dapat ${diffX}`);
    });

    test('acceptance test A.5: dengan origin di-rebase, magnitude vertex tetap kecil meski chunk aslinya jauh dari (0,0,0)', () => {
      const mesher = new GreedyMesher();
      const cube = makeSolidCube();
      const farChunkX = 125000; // >100.000 unit dengan CS=8 -> 1.000.000 unit

      const ctxAbsolute = { chunkCoord: [farChunkX, 0, 0], getNeighbor: () => null };
      const meshAbsolute = mesher.generateMesh(cube, ctxAbsolute);
      assert.ok(
        Math.abs(meshAbsolute.vertexData[0]) > farChunkX * CS - CS * 2,
        'tanpa origin rebase, magnitude vertex tumbuh sebesar posisi absolut dunia'
      );

      const ctxRelative = { chunkCoord: [farChunkX, 0, 0], originChunk: [farChunkX, 0, 0], getNeighbor: () => null };
      const meshRelative = mesher.generateMesh(cube, ctxRelative);
      for (let i = 0; i < meshRelative.vertexData.length; i += 3) {
        assert.ok(
          Math.abs(meshRelative.vertexData[i]) < CS * 2,
          `dengan origin di-rebase, magnitude vertex tetap kecil meski chunk aslinya di x=${farChunkX}`
        );
      }
    });
  });
});
