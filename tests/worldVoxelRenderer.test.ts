import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createWorldCellSampler,
  createWorldChunkStore,
  worldDocumentSchema,
  type WorldEdit,
} from '../services/worldDocument';
import { WorldVoxelRenderer } from '../runtime/WorldVoxelRenderer';
import { geometryArrayBytes } from '../runtime/geometryArrayBytes';
import {
  createTerrainCaveNetworkPath,
  createTerrainSurfaceSampler,
  terrainCaveBranches,
  terrainCaveCenterY,
  terrainCaveNetworkBranches,
} from '../services/terrainNoise';
import {
  deserializeVoxelChunkGeometry,
  serializeVoxelChunkGeometry,
  type VoxelChunkBuildRequest,
  type VoxelChunkBuildResponse,
} from '../runtime/worldVoxelWorkerProtocol';
import type { TileBuildRequest, TileBuildResponse } from '../runtime/worldStreamWorkerProtocol';

function world(mode: 'heightfield' | 'voxel3d' = 'voxel3d', edits: unknown[] = []) {
  return worldDocumentSchema.parse({
    id: 'cave-world',
    name: 'Cave world',
    seed: 817,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      mode,
      origin: [-32, -32],
      size: [64, 64],
      minY: 0,
      maxY: 63,
      baseHeight: 32,
      amplitude: 0,
      noise: 0,
      palette: { surface: 0x79a94e, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
    },
    edits,
  });
}

function compactWorld(width = 1, edits: unknown[] = []) {
  const base = world();
  return worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      origin: [0, 0],
      size: [width, 16],
      minY: 16,
      maxY: 31,
      baseHeight: 24,
      amplitude: 0,
      noise: 0,
    },
    edits,
  });
}

function mountainWorld() {
  return worldDocumentSchema.parse({
    id: 'mountain-seam',
    name: 'Mountain seam',
    seed: 817,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      mode: 'voxel3d',
      origin: [-512, -512],
      size: [1024, 1024],
      minY: 0,
      maxY: 127,
      baseHeight: 64,
      amplitude: 24,
      noise: 0.82,
      landformScale: 96,
      palette: {
        surface: 0x79a94e,
        subsurface: 0x806044,
        deep: 0x5e6269,
        surfaceDepth: 3,
        subsurfaceDepth: 6,
        materialType: 'STANDARD',
      },
    },
    edits: [],
  });
}

class FakeVoxelWorker {
  onmessage: ((event: MessageEvent<VoxelChunkBuildResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: VoxelChunkBuildRequest[] = [];
  terminated = false;

  postMessage(message: VoxelChunkBuildRequest) {
    this.requests.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(response: VoxelChunkBuildResponse) {
    this.onmessage?.({ data: response } as MessageEvent<VoxelChunkBuildResponse>);
  }

  fail() {
    this.onerror?.();
  }
}

class FakeTerrainWorker {
  onmessage: ((event: MessageEvent<TileBuildResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  requests: TileBuildRequest[] = [];

  postMessage(message: TileBuildRequest) {
    this.requests.push(message);
  }

  terminate() {}
}

const chunkMeshes = (renderer: WorldVoxelRenderer) =>
  renderer.group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);

function sameGeometry(first: THREE.BufferGeometry, second: THREE.BufferGeometry) {
  for (const name of ['position', 'normal', 'color'] as const)
    assert.deepEqual(Array.from(first.getAttribute(name).array), Array.from(second.getAttribute(name).array));
  assert.deepEqual(Array.from(first.index!.array), Array.from(second.index!.array));
  assert.deepEqual(first.groups, second.groups);
}

function responseFor(selected: ReturnType<typeof compactWorld>, request: VoxelChunkBuildRequest) {
  const source = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const build = source.buildChunkGeometry(request.coordinate);
  const serialized = build ? serializeVoxelChunkGeometry(build.geometry) : null;
  const response: VoxelChunkBuildResponse = {
    id: request.id,
    revision: request.revision,
    coordinate: request.coordinate,
    geometry: serialized?.data ?? null,
    voxelCellCount: build?.voxelCellCount ?? 0,
    hasCaveFaces: build?.hasCaveFaces ?? false,
    meshMs: 1,
  };
  build?.geometry.dispose();
  source.dispose();
  return response;
}

test('3D occupancy connects the cave cross-passage to its small surface entrance', () => {
  const legacy = world();
  assert.ok(
    createWorldChunkStore(legacy).get({ x: 0, y: 28, z: 10 }),
    'Omitting the cross-passage keeps the original tunnel geometry.',
  );
  const selected = worldDocumentSchema.parse({
    ...legacy,
    generator: { ...legacy.generator, caveCrossPassage: true },
  });
  const first = createWorldChunkStore(selected);
  const repeat = createWorldChunkStore(selected);
  assert.deepEqual(
    [first.get({ x: 0, y: 25, z: 0 }), first.get({ x: 0, y: 28, z: 0 }), first.get({ x: 0, y: 32, z: 0 })],
    [repeat.get({ x: 0, y: 25, z: 0 }), repeat.get({ x: 0, y: 28, z: 0 }), repeat.get({ x: 0, y: 32, z: 0 })],
  );
  assert.ok(first.get({ x: 0, y: 25, z: 0 }), 'Rock remains below the cave.');
  assert.equal(first.get({ x: 0, y: 28, z: 0 }), undefined, 'The generated cave is empty.');
  for (let z = -12; z <= 12; z++)
    assert.equal(first.get({ x: 0, y: 28, z }), undefined, `The cross-passage stays connected at z=${z}.`);
  assert.ok(first.get({ x: 0, y: 28, z: 13 }), 'The bounded cross-passage ends in solid terrain.');
  assert.ok(
    first.get({ x: 13, y: 28, z: 0 }),
    'The finite passage terminates in solid terrain before distant LOD begins.',
  );
  assert.ok(
    Array.from({ length: 12 }, (_, index) => first.get({ x: 0, y: 29 + index, z: 6 })).some(Boolean),
    'Terrain above the tunnel remains a roof.',
  );
  assert.equal(
    first.get({ x: 0, y: 32, z: 0 }),
    undefined,
    'The deterministic entrance opens through the surface cap.',
  );
  assert.ok(first.get({ x: 0, y: 32, z: 6 }), 'The entrance has a solid rim outside its narrow shaft.');
  assert.ok(createWorldCellSampler(selected)({ x: 0, y: 28, z: 0 }) === undefined);
});

test('voxel streaming retains generated side branches beyond the main passage', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, caveBranchCount: 4 },
  });
  const branch = terrainCaveBranches(selected)[0];
  assert.ok(branch, 'The fixture fits at least one side branch.');
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const build = renderer.buildChunkGeometry({
    x: Math.floor(branch.x / 16),
    y: Math.floor(terrainCaveCenterY(selected) / 16),
    z: Math.floor((branch.direction * branch.length) / 16),
  });
  assert.ok(build, 'The chunk intersecting the branch is included in local voxel streaming.');
  assert.equal(build.hasCaveFaces, true, 'The generated branch receives cave-face material grouping.');
  build.geometry.dispose();
  renderer.dispose();
});

