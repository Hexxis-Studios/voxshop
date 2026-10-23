import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerrainCaveNetworkPath,
  createTerrainCaveNetworkConnectorSampler,
  createTerrainSurfaceSampler,
  createTerrainVolumeSampler,
  sampleTerrainOverhangHeightMap,
  terrainCaveBranches,
  terrainCaveCenterY,
  terrainCaveEntrance,
  terrainCaveEntrancesIn,
  terrainCaveNetworkBranchContains,
  terrainCaveNetworkBranches,
  terrainCaveNetworkContains,
  TERRAIN_CAVE_NETWORK_MAX_CONNECTORS_PER_TILE,
} from '../services/terrainNoise';
import { createWorldCellSampler, worldDocumentSchema } from '../services/worldDocument';

const makeWorld = (
  caveDensity?: number,
  overhangDensity?: number,
  overhangMaxHeight?: number,
  caveDepth?: number,
  caveBranchCount?: number,
  caveEntrancesPerRegion?: number,
  caveNetwork?: boolean,
  caveNetworkReach?: number,
) =>
  worldDocumentSchema.parse({
    id: 'cave-field',
    name: 'Cave field',
    seed: 1234,
    chunkSize: 16,
    voxelSize: 1,
    generator: {
      type: 'terrain',
      version: 1,
      mode: 'voxel3d',
      origin: [-64, -48],
      size: [128, 96],
      minY: -16,
      maxY: 80,
      baseHeight: 40,
      amplitude: 8,
      noise: 0,
      ...(caveDensity === undefined ? {} : { caveDensity }),
      ...(caveDepth === undefined ? {} : { caveDepth }),
      ...(caveBranchCount === undefined ? {} : { caveBranchCount }),
      ...(caveEntrancesPerRegion === undefined ? {} : { caveEntrancesPerRegion }),
      ...(caveNetwork === undefined ? {} : { caveNetwork }),
      ...(caveNetworkReach === undefined ? {} : { caveNetworkReach }),
      ...(overhangDensity === undefined ? {} : { overhangDensity }),
      ...(overhangMaxHeight === undefined ? {} : { overhangMaxHeight }),
      palette: { surface: 0x79a94e, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
    },
  });

test('optional cave field is deterministic and carves outside the legacy passage', () => {
  const legacyWorld = makeWorld();
  const caveWorld = makeWorld(0.65);
  const legacy = createTerrainVolumeSampler(legacyWorld);
  const caveField = createTerrainVolumeSampler(caveWorld);
  const repeated = createTerrainVolumeSampler(caveWorld);
  const differentSeed = createTerrainVolumeSampler({ ...caveWorld, seed: caveWorld.seed + 1 });

  assert.equal(legacy(0, 36, 0), false, 'the established demo passage remains present');
  assert.equal(legacy(-35, 18, -15), true, 'the legacy sampler is solid away from its passage');
  assert.equal(caveField(-35, 18, -15), false, 'the configured field carves outside the passage');

  const samples = [] as Array<[number, number, number]>;
  for (const x of [-35, -15, 0, 15, 35])
    for (const z of [-20, 0, 20])
      for (const y of [-14, 0, 14, 18, 26, 34, 37, 38, 40, 41]) samples.push([x, y, z]);
  assert.deepEqual(
    samples.map(([x, y, z]) => caveField(x, y, z)),
    samples.map(([x, y, z]) => repeated(x, y, z)),
    'the same seed and density produce identical occupancy',
  );
  assert.notDeepEqual(
    samples.filter(([x]) => Math.abs(x) > 12).map(([x, y, z]) => caveField(x, y, z)),
    samples.filter(([x]) => Math.abs(x) > 12).map(([x, y, z]) => differentSeed(x, y, z)),
    'the cave field changes with the world seed outside the legacy passage',
  );
});

test('cave field carving stays within descriptor bounds and below a surface cap', () => {
  const world = makeWorld(0.65);
  const surfaceAt = createTerrainSurfaceSampler(world);
  const legacy = createTerrainVolumeSampler(makeWorld());
  const caveField = createTerrainVolumeSampler(world);
  const generatedEntrances = terrainCaveEntrancesIn(world, {
    minX: world.generator.origin[0],
    maxX: world.generator.origin[0] + world.generator.size[0],
    minZ: world.generator.origin[1],
    maxZ: world.generator.origin[1] + world.generator.size[1],
  });

  for (let x = -68; x <= 68; x += 4) {
    for (let z = -52; z <= 52; z += 4) {
      const surface = surfaceAt(x, z);
      for (const y of [-16, -15, -14, 0, 14, 18, 26, 34, 37, 38, 39, 40, 41]) {
        if (legacy(x, y, z) && !caveField(x, y, z)) {
          assert.ok(
            x >= -64 && x < 64 && z >= -48 && z < 48,
            `carve at ${x},${y},${z} is inside the descriptor`,
          );
          assert.ok(y >= world.generator.minY + 2, `carve at ${x},${y},${z} keeps the bottom margin`);
          const connectedMouth = generatedEntrances.some(
            (entrance) => Math.abs(x - entrance.x) <= 1 && Math.abs(z - entrance.z) <= 1 && y >= surface - 3,
          );
          assert.ok(
            y <= surface - 3 || connectedMouth,
            `carve at ${x},${y},${z} stays below the cap or belongs to a generated cave mouth`,
          );
        }
      }
    }
  }

  assert.equal(caveField(64, 18, 0), legacy(64, 18, 0), 'the field does not carve beyond the X bound');
  assert.equal(caveField(0, 18, 48), legacy(0, 18, 48), 'the field does not carve beyond the Z bound');
  assert.equal(caveField(-35, -15, -15), legacy(-35, -15, -15), 'the field preserves the lower margin');
  assert.equal(caveField(-35, 38, -15), legacy(-35, 38, -15), 'the field preserves the surface cap');
});

test('omitted or zero cave density preserves legacy voxel occupancy', () => {
  const legacy = createTerrainVolumeSampler(makeWorld());
  const zero = createTerrainVolumeSampler(makeWorld(0));
  for (let x = -40; x <= 40; x += 3)
    for (let z = -24; z <= 24; z += 3)
      for (let y = -16; y <= 42; y += 2)
        assert.equal(zero(x, y, z), legacy(x, y, z), `legacy occupancy at ${x},${y},${z}`);
});

test('the finite cave passage supports deeper authored placement and clamps to vertical bounds', () => {
  const automatic = makeWorld();
  const deep = makeWorld(undefined, undefined, undefined, 28);
  const automaticCenter = terrainCaveCenterY(automatic);
  const deepCenter = terrainCaveCenterY(deep);
  const deepVolume = createTerrainVolumeSampler(deep);
  const entrance = terrainCaveEntrance(deep);

  assert.equal(automaticCenter, 36, 'zero/omitted depth keeps the previous amplitude-based placement');
  assert.equal(deepCenter, 12, 'a positive depth positions the passage below baseHeight');
  assert.equal(deepVolume(entrance.x, deepCenter, entrance.z), false, 'the authored deep passage is open');
  assert.equal(
    createWorldCellSampler(deep)({ x: entrance.x, y: deepCenter, z: entrance.z }),
    undefined,
    'portable world sampling agrees with the cave sampler',
  );
  assert.equal(
    deepVolume(entrance.x, automaticCenter, entrance.z + 7),
    true,
    'the old passage height remains solid beside the relocated shaft',
  );

  const lowWorld = worldDocumentSchema.parse({
    ...deep,
    generator: { ...deep.generator, minY: 8, caveDepth: 50 },
  });
  assert.equal(
    terrainCaveCenterY(lowWorld),
    11,
    'custom passage depth stays three cells inside the lower world bound',
  );
  const narrowWorld = worldDocumentSchema.parse({
    ...deep,
    generator: { ...deep.generator, minY: 0, maxY: 3, baseHeight: 3, caveDepth: 50 },
  });
  assert.ok(
    terrainCaveCenterY(narrowWorld) >= narrowWorld.generator.minY &&
      terrainCaveCenterY(narrowWorld) <= narrowWorld.generator.maxY,
    'narrow vertical worlds still clamp the passage center inside their bounds',
  );
});

test('optional cave side branches are deterministic, bounded and connected to the main passage', () => {
  const legacy = makeWorld();
  const branched = makeWorld(undefined, undefined, undefined, undefined, 4);
  const branches = terrainCaveBranches(branched);
  const repeated = terrainCaveBranches(branched);
  const cave = createTerrainVolumeSampler(branched);
  const legacyCave = createTerrainVolumeSampler(legacy);
  const centerY = terrainCaveCenterY(branched);

  assert.equal(branches.length, 4, 'The 128-cell-wide fixture fits the requested bounded branches.');
  assert.deepEqual(repeated, branches, 'Branch position, direction and length are seed-stable.');
  for (const branch of branches) {
    const endZ = branch.direction * branch.length;
    let foundOpenCell = false;
    for (let y = centerY - 4; y <= centerY + 4 && !foundOpenCell; y++)
      for (let x = branch.x - 4; x <= branch.x + 4; x++)
        if (!cave(x, y, endZ) && legacyCave(x, y, endZ)) {
          foundOpenCell = true;
          break;
        }
    assert.ok(foundOpenCell, `The branch ending at z=${endZ} reaches beyond the main passage.`);
  }
  assert.deepEqual(terrainCaveBranches(makeWorld(undefined, undefined, undefined, undefined, 0)), []);
});

test('opt-in cave network forms a curved connected trunk across the longer world axis', () => {
  const legacyWorld = makeWorld();
  const networkWorld = makeWorld(undefined, undefined, undefined, undefined, undefined, undefined, true);
  const legacy = createTerrainVolumeSampler(legacyWorld);
  const volume = createTerrainVolumeSampler(networkWorld);
  const path = createTerrainCaveNetworkPath(networkWorld);
  assert.ok(path);
  assert.equal(path.axis, 'x');
  assert.equal(createTerrainCaveNetworkPath(legacyWorld), null);

  let previousSlice = new Set<string>();
  for (let x = -60; x <= 60; x++) {
    const center = path.at(x);
    const open = new Set<string>();
    for (let y = center.y - 3; y <= center.y + 3; y++)
      for (let z = Math.floor(center.z) - 4; z <= Math.floor(center.z) + 4; z++)
        if (terrainCaveNetworkContains(path, x, y, z) && !volume(x, y, z)) open.add(`${y},${z}`);
    assert.ok(open.size > 0, `the network tunnel remains open at x=${x}`);
    if (x > -60)
      assert.ok(
        [...open].some((cell) => previousSlice.has(cell)),
        `the x=${x - 1} and x=${x} cave cross-sections overlap`,
      );
    previousSlice = open;
  }

  const center = path.at(0);
  const surface = createTerrainSurfaceSampler(networkWorld)(center.x, center.z);
  for (let y = center.y; y <= surface; y++)
    assert.equal(volume(0, y, 0), false, `the central entrance connects through y=${y}`);
  assert.equal(legacy(-60, 34, 0), true, 'omitting the option preserves the old finite cave extent');

  const zMajor = worldDocumentSchema.parse({
    ...networkWorld,
    generator: { ...networkWorld.generator, origin: [-48, -64], size: [96, 128] },
  });
  const zPath = createTerrainCaveNetworkPath(zMajor);
  assert.ok(zPath);
  assert.equal(zPath.axis, 'z', 'the trunk follows the longer axis when depth exceeds width');
  assert.equal(
    volume(10_000, center.y, 10_000),
    true,
    'out-of-bounds queries are never carved by the network',
  );
});

test('authored cave-network branches are seeded, bounded and carved away from the trunk', () => {
  const branched = makeWorld(undefined, undefined, undefined, undefined, 4, undefined, true);
  const unbranched = makeWorld(undefined, undefined, undefined, undefined, 0, undefined, true);
  const local = makeWorld(undefined, undefined, undefined, undefined, 0, undefined, false);
  const path = createTerrainCaveNetworkPath(branched);
  assert.ok(path);
  const branches = terrainCaveNetworkBranches(branched, path);
  assert.equal(branches.length, 4);
  assert.deepEqual(
    terrainCaveNetworkBranches(branched, path),
    branches,
    'branch descriptors are seed-stable',
  );
  const volume = createTerrainVolumeSampler(branched);
  const withoutBranches = createTerrainVolumeSampler(unbranched);
  const withoutNetwork = createTerrainVolumeSampler(local);

  for (const branch of branches) {
    const center = path.at(branch.along);
    const crossCenter = path.axis === 'x' ? center.z : center.x;
    const distance = Math.min(4, branch.length - 1);
    const cross = Math.round(crossCenter + branch.direction * distance);
    const x = path.axis === 'x' ? branch.along : cross;
    const z = path.axis === 'x' ? cross : branch.along;
    const y = Math.floor(center.y);
    assert.ok(terrainCaveNetworkBranchContains(path, branch, x, y, z));
    assert.equal(volume(x, y, z), false, 'the authored side passage is carved');
    assert.equal(withoutBranches(x, y, z), true, 'the same trunk without side branches remains solid here');
    assert.equal(withoutNetwork(x, y, z), true, 'the finite legacy cave stays unchanged');
    assert.ok(
      (path.axis === 'x' ? x : z) >=
        (path.axis === 'x' ? branched.generator.origin[0] : branched.generator.origin[1]) &&
        (path.axis === 'x' ? x : z) <
          (path.axis === 'x'
            ? branched.generator.origin[0] + branched.generator.size[0]
            : branched.generator.origin[1] + branched.generator.size[1]),
      'every branch remains within the world descriptor',
    );
  }
});

test('optional overhang field creates deterministic connected solids with a strict height cap', () => {
  const world = makeWorld(undefined, 0.8);
  const surfaceAt = createTerrainSurfaceSampler(world);
  const volumeAt = createTerrainVolumeSampler(world, surfaceAt);
  const repeated = createTerrainVolumeSampler(world, surfaceAt);
  const cells = createWorldCellSampler(world);
  let column: { x: number; z: number; surface: number } | undefined;
  for (let z = -48; z < 48 && !column; z++)
    for (let x = -64; x < 64; x++)
      if (volumeAt(x, surfaceAt(x, z) + 1, z)) {
        column = { x, z, surface: surfaceAt(x, z) };
        break;
      }
  assert.ok(column, 'The configured seed and density produce a connected overhang in the descriptor.');

  let top = column.surface;
  while (top < column.surface + 8 && volumeAt(column.x, top + 1, column.z)) top++;
  assert.ok(top > column.surface, 'The overhang begins directly above its heightfield column.');
  assert.ok(top <= column.surface + 8, 'The overhang does not exceed its eight-cell bound.');
  assert.equal(
    volumeAt(column.x, top + 1, column.z),
    false,
    'The generated column has no disconnected upper layer.',
  );
  for (let y = column.surface + 1; y <= top; y++) {
    assert.equal(volumeAt(column.x, y, column.z), true);
    assert.equal(repeated(column.x, y, column.z), true, 'The same seed reproduces every overhang cell.');
    assert.ok(
      cells({ x: column.x, y, z: column.z }),
      'The ordinary world cell sampler includes overhang voxels.',
    );
  }
  assert.equal(volumeAt(column.x, column.surface + 9, column.z), false, 'The hard cap remains empty.');
  assert.equal(volumeAt(64, 41, 0), false, 'Overhangs stay within the world descriptor.');

  const legacyMouth = terrainCaveEntrance(world);
  assert.equal(
    volumeAt(legacyMouth.x, surfaceAt(legacyMouth.x, legacyMouth.z) + 1, legacyMouth.z),
    false,
    'The original cave shaft stays open through the optional field.',
  );
});

test('overhang height can exceed the legacy default while keeping a deterministic hard bound', () => {
  const world = makeWorld(undefined, 1, 24);
  const surfaceAt = createTerrainSurfaceSampler(world);
  const volumeAt = createTerrainVolumeSampler(world, surfaceAt);
  const repeated = createTerrainVolumeSampler(world, surfaceAt);
  const cells = createWorldCellSampler(world);
  let tallest: { x: number; z: number; surface: number; top: number } | undefined;

  for (let z = -48; z < 48 && !tallest; z++) {
    for (let x = -64; x < 64; x++) {
      const surface = surfaceAt(x, z);
      let top = surface;
      while (top < surface + 24 && volumeAt(x, top + 1, z)) top++;
      if (top === surface + 24) {
        tallest = { x, z, surface, top };
        break;
      }
    }
  }

  assert.ok(tallest, 'The seeded high-density field reaches the configured 24-cell cap.');
  assert.equal(volumeAt(tallest.x, tallest.top, tallest.z), true);
  assert.equal(volumeAt(tallest.x, tallest.top + 1, tallest.z), false);
  assert.equal(repeated(tallest.x, tallest.top, tallest.z), true);
  assert.ok(cells({ x: tallest.x, y: tallest.top, z: tallest.z }));
});

test('authored overhang layer-density profiles taper connected columns and remain deterministic', () => {
  const uniformWorld = makeWorld(undefined, 1, 24);
  const surfaceAt = createTerrainSurfaceSampler(uniformWorld);
  const uniform = createTerrainVolumeSampler(uniformWorld, surfaceAt);
  let column: { x: number; z: number; surface: number } | undefined;
  for (let z = -48; z < 48 && !column; z++) {
    for (let x = -64; x < 64; x++) {
      const surface = surfaceAt(x, z);
      if (uniform(x, surface + 24, z)) {
        column = { x, z, surface };
        break;
      }
    }
  }
  assert.ok(column, 'The seeded uniform field reaches its configured cap at this fixture seed.');

  const profiledWorld = worldDocumentSchema.parse({
    ...uniformWorld,
    generator: { ...uniformWorld.generator, overhangProfile: [1, 0] },
  });
  const profiled = createTerrainVolumeSampler(profiledWorld, surfaceAt);
  const repeated = createTerrainVolumeSampler(profiledWorld, surfaceAt);
  assert.equal(profiled(column.x, column.surface + 1, column.z), true);
  assert.equal(profiled(column.x, column.surface + 24, column.z), false);
  for (let layer = 1; layer < 24; layer++)
    assert.equal(
      profiled(column.x, column.surface + layer, column.z),
      repeated(column.x, column.surface + layer, column.z),
    );
  assert.equal(
    worldDocumentSchema.safeParse({
      ...profiledWorld,
      generator: { ...profiledWorld.generator, overhangProfile: Array(65).fill(1) },
    }).success,
    false,
    'A profile cannot exceed the 64-cell generator limit.',
  );
  assert.equal(
    worldDocumentSchema.safeParse({
      ...profiledWorld,
      generator: { ...profiledWorld.generator, overhangProfile: [1, 1.01] },
    }).success,
    false,
    'Profile samples stay normalized to 0–1.',
  );
});

test('authored horizontal overhang footprints mask and preserve seeded regions', () => {
  const seededWorld = makeWorld(undefined, 1, 8);
  const surfaceAt = createTerrainSurfaceSampler(seededWorld);
  const seeded = createTerrainVolumeSampler(seededWorld, surfaceAt);
  const footprintWorld = worldDocumentSchema.parse({
    ...seededWorld,
    generator: { ...seededWorld.generator, overhangFootprint: [Array(2).fill(0), Array(2).fill(1)] },
  });
  const footprint = createTerrainVolumeSampler(footprintWorld, surfaceAt);
  const { origin, size } = footprintWorld.generator;
  const firstZ = origin[1];
  const lastZ = origin[1] + size[1] - 1;
  for (let x = origin[0]; x < origin[0] + size[0]; x++)
    assert.equal(
      footprint(x, surfaceAt(x, firstZ) + 1, firstZ),
      false,
      'A zero-density footprint row suppresses overhangs across its full width.',
    );

  let preserved: { x: number; surface: number } | undefined;
  for (let x = origin[0]; x < origin[0] + size[0]; x++) {
    const surface = surfaceAt(x, lastZ);
    if (seeded(x, surface + 1, lastZ)) {
      preserved = { x, surface };
      break;
    }
  }
  assert.ok(preserved, 'The fixture seed generates an overhang in the full-density footprint row.');
  for (let layer = 1; layer <= 8; layer++)
    assert.equal(
      footprint(preserved.x, preserved.surface + layer, lastZ),
      seeded(preserved.x, preserved.surface + layer, lastZ),
      'A full-density footprint row preserves the original seeded column.',
    );

  assert.equal(
    worldDocumentSchema.safeParse({
      ...footprintWorld,
      generator: { ...footprintWorld.generator, overhangFootprint: [[0], [0, 1]] },
    }).success,
    false,
    'Footprint rows must be rectangular.',
  );
  assert.equal(
    worldDocumentSchema.safeParse({
      ...footprintWorld,
      generator: { ...footprintWorld.generator, overhangFootprint: [[0, 1.01]] },
    }).success,
    false,
    'Footprint density samples remain normalized to 0–1.',
  );
});

test('authored overhang height maps create exact interpolated columns without seeded noise', () => {
  const base = makeWorld(undefined, 1, 8);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      overhangProfile: [0],
      overhangFootprint: [[0]],
      overhangHeightMap: [
        [0, 0, 1],
        [0, 0.5, 0],
        [0, 0.5, 0],
      ],
    },
  });
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const { origin } = selected.generator;
  assert.equal(sampleTerrainOverhangHeightMap(selected, origin[0], origin[1]), 0);
  assert.equal(volumeAt(origin[0], surfaceAt(origin[0], origin[1]) + 1, origin[1]), false);

  const fullX = origin[0] + selected.generator.size[0] - 1;
  const fullZ = origin[1];
  const fullSurface = surfaceAt(fullX, fullZ);
  assert.equal(sampleTerrainOverhangHeightMap(selected, fullX, fullZ), 8);
  for (let layer = 1; layer <= 8; layer++) assert.equal(volumeAt(fullX, fullSurface + layer, fullZ), true);
  assert.equal(volumeAt(fullX, fullSurface + 9, fullZ), false);

  assert.equal(sampleTerrainOverhangHeightMap(selected, 0, -10), 3);
  assert.equal(volumeAt(0, surfaceAt(0, -10) + 3, -10), true);
  assert.equal(volumeAt(0, surfaceAt(0, -10) + 4, -10), false);

  assert.equal(
    worldDocumentSchema.safeParse({
      ...selected,
      generator: { ...selected.generator, overhangHeightMap: [[0], [0, 1]] },
    }).success,
    false,
    'Height-map rows must be rectangular.',
  );
  assert.equal(
    worldDocumentSchema.safeParse({
      ...selected,
      generator: { ...selected.generator, overhangHeightMap: [[0, 1.01]] },
    }).success,
    false,
    'Height-map samples stay normalized to 0–1.',
  );
});

