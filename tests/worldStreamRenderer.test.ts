import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { newProject, validateProject } from '../services/projectDocument';
import { worldDocumentSchema } from '../services/worldDocument';
import { WorldStreamRenderer } from '../runtime/WorldStreamRenderer';
import { geometryArrayBytes } from '../runtime/geometryArrayBytes';
import {
  deserializeTileGeometry,
  serializeTileGeometry,
  type TileBuildRequest,
  type TileBuildResponse,
} from '../runtime/worldStreamWorkerProtocol';

function world(chunkSize: number, width = 2, maxY = 0, edits: unknown = [], baseHeight = 0, depth = 1) {
  return worldDocumentSchema.parse({
    id: 'island',
    name: 'Island',
    seed: 42,
    chunkSize,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [0, 0],
      size: [width, depth],
      minY: 0,
      maxY,
      baseHeight,
      amplitude: 0,
      palette: { surface: 0x55aa44, subsurface: 0x725439, deep: 0x686b70, materialType: 'STANDARD' },
    },
    edits,
  });
}

const meshes = (renderer: WorldStreamRenderer) =>
  renderer.group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);

const tileKey = (mesh: THREE.Mesh) => {
  const level = mesh.userData.worldLod as string;
  const coordinate = mesh.userData[
    level === 'near'
      ? 'worldTile'
      : level === 'medium'
        ? 'worldMediumTile'
        : level === 'far'
          ? 'worldFarTile'
          : 'worldHorizonTile'
  ] as { x: number; z: number };
  return `${level}:${coordinate.x},${coordinate.z}`;
};

