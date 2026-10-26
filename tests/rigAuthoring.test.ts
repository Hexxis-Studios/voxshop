import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Euler, Quaternion } from 'three';
import { RigEditor } from '../components/RigEditor';
import { NodeInspector } from '../components/NodeInspector';
import {
  addRigClip,
  addRigKeyframe,
  addRigJoint,
  addRigLandmark,
  addRigMarker,
  addRigSocket,
  addRigTrack,
  animationClipUseCount,
  createCustomRig,
  jointRemovalBlock,
  parseRigJson,
  removeRigClip,
  removeRigKeyframe,
  removeRigMarker,
  removeRigJoint,
  removeRigLandmark,
  removeRigTrack,
  renameRigClip,
  renameRigJoint,
  socketUseCount,
  setRigJointParent,
  updateRigClipSettings,
  updateRigKeyframe,
  updateRigMarker,
  updateRigLandmark,
} from '../components/rigAuthoring';
import { createModelDocument } from '../services/modelDocument';
import { fitAssetToBounds } from '../services/assetAssembly';
import {
  assetSchema,
  applyProjectOperations,
  identityTransform,
  newProject,
  retargetRigClip,
  transactionSchema,
  validateProject,
  type Asset,
  type Rig,
} from '../services/projectDocument';
import { createAssetVisual } from '../runtime/assetMesh';

function riggedAsset(): Asset {
  return assetSchema.parse({
    id: 'hero',
    name: 'Hero',
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0xffffff, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
    ]),
    rig: {
      profile: 'humanoid',
      version: 1,
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'arm', parent: 'root', position: [1, 2, 0] },
        { name: 'hand', parent: 'arm', position: [2, 2, 0] },
      ],
      landmarks: { torsoMin: [0, 0, 0], torsoMax: [1, 2, 1] },
      sockets: [{ name: 'hand', joint: 'hand', transform: {} }],
      clips: [
        {
          name: 'wave',
          duration: 1,
          loop: true,
          speed: 1,
          tracks: [{ joint: 'arm', keys: [{ time: 0, rotation: [0, 0, 0] }] }],
          events: [],
        },
      ],
    },
  });
}

test('retargets an animation through a revisioned project operation and preserves metric offsets', () => {
  const source = riggedAsset();
  const sourceRig = structuredClone(source.rig!);
  sourceRig.clips[0].tracks[0].keys[0].position = [1, 2, 3];
  sourceRig.clips[0].events = [{ time: 0.5, name: 'footstep' }];
  const sourceAsset = { ...source, rig: sourceRig };
  const targetAsset = assetSchema.parse({
    ...riggedAsset(),
    id: 'target',
    name: 'Target',
    voxelSize: 0.05,
    rig: {
      ...sourceRig,
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'forearm', parent: 'root', position: [0, 2, 0] },
      ],
      landmarks: {},
      sockets: [],
      clips: [],
    },
  });
  const project = newProject('retarget', 'Retarget');
  project.assets = [sourceAsset, targetAsset];

  const transaction = transactionSchema.parse({
    expectedRevision: 0,
    requestId: 'retarget-wave',
    operations: [
      {
        type: 'asset.retarget-animation',
        sourceAssetId: sourceAsset.id,
        sourceClipName: 'wave',
        targetAssetId: targetAsset.id,
        targetClipName: 'wave_copy',
        jointMap: [{ sourceJoint: 'arm', targetJoint: 'forearm' }],
      },
    ],
  });
  const next = applyProjectOperations(project, transaction.operations);

  const copied = next.assets.find((asset) => asset.id === targetAsset.id)!.rig!.clips[0];
  assert.equal(copied.name, 'wave_copy');
  assert.deepEqual(
    copied.tracks.map((track) => track.joint),
    ['forearm'],
  );
  assert.deepEqual(copied.tracks[0].keys[0].position, [2, 4, 6]);
  assert.deepEqual(copied.events, [{ time: 0.5, name: 'footstep' }]);
  assert.equal(sourceAsset.rig!.clips[0].tracks[0].keys[0].position![0], 1);
  assert.equal(next.assets.find((asset) => asset.id === sourceAsset.id)!.rig!.clips[0].name, 'wave');
  assert.equal(validateProject(next).assets.length, 2);
});

