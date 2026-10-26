import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore } from '../server/projectStore';
import { buildGame } from '../server/gameBuild';
import { generateRecipe } from '../services/recipeGenerator';
import {
  applyProjectOperations,
  assetSchema,
  identityTransform,
  newProject,
  projectAuthoringView,
  validateProject,
} from '../services/projectDocument';
import { createModelDocument } from '../services/modelDocument';
import { createWorldChunkStore, worldDocumentSchema } from '../services/worldDocument';
import { terrainEditsFromHit } from '../runtime/GameViewport';

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
  const detachedRead = await store.read('project');
  assert.deepEqual(detachedRead, result.project);
  detachedRead.name = 'Caller-owned mutation';
  assert.deepEqual(
    await store.read('project'),
    result.project,
    'Mutating the returned document cannot alter the persisted project.',
  );
  const restart = new ProjectStore(directory);
  const undone = await restart.history('project', 'undo', { expectedRevision: 1, requestId: 'undo-fox' });
  assert.equal(undone.project.assets.length, 0);
  assert.equal(undone.project.revision, 2);
  const redone = await restart.history('project', 'redo', { expectedRevision: 2, requestId: 'redo-fox' });
  assert.deepEqual(redone.project.assets, result.project.assets);
  assert.equal(redone.project.revision, 3);
  result.project.assets[0].name = 'Caller-owned commit response mutation';
  assert.equal(
    (await restart.read('project')).assets[0].name,
    'Fox',
    'Mutating a commit response cannot alter the saved project.',
  );
});
test('imported sculpt draft voxel size survives restart and history, then clears when an authored asset opens', async (t) => {
  const scratchRoot = path.resolve(process.cwd(), '.voxshop/engine-development/completion-20261025');
  const directory = path.join(scratchRoot, `scale-draft-store-${randomUUID()}`);
  assert.ok(directory.startsWith(`${scratchRoot}${path.sep}`));
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(directory);
  await store.create('Project', 'project');
  const importedVoxelSize = 0.14498056769728357;
  const draft = createModelDocument([{ x: 0, y: -11, z: 0, color: 0x6b87a8 }]);
  const imported = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'import-scale-draft',
    operations: [{ type: 'editor.set', assetId: null, draft, draftVoxelSize: importedVoxelSize }],
  });
  assert.equal(imported.project.editorDraftVoxelSize, importedVoxelSize);
  assert.deepEqual(imported.project.editorDraft?.voxels, draft.voxels);

  const restart = new ProjectStore(directory);
  const reopened = await restart.read('project');
  assert.equal(reopened.editorDraftVoxelSize, importedVoxelSize);
  assert.deepEqual(reopened.editorDraft?.voxels, draft.voxels);
  assert.equal('editorDraftVoxelSize' in projectAuthoringView(reopened), false);
  const legacy = structuredClone(reopened);
  delete legacy.editorDraftVoxelSize;
  assert.equal(validateProject(legacy).editorDraftVoxelSize, undefined);

  const undone = await restart.history('project', 'undo', {
    expectedRevision: 1,
    requestId: 'undo-import-scale-draft',
  });
  assert.equal(undone.project.editorDraftVoxelSize, null);
  const redone = await restart.history('project', 'redo', {
    expectedRevision: 2,
    requestId: 'redo-import-scale-draft',
  });
  assert.equal(redone.project.editorDraftVoxelSize, importedVoxelSize);

  const importedAsset = assetSchema.parse({
    id: 'imported-asset',
    name: 'Imported mesh',
    model: draft,
    voxelSize: importedVoxelSize,
    pivot: [0, -11, 0],
    source: { kind: 'imported', description: 'Voxelized 3D mesh import' },
  });
  const saved = await restart.commit('project', {
    expectedRevision: 3,
    requestId: 'save-imported-scale-draft',
    operations: [
      { type: 'asset.put', asset: importedAsset },
      { type: 'editor.set', assetId: importedAsset.id, draft, draftVoxelSize: null },
    ],
  });
  const storedAsset = saved.project.assets.find((asset) => asset.id === importedAsset.id)!;
  assert.equal(storedAsset.voxelSize, importedVoxelSize);
  assert.deepEqual(storedAsset.pivot, [0, -11, 0]);
  assert.equal(storedAsset.source.kind, 'imported');
  assert.equal(
    saved.project.editorDraftVoxelSize,
    null,
    'saving moves the hint into the asset and clears the draft',
  );

  const authored = assetSchema.parse({
    id: 'authored-asset',
    name: 'Authored asset',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x123456 }]),
    voxelSize: 0.1,
    source: { kind: 'authored', description: '' },
  });
  const opened = await restart.commit('project', {
    expectedRevision: 4,
    requestId: 'open-authored-asset',
    operations: [
      { type: 'asset.put', asset: authored },
      { type: 'editor.set', assetId: authored.id, draft: authored.model },
    ],
  });
  assert.equal(opened.project.editorDraftVoxelSize, null);
});
test('sparse asset-only commits preserve cap-scale history and persisted caller isolation', async (t) => {
  const { store, directory } = await fixture(t);
  await store.commit('project', {
    expectedRevision: 0,
    requestId: 'add-sparse-edit-asset',
    operations: [
      {
        type: 'asset.put',
        asset: assetSchema.parse({
          id: 'sparse-edit-asset',
          name: 'Sparse edit asset',
          model: createModelDocument([
            { x: 0, y: 0, z: 0, color: 0x123456 },
            { x: 1, y: 0, z: 0, color: 0x654321 },
          ]),
        }),
      },
    ],
  });
  const edited = await store.commit('project', {
    expectedRevision: 1,
    requestId: 'paint-one-voxel',
    operations: [
      {
        type: 'asset.edit',
        id: 'sparse-edit-asset',
        edit: { mode: 'paint', targets: [{ x: 1, y: 0, z: 0 }], color: 0xff00ff },
      },
      {
        type: 'asset.edit',
        id: 'sparse-edit-asset',
        edit: { mode: 'paint', targets: [{ x: 1, y: 0, z: 0 }], color: 0xaabbcc },
      },
      {
        type: 'asset.edit',
        id: 'sparse-edit-asset',
        edit: { mode: 'delete', targets: [{ x: 0, y: 0, z: 0 }] },
      },
      {
        type: 'asset.edit',
        id: 'sparse-edit-asset',
        edit: { mode: 'add', targets: [{ x: 2, y: 0, z: 0 }], color: 0xffffff },
      },
      {
        type: 'asset.edit',
        id: 'sparse-edit-asset',
        edit: { mode: 'paint', targets: [{ x: 2, y: 0, z: 0 }], color: 0x13579b },
      },
      {
        type: 'asset.edit',
        id: 'sparse-edit-asset',
        edit: { mode: 'lock', targets: [{ x: 2, y: 0, z: 0 }] },
      },
    ],
  });
  assert.equal(edited.project.revision, 2);
  assert.equal(edited.project.assets[0].model.voxels.find((voxel) => voxel.x === 1)?.color, 0xaabbcc);
  assert.equal(edited.project.assets[0].model.voxels.find((voxel) => voxel.x === 2)?.color, 0x13579b);
  assert.equal(edited.project.assets[0].model.voxels.find((voxel) => voxel.x === 2)?.isLocked, true);
  const expectedVoxels = structuredClone(edited.project.assets[0].model.voxels);
  edited.project.assets[0].model.voxels[0].color = 0xabcdef;
  const restart = new ProjectStore(directory);
  const undone = await restart.history('project', 'undo', { expectedRevision: 2, requestId: 'undo-paint' });
  assert.deepEqual(
    undone.project.assets[0].model.voxels.map(({ x, color }) => [x, color]),
    [
      [0, 0x123456],
      [1, 0x654321],
    ],
  );
  const redone = await restart.history('project', 'redo', { expectedRevision: 3, requestId: 'redo-paint' });
  assert.deepEqual(redone.project.assets[0].model.voxels, expectedVoxels);
});
test('equipment fit bounds and fitted attachments survive project save, restart, undo, and redo', async (t) => {
  const { store, directory } = await fixture(t),
    body = assetSchema.parse({
      id: 'fit-body',
      name: 'Fit body',
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0xffffff, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
      ]),
      rig: {
        profile: 'humanoid',
        version: 1,
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'hand', parent: 'root', position: [0, 1, 0] },
        ],
        landmarks: {},
        sockets: [
          {
            name: 'hand',
            joint: 'hand',
            transform: {},
            fitBounds: { min: [-0.15, -0.1, -0.1], max: [0.45, 0.3, 0.1] },
          },
        ],
        clips: [],
      },
    }),
    gear = assetSchema.parse({
      id: 'fit-gear',
      name: 'Fit gear',
      voxelSize: 0.1,
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0x885533, bone: 'gear-root', weights: [{ bone: 'gear-root', weight: 1 }] },
        { x: 2, y: 0, z: 0, color: 0x885533, bone: 'gear-root', weights: [{ bone: 'gear-root', weight: 1 }] },
      ]),
      rig: {
        profile: 'humanoid',
        version: 1,
        joints: [{ name: 'gear-root', parent: null, position: [0, 0, 0] }],
        sockets: [],
        clips: [],
      },
    });
  await store.commit('project', {
    expectedRevision: 0,
    requestId: 'seed-fit-project',
    operations: [
      { type: 'asset.put', asset: body },
      { type: 'asset.put', asset: gear },
      {
        type: 'node.put',
        sceneId: 'main',
        node: {
          id: 'fit-wearer',
          name: 'Fit wearer',
          assetId: body.id,
          parentId: null,
          transform: identityTransform(),
          enabled: true,
          components: [],
          attachments: [
            {
              assetId: gear.id,
              socket: 'hand',
              slot: 'custom',
              transform: identityTransform(),
              hiddenBones: [],
            },
          ],
        },
      },
    ],
  });
  const operation = {
    type: 'node.fit-attachment',
    sceneId: 'main',
    nodeId: 'fit-wearer',
    slot: 'custom',
  };
  await store.commit('project', {
    expectedRevision: 1,
    requestId: 'fit-gear',
    operations: [operation],
  });

  const restarted = new ProjectStore(directory),
    saved = await restarted.read('project'),
    savedBody = saved.assets.find((asset) => asset.id === body.id)!,
    savedAttachment = saved.scenes[0].nodes[0].attachments[0];
  assert.deepEqual(savedBody.rig?.sockets[0].fitBounds, body.rig?.sockets[0].fitBounds);
  assert.deepEqual(savedAttachment.transform.scale, [2, 2, 2]);

  const undone = await restarted.history('project', 'undo', {
    expectedRevision: 2,
    requestId: 'undo-gear-fit',
  });
  assert.deepEqual(undone.project.scenes[0].nodes[0].attachments[0].transform, identityTransform());
  assert.deepEqual(
    undone.project.assets.find((asset) => asset.id === body.id)?.rig?.sockets[0].fitBounds,
    body.rig?.sockets[0].fitBounds,
  );
  const redone = await restarted.history('project', 'redo', {
    expectedRevision: 3,
    requestId: 'redo-gear-fit',
  });
  assert.deepEqual(redone.project.scenes[0].nodes[0].attachments[0].transform, savedAttachment.transform);
});
test('saved prefabs and placed nodes persist as one undoable authoring history', async (t) => {
  const { store, directory } = await fixture(t);
  await store.commit('project', {
    expectedRevision: 0,
    requestId: 'save-crate-prefab',
    operations: [
      {
        type: 'prefab.put',
        prefab: {
          id: 'crate-prefab',
          name: 'Crate',
          rootId: 'crate',
          nodes: [
            { id: 'crate', name: 'Crate', transform: {} },
            { id: 'crate-mark', name: 'Mark', parentId: 'crate', transform: {} },
          ],
        },
      },
    ],
  });
  await store.commit('project', {
    expectedRevision: 1,
    requestId: 'place-crate-prefab',
    operations: [
      {
        type: 'prefab.instantiate',
        prefabId: 'crate-prefab',
        sceneId: 'main',
        nodeIds: ['crate-instance', 'mark-instance'],
      },
    ],
  });

  const restarted = new ProjectStore(directory);
  const persisted = await restarted.read('project');
  assert.equal(persisted.prefabs[0].nodes.length, 2);
  assert.deepEqual(
    persisted.scenes[0].nodes.map((node) => [node.id, node.parentId]),
    [
      ['crate-instance', null],
      ['mark-instance', 'crate-instance'],
    ],
  );
  const undone = await restarted.history('project', 'undo', {
    expectedRevision: 2,
    requestId: 'undo-crate-place',
  });
  assert.equal(undone.project.prefabs[0].id, 'crate-prefab');
  assert.equal(undone.project.scenes[0].nodes.length, 0);
  const redone = await restarted.history('project', 'redo', {
    expectedRevision: 3,
    requestId: 'redo-crate-place',
  });
  assert.equal(redone.project.scenes[0].nodes.length, 2);
});

