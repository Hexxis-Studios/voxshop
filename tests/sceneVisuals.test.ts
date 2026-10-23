import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneVisuals } from '../runtime/SceneVisuals';
import { createModelDocument } from '../services/modelDocument';
import { createExample } from '../services/examples';
import { assetSchema, nodeSchema, validateProject } from '../services/projectDocument';
import { generateRecipe } from '../services/recipeGenerator';

const noOcclusion = {
  available: false,
  registeredBatches: 0,
  pendingQueries: 0,
  scheduledQueries: 0,
  occludedBatches: 0,
  visibleResults: 0,
  occludedResults: 0,
  discardedResults: 0,
  enabled: true,
  suppressedInstances: 0,
  suppressedBatchFrames: 0,
};

test('repeated props share one geometry and GPU batch per spatial cell, preserving pick IDs, bounds and visibility', () => {
  const asset = assetSchema.parse({
    id: 'rock',
    name: 'Rock',
    voxelSize: 0.5,
    pivot: [1, 0, 0],
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
  });
  const nodes = Array.from({ length: 1000 }, (_, i) =>
    nodeSchema.parse({
      id: `rock-${i}`,
      name: `Rock ${i}`,
      assetId: asset.id,
      transform: { position: [i % 10, 0, Math.floor(i / 10) % 10] },
    }),
  );
  const scene = new THREE.Scene(),
    visuals = new SceneVisuals(scene, nodes, new Map([[asset.id, asset]]));
  assert.deepEqual(visuals.stats(), {
    objects: 1000,
    instances: 1000,
    batches: 1,
    sharedAssets: 1,
    individualObjects: 0,
    chunkedAssets: 0,
    chunkMeshes: 0,
    terrainLodMeshes: 0,
    terrainLods: 0,
    terrainLodTiers: { fine: 0, medium: 0, far: 0 },
    occlusion: noOcclusion,
  });
  const mesh = visuals.pickables[0] as THREE.InstancedMesh;
  assert.equal(mesh.count, 1000);
  assert.equal(mesh.geometry.getAttribute('position').count, 24);
  assert.equal(
    visuals.nodeAt({ object: mesh, instanceId: 783, distance: 0, point: new THREE.Vector3() }),
    'rock-783',
  );
  assert.equal(visuals.bounds('rock-0').min.x, -0.75);
  const changed = {
    ...nodes[0],
    transform: { ...nodes[0].transform, position: [64, 0, 0] as [number, number, number] },
  };
  visuals.update(changed);
  visuals.flush();
  assert.equal(visuals.bounds('rock-0').max.x, 63.75);
  const moved = visuals.pickables.find(
    (object): object is THREE.InstancedMesh =>
      object instanceof THREE.InstancedMesh && (object.userData.nodeIds as string[]).includes('rock-0'),
  )!;
  assert.equal(mesh.count, 999);
  assert.equal(moved.count, 1);
  assert.ok(moved.boundingSphere!.containsPoint(new THREE.Vector3(63.5, 0, 0)));
  visuals.update(changed, false);
  visuals.flush();
  const matrix = new THREE.Matrix4();
  moved.getMatrixAt(0, matrix);
  assert.equal(new THREE.Vector3().setFromMatrixScale(matrix).length(), 0);
  let released = 0;
  mesh.geometry.addEventListener('dispose', () => released++);
  visuals.dispose();
  assert.equal(released, 1);
  assert.equal(scene.children.length, 0);
});

test('cloned nodes with unchanged attachments keep their shared instance batch', () => {
  const asset = assetSchema.parse({
      id: 'rock',
      name: 'Rock',
      model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
    }),
    node = nodeSchema.parse({ id: 'rock-1', name: 'Rock', assetId: asset.id, transform: {} }),
    scene = new THREE.Scene(),
    visuals = new SceneVisuals(scene, [node], new Map([[asset.id, asset]])),
    original = visuals.nodes.get(node.id)!.group;

  visuals.update(structuredClone(node));

  assert.equal(visuals.nodes.get(node.id)!.group, original);
  assert.equal(visuals.stats().instances, 1);
  assert.equal(visuals.stats().individualObjects, 0);
  visuals.dispose();
});

