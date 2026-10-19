# Verification record

Date: October 18, 2026 (October 19 UTC). Local source: `codex/reliable-model-editing`, based on `17802cd15db20d93fa3d274dd2cb17ac1ccec52d`, with the engine implementation described in this repository. Both accounts' separate Sites source repositories were pushed and privately deployed. GitHub delivery and any later CI result are recorded in `delivery-checkpoint.md`. Environment: Windows, Node v24.14.0. This record is evidence of the checks below, not a certification of every platform, format or asset combination.

## Automated checks

- TypeScript check passes, including strict null checks.
- 48 tests pass: canonical document/legacy input, full-record voxel undo/redo, reconstruction, authoritative save state, replay cancellation, late image imports, canonical locked/black colors in legacy binary round trips, oversized volume rejection, project transactions, cross-reference validation, restart persistence, retry receipts, conflicting writers, disk recovery, IndexedDB ownership/stale-write handling, job cancellation, broker locking, shape budgets, rigs/equipment, animation markers, collision and both game objectives.
- External MCP integration launches a separate process. It discovers tools, creates and generates an asset, receives a PNG, edits it, undoes the edit, saves and reopens the exact document. It then creates both example projects, runs their complete win scenarios and builds the games. The integration workspace is inside a hidden `.voxshop` directory; both authenticated HTTP downloads match their build hashes, and anonymous downloads are rejected.
- Standalone build assertions check compact referenced assets, safe embedded project JSON, absence of external script/style references, blocked runtime networking, license notices, source revision, file byte counts and SHA-256 digests.
- `npm audit` reports zero known vulnerabilities for the installed dependency graph at this run. This is a dependency advisory result, not a full security audit.
- New engine/server/MCP modules pass the configured formatter. `git diff --check` passes; Windows Git may print line-ending normalization notices.

## Built production path

`npm run verify:release` successfully starts the built production broker in an isolated workspace and connects the built stdio MCP server through a separate SDK client. It verifies the served production editor HTML, 17 discovered tools, both game objectives, independent HTML build hashes, authenticated game download hashes and exact portable-project equality.

The generated report is `.voxshop/release-verification/report.json`. Artifacts are:

- `.voxshop/release-verification/games/release-exploration-main-r0.html`
- `.voxshop/release-verification/games/release-arena-main-r0.html`
- `.voxshop/release-verification/exports/release-exploration.voxshop.json`
- `.voxshop/release-verification/exports/release-arena.voxshop.json`

The report records exact sizes and hashes. The initial artifacts were approximately 1.34 MB and 0.83 MB, respectively. Rerunning verification can regenerate them; consult the current report for exact hashes.

The editor's initial compressed JavaScript remains about 308 kB plus a lazy-loaded sculpt chunk of about 61 kB compressed. Vite reports a large-chunk warning. Zod also emits two dependency comment-annotation warnings during bundling; compilation succeeds. These warnings are not hidden or treated as test failures. No renderer performance claim is made from bundle size alone.

## Browser observations already performed

Earlier in this implementation session, browser automation verified:

- Empty-grid Add creates the first voxel; Fill updates color/material; native save, reload, reopen and downloaded JSON retain the full fixture.
- In-app model Save works after replacing unsupported native `prompt()`.
- The new workspace displays the generated exploration scene, asset library and asset inspector.
- Opening a rigged asset in Sculpt displays the existing sculpt tools and geometry.
- Real keyboard movement in exploration collects five crystals, opens its gate and reaches the visible win state with no runtime errors reported in its inspector.
- Stop restores the authoring scene at its unchanged project revision.

`evidence/exploration-play.png` records that observed win state. It predates later reliability fixes and is not a screenshot of the final source state.

## Final editor browser verification

The supported built-in browser responded again during this continuation. It initially reported no existing tab; a fresh tab opened the production editor on loopback port 4330 with an isolated `.voxshop/browser-acceptance` workspace. This continuation did not change browser permissions or restart the browser bridge. The cause of the earlier outage has not been established.

Observed through the actual UI:

- Project create, rename, download, import, switching and reload. Imported assets and scenes were also compared with the downloaded document and matched exactly.
- Creature generation, independent variant, scene placement, fractional position/rotation, collider authoring, parenting, object deletion and undo. The browser caught invalid numeric input stepping that prevented default scale `1` from submitting; the corrected inputs successfully saved position `2.25`, rotation `30.5` degrees and collision at a new revision.
- A separate stdio MCP client changed the selected object's name and position. The hierarchy updated live while pending manual edits remained intact. Applying the stale edit produced a revision conflict; resetting fields loaded the agent values, and a subsequent manual edit saved successfully on the new revision.
- Network interruption through the tab's supported development API, a real sculpt edit, failed save, restored connection, reload and recovery into a separate asset. The original assets remained unchanged. A second pass caught and corrected dropped recovery metadata; the recovered asset retained its original voxel size, pivot and eight-joint rig. The temporary network emulation was restored.
- A further pass made an offline sculpt change while a separate MCP client painted the same source asset. The stale sculpt save was rejected at revision 10. After reload, keeping the recovered asset saved both versions; the agent-updated source still matched its pre-recovery document exactly.
- Text-to-voxel creation produced 885 voxels. An OBJ tetrahedron imported at resolution 12 produced 369 voxels and saved as a named project asset through the in-app dialogs.
- Real keyboard input won exploration with five crystals and arena with three defeated enemies. Both runtime inspectors reported no errors. Stop restored each authoring scene at revision 0.
- Both game exports downloaded successfully after correcting Express's hidden-directory handling. The final editor gameplay pass produced no captured warning/error logs.

