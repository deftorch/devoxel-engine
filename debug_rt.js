import { initComputeRT } from './src/core/renderer/webgpu/raytrace.js';
import { VoxelRendererAdapter } from './src/core/renderer/VoxelRendererAdapter.js';

// Mock WebGPU API
global.navigator = {
  gpu: {
    requestAdapter: async () => ({
      requestDevice: async () => ({
        createShaderModule: () => ({}),
        createBindGroupLayout: () => ({}),
        createComputePipeline: () => ({}),
        createBuffer: () => ({}),
        queue: { writeBuffer: () => {}, submit: () => {} }
      })
    })
  }
};
global.window = {
  devicePixelRatio: 1,
  addEventListener: () => {}
};
global.innerWidth = 800;
global.innerHeight = 600;

async function test() {
  const canvas = {
    getContext: () => ({
      configure: () => {},
      getCurrentTexture: () => ({ createView: () => ({}) })
    }),
    width: 800,
    height: 600
  };
  
  const raw = await initComputeRT(canvas);
  console.log("Raw object keys:", Object.keys(raw));
  console.log("Raw createVoxelVolume type:", typeof raw.createVoxelVolume);
  
  const adapter = new VoxelRendererAdapter('raytrace', () => raw);
  await adapter.init(canvas);
  
  console.log("Adapter object keys:", Object.keys(adapter));
  console.log("Adapter createVoxelVolume type:", typeof adapter.createVoxelVolume);
}
test().catch(console.error);