test('retargeting converts animation deltas through each joint world bind axis', () => {
  const source = riggedAsset().rig!;
  source.joints.find((joint) => joint.name === 'root')!.rotation = [0, Math.PI / 3, 0];
  source.joints.find((joint) => joint.name === 'arm')!.rotation = [Math.PI / 2, 0, 0];
  source.clips[0].tracks[0].keys[0].rotation = [0, 0, Math.PI / 3];
  const target = riggedAsset().rig!;
  target.joints = [
    { name: 'root', parent: null, position: [0, 0, 0], rotation: [-Math.PI / 4, 0, 0] },
    { name: 'forearm', parent: 'root', position: [0, 2, 0], rotation: [0, Math.PI / 2, 0] },
  ];
  target.clips = [];

  const result = retargetRigClip(
    source,
    'wave',
    target,
    'retargeted',
    [{ sourceJoint: 'arm', targetJoint: 'forearm' }],
    1,
    1,
  );
  const copiedRotation = result.clips[0].tracks[0].keys[0].rotation,
    quaternion = (rotation: [number, number, number]) =>
      new Quaternion().setFromEuler(new Euler(...rotation)),
    sourceRest = quaternion([0, Math.PI / 3, 0]).multiply(quaternion([Math.PI / 2, 0, 0])),
    targetRest = quaternion([-Math.PI / 4, 0, 0]).multiply(quaternion([0, Math.PI / 2, 0])),
    sourceDelta = quaternion([0, 0, Math.PI / 3]),
    targetDelta = quaternion(copiedRotation),
    sourceParentDelta = sourceRest.clone().multiply(sourceDelta).multiply(sourceRest.clone().invert()),
    targetParentDelta = targetRest.clone().multiply(targetDelta).multiply(targetRest.clone().invert());

  assert.ok(
    1 - Math.abs(sourceParentDelta.dot(targetParentDelta)) < 1e-6,
    'the retargeted joint preserves the source motion axis in the target parent space',
  );
});

test('retargeting rejects missing tracks, reused target joints and duplicate clip names without mutation', () => {
  const source = riggedAsset().rig!;
  const twoTrackRig = structuredClone(source);
  twoTrackRig.clips[0].tracks.push({ joint: 'hand', keys: [{ time: 0, rotation: [0, 0, 0] }] });
  const target = createCustomRig();
  assert.throws(
    () =>
      retargetRigClip(
        source,
        'missing',
        target,
        'copy',
        [{ sourceJoint: 'arm', targetJoint: 'root' }],
        0.1,
        0.1,
      ),
    /does not exist/,
  );
  assert.throws(
    () =>
      retargetRigClip(
        twoTrackRig,
        'wave',
        target,
        'copy',
        [
          { sourceJoint: 'arm', targetJoint: 'root' },
          { sourceJoint: 'hand', targetJoint: 'root' },
        ],
        0.1,
        0.1,
      ),
    /at most once/,
  );
  const withCopy = {
    ...target,
    clips: [{ name: 'copy', duration: 1, loop: true, speed: 0, blendIn: 0.12, tracks: [], events: [] }],
  };
  assert.throws(
    () =>
      retargetRigClip(
        source,
        'wave',
        withCopy,
        'copy',
        [{ sourceJoint: 'arm', targetJoint: 'root' }],
        0.1,
        0.1,
      ),
    /already exists/,
  );
  assert.equal(target.clips.length, 0);
});

test('rig editor exposes source asset and explicit joint mappings for animation retargeting', () => {
  const source = riggedAsset();
  const target = assetSchema.parse({
    ...riggedAsset(),
    id: 'target',
    name: 'Target',
    rig: { ...riggedAsset().rig!, joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] },
  });
  const project = newProject('retarget-ui', 'Retarget UI');
  project.assets = [source, target];
  const markup = renderToStaticMarkup(
    React.createElement(RigEditor, {
      asset: target,
      project,
      json: JSON.stringify(target.rig),
      onJsonChange: () => {},
      onChange: () => {},
    }),
  );
  assert.match(markup, /aria-label="Retarget animation"/);
  assert.match(markup, /Source asset/);
  assert.match(markup, /Map source joint arm/);
  assert.match(markup, /bind rotation \(radians\)/);
  assert.match(markup, /automatically converted between the source and target bind axes/);
  assert.match(markup, /Copy animation to this rig/);
  assert.match(markup, /aria-label="Live rig preview"/);
  assert.match(markup, /aria-label="Interactive animated asset preview"/);
  assert.match(markup, /Starting motion preset/);
  assert.match(markup, /Motion intensity/);
});

