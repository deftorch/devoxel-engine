import { SHADER } from './shader.wgsl.js';
import { mat4Perspective, mat4LookAt, mat4Multiply, vAdd } from '../../utils/math.js';

const LINE_SHADER = /* wgsl */ `
struct LU { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> lu : LU;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) color : vec3<f32> };
@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) color: vec3<f32>) -> VOut {
  var out: VOut;
  out.pos = lu.viewProj * vec4<f32>(position, 1.0);
  out.color = color;
  return out;
}
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> { return vec4<f32>(in.color, 1.0); }
`;

export async function initWebGPU(canvas) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Tidak ada GPU adapter yang cocok ditemukan.');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    context.configure({ device, format, alphaMode: 'opaque' });
  }
  resize();
  window.addEventListener('resize', resize);

  const module = device.createShaderModule({ code: SHADER });
  const uniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 9 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: 4 },
  });

  let depthTexture = null;
  let msaaTexture = null;
  function ensureRenderTargets() {
    if (depthTexture && depthTexture.width === canvas.width && depthTexture.height === canvas.height) return;
    if (depthTexture) depthTexture.destroy();
    if (msaaTexture) msaaTexture.destroy();
    depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'depth24plus',
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    msaaTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  const uniformArray = new Float32Array(20);

  // --- Debug Primitives Pipelines (Fase 2) ---
  const lineModule = device.createShaderModule({ code: LINE_SHADER });
  const debugUniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const debugBGL = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });
  const debugBG = device.createBindGroup({
    layout: debugBGL,
    entries: [{ binding: 0, resource: { buffer: debugUniformBuffer } }],
  });
  const debugPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [debugBGL] });
  
  const createDebugPipeline = (topology, depthTest) => device.createRenderPipeline({
    layout: debugPipelineLayout,
    vertex: {
      module: lineModule,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 6 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      }],
    },
    fragment: { module: lineModule, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology, cullMode: 'none' },
    depthStencil: { 
      format: 'depth24plus', 
      depthWriteEnabled: depthTest, 
      depthCompare: depthTest ? 'less' : 'always' 
    },
    multisample: { count: 4 },
  });

  const debugPipelines = {
    linesDepth: createDebugPipeline('line-list', true),
    linesNoDepth: createDebugPipeline('line-list', false),
    trisDepth: createDebugPipeline('triangle-list', true),
    trisNoDepth: createDebugPipeline('triangle-list', false),
  };

  // We need to keep track of debug data buffered for the current frame
  let activeDebugDraws = [];
  let debugUniformArray = new Float32Array(16);

  function getDebugBuffer(data) {
    const size = Math.ceil(data.byteLength / 4) * 4;
    if (size === 0) return { buffer: null, count: 0 };
    const buffer = device.createBuffer({
      size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(buffer, 0, data);
    return { buffer, count: data.length / 6 }; // 6 floats per vertex (xyz, rgb)
  }

  return {
    createMesh(vertexData, indexData) {
      const vertexBuffer = device.createBuffer({
        size: vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
      vertexBuffer.unmap();

      const indexBuffer = device.createBuffer({
        size: Math.ceil(indexData.byteLength / 4) * 4,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint32Array(indexBuffer.getMappedRange()).set(indexData);
      indexBuffer.unmap();

      return {
        vertexBuffer,
        indexBuffer,
        destroy: () => {
          vertexBuffer.destroy();
          indexBuffer.destroy();
        },
      };
    },

    draw(cameraState, chunkEids, Renderable, RenderMesh) {
      ensureRenderTargets();

      const aspect = canvas.width / canvas.height;
      const proj = mat4Perspective(Math.PI / 3, aspect, 0.1, 500);
      const { eye, yaw, pitch } = cameraState;
      const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const center = vAdd(eye, forward);
      const view = mat4LookAt(eye, center, [0, 1, 0]);
      const viewProj = mat4Multiply(proj, view);

      uniformArray.set(viewProj, 0);
      uniformArray.set(eye, 16);
      uniformArray[19] = 0.006;
      device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: msaaTexture.createView(),
            resolveTarget: context.getCurrentTexture().createView(),
            clearValue: { r: 0.53, g: 0.72, b: 0.86, a: 1 },
            loadOp: 'clear',
            storeOp: 'discard',
          },
        ],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);

      for (const eid of chunkEids) {
        const mesh = RenderMesh.meshes[eid];
        if (!mesh) continue;
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(Renderable.indexCount[eid]);
      }

      // ----------------------------------------------------
      // Debug Primitives Hook
      // ----------------------------------------------------
      if (activeDebugDraws.length > 0) {
        debugUniformArray.set(viewProj, 0);
        device.queue.writeBuffer(debugUniformBuffer, 0, debugUniformArray);
        pass.setBindGroup(0, debugBG);
        for (const draw of activeDebugDraws) {
          if (!draw.bufferInfo.buffer) continue;
          pass.setPipeline(draw.pipeline);
          pass.setVertexBuffer(0, draw.bufferInfo.buffer);
          pass.draw(draw.bufferInfo.count);
        }
      }

      // Hook ekstensi untuk merender primitif kustom (misal: Grid / Outline) di pass yang sama
      if (typeof cameraState.onPostDraw === 'function') {
         cameraState.onPostDraw(pass);
      }

      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    
    drawDebugPrimitives(cameraState, debugData) {
      // Clean up buffers from previous frame
      for (const draw of activeDebugDraws) {
        if (draw.bufferInfo.buffer) draw.bufferInfo.buffer.destroy();
      }
      activeDebugDraws = [];

      if (!debugData) return;

      if (debugData.lines) {
        for (const lineObj of debugData.lines) {
          activeDebugDraws.push({
            pipeline: lineObj.depthTest ? debugPipelines.linesDepth : debugPipelines.linesNoDepth,
            bufferInfo: getDebugBuffer(lineObj.data)
          });
        }
      }
      if (debugData.tris) {
        for (const triObj of debugData.tris) {
          activeDebugDraws.push({
            pipeline: triObj.depthTest ? debugPipelines.trisDepth : debugPipelines.trisNoDepth,
            bufferInfo: getDebugBuffer(triObj.data)
          });
        }
      }
    },

    // Mengekspos raw device untuk kebutuhan tool/editor eksternal
    device,
    context,
    format
  };
}
