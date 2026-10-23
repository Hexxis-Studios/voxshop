import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SceneVisuals } from '../runtime/SceneVisuals';
import { exportProject } from '../runtime/gameExport';
import { createModelDocument } from '../services/modelDocument';
import { applyProjectOperations, newProject, type ProjectDocument } from '../services/projectDocument';

const worldOperation = {
  type: 'world.create' as const,
  id: 'world',
  name: 'Scatter terrain',
  seed: 7,
  chunkSize: 16,
  voxelSize: 1,
  generator: {
    type: 'terrain' as const,
    version: 1 as const,
    origin: [-4, -4] as [number, number],
    size: [8, 8] as [number, number],
    minY: -2,
    maxY: 8,
    baseHeight: 3,
    amplitude: 0,
    palette: { surface: 0x55aa44, subsurface: 0x725439, deep: 0x686b70, materialType: 'STANDARD' as const },
  },
};

const prop = {
  type: 'asset.put' as const,
  asset: {
    id: 'oak',
    name: 'Oak',
    voxelSize: 0.5,
    pivot: [0, 0, 0] as [number, number, number],
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x4d8745 }]),
  },
};

function projectWithTerrain(): ProjectDocument {
  return applyProjectOperations(newProject('scatter-test', 'Scatter test'), [
    worldOperation,
    { type: 'scene.put', scene: { id: 'main', name: 'Main scene', worldId: 'world' } },
    prop,
  ]);
}

const scatter = {
  type: 'scene.scatter.create' as const,
  sceneId: 'main',
  id: 'scatter-1',
  assetId: 'oak',
  seed: 314,
  count: 40,
  bounds: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 },
  snapToTerrain: true,
  groundY: 0,
  scaleRange: [0.8, 1.2] as [number, number],
  randomYaw: true,
};

test('seeded scatter bakes editable nodes on the generated or sparsely edited terrain', () => {
  const base = projectWithTerrain();
  const first = applyProjectOperations(base, [scatter]);
  const second = applyProjectOperations(base, [scatter]);
  const nodes = first.scenes[0].nodes;

  assert.equal(nodes.length, scatter.count);
  assert.deepEqual(nodes, second.scenes[0].nodes);
  assert.equal(first.scenes[0].scatterGroups?.[0].id, scatter.id);
  assert.ok(nodes.every((node) => node.scatterGroupId === scatter.id && node.assetId === prop.asset.id));
  assert.ok(
    nodes.every(
      (node) => Math.abs(node.transform.position[1] - 0.25 * node.transform.scale[1] - 3.5) < 1e-10,
    ),
  );
  assert.ok(nodes.every((node) => node.transform.position[0] >= -3 && node.transform.position[0] <= 3));

  const edited = applyProjectOperations(
    applyProjectOperations(base, [
      { type: 'world.edit', worldId: 'world', edits: [{ x: 0, y: 3, z: 0, value: null }] },
    ]),
    [{ ...scatter, count: 1, bounds: { minX: -0.1, maxX: 0.1, minZ: -0.1, maxZ: 0.1 } }],
  );
  assert.equal(
    edited.scenes[0].nodes[0].transform.position[1] - 0.25 * edited.scenes[0].nodes[0].transform.scale[1],
    2.5,
  );
  assert.equal(first.revision, base.revision + 1);
});

test('flat-ground scatter anchors the model pivot and bottom face at the authored height', () => {
  const base = applyProjectOperations(newProject('flat-scatter', 'Flat scatter'), [prop]);
  const flat = applyProjectOperations(base, [
    {
      ...scatter,
      snapToTerrain: false,
      groundY: 5,
      count: 1,
      bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
      scaleRange: [1, 1],
      randomYaw: false,
    },
  ]);

  assert.equal(flat.scenes[0].nodes[0].transform.position[1] - 0.25, 5);
  assert.deepEqual(flat.scenes[0].nodes[0].transform.rotation, [0, 0, 0]);
});

test('scatter instances use the existing rigid opaque GPU batches', () => {
  const project = applyProjectOperations(projectWithTerrain(), [scatter]);
  const scene = new THREE.Scene();
  const visuals = new SceneVisuals(
    scene,
    project.scenes[0].nodes,
    new Map(project.assets.map((asset) => [asset.id, asset])),
  );
  const stats = visuals.stats();

  assert.equal(stats.instances, scatter.count);
  assert.equal(stats.sharedAssets, 1);
  assert.ok(stats.batches > 0 && stats.batches <= 4);
  assert.equal(stats.individualObjects, 0);
  assert.equal(stats.chunkedAssets, 0);
  visuals.dispose();
});

test('scatter source assets survive export and deleting a group removes generated descendants', () => {
  let project = applyProjectOperations(projectWithTerrain(), [scatter]);
  const generatedRoot = project.scenes[0].nodes[0];
  project = applyProjectOperations(project, [
    {
      type: 'node.put',
      sceneId: 'main',
      node: {
        id: 'scatter-child',
        name: 'Attached detail',
        assetId: null,
        parentId: generatedRoot.id,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        enabled: true,
        components: [],
        attachments: [],
      },
    },
  ]);

  const exported = exportProject(project, 'main');
  assert.equal(
    exported.assets.some((asset) => asset.id === 'oak'),
    true,
  );
  assert.equal(exported.scenes[0].scatterGroups?.length, 1);
  const cleaned = applyProjectOperations(project, [
    { type: 'scene.scatter.delete', sceneId: 'main', id: scatter.id },
  ]);
  assert.equal(cleaned.scenes[0].scatterGroups?.length, 0);
  assert.equal(cleaned.scenes[0].nodes.length, 0);
});

test('scatter transactions reject invalid bounds, glass assets, duplicates and node-limit overflow', () => {
  const base = projectWithTerrain();
  assert.throws(
    () => applyProjectOperations(base, [{ ...scatter, bounds: { minX: -5, maxX: 1, minZ: -1, maxZ: 1 } }]),
    /inside the selected world/,
  );
  assert.throws(
    () => applyProjectOperations(base, [{ ...scatter, bounds: { minX: 1, maxX: 1, minZ: 0, maxZ: 1 } }]),
    /maxX/,
  );
  assert.throws(
    () => applyProjectOperations(applyProjectOperations(base, [scatter]), [scatter]),
    /already exists/,
  );
  const glass = applyProjectOperations(base, [
    {
      type: 'asset.put',
      asset: {
        ...prop.asset,
        id: 'glass',
        name: 'Glass',
        model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff, materialType: 'GLASS' }]),
      },
    },
  ]);
  assert.throws(() => applyProjectOperations(glass, [{ ...scatter, assetId: 'glass' }]), /static opaque/);

  const fullScene = applyProjectOperations(base, [
    {
      type: 'scene.put',
      scene: {
        ...base.scenes[0],
        nodes: Array.from({ length: 4999 }, (_, index) => ({
          id: `existing-${index}`,
          name: 'Existing',
          assetId: null,
          parentId: null,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          enabled: true,
          components: [],
          attachments: [],
        })),
      },
    },
  ]);
  assert.throws(() => applyProjectOperations(fullScene, [scatter]), /5,000-node scene limit/);
});
