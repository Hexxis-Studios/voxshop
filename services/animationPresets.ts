import type { Rig } from './projectDocument';

export const ANIMATION_PRESETS = ['idle', 'walk', 'run', 'jump', 'attack', 'wave'] as const;
export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

type MotionPresetOptions = { name?: string; duration?: number; intensity?: number };
type JointRole =
  'body' | 'head' | 'arm' | 'forearm' | 'hand' | 'leg' | 'lower-leg' | 'foot' | 'tail' | 'other';

function normalizedName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function side(name: string, x: number): -1 | 0 | 1 {
  const normalized = normalizedName(name);
  if (normalized.includes('left')) return 1;
  if (normalized.includes('right')) return -1;
  if (
    /^l(?:upper|lower|fore)?(?:arm|leg|hand|foot|hip)/.test(normalized) ||
    /(?:upper|lower|fore)?(?:arm|leg|hand|foot|hip)l$/.test(normalized)
  )
    return 1;
  if (
    /^r(?:upper|lower|fore)?(?:arm|leg|hand|foot|hip)/.test(normalized) ||
    /(?:upper|lower|fore)?(?:arm|leg|hand|foot|hip)r$/.test(normalized)
  )
    return -1;
  return x < -0.05 ? -1 : x > 0.05 ? 1 : 0;
}

function role(name: string): JointRole {
  const normalized = normalizedName(name);
  if (/head|skull|neck/.test(normalized)) return 'head';
  if (/tail|caudal/.test(normalized)) return 'tail';
  if (/root|pelvis|spine|torso|chest|body/.test(normalized) || /hips$/.test(normalized)) return 'body';
  if (/forearm|lowerarm|elbow/.test(normalized)) return 'forearm';
  if (/hand|wrist|finger|thumb/.test(normalized)) return 'hand';
  if (/arm|shoulder/.test(normalized)) return 'arm';
  if (/toe|foot|ankle/.test(normalized)) return 'foot';
  if (/calf|shin|knee|lowerleg/.test(normalized)) return 'lower-leg';
  if (/hip/.test(normalized)) return side(name, 0) === 0 ? 'body' : 'leg';
  if (/leg|thigh/.test(normalized)) return 'leg';
  return 'other';
}

function boundedIntensity(value: number | undefined) {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value < 0 || value > 2)
    throw new Error('Motion intensity must be between 0 and 2.');
  return value;
}

