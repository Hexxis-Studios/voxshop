import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { GameSimulation } from '../runtime/GameSimulation';
import { createExample } from '../services/examples';
import type { Asset, Transform } from '../services/projectDocument';

function authoredAssetBounds(asset: Asset) {
  const bounds = new Box3();
  for (const voxel of asset.model.voxels)
    bounds
      .expandByPoint(
        new Vector3(
          voxel.x - 0.5 - asset.pivot[0],
          voxel.y - 0.5 - asset.pivot[1],
          voxel.z - 0.5 - asset.pivot[2],
        ).multiplyScalar(asset.voxelSize),
      )
      .expandByPoint(
        new Vector3(
          voxel.x + 0.5 - asset.pivot[0],
          voxel.y + 0.5 - asset.pivot[1],
          voxel.z + 0.5 - asset.pivot[2],
        ).multiplyScalar(asset.voxelSize),
      );
  return bounds;
}

function worldBounds(bounds: Box3, transform: Transform) {
  const matrix = new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation)),
    new Vector3(...transform.scale),
  );
  return bounds.clone().applyMatrix4(matrix);
}

function colliderBounds(size: number[], offset: number[]) {
  const half = new Vector3(...size).multiplyScalar(0.5),
    center = new Vector3(...offset);
  return new Box3(center.clone().sub(half), center.add(half));
}

test('Survival workbench is beside the pickup path and remains reachable for crafting', () => {
  const project = createExample('survival', 'survival-layout'),
    scene = project.scenes[0],
    player = scene.nodes.find((node) => node.id === 'player')!,
    workbench = scene.nodes.find((node) => node.id === 'workbench')!,
    assets = new Map(project.assets.map((asset) => [asset.id, asset])),
    playerCollider = player.components.find((component) => component.type === 'collider')!,
    playerPathBounds = worldBounds(
      colliderBounds(playerCollider.size, playerCollider.offset),
      player.transform,
    ),
    benchAsset = assets.get(workbench.assetId!)!,
    benchBounds = worldBounds(authoredAssetBounds(benchAsset), workbench.transform),
    pathRightEdge = playerPathBounds.max.x,
    pathLeftEdge = playerPathBounds.min.x,
    visualSideGap = Math.max(benchBounds.min.x - pathRightEdge, pathLeftEdge - benchBounds.max.x);

  assert.ok(benchAsset.model.voxels.length > 0, 'The workbench needs authored geometry for a layout check.');
  assert.ok(
    visualSideGap >= 0.25,
    `The authored workbench mesh should stay at least 0.25m outside the player's walk lane; got ${visualSideGap.toFixed(2)}m.`,
  );

  const simulation = new GameSimulation(project);
  for (let frame = 0; frame < 240; frame++) simulation.step({ moveZ: -1 });
  const supplies = simulation.inspect();
  assert.equal(supplies.interactionTarget?.nodeId, 'workbench');
  assert.deepEqual(
    supplies.inventory.map(({ itemId, quantity }) => [itemId, quantity]),
    [
      ['wood', 2],
      ['stone', 1],
    ],
  );

  simulation.step({ interact: true });
  const crafted = simulation.inspect();
  assert.ok(crafted.events.some((event) => event.type === 'crafted' && event.nodeId === 'workbench'));
  assert.deepEqual(
    crafted.inventory.map(({ itemId, quantity }) => [itemId, quantity]),
    [['campfire-kit', 1]],
  );
});