Screenshots: `evidence/final-editor.jpg`, `evidence/final-editor-exploration-win.jpg`, and `evidence/final-editor-arena-win.jpg`.

The structured browser observation and download-integrity record is `.voxshop/browser-acceptance/report.json`. It labels observations separately from unverified independent-file gameplay.

## Hosted edition and remaining verification

The Sites production build and hosted TypeScript check pass. `node scripts/verify-hosted-api.mjs` passes 11 groups against standard Request/Response handlers with real Miniflare D1/R2 bindings, including authenticated ownership, revision conflicts, history, jobs, portable documents, both game objectives, standalone build integrity and 17 MCP tools. Its report explicitly records that this is API verification, not browser or live-deployment verification.

The earlier `NOT_FOUND` response was explained by the user's ChatGPT account switch. A new owner-private copy was registered under the current account, using the retained application source. The original Site and source checkout remain intact; its identity is preserved in `.openai/hosting.original-account.json` and checkout in `.voxshop/sites/voxshop-original-account`.

Native Sites verified deployment success at `https://voxshop-studio.tr9yqntxdy.chatgpt.site`, project `appgprj_6ad57ad2fc908191b9c051297649d381`, deployment `appgdep_6ad57bfa24b08191a44c345f1c65364b`, source commit `732451ce59bf0dea2678fe09adcaec133cdfe76a`. Owner-only access is confirmed. D1 inspection confirms the deployed schema, and production logs show successful authenticated session, project creation/read and event requests. The native MCP connection is provisioned and its plugin is installed; an actual plugin tool invocation from this chat remains unverified because its tools are not yet exposed to the chat.

The in-app browser reached the normal ChatGPT account chooser. The user identified the active Chrome profile as Alex. Read-only inspection originally found no connector in that profile, explaining its absence from the inventory. After the user installed it, the supported inventory exposed Alex and successfully bound the existing VoxShop tab. No Chrome settings, extensions or permissions were changed by the agent.

Observed in the actual signed-in Alex production tab:

- Created an isolated cloud project and generated a 1,782-voxel quadruped with an eight-joint rig. Both survived reload.
- Placed its scene instance, saved position X `2.25` and rotation Y `30.5` degrees, reloaded and confirmed the saved values. The portable project download contained the same geometry, rig and transform.
- Restored the original rainbow voxel wordmark. The first hosted build exposed a `file://` image URL; an explicit `?url` asset import corrected it. The next browser pass confirmed a loaded image with natural width 1,013 and visibly showed the logo.
- Won Crystal trail with five crystals and arena with three defeated enemies using real keyboard input. Both runtime inspectors reported no errors. Stop restored authoring revision 0.
- Downloaded both games. Their bytes exactly match rebuilding the embedded project with the shipped runtime: exploration 1,341,736 bytes, arena 831,383 bytes. This is download integrity evidence, separate from independent-file gameplay.
- Ran the arena scenario through the hosted editor. All three assertions passed and its downloaded report recorded a win, three kills and no errors.

Screenshots are `evidence/hosted-branding.jpg`, `evidence/hosted-exploration-win.jpg` and `evidence/hosted-arena-win.jpg`. Exact hashes and observations are in `.voxshop/sites/hosted-browser-acceptance.json`. The automated download-event observer timed out once; the actual downloaded project and games were subsequently found and verified. The app's downloads succeeded.

Chrome refused the hosted import file chooser because the extension lacked file-access permission. No alternative upload path or permission change was attempted. The hosted API fixture's portable import still passes. The generator's new automatic selection and **Place first asset** guidance were added afterward and pass both builds/typechecks, but their final browser check remains pending.

After the user switched back to Hexxis/Daymien, native Sites located the original Site and published the retained updated source there. It is owner-private at `https://voxshop-studio.soft-corgi-2100.chatgpt.site`, deployment `appgdep_6ad5904d9a5c8191b056afc530892166`, saved source `565c77d8270ec33ed40ed1897486472185b0758c`, with MCP enabled. The original account's plugin is installed; its tool names are not yet exposed to this chat. The supported browser inventory now reports local browser use disabled in Work settings, so the original account's final browser acceptance is unverified. No settings or bridge processes were changed. The full built release check and the original checkout's 11 D1/R2 API groups passed again after these source changes.

Direct opening of an exported `file://` URL was rejected by the browser tool's protocol policy, which permits HTTP/HTTPS. That restriction was not bypassed. Independent-file gameplay, restart and browser-log checks therefore remain unverified, despite passing shared-runtime scenarios, export-integrity checks and actual editor gameplay. Remote Windows/Linux CI has not been triggered. Existing legacy conversion formats and arbitrary imported clothing have not received comprehensive interoperability certification.
