# VoxShop on Sites

The active private Site is selected by `.openai/hosting.json`. The original Hexxis/Daymien identity is also saved in `.openai/hosting.original-account.json`; the Alex identity is saved in `.openai/hosting.alex-account.json`. Both accounts' hosted checkouts remain on disk, with separate Git repositories, cloud storage and account ownership. Switching ChatGPT accounts does not transfer their cloud project records.

The original account uses `.voxshop/sites/voxshop-original-account`. The Alex account uses `.voxshop/sites/voxshop`. `scripts/sync-sites.mjs` selects the checkout matching the active identity and refuses to overwrite a different Site's identity. An explicit checkout path can be passed as its first argument. Deployment receipts in `.voxshop/sites/` record the exact pushed commit, saved version, production URL and terminal deployment result for each account.

The hosted editor uses the same project validation, recipe generation, rigging, scene simulation and standalone-game renderer as the local editor. D1 stores owner-scoped project pointers; R2 stores project snapshots, presets, jobs and game exports. Writes compare the previous revision and object pointer atomically. Retry receipts, saved undo/redo and backup recovery remain available. Discarded history snapshots are pruned after successful writes. A hosted project is limited to 16 MB, with up to 20 undo and redo entries.

Sites owns sign-in and publication access. Backend records are keyed by the authenticated Site user ID. Session tokens and origin checks protect browser writes; MCP requests use Sites authentication. Optional provider API keys are forwarded only for that request and never stored in D1, R2, source or logs.

## Agent access

The Site exposes 17 tools through a stateless `/mcp` endpoint using MCP 2026-07-28. Publishing provisions a private VoxShop plugin. Use Plugins → Personal → Created by you → VoxShop to install or connect it when automatic connection is unavailable. No local service is required for hosted projects. Tool input schemas are discoverable; `project_commands` returns the full transaction schema.

The desktop stdio MCP server remains available for local projects. Hosted previews return SVG documents. Hosted jobs run within their initiating request and persist their result; they do not provide background cancellation during that request. The local CLI generator and computer-local AI services remain desktop features. Hosted Sculpt can use supported OpenAI and Google HTTPS APIs; recipe generation and gameplay require neither provider.

## Rebuild and publish

1. Retain the existing Site identity, and use the Sites source helper to open the corresponding checkout before editing. Never create a replacement Site merely because a different account cannot access it.
2. Run `npm run build:runtime`, then `node scripts/sync-sites.mjs` from the original project. Synchronization copies application source and generated runtime/license resources, excluding local projects, credentials, logs and browser data.
3. Use the hosted checkout's Sites installation/build helpers and preserve the `sites()` integration. Generate a new Drizzle migration only for schema changes; never rewrite applied migrations.
4. Run `node scripts/verify-hosted-api.mjs <checkout-path>`. It exercises Request/Response handlers against real Miniflare D1/R2 bindings. `node scripts/verify-sites.mjs <loopback-preview-url>` checks the same contract through HTTP when a preview is available. Neither fixture is a production identity bypass.
5. Publish the exact pushed source and matching archive through the source helper and owner-private deployment tools. Keep source credentials in memory and stdin, never files or command arguments. Preserve the existing audience.

On this Windows installation, the workflow uses Git's `bin` directory first in its process-local `PATH`, the ignored checkout-local npm shim, and `TAR_OPTIONS=--force-local`. These select the installed Git Bash and prevent GNU tar from treating a drive-letter archive path as a remote host. No global shell or browser settings need changing.

## Verification

The local editor passed project CRUD/import, recovery, live-agent updates and both keyboard game wins. The Alex account's deployed editor passed cloud project creation, generation, placement, fractional transforms, reload persistence, portable download, both keyboard game wins, arena scenario assertions and both game downloads. The original wordmark was confirmed visibly loaded. See [verification.md](verification.md) for evidence and the checks still pending on the original account after switching back.

Chrome automated uploads require the browser extension's file-access setting; a missing setting blocked the hosted import check. Independent exported-file browser gameplay is also unverified because the tool rejected file URLs. Handler tests verify portable imports, and build/download integrity checks pass. The installed Site plugin's live tool invocation remains separate from handler and stdio MCP verification.
