import assert from 'node:assert/strict';
import * as THREE from 'three';
import { test } from 'node:test';
import {
  createTerrainSurfaceSampler,
  createTerrainVolumeSampler,
  sampleTerrainOverhangHeightMap,
} from '../services/terrainNoise';
import { worldDocumentSchema } from '../services/worldDocument';
import { WorldStreamRenderer } from '../runtime/WorldStreamRenderer';
import { WorldStreamGeometryBuilder } from '../runtime/worldStreamGeometry';

function caveWorld(caveDensity = 0.75) {
  return worldDocumentSchema.parse({
    id: 'cave-volume-world',
    name: 'Cave volume world',
    seed: 317,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      mode: 'voxel3d',
      origin: [0, 0],
      size: [64, 64],
      minY: 0,
      maxY: 64,
      baseHeight: 48,
      amplitude: 0,
      noise: 0,
      caveDensity,
      caveEntrancesPerRegion: 0,
      palette: {
        surface: 0x55aa44,
        subsurface: 0x725439,
        deep: 0x686b70,
        materialType: 'STANDARD',
      },
    },
    edits: [],
  });
}

function deepVertexCount(geometry: THREE.BufferGeometry | null) {
  if (!geometry) return 0;
  const colors = geometry.getAttribute('color');
  const deep = new THREE.Color(0x686b70);
  let count = 0;
  for (let vertex = 0; vertex < colors.count; vertex++)
    if (
      Math.abs(colors.getX(vertex) - deep.r) < 1e-6 &&
      Math.abs(colors.getY(vertex) - deep.g) < 1e-6 &&
      Math.abs(colors.getZ(vertex) - deep.b) < 1e-6
    )
      count++;
  return count;
}

function subsurfaceVertexCount(geometry: THREE.BufferGeometry | null) {
  if (!geometry) return 0;
  const colors = geometry.getAttribute('color');
  const subsurface = new THREE.Color(0x725439);
  let count = 0;
  for (let vertex = 0; vertex < colors.count; vertex++)
    if (
      Math.abs(colors.getX(vertex) - subsurface.r) < 1e-6 &&
      Math.abs(colors.getY(vertex) - subsurface.g) < 1e-6 &&
      Math.abs(colors.getZ(vertex) - subsurface.b) < 1e-6
    )
      count++;
  return count;
}

test('far cave-field volume greedily meshes an enclosed void and respects the finer-tier cutout', () => {
  const selected = caveWorld();
  const surface = { color: 0x55aa44, materialType: 'STANDARD' as const };
  const surfaceAt = () => 48;
  const makeBuilder = (fillCaveCell = false) =>
    new WorldStreamGeometryBuilder(
      selected,
      () => [{ start: 0, end: 48, value: surface }],
      () => ({ top: 47, value: surface }),
      () => false,
      () => false,
      () => [],
      surfaceAt,
      (x, y, z) =>
        x >= 0 &&
        x < 64 &&
        z >= 0 &&
        z < 64 &&
        y >= 0 &&
        y <= 47 &&
        (fillCaveCell && x === 21 && y === 21 && z === 21
          ? true
          : !(x >= 17 && x < 25 && y >= 17 && y < 25 && z >= 17 && z < 25)),
    );
  const tile = { x: 0, z: 0 };
  const noFineCutout = { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 };
  const cave = makeBuilder().buildCoarseTileGeometry(tile, 4, 2, noFineCutout, true);
  assert.ok(cave);
  assert.equal(deepVertexCount(cave), 24, 'The 2×2×2 cave shell should greedily merge to six quads.');

  const filled = makeBuilder(true).buildCoarseTileGeometry(tile, 4, 2, noFineCutout, true);
  assert.ok(
    deepVertexCount(filled) > deepVertexCount(cave),
    'A filled occupancy override stays solid and adds cave-facing wall geometry.',
  );

  const cutout = makeBuilder().buildCoarseTileGeometry(
    tile,
    4,
    2,
    { minX: 0, maxX: 64, minZ: 0, maxZ: 64 },
    true,
  );
  assert.equal(deepVertexCount(cutout), 0, 'The fine-tier region owns its own cave geometry.');
  cave.dispose();
  filled?.dispose();
  cutout?.dispose();
});