test('zero overhang density preserves the legacy surface boundary', () => {
  const world = makeWorld(undefined, 0);
  const surfaceAt = createTerrainSurfaceSampler(world);
  const volumeAt = createTerrainVolumeSampler(world, surfaceAt);
  for (const [x, z] of [
    [-64, -48],
    [-35, -15],
    [0, 0],
    [31, 25],
    [63, 47],
  ])
    assert.equal(
      volumeAt(x, surfaceAt(x, z) + 1, z),
      false,
      `No generated solid appears above the heightfield at ${x},${z}.`,
    );
});

test('cave-field mouths are deterministic, bounded and connected to carved volume', () => {
  const base = makeWorld(0.65);
  const world = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [-512, -512], size: [1024, 1024], overhangDensity: 0.8 },
  });
  const surfaceAt = createTerrainSurfaceSampler(world);
  const volumeAt = createTerrainVolumeSampler(world, surfaceAt);
  const bounds = { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
  const entrances = terrainCaveEntrancesIn(world, bounds, surfaceAt);
  const repeated = terrainCaveEntrancesIn(world, bounds, surfaceAt);
  assert.ok(
    entrances.length > 0,
    'A sufficiently cave-dense seeded world opens at least one field-connected mouth.',
  );
  assert.deepEqual(entrances, repeated, 'The same seed produces stable cave mouths.');
  assert.equal(new Set(entrances.map(({ x, z }) => `${x},${z}`)).size, entrances.length);
  assert.equal(
    new Set(entrances.map(({ x, z }) => `${Math.floor(x / 256)},${Math.floor(z / 256)}`)).size,
    entrances.length,
    'Each 256×256-cell region emits at most one generated mouth.',
  );

  const narrow = terrainCaveEntrancesIn(world, { minX: -256, maxX: 256, minZ: -256, maxZ: 256 }, surfaceAt);
  assert.deepEqual(
    narrow,
    entrances.filter(({ x, z }) => x >= -257 && x <= 256 && z >= -257 && z <= 256),
    'A tile query returns only mouths whose 3×3 opening can overlap that tile.',
  );

  for (const entrance of entrances) {
    assert.ok(entrance.x >= bounds.minX && entrance.x < bounds.maxX);
    assert.ok(entrance.z >= bounds.minZ && entrance.z < bounds.maxZ);
    let reachesCaveBelowShaft = false;
    for (let z = entrance.z - 1; z <= entrance.z + 1; z++) {
      for (let x = entrance.x - 1; x <= entrance.x + 1; x++) {
        const surface = surfaceAt(x, z);
        assert.equal(volumeAt(x, surface, z), false, `The surface mouth is open at ${x},${z}.`);
        assert.equal(volumeAt(x, surface - 3, z), false, `The shaft connects through its cap at ${x},${z}.`);
        assert.equal(
          volumeAt(x, surface + 1, z),
          false,
          `The mouth clears overhangs above the surface at ${x},${z}.`,
        );
        if (!volumeAt(x, surface - 4, z)) reachesCaveBelowShaft = true;
      }
    }
    assert.ok(reachesCaveBelowShaft, 'The forced surface shaft opens directly into the seeded cave field.');
  }

  assert.deepEqual(
    terrainCaveEntrancesIn(makeWorld(0), bounds),
    [],
    'Zero density retains the established finite passage without adding field mouths.',
  );
});

