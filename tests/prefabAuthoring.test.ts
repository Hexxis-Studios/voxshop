import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrefabFromInstance, createPrefabFromSubtree } from '../services/prefabAuthoring';
import {
  applyProjectOperations,
  componentSchema,
  newProject,
  validateProject,
  type SceneNode,
} from '../services/projectDocument';

const node = (id: string, parentId: string | null = null, extra: Partial<SceneNode> = {}): SceneNode => ({
  id,
  name: id,
  assetId: null,
  parentId,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  enabled: true,
  components: [],
  attachments: [],
  ...extra,
});

test('old project documents load with an empty prefab library', () => {
  const project = newProject('old-prefabs', 'Old project');
  const { prefabs: _prefabs, ...oldDocument } = project;
  assert.deepEqual(validateProject(oldDocument).prefabs, []);
});

test('saving a subtree detaches its root while preserving the external parent dependency', () => {
  const parent = node('assembly');
  const root = node('door', parent.id, { transform: { ...node('unused').transform, position: [1, 2, 3] } });
  const child = node('handle', root.id);
  const outside = node('unrelated');
  const sceneNodes = [parent, root, child, outside];

  const prefab = createPrefabFromSubtree(sceneNodes, root.id, 'door-prefab', 'Door');

  assert.equal(prefab.attachmentParentId, parent.id);
  assert.equal(prefab.rootId, root.id);
  assert.deepEqual(
    prefab.nodes.map((entry) => entry.id),
    ['door', 'handle'],
  );
  assert.equal(prefab.nodes[0].parentId, null);
  assert.equal(prefab.nodes[1].parentId, 'door');
  assert.deepEqual(prefab.nodes[0].transform.position, [1, 2, 3]);
  assert.equal(sceneNodes[1].parentId, parent.id);
  assert.equal(sceneNodes.length, 4);
});

test('prefab transactions remap internal hierarchy and rule targets and can override the root position', () => {
  let project = newProject('prefab-use', 'Prefab use');
  const original = node('switch', 'assembly', {
    components: [
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'collision',
            interval: 1,
            once: false,
            actions: [
              { type: 'enable', target: 'cover', value: false },
              { type: 'destroy', target: '$other' },
            ],
          },
        ],
      },
    ],
  });
  project = applyProjectOperations(project, [
    { type: 'node.put', sceneId: 'main', node: node('assembly') },
    { type: 'node.put', sceneId: 'main', node: original },
    { type: 'node.put', sceneId: 'main', node: node('cover', 'switch') },
    {
      type: 'prefab.put',
      prefab: {
        id: 'switch-prefab',
        name: 'Switch assembly',
        rootId: 'switch',
        attachmentParentId: 'assembly',
        nodes: [node('switch', null, { ...original, parentId: null }), node('cover', 'switch')],
      },
    },
  ]);
  const placed = applyProjectOperations(project, [
    {
      type: 'prefab.instantiate',
      prefabId: 'switch-prefab',
      sceneId: 'main',
      nodeIds: ['switch-copy', 'cover-copy'],
      rootName: 'Second switch',
      position: [5, 2, -3],
    },
  ]);

  const root = placed.scenes[0].nodes.find((entry) => entry.id === 'switch-copy')!;
  const child = placed.scenes[0].nodes.find((entry) => entry.id === 'cover-copy')!;
  assert.equal(root.name, 'Second switch');
  assert.deepEqual(root.transform.position, [5, 2, -3]);
  assert.equal(root.parentId, 'assembly');
  assert.equal(child.parentId, root.id);
  assert.deepEqual((root.components[0] as any).rules[0].actions, [
    { type: 'enable', target: child.id, value: false },
    { type: 'destroy', target: '$other' },
  ]);
  assert.equal(project.scenes[0].nodes.length, 3);
  assert.equal(placed.prefabs.length, 1);
  assert.throws(
    () => applyProjectOperations(project, [{ type: 'node.delete', sceneId: 'main', id: 'assembly' }]),
    /missing or internal attachment parent/,
  );
  assert.equal(project.scenes[0].nodes[0].id, 'assembly');
});