const geometryHash = (geometry: THREE.BufferGeometry) => {
  const hash = createHash('sha256');
  for (const name of ['position', 'normal', 'color'] as const) {
    const array = geometry.getAttribute(name).array;
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  const index = geometry.index!.array;
  hash.update(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
  hash.update(JSON.stringify(geometry.groups));
  return hash.digest('hex');
};

function settleSync(renderer: WorldStreamRenderer, target: THREE.Vector3) {
  for (let frame = 0; frame < 300; frame++) {
    const before = meshes(renderer);
    renderer.update(target);
    const after = meshes(renderer);
    if (before.length === after.length && before.every((mesh, index) => mesh === after[index])) return;
  }
  assert.fail('The synchronous renderer did not finish its bounded tile queue.');
}

class FakeTerrainWorker {
  onmessage: ((event: MessageEvent<TileBuildResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  requests: TileBuildRequest[] = [];
  terminated = false;

  postMessage(message: TileBuildRequest) {
    this.requests.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(response: TileBuildResponse) {
    this.onmessage?.({ data: response } as MessageEvent<TileBuildResponse>);
  }

  fail() {
    this.onerror?.();
  }
}

class BuildingTerrainWorker extends FakeTerrainWorker {
  pending = 0;
  private renderer: WorldStreamRenderer | null = null;

  override postMessage(request: TileBuildRequest) {
    super.postMessage(request);
    this.pending++;
    queueMicrotask(() => {
      try {
        if (request.world) this.renderer = new WorldStreamRenderer(new THREE.Scene(), request.world);
        else if (this.renderer && (request.edits?.length || request.clearedEdits?.length))
          this.renderer.applyWorldEditPatch(request.edits ?? [], request.clearedEdits ?? []);
        const geometry = this.renderer?.buildTileGeometry(
          request.level,
          request.coordinate,
          new THREE.Vector3(...request.target),
          request.excludedY,
        );
        const data = geometry ? serializeTileGeometry(geometry).data : null;
        geometry?.dispose();
        this.reply({ ...request, geometry: data, meshMs: 0 });
      } finally {
        this.pending--;
      }
    });
  }

  override terminate() {
    super.terminate();
    this.renderer?.dispose();
    this.renderer = null;
  }
}

async function settleWorker(
  renderer: WorldStreamRenderer,
  worker: BuildingTerrainWorker,
  target: THREE.Vector3,
) {
  let previousRequestCount = -1;
  let quietFrames = 0;
  for (let frame = 0; frame < 300; frame++) {
    renderer.update(target);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (worker.pending === 0 && worker.requests.length === previousRequestCount) quietFrames++;
    else quietFrames = 0;
    if (quietFrames >= 2) return;
    previousRequestCount = worker.requests.length;
  }
  assert.fail('The worker renderer did not finish its bounded tile queue.');
}

test('terrain worker carries the voxel cutout and rebuilds it after vertical-only travel', async () => {
  const selected = world(16, 16, 63, [], 32, 16);
  const worker = new BuildingTerrainWorker();
  let cutout: [number, number] = [-16, 32];
  const mask = ({ x, z }: { x: number; z: number }) => (x === 0 && z === 0 ? cutout : undefined);
  const renderer = new WorldStreamRenderer(
    new THREE.Scene(),
    selected,
    mask,
    () => worker as unknown as Worker,
  );
  const fresh = new WorldStreamRenderer(new THREE.Scene(), selected);
  try {
    for (const y of [0, 16, 40]) {
      const center = Math.floor(y / 8);
      cutout = [(center - 1) * 16, (center + 2) * 16];
      const target = new THREE.Vector3(0, y, 0);
      await settleWorker(renderer, worker, target);
      const request = worker.requests.filter((entry) => entry.level === 'near').at(-1)!;
      assert.deepEqual(request.excludedY, cutout);
      const mesh = meshes(renderer).find((entry) => tileKey(entry) === 'near:0,0')!;
      const expected = fresh.buildTileGeometry('near', { x: 0, z: 0 }, target, cutout)!;
      assert.equal(geometryHash(mesh.geometry), geometryHash(expected));
      expected.dispose();
    }
  } finally {
    renderer.dispose();
    fresh.dispose();
  }
});

function assertRetainedTilesMatchFresh(
  renderer: WorldStreamRenderer,
  selected: ReturnType<typeof world>,
  before: Map<string, string>,
  target: THREE.Vector3,
) {
  const retained = meshes(renderer).filter((mesh) => before.has(tileKey(mesh)));
  const fresh = new WorldStreamRenderer(new THREE.Scene(), selected);
  const retainedByLevel: Record<string, number> = {};
  const changedByLevel: Record<string, number> = {};
  try {
    for (const mesh of retained) {
      const key = tileKey(mesh);
      const [level, coordinate] = key.split(':');
      const [x, z] = coordinate.split(',').map(Number);
      const rebuilt = fresh.buildTileGeometry(
        level as 'near' | 'medium' | 'far' | 'horizon',
        { x, z },
        target,
      );
      assert.ok(rebuilt, `Fresh ${level} tile ${coordinate} has terrain.`);
      const currentHash = geometryHash(mesh.geometry);
      const freshHash = geometryHash(rebuilt);
      assert.equal(
        currentHash,
        freshHash,
        `Retained ${level} tile ${coordinate} matches a fresh same-LOD rebuild after recentering.`,
      );
      retainedByLevel[level] = (retainedByLevel[level] ?? 0) + 1;
      if (before.get(key) !== freshHash) changedByLevel[level] = (changedByLevel[level] ?? 0) + 1;
      rebuilt.dispose();
    }
  } finally {
    fresh.dispose();
  }
  for (const level of ['near', 'medium', 'far', 'horizon'])
    assert.ok(retainedByLevel[level] > 0, `The recenter retains at least one ${level} tile.`);
  assert.ok(changedByLevel.near > 0, 'At least one retained tile changes at the moved near-window boundary.');
  assert.ok(changedByLevel.medium > 0, 'At least one retained tile changes at the moved medium transition.');
  assert.ok(changedByLevel.far > 0, 'At least one retained tile changes at the moved far transition.');
  assert.ok(
    changedByLevel.horizon > 0,
    'At least one retained tile changes at the moved horizon transition.',
  );
}

test('scene world references are optional for old projects and validated when present', () => {
  const project = newProject('project', 'Project');
  const legacy = validateProject({ ...project, scenes: [{ id: 'main', name: 'Main scene' }] });
  assert.equal(legacy.scenes[0].worldId, null);
  assert.throws(
    () => validateProject({ ...project, scenes: [{ ...legacy.scenes[0], worldId: 'missing' }] }),
    /Missing world on scene/,
  );
  assert.equal(
    validateProject({ ...project, worlds: [world(4)], scenes: [{ ...legacy.scenes[0], worldId: 'island' }] })
      .scenes[0].worldId,
    'island',
  );
});

test('heightfield tiles build incrementally and hide opaque faces across tile boundaries', () => {
  const scene = new THREE.Scene();
  const renderer = new WorldStreamRenderer(scene, world(32, 17));
  const target = new THREE.Vector3(0.1, 0.1, 0.1);
  let loaded = 0;
  for (let frame = 0; frame < 4; frame++) {
    renderer.update(target);
    const stats = renderer.stats();
    assert.ok(stats.residentChunks <= stats.maximumResidentChunks);
    assert.ok(stats.loadedChunks - loaded <= 1, 'At most one synchronous tile mesh is built per update.');
    loaded = stats.loadedChunks;
  }
  const tileMeshes = meshes(renderer);
  assert.equal(renderer.stats().renderChunkSize, 16, 'The runtime uses 16×16 heightfield tiles.');
  assert.equal(renderer.stats().maximumResidentChunks, 25);
  assert.equal(renderer.stats().verticalMode, 'heightfield');
  assert.equal(renderer.stats().updateMs.count, 4);
  assert.ok(renderer.stats().updateMs.p95Ms >= 0, 'The rolling stream update timing is exposed.');
  assert.equal(tileMeshes.length, 2);
  assert.deepEqual(
    tileMeshes.map((mesh) => mesh.scale.x),
    [0.5, 0.5],
  );
  assert.equal(tileMeshes[0].geometry.index!.count, 390);
  assert.equal(tileMeshes[1].geometry.index!.count, 30);
  assert.equal(
    renderer.stats().residentGeometryArrayBytes,
    tileMeshes.reduce((total, mesh) => total + geometryArrayBytes(mesh.geometry), 0),
    'The renderer reports the CPU geometry-array storage it actually retains.',
  );

  const rightTile = tileMeshes.find((mesh) => mesh.userData.worldTile.x === 1)!;
  const position = rightTile.geometry.getAttribute('position');
  const normal = rightTile.geometry.getAttribute('normal');
  for (let vertex = 0; vertex < position.count; vertex++) {
    assert.ok(
      !(position.getX(vertex) === -0.5 && normal.getX(vertex) === -1),
      'The shared opaque tile boundary has no internal left-facing faces.',
    );
  }
  renderer.dispose();
  assert.equal(renderer.group.children.length, 0);
});

test('heightfield tile stats report bounded main-thread build durations by LOD', () => {
  const renderer = new WorldStreamRenderer(new THREE.Scene(), world(16, 16, 0, [], 0, 16));
  renderer.update(new THREE.Vector3());
  const timings = renderer.stats().tileBuildMs;
  assert.equal(timings.near.count, 1);
  assert.ok(Number.isFinite(timings.near.p50Ms) && timings.near.p50Ms >= 0);
  assert.ok(timings.near.maxMs >= timings.near.p50Ms);
  assert.deepEqual(
    [timings.medium.count, timings.far.count, timings.horizon.count],
    [0, 0, 0],
    'Unbuilt LOD tiers do not report fabricated timing samples.',
  );
  renderer.dispose();
});

test('worker geometry transfer round-trips the same typed arrays and installs the same tile', () => {
  const selected = world(16, 16, 0, [], 0, 16);
  const target = new THREE.Vector3();
  const source = new WorldStreamRenderer(new THREE.Scene(), selected);
  const sourceGeometry = source.buildTileGeometry('near', { x: 0, z: 0 }, target)!;
  const { data, transfer } = serializeTileGeometry(sourceGeometry);
  const decoded = deserializeTileGeometry(data);
  assert.equal(transfer.length, 4);
  assert.deepEqual(transfer, [
    data.position.buffer,
    data.normal.buffer,
    data.color.buffer,
    data.index.buffer,
  ]);
  for (const name of ['position', 'normal', 'color'] as const)
    assert.deepEqual(
      Array.from(decoded.getAttribute(name).array),
      Array.from(sourceGeometry.getAttribute(name).array),
    );
  assert.deepEqual(Array.from(decoded.index!.array), Array.from(sourceGeometry.index!.array));
  assert.deepEqual(decoded.groups, sourceGeometry.groups);

  const scene = new THREE.Scene();
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(scene, selected, undefined, () => worker as unknown as Worker);
  renderer.update(target);
  const request = worker.requests[0];
  worker.reply({ ...request, geometry: data, meshMs: 2 });
  const installed = meshes(renderer).find((mesh) => mesh.userData.worldLod === 'near')!.geometry;
  assert.deepEqual(
    Array.from(installed.getAttribute('position').array),
    Array.from(sourceGeometry.getAttribute('position').array),
  );
  assert.deepEqual(Array.from(installed.index!.array), Array.from(sourceGeometry.index!.array));
  assert.equal(renderer.stats().workerTileBuildMs.near.count, 1);
  assert.equal(renderer.stats().tileInstallMs.near.count, 1);
  renderer.dispose();
  sourceGeometry.dispose();
  decoded.dispose();
  source.dispose();
});

test('terrain worker receives incremental sparse edits and removals after its initial world transfer', () => {
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(
    new THREE.Scene(),
    world(16, 256, 0, [], 0, 256),
    undefined,
    () => worker as unknown as Worker,
  );
  const target = new THREE.Vector3();
  renderer.update(target);
  const initial = worker.requests[0];
  assert.deepEqual(initial.world?.edits, []);

  const added = { x: 1, y: 0, z: 1, value: { color: 0xff00ff, materialType: 'EMISSIVE' as const } };
  renderer.updateWorldEdits([added], [added]);
  worker.reply({ ...initial, geometry: null, meshMs: 1 });
  const addRequest = worker.requests[1];
  assert.deepEqual(addRequest.edits, [added]);
  assert.deepEqual(addRequest.clearedEdits, []);

  const replacement = { ...added, value: { color: 0x00ffff, materialType: 'EMISSIVE' as const } };
  renderer.updateWorldEdits([replacement], [replacement]);
  worker.reply({ ...addRequest, geometry: null, meshMs: 1 });
  const replaceRequest = worker.requests[2];
  assert.deepEqual(replaceRequest.edits, [replacement]);

  renderer.updateWorldEdits([], [replacement]);
  worker.reply({ ...replaceRequest, geometry: null, meshMs: 1 });
  const clearRequest = worker.requests[3];
  assert.deepEqual(clearRequest.edits, []);
  assert.deepEqual(clearRequest.clearedEdits, [{ x: 1, y: 0, z: 1 }]);
  renderer.dispose();
});

test('terrain worker edit patches rebuild the same tile as a fresh world and restore it when cleared', () => {
  const selected = world(16, 16, 0, [], 0, 16);
  const edit = { x: 1, y: 0, z: 1, value: { color: 0xff00ff, materialType: 'EMISSIVE' as const } };
  const target = new THREE.Vector3();
  const patched = new WorldStreamRenderer(new THREE.Scene(), selected);
  const baseline = new WorldStreamRenderer(new THREE.Scene(), selected);
  const edited = new WorldStreamRenderer(new THREE.Scene(), world(16, 16, 0, [edit], 0, 16));

  patched.applyWorldEditPatch([edit], []);
  const patchedGeometry = patched.buildTileGeometry('near', { x: 0, z: 0 }, target)!;
  const editedGeometry = edited.buildTileGeometry('near', { x: 0, z: 0 }, target)!;
  assert.deepEqual(
    Array.from(patchedGeometry.getAttribute('position').array),
    Array.from(editedGeometry.getAttribute('position').array),
  );
  assert.deepEqual(
    Array.from(patchedGeometry.getAttribute('color').array),
    Array.from(editedGeometry.getAttribute('color').array),
  );
  assert.deepEqual(patchedGeometry.groups, editedGeometry.groups);

  patched.applyWorldEditPatch([], [{ x: edit.x, y: edit.y, z: edit.z }]);
  const clearedGeometry = patched.buildTileGeometry('near', { x: 0, z: 0 }, target)!;
  const baselineGeometry = baseline.buildTileGeometry('near', { x: 0, z: 0 }, target)!;
  assert.deepEqual(
    Array.from(clearedGeometry.getAttribute('position').array),
    Array.from(baselineGeometry.getAttribute('position').array),
  );
  assert.deepEqual(
    Array.from(clearedGeometry.getAttribute('color').array),
    Array.from(baselineGeometry.getAttribute('color').array),
  );
  assert.deepEqual(clearedGeometry.groups, baselineGeometry.groups);

  patchedGeometry.dispose();
  editedGeometry.dispose();
  clearedGeometry.dispose();
  baselineGeometry.dispose();
  patched.dispose();
  baseline.dispose();
  edited.dispose();
});

test('coarse column top sampling matches full bands for generated, carved and sparse columns', () => {
  const selected = world(
    16,
    16,
    10,
    [
      { x: 2, y: 4, z: 2, value: null },
      { x: 3, y: 8, z: 3, value: { color: 0xff00ff, materialType: 'EMISSIVE' } },
      { x: 20, y: 7, z: 20, value: { color: 0x123456, materialType: 'METALLIC' } },
      { x: 21, y: 7, z: 21, value: null },
    ],
    4,
    16,
  );
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const internals = renderer as unknown as {
    columnAt: (x: number, z: number) => { start: number; end: number; value: unknown }[];
    columnTopAt: (x: number, z: number) => { top: number; value: unknown } | null;
  };

  for (const [x, z] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [20, 20],
    [21, 21],
  ] as const) {
    const highestBand = internals.columnAt(x, z).at(-1);
    assert.deepEqual(
      internals.columnTopAt(x, z),
      highestBand ? { top: highestBand.end - 1, value: highestBand.value } : null,
      `Direct top sampling must match full band construction at (${x}, ${z}).`,
    );
  }
  renderer.dispose();
});

test('near and coarse heightfield builders return stable geometry for every streamed LOD', () => {
  const renderer = new WorldStreamRenderer(new THREE.Scene(), world(16, 256, 0, [], 0, 256));
  const target = new THREE.Vector3();
  const tiles = [
    ['near', { x: 0, z: 0 }],
    ['medium', { x: 1, z: 1 }],
    ['far', { x: 1, z: 1 }],
    ['horizon', { x: 0, z: 0 }],
  ] as const;
  for (const [level, coordinate] of tiles) {
    const first = renderer.buildTileGeometry(level, coordinate, target);
    const second = renderer.buildTileGeometry(level, coordinate, target);
    assert.ok(first && second, `The ${level} tile has source terrain.`);
    for (const name of ['position', 'normal', 'color'] as const)
      assert.deepEqual(
        Array.from(second.getAttribute(name).array),
        Array.from(first.getAttribute(name).array),
        `${level} vertices are unchanged across repeated builds.`,
      );
    assert.deepEqual(Array.from(second.index!.array), Array.from(first.index!.array));
    assert.deepEqual(second.groups, first.groups);
    first.dispose();
    second.dispose();
  }
  renderer.dispose();
});

test('camera recenter rebuilds retained heightfield tiles to the fresh same-LOD geometry', () => {
  const selected = world(16, 512, 12, [], 6, 512);
  selected.generator.origin = [-256, -256];
  selected.generator.amplitude = 5;
  selected.generator.noise = 1;
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const initialTarget = new THREE.Vector3(64.1, 0, 0.1);
  const recenteredTarget = new THREE.Vector3(96.1, 0, 0.1);
  settleSync(renderer, initialTarget);
  const before = new Map(meshes(renderer).map((mesh) => [tileKey(mesh), geometryHash(mesh.geometry)]));

  settleSync(renderer, recenteredTarget);
  try {
    assertRetainedTilesMatchFresh(renderer, selected, before, recenteredTarget);
  } finally {
    renderer.dispose();
  }
});

test('worker recenter rebuilds retained heightfield tiles to the fresh same-LOD geometry', async () => {
  const selected = world(16, 512, 12, [], 6, 512);
  selected.generator.origin = [-256, -256];
  selected.generator.amplitude = 5;
  selected.generator.noise = 1;
  const worker = new BuildingTerrainWorker();
  const renderer = new WorldStreamRenderer(
    new THREE.Scene(),
    selected,
    undefined,
    () => worker as unknown as Worker,
  );
  const initialTarget = new THREE.Vector3(64.1, 0, 0.1);
  const recenteredTarget = new THREE.Vector3(96.1, 0, 0.1);
  try {
    await settleWorker(renderer, worker, initialTarget);
    const before = new Map(meshes(renderer).map((mesh) => [tileKey(mesh), geometryHash(mesh.geometry)]));
    await settleWorker(renderer, worker, recenteredTarget);
    assertRetainedTilesMatchFresh(renderer, selected, before, recenteredTarget);
  } finally {
    renderer.dispose();
  }
});

test('worker rejects a tile result from an obsolete camera window and requests the current tile', () => {
  const scene = new THREE.Scene();
  const worker = new FakeTerrainWorker();
  const target = new THREE.Vector3(0, 0, 0);
  const asyncRenderer = new WorldStreamRenderer(
    scene,
    world(16, 256, 0, [], 0, 256),
    undefined,
    () => worker as unknown as Worker,
  );
  asyncRenderer.update(target);
  const stale = worker.requests[0];
  for (const x of [32, 48, 64]) asyncRenderer.update(new THREE.Vector3(x, 0, 0));
  assert.equal(worker.requests.length, 1, 'Camera moves coalesce behind the one in-flight worker request.');
  worker.reply({ ...stale, geometry: null, meshMs: 1 });
  assert.equal(asyncRenderer.stats().residentGeometries, 0);
  assert.equal(worker.requests.length, 2);
  assert.notEqual(worker.requests[1].revision, stale.revision);
  assert.equal(worker.requests[1].level, 'near');
  assert.deepEqual(worker.requests[1].coordinate, { x: 8, z: 0 }, 'Only the latest window is queued.');
  assert.ok(asyncRenderer.stats().residentChunks <= asyncRenderer.stats().maximumResidentChunks);
  asyncRenderer.dispose();
});

test('heightfield worker reprioritizes pending tiles toward the latest viewer position', () => {
  const selected = world(16, 256, 0, [], 0, 256);
  selected.generator.origin = [-128, -128];
  selected.generator.size = [256, 256];
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(
    new THREE.Scene(),
    selected,
    undefined,
    () => worker as unknown as Worker,
  );
  const replyEmpty = (index: number) =>
    worker.reply({ ...worker.requests[index], geometry: null, meshMs: 1 });
  try {
    renderer.update(new THREE.Vector3(7.5, 0, 4));
    assert.deepEqual(
      worker.requests[0].coordinate,
      { x: 0, z: 0 },
      'The tile under the viewer builds first.',
    );
    renderer.update(new THREE.Vector3(0.5, 0, 4));
    assert.equal(worker.requests.length, 1, 'The worker keeps only one build in flight.');
    replyEmpty(0);
    assert.deepEqual(
      worker.requests[1].coordinate,
      { x: -1, z: 0 },
      'The next tile follows the viewer after movement within the same window.',
    );
    renderer.update(new THREE.Vector3(7.5, 0, 4));
    replyEmpty(1);
    assert.deepEqual(worker.requests[2].coordinate, { x: 1, z: 0 });
    assert.equal(renderer.stats().maximumResidentGeometries, 100);
    assert.ok(renderer.stats().residentGeometries <= renderer.stats().maximumResidentGeometries);
  } finally {
    renderer.dispose();
  }
});

test('heightfield scheduler ranks streamed LOD geometry by distance to the viewer', () => {
  const selected = world(16, 256, 0, [], 0, 256);
  selected.generator.origin = [-128, -128];
  selected.generator.size = [256, 256];
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(
    new THREE.Scene(),
    selected,
    undefined,
    () => worker as unknown as Worker,
  );
  const target = new THREE.Vector3(15.9, 0, 15.9);
  const replyEmpty = (request: TileBuildRequest) => worker.reply({ ...request, geometry: null, meshMs: 1 });
  try {
    renderer.update(target);
    assert.deepEqual(worker.requests[0].coordinate, { x: 1, z: 1 });
    assert.equal(worker.requests[0].level, 'near', 'An exact-distance tie keeps near detail first.');

    for (let requestCount = 0; requestCount < 100; requestCount++) {
      const request = worker.requests.at(-1)!;
      if (
        request.level === 'medium' &&
        worker.requests.some(
          (entry) => entry.level === 'near' && entry.coordinate.x === -1 && entry.coordinate.z === -1,
        )
      )
        break;
      replyEmpty(request);
    }
    const firstMedium = worker.requests.findIndex((request) => request.level === 'medium');
    const oppositeNearCorner = worker.requests.findIndex(
      (request) => request.level === 'near' && request.coordinate.x === -1 && request.coordinate.z === -1,
    );
    assert.ok(firstMedium >= 0, 'The bounded terrain queue includes medium tiles.');
    assert.ok(
      oppositeNearCorner > firstMedium,
      'A medium tile closer to the viewer is scheduled before a farther near corner tile.',
    );
    assert.ok(renderer.stats().residentGeometries <= renderer.stats().maximumResidentGeometries);
  } finally {
    renderer.dispose();
  }
});

test('heightfield scheduler prioritizes visible camera-frustum tiles over closer offscreen tiles', () => {
  const selected = world(16, 256, 256, [], 128, 256);
  selected.generator.origin = [-128, -128];
  selected.generator.size = [256, 256];
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(
    new THREE.Scene(),
    selected,
    undefined,
    () => worker as unknown as Worker,
  );
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100);
  camera.position.set(12, 64, 0);
  camera.lookAt(12, 64, 100);
  camera.updateProjectionMatrix();
  const target = new THREE.Vector3(0, 32, 0);
  try {
    renderer.update(target, camera);
    assert.deepEqual(
      worker.requests[0].coordinate,
      { x: 1, z: 0 },
      'The first build is the visible tile, even though the offscreen center tile is closer to the viewer target.',
    );
    assert.equal(worker.requests[0].level, 'near');
  } finally {
    renderer.dispose();
  }
});

test('world replacement ignores a late result from the disposed world worker', () => {
  const scene = new THREE.Scene();
  const firstWorld = world(16, 16, 0, [], 0, 16);
  const oldWorker = new FakeTerrainWorker();
  const oldRenderer = new WorldStreamRenderer(
    scene,
    firstWorld,
    undefined,
    () => oldWorker as unknown as Worker,
  );
  oldRenderer.update(new THREE.Vector3());
  const stale = oldWorker.requests[0];
  oldRenderer.dispose();

  const replacement = world(16, 16, 0, [], 0, 16);
  replacement.id = 'replacement';
  const newWorker = new FakeTerrainWorker();
  const newRenderer = new WorldStreamRenderer(
    scene,
    replacement,
    undefined,
    () => newWorker as unknown as Worker,
  );
  newRenderer.update(new THREE.Vector3());
  oldWorker.reply({ ...stale, geometry: null, meshMs: 1 });
  assert.equal(oldWorker.terminated, true);
  assert.equal(newRenderer.stats().worldId, 'replacement');
  assert.equal(newRenderer.stats().residentGeometries, 0);
  newRenderer.dispose();
});

test('dispose terminates the worker and prevents late installation or further dispatch', () => {
  const scene = new THREE.Scene();
  const selected = world(16, 16, 0, [], 0, 16);
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(scene, selected, undefined, () => worker as unknown as Worker);
  renderer.update(new THREE.Vector3());
  const stale = worker.requests[0];
  renderer.dispose();
  worker.reply({ ...stale, geometry: null, meshMs: 1 });
  renderer.update(new THREE.Vector3(256, 0, 0));
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null, 'Disposal detaches the callback that captures the renderer.');
  assert.equal(worker.onerror, null);
  assert.equal(worker.requests.length, 1);
  assert.equal(renderer.group.children.length, 0);
});

test('worker failure falls back to the synchronous one-tile path', () => {
  const scene = new THREE.Scene();
  const worker = new FakeTerrainWorker();
  const renderer = new WorldStreamRenderer(
    scene,
    world(16, 16, 0, [], 0, 16),
    undefined,
    () => worker as unknown as Worker,
  );
  const target = new THREE.Vector3();
  renderer.update(target);
  worker.fail();
  renderer.update(target);
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null, 'Worker failure detaches both renderer callbacks.');
  assert.equal(worker.onerror, null);
  assert.equal(renderer.stats().residentGeometries, 1);
  assert.equal(renderer.stats().tileBuildMs.near.count, 1);
  renderer.dispose();
});

test('terrain peaks above three vertical core rows remain fully rendered', () => {
  const selected = world(32, 1, 64, [], 48);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3());
  const mesh = meshes(renderer)[0];
  assert.ok(mesh, 'The generated terrain tile is resident and rendered.');
  mesh.geometry.computeBoundingBox();
  assert.equal(mesh.geometry.boundingBox!.max.y, 48.5);
  assert.equal(mesh.scale.x, selected.voxelSize);
  renderer.dispose();
});

