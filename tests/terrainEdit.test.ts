import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTerrainStrokeEdits,
  createTerrainInspector,
  terrainEditFromHit,
  terrainEditsFromHit,
  terrainStrokeSamples,
} from '../runtime/GameViewport';
import type { TerrainPaletteLayer, TerrainPaint } from '../runtime/GameViewport';
import { worldDocumentSchema, type WorldEdit } from '../services/worldDocument';

function world(voxelSize = 0.5, edits: unknown[] = [], materialType: 'STANDARD' | 'METALLIC' = 'STANDARD') {
  return worldDocumentSchema.parse({
    id: 'edit-world',
    name: 'Edit world',
    seed: 19,
    chunkSize: 16,
    voxelSize,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [0, 0],
      size: [4, 4],
      minY: -8,
      maxY: 16,
      baseHeight: 3,
      amplitude: 0,
      palette: {
        surface: 0x55aa44,
        subsurface: 0x725439,
        deep: 0x686b70,
        materialType,
      },
    },
    edits,
  });
}

test('removal targets the hit cell using world-cell spacing and stores a tombstone', () => {
  assert.deepEqual(terrainEditFromHit(world(0.25), 'remove', [-0.75, 1.125, -0.75], [0, 1, 0]), {
    x: -3,
    y: 4,
    z: -3,
    value: null,
  });
  assert.deepEqual(terrainEditFromHit(world(0.5), 'remove', [-1.5, 2.25, -1.5], [0, 1, 0]), {
    x: -3,
    y: 4,
    z: -3,
    value: null,
  });
});

test('placement targets the adjacent face cell and uses the world surface palette', () => {
  assert.deepEqual(terrainEditFromHit(world(), 'place', [0.25, 1.5, -0.25], [1, 0, 0]), {
    x: 1,
    y: 3,
    z: 0,
    value: { color: 0x55aa44, materialType: 'STANDARD' },
  });
});

test('placement uses the selected active-world palette layer color and material', () => {
  const selectedWorld = world(0.5, [], 'METALLIC');
  for (const [layer, color] of [
    ['surface', 0x55aa44],
    ['subsurface', 0x725439],
    ['deep', 0x686b70],
  ] as const satisfies readonly (readonly [TerrainPaletteLayer, number])[]) {
    const edit = terrainEditFromHit(selectedWorld, 'place', [0.25, 1.5, -0.25], [1, 0, 0], false, layer);
    assert.deepEqual(
      edit.value,
      { color, materialType: 'METALLIC' },
      `${layer} selection preserves its palette cell`,
    );
  }
});

test('custom placement writes the selected per-cell color and existing material type', () => {
  const customPaint: TerrainPaint = { color: 0xf04ac1, materialType: 'EMISSIVE' };
  assert.deepEqual(
    terrainEditFromHit(
      world(0.5, [], 'METALLIC'),
      'place',
      [0.25, 1.5, -0.25],
      [1, 0, 0],
      false,
      'custom',
      customPaint,
    ),
    {
      x: 1,
      y: 3,
      z: 0,
      value: customPaint,
    },
  );
});

test('coarse terrain hits resolve to the generated cell column before placing', () => {
  assert.deepEqual(terrainEditFromHit(world(), 'place', [0.5, 30, 0.5], [0, 1, 0], true), {
    x: 1,
    y: 4,
    z: 1,
    value: { color: 0x55aa44, materialType: 'STANDARD' },
  });
  assert.deepEqual(
    terrainEditFromHit(
      world(0.5, [{ x: 1, y: 3, z: 1, value: null }]),
      'remove',
      [0.5, 30, 0.5],
      [0, 1, 0],
      true,
    ),
    { x: 1, y: 2, z: 1, value: null },
  );
});

test('terrain inspection maps hit cells, reports effective sources and leaves world data unchanged', () => {
  const point: [number, number, number] = [0, 0.875, 0],
    normal: [number, number, number] = [0, 1, 0],
    generatedWorld = world(0.25),
    generatedBefore = JSON.stringify(generatedWorld),
    generated = createTerrainInspector(generatedWorld)(point, normal);
  assert.deepEqual(generated, {
    position: [0, 3, 0],
    physicalPosition: [0, 0.75, 0],
    cell: { color: 0x55aa44, materialType: 'STANDARD' },
    status: 'generated',
  });
  assert.equal(JSON.stringify(generatedWorld), generatedBefore);

  const sparseWorld = world(0.25, [
      { x: 0, y: 3, z: 0, value: { color: 0xf04ac1, materialType: 'EMISSIVE' } },
    ]),
    sparseBefore = JSON.stringify(sparseWorld),
    sparse = createTerrainInspector(sparseWorld)(point, normal);
  assert.deepEqual(sparse.cell, { color: 0xf04ac1, materialType: 'EMISSIVE' });
  assert.equal(sparse.status, 'sparse');
  assert.deepEqual(sparse.physicalPosition, [0, 0.75, 0]);
  assert.equal(JSON.stringify(sparseWorld), sparseBefore);

  const removed = createTerrainInspector(world(0.25, [{ x: 0, y: 3, z: 0, value: null }]))(point, normal);
  assert.equal(removed.cell, undefined);
  assert.equal(removed.status, 'removed');
});

