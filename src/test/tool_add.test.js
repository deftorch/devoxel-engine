import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AddToolState, setPalette, getPalette, resetAddToolSettingsToDefault, handleAddToolPointerMove, handleAddToolPointerUp } from '../editor/tool-add.js';
import { loadAddToolSettings, saveAddToolSettings, DEFAULT_PALETTE } from '../editor/settings.js';
import { rayAABBWithNormal } from '../editor/picking.js';
import History from '../editor/history.js';
import { EditorContext } from '../editor/state.js';

// Mock browser globals needed by the modules
global.document = {
  getElementById: (id) => ({
    style: {},
    innerHTML: '',
    appendChild: () => {},
    classList: { add: () => {}, remove: () => {} },
    replaceChildren: () => {},
    addEventListener: () => {},
    textContent: '',
  })
};

describe('tool-add.js — snapToCell', () => {
  test('titik di separuh kedua sebuah sel (lokal x=1.7) resolve ke sel 1, bukan vertex 2', () => {
    AddToolState.baseUnitSize = 1;
    AddToolState.localNormal = [0, 1, 0]; // Y adalah sumbu normal, X dan Z adalah in-plane
    const snapped = AddToolState.snapToCell([1.7, 0.5, 0.2]);
    assert.deepEqual(snapped, [1, 1, 0]); // sumbu in-plane di-floor
  });
});

describe('tool-add.js — getCubeTransform', () => {
  test('drag dari sel 1 ke sel 3 menghasilkan sx=3, bukan cuma span mentah 2', () => {
    AddToolState.startPoint = [1, 0, 0];
    AddToolState.currentPoint = [3, 0, 0];
    AddToolState.localNormal = [0, 1, 0]; // face Y normal
    AddToolState.height = 1;
    AddToolState.baseUnitSize = 1;
    AddToolState.targetRotation = [0, 0, 0];
    AddToolState.targetPivot = [0, 0, 0];

    const t = AddToolState.getCubeTransform();
    assert.equal(t.sx, 3, 'sx harus mencakup sel 1, 2, dan 3 (total 3 unit)');
    assert.equal(t.sy, 1, 'sy harus = height');
    assert.equal(t.sz, 1, 'sz default 1');
  });

  test('Target dirotasi 45° jauh dari titik nol dunia (px=10, pz=6)', () => {
    AddToolState.startPoint = [0, 0, 0];
    AddToolState.currentPoint = [0, 0, 0];
    AddToolState.localNormal = [0, 1, 0];
    AddToolState.height = 1;
    AddToolState.baseUnitSize = 1;
    // rotationMat3()/Transform.rx-ry-rz menggunakan satuan DERAJAT di
    // seluruh codebase ini (lihat picking.js: rotationMat3(t.rx, t.ry, t.rz)
    // dibaca langsung dari Transform ECS component) - jadi 45 derajat di
    // sini harus ditulis literal `45`, BUKAN `Math.PI / 4` (yang adalah
    // representasi radian dari 45 derajat, dan kalau diteruskan ke fungsi
    // yang mengharapkan derajat hanya menghasilkan rotasi ~0.785 derajat).
    AddToolState.targetRotation = [0, 45, 0]; // Rotasi 45 derajat di Y
    AddToolState.targetPivot = [10, 0, 6];

    const t = AddToolState.getCubeTransform();
    // Centroid lokal awal: Lpx = 0.5, Lpy = 0.5, Lpz = 0.5
    // Pivot harus bereaksi terhadap rotasi tersebut dengan poros [10, 0, 6].
    // Nilai referensi (0.5*cos45 + 0.5*sin45 = 0.70710678...) dihitung
    // manual dan diverifikasi lewat mat3Apply(rotationMat3(0,45,0), ...).
    assert.equal(t.rx, 0);
    assert.equal(t.ry, 45);
    assert.equal(t.rz, 0);
    assert.ok(Math.abs(t.px - 10.70710678) < 1e-6, `px harus 10.7071..., dapat ${t.px}`);
    assert.ok(Math.abs(t.py - 0.5) < 1e-6, `py harus 0.5, dapat ${t.py}`);
    assert.ok(Math.abs(t.pz - 6) < 1e-6, `pz harus tetap 6 (offset Z nol di rotasi 45° murni Y), dapat ${t.pz}`);
  });

  test('Target axis-aligned / ground plane - konsistensi hasil', () => {
    AddToolState.startPoint = [0, 0, 0];
    AddToolState.currentPoint = [0, 0, 0];
    AddToolState.localNormal = [0, 1, 0];
    AddToolState.height = 1;
    AddToolState.baseUnitSize = 1;
    AddToolState.targetRotation = [0, 0, 0];
    AddToolState.targetPivot = [0, 0, 0];

    const t = AddToolState.getCubeTransform();
    assert.equal(t.ox, 0);
    assert.equal(t.oy, 0);
    assert.equal(t.oz, 0);
    assert.equal(t.sx, 1);
    assert.equal(t.sy, 1);
    assert.equal(t.sz, 1);
    assert.equal(t.px, 0.5);
    assert.equal(t.py, 0.5);
    assert.equal(t.pz, 0.5);
  });
});