test('cave-mouth count is bounded per region and additional shafts connect to the seeded field', () => {
  const base = makeWorld(1, undefined, undefined, undefined, undefined, 4);
  const world = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [-512, -512], size: [1024, 1024] },
  });
  const surfaceAt = createTerrainSurfaceSampler(world);
  const volumeAt = createTerrainVolumeSampler(world, surfaceAt);
  const bounds = { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
  const entrances = terrainCaveEntrancesIn(world, bounds, surfaceAt);
  const byRegion = new Map<string, typeof entrances>();
  for (const entrance of entrances) {
    const key = `${Math.floor(entrance.x / 256)},${Math.floor(entrance.z / 256)}`;
    const region = byRegion.get(key) ?? [];
    region.push(entrance);
    byRegion.set(key, region);
  }

  assert.ok(
    [...byRegion.values()].some((region) => region.length === 4),
    'A dense field reaches the four-mouth limit.',
  );
  assert.deepEqual(entrances, terrainCaveEntrancesIn(world, bounds, surfaceAt));
  for (const region of byRegion.values()) assert.ok(region.length <= 4);
  for (const entrance of entrances)
    for (let z = entrance.z - 1; z <= entrance.z + 1; z++)
      for (let x = entrance.x - 1; x <= entrance.x + 1; x++) {
        const surface = surfaceAt(x, z);
        assert.equal(volumeAt(x, surface, z), false, 'Every generated mouth opens at the surface.');
        assert.equal(volumeAt(x, surface - 3, z), false, 'Every generated shaft connects to the cave field.');
      }

  const disabled = worldDocumentSchema.parse({
    ...world,
    generator: { ...world.generator, caveEntrancesPerRegion: 0 },
  });
  assert.deepEqual(
    terrainCaveEntrancesIn(disabled, bounds),
    [],
    'Zero disables only generated field mouths.',
  );
});

