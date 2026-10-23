import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flipVoxels, rotateVoxels90 } from '../services/modelTransforms';
import { VoxelMaterial, type VoxelData } from '../types';

test('model flips and quarter turns round coordinates while preserving voxel data', () => {
  const voxel: VoxelData = {
    x: 1.6,
    y: 2.2,
    z: -3.7,
    color: 0,
    materialType: VoxelMaterial.GLASS,
    isLocked: true,
    bone: 'Root',
    weights: [{ bone: 'Root', weight: 1 }],
  };

  assert.deepEqual(flipVoxels([voxel], 'x'), [{ ...voxel, x: -2, y: 2, z: -4 }]);
  assert.deepEqual(flipVoxels([voxel], 'y'), [{ ...voxel, x: 2, y: -2, z: -4 }]);
  assert.deepEqual(flipVoxels([voxel], 'z'), [{ ...voxel, x: 2, y: 2, z: 4 }]);
  assert.deepEqual(rotateVoxels90([voxel], 'cw'), [{ ...voxel, x: -4, y: 2, z: -2 }]);
  assert.deepEqual(rotateVoxels90([voxel], 'ccw'), [{ ...voxel, x: 4, y: 2, z: 2 }]);
  assert.deepEqual(voxel, {
    x: 1.6,
    y: 2.2,
    z: -3.7,
    color: 0,
    materialType: VoxelMaterial.GLASS,
    isLocked: true,
    bone: 'Root',
    weights: [{ bone: 'Root', weight: 1 }],
  });
});
