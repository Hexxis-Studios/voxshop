import test from 'node:test';
import assert from 'node:assert/strict';
import { createExample, exampleKinds, exampleTests } from '../services/examples';
import { runPlaytest } from '../runtime/playtest';
import { GameSimulation } from '../runtime/GameSimulation';
import { renderGameHtml } from '../runtime/gameExport';
import { createAssetVisual, createNodeVisual, disposeObject } from '../runtime/assetMesh';
import {
  applyProjectOperations,
  COLLISION_OTHER_TARGET,
  newProject,
  nodeSchema,
  validateProject,
  type Component,
  type SceneNode,
} from '../services/projectDocument';
import { generateCharacter, sculptedAsset } from '../services/assetAssembly';
import { createModelDocument } from '../services/modelDocument';
import { addAnimationPreset } from '../services/animationPresets';
import { createTerrainNoise, createTerrainSurfaceSampler } from '../services/terrainNoise';
import { createWorldChunkStore, type WorldDocument } from '../services/worldDocument';
import { HUMANOID_SKELETON } from '../utils/riggingConstants';
import * as THREE from 'three';

function terrainWorld(): WorldDocument {
  return {
    id: 'terrain',
    name: 'Terrain',
    seed: 42,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-16, -16],
      size: [32, 32],
      minY: -4,
      maxY: 20,
      baseHeight: 3,
      amplitude: 0,
      noise: 0.25,
      palette: {
        surface: 0x55aa55,
        subsurface: 0x886644,
        deep: 0x554433,
        surfaceDepth: 3,
        subsurfaceDepth: 4,
        materialType: 'STANDARD',
      },
    },
    edits: [],
  };
}

function voxelCaveWorld(): WorldDocument {
  const world = terrainWorld();
  world.generator = { ...world.generator, mode: 'voxel3d', minY: -8 };
  // Open a one-cell shaft and connect it to the seeded cave for a deterministic walk-in fixture.
  world.edits = [
    ...[-1, 0, 1].flatMap((x) =>
      [5, 6, 7].flatMap((z) => [0, 1, 2, 3].map((y) => ({ x, y, z, value: null }))),
    ),
    ...[-1, 0, 1].flatMap((x) =>
      [3, 4, 5, 6, 7].flatMap((z) => [-3, -2, -1].map((y) => ({ x, y, z, value: null }))),
    ),
  ];
  return world;
}

function terrainPlayerProject(world: WorldDocument | null, position: [number, number, number]) {
  const project = createExample('arena', 'terrain-collision');
  project.assets = [];
  project.scenes[0].items = [];
  project.scenes[0].objectives = [];
  project.worlds = world ? [world] : [];
  project.scenes[0].worldId = world?.id ?? null;
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.1, 1, 0.1], offset: [0, 0.5, 0], solid: true },
      ],
      attachments: [],
    },
  ];
  return project;
}

function rigidBodyProject(
  velocity: [number, number, number] = [0, 0, 0],
  bodyPosition: [number, number, number] = [0, 4, 0],
  gravity = 18,
  restitution = 0,
  extras: any[] = [],
) {
  const project = newProject('physics-test', 'Physics test');
  project.scenes[0].nodes = [
    {
      id: 'body',
      name: 'Body',
      assetId: null,
      parentId: null,
      transform: { position: bodyPosition, rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [1, 1, 1], offset: [0, 0.5, 0], solid: true },
        { type: 'rigid-body', gravity, linearDamping: 0, restitution, velocity },
      ],
      attachments: [],
    },
    ...extras,
  ];
  return validateProject(project);
}

function settlePlayer(simulation: GameSimulation) {
  for (let i = 0; i < 300; i++) simulation.step();
  assert.equal(simulation.status, 'playing');
  return simulation.worldPosition(simulation.nodes.get('player')!);
}

type InteractionFixtureTarget = {
  id: string;
  position: [number, number, number];
  enabled?: boolean;
  interactable?: Extract<Component, { type: 'interactable' }>;
  rules?: Extract<Component, { type: 'rules' }>;
};

function interactionProject(targets: InteractionFixtureTarget[]) {
  const project = newProject('interaction-test', 'Interaction test');
  project.scenes[0].variables = { score: 0 };
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
      ],
      attachments: [],
    },
    ...targets.map((target, index) => {
      const components: Component[] = [
        { type: 'collider', size: [1, 1, 1], offset: [0, 0.5, 0], solid: false },
        ...(target.interactable ? [target.interactable] : []),
        ...(target.rules ? [target.rules] : []),
      ];
      return {
        id: target.id,
        name: `Target ${index}`,
        assetId: null,
        parentId: null,
        transform: {
          position: target.position,
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        enabled: target.enabled ?? true,
        components,
        attachments: [],
      };
    }),
  ];
  return validateProject(project);
}

test('legacy player colliders without a shape keep the synchronous AABB simulation path', () => {
  const project = terrainPlayerProject(null, [0, 0, 0]);
  const collider = project.scenes[0]!.nodes[0]!.components.find((entry) => entry.type === 'collider');
  assert.equal(collider?.type, 'collider');
  if (collider?.type !== 'collider') throw new Error('Expected the player collider.');
  assert.equal(collider.shape, undefined);

  const simulation = new GameSimulation(validateProject(project));
  try {
    simulation.step();
    assert.equal(simulation.inspect().frame, 1);
    assert.deepEqual(simulation.inspect().errors, []);
  } finally {
    simulation.dispose();
  }
});

const addInteractionScore = {
  type: 'rules',
  apiVersion: 1,
  rules: [
    { event: 'interact', interval: 1, once: false, actions: [{ type: 'add', variable: 'score', value: 1 }] },
  ],
} satisfies Extract<Component, { type: 'rules' }>;

test('interaction selects and dispatches only the nearest in-range authored target', () => {
  const simulation = new GameSimulation(
    interactionProject([
      {
        id: 'near',
        position: [1, 0, 0],
        interactable: { type: 'interactable', prompt: 'Open chest', range: 3 },
        rules: addInteractionScore,
      },
      {
        id: 'far',
        position: [2, 0, 0],
        interactable: { type: 'interactable', prompt: 'Talk', range: 3 },
        rules: addInteractionScore,
      },
      {
        id: 'same-distance',
        position: [1, 0, 0],
        interactable: { type: 'interactable', prompt: 'Tie', range: 3 },
        rules: addInteractionScore,
      },
    ]),
  );
  simulation.step();
  assert.deepEqual(simulation.inspect().interactionTarget, {
    nodeId: 'near',
    prompt: 'Open chest',
    distanceMeters: 0.5,
  });
  simulation.step({ interact: true });
  assert.equal(simulation.variables.score, 1);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'interact').map((event) => event.nodeId),
    ['near'],
  );
});

test('named signals broadcast to enabled listeners and can chain rules without runtime side effects', () => {
  const signalSource = {
    type: 'rules',
    apiVersion: 1,
    rules: [
      { event: 'interact', interval: 1, once: false, actions: [{ type: 'emit', eventId: 'door-open' }] },
    ],
  } satisfies Extract<Component, { type: 'rules' }>;
  const project = interactionProject([
    {
      id: 'switch',
      position: [1, 0, 0],
      interactable: { type: 'interactable', prompt: 'Switch', range: 3 },
      rules: signalSource,
    },
    {
      id: 'door',
      position: [4, 0, 0],
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'signal',
            eventId: 'door-open',
            interval: 1,
            once: false,
            actions: [{ type: 'set', variable: 'doorOpen', value: 1 }],
          },
        ],
      },
    },
    {
      id: 'lamp',
      position: [6, 0, 0],
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'signal',
            eventId: 'door-open',
            interval: 1,
            once: false,
            actions: [{ type: 'emit', eventId: 'lights-on' }],
          },
        ],
      },
    },
    {
      id: 'light-state',
      position: [8, 0, 0],
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'signal',
            eventId: 'lights-on',
            interval: 1,
            once: false,
            actions: [{ type: 'set', variable: 'lightsOn', value: 1 }],
          },
        ],
      },
    },
    {
      id: 'disabled-listener',
      position: [10, 0, 0],
      enabled: false,
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'signal',
            eventId: 'door-open',
            interval: 1,
            once: false,
            actions: [{ type: 'set', variable: 'disabledRan', value: 1 }],
          },
        ],
      },
    },
  ]);
  project.scenes[0].variables = { score: 0, doorOpen: 0, lightsOn: 0, disabledRan: 0 };
  const simulation = new GameSimulation(project);
  simulation.step();
  simulation.step({ interact: true });

  assert.equal(simulation.variables.doorOpen, 1);
  assert.equal(simulation.variables.lightsOn, 1);
  assert.equal(simulation.variables.disabledRan, 0);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'signal').map((event) => event.data),
    [{ eventId: 'door-open' }, { eventId: 'lights-on' }],
  );
  assert.equal(simulation.events.find((event) => event.type === 'signal')?.nodeId, 'switch');
});

test('cyclic named signals stay iterative and stop at the shared action budget', () => {
  const project = interactionProject([
    {
      id: 'switch',
      position: [1, 0, 0],
      interactable: { type: 'interactable', prompt: 'Switch', range: 3 },
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          { event: 'interact', interval: 1, once: false, actions: [{ type: 'emit', eventId: 'loop' }] },
        ],
      },
    },
    {
      id: 'loop',
      position: [4, 0, 0],
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'signal',
            eventId: 'loop',
            interval: 1,
            once: false,
            actions: [{ type: 'emit', eventId: 'loop' }],
          },
        ],
      },
    },
  ]);
  const simulation = new GameSimulation(project);
  simulation.step();
  simulation.step({ interact: true });
  assert.equal(simulation.status, 'stopped');
  assert.match(simulation.errors.at(-1) ?? '', /Gameplay exceeded 4096 actions in a single simulation step/);
  assert.equal(simulation.events.at(-1)?.type, 'error');
});

test('interaction respects authored range, disabled targets and legacy rule-only targets', () => {
  const simulation = new GameSimulation(
    interactionProject([
      {
        id: 'too-far',
        position: [2, 0, 0],
        interactable: { type: 'interactable', prompt: 'Out of reach', range: 0.5 },
      },
      {
        id: 'disabled',
        position: [1, 0, 0],
        enabled: false,
        interactable: { type: 'interactable', prompt: 'Disabled', range: 3 },
      },
      { id: 'legacy', position: [3, 0, 0], rules: addInteractionScore },
    ]),
  );
  simulation.step();
  assert.equal(simulation.inspect().interactionTarget?.nodeId, 'legacy');
  simulation.step({ interact: true });
  assert.equal(simulation.variables.score, 1);
  assert.equal(simulation.events.find((event) => event.type === 'interact')?.nodeId, 'legacy');
});

test('line-of-sight interactables are hidden behind solid scene colliders', () => {
  const project = interactionProject([
    {
      id: 'target',
      position: [2, 0, 0],
      interactable: {
        type: 'interactable',
        prompt: 'Open door',
        range: 3,
        requiresLineOfSight: true,
      },
      rules: addInteractionScore,
    },
  ]);
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'wall',
      name: 'Wall',
      transform: { position: [1, 0, 0] },
      components: [{ type: 'collider', size: [0.2, 2, 2], offset: [0, 0.5, 0], solid: true }],
    }),
  );
  const simulation = new GameSimulation(validateProject(project));
  simulation.step();
  assert.equal(simulation.inspect().interactionTarget, null);
  simulation.step({ interact: true });
  assert.equal(simulation.variables.score, 0);
  assert.equal(
    simulation.events.some((event) => event.type === 'interact'),
    false,
  );
});

