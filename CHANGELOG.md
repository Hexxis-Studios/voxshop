# Changelog

## 2.0.0-alpha.1

VoxShop grows from a voxel asset workshop into a voxel game-authoring studio. This is an early-access release for Windows and browser users.

- Added a Windows desktop installer with a bundled local service and MCP adapter.
- Added durable projects, undo/redo, recovery and portable project backups.
- Added editable gameplay scenes, components, rules, objectives, campaign transitions, inventory, crafting, construction and HUD authoring.
- Added physics bodies/joints, player movement, enemies and authoritative multiplayer rooms.
- Improved rigging with articulated animation presets, editable tracks/markers/blending, retargeting, sockets and fitted equipment.
- Added procedural streamed worlds, editable terrain and independent terrain/model voxel scales, with chunk meshing, instancing, culling and distant detail.
- Added self-contained browser game exports and Windows game-player packaging.
- Added agent discovery, revisioned authoring tools and connected-editor visual walkthroughs using compatible agents' own subscriptions.
- Preserved the original VoxShop logo and updated the publisher to Hexxis Studios.
- Introduced source-available v2 licensing with explicit royalty-free commercial game/asset output permission. Previously Apache-licensed code retains its existing rights.

### Alpha limits

Linux packages are deferred. Broader hardware/input-device coverage and real-internet multiplayer testing remain ongoing. Distant terrain and smooth-heightfield collision use documented approximations. Gameplay authoring uses supported components/events/actions; arbitrary user script execution and public matchmaking are not supplied. See [current limits](skills/ENGINE_LIMITS.md).

### Updating

Export a portable project backup before installing. The application identifier and project document format remain compatible; the engine version change does not renumber project/model schema version 1. Browser-origin storage remains separate from desktop storage.
