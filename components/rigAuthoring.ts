import { Euler, Quaternion } from 'three';
import {
  idSchema,
  identityTransform,
  rigSchema,
  type Asset,
  type ProjectDocument,
  type Rig,
  vectorSchema,
} from '../services/projectDocument';

type RigClip = Rig['clips'][number];
type RigTrack = RigClip['tracks'][number];
type RigKey = RigTrack['keys'][number];
type RigMarker = RigClip['events'][number];

function nextName(prefix: string, usedNames: readonly string[]) {
  const used = new Set(usedNames);
  for (let index = 1; ; index++) {
    const name = index === 1 ? prefix : `${prefix}-${index}`;
    if (!used.has(name)) return name;
  }
}

export function createCustomRig(): Rig {
  return rigSchema.parse({
    profile: 'custom',
    version: 1,
    joints: [{ name: 'root', parent: null, position: [0, 0, 0] }],
  });
}

export function addRigJoint(rig: Rig): Rig {
  if (rig.joints.length >= 128) throw new Error('A rig can contain at most 128 joints.');
  const parent = rig.joints[0];
  return {
    ...structuredClone(rig),
    joints: [
      ...structuredClone(rig.joints),
      {
        name: nextName(
          'joint',
          rig.joints.map((joint) => joint.name),
        ),
        parent: parent.name,
        position: [parent.position[0], Math.min(100_000, parent.position[1] + 1), parent.position[2]],
        rotation: [0, 0, 0],
      },
    ],
  };
}

export function addRigSocket(rig: Rig): Rig {
  if (rig.sockets.length >= 64) throw new Error('A rig can contain at most 64 sockets.');
  return {
    ...structuredClone(rig),
    sockets: [
      ...structuredClone(rig.sockets),
      {
        name: nextName(
          'socket',
          rig.sockets.map((socket) => socket.name),
        ),
        joint: rig.joints[0].name,
        transform: identityTransform(),
      },
    ],
  };
}

export function addRigLandmark(rig: Rig): Rig {
  return rigSchema.parse({
    ...structuredClone(rig),
    landmarks: { ...rig.landmarks, [nextName('landmark', Object.keys(rig.landmarks))]: [0, 0, 0] },
  });
}

export function updateRigLandmark(
  rig: Rig,
  name: string,
  patch: Partial<{ name: string; position: Rig['landmarks'][string] }>,
): Rig {
  const position = rig.landmarks[name];
  if (!position) throw new Error('Rig landmark not found.');
  const nextName = patch.name ?? name;
  if (!idSchema.safeParse(nextName).success) throw new Error('Landmark names must be valid IDs.');
  if (nextName !== name && Object.hasOwn(rig.landmarks, nextName))
    throw new Error('Landmark names must be unique.');
  if (patch.position && !vectorSchema.safeParse(patch.position).success)
    throw new Error('Landmark coordinates must be finite and within ±100000.');
  const landmarks = { ...rig.landmarks };
  delete landmarks[name];
  landmarks[nextName] = patch.position ?? position;
  return rigSchema.parse({ ...structuredClone(rig), landmarks });
}

export function removeRigLandmark(rig: Rig, name: string): Rig {
  if (!Object.hasOwn(rig.landmarks, name)) throw new Error('Rig landmark not found.');
  const landmarks = { ...rig.landmarks };
  delete landmarks[name];
  return { ...structuredClone(rig), landmarks };
}

export function setRigJointParent(rig: Rig, jointName: string, parentName: string | null): Rig {
  const joint = rig.joints.find((entry) => entry.name === jointName);
  if (!joint) throw new Error('Joint not found.');
  if (parentName !== null) {
    const parent = rig.joints.find((entry) => entry.name === parentName);
    if (!parent) throw new Error('Parent joint not found.');
    let current: string | null = parentName;
    const seen = new Set<string>();
    while (current !== null) {
      if (current === jointName) throw new Error('Joint parent would create a cycle.');
      if (seen.has(current)) throw new Error('Rig hierarchy already contains a cycle.');
      seen.add(current);
      const ancestor = rig.joints.find((entry) => entry.name === current);
      if (!ancestor) throw new Error('Rig hierarchy contains a missing parent.');
      current = ancestor.parent;
    }
  }
  return {
    ...structuredClone(rig),
    joints: rig.joints.map((entry) => (entry.name === jointName ? { ...entry, parent: parentName } : entry)),
  };
}

function updateRigClip(rig: Rig, clipName: string, update: (clip: RigClip) => void): Rig {
  const next = structuredClone(rig);
  const clip = next.clips.find((entry) => entry.name === clipName);
  if (!clip) throw new Error('Animation clip not found.');
  update(clip);
  return rigSchema.parse(next);
}