test('line-of-sight interaction ray detects authored voxel terrain while leaving legacy interactions unchanged', () => {
  const project = interactionProject([
    {
      id: 'target',
      position: [3, 5, 0],
      interactable: {
        type: 'interactable',
        prompt: 'Talk',
        range: 5,
        requiresLineOfSight: true,
      },
    },
  ]);
  project.scenes[0].nodes[0].transform.position = [0, 5, 0];
  const terrain = terrainWorld();
  terrain.generator = { ...terrain.generator, mode: 'voxel3d', minY: -8 };
  terrain.edits = [{ x: 2, y: 11, z: 0, value: { color: 0x725439, materialType: 'STANDARD' } }];
  project.worlds = [terrain];
  project.scenes[0].worldId = terrain.id;
  const simulation = new GameSimulation(validateProject(project));
  simulation.step();
  assert.equal(simulation.inspect().interactionTarget, null);

  const unobstructed = new GameSimulation(
    interactionProject([
      {
        id: 'legacy',
        position: [2, 0, 0],
        interactable: { type: 'interactable', prompt: 'Use', range: 3 },
      },
    ]),
  );
  unobstructed.step();
  assert.equal(unobstructed.inspect().interactionTarget?.nodeId, 'legacy');
});

test('player combat settings control attack damage, reach, cooldown, and checkpoint restore', () => {
  const project = newProject('player-combat', 'Player combat');
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'player',
      name: 'Player',
      transform: {},
      components: [
        { type: 'player', style: 'top-down', speed: 3 },
        { type: 'combat', damage: 30, range: 2, cooldown: 0.8 },
        { type: 'health', maximum: 100 },
      ],
    }),
    nodeSchema.parse({
      id: 'near-enemy',
      name: 'Near enemy',
      transform: { position: [1, 0, 0] },
      components: [
        { type: 'enemy', speed: 0.01, damage: 1, range: 0.1 },
        { type: 'health', maximum: 40 },
      ],
    }),
    nodeSchema.parse({
      id: 'far-enemy',
      name: 'Far enemy',
      transform: { position: [2.5, 0, 0] },
      components: [
        { type: 'enemy', speed: 0.01, damage: 1, range: 0.1 },
        { type: 'health', maximum: 40 },
      ],
    }),
  ];
  const simulation = new GameSimulation(validateProject(project));
  simulation.step({ attack: true });
  assert.equal(simulation.health['near-enemy'], 10);
  assert.equal(simulation.health['far-enemy'], 40, 'targets outside the authored attack reach stay unharmed');

  const snapshot = simulation.progressSnapshot();
  assert.equal(snapshot?.behavior?.cooldowns.attack, 0.8);
  const restored = new GameSimulation(validateProject(project), 'main', snapshot);
  assert.equal(restored.progressRestored, true, 'custom cooldowns survive a campaign checkpoint');
  assert.equal(restored.health['near-enemy'], 10);
  for (let i = 0; i < 9; i++) restored.step({ attack: false }, 0.1);
  restored.step({ attack: true });
  assert.equal(restored.health['near-enemy'], 0, 'the configured damage defeats the in-range target');
  assert.equal(restored.variables.kills, 1);
  assert.equal(restored.health['far-enemy'], 40);
  assert.deepEqual(restored.errors, []);

  const legacyProject = newProject('legacy-player-combat', 'Legacy player combat');
  legacyProject.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'player',
      name: 'Player',
      transform: {},
      components: [
        { type: 'player', style: 'top-down', speed: 3 },
        { type: 'health', maximum: 100 },
      ],
    }),
    nodeSchema.parse({
      id: 'enemy',
      name: 'Enemy',
      transform: { position: [2, 0, 0] },
      components: [
        { type: 'enemy', speed: 0.01, damage: 1, range: 0.1 },
        { type: 'health', maximum: 50 },
      ],
    }),
  ];
  const legacySimulation = new GameSimulation(validateProject(legacyProject));
  legacySimulation.step({ attack: true });
  assert.equal(legacySimulation.health.enemy, 25, 'legacy projects keep the former 25 damage and 3m reach');
});

test('touch and untouch rules fire on overlap transitions, including disabled targets and players', () => {
  const project = interactionProject([
    {
      id: 'trigger',
      position: [0, 0, 0],
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'touch',
            interval: 1,
            once: false,
            actions: [{ type: 'add', variable: 'score', value: 1 }],
          },
        ],
      },
    },
    {
      id: 'exit-only',
      position: [0, 0, 0],
      rules: {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'untouch',
            interval: 1,
            once: false,
            actions: [{ type: 'add', variable: 'leaves', value: 1 }],
          },
        ],
      },
    },
  ]);
  project.scenes[0].variables = { score: 0, leaves: 0 };
  const simulation = new GameSimulation(project);

  for (let i = 0; i < 10; i++) simulation.step();
  assert.equal(simulation.variables.score, 1);
  assert.equal(simulation.variables.leaves, 0);

  for (let i = 0; i < 40; i++) simulation.step({ moveX: 1 });
  assert.equal(simulation.variables.score, 1);
  assert.equal(simulation.variables.leaves, 1);

  for (let i = 0; i < 40; i++) simulation.step({ moveX: -1 });
  assert.equal(simulation.variables.score, 2);
  assert.equal(simulation.variables.leaves, 1);
  for (let i = 0; i < 10; i++) simulation.step();
  assert.equal(simulation.variables.score, 2);
  assert.equal(simulation.variables.leaves, 1);

  const trigger = simulation.nodes.get('trigger')!;
  trigger.enabled = false;
  simulation.step();
  trigger.enabled = true;
  simulation.step();
  assert.equal(simulation.variables.score, 3);
  assert.equal(simulation.variables.leaves, 1);

  const player = simulation.nodes.get('player')!;
  player.enabled = false;
  simulation.step();
  player.enabled = true;
  simulation.step();
  assert.equal(simulation.variables.score, 4);
  assert.equal(simulation.variables.leaves, 1);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'touch').map((event) => event.nodeId),
    ['trigger', 'exit-only', 'trigger', 'exit-only', 'trigger', 'trigger', 'exit-only'],
  );
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'untouch').map((event) => event.nodeId),
    ['trigger', 'exit-only'],
  );
});

test('sensor colliders do not block player movement when an older document also marks them solid', () => {
  const project = newProject('sensor-player', 'Sensor player');
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [-2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 5, jump: 0 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
      ],
      attachments: [],
    },
    {
      id: 'sensor',
      name: 'Sensor',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [{ type: 'collider', size: [1, 2, 2], offset: [0, 0, 0], solid: true, sensor: true }],
      attachments: [],
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  for (let i = 0; i < 5; i++) simulation.step({ moveX: 1 }, 0.1);
  assert.ok(simulation.worldPosition(simulation.nodes.get('player')!).x > 0.4);
  simulation.dispose();
});

test('heal rules restore authored health, clamp to its maximum and skip objects without health', () => {
  const project = newProject('heal-test', 'Heal test');
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
        { type: 'health', maximum: 100 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              interval: 1,
              once: false,
              actions: [
                { type: 'damage', target: 'player', amount: 40 },
                { type: 'heal', target: 'player', amount: 15 },
                { type: 'heal', target: 'player', amount: 50 },
                { type: 'heal', target: 'source', amount: 25 },
              ],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'source',
      name: 'Source without health',
      assetId: null,
      parentId: null,
      transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [{ event: 'start', interval: 1, once: false, actions: [{ type: 'heal', amount: 10 }] }],
        },
      ],
      attachments: [],
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  assert.equal(simulation.health.player, 100);
  assert.equal(simulation.health.source, undefined);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'healed').map((event) => event.data),
    [
      { amount: 15, remaining: 75 },
      { amount: 50, remaining: 100 },
    ],
  );
});

test('usable healing items consume on input edges, clamp health, and restore from campaign progress', () => {
  const project = newProject('usable-item-test', 'Usable item test');
  project.scenes[0].items = [
    { id: 'medkit', name: 'Medkit', description: '', maxStack: 4, use: { type: 'heal', amount: 25 } },
  ];
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [{ event: 'start', once: false, interval: 1, actions: [{ type: 'damage', amount: 30 }] }],
        },
      ],
      attachments: [],
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  simulation.inventory = [{ itemId: 'medkit', quantity: 2 }];

  simulation.step({ useItem: 'medkit' });
  assert.equal(simulation.health.player, 95);
  assert.deepEqual(simulation.inventory, [{ itemId: 'medkit', quantity: 1 }]);
  simulation.step({ useItem: 'medkit' });
  assert.equal(simulation.health.player, 95, 'holding the item input must not consume again');
  assert.deepEqual(simulation.inventory, [{ itemId: 'medkit', quantity: 1 }]);
  simulation.step({});
  simulation.step({ useItem: 'medkit' });
  assert.equal(simulation.health.player, 100);
  assert.deepEqual(simulation.inventory, []);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'item-used').map((event) => event.data),
    [
      { itemId: 'medkit', effect: 'heal', amount: 25 },
      { itemId: 'medkit', effect: 'heal', amount: 5 },
    ],
  );

  const snapshot = simulation.progressSnapshot();
  assert.ok(snapshot);
  const restored = new GameSimulation(validateProject(project), 'main', snapshot);
  assert.equal(restored.progressRestored, true);
  assert.equal(restored.health.player, 100);
  assert.deepEqual(restored.inventory, []);
  restored.inventory = [{ itemId: 'medkit', quantity: 1 }];
  restored.step({ useItem: 'medkit' });
  assert.equal(restored.health.player, 100);
  assert.deepEqual(restored.inventory, [{ itemId: 'medkit', quantity: 1 }]);
  assert.equal(restored.message, 'Health is already full.');
});

test('equippable items swap fitted gear, toggle off, and survive campaign progress without consuming the item', () => {
  const project = createExample('arena', 'equipment-item-test');
  const scene = project.scenes[0],
    player = scene.nodes.find((node) => node.components.some((component) => component.type === 'player'))!;
  scene.nodes = scene.nodes.filter((node) => node.id !== 'shell-pickup');
  scene.objectives = scene.objectives.filter((objective) => objective.id !== 'find-shell');
  player.attachments = [];
  scene.items = [
    {
      id: 'shell-token',
      name: 'Shell token',
      description: '',
      maxStack: 4,
      use: { type: 'equip', assetId: 'armor' },
    },
    {
      id: 'alt-shell-token',
      name: 'Alternate shell token',
      description: '',
      maxStack: 4,
      use: { type: 'equip', assetId: 'armor-alt' },
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  simulation.inventory = [{ itemId: 'shell-token', quantity: 1 }];

  simulation.step({ useItem: 'shell-token' });
  assert.deepEqual(
    simulation.nodes.get(player.id)?.attachments.map((attachment) => [attachment.assetId, attachment.slot]),
    [['armor', 'shell']],
  );
  assert.deepEqual(simulation.inventory, [{ itemId: 'shell-token', quantity: 1 }]);
  simulation.inventory.push({ itemId: 'alt-shell-token', quantity: 1 });
  simulation.step({});
  simulation.step({ useItem: 'alt-shell-token' });
  assert.deepEqual(
    simulation.nodes.get(player.id)?.attachments.map((attachment) => [attachment.assetId, attachment.slot]),
    [['armor-alt', 'shell']],
  );
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'equipment-changed').map((event) => event.data),
    [
      { itemId: 'shell-token', assetId: 'armor', slot: 'shell', equipped: true },
      { itemId: 'alt-shell-token', assetId: 'armor-alt', slot: 'shell', equipped: true },
    ],
  );
  assert.deepEqual(player.attachments, [], 'runtime use must not modify the authored project');

  const snapshot = simulation.progressSnapshot();
  assert.deepEqual(
    snapshot?.nodes.player.attachments?.map((attachment) => attachment.assetId),
    ['armor-alt'],
  );
  const restored = new GameSimulation(validateProject(project), 'main', snapshot);
  assert.equal(restored.progressRestored, true);
  assert.deepEqual(
    restored.nodes.get(player.id)?.attachments.map((attachment) => attachment.assetId),
    ['armor-alt'],
  );
  restored.step({});
  restored.step({ useItem: 'alt-shell-token' });
  assert.deepEqual(restored.nodes.get(player.id)?.attachments, []);
  assert.deepEqual(restored.inventory, [
    { itemId: 'shell-token', quantity: 1 },
    { itemId: 'alt-shell-token', quantity: 1 },
  ]);
});