test('voxel chunks on the world-spanning cave trunk receive cave-face classification', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, caveNetwork: true },
  });
  const path = createTerrainCaveNetworkPath(selected);
  assert.ok(path);
  const point = path.at(-8);
  const coordinate = {
    x: Math.floor(point.x / 16),
    y: Math.floor(point.y / 16),
    z: Math.floor(point.z / 16),
  };
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const build = renderer.buildChunkGeometry(coordinate);
  assert.ok(build, 'the trunk chunk contains generated terrain geometry');
  assert.equal(build.hasCaveFaces, true, 'network tunnel faces use cave material classification');
  build.geometry.dispose();
  renderer.dispose();
});

test('local voxel streaming includes side branches placed along the world-spanning trunk', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      origin: [-128, -64],
      size: [256, 128],
      minY: -16,
      maxY: 63,
      baseHeight: 40,
      caveNetwork: true,
      caveBranchCount: 4,
    },
  });
  const path = createTerrainCaveNetworkPath(selected);
  assert.ok(path);
  const branch = terrainCaveNetworkBranches(selected, path).find(
    (candidate) => Math.abs(candidate.along) > 32,
  );
  assert.ok(branch, 'the fixture has a trunk branch outside the finite entrance cave');
  const point = path.at(branch.along);
  const centerCross = path.axis === 'x' ? point.z : point.x;
  const distance = Math.min(20, branch.length - 2);
  const cross = Math.round(centerCross + branch.direction * distance);
  const source = {
    x: path.axis === 'x' ? branch.along : cross,
    y: Math.floor(point.y),
    z: path.axis === 'x' ? cross : branch.along,
  };
  assert.equal(createWorldCellSampler(selected)(source), undefined, 'the sampled side branch is carved');

  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const build = renderer.buildChunkGeometry({
    x: Math.floor(source.x / 16),
    y: Math.floor(source.y / 16),
    z: Math.floor(source.z / 16),
  });
  assert.ok(build, 'the chunk intersecting the side passage is included in local streaming');
  assert.equal(build.hasCaveFaces, true, 'network side-passage surfaces use cave material classification');
  build.geometry.dispose();
  renderer.dispose();
});

test('a deeper authored cave passage stays in the streamed cave-lighting bounds', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, caveDepth: 28 },
  });
  const centerY = terrainCaveCenterY(selected);
  assert.equal(centerY, 4);
  assert.equal(createWorldCellSampler(selected)({ x: 0, y: centerY, z: 0 }), undefined);

  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const build = renderer.buildChunkGeometry({ x: 0, y: 0, z: 0 });
  assert.ok(build, 'The chunk containing the deeper passage builds');
  assert.equal(build.hasCaveFaces, true, 'The renderer recognizes cave surfaces at the configured depth');
  build.geometry.dispose();
  renderer.dispose();
});

test('local greedy voxel chunks mesh seeded overhang cells above the heightfield', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    seed: 1234,
    generator: { ...base.generator, overhangDensity: 0.8 },
  });
  const legacy = worldDocumentSchema.parse({
    ...selected,
    generator: { ...selected.generator, overhangDensity: 0 },
  });
  const cellAt = createWorldCellSampler(selected);
  let sample: { x: number; z: number } | undefined;
  for (let z = -32; z < 32 && !sample; z++)
    for (let x = -32; x < 32; x++)
      if (cellAt({ x, y: 33, z })) {
        sample = { x, z };
        break;
      }
  assert.ok(sample, 'The seeded fixture has an overhang one cell above its flat surface.');

  const coordinate = {
    x: Math.floor(sample.x / 16),
    y: Math.floor(33 / 16),
    z: Math.floor(sample.z / 16),
  };
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const build = renderer.buildChunkGeometry(coordinate);
  assert.ok(build, 'The local terrain chunk produces greedy geometry.');
  const legacyCells = createWorldCellSampler(legacy);
  let legacyCellCount = 0;
  for (let y = coordinate.y * 16; y < coordinate.y * 16 + 16; y++)
    for (let z = coordinate.z * 16; z < coordinate.z * 16 + 16; z++)
      for (let x = coordinate.x * 16; x < coordinate.x * 16 + 16; x++)
        if (legacyCells({ x, y, z })) legacyCellCount++;
  assert.ok(
    build.voxelCellCount > legacyCellCount,
    'The chunk includes generated cells absent from legacy terrain.',
  );
  const positions = build.geometry.getAttribute('position');
  let maximumY = -Infinity;
  for (let vertex = 0; vertex < positions.count; vertex++)
    maximumY = Math.max(maximumY, positions.getY(vertex));
  assert.ok(maximumY > 0.5, 'The mesh reaches above the heightfield top inside this chunk.');
  build.geometry.dispose();
  renderer.dispose();
});

test('voxel renderer streams distant heightfield tiles through its terrain worker factory', () => {
  const selected = compactWorld(),
    terrain = new FakeTerrainWorker(),
    voxel = new FakeVoxelWorker(),
    renderer = new WorldVoxelRenderer(
      new THREE.Scene(),
      selected,
      () => voxel as unknown as Worker,
      () => terrain as unknown as Worker,
    );
  renderer.update(new THREE.Vector3(0, 12, 0));
  assert.equal(voxel.requests.length, 1);
  assert.equal(terrain.requests.length, 1);
  assert.equal(terrain.requests[0].world?.id, selected.id);
  renderer.dispose();
});

test('voxel terrain keeps the surface outside its vertical chunk window without duplicate coverage', () => {
  const selected = world();
  const scene = new THREE.Scene();
  const renderer = new WorldVoxelRenderer(scene, selected);
  const ray = new THREE.Raycaster(new THREE.Vector3(3.125, 100, 3.375), new THREE.Vector3(0, -1, 0));
  for (const target of [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 16, 0),
    new THREE.Vector3(0, 40, 0),
    new THREE.Vector3(8, 16, 0),
  ]) {
    for (let frame = 0; frame < 140; frame++) renderer.update(target);
    scene.updateMatrixWorld(true);
    const hits = ray.intersectObjects(scene.children, true);
    const tops = hits.filter((hit) => Math.abs(hit.point.y - 16.25) < 1e-6);
    assert.equal(tops.length, 1, `Exactly one surface at target ${target.toArray()}.`);
    assert.equal(hits[0]?.point.y, 16.25);
    assert.ok(renderer.stats().residentChunks <= renderer.stats().maximumResidentChunks);
  }
  renderer.dispose();
});

