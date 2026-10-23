import { z } from 'zod';
import { createModelDocument, voxelKey, type ModelDocument } from './modelDocument';
import {
  applyVoxelCommand,
  applyVoxelCommandToLookup,
  createVoxelEdit,
  createVoxelEditFromLookup,
  type VoxelEdit,
} from './modelCommands';
import { generateRecipe, recipeSchema } from './recipeGenerator';
import { generateCharacter, fitEquipment, fitAssetToBounds } from './assetAssembly';
import {
  terrainGeneratorSchema,
  worldCellSchema,
  worldDocumentSchema,
  worldEditSchema,
} from './worldDocument';
import { playerControlsSchema } from './playerControls';
import { addAnimationPreset, ANIMATION_PRESETS } from './animationPresets';
import { instantiatePrefabNodes, syncLinkedPrefabInstances } from './prefabAuthoring';
import { DEFAULT_SCENE_LIGHTING } from './sceneLightingDefaults';
import { createScatterNodes } from './worldScatter';
import type { VoxelData, VoxelDelta } from '../types';
export { DEFAULT_SCENE_LIGHTING } from './sceneLightingDefaults';

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const COLLISION_OTHER_TARGET = '$other' as const;
const label = z.string().trim().min(1).max(120);
const finite = z.number().finite().min(-100000).max(100000);
export const vectorSchema = z.tuple([finite, finite, finite]);
const scaleSchema = z.tuple([
  z.number().positive().max(1000),
  z.number().positive().max(1000),
  z.number().positive().max(1000),
]);
export const transformSchema = z.object({
  position: vectorSchema.default([0, 0, 0]),
  rotation: vectorSchema.default([0, 0, 0]),
  scale: scaleSchema.default([1, 1, 1]),
});
export type Transform = z.infer<typeof transformSchema>;
export const identityTransform = (): Transform => transformSchema.parse({});
const socketFitBoundsSchema = z
  .object({ min: vectorSchema, max: vectorSchema })
  .superRefine((bounds, context) => {
    for (let axis = 0; axis < 3; axis++)
      if (bounds.min[axis] >= bounds.max[axis])
        context.addIssue({
          code: 'custom',
          path: ['max', axis],
          message: 'Fit bounds must have positive size.',
        });
  })
  .describe('Optional socket-local equipment fit box in meters, before socket scale.');
export const rigSchema = z.object({
  profile: idSchema,
  version: z.literal(1),
  joints: z
    .array(
      z.object({
        name: idSchema,
        parent: idSchema.nullable(),
        position: vectorSchema,
        rotation: vectorSchema.default([0, 0, 0]),
      }),
    )
    .min(1)
    .max(128),
  landmarks: z.record(idSchema, vectorSchema).default({}),
  sockets: z
    .array(
      z.object({
        name: idSchema,
        joint: idSchema,
        transform: transformSchema,
        fitBounds: socketFitBoundsSchema.optional(),
      }),
    )
    .max(64)
    .default([]),
  clips: z
    .array(
      z.object({
        name: idSchema,
        duration: z.number().positive().max(3600),
        loop: z.boolean().default(true),
        speed: z.number().nonnegative().max(1000).default(0),
        blendIn: z.number().finite().min(0).max(2).default(0.12),
        tracks: z
          .array(
            z.object({
              joint: idSchema,
              keys: z
                .array(
                  z.object({
                    time: z.number().nonnegative(),
                    rotation: vectorSchema,
                    position: vectorSchema.optional(),
                    interpolation: z.enum(['linear', 'smooth', 'step']).optional(),
                  }),
                )
                .min(1)
                .max(2048),
            }),
          )
          .max(128),
        events: z
          .array(z.object({ time: z.number().nonnegative(), name: idSchema }))
          .max(256)
          .default([]),
      }),
    )
    .max(64)
    .default([]),
});
export type Rig = z.infer<typeof rigSchema>;
export type RigJointMap = { sourceJoint: string; targetJoint: string };
type QuaternionTuple = [number, number, number, number];

function quaternionFromEuler([x, y, z]: [number, number, number]): QuaternionTuple {
  const c1 = Math.cos(x / 2),
    c2 = Math.cos(y / 2),
    c3 = Math.cos(z / 2),
    s1 = Math.sin(x / 2),
    s2 = Math.sin(y / 2),
    s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function multiplyQuaternions(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  const [x, y, z, w] = a,
    [bx, by, bz, bw] = b;
  return [
    x * bw + w * bx + y * bz - z * by,
    y * bw + w * by + z * bx - x * bz,
    z * bw + w * bz + x * by - y * bx,
    w * bw - x * bx - y * by - z * bz,
  ];
}

function inverseQuaternion([x, y, z, w]: QuaternionTuple): QuaternionTuple {
  return [-x, -y, -z, w];
}

function eulerFromQuaternion([x, y, z, w]: QuaternionTuple): [number, number, number] {
  const m13 = 2 * (x * z + y * w),
    pitch = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999)
    return [
      Math.atan2(2 * (x * w - y * z), 1 - 2 * (x * x + y * y)),
      pitch,
      Math.atan2(2 * (z * w - x * y), 1 - 2 * (y * y + z * z)),
    ];
  return [Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + z * z)), pitch, 0];
}

function rigBindRotations(rig: Rig) {
  const joints = new Map(rig.joints.map((joint) => [joint.name, joint]));
  const rotations = new Map<string, QuaternionTuple>();
  const visiting = new Set<string>();
  const bindRotation = (name: string): QuaternionTuple => {
    const cached = rotations.get(name);
    if (cached) return cached;
    const joint = joints.get(name);
    if (!joint) throw new Error(`Rig joint ${name} does not exist.`);
    if (visiting.has(name)) throw new Error(`Rig joints contain a parent cycle at ${name}.`);
    visiting.add(name);
    const local = quaternionFromEuler(joint.rotation),
      world = joint.parent ? multiplyQuaternions(bindRotation(joint.parent), local) : local;
    visiting.delete(name);
    rotations.set(name, world);
    return world;
  };
  for (const joint of rig.joints) bindRotation(joint.name);
  return rotations;
}

/** Copies a clip between rigs, converting local rotation deltas through each joint's bind axes. */
export function retargetRigClip(
  sourceRig: Rig,
  sourceClipName: string,
  targetRig: Rig,
  targetClipName: string,
  jointMap: readonly RigJointMap[],
  sourceVoxelSize: number,
  targetVoxelSize: number,
): Rig {
  if (!idSchema.safeParse(targetClipName).success) throw new Error('Target clip name must be a valid ID.');
  if (
    !Number.isFinite(sourceVoxelSize) ||
    sourceVoxelSize <= 0 ||
    !Number.isFinite(targetVoxelSize) ||
    targetVoxelSize <= 0
  )
    throw new Error('Asset voxel sizes must be positive finite numbers.');
  const sourceClip = sourceRig.clips.find((clip) => clip.name === sourceClipName);
  if (!sourceClip) throw new Error(`Source animation clip ${sourceClipName} does not exist.`);
  if (targetRig.clips.some((clip) => clip.name === targetClipName))
    throw new Error(`Target animation clip ${targetClipName} already exists.`);
  if (targetRig.clips.length >= 64) throw new Error('A rig can contain at most 64 animation clips.');

  const sourceJoints = new Set(sourceRig.joints.map((joint) => joint.name));
  const targetJoints = new Set(targetRig.joints.map((joint) => joint.name));
  const sourceTracks = new Set(sourceClip.tracks.map((track) => track.joint));
  const mappedSources = new Set<string>();
  const mappedTargets = new Set<string>();
  for (const mapping of jointMap) {
    if (!sourceJoints.has(mapping.sourceJoint) || !sourceTracks.has(mapping.sourceJoint))
      throw new Error(`Source joint ${mapping.sourceJoint} has no track in clip ${sourceClipName}.`);
    if (!targetJoints.has(mapping.targetJoint))
      throw new Error(`Target joint ${mapping.targetJoint} does not exist.`);
    if (mappedSources.has(mapping.sourceJoint) || mappedTargets.has(mapping.targetJoint))
      throw new Error('Retarget mappings must use each source and target joint at most once.');
    mappedSources.add(mapping.sourceJoint);
    mappedTargets.add(mapping.targetJoint);
  }
  if (mappedSources.size === 0) throw new Error('Map at least one source animation track to a target joint.');

  const sourceBindRotations = rigBindRotations(sourceRig);
  const targetBindRotations = rigBindRotations(targetRig);
  const targetBySource = new Map(jointMap.map(({ sourceJoint, targetJoint }) => [sourceJoint, targetJoint]));
  const offsetScale = sourceVoxelSize / targetVoxelSize;
  const clip = {
    ...structuredClone(sourceClip),
    name: targetClipName,
    tracks: sourceClip.tracks.flatMap((track) => {
      const targetJoint = targetBySource.get(track.joint);
      if (!targetJoint) return [];
      const sourceBind = sourceBindRotations.get(track.joint)!,
        targetBind = targetBindRotations.get(targetJoint)!,
        correction = multiplyQuaternions(inverseQuaternion(targetBind), sourceBind),
        inverseCorrection = inverseQuaternion(correction);
      return [
        {
          joint: targetJoint,
          keys: track.keys.map((key) => ({
            ...key,
            rotation: (() => {
              const delta = quaternionFromEuler(key.rotation),
                corrected = multiplyQuaternions(multiplyQuaternions(correction, delta), inverseCorrection);
              return eulerFromQuaternion(corrected);
            })(),
            ...(key.position && {
              position: key.position.map((value) => value * offsetScale) as [number, number, number],
            }),
          })),
        },
      ];
    }),
  };
  return rigSchema.parse({ ...structuredClone(targetRig), clips: [...targetRig.clips, clip] });
}
export const attachmentSchema = z.object({
  assetId: idSchema,
  socket: idSchema,
  transform: transformSchema,
  slot: idSchema,
  hiddenBones: z.array(idSchema).default([]),
});

const inventoryActionItemSchema = z.object({ itemId: idSchema, quantity: z.number().int().min(1).max(9999) });
const actionTargetSchema = z.union([idSchema, z.literal(COLLISION_OTHER_TARGET)]);
export const constructionPaintSchema = worldCellSchema.extend({ id: idSchema, name: label });
export type ConstructionPaint = z.infer<typeof constructionPaintSchema>;
export const MAX_AUDIO_CLIP_BYTES = 3 * 1024 * 1024;
export const MAX_PROJECT_AUDIO_BYTES = 12 * 1024 * 1024;
const audioClipDataUrl = z
  .string()
  .max(4 * Math.ceil(MAX_AUDIO_CLIP_BYTES / 3) + 64)
  .regex(/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/i);
export const audioClipSchema = z
  .object({
    id: idSchema,
    name: label,
    mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i),
    dataUrl: audioClipDataUrl,
  })
  .superRefine((clip, context) => {
    const [header, encoded] = clip.dataUrl.split(',', 2);
    if (header?.toLowerCase() !== `data:${clip.mimeType};base64`.toLowerCase())
      context.addIssue({ code: 'custom', path: ['dataUrl'], message: 'Audio data type does not match.' });
    const padding = encoded?.endsWith('==') ? 2 : encoded?.endsWith('=') ? 1 : 0;
    const bytes = encoded ? Math.floor((encoded.length * 3) / 4) - padding : 0;
    if (bytes <= 0 || bytes > MAX_AUDIO_CLIP_BYTES)
      context.addIssue({ code: 'custom', path: ['dataUrl'], message: 'Audio clips may not exceed 3 MiB.' });
  });
export type AudioClipDocument = z.infer<typeof audioClipSchema>;
const audioClipBytes = (clip: AudioClipDocument) => {
  const encoded = clip.dataUrl.split(',', 2)[1] ?? '';
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
};

