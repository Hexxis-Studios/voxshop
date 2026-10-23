import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../runtime/GameSession';
import {
  CAMPAIGN_PROGRESS_VERSION,
  CampaignProgressStore,
  MAX_CAMPAIGN_PROGRESS_BYTES,
  MAX_CAMPAIGN_SCENES,
  MAX_CAMPAIGN_VARIABLES,
  campaignProgressStorageKey,
  parseCampaignProgress,
  serializeCampaignProgress,
  type CampaignProgressSnapshot,
} from '../runtime/campaignProgress';
import {
  GAME_PROGRESS_VERSION,
  type GameProgressSnapshot,
  type ProgressStorageLike,
} from '../runtime/gameProgress';
import {
  newProject,
  validateProject,
  type Component,
  type ProjectDocument,
  type SceneNode,
} from '../services/projectDocument';

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

function node(
  id: string,
  components: Component[] = [],
  position: [number, number, number] = [0, 0, 0],
): SceneNode {
  return {
    id,
    name: id,
    assetId: null,
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components,
    attachments: [],
  };
}

function gate(destination: string) {
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
          actions: [{ type: 'transition', sceneId: destination }],
        },
      ],
    },
  ]);
}

function campaignProject(): ProjectDocument {
  const project = newProject('campaign-test', 'Campaign test'),
    player = () =>
      node('player', [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
      ]),
    item = { id: 'key', name: 'Key', description: '', maxStack: 10 };
  project.scenes = [
    {
      ...project.scenes[0],
      id: 'main',
      name: 'Scene A',
      variables: { visits: 0 },
      items: [{ ...item }],
      nodes: [player(), gate('level-two'), node('puzzle')],
    },
    {
      ...project.scenes[0],
      id: 'level-two',
      name: 'Scene B',
      variables: { visits: 0 },
      items: [{ ...item }],
      nodes: [player(), gate('main'), node('puzzle')],
    },
  ];
  return validateProject(project);
}

function emptySceneSnapshot(projectId: string, sceneId: string): GameProgressSnapshot {
  return {
    version: GAME_PROGRESS_VERSION,
    projectId,
    sceneId,
    variables: {},
    inventory: [],
    health: {},
    nodes: {},
    status: 'playing',
  };
}

function makeCampaign(projectId = 'campaign-test'): CampaignProgressSnapshot {
  return {
    version: CAMPAIGN_PROGRESS_VERSION,
    projectId,
    startSceneId: 'main',
    activeSceneId: 'main',
    scenes: [emptySceneSnapshot(projectId, 'main')],
    campaignVariables: {},
  };
}

test('campaign snapshots round-trip with project and entry-scene identity', () => {
  const snapshot = makeCampaign(),
    serialized = serializeCampaignProgress(snapshot);
  assert.ok(serialized);
  assert.deepEqual(parseCampaignProgress(serialized, snapshot.projectId, snapshot.startSceneId), snapshot);
  assert.equal(parseCampaignProgress(serialized, 'other-project', snapshot.startSceneId), null);
  assert.equal(parseCampaignProgress(serialized, snapshot.projectId, 'level-two'), null);
  assert.equal(
    campaignProgressStorageKey(snapshot.projectId, snapshot.startSceneId),
    'voxshop:campaign-progress:v1:campaign-test:main',
  );
});

test('campaign variables are bounded and old snapshots without them remain readable', () => {
  const snapshot = makeCampaign();
  snapshot.campaignVariables = { chapter: 2, hasKey: 1 };
  const serialized = serializeCampaignProgress(snapshot);
  assert.ok(serialized);
  assert.deepEqual(
    parseCampaignProgress(serialized, snapshot.projectId, snapshot.startSceneId)?.campaignVariables,
    snapshot.campaignVariables,
  );

  const { campaignVariables: _campaignVariables, ...legacy } = snapshot;
  assert.deepEqual(
    parseCampaignProgress(JSON.stringify(legacy), snapshot.projectId, snapshot.startSceneId)
      ?.campaignVariables,
    {},
  );
  for (const invalid of [
    { 'bad.id': 1 },
    { score: '1' },
    Object.fromEntries(
      Array.from({ length: MAX_CAMPAIGN_VARIABLES + 1 }, (_, index) => [`v${index}`, index]),
    ),
  ])
    assert.equal(
      parseCampaignProgress(
        JSON.stringify({ ...snapshot, campaignVariables: invalid }),
        snapshot.projectId,
        snapshot.startSceneId,
      ),
      null,
    );
});

