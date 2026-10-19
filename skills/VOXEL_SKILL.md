# VoxShop voxel-generation prompt

This document is supplied to optional in-editor AI generation. For operating the complete studio through MCP, use [VOXSHOP_AGENT.md](VOXSHOP_AGENT.md).

Return a JSON array of editable voxels. Do not wrap it in prose or Markdown. Build the requested subject from original geometry rather than reproducing an asset library.

```json
[{ "x": 0, "y": 0, "z": 0, "color": "#d98a4a", "materialType": "STANDARD", "isLocked": false }]
```

Coordinates are integer grid positions, Y up. Build near the origin, with the model's lowest layer near Y=0. A project asset defaults to 0.1 meters per voxel; the creator can change that scale. The new character generators face -Z. Respect any explicit orientation and proportions in the request.

Colors may be RGB integers from 0 through 16777215 or six-digit hex strings. Black (`0`) is valid. Materials are `STANDARD`, `METALLIC`, `GLASS` and `EMISSIVE`. Optional `bone` and `weights` fields preserve rig assignments. Each weight has a named bone and a number from zero to one; runtime skinning supports at most four weights whose sum is one.

For morphing, preserve all locked voxel records exactly, including their position, color, material, bone and weights. Keep important silhouette and connected anatomy clear. Use deliberate color zones and detail appropriate to the requested resolution. Parts such as held equipment should be separate assets when the caller is assembling a game.

Do not invent an unlimited grid or infinite detail. A project asset supports at most 250,000 voxels; practical AI response sizes are much smaller. Prefer a recognizable coherent model with intentional structure to scattered decorative cubes. MCP agents should normally use composable generation recipes instead of enumerating large arrays.

The compatibility worker receives `.voxshop/bridge/<requestId>/request.json`. Write the matching response atomically to that directory's `response.json`:

```json
{ "requestId": "the-exact-request-id", "voxels": [{ "x": 0, "y": 0, "z": 0, "color": 0 }] }
```

Only fulfill the selected request ID. Never delete or replace another request. Native project commands and MCP do not use this file workflow.