test('the default seeded cave sampler contributes horizon cave volume', () => {
  const selected = caveWorld(0.7);
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const surface = {
    color: selected.generator.palette.surface,
    materialType: selected.generator.palette.materialType,
  };
  const builder = new WorldStreamGeometryBuilder(
    selected,
    (x, z) => {
      const top = surfaceAt(x, z) - 1;
      return [{ start: 0, end: top + 1, value: surface }];
    },
    (x, z) => ({ top: surfaceAt(x, z) - 1, value: surface }),
    () => false,
    () => false,
    () => [],
    surfaceAt,
    volumeAt,
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    4,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );
  assert.ok(geometry, 'The seeded density fixture should create visible world geometry.');
  assert.ok(deepVertexCount(geometry) > 0, 'The default sampler should expose distant density-field walls.');
  geometry.dispose();
});

test('far cave volume retains the finite passage when cave-density carving is disabled', () => {
  const selected = caveWorld(0);
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const surface = {
    color: selected.generator.palette.surface,
    materialType: selected.generator.palette.materialType,
  };
  const builder = new WorldStreamGeometryBuilder(
    selected,
    (x, z) => [{ start: 0, end: surfaceAt(x, z), value: surface }],
    (x, z) => ({ top: surfaceAt(x, z) - 1, value: surface }),
    () => false,
    () => false,
    () => [],
    surfaceAt,
    volumeAt,
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    4,
    2,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );
  assert.ok(geometry);
  assert.ok(
    deepVertexCount(geometry) > 0,
    'Generated finite-passage voids below the terrain surface produce distant cave walls without caveDensity.',
  );
  geometry.dispose();
});

test('far and horizon cave volume retains a field opening across coarse cells between center samples', () => {
  const selected = caveWorld();
  const surface = { color: 0x55aa44, materialType: 'STANDARD' as const };
  const surfaceAt = () => 48;
  const makeBuilder = (openPoints: string[]) => {
    const open = new Set(openPoints);
    const isOpen = (x: number, y: number, z: number) => open.has(`${x},${y},${z}`);
    return new WorldStreamGeometryBuilder(
      selected,
      () => [{ start: 0, end: 48, value: surface }],
      () => ({ top: 47, value: surface }),
      () => false,
      () => false,
      () => [],
      surfaceAt,
      (x, y, z) => x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 47 && !isOpen(x, y, z),
      isOpen,
    );
  };
  const noFineCutout = { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 };
  const connected = makeBuilder(['15,22,7', '16,22,7']).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const isolated = makeBuilder(['15,22,7']).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const cornerConnected = makeBuilder(['15,21,15', '16,21,15']).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const cornerIsolated = makeBuilder(['15,21,15']).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );

  assert.ok(connected);
  assert.ok(
    deepVertexCount(connected) > 0,
    'A cave opening sampled on both sides of a coarse-cell boundary remains connected at horizon spacing.',
  );
  assert.ok(isolated);
  assert.equal(
    deepVertexCount(isolated),
    0,
    'A single refined sample with no coarse-cell neighbor is too small to create a horizon cave cell.',
  );
  assert.ok(cornerConnected);
  assert.ok(
    deepVertexCount(cornerConnected) > 0,
    'A corner opening connected across adjacent coarse cells remains represented at horizon spacing.',
  );
  assert.ok(cornerIsolated);
  assert.equal(deepVertexCount(cornerIsolated), 0, 'An isolated refined corner sample stays solid.');
  connected.dispose();
  isolated.dispose();
  cornerConnected.dispose();
  cornerIsolated.dispose();
});

