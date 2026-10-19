# Engine and MCP API

The React editor and stdio MCP server call one authenticated loopback broker. The broker owns the `ProjectStore`, validated operations, persistence, undo/redo and jobs. Rendering and simulation consume the same saved project contract. There is no separate agent-only mutation implementation.

## Source map

| File                          | Responsibility                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `services/modelDocument.ts`   | Native model and legacy-array normalization                                     |
| `services/modelCommands.ts`   | Complete reversible voxel edit records                                          |
| `services/projectDocument.ts` | Versioned project/asset/rig/scene/component schemas and atomic operations       |
| `services/recipeGenerator.ts` | Deterministic bounded shape composition                                         |
| `services/assetAssembly.ts`   | Original character families, initial fitted equipment and legacy-rig conversion |
| `server/projectStore.ts`      | Serialized writes, revisions, retry receipts, atomic files and recovery         |
| `server/app.ts`               | Authenticated routes, events, provider adapter and jobs                         |
| `mcp/server.ts`               | Typed MCP tools using the broker                                                |
| `runtime/GameSimulation.ts`   | Fixed-step shared gameplay without DOM or WebGL                                 |
| `runtime/assetMesh.ts`        | Material-aware surface meshing, skinning, attachments and animation             |
| `runtime/GameViewport.ts`     | Rendering, authoring selection, input, cameras and Play/Stop                    |
| `runtime/playtest.ts`         | Bounded deterministic inputs and assertions                                     |
| `server/gameBuild.ts`         | Compact scene selection and independent HTML export                             |

## Documents and commands

Projects use `format: "voxshop-project"`, `version: 1`, stable IDs, a monotonic revision, meter units and Y up. Native asset model envelopes use `format: "voxshop-model"`, `version: 1`. Unsupported versions fail instead of being partially imported.

The MCP `project_apply` tool accepts:

```json
{
  "projectId": "my-game",
  "expectedRevision": 0,
  "requestId": "make-prop-001",
  "label": "Generate and place a prop",
  "operations": [
    {
      "type": "asset.generate",
      "id": "crate",
      "name": "Crate",
      "recipe": {
        "version": 1,
        "seed": 0,
        "shapes": [{ "kind": "box", "center": [0, 5, 0], "size": [10, 10, 10], "color": 10855845 }]
      }
    },
    {
      "type": "node.put",
      "sceneId": "main",
      "node": {
        "id": "crate-instance",
        "name": "Crate",
        "assetId": "crate",
        "transform": { "position": [2, 0, 0] },
        "components": [{ "type": "collider", "size": [1, 1, 1], "offset": [0, 0.5, 0], "solid": true }]
      }
    }
  ]
}
```

The broker applies the batch to a detached document and validates the final state. Missing assets, hierarchy cycles, dangling rule targets, incompatible equipment and invalid skinning reject the whole batch. Asset deletion is blocked while referenced. Node deletion cascades to its children; external rule references must be removed in the same batch.

Accepted operations: `project.rename`, `asset.put`, `asset.rename`, `asset.delete`, `asset.generate`, `asset.character`, `asset.edit`, `asset.variant`, `equipment.fit`, `scene.put`, `scene.delete`, `node.put`, `node.delete`, `editor.set`. `asset.put`, `scene.put` and `node.put` replace their full record. Use inspection before replacing one, and preserve wanted fields.

Limits include 256 operations per transaction, 1,000 assets, 100 scenes, 5,000 nodes per scene, 250,000 voxels per asset and one million per project. Recipes allow 256 shapes and four million cell evaluations. The HTTP request limit is 25 MiB, so a document below a count limit can still exceed its serialized request-size limit. These are upper bounds, not performance guarantees.

Generation shapes support add/subtract/paint over boxes, ellipsoids, vertical cylinders and deterministic seeded terrain. Later shapes override earlier cells. Regeneration requires a new ID so it cannot silently erase sculpt edits.

## Rigs and equipment

