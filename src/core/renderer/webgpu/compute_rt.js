/**
 * ComputeRTRenderer (Stub)
 * Ini adalah cangkang (stub) untuk implementasi Voxel Ray Tracing di Fase 3.
 * Saat ini hanya akan membersihkan layar dengan warna ungu gelap untuk 
 * membuktikan sistem pengalihan (Switch) berjalan dengan sempurna.
 */
import { COMPUTE_SHADER } from './compute_rt.wgsl.js';
import { vCross, vNorm as vNormalize } from '../../utils/math.js';

let globalTopGridData = new Uint32Array(12 * 5 * 12);
let globalBrickPoolData = new Uint8Array(50000 * 512); 
let globalRadiancePoolData = new Float32Array(50000 * 512); // Memori baru untuk Cahaya

let globalBrickCount = 1; // 0 is AIR

// Freelist: stack (LIFO) berisi index brick yang sudah dilepas dan siap dipakai ulang.
// Tanpa ini, setiap chunk yang dibangun ulang di mode raytrace akan terus menaikkan
// globalBrickCount tanpa batas (kebocoran memori GPU/CPU brick pool).
let freeBrickList = [];

let isTopGridDirty = true;
let dirtyBrickPoolQueue = [];

/**
 * Alokasikan satu slot brick global. Pakai ulang dari freeBrickList kalau ada,
 * kalau tidak alokasikan slot baru di ujung pool.
 * @returns {number} brick index (selalu > 0, 0 dicadangkan untuk udara)
 */
function allocBrick() {
  if (freeBrickList.length > 0) return freeBrickList.pop();
  return globalBrickCount++;
}

/**
 * Lepaskan semua brick milik chunk (cx, cz) kembali ke freeBrickList, dan kosongkan
 * referensinya di topGrid global. Dipanggil lewat volume.destroy() saat chunk entity
 * dihapus (lihat observer onRemove(VoxelVolume) di components.js).
 */
function freeChunkVolume(cx, cz) {
  for (let sz = 0; sz < 2; sz++) {
    for (let sy = 0; sy < 5; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const gx = cx * 2 + sx, gz = cz * 2 + sz;
        const globalIdx = gx + sy * 12 + gz * 60;
        const brickId = globalTopGridData[globalIdx];
        if (brickId > 0) {
          freeBrickList.push(brickId);
          globalTopGridData[globalIdx] = 0;
          // Nol-kan brickPoolData di slot ini untuk mencegah data lama "bocor"
          // kalau brickId ini dipakai ulang sebelum di-overwrite penuh oleh chunk baru.
          globalBrickPoolData.fill(0, brickId * 512, brickId * 512 + 512);
        }
      }
    }
  }
  isTopGridDirty = true;
}