test('rigged focus bounds apply voxel spacing once and honor the scene transform', () => {
  const asset = assetSchema.parse({
    id: 'rigged-focus',
    name: 'Rigged focus',
    voxelSize: 0.5,
    pivot: [2, 0, 0],
    model: createModelDocument([
      { x: 2, y: 4, z: -3, color: 0xffffff, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
    ]),
    rig: {
      profile: 'focus-test',
      version: 1,
      joints: [{ name: 'root', parent: null, position: [2, 4, -3] }],
    },
  });
  const node = nodeSchema.parse({
    id: 'rigged-focus-node',
    name: 'Rigged focus node',
    assetId: asset.id,
    transform: { position: [3, 2, 1], scale: [2, 1, 1] },
  });
  const visuals = new SceneVisuals(new THREE.Scene(), [node], new Map([[asset.id, asset]]));
  const bounds = visuals.bounds(node.id);

  assert.deepEqual(bounds.getSize(new THREE.Vector3()).toArray(), [1, 0.5, 0.5]);
  assert.deepEqual(bounds.min.toArray(), [2.5, 3.75, -0.75]);
  assert.deepEqual(bounds.max.toArray(), [3.5, 4.25, -0.25]);
  visuals.dispose();
});

test('runtime-added prefabs become visible, preserve hierarchy and join spatial instance batches', () => {
  const asset = assetSchema.parse({
    id: 'runtime-rock',
    name: 'Runtime rock',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
  });
  const initial = nodeSchema.parse({
    id: 'initial-rock',
    name: 'Initial rock',
    assetId: asset.id,
    transform: { position: [0, 0, 0] },
  });
  const scene = new THREE.Scene();
  const visuals = new SceneVisuals(scene, [initial], new Map([[asset.id, asset]]));
  const spawnedRoot = nodeSchema.parse({
    id: 'spawned-root',
    name: 'Spawned root',
    transform: { position: [3, 0, 0] },
  });
  const spawnedChild = nodeSchema.parse({
    id: 'spawned-child',
    name: 'Spawned child',
    parentId: spawnedRoot.id,
    assetId: asset.id,
    transform: { position: [0, 1, 0] },
  });
  const spawnedRock = nodeSchema.parse({
    id: 'spawned-rock',
    name: 'Spawned rock',
    assetId: asset.id,
    transform: { position: [5, 0, 0] },
  });

  visuals.addNodes([initial, spawnedRoot, spawnedChild, spawnedRock]);
  visuals.flush();
  assert.equal(visuals.nodes.get(spawnedChild.id)?.group.parent, visuals.nodes.get(spawnedRoot.id)?.group);
  assert.equal(visuals.stats().instances, 2);
  const spawnedBatch = visuals.pickables.find(
    (entry) =>
      entry instanceof THREE.InstancedMesh && (entry.userData.nodeIds as string[]).includes(spawnedRock.id),
  ) as THREE.InstancedMesh;
  assert.equal(
    visuals.nodeAt({
      object: spawnedBatch,
      instanceId: (spawnedBatch.userData.nodeIds as string[]).indexOf(spawnedRock.id),
      distance: 0,
      point: new THREE.Vector3(),
    }),
    spawnedRock.id,
  );
  visuals.dispose();
});

test('moving props rebucket across spatial cells and preserve compacted pick IDs', () => {
  const asset = assetSchema.parse({
    id: 'rock',
    name: 'Rock',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
  });
  const nodes = ['a', 'b', 'c'].map((id, index) =>
      nodeSchema.parse({
        id,
        name: id,
        assetId: asset.id,
        transform: { position: [index, 0, 0] },
      }),
    ),
    scene = new THREE.Scene(),
    visuals = new SceneVisuals(scene, nodes, new Map([[asset.id, asset]]));
  const meshFor = (id: string) =>
    visuals.pickables.find(
      (object): object is THREE.InstancedMesh =>
        object instanceof THREE.InstancedMesh && (object.userData.nodeIds as string[]).includes(id),
    );
  const move = (id: string, x: number) => {
    const original = nodes.find((node) => node.id === id)!;
    visuals.update({ ...original, transform: { ...original.transform, position: [x, 0, 0] } });
    visuals.flush();
  };

  move('a', 64);
  assert.equal(meshFor('a')!.count, 1);
  assert.equal(meshFor('b')!.count, 2);
  assert.equal(
    visuals.nodeAt({ object: meshFor('c')!, instanceId: 0, distance: 0, point: new THREE.Vector3() }),
    'c',
  );

  move('b', 65);
  assert.equal(meshFor('a')!.count, 2, 'Adding an instance grows a full destination batch.');
  assert.equal(meshFor('c')!.count, 1);
  move('c', -64);
  assert.equal(meshFor('c')!.count, 1, 'Negative world coordinates use their own spatial cell.');
  assert.equal(visuals.stats().batches, 2);

  move('a', 0);
  assert.equal(visuals.stats().batches, 3, 'The emptied positive cell batch is released.');
  assert.equal(meshFor('a')!.count, 1);
  move('b', 0);
  assert.equal(meshFor('a')!.count, 2, 'A later move grows a recreated cell batch.');
  assert.equal(visuals.stats().batches, 2);
  assert.equal(
    visuals.nodeAt({ object: meshFor('b')!, instanceId: 1, distance: 0, point: new THREE.Vector3() }),
    'b',
  );
  assert.ok(visuals.bounds('a').max.x < 1);

  visuals.dispose();
  assert.equal(scene.children.length, 0);
});

test('runtime attachment changes rebuild the node visual while preserving the scene entry', () => {
  const project = validateProject(createExample('arena', 'visual-equipment')),
    player = project.scenes[0].nodes.find((node) => node.id === 'player')!,
    attachments = structuredClone(player.attachments),
    scene = new THREE.Scene();
  player.attachments = [];
  const visuals = new SceneVisuals(
      scene,
      [player],
      new Map(project.assets.map((asset) => [asset.id, asset])),
    ),
    initial = visuals.nodes.get(player.id)!.group;
  assert.equal(initial.parent, scene);
  player.attachments = attachments;
  visuals.update(player);
  const equipped = visuals.nodes.get(player.id)!.group;
  assert.notEqual(equipped, initial);
  assert.equal(equipped.parent, scene);
  assert.ok(visuals.pickables.includes(equipped));
  assert.ok(visuals.bounds(player.id).isEmpty() === false);

  visuals.update(structuredClone(player));
  assert.equal(visuals.nodes.get(player.id)!.group, equipped);

  player.attachments = [];
  visuals.update(player);
  assert.notEqual(visuals.nodes.get(player.id)!.group, equipped);
  visuals.dispose();
  assert.equal(scene.children.length, 0);
});

test('hierarchy and transparent objects retain individual visuals; separate cells share geometry and release it once', () => {
  const asset = assetSchema.parse({
    id: 'a',
    name: 'A',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff }]),
  });
  const glass = assetSchema.parse({
    ...asset,
    id: 'glass',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff, materialType: 'GLASS' }]),
  });
  const nodes = [
    nodeSchema.parse({ id: 'parent', name: 'Parent', assetId: 'a', transform: { position: [5, 0, 0] } }),
    nodeSchema.parse({
      id: 'child',
      name: 'Child',
      parentId: 'parent',
      assetId: 'a',
      transform: { position: [1, 0, 0] },
    }),
    nodeSchema.parse({ id: 'glass', name: 'Glass', assetId: 'glass', transform: {} }),
    nodeSchema.parse({ id: 'near', name: 'Near', assetId: 'a', transform: {} }),
    nodeSchema.parse({ id: 'far', name: 'Far', assetId: 'a', transform: { position: [100, 0, 0] } }),
  ];
  const scene = new THREE.Scene(),
    visuals = new SceneVisuals(
      scene,
      nodes,
      new Map([
        ['a', asset],
        ['glass', glass],
      ]),
    );
  assert.equal(visuals.stats().batches, 2);
  assert.equal(visuals.stats().sharedAssets, 1);
  assert.equal(visuals.stats().individualObjects, 3);
  assert.equal(visuals.bounds('child').getCenter(new THREE.Vector3()).x, 6);
  const a = visuals.pickables.filter((o) => o instanceof THREE.InstancedMesh) as THREE.InstancedMesh[];
  assert.equal(a[0].geometry, a[1].geometry);
  let releases = 0;
  visuals.nodes.get('child')!.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.addEventListener('dispose', () => releases++);
  });
  visuals.dispose();
  assert.equal(releases, 1);
  assert.equal(scene.children.length, 0);
});

