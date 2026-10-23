import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorldCellSampler, worldDocumentSchema } from '../services/worldDocument';
import { buildCoarseWorldVoxelChunk } from '../runtime/worldVoxelLod';
import { createTerrainCaveNetworkPath, terrainCaveNetworkBranches } from '../services/terrainNoise';

const world = worldDocumentSchema.parse({
  id: 'coarse-world',
  name: 'Coarse world',
  seed: 1,
  chunkSize: 16,
  voxelSize: 1,
  generator: {
    type: 'terrain',
    version: 1,
    mode: 'voxel3d',
    origin: [0, 0],
    size: [16, 16],
    minY: 0,
    maxY: 15,
    baseHeight: 0,
    amplitude: 0,
    noise: 0,
    palette: { surface: 0x777777, subsurface: 0x666666, deep: 0x555555, materialType: 'STANDARD' },
  },
  edits: [],
});
const coordinate = { x: 0, y: 0, z: 0 };
const at =
  (cells: Map<string, { color: number; materialType: 'STANDARD' | 'METALLIC' | 'GLASS' | 'EMISSIVE' }>) =>
  ({ x, y, z }: { x: number; y: number; z: number }) =>
    cells.get(`${x},${y},${z}`);

test('empty coarse chunks are omitted and sparse surface solids retain occupancy', () => {
  assert.equal(
    buildCoarseWorldVoxelChunk(world, coordinate, () => undefined),
    null,
  );
  const built = buildCoarseWorldVoxelChunk(
    world,
    coordinate,
    at(new Map([['1,1,1', { color: 0x884422, materialType: 'STANDARD' }]])),
  );
  assert.ok(built);
  assert.equal(built.voxelCellCount, 1);
  built.geometry.dispose();
});

