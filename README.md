# VoxShop 2 Alpha

**A free voxel game engine and creative studio by Hexxis Studios.** Create editable models, animate characters, build worlds and gameplay, then export games for the browser or Windows. Work manually or connect your own AI agent through MCP.

This is **2.0.0-alpha.1**, an early-access release. The original voxel workshop is still included, with a new game-authoring workflow around it.

## Download

- [Windows installer and release notes](https://github.com/Hexxis-Studios/voxshop/releases/tag/v2.0.0-alpha.1)
- [VoxShop on itch.io](https://hexxis-studios.itch.io/voxshop)

On Windows, run the installer and launch **VoxShop**. Node is bundled; no developer tools or AI account are required for editing or playing games. The installer may download Microsoft's WebView2 runtime if it is missing. The alpha installer is not code-signed, so Windows may show an unknown-publisher warning. Linux packages are not included in this release.

## Make your first game

1. Open **Crystal trail**, **Arena**, **Survival** or **Construction**, or create a blank project.
2. Choose **Generate** for editable characters, creatures, machines, props and terrain. Import or sculpt your own assets in the workshop.
3. Place assets in a scene. Use the inspector for transforms, hierarchy, equipment, collisions and gameplay components.
4. Add items and crafting recipes, interactions, objectives, rules, HUDs and scene transitions. Rig Editor provides editable animation keys, blending, markers and sockets.
5. Press **Play**. Default controls include WASD/arrows, Space to jump, E to interact, and F/click to attack. Player controls can be remapped.
6. **Save project** makes a portable editable backup. **Export game** downloads a self-contained HTML game that can run without VoxShop or an AI service. [Windows game packaging](docs/windows-game-export.md) is available from source.

## Use your own agent

Open **Connect agent** in VoxShop and copy the configuration for a client that supports local stdio MCP. Configurations are provided for Codex, Claude Code/Desktop, Gemini CLI, OpenCode, Muse Code and generic clients. Third-party client support depends on its MCP implementation and account capabilities.

Ask, for example:

> Build a small exploration game with a backpack-wearing creature, five crystals and a gate that opens when I collect them. Inspect the scene and animations, run its playtest, and export the game.

The agent discovers the authoring tools and shared guidance from VoxShop. Your existing agent subscription stays with that provider. Voice comes from your agent's interface. Optional direct model APIs use separate credentials and billing; they are not required.

## What is included

- Voxel sculpting, materials, image/text/mesh conversion and model import/export.
- Biped, quadruped and machine starters, custom rigs, weighted skinning, articulated animation presets, retargeting and fitted equipment.
- Scene hierarchy, linked prefabs, procedural worlds, independent model/terrain voxel sizes and sparse terrain editing.
- Player movement, physics bodies and joints, enemies, interactions, combat, inventory, crafting, construction and editable HUDs.
- Objectives, campaign variables, scene transitions, local saves and repeatable playtests.
- Authoritative multiplayer hosting and room joining in editor Play and exported games.
- Chunk streaming, greedy meshing, spatial instancing, culling and distant terrain detail.

These are composable systems rather than fixed game genres. See the [engine/API guide](docs/engine-api.md), [multiplayer hosting](docs/multiplayer-hosting.md) and [alpha limits](skills/ENGINE_LIMITS.md).

## Save your work

The Windows editor stores projects in its OS application-data directory. Source-run projects default to `.voxshop/projects/`. Accepted edits save immediately; undo/redo is bounded. **Save project** exports a portable `.voxshop.json` backup, and Import creates a separate project. Make a backup before updating or clearing application/browser data.

Old workshop libraries migrate when found at the same browser origin. A desktop install cannot automatically read a different browser's storage; export and import your models/projects when moving between them. Game saves are local to their origin/profile, with portable save export/import available in the game menu.

## Run from source in a browser

Install the latest supported Node.js LTS (24.22.1 or newer), then:

```sh
npm ci
npm run build
npm start
```

Open [localhost:4269](http://localhost:4269). For development, `npm run dev` starts the editor at [127.0.0.1:3000](http://127.0.0.1:3000). The engine does not require Sites or a hosted account. See [desktop builds](docs/desktop.md), [storage and security](docs/storage-and-security.md) and [contributor checks](docs/verification.md).

Installers contain the app and required dependencies/notices. Consumer source archives omit development tests, generated evidence and private tooling; clone the repository for the complete contributor checks.

## Alpha status and feedback

Windows/browser creation, persistence, exports and local multiplayer have passed automated and visual acceptance. Hardware coverage is limited; physical controller/touch testing and internet multiplayer coverage are still developing. Coarse terrain transitions and smooth-heightfield collision approximations are documented. This release makes no universal FPS or every-game compatibility guarantee.

[Report a problem](https://github.com/Hexxis-Studios/voxshop/issues) with reproduction steps, your platform and the expected/actual behavior. Share a minimal project only if you intend to make it public. Avoid posting credentials or private files.

## License

VoxShop 2 is **source available**, based on PolyForm Noncommercial with the [supplemental terms in LICENSE](LICENSE). **Individuals and studios may create and sell their own games and assets royalty-free.** Selling or monetizing VoxShop itself or a derivative editor/engine requires separate permission. Free public forks must preserve attribution and provide source; modified products must use their own branding. See [commercial licensing](COMMERCIAL-LICENSE.md).

Previously published Apache-licensed code retains its existing rights. Third-party dependencies retain their own licenses and required notices.

Built by **[Hexxis Studios](https://hexxis-studios.github.io/)**. [Support development](https://www.paypal.com/ncp/payment/MNF5JL9WPEJ92).