test('large rigid voxel terrain renders as spatially culled chunks instead of a whole-model mesh', () => {
  const asset = assetSchema.parse({
    id: 'land',
    name: 'Land',
    voxelSize: 0.5,
    pivot: [16, 8, 8],
    model: createModelDocument(
      Array.from({ length: 32 * 16 * 16 }, (_, i) => ({
        x: i % 32,
        y: Math.floor(i / 32) % 16,
        z: Math.floor(i / 512),
        color: 0x789b55,
      })),
    ),
  });
  const node = nodeSchema.parse({
      id: 'land-node',
      name: 'Land',
      assetId: 'land',
      transform: {},
    }),
    scene = new THREE.Scene(),
    visuals = new SceneVisuals(scene, [node], new Map([[asset.id, asset]])),
    visual = visuals.nodes.get(node.id)!;
  assert.deepEqual(visuals.stats(), {
    objects: 1,
    instances: 0,
    batches: 0,
    sharedAssets: 0,
    individualObjects: 1,
    chunkedAssets: 1,
    chunkMeshes: 2,
    terrainLodMeshes: 0,
    terrainLods: 0,
    terrainLodTiers: { fine: 0, medium: 0, far: 0 },
    occlusion: noOcclusion,
  });
  const meshes: THREE.Mesh[] = [];
  visual.group.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  assert.equal(meshes.length, 2);
  assert.ok(meshes.every((mesh) => mesh.frustumCulled));
  assert.ok(meshes.every((mesh) => mesh.material === meshes[0].material));
  assert.equal(visuals.nodeAt({ object: meshes[0], distance: 0, point: new THREE.Vector3() }), node.id);
  assert.equal(visuals.bounds(node.id).getSize(new THREE.Vector3()).x, 16);
  const material = meshes[0].material as THREE.Material[];
  let materialDisposals = 0;
  material.forEach((m) => m.addEventListener('dispose', () => materialDisposals++));
  visuals.dispose();
  assert.equal(materialDisposals, material.length);
  assert.equal(scene.children.length, 0);
});