test('generated one-cell terrain risers remain a visible vertical voxel face', () => {
  const selected = world(16, 4, 10, [], 4, 4);
  selected.generator.amplitude = 3;
  selected.generator.noise = 1;
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3(1, 0, 1));
  const mesh = meshes(renderer)[0]!;
  const position = mesh.geometry.getAttribute('position');
  const normal = mesh.geometry.getAttribute('normal');
  const riserYs: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++)
    if (
      Math.abs(position.getX(vertex) - 0.5) < 1e-6 &&
      Math.abs(normal.getX(vertex) - 1) < 1e-6 &&
      Math.abs(normal.getY(vertex)) < 1e-6 &&
      Math.abs(normal.getZ(vertex)) < 1e-6
    )
      riserYs.push(position.getY(vertex));
  assert.ok(riserYs.length > 0, 'The deterministic one-cell generated riser has an exposed vertical face.');
  assert.equal(
    Math.max(...riserYs) - Math.min(...riserYs),
    1,
    'The exposed face spans exactly one terrain cell.',
  );
  renderer.dispose();
});

test('sparse authored terrain columns retain axis-aligned voxel faces', () => {
  const selected = world(
    16,
    4,
    10,
    [{ x: 1, y: 3, z: 1, value: { color: 0xff00ff, materialType: 'EMISSIVE' } }],
    4,
    4,
  );
  selected.generator.amplitude = 3;
  selected.generator.noise = 1;
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3(1, 0, 1));
  const mesh = meshes(renderer)[0]!;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const emissive = geometry.groups.find((group) => group.materialIndex === 3);
  assert.ok(emissive, 'The explicitly authored replacement remains in its own material group.');
  for (let index = emissive.start; index < emissive.start + emissive.count; index++) {
    const vertex = geometry.index!.getX(index);
    assert.equal(
      [normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex)].filter(
        (component) => Math.abs(component) > 1e-6,
      ).length,
      1,
      'Every explicit edit face normal remains axis-aligned.',
    );
    if (
      position.getX(vertex) > 0.5 &&
      position.getX(vertex) < 1.5 &&
      position.getZ(vertex) > 0.5 &&
      position.getZ(vertex) < 1.5
    )
      assert.ok(
        Number.isInteger(position.getY(vertex) + 0.5),
        'Edited voxel face vertices retain cell-aligned heights.',
      );
  }
  renderer.dispose();
});

