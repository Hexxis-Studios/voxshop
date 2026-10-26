import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createExample } from '../services/examples';
import { buildGame } from '../server/gameBuild';
import { buildNativeGame, nativeGamePlayerAvailable } from '../server/nativeGameExport';
import { createApp } from '../server/app';

function unsignedPe(signed = false) {
  const exe = Buffer.alloc(2048);
  const peOffset = 0x80;
  const optionalHeader = peOffset + 24;
  exe.write('MZ', 0, 'ascii');
  exe.writeUInt32LE(peOffset, 0x3c);
  exe.write('PE\0\0', peOffset, 'binary');
  exe.writeUInt16LE(0x8664, peOffset + 4);
  exe.writeUInt16LE(1, peOffset + 6);
  exe.writeUInt16LE(0xf0, peOffset + 20);
  exe.writeUInt16LE(0x20b, optionalHeader);
  exe.writeUInt32LE(16, optionalHeader + 108);
  if (signed) exe.writeUInt32LE(1, optionalHeader + 112 + 4 * 8);
  return exe;
}

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-native-export-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-native-export-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const project = createExample('exploration', 'native-player-export');
  const built = await buildGame(project, 'main', {
    root: process.cwd(),
    directory: path.join(directory, 'html'),
  });
  const playerPath = path.join(directory, 'voxshop-game-player.exe');
  const noticesPath = path.join(directory, 'LICENSE_NOTICES.txt');
  await fs.writeFile(playerPath, unsignedPe());
  await fs.writeFile(noticesPath, 'Tauri player runtime license notice. <Keep this as text>.\n');
  return { directory, project, built, playerPath, noticesPath };
}

async function createApiFixture(
  t: { after(action: () => Promise<void>): void },
  { withPlayer }: { withPlayer: boolean },
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-native-api-'));
  const root = path.join(directory, 'app'),
    dataDir = path.join(directory, 'data');
  await Promise.all([
    fs.mkdir(path.join(root, 'dist'), { recursive: true }),
    fs.mkdir(path.join(root, 'node_modules', 'three'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, 'dist', 'runtime-lite.js'), 'void 0;');
  await fs.copyFile(
    path.join(process.cwd(), 'node_modules', 'three', 'LICENSE'),
    path.join(root, 'node_modules', 'three', 'LICENSE'),
  );
  if (withPlayer) {
    const playerDirectory = path.join(root, 'game-player');
    await fs.mkdir(playerDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(playerDirectory, 'voxshop-game-player.exe'), unsignedPe()),
      fs.writeFile(path.join(playerDirectory, 'LICENSE_NOTICES.txt'), 'Player dependency notices.\n'),
    ]);
  }

  const service = await createApp({ root, dataDir, port: 0, multiplayerPort: 0 });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test service did not bind a loopback port.');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-native-api-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, token: service.token };
}

