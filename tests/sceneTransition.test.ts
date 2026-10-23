import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGame, exportProject, sceneHasRigidBodies } from '../server/gameBuild';
import { GameSession } from '../runtime/GameSession';
import { runPlaytest } from '../runtime/playtest';
import { createModelDocument } from '../services/modelDocument';
import {
  newProject,
  validateProject,
  type Action,
  type Component,
  type ProjectDocument,
  type SceneNode,
} from '../services/projectDocument';

function node(
  id: string,
  components: Component[],
  assetId: string | null = null,
  position: [number, number, number] = [0, 0, 0],
): SceneNode {
  return {
    id,
    name: id,
    assetId,
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components,
    attachments: [],
  };
}

function gate(destination: string, extra: Action[] = []): SceneNode {
  return node('gate', [
    { type: 'collider', size: [1, 1, 1], offset: [0, 0.5, 0], solid: false },
    { type: 'interactable', prompt: 'Continue', range: 3 },
    {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'interact',
          interval: 1,
          once: false,
          actions: [...extra, { type: 'transition', sceneId: destination }],
        },
      ],
    },
  ]);
}

function terrain(id: string, seed: number) {
  return {
    id,
    name: id,
    seed,
    chunkSize: 8,
    voxelSize: 0.5,
    generator: {
      type: 'terrain' as const,
      version: 1 as const,
      origin: [-2, -2] as [number, number],
      size: [4, 4] as [number, number],
      minY: -4,
      maxY: 8,
      baseHeight: 0,
      amplitude: 0,
      noise: 0.25,
      palette: {
        surface: 0x55aa55,
        subsurface: 0x886644,
        deep: 0x554433,
        surfaceDepth: 2,
        subsurfaceDepth: 3,
        materialType: 'STANDARD' as const,
      },
    },
    edits: [],
  };
}

