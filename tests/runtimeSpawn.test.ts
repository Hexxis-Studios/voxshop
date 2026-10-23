import assert from 'node:assert/strict';
import test from 'node:test';
import { canCreateAction, createAction } from '../components/ruleAuthoring';
import { exportProject } from '../runtime/gameExport';
import { GameSimulation } from '../runtime/GameSimulation';
import { parseGameProgress } from '../runtime/gameProgress';
import { actionSchema, newProject, nodeSchema, validateProject } from '../services/projectDocument';

function spawnProject() {
  const project = newProject('spawn-project', 'Spawn project');
  const source = nodeSchema.parse({
    id: 'spawner',
    name: 'Spawner',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'start',
            once: true,
            actions: [
              {
                type: 'spawn',
                prefabId: 'orb-prefab',
                position: [4, 1, 2],
                rotation: [0, 1.2, 0],
                scale: [2, 1, 0.5],
              },
            ],
          },
        ],
      },
    ],
  });
  const root = nodeSchema.parse({
    id: 'orb-root',
    name: 'Orb',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      { type: 'health', maximum: 10 },
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'start',
            once: true,
            actions: [{ type: 'destroy', target: 'orb-child' }],
          },
        ],
      },
    ],
  });
  const child = nodeSchema.parse({
    id: 'orb-child',
    name: 'Orb detail',
    parentId: 'orb-root',
    transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  project.scenes[0].nodes = [source];
  project.prefabs = [
    { id: 'orb-prefab', name: 'Orb prefab', rootId: root.id, attachmentParentId: null, nodes: [root, child] },
  ];
  return validateProject(project);
}

test('spawn actions are bounded, authorable and exposed only when a prefab exists', () => {
  assert.deepEqual(actionSchema.parse({ type: 'spawn', prefabId: 'orb-prefab' }), {
    type: 'spawn',
    prefabId: 'orb-prefab',
  });
  assert.equal(actionSchema.safeParse({ type: 'spawn', prefabId: 'invalid id' }).success, false);
  assert.equal(
    actionSchema.safeParse({ type: 'spawn', prefabId: 'orb-prefab', scale: [1, 0, 1] }).success,
    false,
  );
  assert.equal(canCreateAction('spawn', { recipes: 0, nodes: 0, items: 0 }), false);
  assert.equal(canCreateAction('spawn', { recipes: 0, nodes: 0, items: 0, prefabs: 1 }), true);
  assert.deepEqual(createAction('spawn', undefined, undefined, undefined, undefined, 'orb-prefab'), {
    type: 'spawn',
    prefabId: 'orb-prefab',
    offset: [0, 0, 0],
  });
});

test('runtime spawning remaps subtree references and preserves spawned state across checkpoints', () => {
  const project = spawnProject();
  const simulation = new GameSimulation(project);
  const root = simulation.nodes.get('rt1n0')!;
  const child = simulation.nodes.get('rt1n1')!;
  assert.ok(root);
  assert.ok(child);
  assert.deepEqual(simulation.worldPosition(root).toArray(), [4, 1, 2]);
  assert.deepEqual(root.transform.rotation, [0, 1.2, 0]);
  assert.deepEqual(root.transform.scale, [2, 1, 0.5]);
  assert.equal(child.enabled, false, 'the root start rule targets the cloned child ID');
  assert.ok(simulation.events.some((event) => event.type === 'spawned'));

  root.transform.position = [8, 2, 3];
  simulation.health[root.id] = 6;
  const snapshot = simulation.progressSnapshot()!;
  assert.equal(snapshot.spawnedPrefabs?.length, 1);
  assert.deepEqual(snapshot.spawnedPrefabs?.[0].rootRotation, [0, 1.2, 0]);
  assert.deepEqual(snapshot.spawnedPrefabs?.[0].rootScale, [2, 1, 0.5]);
  assert.equal(parseGameProgress(JSON.stringify(snapshot), project.id, 'main')?.spawnedPrefabs?.length, 1);
  const malformed = structuredClone(snapshot);
  malformed.spawnedPrefabs![0].rootScale = [1, 0, 1];
  assert.equal(parseGameProgress(JSON.stringify(malformed), project.id, 'main'), null);

  const resumed = new GameSimulation(project, 'main', snapshot);
  assert.equal(resumed.progressRestored, true);
  assert.deepEqual(resumed.nodes.get(root.id)?.transform.position, [8, 2, 3]);
  assert.deepEqual(resumed.nodes.get(root.id)?.transform.rotation, [0, 1.2, 0]);
  assert.deepEqual(resumed.nodes.get(root.id)?.transform.scale, [2, 1, 0.5]);
  assert.equal(resumed.nodes.get(child.id)?.enabled, false);
  assert.equal(resumed.health[root.id], 6);

  const legacy = structuredClone(snapshot);
  delete legacy.spawnedPrefabs![0].rootRotation;
  delete legacy.spawnedPrefabs![0].rootScale;
  assert.equal(new GameSimulation(project, 'main', legacy).progressRestored, true);

  const changedPrefab = structuredClone(project);
  changedPrefab.prefabs[0].nodes[0].name = 'Changed template';
  const fresh = new GameSimulation(validateProject(changedPrefab), 'main', snapshot);
  assert.equal(fresh.progressRestored, false);
  assert.equal(fresh.health[root.id], 10, 'incompatible prefab templates start from a fresh scene');
});

test('a runtime-spawned prefab can listen and emit named signals from its start rules', () => {
  const project = spawnProject();
  const root = project.prefabs[0].nodes.find((node) => node.id === project.prefabs[0].rootId)!;
  const rules = root.components.find((component) => component.type === 'rules');
  assert.equal(rules?.type, 'rules');
  if (rules?.type !== 'rules') throw new Error('Expected prefab root rules.');
  rules.rules = [
    { event: 'start', interval: 1, once: true, actions: [{ type: 'emit', eventId: 'spawned-ready' }] },
    {
      event: 'signal',
      eventId: 'spawned-ready',
      interval: 1,
      once: true,
      actions: [{ type: 'set', variable: 'spawnedReady', value: 1 }],
    },
  ];
  project.scenes[0].variables.spawnedReady = 0;
  const simulation = new GameSimulation(validateProject(project));

  assert.equal(simulation.variables.spawnedReady, 1);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'signal').map((event) => event.data),
    [{ eventId: 'spawned-ready' }],
  );
});