test('generated cave-field mouths connect to the world trunk in either axis without changing legacy worlds', () => {
  for (const fixture of [
    { origin: [-512, -64] as [number, number], size: [1024, 128] as [number, number], axis: 'x' },
    { origin: [-64, -512] as [number, number], size: [128, 1024] as [number, number], axis: 'z' },
  ]) {
    const template = makeWorld(0.65);
    const base = worldDocumentSchema.parse({
      ...template,
      generator: { ...template.generator, origin: fixture.origin, size: fixture.size },
    });
    const connected = worldDocumentSchema.parse({
      ...base,
      generator: { ...base.generator, caveNetwork: true },
    });
    const path = createTerrainCaveNetworkPath(connected);
    assert.ok(path);
    assert.equal(path.axis, fixture.axis);
    const surfaceAt = createTerrainSurfaceSampler(connected);
    const bounds = {
      minX: fixture.origin[0],
      maxX: fixture.origin[0] + fixture.size[0],
      minZ: fixture.origin[1],
      maxZ: fixture.origin[1] + fixture.size[1],
    };
    const entrance = terrainCaveEntrancesIn(connected, bounds, surfaceAt).find(({ x, z }) => {
      const point = path.at(path.axis === 'x' ? x : z);
      return Math.abs(path.axis === 'x' ? z - point.z : x - point.x) > 8;
    });
    assert.ok(entrance, `the ${fixture.axis}-major fixture produces an entrance away from its trunk`);

    const connectedVolume = createTerrainVolumeSampler(connected, surfaceAt);
    const legacyVolume = createTerrainVolumeSampler(base, surfaceAt);
    const pathPoint = path.at(path.axis === 'x' ? entrance.x : entrance.z);
    const mouthY = surfaceAt(entrance.x, entrance.z) - 3;
    let foundPreviouslySolidCell = false;
    const assertConnectorSegment = (
      start: [number, number, number],
      end: [number, number, number],
      label: string,
    ) => {
      const steps = Math.max(
        1,
        Math.ceil(
          Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]), Math.abs(end[2] - start[2])),
        ),
      );
      for (let index = 0; index <= steps; index++) {
        const t = index / steps;
        const x = Math.round(start[0] + (end[0] - start[0]) * t);
        const y = Math.round(start[1] + (end[1] - start[1]) * t);
        const z = Math.round(start[2] + (end[2] - start[2]) * t);
        assert.ok(y <= surfaceAt(x, z) - 3, `the ${label} stays below the surface cap at ${x},${y},${z}`);
        assert.equal(
          connectedVolume(x, y, z),
          false,
          `the connected ${label} is open at ${x},${y},${z} (${fixture.axis}; mouth=${JSON.stringify(entrance)}; trunk=${JSON.stringify(pathPoint)})`,
        );
        if (legacyVolume(x, y, z)) foundPreviouslySolidCell = true;
      }
    };

    const bend: [number, number, number] = [entrance.x, pathPoint.y, entrance.z];
    const mouth: [number, number, number] = [entrance.x, mouthY, entrance.z];
    const trunk: [number, number, number] = [pathPoint.x, pathPoint.y, pathPoint.z];
    assertConnectorSegment(mouth, bend, 'vertical entrance shaft');
    assertConnectorSegment(bend, trunk, 'lateral trunk connector');
    assert.ok(
      foundPreviouslySolidCell,
      'the connector bridges at least one solid gap in the independent cave field',
    );
  }
});

