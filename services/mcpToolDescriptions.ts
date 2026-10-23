export const MCP_TOOL_DESCRIPTIONS = {
  projectInspect:
    'Inspect project revision, scenes and authoring details; use compact to omit voxel arrays or full for portable data. Discover the schema with tools/list first.',
  projectApply:
    'At expectedRevision; use returned appliedRevision, re-inspect before iterating, send unique requestIds. prefab.instantiate remaps references; supports asset.animation-preset.',
  assetGenerate:
    'Generate an editable asset from a recipe; returns a job. Use a new ID or variant to preserve authored assets.',
  assetInspect:
    'Inspect bounds, rig, provenance and recipe. Voxel data is optional and paged to avoid huge tool results.',
  multiplayerRoomList:
    'List active local multiplayer rooms, capacity and any bound project revision/scene. Room and reconnect credentials are never included.',
  multiplayerRoomCreate:
    'Create a local multiplayer room, optionally bound to a current project revision and scene. The credential is returned once; share it only with intended players and keep it out of public logs.',
  multiplayerRoomDelete:
    'Close a local multiplayer room and disconnect its players. This action cannot be undone.',
};
