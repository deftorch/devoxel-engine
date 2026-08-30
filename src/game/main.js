import { addEntity, query, addComponent } from 'bitecs';
import { WORLD_CHUNKS, CHUNK_SX, CHUNK_SY, CHUNK_SZ, DEFAULT_VIEW_DISTANCE, DEFAULT_REBASE_THRESHOLD_CHUNKS, DEFAULT_REMESH_BUDGET_PER_FRAME, DEFAULT_NEAR_STORAGE_RADIUS, DEFAULT_MAX_FRAMES_TO_CLEAR_REMESH_BACKLOG, DEFAULT_LOD_CELL_SCALE } from '../core/config.js';
import {
  world,
  Position,
  Look,
  ChunkCoord,
  Renderable,
  RenderMesh,
  VoxelVolume,
  addGrowable,
  destroyChunkEntity,
} from '../core/ecs/components.js';
import { createMovementSystem } from '../core/ecs/systems.js';
import { VoxelEngine } from '../core/index.js';
import { UIManager } from './ui/UIManager.js';
import { InputManager } from './input/InputManager.js';
import { CommandBus } from '../core/api/CommandBus.js';
import { generateChunkVoxels } from './world/chunk.js';
import { ChunkStreamer } from '../core/world/ChunkStreamer.js';
import { OriginRebase } from '../core/world/OriginRebase.js';
import { ChunkGenerationWorkerPool } from '../core/world/ChunkGenerationWorkerPool.js';
import { deserializeStorage } from '../core/voxel/deserializeStorage.js';
import { ChunkPersistenceStore } from '../core/world/ChunkPersistenceStore.js';
import { createIndexedDBAdapter } from '../core/world/IndexedDBAdapter.js';