test('repeated oversized props keep shared instancing rather than creating a chunk tree per copy', () => {
  const asset = assetSchema.parse({
    id: 'building',
    name: 'Building',
    model: createModelDocument(
      Array.from({ length: 32 * 16 * 16 }, (_, i) => ({
        x: i % 32,
        y: Math.floor(i / 32) % 16,
        z: Math.floor(i / 512),
        color: 0x82715e,
      })),
    ),
  });
  const nodes = [
    nodeSchema.parse({
      id: 'building-a',
      name: 'Building A',
      assetId: asset.id,
      transform: {},
    }),
    nodeSchema.parse({
      id: 'building-b',
      name: 'Building B',
      assetId: asset.id,
      transform: { position: [64, 0, 0] },
    }),
  ];
  const scene = new THREE.Scene(),
    visuals = new SceneVisuals(scene, nodes, new Map([[asset.id, asset]]));
  assert.deepEqual(visuals.stats(), {
    objects: 2,
    instances: 2,
    batches: 2,
    sharedAssets: 1,
    individualObjects: 0,
    chunkedAssets: 0,
    chunkMeshes: 0,
    terrainLodMeshes: 0,
    terrainLods: 0,
    terrainLodTiers: { fine: 0, medium: 0, far: 0 },
    occlusion: noOcclusion,
  });
  visuals.dispose();
  assert.equal(scene.children.length, 0);
});