// A bounded event/action language is also the custom-logic extension API. No eval or shell.
const rawActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set'),
    variable: idSchema,
    value: z.number().finite(),
    scope: z
      .enum(['scene', 'campaign'])
      .optional()
      .describe('Defaults to scene-local; campaign variables persist across scenes.'),
  }),
  z.object({
    type: z.literal('add'),
    variable: idSchema,
    value: z.number().finite(),
    scope: z
      .enum(['scene', 'campaign'])
      .optional()
      .describe('Defaults to scene-local; campaign variables persist across scenes.'),
  }),
  z.object({ type: z.literal('destroy'), target: actionTargetSchema.optional() }),
  z.object({ type: z.literal('enable'), target: idSchema, value: z.boolean() }),
  z.object({
    type: z.literal('emit'),
    eventId: idSchema.describe('Dispatch this named signal to enabled rules listening for the same ID.'),
  }),
  z.object({ type: z.literal('message'), text: z.string().max(500) }),
  z
    .object({
      type: z.literal('sound'),
      waveform: z.enum(['sine', 'square', 'triangle', 'sawtooth']).default('sine'),
      frequency: z.number().finite().min(20).max(4000).default(440),
      endFrequency: z.number().finite().min(20).max(4000).optional(),
      duration: z.number().finite().min(0.02).max(2).default(0.15),
      volume: z.number().finite().min(0).max(1).default(0.5),
    })
    .describe('Play one bounded procedural oscillator cue; no audio file or external service is required.'),
  z.object({
    type: z.literal('audio'),
    clipId: idSchema,
    volume: z.number().finite().min(0).max(1).default(1),
  }),
  z.object({ type: z.literal('win') }),
  z.object({ type: z.literal('lose') }),
  z.object({
    type: z.literal('damage'),
    target: actionTargetSchema.optional(),
    amount: z.number().positive().max(10000),
  }),
  z.object({
    type: z.literal('heal'),
    target: actionTargetSchema.optional(),
    amount: z.number().positive().max(10000),
  }),
  z.object({ type: z.literal('teleport'), target: actionTargetSchema.optional(), position: vectorSchema }),
  z.object({
    type: z.literal('craft'),
    recipeId: idSchema,
    batches: z.number().int().min(1).max(99).default(1),
  }),
  z.object({ type: z.literal('transition'), sceneId: idSchema }),
  z.object({
    type: z.literal('spawn'),
    prefabId: idSchema,
    position: vectorSchema.optional(),
    offset: vectorSchema.optional(),
    rotation: vectorSchema
      .optional()
      .describe('Optional Euler XYZ rotation in radians for the prefab root; omitted rotation is inherited.'),
    scale: scaleSchema
      .optional()
      .describe('Optional positive per-axis scale for the prefab root; omitted scale is inherited.'),
  }),
  z.object({
    type: z.literal('inventory'),
    remove: z.array(inventoryActionItemSchema).max(16).default([]),
    add: z.array(inventoryActionItemSchema).max(16).default([]),
  }),
]);
export const actionSchema = rawActionSchema.superRefine((action, context) => {
  if (action.type === 'spawn') {
    if (action.position && action.offset)
      context.addIssue({
        code: 'custom',
        message: 'Spawn actions use either a world position or an offset, not both.',
      });
    return;
  }
  if (action.type !== 'inventory') return;
  for (const side of ['remove', 'add'] as const) {
    const entries = action[side];
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.itemId))
        context.addIssue({
          code: 'custom',
          message: `Inventory ${side} item IDs must be unique.`,
          path: [side, index, 'itemId'],
        });
      seen.add(entry.itemId);
    });
  }
  if (action.remove.length + action.add.length === 0)
    context.addIssue({ code: 'custom', message: 'Inventory actions need at least one item.' });
});
const comparisonSchema = z.enum(['>=', '<=', '==', '>', '<']);
export const ruleConditionSchema = z.union([
  z
    .object({
      variable: idSchema,
      itemId: z.never().optional(),
      scope: z
        .enum(['scene', 'campaign'])
        .optional()
        .describe('Defaults to this scene; campaign scope reads the shared campaign state.'),
      op: comparisonSchema,
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      itemId: idSchema,
      variable: z.never().optional(),
      op: comparisonSchema,
      value: z.number().int().min(0).max(1_000_000),
    })
    .strict(),
]);
export type RuleCondition = z.infer<typeof ruleConditionSchema>;
const ruleConditionGroupSchema = z
  .object({
    mode: z
      .enum(['all', 'any'])
      .describe('Use all to require every comparison, or any to require at least one comparison.'),
    conditions: z
      .array(ruleConditionSchema)
      .min(1)
      .max(8)
      .describe('One to eight variable or inventory-count comparisons; nested groups are not supported.'),
  })
  .strict()
  .describe('Optional compound rule condition. Use this instead of the legacy single condition field.');
export type RuleConditionGroup = z.infer<typeof ruleConditionGroupSchema>;
const jointComponentSchema = z
  .object({
    type: z.literal('joint'),
    connectedNodeId: idSchema,
    jointType: z.enum(['fixed', 'revolute', 'prismatic']).default('revolute'),
    anchorSelf: vectorSchema.default([0, 0, 0]),
    anchorOther: vectorSchema.default([0, 0, 0]),
    axis: vectorSchema.default([0, 1, 0]),
    limits: z
      .tuple([finite, finite])
      .refine(([minimum, maximum]) => minimum < maximum, 'Joint minimum must be below its maximum.')
      .optional(),
  })
  .superRefine((joint, context) => {
    if (joint.jointType !== 'fixed' && joint.axis.every((value) => value === 0))
      context.addIssue({ code: 'custom', path: ['axis'], message: 'A slider or hinge axis cannot be zero.' });
    if (joint.jointType === 'fixed' && joint.limits)
      context.addIssue({
        code: 'custom',
        path: ['limits'],
        message: 'Fixed joints do not have motion limits.',
      });
  });
export const ruleSchema = z
  .object({
    event: z.enum([
      'start',
      'interact',
      'touch',
      'untouch',
      'collision',
      'separation',
      'tick',
      'destroyed',
      'attack',
      'animation',
      'ui',
      'signal',
    ]),
    marker: idSchema.optional(),
    eventId: idSchema
      .optional()
      .describe('Required for ui and signal events; UI uses a stable event-button ID.'),
    interval: z.number().min(0.05).max(3600).default(1),
    once: z.boolean().default(false),
    condition: ruleConditionSchema
      .optional()
      .describe('Legacy single variable or inventory-count comparison; choose this or conditionGroup.'),
    conditionGroup: ruleConditionGroupSchema
      .optional()
      .describe('Combine up to eight comparisons with all/any; do not also supply condition.'),
    actions: z.array(actionSchema).min(1).max(32),
  })
  .superRefine((rule, context) => {
    if (rule.condition && rule.conditionGroup)
      context.addIssue({
        code: 'custom',
        path: ['conditionGroup'],
        message: 'Use either a single condition or a condition group, not both.',
      });
    const needsEventId = rule.event === 'ui' || rule.event === 'signal';
    if (needsEventId && !rule.eventId)
      context.addIssue({
        code: 'custom',
        path: ['eventId'],
        message: 'UI and signal rules need an event ID.',
      });
    if (!needsEventId && rule.eventId)
      context.addIssue({
        code: 'custom',
        path: ['eventId'],
        message: 'Event IDs are only valid for UI and signal rules.',
      });
    if (rule.event === 'collision' || rule.event === 'separation') return;
    rule.actions.forEach((action, index) => {
      if ('target' in action && action.target === COLLISION_OTHER_TARGET)
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'target'],
          message: '$other is only valid for collision and separation rules.',
        });
    });
  });
const rawComponentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('player'),
    style: z
      .enum(['first-person', 'third-person', 'top-down'])
      .describe('First-person, third-person follow, or top-down follow camera controls.'),
    speed: z.number().positive().max(100),
    sprintMultiplier: z.number().min(1).max(4).optional(),
    jump: z.number().nonnegative().max(100).default(6),
    gravity: z
      .number()
      .finite()
      .nonnegative()
      .max(100)
      .optional()
      .describe('Downward character acceleration in meters per second squared; default 18.'),
    terminalVelocity: z
      .number()
      .finite()
      .positive()
      .max(200)
      .optional()
      .describe('Maximum downward character speed in meters per second; default 50.'),
    coyoteTime: z
      .number()
      .finite()
      .min(0)
      .max(0.5)
      .optional()
      .describe('Optional seconds after leaving the ground when a jump is still accepted; 0 disables it.'),
    jumpBuffer: z
      .number()
      .finite()
      .min(0)
      .max(0.5)
      .optional()
      .describe('Optional seconds a jump press is remembered before landing; 0 disables it.'),
    stepHeight: z
      .number()
      .finite()
      .min(0)
      .max(5)
      .optional()
      .describe('Maximum grounded step-up height in meters; 0 disables stepping.'),
    maxSlopeAngle: z
      .number()
      .finite()
      .min(0)
      .max(89)
      .optional()
      .describe(
        'Maximum walkable slope in degrees for explicitly shaped solid player colliders; default 45.',
      ),
    cameraHeight: z
      .number()
      .finite()
      .min(0.25)
      .max(10)
      .optional()
      .describe('First-person eye height in meters, default 1.6; ignored by other camera styles.'),
    controls: playerControlsSchema.optional(),
  }),
  z.object({
    type: z.literal('combat'),
    damage: z.number().finite().positive().max(10000).default(25),
    range: z.number().finite().positive().max(100).default(3),
    cooldown: z.number().finite().min(0).max(60).default(0.35),
  }),
  z.object({
    type: z.literal('collider'),
    size: vectorSchema,
    offset: vectorSchema.default([0, 0, 0]),
    solid: z.boolean().default(true),
    shape: z.enum(['box', 'sphere', 'capsule']).optional(),
    sensor: z.boolean().optional(),
    friction: z.number().finite().min(0).max(10).optional(),
    restitution: z.number().finite().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('interactable'),
    prompt: z.string().trim().min(1).max(160).default('Interact'),
    range: z.number().finite().positive().max(100).default(3),
    requiresLineOfSight: z
      .boolean()
      .optional()
      .describe(
        'When true, hide this target if a solid scene collider or terrain cell blocks the player-to-target ray.',
      ),
  }),
  z.object({
    type: z.literal('rigid-body'),
    bodyType: z.enum(['dynamic', 'fixed', 'kinematic-position', 'kinematic-velocity']).optional(),
    mass: z.number().finite().positive().max(1000000).optional(),
    gravity: z.number().finite().min(0).max(100).default(18),
    linearDamping: z.number().finite().min(0).max(20).default(0.15),
    restitution: z.number().finite().min(0).max(1).default(0.2),
    angularDamping: z.number().finite().min(0).max(20).optional(),
    velocity: z
      .tuple([
        z.number().finite().min(-100).max(100),
        z.number().finite().min(-100).max(100),
        z.number().finite().min(-100).max(100),
      ])
      .default([0, 0, 0]),
    angularVelocity: z
      .tuple([
        z.number().finite().min(-100).max(100),
        z.number().finite().min(-100).max(100),
        z.number().finite().min(-100).max(100),
      ])
      .optional(),
    ccd: z.boolean().optional(),
    canSleep: z.boolean().optional(),
    lockRotation: z.boolean().optional(),
  }),
  jointComponentSchema,
  z.object({
    type: z.literal('collectible'),
    variable: idSchema.default('score'),
    amount: z.number().finite().default(1),
    itemId: idSchema.optional(),
    quantity: z.number().int().min(1).max(9999).default(1),
  }),
  z.object({
    type: z.literal('construction'),
    place: z.boolean().default(true),
    remove: z.boolean().default(true),
    range: z.number().finite().positive().max(100).default(6),
    placeCost: z.array(inventoryActionItemSchema).max(16).default([]),
    removeYield: z.array(inventoryActionItemSchema).max(16).default([]),
    palette: z.array(constructionPaintSchema).max(32).optional(),
  }),
  z.object({ type: z.literal('inventory'), slots: z.number().int().min(1).max(128).default(24) }),
  z.object({ type: z.literal('gate'), variable: idSchema, required: z.number().finite() }),
  z.object({ type: z.literal('health'), maximum: z.number().positive().max(100000) }),
  z.object({
    type: z.literal('enemy'),
    speed: z.number().positive().max(100),
    damage: z.number().positive().max(10000),
    range: z.number().positive().max(1000).default(1.5),
  }),
  z.object({
    type: z.literal('patrol'),
    points: z.array(vectorSchema).min(2).max(100),
    speed: z.number().positive().max(100),
  }),
  z.object({ type: z.literal('rules'), apiVersion: z.literal(1), rules: z.array(ruleSchema).max(64) }),
  z.object({
    type: z.literal('animation'),
    idle: idSchema,
    moving: idSchema,
    running: idSchema.optional(),
    jumping: idSchema.optional(),
    attacking: idSchema.optional(),
  }),
]);
export type Component = z.infer<typeof rawComponentSchema>;
export const componentSchema = rawComponentSchema.transform((component): Component => {
  if (component.type === 'collider')
    return {
      ...component,
      sensor: component.sensor ?? false,
      friction: component.friction ?? 0.5,
      restitution: component.restitution ?? 0,
    };
  if (component.type === 'rigid-body')
    return {
      ...component,
      bodyType: component.bodyType ?? 'dynamic',
      mass: component.mass ?? 1,
      angularDamping: component.angularDamping ?? 0.1,
      angularVelocity: component.angularVelocity ?? [0, 0, 0],
      ccd: component.ccd ?? false,
      canSleep: component.canSleep ?? true,
      lockRotation: component.lockRotation ?? false,
    };
  return component;
});
export type ParsedComponent = z.output<typeof componentSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Action = z.infer<typeof actionSchema>;
export const itemUseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heal'), amount: z.number().positive().max(10000) }),
  z.object({ type: z.literal('equip'), assetId: idSchema }),
]);
export const itemDefinitionSchema = z.object({
  id: idSchema,
  name: label,
  description: z.string().max(500).default(''),
  maxStack: z.number().int().min(1).max(999).default(99),
  use: itemUseSchema.optional(),
});
const recipeItemSchema = z.object({ itemId: idSchema, quantity: z.number().int().min(1).max(9999) });
export const craftingRecipeSchema = z.object({
  id: idSchema,
  name: label,
  ingredients: z.array(recipeItemSchema).min(1).max(16),
  outputs: z.array(recipeItemSchema).min(1).max(16),
});
export type ItemDefinition = z.infer<typeof itemDefinitionSchema>;
export type CraftingRecipe = z.infer<typeof craftingRecipeSchema>;
export const nodeSchema = z.object({
  id: idSchema,
  name: label,
  assetId: idSchema.nullable().default(null),
  scatterGroupId: idSchema.max(58).nullable().optional(),
  prefabLink: z
    .object({
      prefabId: idSchema,
      instanceId: idSchema.describe('Stable root node ID for this placed prefab instance.'),
      sourceNodeId: idSchema,
      removedSourceIds: z.array(idSchema).max(5000).optional(),
    })
    .optional(),
  parentId: idSchema.nullable().default(null),
  transform: transformSchema,
  enabled: z.boolean().default(true),
  components: z.array(componentSchema).max(16).default([]),
  attachments: z.array(attachmentSchema).max(16).default([]),
});
export type SceneNode = z.infer<typeof nodeSchema>;
const scatterBoundsSchema = z
  .object({ minX: finite, maxX: finite, minZ: finite, maxZ: finite })
  .superRefine((bounds, context) => {
    if (bounds.minX >= bounds.maxX)
      context.addIssue({ code: 'custom', path: ['maxX'], message: 'Scatter maxX must exceed minX.' });
    if (bounds.minZ >= bounds.maxZ)
      context.addIssue({ code: 'custom', path: ['maxZ'], message: 'Scatter maxZ must exceed minZ.' });
  });
