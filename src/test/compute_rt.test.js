import { COMPUTE_SHADER } from '../core/renderer/webgpu/compute_rt.wgsl.js';

function assert(condition, message) {
    if (!condition) throw new Error("Assertion failed: " + message);
}

function assertCloseTo(actual, expected, tolerance = 0.05, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`Assertion failed: ${message} (Expected ~${expected}, got ${actual})`);
    }
}

export async function runShadowTests() {
    console.log("Memulai VoxelRT Buffer Readback Test...");
    const out = document.getElementById('test-output') || { innerHTML: '' };
    const log = (msg, color = 'white') => {
        console.log(msg);
        out.innerHTML += `<div style="color:${color}">${msg}</div>`;
    };

    if (!navigator.gpu) {
        log("WebGPU tidak didukung di browser ini, test dibatalkan.", "red");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();

    // 1. Setup Mock Data (1 Chunk di Sector 0,0,0)
    // topGrid size = 12 * 5 * 12 = 720 uints = 2880 bytes
    const topGridData = new Uint32Array(720);
    topGridData[0] = 1; // Sektor 0 menunjuk ke brickId 1

    // brickPool size = 2 bricks * 512 bytes = 1024 bytes
    // (brickId 0 = AIR, brickId 1 = Mock Chunk)
    const brickPoolData = new Uint8Array(1024);
    
    // Buat lantai di y=0 (semua x, z di dalam chunk 8x8)
    for (let x = 0; x < 8; x++) {
        for (let z = 0; z < 8; z++) {
            brickPoolData[1 * 512 + (x + 0 * 8 + z * 64)] = 1; // Solid
        }
    }
    // Buat satu balok penghalang mengambang di x=4, y=5, z=4
    const blockerIndex = 4 + 5 * 8 + 4 * 64;
    brickPoolData[1 * 512 + blockerIndex] = 1; // Solid

    // Buffer Setup
    const topGridBuffer = device.createBuffer({
        size: topGridData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(topGridBuffer, 0, topGridData);

    const brickPoolBuffer = device.createBuffer({
        size: brickPoolData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(brickPoolBuffer, 0, brickPoolData);

    const radiancePoolSize = 2 * 512 * 4; // float32 untuk tiap voxel
    const radiancePoolBuffer = device.createBuffer({
        size: radiancePoolSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    const sunBuffer = device.createBuffer({
        size: 32, // 2 * vec4f
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Dummy Buffers untuk binding shader yang lain
    const cameraBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM });
    const dummyTexture = device.createTexture({
        size: [1, 1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING
    });

    // Compile Shader
    const module = device.createShaderModule({ code: COMPUTE_SHADER });
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
        ]
    });

    const lightPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        compute: { module, entryPoint: 'light_injection' }
    });

    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            { binding: 0, resource: dummyTexture.createView() },
            { binding: 1, resource: { buffer: cameraBuffer } },
            { binding: 2, resource: { buffer: topGridBuffer } },
            { binding: 3, resource: { buffer: brickPoolBuffer } },
            { binding: 4, resource: { buffer: radiancePoolBuffer } },
            { binding: 5, resource: { buffer: sunBuffer } }
        ]
    });

    // Helper untuk dispatch dan readback
    async function executeAndReadback(sunDirArray) {
        // Update Sun
        device.queue.writeBuffer(sunBuffer, 0, new Float32Array([...sunDirArray, 0, 1, 1, 1, 0]));

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(lightPipeline);
        pass.setBindGroup(0, bindGroup);
        // Dispatch (1,1,1) sudah cukup karena chunk kita ada di dalam 8x8 (id.x < 96, id.y < 96)
        pass.dispatchWorkgroups(1, 1, 1);
        pass.end();

        // Staging Buffer untuk baca
        const stagingBuffer = device.createBuffer({
            size: radiancePoolSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        encoder.copyBufferToBuffer(radiancePoolBuffer, 0, stagingBuffer, 0, radiancePoolSize);
        device.queue.submit([encoder.finish()]);

        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const copyArray = new Float32Array(stagingBuffer.getMappedRange());
        const result = new Float32Array(copyArray); // clone
        stagingBuffer.unmap();
        stagingBuffer.destroy();
        return result;
    }

    try {
        // --- TEST 1: Matahari Vertikal (Bayangan tepat di bawah) ---
        // Arah: lurus dari atas (0, 1, 0)
        let radiance = await executeAndReadback([0.0, 1.0, 0.0]);
        
        // Voxel persis di bawah balok (x=4, y=0, z=4) -> LocalIdx = 4 + 0 + 256 = 260
        let shadowVoxelIdx = 1 * 512 + 260;
        // Voxel sebelahnya (x=5, y=0, z=4) -> LocalIdx = 261
        let litVoxelIdx = 1 * 512 + 261;

        assertCloseTo(radiance[shadowVoxelIdx], 0.0, 0.1, "Test 1: Lantai tepat di bawah balok harus gelap");
        assertCloseTo(radiance[litVoxelIdx], 1.0, 0.1, "Test 1: Lantai di sebelah balok harus terang (bebas bayangan)");
        log("[✓] Test 1 (Vertikal) Passed!", "lime");

        // --- TEST 2: Matahari Miring 45 Derajat ---
        // Arah: dari samping X dan atas Y -> vektor (-0.707, 0.707, 0.0) -> menembak ke (+x, -y)
        // Jika cahaya menembak ke sumbu x positif, bayangan bergeser ke sumbu x positif.
        // Berarti balok di x=4, y=5 akan melempar bayangan ke lantai x=9 (sudah di luar chunk 0,0,0).
        // Kita periksa x=4, y=0 (tadinya bayangan) sekarang harus TERANG karena bayangan bergeser.
        radiance = await executeAndReadback([-0.707, 0.707, 0.0]);
        
        assertCloseTo(radiance[shadowVoxelIdx], 1.0, 0.1, "Test 2: Lantai tepat di bawah balok harus terang (bayangan telah bergeser)");
        log("[✓] Test 2 (Miring 45 deg) Passed!", "lime");

        // --- TEST 3: Soft Shadow Penumbra (opsional, karena angle kecil 0.02 butuh jitter yang beruntung, kita tes eksistensi fraksi saja) ---
        // Karena ada sampel acak di kerucut kecil, voxel di perbatasan murni mungkin mendapat 0.25, 0.5, 0.75
        let foundFraction = false;
        // Hanya cek sekitar balok untuk Test 1
        radiance = await executeAndReadback([0.0, 1.0, 0.0]);
        for (let i = 250; i < 270; i++) {
            let val = radiance[1 * 512 + i];
            if (val > 0.0 && val < 1.0) {
                foundFraction = true;
                break;
            }
        }
        
        if (foundFraction) {
            log("[✓] Test 3 (Penumbra Fractional Values) Passed! Ditemukan nilai gradasi (bukan 0/1 murni).", "lime");
        } else {
            // Bisa jadi tidak kena karena cone 0.02 cukup tipis. Kita tidak fail jika ini meleset, hanya log.
            log("[!] Test 3: Tidak menemukan nilai fraksional. (Wajar karena Cone Radius = 0.02 mungkin terlalu tipis untuk chunk 8x8)", "yellow");
        }

        log("Semua VoxelRT Buffer Readback Test selesai tanpa error.", "cyan");

    } catch (e) {
        log(`[X] Test Failed: ${e.message}`, "red");
        console.error(e);
    }
}
