import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';

async function startBroker(dataDir: string) {
  const service = await createApp({
    root: process.cwd(),
    dataDir,
    port: 0,
    token: 'f'.repeat(64),
  });
  const server = createServer(service.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}`, token: service.token };
}

async function stopBroker(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('editor frame pacing preferences persist in app data and reject invalid updates', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-frame-pacing-'));
  let server: Server | undefined;
  try {
    let broker = await startBroker(dataDir);
    server = broker.server;
    const initialResponse = await fetch(`${broker.base}/api/preferences/frame-pacing`, {
      headers: { 'X-VoxShop-Token': broker.token },
    });
    assert.deepEqual(await initialResponse.json(), {
      settings: { capFrameRate: false, maxFpsTarget: 144 },
      saved: false,
    });

    const unauthorized = await fetch(`${broker.base}/api/preferences/frame-pacing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capFrameRate: true, maxFpsTarget: 240 }),
    });
    assert.equal(unauthorized.status, 401);

    const saved = await fetch(`${broker.base}/api/preferences/frame-pacing`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-VoxShop-Token': broker.token,
      },
      body: JSON.stringify({ capFrameRate: true, maxFpsTarget: 240 }),
    });
    assert.deepEqual(await saved.json(), {
      settings: { capFrameRate: true, maxFpsTarget: 240 },
      saved: true,
    });

    const invalid = await fetch(`${broker.base}/api/preferences/frame-pacing`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-VoxShop-Token': broker.token,
      },
      body: JSON.stringify({ capFrameRate: true, maxFpsTarget: 241 }),
    });
    assert.equal(invalid.status, 400);
    await stopBroker(server);
    server = undefined;

    broker = await startBroker(dataDir);
    server = broker.server;
    const restored = await fetch(`${broker.base}/api/preferences/frame-pacing`, {
      headers: { 'X-VoxShop-Token': broker.token },
    });
    assert.deepEqual(await restored.json(), {
      settings: { capFrameRate: true, maxFpsTarget: 240 },
      saved: true,
    });
  } finally {
    if (server) await stopBroker(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
