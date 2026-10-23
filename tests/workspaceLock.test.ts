import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lockWorkspace } from '../server/workspaceLock';
test('a workspace cannot run two independent brokers and releasing it permits a fresh connection', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-lock-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-lock-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const release = await lockWorkspace(directory);
  await assert.rejects(lockWorkspace(directory), /already open/);
  await release();
  const second = await lockWorkspace(directory);
  await second();
});
