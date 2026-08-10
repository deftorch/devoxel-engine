import { addEntity, query, addComponent } from 'bitecs';
import { WORLD_CHUNKS, CHUNK_SX, CHUNK_SY, CHUNK_SZ } from '../core/config.js';
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

async function main() {
  const ui = new UIManager();

  let currentRenderMode = document.getElementById('render-select')
    ? document.getElementById('render-select').value
    : 'raster';

  let engine;
  let renderer;
  try {
    engine = new VoxelEngine({
      chunkSize: [CHUNK_SX, CHUNK_SY, CHUNK_SZ],
      storage: 'flatgrid', // Default saat awal
      mesher: 'worker-greedy',
      renderer: currentRenderMode === 'raytrace' ? 'raytrace' : 'webgpu'
    });
    await engine.start(ui.canvas);
    renderer = engine.rendererPlugin;
  } catch (e) {
    ui.fail(e.message);
    return;
  }

  const chunkEntities = [];
  const chunkEidMap = new Map();

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

  document.getElementById('rebuild-btn').addEventListener('click', () => {
    const storageType = document.getElementById('storage-select').value;
    const terrainType = document.getElementById('terrain-select').value;
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

    ui.setStatus(`Beralih ke mesin render: ${currentRenderMode}...`, 0);
    try {
      engine = new VoxelEngine({
        chunkSize: [CHUNK_SX, CHUNK_SY, CHUNK_SZ],
        storage: storageType,
        mesher: 'greedy',
        renderer: currentRenderMode === 'raytrace' ? 'raytrace' : 'webgpu'
      });
      await engine.start(ui.canvas);
      renderer = engine.rendererPlugin;
      setupEngineListeners(engine);
    } catch (err) {
      ui.fail('Gagal beralih mesin render:\n' + (err.stack || err.message));
      return;
    }

    buildWorld(storageType, terrainType, currentRenderMode);
  });

  await buildWorld('flat', 'normal', currentRenderMode);

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
      workers: poolSize,
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
      
      // FASE 5: Remesh Otomatis
      engine.remeshDirtyChunks();

      fpsAcc += dt;
      fpsFrames++;
      if (fpsAcc >= 0.4) {
        fpsDisplay = Math.round(fpsFrames / fpsAcc);
        fpsAcc = 0;
        fpsFrames = 0;
      }

      const cameraState = {
        eye: [Position.x[player], Position.y[player], Position.z[player]],
        yaw: Look.yaw[player],
        pitch: Look.pitch[player],
      };

      const chunkEids = query(world, [Renderable, ChunkCoord, RenderMesh]);
      renderer.draw(cameraState, chunkEids, Renderable, RenderMesh);

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
