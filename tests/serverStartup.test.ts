import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('a broker port collision preserves saved access and never announces a ready connection', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-startup-'));
  const accessPath = path.join(dataDir, 'access.json');
  const previousAccess = JSON.stringify({ url: 'http://127.0.0.1:12345', token: 'previous-test-token' });
  await fs.writeFile(accessPath, previousAccess);
  const occupied = createServer((_request, response) => response.end('Unrelated test server'));
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address && typeof address === 'object');
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('server/main.ts')],
    {
      env: {
        ...process.env,
        VOXSHOP_ROOT: process.cwd(),
        VOXSHOP_PORT: String(address.port),
        VOXSHOP_MULTIPLAYER_PORT: '0',
        VOXSHOP_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, stderr);
    assert.match(stderr, /EADDRINUSE|address already in use/);
    assert.doesNotMatch(stdout, /local access only/);
    assert.equal(await fs.readFile(accessPath, 'utf8'), previousAccess);
    assert.equal(
      (await fs.readdir(dataDir)).some((name) => name.endsWith('.lock')),
      false,
    );
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('a multiplayer port collision preserves saved access and releases the workspace lock', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-startup-'));
  const accessPath = path.join(dataDir, 'access.json');
  const previousAccess = JSON.stringify({ url: 'http://127.0.0.1:12345', token: 'previous-test-token' });
  await fs.writeFile(accessPath, previousAccess);
  const occupied = createServer((_request, response) => response.end('Unrelated test server'));
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address && typeof address === 'object');
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('server/main.ts')],
    {
      env: {
        ...process.env,
        VOXSHOP_ROOT: process.cwd(),
        VOXSHOP_PORT: '0',
        VOXSHOP_MULTIPLAYER_PORT: String(address.port),
        VOXSHOP_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, stderr);
    assert.match(stderr, /EADDRINUSE|address already in use/);
    assert.doesNotMatch(stdout, /local access only/);
    assert.equal(await fs.readFile(accessPath, 'utf8'), previousAccess);
    assert.equal(
      (await fs.readdir(dataDir)).some((name) => name.endsWith('.lock')),
      false,
    );
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