function transitionProject(): ProjectDocument {
  const project = newProject('scene-transition-test', 'Scene transition test');
  const player = () =>
    node('player', [
      { type: 'player', style: 'top-down', speed: 3, jump: 6 },
      { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
    ]);
  const visitedAsset = {
    id: 'level-prop',
    name: 'Level prop',
    model: createModelDocument([]),
    voxelSize: 0.1,
    pivot: [0, 0, 0] as [number, number, number],
    rig: null,
    source: { kind: 'authored' as const, description: '' },
  };
  const unusedAsset = { ...visitedAsset, id: 'unused-prop', name: 'Unused prop' };
  project.assets = [visitedAsset, unusedAsset];
  project.worlds = [terrain('world-main', 1), terrain('world-two', 2), terrain('world-unused', 3)];
  project.scenes = [
    {
      ...project.scenes[0],
      bounds: 40,
      variables: { visits: 0 },
      worldId: 'world-main',
      nodes: [player(), gate('level-two', [{ type: 'add', variable: 'visits', value: 1 }])],
    },
    {
      ...project.scenes[0],
      id: 'level-two',
      name: 'Level two',
      bounds: 5,
      variables: { visits: 10 },
      worldId: 'world-two',
      nodes: [
        player(),
        gate('main'),
        node('prop', [], 'level-prop'),
        node(
          'rigid-prop',
          [
            { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
            { type: 'rigid-body', gravity: 9.81, linearDamping: 0, restitution: 0, velocity: [0, 0, 0] },
          ],
          null,
          [3, 5, 0],
        ),
      ],
    },
    {
      ...project.scenes[0],
      id: 'bonus',
      name: 'Unreachable bonus',
      worldId: 'world-unused',
      nodes: [node('unused', [], 'unused-prop')],
    },
  ];
  return validateProject(project);
}

function campaignProject(): ProjectDocument {
  const project = transitionProject(),
    item = { id: 'key', name: 'Key', description: '', maxStack: 10 };
  const world = project.worlds.find((entry) => entry.id === 'world-main')!;
  world.generator = {
    ...world.generator,
    mode: 'voxel3d',
    origin: [-16, -16],
    size: [32, 32],
    minY: -4,
    maxY: 20,
    baseHeight: 3,
  };
  for (const scene of project.scenes.slice(0, 2)) {
    scene.items = [{ ...item }];
    scene.variables = scene.id === 'main' ? { visits: 0 } : { visits: 0 };
    const player = scene.nodes.find((entry) => entry.id === 'player')!;
    player.components.push(
      { type: 'inventory', slots: 4 },
      { type: 'health', maximum: scene.id === 'main' ? 100 : 20 },
    );
    scene.nodes.push(node('puzzle', []));
  }
  project.scenes[0].nodes.push(
    node(
      'key-pickup',
      [
        { type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0.25, 0], solid: false },
        { type: 'collectible', variable: 'score', amount: 1, itemId: 'key', quantity: 1 },
      ],
      null,
      [20, 0, 20],
    ),
  );
  const secondGate = project.scenes[1].nodes.find((entry) => entry.id === 'gate')!;
  const rules = secondGate.components.find(
    (component): component is Extract<Component, { type: 'rules' }> => component.type === 'rules',
  )!;
  rules.rules[0].actions.unshift({ type: 'add', variable: 'visits', value: 1 });
  return validateProject(project);
}

test('project validation accepts scene transitions and rejects missing destinations', () => {
  const project = transitionProject();
  assert.equal(
    project.scenes[0].nodes[1].components.find((component) => component.type === 'rules')?.type,
    'rules',
  );

  const invalid = structuredClone(project);
  const rules = invalid.scenes[0].nodes[1].components.find(
    (component): component is Extract<Component, { type: 'rules' }> => component.type === 'rules',
  )!;
  rules.rules[0].actions[1] = { type: 'transition', sceneId: 'missing-scene' };
  assert.throws(() => validateProject(invalid), /Rule references a missing scene missing-scene/);
});

test('editor session switches scene world and bounds, then restores each scene within the same run', async () => {
  const project = transitionProject();
  const original = structuredClone(project);
  const rebuilt: { sceneId: string; worldId: string | null }[] = [];
  const session = new GameSession(project, 'main', undefined, (simulation) =>
    rebuilt.push({ sceneId: simulation.scene.id, worldId: simulation.terrainWorldDocument?.id ?? null }),
  );
  await session.ready;
  session.step({});
  session.step({ interact: true });

  assert.equal(session.simulation.scene.id, 'level-two');
  assert.equal(session.simulation.scene.bounds, 5);
  assert.equal(session.simulation.terrainWorldDocument?.id, 'world-two');
  assert.equal(session.simulation.variables.visits, 10);
  assert.equal(session.scenePath.join(' > '), 'main > level-two');
  assert.deepEqual(rebuilt, [{ sceneId: 'level-two', worldId: 'world-two' }]);

  await session.ready;
  session.step({});
  session.step({ interact: true });
  assert.equal(session.simulation.scene.id, 'main');
  assert.equal(session.simulation.scene.bounds, 40);
  assert.equal(session.simulation.terrainWorldDocument?.id, 'world-main');
  assert.equal(session.simulation.variables.visits, 1);
  assert.equal(session.scenePath.join(' > '), 'main > level-two > main');
  assert.deepEqual(
    project,
    original,
    'Runtime progression must not mutate the authored document or revision.',
  );
  session.dispose();
});

test('campaign inventory and clamped player health carry A→B→A while A puzzle and terrain progress stay local', async () => {
  const project = campaignProject(),
    session = new GameSession(project, 'main');
  await session.ready;
  session.simulation.inventory = [{ itemId: 'key', quantity: 2 }];
  session.simulation.health.player = 35;
  session.simulation.variables.visits = 6;
  session.simulation.nodes.get('puzzle')!.enabled = false;
  session.simulation.nodes.get('puzzle')!.transform.position = [4, 0, 3];
  assert.ok(session.simulation.editTerrain({ x: 3, y: 3, z: 3, value: null }));

  session.step({});
  session.step({ interact: true });
  assert.equal(session.simulation.scene.id, 'level-two');
  await session.ready;
  assert.deepEqual(session.simulation.inventory, [{ itemId: 'key', quantity: 2 }]);
  assert.equal(
    session.simulation.health.player,
    20,
    'destination clamps carried health to its authored maximum',
  );

  session.simulation.inventory = [{ itemId: 'key', quantity: 3 }];
  session.simulation.health.player = 8;
  session.step({});
  assert.ok(session.simulation.inspect().interactionTarget, 'destination gate should remain interactable');
  session.step({ interact: true });
  assert.equal(session.simulation.scene.id, 'main');
  assert.deepEqual(session.simulation.inventory, [{ itemId: 'key', quantity: 3 }]);
  assert.equal(session.simulation.health.player, 8);
  assert.equal(session.simulation.variables.visits, 7);
  assert.equal(session.simulation.nodes.get('puzzle')!.enabled, false);
  assert.deepEqual(session.simulation.nodes.get('puzzle')!.transform.position, [4, 0, 3]);
  assert.deepEqual(session.simulation.terrainProgressEdits, [{ x: 3, y: 3, z: 3, value: null }]);
  const saved = session.simulation.progressSnapshot();
  assert.equal(saved?.sceneId, 'main');
  assert.deepEqual(saved?.inventory, [{ itemId: 'key', quantity: 3 }]);
  assert.equal(saved?.health.player, 8, 'a per-scene save captures the current campaign health');
  session.dispose();
});

test('campaign variables drive the next scene and survive a campaign save and reload', async () => {
  const project = campaignProject();
  const firstGate = project.scenes[0]!.nodes.find((entry) => entry.id === 'gate')!;
  const firstGateRules = firstGate.components.find(
    (component): component is Extract<Component, { type: 'rules' }> => component.type === 'rules',
  )!;
  firstGateRules.rules[0]!.actions.unshift({
    type: 'set',
    variable: 'chapterUnlocked',
    scope: 'campaign',
    value: 1,
  });

  const secondScene = project.scenes.find((scene) => scene.id === 'level-two')!;
  const puzzle = secondScene.nodes.find((entry) => entry.id === 'puzzle')!;
  puzzle.components.push({
    type: 'rules',
    apiVersion: 1,
    rules: [
      {
        event: 'start',
        interval: 1,
        once: true,
        condition: { variable: 'chapterUnlocked', scope: 'campaign', op: '==', value: 1 },
        actions: [{ type: 'add', variable: 'chapterVisits', scope: 'campaign', value: 1 }],
      },
    ],
  });
  const authored = validateProject(project);
  const session = new GameSession(authored, 'main');
  let resumed: GameSession | null = null;
  try {
    await session.ready;
    session.step({});
    session.step({ interact: true });
    assert.equal(session.simulation.scene.id, 'level-two');
    assert.equal(session.simulation.campaignVariables.chapterVisits, 1);
    assert.equal(
      session.simulation.variables.visits,
      0,
      'campaign state does not overwrite scene-local variables',
    );

    const snapshot = session.progressSnapshot();
    assert.equal(snapshot?.campaignVariables.chapterVisits, 1);
    resumed = new GameSession(authored, 'main', snapshot);
    await resumed.ready;
    assert.equal(resumed.simulation.scene.id, 'level-two');
    assert.equal(resumed.simulation.campaignVariables.chapterUnlocked, 1);
    assert.equal(resumed.simulation.campaignVariables.chapterVisits, 1);
    assert.equal(resumed.simulation.variables.visits, 0);
  } finally {
    session.dispose();
    resumed?.dispose();
  }
});

test('project validation rejects incompatible carried item definitions and shrinking inventory slots', () => {
  const incompatible = campaignProject();
  incompatible.scenes[1].items[0].maxStack = 5;
  assert.throws(() => validateProject(incompatible), /incompatible definitions for item key/);

  const missing = campaignProject();
  missing.scenes[1].items = [];
  assert.throws(() => validateProject(missing), /definition is missing/);

  const smaller = campaignProject();
  const inventory = smaller.scenes[1].nodes
    .find((entry) => entry.id === 'player')!
    .components.find(
      (component): component is Extract<Component, { type: 'inventory' }> => component.type === 'inventory',
    )!;
  inventory.slots = 3;
  assert.throws(() => validateProject(smaller), /smaller slot limit/);
});

test('playtest reports its entry scene, active scene, route and unchanged source revision', async () => {
  const project = transitionProject();
  const result = await runPlaytest(project, {
    sceneId: 'main',
    steps: [
      { frames: 1, input: {} },
      { frames: 1, input: { interact: true } },
    ],
    assertions: [{ type: 'no-errors' }],
  });

  assert.equal(result.passed, true);
  assert.equal(result.sceneId, 'main');
  assert.equal(result.activeSceneId, 'level-two');
  assert.deepEqual(result.scenePath, ['main', 'level-two']);
  assert.equal(result.state.sceneId, 'level-two');
  assert.equal(result.revision, project.revision);
});

test('standalone build packages reachable transition data for the shared session runtime', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-scene-transition-'));
  t.after(async () => {
    assert.ok(
      path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-scene-transition-')),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  const project = transitionProject();
  const exported = exportProject(project, 'main');
  assert.deepEqual(
    exported.scenes.map((scene) => scene.id),
    ['main', 'level-two'],
  );
  assert.deepEqual(
    exported.assets.map((asset) => asset.id),
    ['level-prop'],
  );
  assert.deepEqual(
    exported.worlds.map((world) => world.id),
    ['world-main', 'world-two'],
  );

  const result = await buildGame(project, 'main', { root: process.cwd(), directory });
  const html = await fs.readFile(result.path, 'utf8');
  const embedded = JSON.parse(
    html.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
  ) as ProjectDocument;
  assert.deepEqual(embedded, exported);
  assert.match(html, /scenePath/);
  assert.match(html, /Restart fresh/);
  assert.match(html, /Rapier 3D compatibility build/);

  const session = new GameSession(embedded, 'main');
  await session.ready;
  session.step({});
  session.step({ interact: true });
  await session.ready;
  assert.equal(session.simulation.inspect().sceneId, 'level-two');
  assert.equal(session.simulation.scene.bounds, 5);
  assert.equal(session.simulation.terrainWorldDocument?.id, 'world-two');
  const readyFrame = session.simulation.frame;
  session.step({});
  assert.equal(session.simulation.frame, readyFrame + 1);
  assert.ok(embedded.assets.some((asset) => asset.id === 'level-prop'));
  assert.equal(sceneHasRigidBodies(embedded), true);
  session.dispose();
});

test('self transitions restore initialized scene state without replaying its start rules', () => {
  const project = transitionProject();
  const rules = project.scenes[0].nodes[1].components.find(
    (component): component is Extract<Component, { type: 'rules' }> => component.type === 'rules',
  )!;
  rules.rules[0].event = 'start';
  rules.rules[0].actions = [{ type: 'transition', sceneId: 'main' }];

  const session = new GameSession(project, 'main');
  assert.deepEqual(session.scenePath, ['main', 'main']);
  assert.equal(session.simulation.status, 'playing');
  assert.equal(session.simulation.errors.length, 0);
  session.dispose();
});

test('long chains of fresh-scene start transitions stop at the per-update limit', () => {
  const project = newProject('transition-limit', 'Transition limit');
  project.scenes = Array.from({ length: 18 }, (_, index) => ({
    ...structuredClone(project.scenes[0]),
    id: index === 0 ? 'main' : `scene-${index}`,
    nodes: [
      node('entry', [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              interval: 1,
              once: false,
              actions:
                index < 17
                  ? [{ type: 'transition', sceneId: `scene-${index + 1}` }]
                  : [{ type: 'message', text: 'End' }],
            },
          ],
        },
      ]),
    ],
  }));
  const session = new GameSession(validateProject(project), 'main');
  assert.equal(session.scenePath.length, 17);
  assert.equal(session.simulation.status, 'stopped');
  assert.match(session.simulation.errors[0], /16 scene transitions in one update/);
  session.dispose();
});
