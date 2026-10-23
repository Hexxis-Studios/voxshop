import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainBiomeSampler, terrainBiomeFieldSchema } from '../services/terrainBiomeField';
import { createTerrainSurfaceSampler } from '../services/terrainNoise';
import { applyProjectOperations, newProject } from '../services/projectDocument';
import { createWorldCellSampler, worldDocumentSchema } from '../services/worldDocument';
import { exportProject } from '../runtime/gameExport';

const field = terrainBiomeFieldSchema.parse({
  scale: 80,
  biomes: [
    {
      id: 'green',
      name: 'Green',
      palette: { surface: 0x11aa33, subsurface: 0x665544, deep: 0x444455, materialType: 'STANDARD' },
    },
    {
      id: 'ice',
      name: 'Ice',
      palette: { surface: 0xaaddff, subsurface: 0x667788, deep: 0x223344, materialType: 'GLASS' },
    },
  ],
});
const fallback = {
  surface: 0x55aa44,
  subsurface: 0x725439,
  deep: 0x686b70,
  surfaceDepth: 3,
  subsurfaceDepth: 4,
  materialType: 'STANDARD' as const,
};

test('biome field samples repeat for a seed and spread distinct palettes over large regions', () => {
  const sample = createTerrainBiomeSampler(517, 0.5, fallback, field);
  const repeat = createTerrainBiomeSampler(517, 0.5, fallback, field);
  const changedSeed = createTerrainBiomeSampler(518, 0.5, fallback, field);
  const colors = new Set<number>();
  let changedAssignments = 0;
  for (let z = -400; z <= 400; z += 8)
    for (let x = -400; x <= 400; x += 8) {
      assert.deepEqual(sample(x, z), repeat(x, z));
      colors.add(sample(x, z).surface);
      if (sample(x, z).surface !== changedSeed(x, z).surface) changedAssignments++;
    }
  assert.ok(colors.has(0x11aa33));
  assert.ok(colors.has(0xaaddff));
  assert.ok(colors.size > 2, 'Biome borders blend their palettes instead of making a hard color seam.');
  assert.ok(changedAssignments > 0, 'A different world seed changes the field layout.');
});

test('biome scale uses world meters independently from terrain-cell spacing', () => {
  const halfMeterCells = createTerrainBiomeSampler(92, 0.5, fallback, field);
  const oneMeterCells = createTerrainBiomeSampler(92, 1, fallback, field);
  for (let z = -240; z <= 240; z += 12)
    for (let x = -240; x <= 240; x += 12) assert.deepEqual(halfMeterCells(x, z), oneMeterCells(x / 2, z / 2));
});

test('generated world cells use the deterministic biome palette at each surface', () => {
  const world = worldDocumentSchema.parse({
    id: 'biome-surface-world',
    name: 'Biome surface world',
    seed: 517,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-400, -400],
      size: [801, 801],
      minY: -32,
      maxY: 64,
      baseHeight: 8,
      amplitude: 12,
      noise: 0.25,
      palette: fallback,
      biomeField: field,
    },
  });
  const sampleCell = createWorldCellSampler(world);
  const surfaceAt = createTerrainSurfaceSampler(world);
  const colors = new Set<number>();
  for (let z = -400; z <= 400; z += 8)
    for (let x = -400; x <= 400; x += 8) colors.add(sampleCell({ x, y: surfaceAt(x, z), z })!.color);
  assert.ok(colors.has(field.biomes[0].palette.surface));
  assert.ok(colors.has(field.biomes[1].palette.surface));
  assert.ok(colors.size > field.biomes.length, 'Generated surface cells include blended border colors.');
});

test('legacy worlds without biome data keep their original palette output', () => {
  const world = worldDocumentSchema.parse({
    id: 'legacy-world',
    name: 'Legacy world',
    seed: 14,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-32, -32],
      size: [64, 64],
      minY: -32,
      maxY: 64,
      baseHeight: 8,
      amplitude: 12,
      noise: 0.25,
      palette: fallback,
    },
  });
  assert.equal(world.generator.biomeField, undefined);
  const sampleCell = createWorldCellSampler(world);
  const surface = sampleCell({ x: 0, y: createTerrainSurfaceSampler(world)(0, 0), z: 0 });
  assert.deepEqual(surface, { color: fallback.surface, materialType: fallback.materialType });
});

test('biome fields reject duplicate stable IDs and more than eight palettes', () => {
  const duplicated = structuredClone(field);
  duplicated.biomes[1].id = duplicated.biomes[0].id;
  assert.equal(terrainBiomeFieldSchema.safeParse(duplicated).success, false);
  assert.equal(
    terrainBiomeFieldSchema.safeParse({
      ...field,
      biomes: Array.from({ length: 9 }, (_, index) => ({ ...field.biomes[0], id: `biome-${index}` })),
    }).success,
    false,
  );
});

test('world transactions persist biome fields and allow removing them', () => {
  const world = {
    type: 'world.create',
    id: 'biome-world',
    name: 'Biome world',
    seed: 517,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-64, -64],
      size: [128, 128],
      minY: -32,
      maxY: 64,
      baseHeight: 8,
      amplitude: 12,
      noise: 0.25,
      palette: fallback,
    },
  } as const;
  const base = newProject('project', 'Project');
  const created = applyProjectOperations(base, [
    world,
    { type: 'scene.put', scene: { ...base.scenes[0], worldId: 'biome-world' } },
  ]);
  const updated = applyProjectOperations(created, [
    { type: 'world.update', worldId: 'biome-world', generator: { biomeField: field } },
  ]);
  assert.deepEqual(updated.worlds[0].generator.biomeField, field);
  assert.deepEqual(exportProject(updated, updated.activeSceneId).worlds[0].generator.biomeField, field);
  const cleared = applyProjectOperations(updated, [
    { type: 'world.update', worldId: 'biome-world', generator: { biomeField: null } },
  ]);
  assert.equal(cleared.worlds[0].generator.biomeField, undefined);
});