test('standalone campaign Save/Load preserves Rapier world state through the bounded store', async () => {
  const project = newProject('physics-campaign', 'Physics campaign');
  project.scenes[0].id = 'main';
  project.scenes[0].nodes = [
    node(
      'crate',
      [
        { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
        {
          type: 'rigid-body',
          bodyType: 'dynamic',
          gravity: 0,
          linearDamping: 0,
          restitution: 0.2,
          velocity: [1, 0, 0],
          canSleep: false,
        },
      ],
      [0, 2, 0],
    ),
  ];
  const authored = validateProject(project),
    storage = new MemoryStorage(),
    store = new CampaignProgressStore(authored.id, 'main', () => storage),
    source = new GameSession(authored, 'main');
  let resumed: GameSession | null = null;
  try {
    await source.ready;
    for (let index = 0; index < 18; index++) source.step();
    const checkpoint = source.progressSnapshot();
    assert.ok(checkpoint?.scenes[0].physics);
    assert.equal(store.save(checkpoint), 'saved');

    const loaded = store.load();
    assert.equal(loaded.status, 'loaded');
    if (loaded.status !== 'loaded') return;
    resumed = new GameSession(authored, 'main', loaded.snapshot);
    await resumed.ready;
    assert.equal(resumed.progressWasRestored('main'), true);
    for (let index = 0; index < 24; index++) {
      source.step();
      resumed.step();
    }
    const expected = source.simulation.worldPosition(source.simulation.nodes.get('crate')!),
      actual = resumed.simulation.worldPosition(resumed.simulation.nodes.get('crate')!);
    assert.ok(expected.distanceTo(actual) < 1e-5);
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('campaign parser rejects malformed, oversized, duplicate and over-count snapshots', () => {
  const snapshot = makeCampaign(),
    serialized = serializeCampaignProgress(snapshot)!;
  assert.equal(parseCampaignProgress('{ malformed', snapshot.projectId, snapshot.startSceneId), null);
  assert.equal(
    parseCampaignProgress(
      JSON.stringify({ ...snapshot, version: 2 }),
      snapshot.projectId,
      snapshot.startSceneId,
    ),
    null,
  );
  assert.equal(
    parseCampaignProgress(
      JSON.stringify({ ...snapshot, scenes: [snapshot.scenes[0], snapshot.scenes[0]] }),
      snapshot.projectId,
      snapshot.startSceneId,
    ),
    null,
  );
  const tooMany = makeCampaign();
  tooMany.scenes = Array.from({ length: MAX_CAMPAIGN_SCENES + 1 }, (_, index) =>
    emptySceneSnapshot(tooMany.projectId, index === 0 ? 'main' : `scene-${index}`),
  );
  tooMany.activeSceneId = `scene-${MAX_CAMPAIGN_SCENES}`;
  assert.equal(parseCampaignProgress(JSON.stringify(tooMany), tooMany.projectId, tooMany.startSceneId), null);
  assert.equal(
    parseCampaignProgress(
      ' '.repeat(MAX_CAMPAIGN_PROGRESS_BYTES + 1),
      snapshot.projectId,
      snapshot.startSceneId,
    ),
    null,
  );
  assert.ok(serialized);
});

test('campaign storage uses a separate key and handles malformed, oversized and unavailable storage', () => {
  const storage = new MemoryStorage(),
    snapshot = makeCampaign(),
    store = new CampaignProgressStore(snapshot.projectId, snapshot.startSceneId, () => storage);
  assert.notEqual(store.key, 'voxshop:game-progress:v1:campaign-test:main');
  assert.equal(store.save(snapshot), 'saved');
  assert.deepEqual(store.load(), { status: 'loaded', snapshot });

  storage.setItem(store.key, '{ malformed');
  assert.deepEqual(store.load(), { status: 'invalid' });
  assert.equal(storage.getItem(store.key), null);
  const oversized = makeCampaign();
  oversized.scenes = Array.from({ length: 100 }, (_, index) => ({
    ...emptySceneSnapshot(oversized.projectId, index === 0 ? 'main' : `scene-${index}`),
    variables: Object.fromEntries(
      Array.from({ length: 2400 }, (_, variable) => [
        `v${variable.toString().padStart(4, '0')}_${'x'.repeat(48)}`,
        variable,
      ]),
    ),
  }));
  oversized.activeSceneId = 'scene-99';
  assert.ok(JSON.stringify(oversized).length > MAX_CAMPAIGN_PROGRESS_BYTES);
  assert.equal(store.save(oversized), 'too-large');
  const largeScene = makeCampaign();
  largeScene.scenes[0].variables = Object.fromEntries(
    Array.from({ length: 4900 }, (_, index) => [
      `variable-${index.toString().padStart(4, '0')}-${'x'.repeat(40)}`,
      index,
    ]),
  );
  assert.equal(
    store.save(largeScene),
    'too-large',
    'A scene can exceed its own budget below the campaign budget.',
  );
  assert.equal(store.save(undefined as unknown as CampaignProgressSnapshot), 'invalid');

  const blocked = new CampaignProgressStore(snapshot.projectId, snapshot.startSceneId, () => {
    throw new Error('blocked');
  });
  assert.equal(blocked.available, false);
  assert.deepEqual(blocked.load(), { status: 'unavailable' });
  assert.equal(blocked.save(snapshot), 'unavailable');
});

test('campaign storage catches read, write and clear failures', () => {
  const snapshot = makeCampaign(),
    blocked: ProgressStorageLike = {
      getItem() {
        throw new Error('read blocked');
      },
      setItem() {
        throw new Error('write blocked');
      },
      removeItem() {
        throw new Error('remove blocked');
      },
    },
    store = new CampaignProgressStore(snapshot.projectId, snapshot.startSceneId, () => blocked);
  assert.deepEqual(store.load(), { status: 'unavailable' });
  assert.equal(store.save(snapshot), 'unavailable');
  assert.equal(store.clear(), false);
});

test('A to B campaign save and resume restores B, then returns to A local state with current campaign inventory and health', async () => {
  const project = campaignProject(),
    storage = new MemoryStorage(),
    store = new CampaignProgressStore(project.id, 'main', () => storage),
    session = new GameSession(project, 'main');
  await session.ready;
  session.simulation.variables.visits = 7;
  session.simulation.inventory = [{ itemId: 'key', quantity: 2 }];
  session.simulation.health.player = 50;
  session.simulation.nodes.get('puzzle')!.enabled = false;
  session.simulation.nodes.get('puzzle')!.transform.position = [4, 0, 3];
  session.step({});
  session.step({ interact: true });
  assert.equal(session.simulation.scene.id, 'level-two');
  await session.ready;
  session.simulation.variables.visits = 12;
  session.simulation.inventory = [{ itemId: 'key', quantity: 4 }];
  session.simulation.health.player = 30;
  const saved = session.progressSnapshot();
  assert.ok(saved);
  assert.deepEqual(
    saved.scenes.map((scene) => scene.sceneId),
    ['main', 'level-two'],
  );
  assert.equal(saved.activeSceneId, 'level-two');
  const externalCopy = session.progressSnapshot()!;
  externalCopy.scenes[0].variables.visits = 999;
  assert.equal(
    session.progressSnapshot()!.scenes[0].variables.visits,
    7,
    'Editing a returned snapshot must not mutate retained scene state.',
  );
  assert.equal(store.save(saved), 'saved');
  session.dispose();

  const loaded = store.load();
  assert.equal(loaded.status, 'loaded');
  if (loaded.status !== 'loaded') return;
  const resumed = new GameSession(project, 'main', loaded.snapshot);
  await resumed.ready;
  assert.equal(resumed.simulation.scene.id, 'level-two');
  assert.equal(resumed.simulation.variables.visits, 12);
  assert.deepEqual(resumed.simulation.inventory, [{ itemId: 'key', quantity: 4 }]);
  assert.equal(resumed.simulation.health.player, 30);
  assert.equal(resumed.progressWasRestored('level-two'), true);

  resumed.step({});
  resumed.step({ interact: true });
  assert.equal(resumed.simulation.scene.id, 'main');
  assert.equal(resumed.simulation.variables.visits, 7);
  assert.equal(resumed.simulation.nodes.get('puzzle')!.enabled, false);
  assert.deepEqual(resumed.simulation.nodes.get('puzzle')!.transform.position, [4, 0, 3]);
  assert.deepEqual(resumed.simulation.inventory, [{ itemId: 'key', quantity: 4 }]);
  assert.equal(resumed.simulation.health.player, 30);
  resumed.dispose();
});

test('legacy per-scene snapshots remain accepted by GameSession', async () => {
  const project = campaignProject(),
    legacy: GameProgressSnapshot = {
      version: GAME_PROGRESS_VERSION,
      projectId: project.id,
      sceneId: 'main',
      variables: { visits: 9 },
      inventory: [{ itemId: 'key', quantity: 1 }],
      health: { player: 70 },
      nodes: { puzzle: { enabled: false } },
      status: 'playing',
    },
    session = new GameSession(project, 'main', legacy);
  await session.ready;
  assert.equal(session.simulation.scene.id, 'main');
  assert.equal(session.simulation.variables.visits, 9);
  assert.equal(session.simulation.health.player, 70);
  assert.equal(session.simulation.nodes.get('puzzle')!.enabled, false);
  assert.equal(session.progressWasRestored('main'), true);
  session.dispose();
});

test('valid campaign snapshots do not replay scene start transitions on resume or re-entry', async () => {
  const project = campaignProject();
  for (const scene of project.scenes) {
    const gateRules = scene.nodes
      .find((entry) => entry.id === 'gate')!
      .components.find((component) => component.type === 'rules');
    assert.ok(gateRules && gateRules.type === 'rules');
    gateRules.rules.push({
      event: 'start',
      interval: 1,
      once: false,
      actions: [{ type: 'transition', sceneId: scene.id === 'main' ? 'level-two' : 'main' }],
    });
  }
  validateProject(project);

  const checkpoint: CampaignProgressSnapshot = {
    version: CAMPAIGN_PROGRESS_VERSION,
    projectId: project.id,
    startSceneId: 'main',
    activeSceneId: 'main',
    scenes: ['main', 'level-two'].map((sceneId) => ({
      version: GAME_PROGRESS_VERSION,
      projectId: project.id,
      sceneId,
      variables: { visits: sceneId === 'main' ? 8 : 13 },
      inventory: [],
      health: { player: 100 },
      nodes: {},
      execution: { frame: 0, seconds: 0, firedRules: [], tickDeadlines: {} },
      status: 'playing',
    })),
    campaignVariables: {},
  };
  const session = new GameSession(project, 'main', checkpoint);
  await session.ready;
  assert.equal(session.simulation.scene.id, 'main');
  assert.equal(session.simulation.variables.visits, 8);

  session.step({});
  session.step({ interact: true });
  assert.equal(session.simulation.scene.id, 'level-two');
  await session.ready;
  assert.equal(session.simulation.variables.visits, 13);
  session.step({});
  session.step({ interact: true });
  assert.equal(session.simulation.scene.id, 'main');
  assert.equal(session.simulation.variables.visits, 8);
  session.dispose();
});

test('an incompatible visited scene rejects the entire campaign without partially restoring the entry scene', async () => {
  const project = campaignProject(),
    authored = structuredClone(project),
    session = new GameSession(project, 'main');
  await session.ready;
  session.simulation.variables.visits = 23;
  session.step({});
  session.step({ interact: true });
  await session.ready;
  const snapshot = session.progressSnapshot()!;
  session.dispose();
  const incompatible = structuredClone(snapshot),
    second = incompatible.scenes.find((scene) => scene.sceneId === 'level-two')!;
  second.nodes = { 'missing-node': { enabled: false } };

  const resumed = new GameSession(project, 'main', incompatible);
  await resumed.ready;
  assert.equal(resumed.simulation.scene.id, 'main');
  assert.equal(resumed.simulation.variables.visits, 0);
  assert.equal(resumed.progressWasRestored('main'), false);
  assert.deepEqual(
    project,
    authored,
    'validation and failed restoration must not mutate the project document',
  );
  resumed.dispose();
});