test('caveNetworkReach authorably connects cave mouths beyond the compatibility default', () => {
  const source = makeWorld(0.65, undefined, undefined, undefined, undefined, 4, true),
    base = worldDocumentSchema.parse({
      ...source,
      generator: { ...source.generator, origin: [-512, -512], size: [1024, 1024] },
    }),
    extended = worldDocumentSchema.parse({
      ...base,
      generator: { ...base.generator, caveNetworkReach: 512 },
    }),
    path = createTerrainCaveNetworkPath(extended)!;
  const surfaceAt = createTerrainSurfaceSampler(extended),
    bounds = { minX: -512, maxX: 512, minZ: -512, maxZ: 512 },
    entrance = terrainCaveEntrancesIn(extended, bounds, surfaceAt)
      .map((mouth) => {
        const trunk = path.at(path.axis === 'x' ? mouth.x : mouth.z),
          mouthCross = path.axis === 'x' ? mouth.z : mouth.x,
          trunkCross = path.axis === 'x' ? trunk.z : trunk.x;
        return { mouth, trunk, reach: Math.abs(mouthCross - trunkCross) };
      })
      .find(({ reach }) => reach > 300 && reach <= 512);
  assert.ok(
    entrance,
    'the deterministic 1024×1024 fixture has a mouth between 300 and 512 cells from its trunk',
  );

  const defaultVolume = createTerrainVolumeSampler(base, surfaceAt),
    extendedVolume = createTerrainVolumeSampler(extended, surfaceAt),
    noLinks = worldDocumentSchema.parse({
      ...base,
      generator: { ...base.generator, caveNetworkReach: 0 },
    }),
    noLinkVolume = createTerrainVolumeSampler(noLinks, surfaceAt),
    mid = {
      x: Math.round((entrance.mouth.x + entrance.trunk.x) / 2),
      y: Math.round(entrance.trunk.y),
      z: Math.round((entrance.mouth.z + entrance.trunk.z) / 2),
    };
  assert.equal(defaultVolume(mid.x, mid.y, mid.z), true, 'old worlds keep the 256-cell connector reach');
  assert.equal(noLinkVolume(mid.x, mid.y, mid.z), true, '0 disables generated mouth-to-trunk connectors');
  assert.equal(
    extendedVolume(mid.x, mid.y, mid.z),
    false,
    'the authored 512-cell reach opens the longer connector',
  );
});