describe('tool-add.js — interaksi state dan phase', () => {
  beforeEach(() => {
    History.undoStack = [];
    History.redoStack = [];
  });

  test('EXTRUDE height - mousemove dengan jitter < 6px tidak merubah tinggi', () => {
    AddToolState.active = true;
    AddToolState.phase = 'EXTRUDE';
    AddToolState.extrudeStartScreenPos = [100, 100];
    AddToolState.height = 1;
    AddToolState.baseUnitSize = 1;
    
    // Pindahkan mouse 2px saja dari posisi awal (jitter)
    // Walaupun raycast hasilnya mungkin berbeda, karena < threshold 6px, height harus tetap 1
    const dummyCanvas = {}; // canvas dummy tidak akan dibaca oleh screenToRay jika return awal
    
    // Pastikan kita handle the check correctly
    const result = handleAddToolPointerMove(102, 102, dummyCanvas);
    assert.equal(result, true);
    assert.equal(AddToolState.height, 1, 'Tinggi tidak boleh berubah jika pergerakan < 6px');
  });

  test('finalizeCube: Klik cepat dari HOVER -> DRAW_BASE -> langsung jadi', () => {
    AddToolState.active = true;
    AddToolState.phase = 'DRAW_BASE';
    AddToolState.startPoint = [0, 0, 0];
    AddToolState.currentPoint = [0, 0, 0];
    AddToolState.localNormal = [0, 1, 0];
    AddToolState.targetRotation = [0, 0, 0];
    AddToolState.targetPivot = [0, 0, 0];
    AddToolState.baseUnitSize = 1;

    const initialHistoryLength = History.undoStack.length;
    const initialSceneCount = EditorContext.sceneOrder.length;

    // isClick = true (klik tanpa drag)
    handleAddToolPointerUp(100, 100, {}, true);

    assert.equal(AddToolState.phase, 'HOVER', 'Fase harus kembali ke HOVER setelah selesai');
    assert.equal(History.undoStack.length, initialHistoryLength + 1, 'Harus mencatat 1 entry History baru');
    assert.equal(History.undoStack[History.undoStack.length - 1].label, 'Add Box (Draw)');
    assert.equal(EditorContext.sceneOrder.length, initialSceneCount + 1, 'Entity harus benar-benar dibuat di scene');

    // Ini bagian yang paling penting: benar-benar PANGGIL undo(), bukan
    // cuma cek entry-nya ada. Bug lama (monkey-patch History.push yang
    // menimpa undo jadi fungsi kosong untuk label 'Add Box (Draw)') akan
    // membuat assert di atas tetap lolos - entry-nya tetap ada dengan
    // label yang benar - tapi entity-nya tidak akan pernah terhapus.
    // Diverifikasi: menaruh kembali bug lama secara sengaja membuktikan
    // test tanpa baris ini tetap lolos meski undo()-nya kosong.
    History.undo();
    assert.equal(EditorContext.sceneOrder.length, initialSceneCount, 'undo() harus benar-benar menghapus entity yang baru dibuat');

    // Dan redo() harus mengembalikannya lagi.
    History.redo();
    assert.equal(EditorContext.sceneOrder.length, initialSceneCount + 1, 'redo() harus mengembalikan entity yang di-undo');
  });
});

describe('tool-add.js — settings.js dan palet', () => {
  beforeEach(() => {
    // Reset global yang termutasi agar tiap tes clean
    resetAddToolSettingsToDefault();
  });

  test('loadAddToolSettings tidak throw jika localStorage tidak ada/error', () => {
    // Di lingkungan node:test, window.localStorage tidak ada secara default.
    // Panggilan ini harus mereturn default alih-alih melempar error.
    assert.doesNotThrow(() => {
      const s = loadAddToolSettings();
      assert.ok(s.palette);
      assert.equal(s.unitSize, 1);
    });
  });

  test('setPalette dengan array kosong dihindari / minimal 1 warna', () => {
    setPalette([]);
    // Karena diset array kosong, ia harusnya mem-fallback ke DEFAULT_PALETTE
    const current = getPalette();
    assert.equal(current.length, DEFAULT_PALETTE.length, 'Harus kembali ke default jika kosong');
  });
});

describe('picking.js — rayAABBWithNormal', () => {
  test('ray dari atas mengenai box axis-aligned', () => {
    const mn = [0, 0, 0];
    const mx = [1, 1, 1];
    
    // Ray dari y=2 menembak ke bawah
    const ro = [0.5, 2, 0.5];
    const rd = [0, -1, 0];
    
    const hit = rayAABBWithNormal(ro, rd, mn, mx);
    assert.ok(hit, 'Harus kena box');
    assert.equal(hit.t, 1, 'Jarak harus 1 unit');
    assert.deepEqual(hit.normal, [0, 1, 0], 'Normal harus menunjuk ke atas (+Y)');
  });

  test('ray dari samping (+X) mengenai box', () => {
    const mn = [0, 0, 0];
    const mx = [1, 1, 1];
    
    // Ray dari x=2 menembak ke kiri (-X)
    const ro = [2, 0.5, 0.5];
    const rd = [-1, 0, 0];
    
    const hit = rayAABBWithNormal(ro, rd, mn, mx);
    assert.ok(hit, 'Harus kena box');
    assert.equal(hit.t, 1, 'Jarak harus 1 unit');
    assert.deepEqual(hit.normal, [1, 0, 0], 'Normal harus menunjuk ke +X');
  });

  test('ray meleset dari box', () => {
    const mn = [0, 0, 0];
    const mx = [1, 1, 1];
    
    // Ray dari samping menembak ke arah yang salah
    const ro = [2, 0.5, 0.5];
    const rd = [0, 1, 0];
    
    const hit = rayAABBWithNormal(ro, rd, mn, mx);
    assert.equal(hit, null, 'Tidak boleh mengenai box');
  });
});