test('Arena starter shell pickup equips its compatible alternative without consuming the item', () => {
  const project = createExample('arena', 'arena-field-shell'),
    scene = project.scenes[0],
    player = scene.nodes.find((node) => node.components.some((component) => component.type === 'player'))!,
    gear = project.assets.find((asset) => asset.id === 'armor-alt'),
    item = scene.items.find((definition) => definition.id === 'field-shell'),
    pickup = scene.nodes.find((node) => node.id === 'shell-pickup'),
    collectible = pickup?.components.find((component) => component.type === 'collectible');

  assert.equal(gear?.equipment?.kind, 'shell');
  assert.equal(gear?.equipment?.bodyAssetId, player.assetId);
  assert.equal(item?.use?.type, 'equip');
  assert.equal(item?.use?.type === 'equip' ? item.use.assetId : undefined, gear?.id);
  assert.ok(collectible?.type === 'collectible');
  assert.equal(collectible.itemId, item?.id);
  assert.ok(pickup);
  const distance = Math.hypot(
    pickup.transform.position[0] - player.transform.position[0],
    pickup.transform.position[1] - player.transform.position[1],
    pickup.transform.position[2] - player.transform.position[2],
  );
  assert.ok(distance <= 2, 'the pickup sits within a short walk of the spawn');
  const enemyDistances = scene.nodes
    .filter((node) => node.components.some((component) => component.type === 'enemy'))
    .map((enemy) =>
      Math.hypot(
        pickup.transform.position[0] - enemy.transform.position[0],
        pickup.transform.position[1] - enemy.transform.position[1],
        pickup.transform.position[2] - enemy.transform.position[2],
      ),
    );
  assert.ok(Math.min(...enemyDistances) > 3, 'the pickup is outside the sentinels’ initial reach');

  for (const kind of exampleKinds) {
    if (kind === 'arena') continue;
    const other = createExample(kind, `without-arena-shell-${kind}`);
    assert.equal(
      other.assets.some((asset) => asset.id === 'armor-alt'),
      false,
    );
    assert.equal(
      other.scenes[0].items.some((definition) => definition.id === 'field-shell'),
      false,
    );
    assert.equal(
      other.scenes[0].nodes.some((node) => node.id === 'shell-pickup'),
      false,
    );
  }

  const simulation = new GameSimulation(validateProject(project)),
    shellIds = () =>
      simulation.nodes
        .get(player.id)!
        .attachments.filter(
          (attachment) =>
            project.assets.find((asset) => asset.id === attachment.assetId)?.equipment?.kind === 'shell',
        )
        .map((attachment) => attachment.assetId);
  assert.deepEqual(shellIds(), ['armor']);
  for (let i = 0; i < 8; i++) simulation.step({ moveX: 1, moveZ: -1 }, 1 / 60);
  assert.deepEqual(simulation.inventory, [{ itemId: 'field-shell', quantity: 1 }]);
  assert.equal(simulation.nodes.get('shell-pickup')?.enabled, false);

  simulation.step({ useItem: 'field-shell' });
  assert.deepEqual(shellIds(), ['armor-alt']);
  assert.deepEqual(simulation.inventory, [{ itemId: 'field-shell', quantity: 1 }]);
});

test('usable items and standalone controls remain backward-compatible with old item definitions', () => {
  const project = newProject('usable-item-export', 'Usable item export');
  project.scenes[0].items = [
    { id: 'potion', name: 'Potion', description: '', maxStack: 8, use: { type: 'heal', amount: 12 } },
    { id: 'ore', name: 'Ore', description: '', maxStack: 99 },
  ];
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'player',
      name: 'Player',
      transform: {},
      components: [{ type: 'player', style: 'third-person', speed: 3 }],
    }),
  );
  const parsed = validateProject(project);
  assert.equal(parsed.scenes[0].items[1].use, undefined);
  const html = renderGameHtml(parsed, 'main', 'runtime', 'license');
  assert.match(html, /inventory 1\/2\/3\/4\/5\/6\/7\/8\/9/);
});

test('heal rejects a missing authored target and safely skips it at runtime', () => {
  const project = newProject('heal-missing-target', 'Heal missing target test');
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'health', maximum: 100 },
      ],
      attachments: [],
    },
    {
      id: 'source',
      name: 'Healer',
      assetId: null,
      parentId: null,
      transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              interval: 1,
              once: false,
              actions: [{ type: 'heal', target: 'missing', amount: 10 }],
            },
          ],
        },
      ],
      attachments: [],
    },
  ];
  assert.throws(() => validateProject(project), /Rule references a missing node/);
  const simulation = new GameSimulation(project);
  assert.equal(simulation.health.player, 100);
  assert.equal(
    simulation.events.some((event) => event.type === 'healed'),
    false,
  );
});

for (const kind of exampleKinds)
  test(`${kind} example completes with the shared deterministic runtime and does not alter authoring state`, async () => {
    const p = createExample(kind, `test-${kind}`),
      before = structuredClone(p);
    const r = await runPlaytest(p, exampleTests[kind]);
    assert.equal(r.passed, true, JSON.stringify(r));
    assert.deepEqual(p, before);
    if (kind === 'survival') {
      assert.deepEqual(
        p.assets.map((asset) => asset.id),
        ['hero', 'pack', 'armor', 'logs', 'stone', 'pine', 'bench', 'campfire'],
      );
      assert.deepEqual(r.state.inventory, [{ itemId: 'campfire-kit', quantity: 1, name: 'Campfire kit' }]);
      assert.ok(r.state.events.some((event) => event.type === 'crafted' && event.nodeId === 'workbench'));
      assert.ok(r.state.events.some((event) => event.type === 'interact' && event.nodeId === 'workbench'));
    }
    if (kind === 'construction') {
      assert.equal(p.name, 'Voxel workshop');
      assert.deepEqual(
        p.assets.map((asset) => asset.id),
        ['hero', 'pack', 'armor'],
      );
      assert.equal(p.worlds[0].generator.mode, 'voxel3d');
      assert.equal(p.worlds[0].voxelSize, 1.5);
      assert.equal(p.scenes[0].worldId, 'construction-world');
      assert.deepEqual(r.state.inventory, [{ itemId: 'stone', quantity: 63, name: 'Building blocks' }]);
      assert.equal(r.state.events.filter((event) => event.type === 'terrain-cell-placed').length, 2);
      assert.equal(r.state.events.filter((event) => event.type === 'terrain-cell-removed').length, 1);
      assert.deepEqual(p.worlds[0].edits, []);
    }
  });

test('selected terrain world supports standing and jumping at its generated surface', () => {
  const world = terrainWorld();
  const project = terrainPlayerProject(world, [0, 12, 0]);
  const hero = createExample('exploration', 'action-animation').assets.find((asset) => asset.id === 'hero')!;
  hero.rig = addAnimationPreset(hero.rig!, 'jump', { name: 'test-jump' });
  hero.rig = addAnimationPreset(hero.rig!, 'attack', { name: 'test-attack' });
  const player = project.scenes[0].nodes[0];
  player.assetId = hero.id;
  const idle = hero.rig.clips.find((clip) => clip.name.toLowerCase() === 'idle')!;
  const moving = hero.rig.clips.find((clip) => clip.name.toLowerCase() === 'walk')!;
  player.components.push({
    type: 'animation',
    idle: idle.name,
    moving: moving.name,
    jumping: 'test-jump',
    attacking: 'test-attack',
  });
  project.assets = [hero];
  const simulation = new GameSimulation(validateProject(project));
  const landed = settlePlayer(simulation);
  assert.ok(Math.abs(landed.y - 1.75) < 0.01, `Expected terrain top at 1.75m, got ${landed.y}.`);
  simulation.step({ jump: true });
  assert.ok(simulation.worldPosition(simulation.nodes.get('player')!).y > landed.y + 0.05);
  assert.equal(simulation.animationState('player')?.clip, 'test-jump');
  simulation.step({ attack: true });
  assert.equal(simulation.animationState('player')?.clip, 'test-attack');
  for (let frame = 0; frame < 45; frame++) simulation.step();
  assert.notEqual(simulation.animationState('player')?.clip, 'test-attack');
  simulation.dispose();
});

test('player sprint selects a rig run clip and returns to the authored move clip', () => {
  const project = newProject('sprint-animation', 'Sprint animation');
  const hero = createExample('exploration', 'action-animation').assets.find((asset) => asset.id === 'hero')!;
  assert.ok(hero.rig?.clips.some((clip) => clip.name.toLowerCase() === 'run'));
  project.assets = [hero];
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'player',
      name: 'Player',
      assetId: hero.id,
      transform: {},
      components: [
        { type: 'player', style: 'third-person', speed: 3, sprintMultiplier: 1.8 },
        { type: 'animation', idle: 'idle', moving: 'walk', running: 'run' },
      ],
    }),
  ];
  const simulation = new GameSimulation(validateProject(project));
  try {
    simulation.step({ moveX: 1, sprint: true });
    assert.equal(simulation.animationState('player')?.clip, 'run');
    simulation.step({ moveX: 1 });
    assert.equal(simulation.animationState('player')?.clip, 'walk');
  } finally {
    simulation.dispose();
  }
});

test('GameSimulation exposes non-mutating physics queries after scene initialization', async () => {
  const project = newProject('physics-query-api', 'Physics query API');
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'wall',
      name: 'Wall',
      transform: { position: [3, 4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ type: 'collider', size: [1, 2, 2], solid: true }],
    }),
  ];
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  try {
    const result = await simulation.queryPhysics({
      shape: 'ray',
      origin: [0, 4, 0],
      direction: [2, 0, 0],
      maxDistance: 10,
      includeSensors: false,
      excludeNodeIds: [],
    });
    assert.equal(result.available && result.shape === 'ray' ? result.hit?.nodeId : null, 'wall');
    assert.equal(result.available && result.shape === 'ray' ? result.hit?.distance : null, 2.5);
    assert.equal(simulation.worldPosition(simulation.nodes.get('wall')!).x, 3);
  } finally {
    simulation.dispose();
  }
});

test('terrain world extent controls Play movement bounds independently of scene radius', () => {
  const wide = terrainWorld();
  wide.generator = { ...wide.generator, origin: [-128, -128], size: [512, 512] };
  const wideProject = terrainPlayerProject(wide, [15, 12, 0]);
  const wideSimulation = new GameSimulation(wideProject);
  settlePlayer(wideSimulation);
  for (let frame = 0; frame < 180; frame++) wideSimulation.step({ moveX: 1 });
  const widePosition = wideSimulation.worldPosition(wideSimulation.nodes.get('player')!);
  assert.ok(
    widePosition.x > wideProject.scenes[0].bounds + 2,
    `Expected to walk beyond the ${wideProject.scenes[0].bounds}m scene radius across the wider terrain, got ${widePosition.x}.`,
  );
  assert.ok(widePosition.y > 1.7, 'The player remains supported by the terrain beyond the scene radius.');

  const finiteWorld = terrainWorld();
  const finiteProject = terrainPlayerProject(finiteWorld, [7.3, 12, 0]);
  const finiteSimulation = new GameSimulation(finiteProject);
  settlePlayer(finiteSimulation);
  for (let frame = 0; frame < 120; frame++) finiteSimulation.step({ moveX: 1 });
  const finitePosition = finiteSimulation.worldPosition(finiteSimulation.nodes.get('player')!);
  assert.ok(
    Math.abs(finitePosition.x - 7.7) < 0.02,
    `Expected the player collider to stop at the finite terrain edge, got ${finitePosition.x}.`,
  );
  assert.ok(finitePosition.y > 1.7, 'The player does not walk off the generated world edge.');
});

