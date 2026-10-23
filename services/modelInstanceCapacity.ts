import { VoxelMaterial, type SimulationVoxel } from '../types';

export type MaterialVoxelCounts = Record<VoxelMaterial, number>;
export type MaterialInstanceCapacities = Record<VoxelMaterial, number>;

export function countVoxelsByMaterial(voxels: readonly Pick<SimulationVoxel, 'materialType'>[]) {
  const counts: MaterialVoxelCounts = {
    [VoxelMaterial.STANDARD]: 0,
    [VoxelMaterial.METALLIC]: 0,
    [VoxelMaterial.GLASS]: 0,
    [VoxelMaterial.EMISSIVE]: 0,
  };
  for (const voxel of voxels) counts[voxel.materialType ?? VoxelMaterial.STANDARD]++;
  return counts;
}

export function materialInstanceCapacities(counts: MaterialVoxelCounts): MaterialInstanceCapacities {
  return {
    [VoxelMaterial.STANDARD]: capacity(counts[VoxelMaterial.STANDARD]),
    [VoxelMaterial.METALLIC]: capacity(counts[VoxelMaterial.METALLIC]),
    [VoxelMaterial.GLASS]: capacity(counts[VoxelMaterial.GLASS]),
    [VoxelMaterial.EMISSIVE]: capacity(counts[VoxelMaterial.EMISSIVE]),
  };
}

function capacity(count: number) {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Voxel material counts must be nonnegative integers.');
  return Math.max(count + 1000, 5000);
}