export async function initComputeRT(canvas) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Tidak ada GPU adapter yang cocok untuk Compute.');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  
  // Wajib seragam dengan WGSL (rgba8unorm)
  const format = 'rgba8unorm';

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    
    // Wajib menambahkan STORAGE_BINDING agar Compute Shader bisa menggambar langsung ke Kanvas
    context.configure({ 
      device, 
      format, 
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
      alphaMode: 'opaque' 
    });
  }
  resize();
  window.addEventListener('resize', resize);

  // --- Inisialisasi Compute Pipeline ---
  const module = device.createShaderModule({ code: COMPUTE_SHADER });
  
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: format } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
    ]
  });

  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: { module, entryPoint: 'main' }
  });

  const lightPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: { module, entryPoint: 'light_injection' }
  });

  // Buffer Seragam (Uniform) untuk mengirim Kamera
  const uniformBuffer = device.createBuffer({
    size: 80, // 5 * 16 bytes
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformArray = new Float32Array(20);

  const globalTopGridBuffer = device.createBuffer({
    size: globalTopGridData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const globalBrickPoolBuffer = device.createBuffer({
    size: globalBrickPoolData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const globalRadiancePoolBuffer = device.createBuffer({
    size: globalRadiancePoolData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  return {
    // Ray Tracer tidak menggunakan mesh poligon, fungsi ini dibuat agar interface sama (Duck Typing).
    createMesh(vertexData, indexData) {
      return { destroy: () => {} };
    },

    // Membangun StorageBuffer di VRAM dari data BrickMap mentah.
    // Setiap sub-sektor (2x5x2 per chunk) yang punya brick dialokasikan SATU PER SATU
    // lewat allocBrick(), supaya slot yang dibebaskan freeChunkVolume() bisa dipakai ulang
    // (kalau dialokasikan sekaligus secara kontigu seperti sebelumnya, reuse jadi tidak mungkin
    // karena freeBrickList bisa berisi index yang tersebar/non-kontigu).
    createVoxelVolume(cx, cz, topGridData, brickPoolData) {
      if (!topGridData) return { destroy: () => {} };

      isTopGridDirty = true;

      for (let sz = 0; sz < 2; sz++) {
        for (let sy = 0; sy < 5; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const localIdx = sx + sy * 2 + sz * 10;
            const localBrickId = topGridData[localIdx];

            const gx = cx * 2 + sx;
            const gz = cz * 2 + sz;
            const globalIdx = gx + sy * 12 + gz * 60;

            if (localBrickId === 0) {
              globalTopGridData[globalIdx] = 0;
              continue;
            }

            const brickId = allocBrick();
            const srcOffset = localBrickId * 512;
            const destOffset = brickId * 512;
            globalBrickPoolData.set(
              brickPoolData.subarray(srcOffset, srcOffset + 512),
              destOffset
            );

            dirtyBrickPoolQueue.push({
              byteOffset: destOffset,
              dataOffset: destOffset,
              byteSize: 512
            });

            globalTopGridData[globalIdx] = brickId;
          }
        }
      }

      // destroy() melepas brick chunk ini kembali ke freeBrickList (lihat freeChunkVolume di atas).
      return {
        destroy: () => freeChunkVolume(cx, cz)
      };
    },
    
    getVoxel(x, y, z) {
        if (x < 0 || x >= 96 || y < 0 || y >= 40 || z < 0 || z >= 96) return 0;
        const gx = Math.floor(x / 8);
        const gy = Math.floor(y / 8);
        const gz = Math.floor(z / 8);
        const sectorIdx = gx + gy * 12 + gz * 60;
        const brickId = globalTopGridData[sectorIdx];
        if (brickId === 0) return 0;
        
        const lx = Math.floor(x) % 8;
        const ly = Math.floor(y) % 8;
        const lz = Math.floor(z) % 8;
        return globalBrickPoolData[brickId * 512 + (lx + ly * 8 + lz * 64)];
    },

    editVoxel(x, y, z, type) {
        if (x < 0 || x >= 96 || y < 0 || y >= 40 || z < 0 || z >= 96) return;
        
        const gx = Math.floor(x / 8);
        const gy = Math.floor(y / 8);
        const gz = Math.floor(z / 8);
        const sectorIdx = gx + gy * 12 + gz * 60;
        let brickId = globalTopGridData[sectorIdx];
        
        const lx = Math.floor(x) % 8;
        const ly = Math.floor(y) % 8;
        const lz = Math.floor(z) % 8;
        const localIdx = lx + ly * 8 + lz * 64;
        
        if (brickId === 0) {
          if (type === 0) return; // Menghapus udara = tidak ada efek
          // Alokasikan memori baru untuk Brick (Chunk baru) menggunakan allocBrick()
          brickId = allocBrick();
          globalTopGridData[sectorIdx] = brickId;
          isTopGridDirty = true;
        }
        
        const voxelOffset = brickId * 512 + localIdx;
        globalBrickPoolData[voxelOffset] = type;
        
        // WebGPU writeBuffer offset & size harus kelipatan 4 bytes,
        // jadi kita perbarui seluruh blok 8x8x8 (512 byte) ini saja.
        const brickDestOffset = brickId * 512;
        dirtyBrickPoolQueue.push({
            byteOffset: brickDestOffset,
            dataOffset: brickDestOffset,
            byteSize: 512
        });
    },
    
    // Fungsi ini mengeksekusi (Dispatch) Compute Shader untuk menggambar ke Kanvas
    draw(cameraState, chunkEids, Renderable, RenderMesh) {
      const { eye, yaw, pitch } = cameraState;
      
      // Kalkulasi Vektor Kamera
      const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const upDir = [0, 1, 0];
      const right = vNormalize(vCross(forward, upDir));
      const up = vNormalize(vCross(right, forward));

      // Update Uniforms
      uniformArray.set(eye, 0);
      uniformArray.set(forward, 4);
      uniformArray.set(right, 8);
      uniformArray.set(up, 12);
      uniformArray[16] = canvas.width;
      uniformArray[17] = canvas.height;
      // Slot 18 = Camera.debugMode (Fase 0.3). Slot 19 tetap padding, tidak dipakai.
      const debugSelect = document.getElementById('debug-select');
      uniformArray[18] = debugSelect ? Number(debugSelect.value) : 0;
      device.queue.writeBuffer(uniformBuffer, 0, uniformArray);
      
      // Hanya perbarui VRAM jika ada perubahan (Dirty Flags)
      if (isTopGridDirty) {
          device.queue.writeBuffer(globalTopGridBuffer, 0, globalTopGridData);
          isTopGridDirty = false;
      }
      
      for (const update of dirtyBrickPoolQueue) {
          device.queue.writeBuffer(
              globalBrickPoolBuffer, 
              update.byteOffset, 
              globalBrickPoolData, 
              update.dataOffset, 
              update.byteSize
          );
      }
      dirtyBrickPoolQueue = [];

      const currentTexture = context.getCurrentTexture();
      
      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: currentTexture.createView() },
          { binding: 1, resource: { buffer: uniformBuffer } },
          { binding: 2, resource: { buffer: globalTopGridBuffer } },
          { binding: 3, resource: { buffer: globalBrickPoolBuffer } },
          { binding: 4, resource: { buffer: globalRadiancePoolBuffer } }
        ]
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      
      // Mengikat VRAM (Sama untuk kedua shader)
      pass.setBindGroup(0, bindGroup);
      
      // TAHAP 1: Menembakkan cahaya matahari dari langit ke seluruh balok Voxel
      // Dunia kita lebarnya 96x96 voxel. Workgroup size = 8x8.
      pass.setPipeline(lightPipeline);
      pass.dispatchWorkgroups(Math.ceil(96 / 8), Math.ceil(96 / 8));
      
      // TAHAP 2: Menggambar (Render) ke Piksel Layar
      pass.setPipeline(pipeline);
      pass.dispatchWorkgroups(Math.ceil(canvas.width / 16), Math.ceil(canvas.height / 16));
      
      pass.end();

      device.queue.submit([encoder.finish()]);
    }
    ,
    // Diagnostic info for runtime inspection (used by CommandBus)
    getDiagnostics() {
      return {
        globalBrickCount,
        freeBrickListLength: freeBrickList.length,
        freeBrickListSample: freeBrickList.slice(Math.max(0, freeBrickList.length - 8))
      };
    }
  };
}