test('actor collision against overlapping solid segments uses the nearest wall face once', () => {
  const project = terrainPlayerProject(null, [0, 0, 0]);
  project.scenes[0].nodes.push(
    ...[0.15, 0.16].map((x, index) => ({
      id: `wall-${index}`,
      name: `Wall ${index}`,
      assetId: null,
      parentId: null,
      transform: {
        position: [x, 0.5, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      enabled: true,
      components: [
        {
          type: 'collider' as const,
          size: [0.2, 2, 2] as [number, number, number],
          offset: [0, 0, 0] as [number, number, number],
          solid: true,
        },
      ],
      attachments: [],
    })),
  );
  const simulation = new GameSimulation(project);
  simulation.step({ moveX: 1 });
  const x = simulation.worldPosition(simulation.nodes.get('player')!).x;
  assert.ok(Math.abs(x) < 1e-6, `Expected the actor to stay at the nearest wall face, got x=${x}.`);
});

test('player movement sweeps thin solid colliders smaller than its movement substep', () => {
  const project = terrainPlayerProject(null, [0, 0, 0]);
  project.scenes[0].nodes[0]!.components = project.scenes[0].nodes[0]!.components.map((component) =>
    component.type === 'player'
      ? { ...component, speed: 100 }
      : component.type === 'collider'
        ? { ...component, size: [0.001, 1, 0.001] }
        : component,
  );
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'thin-wall',
      name: 'Thin wall',
      transform: { position: [1.1, 0, 0] },
      components: [{ type: 'collider', size: [0.002, 4, 4], offset: [0, 0, 0], solid: true }],
    }),
  );
  const simulation = new GameSimulation(validateProject(project));

  simulation.step({ moveX: 1 }, 0.1);

  const position = simulation.worldPosition(simulation.nodes.get('player')!);
  assert.ok(
    position.x <= 1.1 - 0.0015 + 1e-5,
    `The thin wall should stop the fast player at its near face, got x=${position.x}.`,
  );
});

test('authored player step height climbs a reachable solid block but respects a low ceiling', () => {
  const createStepScene = (withCeiling: boolean) => {
    const project = terrainPlayerProject(null, [0, 0, 0]);
    project.scenes[0].nodes[0]!.components = project.scenes[0].nodes[0]!.components.map((component) =>
      component.type === 'player' ? { ...component, stepHeight: 0.5 } : component,
    );
    project.scenes[0].nodes.push(
      nodeSchema.parse({
        id: 'step',
        name: 'Step',
        transform: { position: [0.5, 0.25, 0] },
        components: [{ type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0, 0], solid: true }],
      }),
    );
    if (withCeiling)
      project.scenes[0].nodes.push(
        nodeSchema.parse({
          id: 'ceiling',
          name: 'Ceiling',
          transform: { position: [0.5, 1.3, 0] },
          components: [{ type: 'collider', size: [1, 0.5, 1], offset: [0, 0, 0], solid: true }],
        }),
      );
    return validateProject(project);
  };
  const climb = new GameSimulation(createStepScene(false)),
    blocked = new GameSimulation(createStepScene(true));
  try {
    for (let frame = 0; frame < 12; frame++) {
      climb.step({ moveX: 1 });
      blocked.step({ moveX: 1 });
    }
    const climbed = climb.worldPosition(climb.nodes.get('player')!),
      underCeiling = blocked.worldPosition(blocked.nodes.get('player')!);
    assert.ok(climbed.x > 0.5, `Expected the player to get onto the block, got x=${climbed.x}.`);
    assert.ok(Math.abs(climbed.y - 0.5) < 0.01, `Expected the step top at y=0.5, got ${climbed.y}.`);
    assert.ok(underCeiling.x < 0.25, `Expected the low ceiling to prevent step-up, got x=${underCeiling.x}.`);
  } finally {
    climb.dispose();
    blocked.dispose();
  }
});

test('authored player step height applies to voxel terrain cells', () => {
  const world = terrainWorld();
  world.generator = { ...world.generator, mode: 'voxel3d' };
  world.edits = [{ x: 3, y: 4, z: 0, value: { color: 0x886644, materialType: 'STANDARD' } }];
  const project = terrainPlayerProject(world, [1, 1.75, 0]);
  project.scenes[0].nodes[0]!.components = project.scenes[0].nodes[0]!.components.map((component) =>
    component.type === 'player' ? { ...component, stepHeight: 0.5 } : component,
  );
  const simulation = new GameSimulation(validateProject(project));
  try {
    for (let frame = 0; frame < 12; frame++) simulation.step({ moveX: 1 });
    const position = simulation.worldPosition(simulation.nodes.get('player')!);
    assert.ok(position.x > 0.5, `Expected the player to climb the terrain block, got x=${position.x}.`);
    assert.ok(Math.abs(position.y - 2.25) < 0.01, `Expected the terrain step at y=2.25, got ${position.y}.`);
  } finally {
    simulation.dispose();
  }
});

test('grounded capsule and AABB players ride translating kinematic platforms once and jump free', async () => {
  const createRider = async (
    platformBodyType: 'kinematic-position' | 'kinematic-velocity' = 'kinematic-position',
    platformVelocity: [number, number, number] = [0, 0, 0],
    playerShape: 'box' | 'capsule' = 'capsule',
    parentedPlatform = false,
  ) => {
    const project = terrainPlayerProject(null, [0, 4, 0]),
      player = project.scenes[0].nodes[0]!;
    player.components = player.components.map((component) =>
      component.type === 'collider'
        ? {
            ...component,
            shape: playerShape,
            size: playerShape === 'capsule' ? [0.5, 1, 0.5] : component.size,
          }
        : component,
    );
    if (parentedPlatform)
      project.scenes[0].nodes.push(
        nodeSchema.parse({
          id: 'platform-root',
          name: 'Moving platform root',
          transform: { position: [0, 0, 0] },
          components: [],
        }),
      );
    project.scenes[0].nodes.push(
      nodeSchema.parse({
        id: 'platform',
        name: 'Moving platform',
        parentId: parentedPlatform ? 'platform-root' : null,
        transform: { position: [0, 3.75, 0] },
        components: [
          { type: 'collider', size: [4, 0.5, 4], solid: true },
          {
            type: 'rigid-body',
            bodyType: platformBodyType,
            gravity: 0,
            velocity: platformVelocity,
          },
        ],
      }),
    );
    const simulation = new GameSimulation(validateProject(project));
    await simulation.ready;
    for (let frame = 0; frame < 10; frame++) simulation.step({});
    return simulation;
  };

  const rider = await createRider(),
    jumper = await createRider(),
    descending = await createRider(),
    boxRider = await createRider('kinematic-position', [0, 0, 0], 'box'),
    boxDescending = await createRider('kinematic-position', [0, 0, 0], 'box'),
    boxJumper = await createRider('kinematic-position', [0, 0, 0], 'box'),
    parentedRider = await createRider('kinematic-position', [0, 0, 0], 'capsule', true),
    velocityRider = await createRider('kinematic-velocity', [1, 0, 0]),
    boxVelocityRider = await createRider('kinematic-velocity', [1, 0, 0], 'box');
  try {
    const riderNode = rider.nodes.get('player')!,
      platform = rider.nodes.get('platform')!;
    platform.transform.position[0] = 1;
    rider.step({});
    const carriedX = rider.worldPosition(riderNode).x;
    assert.ok(carriedX > 0.95, `Expected the grounded player to follow the platform, got x=${carriedX}.`);
    rider.step({});
    assert.ok(
      Math.abs(rider.worldPosition(riderNode).x - carriedX) < 0.01,
      'A stationary platform displacement must not be applied twice.',
    );

    const jumperNode = jumper.nodes.get('player')!,
      jumpPlatform = jumper.nodes.get('platform')!,
      beforeJump = jumper.worldPosition(jumperNode).clone();
    jumpPlatform.transform.position[0] = 1;
    jumper.step({ jump: true });
    const afterJump = jumper.worldPosition(jumperNode);
    assert.ok(Math.abs(afterJump.x - beforeJump.x) < 0.01, 'An airborne player must not be carried.');
    assert.ok(afterJump.y > beforeJump.y, 'The player should still jump away from the platform.');

    const descendingNode = descending.nodes.get('player')!,
      descendingPlatform = descending.nodes.get('platform')!;
    descendingPlatform.transform.position[1] = 3.25;
    descending.step({});
    const descended = descending.worldPosition(descendingNode).y;
    assert.ok(
      Math.abs(descended - 3.5) < 0.02,
      `Expected the grounded player to follow the platform down, got y=${descended}.`,
    );

    const boxRiderNode = boxRider.nodes.get('player')!,
      boxRiderPlatform = boxRider.nodes.get('platform')!;
    boxRiderPlatform.transform.position[0] = 1;
    boxRider.step({});
    assert.ok(
      boxRider.worldPosition(boxRiderNode).x > 0.95,
      `Expected the AABB player to follow an authored platform translation, got x=${boxRider.worldPosition(boxRiderNode).x}.`,
    );

    const parentedPlayer = parentedRider.nodes.get('player')!,
      platformRoot = parentedRider.nodes.get('platform-root')!;
    platformRoot.transform.position[0] = 1;
    parentedRider.step({});
    assert.ok(
      parentedRider.worldPosition(parentedPlayer).x > 0.95,
      `Expected the player to follow a platform translated by its parent, got x=${parentedRider.worldPosition(parentedPlayer).x}.`,
    );

    const boxDescendingNode = boxDescending.nodes.get('player')!,
      boxDescendingPlatform = boxDescending.nodes.get('platform')!;
    boxDescendingPlatform.transform.position[1] = 3.25;
    boxDescending.step({});
    assert.ok(
      Math.abs(boxDescending.worldPosition(boxDescendingNode).y - 3.5) < 0.02,
      `Expected the AABB player to follow a descending platform, got y=${boxDescending.worldPosition(boxDescendingNode).y}.`,
    );

    const boxJumperNode = boxJumper.nodes.get('player')!,
      boxJumpPlatform = boxJumper.nodes.get('platform')!,
      beforeBoxJump = boxJumper.worldPosition(boxJumperNode).clone();
    boxJumpPlatform.transform.position[0] = 1;
    boxJumper.step({ jump: true });
    const afterBoxJump = boxJumper.worldPosition(boxJumperNode);
    assert.ok(
      Math.abs(afterBoxJump.x - beforeBoxJump.x) < 0.01,
      'An AABB player must detach instead of being carried when jumping.',
    );
    assert.ok(afterBoxJump.y > beforeBoxJump.y, 'The AABB player should still jump away from the platform.');

    const velocityPlayer = velocityRider.nodes.get('player')!,
      velocityPlatform = velocityRider.nodes.get('platform')!,
      initialOffset =
        velocityRider.worldPosition(velocityPlayer).x - velocityRider.worldPosition(velocityPlatform).x;
    for (let frame = 0; frame < 30; frame++) velocityRider.step({});
    const finalOffset =
      velocityRider.worldPosition(velocityPlayer).x - velocityRider.worldPosition(velocityPlatform).x;
    assert.ok(
      Math.abs(finalOffset - initialOffset) < 0.05,
      `Expected the player to stay aboard a velocity-driven platform, offset changed ${initialOffset} → ${finalOffset}.`,
    );

    const boxPlayer = boxVelocityRider.nodes.get('player')!,
      boxPlatform = boxVelocityRider.nodes.get('platform')!,
      initialBoxOffset =
        boxVelocityRider.worldPosition(boxPlayer).x - boxVelocityRider.worldPosition(boxPlatform).x;
    for (let frame = 0; frame < 30; frame++) boxVelocityRider.step({});
    const finalBoxOffset =
      boxVelocityRider.worldPosition(boxPlayer).x - boxVelocityRider.worldPosition(boxPlatform).x;
    assert.ok(
      Math.abs(finalBoxOffset - initialBoxOffset) < 0.05,
      `Expected the AABB player to stay aboard, offset changed ${initialBoxOffset} → ${finalBoxOffset}.`,
    );
  } finally {
    rider.dispose();
    jumper.dispose();
    descending.dispose();
    boxRider.dispose();
    boxDescending.dispose();
    boxJumper.dispose();
    parentedRider.dispose();
    velocityRider.dispose();
    boxVelocityRider.dispose();
  }
});

