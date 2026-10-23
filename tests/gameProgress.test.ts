import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, validateProject, type SceneNode } from '../services/projectDocument';
import { GameSimulation, terrainWorldSignature } from '../runtime/GameSimulation';
import { renderGameHtml } from '../runtime/gameExport';
import {
  GAME_PROGRESS_VERSION,
  GameProgressStore,
  MAX_GAME_WORLD_EDITS,
  MAX_GAME_PROGRESS_BYTES,
  gameProgressStorageKey,
  parseGameProgress,
  serializeGameProgress,
  type GameProgressSnapshot,
  type ProgressStorageLike,
} from '../runtime/gameProgress';

class MemoryStorage implements ProgressStorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function progressProject() {
  const project = newProject('progress-project', 'Progress test');
  const transform = (position: [number, number, number] = [0, 0, 0]) => ({
    position,
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  });
  const nodes: SceneNode[] = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: transform(),
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
      ],
      attachments: [],
    },
    {
      id: 'pickup',
      name: 'Pickup',
      assetId: null,
      parentId: null,
      transform: transform([2, 0, 0]),
      enabled: true,
      components: [],
      attachments: [],
    },
  ];
  project.scenes[0].variables = { coins: 0 };
  project.scenes[0].items = [{ id: 'gem', name: 'Gem', description: '', maxStack: 10 }];
  project.scenes[0].nodes = nodes;
  return validateProject(project);
}

function progressWorldProject() {
  const project = progressProject();
  project.worlds = [
    {
      id: 'terrain',
      name: 'Seeded terrain',
      seed: 17,
      chunkSize: 16,
      voxelSize: 0.5,
      generator: {
        type: 'terrain',
        version: 1,
        mode: 'voxel3d',
        origin: [-8, -8],
        size: [16, 16],
        minY: 0,
        maxY: 16,
        baseHeight: 3,
        amplitude: 0,
        noise: 0.25,
        palette: {
          surface: 0x55aa44,
          subsurface: 0x725439,
          deep: 0x686b70,
          surfaceDepth: 3,
          subsurfaceDepth: 4,
          materialType: 'STANDARD',
        },
      },
      edits: [],
    },
  ];
  project.scenes[0].worldId = 'terrain';
  return validateProject(project);
}

function snapshot(projectId = 'progress-project', sceneId = 'main'): GameProgressSnapshot {
  return {
    version: GAME_PROGRESS_VERSION,
    projectId,
    sceneId,
    variables: { coins: 7 },
    inventory: [{ itemId: 'gem', quantity: 2 }],
    health: { player: 55 },
    nodes: { player: { transform: { position: [3, 4, 5] } }, pickup: { enabled: false } },
    status: 'won',
  };
}

test('versioned progress snapshots round-trip only for their project and scene identity', () => {
  const value = snapshot();
  const serialized = serializeGameProgress(value);
  assert.ok(serialized);
  assert.deepEqual(parseGameProgress(serialized, value.projectId, value.sceneId), value);
  assert.equal(parseGameProgress(serialized, 'other-project', value.sceneId), null);
  assert.equal(
    gameProgressStorageKey(value.projectId, value.sceneId),
    'voxshop:game-progress:v1:progress-project:main',
  );
});

