import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearRecovery, readRecovery, writeRecovery, type DraftRecovery } from '../services/recoveryStore';
import { createModelDocument } from '../services/modelDocument';
test('recovery keeps project ownership, preserves newer edits against stale writes, and clears only acknowledged drafts', async () => {
  const first: DraftRecovery = {
    projectId: 'one',
    assetId: 'fox',
    baseRevision: 4,
    updatedAt: 10,
    document: createModelDocument([{ x: 0, y: 0, z: 0, color: 0 }]),
    draftVoxelSize: 0.14498056769728357,
  };
  const newer = {
    ...first,
    updatedAt: 11,
    document: createModelDocument([{ x: 1, y: 0, z: 0, color: 0xffffff }]),
  };
  await writeRecovery(newer);
  await writeRecovery(first);
  await writeRecovery({ ...first, projectId: 'two' });
  assert.deepEqual(await readRecovery('one'), newer);
  assert.equal((await readRecovery('one'))?.draftVoxelSize, 0.14498056769728357);
  await clearRecovery('one', 10);
  assert.deepEqual(await readRecovery('one'), newer);
  await clearRecovery('one', 11);
  assert.equal(await readRecovery('one'), undefined);
  assert.equal((await readRecovery('two'))?.assetId, 'fox');
  await clearRecovery('two');
});