test('adding a custom rig, joint and socket uses stable unique IDs within schema bounds', () => {
  const custom = createCustomRig();
  assert.equal(
    validateProject({ ...newProject('rig-test', 'Rig test'), assets: [riggedAsset()] }).assets.length,
    1,
  );
  assert.equal(custom.joints[0].name, 'root');
  assert.deepEqual(custom.joints[0].rotation, [0, 0, 0]);
  assert.deepEqual(custom.sockets, []);

  const asset = riggedAsset();
  const first = addRigJoint(asset.rig!);
  const second = addRigJoint(first);
  assert.equal(first.joints[3].name, 'joint');
  assert.equal(second.joints[4].name, 'joint-2');
  assert.equal(first.joints[3].parent, 'root');

  const socketRig = addRigSocket(asset.rig!);
  assert.equal(socketRig.sockets[1].name, 'socket');
  assert.equal(socketRig.sockets[1].joint, 'root');
  assert.deepEqual(socketRig.sockets[1].transform, {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  assert.equal(addRigSocket(socketRig).sockets[2].name, 'socket-2');
});

test('rig sockets author meter-space fit bounds for rigid equipment', () => {
  const asset = riggedAsset();
  const next = assetSchema.parse({
    ...asset,
    rig: {
      ...asset.rig!,
      sockets: [{ ...asset.rig!.sockets[0], fitBounds: { min: [-0.2, -0.1, -0.1], max: [0.2, 0.3, 0.1] } }],
    },
  });
  assert.deepEqual(next.rig?.sockets[0].fitBounds, {
    min: [-0.2, -0.1, -0.1],
    max: [0.2, 0.3, 0.1],
  });
  assert.equal(
    assetSchema.safeParse({
      ...next,
      rig: {
        ...next.rig!,
        sockets: [{ ...next.rig!.sockets[0], fitBounds: { min: [0, 0, 0], max: [0, 1, 1] } }],
      },
    }).success,
    false,
    'fit bounds reject zero-width axes',
  );

  const project = newProject('socket-fit-bounds', 'Socket fit bounds');
  project.assets.push(next);
  const markup = renderToStaticMarkup(
    React.createElement(RigEditor, {
      asset: next,
      project,
      json: JSON.stringify(next.rig),
      onJsonChange: () => {},
      onChange: () => {},
    }),
  );
  assert.match(markup, /Socket hand fit minimum · meters X/);
  assert.match(markup, /Socket hand fit maximum · meters Z/);
});

test('asset fit preserves voxel geometry and uses one scale across a rotated socket box', () => {
  const gear = assetSchema.parse({
    id: 'fit-gear',
    name: 'Fit gear',
    voxelSize: 0.1,
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0x885533 },
      { x: 2, y: 0, z: 0, color: 0x885533 },
    ]),
  });
  const original = structuredClone(gear.model.voxels);
  const fit = fitAssetToBounds(gear, { min: [-0.1, 0, 0.1], max: [0.5, 0.6, 0.7] }, [0, 0, Math.PI / 2]);
  assert.ok(Math.abs(fit.scale[0] - 2) < 1e-6);
  assert.deepEqual(fit.scale, [2, 2, 2]);
  assert.ok(Math.abs(fit.position[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(fit.position[1] - 0.1) < 1e-6);
  assert.ok(Math.abs(fit.position[2] - 0.4) < 1e-6);
  assert.deepEqual(
    gear.model.voxels,
    original,
    'fitting changes only attachment transforms, never source voxels',
  );
  assert.throws(() => fitAssetToBounds(gear, { min: [0, 0, 0], max: [0, 1, 1] }), /positive dimensions/);
  const skinnedGear = assetSchema.parse({
      ...gear,
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0x885533, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
        { x: 2, y: 0, z: 0, color: 0x885533, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
      ]),
      rig: riggedAsset().rig,
    }),
    rigBeforeFit = structuredClone(skinnedGear.rig),
    skinBeforeFit = structuredClone(skinnedGear.model.voxels);
  const skinnedFit = fitAssetToBounds(skinnedGear, { min: [-0.1, 0, 0.1], max: [0.5, 0.6, 0.7] });
  assert.deepEqual(skinnedGear.rig, rigBeforeFit);
  assert.deepEqual(skinnedGear.model.voxels, skinBeforeFit);
  assert.deepEqual(skinnedFit.scale, [2, 2, 2]);
});

test('MCP project transactions auto-fit an attachment from its socket fit bounds', () => {
  const body = riggedAsset();
  body.rig!.sockets[0].fitBounds = { min: [-0.15, -0.1, -0.1], max: [0.45, 0.3, 0.1] };
  const gear = assetSchema.parse({
    id: 'custom-gear',
    name: 'Custom gear',
    voxelSize: 0.1,
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0x885533, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
      { x: 2, y: 0, z: 0, color: 0x885533, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
    ]),
    rig: riggedAsset().rig,
  });
  const project = newProject('fit-attachment', 'Fit attachment');
  project.assets.push(body, gear);
  const scene = project.scenes[0];
  scene.nodes.push({
    id: 'wearer',
    name: 'Wearer',
    assetId: body.id,
    transform: identityTransform(),
    enabled: true,
    components: [],
    attachments: [
      { assetId: gear.id, socket: 'hand', slot: 'custom', transform: identityTransform(), hiddenBones: [] },
    ],
    parentId: null,
  });
  const operation = { type: 'node.fit-attachment', sceneId: scene.id, nodeId: 'wearer', slot: 'custom' };
  assert.doesNotThrow(() =>
    transactionSchema.parse({
      expectedRevision: project.revision,
      requestId: 'fit',
      operations: [operation],
    }),
  );
  const fitted = applyProjectOperations(project, [operation]);
  const attachment = fitted.scenes[0].nodes[0].attachments[0];
  assert.deepEqual(attachment.transform.scale, [2, 2, 2]);
  assert.ok(Math.abs(attachment.transform.position[0] + 0.05) < 1e-6);
  assert.ok(Math.abs(attachment.transform.position[1] - 0.1) < 1e-6);
  assert.deepEqual(project.scenes[0].nodes[0].attachments[0].transform, identityTransform());
  assert.throws(
    () => applyProjectOperations(project, [{ ...operation, slot: 'missing' }]),
    /Attachment slot missing does not exist/,
  );
});