test('linked prefab updates propagate source changes, preserve local overrides, and add authored children', () => {
  const sourceNodes = [node('switch'), node('cover', 'switch')];
  let prefab = createPrefabFromSubtree(sourceNodes, 'switch', 'switch-prefab', 'Switch');
  let project = applyProjectOperations(newProject('linked-prefab', 'Linked prefab'), [
    { type: 'prefab.put', prefab },
    {
      type: 'prefab.instantiate',
      prefabId: prefab.id,
      sceneId: 'main',
      nodeIds: ['left-root', 'left-cover'],
    },
    {
      type: 'prefab.instantiate',
      prefabId: prefab.id,
      sceneId: 'main',
      nodeIds: ['right-root', 'right-cover'],
    },
  ]);
  assert.deepEqual(project.scenes[0]!.nodes.find((entry) => entry.id === 'left-cover')!.prefabLink, {
    prefabId: prefab.id,
    instanceId: 'left-root',
    sourceNodeId: 'cover',
  });
  project = applyProjectOperations(project, [
    {
      type: 'node.put',
      sceneId: 'main',
      node: { ...project.scenes[0]!.nodes.find((entry) => entry.id === 'left-cover')!, name: 'Local cover' },
    },
  ]);
  prefab = {
    ...prefab,
    nodes: [
      { ...prefab.nodes[0]!, name: 'Switch v2' },
      {
        ...prefab.nodes[1]!,
        name: 'Cover v2',
        transform: { ...prefab.nodes[1]!.transform, position: [0, 1, 0] },
      },
      node('lamp', 'cover'),
    ],
  };
  project = applyProjectOperations(project, [{ type: 'prefab.put', prefab }]);

  const nodes = project.scenes[0]!.nodes;
  assert.equal(nodes.find((entry) => entry.id === 'left-root')!.name, 'Switch v2');
  assert.equal(nodes.find((entry) => entry.id === 'right-root')!.name, 'Switch v2');
  assert.equal(nodes.find((entry) => entry.id === 'left-cover')!.name, 'Local cover');
  assert.equal(nodes.find((entry) => entry.id === 'right-cover')!.name, 'Cover v2');
  assert.deepEqual(nodes.find((entry) => entry.id === 'left-cover')!.transform.position, [0, 1, 0]);
  for (const instanceId of ['left-root', 'right-root']) {
    const lamp = nodes.find(
      (entry) => entry.prefabLink?.instanceId === instanceId && entry.prefabLink.sourceNodeId === 'lamp',
    );
    assert.ok(lamp);
    assert.equal(lamp.parentId, instanceId === 'left-root' ? 'left-cover' : 'right-cover');
  }
});

test('updating a prefab from an instance adopts its edits; reset clears overrides and restores deleted linked nodes', () => {
  let prefab = createPrefabFromSubtree([node('door'), node('handle', 'door')], 'door', 'door-prefab', 'Door');
  let project = applyProjectOperations(newProject('linked-prefab-reset', 'Linked prefab reset'), [
    { type: 'prefab.put', prefab },
    {
      type: 'prefab.instantiate',
      prefabId: prefab.id,
      sceneId: 'main',
      nodeIds: ['source-root', 'source-handle'],
      position: [5, 0, 0],
    },
    {
      type: 'prefab.instantiate',
      prefabId: prefab.id,
      sceneId: 'main',
      nodeIds: ['copy-root', 'copy-handle'],
    },
  ]);
  const sourceHandle = project.scenes[0]!.nodes.find((entry) => entry.id === 'source-handle')!;
  project = applyProjectOperations(project, [
    { type: 'node.put', sceneId: 'main', node: node('door', 'source-root') },
    { type: 'node.put', sceneId: 'main', node: { ...sourceHandle, name: 'Brass handle' } },
  ]);
  const source = createPrefabFromInstance(project.scenes[0]!.nodes, 'source-root', prefab);
  const addedSourceId = Object.entries(source.sourceInstanceNodeIds).find(
    ([, sceneNodeId]) => sceneNodeId === 'door',
  )![0];
  assert.notEqual(addedSourceId, 'door');
  project = applyProjectOperations(project, [
    {
      type: 'prefab.put',
      prefab: source.prefab,
      sourceInstanceRootId: 'source-root',
      sourceInstanceNodeIds: source.sourceInstanceNodeIds,
    },
  ]);
  prefab = project.prefabs[0]!;
  assert.equal(prefab.nodes.find((entry) => entry.id === 'handle')!.name, 'Brass handle');
  assert.ok(prefab.nodes.some((entry) => entry.id === addedSourceId));
  assert.equal(project.scenes[0]!.nodes.find((entry) => entry.id === 'copy-handle')!.name, 'Brass handle');
  assert.ok(
    project.scenes[0]!.nodes.some(
      (entry) =>
        entry.prefabLink?.instanceId === 'copy-root' && entry.prefabLink.sourceNodeId === addedSourceId,
    ),
  );

  const copyRoot = project.scenes[0]!.nodes.find((entry) => entry.id === 'copy-root')!;
  project = applyProjectOperations(project, [
    {
      type: 'node.put',
      sceneId: 'main',
      node: { ...copyRoot, transform: { ...copyRoot.transform, position: [12, 0, 0] } },
    },
  ]);
  project = applyProjectOperations(project, [{ type: 'node.delete', sceneId: 'main', id: 'copy-handle' }]);
  project = applyProjectOperations(project, [
    {
      type: 'prefab.put',
      prefab: { ...prefab, nodes: prefab.nodes.map((entry) => ({ ...entry, name: `${entry.name} v2` })) },
    },
  ]);
  assert.equal(
    project.scenes[0]!.nodes.some((entry) => entry.id === 'copy-handle'),
    false,
  );
  project = applyProjectOperations(project, [
    { type: 'prefab.reset', sceneId: 'main', instanceRootId: 'copy-root' },
  ]);
  assert.equal(project.scenes[0]!.nodes.find((entry) => entry.id === 'copy-root')!.transform.position[0], 12);
  assert.equal(
    project.scenes[0]!.nodes.find(
      (entry) => entry.prefabLink?.instanceId === 'copy-root' && entry.prefabLink.sourceNodeId === 'handle',
    )!.name,
    'Brass handle v2',
  );
});

