# First reliability repair

This change starts the shared engine foundation described in the VoxShop audit and MCP plan.

## Implemented

- One renderer-independent reader/writer for versioned native model documents, legacy voxel arrays, and compact GLB voxel metadata.
- Native JSON, browser library saves, and templates retain materials, bones, weights, locks, and skeleton/animation profiles. Black stays black; display tints are not saved as authored colors.
- Reversible commands store complete voxel records. Fill, Paint, Add, Delete, Lock, Move, Flip, Rotate, Resample, and completed reconstructions use these commands. Symmetry overlaps are deduplicated; moving onto occupied voxels is rejected.
- Reconstruction commits exactly its validated target, including smaller and empty targets. Saves during the effect contain the target geometry, and undo restores the previous model. Completion waits for all three position axes.
- Add can place the first voxel directly on the empty scene's floor plane.
- Mesh buffer capacity uses the supported instance attribute capacity, and new instances are populated immediately. Model switches clear stale rigs and reconstruction targets. Cleanup releases controls, listeners, render targets, mesh resources, and shadow resources.
- Direct AI edits now include the current voxel model. Both generation paths use the shared voxel validator. No live AI provider calls were made during validation.
- Save, Template, and Rename use an in-app naming dialog instead of native browser prompts. A failed browser-library write keeps the dialog open with an error. Native JSON can be downloaded as a file.

The core modules are `services/modelDocument.ts` and `services/modelCommands.ts`. They do not depend on a canvas or renderer. This is an initial extraction; the rest of the existing engine is still combined in `VoxelEngine.ts`.

## Validation

`npm test`: 28 passing checks covering save/open, shipped preset compatibility, complete undo/redo records, locked voxels, reconstruction completion, transforms, replay history, buffer reuse, and empty-grid pointer placement. Engine tests use real Three.js geometry and engine methods without constructing a WebGL renderer.

`npm run lint` and `npm run build` pass. The existing large-bundle and mixed static/dynamic Three.js import warnings remain.

The browser smoke check placed a voxel into a blank scene and applied a material Fill. The final native persistence check imported a three-voxel model containing glass, metal, emission, black, a locked weighted voxel, and a custom skeleton with animation; saved it through the new dialog; refreshed; reopened it from the library; and downloaded JSON. The reopened data and downloaded file were semantically identical to the input, including the full skeleton. A synthetic `Repair verification` model remains in the test browser's library. No user models were removed.

The embedded browser's rejection of the old native `prompt()` exposed the naming issue during verification; it was replaced and the Save workflow was retested successfully.

## Boundaries

This is the first repair batch, not the complete engine or complete Phase 1. Browser recovery/IndexedDB, stable project/asset IDs, the local bridge's access controls and job queue, dependency advisories, and MCP transport/tool integration remain follow-up work. Browser library storage is still localStorage; JSON download is the portable backup. Non-native export appearance and every external format are not certified by these checks. Existing saves that already lost metadata cannot recover the missing information automatically.