test('grounded capsule riders follow kinematic platform rotation without duplicate carry', async () => {
  const project = terrainPlayerProject(null, [1, 4, 0]),
    player = project.scenes[0]!.nodes[0]!;
  player.components = player.components.map((component) =>
    component.type === 'collider' ? { ...component, shape: 'capsule', size: [0.5, 1, 0.5] } : component,
  );
  project.scenes[0]!.nodes.push(
    nodeSchema.parse({
      id: 'platform',
      name: 'Rotating platform',
      transform: { position: [0, 3.75, 0] },
      components: [
        { type: 'collider', size: [4, 0.5, 1], solid: true },
        { type: 'rigid-body', bodyType: 'kinematic-position', gravity: 0, velocity: [0, 0, 0] },
      ],
    }),
  );
  const simulation = new GameSimulation(validateProject(project));
  try {
    await simulation.ready;
    for (let frame = 0; frame < 6; frame++) simulation.step({});
    const rider = simulation.nodes.get('player')!,
      platform = simulation.nodes.get('platform')!,
      before = simulation.worldPosition(rider).clone();

    platform.transform.rotation[1] = Math.PI / 2;
    simulation.step({});
    const carried = simulation.worldPosition(rider).clone();
    assert.ok(
      carried.z < -0.9,
      `Expected rotation to carry the rider around the platform, got z=${carried.z}.`,
    );
    assert.ok(
      Math.abs(carried.x) < 0.1,
      `Expected the rider to rotate around the platform center, got x=${carried.x}.`,
    );
    assert.ok(
      Math.abs(carried.y - before.y) < 0.02,
      'A horizontal platform turn should preserve rider height.',
    );

    simulation.step({});
    const settled = simulation.worldPosition(rider);
    assert.ok(settled.distanceTo(carried) < 0.02, 'A platform rotation must not be applied twice.');
  } finally {
    simulation.dispose();
  }
});

test('grounded AABB riders follow kinematic platform rotation', async () => {
  const project = terrainPlayerProject(null, [1, 4, 0]);
  project.scenes[0]!.nodes.push(
    nodeSchema.parse({
      id: 'platform',
      name: 'Rotating platform',
      transform: { position: [0, 3.75, 0] },
      components: [
        { type: 'collider', size: [4, 0.5, 1], solid: true },
        { type: 'rigid-body', bodyType: 'kinematic-position', gravity: 0, velocity: [0, 0, 0] },
      ],
    }),
  );
  const simulation = new GameSimulation(validateProject(project));
  try {
    await simulation.ready;
    for (let frame = 0; frame < 6; frame++) simulation.step({});
    const rider = simulation.nodes.get('player')!,
      platform = simulation.nodes.get('platform')!;
    platform.transform.rotation[1] = Math.PI / 2;
    simulation.step({});
    const carried = simulation.worldPosition(rider);
    assert.ok(carried.z < -0.9, `Expected AABB rotation carry, got z=${carried.z}.`);
    assert.ok(
      Math.abs(carried.x) < 0.1,
      `Expected the rider to rotate around the platform center, got x=${carried.x}.`,
    );
    assert.ok(Math.abs(carried.y - 4) < 0.02, 'A horizontal platform turn should preserve rider height.');
  } finally {
    simulation.dispose();
  }
});

test('grounded legacy and explicit-shape riders follow kinematic platform tilt', async () => {
  for (const shape of ['legacy', 'box', 'sphere', 'capsule'] as const) {
    const project = terrainPlayerProject(null, [0.5, 4, 0]);
    const player = project.scenes[0]!.nodes[0]!;
    player.components = player.components.map((entry) =>
      entry.type === 'collider'
        ? shape === 'legacy'
          ? entry
          : shape === 'box'
            ? { ...entry, shape }
            : { ...entry, shape, size: [0.5, 1, 0.5] }
        : entry,
    );
    project.scenes[0]!.nodes.push(
      nodeSchema.parse({
        id: 'platform',
        name: 'Tilting platform',
        transform: { position: [0, 3.75, 0] },
        components: [
          { type: 'collider', size: [4, 0.5, 4], solid: true },
          { type: 'rigid-body', bodyType: 'kinematic-position', gravity: 0, velocity: [0, 0, 0] },
        ],
      }),
    );
    const simulation = new GameSimulation(validateProject(project));
    try {
      await simulation.ready;
      for (let frame = 0; frame < 6; frame++) simulation.step({});
      const rider = simulation.nodes.get('player')!,
        platform = simulation.nodes.get('platform')!;
      platform.transform.rotation[2] = Math.PI / 6;
      simulation.step({});

      const expected = new THREE.Vector3(0.5, 0.75, 0)
          .applyEuler(new THREE.Euler(...platform.transform.rotation))
          .add(simulation.worldPosition(platform))
          .sub(new THREE.Vector3(0, 0.5, 0)),
        carried = simulation.worldPosition(rider);
      assert.ok(
        carried.distanceTo(expected) < 0.05 && carried.x < 0.5 && carried.y > 4,
        `The ${shape} rider should follow platform pitch/roll: got ${carried.toArray()}, expected ${expected.toArray()}.`,
      );
      simulation.step({});
      const settled = simulation.worldPosition(rider);
      assert.ok(
        settled.distanceTo(carried) < 0.065,
        `The ${shape} rider should settle without applying platform tilt twice: ${carried.toArray()} → ${settled.toArray()}.`,
      );
    } finally {
      simulation.dispose();
    }
  }
});

test('grounded capsule and AABB riders follow dynamic and kinematic-velocity platform rotation', async () => {
  for (const bodyType of ['dynamic', 'kinematic-velocity'] as const)
    for (const shape of ['aabb', 'capsule'] as const) {
      const project = terrainPlayerProject(null, [1, 4, 0]);
      if (shape === 'capsule') {
        const player = project.scenes[0]!.nodes[0]!;
        player.components = player.components.map((entry) =>
          entry.type === 'collider' ? { ...entry, shape: 'capsule', size: [0.5, 1, 0.5] } : entry,
        );
      }
      project.scenes[0]!.nodes.push(
        nodeSchema.parse({
          id: 'platform',
          name: 'Physics-driven rotating platform',
          transform: { position: [0, 3.75, 0] },
          components: [
            { type: 'collider', size: [4, 0.5, 1], solid: true },
            {
              type: 'rigid-body',
              bodyType,
              gravity: 0,
              linearDamping: 0,
              angularDamping: 0,
              velocity: [0, 0, 0],
              angularVelocity: [0, Math.PI / 2 / (6 / 60) / 4, 0],
              canSleep: false,
            },
          ],
        }),
      );
      const simulation = new GameSimulation(validateProject(project));
      try {
        await simulation.ready;
        for (let frame = 0; frame < 14; frame++) simulation.step({});
        const rider = simulation.worldPosition(simulation.nodes.get('player')!),
          platform = simulation.nodes.get('platform')!,
          rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...platform.transform.rotation)),
          expected = new THREE.Vector3(1, 0.25, 0)
            .applyQuaternion(rotation)
            .add(simulation.worldPosition(platform));
        assert.ok(Math.abs(platform.transform.rotation[1]) > 0.5, 'The physics body must rotate visibly.');
        assert.ok(
          rider.distanceTo(expected) < 0.2,
          `A ${shape} rider should follow the ${bodyType} platform turn: got ${rider.toArray()}, expected ${expected.toArray()}.`,
        );
      } finally {
        simulation.dispose();
      }
    }
});

test('grounded legacy AABB and explicit-shape riders follow dynamic and kinematic-velocity platform tilt', async () => {
  for (const bodyType of ['dynamic', 'kinematic-velocity'] as const)
    for (const shape of ['legacy', 'box', 'sphere', 'capsule'] as const) {
      const project = terrainPlayerProject(null, [0.5, 4, 0]);
      if (shape !== 'legacy')
        project.scenes[0]!.nodes[0]!.components = project.scenes[0]!.nodes[0]!.components.map((entry) =>
          entry.type === 'collider' ? { ...entry, shape, size: [0.5, 1, 0.5] } : entry,
        );
      project.scenes[0]!.nodes.push(
        nodeSchema.parse({
          id: 'platform',
          name: 'Physics-driven tilting platform',
          transform: { position: [0, 3.75, 0] },
          components: [
            { type: 'collider', size: [4, 0.5, 4], solid: true },
            {
              type: 'rigid-body',
              bodyType,
              gravity: 0,
              linearDamping: 0,
              angularDamping: 0,
              velocity: [0, 0, 0],
              angularVelocity: [0, 0, 2.244],
              canSleep: false,
            },
          ],
        }),
      );
      const simulation = new GameSimulation(validateProject(project));
      try {
        await simulation.ready;
        for (let frame = 0; frame < 14; frame++) simulation.step({});
        const rider = simulation.worldPosition(simulation.nodes.get('player')!),
          platform = simulation.nodes.get('platform')!,
          rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...platform.transform.rotation)),
          expected = new THREE.Vector3(0.5, 0.75, 0)
            .applyQuaternion(rotation)
            .add(simulation.worldPosition(platform))
            .sub(new THREE.Vector3(0, 0.5, 0));
        assert.ok(Math.abs(platform.transform.rotation[2]) > 0.2, 'The platform must visibly tilt.');
        assert.ok(
          rider.distanceTo(expected) < 0.12,
          `A ${shape} rider should follow the ${bodyType} platform tilt: got ${rider.toArray()}, expected ${expected.toArray()}.`,
        );
        simulation.step({});
        assert.ok(
          simulation.worldPosition(simulation.nodes.get('player')!).distanceTo(rider) < 0.06,
          `A ${shape} rider should not receive the same ${bodyType} platform tilt twice.`,
        );
      } finally {
        simulation.dispose();
      }
    }
});

test('parented players face along world-space movement', () => {
  const project = terrainPlayerProject(null, [0, 0, 0]);
  project.scenes[0].nodes[0]!.parentId = 'rotated-parent';
  project.scenes[0].nodes.push({
    id: 'rotated-parent',
    name: 'Rotated parent',
    assetId: null,
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
    enabled: true,
    components: [],
    attachments: [],
  });
  const simulation = new GameSimulation(validateProject(project));
  simulation.step({ moveX: 1 });

  const player = simulation.nodes.get('player')!,
    forward = new THREE.Vector3(0, 0, -1).transformDirection(simulation.worldMatrix(player));
  assert.ok(simulation.worldPosition(player).x > 0, 'The player moves along the world X axis.');
  assert.ok(
    forward.x > 0.99 && Math.abs(forward.z) < 0.01,
    `Expected world +X facing, got ${forward.toArray()}.`,
  );
});

test('voxel3d player collision follows edited cave openings and the voxel floor', () => {
  const world = voxelCaveWorld();
  const simulation = new GameSimulation(terrainPlayerProject(world, [0, 4, 3]));
  const landed = settlePlayer(simulation);
  assert.ok(Math.abs(landed.y + 1.75) < 0.01, `Expected the cave floor at -1.75m, got ${landed.y}.`);

  for (let i = 0; i < 24; i++) simulation.step({ moveZ: -1 });
  const walkedIn = simulation.worldPosition(simulation.nodes.get('player')!);
  assert.ok(
    walkedIn.z < 2,
    `Expected the player to walk from the entrance into the cave, got z=${walkedIn.z}.`,
  );
  assert.ok(walkedIn.y < 0, `Expected cave traversal below the heightfield surface, got y=${walkedIn.y}.`);
});

