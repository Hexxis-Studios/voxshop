# Contributor checks

Clone the repository for development checks; consumer source archives intentionally omit tests and verification fixtures.

```sh
npm ci
npm run lint
npm test
npm run build
npm run verify:release
```

`verify:release` starts an isolated production broker and built MCP client, checks identity and agent resources, completes starter scenarios, and verifies portable projects and game exports. Its data stays under `.voxshop/release-verification/`, separate from creator projects. Set `VOXSHOP_VERIFY_PORT` if its default loopback port 4329 is occupied.

After preparing the desktop build, run `npm run verify:desktop-runtime` to check the packaged service, persistence and MCP resources. Installer acceptance should cover clean install, upgrade/reinstall, launch and uninstall while preserving user data.

Rendering and interaction changes also require a real visual pass: open a connected editor, inspect the affected scene at the correct revision, exercise controls and motion, and compare screenshots. Simulation assertions, mocked WebGL calls and syntax checks alone do not establish visual quality or FPS.

Use disposable projects and `VOXSHOP_DATA_DIR` for automation. Never publish `access.json`, real project data or private visual captures. Performance claims must state hardware, resolution, scene and whether the measurement is CPU work, GPU time or presented frames.