test('seeded static terrain selects projected detail by resolution while retaining exact bounds and hysteresis', () => {
  const recipe = {
    version: 1 as const,
    seed: 27,
    shapes: [
      {
        kind: 'terrain' as const,
        operation: 'add' as const,
        center: [2, 4, -2] as [number, number, number],
        size: [25, 14, 23] as [number, number, number],
        color: 0x789b55,
        noise: 0.45,
      },
    ],
  };
  const asset = assetSchema.parse({
      id: 'seeded-land',
      name: 'Seeded Land',
      voxelSize: 0.5,
      pivot: [4, 1, -3],
      recipe,
      source: { kind: 'generated', seed: recipe.seed, description: 'test' },
      model: createModelDocument(generateRecipe(recipe)),
    }),
    node = nodeSchema.parse({ id: 'land', name: 'Land', assetId: asset.id, transform: {} }),
    scene = new THREE.Scene();
  let originalHookCalls = 0;
  const originalHook: THREE.Scene['onBeforeRender'] = () => originalHookCalls++;
  scene.onBeforeRender = originalHook;
  const visuals = new SceneVisuals(scene, [node], new Map([[asset.id, asset]])),
    visual = visuals.nodes.get(node.id)!,
    [fine, medium, far] = visual.group.children as THREE.Group[],
    fineBounds = visuals.bounds(node.id),
    mediumBounds = new THREE.Box3().setFromObject(medium),
    farBounds = new THREE.Box3().setFromObject(far);
  assert.equal(visuals.stats().terrainLods, 1);
  assert.deepEqual(visuals.stats().terrainLodTiers, { fine: 1, medium: 0, far: 0 });
  assert.equal(visuals.stats().chunkedAssets, 1);
  assert.equal(visuals.stats().chunkMeshes, countMeshes(fine));
  assert.equal(visuals.stats().terrainLodMeshes, countMeshes(medium) + countMeshes(far));
  assert.equal(fine.visible, true);
  assert.equal(medium.visible, false);
  assert.equal(far.visible, false);
  for (const lodBounds of [mediumBounds, farBounds]) {
    assert.ok(fineBounds.min.distanceTo(lodBounds.min) < 1e-6);
    assert.ok(fineBounds.max.distanceTo(lodBounds.max) < 1e-6);
  }
  const fineTriangles = countTriangles(fine),
    mediumTriangles = countTriangles(medium),
    farTriangles = countTriangles(far),
    sphere = fineBounds.getBoundingSphere(new THREE.Sphere()),
    camera = new THREE.PerspectiveCamera(50, 720 / 568, 0.1, 10000);
  const moveCamera = (distance: number, viewportHeight = 900) => {
    camera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, distance));
    camera.lookAt(sphere.center);
    camera.updateMatrixWorld(true);
    visuals.updateLod(camera, viewportHeight);
  };
  assert.ok(
    mediumTriangles < fineTriangles,
    'Medium terrain should submit fewer triangles than full detail.',
  );
  assert.ok(farTriangles < mediumTriangles, 'Far terrain should submit fewer triangles than medium detail.');
  moveCamera(1);
  assert.equal(fine.visible, true);
  assert.equal(medium.visible, false);
  assert.equal(far.visible, false);
  moveCamera(1000);
  const sceneHook = scene.onBeforeRender as unknown as (...args: unknown[]) => void;
  sceneHook.call(
    scene,
    { getDrawingBufferSize: (size: THREE.Vector2) => size.set(720, 900) },
    scene,
    camera,
    null,
    null,
    null,
  );
  assert.equal(originalHookCalls, 1, 'The existing scene render callback should remain chained.');
  assert.equal(fine.visible, false);
  assert.equal(medium.visible, true);
  assert.equal(far.visible, false);
  assert.deepEqual(visuals.stats().terrainLodTiers, { fine: 0, medium: 1, far: 0 });
  moveCamera(900);
  assert.equal(
    medium.visible,
    true,
    'Existing hysteresis should hold medium LOD inside the transition band.',
  );
  moveCamera(600);
  assert.equal(fine.visible, true);
  assert.equal(medium.visible, false);

  moveCamera(2000);
  assert.equal(fine.visible, false);
  assert.equal(medium.visible, false);
  assert.equal(far.visible, true);
  assert.deepEqual(visuals.stats().terrainLodTiers, { fine: 0, medium: 0, far: 1 });
  moveCamera(1800);
  assert.equal(far.visible, true, 'Far hysteresis should hold the far tier inside its transition band.');
  moveCamera(1000);
  assert.equal(medium.visible, true);
  assert.equal(far.visible, false);
  moveCamera(1000, 360);
  assert.equal(far.visible, true, 'A shorter render height permits coarser terrain at the same distance.');
  moveCamera(1000, 1440);
  assert.equal(fine.visible, true, 'A taller render height retains fine detail at the same distance.');
  const orthoCamera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 10000);
  const moveOrthoCamera = (distance: number) => {
    orthoCamera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, distance));
    orthoCamera.lookAt(sphere.center);
    orthoCamera.updateMatrixWorld(true);
    visuals.updateLod(orthoCamera, 32);
  };
  moveOrthoCamera(10);
  assert.equal(medium.visible, true, 'Orthographic detail follows camera scale, not distance.');
  moveOrthoCamera(5000);
  assert.equal(medium.visible, true, 'Orthographic projection keeps the same tier as the camera moves.');
  visuals.dispose();
  assert.equal(scene.onBeforeRender, originalHook);
  assert.equal(scene.children.length, 0);
});

function countTriangles(group: THREE.Group) {
  let triangles = 0;
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? 0) / 3;
  });
  return triangles;
}

function countMeshes(group: THREE.Group) {
  let meshes = 0;
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes++;
  });
  return meshes;
}