test('prefab instantiation remaps internal rigid-body joint links', () => {
  let project = newProject('prefab-joints', 'Prefab joints');
  const assembly = node('assembly'),
    frame = node('frame', assembly.id, {
      components: [
        componentSchema.parse({ type: 'collider', size: [1, 1, 1], solid: true }),
        componentSchema.parse({ type: 'rigid-body', bodyType: 'fixed' }),
      ],
    }),
    door = node('door', assembly.id, {
      components: [
        componentSchema.parse({ type: 'collider', size: [1, 1, 1], solid: true }),
        componentSchema.parse({ type: 'rigid-body' }),
        componentSchema.parse({ type: 'joint', connectedNodeId: frame.id, jointType: 'revolute' }),
      ],
    });
  project = applyProjectOperations(project, [
    { type: 'node.put', sceneId: 'main', node: assembly },
    { type: 'node.put', sceneId: 'main', node: frame },
    { type: 'node.put', sceneId: 'main', node: door },
    {
      type: 'prefab.put',
      prefab: createPrefabFromSubtree([assembly, frame, door], assembly.id, 'door-prefab', 'Door assembly'),
    },
  ]);
  const placed = applyProjectOperations(project, [
    {
      type: 'prefab.instantiate',
      prefabId: 'door-prefab',
      sceneId: 'main',
      nodeIds: ['assembly-copy', 'frame-copy', 'door-copy'],
    },
  ]);
  const placedDoor = placed.scenes[0].nodes.find((entry) => entry.id === 'door-copy')!;
  assert.equal(
    placedDoor.components.find((component) => component.type === 'joint')?.connectedNodeId,
    'frame-copy',
  );
});

test('invalid prefab placement rejects atomically and export drops authoring-only prefab definitions', async () => {
  const project = newProject('prefab-invalid', 'Prefab invalid');
  const withPrefab = applyProjectOperations(project, [
    {
      type: 'prefab.put',
      prefab: { id: 'lamp-prefab', name: 'Lamp', rootId: 'lamp', nodes: [node('lamp')] },
    },
  ]);
  assert.throws(
    () =>
      applyProjectOperations(withPrefab, [
        {
          type: 'prefab.instantiate',
          prefabId: 'lamp-prefab',
          sceneId: 'main',
          nodeIds: ['lamp-copy', 'extra'],
        },
      ]),
    /one new node ID for each/,
  );
  assert.throws(
    () =>
      applyProjectOperations(
        applyProjectOperations(withPrefab, [{ type: 'node.put', sceneId: 'main', node: node('lamp-copy') }]),
        [{ type: 'prefab.instantiate', prefabId: 'lamp-prefab', sceneId: 'main', nodeIds: ['lamp-copy'] }],
      ),
    /already exists/,
  );

  const { exportProject } = await import('../runtime/gameExport');
  const game = exportProject(withPrefab, 'main');
  assert.deepEqual(game.prefabs, []);
  assert.deepEqual(
    withPrefab.prefabs.map((entry) => entry.id),
    ['lamp-prefab'],
  );
  const placed = applyProjectOperations(withPrefab, [
    { type: 'prefab.instantiate', prefabId: 'lamp-prefab', sceneId: 'main', nodeIds: ['lamp-copy'] },
  ]);
  const playable = exportProject(placed, 'main');
  assert.equal(playable.scenes[0]!.nodes[0]!.prefabLink, undefined);
  const detached = applyProjectOperations(placed, [{ type: 'prefab.delete', id: 'lamp-prefab' }]);
  assert.equal(detached.scenes[0]!.nodes[0]!.prefabLink, undefined);
  assert.equal(detached.scenes[0]!.nodes[0]!.id, 'lamp-copy');
});