test('factor-two cave LOD closes an occupancy mismatch at the fine terrain boundary', () => {
  const selected = mountainWorld();
  const cellAt = createWorldCellSampler(selected);
  assert.ok(cellAt({ x: -17, y: 65, z: 0 }), 'The outer coarse cell is solid at the seam.');
  assert.equal(cellAt({ x: -16, y: 65, z: 0 }), undefined, 'The adjacent fine cell is empty.');

  const scene = new THREE.Scene();
  const renderer = new WorldVoxelRenderer(scene, selected);
  renderer.update(new THREE.Vector3(0, 26, 0));
  const fine = renderer.buildChunkGeometry({ x: -1, y: 4, z: 0 });
  const coarse = renderer.buildCoarseChunkGeometry({ x: -2, y: 4, z: 0 }, 2);
  assert.ok(fine && coarse, 'Both sides of the terrain LOD boundary have geometry.');

  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const fineMesh = new THREE.Mesh(fine.geometry, material);
  fineMesh.position.set(-8, 32, 0);
  fineMesh.scale.setScalar(selected.voxelSize);
  const coarseMesh = new THREE.Mesh(coarse.geometry, material);
  coarseMesh.position.set(-16, 32, 0);
  coarseMesh.scale.setScalar(selected.voxelSize * 2);
  fineMesh.updateMatrixWorld(true);
  coarseMesh.updateMatrixWorld(true);

  const seamRay = new THREE.Raycaster(new THREE.Vector3(-8.2, 32.5, 0), new THREE.Vector3(-1, 0, 0), 0, 0.1);
  const seamHit = seamRay.intersectObjects([fineMesh, coarseMesh], true)[0];
  assert.ok(seamHit, 'The exact LOD boundary has a visible wall across the occupancy mismatch.');
  assert.ok(Math.abs(seamHit.point.x + 8.25) < 1e-6, 'The repaired face lies on the shared chunk plane.');

  fine.geometry.dispose();
  coarse.geometry.dispose();
  material.dispose();
  renderer.dispose();
});

test('cave LOD follows the camera position rather than an underground orbit target', () => {
  const selected = mountainWorld();
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const target = new THREE.Vector3(0, 26, 0);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 54, 82);
  assert.ok(
    target.y / selected.voxelSize < surfaceAt(0, 0) - 1,
    'The orbit target is below the mountain surface.',
  );
  assert.ok(
    camera.position.y / selected.voxelSize >=
      surfaceAt(
        Math.round(camera.position.x / selected.voxelSize),
        Math.round(camera.position.z / selected.voxelSize),
      ) -
        1,
    'The camera is above the terrain beneath it.',
  );

  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  renderer.update(target, camera);
  assert.equal(renderer.stats().caveLodEnabled, false);
  renderer.dispose();
});

test('legacy terrain stays a solid heightfield and arbitrary sparse edits override 3D occupancy', () => {
  const legacy = world('heightfield');
  assert.ok(createWorldChunkStore(legacy).get({ x: 0, y: 28, z: 0 }));
  const edited = world('voxel3d', [
    { x: 0, y: 28, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } },
    { x: 1, y: 28, z: 0, value: null },
  ]);
  const chunks = createWorldChunkStore(edited);
  assert.equal(chunks.get({ x: 0, y: 28, z: 0 })?.color, 0xff00ff);
  assert.equal(chunks.get({ x: 1, y: 28, z: 0 }), undefined);
  chunks.unloadAll();
  assert.equal(createWorldChunkStore(edited).get({ x: 0, y: 28, z: 0 })?.materialType, 'EMISSIVE');
});

test('3D greedy chunk meshes expose the cave ceiling and stay within a streamed 3D window', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, caveCrossPassage: true },
  });
  const scene = new THREE.Scene();
  const renderer = new WorldVoxelRenderer(scene, selected);
  const target = new THREE.Vector3(0, 14, 0);
  renderer.update(target);
  assert.equal(renderer.stats().verticalMode, 'voxel3d');
  assert.equal(renderer.stats().renderChunkSize, 16);
  assert.equal(renderer.stats().logicalCellSizeMeters, 0.5);
  assert.ok(renderer.stats().residentChunks <= 27);
  assert.equal(renderer.stats().streamUpdateMs.count, 1);
  assert.equal(renderer.stats().distantTerrain.updateMs.count, 1);
  const mesh = renderer.group.children.find(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.userData.worldChunk.y === 1,
  );
  assert.ok(mesh, 'The cave chunk is meshed.');
  assert.equal(mesh!.receiveShadow, true, 'Cave chunks keep the same shadow reception as exterior terrain.');
  mesh!.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 14, 1), new THREE.Vector3(0, 1, 0));
  const ceiling = ray.intersectObject(mesh!);
  assert.ok(ceiling.length > 0, 'The cave has rendered solid ceiling geometry above its void.');
  assert.equal(ceiling[0].face?.materialIndex, 4, 'Cave-facing surfaces use the cave fill material.');
  const branchRay = new THREE.Raycaster(new THREE.Vector3(0, 17, 5), new THREE.Vector3(0, -1, 0));
  const branchCeiling = branchRay.intersectObject(mesh!);
  assert.ok(branchCeiling.length > 0, 'The connected cross-passage has meshed ceiling geometry.');
  assert.equal(
    branchCeiling[0].face?.materialIndex,
    4,
    'The branch ceiling receives the cave fill material.',
  );
  assert.equal(
    (mesh!.material as THREE.MeshStandardMaterial[])[4].emissiveIntensity,
    0.04,
    'The cave fill adds a subtle amount of light without changing the voxel palette.',
  );
  assert.ok(
    mesh!.geometry.groups.length <= 2,
    'Cave material grouping adds at most one draw call per terrain chunk.',
  );

  for (let i = 0; i < 40; i++) renderer.update(target);
  assert.equal(
    renderer.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.userData.worldChunk.y === 0,
    )?.receiveShadow,
    true,
    'Voxel terrain outside the cave keeps directional shadow reception.',
  );
  const exteriorMesh = renderer.group.children.find(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh &&
      child.userData.worldChunk.x === 0 &&
      child.userData.worldChunk.y === 2 &&
      child.userData.worldChunk.z === 0,
  );
  assert.ok(exteriorMesh, 'The exterior surface chunk is meshed.');
  exteriorMesh!.updateMatrixWorld(true);
  const exteriorRay = new THREE.Raycaster(new THREE.Vector3(3, 20, 3), new THREE.Vector3(0, -1, 0));
  const exterior = exteriorRay.intersectObject(exteriorMesh!);
  assert.ok(exterior.length > 0, 'The ray reaches the exterior terrain surface.');
  assert.equal(exterior[0].face?.materialIndex, 0, 'Exterior faces keep the original terrain material.');
  assert.ok(renderer.stats().residentChunks <= renderer.stats().maximumResidentChunks);
  assert.equal(
    renderer.stats().residentVoxelGeometryArrayBytes,
    chunkMeshes(renderer)
      .filter((chunk) => chunk.userData.worldVoxelLodCellSize === undefined)
      .reduce((total, chunk) => total + geometryArrayBytes(chunk.geometry), 0),
    'The voxel renderer counts resident chunk arrays without counting unmeshed logical cells.',
  );
  assert.ok(renderer.stats().loadedChunks <= renderer.stats().maximumResidentChunks);
  assert.ok(
    renderer.stats().renderedCaveLodChunks > 0,
    'The bounded coarse volume represents terrain outside the full-resolution window.',
  );
  const beforeMove = renderer.stats().residentChunks;
  renderer.update(new THREE.Vector3(64, 14, 0));
  assert.ok(renderer.stats().residentChunks <= 27);
  assert.ok(renderer.stats().residentChunks <= beforeMove);
  renderer.dispose();
  assert.equal(renderer.group.children.length, 0);
});