test('node inspector offers preserve-shape auto-fit for rigged gear on configured sockets', () => {
  const body = riggedAsset();
  body.rig!.sockets[0].fitBounds = { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] };
  const gear = assetSchema.parse({
    id: 'inspector-gear',
    name: 'Inspector gear',
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0x885533, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
    ]),
    rig: riggedAsset().rig,
  });
  const project = newProject('inspector-fit', 'Inspector fit');
  project.assets.push(body, gear);
  const node = {
    id: 'wearer',
    name: 'Wearer',
    assetId: body.id,
    transform: identityTransform(),
    enabled: true,
    components: [],
    attachments: [
      { assetId: gear.id, socket: 'hand', slot: 'custom', transform: identityTransform(), hiddenBones: [] },
    ],
    parentId: null,
  };
  project.scenes[0].nodes.push(node);
  const validated = validateProject(project);
  const markup = renderToStaticMarkup(
    React.createElement(NodeInspector, {
      node: validated.scenes[0].nodes[0],
      project: validated,
      onApply: async () => null,
      onDelete: () => {},
    }),
  );
  assert.match(markup, /Auto-fit to socket bounds/);
  assert.match(markup, /Fits the rigged asset in its rest pose/);
});

test('landmarks can be added, renamed, positioned, removed and committed through asset transactions', () => {
  const asset = riggedAsset();
  let rig = addRigLandmark(asset.rig!);
  rig = addRigLandmark(rig);
  assert.deepEqual(rig.landmarks.landmark, [0, 0, 0]);
  assert.deepEqual(rig.landmarks['landmark-2'], [0, 0, 0]);

  rig = updateRigLandmark(rig, 'landmark', { name: 'head', position: [1.5, 4, -2] });
  assert.deepEqual(rig.landmarks.head, [1.5, 4, -2]);
  assert.equal(Object.hasOwn(rig.landmarks, 'landmark'), false);
  assert.throws(() => updateRigLandmark(rig, 'head', { name: 'landmark-2' }), /unique/);
  assert.throws(() => updateRigLandmark(rig, 'head', { name: 'invalid name' }), /valid IDs/);
  assert.throws(() => updateRigLandmark(rig, 'head', { name: '' }), /valid IDs/);
  assert.throws(() => updateRigLandmark(rig, 'head', { position: [Infinity, 0, 0] }), /finite/);
  assert.throws(() => updateRigLandmark(rig, 'head', { position: [100_001, 0, 0] }), /100000/);
  assert.throws(() => updateRigLandmark(rig, 'missing', { position: [0, 0, 0] }), /not found/);

  const project = newProject('rig-landmarks', 'Rig landmarks');
  project.assets.push(asset);
  const committed = applyProjectOperations(project, [{ type: 'asset.put', asset: { ...asset, rig } }]);
  const shared = validateProject(JSON.parse(JSON.stringify(committed)));
  assert.deepEqual(shared.assets[0].rig?.landmarks, rig.landmarks);

  rig = removeRigLandmark(rig, 'head');
  assert.equal(Object.hasOwn(rig.landmarks, 'head'), false);
  assert.deepEqual(rig.landmarks, {
    torsoMin: [0, 0, 0],
    torsoMax: [1, 2, 1],
    'landmark-2': [0, 0, 0],
  });
  assert.deepEqual(asset.rig!.landmarks, { torsoMin: [0, 0, 0], torsoMax: [1, 2, 1] });
  assert.throws(() => removeRigLandmark(rig, 'head'), /not found/);
});

test('reparenting a joint rejects descendant cycles before changing the rig', () => {
  const asset = riggedAsset();
  assert.throws(() => setRigJointParent(asset.rig!, 'arm', 'hand'), /create a cycle/);
  assert.throws(() => setRigJointParent(asset.rig!, 'arm', 'missing'), /Parent joint not found/);

  const nextRig = setRigJointParent(asset.rig!, 'hand', 'root');
  assert.equal(nextRig.joints.find((joint) => joint.name === 'hand')?.parent, 'root');
  assert.equal(
    validateProject({ ...newProject('rig-parent', 'Rig parent'), assets: [{ ...asset, rig: nextRig }] })
      .assets[0].rig?.joints.length,
    3,
  );
  assert.equal(asset.rig!.joints.find((joint) => joint.name === 'hand')?.parent, 'arm');
});