test('seeded scatter persists and its entire group creation is one undo/redo entry', async (t) => {
  const { store, directory } = await fixture(t);
  const result = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'scatter-create',
    operations: [
      generate,
      {
        type: 'scene.scatter.create',
        sceneId: 'main',
        id: 'scatter-1',
        assetId: 'fox',
        seed: 12,
        count: 5,
        bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
        snapToTerrain: false,
        groundY: 0,
        scaleRange: [1, 1],
        randomYaw: false,
      },
    ],
  });

  const restarted = new ProjectStore(directory);
  const persisted = await restarted.read('project');
  assert.equal(persisted.scenes[0].nodes.length, 5);
  assert.equal(persisted.scenes[0].scatterGroups?.[0].id, 'scatter-1');
  const undone = await restarted.history('project', 'undo', {
    expectedRevision: result.project.revision,
    requestId: 'undo-scatter',
  });
  assert.equal(undone.project.assets.length, 0);
  assert.equal(undone.project.scenes[0].nodes.length, 0);
  assert.equal(undone.project.scenes[0].scatterGroups?.length ?? 0, 0);
  const redone = await restarted.history('project', 'redo', {
    expectedRevision: undone.project.revision,
    requestId: 'redo-scatter',
  });
  assert.equal(redone.project.scenes[0].nodes.length, 5);
  assert.equal(redone.project.scenes[0].scatterGroups?.[0].id, 'scatter-1');
});
test('rigid-body settings survive persistence and undo/redo', async (t) => {
  const { store, directory } = await fixture(t);
  const node = {
    id: 'falling-prop',
    name: 'Falling prop',
    transform: {},
    components: [
      { type: 'collider', size: [1, 1, 1], offset: [0, 0.5, 0], solid: true },
      { type: 'rigid-body', gravity: 9.8, linearDamping: 0.3, restitution: 0.65, velocity: [1, 2, 3] },
    ],
  };
  const committed = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'add-rigid-body',
    operations: [{ type: 'node.put', sceneId: 'main', node }],
  });
  const persisted = new ProjectStore(directory);
  assert.deepEqual(
    (await persisted.read('project')).scenes[0].nodes[0].components,
    committed.project.scenes[0].nodes[0].components,
  );
  const undone = await persisted.history('project', 'undo', {
    expectedRevision: 1,
    requestId: 'undo-rigid-body',
  });
  assert.equal(undone.project.scenes[0].nodes.length, 0);
  const redone = await persisted.history('project', 'redo', {
    expectedRevision: 2,
    requestId: 'redo-rigid-body',
  });
  assert.deepEqual(
    redone.project.scenes[0].nodes[0].components,
    committed.project.scenes[0].nodes[0].components,
  );
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
test('recovery backups keep only the previous project and recovery validates it and clears history', async (t) => {
  const { store, directory } = await fixture(t);
  const previous = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'first',
    operations: [generate],
  });
  const latest = await store.commit('project', {
    expectedRevision: 1,
    requestId: 'second',
    operations: [{ type: 'project.rename', name: 'Latest project' }],
  });
  const backupPath = path.join(directory, 'project.json.bak');
  const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  assert.deepEqual(backup, { project: previous.project });

  await fs.writeFile(backupPath, JSON.stringify({ project: { ...previous.project, version: 2 } }));
  await assert.rejects(store.recover('project'));
  assert.deepEqual(await store.read('project'), latest.project);

  // Backups written by earlier releases contain history too; recovery still accepts and clears it.
  await fs.writeFile(
    backupPath,
    JSON.stringify({
      ...backup,
      undo: [previous.project],
      redo: [latest.project],
      receipts: [{ id: 'legacy-receipt', digest: 'old', revision: 1 }],
    }),
  );
  await fs.writeFile(path.join(directory, 'project.json'), '{broken');
  await assert.rejects(store.read('project'), /recovery/);
  const recovered = await store.recover('project');
  assert.ok(recovered.revision > 1);
  assert.deepEqual(recovered.assets, previous.project.assets);
  const recoveredState = JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8'));
  assert.deepEqual(recoveredState.undo, []);
  assert.deepEqual(recoveredState.redo, []);
  assert.deepEqual(recoveredState.receipts, []);
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
  const rigged = applyProjectOperations(p, [
    {
      type: 'asset.character',
      id: 'skinned',
      name: 'Skinned character',
      profile: 'biped',
    },
  ]);
  const target = rigged.assets[0].model.voxels[0];
  assert.throws(
    () =>
      applyProjectOperations(rigged, [
        {
          type: 'asset.edit',
          id: 'skinned',
          edit: {
            mode: 'weight',
            targets: [{ x: target.x, y: target.y, z: target.z }],
            weights: [{ bone: 'missing-joint', weight: 1 }],
          },
        },
      ]),
    /joint missing from the asset rig/,
  );
  const unrigged = applyProjectOperations(p, [generate]);
  assert.throws(
    () =>
      applyProjectOperations(unrigged, [
        {
          type: 'asset.edit',
          id: 'fox',
          edit: { mode: 'weight', targets: [{ x: 0, y: 1, z: 0 }], weights: [{ bone: 'Root', weight: 1 }] },
        },
      ]),
    /only be assigned to an asset with a rig/,
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
test('recipe rotations preserve v1 output by default and rotate primitive occupancy around its center', () => {
  const legacy = {
    version: 1,
    seed: 73,
    shapes: [
      { kind: 'box', center: [0, 0, 0], size: [4, 3, 2], color: 0xaa2211 },
      { kind: 'ellipsoid', center: [3, 1, 0], size: [4, 4, 4], color: 0x22aa11 },
      { kind: 'cylinder', center: [-3, 1, 0], size: [3, 4, 3], color: 0x1122aa },
      { kind: 'terrain', center: [0, 0, 0], size: [5, 4, 5], color: 0x778899, noise: 0.2 },
    ],
  };
  const original = generateRecipe(legacy);
  assert.equal(
    createHash('sha256').update(JSON.stringify(original)).digest('hex'),
    'b399c88755ccbbfe5d7b97f25f046838980f5cc663312d6113bc7cece78b5cde',
  );
  assert.deepEqual(
    generateRecipe({
      ...legacy,
      shapes: legacy.shapes.map((shape) =>
        shape.kind === 'terrain' ? shape : { ...shape, rotation: [0, 0, 0] },
      ),
    }),
    original,
  );

  const bounds = { minX: -1, maxX: 0, minY: -2, maxY: 1, minZ: -1, maxZ: 0 };
  for (const [kind, count] of [
    ['box', 16],
    ['ellipsoid', 6],
    ['cylinder', 10],
  ] as const) {
    const voxels = generateRecipe({
      version: 1,
      shapes: [{ kind, center: [0, 0, 0], size: [4, 2, 2], color: 0x55aaee, rotation: [0, 0, Math.PI / 2] }],
    });
    assert.equal(voxels.length, count, `${kind} should retain its rotated volume`);
    assert.deepEqual(
      {
        minX: Math.min(...voxels.map((voxel) => voxel.x)),
        maxX: Math.max(...voxels.map((voxel) => voxel.x)),
        minY: Math.min(...voxels.map((voxel) => voxel.y)),
        maxY: Math.max(...voxels.map((voxel) => voxel.y)),
        minZ: Math.min(...voxels.map((voxel) => voxel.z)),
        maxZ: Math.max(...voxels.map((voxel) => voxel.z)),
      },
      bounds,
    );
    const occupied = new Set(voxels.map(({ x, y, z }) => `${x},${y},${z}`));
    assert.ok(occupied.has('0,0,0'));
    if (kind === 'ellipsoid') {
      assert.ok(occupied.has('0,-2,0'));
      assert.ok(!occupied.has('0,-2,-1'));
    }
    if (kind === 'cylinder') {
      assert.ok(occupied.has('-1,-2,0'));
      assert.ok(!occupied.has('-1,-2,-1'));
    }
  }

  const diagonalBox = generateRecipe({
    version: 1,
    shapes: [
      { kind: 'box', center: [0, 0, 0], size: [2, 2, 2], color: 0x55aaee, rotation: [0, 0, Math.PI / 4] },
    ],
  });
  const diagonalOccupancy = new Set(diagonalBox.map(({ x, y, z }) => `${x},${y},${z}`));
  assert.equal(diagonalBox.length, 10);
  assert.ok(diagonalOccupancy.has('0,0,0'));
  assert.ok(!diagonalOccupancy.has('-1,-1,-1'));
  assert.ok(!diagonalOccupancy.has('1,1,0'));

  assert.throws(
    () =>
      generateRecipe({
        version: 1,
        shapes: [{ kind: 'terrain', center: [0, 0, 0], size: [4, 2, 2], color: 0, rotation: [0, 0, 1] }],
      }),
    /Terrain recipe shapes do not support rotation/,
  );
});
test('terrain recipes produce deterministic varied heights from their seed', () => {
  const input = {
    version: 1,
    seed: 42,
    shapes: [
      {
        kind: 'terrain',
        center: [0, 8, 0],
        size: [32, 16, 32],
        color: 0x557744,
        noise: 0.5,
        palette: {
          surface: 0x62964b,
          subsurface: 0x725439,
          deep: 0x686b70,
          surfaceDepth: 2,
          subsurfaceDepth: 3,
        },
      },
    ],
  };
  const first = generateRecipe(input);
  assert.deepEqual(first, generateRecipe(input));
  assert.notDeepEqual(first, generateRecipe({ ...input, seed: 43 }));

  const topByColumn = new Map<string, number>();
  for (const voxel of first) {
    const key = `${voxel.x},${voxel.z}`;
    topByColumn.set(key, Math.max(topByColumn.get(key) ?? -Infinity, voxel.y));
  }
  assert.ok(new Set(topByColumn.values()).size > 1, 'terrain should contain more than one surface height');
  assert.deepEqual(
    new Set(first.map((voxel) => voxel.color)),
    new Set([0x62964b, 0x725439, 0x686b70]),
    'palette colors should produce surface, soil and deep terrain layers',
  );
  assert.throws(
    () =>
      generateRecipe({
        ...input,
        shapes: [{ ...input.shapes[0], kind: 'box' }],
      }),
    /only be used on terrain/,
  );
});
test('generated terrain and characters retain independent per-asset voxel spacing', () => {
  const project = applyProjectOperations(newProject('scale-test', 'Voxel scale test'), [
    { type: 'asset.generate', id: 'terrain', name: 'Terrain', recipe, voxelSize: 0.5 },
    { type: 'asset.character', id: 'hero', name: 'Hero', profile: 'biped', voxelSize: 0.04 },
  ]);
  assert.equal(project.assets.find((asset) => asset.id === 'terrain')?.voxelSize, 0.5);
  assert.equal(project.assets.find((asset) => asset.id === 'hero')?.voxelSize, 0.04);
  assert.equal(project.assets.find((asset) => asset.id === 'terrain')?.model.voxels.length, 27);
  assert.ok((project.assets.find((asset) => asset.id === 'hero')?.rig?.joints.length ?? 0) > 1);
});

const world = {
  type: 'world.create',
  id: 'island',
  name: 'Island',
  seed: 42,
  chunkSize: 4,
  voxelSize: 0.25,
  generator: {
    type: 'terrain',
    version: 1,
    origin: [0, 0],
    size: [4, 4],
    minY: 0,
    maxY: 3,
    baseHeight: 2,
    amplitude: 0,
    palette: {
      surface: 0x55aa44,
      subsurface: 0x725439,
      deep: 0x686b70,
      surfaceDepth: 1,
      subsurfaceDepth: 2,
      materialType: 'STANDARD',
    },
  },
} as const;

test('world transactions persist sparse edits and keep undo/redo across restart', async (t) => {
  const { store, directory } = await fixture(t);
  await assert.rejects(
    store.commit('project', {
      expectedRevision: 0,
      requestId: 'bad-world-batch',
      operations: [
        world,
        { type: 'world.edit', worldId: 'missing', edits: [{ x: 0, y: 0, z: 0, value: null }] },
      ],
    }),
    /does not exist/,
  );
  await assert.rejects(
    store.commit('project', {
      expectedRevision: 0,
      requestId: 'oversized-world-batch',
      operations: [
        world,
        {
          type: 'world.edit',
          worldId: 'island',
          edits: Array.from({ length: 6000 }, (_, x) => ({ x, y: 0, z: 0, value: null })),
        },
        {
          type: 'world.edit',
          worldId: 'island',
          edits: Array.from({ length: 6000 }, (_, x) => ({ x: x + 6000, y: 0, z: 0, value: null })),
        },
      ],
    }),
    /10,000 world cell edits/,
  );
  assert.deepEqual((await store.read('project')).worlds, []);

  const result = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'make-island',
    operations: [
      world,
      {
        type: 'world.edit',
        worldId: 'island',
        edits: [
          { x: 1, y: 1, z: 1, value: null },
          { x: 1, y: 3, z: 1, value: { color: 0xffffff, materialType: 'EMISSIVE' } },
        ],
      },
    ],
  });
  assert.equal(result.project.worlds[0].voxelSize, 0.25);
  assert.deepEqual(
    result.project.worlds[0].edits.map((edit) => edit.value),
    [null, { color: 0xffffff, materialType: 'EMISSIVE' }],
  );

  const restarted = new ProjectStore(directory);
  const restored = await restarted.read('project');
  const chunks = createWorldChunkStore(restored.worlds[0]);
  assert.equal(chunks.get({ x: 1, y: 1, z: 1 }), undefined, 'tombstone hides generated terrain');
  assert.deepEqual(chunks.get({ x: 1, y: 3, z: 1 }), { color: 0xffffff, materialType: 'EMISSIVE' });
  assert.equal(chunks.get({ x: 4, y: 1, z: 1 }), undefined, 'terrain stays inside its descriptor bounds');

  const undone = await restarted.history('project', 'undo', {
    expectedRevision: 1,
    requestId: 'undo-island',
  });
  assert.deepEqual(undone.project.worlds, []);
  const redone = await restarted.history('project', 'redo', {
    expectedRevision: 2,
    requestId: 'redo-island',
  });
  assert.deepEqual(redone.project.worlds, restored.worlds);

  const gameProject = validateProject({
    ...redone.project,
    scenes: redone.project.scenes.map((scene) => ({ ...scene, worldId: 'island' })),
  });
  const game = await buildGame(gameProject, 'main', {
    root: process.cwd(),
    directory: path.join(directory, 'world-export'),
  });
  const html = await fs.readFile(game.path, 'utf8');
  const embeddedProject = JSON.parse(
    html.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
  );
  assert.equal(embeddedProject.worlds.length, 1);
  const portableChunks = createWorldChunkStore(embeddedProject.worlds[0]);
  portableChunks.unloadAll();
  assert.equal(
    portableChunks.get({ x: 1, y: 1, z: 1 }),
    undefined,
    'Portable tombstone still hides generated terrain.',
  );
  assert.deepEqual(
    portableChunks.get({ x: 1, y: 3, z: 1 }),
    { color: 0xffffff, materialType: 'EMISSIVE' },
    'Portable sparse addition survives save, restart, export and chunk rehydration.',
  );
});

