# Desktop builds

The Windows editor uses Tauri 2 to host the current renderer and a packaged Node sidecar on a random loopback port. Node is bundled, so installed users need no development runtime. Project data lives in the OS application-data directory, separate from the installation. The application identifier is `com.hexxisstudios.voxshop`.

The shell is a packaging and lifecycle layer; it does not turn the renderer into a separate native graphics backend or guarantee higher FPS. Browser authoring and self-contained game exports remain supported.

## Windows

Source builds require a supported Node.js release at least 24.22.1, Rust, Microsoft C++ Build Tools and WebView2. Follow [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/) for the toolchain. Packaging rejects older Node versions rather than distributing an outdated service runtime.

```sh
npm ci
npm run desktop:build-app -- --bundles nsis
```

The build prepares the production editor, Node service, MCP guidance and required dependency notices, then creates the installer under `src-tauri/target/release/bundle/nsis/`. User projects stay in OS application data, outside the installation.

`npm run desktop:dev-app` starts the development shell. `npm run verify:desktop-runtime` exercises the prepared sidecar, persistence and packaged MCP resources in an isolated workspace.

## Game player

The installed Windows editor includes a prebuilt player. Select **Windows EXE** beside **Export game** to create a standalone game without installing Node.js or a Rust toolchain, or compiling the player from source. Browser HTML is also supported. Developers can additionally build a game-specific installer from an HTML export. See [Windows game export](windows-game-export.md).

## Linux

The on-demand Linux package workflow builds DEB and AppImage artifacts on Ubuntu 22.04 and runs the packaged sidecar/MCP check. It also installs the DEB and checks the editor viewport in an Xvfb software-rendered session. These are CI artifacts, not downloads in the current public release; the workflow does not establish compatibility with every distribution, compositor or GPU.

Source builds require a matching Linux Node.js runtime, Rust toolchain and WebKitGTK 4.1 development packages. The repository's on-demand CI workflow runs the package and smoke checks described above.
