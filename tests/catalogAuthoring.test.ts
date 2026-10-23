import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SceneCatalogEditor from '../components/SceneCatalogEditor';
import { createExample } from '../services/examples';
import {
  addCatalogItem,
  addCatalogRecipe,
  deleteCatalogItem,
  deleteCatalogRecipe,
  updateCatalogItem,
  updateCatalogRecipe,
  validateCatalogDraft,
} from '../components/catalogAuthoring';
import { identityTransform, newProject, nodeSchema } from '../services/projectDocument';

function sceneWithCatalog() {
  const project = newProject('catalog-test', 'Catalog test');
  const scene = project.scenes[0];
  scene.items = [{ id: 'ore', name: 'Ore', description: '', maxStack: 40 }];
  scene.objectives = [
    { id: 'ore-goal', text: 'Collect ore', condition: { itemId: 'ore', op: '>=', value: 2 } },
  ];
  scene.recipes = [
    {
      id: 'smelt',
      name: 'Smelt ore',
      ingredients: [{ itemId: 'ore', quantity: 2 }],
      outputs: [{ itemId: 'ore', quantity: 1 }],
    },
  ];
  scene.nodes = [
    nodeSchema.parse({
      id: 'pickup',
      name: 'Ore pickup',
      transform: identityTransform(),
      components: [{ type: 'collectible', itemId: 'ore', quantity: 1 }],
    }),
    nodeSchema.parse({
      id: 'station',
      name: 'Smelter',
      transform: identityTransform(),
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'interact',
              interval: 1,
              once: false,
              condition: { itemId: 'ore', op: '>=', value: 2 },
              actions: [
                { type: 'craft', recipeId: 'smelt' },
                {
                  type: 'inventory',
                  remove: [{ itemId: 'ore', quantity: 1 }],
                  add: [{ itemId: 'ore', quantity: 2 }],
                },
              ],
            },
            {
              event: 'start',
              conditionGroup: {
                mode: 'any',
                conditions: [
                  { itemId: 'ore', op: '>=', value: 1 },
                  { variable: 'score', op: '>=', value: 1 },
                ],
              },
              actions: [{ type: 'message', text: 'Ready' }],
            },
          ],
        },
      ],
    }),
  ];
  return { project, scene };
}

test('catalog helpers add, edit, remove and preserve item/recipe references', () => {
  const { project, scene } = sceneWithCatalog();
  let next = addCatalogItem(scene);
  assert.equal(next.items[1].id, 'item-1');
  next = updateCatalogItem(next, 'ore', { id: 'copper-ore', maxStack: 64 });
  assert.equal(next.recipes[0].ingredients[0].itemId, 'copper-ore');
  assert.deepEqual(next.objectives[0]?.condition, { itemId: 'copper-ore', op: '>=', value: 2 });
  assert.equal(
    next.nodes[0].components[0].type === 'collectible' && next.nodes[0].components[0].itemId,
    'copper-ore',
  );
  const rules = next.nodes[1].components[0];
  assert.equal(rules.type === 'rules' && rules.rules[0].condition?.itemId, 'copper-ore');
  assert.equal(rules.type === 'rules' && rules.rules[1].conditionGroup?.conditions[0]?.itemId, 'copper-ore');
  assert.deepEqual(
    rules.type === 'rules' && rules.rules[0].actions[1].type === 'inventory'
      ? [rules.rules[0].actions[1].remove[0].itemId, rules.rules[0].actions[1].add[0].itemId]
      : [],
    ['copper-ore', 'copper-ore'],
  );

  next = updateCatalogRecipe(next, 'smelt', { id: 'smelt-copper' });
  const rule = next.nodes[1].components[0];
  assert.equal(
    rule.type === 'rules' && rule.rules[0].actions[0].type === 'craft' && rule.rules[0].actions[0].recipeId,
    'smelt-copper',
  );
  assert.equal(validateCatalogDraft(project, next), null);

  next = deleteCatalogRecipe(next, 'smelt-copper');
  assert.equal(validateCatalogDraft(project, next)?.includes('recipe'), true);
  next = deleteCatalogItem(next, 'copper-ore');
  assert.equal(validateCatalogDraft(project, next)?.includes('item'), true);
});

test('catalog defaults use available scene items and validation reports incomplete references', () => {
  const { project, scene } = sceneWithCatalog();
  const withRecipe = addCatalogRecipe(scene);
  assert.equal(withRecipe.recipes[1].ingredients[0].itemId, 'ore');
  assert.equal(withRecipe.recipes[1].outputs[0].itemId, 'ore');

  const duplicate = { ...scene, items: [...scene.items, { ...scene.items[0] }] };
  assert.match(validateCatalogDraft(project, duplicate) ?? '', /Duplicate item/);
  assert.throws(() => addCatalogRecipe({ ...scene, items: [] }), /Add an item/);
});