test('Play terrain cell edits change voxel collision immediately and stay off the source project', () => {
  const world = terrainWorld();
  world.generator = { ...world.generator, mode: 'voxel3d' };
  const project = terrainPlayerProject(world, [0, 12, 0]),
    simulation = new GameSimulation(project),
    player = simulation.nodes.get('player')!;
  player.transform.position = [1.5, 12, 1.5];
  assert.ok(Math.abs(settlePlayer(simulation).y - 1.75) < 0.01);

  assert.ok(simulation.editTerrain({ x: 3, y: 3, z: 3, value: null }));
  player.transform.position = [1.5, 12, 1.5];
  simulation.velocities.delete('player');
  assert.ok(Math.abs(settlePlayer(simulation).y - 1.25) < 0.01);

  assert.equal(simulation.editTerrain({ x: 3, y: 3, z: 3, value: null }), null);
  assert.equal(simulation.editTerrain({ x: 20, y: 3, z: 0, value: null }), null);
  assert.ok(
    simulation.editTerrain({
      x: 3,
      y: 3,
      z: 3,
      value: { color: 0x55aa55, materialType: 'STANDARD' },
    }),
  );
  player.transform.position = [1.5, 12, 1.5];
  simulation.velocities.delete('player');
  assert.ok(Math.abs(settlePlayer(simulation).y - 1.75) < 0.01);
  assert.equal(project.worlds[0].edits.length, 0);
  simulation.dispose();
});

test('voxel3d rigid bodies fall through edited cave openings and land on voxel occupancy', async () => {
  const project = rigidBodyProject([0, 0, 0], [0, 4, 3], 18, 0);
  const world = voxelCaveWorld();
  project.worlds = [world];
  project.scenes[0].worldId = world.id;
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  for (let i = 0; i < 180; i++) simulation.step();
  const position = simulation.worldPosition(simulation.nodes.get('body')!);
  assert.ok(
    Math.abs(position.y + 1.75) < 0.01,
    `Expected the body to land on the cave floor at -1.75m, got ${position.y}.`,
  );
  simulation.dispose();
});

test('voxel3d rigid bodies stop against solid cave walls', async () => {
  const project = rigidBodyProject([8, 0, 0], [0, -1.75, 3], 0, 0);
  const world = voxelCaveWorld();
  project.worlds = [world];
  project.scenes[0].worldId = world.id;
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  for (let i = 0; i < 12; i++) simulation.step();
  const position = simulation.worldPosition(simulation.nodes.get('body')!);
  assert.ok(position.x > 0.1, `Expected the body to move inside the cave, got x=${position.x}.`);
  assert.ok(position.x <= 0.251, `Expected the voxel wall at x=0.75m to stop the body, got x=${position.x}.`);
  simulation.dispose();
});

test('rigid bodies fall onto the default floor and bounce with configured restitution', async () => {
  const falling = new GameSimulation(rigidBodyProject());
  await falling.ready;
  for (let i = 0; i < 60; i++) falling.step();
  assert.ok(Math.abs(falling.worldPosition(falling.nodes.get('body')!).y) < 0.001);

  const bouncing = new GameSimulation(rigidBodyProject([0, 0, 0], [0, 3, 0], 18, 0.8));
  await bouncing.ready;
  let bouncePeak = 0;
  for (let i = 0; i < 65; i++) {
    bouncing.step();
    if (i > 30) bouncePeak = Math.max(bouncePeak, bouncing.worldPosition(bouncing.nodes.get('body')!).y);
  }
  assert.ok(bouncePeak > 1, `Expected a visible bounce, got a peak of ${bouncePeak}m.`);
  falling.dispose();
  bouncing.dispose();
});

test('rigid bodies stop at authored solid colliders without changing actor motion rules', async () => {
  const wall = {
    id: 'wall',
    name: 'Wall',
    assetId: null,
    parentId: null,
    transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components: [{ type: 'collider', size: [1, 2, 1], offset: [0, 1, 0], solid: true }],
    attachments: [],
  };
  const simulation = new GameSimulation(rigidBodyProject([8, 0, 0], [0, 0, 0], 0, 0, [wall]));
  await simulation.ready;
  for (let i = 0; i < 30; i++) simulation.step();
  assert.ok(simulation.worldPosition(simulation.nodes.get('body')!).x <= 1.001);
  assert.equal(simulation.status, 'playing');
  simulation.dispose();
});

test('simulation steps issued during Rapier startup replay once initialization finishes', async () => {
  const simulation = new GameSimulation(rigidBodyProject([0, 0, 0], [0, 4, 0], 18, 0));
  for (let i = 0; i < 30; i++) simulation.step();
  await simulation.ready;
  assert.equal(simulation.frame, 30);
  assert.ok(simulation.worldPosition(simulation.nodes.get('body')!).y < 3.5);
  simulation.dispose();
});

test('disposing a simulation before physics startup avoids building an unused Rapier world', async () => {
  const { RapierPhysics } = await import('../runtime/RapierPhysics');
  const create = RapierPhysics.create;
  let builds = 0;
  RapierPhysics.create = async (...args: Parameters<typeof create>) => {
    builds++;
    return create(...args);
  };
  try {
    const simulation = new GameSimulation(rigidBodyProject([0, 0, 0], [0, 4, 0], 18, 0));
    simulation.dispose();
    await simulation.ready;
    assert.equal(builds, 0);
  } finally {
    RapierPhysics.create = create;
  }
});

test('Rapier resolves a stable stack between authored rigid bodies and a solid scene collider', async () => {
  const makeNode = (
    id: string,
    position: [number, number, number],
    size: [number, number, number],
    dynamic = false,
  ): SceneNode => {
    const components: Component[] = [
      { type: 'collider', size, offset: [0, 0, 0], solid: true, shape: 'box', friction: 0.8, restitution: 0 },
      ...(dynamic
        ? [
            {
              type: 'rigid-body',
              bodyType: 'dynamic',
              mass: 1,
              gravity: 9.81,
              linearDamping: 0,
              restitution: 0,
              velocity: [0, 0, 0],
              canSleep: false,
              lockRotation: true,
            } as Extract<Component, { type: 'rigid-body' }>,
          ]
        : []),
    ];
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
  };
  const project = rigidBodyProject();
  project.scenes[0].nodes = [
    makeNode('floor', [0, -0.5, 0], [8, 1, 8]),
    makeNode('lower', [0, 3, 0], [1, 1, 1], true),
    makeNode('upper', [0, 5, 0], [1, 1, 1], true),
  ];
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  for (let i = 0; i < 240; i++) simulation.step();
  const lower = simulation.worldPosition(simulation.nodes.get('lower')!),
    upper = simulation.worldPosition(simulation.nodes.get('upper')!);
  assert.ok(
    Math.abs(lower.y - 0.5) < 0.04,
    `Expected bottom box on the solid floor at y=0.5, got ${lower.y}.`,
  );
  assert.ok(
    Math.abs(upper.y - 1.5) < 0.04,
    `Expected upper box on the dynamic body at y=1.5, got ${upper.y}.`,
  );
  assert.ok(upper.y > lower.y + 0.95, 'The dynamic bodies must remain in contact without overlap.');
  simulation.dispose();
});

test('Rapier sensor rules dispatch collision and separation to both participating nodes', async () => {
  const project = newProject('sensor-events', 'Sensor events');
  project.scenes[0].variables = { sensorEntered: 0, bodyEntered: 0, bodyLeft: 0, wallHit: 0 };
  project.scenes[0].nodes = [
    {
      id: 'trigger',
      name: 'Trigger',
      assetId: null,
      parentId: null,
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [1, 10, 2], offset: [0, 0, 0], solid: false, sensor: true },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'collision',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'sensorEntered', value: 1 }],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'wall',
      name: 'Wall',
      assetId: null,
      parentId: null,
      transform: { position: [2, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [0.25, 4, 2], offset: [0, 0, 0], solid: true },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'collision',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'wallHit', value: 1 }],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'mover',
      name: 'Mover',
      assetId: null,
      parentId: null,
      transform: { position: [-2, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0, 0], solid: true },
        {
          type: 'rigid-body',
          bodyType: 'dynamic',
          mass: 1,
          gravity: 0,
          linearDamping: 0,
          angularDamping: 0,
          restitution: 0,
          velocity: [5, 0, 0],
          angularVelocity: [0, 0, 0],
          canSleep: false,
          lockRotation: true,
        },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'collision',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'bodyEntered', value: 1 }],
            },
            {
              event: 'separation',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'bodyLeft', value: 1 }],
            },
          ],
        },
      ],
      attachments: [],
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  for (let i = 0; i < 10; i++) simulation.step({}, 0.1);
  assert.equal(simulation.variables.sensorEntered, 1);
  assert.equal(simulation.variables.bodyEntered, 2);
  assert.equal(simulation.variables.bodyLeft, 1);
  assert.equal(simulation.variables.wallHit, 1);
  assert.ok(
    simulation.events.some(
      (event) =>
        event.type === 'collision' &&
        event.nodeId === 'trigger' &&
        (event.data as { otherNodeId?: string }).otherNodeId === 'mover',
    ),
  );
  assert.ok(simulation.events.some((event) => event.type === 'separation' && event.nodeId === 'mover'));
  simulation.dispose();
});

test('collision and separation actions can damage, heal, teleport, and destroy the counterpart', async () => {
  const project = newProject('collision-counterpart', 'Collision counterpart');
  project.scenes[0].nodes = [
    {
      id: 'trigger',
      name: 'Trigger',
      assetId: null,
      parentId: null,
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [2, 2, 2], offset: [0, 0, 0], solid: false, sensor: true },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'collision',
              interval: 1,
              once: false,
              actions: [
                { type: 'damage', target: COLLISION_OTHER_TARGET, amount: 20 },
                { type: 'heal', target: COLLISION_OTHER_TARGET, amount: 5 },
                { type: 'teleport', target: COLLISION_OTHER_TARGET, position: [4, 2, 0] },
              ],
            },
            {
              event: 'separation',
              interval: 1,
              once: false,
              actions: [{ type: 'destroy', target: COLLISION_OTHER_TARGET }],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'mover',
      name: 'Mover',
      assetId: null,
      parentId: null,
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0, 0], solid: true },
        {
          type: 'rigid-body',
          bodyType: 'dynamic',
          mass: 1,
          gravity: 0,
          linearDamping: 0,
          angularDamping: 0,
          restitution: 0,
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          canSleep: false,
          lockRotation: true,
        },
        { type: 'health', maximum: 100 },
      ],
      attachments: [],
    },
  ];

  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  simulation.step({}, 0.1);
  assert.equal(simulation.health.mover, 85);
  assert.deepEqual(simulation.nodes.get('mover')?.transform.position, [4, 2, 0]);
  assert.ok(simulation.events.some((event) => event.type === 'damage' && event.nodeId === 'mover'));
  assert.ok(simulation.events.some((event) => event.type === 'healed' && event.nodeId === 'mover'));

  simulation.step({}, 0.1);
  assert.equal(simulation.nodes.get('mover')?.enabled, false);
  assert.ok(simulation.events.some((event) => event.type === 'destroyed' && event.nodeId === 'mover'));
  simulation.dispose();
});