test('underground views stream bounded horizontal and vertical cave LOD and retire it above ground', () => {
  const base = world();
  const chamberEdits: WorldEdit[] = [];
  for (let y = 20; y < 28; y++)
    for (let z = 4; z < 12; z++) for (let x = 36; x < 44; x++) chamberEdits.push({ x, y, z, value: null });
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [-64, -64], size: [128, 128], baseHeight: 64, maxY: 127 },
    edits: [
      ...chamberEdits,
      { x: 40, y: 16, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } },
      { x: 40, y: 80, z: 0, value: { color: 0x00ffff, materialType: 'EMISSIVE' } },
    ],
  });
  const scene = new THREE.Scene();
  const renderer = new WorldVoxelRenderer(scene, selected);
  const underground = new THREE.Vector3(0, 24, 0);
  renderer.update(underground);
  assert.equal(
    renderer.stats().caveLodTileCount,
    1080,
    'The underground window includes the factor-two, factor-four, factor-eight and factor-sixteen cave rings.',
  );
  assert.equal(
    renderer.stats().desiredCaveLodChunks,
    215,
    'The five-layer near ring and the world-clipped outer ring remain bounded.',
  );
  for (
    let frame = 1;
    frame < 500 && renderer.stats().residentCaveLodChunks < renderer.stats().desiredCaveLodChunks;
    frame++
  )
    renderer.update(underground);

  const stats = renderer.stats();
  assert.equal(stats.caveLodEnabled, true);
  assert.equal(stats.caveLodTileCount, 1080);
  assert.equal(stats.desiredCaveLodChunks, 215);
  assert.equal(stats.residentCaveLodChunks, 215);
  assert.ok(stats.renderedCaveLodChunks > 0, 'A cave volume in the outer ring receives a coarse mesh.');
  assert.equal(stats.maximumResidentCaveLodChunks, 1240);
  assert.ok(
    stats.distantTerrain.renderedGeometries > 0,
    'Heightfield tiles continue building while synchronous cave LOD drains.',
  );
  assert.equal(
    stats.residentGeometryArrayBytes,
    stats.residentVoxelGeometryArrayBytes +
      stats.residentCaveLodGeometryArrayBytes +
      stats.distantTerrain.residentGeometryArrayBytes,
  );

  const coarse = chunkMeshes(renderer).find(
    (mesh) =>
      mesh.userData.worldChunk.x === 2 &&
      mesh.userData.worldChunk.y === 1 &&
      mesh.userData.worldChunk.z === 0,
  );
  assert.ok(coarse, 'The outer 16³ source chunk has a coarse cave-view mesh.');
  assert.equal(coarse!.userData.worldVoxelLodCellSize, 2);
  assert.equal(coarse!.scale.x, selected.voxelSize * 2);
  const farCoarse = chunkMeshes(renderer).find(
    (mesh) =>
      mesh.userData.worldChunk.x === -4 &&
      mesh.userData.worldChunk.y === 3 &&
      mesh.userData.worldChunk.z === 0,
  );
  assert.ok(
    farCoarse,
    `The factor-four outer ring extends coarse cave volume to the distant world edge; rendered far coordinates: ${JSON.stringify(
      chunkMeshes(renderer)
        .filter((mesh) => mesh.userData.worldVoxelLodCellSize === 4)
        .map((mesh) => mesh.userData.worldChunk),
    )}`,
  );
  assert.equal(farCoarse!.userData.worldVoxelLodCellSize, 4);
  assert.equal(farCoarse!.scale.x, selected.voxelSize * 4);
  assert.ok(
    chunkMeshes(renderer).some(
      (mesh) =>
        mesh.userData.worldChunk.x === 3 &&
        mesh.userData.worldChunk.y === 1 &&
        mesh.userData.worldChunk.z === 0,
    ),
    'The extended coarse ring reaches the third chunk band beyond the local 3×3 window.',
  );
  assert.ok(
    chunkMeshes(renderer).some(
      (mesh) =>
        mesh.userData.worldChunk.x === 2 &&
        mesh.userData.worldChunk.y === 1 &&
        mesh.userData.worldChunk.z === 0,
    ),
    'The coarse view extends below the full-resolution vertical window.',
  );
  assert.ok(
    chunkMeshes(renderer).some(
      (mesh) =>
        mesh.userData.worldChunk.x === 2 &&
        mesh.userData.worldChunk.y === 5 &&
        mesh.userData.worldChunk.z === 0,
    ),
    'The coarse view extends above the full-resolution vertical window.',
  );
  scene.updateMatrixWorld(true);
  const caveRay = new THREE.Raycaster(new THREE.Vector3(20, 12, 3.5), new THREE.Vector3(0, 1, 0));
  assert.ok(
    caveRay.intersectObject(coarse!).some((hit) => Math.abs(hit.point.y - 13.75) < 1e-6),
    'The coarse ring preserves the ceiling of a large authored cave volume.',
  );

  const ray = new THREE.Raycaster(new THREE.Vector3(20, 50, 0), new THREE.Vector3(0, -1, 0));
  const topHits = ray
    .intersectObjects(scene.children, true)
    .filter((hit) => Math.abs(hit.point.y - 32.75) < 1e-6);
  assert.ok(topHits.length > 0, 'The generated terrain surface remains present in the streamed cave band.');
  assert.ok(
    topHits.some((hit) => hit.object.userData.worldVoxelLodCellSize === 2),
    'The coarse volume supplies the surface removed from the overlapping heightfield tile.',
  );

  const previousLodBuildCount = renderer.stats().caveLodChunkBuildMs.count;
  renderer.updateWorld(
    worldDocumentSchema.parse({
      ...selected,
      edits: [
        ...selected.edits,
        { x: 40, y: 20, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } },
      ],
    }),
  );
  renderer.update(underground);
  for (
    let frame = 0;
    frame < 2 && renderer.stats().caveLodChunkBuildMs.count === previousLodBuildCount;
    frame++
  )
    renderer.update(underground);
  assert.equal(
    renderer.stats().caveLodChunkBuildMs.count,
    previousLodBuildCount + 1,
    'An edit inside a resident coarse source chunk schedules its mesh for rebuild.',
  );

  renderer.update(new THREE.Vector3(0, 34, 0));
  assert.equal(renderer.stats().caveLodEnabled, false);
  assert.equal(renderer.stats().residentCaveLodChunks, 0);
  renderer.dispose();
});