Rig definitions contain profile/version, named joints with parent and absolute bind positions, landmarks, sockets and clips. Bind and socket coordinates use asset grid units. A voxel can have up to four named weights summing to one. A socket's transform is local to its joint. Scene attachment position overrides are meters; rotation is radians.

Clips have duration, loop, authored locomotion speed, named joint tracks and timed events. Runtime playback scales locomotion to movement speed. Marker events can drive version-1 rules with `event: "animation"` and an optional `marker` filter. Geometry optimization retains faces between regions with different skinning so motion can expose those surfaces.

The initial equipment fitter requires `torsoMin`/`torsoMax` landmarks. Body shells share the selected body rig and hide a declared body region; backpacks and blades attach rigidly to sockets. Equipment declares the exact body it was fitted against. Custom rigs and hand-authored assets use the same contracts, but arbitrary remapping/fitting is not automatic.

## Gameplay API v1

Components: `player`, `collider`, `collectible`, `gate`, `health`, `enemy`, `patrol`, `animation`, `rules`.

Rules listen for `start`, `interact`, `touch`, `tick`, `destroyed`, `attack` or `animation`. They can run once, use a tick interval, and compare a numeric scene variable with `>=`, `<=`, `==`, `>` or `<`.

Actions: `set`, `add`, `destroy`, `enable`, `message`, `win`, `lose`, `damage`, `teleport`. Actions are bounded to 4,096 per simulation step. This deliberately scoped language is the first custom-logic extension API. It provides no network, filesystem, shell or arbitrary evaluation capability.

Simulation uses 60 fixed steps per second, normalized movement, gravity/jump, conservative transformed AABBs, collision substeps and scene bounds. Solid static colliders block movement. Enemies pursue directly and melee combat checks range; there is no pathfinding or general rigid-body simulation. Trigger rules and collectibles use intersection with the player's collider. Play mode operates on a cloned scene, and Stop reloads authored transforms and enabled state.

## Playtests

`playtest_run` accepts a scene ID, input steps and assertions:

```json
{
  "projectId": "my-game",
  "sceneId": "main",
  "steps": [{ "frames": 120, "input": { "moveX": 1, "moveZ": 0 } }],
  "assertions": [{ "type": "no-errors" }, { "type": "variable", "name": "score", "minimum": 1 }]
}
```

Input fields: `moveX`, `moveZ` in -1..1, `jump`, `interact`, `attack`. Jump/interaction/attack use rising edges; release between repeated attacks. Assertions support `status`, `variable` minimum, `position` near/tolerance, `enabled`, and `no-errors`. At most 18,000 frames run per scenario. Reports include source revision, assertion results, runtime state, events, errors and elapsed time. This is simulation evidence, not a renderer benchmark.

## MCP tools

`project_list`, `project_create`, `project_inspect`, `project_activate`, `project_apply`, `project_undo`, `project_redo`, `project_save`, `asset_generate`, `asset_inspect`, `preview_capture`, `example_create`, `playtest_run`, `game_build`, `job_status`, `job_cancel`, `diagnostics_read`.

Tool discovery returns their current schemas. `asset_inspect` pages raw voxels (up to 2,000 per call). PNG previews are bounded to 40,000 surface voxels. Generation/test/build jobs return IDs and structured results. The MCP process writes only protocol messages to stdout.

The SDK client integration test launches a separate process and calls these tools without UI clicks or compatibility files. It also creates both examples, runs their complete simulation scenarios and builds their standalone exports.

## Export and extension boundary

`game_build` includes one selected scene and only referenced assets, stripping generation recipes, unused variants and editor drafts. Geometry, materials, joints, animation and attachments remain. Runtime code is bundled into the HTML; Three.js notices are included. No provider credentials, editor API connection, MCP or external asset/font URL is needed.

The standalone page exposes `window.VoxShopGame` API version 1: `inspect()`, bounded `step(input, frames)` and `restart()`, for creators' external harnesses. It is local gameplay control, not a privileged authoring API. Future features should extend the shared document, command and runtime contracts with migrations and validation, rather than introduce an agent-only shortcut.
