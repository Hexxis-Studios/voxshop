# VoxShop

A voxel game studio with a private hosted editor and a local desktop workspace. Generate original editable assets, sculpt them, rig and equip characters, build scenes, author gameplay, playtest, and export independent browser games. Compatible agents can operate the same project through MCP.

VoxShop uses React, TypeScript and Three.js. The first engine milestone targets desktop browsers with keyboard/mouse and WebGL2. It includes a flexible component and event/action system; it does not aim for feature parity with Unity, Unreal or Godot.

## Start

Open [VoxShop Studio](https://voxshop-studio.soft-corgi-2100.chatgpt.site) and sign in with its owning ChatGPT account to use the private hosted editor. Built-in generation, cloud saves, gameplay and exports run there without a local installation. The separate Alex-account copy remains at [its existing address](https://voxshop-studio.tr9yqntxdy.chatgpt.site); each account has separate saved projects.

For a local workspace and desktop MCP server:

Install Node.js 24 or later, then run:

```sh
npm ci
npm run build
npm start
```

Open [VoxShop](http://localhost:4269). For development, `npm run dev` starts the editor at [127.0.0.1:3000](http://127.0.0.1:3000) with automatic client and server reloads. `start.bat` starts development mode on Windows.

No AI subscription, key or account is required for the built-in generators, editor, gameplay or exports. Your chosen agent or optional AI provider has its own requirements.

## Make a first game

1. Open **Crystal trail** or **Arena** to explore an editable example, or create a new project.
2. Choose **Generate** for a character, creature, machine, prop, terrain, or custom mathematical shape recipe.
3. Newly generated assets open in the inspector automatically. Choose **Place first asset** or **Place in scene**, then change position, rotation, scale and parent in the scene object's inspector.
4. Add components such as player controls, collider, collectibles, gates, health, enemies, patrols, animation or custom rules. Press **Apply object changes** to save inspector edits.
5. For a rigged asset, generate a fitted shell, backpack or blade. Add it to a scene object's equipment slots. Equipment remains a separate editable asset.
6. Press **Play**. WASD/arrows move, Space jumps, E interacts, and F/click attacks nearby enemies. **Stop** restores the authoring scene.
7. Use **Run playtest** for a repeatable scenario and JSON report. The two examples include complete win-condition scenarios; custom projects can define their own inputs and assertions.
8. **Export game** downloads one self-contained HTML file. Open it directly or host it as a static file. Players need a WebGL2 browser; the editor, agent, MCP service, AI keys and network AI are unnecessary.

**Crystal trail** uses a third-person creature, separate backpack and fitted shell, five collectibles, a conditional gate and a goal. **Arena** uses a top-down robot, equipment, pursuing enemies, health, melee attacks and an exit unlocked by defeating the enemies. Both use the same runtime and authoring contracts.

## Talk to your agent

In the hosted editor, open **Connect agent** and install or connect your account's VoxShop plugin under Plugins → Personal → Created by you. For the local editor, copy its generated MCP configuration into a client that supports local process (stdio) MCP servers. It includes the actual Node and server paths for your machine. Build first so that local server exists.

For example, ask your agent:

> Create a small exploration game with a quadruped carrying a backpack. Generate the assets, place five crystals, make the gate require all five, run a playtest and export the game.

Voice comes from your agent's voice interface. VoxShop exposes structured tools for projects, generation, inspection, editing, previews, undo/redo, playtests and builds. The agent uses the same validated, revisioned project service as the editor. See the [MCP and engine API guide](docs/engine-api.md) and [agent workflow](skills/VOXSHOP_AGENT.md).

## Sculpt and import assets

Select an asset and choose **Sculpt asset**, or **Sculpt from blank**. The existing workshop remains available: add, move, paint, delete, fill, lock, symmetry, brushes, rig painting, animation preview, image/text/mesh conversion, materials and export tools.

Sculpt changes to an opened project asset save automatically to that asset. Blank sculpt work saves as a project draft until **Save** gives it an asset name. Variants create independent geometry; scene instances reference shared assets, so editing an asset updates its instances.

Native model JSON uses `voxshop-model` version 1 and preserves colors, materials, locks, weights and the legacy animation profile. Legacy voxel arrays remain readable. The workshop also offers existing GLB, OBJ, PLY, STL, VOX, QB, PNG and Minecraft conversion paths. Formats differ in what they preserve; use native project/model JSON for editable backups. The new engine's explicit rig/socket contract is preserved in project files and game exports; the workshop's legacy mesh exporters do not yet export every new scene/equipment feature.

Optional direct AI generation accepts an OpenAI-compatible chat endpoint. API keys remain in memory for the current editor session. Configure the exact endpoint origin using `VOXSHOP_AI_ORIGINS` if it is outside the default OpenAI, Google, Ollama and LM Studio origins. The compatibility file worker is optional and uses separate request directories; it is not required for MCP. See [storage and local services](docs/storage-and-security.md).

## Save and recover

Projects are saved under `.voxshop/projects/` in the repository directory by default. Every accepted project transaction saves immediately using an atomic replacement and retains the previous save. Project undo/redo survives server restarts and is bounded to 20 entries and 32 MiB of history.

**Save project** downloads a portable `.voxshop.json` file. **Import** validates the complete document and creates a new project without replacing an existing project. Browser recovery stores unsent sculpt work in IndexedDB. If a save conflicts with an agent's changes, recovery can keep the sculpt as a separate asset. A damaged project can be restored explicitly from its previous save, preserving a copy of the damaged file.

Legacy browser libraries and simple scenes migrate once into an empty project. The original browser data remains intact. Browser origins have separate storage, so use the same host (`localhost` or `127.0.0.1`) when migrating an old library. Download portable backups before clearing browser storage or moving installations.

## Current scope

- Local, single-broker authoring with stable IDs, atomic batches, revisions, retry receipts, saved undo/redo and live editor updates.
- Composable box, ellipsoid, cylinder and seeded terrain generation; biped, quadruped and machine starter rigs; editable custom rigs and animation data.
- Rigid joint attachments and an initial body-shell fit against declared torso landmarks. Fitting unrelated imported clothing to arbitrary bodies is not supported.
- Scene hierarchy and full transforms; bounded fixed-step gameplay with conservative axis-aligned collision boxes. This is not a general rigid-body physics solver or navigation-mesh system.
- Custom logic through the versioned event/action API. Arbitrary JavaScript, shell execution, native plugins, multiplayer, large streaming worlds and native mobile builds are outside this milestone.
- Asset PNG previews and simulation test reports through MCP. A static preview is not an animation or gameplay certification.

## Development

See [Sites hosting](docs/sites-hosting.md) for cloud deployment details, account identities and current limits. Both hosted checkouts are preserved, and source synchronization checks their identity before copying. Local projects and the desktop MCP service remain available through the commands below.

```sh
npm run lint
npm test
npm run build
npm audit
npm run verify:release
```

`npm test` builds the standalone runtime and runs document, command, persistence, recovery, cancellation, rigging, gameplay, export and external MCP-client tests. CI is configured for Windows and Linux. See [architecture and API](docs/engine-api.md), [implementation status](docs/implementation-status.md), and [verification evidence](docs/verification.md) for the distinction between automated checks, browser observations and remaining limitations.

`npm run verify:release` starts a built broker on loopback port 4329 using an isolated `.voxshop/release-verification` workspace, launches the built MCP server through a separate client, completes both example scenarios, saves portable projects and writes standalone games plus a report. It leaves the creator's normal workspace untouched.

Built by [Hexxis Studios](https://github.com/Hexxis-Studios/voxshop). [Support development](https://www.paypal.com/ncp/payment/MNF5JL9WPEJ92).

The project retains its existing Apache-2.0 license. The reference generator discussed during the audit was used for design study only; its GPL code and generated assets were not copied into VoxShop. Standalone builds include Three.js license notices.