test('native clip and keyframe edits stay ordered, bounded and schema-valid', () => {
  let rig = addRigClip(riggedAsset().rig!);
  assert.deepEqual(rig.clips.at(-1), {
    name: 'clip',
    duration: 1,
    loop: true,
    speed: 0,
    blendIn: 0.12,
    tracks: [],
    events: [],
  });

  rig = addRigTrack(rig, 'clip', 'arm');
  rig = addRigKeyframe(rig, 'clip', 'arm');
  rig = updateRigKeyframe(rig, 'clip', 'arm', 1, {
    time: 0.75,
    rotation: [0, 1, 0],
    position: [2, 0, 0],
  });
  rig = {
    ...rig,
    clips: rig.clips.map((entry) =>
      entry.name === 'clip' ? { ...entry, events: [{ time: 0.25, name: 'footstep' }] } : entry,
    ),
  };
  const clip = rig.clips.find((entry) => entry.name === 'clip')!;
  assert.deepEqual(
    clip.tracks[0].keys.map((key) => key.time),
    [0, 0.75],
  );
  assert.deepEqual(clip.events, [{ time: 0.25, name: 'footstep' }]);
  assert.throws(() => updateRigKeyframe(rig, 'clip', 'arm', 1, { time: 0 }), /same time/);
  assert.throws(() => updateRigClipSettings(rig, 'clip', { duration: 0.5 }), /Move keys and markers/);
  assert.throws(() => addRigTrack(rig, 'clip', 'arm'), /already has a track/);

  rig = updateRigClipSettings(rig, 'clip', { speed: 2, loop: false });
  assert.equal(rig.clips.find((entry) => entry.name === 'clip')?.speed, 2);
  assert.equal(
    validateProject({ ...newProject('rig-clips', 'Rig clips'), assets: [{ ...riggedAsset(), rig }] }).assets
      .length,
    1,
  );
});

test('inserts a sampled keyframe into an imported end-to-end track without changing its source keys', () => {
  const source = riggedAsset();
  const importedRig = structuredClone(source.rig!);
  const importedClip = importedRig.clips[0];
  importedClip.duration = 2;
  importedClip.blendIn = 0;
  importedClip.tracks[0].keys = [
    { time: 0, rotation: [0, 0, 0], position: [0, 0, 0], interpolation: 'linear' },
    { time: 2, rotation: [0, Math.PI / 2, 0], position: [2, 0, 0] },
  ];
  const imported = assetSchema.parse({ ...source, rig: importedRig });
  const originalRig = structuredClone(imported.rig!);
  const nextRig = addRigKeyframe(imported.rig!, importedClip.name, 'arm');
  const inserted = nextRig.clips[0].tracks[0].keys;

  assert.deepEqual(imported.rig, originalRig, 'inserting a key does not mutate the imported source');
  assert.deepEqual(
    inserted.map((key) => key.time),
    [0, 1, 2],
  );
  assert.deepEqual(inserted[0], originalRig.clips[0].tracks[0].keys[0]);
  assert.deepEqual(inserted[2], originalRig.clips[0].tracks[0].keys[1]);
  assert.deepEqual(inserted[1].position, [1, 0, 0]);
  assert.equal(inserted[1].interpolation, 'linear');
  const expectedRotation = new Euler().setFromQuaternion(
    new Quaternion()
      .setFromEuler(new Euler(...inserted[0].rotation))
      .slerp(new Quaternion().setFromEuler(new Euler(...inserted[2].rotation)), 0.5),
  );
  assert.ok(Math.abs(inserted[1].rotation[0] - expectedRotation.x) < 1e-8);
  assert.ok(Math.abs(inserted[1].rotation[1] - expectedRotation.y) < 1e-8);
  assert.ok(Math.abs(inserted[1].rotation[2] - expectedRotation.z) < 1e-8);

  for (const interpolation of ['smooth', 'step'] as const) {
    const modeRig = structuredClone(originalRig);
    modeRig.clips[0].tracks[0].keys[0].interpolation = interpolation;
    const modeKeys = addRigKeyframe(modeRig, importedClip.name, 'arm').clips[0].tracks[0].keys;
    assert.equal(modeKeys[1].interpolation, interpolation);
    if (interpolation === 'step') {
      assert.deepEqual(modeKeys[1].rotation, modeKeys[0].rotation);
      assert.deepEqual(modeKeys[1].position, modeKeys[0].position);
    }
  }

  const originalVisual = createAssetVisual(imported);
  const insertedVisual = createAssetVisual({ ...imported, rig: nextRig });
  for (const time of [0.25, 0.75, 1.25, 1.75]) {
    originalVisual.animate(importedClip.name, time);
    insertedVisual.animate(importedClip.name, time);
    const originalBone = originalVisual.bones.get('arm')!;
    const insertedBone = insertedVisual.bones.get('arm')!;
    assert.ok(originalBone.quaternion.angleTo(insertedBone.quaternion) < 1e-8);
    assert.ok(Math.abs(originalBone.position.x - insertedBone.position.x) < 1e-8);
    assert.ok(Math.abs(originalBone.position.y - insertedBone.position.y) < 1e-8);
    assert.ok(Math.abs(originalBone.position.z - insertedBone.position.z) < 1e-8);
  }

  const project = validateProject({ ...newProject('rig-keyframe', 'Rig keyframe'), assets: [imported] });
  const html = renderToStaticMarkup(
    React.createElement(RigEditor, {
      asset: imported,
      project,
      json: JSON.stringify(imported.rig),
      onJsonChange: () => {},
      onChange: () => {},
    }),
  );
  assert.match(html, /<button type="button">\+ Add keyframe<\/button>/);
});

