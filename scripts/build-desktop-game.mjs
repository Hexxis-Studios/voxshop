import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDesktopGame } from './stage-desktop-game.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildDesktopGame(sourceHtmlPath) {
  if (process.platform !== 'win32')
    throw new Error('Windows game packaging must run on Windows. Other desktop targets are deferred.');

  const staged = await stageDesktopGame(sourceHtmlPath);
  const targetDirectory = path.join(projectRoot, '.voxshop', 'game-player', 'target');
  const tauriCli = path.join(projectRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const result = spawnSync(
    process.execPath,
    [tauriCli, 'build', '--ci', '--bundles', 'nsis', '--config', staged.configFile],
    {
      cwd: staged.playerRoot,
      env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Windows game packaging failed with status ${result.status ?? 'unknown'}.`);

  const installerDirectory = path.join(targetDirectory, 'release', 'bundle', 'nsis');
  const installers = (await fs.readdir(installerDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith(`${staged.productName}_`) && entry.name.endsWith('.exe'),
    )
    .map((entry) => path.join(installerDirectory, entry.name));
  if (installers.length !== 1)
    throw new Error(`Expected one NSIS game installer in ${installerDirectory}, found ${installers.length}.`);
  return { ...staged, installerPath: installers[0] };
}

const sourceHtmlPath = process.argv[2];
if (!sourceHtmlPath || process.argv.length > 3) {
  console.error('Usage: npm run desktop:game:build -- <standalone-game.html>');
  process.exitCode = 2;
} else {
  try {
    const built = await buildDesktopGame(sourceHtmlPath);
    console.log(`Built ${built.productName}: ${built.installerPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
