import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SceneVisuals } from '../runtime/SceneVisuals';
import { OcclusionQueries, type OcclusionToken } from '../runtime/occlusionQueries';
import { createModelDocument } from '../services/modelDocument';
import { assetSchema, nodeSchema } from '../services/projectDocument';

type FakeQuery = { available: boolean; result: number };

function fakeGl() {
  const calls = {
    created: 0,
    deleted: 0,
    begins: 0,
    ends: 0,
    availabilityChecks: 0,
    resultReads: 0,
  };
  const queries: FakeQuery[] = [];
  const gl = {
    ANY_SAMPLES_PASSED_CONSERVATIVE: 1,
    QUERY_RESULT_AVAILABLE: 2,
    QUERY_RESULT: 3,
    createQuery() {
      calls.created++;
      const query = { available: false, result: 0 };
      queries.push(query);
      return query as FakeQuery as WebGLQuery;
    },
    deleteQuery() {
      calls.deleted++;
    },
    beginQuery() {
      calls.begins++;
    },
    endQuery() {
      calls.ends++;
    },
    getQueryParameter(query: WebGLQuery, parameter: number) {
      const value = query as unknown as FakeQuery;
      if (parameter === 2) {
        calls.availabilityChecks++;
        return value.available;
      }
      calls.resultReads++;
      assert.equal(value.available, true, 'result reads happen only after availability');
      return value.result;
    },
  };
  return { gl, calls, queries };
}

test('occlusion queries schedule within a frame budget and poll results asynchronously', () => {
  const { gl, calls, queries } = fakeGl();
  const scheduler = new OcclusionQueries(gl, 2, 1);
  const a: OcclusionToken = {},
    b: OcclusionToken = {},
    overflow: OcclusionToken = {};
  assert.equal(scheduler.register(a), true);
  assert.equal(scheduler.register(b), true);
  assert.equal(scheduler.register(overflow), false);

  scheduler.prepare();
  assert.equal(scheduler.willRun(a), true);
  assert.equal(scheduler.willRun(b), false);
  assert.equal(scheduler.begin(a), true);
  scheduler.end(a);
  assert.deepEqual([calls.begins, calls.ends], [1, 1]);

  assert.equal(scheduler.isOccluded(a), false, 'pending results never block the frame');
  queries[0].available = true;
  queries[0].result = 0;
  scheduler.prepare((token) => token === b);
  assert.equal(scheduler.willRun(b), true, 'the next batch advances under the same fixed budget');
  assert.equal(scheduler.isOccluded(a), true);
  assert.deepEqual(scheduler.stats(), {
    available: true,
    registeredBatches: 2,
    pendingQueries: 0,
    scheduledQueries: 1,
    occludedBatches: 1,
    visibleResults: 0,
    occludedResults: 1,
    discardedResults: 0,
  });
  assert.equal(calls.availabilityChecks, 1, 'only one result-availability check runs per frame');
  assert.equal(calls.resultReads, 1);
  assert.equal(calls.begins, 1, 'prepare never blocks on query completion');
  scheduler.dispose();
});

test('visible query scheduling scans past off-frustum batches within the bounded record set', () => {
  const { gl } = fakeGl();
  const scheduler = new OcclusionQueries(gl, 16, 1);
  const tokens = Array.from({ length: 12 }, () => ({}) as OcclusionToken);
  for (const token of tokens) assert.equal(scheduler.register(token), true);

  const visible = tokens.at(-1)!;
  scheduler.prepare((token) => token === visible);

  assert.equal(scheduler.willRun(visible), true);
  assert.equal(scheduler.stats().scheduledQueries, 1);
  assert.equal(
    tokens.slice(0, -1).some((token) => scheduler.willRun(token)),
    false,
  );
  scheduler.dispose();
});

test('invalidation discards stale occlusion and batch/context disposal releases query handles', () => {
  const { gl, calls, queries } = fakeGl();
  const scheduler = new OcclusionQueries(gl, 1, 1),
    token: OcclusionToken = {};
  scheduler.register(token);
  scheduler.prepare();
  scheduler.begin(token);
  scheduler.end(token);
  scheduler.invalidate(token);
  queries[0].available = true;
  queries[0].result = 0;
  scheduler.prepare();
  assert.equal(scheduler.isOccluded(token), false, 'a stale result cannot hide a changed batch');
  assert.equal(scheduler.stats().discardedResults, 1);
  scheduler.remove(token);
  assert.equal(calls.deleted, 1);

  const restored: OcclusionToken = {};
  scheduler.register(restored);
  scheduler.prepare();
  scheduler.contextLost();
  assert.equal(scheduler.enabled, false);
  assert.equal(calls.deleted, 1, 'lost-context handles are discarded without deletion');
  scheduler.contextRestored();
  assert.equal(scheduler.enabled, true);
  scheduler.prepare();
  scheduler.dispose();
  assert.ok(calls.deleted >= 2, 'live handles are deleted during disposal');
});

