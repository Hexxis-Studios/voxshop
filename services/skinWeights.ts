import type { VoxelData } from '../types';

/** Resolve a voxel's bounded influences into the four GPU skinning slots. */
export function resolveSkinWeights(
  voxel: Pick<VoxelData, 'bone' | 'weights'>,
  jointNames: string[],
): { indices: [number, number, number, number]; weights: [number, number, number, number] } {
  const influences = voxel.weights?.length
    ? voxel.weights
    : voxel.bone
      ? [{ bone: voxel.bone, weight: 1 }]
      : jointNames[0]
        ? [{ bone: jointNames[0], weight: 1 }]
        : [];
  const entries = influences
    .slice()
    .sort((a, b) => b.weight - a.weight || a.bone.localeCompare(b.bone))
    .slice(0, 4);
  const total = entries.reduce((sum, influence) => sum + influence.weight, 0) || 1;
  const indices = [0, 1, 2, 3].map((slot) => {
    const index = jointNames.indexOf(entries[slot]?.bone ?? '');
    return index < 0 ? 0 : index;
  }) as [number, number, number, number];
  const weights = [0, 1, 2, 3].map((slot) => (entries[slot]?.weight ?? 0) / total) as [
    number,
    number,
    number,
    number,
  ];
  return { indices, weights };
}
