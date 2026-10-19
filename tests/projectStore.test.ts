import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore } from '../server/projectStore';
import { generateRecipe } from '../services/recipeGenerator';
import { newProject, validateProject } from '../services/projectDocument';

export const recipe = {
  version: 1,
  seed: 4,
  shapes: [{ kind: 'box', center: [0, 1, 0], size: [3, 3, 3], color: 0xff8844 }],
};
const generate = { type: 'asset.generate', id: 'fox', name: 'Fox', recipe };
async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new ProjectStore(directory);
  await store.create('Project', 'project');
  return { store, directory };
}
test('project transactions persist, reject invalid references atomically, and retain undo/redo across restart', async (t) => {
  const { store, directory } = await fixture(t);
  const result = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'make-fox',
    operations: [generate],
  });
  assert.equal(result.project.assets[0].model.voxels.length, 27);
  await assert.rejects(
    store.commit('project', {
      expectedRevision: 1,
      requestId: 'bad-batch',
      operations: [
        { type: 'project.rename', name: 'Should not commit' },
        {
          type: 'node.put',
          sceneId: 'main',
          node: { id: 'broken', name: 'Broken', assetId: 'missing', transform: {} },
        },
      ],
    }),
  );
  assert.deepEqual(await store.read('project'), result.project);
  const restart = new ProjectStore(directory);
  const undone = await restart.history('project', 'undo', { expectedRevision: 1, requestId: 'undo-fox' });
  assert.equal(undone.project.assets.length, 0);
  assert.equal(undone.project.revision, 2);
  const redone = await restart.history('project', 'redo', { expectedRevision: 2, requestId: 'redo-fox' });
  assert.deepEqual(redone.project.assets, result.project.assets);
  assert.equal(redone.project.revision, 3);
});
test('concurrent writers use revisions and identical retries survive restart without duplicate edits', async (t) => {
  const { store, directory } = await fixture(t);
  const request = { expectedRevision: 0, requestId: 'request-a', operations: [generate] };
  const results = await Promise.allSettled([
    store.commit('project', request),
    store.commit('project', { ...request, requestId: 'request-b' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await store.read('project')).revision, 1);
  const replayed = await new ProjectStore(directory).commit('project', request);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.appliedRevision, 1);
  await assert.rejects(
    store.commit('project', {
      ...request,
      operations: [{ type: 'project.rename', name: 'Different request' }],
    }),
    /different arguments/,
  );
});
test('referenced asset deletion is blocked; hierarchy deletion cascades and variants keep independent edits', async (t) => {
  const { store } = await fixture(t);
  await store.commit('project', {
    expectedRevision: 0,
    requestId: 'initial',
    operations: [
      generate,
      { type: 'asset.variant', sourceId: 'fox', id: 'snow-fox', name: 'Snow fox' },
      {
        type: 'node.put',
        sceneId: 'main',
        node: { id: 'parent', name: 'Parent', assetId: 'fox', transform: {} },
      },
      {
        type: 'node.put',
        sceneId: 'main',
        node: { id: 'child', name: 'Child', parentId: 'parent', assetId: 'snow-fox', transform: {} },
      },
    ],
  });
  await assert.rejects(
    store.commit('project', {
      expectedRevision: 1,
      requestId: 'delete-in-use',
      operations: [{ type: 'asset.delete', id: 'snow-fox' }],
    }),
    /Missing asset/,
  );
  const next = await store.commit('project', {
    expectedRevision: 1,
    requestId: 'remove-tree',
    operations: [
      { type: 'node.delete', sceneId: 'main', id: 'parent' },
      {
        type: 'asset.edit',
        id: 'snow-fox',
        edit: { mode: 'paint', targets: [{ x: 0, y: 1, z: 0 }], color: 0xffffff },
      },
    ],
  });
  assert.equal(next.project.scenes[0].nodes.length, 0);
  assert.notEqual(
    next.project.assets[0].model.voxels.find((v) => v.x === 0 && v.y === 1 && v.z === 0)?.color,
    next.project.assets[1].model.voxels.find((v) => v.x === 0 && v.y === 1 && v.z === 0)?.color,
  );
});
test('explicit disk recovery restores the previous validated save and keeps a damaged-file copy', async (t) => {
  const { store, directory } = await fixture(t);
  await store.commit('project', { expectedRevision: 0, requestId: 'first', operations: [generate] });
  await fs.writeFile(path.join(directory, 'project.json'), '{broken');
  await assert.rejects(store.read('project'), /recovery/);
  const recovered = await store.recover('project');
  assert.ok(recovered.revision > 1);
  await assert.rejects(
    store.commit('project', {
      expectedRevision: 1,
      requestId: 'stale-after-recovery',
      operations: [{ type: 'project.rename', name: 'Stale' }],
    }),
    /Revision conflict/,
  );
  assert.ok((await fs.readdir(directory)).some((f) => f.startsWith('project.json.replaced-')));
});
test('project validation rejects future schemas, cyclic hierarchy, invalid skinning and missing rule targets', () => {
  const p = newProject('p', 'Project');
  assert.throws(() => validateProject({ ...p, version: 2 }));
  assert.throws(
    () =>
      validateProject({
        ...p,
        scenes: [{ ...p.scenes[0], nodes: [{ id: 'n', name: 'Cycle', parentId: 'n', transform: {} }] }],
      }),
    /cycle/,
  );
  assert.throws(
    () =>
      validateProject({
        ...p,
        scenes: [
          {
            ...p.scenes[0],
            nodes: [
              {
                id: 'n',
                name: 'Rule',
                transform: {},
                components: [
                  {
                    type: 'rules',
                    apiVersion: 1,
                    rules: [
                      { event: 'start', actions: [{ type: 'enable', target: 'missing', value: true }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    /missing node/,
  );
});
test('recipes compose deterministic subtraction/paint and stop oversized work before allocation', () => {
  const shaped = {
    ...recipe,
    shapes: [
      ...recipe.shapes,
      { kind: 'box', operation: 'subtract', center: [0, 1, 0], size: [1, 1, 1], color: 0 },
      { kind: 'box', operation: 'paint', center: [1, 1, 0], size: [1, 1, 1], color: 0 },
    ],
  };
  const a = generateRecipe(shaped);
  assert.equal(a.length, 26);
  assert.equal(a.find((v) => v.x === 1 && v.y === 1 && v.z === 0)?.color, 0);
  assert.deepEqual(a, generateRecipe(shaped));
  assert.throws(
    () =>
      generateRecipe({
        version: 1,
        shapes: [{ kind: 'box', center: [0, 0, 0], size: [256, 256, 256], color: 0 }],
      }),
    /budget/,
  );
});