export function addRigClip(rig: Rig): Rig {
  if (rig.clips.length >= 64) throw new Error('A rig can contain at most 64 animation clips.');
  return {
    ...structuredClone(rig),
    clips: [
      ...structuredClone(rig.clips),
      {
        name: nextName(
          'clip',
          rig.clips.map((clip) => clip.name),
        ),
        duration: 1,
        loop: true,
        speed: 0,
        blendIn: 0.12,
        tracks: [],
        events: [],
      },
    ],
  };
}

export function animationClipUseCount(project: ProjectDocument, assetId: string, clipName: string): number {
  const markers = new Set(
    project.assets
      .find((asset) => asset.id === assetId)
      ?.rig?.clips.find((clip) => clip.name === clipName)
      ?.events.map((event) => event.name) ?? [],
  );
  return [...project.scenes, ...project.prefabs].reduce(
    (count, scene) =>
      count +
      scene.nodes.reduce((nodeCount, node) => {
        if (node.assetId !== assetId) return nodeCount;
        for (const component of node.components) {
          if (
            component.type === 'animation' &&
            [
              component.idle,
              component.moving,
              component.running,
              component.jumping,
              component.attacking,
            ].some((name) => name?.toLowerCase() === clipName.toLowerCase())
          )
            nodeCount++;
          if (component.type === 'rules')
            nodeCount += component.rules.filter(
              (rule) =>
                rule.event === 'animation' && (rule.marker ? markers.has(rule.marker) : markers.size > 0),
            ).length;
        }
        return nodeCount;
      }, 0),
    0,
  );
}

export function renameRigClip(rig: Rig, clipName: string, nextName: string, uses: number): Rig {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(nextName)) throw new Error('Clip names must be valid IDs.');
  if (rig.clips.some((clip) => clip.name === nextName && clip.name !== clipName))
    throw new Error('Clip names must be unique.');
  if (uses > 0) throw new Error('Resolve scene animation and marker references before renaming this clip.');
  return updateRigClip(rig, clipName, (clip) => {
    clip.name = nextName;
  });
}

export function removeRigClip(rig: Rig, clipName: string, uses: number): Rig {
  if (uses > 0) throw new Error('Resolve scene animation and marker references before removing this clip.');
  if (!rig.clips.some((clip) => clip.name === clipName)) throw new Error('Animation clip not found.');
  return { ...structuredClone(rig), clips: rig.clips.filter((clip) => clip.name !== clipName) };
}

export function updateRigClipSettings(
  rig: Rig,
  clipName: string,
  patch: Partial<Pick<RigClip, 'duration' | 'loop' | 'speed' | 'blendIn'>>,
): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    if (
      patch.duration !== undefined &&
      (clip.events.some((event) => event.time > patch.duration!) ||
        clip.tracks.some((track) => track.keys.some((key) => key.time > patch.duration!)))
    )
      throw new Error('Move keys and markers inside the clip before shortening its duration.');
    Object.assign(clip, patch);
  });
}

export function addRigMarker(rig: Rig, clipName: string): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    if (clip.events.length >= 256) throw new Error('A clip can contain at most 256 markers.');
    const lastTime = Math.max(0, ...clip.events.map((event) => Math.min(event.time, clip.duration)));
    clip.events.push({
      time: lastTime + (clip.duration - lastTime) / 2,
      name: nextName(
        'marker',
        clip.events.map((event) => event.name),
      ),
    });
    clip.events.sort((a, b) => a.time - b.time);
  });
}

export function updateRigMarker(
  rig: Rig,
  clipName: string,
  markerIndex: number,
  patch: Partial<RigMarker>,
): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    const marker = clip.events[markerIndex];
    if (!marker) throw new Error('Animation marker not found.');
    const next = { ...marker, ...patch };
    if (!Number.isFinite(next.time) || next.time < 0 || next.time > clip.duration)
      throw new Error('Marker time must be within the clip duration.');
    if (!idSchema.safeParse(next.name).success) throw new Error('Marker names must be valid IDs.');
    clip.events[markerIndex] = next;
    clip.events.sort((a, b) => a.time - b.time);
  });
}

export function removeRigMarker(rig: Rig, clipName: string, markerIndex: number): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    if (!clip.events[markerIndex]) throw new Error('Animation marker not found.');
    clip.events.splice(markerIndex, 1);
  });
}

export function addRigTrack(rig: Rig, clipName: string, jointName: string): Rig {
  const clip = rig.clips.find((entry) => entry.name === clipName);
  if (!clip) throw new Error('Animation clip not found.');
  if (!rig.joints.some((joint) => joint.name === jointName)) throw new Error('Animation joint not found.');
  if (clip.tracks.some((track) => track.joint === jointName))
    throw new Error('This clip already has a track for that joint.');
  if (clip.tracks.length >= 128) throw new Error('A clip can contain at most 128 tracks.');
  return updateRigClip(rig, clipName, (entry) => {
    entry.tracks.push({ joint: jointName, keys: [{ time: 0, rotation: [0, 0, 0] }] });
  });
}