test('a prefab spawned after Rapier initialization registers its rigid body in the live world', async () => {
  const project = newProject('spawn-physics', 'Spawn physics');
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'timer',
      name: 'Timer',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'tick',
              interval: 0.05,
              once: true,
              actions: [{ type: 'spawn', prefabId: 'falling-rock', position: [0, 5, 0] }],
            },
          ],
        },
      ],
    }),
  ];
  const fallingRock = nodeSchema.parse({
    id: 'rock',
    name: 'Falling rock',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      { type: 'collider', size: [1, 1, 1], solid: true },
      { type: 'rigid-body', bodyType: 'dynamic', gravity: 18, linearDamping: 0 },
    ],
  });
  project.prefabs = [
    {
      id: 'falling-rock',
      name: 'Falling rock',
      rootId: 'rock',
      attachmentParentId: null,
      nodes: [fallingRock],
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  simulation.step({}, 0.1);
  assert.ok(simulation.nodes.has('rt1n0'));
  assert.ok(simulation.worldPosition(simulation.nodes.get('rt1n0')!).y < 4.99);
  simulation.dispose();
});

test('standalone export includes only prefabs reachable through spawn actions and their nested spawns', () => {
  const project = spawnProject();
  const sourceRules = project.scenes[0].nodes[0].components.find((component) => component.type === 'rules')!;
  if (sourceRules.type === 'rules')
    sourceRules.rules[0].actions[0] = { type: 'spawn', prefabId: 'container-prefab' };
  const container = nodeSchema.parse({
    id: 'container-root',
    name: 'Container',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      {
        type: 'rules',
        apiVersion: 1,
        rules: [{ event: 'start', once: true, actions: [{ type: 'spawn', prefabId: 'orb-prefab' }] }],
      },
    ],
  });
  project.prefabs.push({
    id: 'container-prefab',
    name: 'Container prefab',
    rootId: container.id,
    attachmentParentId: null,
    nodes: [container],
  });
  project.prefabs.push({
    id: 'unused-prefab',
    name: 'Unused',
    rootId: 'unused-root',
    attachmentParentId: null,
    nodes: [
      nodeSchema.parse({
        id: 'unused-root',
        name: 'Unused',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    ],
  });
  const game = exportProject(validateProject(project), 'main');
  assert.deepEqual(
    game.prefabs.map((prefab) => prefab.id),
    ['orb-prefab', 'container-prefab'],
  );
  assert.equal(game.scenes[0].nodes[0].components[0]?.type, 'rules');
});