test('ultra-far cave LOD remains within the expanded chunk residency budget', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [-320, -320], size: [640, 640] },
  });
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3(0, 12, 0));
  const stats = renderer.stats();
  assert.equal(stats.caveLodTileCount, 1080);
  assert.equal(stats.desiredCaveLodChunks, 1200);
  assert.equal(stats.maximumResidentCaveLodChunks, 1240);
  assert.ok(stats.desiredCaveLodChunks <= stats.maximumResidentCaveLodChunks);
  renderer.dispose();
});

test('million-column 3D worlds retain only the local voxel window at distant positive and negative views', () => {
  const selected = world();
  const large = worldDocumentSchema.parse({
    ...selected,
    generator: {
      ...selected.generator,
      origin: [-500, -500],
      size: [1_000, 1_000],
    },
  });
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), large);

  for (const cell of [-400, 400]) {
    const target = new THREE.Vector3(cell * large.voxelSize, 14, cell * large.voxelSize);
    renderer.update(target);
    for (let frame = 0; frame < 36; frame++) {
      renderer.update(target);
      const stats = renderer.stats();
      assert.ok(stats.residentChunks <= stats.maximumResidentChunks);
      assert.ok(stats.loadedChunks <= stats.maximumResidentChunks);
      assert.ok(stats.distantTerrain.renderedGeometries <= stats.distantTerrain.maximumResidentGeometries);
    }

    const expected = {
      x: Math.floor(cell / 16),
      z: Math.floor(cell / 16),
    };
    assert.ok(
      chunkMeshes(renderer).some((mesh) => {
        const coordinate = mesh.userData.worldChunk;
        return (
          coordinate.x === expected.x && coordinate.z === expected.z && coordinate.y >= 0 && coordinate.y <= 2
        );
      }),
      `A rendered local 3D chunk covers logical cell ${cell}.`,
    );
    assert.ok(renderer.stats().residentChunks <= 27);
  }

  const farEdited = worldDocumentSchema.parse({
    ...large,
    edits: [{ x: -400, y: 63, z: -400, value: { color: 0xff00ff, materialType: 'EMISSIVE' } }],
  });
  renderer.updateWorld(farEdited);
  assert.ok(
    !chunkMeshes(renderer).some(({ userData }) => {
      const coordinate = userData.worldChunk;
      return coordinate.x === -25 && coordinate.y === 3 && coordinate.z === -25;
    }),
    'An edit outside the current resident window does not allocate a distant chunk early.',
  );
  const editedTarget = new THREE.Vector3(
    -400 * large.voxelSize,
    63 * large.voxelSize,
    -400 * large.voxelSize,
  );
  renderer.update(editedTarget);
  for (let frame = 0; frame < 40; frame++) renderer.update(editedTarget);
  const streamedEdit = chunkMeshes(renderer).find(({ userData }) => {
    const coordinate = userData.worldChunk;
    return coordinate.x === -25 && coordinate.y === 3 && coordinate.z === -25;
  });
  assert.equal(
    streamedEdit?.userData.voxelCellCount,
    1,
    'The sparse edit appears when its chunk streams into view.',
  );
  assert.ok(renderer.stats().residentChunks <= renderer.stats().maximumResidentChunks);

  renderer.dispose();
});

test('voxel worker transfers the synchronous chunk geometry without changing its output', () => {
  const selected = world();
  const target = new THREE.Vector3(0, 14, 0);
  const synchronous = new WorldVoxelRenderer(new THREE.Scene(), selected);
  synchronous.update(target);
  const expected = chunkMeshes(synchronous)[0]!;
  const { data, transfer } = serializeVoxelChunkGeometry(expected.geometry);
  const decoded = deserializeVoxelChunkGeometry(data);
  assert.equal(transfer.length, 4);
  assert.deepEqual(transfer, [
    data.position.buffer,
    data.normal.buffer,
    data.color.buffer,
    data.index.buffer,
  ]);
  sameGeometry(expected.geometry, decoded);

  const worker = new FakeVoxelWorker();
  const asynchronous = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  asynchronous.update(target);
  const request = worker.requests[0];
  assert.ok(request.world, 'The worker receives its world only with its first request.');
  worker.reply({
    id: request.id,
    revision: request.revision,
    coordinate: request.coordinate,
    geometry: data,
    voxelCellCount: expected.userData.voxelCellCount,
    hasCaveFaces: (expected.material as THREE.Material[]).length === 5,
    meshMs: 1,
  });
  const installed = chunkMeshes(asynchronous)[0]!;
  sameGeometry(expected.geometry, installed.geometry);
  assert.deepEqual(installed.position.toArray(), expected.position.toArray());
  assert.deepEqual(installed.scale.toArray(), expected.scale.toArray());
  assert.equal(installed.receiveShadow, expected.receiveShadow);
  assert.equal(installed.userData.voxelCellCount, expected.userData.voxelCellCount);
  assert.ok(asynchronous.stats().residentChunks <= asynchronous.stats().maximumResidentChunks);
  assert.equal(asynchronous.stats().workerChunkBuildMs.count, 1);
  assert.equal(asynchronous.stats().chunkInstallMs.count, 1);
  assert.ok(asynchronous.stats().chunkInstallMs.maxMs >= asynchronous.stats().chunkInstallMs.p50Ms);

  decoded.dispose();
  synchronous.dispose();
  asynchronous.dispose();
});

