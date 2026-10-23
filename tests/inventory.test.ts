import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation } from '../runtime/GameSimulation';
import { renderGameHtml } from '../runtime/gameExport';
import {
  addInventoryItem,
  craftInventory,
  reorderInventoryStacks,
  sortInventoryStacks,
} from '../runtime/Inventory';
import {
  newProject,
  validateProject,
  type CraftingRecipe,
  type ItemDefinition,
  type SceneNode,
} from '../services/projectDocument';

const iron: ItemDefinition = { id: 'iron', name: 'Iron ore', description: '', maxStack: 4 };
const wood: ItemDefinition = { id: 'wood', name: 'Wood', description: '', maxStack: 4 };
const bar: ItemDefinition = { id: 'bar', name: 'Iron bar', description: '', maxStack: 4 };
const recipe: CraftingRecipe = {
  id: 'smelt-bar',
  name: 'Smelt iron bar',
  ingredients: [
    { itemId: 'iron', quantity: 2 },
    { itemId: 'wood', quantity: 1 },
  ],
  outputs: [{ itemId: 'bar', quantity: 2 }],
};

function projectWithInventory(slots = 4) {
  const project = newProject('inventory-test', 'Inventory test');
  project.scenes[0].items = [iron, wood, bar];
  project.scenes[0].recipes = [recipe];
  const nodes: SceneNode[] = [
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
        { type: 'inventory', slots },
      ],
      attachments: [],
    },
    ...(
      [
        ['ore-pickup', 'iron', 2],
        ['wood-pickup', 'wood', 1],
      ] as const
    ).map(([id, itemId, quantity]) => ({
      id,
      name: id,
      assetId: null,
      parentId: null,
      transform: {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      enabled: true,
      components: [
        {
          type: 'collider' as const,
          size: [0.5, 0.5, 0.5] as [number, number, number],
          offset: [0, 0.25, 0] as [number, number, number],
          solid: false,
        },
        { type: 'collectible' as const, variable: 'score', amount: 1, itemId, quantity },
      ],
      attachments: [],
    })),
    {
      id: 'furnace',
      name: 'Furnace',
      assetId: null,
      parentId: null,
      transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider' as const, size: [1, 1, 1], offset: [0, 0.5, 0], solid: false },
        { type: 'interactable' as const, prompt: 'Smelt iron bar', range: 2 },
        {
          type: 'rules' as const,
          apiVersion: 1,
          rules: [
            {
              event: 'interact' as const,
              once: false,
              interval: 1,
              actions: [{ type: 'craft' as const, recipeId: 'smelt-bar', batches: 1 }],
            },
          ],
        },
      ],
      attachments: [],
    },
  ];
  project.scenes[0].nodes = nodes;
  return validateProject(project);
}

test('inventory sorting and stack moves preserve stack contents and produce stable hotbar order', () => {
  const stacks = [
    { itemId: 'wood', quantity: 3 },
    { itemId: 'bar', quantity: 2 },
    { itemId: 'iron', quantity: 4 },
  ];
  const items = new Map([iron, wood, bar].map((item) => [item.id, item]));
  assert.deepEqual(sortInventoryStacks(stacks, items), [
    { itemId: 'bar', quantity: 2 },
    { itemId: 'iron', quantity: 4 },
    { itemId: 'wood', quantity: 3 },
  ]);
  assert.deepEqual(reorderInventoryStacks(stacks, 2, 0), [
    { itemId: 'iron', quantity: 4 },
    { itemId: 'wood', quantity: 3 },
    { itemId: 'bar', quantity: 2 },
  ]);
  assert.equal(reorderInventoryStacks(stacks, -1, 0), null);
  assert.deepEqual(
    stacks.map((stack) => stack.quantity),
    [3, 2, 4],
  );

  const simulation = new GameSimulation(projectWithInventory());
  simulation.inventory = stacks.map((stack) => ({ ...stack }));
  assert.equal(simulation.moveInventoryStack(2, 0), true);
  assert.deepEqual(simulation.progressSnapshot()?.inventory, [
    { itemId: 'iron', quantity: 4 },
    { itemId: 'wood', quantity: 3 },
    { itemId: 'bar', quantity: 2 },
  ]);
  assert.equal(simulation.sortInventoryByName(), true);
  assert.deepEqual(
    simulation.inventory.map((stack) => stack.itemId),
    ['bar', 'iron', 'wood'],
  );
  simulation.status = 'won';
  assert.equal(simulation.moveInventoryStack(0, 1), false);
  assert.equal(simulation.sortInventoryByName(), false);
});