test('adds one-key tracks safely and rejects schema-invalid empty tracks without mutation', () => {
  const oneKeyRig = structuredClone(riggedAsset().rig!);
  oneKeyRig.clips[0].tracks[0].keys = [{ time: 1, rotation: [0, Math.PI / 4, 0], interpolation: 'smooth' }];
  const originalOneKeyRig = structuredClone(oneKeyRig);
  const added = addRigKeyframe(oneKeyRig, oneKeyRig.clips[0].name, 'arm');
  assert.deepEqual(oneKeyRig, originalOneKeyRig);
  assert.deepEqual(
    added.clips[0].tracks[0].keys.map((key) => key.time),
    [0.5, 1],
  );
  assert.deepEqual(added.clips[0].tracks[0].keys[0].rotation, [0, Math.PI / 4, 0]);
  assert.equal(added.clips[0].tracks[0].keys[0].interpolation, 'smooth');

  const emptyTrackRig = structuredClone(oneKeyRig) as Rig;
  emptyTrackRig.clips[0].tracks[0].keys = [];
  const originalEmptyTrackRig = structuredClone(emptyTrackRig);
  assert.throws(
    () => addRigKeyframe(emptyTrackRig, emptyTrackRig.clips[0].name, 'arm'),
    /at least one keyframe/,
  );
  assert.deepEqual(emptyTrackRig, originalEmptyTrackRig);
});

test('native marker edits stay ordered, within clip duration and inside the schema limit', () => {
  let rig = addRigClip(riggedAsset().rig!);
  rig = addRigMarker(rig, 'clip');
  rig = addRigMarker(rig, 'clip');
  assert.deepEqual(rig.clips.at(-1)?.events, [
    { time: 0.5, name: 'marker' },
    { time: 0.75, name: 'marker-2' },
  ]);

  rig = updateRigMarker(rig, 'clip', 0, { time: 1, name: 'release' });
  assert.deepEqual(rig.clips.at(-1)?.events, [
    { time: 0.75, name: 'marker-2' },
    { time: 1, name: 'release' },
  ]);
  assert.throws(() => updateRigMarker(rig, 'clip', 0, { time: -0.01 }), /within the clip duration/);
  assert.throws(() => updateRigMarker(rig, 'clip', 0, { time: 1.01 }), /within the clip duration/);
  assert.throws(() => updateRigMarker(rig, 'clip', 0, { name: 'invalid marker' }), /valid IDs/);
  assert.throws(() => updateRigMarker(rig, 'clip', 2, { time: 0 }), /marker not found/);

  rig = removeRigMarker(rig, 'clip', 0);
  assert.deepEqual(rig.clips.at(-1)?.events, [{ time: 1, name: 'release' }]);
  assert.throws(() => removeRigMarker(rig, 'clip', 1), /marker not found/);
  assert.equal(
    validateProject({ ...newProject('rig-markers', 'Rig markers'), assets: [{ ...riggedAsset(), rig }] })
      .assets.length,
    1,
  );

  const fullRig = {
    ...rig,
    clips: rig.clips.map((clip) =>
      clip.name === 'clip'
        ? {
            ...clip,
            events: Array.from({ length: 256 }, (_, index) => ({
              time: index / 255,
              name: `marker-${index}`,
            })),
          }
        : clip,
    ),
  };
  assert.equal(fullRig.clips.find((clip) => clip.name === 'clip')?.events.length, 256);
  assert.throws(() => addRigMarker(fullRig, 'clip'), /at most 256 markers/);
});

test('clip deletion and renaming protect scene animation references', () => {
  const asset = riggedAsset();
  const base = addRigClip(asset.rig!);
  const rig = {
    ...base,
    clips: base.clips.map((clip) =>
      clip.name === 'clip' ? { ...clip, events: [{ time: 0.5, name: 'footstep' }] } : clip,
    ),
  };
  const project = newProject('rig-clip-use', 'Rig clip use');
  project.assets.push({ ...asset, rig });
  project.scenes[0].nodes.push({
    id: 'actor',
    name: 'Actor',
    assetId: asset.id,
    transform: identityTransform(),
    enabled: true,
    components: [
      { type: 'animation', idle: 'clip', moving: 'wave' },
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'animation',
            marker: 'footstep',
            interval: 1,
            once: false,
            actions: [{ type: 'set', variable: 'steps', value: 1 }],
          },
        ],
      },
    ],
    attachments: [],
    parentId: null,
  });
  const uses = animationClipUseCount(project, asset.id, 'clip');
  assert.equal(uses, 2);
  assert.throws(() => renameRigClip(rig, 'clip', 'emote', uses), /scene animation and marker references/);
  assert.throws(() => removeRigClip(rig, 'clip', uses), /scene animation and marker references/);
  assert.equal(renameRigClip(rig, 'clip', 'emote', 0).clips.at(-1)?.name, 'emote');
  assert.equal(removeRigClip(rig, 'clip', 0).clips.length, rig.clips.length - 1);
});