test('voxel worker builds coarse cave-ring chunks and installs the same geometry as the sync path', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [-160, -160], size: [320, 320] },
  });
  const target = new THREE.Vector3(0, 12, 0);
  const worker = new FakeVoxelWorker();
  const asynchronous = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  const synchronous = new WorldVoxelRenderer(new THREE.Scene(), selected);

  asynchronous.update(target);
  assert.ok(worker.requests[0]?.world, 'The first request initializes the world on the worker.');
  let guard = 0;
  while (!worker.requests[worker.requests.length - 1]?.coarseFactor && guard++ < 40) {
    const request = worker.requests[worker.requests.length - 1]!;
    worker.reply({
      id: request.id,
      revision: request.revision,
      coordinate: request.coordinate,
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs: 0.1,
    });
  }

  let request = worker.requests[worker.requests.length - 1]!;
  assert.equal(request.coarseFactor, 2, 'Fine chunks retain priority before cave LOD work.');
  assert.equal(
    asynchronous.stats().caveLodChunkBuildMs.count,
    0,
    'The editor thread waits for the worker instead of synchronously meshing the coarse chunk.',
  );
  let expected = synchronous.buildCoarseChunkGeometry(request.coordinate);
  let emptyGuard = 0;
  while (!expected && emptyGuard++ < 100) {
    worker.reply({
      id: request.id,
      revision: request.revision,
      coordinate: request.coordinate,
      coarseFactor: request.coarseFactor,
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs: 0.1,
    });
    request = worker.requests[worker.requests.length - 1]!;
    assert.equal(request.coarseFactor, 2, 'Near cave chunks continue to precede the far ring.');
    expected = synchronous.buildCoarseChunkGeometry(request.coordinate);
  }
  assert.ok(
    expected,
    `The selected world contains a coarse solid in the requested ring chunk ${JSON.stringify(request.coordinate)}.`,
  );
  const previousWorkerLodBuilds = asynchronous.stats().caveLodChunkBuildMs.count;
  const serialized = serializeVoxelChunkGeometry(expected.geometry);
  worker.reply({
    id: request.id,
    revision: request.revision,
    coordinate: request.coordinate,
    coarseFactor: 2,
    geometry: serialized.data,
    voxelCellCount: expected.voxelCellCount,
    hasCaveFaces: false,
    meshMs: 1.25,
  });

  const installed = chunkMeshes(asynchronous).find((mesh) => mesh.userData.worldVoxelLodCellSize === 2);
  assert.ok(installed, 'The coarse worker result is installed as a cave LOD mesh.');
  sameGeometry(expected.geometry, installed!.geometry);
  assert.deepEqual(installed!.position.toArray(), [
    request.coordinate.x * 8,
    request.coordinate.y * 8,
    request.coordinate.z * 8,
  ]);
  assert.deepEqual(installed!.scale.toArray(), [1, 1, 1]);
  assert.equal(asynchronous.stats().caveLodChunkBuildMs.count, previousWorkerLodBuilds + 1);
  assert.equal(asynchronous.stats().caveLodChunkBuildMs.maxMs, 1.25);
  assert.equal(asynchronous.stats().caveLodChunkInstallMs.count, previousWorkerLodBuilds + 1);

  let farGuard = 0;
  let farRequest = worker.requests[worker.requests.length - 1]!;
  let farExpected: ReturnType<WorldVoxelRenderer['buildCoarseChunkGeometry']> = null;
  while (farGuard++ < 600) {
    if (farRequest.coarseFactor === 4) {
      farExpected = synchronous.buildCoarseChunkGeometry(farRequest.coordinate, 4);
      if (farExpected) break;
    }
    worker.reply({
      id: farRequest.id,
      revision: farRequest.revision,
      coordinate: farRequest.coordinate,
      ...(farRequest.coarseFactor && { coarseFactor: farRequest.coarseFactor }),
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs: 0.1,
    });
    farRequest = worker.requests[worker.requests.length - 1]!;
  }
  assert.equal(
    farRequest.coarseFactor,
    4,
    'The outer cave ring requests factor-four geometry from the worker.',
  );
  assert.ok(farExpected, 'The expanded test world contains solid volume in the far cave ring.');
  const farSerialized = serializeVoxelChunkGeometry(farExpected.geometry);
  worker.reply({
    id: farRequest.id,
    revision: farRequest.revision,
    coordinate: farRequest.coordinate,
    coarseFactor: 4,
    geometry: farSerialized.data,
    voxelCellCount: farExpected.voxelCellCount,
    hasCaveFaces: false,
    meshMs: 2.5,
  });
  const installedFar = chunkMeshes(asynchronous).find((mesh) => mesh.userData.worldVoxelLodCellSize === 4);
  assert.ok(installedFar, 'The factor-four worker result is installed with its world-space cell scale.');
  sameGeometry(farExpected.geometry, installedFar!.geometry);
  assert.deepEqual(installedFar!.scale.toArray(), [2, 2, 2]);
  assert.ok(asynchronous.stats().caveLodChunkBuildMs.count > previousWorkerLodBuilds + 1);
  assert.equal(asynchronous.stats().caveLodChunkBuildMs.maxMs, 2.5);

  expected.geometry.dispose();
  farExpected.geometry.dispose();
  synchronous.dispose();
  asynchronous.dispose();
});

test('voxel worker requests and installs factor-eight cave-ring geometry', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [-192, -192], size: [384, 384] },
  });
  const target = new THREE.Vector3(0, 12, 0);
  const worker = new FakeVoxelWorker();
  const asynchronous = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  const synchronous = new WorldVoxelRenderer(new THREE.Scene(), selected);

  asynchronous.update(target);
  let request = worker.requests[worker.requests.length - 1]!;
  let guard = 0;
  while (!request.coarseFactor && guard++ < 40) {
    worker.reply({
      id: request.id,
      revision: request.revision,
      coordinate: request.coordinate,
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs: 0.1,
    });
    request = worker.requests[worker.requests.length - 1]!;
  }

  let expected: ReturnType<WorldVoxelRenderer['buildCoarseChunkGeometry']> = null;
  while (guard++ < 900) {
    if (request.coarseFactor === 8) {
      expected = synchronous.buildCoarseChunkGeometry(request.coordinate, 8);
      if (expected) break;
    }
    worker.reply({
      id: request.id,
      revision: request.revision,
      coordinate: request.coordinate,
      ...(request.coarseFactor && { coarseFactor: request.coarseFactor }),
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs: 0.1,
    });
    request = worker.requests[worker.requests.length - 1]!;
  }
  assert.equal(request.coarseFactor, 8, 'The outer cave ring sends factor-eight work to the worker.');
  assert.ok(expected, 'The world-edge chunk has a factor-eight cave mesh.');

  const serialized = serializeVoxelChunkGeometry(expected.geometry);
  worker.reply({
    id: request.id,
    revision: request.revision,
    coordinate: request.coordinate,
    coarseFactor: 8,
    geometry: serialized.data,
    voxelCellCount: expected.voxelCellCount,
    hasCaveFaces: false,
    meshMs: 3.75,
  });
  const installed = chunkMeshes(asynchronous).find((mesh) => mesh.userData.worldVoxelLodCellSize === 8);
  assert.ok(installed, 'The worker result installs with factor-eight world-space scale.');
  sameGeometry(expected.geometry, installed!.geometry);
  assert.deepEqual(installed!.scale.toArray(), [4, 4, 4]);
  assert.equal(asynchronous.stats().caveLodChunkBuildMs.maxMs, 3.75);

  expected.geometry.dispose();
  synchronous.dispose();
  asynchronous.dispose();
});

test('voxel worker requests and installs factor-sixteen outer cave-ring geometry', () => {
  const base = world();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, origin: [208, -16], size: [64, 32] },
  });
  const target = new THREE.Vector3(0, 12, 0);
  const worker = new FakeVoxelWorker();
  const asynchronous = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);

  asynchronous.update(target);
  const request = worker.requests[worker.requests.length - 1]!;
  assert.equal(
    request.coarseFactor,
    16,
    'A world that only intersects the outer ring requests factor-sixteen work.',
  );
  const expected = asynchronous.buildCoarseChunkGeometry(request.coordinate, 16);
  assert.ok(expected, 'The outer-ring world chunk has coarse geometry.');

  worker.reply({
    id: request.id,
    revision: request.revision,
    coordinate: request.coordinate,
    coarseFactor: 16,
    geometry: serializeVoxelChunkGeometry(expected.geometry).data,
    voxelCellCount: expected.voxelCellCount,
    hasCaveFaces: false,
    meshMs: 4.25,
  });

  const installed = chunkMeshes(asynchronous).find((mesh) => mesh.userData.worldVoxelLodCellSize === 16);
  assert.ok(installed, 'The factor-sixteen worker result installs in the outer cave ring.');
  sameGeometry(expected.geometry, installed!.geometry);
  assert.deepEqual(installed!.scale.toArray(), [8, 8, 8]);
  assert.equal(asynchronous.stats().caveLodChunkBuildMs.maxMs, 4.25);

  expected.geometry.dispose();
  asynchronous.dispose();
});

