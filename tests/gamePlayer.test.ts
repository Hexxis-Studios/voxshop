import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExample } from '../services/examples';
import { buildGame } from '../server/gameBuild';
import { stageDesktopGame } from '../scripts/stage-desktop-game.mjs';

test('Windows player stages one named game with its inline runtime and no editor service', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-game-player-'));
  t.after(async () => {
    assert.ok(path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir(), 'voxshop-game-player-')));
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const project = createExample('exploration', 'native-game-player');
  const exported = await buildGame(project, 'main', {
    root: process.cwd(),
    directory: path.join(temporaryRoot, 'exports'),
  });
  const sourceHtml = await fs.readFile(exported.path, 'utf8');
  const staged = await stageDesktopGame(exported.path, {
    outputRoot: path.join(temporaryRoot, 'staged'),
  });
  const stagedHtml = await fs.readFile(staged.frontendFile, 'utf8');
  const stagedConfig = JSON.parse(await fs.readFile(staged.configFile, 'utf8'));
  const playerRoot = path.join(process.cwd(), 'desktop', 'game-player');
  const tauriConfig = JSON.parse(
    await fs.readFile(path.join(playerRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const cargoManifest = await fs.readFile(path.join(playerRoot, 'src-tauri', 'Cargo.toml'), 'utf8');

  assert.equal(stagedHtml, sourceHtml, 'staging copies the built game without changing its HTML export');
  assert.equal(staged.projectId, project.id);
  assert.equal(staged.sceneId, 'main');
  assert.equal(staged.revision, project.revision);
  const nameSlug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  assert.match(
    staged.productName,
    new RegExp(`^VoxShop-Game-${nameSlug}-main-r${project.revision}-[a-f0-9]{10}$`),
  );
  assert.equal(stagedConfig.productName, staged.productName);
  assert.equal(stagedConfig.identifier, staged.identifier);
  assert.equal(stagedConfig.app.windows[0].title, staged.windowTitle);
  assert.equal(stagedConfig.app.windows[0].url, 'index.html');
  assert.deepEqual(stagedConfig.build.frontendDist, [staged.frontendFile]);

  const embeddedProject = JSON.parse(
    stagedHtml.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
  );
  assert.equal(embeddedProject.id, project.id);
  assert.equal(embeddedProject.activeSceneId, 'main');
  assert.ok(stagedHtml.match(/<script>([\s\S]+?)<\/script>/)?.[1], 'the game runtime is inline');
  assert.match(stagedHtml, /id="voxshop-workers" type="application\/json"/);
  assert.match(stagedHtml, /connect-src wss: ws:\/\/localhost:\* ws:\/\/127\.0\.0\.1:\* ws:\/\/\[::1\]:\*/);
  assert.doesNotMatch(stagedHtml, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(stagedHtml, /<link\b[^>]*\bhref\s*=/i);

  assert.equal(tauriConfig.version, '2.0.0-alpha.1');
  assert.deepEqual(tauriConfig.bundle.targets, ['nsis']);
  assert.equal(tauriConfig.bundle.externalBin, undefined);
  assert.equal(tauriConfig.bundle.resources, undefined);
  assert.equal(tauriConfig.build.beforeBuildCommand, undefined);
  assert.equal(tauriConfig.build.devUrl, undefined);
  const policyDirectives = tauriConfig.app.security.csp.split(';').map((value: string) => value.trim());
  assert.ok(
    policyDirectives.includes("script-src 'unsafe-inline' 'wasm-unsafe-eval'"),
    'The native player must allow the embedded Rapier WASM compiler.',
  );
  assert.ok(
    policyDirectives.includes('connect-src wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*'),
    'The native player must permit the same optional multiplayer hosts as its HTML game.',
  );
  assert.doesNotMatch(cargoManifest, /tauri-plugin-shell|voxshop-node|express|mcp\/server/i);
  assert.deepEqual((await fs.readdir(staged.appDirectory)).sort(), ['frontend', 'tauri.conf.json']);
});