test('underground cave LOD retains broad and narrow passages without eroding surface silhouettes', () => {
  const caveWorld = worldDocumentSchema.parse({
    ...world,
    generator: { ...world.generator, minY: -32, maxY: 64, baseHeight: 32 },
  });
  const makeCells = (factor: number, count: number, yOffset = 0) => {
    const cells = new Map<string, { color: number; materialType: 'STANDARD' }>();
    let index = 0;
    for (let y = 0; y < factor; y++)
      for (let z = 0; z < factor; z++)
        for (let x = 0; x < factor; x++, index++)
          if (index < count)
            cells.set(`${x},${y + yOffset},${z}`, { color: 0x884422, materialType: 'STANDARD' });
    return cells;
  };
  const withSolidChunkDefault =
    (cells: Map<string, { color: number; materialType: 'STANDARD' }>) =>
    ({ x, y, z }: { x: number; y: number; z: number }) => {
      if (x < 0 || x >= 16 || y < 0 || y >= 16 || z < 0 || z >= 16) return undefined;
      return cells.get(`${x},${y},${z}`) ?? { color: 0x884422, materialType: 'STANDARD' as const };
    };

  const openFactorTwoCell = buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(makeCells(2, 3)), 2);
  assert.equal(openFactorTwoCell, null, 'A broad underground void stays open in cave LOD.');

  const solidFactorTwoSamples = makeCells(2, 8);
  for (const cell of [
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
  ])
    solidFactorTwoSamples.delete(cell.join(','));
  const solidFactorTwoCell = buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(solidFactorTwoSamples), 2);
  assert.ok(solidFactorTwoCell, 'A majority-solid underground source cell remains visible.');
  solidFactorTwoCell.geometry.dispose();

  const tiedFactorTwoSamples = makeCells(2, 8);
  for (const cell of [
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ])
    tiedFactorTwoSamples.delete(cell.join(','));
  const tiedFactorTwoCell = buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(tiedFactorTwoSamples), 2);
  assert.ok(tiedFactorTwoCell, 'A tie keeps occupancy to avoid eroding a borderline cave wall.');
  tiedFactorTwoCell.geometry.dispose();

  const openFactorFourCell = buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(makeCells(4, 31)), 4);
  assert.equal(openFactorFourCell, null, 'Broad voids stay open in factor-four cave LOD.');

  const broadFactorEightCave = makeCells(16, 4096);
  for (let y = 0; y < 8; y++)
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) broadFactorEightCave.delete(`${x},${y},${z}`);
  const broadFactorEightChunk = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    at(broadFactorEightCave),
    8,
  );
  assert.ok(broadFactorEightChunk, 'Solid neighboring cells still mesh around a factor-eight cave void.');
  assert.equal(
    broadFactorEightChunk.voxelCellCount,
    7,
    'The broad eight-by-eight-by-eight source cave stays open.',
  );
  broadFactorEightChunk.geometry.dispose();

  const narrowFactorTwoPassage = makeCells(2, 8);
  narrowFactorTwoPassage.delete('0,0,0');
  narrowFactorTwoPassage.delete('1,0,0');
  const openFactorTwoPassage = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    at(narrowFactorTwoPassage),
    2,
  );
  assert.equal(openFactorTwoPassage, null, 'A connected one-cell passage stays open in factor-two cave LOD.');

  const narrowFactorFourPassage = makeCells(4, 64);
  for (let x = 0; x < 4; x++) narrowFactorFourPassage.delete(`${x},1,1`);
  const openFactorFourPassage = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    at(narrowFactorFourPassage),
    4,
  );
  assert.equal(
    openFactorFourPassage,
    null,
    'A connected one-cell passage stays open in factor-four cave LOD.',
  );

  const narrowFactorEightPassage = makeCells(8, 512);
  for (let x = 0; x < 8; x++) narrowFactorEightPassage.delete(`${x},3,3`);
  const openFactorEightPassage = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    at(narrowFactorEightPassage),
    8,
  );
  assert.equal(
    openFactorEightPassage,
    null,
    'A connected one-cell passage stays open in factor-eight cave LOD.',
  );

  const upperFactorEightPassage = makeCells(8, 512);
  for (let x = 0; x < 8; x++) upperFactorEightPassage.delete(`${x},6,6`);
  assert.equal(
    buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(upperFactorEightPassage), 8),
    null,
    'Factor-eight connectivity retains passages whose source indices exceed one byte.',
  );

  const disconnectedFactorFourVoids = makeCells(4, 64);
  for (const cell of [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
  ])
    disconnectedFactorFourVoids.delete(cell.join(','));
  const solidDisconnectedCaveCell = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    withSolidChunkDefault(disconnectedFactorFourVoids),
    4,
  );
  assert.ok(solidDisconnectedCaveCell, 'Disconnected air specks do not carve a coarse cave cell.');
  solidDisconnectedCaveCell.geometry.dispose();

  const disconnectedFactorEightVoids = makeCells(8, 512);
  for (const cell of [
    [0, 0, 0],
    [2, 2, 2],
    [4, 4, 4],
    [6, 6, 6],
  ])
    disconnectedFactorEightVoids.delete(cell.join(','));
  const solidDisconnectedFactorEightCell = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    withSolidChunkDefault(disconnectedFactorEightVoids),
    8,
  );
  assert.ok(
    solidDisconnectedFactorEightCell,
    'Disconnected air specks do not carve a factor-eight cave cell.',
  );
  solidDisconnectedFactorEightCell.geometry.dispose();

  const narrowFactorSixteenPassage = makeCells(16, 4096);
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 8; y++)
      for (let z = 0; z < 8; z++) narrowFactorSixteenPassage.delete(`${x},${y},${z}`);
  const openFactorSixteenPassage = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    at(narrowFactorSixteenPassage),
    16,
  );
  assert.equal(
    openFactorSixteenPassage,
    null,
    'A connected through-passage remains open in the factor-sixteen cave cell.',
  );

  const bentFactorSixteenPassage = makeCells(16, 4096);
  for (let x = 0; x <= 8; x++) bentFactorSixteenPassage.delete(`${x},8,8`);
  for (let z = 9; z < 16; z++) bentFactorSixteenPassage.delete(`8,8,${z}`);
  assert.equal(
    buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(bentFactorSixteenPassage), 16),
    null,
    'A cave passage that turns between adjacent coarse-cell faces remains connected.',
  );

  const bentCaveWorld = worldDocumentSchema.parse({
    ...caveWorld,
    generator: { ...caveWorld.generator, size: [64, 64], baseHeight: 40 },
  });
  const shortBentCave = new Map<string, { color: number; materialType: 'STANDARD' }>();
  const openSourceCells = new Set<string>();
  for (let y = 16; y < 32; y++)
    for (let z = 16; z < 32; z++)
      for (let x = 16; x < 32; x++)
        shortBentCave.set(`${x},${y},${z}`, { color: 0x884422, materialType: 'STANDARD' });
  shortBentCave.set('15,24,24', { color: 0x884422, materialType: 'STANDARD' });
  shortBentCave.set('17,15,24', { color: 0x884422, materialType: 'STANDARD' });
  for (let x = 16; x <= 17; x++) openSourceCells.add(`${x},24,24`);
  for (let y = 16; y < 24; y++) openSourceCells.add(`17,${y},24`);
  const shortBentCellAt = ({ x, y, z }: { x: number; y: number; z: number }) => {
    const key = `${x},${y},${z}`;
    return openSourceCells.has(key) ? undefined : shortBentCave.get(key);
  };
  const shortUncontinuedTurn = buildCoarseWorldVoxelChunk(
    bentCaveWorld,
    { x: 1, y: 1, z: 1 },
    shortBentCellAt,
    16,
  );
  assert.ok(shortUncontinuedTurn, 'A short, unconnected corner pocket stays solid at coarse LOD.');
  shortUncontinuedTurn.geometry.dispose();

  shortBentCave.delete('15,24,24');
  shortBentCave.delete('17,15,24');
  assert.equal(
    buildCoarseWorldVoxelChunk(bentCaveWorld, { x: 1, y: 1, z: 1 }, shortBentCellAt, 16),
    null,
    'A sub-resolution cave bend remains open when both touched coarse faces continue into deep air.',
  );

  const disconnectedFactorSixteenVoids = makeCells(16, 4096);
  for (const cell of [
    [0, 0, 0],
    [5, 5, 5],
    [10, 10, 10],
    [15, 15, 15],
  ])
    disconnectedFactorSixteenVoids.delete(cell.join(','));
  const solidDisconnectedFactorSixteenCell = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    withSolidChunkDefault(disconnectedFactorSixteenVoids),
    16,
  );
  assert.ok(
    solidDisconnectedFactorSixteenCell,
    'Disconnected air specks do not hollow a factor-sixteen cave cell.',
  );
  solidDisconnectedFactorSixteenCell.geometry.dispose();

  const enclosedCavernFactorSixteen = makeCells(16, 4096);
  for (let y = 4; y < 12; y++)
    for (let z = 4; z < 12; z++)
      for (let x = 4; x < 12; x++) enclosedCavernFactorSixteen.delete(`${x},${y},${z}`);
  assert.equal(
    buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(enclosedCavernFactorSixteen), 16),
    null,
    'A broad enclosed cave-field cavern remains open in the coarsest cave cell.',
  );

  const boundaryCavernFactorSixteen = makeCells(16, 4096);
  for (let y = 4; y < 12; y++)
    for (let z = 4; z < 12; z++)
      for (let x = 4; x < 8; x++) boundaryCavernFactorSixteen.delete(`${x},${y},${z}`);
  assert.equal(
    buildCoarseWorldVoxelChunk(caveWorld, coordinate, at(boundaryCavernFactorSixteen), 16),
    null,
    'A broad cave crossing a source-chunk boundary keeps its half-room open.',
  );

  const smallEnclosedPocketFactorSixteen = makeCells(16, 4096);
  for (let y = 6; y < 10; y++)
    for (let z = 6; z < 10; z++)
      for (let x = 6; x < 10; x++) smallEnclosedPocketFactorSixteen.delete(`${x},${y},${z}`);
  const solidSmallEnclosedPocket = buildCoarseWorldVoxelChunk(
    caveWorld,
    coordinate,
    at(smallEnclosedPocketFactorSixteen),
    16,
  );
  assert.ok(solidSmallEnclosedPocket, 'Small enclosed pockets do not erode the coarsest cave cell.');
  solidSmallEnclosedPocket.geometry.dispose();

  const surfaceChunk = buildCoarseWorldVoxelChunk(
    caveWorld,
    { x: 0, y: 2, z: 0 },
    at(makeCells(2, 1, 32)),
    2,
  );
  assert.ok(surfaceChunk, 'A sparse occupied cell at the terrain surface still preserves its silhouette.');
  surfaceChunk.geometry.dispose();
});