async function createApiProject(baseUrl: string, token: string, id: string) {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'X-VoxShop-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: 'Native API test' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function waitForGameBuild(baseUrl: string, token: string, jobId: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
      headers: { 'X-VoxShop-Token': token },
    });
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed' || job.status === 'cancelled')
      throw new Error(`Native game build ${job.status}: ${job.error}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Native game build did not finish within 20 seconds.');
}

test('native game export appends a bounded standalone payload and visible player notices', async (t) => {
  const { directory, project, built, playerPath, noticesPath } = await fixture(t);
  assert.equal(await nativeGamePlayerAvailable(playerPath, noticesPath), true);

  const output = await buildNativeGame(built.path, {
    playerPath,
    noticesPath,
    directory: path.join(directory, 'games'),
  });
  const [player, exe] = await Promise.all([fs.readFile(playerPath), fs.readFile(output.path)]);
  const trailer = exe.subarray(-56);
  const payloadLength = Number(trailer.readBigUInt64LE(16));
  const payload = exe.subarray(exe.length - 56 - payloadLength, exe.length - 56);
  const html = payload.toString('utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];

  assert.match(
    output.filename,
    new RegExp(`^crystal-trail-main-[a-f0-9]{10}-r${project.revision}\\.exe$`),
  );
  assert.equal(output.projectId, project.id);
  assert.equal(output.sceneId, 'main');
  assert.equal(exe.length, player.length + payload.length + 56);
  assert.deepEqual(exe.subarray(0, player.length), player);
  assert.equal(trailer.toString('ascii', 0, 8), 'VOXGAME1');
  assert.equal(trailer.readUInt32LE(8), 1);
  assert.equal(trailer.readUInt32LE(12), 0);
  assert.equal(trailer.subarray(24).toString('hex'), createHash('sha256').update(payload).digest('hex'));
  assert.match(html, /id="voxshop-player-licenses"/);
  assert.ok(csp?.includes("default-src 'none'"));
  assert.ok(csp?.includes('connect-src wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*'));
  assert.doesNotMatch(csp ?? '', /(?:^|[ ;])(?:ipc|tauri):|connect-src\s+\*/);
  assert.match(html, /Tauri player runtime license notice\. &lt;Keep this as text&gt;\./);
  assert.doesNotMatch(html, /Hexxis Studios authored this game/);
  assert.equal(output.bytes, exe.length);
  assert.equal(output.sha256, createHash('sha256').update(exe).digest('hex'));
  assert.match(output.requirements, /WebView2 Evergreen/);
  assert.match(output.requirements, /Export save and Import save/);
});

test('generic player enables no Tauri IPC capabilities or application commands', async () => {
  const playerRoot = path.join(process.cwd(), 'desktop', 'game-player', 'src-tauri');
  const [config, source, capabilities] = await Promise.all([
    fs.readFile(path.join(playerRoot, 'tauri.conf.json'), 'utf8').then((text) => JSON.parse(text)),
    fs.readFile(path.join(playerRoot, 'src', 'main.rs'), 'utf8'),
    fs.readdir(path.join(playerRoot, 'capabilities')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }),
  ]);
  assert.equal(config.app.security.capabilities, undefined);
  assert.deepEqual(capabilities, []);
  assert.doesNotMatch(source, /tauri::command|invoke_handler|\.plugin\s*\(/);
  assert.doesNotMatch(config.app.security.csp, /\b(?:ipc|tauri):/);
});

test('loopback API builds and authenticates a native Windows game download', async (t) => {
  const { baseUrl, token } = await createApiFixture(t, { withPlayer: true });
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.deepEqual(session.gameTargets, ['html', 'windows-exe']);

  const project = await createApiProject(baseUrl, token, 'native-api-success');
  const buildResponse = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
    method: 'POST',
    headers: { 'X-VoxShop-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: project.activeSceneId, target: 'windows-exe' }),
  });
  assert.equal(buildResponse.status, 202);
  const job = await buildResponse.json();
  const result = await waitForGameBuild(baseUrl, token, job.id);
  assert.equal(result.target, 'windows-exe');
  assert.match(result.filename, /^native-api-test-main-[a-f0-9]{10}-r\d+\.exe$/);

  const unauthenticated = await fetch(`${baseUrl}/api/games/${result.filename}`);
  assert.equal(unauthenticated.status, 401);
  const download = await fetch(`${baseUrl}/api/games/${result.filename}`, {
    headers: { 'X-VoxShop-Token': token },
  });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  assert.equal(bytes.subarray(-56, -48).toString('ascii'), 'VOXGAME1');
});

test('native Windows target reports unavailable players and rejects invalid target and download paths', async (t) => {
  const { baseUrl, token } = await createApiFixture(t, { withPlayer: false });
  const project = await createApiProject(baseUrl, token, 'native-api-missing');

  const session = await (await fetch(`${baseUrl}/api/session`)).json();
  assert.deepEqual(session.gameTargets, ['html']);
  const missing = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
    method: 'POST',
    headers: { 'X-VoxShop-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: project.activeSceneId, target: 'windows-exe' }),
  });
  assert.equal(missing.status, 501);

  const invalidTarget = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
    method: 'POST',
    headers: { 'X-VoxShop-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: project.activeSceneId, target: 'linux' }),
  });
  assert.equal(invalidTarget.status, 400);
  const invalidPath = await fetch(`${baseUrl}/api/games/safe%2F..%2Foutside.exe`, {
    headers: { 'X-VoxShop-Token': token },
  });
  assert.equal(invalidPath.status, 400);
});

test('native game export rejects external dependencies, unsigned player corruption and signed player bases', async (t) => {
  const { directory, built, playerPath, noticesPath } = await fixture(t);
  const weakCspHtml = path.join(directory, 'weak-csp.html');
  await fs.writeFile(
    weakCspHtml,
    (await fs.readFile(built.path, 'utf8')).replace("default-src 'none'", 'default-src *'),
  );
  await assert.rejects(
    buildNativeGame(weakCspHtml, {
      playerPath,
      noticesPath,
      directory: path.join(directory, 'weak-csp'),
    }),
    /restrictive VoxShop Content Security Policy/,
  );

  const invalidHtml = path.join(directory, 'invalid.html');
  await fs.writeFile(
    invalidHtml,
    (await fs.readFile(built.path, 'utf8')).replace(
      '</head>',
      '<script src="https://example.test/game.js"></script></head>',
    ),
  );
  await assert.rejects(
    buildNativeGame(invalidHtml, { playerPath, noticesPath, directory: path.join(directory, 'invalid') }),
    /avoid external scripts/,
  );

  const signedPlayer = path.join(directory, 'signed-player.exe');
  const outputDir = path.join(directory, 'signed');
  await fs.writeFile(signedPlayer, unsignedPe(true));
  await fs.mkdir(outputDir);
  assert.equal(await nativeGamePlayerAvailable(signedPlayer, noticesPath), true);
  await assert.rejects(
    buildNativeGame(built.path, {
      playerPath: signedPlayer,
      noticesPath,
      directory: outputDir,
    }),
    /signed Windows executable/,
  );

  assert.deepEqual(await fs.readdir(outputDir), []);
});