export function setRigTrackJoint(rig: Rig, clipName: string, currentJoint: string, nextJoint: string): Rig {
  if (!rig.joints.some((joint) => joint.name === nextJoint)) throw new Error('Animation joint not found.');
  return updateRigClip(rig, clipName, (clip) => {
    const track = clip.tracks.find((entry) => entry.joint === currentJoint);
    if (!track) throw new Error('Animation track not found.');
    if (clip.tracks.some((entry) => entry.joint === nextJoint && entry.joint !== currentJoint))
      throw new Error('This clip already has a track for that joint.');
    track.joint = nextJoint;
  });
}

export function removeRigTrack(rig: Rig, clipName: string, jointName: string): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    clip.tracks = clip.tracks.filter((track) => track.joint !== jointName);
  });
}

export function addRigKeyframe(rig: Rig, clipName: string, jointName: string): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    const track = clip.tracks.find((entry) => entry.joint === jointName);
    if (!track) throw new Error('Animation track not found.');
    if (track.keys.length >= 2048) throw new Error('A track can contain at most 2,048 keyframes.');
    const keys = track.keys.slice().sort((a, b) => a.time - b.time);
    if (!keys.length) throw new Error('An animation track must contain at least one keyframe.');

    const gaps: { start: number; end: number; left?: RigKey; right?: RigKey }[] = [
      { start: 0, end: keys[0].time, left: undefined, right: keys[0] },
      ...keys.slice(1).map((key, index) => ({
        start: keys[index].time,
        end: key.time,
        left: keys[index],
        right: key,
      })),
      { start: keys.at(-1)!.time, end: clip.duration, left: keys.at(-1)!, right: undefined },
    ].filter((gap) => gap.end > gap.start);
    let gap: (typeof gaps)[number] | undefined;
    for (const candidate of gaps)
      if (!gap || candidate.end - candidate.start > gap.end - gap.start) gap = candidate;
    const time = gap ? gap.start + (gap.end - gap.start) / 2 : Number.NaN;
    if (!gap || !(time > gap.start && time < gap.end))
      throw new Error('There is no time remaining in this clip.');

    const from = gap.left ?? gap.right!;
    const to = gap.right ?? from;
    const hasPair = Boolean(gap.left && gap.right);
    let alpha = hasPair ? (time - from.time) / (to.time - from.time) : 0;
    if (from.interpolation === 'step') alpha = 0;
    else if (from.interpolation === 'smooth') alpha = alpha * alpha * (3 - 2 * alpha);
    let rotation: [number, number, number] = [...from.rotation];
    if (hasPair && alpha !== 0) {
      const euler = new Euler().setFromQuaternion(
        new Quaternion()
          .setFromEuler(new Euler(...from.rotation))
          .slerp(new Quaternion().setFromEuler(new Euler(...to.rotation)), alpha),
      );
      rotation = [euler.x, euler.y, euler.z];
    }
    const position =
      from.position || to.position
        ? hasPair
          ? ([0, 1, 2].map(
              (axis) =>
                (from.position?.[axis] ?? 0) +
                ((to.position?.[axis] ?? 0) - (from.position?.[axis] ?? 0)) * alpha,
            ) as [number, number, number])
          : ([...(from.position ?? to.position!)] as [number, number, number])
        : undefined;
    track.keys.push({
      time,
      rotation,
      ...(position && { position }),
      ...(from.interpolation && { interpolation: from.interpolation }),
    });
    track.keys.sort((a, b) => a.time - b.time);
  });
}

export function updateRigKeyframe(
  rig: Rig,
  clipName: string,
  jointName: string,
  keyIndex: number,
  patch: Partial<RigKey>,
): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    const track = clip.tracks.find((entry) => entry.joint === jointName);
    const key = track?.keys[keyIndex];
    if (!track || !key) throw new Error('Animation keyframe not found.');
    const next = { ...key, ...patch };
    if (!Number.isFinite(next.time) || next.time < 0 || next.time > clip.duration)
      throw new Error('Keyframe time must be within the clip duration.');
    if (track.keys.some((entry, index) => index !== keyIndex && entry.time === next.time))
      throw new Error('A track cannot contain two keyframes at the same time.');
    track.keys[keyIndex] = next;
    track.keys.sort((a, b) => a.time - b.time);
  });
}

export function removeRigKeyframe(rig: Rig, clipName: string, jointName: string, keyIndex: number): Rig {
  return updateRigClip(rig, clipName, (clip) => {
    const track = clip.tracks.find((entry) => entry.joint === jointName);
    if (!track || !track.keys[keyIndex]) throw new Error('Animation keyframe not found.');
    if (track.keys.length <= 1) throw new Error('An animation track must keep at least one keyframe.');
    track.keys.splice(keyIndex, 1);
  });
}