test('distant cave connector descriptors are deterministic and bounded per aligned tile', () => {
  const source = makeWorld(1, undefined, undefined, undefined, undefined, 4, true, 4096);
  const large = worldDocumentSchema.parse({
    ...source,
    generator: { ...source.generator, origin: [-8192, -8192], size: [16384, 16384] },
  });
  const tile = { minX: 0, maxX: 256, minZ: 0, maxZ: 256 };
  const connectorsIn = createTerrainCaveNetworkConnectorSampler(large);
  const connectors = connectorsIn(tile);
  assert.ok(connectors.length > 0, 'the high-density world generates connected cave mouths in the tile');
  assert.ok(connectors.length <= TERRAIN_CAVE_NETWORK_MAX_CONNECTORS_PER_TILE);
  assert.deepEqual(
    connectorsIn(tile),
    connectors,
    'the same world and tile return the same sorted descriptors',
  );
  assert.deepEqual(
    connectors.map(({ shaft }) => [shaft[0][0], shaft[0][2]]),
    [...connectors]
      .map(({ shaft }) => [shaft[0][0], shaft[0][2]])
      .sort(([ax, az], [bx, bz]) => ax - bx || az - bz),
  );

  const disabled = worldDocumentSchema.parse({
    ...large,
    generator: { ...large.generator, caveNetworkReach: 0 },
  });
  assert.deepEqual(
    createTerrainCaveNetworkConnectorSampler(disabled)(tile),
    [],
    'zero reach retains the established no-link behavior',
  );
});