async function main() {
  const ui = new UIManager();

  let currentRenderMode = document.getElementById('render-select')
    ? document.getElementById('render-select').value
    : 'raster';

  // DEBUG: pewarnaan batas chunk (lihat VoxelEngine.setDebugChunkBounds +
  // SurfaceNetsMesher). Disimpan di luar `engine` karena engine bisa
  // dibuat ulang (mis. saat ganti mesin render), supaya preferensi user
  // tetap terbawa ke instance engine yang baru.
  let debugChunkBoundsEnabled = document.getElementById('debug-chunk-bounds')
    ? document.getElementById('debug-chunk-bounds').checked
    : false;

  let engine;
  let renderer;
  try {
    engine = new VoxelEngine({
      chunkSize: [CHUNK_SX, CHUNK_SY, CHUNK_SZ],
      storage: 'sdf', // Default saat awal
      mesher: 'surfacenets',
      renderer: currentRenderMode === 'raytrace' ? 'raytrace' : 'webgpu'
    });
    engine.setDebugChunkBounds(debugChunkBoundsEnabled);

    // Sinkronkan UI form elements
    const storageSelect = document.getElementById('storage-select');
    if (storageSelect) storageSelect.value = 'sdf';
    
    await engine.start(ui.canvas);
    renderer = engine.rendererPlugin;
  } catch (e) {
    ui.fail(e.message);
    return;
  }

  const chunkEntities = [];
  const chunkEidMap = new Map();

  // Roadmap A.1 -- Chunk Streaming Berbasis Posisi Pemain (sinkron dulu).
  // `chunkStreamer` non-null cuma ketika mode "Infinite Terrain" aktif;
  // kalau null, dunia tetap berperilaku seperti sebelumnya (grid
  // WORLD_CHUNKS x WORLD_CHUNKS lewat buildWorld(), dipakai mode benchmark).
  let chunkStreamer = null;
  let infiniteTerrainEnabled = false;

  // Roadmap A.5 -- Origin Rebasing: aktif berbarengan dengan chunkStreamer
  // (dibuat/dibuang di titik yang sama, lihat toggle di bawah). Non-null
  // cuma saat streaming aktif -- mode benchmark/editor/landing tidak pernah
  // menggeser engine.originChunk dari default [0,0,0].
  let originRebase = null;

  // Roadmap A.2 -- pool worker untuk generation (terpisah dari pool mesher
  // di AsyncWorkerMesher). Dibuat sekali secara lazy (bukan di setiap toggle
  // Infinite Terrain on/off) supaya worker tidak di-spawn/terminate berulang
  // kali -- worker generation cukup mahal untuk dibuat, dan tidak menyimpan
  // state apapun yang perlu di-reset antar sesi streaming.
  let chunkGenerationPool = null;

  // Roadmap A.3 -- Persistensi Chunk yang Diedit. Sama seperti
  // chunkGenerationPool: dibuat sekali secara lazy (bukan di setiap toggle
  // Infinite Terrain on/off) supaya koneksi IndexedDB tidak dibuka/ditutup
  // berulang, TAPI baru dipasang ke engine (engine.setPersistenceStore())
  // saat Infinite Terrain aktif -- mode benchmark/editor tidak pernah
  // menyimpan/memuat apapun dari IndexedDB. Tetap null kalau IndexedDB
  // tidak tersedia di environment ini (mis. beberapa mode headless/test) --
  // Infinite Terrain tetap jalan tanpa persistensi, cuma tanpa jaminan
  // galian tersimpan lintas sesi.
  let chunkPersistenceStore = null;
  if (typeof indexedDB !== 'undefined') {
    try {
      chunkPersistenceStore = new ChunkPersistenceStore(createIndexedDBAdapter());
    } catch (err) {
      console.warn('[main] IndexedDB tidak tersedia, persistensi chunk dinonaktifkan:', err);
    }
  }

  /**
   * Load 1 chunk hasil keputusan ChunkStreamer. Roadmap A.2: generation
   * sekarang berjalan di worker pool (`ChunkGenerationWorkerPool`), bukan
   * lagi blocking Main Thread seperti A.1.
   *
   * Roadmap A.3: SEBELUM meminta generation, cek dulu apakah chunk ini
   * pernah diedit & disimpan di sesi sebelumnya (`chunkPersistenceStore`).
   * Kalau ada, muat data tersimpan itu langsung dan SKIP generation sama
   * sekali -- generation ulang dari noise akan menghasilkan terrain
   * DEFAULT lagi, menghapus galian pemain yang seharusnya persisten.
   *
   * `engine.getOrCreateChunk()` dipanggil SEKARANG (sinkron, sebelum worker
   * selesai) supaya entity ECS + entry `engine.chunks` untuk chunk ini ada
   * segera -- placeholder storage kosong bawaan `storageFactory` AMAN
   * dijadikan neighbor sementara oleh chunk lain yang di-mesh lebih dulu:
   * `SurfaceNetsMesher._getSDF()` fallback ke 1.0 (udara) baik untuk
   * neighbor yang belum ada maupun yang ada tapi storage-nya masih
   * placeholder kosong, jadi hasilnya identik sampai data asli tiba (lihat
   * komentar lebih lengkap di ChunkGenerationWorkerPool) -- berlaku juga
   * untuk jeda singkat menunggu lookup persistence di bawah.
   *
   * `priorityDistance` menentukan urutan proses di worker pool (chunk
   * terdekat ke pemain duluan, bukan FIFO) -- lihat ChunkGenerationQueue.
   *
   * Roadmap A.4: setelah storage chunk ini benar-benar terisi (baik dari
   * data tersimpan MAUPUN dari worker generation), panggil
   * engine.markChunkLoaded() -- TITIK PEMANGGILANNYA SAMA di kedua jalur,
   * cuma window race condition-nya jadi lebih lebar untuk jalur worker
   * (lihat catatan commit A.4).
   *
   * Hotfix race condition (Roadmap A.3): kalau chunk ini di-unload SAAT
   * `await chunkPersistenceStore.load()` masih berjalan, lalu di-load ULANG
   * (cx,cz sama) sebelum lookup itu selesai, `engine.getChunk(cx,0,cz)`
   * setelah await akan mengembalikan chunk yang BARU (dari load kedua) --
   * BUKAN null! Guard lama (`if (!chunk) return`) tidak menangkap kasus
   * ini sama sekali, jadi hasil lookup BASI (dari upaya load PERTAMA) bisa
   * ke-apply ke chunk yang salah (yang sedang diproses upaya load KEDUA),
   * menimpa apapun yang sedang terjadi di sana. Fix: `getOrCreateChunk()`
   * SELALU membuat object literal BARU untuk chunk yang baru dibuat
   * (identitas berubah setiap unload+reload), jadi menyimpan REFERENCE
   * chunk di awal (`originalChunk`) dan membandingkannya dengan `===`
   * setelah `await` (bukan cuma cek non-null) cukup untuk mendeteksi
   * "apakah ini masih upaya load YANG SAMA" -- tanpa perlu bookkeeping
   * token/generation-counter terpisah.
   *
   * Roadmap A.6/B.5 -- LOD: `cellScale` (default 1, dipilih call site
   * berdasar jarak -- lihat komentar di titik pemanggilan) diset lewat
   * engine.setChunkLOD() SEGERA setelah chunk dibuat, SEBELUM await apapun
   * -- baik jalur persistence maupun generation akan membaca
   * chunk.desiredCellScale ini otomatis lewat remeshChunk() begitu
   * storage-nya terisi (lihat VoxelEngine.js), jadi tidak perlu wiring
   * terpisah di kedua cabang di bawah.
   */
  async function loadStreamedChunk(cx, cz, storageType, terrainType, priorityDistance, cellScale = 1) {
    const originalChunk = engine.getOrCreateChunk(cx, 0, cz);
    engine.setChunkLOD(cx, 0, cz, cellScale);

    if (chunkPersistenceStore) {
      let savedStorage = null;
      try {
        savedStorage = await chunkPersistenceStore.load(cx, 0, cz);
      } catch (err) {
        // Gagal baca IndexedDB (mis. kuota, browser mode private) --
        // degradasi anggun: lanjut ke generation seperti biasa, jangan
        // sampai satu chunk gagal load bikin seluruh streaming berhenti.
        console.warn(`[main] Gagal memuat data tersimpan chunk (${cx},0,${cz}), generate ulang:`, err);
      }
      if (savedStorage) {
        // Bandingkan REFERENCE (bukan cuma non-null) -- lihat catatan
        // "Hotfix race condition" di atas. Chunk yang di-unload lalu
        // di-load ulang selama await ini akan punya IDENTITAS BARU;
        // hasil lookup basi ini harus dibuang, bukan diterapkan ke
        // upaya load yang lain.
        const chunk = engine.getChunk(cx, 0, cz);
        if (chunk !== originalChunk) return;

        chunk.storage = savedStorage;
        chunk.dirty = true;
        // Data ini ADA di persistence karena dulu pernah everEdited=true --
        // pertahankan flag itu supaya siklus edit-lagi -> unload berikutnya
        // tetap tersimpan (bukan cuma tersimpan sekali lalu "lupa").
        chunk.everEdited = true;
        engine.markChunkLoaded(cx, 0, cz);
        return; // SKIP generation sama sekali -- lihat catatan di atas.
      }
    }

    chunkGenerationPool
      .requestChunk(cx, cz, storageType, terrainType, priorityDistance)
      .then((storagePayload) => {
        if (!storagePayload) return; // dibatalkan: chunk ini sudah di-unload lagi sebelum worker selesai

        // Sama seperti guard di cabang persistence di atas: bandingkan
        // REFERENCE, bukan cuma non-null -- chunk bisa saja sudah
        // di-unload lalu di-load ULANG (identitas object baru) tepat di
        // antara resolve() promise ini dan baris berikut. JANGAN pakai
        // getOrCreateChunk() di sini (itu akan diam-diam menghidupkan
        // lagi chunk yang sudah sengaja di-unload).
        const chunk = engine.getChunk(cx, 0, cz);
        if (chunk !== originalChunk) return;

        chunk.storage = deserializeStorage(storagePayload);
        chunk.dirty = true;
        engine.markChunkLoaded(cx, 0, cz);
      })
      .catch((err) => {
        console.error(`[main] Gagal generate chunk (${cx}, 0, ${cz}) di worker:`, err);
      });
  }

  /**
   * Unload 1 chunk hasil keputusan ChunkStreamer: batalkan job generation
   * yang mungkin masih tertunda untuk chunk ini (Roadmap A.2 -- mencegah
   * chunk yang sudah di-unload "hidup lagi" kalau hasil worker datang
   * telat), hapus dari VoxelEngine (data storage, TIDAK dipersist -- lihat
   * catatan A.3 di roadmap), dan hapus entity ECS terkait supaya GPU buffer-
   * nya di-dispose lewat observer onRemove(RenderMesh)/onRemove(VoxelVolume)
   * di components.js.
   */
  function unloadStreamedChunk(cx, cz) {
    if (chunkGenerationPool) chunkGenerationPool.cancel(cx, cz);
    engine.unloadChunk(cx, 0, cz);

    const key = `${cx},0,${cz}`;
    const eid = chunkEidMap.get(key);
    if (eid == null) return;
    chunkEidMap.delete(key);
    const idx = chunkEntities.indexOf(eid);
    if (idx !== -1) chunkEntities.splice(idx, 1);
    destroyChunkEntity(world, eid);
  }

  function setupEngineListeners(engineInstance) {
    // Bersihkan listener lama (berjaga-jaga jika menggunakan instance yang sama)
    engineInstance.off('chunkCreated');
    engineInstance.off('afterMesh');

    // FASE 2: Sinkronisasi ECS
    engineInstance.on('chunkCreated', (chunk) => {
      const eid = addEntity(world);
      addGrowable(world, eid, ChunkCoord);
      ChunkCoord.cx[eid] = chunk.cx;
      ChunkCoord.cz[eid] = chunk.cz;
      chunkEidMap.set(`${chunk.cx},${chunk.cy},${chunk.cz}`, eid);
      chunkEntities.push(eid);
    });

    engineInstance.on('afterMesh', ({ chunk, meshData }) => {
      const eid = chunkEidMap.get(`${chunk.cx},${chunk.cy},${chunk.cz}`);
      if (eid == null) return;

      if (currentRenderMode === 'raster' && meshData && meshData.indexCount > 0) {
        const mesh = renderer.createMesh(meshData.vertexData, meshData.indexData);
        if (!Renderable.indexCount[eid]) {
           addGrowable(world, eid, Renderable);
           addComponent(world, eid, RenderMesh);
        }
        Renderable.indexCount[eid] = meshData.indexCount;
        RenderMesh.meshes[eid] = mesh;
      } else if (currentRenderMode === 'raytrace' && meshData && meshData.rtData) {
        // Cek fallback jika error VoxelVolume
        if (typeof renderer.createVoxelVolume !== 'function') {
           console.error('[Error] renderer.createVoxelVolume tidak ditemukan! Renderer saat ini:', renderer);
           return;
        }
        const volume = renderer.createVoxelVolume(chunk.cx, chunk.cz, meshData.rtData.topGrid, meshData.rtData.brickPool);
        if (!VoxelVolume.volume[eid]) {
           addGrowable(world, eid, Renderable);
           addComponent(world, eid, VoxelVolume);
        }
        VoxelVolume.volume[eid] = volume;
      }
    });
  }

  // Panggil listener untuk engine pertama kali
  if (engine) setupEngineListeners(engine);

  let benchmarkStats = { type: 'flat', genMs: 0, meshMs: 0, nodes: 0 };

  async function buildWorld(storageType, terrainType, renderMode) {
    if (renderMode === 'raytrace' && storageType !== 'brickmap') {
      ui.fail(
        `Mode VoxelRT hanya mendukung storage 'brickmap'. ` + `Storage '${storageType}' tidak punya serialize().`
      );
      return;
    }

    ui.overlay.classList.remove('hidden');

    while (chunkEntities.length > 0) {
      destroyChunkEntity(world, chunkEntities.pop());
    }
    chunkEidMap.clear();
    if (engine) engine.chunks.clear();

    benchmarkStats.type = storageType;
    try {
      const totalChunks = WORLD_CHUNKS * WORLD_CHUNKS;
      let received = 0;
      let t0 = performance.now();

      // Fase 3: Generate terrain murni di Main Thread (cepat)
      ui.setStatus(`Membangkitkan Terrain...`, 0);
      for (let cx = 0; cx < WORLD_CHUNKS; cx++) {
        for (let cz = 0; cz < WORLD_CHUNKS; cz++) {
           const chunk = engine.getOrCreateChunk(cx, 0, cz);
           chunk.storage = generateChunkVoxels(cx, cz, storageType, terrainType);
           chunk.dirty = true;
        }
      }
      
      benchmarkStats.genMs = performance.now() - t0;
      benchmarkStats.meshMs = 0;
      benchmarkStats.nodes = 0;

      let resolveBenchmark;
      const benchmarkPromise = new Promise(r => resolveBenchmark = r);

      const onChunkMesh = ({ meshData }) => {
        received++;
        ui.setStatus(
          `Meshing (Pekerja Belakang Layar): ${terrainType} - ${storageType.toUpperCase()}… (${received}/${totalChunks})`,
          received / totalChunks
        );
        if (meshData && meshData.stats) {
           benchmarkStats.meshMs += meshData.stats.meshMs;
           benchmarkStats.nodes += meshData.stats.nodes;
        }
        if (received === totalChunks) {
           engine.off('afterMesh', onChunkMesh);
           resolveBenchmark();
        }
      };

      engine.on('afterMesh', onChunkMesh);
      engine.remeshDirtyChunks(); // Minta Engine memproses via AsyncWorkerMesher
      
      await benchmarkPromise;

    } catch (e) {
      ui.fail(e.message);
      return;
    }

    ui.setStatus('Benchmark Selesai.', 1);
    ui.hideOverlay();
    ui.showHUD();
  }

  // DEBUG: toggle pewarnaan batas chunk. Menandai semua chunk dirty lewat
  // engine.setDebugChunkBounds(), lalu remeshDirtyChunks() di render loop
  // (frame()) yang otomatis memprosesnya di frame berikutnya.
  const debugChunkBoundsToggle = document.getElementById('debug-chunk-bounds');
  if (debugChunkBoundsToggle) {
    debugChunkBoundsToggle.addEventListener('change', (e) => {
      debugChunkBoundsEnabled = e.target.checked;
      if (engine) engine.setDebugChunkBounds(debugChunkBoundsEnabled);
    });
  }

  // Roadmap A.1 -- toggle antara mode benchmark (dunia tetap, WORLD_CHUNKS x
  // WORLD_CHUNKS) dan mode Infinite Terrain (streaming berbasis posisi
  // pemain). Radius diambil dari DEFAULT_VIEW_DISTANCE (config.js).
  const infiniteTerrainToggle = document.getElementById('infinite-terrain-toggle');
  if (infiniteTerrainToggle) {
    infiniteTerrainToggle.addEventListener('change', (e) => {
      if (e.target.checked && currentRenderMode === 'raytrace') {
        // VoxelRT belum diuji untuk chunk streaming (storage/volume alloc-nya
        // berbeda) -- di luar scope A.1, jadi tolak kombinasi ini eksplisit
        // daripada diam-diam berperilaku salah.
        e.target.checked = false;
        ui.fail('Infinite Terrain belum didukung di mode VoxelRT. Pindah ke Rasterisasi dulu.');
        setTimeout(() => ui.hideOverlay(), 2000);
        return;
      }

      infiniteTerrainEnabled = e.target.checked;
      if (infiniteTerrainEnabled) {
        // Bersihkan dunia benchmark tetap yang sedang ter-load (jika ada)
        // sebelum masuk mode streaming -- keduanya tidak boleh aktif bersamaan
        // karena sama-sama memutuskan sendiri chunk mana yang "harus ada".
        while (chunkEntities.length > 0) destroyChunkEntity(world, chunkEntities.pop());
        chunkEidMap.clear();
        engine.chunks.clear();

        chunkStreamer = new ChunkStreamer(DEFAULT_VIEW_DISTANCE);
        originRebase = new OriginRebase(DEFAULT_REBASE_THRESHOLD_CHUNKS);
        // Lazy-create: worker pool baru di-spawn saat Infinite Terrain
        // pertama kali diaktifkan, lalu dipakai ulang untuk toggle
        // berikutnya dalam sesi yang sama (lihat komentar di deklarasinya).
        if (!chunkGenerationPool) chunkGenerationPool = new ChunkGenerationWorkerPool();
        // Roadmap A.3 -- pasang persistence store HANYA selama streaming
        // aktif (dipasang di sini, dilepas lagi di cabang else di bawah) --
        // mode benchmark/editor tidak pernah menyimpan/memuat chunk.
        if (chunkPersistenceStore) engine.setPersistenceStore(chunkPersistenceStore);
        ui.setStatus(`Infinite Terrain aktif — radius ${DEFAULT_VIEW_DISTANCE} chunk di sekitar pemain.`, 1);
        setTimeout(() => ui.hideOverlay(), 600);
        ui.showHUD();
      } else {
        chunkStreamer = null;
        originRebase = null;
        engine.originChunk = [0, 0, 0]; // kembali ke baking posisi absolut (mode benchmark)
        engine.setPersistenceStore(null); // Roadmap A.3 -- benchmark/editor tidak pakai persistensi
        // Kembali ke mode benchmark tetap dengan konfigurasi yang sedang dipilih di UI.
        const storageType = document.getElementById('storage-select').value;
        const terrainType = document.getElementById('terrain-select').value;
        buildWorld(storageType, terrainType, currentRenderMode);
      }
    });
  }

  document.getElementById('rebuild-btn').addEventListener('click', () => {
    // "Mulai Benchmark" selalu berarti dunia tetap (grid WORLD_CHUNKS) --
    // matikan mode streaming dulu kalau sedang aktif supaya keduanya tidak
    // berebut memutuskan chunk mana yang harus ada.
    if (infiniteTerrainEnabled) {
      infiniteTerrainEnabled = false;
      chunkStreamer = null;
      originRebase = null;
      engine.originChunk = [0, 0, 0];
      engine.setPersistenceStore(null); // Roadmap A.3
      if (infiniteTerrainToggle) infiniteTerrainToggle.checked = false;
    }

    const storageType = document.getElementById('storage-select').value;
    const terrainType = document.getElementById('terrain-select').value;
    
    const requiredMesher = storageType === 'sdf' ? 'surfacenets' : 'greedy_async';
    engine.useMesher(engine.registry.createMesher(requiredMesher));

    buildWorld(storageType, terrainType, currentRenderMode);
  });

  // One-shot RT diagnostics button (copy to clipboard + console)
  const rtDiagBtn = document.getElementById('rt-diag-btn');
  if (rtDiagBtn) {
    rtDiagBtn.addEventListener('click', async () => {
      try {
        ui.setStatus('Mengambil diagnostics VoxelRT...', 0);
        const res = await window.devoxelAPI.execute('getVoxelRTDiagnostics');
        console.log('[RT DIAGNOSTICS]', res);
        const text = JSON.stringify(res, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          ui.setStatus('Diagnostics VoxelRT disalin ke clipboard.', 1);
        } else {
          ui.setStatus('Diagnostics (lihat Console).', 1);
        }
        setTimeout(() => ui.hideOverlay(), 900);
        setTimeout(() => ui.setStatus(''), 1500);
      } catch (err) {
        ui.fail('Gagal mengambil diagnostics VoxelRT:\n' + (err.stack || err.message));
        setTimeout(() => ui.hideOverlay(), 2000);
      }
    });
  }

  document.getElementById('render-select').addEventListener('change', async (e) => {
    currentRenderMode = e.target.value;

    const storageType = document.getElementById('storage-select').value;
    const terrainType = document.getElementById('terrain-select').value;

    // Guard yang sama seperti di buildWorld() (Fase 0.1): cek dulu SEBELUM membuat
    // renderer/pipeline WebGPU baru, supaya kombinasi tidak valid tidak membuang biaya
    // inisialisasi compute pipeline yang akan langsung dibuang lagi oleh buildWorld().
    if (currentRenderMode === 'raytrace' && storageType !== 'brickmap') {
      ui.fail(
        `Mode VoxelRT hanya mendukung storage 'brickmap'. ` + `Storage '${storageType}' tidak punya serialize().`
      );
      return;
    }

    // Sama seperti guard di toggle Infinite Terrain: kombinasi streaming +
    // VoxelRT belum didukung (di luar scope A.1) -- matikan streaming dulu
    // kalau pemain pindah ke raytrace lewat dropdown ini.
    if (currentRenderMode === 'raytrace' && infiniteTerrainEnabled) {
      infiniteTerrainEnabled = false;
      chunkStreamer = null;
      originRebase = null;
      engine.originChunk = [0, 0, 0];
      engine.setPersistenceStore(null); // Roadmap A.3
      if (infiniteTerrainToggle) infiniteTerrainToggle.checked = false;
    }

    ui.setStatus(`Beralih ke mesin render: ${currentRenderMode}...`, 0);
    try {
      engine = new VoxelEngine({
        chunkSize: [CHUNK_SX, CHUNK_SY, CHUNK_SZ],
        storage: storageType,
        mesher: storageType === 'sdf' ? 'surfacenets' : 'greedy_async',
        renderer: currentRenderMode === 'raytrace' ? 'raytrace' : 'webgpu'
      });
      engine.setDebugChunkBounds(debugChunkBoundsEnabled);
      await engine.start(ui.canvas);
      renderer = engine.rendererPlugin;
      setupEngineListeners(engine);
    } catch (err) {
      ui.fail('Gagal beralih mesin render:\n' + (err.stack || err.message));
      return;
    }

    buildWorld(storageType, terrainType, currentRenderMode);
  });

  await buildWorld('sdf', 'normal', currentRenderMode);

  const player = addEntity(world);
  addGrowable(world, player, Position);
  addGrowable(world, player, Look);
  Position.x[player] = (WORLD_CHUNKS * CHUNK_SX) / 2;
  Position.y[player] = CHUNK_SY + 8;
  Position.z[player] = (WORLD_CHUNKS * CHUNK_SZ) / 2;
  Look.yaw[player] = 0.6;
  Look.pitch[player] = -0.35;

  // Initialize MCP Command Bus
  const engineAPI = new CommandBus();
  window.devoxelAPI = engineAPI;

  engineAPI.register({
    name: 'getPlayerPosition',
    description: 'Get the absolute coordinates and camera angles of the player in the world.',
    schema: { type: 'object', properties: {} },
    handler: () => ({
      x: Position.x[player],
      y: Position.y[player],
      z: Position.z[player],
      yaw: Look.yaw[player],
      pitch: Look.pitch[player],
    }),
  });

  engineAPI.register({
    name: 'getMetrics',
    description: 'Retrieve real-time performance metrics (FPS, Chunk counts, Workers).',
    schema: { type: 'object', properties: {} },
    handler: () => ({
      fps: fpsDisplay,
      chunks: chunkEntities.length,
      // Bug pre-existing (ReferenceError: `poolSize` tidak pernah
      // dideklarasikan) -- jumlah worker generation SEKARANG memang ada di
      // chunkGenerationPool.workers.length (Roadmap A.2), tapi cuma
      // meaningful kalau pool-nya sudah pernah dibuat (Infinite Terrain
      // pernah diaktifkan minimal sekali -- lihat komentar di deklarasi
      // chunkGenerationPool). 0 dipakai saat belum ada pool sama sekali,
      // konsisten dengan '-' yang sudah dipakai di HUD (ui.updateHUD) untuk
      // kasus yang sama.
      workers: chunkGenerationPool ? chunkGenerationPool.workers.length : 0,
    }),
  });

  // Diagnostics for VoxelRT internals (if renderer supports it)
  engineAPI.register({
    name: 'getVoxelRTDiagnostics',
    description: 'Inspect internal VoxelRT allocator state (globalBrickCount, freelist length).',
    schema: { type: 'object', properties: {} },
    handler: () => {
      if (renderer && typeof renderer.getDiagnostics === 'function') return renderer.getDiagnostics();
      return { error: 'Renderer does not expose VoxelRT diagnostics' };
    },
  });

  const input = new InputManager(ui.canvas);
  let lastRemoved = null;
  let lastDiagnostics = null;

  // Poll VoxelRT diagnostics periodically (1s) if renderer exposes them
  setInterval(() => {
    try {
      if (renderer && typeof renderer.getDiagnostics === 'function') {
        lastDiagnostics = renderer.getDiagnostics();
      }
    } catch {
      /* ignore */
    }
  }, 1000);

  input.onKeyDown = (code) => {
    if (code !== 'KeyT') return;
    const eid = chunkEntities.pop();
    if (eid == null) return;
    destroyChunkEntity(world, eid);
    lastRemoved = { eid, at: performance.now() };
    console.log(`[debug] Chunk entity ${eid} dihapus lewat removeEntity(); buffer di-destroy() via observer onRemove.`);
    try {
      const diag = renderer && typeof renderer.getDiagnostics === 'function' ? renderer.getDiagnostics() : null;
      if (diag) console.log('[debug] VoxelRT diagnostics:', diag);
    } catch (e) {
      console.warn('Gagal membaca diagnostics VoxelRT:', e);
    }
  };

  input.onMouseDown = (button) => {
    // FASE 4: Alih Kontrol Raycasting (Dukung raster & raytrace)

    // Simple DDA Raycaster in JS (CPU side)
    const ro = [Position.x[player], Position.y[player], Position.z[player]];
    const yaw = Look.yaw[player];
    const pitch = Look.pitch[player];
    const rd = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];

    let mapX = Math.floor(ro[0]);
    let mapY = Math.floor(ro[1]);
    let mapZ = Math.floor(ro[2]);

    const deltaDistX = Math.abs(1 / rd[0]);
    const deltaDistY = Math.abs(1 / rd[1]);
    const deltaDistZ = Math.abs(1 / rd[2]);

    const stepX = rd[0] < 0 ? -1 : 1;
    const stepY = rd[1] < 0 ? -1 : 1;
    const stepZ = rd[2] < 0 ? -1 : 1;

    let sideDistX = (rd[0] < 0 ? ro[0] - mapX : mapX + 1 - ro[0]) * deltaDistX;
    let sideDistY = (rd[1] < 0 ? ro[1] - mapY : mapY + 1 - ro[1]) * deltaDistY;
    let sideDistZ = (rd[2] < 0 ? ro[2] - mapZ : mapZ + 1 - ro[2]) * deltaDistZ;

    let hit = false;
    let side = 0; // 0=x, 1=y, 2=z

    // Raycast max 50 blok ke depan
    for (let i = 0; i < 50; i++) {
      if (sideDistX < sideDistY && sideDistX < sideDistZ) {
        sideDistX += deltaDistX;
        mapX += stepX;
        side = 0;
      } else if (sideDistY < sideDistZ) {
        sideDistY += deltaDistY;
        mapY += stepY;
        side = 1;
      } else {
        sideDistZ += deltaDistZ;
        mapZ += stepZ;
        side = 2;
      }

      // FASE 4: Cek blok dengan engine.getVoxel (bukan renderer.getVoxel)
      const voxel = engine.getVoxel(mapX, mapY, mapZ);
      if (voxel > 0) {
        hit = true;
        break;
      }
    }

    if (hit) {
      if (button === 0) {
        // Klik Kiri = Hancurkan (Set jadi Udara = 0)
        engine.setVoxel(mapX, mapY, mapZ, 0);
        // Fallback untuk VoxelRT karena belum punya Event Sync dari engine ke shader
        if (currentRenderMode === 'raytrace') renderer.editVoxel(mapX, mapY, mapZ, 0);
      } else if (button === 2) {
        // Klik Kanan = Bangun (Dirt = 2)
        let bx = mapX;
        let by = mapY;
        let bz = mapZ;
        if (side === 0) bx -= stepX;
        else if (side === 1) by -= stepY;
        else bz -= stepZ;
        engine.setVoxel(bx, by, bz, 2);
        if (currentRenderMode === 'raytrace') renderer.editVoxel(bx, by, bz, 2);
      }
    }
  };

  input.onMouseMove = (movementX, movementY) => {
    const sensitivity = 0.0024;
    Look.yaw[player] -= movementX * sensitivity;
    Look.pitch[player] -= movementY * sensitivity;
    const lim = Math.PI / 2 - 0.05;
    Look.pitch[player] = Math.max(-lim, Math.min(lim, Look.pitch[player]));
  };

  const movementSystem = createMovementSystem(world, input.keys);

  let lastTime = performance.now();
  let fpsAcc = 0,
    fpsFrames = 0,
    fpsDisplay = 0;

  function frame(now) {
    try {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      movementSystem(dt);

      // Hardening A.5: pcx/pcz dihitung di sini (bukan cuma di dalam blok
      // chunkStreamer) supaya bisa dipakai juga sebagai priorityOrigin
      // untuk remeshDirtyChunks() di FASE 5 di bawah, tanpa menghitung
      // ulang Math.floor() dua kali.
      let pcx = null, pcz = null;

      // Roadmap A.1 -- Chunk Streaming: hitung chunk (cx, cz) pemain saat
      // ini dan minta ChunkStreamer memutuskan load/unload HANYA kalau
      // pemain baru saja pindah chunk (streamer.update() return null kalau
      // masih di chunk yang sama -- lihat komentar di ChunkStreamer.js).
      if (chunkStreamer) {
        pcx = Math.floor(Position.x[player] / CHUNK_SX);
        pcz = Math.floor(Position.z[player] / CHUNK_SZ);
        const delta = chunkStreamer.update(pcx, pcz);
        if (delta) {
          // Roadmap A.2: prioritaskan job generation berdasar jarak
          // Chebyshev ke chunk pemain SAAT INI (pcx, pcz) -- chunk yang
          // langsung terlihat (dekat) diproses duluan oleh worker pool,
          // bukan menurut urutan FIFO munculnya di delta.toLoad.
          for (const [cx, cz] of delta.toLoad) {
            const priorityDistance = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
            // Roadmap B.4 -- chunk dekat pemain dapat storage SDF penuh
            // (presisi maksimal, cocok untuk diedit); chunk lebih jauh
            // (tapi masih dalam radius streaming) dapat storage
            // terkompresi -- lihat DEFAULT_NEAR_STORAGE_RADIUS di config.js.
            // Roadmap A.6/B.5 -- ambang jarak yang SAMA juga dipakai untuk
            // LOD mesh (cellScale): chunk dekat pemain di-mesh resolusi
            // penuh (cellScale=1), chunk lebih jauh di-mesh lebih kasar
            // (cellScale=4 -- lihat DEFAULT_LOD_CELL_SCALE) supaya vertex/
            // triangle count-nya jauh lebih sedikit, mengurangi draw call
            // & memori GPU untuk chunk yang toh cuma terlihat kecil di
            // layar. Kedua keputusan (storage & LOD) SENGAJA dibundel di
            // ambang yang sama -- "makin jauh, makin kasar" berlaku
            // konsisten di storage MAUPUN mesh sekaligus.
            //
            // PENTING (keterbatasan yang diketahui, lihat ROADMAP): belum
            // ada skirt/stitching geometry di batas transisi LOD -- chunk
            // cellScale=1 yang bersebelahan dengan chunk cellScale=4 bisa
            // punya celah visual KECIL di garis batasnya (vertex besar-
            // besar dari chunk kasar tidak pas menyambung ke vertex kecil-
            // kecil dari chunk halus). Diterima sebagai trade-off tahap
            // awal LOD, bukan diklaim seamless sempurna.
            //
            // Keputusan ini (seperti storageType di atas) HANYA diambil
            // sekali, saat chunk pertama kali di-load -- TIDAK di-upgrade/
            // downgrade otomatis kalau pemain berpindah jarak setelahnya
            // (scope decision yang sama seperti B.4, lihat ROADMAP).
            const storageType = priorityDistance <= DEFAULT_NEAR_STORAGE_RADIUS ? 'sdf' : 'sdf-compact';
            const cellScale = priorityDistance <= DEFAULT_NEAR_STORAGE_RADIUS ? 1 : DEFAULT_LOD_CELL_SCALE;
            loadStreamedChunk(cx, cz, storageType, 'normal', priorityDistance, cellScale);
          }
          for (const [cx, cz] of delta.toUnload) unloadStreamedChunk(cx, cz);
        }

        // Roadmap A.5 -- Origin Rebasing: cek di titik yang sama (hanya
        // saat pemain pindah chunk, bukan tiap frame -- konsisten dengan
        // ChunkStreamer). Kalau originRebase.update() return true, origin
        // baru saja digeser PERSIS ke (pcx, pcz) dan SEMUA chunk loaded
        // sudah ditandai dirty oleh setOriginChunk() -- remeshDirtyChunks()
        // di bawah akan membangun ulang vertex data-nya relatif ke origin
        // baru itu pada frame yang sama.
        if (originRebase && originRebase.update(pcx, pcz)) {
          engine.setOriginChunk(originRebase.originChunkX, 0, originRebase.originChunkZ);
        }
      }

      // FASE 5: Remesh Otomatis
      //
      // Hardening A.5 + HOTFIX starvation (lihat catatan lengkap di
      // VoxelEngine.remeshDirtyChunks()): budget (tetap ATAU dinamis) TIDAK
      // CUKUP sendirian -- selama nearest-first murni dipakai, backlog lama
      // bisa starvation PERMANEN kalau chunk baru terus mengalir lebih
      // dekat ke pemain (dibuktikan lewat simulasi, lihat komentar di
      // VoxelEngine.js). Jaminan sebenarnya datang dari parameter ke-3
      // (forceAfterSkips, default 8 di VoxelEngine) -- chunk yang sudah
      // kalah bersaing 8 kali berturut-turut WAJIB diproses, apapun
      // jaraknya. Budget dinamis di bawah ini dipertahankan sebagai
      // pelengkap (menyerap lonjakan besar -- mis. rebase -- lebih halus,
      // mengurangi seberapa sering forced-inclusion terpicu), BUKAN
      // sebagai satu-satunya jaminan anti-starvation lagi. Mode lain
      // (editor/benchmark/landing, chunkStreamer null) tetap pakai
      // perilaku lama: semua dirty langsung sekaligus, tanpa throttle --
      // 100% tidak berubah untuk jalur itu.
      if (chunkStreamer) {
        const dirtyCount = engine.countDirtyChunks();
        const dynamicBudget = Math.max(
          DEFAULT_REMESH_BUDGET_PER_FRAME,
          Math.ceil(dirtyCount / DEFAULT_MAX_FRAMES_TO_CLEAR_REMESH_BACKLOG)
        );
        engine.remeshDirtyChunks(dynamicBudget, { cx: pcx, cz: pcz }, DEFAULT_MAX_FRAMES_TO_CLEAR_REMESH_BACKLOG);
      } else {
        engine.remeshDirtyChunks();
      }

      fpsAcc += dt;
      fpsFrames++;
      if (fpsAcc >= 0.4) {
        fpsDisplay = Math.round(fpsFrames / fpsAcc);
        fpsAcc = 0;
        fpsFrames = 0;
      }

      // Roadmap A.5 -- Origin Rebasing: `eye` HARUS digeser dengan
      // engine.originChunk yang SAMA dipakai untuk membakar vertex mesh
      // (lihat SurfaceNetsMesher.generateMesh()) dan untuk AABB culling
      // (lihat draw() di kedua backend renderer) -- kalau tidak, kamera dan
      // geometri akan berada di ruang koordinat yang berbeda. Saat
      // originRebase null (mode benchmark/raytrace), engine.originChunk
      // tetap [0,0,0] sehingga pengurangan ini no-op (perilaku lama persis).
      const [rox, roy, roz] = engine.originChunk;
      const cameraState = {
        eye: [Position.x[player] - rox * CHUNK_SX, Position.y[player] - roy * CHUNK_SY, Position.z[player] - roz * CHUNK_SZ],
        yaw: Look.yaw[player],
        pitch: Look.pitch[player],
      };

      const chunkEids = query(world, [Renderable, ChunkCoord, RenderMesh]);
      renderer.draw(
        cameraState,
        chunkEids,
        Renderable,
        RenderMesh,
        ChunkCoord,
        [CHUNK_SX, CHUNK_SY, CHUNK_SZ],
        engine.originChunk
      );

      ui.updateHUD(
        fpsDisplay,
        chunkEntities.length,
        '-', // poolSize tidak lagi relevan di main.js
        cameraState,
        lastRemoved,
        benchmarkStats,
        lastDiagnostics
      );

      requestAnimationFrame(frame);
    } catch (err) {
      ui.fail('Error di render loop:\n' + (err.stack || err.message));
    }
  }
  requestAnimationFrame(frame);
}

main();
