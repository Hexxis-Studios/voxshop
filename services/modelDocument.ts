import { VoxelMaterial, type VoxelData } from '../types';
import type { SkeletonDef } from '../utils/riggingConstants';

export interface ModelDocument {
  format: 'voxshop-model';
  version: 1;
  voxels: VoxelData[];
  skeleton: SkeletonDef | null;
}

export const voxelKey = (v: Pick<VoxelData, 'x' | 'y' | 'z'>): string => `${v.x},${v.y},${v.z}`;
export const cloneVoxel = (v: VoxelData): VoxelData => ({
  ...v,
  ...(v.weights && { weights: v.weights.map((w) => ({ ...w })) }),
});

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function coordinate(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value))) {
    throw new Error('Voxel coordinates must be finite, safe numbers.');
  }
  return Math.round(value) || 0;
}

function color(value: unknown): number {
  if (value === undefined) return 0xcccccc;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  if (typeof value === 'string') {
    let hex = value.replace(/^(#|0x)/i, '');
    if (/^[0-9a-f]{3}$/i.test(hex))
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
  }
  throw new Error('Voxel colors must be RGB numbers or hex colors.');
}

function material(value: unknown): VoxelMaterial {
  if (value === undefined) return VoxelMaterial.STANDARD;
  if (typeof value === 'string') {
    const normalized = value.toUpperCase();
    if (normalized === 'METAL') return VoxelMaterial.METALLIC;
    if (['EMIT', 'GLOW', 'EMISSION'].includes(normalized)) return VoxelMaterial.EMISSIVE;
    if (Object.values(VoxelMaterial).includes(normalized as VoxelMaterial))
      return normalized as VoxelMaterial;
  }
  throw new Error('Unknown voxel material.');
}

/** The one reader for native files, legacy arrays, library data, and generated voxels. */
export function normalizeVoxels(value: unknown): VoxelData[] {
  if (!Array.isArray(value)) throw new Error('Expected an array of voxels.');
  const voxels = new Map<string, VoxelData>();
  for (const input of value) {
    if (!record(input)) throw new Error('Each voxel must be an object.');
    const v: VoxelData = {
      x: coordinate(input.x),
      y: coordinate(input.y),
      z: coordinate(input.z),
      color: color(input.color ?? input.c),
      materialType: material(input.materialType ?? input.m),
      isLocked: input.isLocked === true || input.l === true,
    };
    const bone = input.bone ?? input.b;
    if (bone !== undefined) {
      if (typeof bone !== 'string' || !bone) throw new Error('Bone names must be nonempty strings.');
      v.bone = bone;
    }
    const weights = input.weights ?? input.w;
    if (weights !== undefined) {
      if (!Array.isArray(weights)) throw new Error('Voxel weights must be an array.');
      v.weights = weights.map((w) => {
        if (
          !record(w) ||
          typeof w.bone !== 'string' ||
          !w.bone ||
          typeof w.weight !== 'number' ||
          !Number.isFinite(w.weight) ||
          w.weight < 0 ||
          w.weight > 1
        ) {
          throw new Error('Each weight needs a bone name and a weight between zero and one.');
        }
        return { bone: w.bone, weight: w.weight };
      });
    }
    voxels.set(voxelKey(v), v);
  }
  return [...voxels.values()];
}

export function cloneSkeleton(value: unknown): SkeletonDef | null {
  if (value === null || value === undefined) return null;
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.bones) ||
    !Array.isArray(value.animations)
  )
    throw new Error('Invalid skeleton profile.');
  const pivots = ['center', 'top', 'bottom', 'left', 'right', 'front', 'back'];
  const parents = new Map<string, string | null>();
  for (const bone of value.bones) {
    if (
      !record(bone) ||
      typeof bone.name !== 'string' ||
      !bone.name ||
      parents.has(bone.name) ||
      !(bone.parent === null || typeof bone.parent === 'string') ||
      !pivots.includes(bone.pivotType as string) ||
      typeof bone.color !== 'string'
    ) {
      throw new Error('Invalid skeleton bone.');
    }
    parents.set(bone.name, bone.parent as string | null);
  }
  for (const name of parents.keys()) {
    const visited = new Set<string>();
    let current: string | null = name;
    while (current !== null) {
      if (!parents.has(current) || visited.has(current))
        throw new Error('Skeleton hierarchy is missing a parent or contains a cycle.');
      visited.add(current);
      current = parents.get(current)!;
    }
  }
  for (const animation of value.animations) {
    if (
      !record(animation) ||
      typeof animation.name !== 'string' ||
      typeof animation.duration !== 'number' ||
      !Number.isFinite(animation.duration) ||
      animation.duration < 0 ||
      !record(animation.tracks)
    )
      throw new Error('Invalid skeleton animation.');
    for (const [bone, frames] of Object.entries(animation.tracks)) {
      // Older profiles include optional tracks (for example Root) absent from their bone list.
      // The player already skips unavailable joints; retain these tracks when migrating saves.
      if (!bone || !Array.isArray(frames)) throw new Error('Invalid animation track.');
      for (const frame of frames) {
        if (
          !record(frame) ||
          typeof frame.time !== 'number' ||
          !Number.isFinite(frame.time) ||
          frame.time < 0
        ) {
          throw new Error('Invalid animation keyframe.');
        }
        for (const channel of ['pos', 'rot']) {
          const vector = frame[channel];
          if (
            vector !== undefined &&
            (!Array.isArray(vector) ||
              vector.length !== 3 ||
              vector.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
          )
            throw new Error('Invalid animation vector.');
        }
      }
    }
  }
  return structuredClone(value) as unknown as SkeletonDef;
}

export function createModelDocument(voxels: unknown, skeleton: unknown = null): ModelDocument {
  return {
    format: 'voxshop-model',
    version: 1,
    voxels: normalizeVoxels(voxels),
    skeleton: cloneSkeleton(skeleton),
  };
}

export function parseModelDocument(json: string): ModelDocument {
  const value: unknown = JSON.parse(json);
  if (Array.isArray(value)) return createModelDocument(value);
  if (!record(value) || value.format !== 'voxshop-model')
    throw new Error('Expected a VoxShop model or a legacy voxel array.');
  if (value.version !== 1) throw new Error(`Unsupported VoxShop model version: ${String(value.version)}`);
  return createModelDocument(value.voxels, value.skeleton);
}

export function serializeModelDocument(document: ModelDocument): string {
  return JSON.stringify(createModelDocument(document.voxels, document.skeleton), null, 2);
}
