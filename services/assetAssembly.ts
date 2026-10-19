import { generateRecipe, type Recipe } from './recipeGenerator';
import { createModelDocument, type ModelDocument } from './modelDocument';
import type { Asset, Rig } from './projectDocument';

export type CharacterOptions = {
  id: string;
  name: string;
  profile: 'biped' | 'quadruped' | 'machine';
  height: number;
  width: number;
  color: number;
  accent: number;
};
/** Bridge existing sculpt rig authoring into the shared runtime rig contract. */
export function sculptedAsset(asset: Asset, model: ModelDocument): Asset {
  const next = { ...structuredClone(asset), model: createModelDocument(model.voxels, model.skeleton) };
  const skeleton = model.skeleton;
  if (!skeleton) return next;
  const joints: Rig['joints'] = skeleton.bones.map((bone) => {
    const points = model.voxels.filter((v) => v.bone === bone.name);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const v of points)
      for (const [i, key] of ['x', 'y', 'z'].entries()) {
        min[i] = Math.min(min[i], v[key as 'x' | 'y' | 'z']);
        max[i] = Math.max(max[i], v[key as 'x' | 'y' | 'z']);
      }
    const position = points.length ? min.map((n, i) => (n + max[i]) / 2) : [0, 0, 0];
    const pivots: Partial<Record<typeof bone.pivotType, [number, number]>> = {
      left: [0, 0],
      right: [0, 1],
      bottom: [1, 0],
      top: [1, 1],
      back: [2, 0],
      front: [2, 1],
    };
    const pivot = pivots[bone.pivotType];
    if (pivot && points.length) position[pivot[0]] = pivot[1] ? max[pivot[0]] : min[pivot[0]];
    return { name: bone.name, parent: bone.parent, position: position as [number, number, number] };
  });
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
        tracks: Object.entries(animation.tracks)
          .filter(([name]) => names.has(name))
          .map(([joint, frames]) => ({
            joint,
            keys: frames.map((k) => ({
              time: Math.min(k.time, animation.duration),
              rotation: k.rot ?? [0, 0, 0],
              ...(k.pos && { position: k.pos }),
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
    joints.push({ name, parent, position });
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
        box([side * w * 0.35, h * 0.22, end * w * 0.6], [w * 0.22, h * 0.45, w * 0.3], o.accent, name);
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
      box([side * w * 0.64, h * 0.52, 0], [w * 0.25, h * 0.4, w * 0.3], o.accent, `arm_${suffix}`);
      joint(`leg_${suffix}`, 'root', [side * w * 0.25, h * 0.38, 0]);
      box([side * w * 0.25, h * 0.2, 0], [w * 0.3, h * 0.38, w * 0.4], o.accent, `leg_${suffix}`);
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
  const moving = joints.filter((j) => j.name.startsWith('leg_') || j.name.startsWith('arm_'));
  const duration = 0.8;
  const rig: Rig = {
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
        joint: joints.some((j) => j.name === 'arm_right') ? 'arm_right' : 'head',
        transform: {
          position: o.profile === 'quadruped' ? [0, 0, -w * 0.5] : [0, -h * 0.2, -w * 0.25],
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
    clips: [
      {
        name: 'idle',
        duration: 2,
        loop: true,
        speed: 0,
        tracks: [
          {
            joint: 'head',
            keys: [
              { time: 0, rotation: [0, 0, 0] },
              { time: 1, rotation: [0, 0.08, 0] },
              { time: 2, rotation: [0, 0, 0] },
            ],
          },
        ],
        events: [],
      },
      {
        name: 'walk',
        duration,
        loop: true,
        speed: 3,
        tracks: moving.map((j, i) => {
          const amplitude = (i % 2 === 0 ? 1 : -1) * 0.45;
          return {
            joint: j.name,
            keys: [
              { time: 0, rotation: [amplitude, 0, 0] },
              { time: duration / 2, rotation: [-amplitude, 0, 0] },
              { time: duration, rotation: [amplitude, 0, 0] },
            ],
          };
        }),
        events: [
          { time: 0, name: 'step' },
          { time: duration / 2, name: 'step' },
        ],
      },
    ],
  };
  const recipe = { version: 1, seed: 0, shapes } as Recipe;
  return {
    id: o.id,
    name: o.name,
    model: createModelDocument(generateRecipe(recipe)),
    voxelSize: 0.1,
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
  return {
    id: options.id,
    name: options.name,
    model: createModelDocument(generateRecipe(recipe)),
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
