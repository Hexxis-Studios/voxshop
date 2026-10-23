import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation } from '../runtime/GameSimulation';
import { changeInventory } from '../runtime/Inventory';
import { createExample } from '../services/examples';
import { newProject, validateProject } from '../services/projectDocument';

const ore = { id: 'ore', name: 'Ore', description: '', maxStack: 4 };
const wood = { id: 'wood', name: 'Wood', description: '', maxStack: 4 };
const bar = { id: 'bar', name: 'Bar', description: '', maxStack: 4 };
const token = { id: 'token', name: 'Token', description: '', maxStack: 1 };
const forge = {
  id: 'forge',
  name: 'Forge bar',
  ingredients: [{ itemId: 'ore', quantity: 1 }],
  outputs: [{ itemId: 'bar', quantity: 1 }],
};

function makeSimulation(
  actions: unknown[],
  options: { once?: boolean; condition?: unknown; slots?: number } = {},
) {
  const project = newProject('inventory-rules', 'Inventory rules');
  project.scenes[0].items = [ore, wood, bar, token];
  project.scenes[0].recipes = [forge];
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
        { type: 'inventory', slots: options.slots ?? 4 },
      ],
      attachments: [],
    },
    {
      id: 'target',
      name: 'Target',
      assetId: null,
      parentId: null,
      transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'interactable', prompt: 'Use', range: 3 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'interact',
              interval: 1,
              once: options.once ?? false,
              ...(options.condition ? { condition: options.condition } : {}),
              actions,
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'door',
      name: 'Door',
      assetId: null,
      parentId: null,
      transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: false,
      components: [],
      attachments: [],
    },
  ] as any;
  return new GameSimulation(validateProject(project));
}

function interact(simulation: GameSimulation) {
  simulation.step({ interact: true });
  simulation.step({ interact: false });
}

test('inventory actions give, consume and exchange items with visible change events', () => {
  const simulation = makeSimulation([
    { type: 'inventory', add: [{ itemId: 'token', quantity: 1 }] },
    { type: 'inventory', remove: [{ itemId: 'ore', quantity: 1 }] },
    {
      type: 'inventory',
      remove: [{ itemId: 'ore', quantity: 1 }],
      add: [{ itemId: 'bar', quantity: 1 }],
    },
  ]);
  simulation.inventory = [{ itemId: 'ore', quantity: 2 }];

  interact(simulation);

  assert.deepEqual(
    simulation.inventory.map(({ itemId, quantity }) => [itemId, quantity]),
    [
      ['token', 1],
      ['bar', 1],
    ],
  );
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'inventory-changed').map((event) => event.data),
    [
      { remove: [], add: [{ itemId: 'token', quantity: 1 }] },
      { remove: [{ itemId: 'ore', quantity: 1 }], add: [] },
      { remove: [{ itemId: 'ore', quantity: 1 }], add: [{ itemId: 'bar', quantity: 1 }] },
    ],
  );
  assert.match(simulation.message, /-1 Ore, \+1 Bar/);
});

test('missing costs and full output space both roll back an entire exchange', () => {
  const missingCost = makeSimulation([
    {
      type: 'inventory',
      remove: [{ itemId: 'wood', quantity: 3 }],
      add: [{ itemId: 'bar', quantity: 1 }],
    },
  ]);
  missingCost.inventory = [{ itemId: 'wood', quantity: 2 }];
  interact(missingCost);
  assert.deepEqual(missingCost.inventory, [{ itemId: 'wood', quantity: 2 }]);
  assert.equal(missingCost.events.at(-1)?.type, 'inventory-failed');
  assert.equal((missingCost.events.at(-1)?.data as any).reason, 'missing-items');
  assert.match(missingCost.message, /Not enough Wood/);

  const fullOutput = makeSimulation(
    [
      {
        type: 'inventory',
        remove: [{ itemId: 'wood', quantity: 1 }],
        add: [{ itemId: 'bar', quantity: 1 }],
      },
    ],
    { slots: 1 },
  );
  fullOutput.inventory = [{ itemId: 'wood', quantity: 2 }];
  interact(fullOutput);
  assert.deepEqual(fullOutput.inventory, [{ itemId: 'wood', quantity: 2 }]);
  assert.equal((fullOutput.events.at(-1)?.data as any).reason, 'inventory-full');
  assert.match(fullOutput.message, /make room/);
});

test('inventory conditions sum matching stacks before comparison', () => {
  const simulation = makeSimulation([{ type: 'inventory', add: [{ itemId: 'token', quantity: 1 }] }], {
    condition: { itemId: 'ore', op: '>=', value: 2 },
  });
  simulation.inventory = [
    { itemId: 'ore', quantity: 1 },
    { itemId: 'ore', quantity: 1 },
  ];

  interact(simulation);

  assert.deepEqual(
    simulation.inventory.map(({ itemId, quantity }) => [itemId, quantity]),
    [
      ['ore', 1],
      ['ore', 1],
      ['token', 1],
    ],
  );
  assert.equal(simulation.events.filter((event) => event.type === 'inventory-changed').length, 1);
});

