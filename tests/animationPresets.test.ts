import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/projectStore';
import { addAnimationPreset } from '../services/animationPresets';
import { generateCharacter } from '../services/assetAssembly';
import {
  applyProjectOperations,
  assetSchema,
  newProject,
  rigSchema,
  validateProject,
} from '../services/projectDocument';
import { createModelDocument } from '../services/modelDocument';

const humanoidRig = () =>
  rigSchema.parse({
    profile: 'humanoid',
    version: 1,
    joints: [
      { name: 'hips', parent: null, position: [0, 0, 0] },
      { name: 'spine', parent: 'hips', position: [0, 1, 0] },
      { name: 'head', parent: 'spine', position: [0, 2, 0] },
      { name: 'upperArmLeft', parent: 'spine', position: [-1, 1.5, 0] },
      { name: 'forearmLeft', parent: 'upperArmLeft', position: [-1.2, 0.9, 0] },
      { name: 'upperArmRight', parent: 'spine', position: [1, 1.5, 0] },
      { name: 'forearmRight', parent: 'upperArmRight', position: [1.2, 0.9, 0] },
      { name: 'thighLeft', parent: 'hips', position: [-0.4, -0.5, 0] },
      { name: 'thighRight', parent: 'hips', position: [0.4, -0.5, 0] },
      { name: 'kneeLeft', parent: 'thighLeft', position: [-0.4, -1.2, 0] },
      { name: 'kneeRight', parent: 'thighRight', position: [0.4, -1.2, 0] },
    ],
  });

test('locomotion presets create mirrored, editable gait keys with footstep markers', () => {
  const rig = humanoidRig();
  const next = addAnimationPreset(rig, 'walk', { duration: 1.1, intensity: 1.25 });
  const walk = next.clips[0];
  const leftLeg = walk.tracks.find((track) => track.joint === 'thighLeft')!;
  const rightLeg = walk.tracks.find((track) => track.joint === 'thighRight')!;

  assert.equal(walk.name, 'walk');
  assert.equal(walk.duration, 1.1);
  assert.equal(walk.loop, true);
  assert.equal(walk.speed, 3);
  assert.equal(walk.blendIn, 0.12);
  assert.equal(leftLeg.keys.length, 17);
  assert.ok(leftLeg.keys[1].rotation[0] * rightLeg.keys[1].rotation[0] < 0);
  assert.equal(leftLeg.keys[1].interpolation, 'linear');
  assert.ok(walk.tracks.find((track) => track.joint === 'hips')!.keys[1].position);
  assert.equal(walk.tracks.find((track) => track.joint === 'spine')!.keys[1].position, undefined);
  assert.deepEqual(
    walk.events.map(({ name }) => name),
    ['footstep', 'footstep'],
  );
  assert.deepEqual(
    walk.events.map(({ time }) => time),
    [0.275, 0.8250000000000001],
  );
});

test('locomotion presets articulate knees and feet and clip blending remains editable', () => {
  const rig = rigSchema.parse({
    profile: 'humanoid',
    version: 1,
    joints: [
      { name: 'hips', parent: null, position: [0, 0, 0] },
      { name: 'thighLeft', parent: 'hips', position: [-0.4, -0.5, 0] },
      { name: 'kneeLeft', parent: 'thighLeft', position: [-0.4, -1.2, 0] },
      { name: 'footLeft', parent: 'kneeLeft', position: [-0.4, -1.8, 0] },
      { name: 'thighRight', parent: 'hips', position: [0.4, -0.5, 0] },
      { name: 'kneeRight', parent: 'thighRight', position: [0.4, -1.2, 0] },
      { name: 'footRight', parent: 'kneeRight', position: [0.4, -1.8, 0] },
    ],
    clips: [{ name: 'legacy', duration: 1, tracks: [] }],
  });
  const walk = addAnimationPreset(rig, 'walk').clips[1];
  const keyAt = (joint: string, index: number) =>
    walk.tracks.find((track) => track.joint === joint)!.keys[index];

  assert.equal(rig.clips[0].blendIn, 0.12, 'legacy clips receive the backward-compatible default');
  assert.ok(Math.abs(keyAt('kneeLeft', 2).rotation[0]) > 0);
  assert.ok(Math.abs(keyAt('footLeft', 2).rotation[0]) > 0);
  assert.notDeepEqual(keyAt('thighLeft', 2).rotation, keyAt('thighRight', 2).rotation);
});

