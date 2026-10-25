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

Export an HTML game, then run `npm run desktop:game:build -- <game.html>`. This produces a game-specific Windows installer. Its player embeds the HTML and runtime without the editor, Node sidecar or MCP broker. See [Windows game export](windows-game-export.md).

## Linux

The architecture retains Linux support, but current packages are Windows-only. Linux builds require that platform's matching Node runtime and WebKitGTK 4.1 development packages.
