import { generateRecipe, type Recipe } from './recipeGenerator';
import { createModelDocument, type ModelDocument } from './modelDocument';
import { addAnimationPreset } from './animationPresets';
import type { Asset, Rig } from './projectDocument';
import * as THREE from 'three';

export type CharacterOptions = {
  id: string;
  name: string;
  profile: 'biped' | 'quadruped' | 'machine';
  height: number;
  width: number;
  color: number;
  accent: number;
  voxelSize?: number;
};
/** Bridge existing sculpt rig authoring into the shared runtime rig contract. */
export function sculptedAsset(asset: Asset, model: ModelDocument): Asset {
  const next = { ...structuredClone(asset), model: createModelDocument(model.voxels, model.skeleton) };
  const skeleton = model.skeleton;
  if (!skeleton) return next;
  const jointsByName = new Map<string, Rig['joints'][number]>();
  const worldRotations = new Map<string, THREE.Quaternion>();
  const bonesByName = new Map(skeleton.bones.map((bone) => [bone.name, bone]));
  const toQuaternion = (euler: [number, number, number]) =>
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler));
  const absoluteJoint = (boneName: string): Rig['joints'][number] => {
    const prior = jointsByName.get(boneName);
    if (prior) return prior;
    const bone = bonesByName.get(boneName)!;
    const points = model.voxels.filter((v) => v.bone === bone.name);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const v of points)
      for (const [i, key] of ['x', 'y', 'z'].entries()) {
        min[i] = Math.min(min[i], v[key as 'x' | 'y' | 'z']);
        max[i] = Math.max(max[i], v[key as 'x' | 'y' | 'z']);
      }
    let position: [number, number, number];
    let rotation: [number, number, number];
    if (bone.bindPosition) {
      const parent = bone.parent ? absoluteJoint(bone.parent) : null;
      const parentRotation = parent ? worldRotations.get(parent.name)! : new THREE.Quaternion();
      const local = new THREE.Vector3(...bone.bindPosition).applyQuaternion(parentRotation);
      position = parent
        ? [parent.position[0] + local.x, parent.position[1] + local.y, parent.position[2] + local.z]
        : [...bone.bindPosition];
      rotation = bone.bindRotation ?? [0, 0, 0];
      worldRotations.set(bone.name, parentRotation.clone().multiply(toQuaternion(rotation)));
    } else {
      const pivots: Partial<Record<typeof bone.pivotType, [number, number]>> = {
        left: [0, 0],
        right: [0, 1],
        bottom: [1, 0],
        top: [1, 1],
        back: [2, 0],
        front: [2, 1],
      };
      const pivot = pivots[bone.pivotType];
      const center = points.length ? min.map((n, i) => (n + max[i]) / 2) : [0, 0, 0];
      if (pivot && points.length) center[pivot[0]] = pivot[1] ? max[pivot[0]] : min[pivot[0]];
      position = center as [number, number, number];
      rotation = bone.bindRotation ?? [0, 0, 0];
      const parent = bone.parent ? absoluteJoint(bone.parent) : null;
      const parentRotation = parent ? worldRotations.get(parent.name)! : new THREE.Quaternion();
      worldRotations.set(bone.name, parentRotation.clone().multiply(toQuaternion(rotation)));
    }
    const joint = { name: bone.name, parent: bone.parent, position, rotation };
    jointsByName.set(bone.name, joint);
    return joint;
  };
  const joints = skeleton.bones.map((bone) => absoluteJoint(bone.name));
  const names = new Set(joints.map((j) => j.name));
  const prior = next.rig;
  next.rig = {
    profile: skeleton.id,
    version: 1,
    joints,
    landmarks: prior?.landmarks ?? {},
    sockets: prior?.sockets.filter((s) => names.has(s.joint)) ?? [],
    clips: skeleton.animations
      .filter((a) => a.duration > 0)
      .map((animation) => ({
        name: animation.name,
        duration: animation.duration,
        loop: true,
        speed: /walk|run/i.test(animation.name) ? 3 : 0,
        blendIn: 0.12,
        tracks: Object.entries(animation.tracks)
          .filter(([name]) => names.has(name))
          .map(([joint, frames]) => ({
            joint,
            keys: frames.map((k) => ({
              time: Math.min(k.time, animation.duration),
              rotation: k.rot ?? [0, 0, 0],
              ...(k.pos && { position: k.pos }),
              ...(k.interpolation && { interpolation: k.interpolation }),
            })),
          })),
        events: [],
      })),
  };
  return next;
}
/** Original starter families. All anatomy is editable recipe data; custom rigs use the same format. */
export function generateCharacter(o: CharacterOptions): Asset {
  const h = Math.round(o.height),
    w = Math.round(o.width);
  const shapes: any[] = [];
  const box = (center: number[], size: number[], color: number, bone: string, kind = 'box') =>
    shapes.push({ kind, center, size, color, bone });
  const joints: Rig['joints'] = [];
  const joint = (name: string, parent: string | null, position: [number, number, number]) =>
    joints.push({ name, parent, position, rotation: [0, 0, 0] });
  const rootY = o.profile === 'quadruped' ? h * 0.45 : h * 0.4;
  joint('root', null, [0, rootY, 0]);
  joint('torso', 'root', [0, rootY, 0]);
  let torsoMin: [number, number, number], torsoMax: [number, number, number];
  if (o.profile === 'quadruped') {
    box([0, h * 0.55, 0], [w, h * 0.4, w * 1.8], o.color, 'torso', 'ellipsoid');
    torsoMin = [-w / 2, h * 0.35, -w * 0.9];
    torsoMax = [w / 2, h * 0.75, w * 0.9];
    joint('head', 'torso', [0, h * 0.68, -w * 0.7]);
    box([0, h * 0.8, -w], [w * 0.8, h * 0.35, w * 0.8], o.color, 'head');
    box([0, h * 0.7, -w * 1.4], [w * 0.5, h * 0.13, w * 0.5], o.accent, 'head');
    for (const side of [-1, 1])
      for (const end of [-1, 1]) {
        const name = `leg_${side < 0 ? 'left' : 'right'}_${end < 0 ? 'front' : 'back'}`;
        joint(name, 'torso', [side * w * 0.35, h * 0.45, end * w * 0.6]);
        box([side * w * 0.35, h * 0.34, end * w * 0.57], [w * 0.22, h * 0.23, w * 0.26], o.accent, name);
        const knee = `knee_${side < 0 ? 'left' : 'right'}_${end < 0 ? 'front' : 'back'}`;
        joint(knee, name, [side * w * 0.35, h * 0.2, end * w * 0.72]);
        box([side * w * 0.35, h * 0.11, end * w * 0.76], [w * 0.2, h * 0.2, w * 0.23], o.accent, knee);
        const foot = `foot_${side < 0 ? 'left' : 'right'}_${end < 0 ? 'front' : 'back'}`;
        joint(foot, knee, [side * w * 0.35, h * 0.07, end * w * 0.84]);
        box([side * w * 0.35, h * 0.07, end * w * 0.9], [w * 0.24, h * 0.13, w * 0.3], o.accent, foot);
      }
    joint('tail', 'torso', [0, h * 0.5, w * 0.75]);
    box([0, h * 0.55, w * 1.2], [w * 0.35, h * 0.2, w], o.accent, 'tail', 'ellipsoid');
  } else {
    const machine = o.profile === 'machine';
    box([0, h * 0.56, 0], [w, h * 0.38, w * 0.65], o.color, 'torso', machine ? 'box' : 'ellipsoid');
    torsoMin = [-w / 2, h * 0.37, -w * 0.325];
    torsoMax = [w / 2, h * 0.75, w * 0.325];
    joint('head', 'torso', [0, h * 0.76, 0]);
    box([0, h * 0.87, 0], [w * 0.7, h * 0.24, w * 0.65], o.color, 'head');
    box([0, h * 0.9, -w * 0.34], [w * 0.5, h * 0.06, 1], o.accent, 'head');
    for (const side of [-1, 1]) {
      const suffix = side < 0 ? 'left' : 'right';
      joint(`arm_${suffix}`, 'torso', [side * w * 0.58, h * 0.7, 0]);
      box([side * w * 0.63, h * 0.6, 0], [w * 0.24, h * 0.22, w * 0.3], o.accent, `arm_${suffix}`);
      joint(`forearm_${suffix}`, `arm_${suffix}`, [side * w * 0.64, h * 0.49, 0]);
      box([side * w * 0.64, h * 0.39, 0], [w * 0.22, h * 0.21, w * 0.28], o.accent, `forearm_${suffix}`);
      joint(`hand_${suffix}`, `forearm_${suffix}`, [side * w * 0.64, h * 0.28, 0]);
      box([side * w * 0.64, h * 0.28, -w * 0.02], [w * 0.23, h * 0.13, w * 0.28], o.accent, `hand_${suffix}`);
      joint(`leg_${suffix}`, 'root', [side * w * 0.25, h * 0.38, 0]);
      box([side * w * 0.25, h * 0.29, 0], [w * 0.3, h * 0.2, w * 0.4], o.accent, `leg_${suffix}`);
      joint(`knee_${suffix}`, `leg_${suffix}`, [side * w * 0.25, h * 0.19, 0]);
      box([side * w * 0.25, h * 0.1, 0], [w * 0.28, h * 0.19, w * 0.36], o.accent, `knee_${suffix}`);
      joint(`foot_${suffix}`, `knee_${suffix}`, [side * w * 0.25, h * 0.055, -w * 0.06]);
      box([side * w * 0.25, h * 0.06, -w * 0.11], [w * 0.32, h * 0.11, w * 0.48], o.accent, `foot_${suffix}`);
    }
  }
  // Eyes face -Z for consistent socket/camera orientation.
  for (const side of [-1, 1])
    box(
      [
        side * w * 0.2,
        h * (o.profile === 'quadruped' ? 0.85 : 0.9),
        o.profile === 'quadruped' ? -w * 1.41 : -w * 0.34,
      ],
      [1, 1, 1],
      0x101827,
      'head',
    );
  const baseRig: Rig = {
    profile: o.profile,
    version: 1,
    joints,
    landmarks: { torsoMin, torsoMax, head: joints.find((j) => j.name === 'head')!.position },
    sockets: [
      {
        name: 'back',
        joint: 'torso',
        transform: {
          position: [0, torsoMax[1] - rootY, torsoMax[2] + 1],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
      {
        name: 'hand',
        joint: joints.some((j) => j.name === 'hand_right')
          ? 'hand_right'
          : joints.some((j) => j.name === 'arm_right')
            ? 'arm_right'
            : 'head',
        transform: {
          position: o.profile === 'quadruped' ? [0, 0, -w * 0.5] : [0, 0, -w * 0.25 - 0.5],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
      {
        name: 'body',
        joint: 'root',
        transform: { position: [0, -rootY, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
    clips: [],
  };
  const rig = (['idle', 'walk', 'run'] as const).reduce(
    (current, preset) => addAnimationPreset(current, preset),
    baseRig,
  );
  const recipe = { version: 1, seed: 0, shapes } as Recipe;
  return {
    id: o.id,
    name: o.name,
    model: createModelDocument(generateRecipe(recipe)),
    voxelSize: o.voxelSize ?? 0.1,
    pivot: [0, 0, 0],
    rig,
    recipe,
    source: { kind: 'generated', description: `VoxShop ${o.profile} starter recipe v1` },
  };
}

export function fitEquipment(
  body: Asset,
  options: { id: string; name: string; kind: 'shell' | 'backpack' | 'blade'; color: number },
): Asset {
  const rig = body.rig;
  if (!rig || !rig.landmarks.torsoMin || !rig.landmarks.torsoMax)
    throw new Error('Equipment fitting needs a rig with torsoMin and torsoMax landmarks.');
  const [min, max] = [rig.landmarks.torsoMin, rig.landmarks.torsoMax];
  const size = min.map((v, i) => max[i] - v),
    center = min.map((v, i) => (max[i] + v) / 2);
  let recipe: any,
    fitted = false;
  if (options.kind === 'shell') {
    fitted = true;
    recipe = {
      version: 1,
      shapes: [
        { kind: 'box', center, size: size.map((n) => n + 2), color: options.color, bone: 'torso' },
        { kind: 'box', operation: 'subtract', center, size: size.map((n) => Math.max(1, n)), color: 0 },
        {
          kind: 'box',
          operation: 'subtract',
          center: [center[0], max[1] + 1, center[2]],
          size: [size[0] * 0.6, 4, size[2] + 4],
          color: 0,
        },
      ],
    };
  } else if (options.kind === 'backpack')
    recipe = {
      version: 1,
      shapes: [
        {
          kind: 'box',
          center: [0, 0, 2],
          size: [Math.max(3, size[0] * 0.7), Math.max(4, size[1] * 0.8), 4],
          color: options.color,
        },
      ],
    };
  else
    recipe = {
      version: 1,
      shapes: [
        { kind: 'box', center: [0, 0, -5], size: [1, 2, 10], color: options.color, material: 'METALLIC' },
        { kind: 'box', center: [0, 0, 0], size: [5, 2, 1], color: 0x995a32 },
        { kind: 'box', center: [0, 0, 2], size: [1, 2, 4], color: 0x573b28 },
      ],
    };
  if (fitted && !rig.joints.some((j) => j.name === 'torso'))
    throw new Error('Shell fitting requires a torso joint.');
  let voxels = generateRecipe(recipe);
  if (fitted) {
    const articulated = new Set(
      body.model.voxels
        .filter(
          (v) => v.bone !== 'torso' && !(v.weights?.length && v.weights.every((w) => w.bone === 'torso')),
        )
        .map((v) => `${v.x},${v.y},${v.z}`),
    );
    // Preserve clearance at limb openings instead of leaving coincident shell/body faces.
    voxels = voxels.filter((v) => {
      for (let x = -1; x <= 1; x++)
        for (let y = -1; y <= 1; y++)
          for (let z = -1; z <= 1; z++) if (articulated.has(`${v.x + x},${v.y + y},${v.z + z}`)) return false;
      return true;
    });
    if (!voxels.length)
      throw Error(
        'No shell surface remains after limb clearance. Adjust torso landmarks or author custom equipment.',
      );
  }
  return {
    id: options.id,
    name: options.name,
    model: createModelDocument(voxels),
    voxelSize: body.voxelSize,
    pivot: [0, 0, 0],
    rig: fitted ? structuredClone(rig) : null,
    recipe,
    source: { kind: 'generated', description: `Fitted ${options.kind} for ${body.id}` },
    equipment: {
      bodyAssetId: body.id,
      profile: rig.profile,
      profileVersion: rig.version,
      kind: options.kind,
      socket: fitted ? 'body' : options.kind === 'backpack' ? 'back' : 'hand',
      hiddenBones: fitted ? ['torso'] : [],
    },
  };
}

/** Uniformly fits an asset's rest-pose voxel bounds inside a socket-local meter-space box. */
export function fitAssetToBounds(
  asset: Asset,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  rotation: [number, number, number] = [0, 0, 0],
) {
  const voxels = asset.model.voxels;
  if (!voxels.length) throw new Error('Cannot fit an empty equipment asset.');
  if (
    rotation.some((value) => !Number.isFinite(value)) ||
    bounds.min.some((value, axis) => !Number.isFinite(value) || value >= bounds.max[axis]) ||
    bounds.max.some((value) => !Number.isFinite(value))
  )
    throw new Error('Socket fit bounds must have finite, positive dimensions.');

  const [sinX, cosX] = [Math.sin(rotation[0]), Math.cos(rotation[0])],
    [sinY, cosY] = [Math.sin(rotation[1]), Math.cos(rotation[1])],
    [sinZ, cosZ] = [Math.sin(rotation[2]), Math.cos(rotation[2])],
    pivot = asset.pivot,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const voxel of voxels) {
    const center = [voxel.x - pivot[0], voxel.y - pivot[1], voxel.z - pivot[2]];
    for (const x of [-0.5, 0.5])
      for (const y of [-0.5, 0.5])
        for (const z of [-0.5, 0.5]) {
          const source = [
              (center[0] + x) * asset.voxelSize,
              (center[1] + y) * asset.voxelSize,
              (center[2] + z) * asset.voxelSize,
            ],
            rotatedX = source[0],
            rotatedY = source[1] * cosX - source[2] * sinX,
            rotatedZ = source[1] * sinX + source[2] * cosX,
            yawX = rotatedX * cosY + rotatedZ * sinY,
            yawZ = -rotatedX * sinY + rotatedZ * cosY,
            point = [yawX * cosZ - rotatedY * sinZ, yawX * sinZ + rotatedY * cosZ, yawZ];
          point.forEach((value, axis) => {
            min[axis] = Math.min(min[axis], value);
            max[axis] = Math.max(max[axis], value);
          });
        }
  }

  const sourceSize = max.map((value, axis) => value - min[axis]),
    targetSize = bounds.max.map((value, axis) => value - bounds.min[axis]),
    scale = Math.min(...targetSize.map((value, axis) => value / sourceSize[axis]));
  if (!Number.isFinite(scale) || scale < 0.001 || scale > 1000)
    throw new Error('The fitted equipment scale is outside the supported 0.001–1,000 range.');
  const position = targetSize.map(
    (_, axis) => (bounds.min[axis] + bounds.max[axis] - (min[axis] + max[axis]) * scale) / 2,
  ) as [number, number, number];
  if (position.some((value) => !Number.isFinite(value) || Math.abs(value) > 100_000))
    throw new Error('Fitted equipment position is outside the supported project range.');
  return { position, scale: [scale, scale, scale] as [number, number, number] };
}
