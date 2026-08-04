# Devoxel Engine AI Manifest

Welcome to Devoxel Engine. As an AI agent working on this project, you must strictly follow these architectural guidelines to maintain an AI-friendly, scalable, and predictable codebase.

## 1. Core Principles
- **Data-Driven**: Never hardcode block types, entities, or materials in logic files. Always use the JSON/JS registries in `src/data/`.
- **Modularity**: One file = One purpose. Do not create God Objects.
- **Strict Typing**: Use JSDoc annotations extensively. All math functions, ECS components, and public APIs must have `@typedef` and `@param` annotations to help context understanding.

## 2. Directory Structure
- `/src/core/`: The core engine (WebGPU, ECS, Math). **Do not modify this unless explicitly asked.**
- `/src/game/`: The game runtime logic (Input, World generation, UI).
- `/src/editor/`: The standalone voxel editor.
- `/src/data/`: Data registries (blocks, materials, entities).

## 3. ECS Rules
- We use `bitecs`.
- All components must be created using `growableComponent()` from `src/core/ecs/components.js` to prevent silent overflows, unless it is an AoS component like `RenderMesh` that stores complex JS Objects.
- Do not store heavy objects (like GPU Buffers) in TypedArrays.

## 4. WebGPU Rules
- Main thread handles all `device.create*` calls.
- Workers (like `mesher.worker.js`) only compute raw `Float32Array` or `Uint32Array` data and pass it back. Workers never touch WebGPU objects directly.

## 5. MCP Server Integration (Command API)
To allow AI agents or external tools (like MCP via WebSocket) to control the engine, we use the `CommandBus` (`src/core/api/CommandBus.js`).
- Never mutate the ECS `world` directly from external scripts. Always register a command via `devoxelAPI.register('commandName', handler)`.
- The global `window.devoxelAPI` is the entry point for MCP WebSocket bridges. As an AI, you can call `window.devoxelAPI.execute('command')` to interact with the game state dynamically.
