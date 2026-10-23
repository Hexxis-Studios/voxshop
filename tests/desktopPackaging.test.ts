import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localServiceUrl } from '../desktop/serviceUrl';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop startup only accepts an explicit VoxShop loopback URL', () => {
  assert.equal(localServiceUrl('http://127.0.0.1:4269'), 'http://127.0.0.1:4269');
  for (const value of [
    'https://127.0.0.1:4269',
    'http://localhost:4269',
    'http://127.0.0.1',
    'http://127.0.0.1:4269/path',
    'http://user:pass@127.0.0.1:4269',
    'https://example.com',
  ]) {
    assert.throws(() => localServiceUrl(value), /invalid local address/);
  }
  assert.throws(() => localServiceUrl(undefined), /no address/);
});

test('Tauri Rust resolves the packaged sidecar by its executable basename', async () => {
  const config = JSON.parse(
    await readFile(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const configuredSidecar = config.bundle.externalBin.find((entry: string) =>
    entry.endsWith('/voxshop-node'),
  );
  assert.ok(configuredSidecar, 'Tauri must bundle the VoxShop Node sidecar.');

  const rustLauncher = await readFile(path.join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const runtimeName = path.posix.basename(configuredSidecar);
  assert.match(rustLauncher, new RegExp(`\\.sidecar\\("${runtimeName}"\\)`));
  assert.doesNotMatch(rustLauncher, /\.sidecar\("binaries\//);
});