test('brush sizes 1, 3 and 5 emit complete odd square footprints', () => {
  for (const [size, count] of [
    [1, 1],
    [3, 9],
    [5, 25],
  ] as const) {
    const edits = terrainEditsFromHit(world(), 'remove', [0.25, 1.25, 0.25], [0, 1, 0], false, size);
    assert.equal(edits.length, count);
    assert.ok(edits.every((edit) => edit.value === null && edit.y === 2));
    if (size === 1)
      assert.deepEqual(edits, [terrainEditFromHit(world(), 'remove', [0.25, 1.25, 0.25], [0, 1, 0])]);
  }
});

test('cube and sphere stamps fill bounded volumes for placement and removal', () => {
  const point: [number, number, number] = [0.25, 1.25, 0.25],
    normal: [number, number, number] = [0, 1, 0],
    removedCube = terrainEditsFromHit(
      world(),
      'remove',
      point,
      normal,
      false,
      3,
      'surface',
      undefined,
      'cube',
    ),
    placedCube = terrainEditsFromHit(world(), 'place', point, normal, false, 3, 'surface', undefined, 'cube');
  assert.equal(removedCube.length, 27);
  assert.ok(removedCube.every((edit) => edit.value === null));
  assert.equal(placedCube.length, 27);
  assert.ok(placedCube.every((edit) => edit.value?.color === 0x55aa44));
  assert.deepEqual(
    [...new Set(placedCube.map(({ y }) => y))].sort((a, b) => a - b),
    [2, 3, 4],
  );

  for (const [size, count] of [
    [3, 7],
    [5, 33],
  ] as const) {
    const radius = Math.floor(size / 2),
      sphere = terrainEditsFromHit(
        world(),
        'remove',
        point,
        normal,
        false,
        size,
        'surface',
        undefined,
        'sphere',
      );
    assert.equal(sphere.length, count);
    assert.ok(
      sphere.every(({ x, y, z }) => {
        const dx = x - 1,
          dy = y - 2,
          dz = z - 1;
        return dx * dx + dy * dy + dz * dz <= radius * radius;
      }),
    );
  }
  assert.equal(
    terrainEditsFromHit(world(), 'remove', point, normal, false, 5, 'surface', undefined, 'cube').length,
    125,
  );
});

test('brush footprint stays in the face plane for all six axis directions', () => {
  const point: [number, number, number] = [0.25, 1.25, 0.25];
  for (const axis of [0, 1, 2])
    for (const direction of [-1, 1]) {
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = direction;
      const edits = terrainEditsFromHit(world(), 'place', point, normal, false, 3);
      const center = terrainEditFromHit(world(), 'place', point, normal),
        fixedKey = ['x', 'y', 'z'][axis] as 'x' | 'y' | 'z';
      assert.ok(edits.every((edit) => edit[fixedKey] === center[fixedKey]));
      for (const coordinateAxis of [0, 1, 2].filter((index) => index !== axis)) {
        const key = ['x', 'y', 'z'][coordinateAxis] as 'x' | 'y' | 'z';
        assert.deepEqual(
          [...new Set(edits.map((edit) => edit[key]))].sort((a, b) => a - b),
          [center[key] - 1, center[key], center[key] + 1],
        );
      }
      assert.equal(new Set(edits.map(({ x, y, z }) => `${x},${y},${z}`)).size, 9);
    }
});

test('edge brushes retain every unique cell and reject footprints past coordinate bounds', () => {
  const edge = terrainEditsFromHit(world(), 'remove', [0.25, 1.25, 0.25], [0, 1, 0], false, 5);
  assert.equal(edge.length, 25);
  assert.equal(new Set(edge.map(({ x, y, z }) => `${x},${y},${z}`)).size, 25);
  assert.deepEqual(
    [...new Set(edge.map(({ x }) => x))].sort((a, b) => a - b),
    [-1, 0, 1, 2, 3],
  );
  assert.throws(
    () => terrainEditsFromHit(world(), 'remove', [500_000_000, 1.25, 0.25], [0, 1, 0], false, 3),
    /coordinate bounds/,
  );
});

test('drag sampling fills the screen path between widely spaced pointer events', () => {
  const samples = terrainStrokeSamples([10, 20], [30, 20]);
  assert.deepEqual(samples, [
    [14, 20],
    [18, 20],
    [22, 20],
    [26, 20],
    [30, 20],
  ]);
  assert.throws(() => terrainStrokeSamples([0, 0], [40001, 0]), /too long/);
});

test('one drag deduplicates overlapping brushes and rejects an over-limit stroke atomically', () => {
  const edits = new Map<string, WorldEdit>(),
    first = terrainEditsFromHit(world(), 'remove', [0.25, 1.25, 0.25], [0, 1, 0], false, 3),
    overlapping = terrainEditsFromHit(world(), 'remove', [0.75, 1.25, 0.25], [0, 1, 0], false, 3);
  addTerrainStrokeEdits(edits, first);
  addTerrainStrokeEdits(edits, overlapping);
  addTerrainStrokeEdits(edits, first);
  assert.equal(edits.size, 12);

  const atLimit = new Map<string, WorldEdit>(
    Array.from({ length: 9999 }, (_, x) => [`${x},0,0`, { x, y: 0, z: 0, value: null }]),
  );
  assert.throws(
    () =>
      addTerrainStrokeEdits(atLimit, [
        { x: 9999, y: 0, z: 0, value: null },
        { x: 10000, y: 0, z: 0, value: null },
      ]),
    /10,000 unique cells/,
  );
  assert.equal(atLimit.size, 9999);
});
