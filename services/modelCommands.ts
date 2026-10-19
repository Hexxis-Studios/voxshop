import { VoxelMaterial, type VoxelData, type VoxelDelta } from '../types';
import { cloneVoxel, normalizeVoxels, voxelKey } from './modelDocument';

type Position = Pick<VoxelData, 'x' | 'y' | 'z'>;
export interface VoxelEdit {
  mode: 'add' | 'delete' | 'paint' | 'lock' | 'fill';
  targets: Position[];
  color?: number;
  materialType?: VoxelMaterial;
}

/** Commands contain complete records, independent of selection, brush settings, or WebGL. */
export function createVoxelEdit(data: VoxelData[], edit: VoxelEdit): VoxelDelta {
  const grid = new Map(data.map((v) => [voxelKey(v), v]));
  const targets = new Map(edit.targets.map((v) => [voxelKey(v), v]));
  const delta: VoxelDelta = { action: edit.mode, voxels: [] };
  const visited = new Set<string>();
  const paint = (v: VoxelData) => {
    if (v.isLocked || edit.color === undefined) return;
    const after = {
      ...cloneVoxel(v),
      color: edit.color,
      materialType: edit.materialType ?? VoxelMaterial.STANDARD,
    };
    if (v.color !== after.color || (v.materialType ?? VoxelMaterial.STANDARD) !== after.materialType) {
      delta.voxels.push({ before: cloneVoxel(v), after });
    }
  };
  for (const position of targets.values()) {
    const before = grid.get(voxelKey(position));
    if (edit.mode === 'fill') {
      if (!before || before.isLocked || edit.color === undefined) continue;
      const queue = [position];
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i],
          key = voxelKey(p);
        if (visited.has(key)) continue;
        const voxel = grid.get(key);
        if (!voxel || voxel.isLocked || voxel.color !== before.color) continue;
        visited.add(key);
        paint(voxel);
        for (const [x, y, z] of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          queue.push({ x: p.x + x, y: p.y + y, z: p.z + z });
        }
      }
    } else if (edit.mode === 'add') {
      if (!before && edit.color !== undefined)
        delta.voxels.push({
          before: null,
          after: {
            ...position,
            color: edit.color,
            materialType: edit.materialType ?? VoxelMaterial.STANDARD,
            isLocked: false,
          },
        });
    } else if (before && (edit.mode === 'lock' || !before.isLocked)) {
      if (edit.mode === 'delete') delta.voxels.push({ before: cloneVoxel(before), after: null });
      else if (edit.mode === 'lock')
        delta.voxels.push({
          before: cloneVoxel(before),
          after: { ...cloneVoxel(before), isLocked: !before.isLocked },
        });
      else paint(before);
    }
  }
  return delta;
}

export function createMoveCommand(data: VoxelData[], from: Position, to: Position): VoxelDelta {
  const before = data.find((v) => voxelKey(v) === voxelKey(from));
  const voxels: VoxelDelta['voxels'] = [];
  if (
    before &&
    !before.isLocked &&
    voxelKey(from) !== voxelKey(to) &&
    !data.some((v) => voxelKey(v) === voxelKey(to))
  ) {
    voxels.push({ before: cloneVoxel(before), after: { ...cloneVoxel(before), ...to } });
  }
  return { action: 'move', voxels };
}

export function replaceModelCommand(
  before: VoxelData[],
  after: VoxelData[],
  action: VoxelDelta['action'] = 'replace',
): VoxelDelta {
  return {
    action,
    voxels: [
      ...before.map((v) => ({ before: cloneVoxel(v), after: null })),
      ...after.map((v) => ({ before: null, after: cloneVoxel(v) })),
    ],
  };
}

export function applyVoxelCommand(data: VoxelData[], command: VoxelDelta, undo = false): VoxelData[] {
  const grid = new Map(data.map((v) => [voxelKey(v), cloneVoxel(v)]));
  // Remove every source first, so transforms can swap positions without losing voxels.
  for (const change of command.voxels) {
    const source = undo ? change.after : change.before;
    if (source) grid.delete(voxelKey(source));
  }
  for (const change of command.voxels) {
    const target = undo ? change.before : change.after;
    if (target) grid.set(voxelKey(target), cloneVoxel(target));
  }
  return normalizeVoxels([...grid.values()]);
}