test('a volumetric terrain stamp is undone as one transaction', async (t) => {
  const { store } = await fixture(t);
  await store.commit('project', {
    expectedRevision: 0,
    requestId: 'create-brush-world',
    operations: [world],
  });
  const brush = terrainEditsFromHit(
    worldDocumentSchema.parse({ ...world, id: 'island', edits: [] }),
    'place',
    [0.125, 0.625, 0.125],
    [0, 1, 0],
    false,
    3,
    'surface',
    undefined,
    'cube',
  );
  const placed = await store.commit('project', {
    expectedRevision: 1,
    requestId: 'place-terrain-cube',
    label: 'Place terrain cube',
    operations: [{ type: 'world.edit', worldId: 'island', edits: brush }],
  });
  assert.equal(placed.project.worlds[0].edits.length, 27);

  const undone = await store.history('project', 'undo', { expectedRevision: 2, requestId: 'undo-cube' });
  assert.deepEqual(undone.project.worlds[0].edits, []);
  const redone = await store.history('project', 'redo', { expectedRevision: 3, requestId: 'redo-cube' });
  assert.deepEqual(redone.project.worlds[0].edits, placed.project.worlds[0].edits);
});

test('world.update merges settings, preserves edits, validates the full descriptor and supports undo', async (t) => {
  const { store } = await fixture(t);
  const created = await store.commit('project', {
    expectedRevision: 0,
    requestId: 'create-editable-island',
    operations: [
      world,
      {
        type: 'world.edit',
        worldId: 'island',
        edits: [
          { x: 1, y: 1, z: 1, value: null },
          { x: 1, y: 3, z: 1, value: { color: 0xffffff, materialType: 'EMISSIVE' } },
        ],
      },
    ],
  });
  const original = created.project.worlds[0];

  await assert.rejects(
    store.commit('project', {
      expectedRevision: 1,
      requestId: 'invalid-island-update',
      operations: [{ type: 'world.update', worldId: 'island', generator: { maxY: 1 } }],
    }),
    /Terrain baseHeight must be within its vertical bounds\./,
  );
  assert.deepEqual((await store.read('project')).worlds[0], original);

  const updated = await store.commit('project', {
    expectedRevision: 1,
    requestId: 'update-island',
    operations: [
      {
        type: 'world.update',
        worldId: 'island',
        name: 'Updated island',
        seed: 84,
        chunkSize: 8,
        voxelSize: 0.5,
        generator: {
          mode: 'voxel3d',
          amplitude: 8,
          landformScale: 96,
          caveDepth: 36,
          caveEntrancesPerRegion: 4,
          caveBranchCount: 3,
          caveCrossPassage: true,
          caveNetwork: true,
          caveNetworkReach: 512,
          overhangDensity: 0.7,
          overhangMaxHeight: 48,
          overhangProfile: [1, 0.75, 0],
          overhangFootprint: [
            [0, 0.5],
            [1, 1],
          ],
          overhangHeightMap: [
            [0, 0.25],
            [0.75, 1],
          ],
          palette: { surface: 0x123456 },
        },
      },
    ],
  });
  const changed = updated.project.worlds[0];
  assert.equal(changed.name, 'Updated island');
  assert.equal(changed.seed, 84);
  assert.equal(changed.chunkSize, 8);
  assert.equal(changed.voxelSize, 0.5);
  assert.equal(changed.generator.amplitude, 8);
  assert.equal(changed.generator.landformScale, 96);
  assert.equal(changed.generator.caveDepth, 36);
  assert.equal(changed.generator.caveEntrancesPerRegion, 4);
  assert.equal(changed.generator.caveBranchCount, 3);
  assert.equal(changed.generator.caveCrossPassage, true);
  assert.equal(changed.generator.caveNetwork, true);
  assert.equal(changed.generator.caveNetworkReach, 512);
  assert.equal(changed.generator.mode, 'voxel3d');
  assert.equal(changed.generator.overhangDensity, 0.7);
  assert.equal(changed.generator.overhangMaxHeight, 48);
  assert.deepEqual(changed.generator.overhangProfile, [1, 0.75, 0]);
  assert.deepEqual(changed.generator.overhangFootprint, [
    [0, 0.5],
    [1, 1],
  ]);
  assert.deepEqual(changed.generator.overhangHeightMap, [
    [0, 0.25],
    [0.75, 1],
  ]);
  assert.equal(changed.generator.noise, original.generator.noise);
  assert.equal(changed.generator.palette.surface, 0x123456);
  assert.equal(changed.generator.palette.surfaceDepth, original.generator.palette.surfaceDepth);
  assert.deepEqual(changed.edits, original.edits);

  const undone = await store.history('project', 'undo', {
    expectedRevision: 2,
    requestId: 'undo-island-update',
  });
  assert.deepEqual(undone.project.worlds[0], original);
  const redone = await store.history('project', 'redo', {
    expectedRevision: 3,
    requestId: 'redo-island-update',
  });
  assert.deepEqual(redone.project.worlds[0], changed);
  const cleared = await store.commit('project', {
    expectedRevision: 4,
    requestId: 'clear-island-overhang-profiles',
    operations: [
      {
        type: 'world.update',
        worldId: 'island',
        generator: { overhangProfile: null, overhangFootprint: null, overhangHeightMap: null },
      },
    ],
  });
  assert.equal(cleared.project.worlds[0].generator.overhangProfile, undefined);
  assert.equal(cleared.project.worlds[0].generator.overhangFootprint, undefined);
  assert.equal(cleared.project.worlds[0].generator.overhangHeightMap, undefined);
});

test('older version-one files load and large terrain extents hydrate only the requested chunk', async (t) => {
  const { directory } = await fixture(t);
  const legacy = newProject('project', 'Project') as any;
  delete legacy.worlds;
  await fs.writeFile(
    path.join(directory, 'project.json'),
    JSON.stringify({ project: legacy, undo: [], redo: [], receipts: [] }),
  );
  assert.deepEqual((await new ProjectStore(directory).read('project')).worlds, []);

  const largeProject = applyProjectOperations(newProject('large', 'Large world'), [
    { ...world, generator: { ...world.generator, size: [1_000_000, 1_000_000] } },
  ]);
  const chunks = createWorldChunkStore(largeProject.worlds[0]);
  assert.equal(chunks.get({ x: 999_999, y: 2, z: 999_999 })?.color, 0x55aa44);
  assert.equal(
    chunks.loadedChunkCount(),
    1,
    'reading a distant position generates only its containing chunk',
  );

  assert.throws(
    () =>
      applyProjectOperations(newProject('p', 'Project'), [
        { ...world, generator: { ...world.generator, origin: [1_000_000_000, 0], size: [2, 2] } },
      ]),
    /bounds exceed/,
  );
});
