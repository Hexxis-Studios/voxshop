# VoxShop engine skill

VoxShop is a voxel game engine by Hexxis Studios. Use the connected client's own subscription; optional direct model APIs are separately configured. Both manual editing and MCP mutate the same revisioned projects.

Read `voxshop://agent/workflow` before authoring, then discover `tools/list` and its current schemas. Tool sets differ between local and hosted adapters. The local `project_apply.inputSchema` exposes the transaction union. Never invent tool names, component fields or unsupported scripts.

1. Inspect the project, scene, active player and revision. Use compact inspection to avoid downloading large voxel arrays.
2. Generate or import editable assets. Terrain-cell size and each model's voxel size are independent; tune them in physical meters.
3. Place assets and compose supported components: player controls, colliders, rigid bodies, interactables, items/recipes, rules, objectives, prefabs, HUDs and campaign transitions.
4. Apply small atomic batches using stable IDs, the current revision and a unique retry ID. On conflict, inspect again and preserve manual work. Reuse a retry ID only with identical arguments.
5. Use articulated animation presets as starting points. Tune keys, blending, markers and sockets for the actual model. Imported rigs and clothing need their own joint mappings and fitting.
6. Run bounded simulation playtests, then inspect real connected-editor PNGs before accepting visual changes. Capture multiple angles and motion frames; inspect equipment deformation, lighting, collisions and player-facing UI.
7. Stop Play before editing. Save a portable project backup and export a self-contained browser game; Windows game packaging is a separate build step.

Use `viewport_clients` to find a connected editor. An empty list means no visual client is attached. `viewport_observe` can move the camera, enter Play, advance bounded input and return real PNGs and state. Check project identity/revision; wait for a newly applied revision to load before capturing. Static previews and simulation assertions do not establish visual quality or frame rate.

For a prompted interaction, add an enabled `interactable` component with a useful prompt and physical reach, plus a version-1 rule for `interact`. Enter its range, verify the rendered prompt, press the interaction input once, and inspect the result. Validate prerequisite items, objectives and disabled/out-of-range behavior where relevant.

Portable project/model documents preserve editable engine data. Mesh exports have different capabilities; do not promise that every legacy model format preserves scene rules, equipment or new animation features. Save before clearing storage or moving installations.

See `voxshop://engine/findings` and the current limits resource for supported behavior and known constraints. Game genres are not permanent architectural restrictions.