const scatterScaleRangeSchema = z
  .tuple([z.number().finite().positive().max(100), z.number().finite().positive().max(100)])
  .superRefine(([min, max], context) => {
    if (min > max)
      context.addIssue({ code: 'custom', message: 'Scatter scale minimum must not exceed maximum.' });
  });
const sceneScatterParametersSchema = z.object({
  assetId: idSchema.describe('Static opaque voxel asset to instance throughout the selected area.'),
  seed: z.number().int().min(-2147483648).max(2147483647),
  count: z.number().int().min(1).max(1000).describe('Number of editable scene nodes to generate.'),
  bounds: scatterBoundsSchema.describe('Axis-aligned X/Z rectangle in world meters.'),
  snapToTerrain: z.boolean().default(true),
  groundY: finite.default(0).describe('Flat ground top in meters when terrain snapping is disabled.'),
  scaleRange: scatterScaleRangeSchema.default([0.8, 1.2]),
  randomYaw: z.boolean().default(true),
});
export const sceneScatterSchema = sceneScatterParametersSchema.extend({
  id: idSchema.max(58).describe('Stable group ID; generated scene nodes use this as their scatterGroupId.'),
});
export type SceneScatter = z.infer<typeof sceneScatterSchema>;
const sceneHemisphereLightingSchema = z.object({
  skyColor: z.number().int().min(0).max(0xffffff).default(0xc5e3ff),
  groundColor: z.number().int().min(0).max(0xffffff).default(0x334025),
  intensity: z.number().finite().min(0).max(10).default(2),
});
const sceneDirectionalLightingSchema = z.object({
  color: z.number().int().min(0).max(0xffffff).default(0xffe8ce),
  intensity: z.number().finite().min(0).max(10).default(3),
  position: z
    .tuple([
      z.number().finite().min(-10_000).max(10_000),
      z.number().finite().min(-10_000).max(10_000),
      z.number().finite().min(-10_000).max(10_000),
    ])
    .default([12, 24, 8]),
  castShadow: z.boolean().default(true),
});
export const sceneLightingSchema = z.object({
  hemisphere: sceneHemisphereLightingSchema.default({ ...DEFAULT_SCENE_LIGHTING.hemisphere }),
  directional: sceneDirectionalLightingSchema.default({ ...DEFAULT_SCENE_LIGHTING.directional }),
});
export type SceneLighting = z.infer<typeof sceneLightingSchema>;
export const prefabSchema = z
  .object({
    id: idSchema,
    name: label,
    rootId: idSchema,
    attachmentParentId: idSchema.nullable().default(null),
    nodes: z.array(nodeSchema).min(1).max(5000),
  })
  .superRefine((prefab, context) => {
    const roots = prefab.nodes.filter((node) => node.parentId === null);
    if (roots.length !== 1 || roots[0]?.id !== prefab.rootId)
      context.addIssue({
        code: 'custom',
        path: ['rootId'],
        message: 'A prefab must have exactly one declared root node.',
      });
  });
export type Prefab = z.infer<typeof prefabSchema>;

const hudBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('variable'),
    id: idSchema,
    scope: z.enum(['scene', 'campaign']).optional().describe('Defaults to a scene-local variable.'),
  }),
  z.object({ kind: z.literal('health') }),
  z.object({ kind: z.literal('inventory'), itemId: idSchema }),
]);
export const hudActionSchema = z.enum([
  'togglePause',
  'jump',
  'interact',
  'attack',
  'useItem',
  'placeCell',
  'removeCell',
  'cyclePaint',
]);
const hudWidgetBase = {
  id: idSchema,
  parentId: idSchema.optional().describe('Optional parent panel ID; panels may nest up to four levels.'),
  visibleWhen: ruleConditionSchema
    .optional()
    .describe('Optional variable or inventory condition for screen-flow visibility.'),
  visibleWhenPaused: z
    .boolean()
    .optional()
    .describe('Optional pause state required for this widget to be visible.'),
  visibleWhenTab: z
    .object({ groupId: idSchema, tabId: idSchema })
    .optional()
    .describe('Optional tab selection required for this widget to be visible.'),
  anchor: z
    .enum([
      'top-left',
      'top-center',
      'top-right',
      'center-left',
      'center',
      'center-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ])
    .default('top-left'),
  offsetX: z.number().int().min(-2000).max(2000).default(0),
  offsetY: z.number().int().min(-2000).max(2000).default(0),
  width: z.number().int().min(40).max(1000).default(200),
  fontSize: z.number().int().min(10).max(64).default(16),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#f1f5f9'),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#111827'),
  fillColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#34d399'),
  opacity: z.number().min(0).max(1).default(0.85),
};
export const gameHudWidgetSchema = z.discriminatedUnion('type', [
  z.object({ ...hudWidgetBase, type: z.literal('text'), text: z.string().max(500) }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('panel'),
    height: z.number().int().min(24).max(1200).default(180),
    layout: z.enum(['free', 'row', 'column']).default('free'),
    gap: z.number().int().min(0).max(64).default(8),
    padding: z.number().int().min(0).max(64).default(12),
  }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('value'),
    binding: hudBindingSchema,
    prefix: z.string().max(120).default(''),
    suffix: z.string().max(120).default(''),
  }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('bar'),
    binding: hudBindingSchema,
    label: z.string().max(120).default(''),
    min: z.number().finite().default(0),
    max: z.number().finite().default(100),
  }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('button'),
    text: z.string().min(1).max(120),
    action: hudActionSchema,
  }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('event-button'),
    text: z.string().min(1).max(120),
    eventId: idSchema,
  }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('tab-button'),
    text: z.string().min(1).max(120),
    groupId: idSchema,
    tabId: idSchema,
  }),
  z.object({
    ...hudWidgetBase,
    type: z.literal('inventory'),
    maxItems: z.number().int().min(1).max(32).default(12),
    columns: z.number().int().min(1).max(8).default(3),
    showUseButtons: z.boolean().default(true),
  }),
]);
export type GameHudWidget = z.infer<typeof gameHudWidgetSchema>;
export const MAX_HUD_PANEL_DEPTH = 4;
export const sceneSchema = z.object({
  id: idSchema,
  name: label,
  worldId: idSchema.nullable().default(null),
  nodes: z.array(nodeSchema).max(5000).default([]),
  scatterGroups: z.array(sceneScatterSchema).max(1000).optional(),
  background: z.number().int().min(0).max(0xffffff).default(0x111827),
  groundColor: z.number().int().min(0).max(0xffffff).default(0x334155),
  lighting: sceneLightingSchema
    .optional()
    .describe('Optional scene lighting; omission preserves renderer defaults.'),
  bounds: z.number().positive().max(10000).default(40),
  variables: z.record(idSchema, z.number().finite()).default({}),
  items: z.array(itemDefinitionSchema).max(128).default([]),
  recipes: z.array(craftingRecipeSchema).max(128).default([]),
  objectives: z
    .array(
      z.object({
        id: idSchema,
        text: label,
        condition: ruleConditionSchema,
        requires: z
          .array(idSchema)
          .max(15)
          .optional()
          .describe('Optional objective IDs that must be completed before this objective is available.'),
      }),
    )
    .max(16)
    .describe(
      'Up to 16 unique-ID progress goals with optional same-scene prerequisites, using the same variable or inventory conditions as rules.',
    )
    .default([]),
  hud: z.array(gameHudWidgetSchema).max(32).optional(),
  music: z
    .object({ clipId: idSchema, volume: z.number().finite().min(0).max(1).default(0.5) })
    .optional()
    .describe('Optional looping scene music, resumed on the first permitted audio gesture.'),
  instructions: z
    .string()
    .max(2000)
    .default('Explore the scene, interact with its objects, and reach the authored goal.'),
});
export type GameScene = z.infer<typeof sceneSchema>;
const modelSchema = z.unknown().transform((v, ctx): ModelDocument => {
  try {
    if (!v || typeof v !== 'object' || (v as any).format !== 'voxshop-model' || (v as any).version !== 1)
      throw new Error('Invalid model envelope.');
    const model = createModelDocument((v as any).voxels, (v as any).skeleton);
    if (model.voxels.length > 250000) throw new Error('An asset may contain at most 250,000 voxels.');
    return model;
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});
export const assetSchema = z.object({
  id: idSchema,
  name: label,
  model: modelSchema,
  voxelSize: z
    .number()
    .positive()
    .min(0.001)
    .max(100)
    .default(0.1)
    .describe('Meters per asset voxel, independent of terrain-cell size and scene-node scale.'),
  pivot: vectorSchema.default([0, 0, 0]),
  rig: rigSchema.nullable().default(null),
  recipe: recipeSchema.optional(),
  source: z
    .object({
      kind: z.enum(['authored', 'generated', 'imported']),
      description: z.string().max(2000).default(''),
      seed: z.number().int().optional(),
    })
    .default({ kind: 'authored', description: '' }),
  variantOf: idSchema.optional(),
  equipment: z
    .object({
      bodyAssetId: idSchema,
      profile: idSchema,
      profileVersion: z.literal(1),
      kind: z.enum(['shell', 'backpack', 'blade']),
      socket: idSchema,
      hiddenBones: z.array(idSchema),
    })
    .optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const projectSchema = z.object({
  format: z.literal('voxshop-project'),
  version: z.literal(1),
  id: idSchema,
  name: label,
  revision: z.number().int().nonnegative(),
  units: z.literal('meters'),
  upAxis: z.literal('Y'),
  assets: z.array(assetSchema).max(1000),
  audioClips: z.array(audioClipSchema).max(16).default([]),
  prefabs: z.array(prefabSchema).max(1000).default([]),
  worlds: z.array(worldDocumentSchema).max(100).default([]),
  scenes: z.array(sceneSchema).min(1).max(100),
  activeSceneId: idSchema,
  activeAssetId: idSchema.nullable(),
  editorDraft: modelSchema.nullable(),
});
export type ProjectDocument = z.infer<typeof projectSchema>;
export type AssetEditHistoryEntry = {
  kind: 'asset-edit';
  edits: { assetId: string; delta: VoxelDelta }[];
};
export type ProjectHistoryEntry = ProjectDocument | AssetEditHistoryEntry;

function unique(values: string[], what: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${what} ID.`);
}
function hierarchy(entries: { name: string; parent: string | null }[], what: string) {
  unique(
    entries.map((e) => e.name),
    what,
  );
  const parents = new Map(entries.map((e) => [e.name, e.parent]));
  for (const e of entries) {
    let next: string | null = e.name;
    const seen = new Set<string>();
    while (next !== null) {
      if (!parents.has(next) || seen.has(next))
        throw new Error(`${what} hierarchy has a missing parent or cycle.`);
      seen.add(next);
      if (seen.size > 128) throw new Error(`${what} hierarchy exceeds 128 levels.`);
      next = parents.get(next)!;
    }
  }
}
export function validateProject(value: unknown): ProjectDocument {
  const p = projectSchema.parse(value);
  unique(
    p.assets.map((a) => a.id),
    'asset',
  );
  unique(
    p.scenes.map((s) => s.id),
    'scene',
  );
  unique(
    p.worlds.map((w) => w.id),
    'world',
  );
  unique(
    p.prefabs.map((prefab) => prefab.id),
    'prefab',
  );
  unique(
    p.audioClips.map((clip) => clip.id),
    'audio clip',
  );
  if (p.audioClips.reduce((total, clip) => total + audioClipBytes(clip), 0) > MAX_PROJECT_AUDIO_BYTES)
    throw new Error('Project audio exceeds 12 MiB.');
  const audioClipIds = new Set(p.audioClips.map((clip) => clip.id));
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  const sceneIds = new Set(p.scenes.map((scene) => scene.id));
  if (
    !p.scenes.some((s) => s.id === p.activeSceneId) ||
    (p.activeAssetId !== null && !assets.has(p.activeAssetId))
  )
    throw new Error('Active selection is missing.');
  if (p.assets.reduce((n, a) => n + a.model.voxels.length, 0) > 1000000)
    throw new Error('Project exceeds one million voxels.');
  if (p.worlds.reduce((n, w) => n + w.edits.length, 0) > 1000000)
    throw new Error('Project exceeds one million world edits.');
  if (p.prefabs.reduce((count, prefab) => count + prefab.nodes.length, 0) > 25000)
    throw new Error('Project exceeds 25,000 saved prefab nodes.');
  for (const a of p.assets) {
    if (a.variantOf && (!assets.has(a.variantOf) || a.variantOf === a.id))
      throw new Error('Missing or invalid variant source.');
    if (a.equipment) {
      const body = assets.get(a.equipment.bodyAssetId);
      if (
        !body?.rig ||
        a.equipment.profile !== body.rig.profile ||
        a.equipment.profileVersion !== body.rig.version ||
        !body.rig.sockets.some((socket) => socket.name === a.equipment!.socket) ||
        a.equipment.hiddenBones.some((joint) => !body.rig!.joints.some((entry) => entry.name === joint)) ||
        (a.rig && JSON.stringify(a.rig.joints) !== JSON.stringify(body.rig.joints))
      )
        throw new Error('Equipment is fitted to a missing or incompatible body.');
    }
    if (!a.rig) continue;
    hierarchy(a.rig.joints, 'joint');
    const joints = new Set(a.rig.joints.map((j) => j.name));
    unique(
      a.rig.sockets.map((s) => s.name),
      'socket',
    );
    unique(
      a.rig.clips.map((c) => c.name),
      'clip',
    );
    if (a.rig.sockets.some((s) => !joints.has(s.joint)))
      throw new Error('Socket references a missing joint.');
    for (const c of a.rig.clips) {
      if (
        c.tracks.some((t) => !joints.has(t.joint) || t.keys.some((k) => k.time > c.duration)) ||
        c.events.some((e) => e.time > c.duration)
      )
        throw new Error('Invalid animation joint or key time.');
    }
    for (const v of a.model.voxels) {
      if (v.weights && v.weights.length > 4)
        throw new Error('Rigged voxels support up to four skin weights.');
      if ((v.bone && !joints.has(v.bone)) || v.weights?.some((w) => !joints.has(w.bone)))
        throw new Error('Voxel references a joint absent from its rig.');
      if (v.weights?.length && Math.abs(v.weights.reduce((s, w) => s + w.weight, 0) - 1) > 0.001)
        throw new Error('Skin weights must sum to one.');
    }
  }
  for (const prefab of p.prefabs) {
    if (prefab.nodes.some((node) => node.prefabLink))
      throw new Error(`Prefab ${prefab.id} cannot contain placed-instance links.`);
    const prefabNodesById = new Map(prefab.nodes.map((node) => [node.id, node]));
    hierarchy(
      prefab.nodes.map((node) => ({ name: node.id, parent: node.parentId })),
      `node in prefab ${prefab.id}`,
    );
    if (!prefab.nodes.some((node) => node.id === prefab.rootId && node.parentId === null))
      throw new Error(`Prefab ${prefab.id} root is missing.`);
    if (
      prefab.attachmentParentId &&
      (prefab.nodes.some((node) => node.id === prefab.attachmentParentId) ||
        !p.scenes.some((scene) => scene.nodes.some((node) => node.id === prefab.attachmentParentId)))
    )
      throw new Error(`Prefab ${prefab.id} has a missing or internal attachment parent.`);
    for (const node of prefab.nodes) {
      if (node.assetId && !assets.has(node.assetId))
        throw new Error(`Missing asset on prefab node ${node.id}.`);
      const body = node.assetId && assets.get(node.assetId);
      unique(
        node.components.map((component) => component.type),
        'component',
      );
      unique(
        node.attachments.map((attachment) => attachment.slot),
        'equipment slot',
      );
      for (const attachment of node.attachments) {
        if (
          !assets.has(attachment.assetId) ||
          !body ||
          !body.rig?.sockets.some((socket) => socket.name === attachment.socket)
        )
          throw new Error(`Invalid attachment on prefab node ${node.id}.`);
      }
      for (const joint of node.components.filter((component) => component.type === 'joint')) {
        const connected = prefabNodesById.get(joint.connectedNodeId);
        if (
          joint.connectedNodeId === node.id ||
          !node.components.some((component) => component.type === 'rigid-body') ||
          !connected?.components.some((component) => component.type === 'rigid-body')
        )
          throw new Error(`Joint on prefab node ${node.id} must connect two different prefab rigid bodies.`);
      }
      const rules = node.components.find((component) => component.type === 'rules');
      if (rules)
        for (const rule of rules.rules)
          for (const action of rule.actions) {
            if (action.type === 'spawn' && !p.prefabs.some((candidate) => candidate.id === action.prefabId))
              throw new Error(`Rule references a missing prefab ${action.prefabId}.`);
            if (action.type === 'transition' && !sceneIds.has(action.sceneId))
              throw new Error(`Rule references a missing scene ${action.sceneId}.`);
            if (action.type === 'audio' && !audioClipIds.has(action.clipId))
              throw new Error(`Rule references a missing audio clip ${action.clipId}.`);
          }
    }
  }
  for (const scene of p.scenes) {
    if (scene.music && !audioClipIds.has(scene.music.clipId))
      throw new Error(`Scene ${scene.id} references a missing music clip.`);
    if (scene.worldId && !p.worlds.some((world) => world.id === scene.worldId))
      throw new Error(`Missing world on scene ${scene.id}.`);
    if (scene.nodes.filter((n) => n.components.some((c) => c.type === 'player')).length > 1)
      throw new Error('A scene supports one player controller.');
    unique(
      scene.items.map((item) => item.id),
      'item',
    );
    unique(
      scene.recipes.map((recipe) => recipe.id),
      'recipe',
    );
    const itemIds = new Set(scene.items.map((item) => item.id));
    unique(
      scene.objectives.map((objective) => objective.id),
      'objective',
    );
    const objectivesById = new Map(scene.objectives.map((objective) => [objective.id, objective]));
    for (const objective of scene.objectives) {
      const requires = objective.requires ?? [];
      unique(requires, `prerequisite on objective ${objective.id}`);
      if (requires.some((id) => id === objective.id || !objectivesById.has(id)))
        throw new Error(`Objective ${objective.id} references an invalid prerequisite.`);
    }
    const visitedObjectives = new Set<string>();
    const visitingObjectives = new Set<string>();
    const visitObjective = (id: string) => {
      if (visitedObjectives.has(id)) return;
      if (visitingObjectives.has(id)) throw new Error('Objective prerequisites cannot contain a cycle.');
      visitingObjectives.add(id);
      for (const requiredId of objectivesById.get(id)?.requires ?? []) visitObjective(requiredId);
      visitingObjectives.delete(id);
      visitedObjectives.add(id);
    };
    for (const objective of scene.objectives) visitObjective(objective.id);
    unique(
      (scene.hud ?? []).map((widget) => widget.id),
      `HUD widget in scene ${scene.id}`,
    );
    const hudWidgets = scene.hud ?? [];
    const tabButtons = hudWidgets.filter((widget) => widget.type === 'tab-button');
    unique(
      tabButtons.map((widget) => `${widget.groupId}\u0000${widget.tabId}`),
      'HUD tab',
    );
    const tabsByGroup = new Map<string, Set<string>>();
    for (const tab of tabButtons) {
      const tabs = tabsByGroup.get(tab.groupId) ?? new Set<string>();
      tabs.add(tab.tabId);
      tabsByGroup.set(tab.groupId, tabs);
    }
    if (
      hudWidgets.some(
        (widget) =>
          widget.visibleWhenTab &&
          !tabsByGroup.get(widget.visibleWhenTab.groupId)?.has(widget.visibleWhenTab.tabId),
      )
    )
      throw new Error(`Invalid HUD tab visibility in scene ${scene.id}.`);
    if (
      (scene.hud ?? []).some(
        (widget) =>
          (widget.type === 'bar' && widget.max <= widget.min) ||
          ((widget.type === 'value' || widget.type === 'bar') &&
            widget.binding.kind === 'inventory' &&
            !itemIds.has(widget.binding.itemId)) ||
          (typeof widget.visibleWhen?.itemId === 'string' && !itemIds.has(widget.visibleWhen.itemId)),
      )
    )
      throw new Error(`Invalid HUD binding or range in scene ${scene.id}.`);
    const hudById = new Map(hudWidgets.map((widget) => [widget.id, widget]));
    if (
      hudWidgets.some((widget) => {
        let current: GameHudWidget | undefined = widget;
        const seen = new Set([widget.id]);
        let depth = 0;
        while (current?.parentId) {
          depth++;
          const parent = hudById.get(current.parentId);
          if (!parent || parent.type !== 'panel' || seen.has(parent.id) || depth > MAX_HUD_PANEL_DEPTH)
            return true;
          seen.add(parent.id);
          current = parent;
        }
        return false;
      })
    )
      throw new Error(`Invalid HUD panel parent in scene ${scene.id}.`);
    if (
      scene.objectives.some(
        (objective) => objective.condition.itemId && !itemIds.has(objective.condition.itemId),
      )
    )
      throw new Error('Objective condition references a missing item.');
    for (const recipe of scene.recipes) {
      const ingredientIds = recipe.ingredients.map((entry) => entry.itemId);
      const outputIds = recipe.outputs.map((entry) => entry.itemId);
      unique(ingredientIds, `ingredient in recipe ${recipe.id}`);
      unique(outputIds, `output in recipe ${recipe.id}`);
      if ([...ingredientIds, ...outputIds].some((id) => !itemIds.has(id)))
        throw new Error(`Recipe ${recipe.id} references a missing item.`);
    }
    hierarchy(
      scene.nodes.map((n) => ({ name: n.id, parent: n.parentId })),
      'node',
    );
    const scatterGroups = scene.scatterGroups ?? [];
    unique(
      scatterGroups.map((scatter) => scatter.id),
      `scatter group in scene ${scene.id}`,
    );
    const scatterIds = new Set(scatterGroups.map((scatter) => scatter.id));
    for (const scatter of scatterGroups) {
      if (!assets.has(scatter.assetId)) throw new Error(`Missing asset on scatter group ${scatter.id}.`);
      if (scatter.snapToTerrain && !scene.worldId)
        throw new Error(`Terrain scatter group ${scatter.id} needs a scene world.`);
    }
    const ids = new Set(scene.nodes.map((n) => n.id));
    const nodesById = new Map(scene.nodes.map((node) => [node.id, node]));
    const linkedSourceKeys = new Set<string>();
    for (const node of scene.nodes) {
      if (node.assetId && !assets.has(node.assetId)) throw new Error(`Missing asset on ${node.id}.`);
      if (node.scatterGroupId && !scatterIds.has(node.scatterGroupId))
        throw new Error(`Node ${node.id} references a missing scatter group.`);
      if (node.prefabLink) {
        const link = node.prefabLink;
        const prefab = p.prefabs.find((entry) => entry.id === link.prefabId);
        const root = nodesById.get(link.instanceId);
        if (
          !prefab ||
          !prefab.nodes.some((entry) => entry.id === link.sourceNodeId) ||
          !root?.prefabLink ||
          root.prefabLink.prefabId !== link.prefabId ||
          root.prefabLink.instanceId !== root.id ||
          root.prefabLink.sourceNodeId !== prefab.rootId ||
          (link.sourceNodeId === prefab.rootId) !== (node.id === link.instanceId)
        )
          throw new Error(`Node ${node.id} has an invalid prefab instance link.`);
        const sourceKey = `${link.instanceId}:${link.sourceNodeId}`;
        if (linkedSourceKeys.has(sourceKey))
          throw new Error(`Prefab instance duplicates source node ${link.sourceNodeId}.`);
        linkedSourceKeys.add(sourceKey);
        if (link.removedSourceIds !== undefined && node.id !== link.instanceId)
          throw new Error('Removed prefab source IDs belong on the instance root.');
        if (
          link.removedSourceIds &&
          (new Set(link.removedSourceIds).size !== link.removedSourceIds.length ||
            link.removedSourceIds.some(
              (id) => id === prefab.rootId || !prefab.nodes.some((entry) => entry.id === id),
            ))
        )
          throw new Error('Prefab instance contains invalid removed-source overrides.');
      }
      unique(
        node.components.map((c) => c.type),
        'component',
      );
      const body = node.assetId && assets.get(node.assetId);
      unique(
        node.attachments.map((a) => a.slot),
        'equipment slot',
      );
      for (const a of node.attachments) {
        if (!assets.has(a.assetId) || !body || !body.rig?.sockets.some((s) => s.name === a.socket))
          throw new Error(`Invalid attachment on ${node.id}.`);
        if (a.hiddenBones.some((b) => !body.rig!.joints.some((j) => j.name === b)))
          throw new Error('Equipment mask references a missing bone.');
        const item = assets.get(a.assetId)!;
        if (
          item.equipment &&
          (item.equipment.bodyAssetId !== body.id || item.equipment.profile !== body.rig!.profile)
        )
          throw new Error('Equipment was fitted to a different body.');
        if (item.equipment && item.equipment.socket !== a.socket)
          throw new Error('Fitted equipment must use its declared socket.');
        if (
          item.equipment &&
          item.rig &&
          JSON.stringify(item.rig.joints) !== JSON.stringify(body.rig!.joints)
        )
          throw new Error('Body rig changed. Refit the equipment before attaching it.');
      }
      for (const c of node.components) {
        if (c.type === 'inventory' && !node.components.some((component) => component.type === 'player'))
          throw new Error('Inventory components belong on the player.');
        if (c.type === 'combat' && !node.components.some((component) => component.type === 'player'))
          throw new Error('Combat components belong on the player.');
        if (c.type === 'construction') {
          if (!node.components.some((component) => component.type === 'player'))
            throw new Error('Construction components belong on the player.');
          if (c.palette)
            unique(
              c.palette.map((paint) => paint.id),
              'construction paint',
            );
          for (const side of ['placeCost', 'removeYield'] as const) {
            const entries = c[side];
            unique(
              entries.map((entry) => entry.itemId),
              `construction ${side} item`,
            );
            if (entries.some((entry) => !itemIds.has(entry.itemId)))
              throw new Error(`Construction ${side} references a missing item.`);
          }
        }
        if (c.type === 'collectible' && c.itemId && !itemIds.has(c.itemId))
          throw new Error(`Collectible on ${node.id} references a missing item.`);
        if (c.type === 'collider' && c.size.some((n) => n <= 0))
          throw new Error('Collider dimensions must be positive.');
        if (c.type === 'joint') {
          const connected = nodesById.get(c.connectedNodeId);
          if (
            c.connectedNodeId === node.id ||
            !node.components.some((component) => component.type === 'rigid-body') ||
            !connected?.components.some((component) => component.type === 'rigid-body')
          )
            throw new Error(`Joint on ${node.id} must connect two different rigid-body nodes in its scene.`);
        }
        if (
          c.type === 'rigid-body' &&
          (!node.components.some(
            (component) => component.type === 'collider' && (component.solid || component.sensor),
          ) ||
            node.components.some(
              (component) =>
                component.type === 'player' || component.type === 'enemy' || component.type === 'patrol',
            ))
        )
          throw new Error(
            'Rigid bodies need a solid collider or trigger sensor and cannot use actor movement behaviors.',
          );
        if (c.type === 'rules') {
          for (const r of c.rules) {
            const conditions = [
              ...(r.condition ? [r.condition] : []),
              ...(r.conditionGroup?.conditions ?? []),
            ];
            for (const condition of conditions)
              if (condition.itemId && !itemIds.has(condition.itemId))
                throw new Error(`Rule condition references a missing item ${condition.itemId}.`);
            for (const a of r.actions) {
              if ('target' in a && a.target && a.target !== COLLISION_OTHER_TARGET && !ids.has(a.target))
                throw new Error('Rule references a missing node.');
              if (a.type === 'craft' && !scene.recipes.some((recipe) => recipe.id === a.recipeId))
                throw new Error(`Rule references a missing recipe ${a.recipeId}.`);
              if (a.type === 'transition' && !sceneIds.has(a.sceneId))
                throw new Error(`Rule references a missing scene ${a.sceneId}.`);
              if (a.type === 'spawn' && !p.prefabs.some((prefab) => prefab.id === a.prefabId))
                throw new Error(`Rule references a missing prefab ${a.prefabId}.`);
              if (a.type === 'audio' && !audioClipIds.has(a.clipId))
                throw new Error(`Rule references a missing audio clip ${a.clipId}.`);
              if (
                a.type === 'inventory' &&
                [...a.remove, ...a.add].some((entry) => !itemIds.has(entry.itemId))
              )
                throw new Error('Inventory action references a missing item.');
            }
          }
        }
      }
    }
    for (const item of scene.items) {
      if (item.use?.type !== 'equip') continue;
      const gear = assets.get(item.use.assetId),
        fit = gear?.equipment,
        player = scene.nodes.find((node) => node.components.some((component) => component.type === 'player')),
        body = player?.assetId ? assets.get(player.assetId) : undefined;
      if (!fit || !player || !body?.rig || fit.bodyAssetId !== body.id || fit.profile !== body.rig.profile)
        throw new Error(`Equipment item ${item.id} must reference gear fitted to the scene player.`);
    }
  }
  const transitions = new Map<string, Set<string>>(),
    carriedItems = new Map<string, Set<string>>(),
    inventorySlots = new Map(
      p.scenes.map((scene) => {
        const player = scene.nodes.find((node) =>
          node.components.some((component) => component.type === 'player'),
        );
        return [
          scene.id,
          (
            player?.components.find((component) => component.type === 'inventory') as
              Extract<Component, { type: 'inventory' }> | undefined
          )?.slots ?? 24,
        ];
      }),
    );
  for (const scene of p.scenes) {
    const edges = new Set<string>(),
      items = new Set<string>([
        ...scene.recipes.flatMap((recipe) => recipe.outputs.map((output) => output.itemId)),
        ...scene.nodes.flatMap((node) =>
          node.components.flatMap((component) =>
            component.type === 'rules'
              ? component.rules.flatMap((rule) =>
                  rule.actions.flatMap((action) =>
                    action.type === 'inventory' ? action.add.map((entry) => entry.itemId) : [],
                  ),
                )
              : [],
          ),
        ),
        ...scene.nodes.flatMap((node) =>
          node.components.flatMap((component) =>
            component.type === 'construction' ? component.removeYield.map((entry) => entry.itemId) : [],
          ),
        ),
        ...scene.nodes.flatMap((node) =>
          node.components.flatMap((component) =>
            component.type === 'collectible' && component.itemId ? [component.itemId] : [],
          ),
        ),
      ]);
    for (const node of scene.nodes)
      for (const component of node.components)
        if (component.type === 'rules')
          for (const rule of component.rules)
            for (const action of rule.actions) if (action.type === 'transition') edges.add(action.sceneId);
    transitions.set(scene.id, edges);
    carriedItems.set(scene.id, items);
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const source of p.scenes)
      for (const destinationId of transitions.get(source.id)!) {
        const destination = p.scenes.find((scene) => scene.id === destinationId)!;
        if (inventorySlots.get(destinationId)! < inventorySlots.get(source.id)!)
          throw new Error(
            `Scene transition ${source.id} -> ${destinationId} cannot carry inventory to a smaller slot limit.`,
          );
        for (const itemId of carriedItems.get(source.id)!) {
          const sourceItem = source.items.find((item) => item.id === itemId)!,
            destinationItem = destination.items.find((item) => item.id === itemId);
          if (!destinationItem)
            throw new Error(
              `Scene transition ${source.id} -> ${destinationId} cannot carry item ${itemId}; its definition is missing.`,
            );
          if (destinationItem.maxStack !== sourceItem.maxStack)
            throw new Error(
              `Scene transition ${source.id} -> ${destinationId} has incompatible definitions for item ${itemId}.`,
            );
          const destinationItems = carriedItems.get(destinationId)!;
          if (!destinationItems.has(itemId)) {
            destinationItems.add(itemId);
            propagated = true;
          }
        }
      }
  }
  return p;
}
export function newProject(id: string, name: string): ProjectDocument {
  return validateProject({
    format: 'voxshop-project',
    version: 1,
    id,
    name,
    revision: 0,
    units: 'meters',
    upAxis: 'Y',
    assets: [],
    audioClips: [],
    scenes: [{ id: 'main', name: 'Main scene' }],
    activeSceneId: 'main',
    activeAssetId: null,
    editorDraft: null,
  });
}

const terrainPaletteSchema = terrainGeneratorSchema.shape.palette;
const terrainPaletteUpdateSchema = terrainPaletteSchema
  .partial()
  .extend({
    surfaceDepth: terrainPaletteSchema.shape.surfaceDepth.removeDefault().optional(),
    subsurfaceDepth: terrainPaletteSchema.shape.subsurfaceDepth.removeDefault().optional(),
  })
  .refine((palette) => Object.keys(palette).length > 0, 'Terrain palette update cannot be empty.');
const terrainGeneratorUpdateSchema = z
  .object({
    mode: terrainGeneratorSchema.shape.mode,
    origin: terrainGeneratorSchema.shape.origin.optional(),
    size: terrainGeneratorSchema.shape.size.optional(),
    minY: terrainGeneratorSchema.shape.minY.optional(),
    maxY: terrainGeneratorSchema.shape.maxY.optional(),
    baseHeight: terrainGeneratorSchema.shape.baseHeight.optional(),
    amplitude: terrainGeneratorSchema.shape.amplitude.optional(),
    noise: terrainGeneratorSchema.shape.noise.removeDefault().optional(),
    landformScale: terrainGeneratorSchema.shape.landformScale,
    caveDensity: terrainGeneratorSchema.shape.caveDensity,
    caveEntrancesPerRegion: terrainGeneratorSchema.shape.caveEntrancesPerRegion,
    caveDepth: terrainGeneratorSchema.shape.caveDepth,
    caveBranchCount: terrainGeneratorSchema.shape.caveBranchCount,
    caveCrossPassage: terrainGeneratorSchema.shape.caveCrossPassage,
    caveNetwork: terrainGeneratorSchema.shape.caveNetwork,
    caveNetworkReach: terrainGeneratorSchema.shape.caveNetworkReach,
    overhangDensity: terrainGeneratorSchema.shape.overhangDensity,
    overhangMaxHeight: terrainGeneratorSchema.shape.overhangMaxHeight,
    overhangProfile: terrainGeneratorSchema.shape.overhangProfile.nullable(),
    overhangFootprint: terrainGeneratorSchema.shape.overhangFootprint.nullable(),
    overhangHeightMap: terrainGeneratorSchema.shape.overhangHeightMap.nullable(),
    palette: terrainPaletteUpdateSchema.optional(),
    biomeField: terrainGeneratorSchema.shape.biomeField.nullable(),
  })
  .refine((generator) => Object.keys(generator).length > 0, 'Terrain generator update cannot be empty.');

export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project.rename'), name: label }),
  z.object({ type: z.literal('audio.put'), clip: audioClipSchema }),
  z.object({ type: z.literal('audio.delete'), id: idSchema }),
  z.object({ type: z.literal('asset.put'), asset: assetSchema }),
  z
    .object({
      type: z.literal('asset.retarget-animation'),
      sourceAssetId: idSchema,
      sourceClipName: idSchema,
      targetAssetId: idSchema,
      targetClipName: idSchema,
      jointMap: z
        .array(z.object({ sourceJoint: idSchema, targetJoint: idSchema }))
        .min(1)
        .max(128)
        .describe('Explicit one-to-one source-to-target mapping for the animation tracks to copy.'),
    })
    .describe(
      'Copy a clip and its event markers to another rig. Local joint axes must be compatible; unmapped source tracks are skipped, and key position offsets are scaled to preserve meters across asset voxel sizes.',
    ),
  z
    .object({
      type: z.literal('asset.animation-preset'),
      assetId: idSchema,
      preset: z.enum(ANIMATION_PRESETS),
      clipName: idSchema.optional(),
      duration: z.number().finite().min(0.2).max(30).optional(),
      intensity: z.number().finite().min(0).max(2).optional(),
    })
    .describe(
      'Append an editable idle, walk, run, jump, attack, or wave clip to a rig using common joint names and mirrored sides. Tune its keyframes afterward; duplicate preset names receive a numeric suffix.',
    ),
  z.object({ type: z.literal('asset.rename'), id: idSchema, name: label }),
  z.object({ type: z.literal('asset.delete'), id: idSchema }),
  z.object({
    type: z.literal('asset.generate'),
    id: idSchema,
    name: label,
    recipe: recipeSchema,
    voxelSize: z
      .number()
      .positive()
      .min(0.001)
      .max(100)
      .default(0.1)
      .describe('Meters per asset voxel, independent of terrain-cell size and scene-node scale.'),
  }),
  z.object({
    type: z.literal('asset.character'),
    id: idSchema,
    name: label,
    profile: z.enum(['biped', 'quadruped', 'machine']),
    height: z.number().min(12).max(80).default(24),
    width: z.number().min(6).max(30).default(10),
    color: z.number().int().min(0).max(0xffffff).default(0xe78b43),
    accent: z.number().int().min(0).max(0xffffff).default(0xf4d7b6),
    voxelSize: z.number().positive().min(0.001).max(100).default(0.1),
  }),
  z.object({
    type: z.literal('equipment.fit'),
    bodyId: idSchema,
    id: idSchema,
    name: label,
    kind: z.enum(['shell', 'backpack', 'blade']),
    color: z.number().int().min(0).max(0xffffff).default(0x38bdf8),
  }),
  z.object({
    type: z.literal('asset.edit'),
    id: idSchema,
    edit: z
      .object({
        mode: z.enum(['add', 'delete', 'paint', 'lock', 'fill', 'weight']),
        targets: z.array(z.object({ x: finite, y: finite, z: finite })).max(250000),
        color: z.number().int().min(0).max(0xffffff).optional(),
        materialType: z.enum(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE']).optional(),
        weights: z
          .array(z.object({ bone: idSchema, weight: z.number().positive().max(1) }))
          .min(1)
          .max(4)
          .optional()
          .describe('One to four unique rig-joint influences whose weights sum to one.'),
      })
      .superRefine((edit, context) => {
        if (edit.mode !== 'weight' && edit.weights !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['weights'],
            message: 'Weights are only valid for weight edits.',
          });
          return;
        }
        if (edit.mode === 'weight' && !edit.weights) {
          context.addIssue({
            code: 'custom',
            path: ['weights'],
            message: 'Weight edits need joint influences.',
          });
          return;
        }
        if (!edit.weights) return;
        const names = new Set<string>();
        edit.weights.forEach((entry, index) => {
          if (names.has(entry.bone))
            context.addIssue({
              code: 'custom',
              path: ['weights', index, 'bone'],
              message: 'Joint influences must be unique.',
            });
          names.add(entry.bone);
        });
        const total = edit.weights.reduce((sum, entry) => sum + entry.weight, 0);
        if (Math.abs(total - 1) > 0.001)
          context.addIssue({ code: 'custom', path: ['weights'], message: 'Skin weights must sum to one.' });
      }),
  }),
  z.object({ type: z.literal('asset.variant'), sourceId: idSchema, id: idSchema, name: label }),
  z.object({ type: z.literal('scene.put'), scene: sceneSchema }),
  z
    .object({
      type: z.literal('scene.scatter.create'),
      sceneId: idSchema,
      id: idSchema
        .max(58)
        .describe('Stable group ID; generated scene nodes use this as their scatterGroupId.'),
      ...sceneScatterParametersSchema.shape,
    })
    .describe('Bake a deterministic scatter pass into editable, GPU-instanced scene nodes.'),
  z.object({
    type: z.literal('scene.scatter.delete'),
    sceneId: idSchema,
    id: idSchema.max(58).describe('Delete one scatter group and its remaining generated nodes.'),
  }),
  z.object({ type: z.literal('scene.delete'), id: idSchema }),
  z.object({
    type: z.literal('prefab.put'),
    prefab: prefabSchema,
    sourceInstanceRootId: idSchema
      .optional()
      .describe('Use this linked instance as the edited source and clear its overrides.'),
    sourceInstanceNodeIds: z
      .record(idSchema, idSchema)
      .optional()
      .describe('Maps edited prefab source-node IDs to nodes in sourceInstanceRootId.'),
  }),
  z.object({ type: z.literal('prefab.delete'), id: idSchema }),
  z.object({
    type: z.literal('prefab.reset'),
    sceneId: idSchema,
    instanceRootId: idSchema,
    preserveRootPosition: z.boolean().default(true),
  }),
  z
    .object({
      type: z.literal('prefab.instantiate'),
      prefabId: idSchema,
      sceneId: idSchema,
      nodeIds: z
        .array(idSchema)
        .min(1)
        .max(5000)
        .describe('Supply one unique new ID per stored prefab node, in stored order.'),
      rootName: label.optional(),
      position: vectorSchema.optional(),
    })
    .superRefine((operation, context) => {
      if (new Set(operation.nodeIds).size !== operation.nodeIds.length)
        context.addIssue({
          code: 'custom',
          path: ['nodeIds'],
          message: 'Instantiated node IDs must be unique.',
        });
    }),
  z.object({
    type: z.literal('world.create'),
    id: idSchema,
    name: label,
    seed: z.number().int().min(-2147483648).max(2147483647),
    chunkSize: z.number().int().min(1).max(32),
    voxelSize: z.number().positive().min(0.001).max(100),
    generator: worldDocumentSchema.shape.generator,
  }),
  z
    .object({
      type: z.literal('world.update'),
      worldId: idSchema,
      name: label.optional(),
      seed: z.number().int().min(-2147483648).max(2147483647).optional(),
      chunkSize: z.number().int().min(1).max(32).optional(),
      voxelSize: z
        .number()
        .positive()
        .min(0.001)
        .max(100)
        .optional()
        .describe('Meters per terrain cell; independent of asset voxel size and scene-node scale.'),
      generator: terrainGeneratorUpdateSchema.optional(),
    })
    .refine(
      (update) =>
        update.name !== undefined ||
        update.seed !== undefined ||
        update.chunkSize !== undefined ||
        update.voxelSize !== undefined ||
        update.generator !== undefined,
      'World update must include at least one setting.',
    ),
  z.object({
    type: z.literal('world.edit'),
    worldId: idSchema,
    edits: z
      .array(worldEditSchema)
      .min(1)
      .max(10000)
      .superRefine((edits, context) => {
        const cells = new Set<string>();
        for (const edit of edits) {
          const key = `${edit.x},${edit.y},${edit.z}`;
          if (cells.has(key)) {
            context.addIssue({
              code: 'custom',
              message: 'World edit batch contains duplicate cell coordinates.',
            });
            return;
          }
          cells.add(key);
        }
      }),
  }),
  z.object({ type: z.literal('node.put'), sceneId: idSchema, node: nodeSchema }),
  z
    .object({ type: z.literal('node.fit-attachment'), sceneId: idSchema, nodeId: idSchema, slot: idSchema })
    .describe(
      'Uniformly fit a rigged or unrigged asset in its socket-local meter-space rest-pose fitBounds. Its voxel model, rig, weights and current rotation are preserved; only attachment position and scale change.',
    ),
  z.object({ type: z.literal('node.delete'), sceneId: idSchema, id: idSchema }),
  z.object({
    type: z.literal('editor.set'),
    sceneId: idSchema.optional(),
    assetId: idSchema.nullable().optional(),
    draft: modelSchema.nullable().optional(),
  }),
]);
export type ProjectOperation = z.input<typeof operationSchema>;
export const transactionSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .describe('Current project revision required to apply this mutation.'),
    requestId: idSchema.describe('Unique mutation ID; reuse only to retry identical arguments.'),
    label: label.default('Edit project'),
    operations: z.array(operationSchema).min(1).max(256),
  })
  .superRefine((transaction, context) => {
    const worldEdits = transaction.operations.reduce(
      (count, operation) => count + (operation.type === 'world.edit' ? operation.edits.length : 0),
      0,
    );
    if (worldEdits > 10000)
      context.addIssue({
        code: 'custom',
        message: 'A transaction may contain at most 10,000 world cell edits.',
      });
  });

/**
 * Apply an asset-edit-only transaction to a freshly validated store snapshot.
 * Untouched document branches are shared with the previous history snapshot; callers must treat
 * those shared branches as immutable. The store reloads the document for each transaction, so no
 * shared branch survives beyond the save/response boundary.
 */
function applyStoredAssetEdits(
  input: ProjectDocument,
  operations: unknown[],
): { project: ProjectDocument; history: AssetEditHistoryEntry } | null {
  const parsed = operations.map((raw) => operationSchema.parse(raw));
  if (
    !parsed.every(
      (operation) =>
        operation.type === 'asset.edit' &&
        operation.edit.targets.every((position) =>
          [position.x, position.y, position.z].every(Number.isSafeInteger),
        ),
    )
  )
    return null;

  const project: ProjectDocument = { ...input, assets: [...input.assets], revision: input.revision + 1 };
  const edited = new Map<string, (typeof input.assets)[number]>();
  const voxelLookups = new Map<string, Map<string, VoxelData>>();
  const history: AssetEditHistoryEntry = { kind: 'asset-edit', edits: [] };
  for (const raw of parsed) {
    if (raw.type !== 'asset.edit') continue;
    const index = project.assets.findIndex((candidate) => candidate.id === raw.id);
    if (index < 0) throw new Error(`Asset ${raw.id} does not exist.`);
    let target = edited.get(raw.id);
    if (!target) {
      const source = project.assets[index];
      target = { ...source, model: { ...source.model } };
      project.assets[index] = target;
      edited.set(raw.id, target);
      voxelLookups.set(raw.id, new Map(source.model.voxels.map((voxel) => [voxelKey(voxel), voxel])));
    }
    if (raw.edit.mode === 'weight') {
      if (!target.rig) throw new Error('Skin weights can only be assigned to an asset with a rig.');
      const joints = new Set(target.rig.joints.map((joint) => joint.name));
      if (raw.edit.weights?.some((influence) => !joints.has(influence.bone)))
        throw new Error('Skin weights reference a joint missing from the asset rig.');
    }
    const lookup = voxelLookups.get(raw.id)!;
    const delta = createVoxelEditFromLookup((key) => lookup.get(key), raw.edit as VoxelEdit);
    applyVoxelCommandToLookup(lookup, delta);
    history.edits.push({ assetId: raw.id, delta });
  }

  for (const [assetId, target] of edited)
    target.model = { ...target.model, voxels: [...voxelLookups.get(assetId)!.values()] };
  if ([...edited.values()].some((asset) => asset.model.voxels.length > 250000))
    throw new Error('An asset may contain at most 250,000 voxels.');
  if (project.assets.reduce((count, asset) => count + asset.model.voxels.length, 0) > 1000000)
    throw new Error('Project exceeds one million voxels.');
  if (project.activeAssetId && edited.has(project.activeAssetId))
    project.editorDraft = structuredClone(edited.get(project.activeAssetId)!.model);
  return { project, history };
}

/** Transaction: apply to a detached document; validate all references before committing anything. */
export function applyProjectOperations(input: ProjectDocument, operations: unknown[]): ProjectDocument {
  const p = structuredClone(input);
  const asset = (id: string) => {
    const a = p.assets.find((a) => a.id === id);
    if (!a) throw new Error(`Asset ${id} does not exist.`);
    return a;
  };
  const scene = (id: string) => {
    const s = p.scenes.find((s) => s.id === id);
    if (!s) throw new Error(`Scene ${id} does not exist.`);
    return s;
  };
  const world = (id: string) => {
    const w = p.worlds.find((w) => w.id === id);
    if (!w) throw new Error(`World ${id} does not exist.`);
    return w;
  };
  for (const raw of operations) {
    const op = operationSchema.parse(raw);
    switch (op.type) {
      case 'project.rename':
        p.name = op.name;
        break;
      case 'audio.put': {
        const index = p.audioClips.findIndex((clip) => clip.id === op.clip.id);
        if (index < 0) p.audioClips.push(op.clip);
        else p.audioClips[index] = op.clip;
        break;
      }
      case 'audio.delete':
        if (!p.audioClips.some((clip) => clip.id === op.id)) throw new Error('Audio clip does not exist.');
        p.audioClips = p.audioClips.filter((clip) => clip.id !== op.id);
        break;
      case 'asset.put': {
        const i = p.assets.findIndex((a) => a.id === op.asset.id);
        if (i < 0) p.assets.push(op.asset);
        else p.assets[i] = op.asset;
        if (p.activeAssetId === op.asset.id) p.editorDraft = structuredClone(op.asset.model);
        break;
      }
      case 'asset.retarget-animation': {
        const source = asset(op.sourceAssetId);
        const target = asset(op.targetAssetId);
        if (!source.rig || !target.rig) throw new Error('Source and target assets both need rigs.');
        target.rig = retargetRigClip(
          source.rig,
          op.sourceClipName,
          target.rig,
          op.targetClipName,
          op.jointMap,
          source.voxelSize,
          target.voxelSize,
        );
        break;
      }
      case 'asset.animation-preset': {
        const target = asset(op.assetId);
        if (!target.rig) throw new Error('Animation presets require an asset rig.');
        target.rig = addAnimationPreset(target.rig, op.preset, {
          ...(op.clipName && { name: op.clipName }),
          ...(op.duration !== undefined && { duration: op.duration }),
          ...(op.intensity !== undefined && { intensity: op.intensity }),
        });
        break;
      }
      case 'asset.rename':
        asset(op.id).name = op.name;
        break;
      case 'asset.delete':
        asset(op.id);
        p.assets = p.assets.filter((a) => a.id !== op.id);
        if (p.activeAssetId === op.id) {
          p.activeAssetId = null;
          p.editorDraft = null;
        }
        break;
      case 'asset.generate':
        if (p.assets.some((a) => a.id === op.id))
          throw new Error('Generate uses a new ID; create a variant to preserve edits.');
        p.assets.push(
          assetSchema.parse({
            id: op.id,
            name: op.name,
            model: createModelDocument(generateRecipe(op.recipe)),
            voxelSize: op.voxelSize,
            recipe: op.recipe,
            source: { kind: 'generated', description: 'VoxShop recipe v1', seed: op.recipe.seed },
          }),
        );
        break;
      case 'asset.character':
        if (p.assets.some((a) => a.id === op.id)) throw new Error('Asset ID already exists.');
        p.assets.push(assetSchema.parse(generateCharacter(op)));
        break;
      case 'equipment.fit':
        if (p.assets.some((a) => a.id === op.id)) throw new Error('Equipment ID already exists.');
        p.assets.push(assetSchema.parse(fitEquipment(asset(op.bodyId), op)));
        break;
      case 'asset.edit': {
        const a = asset(op.id);
        if (op.edit.mode === 'weight') {
          if (!a.rig) throw new Error('Skin weights can only be assigned to an asset with a rig.');
          const joints = new Set(a.rig.joints.map((joint) => joint.name));
          if (op.edit.weights?.some((influence) => !joints.has(influence.bone)))
            throw new Error('Skin weights reference a joint missing from the asset rig.');
        }
        a.model.voxels = applyVoxelCommand(
          a.model.voxels,
          createVoxelEdit(a.model.voxels, op.edit as VoxelEdit),
        );
        if (p.activeAssetId === op.id) p.editorDraft = structuredClone(a.model);
        break;
      }
      case 'asset.variant':
        if (p.assets.some((a) => a.id === op.id)) throw new Error('Variant ID already exists.');
        p.assets.push({
          ...structuredClone(asset(op.sourceId)),
          id: op.id,
          name: op.name,
          variantOf: op.sourceId,
        });
        break;
      case 'scene.put': {
        const i = p.scenes.findIndex((s) => s.id === op.scene.id);
        if (i < 0) p.scenes.push(op.scene);
        else p.scenes[i] = op.scene;
        break;
      }
      case 'scene.scatter.create': {
        const target = scene(op.sceneId);
        const scatter = sceneScatterSchema.parse({
          id: op.id,
          assetId: op.assetId,
          seed: op.seed,
          count: op.count,
          bounds: op.bounds,
          snapToTerrain: op.snapToTerrain,
          groundY: op.groundY,
          scaleRange: op.scaleRange,
          randomYaw: op.randomYaw,
        });
        target.scatterGroups ??= [];
        if (target.scatterGroups.some((group) => group.id === scatter.id))
          throw new Error(`Scatter group ${scatter.id} already exists.`);
        if (target.nodes.length + scatter.count > 5000)
          throw new Error('Scene scatter would exceed the 5,000-node scene limit.');
        const scatterAsset = asset(scatter.assetId);
        const scatterWorld = target.worldId
          ? p.worlds.find((candidate) => candidate.id === target.worldId)
          : undefined;
        const generatedNodes = createScatterNodes(target, scatter, scatterAsset, scatterWorld);
        target.scatterGroups.push(scatter);
        target.nodes.push(...generatedNodes);
        break;
      }
      case 'scene.scatter.delete': {
        const target = scene(op.sceneId);
        target.scatterGroups ??= [];
        if (!target.scatterGroups.some((group) => group.id === op.id))
          throw new Error(`Scatter group ${op.id} does not exist.`);
        target.scatterGroups = target.scatterGroups.filter((group) => group.id !== op.id);
        const removed = new Set(
          target.nodes.filter((node) => node.scatterGroupId === op.id).map((node) => node.id),
        );
        let previousSize = -1;
        while (removed.size !== previousSize) {
          previousSize = removed.size;
          for (const node of target.nodes)
            if (node.parentId && removed.has(node.parentId)) removed.add(node.id);
        }
        target.nodes = target.nodes.filter((node) => !removed.has(node.id));
        break;
      }
      case 'scene.delete':
        scene(op.id);
        p.scenes = p.scenes.filter((s) => s.id !== op.id);
        if (p.activeSceneId === op.id) p.activeSceneId = p.scenes[0]?.id;
        break;
      case 'prefab.put': {
        const parsed = prefabSchema.parse(op.prefab);
        const index = p.prefabs.findIndex((prefab) => prefab.id === op.prefab.id);
        const previous = index < 0 ? undefined : p.prefabs[index];
        if (previous)
          syncLinkedPrefabInstances(p.scenes, previous, parsed, {
            sourceInstanceRootId: op.sourceInstanceRootId,
            sourceInstanceNodeIds: op.sourceInstanceNodeIds,
          });
        else if (op.sourceInstanceRootId)
          throw new Error('A new prefab cannot use a linked source instance.');
        if (index < 0) p.prefabs.push(parsed);
        else p.prefabs[index] = parsed;
        break;
      }
      case 'prefab.delete': {
        if (!p.prefabs.some((prefab) => prefab.id === op.id)) throw new Error('Prefab does not exist.');
        p.prefabs = p.prefabs.filter((prefab) => prefab.id !== op.id);
        for (const target of p.scenes)
          for (const node of target.nodes) if (node.prefabLink?.prefabId === op.id) delete node.prefabLink;
        break;
      }
      case 'prefab.reset': {
        const target = scene(op.sceneId);
        const root = target.nodes.find((node) => node.id === op.instanceRootId);
        if (!root?.prefabLink || root.prefabLink.instanceId !== root.id)
          throw new Error('Linked prefab instance root does not exist.');
        const prefab = p.prefabs.find((candidate) => candidate.id === root.prefabLink!.prefabId);
        if (!prefab) throw new Error('Linked prefab source does not exist.');
        syncLinkedPrefabInstances([target], prefab, prefab, {
          resetInstanceRootId: root.id,
          preserveRootPosition: op.preserveRootPosition,
        });
        break;
      }
      case 'prefab.instantiate': {
        const prefab = p.prefabs.find((candidate) => candidate.id === op.prefabId);
        if (!prefab) throw new Error(`Prefab ${op.prefabId} does not exist.`);
        const target = scene(op.sceneId);
        const existing = new Set(target.nodes.map((node) => node.id));
        if (op.nodeIds.some((id) => existing.has(id)))
          throw new Error('Instantiated node ID already exists in the scene.');
        const nodes = instantiatePrefabNodes(prefab, op.nodeIds, {
          rootName: op.rootName,
          position: op.position,
        });
        const sourceIndex = new Map(prefab.nodes.map((source, index) => [op.nodeIds[index]!, source.id]));
        const rootInstanceId = op.nodeIds[prefab.nodes.findIndex((source) => source.id === prefab.rootId)]!;
        for (const node of nodes)
          node.prefabLink = {
            prefabId: prefab.id,
            instanceId: rootInstanceId,
            sourceNodeId: sourceIndex.get(node.id)!,
          };
        target.nodes.push(...nodes);
        break;
      }
      case 'world.create':
        if (p.worlds.some((w) => w.id === op.id)) throw new Error('World ID already exists.');
        p.worlds.push(worldDocumentSchema.parse({ ...op, edits: [] }));
        break;
      case 'world.update': {
        const current = world(op.worldId);
        const updated = worldDocumentSchema.parse({
          ...current,
          name: op.name ?? current.name,
          seed: op.seed ?? current.seed,
          chunkSize: op.chunkSize ?? current.chunkSize,
          voxelSize: op.voxelSize ?? current.voxelSize,
          generator: op.generator
            ? (() => {
                const {
                  biomeField,
                  overhangProfile,
                  overhangFootprint,
                  overhangHeightMap,
                  ...generatorUpdate
                } = op.generator!;
                const merged = {
                  ...current.generator,
                  ...generatorUpdate,
                  palette: { ...current.generator.palette, ...generatorUpdate.palette },
                };
                if (biomeField === null) delete merged.biomeField;
                else if (biomeField) merged.biomeField = biomeField;
                if (overhangProfile === null) delete merged.overhangProfile;
                else if (overhangProfile) merged.overhangProfile = overhangProfile;
                if (overhangFootprint === null) delete merged.overhangFootprint;
                else if (overhangFootprint) merged.overhangFootprint = overhangFootprint;
                if (overhangHeightMap === null) delete merged.overhangHeightMap;
                else if (overhangHeightMap) merged.overhangHeightMap = overhangHeightMap;
                return merged;
              })()
            : current.generator,
        });
        p.worlds[p.worlds.indexOf(current)] = updated;
        break;
      }
      case 'world.edit': {
        const w = world(op.worldId);
        const edits = new Map(w.edits.map((e) => [`${e.x},${e.y},${e.z}`, e]));
        for (const edit of op.edits) edits.set(`${edit.x},${edit.y},${edit.z}`, edit);
        w.edits = [...edits.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
        break;
      }
      case 'node.put': {
        const s = scene(op.sceneId);
        const i = s.nodes.findIndex((n) => n.id === op.node.id);
        if (i < 0) s.nodes.push(op.node);
        else s.nodes[i] = op.node;
        break;
      }
      case 'node.fit-attachment': {
        const s = scene(op.sceneId),
          node = s.nodes.find((entry) => entry.id === op.nodeId);
        if (!node) throw new Error('Node does not exist.');
        if (!node.assetId) throw new Error('Equipment fitting needs a rigged body asset.');
        const body = asset(node.assetId),
          attachment = node.attachments.find((entry) => entry.slot === op.slot);
        if (!body.rig) throw new Error('Equipment fitting needs a rigged body asset.');
        if (!attachment) throw new Error(`Attachment slot ${op.slot} does not exist.`);
        const socket = body.rig.sockets.find((entry) => entry.name === attachment.socket);
        if (!socket) throw new Error(`Socket ${attachment.socket} does not exist on the body rig.`);
        if (!socket.fitBounds) throw new Error(`Socket ${socket.name} has no equipment fit bounds.`);
        const fit = fitAssetToBounds(
          asset(attachment.assetId),
          socket.fitBounds,
          attachment.transform.rotation,
        );
        attachment.transform = { ...attachment.transform, ...fit };
        break;
      }
      case 'node.delete': {
        const s = scene(op.sceneId);
        if (!s.nodes.some((n) => n.id === op.id)) throw new Error('Node does not exist.');
        const removed = new Set([op.id]);
        let size = 0;
        while (removed.size !== size) {
          size = removed.size;
          for (const n of s.nodes) if (n.parentId && removed.has(n.parentId)) removed.add(n.id);
        }
        const deletedLinks = s.nodes
          .filter((node) => removed.has(node.id) && node.prefabLink)
          .map((node) => node.prefabLink!);
        for (const instanceId of new Set(deletedLinks.map((link) => link.instanceId))) {
          if (removed.has(instanceId)) continue;
          const root = s.nodes.find((node) => node.id === instanceId);
          if (!root?.prefabLink) continue;
          const deletedSourceIds = deletedLinks
            .filter((link) => link.instanceId === instanceId)
            .map((link) => link.sourceNodeId);
          root.prefabLink.removedSourceIds = [
            ...new Set([...(root.prefabLink.removedSourceIds ?? []), ...deletedSourceIds]),
          ];
        }
        s.nodes = s.nodes.filter((n) => !removed.has(n.id));
        break;
      }
      case 'editor.set':
        if (op.sceneId !== undefined) p.activeSceneId = op.sceneId;
        if (op.assetId !== undefined) p.activeAssetId = op.assetId;
        if (op.draft !== undefined) p.editorDraft = op.draft;
        break;
    }
  }
  p.revision++;
  return validateProject(p);
}

/** Use compact reversible voxel deltas only for isolated, canonical asset edits in the project store. */
export function applyProjectOperationsForStore(
  input: ProjectDocument,
  operations: unknown[],
): { project: ProjectDocument; history: ProjectHistoryEntry } {
  if (
    operations.length > 0 &&
    operations.every(
      (raw) =>
        raw !== null &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        (raw as { type?: unknown }).type === 'asset.edit',
    )
  ) {
    const assetEdits = applyStoredAssetEdits(input, operations);
    if (assetEdits) return assetEdits;
  }
  return { project: applyProjectOperations(input, operations), history: input };
}

export function applyProjectAssetEditHistory(
  input: ProjectDocument,
  history: AssetEditHistoryEntry,
  undo: boolean,
): ProjectDocument {
  const project: ProjectDocument = { ...input, assets: [...input.assets], revision: input.revision + 1 };
  const edited = new Map<string, (typeof input.assets)[number]>();
  const voxelLookups = new Map<string, Map<string, VoxelData>>();
  const changes = undo ? [...history.edits].reverse() : history.edits;
  for (const change of changes) {
    const index = project.assets.findIndex((candidate) => candidate.id === change.assetId);
    if (index < 0) throw new Error(`Asset ${change.assetId} does not exist.`);
    let target = edited.get(change.assetId);
    if (!target) {
      const source = project.assets[index];
      target = { ...source, model: { ...source.model } };
      project.assets[index] = target;
      edited.set(change.assetId, target);
      voxelLookups.set(change.assetId, new Map(source.model.voxels.map((voxel) => [voxelKey(voxel), voxel])));
    }
    applyVoxelCommandToLookup(voxelLookups.get(change.assetId)!, change.delta, undo);
  }
  for (const [assetId, target] of edited)
    target.model = { ...target.model, voxels: [...voxelLookups.get(assetId)!.values()] };
  if ([...edited.values()].some((asset) => asset.model.voxels.length > 250000))
    throw new Error('An asset may contain at most 250,000 voxels.');
  if (project.assets.reduce((count, asset) => count + asset.model.voxels.length, 0) > 1000000)
    throw new Error('Project exceeds one million voxels.');
  if (project.activeAssetId && edited.has(project.activeAssetId))
    project.editorDraft = structuredClone(edited.get(project.activeAssetId)!.model);
  return project;
}

export function projectSummary(p: ProjectDocument) {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    activeSceneId: p.activeSceneId,
    activeAssetId: p.activeAssetId,
    audioClips: p.audioClips.map(({ id, name, mimeType, ...clip }) => ({
      id,
      name,
      mimeType,
      sizeBytes: audioClipBytes({ id, name, mimeType, ...clip }),
    })),
    assets: p.assets.map((a) => ({
      id: a.id,
      name: a.name,
      voxels: a.model.voxels.length,
      voxelSize: a.voxelSize,
      rig: a.rig?.profile ?? null,
    })),
    prefabs: p.prefabs.map((prefab) => ({ id: prefab.id, name: prefab.name, nodes: prefab.nodes.length })),
    worlds: p.worlds.map((w) => ({
      id: w.id,
      name: w.name,
      chunkSize: w.chunkSize,
      voxelSize: w.voxelSize,
      edits: w.edits.length,
    })),
    scenes: p.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      nodes: s.nodes.length,
      scatterGroups: s.scatterGroups?.length ?? 0,
    })),
  };
}

/** Project detail for authoring tools, with large voxel arrays available separately through asset inspection. */
export function projectAuthoringView(p: ProjectDocument) {
  const { assets, audioClips, editorDraft, ...document } = p;
  return {
    ...document,
    audioClips: audioClips.map(({ id, name, mimeType, ...clip }) => ({
      id,
      name,
      mimeType,
      sizeBytes: audioClipBytes({ id, name, mimeType, ...clip }),
    })),
    assets: assets.map(({ model, ...asset }) => ({
      ...asset,
      modelSummary: { voxelCount: model.voxels.length },
    })),
    editorDraftSummary: editorDraft ? { voxelCount: editorDraft.voxels.length } : null,
  };
}

/** Inspect one asset without returning its full voxel array. MCP adapters share this projection and paging contract. */
export function assetInspectionView(
  project: ProjectDocument,
  assetId: string,
  offset: number,
  limit: number,
) {
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error('Asset not found.');

  const { model, ...metadata } = asset;
  const bounds = model.voxels.reduce(
    (result, voxel) => ({
      min: result.min.map((value, axis) => Math.min(value, voxel[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z'])),
      max: result.max.map((value, axis) => Math.max(value, voxel[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z'])),
    }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  );

  return {
    ...metadata,
    revision: project.revision,
    count: model.voxels.length,
    bounds: model.voxels.length ? bounds : null,
    skeleton: model.skeleton,
    voxels: model.voxels.slice(offset, offset + limit),
    nextOffset: limit && offset + limit < model.voxels.length ? offset + limit : null,
  };
}
