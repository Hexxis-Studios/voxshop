# Delivery checkpoint

The first voxel game creation loop is implemented: original editable asset generation, sculpting, rigs and equipment, shared assets, scenes, gameplay components and rules, Play/Stop, repeatable playtests, saved projects, conflict recovery, standalone HTML exports, local MCP and hosted MCP handlers.

The original VoxShop branding is restored. New generation opens the asset inspector automatically and an empty scene with assets offers **Place first asset**. Hosted workspace and connection messages accurately refer to the hosted service.

## Active account and source

- Active account: Hexxis/Daymien. Private Site: https://voxshop-studio.soft-corgi-2100.chatgpt.site
- Site ID: `appgprj_6ad557f264ec81918ea056c8c4baf40e`.
- Hosted checkout: `.voxshop/sites/voxshop-original-account`.
- Pushed hosted source: `565c77d8270ec33ed40ed1897486472185b0758c`.
- Successful deployment: `appgdep_6ad5904d9a5c8191b056afc530892166`.
- Hosted MCP: https://voxshop-studio.soft-corgi-2100.chatgpt.site/mcp
- Installed plugin: `plugin_asdk_app_sites_51dee730bc448191ae0b713d1926de20`.
- Alex copy remains separate at https://voxshop-studio.tr9yqntxdy.chatgpt.site, checkout `.voxshop/sites/voxshop`, source `d512d497e67c2f4fe3f38cb7e9f02c43b6ffa827`.
- Root `.openai/hosting.json` selects the original account. Both identity backups remain in `.openai/`. Source synchronization selects by project identity and rejects a mismatched checkout. Never register another Site just because the selected account cannot access one.

## Verification

48 automated tests, both production builds, both TypeScript checks, the separate built broker/MCP release check, and 11 hosted D1/R2 API groups pass. GitHub's Windows and Linux CI also passed the implementation commit. Local browser verification passed project CRUD/import, sculpt recovery including concurrent agent edits, live MCP updates, both keyboard wins and downloads. Alex production verification passed cloud creation, generation, placement, fractional transforms, persistence after reload, portable download, both keyboard wins, both game downloads and the arena scenario. Downloaded HTML matches rebuilding its embedded project exactly. Evidence and exact hashes are in `verification.md` and `.voxshop/sites/hosted-browser-acceptance.json`.

The original account's installed plugin subsequently completed authenticated production calls: project creation, recipe generation, SVG preview, rigged character and fitted equipment, a new custom game scene with a win rule, passing playtest, durable undo/redo, build, save, portable import and exact asset/scene comparison. Both example game scenarios and builds also passed through that installed plugin. The active project is **Beacon trail · Agent-built**, revision 5. Its custom scenario won after 54 frames without errors. Detailed results are in `.voxshop/sites/original-account-mcp-acceptance.json`.

## Remaining verification

The original account's final browser pass and the latest generator guidance remain unverified: after switching back, the supported browser tool reported local browser use disabled. Hosted import automation was blocked by Chrome's connector file-access setting; the API import fixture passes. Independent-file browser gameplay was blocked by the tool's file-URL policy; shared-runtime gameplay and export bytes pass. No settings or browser bridge processes were changed to work around these errors.

The hosted MCP acceptance is complete; it is separate from the browser checks still limited above.

Native mobile builds, multiplayer, a marketplace, arbitrary scripting, streaming worlds and general rigid-body physics are outside this implemented milestone. The app is a working voxel game studio foundation, not a claim of feature parity with Unity, Unreal or Godot.

## GitHub delivery

The source is pushed on `codex/reliable-model-editing` in [draft PR #1](https://github.com/Hexxis-Studios/voxshop/pull/1). Implementation commit `93765e18a5001b4053e0f336281236caba489a3b` passed [Windows and Linux CI](https://github.com/Hexxis-Studios/voxshop/actions/runs/39195756455), including clean installation, typecheck, all 48 tests, build and production dependency audit. Main is not modified automatically. A following documentation-only commit records this final evidence.
