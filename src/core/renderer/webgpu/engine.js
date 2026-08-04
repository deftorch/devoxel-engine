import { SHADER } from './shader.wgsl.js';
import { mat4Perspective, mat4LookAt, mat4Multiply, vAdd } from '../../utils/math.js';

export async function initWebGPU(canvas) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Tidak ada GPU adapter yang cocok ditemukan.');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
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
      module, entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 9 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x3' },
        ],
      }],
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
        }
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
        colorAttachments: [{
          view: msaaTexture.createView(),
          resolveTarget: context.getCurrentTexture().createView(),
          clearValue: { r: 0.53, g: 0.72, b: 0.86, a: 1 },
          loadOp: 'clear', storeOp: 'discard',
        }],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
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
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
  };
}
