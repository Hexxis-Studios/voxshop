# Verified engine findings and alpha limits

VoxShop 2 alpha supports Windows desktop authoring, local browser authoring, self-contained browser games and Windows game packaging. Linux packaging is deferred. The Tauri shell packages the existing renderer and local service; it does not itself increase rendering throughput.

- Project transactions are revisioned, atomic, retryable and immediately saved. Undo/redo is bounded to 20 entries and 32 MiB. Import creates a separate project. Keep portable backups.
- Local stdio MCP exposes shared authoring and real connected-editor viewport tools. Client setup examples do not certify every third-party agent or subscription. Voice is supplied by the chosen agent.
- Biped, machine and quadruped presets provide editable articulated motions. Joint weights, retargeting, socket fitting, blend timing and animation markers are authorable. Arbitrary imported rigs still need deformation review.
- Seeded worlds use bounded chunk streaming, sparse edits and coarse distant geometry. Model and terrain voxel spacing are independent. Coarse sampling can omit small distant openings; near blocky terrain and distant approximations may have visible transitions.
- Unedited heightfields use smooth sampled collision beneath a blocky visual surface. Edited and voxel3d terrain use voxel collision. Do not assume exact visible-cell contact on every heightfield slope.
- Standalone games preserve campaign scene state, actor motion, inventory, terrain edits and compatible physics snapshots in local saves. Saves are scoped to the browser origin/profile; automatic cross-device sync is not supplied.
- Multiplayer uses a project-bound authoritative host. Two-client local play, reconnect and host-restart recovery were accepted. Public matchmaking, broad internet-latency/scale testing and hosted infrastructure are not supplied.
- Gamepad mappings and touch layouts are implemented. Physical device coverage, other GPUs and low-end hardware remain broader compatibility work. Audio has automated schema/runtime coverage; sound quality is not certified by that coverage.
- Render callbacks, CPU time, GPU query time and monitor-presented frames are separate measurements. Uncapped rendering does not guarantee a particular visible FPS. Browser/WebView compositors still control presentation.
- Rapier exports require `script-src 'wasm-unsafe-eval'`; general JavaScript eval remains disabled. Keep secure/loopback multiplayer policy parity between HTML and native players.
- Standalone startup must preserve an already restored simulation. Re-entering Play during walkthrough initialization discards its save. Only explicit reset should restart the game.
- Framing large terrain must fit fog distance as well as camera clipping. When an entire world looks like sky, inspect fog and camera bounds before changing terrain data.

The automated and visual acceptance fixtures establish their tested workflows, rather than every genre, device or performance target. Report new reproducible findings with the affected contract, check and limitation; do not include private project data, credentials or local execution diaries in shared guidance.