test('SceneVisuals probes before its instance batch, skips only the main draw and releases batch queries', () => {
  const { gl, calls, queries } = fakeGl();
  const asset = assetSchema.parse({
    id: 'occlusion-rock',
    name: 'Occlusion rock',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
  });
  const nodes = [0, 1].map((index) =>
    nodeSchema.parse({
      id: `occlusion-${index}`,
      name: 'Occlusion rock',
      assetId: asset.id,
      transform: { position: [index * 2, 0, -5] },
    }),
  );
  const canvas = new EventTarget() as HTMLCanvasElement;
  const renderer = {
    capabilities: { isWebGL2: true },
    domElement: canvas,
    getContext: () => gl,
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600),
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const visuals = new SceneVisuals(scene, nodes, new Map([[asset.id, asset]]), renderer);
  const batch = scene.children.find(
    (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
  )!;
  const proxy = scene.children.find(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && !(child instanceof THREE.InstancedMesh),
  )!;
  const camera = new THREE.PerspectiveCamera();
  camera.updateMatrixWorld(true);
  const renderSceneHook = scene.onBeforeRender as unknown as (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    target: THREE.WebGLRenderTarget | null,
  ) => void;

  assert.equal(batch.renderOrder, 1);
  assert.equal(proxy.renderOrder, 0.5);
  renderSceneHook(renderer, scene, camera, null);
  assert.equal(proxy.visible, true);
  const group = new THREE.Group();
  proxy.onBeforeRender(renderer, scene, camera, proxy.geometry, proxy.material as THREE.Material, group);
  proxy.onAfterRender(renderer, scene, camera, proxy.geometry, proxy.material as THREE.Material, group);
  queries[0].available = true;
  queries[0].result = 0;
  renderSceneHook(renderer, scene, camera, null);

  assert.equal(proxy.visible, false, 'an occluded batch does not issue an unnecessary follow-up probe');
  assert.equal(batch.visible, true, 'the object remains eligible for shadow rendering');
  assert.equal(batch.castShadow, true);
  assert.equal(batch.count, 2, 'the batch retains its instances outside the main-camera draw callback');
  batch.onBeforeRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);
  assert.equal(batch.count, 0, 'the prior result suppresses instance submission for the active camera');
  assert.equal(visuals.stats().occlusion.suppressedInstances, 2);
  assert.equal(visuals.stats().occlusion.occludedResults, 1);
  batch.onAfterRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);
  assert.equal(batch.count, 2, 'the original count is restored for later passes');

  visuals.setOcclusionEnabled(false);
  renderSceneHook(renderer, scene, camera, null);
  assert.equal(proxy.visible, false);
  assert.equal(batch.renderOrder, 0, 'disabled culling restores the ordinary opaque draw order');
  assert.equal(visuals.stats().occlusion.enabled, false);
  batch.onBeforeRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);
  assert.equal(batch.count, 2, 'disabled culling does not suppress an occluded batch');
  visuals.setOcclusionEnabled(true);
  renderSceneHook(renderer, scene, camera, null);
  assert.equal(visuals.stats().occlusion.enabled, true);

  camera.position.x = 1;
  camera.updateMatrixWorld(true);
  renderSceneHook(renderer, scene, camera, null);
  assert.equal(proxy.visible, true, 'camera movement reveals and schedules a previously occluded batch');
  batch.onBeforeRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);
  assert.equal(batch.count, 2);
  batch.onAfterRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);

  const moved = {
    ...nodes[0],
    transform: { ...nodes[0].transform, position: [1, 0, -5] as [number, number, number] },
  };
  visuals.update(moved);
  visuals.flush();
  batch.onBeforeRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);
  assert.equal(batch.count, 2, 'batch-bound changes invalidate stale occlusion before drawing');
  batch.onAfterRender(renderer, scene, camera, batch.geometry, batch.material as THREE.Material, group);

  visuals.dispose();
  assert.equal(calls.deleted, 1);
  assert.equal(scene.children.length, 0);
});

test('SceneVisuals spends occlusion probes only on instance batches intersecting the camera frustum', () => {
  const { gl } = fakeGl();
  const asset = assetSchema.parse({
    id: 'frustum-rock',
    name: 'Frustum rock',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
  });
  const nodes = [
    nodeSchema.parse({
      id: 'offscreen',
      name: 'Offscreen rock',
      assetId: asset.id,
      transform: { position: [10000, 0, -5] },
    }),
    nodeSchema.parse({
      id: 'visible',
      name: 'Visible rock',
      assetId: asset.id,
      transform: { position: [0, 0, -5] },
    }),
  ];
  const renderer = {
    capabilities: { isWebGL2: true },
    domElement: new EventTarget() as HTMLCanvasElement,
    getContext: () => gl,
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600),
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const visuals = new SceneVisuals(scene, nodes, new Map([[asset.id, asset]]), renderer);
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 2000);
  camera.updateMatrixWorld(true);
  const renderSceneHook = scene.onBeforeRender as unknown as (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    target: THREE.WebGLRenderTarget | null,
  ) => void;

  renderSceneHook(renderer, scene, camera, null);

  const proxies = scene.children.filter(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && !(child instanceof THREE.InstancedMesh),
  );
  assert.equal(proxies.length, 2);
  const offscreenProxy = proxies.find((proxy) => proxy.matrix.elements[12] > 1000)!;
  const visibleProxy = proxies.find((proxy) => proxy.matrix.elements[12] < 1000)!;
  assert.equal(offscreenProxy.visible, false);
  assert.equal(visibleProxy.visible, true);
  assert.equal(visuals.stats().occlusion.scheduledQueries, 1);
  visuals.dispose();
});