test('factor-sixteen cave LOD keeps broad enclosed voids from the independent seeded cave field', () => {
  const caveFieldWorld = worldDocumentSchema.parse({
    ...world,
    generator: {
      ...world.generator,
      origin: [0, 0],
      size: [128, 128],
      minY: -64,
      maxY: 64,
      baseHeight: 32,
      caveDensity: 1,
      caveEntrancesPerRegion: 0,
      caveNetwork: false,
    },
  });
  const cellAt = createWorldCellSampler(caveFieldWorld);
  let retainedIndependentCavern = false;

  for (let zChunk = 0; zChunk < 8 && !retainedIndependentCavern; zChunk++)
    for (let xChunk = 0; xChunk < 3 && !retainedIndependentCavern; xChunk++) {
      const coordinate = { x: xChunk, y: 0, z: zChunk };
      let occupied = 0;
      for (let y = 0; y < 16; y++)
        for (let z = 0; z < 16; z++)
          for (let x = 0; x < 16; x++) if (cellAt({ x: xChunk * 16 + x, y, z: zChunk * 16 + z })) occupied++;
      if (occupied <= 2048) continue;

      const coarse = buildCoarseWorldVoxelChunk(caveFieldWorld, coordinate, cellAt, 16);
      if (coarse) coarse.geometry.dispose();
      else retainedIndependentCavern = true;
    }

  assert.ok(
    retainedIndependentCavern,
    'At least one broad enclosed field cavern remains open away from the legacy entrance.',
  );
});