test('saved Rapier solver state resumes a moving body with the same subsequent motion', async () => {
  const project = progressProject();
  project.scenes[0].nodes.push({
    id: 'crate',
    name: 'Moving crate',
    assetId: null,
    parentId: null,
    transform: {
      position: [4, 4, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    enabled: true,
    components: [
      { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
      {
        type: 'rigid-body',
        bodyType: 'dynamic',
        gravity: 0,
        linearDamping: 0,
        restitution: 0.2,
        angularDamping: 0,
        velocity: [2, 0, 0],
        canSleep: false,
      },
    ],
    attachments: [],
  });
  const authored = validateProject(project),
    source = new GameSimulation(authored);
  let restored: GameSimulation | null = null;
  try {
    await source.ready;
    for (let index = 0; index < 24; index++) source.step();
    const saved = source.progressSnapshot()!;
    assert.ok(saved.physics, 'The checkpoint contains Rapier’s full world state.');
    assert.ok(
      parseGameProgress(JSON.stringify(saved), authored.id, 'main'),
      'Serialized Rapier state remains within the progress schema.',
    );
    restored = new GameSimulation(authored, 'main', JSON.parse(JSON.stringify(saved)));
    assert.equal(restored.progressRestored, true);
    await restored.ready;
    assert.equal(
      restored.errors.some((error) => error.includes('solver state did not match')),
      false,
    );
    for (let index = 0; index < 30; index++) {
      source.step();
      restored.step();
    }
    const expected = source.worldPosition(source.nodes.get('crate')!),
      actual = restored.worldPosition(restored.nodes.get('crate')!);
    assert.ok(expected.distanceTo(actual) < 1e-5);
  } finally {
    source.dispose();
    restored?.dispose();
  }
});

test('terrain collider handles round-trip through campaign progress and Rapier restore', async () => {
  const project = progressWorldProject();
  project.scenes[0].nodes.push({
    id: 'terrain-crate',
    name: 'Terrain crate',
    assetId: null,
    parentId: null,
    transform: { position: [4, 8, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components: [
      { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
      {
        type: 'rigid-body',
        bodyType: 'dynamic',
        gravity: 9.81,
        linearDamping: 0,
        restitution: 0,
        velocity: [0, 0, 0],
        canSleep: false,
      },
    ],
    attachments: [],
  });
  const authored = validateProject(project),
    source = new GameSimulation(authored);
  let restored: GameSimulation | null = null;
  try {
    await source.ready;
    for (let index = 0; index < 180; index++) source.step();
    const saved = source.progressSnapshot()!;
    assert.ok(saved.physics?.terrainBodyHandle !== undefined);
    assert.ok((saved.physics?.terrainColliderHandles?.length ?? 0) > 0);
    const parsed = parseGameProgress(JSON.stringify(saved), authored.id, 'main');
    assert.ok(
      parsed?.physics?.terrainColliderHandles?.length,
      'The progress parser preserves terrain handles.',
    );
    const malformed = structuredClone(saved);
    malformed.physics!.terrainColliderHandles![0]!.key = 'not-a-terrain-region';
    assert.equal(parseGameProgress(JSON.stringify(malformed), authored.id, 'main'), null);
    restored = new GameSimulation(authored, 'main', parsed);
    assert.equal(restored.progressRestored, true);
    await restored.ready;
    assert.equal(
      restored.errors.some((error) => error.includes('solver state did not match')),
      false,
    );
    for (let index = 0; index < 30; index++) {
      source.step();
      restored.step();
    }
    const expected = source.worldPosition(source.nodes.get('terrain-crate')!),
      actual = restored.worldPosition(restored.nodes.get('terrain-crate')!);
    assert.ok(expected.distanceTo(actual) < 1e-5);
  } finally {
    source.dispose();
    restored?.dispose();
  }
});

test('saved fitted attachments round-trip through the bounded progress parser', () => {
  const value = snapshot();
  value.nodes.player.attachments = [
    {
      assetId: 'armor',
      socket: 'body',
      slot: 'shell',
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      hiddenBones: ['torso'],
    },
  ];
  const serialized = serializeGameProgress(value);
  assert.ok(serialized);
  assert.deepEqual(parseGameProgress(serialized, value.projectId, value.sceneId), value);

  const malformed = JSON.parse(serialized);
  malformed.nodes.player.attachments[0].slot = 'not a slot';
  assert.equal(parseGameProgress(JSON.stringify(malformed), value.projectId, value.sceneId), null);
});

test('standalone HUD explains local save, load and fresh restart controls', () => {
  const html = renderGameHtml(progressWorldProject(), 'main', '', '');
  assert.match(html, /id="save-progress"/);
  assert.match(html, /id="load-progress"/);
  assert.match(html, /Load this game's saved progress/);
  assert.match(
    html,
    /id="restart" title="Start from the authored beginning; saved progress remains available"/,
  );
  assert.match(html, /id="progress-status" role="status" aria-live="polite"/);
  assert.match(html, /Use the configured Place and Remove actions to edit one terrain cell/);
});

test('local progress storage ignores malformed, obsolete and oversized values without blocking startup', () => {
  const storage = new MemoryStorage(),
    store = new GameProgressStore('progress-project', 'main', () => storage);
  storage.setItem(store.key, '{ malformed');
  assert.deepEqual(store.load(), { status: 'invalid' });
  assert.equal(storage.getItem(store.key), null);

  storage.setItem(store.key, JSON.stringify({ ...snapshot(), version: 0 }));
  assert.deepEqual(store.load(), { status: 'invalid' });
  storage.setItem(store.key, 'x'.repeat(MAX_GAME_PROGRESS_BYTES + 1));
  assert.deepEqual(store.load(), { status: 'invalid' });
  assert.equal(storage.getItem(store.key), null);

  const tooLarge = snapshot();
  tooLarge.nodes = Object.fromEntries(
    Array.from({ length: 5000 }, (_, index) => [
      `node-${index}`,
      { transform: { position: [1000000000, 1000000000, 1000000000] as [number, number, number] } },
    ]),
  );
  assert.equal(store.save(tooLarge), 'too-large');

  const tooLargeTerrain = snapshot();
  tooLargeTerrain.terrain = {
    worldId: 'terrain',
    signature: 'seeded-signature',
    edits: Array.from({ length: 5000 }, (_, x) => ({
      x,
      y: 3,
      z: 4,
      value: { color: 0x55aa44, materialType: 'STANDARD' as const },
    })),
  };
  assert.equal(store.save(tooLargeTerrain), 'too-large');
  assert.deepEqual(store.load(), { status: 'empty' });
});

test('browser storage failures are reported without throwing', () => {
  const store = new GameProgressStore('progress-project', 'main', () => {
    throw new Error('blocked');
  });
  assert.equal(store.available, false);
  assert.deepEqual(store.load(), { status: 'unavailable' });
  assert.equal(store.save(snapshot()), 'unavailable');
});

test('simulation restores variables, inventory, health, outcome and changed node state atomically', () => {
  const project = progressProject(),
    fresh = new GameSimulation(project);
  fresh.variables.coins = 7;
  fresh.inventory = [{ itemId: 'gem', quantity: 2 }];
  fresh.health.player = 55;
  fresh.nodes.get('player')!.transform.position = [3, 4, 5];
  fresh.nodes.get('pickup')!.enabled = false;
  fresh.status = 'won';
  const saved = fresh.progressSnapshot();
  assert.ok(saved);

  const loaded = new GameSimulation(project, 'main', saved);
  assert.equal(loaded.progressRestored, true);
  assert.equal(loaded.variables.coins, 7);
  assert.deepEqual(loaded.inventory, [{ itemId: 'gem', quantity: 2 }]);
  assert.equal(loaded.health.player, 55);
  assert.deepEqual(loaded.nodes.get('player')!.transform.position, [3, 4, 5]);
  assert.equal(loaded.nodes.get('pickup')!.enabled, false);
  assert.equal(loaded.status, 'won');

  const invalid = structuredClone(saved);
  invalid.inventory = [{ itemId: 'missing', quantity: 2 }];
  const rejected = new GameSimulation(project, 'main', invalid);
  assert.equal(rejected.progressRestored, false);
  assert.equal(rejected.variables.coins, 0);
  assert.deepEqual(rejected.inventory, []);
  assert.equal(rejected.health.player, 100);
  assert.deepEqual(rejected.nodes.get('player')!.transform.position, [0, 0, 0]);
  assert.equal(rejected.nodes.get('pickup')!.enabled, true);
  assert.equal(rejected.status, 'playing');
});

test('saved execution resumes one-shot rules and tick deadlines without replaying scene start', () => {
  const project = progressProject();
  project.scenes[0].variables = { coins: 0, starts: 0, ticks: 0 };
  project.scenes[0].nodes[1].components = [
    { type: 'interactable', prompt: 'Reward', range: 3 },
    {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'start',
          interval: 1,
          once: false,
          actions: [{ type: 'add', variable: 'starts', value: 1 }],
        },
        {
          event: 'interact',
          interval: 1,
          once: true,
          actions: [{ type: 'add', variable: 'coins', value: 1 }],
        },
        { event: 'tick', interval: 1, once: false, actions: [{ type: 'add', variable: 'ticks', value: 1 }] },
      ],
    },
  ];
  const authored = validateProject(project);
  const original = new GameSimulation(authored);
  original.step({ interact: true });
  for (let index = 1; index < 30; index++) original.step();
  const saved = original.progressSnapshot()!;
  assert.equal(saved.variables.coins, 1);
  assert.equal(saved.variables.ticks, 1);
  const resumed = new GameSimulation(authored, 'main', saved);
  assert.equal(resumed.progressRestored, true);
  assert.equal(
    resumed.events.some((event) => event.type === 'message'),
    false,
  );
  assert.equal(resumed.variables.starts, 1);
  assert.equal(resumed.inspect().frame, 30);
  assert.ok(Math.abs(resumed.inspect().seconds - 0.5) < 1e-8);
  resumed.step({ interact: true }, 1 / 240);
  assert.equal(resumed.variables.coins, 1, 'The already used once-only reward cannot be collected again.');
  for (let index = 1; index < 123; index++) resumed.step({}, 1 / 240);
  assert.equal(
    resumed.variables.ticks,
    1,
    'The saved timer keeps its remaining time after changing step frequency.',
  );
  resumed.step({}, 1 / 240);
  assert.equal(resumed.variables.ticks, 2);

  const invalid = structuredClone(saved);
  invalid.execution!.firedRules.push('missing:0');
  const before = resumed.progressSnapshot();
  assert.equal(resumed.restoreProgress(invalid), false);
  assert.deepEqual(
    resumed.progressSnapshot(),
    before,
    'Invalid execution state is rejected before any mutation.',
  );
  const implausible = structuredClone(saved);
  implausible.execution!.tickDeadlines['pickup:2'] = saved.execution!.seconds + 3600;
  assert.equal(
    resumed.restoreProgress(implausible),
    false,
    'A 1-second rule cannot have an hour-long saved deadline.',
  );
  assert.deepEqual(resumed.progressSnapshot(), before);
  original.dispose();
  resumed.dispose();
});

test('restoring a scene suppresses authored start transitions and rejects malformed execution state', () => {
  const project = progressProject();
  project.scenes.push({ ...structuredClone(project.scenes[0]), id: 'next' });
  project.scenes[0].nodes[1].components = [
    {
      type: 'rules',
      apiVersion: 1,
      rules: [
        { event: 'start', interval: 1, once: false, actions: [{ type: 'transition', sceneId: 'next' }] },
      ],
    },
  ];
  const authored = validateProject(project);
  const fresh = new GameSimulation(authored);
  assert.equal(fresh.takeSceneTransition(), 'next');
  const saved = fresh.progressSnapshot()!;
  const restored = new GameSimulation(authored, 'main', saved);
  assert.equal(restored.progressRestored, true);
  assert.equal(restored.takeSceneTransition(), null);
  for (const execution of [
    { ...saved.execution, frame: -1 },
    { ...saved.execution, firedRules: ['pickup:0', 'pickup:0'] },
    { ...saved.execution, tickDeadlines: { 'pickup:64': 1 } },
    { ...saved.execution, tickDeadlines: { 'pickup:0': -1 } },
  ])
    assert.equal(parseGameProgress(JSON.stringify({ ...saved, execution }), project.id, 'main'), null);
  fresh.dispose();
  restored.dispose();
});

test('standalone terrain edits save and load against the authored world while fresh runs keep the source', () => {
  const project = progressWorldProject(),
    fresh = new GameSimulation(project);
  const removed = fresh.editTerrain({ x: 3, y: 3, z: 3, value: null });
  assert.ok(removed);
  assert.equal(project.worlds[0].edits.length, 0);
  const saved = fresh.progressSnapshot();
  assert.deepEqual(saved?.terrain?.edits, [{ x: 3, y: 3, z: 3, value: null }]);

  const loaded = new GameSimulation(project, 'main', saved);
  assert.equal(loaded.progressRestored, true);
  assert.deepEqual(loaded.terrainProgressEdits, [{ x: 3, y: 3, z: 3, value: null }]);
  assert.equal(loaded.terrainWorldDocument?.edits[0].value, null);

  const freshAgain = new GameSimulation(project);
  assert.deepEqual(freshAgain.terrainProgressEdits, []);
  assert.equal(freshAgain.terrainWorldDocument?.edits.length, 0);

  const stale = structuredClone(saved!);
  stale.terrain!.signature = 'another-authored-world';
  assert.equal(new GameSimulation(project, 'main', stale).progressRestored, false);
  const outOfBounds = structuredClone(saved!);
  outOfBounds.terrain!.edits = [{ x: 100, y: 3, z: 3, value: null }];
  assert.equal(new GameSimulation(project, 'main', outOfBounds).progressRestored, false);
});

test('progress validates terrain budgets against authored base and incoming state, not later live edits', () => {
  const project = progressWorldProject(),
    simulation = new GameSimulation(project),
    terrain = project.worlds[0];
  (simulation as unknown as { terrainBaseEdits: Map<string, unknown> }).terrainBaseEdits = new Map(
    Array.from({ length: 250_000 }, (_, x) => [`${x},0,0`, { x, y: 0, z: 0, value: null }]),
  );
  const value = {
    ...snapshot(),
    terrain: {
      worldId: terrain.id,
      signature: terrainWorldSignature(terrain),
      edits: [{ x: 3, y: 3, z: 3, value: null }],
    },
  };
  assert.equal(simulation.restoreProgress(value), false);
  assert.equal(simulation.variables.coins, 0);
  assert.deepEqual(simulation.inventory, []);
  assert.equal(simulation.status, 'playing');
  assert.equal(simulation.terrainWorldDocument?.edits.length, 0);
  const internal = simulation as unknown as {
    terrainBaseEdits: Map<string, unknown>;
    terrainCurrentEdits: Map<string, unknown>;
  };
  internal.terrainCurrentEdits = internal.terrainBaseEdits;
  internal.terrainBaseEdits = new Map();
  assert.equal(
    simulation.restoreProgress(value),
    true,
    'later live edits cannot invalidate a smaller saved world',
  );
  assert.equal(simulation.variables.coins, 7);
  assert.equal(simulation.terrainWorldDocument?.edits.length, 1);
  simulation.dispose();
});

test('progress accepts old snapshots but rejects malformed, duplicate and oversized terrain deltas', () => {
  const old = snapshot(),
    serializedOld = serializeGameProgress(old);
  assert.ok(serializedOld);
  assert.equal(parseGameProgress(serializedOld, old.projectId, old.sceneId)?.terrain, undefined);

  const withTerrain = {
    ...old,
    terrain: {
      worldId: 'terrain',
      signature: 'seeded-signature',
      edits: [{ x: 1, y: 2, z: 3, value: { color: 0x55aa44, materialType: 'STANDARD' as const } }],
    },
  };
  const serialized = serializeGameProgress(withTerrain);
  assert.ok(serialized);
  assert.deepEqual(parseGameProgress(serialized, old.projectId, old.sceneId), withTerrain);
  assert.equal(
    parseGameProgress(
      JSON.stringify({
        ...withTerrain,
        terrain: {
          ...withTerrain.terrain,
          edits: [...withTerrain.terrain.edits, ...withTerrain.terrain.edits],
        },
      }),
      old.projectId,
      old.sceneId,
    ),
    null,
  );
  const tooMany = {
    ...withTerrain,
    terrain: {
      ...withTerrain.terrain,
      edits: Array.from({ length: MAX_GAME_WORLD_EDITS + 1 }, (_, x) => ({ x, y: 2, z: 3, value: null })),
    },
  };
  assert.equal(parseGameProgress(JSON.stringify(tooMany), old.projectId, old.sceneId), null);
  const malformed = structuredClone(withTerrain);
  malformed.terrain.edits[0].value = { color: -1, materialType: 'STANDARD' as 'STANDARD' };
  assert.equal(parseGameProgress(JSON.stringify(malformed), old.projectId, old.sceneId), null);
});

test('simulation does not serialize a stopped run or accept invalid transforms', () => {
  const project = progressProject(),
    simulation = new GameSimulation(project);
  simulation.status = 'stopped';
  assert.equal(simulation.progressSnapshot(), null);
  const unsafe = snapshot();
  unsafe.nodes.player.transform = { position: [1000000000, 0, 0] };
  assert.equal(simulation.restoreProgress(unsafe), false);
});
