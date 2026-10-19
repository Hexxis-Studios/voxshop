# Operate VoxShop through MCP

Use the running local VoxShop MCP server for authoring. Do not edit `.voxshop/projects` directly or poll compatibility-worker files. Do not run shell commands or arbitrary code through a gameplay rule.

1. Call `project_list` and `project_inspect`. Choose the intended project. `project_activate` opens it in the editor.
2. Inspect existing assets, scene nodes, revision and supported tools before changing them. Stable IDs identify entities; names are display labels.
3. Every mutation uses the current `expectedRevision` and a unique `requestId`. Repeat an identical request ID only when retrying identical arguments. On a revision conflict, inspect the newer project and reconcile the intended changes.
4. Use `asset_generate` for asynchronous composable solids, and `job_status`/`job_cancel` for its lifecycle. Use `project_apply` for atomic batches, including `asset.character`, `equipment.fit`, `asset.variant`, `asset.edit`, `node.put`, `scene.put` and `editor.set`.
5. Preserve designated manual edits. Generate under a new asset ID or create a variant before regeneration. Assets are shared by reference across scene instances.
6. Inspect `asset_inspect` and its paged voxel data when needed. Call `preview_capture` for a real static isometric PNG. Check silhouette, materials and dimensions; the preview does not show animated equipment fit.
7. Place scene objects with asset IDs, full transforms and components. A node's parent must exist in the same scene. The entire batch is validated before saving, so dependent assets, nodes and rules may be authored together.
8. Configure rig profiles, landmarks, named sockets and compatible equipment. Generated wearables target the selected body ID. A shell uses compatible skinning; a backpack/blade uses a rigid socket. Do not claim that arbitrary clothing can fit any body.
9. Configure gameplay with supported components and version-1 event/action rules. For new logic, combine events, conditions and bounded actions. Never substitute unrestricted evaluation for a missing engine capability.
10. Run `playtest_run` with repeatable input steps and assertions. Read the final job report. Static image previews and deterministic simulation tests do not prove rendering or human usability; inspect Play in the editor when a browser is available.
11. Use `project_undo`/`project_redo` to reverse whole transactions. Revisions increase even when undoing. `project_save` produces a portable snapshot; ordinary accepted changes already save automatically.
12. Use `game_build` to export a scene. Read the job's artifact path, revision, hash and limits. It must play without the creating agent, editor service or AI connection. Report what was tested and any unsupported features honestly.

`example_create` can create an independently authored exploration or arena starter. The creator can edit every included asset and behavior. Use them as starting points, not as a limit on the kinds of games the engine can author.

Coordinate contract: project units are meters, Y up, rotations are radians. Voxel coordinates and rig bind positions are in asset grid units. Socket positions are relative to a joint in grid units; scene attachment position overrides are in meters. Scale is positive. Starter characters face -Z.