test('horizon cave boundary probes retain a bent tunnel after it leaves the sample lattice', () => {
  const selected = caveWorld(1);
  const surface = { color: 0x55aa44, materialType: 'STANDARD' as const };
  const tunnelAt = (x: number, y: number, z: number) =>
    y === 40 &&
    ((z === 7 && x >= 3 && x <= 15) || (x === 15 && z >= 5 && z <= 7) || (z === 5 && x >= 15 && x <= 31));
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [{ start: selected.generator.minY, end: 49, value: surface }],
    () => ({ top: 48, value: surface }),
    undefined,
    undefined,
    undefined,
    () => 48,
    (x, y, z) => x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 64 && !tunnelAt(x, y, z),
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );

  assert.ok(geometry);
  const positions = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color');
  const deep = new THREE.Color(0x686b70);
  let maxDeepX = -Infinity;
  for (let vertex = 0; vertex < colors.count; vertex++)
    if (
      Math.abs(colors.getX(vertex) - deep.r) < 1e-6 &&
      Math.abs(colors.getY(vertex) - deep.g) < 1e-6 &&
      Math.abs(colors.getZ(vertex) - deep.b) < 1e-6
    )
      maxDeepX = Math.max(maxDeepX, positions.getX(vertex));

  assert.ok(maxDeepX > 1.5, `The bent tunnel's coarse shell should reach the next cell; got x=${maxDeepX}.`);
  geometry.dispose();
});

test('horizon cave boundary flood follows tunnels across multiple unsampled coarse cells', () => {
  const selected = caveWorld(1);
  const surface = { color: 0x55aa44, materialType: 'STANDARD' as const };
  const tunnelAt = (x: number, y: number, z: number) =>
    y === 40 && ((z === 7 && x >= 3 && x <= 16) || (x === 16 && z === 8) || (z === 8 && x >= 16 && x < 64));
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [{ start: selected.generator.minY, end: 49, value: surface }],
    () => ({ top: 48, value: surface }),
    undefined,
    undefined,
    undefined,
    () => 48,
    (x, y, z) => x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 64 && !tunnelAt(x, y, z),
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );

  assert.ok(geometry);
  const positions = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color');
  const deep = new THREE.Color(0x686b70);
  let maxDeepX = -Infinity;
  for (let vertex = 0; vertex < colors.count; vertex++)
    if (
      Math.abs(colors.getX(vertex) - deep.r) < 1e-6 &&
      Math.abs(colors.getY(vertex) - deep.g) < 1e-6 &&
      Math.abs(colors.getZ(vertex) - deep.b) < 1e-6
    )
      maxDeepX = Math.max(maxDeepX, positions.getX(vertex));

  assert.ok(
    maxDeepX > 3.5,
    `Connected coarse cave expansion should keep the unsampled tunnel to the far edge of the tile; got x=${maxDeepX}.`,
  );
  geometry.dispose();
});

test('horizon cave volume keeps a sparse-edited tunnel that misses procedural probes', () => {
  const base = caveWorld(0);
  const edits = Array.from({ length: 17 }, (_, index) => ({ x: index + 3, y: 41, z: 6, value: null }));
  const editedWorld = worldDocumentSchema.parse({ ...base, edits });
  const target = new THREE.Vector3(10000, 20, 10000);
  const baselineRenderer = new WorldStreamRenderer(new THREE.Scene(), base);
  const editedRenderer = new WorldStreamRenderer(new THREE.Scene(), editedWorld);
  const baseline = baselineRenderer.buildTileGeometry('horizon', { x: 0, z: 0 }, target);
  const edited = editedRenderer.buildTileGeometry('horizon', { x: 0, z: 0 }, target);

  assert.ok(baseline);
  assert.ok(edited);
  assert.ok(
    deepVertexCount(edited) > deepVertexCount(baseline),
    'Exact sparse cave edits across adjacent coarse cells should contribute distant cave-facing geometry even when they fall between the fixed probe lattice.',
  );

  baseline.dispose();
  edited.dispose();
  baselineRenderer.dispose();
  editedRenderer.dispose();
});