test('legacy projects normalize to empty item and recipe catalogs', () => {
  const project = newProject('legacy-inventory', 'Legacy project') as any;
  delete project.scenes[0].items;
  delete project.scenes[0].recipes;
  const parsed = validateProject(project);
  assert.deepEqual(parsed.scenes[0].items, []);
  assert.deepEqual(parsed.scenes[0].recipes, []);
});

test('standalone export carries authored catalogs and exposes an inventory HUD region', () => {
  const project = projectWithInventory();
  project.scenes[0].items[0].description = 'A sample description for the exported iron ore.';
  const html = renderGameHtml(project, 'main', '', '');
  assert.match(html, /id="inventory" aria-label="Inventory"/);
  const embedded = JSON.parse(
    html.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
  );
  assert.deepEqual(
    embedded.scenes[0].items.map((item: ItemDefinition) => item.id),
    ['iron', 'wood', 'bar'],
  );
  assert.equal(embedded.scenes[0].items[0].description, 'A sample description for the exported iron ore.');
  assert.equal(embedded.scenes[0].recipes[0].id, 'smelt-bar');
});

test('project validation bounds inventory data and resolves item, recipe and action references', () => {
  const valid = projectWithInventory();
  assert.equal(valid.scenes[0].recipes[0].ingredients.length, 2);
  const unknownPickup = structuredClone(valid);
  unknownPickup.scenes[0].nodes[1].components[1] = {
    type: 'collectible',
    itemId: 'missing',
    quantity: 1,
  } as any;
  assert.throws(() => validateProject(unknownPickup), /references a missing item/);
  const unknownRecipe = structuredClone(valid);
  unknownRecipe.scenes[0].recipes[0].outputs[0].itemId = 'missing';
  assert.throws(() => validateProject(unknownRecipe), /references a missing item/);
  const unknownAction = structuredClone(valid);
  (unknownAction.scenes[0].nodes[3].components[2] as any).rules[0].actions[0].recipeId = 'missing';
  assert.throws(() => validateProject(unknownAction), /references a missing recipe/);
  const duplicate = structuredClone(valid);
  duplicate.scenes[0].items.push({ ...iron });
  assert.throws(() => validateProject(duplicate), /Duplicate item ID/);
});

test('touch pickups feed named inventory and an authored interact rule crafts atomically', () => {
  const sim = new GameSimulation(projectWithInventory());
  sim.step();
  assert.deepEqual(sim.inspect().inventory, [
    { itemId: 'iron', quantity: 2, name: 'Iron ore' },
    { itemId: 'wood', quantity: 1, name: 'Wood' },
  ]);
  assert.equal(sim.nodes.get('ore-pickup')?.enabled, false);
  assert.match(sim.message, /Wood/);

  sim.step({ interact: true });
  assert.deepEqual(sim.inspect().inventory, [{ itemId: 'bar', quantity: 2, name: 'Iron bar' }]);
  assert.equal(sim.message, 'Smelt iron bar crafted.');
  assert.equal(sim.events.at(-1)?.type, 'crafted');

  sim.step({ interact: false });
  sim.step({ interact: true });
  assert.deepEqual(sim.inspect().inventory, [{ itemId: 'bar', quantity: 2, name: 'Iron bar' }]);
  assert.equal(sim.message, 'Not enough ingredients for Smelt iron bar.');
  assert.equal(sim.events.at(-1)?.type, 'craft-failed');
});

test('full inventory preserves an uncollected pickup and crafting failures do not consume materials', () => {
  const sim = new GameSimulation(projectWithInventory(1));
  sim.step();
  assert.deepEqual(sim.inspect().inventory, [{ itemId: 'iron', quantity: 2, name: 'Iron ore' }]);
  assert.equal(sim.nodes.get('wood-pickup')?.enabled, true);
  assert.equal(sim.events.filter((event) => event.type === 'pickup-blocked').length, 1);
  sim.step();
  assert.equal(sim.events.filter((event) => event.type === 'pickup-blocked').length, 1);

  const items = new Map([
    [iron.id, iron],
    [wood.id, wood],
    [bar.id, bar],
  ]);
  const failed = craftInventory([{ itemId: 'iron', quantity: 2 }], recipe, items, 1, 1);
  assert.equal(failed.status, 'missing-items');
  assert.deepEqual(failed.inventory, [{ itemId: 'iron', quantity: 2 }]);
});

test('slot and stack limits reject additions without partial inventory mutation', () => {
  const first = addInventoryItem([], iron, 3, 1);
  assert.deepEqual(first, [{ itemId: 'iron', quantity: 3 }]);
  assert.equal(addInventoryItem(first!, iron, 2, 1), null);
  assert.deepEqual(first, [{ itemId: 'iron', quantity: 3 }]);
  assert.equal(addInventoryItem(first!, wood, 1, 1), null);
});