function clipName(rig: Rig, requested: string, automatic: boolean) {
  let name = requested.trim();
  if (automatic) {
    const base = name.slice(0, 58);
    for (let suffix = 2; rig.clips.some((clip) => clip.name.toLowerCase() === name.toLowerCase()); suffix++)
      name = `${base}-${suffix}`;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new Error('Motion clip names must be valid IDs of at most 64 characters.');
  if (rig.clips.some((clip) => clip.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`Animation clip ${name} already exists.`);
  if (rig.clips.length >= 64) throw new Error('A rig can contain at most 64 animation clips.');
  return name;
}

const presetDuration: Record<AnimationPreset, number> = {
  idle: 2.4,
  walk: 0.9,
  run: 0.62,
  jump: 0.9,
  attack: 0.65,
  wave: 1.5,
};

/** Add an editable, bounded starter motion using common bone names and mirrored X-side positions. */
export function addAnimationPreset(
  rig: Rig,
  preset: AnimationPreset,
  options: MotionPresetOptions = {},
): Rig {
  const duration = options.duration ?? presetDuration[preset];
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 30)
    throw new Error('Motion duration must be between 0.2 and 30 seconds.');
  const intensity = boundedIntensity(options.intensity);
  const isQuadruped = rig.profile === 'quadruped';
  const defaultName = isQuadruped && preset === 'wave' ? 'tail-wag' : preset;
  const name = clipName(rig, options.name ?? defaultName, options.name === undefined);
  const joints = rig.joints.map((joint) => ({
    ...joint,
    role: role(joint.name),
    side: side(joint.name, joint.position[0]),
    gaitSide:
      rig.profile === 'quadruped' && /(?:back|rear)/.test(normalizedName(joint.name))
        ? -side(joint.name, joint.position[0])
        : side(joint.name, joint.position[0]),
  }));
  const rootMotionJoint =
    joints.find((joint) => /(?:hips?|pelvis)$/.test(normalizedName(joint.name)) && joint.role === 'body') ??
    joints.find((joint) => /(?:root|armature)$/.test(normalizedName(joint.name)) && joint.role === 'body') ??
    joints.find((joint) => joint.role === 'body');
  const rigHeight = Math.max(
    1,
    Math.max(...joints.map((joint) => joint.position[1])) -
      Math.min(...joints.map((joint) => joint.position[1])),
  );
  const rigDepth = Math.max(
    1,
    Math.max(...joints.map((joint) => joint.position[2])) -
      Math.min(...joints.map((joint) => joint.position[2])),
  );
  // The wave oscillates several times per clip. Seven evenly spaced keys land
  // directly on every zero crossing, producing a stationary wrist/tail.
  const sampleCount =
    preset === 'wave' ? 19 : preset === 'idle' || preset === 'walk' || preset === 'run' ? 17 : 7;
  const times = Array.from({ length: sampleCount }, (_, index) => (duration * index) / (sampleCount - 1));
  const tracks = joints.flatMap((joint) => {
    const { role: jointRole, side: jointSide } = joint;
    const gaitSide = joint.gaitSide;
    const belongsToPreset =
      (preset === 'idle' &&
        jointRole !== 'other' &&
        jointRole !== 'hand' &&
        (jointRole !== 'tail' || isQuadruped)) ||
      ((preset === 'walk' || preset === 'run') &&
        (['body', 'head', 'arm', 'forearm', 'leg', 'lower-leg', 'foot'].includes(jointRole) ||
          (isQuadruped && jointRole === 'tail'))) ||
      (preset === 'jump' &&
        (['body', 'arm', 'forearm', 'leg', 'lower-leg', 'foot'].includes(jointRole) ||
          (isQuadruped && jointRole === 'tail'))) ||
      (preset === 'attack' &&
        (isQuadruped
          ? ['body', 'head', 'leg', 'lower-leg', 'foot', 'tail'].includes(jointRole)
          : ['body', 'arm', 'forearm'].includes(jointRole))) ||
      (preset === 'wave' &&
        (isQuadruped
          ? jointRole === 'tail'
          : ['arm', 'forearm', 'hand', 'head', 'body'].includes(jointRole)));
    if (!belongsToPreset) return [];

    const keys = times.map((time, index) => {
      const phase = index / (sampleCount - 1);
      const cycle = phase * Math.PI * 2;
      const wave = Math.sin(cycle);
      const mirroredSide = jointSide === 0 ? 1 : jointSide;
      const gaitDirection = gaitSide === 0 ? 1 : gaitSide;
      let rotation: [number, number, number] = [0, 0, 0];
      let position: [number, number, number] | undefined;
      const rootMotion = joint.name === rootMotionJoint?.name;

      if (preset === 'idle') {
        if (jointRole === 'body') {
          if (rootMotion) position = [0, Math.sin(cycle) * rigHeight * 0.0025 * intensity, 0];
          rotation[0] = wave * 0.028 * intensity * (rootMotion ? 0.5 : 1);
        }
        if (jointRole === 'head') {
          rotation[0] = -wave * 0.035 * intensity;
          rotation[1] = Math.sin(cycle * 0.5) * 0.025 * intensity;
        }
        if (jointRole === 'arm') rotation[2] = mirroredSide * (0.04 + wave * 0.025) * intensity;
        if (jointRole === 'tail') {
          rotation[1] = Math.sin(cycle * 0.5) * 0.075 * intensity;
          rotation[2] = Math.cos(cycle * 0.5) * 0.035 * intensity;
        }
      } else if (preset === 'walk' || preset === 'run') {
        const amplitude = (preset === 'run' ? 0.95 : 0.56) * intensity;
        if (jointRole === 'leg' || jointRole === 'lower-leg') {
          rotation[0] = wave * amplitude * gaitDirection * (jointRole === 'lower-leg' ? 0.55 : 1);
          if (jointRole === 'lower-leg')
            rotation[0] = Math.max(0, wave * gaitDirection) * (preset === 'run' ? 0.58 : 0.42) * intensity;
        }
        if (jointRole === 'foot') rotation[0] = -wave * amplitude * gaitDirection * 0.28;
        if (jointRole === 'arm') rotation[0] = -wave * amplitude * mirroredSide * 0.62;
        if (jointRole === 'forearm')
          rotation[0] = 0.12 * intensity + Math.max(0, -wave * mirroredSide) * 0.26 * intensity;
        if (jointRole === 'body') {
          if (rootMotion)
            position = [
              0,
              Math.abs(Math.sin(cycle)) * rigHeight * (preset === 'run' ? 0.018 : 0.008) * intensity,
              0,
            ];
          rotation[0] = (preset === 'run' ? -0.12 : -0.035) * intensity * (rootMotion ? 0.55 : 0.25);
          rotation[1] = wave * (preset === 'run' ? 0.035 : 0.02) * intensity;
          rotation[2] = Math.cos(cycle) * (preset === 'run' ? 0.025 : 0.015) * intensity * mirroredSide;
        }
        if (jointRole === 'head') {
          rotation[0] = Math.sin(cycle * 2) * 0.018 * intensity;
          rotation[1] = -wave * 0.018 * intensity;
        }
        if (jointRole === 'tail') rotation[1] = -wave * (preset === 'run' ? 0.17 : 0.09) * intensity;
      } else if (preset === 'jump') {
        const pose = phase;
        const ease = (value: number) => value * value * (3 - 2 * value);
        const lift =
          pose < 0.2
            ? -0.04 * ease(pose / 0.2)
            : pose < 0.7
              ? -0.04 + 0.2 * ease((pose - 0.2) / 0.5)
              : pose < 0.84
                ? 0.16 - 0.2 * ease((pose - 0.7) / 0.14)
                : -0.04 + 0.04 * ease((pose - 0.84) / 0.16);
        if (jointRole === 'leg')
          rotation[0] = (pose < 0.25 ? 0.28 : pose < 0.75 ? -0.12 : 0) * gaitDirection * intensity;
        if (jointRole === 'lower-leg')
          rotation[0] = (pose < 0.25 ? -0.42 : pose < 0.75 ? 0.08 : 0) * intensity;
        if (jointRole === 'foot') rotation[0] = pose < 0.2 ? 0.08 * intensity : 0;
        if (jointRole === 'arm' || jointRole === 'forearm')
          rotation[2] = mirroredSide * (pose < 0.2 ? 0.12 : pose < 0.78 ? -0.9 : 0) * intensity;
        if (jointRole === 'body') {
          if (rootMotion) position = [0, lift * rigHeight * intensity, 0];
          rotation[0] =
            (pose < 0.2 ? 0.16 : pose < 0.78 ? -0.08 : 0) * intensity * (rootMotion ? 0.55 : 0.25);
        }
      } else if (preset === 'attack') {
        const pose = phase;
        const weaponSide = jointSide === 0 ? 1 : jointSide;
        if (isQuadruped && jointRole === 'head') {
          rotation[0] = pose < 0.25 ? 0.12 * intensity : pose < 0.62 ? -0.48 * intensity : 0;
        } else if (isQuadruped && jointRole === 'leg') {
          const normalized = normalizedName(joint.name);
          const front = normalized.includes('front');
          rotation[0] =
            pose < 0.25
              ? (front ? -0.12 : 0.1) * intensity
              : pose < 0.62
                ? (front ? 0.38 : -0.22) * intensity
                : 0;
        } else if (isQuadruped && jointRole === 'lower-leg') {
          const front = normalizedName(joint.name).includes('front');
          rotation[0] =
            pose < 0.25
              ? (front ? 0.18 : -0.08) * intensity
              : pose < 0.62
                ? (front ? -0.28 : 0.14) * intensity
                : 0;
        } else if (isQuadruped && jointRole === 'foot') {
          rotation[0] = pose < 0.62 ? (jointSide >= 0 ? 0.1 : -0.1) * intensity : 0;
        } else if (isQuadruped && jointRole === 'tail') {
          rotation[1] = (pose < 0.25 ? -0.18 : pose < 0.62 ? 0.3 : 0) * intensity;
        } else if (jointRole === 'arm') {
          const strikingArm = jointSide <= 0;
          rotation[0] = strikingArm
            ? (pose < 0.3 ? -0.55 : pose < 0.62 ? 0.95 : -0.05) * intensity
            : (pose < 0.3 ? 0.08 : pose < 0.62 ? -0.14 : 0) * intensity;
          rotation[2] = weaponSide * (pose < 0.3 ? -0.18 : pose < 0.62 ? 0.12 : -0.04) * intensity;
        }
        if (jointRole === 'forearm') {
          const strikingArm = jointSide <= 0;
          rotation[0] = strikingArm
            ? (pose < 0.3 ? -0.65 : pose < 0.62 ? 0.32 : 0) * intensity
            : (pose < 0.3 ? 0.12 : pose < 0.62 ? -0.08 : 0) * intensity;
        }
        if (jointRole === 'body') {
          if (rootMotion && isQuadruped)
            position = [
              0,
              pose < 0.25 ? -rigHeight * 0.015 * intensity : pose < 0.62 ? rigHeight * 0.008 * intensity : 0,
              pose < 0.25 ? rigDepth * 0.006 * intensity : pose < 0.62 ? -rigDepth * 0.045 * intensity : 0,
            ];
          else if (rootMotion)
            position = [0, 0, pose < 0.3 ? 0 : pose < 0.62 ? -rigHeight * 0.035 * intensity : 0];
          rotation[1] =
            (pose < 0.3 ? -0.12 : pose < 0.62 ? 0.28 : 0) * intensity * (rootMotion ? 0.55 : 0.25);
        }
      } else if (preset === 'wave') {
        if (isQuadruped && jointRole === 'tail') {
          rotation[1] = Math.sin(phase * Math.PI * 4) * 0.35 * intensity;
          rotation[2] = Math.sin(phase * Math.PI * 2) * 0.12 * intensity;
        }
        const selectedArm = jointSide >= 0;
        if (
          !isQuadruped &&
          (jointRole === 'arm' || jointRole === 'forearm' || jointRole === 'hand') &&
          selectedArm
        ) {
          rotation[2] =
            mirroredSide * (jointRole === 'arm' ? -1.25 : jointRole === 'forearm' ? -0.55 : 0) * intensity;
          if (jointRole === 'forearm') rotation[0] = Math.sin(phase * Math.PI * 6) * 0.28 * intensity;
          if (jointRole === 'hand') rotation[0] = Math.sin(phase * Math.PI * 6) * 0.48 * intensity;
        }
        if (!isQuadruped && jointRole === 'head') rotation[1] = Math.sin(cycle) * 0.06 * intensity;
        if (!isQuadruped && jointRole === 'body')
          rotation[1] = Math.sin(cycle) * 0.025 * intensity * (rootMotion ? 0.55 : 0.25);
      }
      const finalKey = index === sampleCount - 1;
      if ((preset === 'walk' || preset === 'run' || preset === 'idle') && finalKey) {
        rotation = [0, 0, 0];
        position = jointRole === 'body' && joint.name === rootMotionJoint?.name ? [0, 0, 0] : undefined;
      }
      rotation = rotation.map((value) => (Object.is(value, -0) ? 0 : value)) as [number, number, number];
      if (position)
        position = position.map((value) => (Object.is(value, -0) ? 0 : value)) as [number, number, number];
      return {
        time,
        rotation,
        ...(position && { position }),
        interpolation:
          preset === 'walk' || preset === 'run' || preset === 'idle'
            ? ('linear' as const)
            : ('smooth' as const),
      };
    });
    return [{ joint: joint.name, keys }];
  });

  if (!tracks.length && preset === 'idle') {
    const root = joints[0];
    if (root)
      tracks.push({
        joint: root.name,
        keys: times.map((time, index) => ({
          time,
          rotation: [0, 0, 0] as [number, number, number],
          position: [
            0,
            Math.sin((index / (sampleCount - 1)) * Math.PI * 2) * rigHeight * 0.0025 * intensity,
            0,
          ] as [number, number, number],
          interpolation: 'linear' as const,
        })),
      });
  }
  if (!tracks.length)
    throw new Error(`The ${preset} preset could not identify compatible joints in this rig.`);

  const loop = preset === 'idle' || preset === 'walk' || preset === 'run';
  return {
    ...structuredClone(rig),
    clips: [
      ...structuredClone(rig.clips),
      {
        name,
        duration,
        loop,
        speed: preset === 'walk' ? 3 : preset === 'run' ? 6 : 0,
        blendIn: 0.12,
        tracks,
        events:
          preset === 'walk' || preset === 'run'
            ? [
                { time: duration * 0.25, name: 'footstep' },
                { time: duration * 0.75, name: 'footstep' },
              ]
            : preset === 'attack'
              ? [{ time: duration * 0.56, name: 'impact' }]
              : [],
      },
    ],
  };
}
