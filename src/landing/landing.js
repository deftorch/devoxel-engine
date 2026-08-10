import { createWorld, addEntity, addComponent, query } from 'https://esm.sh/bitecs@0.4.0';
import { VoxelEngine } from '../core/index.js';
import { Renderable, ChunkCoord, RenderMesh, addGrowable } from '../core/ecs/components.js';

async function initBackground() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;

    // Inisialisasi engine mini tanpa input/ui
    const engine = new VoxelEngine({
        chunkSize: [32, 40, 32],
        storage: 'flatgrid',
        mesher: 'worker-greedy',
        renderer: 'webgpu'
    });
    
    try {
        await engine.start(canvas);
    } catch (e) {
        console.warn("WebGPU tidak didukung, background 3D dimatikan.", e);
        return;
    }
    
    const renderer = engine.rendererPlugin;
    const world = createWorld();
    const chunkEids = [];
    
    engine.on('chunkCreated', (chunk) => {
        const eid = addEntity(world);
        addGrowable(world, eid, ChunkCoord);
        ChunkCoord.cx[eid] = chunk.cx;
        ChunkCoord.cz[eid] = chunk.cz;
        chunk.eid = eid;
        chunkEids.push(eid);
    });
    
    engine.on('afterMesh', ({ chunk, meshData }) => {
        if (!meshData || meshData.indexCount === 0 || meshData.error) return;
        const eid = chunk.eid;
        const mesh = renderer.createMesh(meshData.vertexData, meshData.indexData);
        if (!Renderable.indexCount[eid]) {
           addGrowable(world, eid, Renderable);
           addComponent(world, eid, RenderMesh);
        }
        Renderable.indexCount[eid] = meshData.indexCount;
        RenderMesh.meshes[eid] = mesh;
    });

    // Generate Floating Island (Procedural)
    const islandRadius = 12;
    const centerX = 16;
    const centerZ = 16;

    for (let x = 0; x < 32; x++) {
       for (let z = 0; z < 32; z++) {
          const dx = x - centerX;
          const dz = z - centerZ;
          const dist = Math.sqrt(dx*dx + dz*dz);
          
          if (dist < islandRadius) {
              const noise = Math.sin(x * 0.5) * 2 + Math.cos(z * 0.5) * 2;
              const h = Math.floor(10 + noise - (dist * 0.5)); // Dome shape
              
              if (h > 0) {
                  for (let y = 0; y < h; y++) {
                      // 1: Stone, 2: Dirt, 3: Grass
                      let blockId = 1; 
                      if (y === h - 1) blockId = 3; // Grass on top
                      else if (y > h - 4) blockId = 2; // Dirt below grass
                      
                      engine.setVoxel(x, y + 10, z, blockId); // Offset Y
                  }
              }
          }
       }
    }
    
    engine.remeshDirtyChunks();
    
    let time = 0;
    function frame() {
        time += 0.003;
        
        // Rotating Camera Settings
        const radius = 45;
        const targetY = 15;
        
        const cameraState = {
            eye: [centerX + Math.cos(time) * radius, targetY + Math.sin(time*2) * 5, centerZ + Math.sin(time) * radius],
            yaw: -time + Math.PI/2,
            pitch: -0.2 + (Math.sin(time*2) * 0.05) // Slight nodding
        };
        
        const chunkEidsQuery = query(world, [Renderable, ChunkCoord, RenderMesh]);
        if (chunkEidsQuery.length > 0) {
            renderer.draw(cameraState, chunkEidsQuery, Renderable, RenderMesh);
        }
        
        requestAnimationFrame(frame);
    }
    frame();
}

initBackground().catch(console.error);
