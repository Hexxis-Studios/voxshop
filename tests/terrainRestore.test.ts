import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSimulation } from '../runtime/GameSimulation';
import { MAX_GAME_WORLD_EDITS, serializeGameProgress } from '../runtime/gameProgress';
import { validateProject } from '../services/projectDocument';
import { constructionProject } from './fixtures/constructionProject';

const paintA = { color: 0x1379bd, materialType: 'METALLIC' as const };
const paintB = { color: 0xe25a31, materialType: 'EMISSIVE' as const };
const cellA = { x: 2, y: 4, z: 0 };
const cellB = { x: 3, y: 4, z: 0 };
const cellC = { x: 4, y: 4, z: 0 };

function checkpoint(simulation: GameSimulation) {
  const snapshot = simulation.progressSnapshot();
  assert.ok(snapshot);
  const serialized = serializeGameProgress(snapshot);
  assert.ok(serialized);
  return JSON.parse(serialized) as typeof snapshot;
}

function floodTouchedCells(simulation: GameSimulation) {
  const internal = simulation as unknown as { terrainTouchedCells: Set<string> };
  internal.terrainTouchedCells = new Set(
    Array.from({ length: MAX_GAME_WORLD_EDITS }, (_, index) => `budget-${index},0,0`),
  );
}

test('live terrain restore replaces later edits and exactly restores saved occupancy and world state', () => {
  const project = validateProject(constructionProject({ placeCost: [], removeYield: [] })),
    simulation = new GameSimulation(project);
  try {
    assert.ok(simulation.editTerrain({ ...cellA, value: paintA }));
    const liveSnapshot = simulation.progressSnapshot();
    assert.ok(liveSnapshot?.terrain);
    const serialized = serializeGameProgress(liveSnapshot);
    assert.ok(serialized);
    const saved = JSON.parse(serialized) as typeof liveSnapshot,
      savedDeltas = structuredClone(simulation.terrainProgressEdits),
      savedWorld = structuredClone(simulation.terrainWorldDocument);
    assert.deepEqual(saved.terrain?.edits, savedDeltas);
    assert.equal(savedDeltas.length, 1);
    assert.ok(liveSnapshot.terrain.edits[0].value);
    liveSnapshot.terrain.edits[0].value.color = 0;
    assert.deepEqual(
      simulation.inspectTerrainCell(cellA),
      paintA,
      'mutating a snapshot does not mutate the live terrain',
    );

    assert.ok(simulation.editTerrain({ ...cellB, value: paintB }));
    assert.ok(
      simulation.editTerrain({ ...cellA, value: null }),
      'reverting A records its generated base value',
    );
    assert.deepEqual(simulation.inspectTerrainCell(cellA), null);
    assert.deepEqual(simulation.inspectTerrainCell(cellB), paintB);
    assert.equal(simulation.terrainProgressEdits.length, 2);

    floodTouchedCells(simulation);
    assert.equal(simulation.restoreProgress(saved), true);
    assert.deepEqual(simulation.terrainProgressEdits, savedDeltas);
    assert.deepEqual(simulation.terrainWorldDocument, savedWorld);
    assert.deepEqual(simulation.inspectTerrainCell(cellA), paintA);
    assert.equal(simulation.inspectTerrainCell(cellB), null, 'a later edit is absent after restore');
    assert.equal(simulation.inspectTerrainCell(cellC), null);

    const internal = simulation as unknown as { terrainTouchedCells: Set<string> };
    assert.deepEqual(
      [...internal.terrainTouchedCells],
      ['2,4,0'],
      'the budget tracks only accepted saved deltas',
    );
    assert.ok(
      simulation.editTerrain({ ...cellC, value: paintB }),
      'the restored budget leaves room for new edits',
    );
  } finally {
    simulation.dispose();
  }
});

test('restoring a checkpoint without terrain returns to authored edits and clears the touched-cell budget', () => {
  const project = constructionProject({ placeCost: [], removeYield: [] });
  project.scenes[0].variables = { score: 0 };
  project.worlds[0].edits = [{ ...cellA, value: paintA }];
  const validProject = validateProject(project),
    simulation = new GameSimulation(validProject),
    authoredWorld = structuredClone(validProject.worlds[0]);
  try {
    const emptyTerrainCheckpoint = checkpoint(simulation);
    assert.equal(emptyTerrainCheckpoint.terrain, undefined);
    assert.deepEqual(simulation.inspectTerrainCell(cellA), paintA);

    assert.ok(simulation.editTerrain({ ...cellA, value: null }));
    assert.ok(simulation.editTerrain({ ...cellB, value: paintB }));
    assert.notDeepEqual(simulation.terrainWorldDocument, authoredWorld);
    floodTouchedCells(simulation);

    assert.equal(simulation.restoreProgress(emptyTerrainCheckpoint), true);
    assert.deepEqual(simulation.terrainProgressEdits, []);
    assert.deepEqual(simulation.terrainWorldDocument, authoredWorld);
    assert.deepEqual(simulation.inspectTerrainCell(cellA), paintA, 'authored sparse cells return');
    assert.equal(simulation.inspectTerrainCell(cellB), null, 'later runtime cells are removed');
    assert.equal((simulation as unknown as { terrainTouchedCells: Set<string> }).terrainTouchedCells.size, 0);
    assert.ok(
      simulation.editTerrain({ ...cellC, value: paintB }),
      'the empty checkpoint resets the edit budget',
    );
  } finally {
    simulation.dispose();
  }
});

test('bad terrain signatures and oversized deltas reject without changing the live checkpoint', () => {
  const project = constructionProject({ placeCost: [], removeYield: [] });
  project.scenes[0].variables = { score: 0 };
  const validProject = validateProject(project),
    simulation = new GameSimulation(validProject);
  try {
    assert.ok(simulation.editTerrain({ ...cellA, value: paintA }));
    const before = checkpoint(simulation),
      beforeWorld = structuredClone(simulation.terrainWorldDocument),
      badSignature = structuredClone(before);
    badSignature.variables.score = 123;
    badSignature.terrain!.signature = 'wrong-world-signature';
    assert.equal(simulation.restoreProgress(badSignature), false);
    assert.deepEqual(checkpoint(simulation), before);
    assert.deepEqual(simulation.terrainWorldDocument, beforeWorld);

    const overBudget = structuredClone(before);
    overBudget.variables.score = 456;
    overBudget.terrain!.edits = Array.from({ length: MAX_GAME_WORLD_EDITS + 1 }, (_, x) => ({
      x,
      y: 1,
      z: 1,
      value: null,
    }));
    assert.equal(simulation.restoreProgress(overBudget), false);
    assert.deepEqual(checkpoint(simulation), before);
    assert.deepEqual(simulation.terrainWorldDocument, beforeWorld);
    assert.deepEqual(simulation.inspectTerrainCell(cellA), paintA);
  } finally {
    simulation.dispose();
  }
});
