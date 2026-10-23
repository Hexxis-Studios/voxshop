import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerrainBiomeSampler } from '../services/terrainBiomeField';
import { createTerrainSurfaceSampler, createTerrainVolumeSampler } from '../services/terrainNoise';
import { createWorldCellSampler, worldDocumentSchema } from '../services/worldDocument';

for (const mode of ['heightfield', 'voxel3d'] as const) {
  test(`${mode} column reuse preserves cells, cave occupancy and overrides across cache eviction`, () => {
    const world = worldDocumentSchema.parse({
      id: 'sampling-parity',
      name: 'Sampling parity',
      seed: 817,
      chunkSize: 16,
      voxelSize: 0.5,
      generator: {
        type: 'terrain',
        version: 1,
        mode,
        origin: [-2048, -32],
        size: [4096, 64],
        minY: -16,
        maxY: 63,
        baseHeight: 32,
        amplitude: 12,
        noise: 0.82,
        landformScale: 96,
        palette: { surface: 0x79a94e, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
        biomeField: {
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
        },
      },
      edits: [
        { x: 0, y: 28, z: 0, value: { color: 0xe13a83, materialType: 'EMISSIVE' } },
        { x: 2048, y: 70, z: 0, value: { color: 0x123456, materialType: 'STANDARD' } },
      ],
    });
    const surfaceAt = createTerrainSurfaceSampler(world);
    world.edits.push({ x: 1, y: surfaceAt(1, 0), z: 0, value: null });
    const sample = createWorldCellSampler(world);
    const paletteAt = createTerrainBiomeSampler(
      world.seed,
      world.voxelSize,
      world.generator.palette,
      world.generator.biomeField,
    );
    const volumeAt = createTerrainVolumeSampler(world);
    const overrides = new Map(world.edits.map((edit) => [`${edit.x},${edit.y},${edit.z}`, edit.value]));
    const check = (x: number, y: number, z: number) => {
      const key = `${x},${y},${z}`;
      const surface = surfaceAt(x, z);
      const palette = paletteAt(x, z);
      const layer = surface - y;
      const outside = x < -2048 || x >= 2048 || z < -32 || z >= 32 || y < -16 || y > 63;
      const solid = !outside && (mode === 'voxel3d' ? volumeAt(x, y, z) : y <= surface);
      const expected = overrides.has(key)
        ? (overrides.get(key) ?? undefined)
        : solid
          ? {
              color:
                layer < palette.surfaceDepth
                  ? palette.surface
                  : layer < palette.surfaceDepth + palette.subsurfaceDepth
                    ? palette.subsurface
                    : palette.deep,
              materialType: palette.materialType,
            }
          : undefined;
      assert.deepEqual(sample({ x, y, z }), expected, `Cell ${key} must match uncached generation.`);
    };
    const visitCave = () => {
      for (let x = -16; x <= 16; x++)
        for (let z = -8; z <= 8; z++) for (let y = 18; y <= 40; y++) check(x, y, z);
    };
    visitCave();
    // Cross more distinct columns than the bounded working set, then revisit the cave.
    for (let x = -1800; x <= 1800; x++) {
      const z = x % 17;
      const surface = surfaceAt(x, z);
      for (const y of [surface + 1, surface, surface - 3, -16]) check(x, y, z);
    }
    visitCave();
    for (const edit of world.edits) check(edit.x, edit.y, edit.z);
    for (const position of [
      [-2049, 0, 0],
      [2048, 0, 0],
      [0, 64, 0],
      [0, 0, -33],
      [0, -17, 0],
    ])
      check(...(position as [number, number, number]));

    const position = { x: 100, y: 0, z: 0 };
    const original = { ...sample(position)! };
    sample(position)!.color = 0;
    assert.deepEqual(sample(position), original, 'Generated cell objects cannot mutate the cached palette.');
  });
}