test('dynamic sensor rigid bodies move through colliders and run entry and exit rules', async () => {
  const project = newProject('moving-sensor', 'Moving sensor');
  project.scenes[0].variables = { entered: 0, left: 0 };
  project.scenes[0].nodes = [
    {
      id: 'sensor',
      name: 'Moving sensor',
      assetId: null,
      parentId: null,
      transform: { position: [-2, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0, 0], solid: false, sensor: true },
        {
          type: 'rigid-body',
          bodyType: 'dynamic',
          mass: 1,
          gravity: 0,
          linearDamping: 0,
          angularDamping: 0,
          restitution: 0,
          velocity: [5, 0, 0],
          angularVelocity: [0, 0, 0],
          canSleep: false,
          lockRotation: true,
        },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'collision',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'entered', value: 1 }],
            },
            {
              event: 'separation',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'left', value: 1 }],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'target',
      name: 'Static target',
      assetId: null,
      parentId: null,
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [{ type: 'collider', size: [1, 2, 2], offset: [0, 0, 0], solid: true }],
      attachments: [],
    },
  ];
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  for (let i = 0; i < 10; i++) simulation.step({}, 0.1);
  assert.equal(simulation.variables.entered, 1);
  assert.equal(simulation.variables.left, 1);
  assert.ok(simulation.worldPosition(simulation.nodes.get('sensor')!).x > 2.5);
  simulation.dispose();
});

test('kinematic actors trigger sensor entry and exit gameplay rules', async () => {
  const project = newProject('kinematic-sensor-rules', 'Kinematic sensor rules');
  project.scenes[0].variables = { entered: 0, left: 0 };
  project.scenes[0].nodes = [
    {
      id: 'sensor',
      name: 'Trigger zone',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [1, 2, 2], offset: [0, 0, 0], solid: false, sensor: true },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'collision',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'entered', value: 1 }],
            },
            {
              event: 'separation',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'left', value: 1 }],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'mover',
      name: 'Kinematic actor',
      assetId: null,
      parentId: null,
      transform: { position: [-2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0, 0], solid: true },
        {
          type: 'rigid-body',
          bodyType: 'kinematic-position',
          gravity: 18,
          linearDamping: 0,
          restitution: 0,
          velocity: [0, 0, 0],
        },
      ],
      attachments: [],
    },
  ];

  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  const mover = simulation.nodes.get('mover')!;
  for (let step = 0; step < 7; step++) {
    mover.transform.position[0] += 0.5;
    simulation.step({}, 0.1);
  }

  assert.equal(simulation.variables.entered, 1);
  assert.equal(simulation.variables.left, 1);
  assert.ok(simulation.events.some((event) => event.type === 'collision' && event.nodeId === 'sensor'));
  assert.ok(simulation.events.some((event) => event.type === 'separation' && event.nodeId === 'sensor'));
  simulation.dispose();
});

test('Rapier CCD keeps a high-speed authored rigid body from tunneling through a thin scene wall', async () => {
  const project = rigidBodyProject([100, 0, 0], [-2, 2, 0], 0, 0, [
    {
      id: 'wall',
      name: 'Thin wall',
      assetId: null,
      parentId: null,
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [{ type: 'collider', size: [0.05, 4, 4], offset: [0, 0, 0], solid: true }],
      attachments: [],
    },
  ]);
  const body = project.scenes[0].nodes.find((node) => node.id === 'body')!;
  const rigidBody = body.components.find((component) => component.type === 'rigid-body');
  assert.equal(rigidBody?.type, 'rigid-body');
  if (rigidBody?.type !== 'rigid-body') throw new Error('Expected a rigid-body component.');
  rigidBody.ccd = true;
  const simulation = new GameSimulation(validateProject(project));
  await simulation.ready;
  simulation.step({}, 0.05);
  const position = simulation.worldPosition(simulation.nodes.get('body')!).x;
  assert.ok(position < -0.05, `CCD body crossed the wall; x=${position}.`);
  simulation.dispose();
});

test('single-file game export includes Rapier Apache terms in its third-party notices', () => {
  const html = renderGameHtml(
    rigidBodyProject(),
    'main',
    'window.runtimeReady = true;',
    'Three.js test notice',
  );
  assert.ok(html.includes('id="third-party-notices"'));
  assert.ok(html.includes('Rapier 3D compatibility build 0.21.0 (Apache-2.0)'));
  assert.ok(html.includes('Apache License'));
  assert.ok(html.includes('Version 2.0, January 2004'));
  assert.ok(html.includes('window.runtimeReady = true;'));
  assert.doesNotMatch(html, /<script\s+src=/i);
  assert.doesNotMatch(html, /<link\b[^>]*href=/i);
});

test('terrain collision follows seeded mountain heights at the persisted voxel spacing', () => {
  const world = terrainWorld();
  world.voxelSize = 0.25;
  world.generator = { ...world.generator, baseHeight: 8, amplitude: 12, noise: 1 };
  const sample = createTerrainNoise(world.seed);
  const candidates = Array.from({ length: 21 * 21 }, (_, index) => {
    const x = (index % 21) - 10;
    const z = Math.floor(index / 21) - 10;
    return {
      x,
      z,
      surface: Math.max(
        world.generator.minY,
        Math.min(
          world.generator.maxY,
          Math.floor(world.generator.baseHeight + sample(x, z) * world.generator.amplitude),
        ),
      ),
    };
  });
  const low = candidates.reduce((best, item) => (item.surface < best.surface ? item : best));
  const high = candidates.reduce((best, item) => (item.surface > best.surface ? item : best));
  assert.ok(high.surface - low.surface >= 3, 'The seeded fixture should include distinct mountain heights.');

  const lowPosition = settlePlayer(
    new GameSimulation(terrainPlayerProject(world, [low.x * world.voxelSize, 30, low.z * world.voxelSize])),
  );
  const highPosition = settlePlayer(
    new GameSimulation(terrainPlayerProject(world, [high.x * world.voxelSize, 30, high.z * world.voxelSize])),
  );
  assert.ok(Math.abs(lowPosition.y - (low.surface + 0.5) * world.voxelSize) < 0.01);
  assert.ok(Math.abs(highPosition.y - (high.surface + 0.5) * world.voxelSize) < 0.01);
  assert.ok(highPosition.y > lowPosition.y + 1);
});

test('capsule players climb a seeded gentle terrain slope one voxel step at a time', async () => {
  const world = terrainWorld();
  world.voxelSize = 0.5;
  world.generator = { ...world.generator, baseHeight: 8, amplitude: 12, noise: 1 };
  const surfaceAt = createTerrainSurfaceSampler(world),
    z = -12,
    startX = -10,
    endX = -3,
    heights = Array.from({ length: endX - startX + 1 }, (_, index) => surfaceAt(startX + index, z));
  assert.deepEqual(heights, [9, 9, 10, 9, 9, 9, 10, 11]);

  const project = terrainPlayerProject(world, [-5, 20, z * world.voxelSize]);
  project.scenes[0]!.nodes[0]!.components = project.scenes[0]!.nodes[0]!.components.map((component) =>
    component.type === 'player'
      ? { ...component, stepHeight: world.voxelSize, maxSlopeAngle: 45 }
      : component.type === 'collider'
        ? { ...component, shape: 'capsule', size: [0.2, 1, 0.2] }
        : component,
  );

  const simulation = new GameSimulation(validateProject(project));
  try {
    await simulation.ready;
    const settled = settlePlayer(simulation);
    const expectedStartY = (heights[0]! + 0.5) * world.voxelSize;
    assert.ok(
      Math.abs(settled.y - expectedStartY) <= world.voxelSize * 0.5,
      `Expected the capsule to land within half a terrain cell of ${expectedStartY}, got ${settled.toArray()}.`,
    );

    for (let frame = 0; frame < 70; frame++) simulation.step({ moveX: 1 });
    const climbed = simulation.worldPosition(simulation.nodes.get('player')!);
    assert.ok(
      climbed.x > endX * world.voxelSize - 0.1,
      `Expected the capsule to cross the slope, got x=${climbed.x}.`,
    );
    assert.ok(
      Math.abs(climbed.y - (heights.at(-1)! + 0.5) * world.voxelSize) <= world.voxelSize * 0.5,
      `Expected the capsule to reach within half a terrain cell of the far slope height, got y=${climbed.y}.`,
    );
  } finally {
    simulation.dispose();
  }
});

test('capsule players traverse generated triangle slopes without autostep', async () => {
  const world = terrainWorld();
  world.voxelSize = 0.5;
  world.generator = { ...world.generator, baseHeight: 8, amplitude: 12, noise: 1 };
  const surfaceAt = createTerrainSurfaceSampler(world),
    z = -10,
    startX = -10,
    endX = -3,
    heights = Array.from({ length: endX - startX + 1 }, (_, index) => surfaceAt(startX + index, z));
  assert.deepEqual(heights, [9, 9, 9, 10, 10, 10, 11, 12]);

  const project = terrainPlayerProject(world, [-5, 8, -5]);
  project.scenes[0]!.nodes[0]!.components = project.scenes[0]!.nodes[0]!.components.map((component) =>
    component.type === 'player'
      ? { ...component, stepHeight: 0, maxSlopeAngle: 80 }
      : component.type === 'collider'
        ? { ...component, shape: 'capsule', size: [0.2, 1, 0.2] }
        : component,
  );

  const simulation = new GameSimulation(validateProject(project));
  try {
    await simulation.ready;
    simulation.step();
    const settled = settlePlayer(simulation);
    assert.ok(
      settled.y > 4.5 && settled.y < 5.5,
      `Expected the capsule to settle on the smoothed generated surface, got ${settled.toArray()}.`,
    );

    for (let frame = 0; frame < 90; frame++) simulation.step({ moveX: 1 });
    const climbed = simulation.worldPosition(simulation.nodes.get('player')!);
    assert.ok(
      climbed.x > endX * world.voxelSize - 0.1,
      `Expected the capsule to cross the generated triangle slope without stepping, got x=${climbed.x}.`,
    );
    assert.ok(
      climbed.y > settled.y + 0.5,
      `Expected the capsule to climb the generated triangle slope, got y=${climbed.y} from ${settled.y}.`,
    );
  } finally {
    simulation.dispose();
  }
});

test('large heightfield colliders scan the finite world and land on raised sparse edits', () => {
  const world = terrainWorld();
  world.generator = { ...world.generator, baseHeight: 0, amplitude: 0 };
  world.edits = [{ x: 10, y: 12, z: 10, value: { color: 0x44aa55, materialType: 'STANDARD' } }];
  const project = terrainPlayerProject(world, [0, 20, 0]);
  const collider = project.scenes[0].nodes[0].components.find((component) => component.type === 'collider');
  assert.equal(collider?.type, 'collider');
  if (collider?.type !== 'collider') throw new Error('Expected the player collider.');
  collider.size = [64, 1, 64];

  const landed = settlePlayer(new GameSimulation(project));
  assert.ok(
    Math.abs(landed.y - 6.25) < 0.01,
    `Expected the wide collider to land on the raised column at 6.25m, got ${landed.y}.`,
  );
});

test('version-1 worlds without landform scale keep their original persisted surface heights', () => {
  const world = terrainWorld();
  world.generator = { ...world.generator, baseHeight: 8, amplitude: 12, noise: 1 };
  const oldNoise = createTerrainNoise(world.seed);
  const surfaceAt = createTerrainSurfaceSampler(world);
  const chunks = createWorldChunkStore(world);
  for (const [x, z] of [
    [-15, -11],
    [-1, 0],
    [0, 0],
    [13, 14],
  ]) {
    const expected = Math.max(
      world.generator.minY,
      Math.min(
        world.generator.maxY,
        Math.floor(world.generator.baseHeight + oldNoise(x, z) * world.generator.amplitude),
      ),
    );
    assert.equal(surfaceAt(x, z), expected);
    assert.equal(chunks.get({ x, y: expected, z })?.color, world.generator.palette.surface);
    assert.equal(chunks.get({ x, y: expected + 1, z }), undefined);
  }
});