test('coarse cave LOD retains the generated world-spanning trunk beyond the finite entrance passage', () => {
  const base = worldDocumentSchema.parse({
    ...world,
    generator: {
      ...world.generator,
      origin: [-32, -32],
      size: [64, 64],
      minY: -16,
      maxY: 63,
      baseHeight: 32,
      caveNetwork: false,
    },
  });
  const network = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, caveNetwork: true },
  });
  const route = createTerrainCaveNetworkPath(network);
  assert.ok(route);
  const point = route.at(-24);
  const coordinate = {
    x: Math.floor(point.x / 16),
    y: Math.floor(point.y / 16),
    z: Math.floor(point.z / 16),
  };
  for (const factor of [2, 4, 8, 16] as const) {
    const original = buildCoarseWorldVoxelChunk(base, coordinate, createWorldCellSampler(base), factor);
    const connected = buildCoarseWorldVoxelChunk(
      network,
      coordinate,
      createWorldCellSampler(network),
      factor,
    );
    const originalCellCount = original?.voxelCellCount ?? 0;
    const connectedCellCount = connected?.voxelCellCount ?? 0;
    assert.ok(
      connectedCellCount < originalCellCount,
      `the generated trunk removes connected coarse cells at factor ${factor}`,
    );
    original?.geometry.dispose();
    connected?.geometry.dispose();
  }
});

test('coarse cave LOD retains dead-end cells from authored branches along the network trunk', () => {
  const base = worldDocumentSchema.parse({
    ...world,
    generator: {
      ...world.generator,
      origin: [-128, -64],
      size: [256, 128],
      minY: -16,
      maxY: 63,
      baseHeight: 40,
      caveNetwork: true,
      caveBranchCount: 0,
    },
  });
  const branched = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, caveBranchCount: 4 },
  });
  const path = createTerrainCaveNetworkPath(branched);
  assert.ok(path);
  const branch = terrainCaveNetworkBranches(branched, path).find((candidate) => {
    const center = path.at(candidate.along);
    const crossCenter = path.axis === 'x' ? center.z : center.x;
    const endpoint = Math.round(crossCenter + candidate.direction * (candidate.length - 1));
    return Math.abs(candidate.along) > 16 && Math.floor(crossCenter / 16) !== Math.floor(endpoint / 16);
  });
  assert.ok(branch, 'the fixture has a side branch whose endpoint occupies a different factor-sixteen cell');
  const center = path.at(branch.along);
  const crossCenter = path.axis === 'x' ? center.z : center.x;
  const source = {
    x: path.axis === 'x' ? branch.along : Math.round(crossCenter + branch.direction * (branch.length - 1)),
    y: Math.floor(center.y),
    z: path.axis === 'x' ? Math.round(crossCenter + branch.direction * (branch.length - 1)) : branch.along,
  };
  const coordinate = {
    x: Math.floor(source.x / 16),
    y: Math.floor(source.y / 16),
    z: Math.floor(source.z / 16),
  };
  const baseCellAt = createWorldCellSampler(base);
  const branchedCellAt = createWorldCellSampler(branched);
  assert.ok(baseCellAt(source), 'the dead-end branch endpoint is solid without the branch');
  assert.equal(branchedCellAt(source), undefined, 'the authored branch endpoint is open in the source world');

  for (const factor of [2, 4, 8] as const) {
    const withoutBranch = buildCoarseWorldVoxelChunk(base, coordinate, baseCellAt, factor);
    const withBranch = buildCoarseWorldVoxelChunk(branched, coordinate, branchedCellAt, factor);
    const withoutBranchCellCount = withoutBranch?.voxelCellCount ?? 0;
    const withBranchCellCount = withBranch?.voxelCellCount ?? 0;
    assert.ok(
      withBranchCellCount < withoutBranchCellCount,
      `the dead-end branch opens its coarse terminal cell at factor ${factor}`,
    );
    withoutBranch?.geometry.dispose();
    withBranch?.geometry.dispose();
  }
});

