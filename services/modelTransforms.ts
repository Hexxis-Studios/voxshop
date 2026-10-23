import type { VoxelData } from '../types';

export function flipVoxels(data: VoxelData[], axis: 'x' | 'y' | 'z'): VoxelData[] {
  return data.map((voxel) => ({
    ...voxel,
    x: axis === 'x' ? -Math.round(voxel.x) : Math.round(voxel.x),
    y: axis === 'y' ? -Math.round(voxel.y) : Math.round(voxel.y),
    z: axis === 'z' ? -Math.round(voxel.z) : Math.round(voxel.z),
  }));
}

export function rotateVoxels90(data: VoxelData[], direction: 'cw' | 'ccw'): VoxelData[] {
  return data.map((voxel) => {
    const x = Math.round(voxel.x),
      z = Math.round(voxel.z);
    return {
      ...voxel,
      x: direction === 'cw' ? z : -z,
      y: Math.round(voxel.y),
      z: direction === 'cw' ? -x : x,
    };
  });
}