test('meter-based landform scale smooths new terrain and matches persistence and runtime', () => {
  const world = terrainWorld();
  world.voxelSize = 0.5;
  world.generator = {
    ...world.generator,
    origin: [-128, -128],
    size: [256, 256],
    minY: -32,
    maxY: 32,
    baseHeight: 0,
    amplitude: 32,
    noise: 1,
    landformScale: 96,
  };
  const scaled = createTerrainSurfaceSampler(world);
  const legacy = createTerrainSurfaceSampler({
    ...world,
    generator: { ...world.generator, landformScale: undefined },
  });
  const roughness = (sample: (x: number, z: number) => number) => {
    let total = 0;
    for (let z = -80; z < 80; z++)
      for (let x = -80; x < 80; x++) total += Math.abs(sample(x + 1, z) - sample(x, z));
    return total;
  };
  assert.ok(roughness(scaled) < roughness(legacy) * 0.6);

  const cellX = 20,
    cellZ = -3,
    surface = scaled(cellX, cellZ),
    chunks = createWorldChunkStore(world);
  assert.equal(chunks.get({ x: cellX, y: surface, z: cellZ })?.color, world.generator.palette.surface);
  assert.equal(chunks.get({ x: cellX, y: surface + 1, z: cellZ }), undefined);
  const landed = settlePlayer(
    new GameSimulation(terrainPlayerProject(world, [cellX * world.voxelSize, 30, cellZ * world.voxelSize])),
  );
  assert.ok(Math.abs(landed.y - (surface + 0.5) * world.voxelSize) < 0.01);
});

test('sparse terrain placement raises the surface and a tombstone lowers it', () => {
  const removed = terrainWorld();
  removed.edits = [{ x: 0, y: 3, z: 0, value: null }];
  const placed = terrainWorld();
  placed.edits = [{ x: 0, y: 4, z: 0, value: { color: 0x44aa55, materialType: 'STANDARD' } }];

  const removedPosition = settlePlayer(new GameSimulation(terrainPlayerProject(removed, [0, 12, 0])));
  const placedPosition = settlePlayer(new GameSimulation(terrainPlayerProject(placed, [0, 12, 0])));
  assert.ok(Math.abs(removedPosition.y - 1.25) < 0.01);
  assert.ok(Math.abs(placedPosition.y - 2.25) < 0.01);
});

test('scenes without a selected world retain the legacy y=0 ground', () => {
  const simulation = new GameSimulation(terrainPlayerProject(null, [0, 0, 0]));
  for (let i = 0; i < 120; i++) simulation.step();
  assert.ok(Math.abs(simulation.worldPosition(simulation.nodes.get('player')!).y) < 1e-10);
});

test('240 Hz standalone simulation advances the same authored movement and elapsed time as 60 Hz', () => {
  const project = createExample('exploration', 'high-refresh'),
    standard = new GameSimulation(project),
    highRate = new GameSimulation(project);
  for (let i = 0; i < 60; i++) standard.step({ moveZ: -1 });
  for (let i = 0; i < 240; i++) highRate.step({ moveZ: -1 }, 1 / 240);
  const standardPlayer = standard.inspect().nodes.find((node) => node.id === 'player')!,
    highRatePlayer = highRate.inspect().nodes.find((node) => node.id === 'player')!;
  assert.ok(Math.abs(standardPlayer.position[0] - highRatePlayer.position[0]) < 0.05);
  assert.ok(Math.abs(standardPlayer.position[2] - highRatePlayer.position[2]) < 0.05);
  assert.ok(Math.abs(standard.inspect().seconds - 1) < 1e-12);
  assert.ok(Math.abs(highRate.inspect().seconds - 1) < 1e-12);
});
test('human, quadruped and machine bodies, fitted equipment, sockets and animation survive portable round trips', () => {
  let p = createExample('exploration', 'rig-test');
  p = applyProjectOperations(p, [
    { type: 'asset.character', id: 'biped', name: 'Biped', profile: 'biped' },
    { type: 'equipment.fit', bodyId: 'biped', id: 'biped-shell', name: 'Shell', kind: 'shell' },
    { type: 'asset.character', id: 'machine', name: 'Machine', profile: 'machine' },
  ]);
  const restored = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored, p);
  const hero = restored.scenes[0].nodes.find((n) => n.id === 'player')!;
  const visual = createNodeVisual(hero, new Map(restored.assets.map((a) => [a.id, a])));
  visual.animate('walk', 0.1);
  assert.ok(visual.bones.get('leg_left_front')!.rotation.x !== 0);
  let renderedMeshes = 0;
  visual.group.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) renderedMeshes++;
  });
  assert.ok(renderedMeshes > 1, 'The fitted wearable is included below its socket bone.');
  disposeObject(visual.group);
  assert.throws(
    () =>
      applyProjectOperations(p, [
        { type: 'node.put', sceneId: 'main', node: { ...hero, assetId: 'machine' } },
      ]),
    /different body/,
  );
});
test('generated walk cycles alternate biped limbs and use a diagonal quadruped gait', () => {
  const make = (profile: 'biped' | 'quadruped' | 'machine') =>
    generateCharacter({
      id: profile,
      name: profile,
      profile,
      height: 22,
      width: 10,
      color: 0x397965,
      accent: 0xf3c96b,
    });
  const [biped, quadruped, machine] = (['biped', 'quadruped', 'machine'] as const).map(make),
    midCycle = (asset: ReturnType<typeof generateCharacter>, joint: string) =>
      asset.rig!.clips.find((clip) => clip.name === 'walk')!.tracks.find((track) => track.joint === joint)!
        .keys[1].rotation[0];

  assert.ok(midCycle(biped, 'arm_left') < 0);
  assert.ok(midCycle(biped, 'leg_left') > 0);
  assert.ok(midCycle(biped, 'arm_right') > 0);
  assert.ok(midCycle(biped, 'leg_right') < 0);
  assert.ok(midCycle(machine, 'arm_left') * midCycle(machine, 'arm_right') < 0);
  assert.ok(midCycle(quadruped, 'leg_left_front') * midCycle(quadruped, 'leg_right_back') > 0);
  assert.ok(midCycle(quadruped, 'leg_left_back') * midCycle(quadruped, 'leg_right_front') > 0);
  assert.ok(midCycle(quadruped, 'leg_left_front') * midCycle(quadruped, 'leg_left_back') < 0);
  assert.ok(biped.rig!.clips.some((clip) => clip.name === 'run'));

  const joints = new Map(biped.rig!.joints.map((joint) => [joint.name, joint]));
  assert.equal(joints.get('forearm_left')?.parent, 'arm_left');
  assert.equal(joints.get('hand_left')?.parent, 'forearm_left');
  assert.equal(joints.get('knee_left')?.parent, 'leg_left');
  assert.equal(joints.get('foot_left')?.parent, 'knee_left');
  for (const name of ['forearm_left', 'hand_left', 'knee_left', 'foot_left'])
    assert.ok(
      biped.model.voxels.some((voxel) => voxel.bone === name),
      `${name} owns authored voxels`,
    );

  const visual = createAssetVisual(biped);
  visual.animate('walk', biped.rig!.clips.find((clip) => clip.name === 'walk')!.duration / 8);
  for (const name of ['forearm_left', 'knee_left', 'foot_left'])
    assert.notEqual(visual.bones.get(name)!.rotation.x, 0, `${name} moves in the generated walk cycle`);
  disposeObject(visual.group);
});
test('solid gates stop movement until their authored variable is satisfied; stopping a runtime leaves the project intact', () => {
  const p = createExample('exploration', 'collision');
  const sim = new GameSimulation(p);
  for (const n of sim.nodes.values()) if (sim.component(n, 'collectible')) n.enabled = false;
  for (let i = 0; i < 600; i++) sim.step({ moveZ: -1 });
  const pos = sim.worldPosition(sim.nodes.get('player')!);
  assert.ok(pos.z > -10);
  assert.equal(sim.status, 'playing');
  sim.variables.crystals = 5;
  for (let i = 0; i < 80; i++) sim.step({ moveZ: -1 });
  assert.equal(sim.status, 'won');
  assert.equal(p.scenes[0].variables.crystals, 0);
});

test('generated fitted equipment avoids coincident body faces and keeps the guard in front of the hand', () => {
  const p = createExample('arena', 'equipment-clearance');
  const body = p.assets.find((a) => a.id === 'hero')!,
    tool = p.assets.find((a) => a.id === 'tool')!;
  const arm = body.model.voxels.filter((v) => v.bone === 'arm_right');
  const socket = body.rig!.sockets.find((s) => s.name === 'hand')!;
  const guard = tool.model.voxels.filter((v) => v.color === 0x995a32);
  assert.ok(
    Math.max(...guard.map((v) => v.z + 0.5)) + socket.transform.position[2] <
      Math.min(...arm.map((v) => v.z - 0.5)),
  );
  const visual = createNodeVisual(p.scenes[0].nodes[0], new Map(p.assets.map((a) => [a.id, a])));
  visual.animate('idle', 0);
  visual.group.updateMatrixWorld(true);
  visual.group.traverse((o) => (o as THREE.SkinnedMesh).skeleton?.update());
  const faces = new Map<string, THREE.Object3D>();
  visual.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    const positions = mesh.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i += 4) {
      const corners = Array.from({ length: 4 }, (_, k) => {
        const point = new THREE.Vector3().fromBufferAttribute(positions, i + k);
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh)
          (mesh as THREE.SkinnedMesh).applyBoneTransform(i + k, point);
        return point.applyMatrix4(mesh.matrixWorld);
      });
      const box = new THREE.Box3().setFromPoints(corners);
      const key = [...box.min.toArray(), ...box.max.toArray()].map((n) => Math.round(n * 10000)).join(',');
      const previous = faces.get(key);
      assert.ok(
        !previous || previous === mesh,
        'Separate equipment meshes must not share an entire coincident body face.',
      );
      faces.set(key, mesh);
    }
  });
  disposeObject(visual.group);
});
test('legacy sculpt rigs convert into animated runtime joints without discarding authored keyframes', () => {
  const p = createExample('exploration', 'legacy-rig'),
    hero = p.assets.find((a) => a.id === 'hero')!;
  const model = createModelDocument(
    [{ x: 0, y: 0, z: 0, color: 0, bone: 'Torso', weights: [{ bone: 'Torso', weight: 1 }] }],
    HUMANOID_SKELETON,
  );
  const converted = sculptedAsset({ ...hero, rig: null }, model);
  assert.equal(converted.rig!.profile, 'humanoid');
  assert.ok(converted.rig!.clips.find((c) => c.name === 'Walk'));
  assert.ok(converted.rig!.clips.some((c) => c.tracks.some((t) => t.keys.some((k) => k.position))));
  validateProject({
    ...p,
    assets: [converted],
    scenes: [{ ...p.scenes[0], nodes: [] }],
    activeAssetId: null,
    editorDraft: null,
  });
});
test('animation markers run custom rules on the same fixed timeline as visual clips', () => {
  let p = createExample('exploration', 'markers');
  const n = p.scenes[0].nodes.find((n) => n.id === 'player')!;
  p = applyProjectOperations(p, [
    {
      type: 'node.put',
      sceneId: 'main',
      node: {
        ...n,
        components: [
          ...n.components,
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'animation',
                marker: 'footstep',
                actions: [{ type: 'add', variable: 'footsteps', value: 1 }],
              },
            ],
          },
        ],
      },
    },
  ]);
  const sim = new GameSimulation(p);
  for (let i = 0; i < 60; i++) sim.step({ moveZ: -1 });
  assert.ok(sim.variables.footsteps >= 2);
  assert.ok(sim.events.some((e) => e.type === 'animation'));
  assert.ok(sim.animationState('player')!.time > 0);
});
