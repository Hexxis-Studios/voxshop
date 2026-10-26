# Export a Windows game

In the Windows desktop editor, select **Windows EXE** beside **Export game**. VoxShop packages your game, assets and runtime into a standalone executable using the player bundled with the editor; export does not build a new native player. The player does not need VoxShop, Node.js, Rust, an AI account or a running editor service. Microsoft WebView2 Evergreen must be installed on the player's Windows system.

The game window uses your project's title. Engine and dependency licenses are available in the game menu; they do not claim authorship of your game or require a splash screen.

Each exported executable isolates its local game storage. Re-exporting after changing the game creates a separate storage identity. Use **Export save** and **Import save** in the game menu to move compatible progress to an updated export. Keep a portable project backup separately for further editing.

**Browser HTML** remains available in every build. Open that file in a compatible browser, or host it as a static game. Windows EXE is enabled only when the editor includes its prebuilt Windows player.

## Build a game installer from source

Developers who need a game-specific Windows installer can export Browser HTML and run:

```sh
npm run desktop:game:build -- path/to/game.html
```

This path requires the [Windows desktop build prerequisites](desktop.md). It embeds the exact HTML file in a game-specific Tauri app, retaining the original HTML export. The staging command validates embedded game data and generates its configuration; it never reads other projects from the export folder.
