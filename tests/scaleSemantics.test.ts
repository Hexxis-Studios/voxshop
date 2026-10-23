import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneVisuals } from '../runtime/SceneVisuals';
import { WorldVoxelRenderer } from '../runtime/WorldVoxelRenderer';
import { createModelDocument } from '../services/modelDocument';
import { assetSchema, nodeSchema } from '../services/projectDocument';
import { worldDocumentSchema } from '../services/worldDocument';

test('world cell spacing and asset voxel spacing remain independent in either size order', () => {
  for (const [worldSize, assetSize] of [
    [0.5, 0.04],
    [0.04, 0.5],
  ]) {
    const world = worldDocumentSchema.parse({
      id: 'scale-world',
      name: 'Scale world',
      seed: 1,
      chunkSize: 16,
      voxelSize: worldSize,
      generator: {
        type: 'terrain',
        version: 1,
        mode: 'heightfield',
        origin: [0, 0],
        size: [1, 1],
        minY: 0,
        maxY: 0,
        baseHeight: 0,
        amplitude: 0,
        noise: 0,
        palette: { surface: 0x777777, subsurface: 0x666666, deep: 0x555555, materialType: 'STANDARD' },
      },
    });
    const asset = assetSchema.parse({
      id: 'scale-prop',
      name: 'Scale prop',
      voxelSize: assetSize,
      model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff }]),
    });
    const node = nodeSchema.parse({
      id: 'scale-prop-node',
      name: asset.name,
      assetId: asset.id,
      transform: {},
    });
    const scene = new THREE.Scene();
    const worldRenderer = new WorldVoxelRenderer(scene, world);
    const assetVisuals = new SceneVisuals(scene, [node], new Map([[asset.id, asset]]));

    worldRenderer.update(new THREE.Vector3(worldSize / 2, worldSize / 2, worldSize / 2));
    const worldCell = worldRenderer.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.userData.voxelCellCount === 1,
    );
    assert.ok(worldCell, 'The single logical world cell is rendered.');
    worldCell!.updateMatrixWorld(true);
    const worldCellMeters = new THREE.Box3().setFromObject(worldCell!).getSize(new THREE.Vector3());
    const assetMeters = assetVisuals.bounds(node.id).getSize(new THREE.Vector3());

    assert.equal(worldRenderer.stats().logicalCellSizeMeters, worldSize);
    assert.ok(Math.abs(worldCellMeters.x - worldSize) < 1e-9);
    assert.ok(Math.abs(worldCellMeters.y - worldSize) < 1e-9);
    assert.ok(Math.abs(worldCellMeters.z - worldSize) < 1e-9);
    assert.ok(Math.abs(assetMeters.x - assetSize) < 1e-9);
    assert.ok(Math.abs(assetMeters.y - assetSize) < 1e-9);
    assert.ok(Math.abs(assetMeters.z - assetSize) < 1e-9);

    assetVisuals.dispose();
    worldRenderer.dispose();
  }
});
