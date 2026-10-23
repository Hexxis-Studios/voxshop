import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation } from '../runtime/GameSimulation';
import { GameSession } from '../runtime/GameSession';
import { runPlaytest, playtestSchema } from '../runtime/playtest';
import { nodeSchema, validateProject } from '../services/projectDocument';
import { constructionProject } from './fixtures/constructionProject';

const block = { x: 2, y: 4, z: 0, value: { color: 0x55aa44, materialType: 'STANDARD' as const } };

test('building spends materials once, harvesting restores them and a campaign resumes both together', () => {
  const project = constructionProject();
  const original = structuredClone(project);
  const session = new GameSession(project, 'main');
  const simulation = session.simulation;
  assert.deepEqual(simulation.inventory, [{ itemId: 'stone', quantity: 2 }]);
  assert.ok(simulation.editTerrain(block));
  assert.deepEqual(simulation.inventory, [{ itemId: 'stone', quantity: 1 }]);
  assert.equal(simulation.editTerrain(block), null, 'An occupied target never costs a second block.');
  assert.deepEqual(simulation.inventory, [{ itemId: 'stone', quantity: 1 }]);

  const resumed = new GameSession(project, 'main', JSON.parse(JSON.stringify(session.progressSnapshot())));
  assert.equal(resumed.simulation.progressRestored, true);
  assert.deepEqual(resumed.simulation.inspectTerrainCell(block), block.value);
  assert.deepEqual(resumed.simulation.inventory, [{ itemId: 'stone', quantity: 1 }]);
  assert.ok(resumed.simulation.editTerrain({ ...block, value: null }));
  assert.deepEqual(resumed.simulation.inventory, [{ itemId: 'stone', quantity: 2 }]);
  assert.equal(resumed.simulation.editTerrain({ ...block, value: null }), null);
  assert.deepEqual(resumed.simulation.inventory, [{ itemId: 'stone', quantity: 2 }]);
  assert.deepEqual(project, original);
  session.dispose();
  resumed.dispose();
});

test('missing build costs and a full harvest inventory preserve both sides of the operation', () => {
  const missing = new GameSimulation(constructionProject());
  missing.inventory = [];
  assert.equal(missing.editTerrain(block), null);
  assert.equal(missing.inspectTerrainCell(block), null);
  assert.deepEqual(missing.terrainProgressEdits, []);
  assert.match(missing.message, /Not enough materials/);

  const full = new GameSimulation(constructionProject({}, { slots: 1 }));
  assert.ok(full.editTerrain(block));
  full.inventory = [{ itemId: 'coin', quantity: 1 }];
  assert.equal(full.editTerrain({ ...block, value: null }), null);
  assert.deepEqual(full.inspectTerrainCell(block), block.value);
  assert.deepEqual(full.inventory, [{ itemId: 'coin', quantity: 1 }]);
  assert.match(full.message, /Inventory full/);
  missing.dispose();
  full.dispose();
});

test('construction permissions and physical reach are enforced independently of terrain cell size', () => {
  const disabled = new GameSimulation(constructionProject({ place: false }));
  assert.equal(disabled.editTerrain(block), null);
  assert.match(disabled.message, /Building is disabled/);
  assert.deepEqual(disabled.inventory, [{ itemId: 'stone', quantity: 2 }]);

  const small = new GameSimulation(constructionProject({ range: 1 }, { voxelSize: 0.5 }));
  assert.ok(small.editTerrain(block));
  const large = new GameSimulation(constructionProject({ range: 1 }, { voxelSize: 2 }));
  assert.equal(large.editTerrain(block), null);
  assert.match(large.message, /out of reach/);
  assert.deepEqual(large.inventory, [{ itemId: 'stone', quantity: 2 }]);

  const removeDisabled = new GameSimulation(constructionProject({ remove: false }));
  assert.ok(removeDisabled.editTerrain(block));
  assert.equal(removeDisabled.editTerrain({ ...block, value: null }), null);
  assert.match(removeDisabled.message, /Harvesting is disabled/);
  assert.deepEqual(removeDisabled.inspectTerrainCell(block), block.value);
  for (const simulation of [disabled, small, large, removeDisabled]) simulation.dispose();
});