test('generated cliffs taller than one cell keep their vertical face', () => {
  const selected = world(16, 16, 100, [], 50, 16);
  selected.generator.amplitude = 40;
  selected.generator.noise = 1;
  selected.generator.landformScale = 4;
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3(4, 0, 2));
  const geometry = meshes(renderer)[0]!.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const cliffYs: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++)
    if (
      Math.abs(position.getX(vertex) - 7.5) < 1e-6 &&
      Math.abs(normal.getX(vertex)) > 0.999 &&
      Math.abs(normal.getY(vertex)) < 1e-6 &&
      Math.abs(normal.getZ(vertex)) < 1e-6
    )
      cliffYs.push(position.getY(vertex));
  assert.ok(cliffYs.length > 0, 'The generated high-to-low column boundary still has a vertical face.');
  assert.ok(
    Math.max(...cliffYs) - Math.min(...cliffYs) > 8,
    'The large generated cliff retains substantial vertical relief.',
  );
  renderer.dispose();
});

test('resident heightfield tiles stay bounded and unload when the camera moves', () => {
  const renderer = new WorldStreamRenderer(new THREE.Scene(), world(32, 256, 0, [], 0, 256));
  const target = new THREE.Vector3(64, 0, 64);
  for (let frame = 0; frame < 100 && renderer.stats().residentChunks < 25; frame++) {
    renderer.update(target);
    const stats = renderer.stats();
    assert.ok(stats.residentChunks <= stats.maximumResidentChunks);
    assert.ok(stats.residentMediumChunks <= stats.maximumResidentMediumChunks);
    assert.ok(stats.residentFarChunks <= stats.maximumResidentFarChunks);
    assert.ok(stats.residentHorizonChunks <= stats.maximumResidentHorizonChunks);
    assert.ok(stats.residentGeometries <= stats.maximumResidentGeometries);
  }
  assert.equal(
    renderer.stats().residentChunks,
    25,
    'All near tiles eventually complete despite cross-LOD work.',
  );
  assert.equal(
    meshes(renderer).filter((mesh) => mesh.userData.worldLod === 'near').length,
    25,
    'All 25 nearby high-detail meshes are resident.',
  );
  assert.ok(meshes(renderer).length <= renderer.stats().maximumResidentGeometries);
  renderer.update(new THREE.Vector3(128, 0, 64));
  assert.equal(
    renderer.stats().residentChunks,
    1,
    'Tiles outside the camera window are unloaded immediately.',
  );
  assert.ok(renderer.stats().residentChunks <= renderer.stats().maximumResidentChunks);
  renderer.dispose();
});

