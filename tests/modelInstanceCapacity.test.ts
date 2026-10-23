import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countVoxelsByMaterial, materialInstanceCapacities } from '../services/modelInstanceCapacity';
import { VoxelMaterial } from '../types';

test('single-material models reserve capacity only for their populated batch', () => {
  const counts = {
    [VoxelMaterial.STANDARD]: 250_000,
    [VoxelMaterial.METALLIC]: 0,
    [VoxelMaterial.GLASS]: 0,
    [VoxelMaterial.EMISSIVE]: 0,
  };
  const capacities = materialInstanceCapacities(counts);

  assert.deepEqual(capacities, {
    [VoxelMaterial.STANDARD]: 251_000,
    [VoxelMaterial.METALLIC]: 5_000,
    [VoxelMaterial.GLASS]: 5_000,
    [VoxelMaterial.EMISSIVE]: 5_000,
  });
  const previousSlots = 4 * 251_000;
  const reservedSlots = Object.values(capacities).reduce((sum, capacity) => sum + capacity, 0);
  assert.equal(previousSlots, 1_004_000);
  assert.equal(reservedSlots, 266_000);
  assert.equal((previousSlots - reservedSlots) * 64, 47_232_000, 'Float32 matrix storage avoided in bytes.');
});

test('material counts include the standard fallback and reserve headroom per material', () => {
  const counts = countVoxelsByMaterial([
    { materialType: VoxelMaterial.STANDARD },
    { materialType: VoxelMaterial.METALLIC },
    { materialType: VoxelMaterial.EMISSIVE },
  ]);
  assert.deepEqual(counts, {
    [VoxelMaterial.STANDARD]: 1,
    [VoxelMaterial.METALLIC]: 1,
    [VoxelMaterial.GLASS]: 0,
    [VoxelMaterial.EMISSIVE]: 1,
  });
  assert.deepEqual(materialInstanceCapacities(counts), {
    [VoxelMaterial.STANDARD]: 5_000,
    [VoxelMaterial.METALLIC]: 5_000,
    [VoxelMaterial.GLASS]: 5_000,
    [VoxelMaterial.EMISSIVE]: 5_000,
  });
  assert.throws(
    () => materialInstanceCapacities({ ...counts, [VoxelMaterial.STANDARD]: -1 }),
    /nonnegative integers/,
  );
});