test('coarse cells use the most common color and material with a stable tie break', () => {
  const cells = new Map<string, { color: number; materialType: 'STANDARD' | 'EMISSIVE' }>();
  for (let index = 0; index < 8; index++) {
    const x = index % 2,
      y = Math.floor(index / 2) % 2,
      z = Math.floor(index / 4);
    cells.set(`${x},${y},${z}`, {
      color: index < 5 ? 0xff0000 : 0x0000ff,
      materialType: index < 5 ? 'EMISSIVE' : 'STANDARD',
    });
  }
  const majority = buildCoarseWorldVoxelChunk(world, coordinate, at(cells));
  assert.ok(majority);
  assert.equal(majority.geometry.groups[0]?.materialIndex, 3);
  const expected = new THREE.Color(0xff0000);
  const color = majority.geometry.getAttribute('color');
  assert.deepEqual([color.getX(0), color.getY(0), color.getZ(0)], [expected.r, expected.g, expected.b]);
  majority.geometry.dispose();

  const tiedCells = new Map<string, { color: number; materialType: 'STANDARD' }>();
  for (let index = 0; index < 8; index++) {
    const x = index % 2,
      y = Math.floor(index / 2) % 2,
      z = Math.floor(index / 4);
    tiedCells.set(`${x},${y},${z}`, { color: index < 4 ? 0x00ff00 : 0x0000ff, materialType: 'STANDARD' });
  }
  const tied = buildCoarseWorldVoxelChunk(world, coordinate, at(tiedCells));
  assert.ok(tied);
  assert.equal(
    tied.geometry.groups[0]?.materialIndex,
    0,
    'Equal counts use the lower color and stable material order.',
  );
  const tieColor = new THREE.Color(0x0000ff);
  const tieAttribute = tied.geometry.getAttribute('color');
  assert.deepEqual(
    [tieAttribute.getX(0), tieAttribute.getY(0), tieAttribute.getZ(0)],
    [tieColor.r, tieColor.g, tieColor.b],
  );
  tied.geometry.dispose();
});

test('neighbor samples across the source chunk boundary suppress the internal coarse face', () => {
  const built = buildCoarseWorldVoxelChunk(
    world,
    coordinate,
    at(
      new Map([
        ['14,0,0', { color: 0x884422, materialType: 'STANDARD' }],
        ['16,0,0', { color: 0x884422, materialType: 'STANDARD' }],
      ]),
    ),
  );
  assert.ok(built);
  assert.equal(built.voxelCellCount, 1);
  assert.equal(
    built.geometry.index?.count,
    30,
    'The occupied boundary coarse cell keeps five exposed quads.',
  );
  built.geometry.dispose();
});

test('factor-two geometry scales to the exact source chunk bounds', () => {
  const cells = new Map<string, { color: number; materialType: 'STANDARD' }>();
  for (let y = 0; y < 16; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) cells.set(`${x},${y},${z}`, { color: 0x4488aa, materialType: 'STANDARD' });
  const built = buildCoarseWorldVoxelChunk(world, coordinate, at(cells));
  assert.ok(built);
  assert.equal(built.voxelCellCount, 8 ** 3);
  built.geometry.computeBoundingBox();
  const scaledBounds = built.geometry
    .boundingBox!.clone()
    .applyMatrix4(new THREE.Matrix4().makeScale(2, 2, 2));
  assert.deepEqual(scaledBounds.min.toArray(), [-0.5, -0.5, -0.5]);
  assert.deepEqual(scaledBounds.max.toArray(), [15.5, 15.5, 15.5]);
  built.geometry.dispose();
});

test('factor-four geometry preserves the exact source chunk bounds', () => {
  const cells = new Map<string, { color: number; materialType: 'STANDARD' }>();
  for (let y = 0; y < 16; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) cells.set(`${x},${y},${z}`, { color: 0x4488aa, materialType: 'STANDARD' });
  const built = buildCoarseWorldVoxelChunk(world, coordinate, at(cells), 4);
  assert.ok(built);
  assert.equal(built.voxelCellCount, 4 ** 3);
  built.geometry.computeBoundingBox();
  const scaledBounds = built.geometry
    .boundingBox!.clone()
    .applyMatrix4(new THREE.Matrix4().makeScale(4, 4, 4));
  assert.deepEqual(scaledBounds.min.toArray(), [-0.5, -0.5, -0.5]);
  assert.deepEqual(scaledBounds.max.toArray(), [15.5, 15.5, 15.5]);
  built.geometry.dispose();
});
