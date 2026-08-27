# AGENTS.md — Devoxel: Universal Voxel Framework

This file follows the [AGENTS.md](https://agents.md) convention: a single,
tool-agnostic set of instructions for any AI coding agent working in this
repository (Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, or others).
If your tool reads a different file (e.g. `CLAUDE.md`, `.cursorrules`,
`.github/copilot-instructions.md`), point it at this file instead of
duplicating instructions.

---

## 1. What this project is

Devoxel is a **pluggable voxel engine** for the browser (WebGL2 + WebGPU).
Its defining architectural decision: **storage, meshing, and rendering are
each a swappable plugin**, resolved by string id through a central
`PluginRegistry`, not hardcoded branches. See `README.md` for the
user-facing pitch and `docs/Voxel - berbagai pendekatan.md` for the research
backing the design (why no single voxel data structure wins on every axis).

Before making non-trivial changes, skim:

- `README.md` — pluggable system usage and naming conventions
- `NEXT_STEPS.md` — current known gaps and the recommended order to close them
- `docs/Voxel - berbagai pendekatan.md` — survey of voxel approaches this
  framework is designed to accommodate
- `docs/gi-roadmap/` — global illumination implementation roadmap (phased)

---

## 2. Directory structure

| Path          | Purpose                                                                                                                                                 | Modify freely?                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`   | The framework itself: `VoxelEngine`, `PluginRegistry`, base classes (`VoxelStorage`, `VoxelMesher`, `VoxelRenderer`), built-in plugins, ECS, math utils | **Only when the task is about the framework/plugin system.** Changes here affect every plugin — read `src/core/index.js` first to see the full public surface. |
| `src/game/`   | Game runtime: input, world/chunk logic, UI, workers                                                                                                     | Yes, freely                                                                                                                                                    |
| `src/editor/` | Standalone voxel editor                                                                                                                                 | Yes, freely                                                                                                                                                    |
| `src/data/`   | Data registries (blocks, materials)                                                                                                                     | Yes — this is where new block/material types belong, never hardcoded in logic                                                                                  |
| `src/test/`   | Tests (`node --test` style + WebGPU browser tests)                                                                                                      | Yes, and please add tests for `src/core/` changes                                                                                                              |
| `docs/`       | Architecture research and roadmaps                                                                                                                      | Yes — keep it updated when architecture decisions change                                                                                                       |

---

## 3. Core principles

- **Data-driven**: never hardcode block types, entities, or materials in
  logic files. Use the registries in `src/data/`.
- **Modularity**: one file = one purpose. No God Objects.
- **Plugin over branch**: if you catch yourself writing
  `if (storageType === 'octree') { ... } else if (...) { ... }` inside
  `src/core/`, that's a signal the logic belongs in a new `VoxelStorage`
  subclass registered with `PluginRegistry`, not a conditional.
- **JSDoc everywhere in `src/core/`**: public APIs, ECS components, and math
  functions need `@param`/`@returns` annotations — this is how agents (and
  humans) understand the contract without reading the implementation.

---

## 4. The pluggable plugin system (read this before touching `src/core/`)

Three roles, three base classes, one registry:

| Role      | Base class      | File                                 | Built-in implementations                                                                             |
| --------- | --------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Storage   | `VoxelStorage`  | `src/core/voxel/VoxelStorage.js`     | `FlatGridStorage`, `OctreeStorage`, `SVDAGStorage`, `Tree64Storage`, `BrickMapStorage`, `SDFStorage` |
| Meshing   | `VoxelMesher`   | `src/core/mesher/VoxelMesher.js`     | `GreedyMesher`                                                                                       |
| Rendering | `VoxelRenderer` | `src/core/renderer/VoxelRenderer.js` | `VoxelRendererAdapter` (wraps WebGL/WebGPU/raytrace backends)                                        |

**Naming convention** — follow this exactly for new plugins:

- Base class: `Voxel<Role>` (no `Plugin` suffix — that's implied by the
  architecture already).
- Implementation: `<Name><Role>` (e.g. `MarchingCubesMesher`, not
  `MarchingCubesMesherPlugin` — don't repeat the role suffix twice).
- Registry id: lowercase, no separators or hyphens preferred (`'octree'`,
  `'raytrace'`), matching the existing set.

**To add a new plugin** (storage, mesher, or renderer):

1. Extend the relevant base class and implement its contract (`get/set` for
   storage, `generateMesh` for mesher, `init/render` for renderer).
2. Register it with `defaultRegistry.register<Role>(id, factory, meta)` in
   the relevant `src/core/<role>/index.js` barrel (or at runtime via
   `engine.registerPlugin(kind, id, factory, meta)`).
3. Do **not** add a branch for it inside `VoxelEngine.js` — if you find
   yourself editing `VoxelEngine.js` to support a new plugin, stop and
   reconsider; the whole point of the registry is that `VoxelEngine` never
   needs to know concrete plugin types.
4. Verify with a smoke test (see §8) before considering the task done.

**Mesher `ctx` contract:** `generateMesh(chunkStorage, ctx)` receives an
optional `ctx` object with `chunkCoord` (`[cx,cy,cz]`), `getNeighbor(dx,dy,dz)`
(returns adjacent chunk's storage or `null` — used for border/seam stitching,
see the Fase 0 seam fix and Roadmap A.4), `debugChunkBounds`, and
`originChunk` (`[ox,oy,oz]`, default `[0,0,0]` — Roadmap A.5 Origin Rebasing:
lets `VoxelEngine.setOriginChunk()` shift where vertex positions are baked
*relative to*, so Float32 vertex buffers never accumulate the player's full
absolute distance from spawn; see `core/world/OriginRebase.js`). All fields
are additive/optional — a mesher that ignores `ctx` entirely, or a caller
that never sets `originChunk`, keeps the old world-absolute baking behavior
unchanged.

---

## 5. ECS rules

- We use `bitecs`.
- All components must be created with `growableComponent()` from
  `src/core/ecs/components.js` to prevent silent overflows, **unless** it's
  an AoS component like `RenderMesh` that stores complex JS objects.
- Never store heavy objects (GPU buffers, etc.) in TypedArrays.

---

## 6. WebGPU / WebGL rules

- Main thread handles all `device.create*` calls.
- Workers (e.g. `mesher.worker.js`) only compute raw `Float32Array` /
  `Uint32Array` data and pass it back — workers never touch WebGPU/WebGL
  objects directly.
- Renderer backend files are paired by convention: `engine.js` (init +
  draw) alongside `shader.<glsl|wgsl>.js` (shader source) for raster
  backends; `raytrace.js` alongside `raytrace.wgsl.js` for the WebGPU
  compute raytracer. Keep new backends consistent with this pairing.

---

## 7. Command API / external control

To let AI agents or external tools (MCP over WebSocket, browser console,
etc.) control a running engine instance, use `CommandBus`
(`src/core/api/CommandBus.js`):

- Never mutate the ECS `world` or `VoxelEngine` state directly from external
  scripts. Always register a command via `engine.commands.register({...})`.
- `window.devoxelAPI` (where wired up by the host app) is the entry point
  for external bridges — call `window.devoxelAPI.execute('commandName',
payload)` rather than reaching into internals.

---

## 8. Verifying changes

This project has no build step for `src/core/` — it's plain ESM. Before
considering a `src/core/` change done:

```bash
# Syntax-check every file you touched
node --check path/to/file.js

# Smoke-test the framework barrel still resolves and a basic engine works
node -e "
import('./src/core/index.js').then(m => {
  const engine = new m.VoxelEngine({ storage: 'flatgrid', mesher: 'greedy', chunkSize: [16,40,16] });
  engine.setVoxel(0,0,0,1);
  console.log('voxel(0,0,0) =', engine.getVoxel(0,0,0));
  console.log(engine.remeshChunk(0,0,0) ? 'mesh OK' : 'mesh FAILED');
}).catch(e => { console.error('FAIL', e); process.exit(1); });
"
```

Renderer backends (WebGL/WebGPU) require a real browser — don't try to
exercise `init()`/`render()` in Node; structural checks (method exists, base
class contract satisfied) are sufficient outside a browser.

If `src/test/` has runnable tests when you read this (check `package.json`
for a `test` script), run them too.

---

## 9. What NOT to do

- Don't hardcode a new storage/mesher/renderer type as a branch anywhere —
  register it as a plugin (§4).
- Don't add a `Plugin` suffix to new class names — see naming convention
  in §4.
- Don't touch WebGPU objects from inside a worker.
- Don't invent your own "AI instructions" file for this repo — extend this
  one so every agent and every human stays in sync.