test('positive sparse edits render even outside the generated heightfield bounds', () => {
  const selected = world(16, 1, 0, [
    { x: 20, y: 5, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } },
  ]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3(10, 2.5, 0));
  const editedTile = meshes(renderer).find((mesh) => mesh.userData.worldTile.x === 1);
  assert.ok(editedTile, 'A tile containing only a sparse edit is considered resident.');
  editedTile.geometry.computeBoundingBox();
  assert.equal(editedTile.geometry.boundingBox!.max.y, 5.5);
  renderer.dispose();
});

test('world rendering applies cell replacements and tombstones with independent world voxel spacing', () => {
  const selected = world(4, 1, 1, [
    { x: 0, y: 0, z: 0, value: null },
    { x: 0, y: 1, z: 0, value: { color: 0xff00ff, materialType: 'EMISSIVE' } },
  ]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  renderer.update(new THREE.Vector3());
  const mesh = meshes(renderer)[0]!;
  mesh.geometry.computeBoundingBox();
  assert.deepEqual(mesh.geometry.boundingBox!.min.toArray(), [-0.5, 0.5, -0.5]);
  assert.deepEqual(mesh.geometry.boundingBox!.max.toArray(), [0.5, 1.5, 0.5]);
  assert.equal(mesh.scale.x, selected.voxelSize);
  assert.deepEqual(
    mesh.geometry.groups.map((group) => group.materialIndex),
    [3],
  );
  renderer.dispose();
});