test('synchronous standalone chunk updates rebuild one affected chunk on the next frame', () => {
  const selected = compactWorld(),
    renderer = new WorldVoxelRenderer(new THREE.Scene(), selected),
    target = new THREE.Vector3(0, 10, 0);
  renderer.update(target);
  const original = chunkMeshes(renderer)[0]!;
  const edited = worldDocumentSchema.parse({
    ...selected,
    edits: [{ x: 0, y: 30, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } }],
  });
  renderer.updateWorld(edited);
  renderer.update(target);
  assert.equal(chunkMeshes(renderer).length, 1);
  assert.notEqual(chunkMeshes(renderer)[0], original);
  assert.equal(chunkMeshes(renderer)[0]!.userData.voxelCellCount, original.userData.voxelCellCount + 1);
  renderer.dispose();
});

test('voxel worker applies the latest sparse edit before rebuilding and drops an out-of-date result', () => {
  const selected = compactWorld(),
    target = new THREE.Vector3(0, 10, 0),
    worker = new FakeVoxelWorker(),
    renderer = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  renderer.update(target);
  const initialRequest = worker.requests[0],
    initialResponse = responseFor(selected, initialRequest);
  assert.ok(initialResponse.geometry);
  worker.reply(initialResponse);
  const originalMesh = chunkMeshes(renderer)[0]!;
  const firstEdit = worldDocumentSchema.parse({
    ...selected,
    edits: [{ x: 0, y: 30, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } }],
  });
  renderer.updateWorld(firstEdit);
  renderer.update(target);
  const staleRequest = worker.requests[1];
  assert.deepEqual(staleRequest.edits, firstEdit.edits);
  assert.equal(chunkMeshes(renderer)[0], originalMesh, 'The old mesh remains until the worker finishes.');

  const latestEdit = worldDocumentSchema.parse({
    ...firstEdit,
    edits: [{ x: 0, y: 30, z: 0, value: { color: 0x2277dd, materialType: 'METALLIC' } }],
  });
  renderer.updateWorld(latestEdit);
  renderer.update(target);
  worker.reply(responseFor(firstEdit, staleRequest));
  assert.equal(
    chunkMeshes(renderer)[0],
    originalMesh,
    'The stale edit result does not replace the resident mesh.',
  );
  const currentRequest = worker.requests[2];
  assert.deepEqual(currentRequest.edits, latestEdit.edits);
  assert.equal(currentRequest.revision, staleRequest.revision + 1);
  worker.reply(responseFor(latestEdit, currentRequest));
  const latestMesh = chunkMeshes(renderer)[0]!;
  const expectedSource = new WorldVoxelRenderer(new THREE.Scene(), latestEdit),
    expected = expectedSource.buildChunkGeometry(currentRequest.coordinate)!;
  sameGeometry(latestMesh.geometry, expected.geometry);
  assert.equal(latestMesh.userData.voxelCellCount, initialResponse.voxelCellCount + 1);

  const tombstoneWorld = worldDocumentSchema.parse({
    ...latestEdit,
    edits: [...latestEdit.edits, { x: 0, y: 16, z: 0, value: null }],
  });
  renderer.updateWorld(tombstoneWorld);
  renderer.update(target);
  const tombstoneRequest = worker.requests[3];
  assert.deepEqual(tombstoneRequest.edits, [{ x: 0, y: 16, z: 0, value: null }]);
  worker.reply(responseFor(tombstoneWorld, tombstoneRequest));
  const tombstoneMesh = chunkMeshes(renderer)[0]!;
  assert.equal(tombstoneMesh.userData.voxelCellCount, initialResponse.voxelCellCount);
  renderer.updateWorld(latestEdit);
  renderer.update(target);
  const clearedRequest = worker.requests[4];
  assert.deepEqual(clearedRequest.clearedEdits, [{ x: 0, y: 16, z: 0 }]);
  worker.reply(responseFor(latestEdit, clearedRequest));
  assert.equal(chunkMeshes(renderer)[0]!.userData.voxelCellCount, initialResponse.voxelCellCount + 1);
  expected.geometry.dispose();
  expectedSource.dispose();
  renderer.dispose();
});

test('a sparse edit on a chunk edge asynchronously rebuilds each resident face neighbor', () => {
  const selected = compactWorld(32),
    target = new THREE.Vector3(0, 10, 0),
    worker = new FakeVoxelWorker(),
    renderer = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  renderer.update(target);
  worker.reply(responseFor(selected, worker.requests[0]));
  worker.reply(responseFor(selected, worker.requests[1]));
  const originalMeshes = new Map(
    chunkMeshes(renderer).map((mesh) => [
      `${mesh.userData.worldChunk.x},${mesh.userData.worldChunk.y},${mesh.userData.worldChunk.z}`,
      mesh,
    ]),
  );
  assert.ok(originalMeshes.has('0,1,0'));
  assert.ok(originalMeshes.has('1,1,0'));

  const edited = worldDocumentSchema.parse({
    ...selected,
    edits: [{ x: 15, y: 16, z: 0, value: null }],
  });
  renderer.updateWorld(edited);
  renderer.update(target);
  const first = worker.requests[2];
  worker.reply(responseFor(edited, first));
  const second = worker.requests[3];
  assert.notDeepEqual(first.coordinate, second.coordinate);
  worker.reply(responseFor(edited, second));
  const rebuilt = chunkMeshes(renderer);
  for (const coordinate of ['0,1,0', '1,1,0']) {
    const mesh = rebuilt.find((candidate) => {
      const chunk = candidate.userData.worldChunk;
      return `${chunk.x},${chunk.y},${chunk.z}` === coordinate;
    });
    assert.ok(mesh);
    assert.notEqual(mesh, originalMeshes.get(coordinate), `Resident chunk ${coordinate} was rebuilt.`);
  }
  renderer.dispose();
});