test('run and action clip references protect scene actors and prefab templates from destructive edits', () => {
  const asset = riggedAsset();
  const project = newProject('rig-action-uses', 'Action uses');
  const rig = addRigClip(asset.rig!);
  project.assets.push({ ...asset, rig });
  for (const field of ['running', 'jumping', 'attacking'] as const) {
    const actor = {
      id: 'actor',
      name: 'Actor',
      assetId: asset.id,
      parentId: null,
      transform: identityTransform(),
      enabled: true,
      attachments: [],
      components: [{ type: 'animation' as const, idle: 'idle', moving: 'walk', [field]: 'CLIP' }],
    };
    project.scenes[0].nodes = [actor];
    project.prefabs = [
      {
        id: 'template',
        name: 'Template',
        rootId: actor.id,
        attachmentParentId: null,
        nodes: [structuredClone(actor)],
      },
    ];
    const uses = animationClipUseCount(project, asset.id, 'clip');
    assert.equal(uses, 2, `${field} references in scenes and prefabs are case-insensitive`);
    assert.throws(() => removeRigClip(rig, 'clip', uses), /references/);
    assert.throws(() => renameRigClip(rig, 'clip', 'replacement', uses), /references/);
  }
});

test('authored keyframes produce the expected interpolated rig pose', () => {
  let rig = addRigClip(riggedAsset().rig!);
  rig = addRigTrack(rig, 'clip', 'arm');
  rig = addRigKeyframe(rig, 'clip', 'arm');
  rig = updateRigKeyframe(rig, 'clip', 'arm', 1, {
    time: 1,
    rotation: [0, 1, 0],
    position: [2, 0, 0],
  });
  const visual = createAssetVisual({ ...riggedAsset(), rig });
  visual.animate('clip', 0.5);
  const arm = visual.bones.get('arm');
  assert.ok(arm);
  assert.ok(Math.abs(arm.rotation.y - 0.5) < 1e-6);
  assert.ok(Math.abs(arm.position.x - 2) < 1e-6);
});

test('renaming a joint updates every authored reference without dropping clips or rig fields', () => {
  const asset = riggedAsset();
  const next = renameRigJoint(asset, 'arm', 'forearm');
  assert.deepEqual(
    next.rig!.joints.map((joint) => joint.parent),
    [null, 'root', 'forearm'],
  );
  assert.equal(next.rig!.joints[1].name, 'forearm');
  assert.equal(next.rig!.sockets[0].joint, 'hand');
  assert.equal(next.rig!.clips[0].tracks[0].joint, 'forearm');
  assert.equal(next.rig!.clips[0].tracks[0].keys[0].time, 0);
  assert.deepEqual(next.rig!.landmarks, asset.rig!.landmarks);
  assert.deepEqual(
    next.model.voxels,
    asset.model.voxels,
    'renaming a different bone leaves model weights untouched',
  );

  const weighted = {
    ...asset,
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0xffffff, bone: 'arm', weights: [{ bone: 'arm', weight: 1 }] },
    ]),
  };
  const renamed = renameRigJoint(weighted, 'arm', 'forearm');
  assert.equal(renamed.model.voxels[0].bone, 'forearm');
  assert.deepEqual(renamed.model.voxels[0].weights, [{ bone: 'forearm', weight: 1 }]);
  assert.throws(() => renameRigJoint(asset, 'arm', 'hand'), /unique/);
});

test('joint removal protects dependent data and reparents children when safe', () => {
  const asset = riggedAsset();
  assert.match(jointRemovalBlock(asset, 'hand')!, /sockets/);
  assert.match(jointRemovalBlock(asset, 'arm')!, /Animation clips/);
  const withoutSocket = { ...asset, rig: { ...asset.rig!, sockets: [] } };
  assert.match(jointRemovalBlock(withoutSocket, 'arm')!, /Animation clips/);
  const withoutTrack = {
    ...withoutSocket,
    rig: { ...withoutSocket.rig!, clips: [{ ...withoutSocket.rig!.clips[0], tracks: [] }] },
  };
  assert.equal(jointRemovalBlock(withoutTrack, 'arm'), null);
  const removed = removeRigJoint(withoutTrack, 'arm');
  assert.deepEqual(
    removed.rig!.joints.map((joint) => [joint.name, joint.parent]),
    [
      ['root', null],
      ['hand', 'root'],
    ],
  );
  assert.match(
    jointRemovalBlock({ ...removed, rig: { ...removed.rig!, joints: [removed.rig!.joints[0]] } }, 'root')!,
    /at least one/,
  );

  const weighted = {
    ...withoutTrack,
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0xffffff, weights: [{ bone: 'arm', weight: 1 }] },
    ]),
  };
  assert.match(jointRemovalBlock(weighted, 'arm')!, /weighted/);
});