test('starter body motion scales with rig height for walking, running, and jumping', () => {
  const small = humanoidRig();
  const large = structuredClone(small);
  for (const joint of large.joints)
    joint.position = joint.position.map((value) => value * 10) as [number, number, number];

  const motion = (rig: ReturnType<typeof humanoidRig>, preset: 'walk' | 'run' | 'jump') => {
    const clip = addAnimationPreset(rig, preset).clips[0],
      root = clip.tracks.find((track) => track.joint === 'hips')!,
      peak = preset === 'jump' ? root.keys[3] : root.keys[4];
    return { clip, peak };
  };
  const smallWalk = motion(small, 'walk'),
    largeWalk = motion(large, 'walk'),
    smallRun = motion(small, 'run'),
    largeRun = motion(large, 'run'),
    smallJump = motion(small, 'jump'),
    largeJump = motion(large, 'jump');

  assert.equal(smallWalk.clip.tracks[0].keys.length, 17);
  assert.ok(Math.abs(largeWalk.peak.position![1] / smallWalk.peak.position![1] - 10) < 1e-6);
  assert.ok(Math.abs(largeRun.peak.position![1] / smallRun.peak.position![1] - 10) < 1e-6);
  assert.ok(Math.abs(largeJump.peak.position![1] / smallJump.peak.position![1] - 10) < 1e-6);
});

test('one-shot jump and attack presets expose editable poses and actionable markers', () => {
  let rig = humanoidRig();
  rig = addAnimationPreset(rig, 'jump');
  rig = addAnimationPreset(rig, 'attack');
  const jump = rig.clips.find((clip) => clip.name === 'jump')!;
  const attack = rig.clips.find((clip) => clip.name === 'attack')!;

  assert.equal(jump.loop, false);
  assert.equal(jump.tracks.find((track) => track.joint === 'hips')!.keys.length, 7);
  assert.equal(attack.loop, false);
  assert.deepEqual(attack.events, [{ time: attack.duration * 0.56, name: 'impact' }]);
  const strikePose = 3;
  assert.ok(
    attack.tracks.find((track) => track.joint === 'upperArmRight')!.keys[strikePose].rotation[0] > 0.6,
  );
  assert.ok(
    Math.abs(attack.tracks.find((track) => track.joint === 'upperArmLeft')!.keys[strikePose].rotation[0]) <
      0.2,
  );
  assert.ok(
    attack.tracks.find((track) => track.joint === 'forearmRight')!.keys[strikePose].rotation[0] > 0.2,
  );
});

test('wave motion raises one arm and gives its wrist visible oscillation', () => {
  const rig = rigSchema.parse({
    profile: 'humanoid',
    version: 1,
    joints: [
      { name: 'hips', parent: null, position: [0, 0, 0] },
      { name: 'upperArmLeft', parent: 'hips', position: [-1, 1, 0] },
      { name: 'forearmLeft', parent: 'upperArmLeft', position: [-2, 1, 0] },
      { name: 'handLeft', parent: 'forearmLeft', position: [-3, 1, 0] },
      { name: 'upperArmRight', parent: 'hips', position: [1, 1, 0] },
      { name: 'handRight', parent: 'upperArmRight', position: [2, 1, 0] },
    ],
  });
  const wave = addAnimationPreset(rig, 'wave');
  const track = (joint: string) => wave.clips[0].tracks.find((entry) => entry.joint === joint)!;

  assert.notEqual(track('upperArmLeft').keys[0].rotation[2], 0);
  assert.equal(track('upperArmRight').keys[0].rotation[2], 0);
  assert.equal(track('handLeft').keys.length, 19);
  assert.ok(Math.abs(track('handLeft').keys[1].rotation[0]) > 0.1);
  assert.equal(track('handRight').keys[2].rotation[0], 0);
});

