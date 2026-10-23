import { VoxelMaterial, type VoxelData, type VoxelDelta, type VoxelWeight } from '../types';
import { cloneVoxel, normalizeVoxels, voxelKey } from './modelDocument';

type Position = Pick<VoxelData, 'x' | 'y' | 'z'>;
export interface VoxelEdit {
  mode: 'add' | 'delete' | 'paint' | 'lock' | 'fill' | 'weight';
  targets: Position[];
  color?: number;
  materialType?: VoxelMaterial;
  weights?: VoxelWeight[];
}

function checkedWeights(weights: VoxelWeight[] | undefined): VoxelWeight[] {
  if (!weights || weights.length < 1 || weights.length > 4)
    throw new Error('Skin weight edits need one to four joint influences.');
  const seen = new Set<string>();
  for (const influence of weights) {
    if (
      !influence.bone ||
      !Number.isFinite(influence.weight) ||
      influence.weight <= 0 ||
      influence.weight > 1 ||
      seen.has(influence.bone)
    )
      throw new Error('Skin influences need unique joints and weights greater than zero and at most one.');
    seen.add(influence.bone);
  }
  const total = weights.reduce((sum, influence) => sum + influence.weight, 0);
  if (Math.abs(total - 1) > 0.001) throw new Error('Skin weights must sum to one.');
  return weights
    .map(({ bone, weight }) => ({ bone, weight: weight / total }))
    .sort((a, b) => b.weight - a.weight || a.bone.localeCompare(b.bone));
}

/** Set one influence and redistribute the remainder across existing influences. */
export function blendVoxelWeights(
  voxel: Pick<VoxelData, 'bone' | 'weights'>,
  bone: string,
  influence: number,
  fallbackBone?: string,
): VoxelWeight[] {
  if (!bone || !Number.isFinite(influence) || influence <= 0 || influence > 1)
    throw new Error('A painted joint needs an influence greater than zero and at most one.');
  const current = voxel.weights?.length
    ? voxel.weights
    : voxel.bone
      ? [{ bone: voxel.bone, weight: 1 }]
      : fallbackBone
        ? [{ bone: fallbackBone, weight: 1 }]
        : [];
  const accumulated = new Map<string, number>();
  for (const entry of current)
    if (entry.bone !== bone && entry.weight > 0)
      accumulated.set(entry.bone, (accumulated.get(entry.bone) ?? 0) + entry.weight);
  const remaining = [...accumulated.entries()]
    .map(([name, weight]) => ({ bone: name, weight }))
    .sort((a, b) => b.weight - a.weight || a.bone.localeCompare(b.bone))
    .slice(0, 3);
  const total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
  const result =
    influence === 1 || total === 0
      ? [{ bone, weight: 1 }]
      : [
          { bone, weight: influence },
          ...remaining.map((entry) => ({
            bone: entry.bone,
            weight: (entry.weight / total) * (1 - influence),
          })),
        ];
  return result.sort((a, b) => b.weight - a.weight || a.bone.localeCompare(b.bone));
}

/** Commands contain complete records, independent of selection, brush settings, or WebGL. */
export function createVoxelEdit(data: VoxelData[], edit: VoxelEdit): VoxelDelta {
  const grid = new Map<string, VoxelData>();
  for (const voxel of data) grid.set(voxelKey(voxel), voxel);
  return createVoxelEditFromLookup((key) => grid.get(key), edit);
}

/** Builds an edit from a coordinate lookup, so live editors need only visit touched voxels. */
export function createVoxelEditFromLookup(
  getVoxel: (key: string) => VoxelData | undefined,
  edit: VoxelEdit,
): VoxelDelta {
  const weights = edit.mode === 'weight' ? checkedWeights(edit.weights) : undefined;
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
    const before = getVoxel(voxelKey(position));
    if (edit.mode === 'fill') {
      if (!before || before.isLocked || edit.color === undefined) continue;
      const queue = [position];
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i],
          key = voxelKey(p);
        if (visited.has(key)) continue;
        const voxel = getVoxel(key);
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
    } else if (before && edit.mode === 'weight' && !before.isLocked) {
      const after = {
        ...cloneVoxel(before),
        bone: weights![0].bone,
        weights: weights!.map((w) => ({ ...w })),
      };
      if (
        before.bone !== after.bone ||
        JSON.stringify(before.weights ?? []) !== JSON.stringify(after.weights)
      )
        delta.voxels.push({ before: cloneVoxel(before), after });
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
  return createMoveCommandFromLookup((key) => data.find((voxel) => voxelKey(voxel) === key), from, to);
}

export function createMoveCommandFromLookup(
  getVoxel: (key: string) => VoxelData | undefined,
  from: Position,
  to: Position,
): VoxelDelta {
  const sourceKey = voxelKey(from);
  const destinationKey = voxelKey(to);
  const before = getVoxel(sourceKey);
  const voxels: VoxelDelta['voxels'] = [];
  if (before && !before.isLocked && sourceKey !== destinationKey && !getVoxel(destinationKey)) {
    voxels.push({ before: cloneVoxel(before), after: { ...cloneVoxel(before), ...to } });
  }
  return { action: 'move', voxels };
}

/** Moves one existing record through the coordinate index without rebuilding the model array. */
export function moveVoxelInLookup<T extends Position>(
  lookup: Map<string, T>,
  from: Position,
  to: Position,
): T | null {
  const sourceKey = voxelKey(from);
  const destinationKey = voxelKey(to);
  const voxel = lookup.get(sourceKey);
  if (!voxel || sourceKey === destinationKey || lookup.has(destinationKey)) return null;
  lookup.delete(sourceKey);
  voxel.x = to.x;
  voxel.y = to.y;
  voxel.z = to.z;
  lookup.set(destinationKey, voxel);
  return voxel;
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

/** Applies edits to a coordinate-unique model with structural sharing; records are immutable. */
export function applyVoxelCommand(data: VoxelData[], command: VoxelDelta, undo = false): VoxelData[] {
  const sources = normalizeVoxels(
    command.voxels.flatMap((change) => {
      const source = undo ? change.after : change.before;
      return source ? [source] : [];
    }),
  );
  const targets = normalizeVoxels(
    command.voxels.flatMap((change) => {
      const target = undo ? change.before : change.after;
      return target ? [target] : [];
    }),
  );
  const sourceKeys = new Set(sources.map(voxelKey));
  const targetByKey = new Map(targets.map((voxel) => [voxelKey(voxel), voxel]));
  const result: VoxelData[] = [];
  for (const voxel of data) {
    const key = voxelKey(voxel);
    if (sourceKeys.has(key)) continue;
    const replacement = targetByKey.get(key);
    if (replacement) {
      result.push(replacement);
      targetByKey.delete(key);
    } else result.push(voxel);
  }
  // Additions and changed source cells are appended after all removals, matching Map order.
  result.push(...targetByKey.values());
  return result;
}

/** Applies an ordered command to a coordinate map without rebuilding the model array. */
export function applyVoxelCommandToLookup(lookup: Map<string, VoxelData>, command: VoxelDelta, undo = false) {
  for (const change of command.voxels) {
    const source = undo ? change.after : change.before;
    const target = undo ? change.before : change.after;
    if (source) lookup.delete(voxelKey(source));
    if (target) lookup.set(voxelKey(target), target);
  }
}