test('socket use counting keeps scene and fitted-equipment references discoverable', () => {
  const project = newProject('rig-test', 'Rig test');
  const body = riggedAsset();
  project.assets.push(body);
  project.scenes[0].nodes.push({
    id: 'wearer',
    name: 'Wearer',
    assetId: body.id,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components: [],
    attachments: [
      { assetId: 'sword', socket: 'hand', slot: 'weapon', transform: identityTransform(), hiddenBones: [] },
    ],
    parentId: null,
  });
  project.assets.push(
    assetSchema.parse({
      ...riggedAsset(),
      id: 'sword',
      name: 'Sword',
      equipment: {
        bodyAssetId: body.id,
        profile: 'humanoid',
        profileVersion: 1,
        kind: 'blade',
        socket: 'hand',
        hiddenBones: [],
      },
    }),
  );
  assert.equal(socketUseCount(project, body.id, 'hand'), 2);
  assert.equal(socketUseCount(project, body.id, 'unknown'), 0);
});

test('advanced rig JSON is checked while native controls expose landmarks, joints and sockets accessibly', () => {
  const asset = riggedAsset();
  const markerAsset = {
    ...asset,
    rig: {
      ...asset.rig!,
      clips: asset.rig!.clips.map((clip) => ({ ...clip, events: [{ time: 0.5, name: 'footstep' }] })),
    },
  };
  assert.deepEqual(parseRigJson(JSON.stringify(asset.rig)), asset.rig);
  assert.equal(parseRigJson('null'), null);
  assert.throws(() => parseRigJson('{'), /JSON/);
  assert.throws(() => parseRigJson('{"profile":"bad profile"}'), /profile/);

  const project = newProject('rig-test', 'Rig test');
  project.assets.push(markerAsset);
  project.scenes[0].nodes.push({
    id: 'wearer',
    name: 'Wearer',
    assetId: asset.id,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components: [],
    attachments: [
      { assetId: 'sword', socket: 'hand', slot: 'weapon', transform: identityTransform(), hiddenBones: [] },
    ],
    parentId: null,
  });
  project.assets.push(
    assetSchema.parse({
      ...riggedAsset(),
      id: 'sword',
      name: 'Sword',
      equipment: {
        bodyAssetId: asset.id,
        profile: 'humanoid',
        profileVersion: 1,
        kind: 'blade',
        socket: 'hand',
        hiddenBones: [],
      },
    }),
  );
  const validated = validateProject(project);
  const html = renderToStaticMarkup(
    React.createElement(RigEditor, {
      asset: markerAsset,
      project: validated,
      json: JSON.stringify(markerAsset.rig),
      onJsonChange: () => {},
      onChange: () => {},
    }),
  );
  assert.match(html, /Joint 1 name/);
  assert.match(html, /Joint hand bind position X/);
  assert.match(html, /aria-label="Rig landmarks"/);
  assert.match(html, /aria-label="Landmark torsoMin name"/);
  assert.match(html, /Landmark torsoMin position X/);
  assert.match(html, /aria-label="Remove landmark torsoMin"/);
  assert.match(html, /\+ Add landmark/);
  assert.match(html, /Attached joint/);
  assert.match(html, /Socket hand rotation Y/);
  assert.match(html, /Animation clips/);
  assert.match(html, /Preview animation clip/);
  assert.match(html, /Interpolation to next key/);
  assert.match(html, /Smooth ease in\/out/);
  assert.match(html, /Add walk motion/);
  assert.match(html, /Animation markers/);
  assert.match(html, /Marker name/);
  assert.match(html, /Marker time \(seconds\)/);
  assert.match(html, /Remove marker/);
  assert.match(html, /\+ Add marker/);
  assert.match(html, /Keyframe time \(seconds\)/);
  assert.match(html, /Rotation \(radians\)/);
  assert.match(html, /Add position offset \(local voxels\)/);
  assert.match(html, /Add joint track/);
  assert.match(html, /Advanced rig JSON/);
  assert.doesNotMatch(html, /marker events, landmarks/);
  assert.match(html, /disabled="" title="This joint list is shared with fitted equipment/);
  assert.match(html, /disabled="" title="Change attached equipment references first\./);

  const cappedAsset = {
    ...markerAsset,
    rig: {
      ...markerAsset.rig!,
      clips: markerAsset.rig!.clips.map((clip) => ({
        ...clip,
        events: Array.from({ length: 256 }, (_, index) => ({ time: index / 255, name: `marker-${index}` })),
      })),
    },
  };
  const cappedHtml = renderToStaticMarkup(
    React.createElement(RigEditor, {
      asset: cappedAsset,
      project: validated,
      json: JSON.stringify(cappedAsset.rig),
      onJsonChange: () => {},
      onChange: () => {},
    }),
  );
  assert.match(cappedHtml, /<button type="button" disabled="">\+ Add marker<\/button>/);
});