test('quadruped attack and wave presets animate the head, stride, and tail', () => {
  const creature = generateCharacter({
    id: 'creature',
    name: 'Creature',
    profile: 'quadruped',
    height: 24,
    width: 10,
    color: 0xd88747,
    accent: 0xe7d6b8,
  });
  const attack = addAnimationPreset(creature.rig!, 'attack').clips.at(-1)!;
  const attackTrack = (joint: string) => attack.tracks.find((entry) => entry.joint === joint)!;
  assert.ok(attackTrack('head').keys.some((key) => key.rotation[0] < -0.2));
  assert.ok(attackTrack('leg_left_front').keys.some((key) => Math.abs(key.rotation[0]) > 0.2));
  assert.ok(attackTrack('root').keys.some((key) => Math.abs(key.position?.[2] ?? 0) > 0.1));
  assert.ok(attackTrack('tail').keys.some((key) => Math.abs(key.rotation[1]) > 0.1));
  assert.deepEqual(attack.events, [{ time: attack.duration * 0.56, name: 'impact' }]);

  const wave = addAnimationPreset(creature.rig!, 'wave').clips.at(-1)!;
  const tail = wave.tracks.find((entry) => entry.joint === 'tail')!;
  assert.equal(wave.name, 'tail-wag');
  assert.equal(tail.keys.length, 19);
  assert.ok(tail.keys.some((key) => Math.abs(key.rotation[1]) > 0.2));
  assert.equal(
    wave.tracks.some((entry) => entry.joint.startsWith('leg_')),
    false,
  );
  assert.equal(
    addAnimationPreset(addAnimationPreset(creature.rig!, 'wave'), 'wave').clips.at(-1)!.name,
    'tail-wag-2',
  );
});

test('presets avoid overwrites, validate tuning, and can be generated through project_apply', () => {
  const rig = addAnimationPreset(humanoidRig(), 'wave');
  const named = addAnimationPreset(rig, 'wave');
  assert.equal(named.clips[1].name, 'wave-2');
  assert.throws(() => addAnimationPreset(rig, 'wave', { name: 'wave' }), /already exists/);
  assert.throws(() => addAnimationPreset(rig, 'walk', { intensity: 2.1 }), /intensity must be between/);
  assert.throws(() => addAnimationPreset(rig, 'walk', { duration: 0.1 }), /duration must be between/);

  const project = newProject('motion-authoring', 'Motion authoring');
  project.assets = [
    assetSchema.parse({
      id: 'hero',
      name: 'Hero',
      model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff }]),
      voxelSize: 0.1,
      pivot: [0, 0, 0],
      rig: humanoidRig(),
    }),
  ];
  const updated = validateProject(
    applyProjectOperations(project, [{ type: 'asset.animation-preset', assetId: 'hero', preset: 'run' }]),
  );
  const run = updated.assets[0].rig!.clips[0];
  assert.equal(run.name, 'run');
  assert.ok(run.tracks.some((track) => track.joint === 'thighLeft'));
});

test('Rig Editor preset Apply supports ProjectStore undo, redo, and reopen', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-animation-history-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-animation-history-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new ProjectStore(directory);
  await store.create('Motion history', 'motion-history');
  const hero = assetSchema.parse({
    id: 'hero',
    name: 'Hero',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff }]),
    rig: humanoidRig(),
  });
  await store.commit('motion-history', {
    expectedRevision: 0,
    requestId: 'seed-motion-hero',
    operations: [{ type: 'asset.put', asset: hero }],
  });

  const editorDraft = structuredClone(hero);
  editorDraft.rig = addAnimationPreset(editorDraft.rig!, 'walk', { intensity: 0.8 });
  await store.commit('motion-history', {
    expectedRevision: 1,
    requestId: 'apply-editor-walk',
    operations: [{ type: 'asset.put', asset: editorDraft }],
  });

  const reopened = await new ProjectStore(directory).read('motion-history');
  assert.equal(reopened.assets[0].rig?.clips[0].name, 'walk');
  const undone = await new ProjectStore(directory).history('motion-history', 'undo', {
    expectedRevision: 2,
    requestId: 'undo-editor-walk',
  });
  assert.deepEqual(undone.project.assets[0].rig?.clips, []);
  const redone = await new ProjectStore(directory).history('motion-history', 'redo', {
    expectedRevision: 3,
    requestId: 'redo-editor-walk',
  });
  assert.equal(redone.project.assets[0].rig?.clips[0].name, 'walk');
  assert.equal(
    (await new ProjectStore(directory).read('motion-history')).assets[0].rig?.clips[0].name,
    'walk',
  );
});