test('building cannot bury the player or an enabled solid but can touch or replace an empty neighbor', () => {
  const project = constructionProject();
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'crate',
      name: 'Crate',
      transform: { position: [2, 4, 0] },
      components: [{ type: 'collider', size: [1, 1, 1], offset: [0, 0.5, 0], solid: true }],
    }),
  );
  const simulation = new GameSimulation(validateProject(project));
  assert.equal(simulation.editTerrain({ ...block, x: 0 }), null);
  assert.equal(simulation.editTerrain(block), null);
  assert.deepEqual(simulation.inventory, [{ itemId: 'stone', quantity: 2 }]);
  simulation.nodes.get('crate')!.enabled = false;
  assert.ok(simulation.editTerrain(block));
  assert.deepEqual(simulation.inventory, [{ itemId: 'stone', quantity: 1 }]);
  // The cell's maximum Y touches the player's feet without overlapping them.
  simulation.nodes.get('player')!.transform.position = [0, 4.5, 0];
  assert.ok(simulation.editTerrain({ ...block, x: 0 }));
  simulation.dispose();
});

test('legacy free editing remains supported and finished runs cannot modify their saved world', () => {
  const project = constructionProject();
  project.scenes[0].nodes[0].components = project.scenes[0].nodes[0].components.filter(
    (component) => component.type !== 'construction',
  );
  const simulation = new GameSimulation(validateProject(project));
  simulation.inventory = [];
  assert.ok(simulation.editTerrain(block));
  assert.deepEqual(simulation.inventory, []);
  simulation.status = 'won';
  assert.equal(simulation.editTerrain({ ...block, value: null }), null);
  assert.deepEqual(simulation.inspectTerrainCell(block), block.value);
  simulation.dispose();
});

test('construction in a heightfield uses cell collision for a mined interior and preserves it on resume', () => {
  const project = constructionProject({ range: 10 });
  project.worlds[0].generator.mode = 'heightfield';
  const simulation = new GameSimulation(validateProject(project));
  assert.ok(simulation.editTerrain({ ...block, y: -1, value: null }));
  assert.ok(simulation.editTerrain({ ...block, y: -2, value: null }));
  simulation.nodes.get('player')!.transform.position = [2, -2.49, 0];
  for (let frame = 0; frame < 90; frame++) simulation.step();
  assert.ok(Math.abs(simulation.worldPosition(simulation.nodes.get('player')!).y + 2.5) < 0.01);
  assert.equal(simulation.inspectTerrainCell({ ...block, y: -1 }), null);
  assert.notEqual(simulation.inspectTerrainCell({ ...block, y: 0 }), null, 'The roof is still present.');
  const restored = new GameSimulation(project, 'main', simulation.progressSnapshot());
  assert.equal(restored.progressRestored, true);
  for (let frame = 0; frame < 30; frame++) restored.step();
  assert.ok(Math.abs(restored.worldPosition(restored.nodes.get('player')!).y + 2.5) < 0.01);
  assert.deepEqual(restored.inventory, [{ itemId: 'stone', quantity: 4 }]);
  simulation.dispose();
  restored.dispose();
});

test('playtests build once per step, inspect terrain and inventory, and fail for missing worlds', async () => {
  const project = constructionProject();
  const placed = await runPlaytest(project, {
    sceneId: 'main',
    steps: [{ frames: 60, terrainEdit: block }],
    assertions: [
      { type: 'terrain-cell', ...block },
      { type: 'inventory', itemId: 'stone', equals: 1 },
      { type: 'no-errors' },
    ],
  });
  assert.equal(placed.passed, true, JSON.stringify(placed.assertions));
  assert.equal(placed.state.events.filter((event) => event.type === 'terrain-cell-placed').length, 1);
  const removed = await runPlaytest(project, {
    sceneId: 'main',
    steps: [
      { frames: 1, terrainEdit: block },
      { frames: 1, terrainEdit: { ...block, value: null } },
    ],
    assertions: [
      { type: 'terrain-cell', ...block, value: null },
      { type: 'inventory', itemId: 'stone', equals: 2 },
    ],
  });
  assert.equal(removed.passed, true);
  project.scenes[0].worldId = null;
  const missing = await runPlaytest(project, {
    sceneId: 'main',
    steps: [],
    assertions: [{ type: 'terrain-cell', ...block, value: null }],
  });
  assert.equal(missing.passed, false);
  assert.match(missing.assertions[0].message!, /inBounds.*false/);
  assert.equal(
    playtestSchema.safeParse({ sceneId: 'main', steps: [{ frames: 1, terrainEdit: { ...block, x: 1.5 } }] })
      .success,
    false,
  );
});