test('horizon cave sampling retains a connected tunnel at quarter-cell samples', () => {
  const selected = caveWorld(1);
  const surface = { color: selected.generator.palette.surface, materialType: 'STANDARD' as const };
  const tunnelAt = (x: number, y: number, z: number) => y === 40 && z === 3 && x >= 3 && x <= 19;
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [{ start: selected.generator.minY, end: 49, value: surface }],
    () => ({ top: 48, value: surface }),
    undefined,
    undefined,
    undefined,
    () => 48,
    (x, y, z) => x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 64 && !tunnelAt(x, y, z),
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );

  assert.ok(geometry);
  assert.ok(
    deepVertexCount(geometry) > 0,
    'A continuous tunnel through adjacent coarse cells at (x=3…19,z=3) is retained when it falls between the former 3×3×3 samples.',
  );
  geometry.dispose();
});

test('horizon cave sampling retains a connected tunnel at omitted vertical quarter samples', () => {
  const base = caveWorld(1);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, maxY: 127 },
  });
  const surface = { color: selected.generator.palette.surface, materialType: 'STANDARD' as const };
  const tunnelAt = (x: number, y: number, z: number) => y === 42 && z === 7 && x >= 3 && x <= 19;
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [{ start: selected.generator.minY, end: 49, value: surface }],
    () => ({ top: 48, value: surface }),
    undefined,
    undefined,
    undefined,
    () => 48,
    (x, y, z) => x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 127 && !tunnelAt(x, y, z),
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );

  assert.ok(geometry);
  assert.ok(
    deepVertexCount(geometry) > 0,
    'A continuous tunnel between the coarse vertical sample planes remains represented when it crosses adjacent coarse cells.',
  );
  geometry.dispose();
});

test('horizon cave sampling retains a deep tunnel between the quarter-height probes', () => {
  const base = caveWorld(1);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, maxY: 1023 },
  });
  const surface = { color: selected.generator.palette.surface, materialType: 'STANDARD' as const };
  const tunnelAt = (x: number, y: number, z: number) => y === 5 && z === 7 && x >= 3 && x <= 19;
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [{ start: selected.generator.minY, end: 49, value: surface }],
    () => ({ top: 48, value: surface }),
    undefined,
    undefined,
    undefined,
    () => 48,
    (x, y, z) => x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 1023 && !tunnelAt(x, y, z),
  );
  const geometry = builder.buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 },
    true,
  );

  assert.ok(geometry);
  assert.ok(
    deepVertexCount(geometry) > 0,
    'A connected tunnel at a deep-slab midpoint remains represented between the bounded quarter-height probes.',
  );
  geometry.dispose();
});