test('edit updates keep distant heightfield tiles resident and refresh the affected silhouette', () => {
  const base = world(),
    selected = worldDocumentSchema.parse({
      ...base,
      generator: { ...base.generator, origin: [-128, -128], size: [256, 256] },
    }),
    scene = new THREE.Scene(),
    target = new THREE.Vector3(0, 14, 0),
    renderer = new WorldVoxelRenderer(scene, selected);
  for (let frame = 0; frame < 150; frame++) renderer.update(target);
  const distant = scene.getObjectByName(`world:${selected.id}`)!;
  const initialTile = distant.children.find(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh &&
      child.userData.worldLod === 'medium' &&
      child.userData.worldMediumTile.x === 1 &&
      child.userData.worldMediumTile.z === 0,
  );
  assert.ok(initialTile, 'The target medium-level silhouette tile is resident.');
  initialTile!.geometry.computeBoundingBox();
  const initialHeight = initialTile!.geometry.boundingBox!.max.y;
  const edited = worldDocumentSchema.parse({
    ...selected,
    edits: [{ x: 48, y: 63, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } }],
  });
  renderer.updateWorld(edited);
  assert.equal(scene.getObjectByName(`world:${selected.id}`), distant);
  let updatedTile = initialTile;
  for (let frame = 0; frame < 100 && updatedTile === initialTile; frame++) {
    renderer.update(target);
    updatedTile = distant.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh &&
        child.userData.worldLod === 'medium' &&
        child.userData.worldMediumTile.x === 1 &&
        child.userData.worldMediumTile.z === 0,
    )!;
  }
  assert.ok(updatedTile);
  assert.notEqual(updatedTile, initialTile, 'The affected distant tile was refreshed in place.');
  updatedTile!.geometry.computeBoundingBox();
  assert.ok(
    updatedTile!.geometry.boundingBox!.max.y > initialHeight,
    'The edited high cell changes the silhouette.',
  );
  renderer.dispose();
});

test('voxel worker drops a completed chunk after the camera moves to another window', () => {
  const selected = world();
  selected.generator.origin = [-128, -128];
  selected.generator.size = [256, 256];
  const worker = new FakeVoxelWorker();
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  renderer.update(new THREE.Vector3(0, 14, 4));
  const stale = worker.requests[0];
  const source = new WorldVoxelRenderer(new THREE.Scene(), selected);
  const staleBuild = source.buildChunkGeometry(stale.coordinate)!;
  const serialized = serializeVoxelChunkGeometry(staleBuild.geometry);
  for (const x of [16, 32, 48, -29]) renderer.update(new THREE.Vector3(x, 14, 4));
  assert.equal(worker.requests.length, 1, 'Camera moves coalesce behind the one in-flight worker request.');
  worker.reply({
    id: stale.id,
    revision: stale.revision,
    coordinate: stale.coordinate,
    geometry: serialized.data,
    voxelCellCount: staleBuild.voxelCellCount,
    hasCaveFaces: staleBuild.hasCaveFaces,
    meshMs: 1,
  });
  assert.equal(chunkMeshes(renderer).length, 0);
  assert.equal(renderer.stats().residentChunks, 0);
  assert.equal(worker.requests.length, 2);
  assert.notEqual(worker.requests[1].revision, stale.revision);
  assert.deepEqual(worker.requests[1].coordinate, { x: -4, y: 1, z: 0 }, 'Only the latest window is queued.');
  assert.ok(renderer.stats().residentChunks <= renderer.stats().maximumResidentChunks);
  staleBuild.geometry.dispose();
  source.dispose();
  renderer.dispose();
});

test('voxel worker reprioritizes pending chunks toward the latest viewer position', () => {
  const selected = world();
  selected.generator.origin = [-128, -128];
  selected.generator.size = [256, 256];
  const worker = new FakeVoxelWorker();
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), selected, () => worker as unknown as Worker);
  const replyEmpty = (index: number) =>
    worker.reply({
      id: worker.requests[index].id,
      revision: worker.requests[index].revision,
      coordinate: worker.requests[index].coordinate,
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs: 1,
    });
  try {
    renderer.update(new THREE.Vector3(7.5, 12, 4));
    assert.deepEqual(worker.requests[0].coordinate, { x: 0, y: 1, z: 0 });
    renderer.update(new THREE.Vector3(0.5, 12, 4));
    assert.equal(worker.requests.length, 1, 'The worker keeps only one build in flight.');
    replyEmpty(0);
    assert.deepEqual(
      worker.requests[1].coordinate,
      { x: -1, y: 1, z: 0 },
      'The next chunk follows the viewer after movement within the same window.',
    );
    renderer.update(new THREE.Vector3(7.5, 12, 4));
    replyEmpty(1);
    assert.deepEqual(worker.requests[2].coordinate, { x: 1, y: 1, z: 0 });
    assert.ok(renderer.stats().residentChunks <= renderer.stats().maximumResidentChunks);
  } finally {
    renderer.dispose();
  }
});

test('disposing a voxel renderer terminates its worker and rejects a late chunk', () => {
  const worker = new FakeVoxelWorker();
  const renderer = new WorldVoxelRenderer(new THREE.Scene(), world(), () => worker as unknown as Worker);
  renderer.update(new THREE.Vector3(0, 14, 0));
  const request = worker.requests[0];
  renderer.dispose();
  worker.reply({
    id: request.id,
    revision: request.revision,
    coordinate: request.coordinate,
    geometry: null,
    voxelCellCount: 0,
    hasCaveFaces: false,
    meshMs: 1,
  });
  renderer.update(new THREE.Vector3(64, 14, 0));
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null, 'Disposal detaches the callback that captures the renderer.');
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  assert.equal(worker.requests.length, 1);
  assert.equal(renderer.group.children.length, 0);
});

test('voxel worker creation and runtime failures fall back to one synchronous chunk at a time', () => {
  const selected = world();
  const target = new THREE.Vector3(0, 14, 0);
  const expectedRenderer = new WorldVoxelRenderer(new THREE.Scene(), selected);
  expectedRenderer.update(target);
  const expected = chunkMeshes(expectedRenderer)[0]!;

  const creationFailure = new WorldVoxelRenderer(new THREE.Scene(), selected, () => {
    throw new Error('Worker unavailable');
  });
  creationFailure.update(target);
  const afterCreationFailure = chunkMeshes(creationFailure)[0]!;
  sameGeometry(expected.geometry, afterCreationFailure.geometry);
  assert.equal(creationFailure.stats().residentChunks, 1);

  const worker = new FakeVoxelWorker();
  const runtimeFailure = new WorldVoxelRenderer(
    new THREE.Scene(),
    selected,
    () => worker as unknown as Worker,
  );
  runtimeFailure.update(target);
  worker.fail();
  runtimeFailure.update(target);
  const afterRuntimeFailure = chunkMeshes(runtimeFailure)[0]!;
  sameGeometry(expected.geometry, afterRuntimeFailure.geometry);
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null, 'Worker failure detaches every renderer callback.');
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  assert.equal(runtimeFailure.stats().residentChunks, 1);
  runtimeFailure.update(target);
  assert.ok(runtimeFailure.stats().residentChunks <= 2, 'Fallback builds at most one chunk per update.');

  expectedRenderer.dispose();
  creationFailure.dispose();
  runtimeFailure.dispose();
});