export function renameRigJoint(asset: Asset, oldName: string, newName: string): Asset {
  const rig = asset.rig;
  if (!rig) throw new Error('Add a rig before editing its joints.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(newName)) throw new Error('Joint names must be valid IDs.');
  if (rig.joints.some((joint) => joint.name === newName && joint.name !== oldName))
    throw new Error('Joint names must be unique.');

  return {
    ...asset,
    rig: {
      ...structuredClone(rig),
      joints: rig.joints.map((joint) => ({
        ...joint,
        name: joint.name === oldName ? newName : joint.name,
        parent: joint.parent === oldName ? newName : joint.parent,
      })),
      sockets: rig.sockets.map((socket) => ({
        ...socket,
        joint: socket.joint === oldName ? newName : socket.joint,
      })),
      clips: rig.clips.map((clip) => ({
        ...clip,
        tracks: clip.tracks.map((track) => ({
          ...track,
          joint: track.joint === oldName ? newName : track.joint,
        })),
      })),
    },
    model: {
      ...asset.model,
      voxels: asset.model.voxels.map((voxel) => ({
        ...voxel,
        ...(voxel.bone === oldName && { bone: newName }),
        ...(voxel.weights && {
          weights: voxel.weights.map((weight) => ({
            ...weight,
            bone: weight.bone === oldName ? newName : weight.bone,
          })),
        }),
      })),
    },
  };
}

export function rigJointEditBlock(project: ProjectDocument, asset: Asset): string | null {
  if (asset.equipment || project.assets.some((candidate) => candidate.equipment?.bodyAssetId === asset.id))
    return 'This joint list is shared with fitted equipment. Remove or refit that equipment before editing joints.';
  return null;
}

export function jointAttachmentUseCount(
  project: ProjectDocument,
  assetId: string,
  jointName: string,
): number {
  return project.scenes.reduce(
    (count, scene) =>
      count +
      scene.nodes.reduce(
        (nodeCount, node) =>
          nodeCount +
          (node.assetId === assetId
            ? node.attachments.filter((attachment) => attachment.hiddenBones.includes(jointName)).length
            : 0),
        0,
      ),
    0,
  );
}

export function jointRemovalBlock(asset: Asset, name: string, project?: ProjectDocument): string | null {
  const rig = asset.rig;
  if (!rig) return 'Add a rig before removing joints.';
  if (project) {
    const shared = rigJointEditBlock(project, asset);
    if (shared) return shared;
    if (jointAttachmentUseCount(project, asset.id, name) > 0)
      return 'Equipment masks use this joint. Change those references before removing it.';
  }
  if (rig.joints.length <= 1) return 'A rig must keep at least one joint.';
  if (rig.sockets.some((socket) => socket.joint === name))
    return 'Move or remove this joint’s sockets first.';
  if (rig.clips.some((clip) => clip.tracks.some((track) => track.joint === name)))
    return 'Animation clips use this joint. Retarget their tracks in Advanced rig JSON first.';
  if (
    asset.model.voxels.some(
      (voxel) => voxel.bone === name || voxel.weights?.some((weight) => weight.bone === name),
    )
  )
    return 'Model voxels are weighted to this joint. Reassign them before removing it.';
  return null;
}

export function removeRigJoint(asset: Asset, name: string): Asset {
  const rig = asset.rig;
  const reason = jointRemovalBlock(asset, name);
  if (!rig || reason) throw new Error(reason ?? 'Rig is missing.');
  const removed = rig.joints.find((joint) => joint.name === name);
  if (!removed) return asset;
  return {
    ...asset,
    rig: {
      ...structuredClone(rig),
      joints: rig.joints
        .filter((joint) => joint.name !== name)
        .map((joint) => ({ ...joint, parent: joint.parent === name ? removed.parent : joint.parent })),
    },
  };
}

export function socketUseCount(project: ProjectDocument, bodyAssetId: string, socketName: string): number {
  const attached = project.scenes.reduce(
    (count, scene) =>
      count +
      scene.nodes.reduce(
        (nodeCount, node) =>
          nodeCount +
          (node.assetId === bodyAssetId
            ? node.attachments.filter((attachment) => attachment.socket === socketName).length
            : 0),
        0,
      ),
    0,
  );
  const fitted = project.assets.filter(
    (asset) => asset.equipment?.bodyAssetId === bodyAssetId && asset.equipment.socket === socketName,
  ).length;
  return attached + fitted;
}

export function parseRigJson(source: string): Rig | null {
  const value: unknown = JSON.parse(source);
  return value === null ? null : rigSchema.parse(value);
}
