import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CUSTOM_RECIPE } from '../components/AssetGenerator';
import { generateRecipe } from '../services/recipeGenerator';

test('custom asset starter recipe generates an editable box', () => {
  assert.equal(generateRecipe(JSON.parse(DEFAULT_CUSTOM_RECIPE)).length, 1000);
});

test('ramp recipes generate deterministic slopes and rotate with the other primitives', () => {
  const shape = { kind: 'ramp', center: [0, 2, 0], size: [5, 5, 1], color: 0x123456 } as const;
  const voxels = generateRecipe({ version: 1, shapes: [shape] });
  assert.equal(voxels.length, 15);
  assert.deepEqual(
    [-2, -1, 0, 1, 2].map((x) => voxels.filter((voxel) => voxel.x === x).length),
    [1, 2, 3, 4, 5],
  );

  const rotated = generateRecipe({ version: 1, shapes: [{ ...shape, rotation: [0, Math.PI / 2, 0] }] });
  assert.equal(rotated.length, voxels.length);
  assert.deepEqual(
    [-2, -1, 0, 1, 2].map((z) => rotated.filter((voxel) => voxel.z === z).length),
    [5, 4, 3, 2, 1],
  );
  assert.deepEqual(
    rotated,
    generateRecipe({ version: 1, shapes: [{ ...shape, rotation: [0, Math.PI / 2, 0] }] }),
  );
});