test('catalog item rename preserves construction references and deletion counts them', () => {
  const { project, scene } = sceneWithCatalog();
  scene.nodes.push(
    nodeSchema.parse({
      id: 'builder',
      name: 'Builder',
      transform: identityTransform(),
      components: [
        { type: 'player', style: 'third-person', speed: 3 },
        {
          type: 'construction',
          placeCost: [{ itemId: 'ore', quantity: 2 }],
          removeYield: [{ itemId: 'ore', quantity: 1 }],
        },
      ],
    }),
  );

  const renamed = updateCatalogItem(scene, 'ore', { id: 'copper-ore' });
  const construction = renamed.nodes[2].components.find((component) => component.type === 'construction');
  assert.deepEqual(
    construction?.type === 'construction'
      ? [construction.placeCost[0].itemId, construction.removeYield[0].itemId]
      : [],
    ['copper-ore', 'copper-ore'],
  );
  assert.equal(validateCatalogDraft(project, renamed), null);

  const removed = deleteCatalogItem(renamed, 'copper-ore');
  assert.match(validateCatalogDraft(project, removed) ?? '', /missing item/);

  const html = renderToStaticMarkup(
    createElement(SceneCatalogEditor, {
      project,
      scene,
      onSave: async () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /9 references · remove them before deleting/);
  assert.match(html, /aria-label="Delete item Ore" disabled=""/);
});

test('manual catalog dialog renders labeled fields and bounded add/delete controls', () => {
  const { project, scene } = sceneWithCatalog();
  const html = renderToStaticMarkup(
    createElement(SceneCatalogEditor, {
      project,
      scene,
      onSave: async () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /Scene items &amp; recipes/);
  assert.match(html, /Item name/);
  assert.match(html, /Item ID/);
  assert.match(html, /Max stack/);
  assert.match(html, /aria-label="Use effect for Ore"/);
  assert.match(html, /aria-label="Health restored by Ore"/);
  assert.match(html, /Recipe name/);
  assert.match(html, /Recipe ID/);
  assert.match(html, /Item needed/);
  assert.match(html, /Item produced/);
  assert.match(html, /7 references · remove them before deleting/);
  assert.match(html, /aria-label="Delete item Ore" disabled=""/);
  assert.match(html, /Apply scene catalog/);
});

test('catalog authors bounded health effects and preserves them when item IDs change', () => {
  const { project, scene } = sceneWithCatalog();
  const usable = updateCatalogItem(scene, 'ore', { use: { type: 'heal', amount: 30 } });
  assert.equal(validateCatalogDraft(project, usable), null);
  const renamed = updateCatalogItem(usable, 'ore', { id: 'healing-ore' });
  assert.deepEqual(renamed.items[0].use, { type: 'heal', amount: 30 });

  const html = renderToStaticMarkup(
    createElement(SceneCatalogEditor, {
      project,
      scene: renamed,
      onSave: async () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /aria-label="Use effect for Ore"/);
  assert.match(html, /<option value="heal" selected="">/);
  assert.match(html, /aria-label="Health restored by Ore"[^>]*value="30"/);

  const invalid = { ...renamed, items: [{ ...renamed.items[0], use: { type: 'heal' as const, amount: 0 } }] };
  assert.notEqual(validateCatalogDraft(project, invalid), null);
});

test('manual catalog editor preserves and bounds the item description field', () => {
  const { project, scene } = sceneWithCatalog();
  const described = updateCatalogItem(scene, 'ore', { description: 'A rough copper ore sample.' });
  assert.equal(described.items[0].description, 'A rough copper ore sample.');
  assert.equal(validateCatalogDraft(project, described), null);
  assert.notEqual(
    validateCatalogDraft(project, updateCatalogItem(scene, 'ore', { description: 'x'.repeat(501) })),
    null,
  );

  const html = renderToStaticMarkup(
    createElement(SceneCatalogEditor, {
      project,
      scene: described,
      onSave: async () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /aria-label="Description for Ore"/);
  assert.match(html, /maxLength="500"/);
  assert.match(html, /A rough copper ore sample\./);
});

test('catalog selects compatible fitted gear for equippable items', () => {
  const project = createExample('arena', 'catalog-equipment'),
    scene = project.scenes[0];
  scene.nodes = scene.nodes.filter((node) => node.id !== 'shell-pickup');
  scene.objectives = scene.objectives.filter((objective) => objective.id !== 'find-shell');
  scene.items = [
    {
      id: 'shell-token',
      name: 'Shell token',
      description: '',
      maxStack: 1,
      use: { type: 'equip', assetId: 'armor' },
    },
  ];
  const html = renderToStaticMarkup(
    createElement(SceneCatalogEditor, {
      project,
      scene,
      onSave: async () => {},
      onClose: () => {},
    }),
  );
  assert.equal(validateCatalogDraft(project, scene), null);
  assert.match(html, /<option value="equip" selected="">Equip fitted equipment<\/option>/);
  assert.match(html, /aria-label="Fitted gear for Shell token"/);
  assert.match(html, /option value="armor" selected="">Fitted shell · shell/);
});