test('horizon cave volume retains a sampled undercut beneath a solid overhang', () => {
  const base = caveWorld(0);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      overhangMaxHeight: 16,
      overhangHeightMap: [[1]],
    },
  });
  const surfaceAt = (_x: number, _z: number) => 48;
  const surface = { color: 0x55aa44, materialType: 'STANDARD' as const };
  const makeBuilder = (undercut?: { x: number; y: number; z: number }) => {
    const topAt = (x: number, z: number) => ({
      top: surfaceAt(x, z) + sampleTerrainOverhangHeightMap(selected, x, z),
      value: surface,
    });
    return new WorldStreamGeometryBuilder(
      selected,
      (x, z) => [{ start: 0, end: topAt(x, z).top + 1, value: surface }],
      topAt,
      () => false,
      () => false,
      () => [],
      surfaceAt,
      (x, y, z) =>
        x >= 0 &&
        x < 64 &&
        z >= 0 &&
        z < 64 &&
        y >= 0 &&
        y <= 64 &&
        !(undercut && x === undercut.x && y === undercut.y && z === undercut.z),
    );
  };
  const noFineCutout = { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 };
  const solid = makeBuilder().buildCoarseTileGeometry({ x: 0, z: 0 }, 16, 8, noFineCutout, true);
  const undercut = makeBuilder({ x: 7, y: 55, z: 7 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const upperAuthoredUndercut = makeBuilder({ x: 7, y: 60, z: 7 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const betweenSamples = makeBuilder({ x: 7, y: 56, z: 7 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const onCellEdge = makeBuilder({ x: 0, y: 56, z: 7 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const onCellCorner = makeBuilder({ x: 0, y: 56, z: 0 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const betweenColumns = makeBuilder({ x: 3, y: 56, z: 3 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const betweenPerimeter = makeBuilder({ x: 3, y: 56, z: 0 }).buildCoarseTileGeometry(
    { x: 0, z: 0 },
    16,
    8,
    noFineCutout,
    true,
  );
  const editedWorld = caveWorld(0);
  const editedBuilder = new WorldStreamGeometryBuilder(
    editedWorld,
    () => [{ start: 0, end: 65, value: surface }],
    () => ({ top: 64, value: surface }),
    undefined,
    undefined,
    undefined,
    surfaceAt,
    (x, y, z) =>
      x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y <= 64 && !(x === 0 && y === 56 && z === 7),
    () => false,
    () => true,
  );
  const editedUndercut = editedBuilder.buildCoarseTileGeometry({ x: 0, z: 0 }, 16, 8, noFineCutout, true);

  assert.ok(solid);
  assert.equal(deepVertexCount(solid), 0, 'An uninterrupted overhang has no cave-facing undercut shell.');
  assert.ok(undercut);
  assert.ok(
    deepVertexCount(undercut) > 0,
    'A sampled air gap between upper and lower overhang solids becomes a coarse undercut.',
  );
  assert.ok(upperAuthoredUndercut);
  assert.ok(
    deepVertexCount(upperAuthoredUndercut) > 0,
    'The authored overhang cap retains undercuts above the default height when the world allows them.',
  );
  assert.ok(betweenSamples);
  assert.ok(
    deepVertexCount(betweenSamples) > 0,
    'A one-cell undercut bounded by solids remains represented even when the layer center misses it.',
  );
  assert.ok(onCellEdge);
  assert.ok(
    deepVertexCount(onCellEdge) > 0,
    'A one-cell undercut at a coarse-cell edge remains represented when the center column stays solid.',
  );
  assert.ok(onCellCorner);
  assert.ok(
    deepVertexCount(onCellCorner) > 0,
    'A one-cell undercut at a coarse-cell corner remains represented when all five previous columns stay solid.',
  );
  assert.ok(betweenColumns);
  assert.ok(
    deepVertexCount(betweenColumns) > 0,
    'A one-cell undercut at a quadrant-center column remains represented between the original nine probes.',
  );
  assert.ok(betweenPerimeter);
  assert.ok(
    deepVertexCount(betweenPerimeter) > 0,
    'A one-cell undercut on a quarter-edge sample remains represented between the original edge centers and corners.',
  );
  assert.ok(editedUndercut);
  assert.ok(
    deepVertexCount(editedUndercut) > 0,
    'Horizon undercuts from the merged occupancy sampler work without procedural overhang settings.',
  );
  solid.dispose();
  undercut.dispose();
  upperAuthoredUndercut.dispose();
  betweenSamples.dispose();
  onCellEdge.dispose();
  onCellCorner.dispose();
  betweenColumns.dispose();
  betweenPerimeter.dispose();
  editedUndercut.dispose();
});

test('horizon tiles retain undercuts from sparse voxel additions without procedural overhang settings', () => {
  const base = caveWorld(0);
  const surface = { color: base.generator.palette.surface, materialType: 'STANDARD' as const };
  const selected = worldDocumentSchema.parse({
    ...base,
    edits: [
      { x: 7, y: 55, z: 7, value: surface },
      { x: 7, y: 57, z: 7, value: surface },
      { x: 0, y: 55, z: 7, value: surface },
      { x: 0, y: 57, z: 7, value: surface },
    ],
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const geometry = renderer.buildTileGeometry('horizon', { x: 0, z: 0 }, new THREE.Vector3(500, 24, 500));

  assert.ok(geometry);
  assert.ok(
    deepVertexCount(geometry) > 0,
    'Sparse edited solids bound an edge-center air gap that the horizon layer-center sample misses.',
  );
  geometry.dispose();
  renderer.dispose();
});

test('horizon refines sparse edited columns outside the fixed undercut probe lattice', () => {
  const base = caveWorld(0);
  for (const { x, z, tileX, tileZ } of [
    { x: 1, z: 1, tileX: 0, tileZ: 0 },
    { x: 253, z: 1, tileX: 1, tileZ: 0 },
  ]) {
    const selected = worldDocumentSchema.parse({
      ...base,
      generator: {
        ...base.generator,
        size: [512, 512],
        overhangMaxHeight: 16,
        overhangHeightMap: [[1]],
      },
    });
    const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
    renderer.updateWorldEdits([{ x, y: 56, z, value: null }], [{ x, y: 56, z }]);
    const geometry = renderer.buildTileGeometry(
      'horizon',
      { x: tileX, z: tileZ },
      new THREE.Vector3(500, 24, 500),
    );

    assert.ok(geometry);
    assert.ok(
      deepVertexCount(geometry) > 0,
      `A live tombstone edit at source column (${x},${z}), between regular probes, remains represented in horizon tile ${tileX},${tileZ}.`,
    );
    geometry.dispose();
    renderer.dispose();
  }
});

test('far and horizon tiles retain coarse overhang side volume and respect finer-tier cutouts', () => {
  const selected = worldDocumentSchema.parse({
    ...caveWorld(0),
    generator: {
      ...caveWorld(0).generator,
      overhangMaxHeight: 8,
      overhangHeightMap: [
        [1, 0],
        [1, 0],
      ],
    },
  });
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const surface = {
    color: selected.generator.palette.surface,
    materialType: selected.generator.palette.materialType,
  };
  const topAt = (x: number, z: number) => ({
    top: surfaceAt(x, z) + sampleTerrainOverhangHeightMap(selected, x, z),
    value: surface,
  });
  const builder = new WorldStreamGeometryBuilder(
    selected,
    (x, z) => [{ start: 0, end: topAt(x, z).top + 1, value: surface }],
    topAt,
    undefined,
    undefined,
    undefined,
    surfaceAt,
    volumeAt,
  );
  const noFineCutout = { minX: 1000, maxX: 1001, minZ: 1000, maxZ: 1001 };
  const fullCutout = { minX: 0, maxX: 64, minZ: 0, maxZ: 64 };

  for (const spacing of [4, 16]) {
    const extended = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, spacing, spacing / 2, noFineCutout);
    const cutout = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, spacing, spacing / 2, fullCutout);
    assert.ok(extended);
    const colors = extended.getAttribute('color');
    const normals = extended.getAttribute('normal');
    const positions = extended.getAttribute('position');
    const subsurface = new THREE.Color(selected.generator.palette.subsurface);
    let wallVertices = 0;
    for (let vertex = 0; vertex < colors.count; vertex++) {
      if (
        Math.abs(colors.getX(vertex) - subsurface.r) >= 1e-6 ||
        Math.abs(colors.getY(vertex) - subsurface.g) >= 1e-6 ||
        Math.abs(colors.getZ(vertex) - subsurface.b) >= 1e-6
      )
        continue;
      assert.ok(Math.abs(normals.getY(vertex)) < 1e-6, 'Coarse overhang faces remain vertical side walls.');
      assert.ok(
        Math.abs(normals.getX(vertex)) > 0.99 || Math.abs(normals.getZ(vertex)) > 0.99,
        'Coarse overhang wall normals face horizontally out of the solid.',
      );
      assert.ok(positions.getY(vertex) >= 48.5 && positions.getY(vertex) <= 56.5);
      wallVertices++;
    }
    assert.ok(wallVertices > 0, `Spacing ${spacing} keeps coarse vertical walls on authored overhangs.`);
    assert.equal(
      subsurfaceVertexCount(cutout),
      0,
      'The finer tier owns overhang geometry inside its cutout.',
    );
    extended.dispose();
    cutout?.dispose();
  }
});
