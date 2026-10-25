# Windows game export

Build one scene to the existing standalone HTML format, then package that file as a Windows app:

```powershell
npm run desktop:game:stage -- .voxshop\exports\game.html
npm run desktop:game:build -- .voxshop\exports\game.html
```

The staging command validates the embedded game payload and writes a game-specific Tauri config plus an unchanged `index.html` under `.voxshop/game-player/`. The build command produces an NSIS installer under `.voxshop/game-player/target/release/bundle/nsis/`. The installer embeds the game and uses the Windows WebView2 runtime; it does not start the VoxShop editor, Node sidecar, project server, or MCP service. WebView2 is downloaded by the installer only if it is missing.

The staged `frontendDist` is an array containing the exact HTML file, with `index.html` as the window URL. An absolute Windows directory string can be parsed as a URL by Tauri and show a folder index instead of embedding the game. The player's content policy permits embedded WebAssembly for Rapier and the same optional secure/loopback multiplayer connections as browser exports; it keeps general JavaScript eval disabled. Campaign saves use the game-specific app identity and survive player relaunch.

This first player target is Windows-only. It keeps the standalone HTML export available. Native project schema versions are unchanged.