test('failed once-only crafting can retry, then saves and restores its completed flag', () => {
  const simulation = makeSimulation(
    [
      { type: 'craft', recipeId: 'forge', batches: 1 },
      { type: 'enable', target: 'door', value: true },
    ],
    { once: true },
  );

  interact(simulation);
  assert.deepEqual(simulation.inventory, []);
  assert.equal(simulation.nodes.get('door')?.enabled, false);
  assert.deepEqual(simulation.progressSnapshot()?.execution?.firedRules, []);
  assert.equal(simulation.events.at(-1)?.type, 'craft-failed');

  simulation.inventory = [{ itemId: 'ore', quantity: 1 }];
  interact(simulation);
  assert.deepEqual(simulation.inventory, [{ itemId: 'bar', quantity: 1 }]);
  assert.equal(simulation.nodes.get('door')?.enabled, true);
  const saved = simulation.progressSnapshot()!;
  assert.deepEqual(saved.execution?.firedRules, ['target:0']);

  const resumed = makeSimulation(
    [
      { type: 'craft', recipeId: 'forge', batches: 1 },
      { type: 'enable', target: 'door', value: true },
    ],
    { once: true },
  );
  assert.equal(resumed.restoreProgress(saved), true);
  interact(resumed);
  assert.deepEqual(resumed.inventory, [{ itemId: 'bar', quantity: 1 }]);
  assert.equal(
    resumed.events.some((event) => event.type === 'crafted'),
    false,
  );
});

test('a failed exchange stops later win and enable actions', () => {
  const simulation = makeSimulation([
    {
      type: 'inventory',
      remove: [{ itemId: 'ore', quantity: 2 }],
      add: [{ itemId: 'bar', quantity: 1 }],
    },
    { type: 'win' },
    { type: 'enable', target: 'door', value: true },
  ]);
  simulation.inventory = [{ itemId: 'ore', quantity: 1 }];

  interact(simulation);

  assert.deepEqual(simulation.inventory, [{ itemId: 'ore', quantity: 1 }]);
  assert.equal(simulation.status, 'playing');
  assert.equal(simulation.nodes.get('door')?.enabled, false);
  assert.deepEqual(
    simulation.events.map((event) => event.type),
    ['interact', 'inventory-failed'],
  );
});

test('an exchange can reuse a consumed slot but still requires the full authored cost', () => {
  const items = new Map([ore, wood, bar, token].map((item) => [item.id, item]));
  const inventory = [{ itemId: 'ore', quantity: 1 }];
  const result = changeInventory(
    inventory,
    { remove: [{ itemId: 'ore', quantity: 1 }], add: [{ itemId: 'bar', quantity: 1 }] },
    items,
    1,
  );
  assert.equal(result.status, 'changed');
  assert.deepEqual(result.inventory, [{ itemId: 'bar', quantity: 1 }]);
  assert.deepEqual(inventory, [{ itemId: 'ore', quantity: 1 }]);

  const insufficient = changeInventory(
    inventory,
    { remove: [{ itemId: 'ore', quantity: 2 }], add: [{ itemId: 'ore', quantity: 2 }] },
    items,
    1,
  );
  assert.equal(insufficient.status, 'missing-items');
  assert.deepEqual(insufficient.inventory, inventory);
});

test('legacy variable guards still use variables when the optional item selector is undefined', () => {
  const simulation = makeSimulation([{ type: 'inventory', add: [{ itemId: 'token', quantity: 1 }] }], {
    condition: { variable: 'score', itemId: undefined, op: '>=', value: 2 },
    once: true,
  });
  simulation.inventory = [{ itemId: 'ore', quantity: 4 }];
  interact(simulation);
  assert.deepEqual(simulation.inventory, [{ itemId: 'ore', quantity: 4 }]);
  simulation.variables.score = 2;
  interact(simulation);
  assert.deepEqual(simulation.inventory, [
    { itemId: 'ore', quantity: 4 },
    { itemId: 'token', quantity: 1 },
  ]);
});

test('the survival workbench explains missing ingredients and can complete after retry', () => {
  const project = createExample('survival', 'survival-craft-retry');
  const original = structuredClone(project);
  const simulation = new GameSimulation(project);
  simulation.nodes.get('player')!.transform.position = [0.9, 0, -4];
  interact(simulation);
  assert.match(simulation.message, /Not enough ingredients/);
  assert.equal(simulation.variables.campfireBuilt ?? 0, 0);
  assert.equal(simulation.nodes.get('campfire-site')!.enabled, false);
  assert.equal(simulation.status, 'playing');
  assert.ok(!simulation.progressSnapshot()!.execution!.firedRules.includes('workbench:0'));

  simulation.inventory = [
    { itemId: 'wood', quantity: 2 },
    { itemId: 'stone', quantity: 1 },
  ];
  interact(simulation);
  assert.deepEqual(simulation.inventory, [{ itemId: 'campfire-kit', quantity: 1 }]);
  assert.equal(simulation.variables.campfireBuilt, 1);
  assert.equal(simulation.nodes.get('campfire-site')!.enabled, true);
  assert.ok(simulation.progressSnapshot()!.execution!.firedRules.includes('workbench:0'));
  simulation.nodes.get('player')!.transform.position = [0, 0, -11];
  simulation.step();
  assert.equal(simulation.status, 'won');
  assert.deepEqual(project, original, 'Play must preserve the authored project.');
  simulation.dispose();
});
