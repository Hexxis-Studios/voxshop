import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { createAssetVisual } from '../runtime/assetMesh';
import { createModelDocument } from '../services/modelDocument';
import { assetSchema, type Asset } from '../services/projectDocument';

function animatedAsset(): Asset {
  return assetSchema.parse({
    id: 'animated',
    name: 'Animated',
    model: createModelDocument([
      { x: 0, y: 0, z: 0, color: 0xffffff, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
    ]),
    rig: {
      profile: 'humanoid',
      version: 1,
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'arm', parent: 'root', position: [0, 1, 0] },
      ],
      clips: [
        {
          name: 'wave',
          duration: 1,
          loop: true,
          tracks: [
            {
              joint: 'arm',
              keys: [
                { time: 1, rotation: [0, 1, 0], position: [2, 0, 0] },
                { time: 0, rotation: [0, 0, 0], position: [0, 0, 0] },
              ],
            },
          ],
        },
      ],
    },
  });
}

test('animation tracks are sorted once per rig and sampled without per-frame copies', () => {
  const asset = animatedAsset();
  const track = asset.rig!.clips[0].tracks[0];
  let keyCopies = 0;
  track.keys = new Proxy(track.keys, {
    get(target, property, receiver) {
      if (property === 'slice') keyCopies++;
      return Reflect.get(target, property, receiver);
    },
  });

  const visual = createAssetVisual(asset);
  visual.animate('WAVE', 0.25);
  visual.animate('wave', 0.5);
  visual.animate('wave', 0.75);

  assert.equal(keyCopies, 1, 'the unsorted track is copied and sorted only when prepared');
  assert.ok(Math.abs(visual.bones.get('arm')!.rotation.y - 0.75) < 1e-6);
  assert.ok(Math.abs(visual.bones.get('arm')!.position.x - 1.5) < 1e-6);
});

test('animation keys apply as local deltas from each joint bind rotation', () => {
  const asset = animatedAsset();
  asset.rig!.joints.find((joint) => joint.name === 'arm')!.rotation = [0, Math.PI / 2, 0];
  const visual = createAssetVisual(asset),
    rest = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)),
    delta = new Quaternion().setFromEuler(new Euler(0, 0.5, 0)),
    expected = rest.clone().multiply(delta);

  visual.animate('wave', 0.5);

  assert.ok(
    1 - Math.abs(visual.bones.get('arm')!.quaternion.dot(expected)) < 1e-6,
    'the sampled animation is composed with the authored local bind orientation',
  );
});

test('animation keys support smooth easing and held poses while preserving linear legacy defaults', () => {
  const smoothAsset = animatedAsset();
  smoothAsset.rig!.clips[0].tracks[0].keys.find((key) => key.time === 0)!.interpolation = 'smooth';
  const smoothVisual = createAssetVisual(smoothAsset);
  smoothVisual.animate('wave', 0.25);
  assert.ok(Math.abs(smoothVisual.bones.get('arm')!.rotation.y - 0.15625) < 1e-6);
  assert.ok(Math.abs(smoothVisual.bones.get('arm')!.position.x - 0.3125) < 1e-6);

  const heldAsset = animatedAsset();
  heldAsset.rig!.clips[0].tracks[0].keys.find((key) => key.time === 0)!.interpolation = 'step';
  const heldVisual = createAssetVisual(heldAsset);
  heldVisual.animate('wave', 0.75);
  assert.ok(Math.abs(heldVisual.bones.get('arm')!.rotation.y) < 1e-6);
  assert.ok(Math.abs(heldVisual.bones.get('arm')!.position.x) < 1e-6);
});

test('clip transitions crossfade the current pose with a per-clip blend duration', () => {
  const asset = animatedAsset();
  asset.rig!.clips.push({
    name: 'rest',
    duration: 1,
    loop: false,
    speed: 0,
    blendIn: 0.2,
    tracks: [],
    events: [],
  });
  const visual = createAssetVisual(asset);
  visual.animate('wave', 0.75);
  const moving = visual.bones.get('arm')!.quaternion.clone();
  const movingPosition = visual.bones.get('arm')!.position.clone();

  visual.animate('rest', 0);
  assert.ok(1 - Math.abs(visual.bones.get('arm')!.quaternion.dot(moving)) < 1e-6);
  assert.ok(visual.bones.get('arm')!.position.distanceTo(movingPosition) < 1e-6);

  visual.animate('rest', 0.1);
  const halfway = new Quaternion().setFromEuler(new Euler(0, 0.375, 0));
  assert.ok(1 - Math.abs(visual.bones.get('arm')!.quaternion.dot(halfway)) < 1e-6);
  assert.ok(Math.abs(visual.bones.get('arm')!.position.x - 0.75) < 1e-6);

  visual.animate('rest', 0.2);
  assert.ok(Math.abs(visual.bones.get('arm')!.quaternion.y) < 1e-6);
  assert.ok(Math.abs(visual.bones.get('arm')!.position.x) < 1e-6);
});

test('rotation interpolation takes the short quaternion path across the Euler wrap boundary', () => {
  const asset = animatedAsset();
  asset.rig!.clips[0].tracks[0].keys = [
    { time: 0, rotation: [0, Math.PI - 0.1, 0] },
    { time: 1, rotation: [0, -Math.PI + 0.1, 0] },
  ];
  const visual = createAssetVisual(asset);
  visual.animate('wave', 0.5);
  const rotation = visual.bones.get('arm')!.quaternion;
  assert.ok(
    Math.abs(rotation.y) > 0.99 && Math.abs(rotation.w) < 0.01,
    'Expected the shortest path through a half turn.',
  );
});

test('animated rig bounds conservatively contain weighted vertices and remain frustum culled', () => {
  const asset = animatedAsset();
  asset.model = createModelDocument([
    {
      x: 12,
      y: 2,
      z: -3,
      color: 0xffffff,
      weights: [
        { bone: 'root', weight: 0.35 },
        { bone: 'arm', weight: 0.65 },
      ],
    },
  ]);
  asset.rig!.clips[0].tracks.push({
    joint: 'root',
    keys: [
      { time: 0, rotation: [0, 0, 0], position: [0, 0, 0] },
      { time: 1, rotation: [0.5, 0.2, 0.1], position: [3, -1, 2] },
    ],
  });

  const visual = createAssetVisual(asset);
  const mesh = visual.group.children[0] as SkinnedMesh;
  assert.equal(mesh.frustumCulled, true);
  assert.ok(mesh.boundingSphere && mesh.boundingSphere.radius > 10);

  for (const time of [0, 0.1, 0.25, 0.5, 0.75, 0.99]) {
    visual.animate('wave', time);
    visual.group.updateMatrixWorld(true);
    mesh.skeleton.update();
    const vertex = new Vector3();
    for (let index = 0; index < mesh.geometry.getAttribute('position').count; index++) {
      mesh.getVertexPosition(index, vertex);
      assert.ok(
        vertex.distanceTo(mesh.boundingSphere!.center) <= mesh.boundingSphere!.radius + 1e-5,
        `vertex ${index} at animation time ${time} exceeded the conservative sphere`,
      );
    }
  }
});

test('animated rig bounds include bent descendant chains when an ancestor rotates', () => {
  const asset = assetSchema.parse({
    id: 'bent-rig',
    name: 'Bent rig',
    model: createModelDocument([
      {
        x: 8,
        y: 8,
        z: 0,
        color: 0xffffff,
        weights: [{ bone: 'arm', weight: 1 }],
      },
    ]),
    rig: {
      profile: 'humanoid',
      version: 1,
      joints: [
        { name: 'root', parent: null, position: [8, 0, 0] },
        { name: 'arm', parent: 'root', position: [8, 8, 0] },
      ],
      clips: [
        {
          name: 'turn',
          duration: 1,
          loop: false,
          tracks: [
            {
              joint: 'root',
              keys: [
                { time: 0, rotation: [0, 0, 0] },
                { time: 1, rotation: [0, 0, -Math.PI / 2] },
              ],
            },
          ],
        },
      ],
    },
  });
  const visual = createAssetVisual(asset);
  const mesh = visual.group.children[0] as SkinnedMesh;
  visual.animate('turn', 1);
  visual.group.updateMatrixWorld(true);
  mesh.skeleton.update();

  const vertex = new Vector3();
  for (let index = 0; index < mesh.geometry.getAttribute('position').count; index++) {
    mesh.getVertexPosition(index, vertex);
    assert.ok(
      vertex.distanceTo(mesh.boundingSphere!.center) <= mesh.boundingSphere!.radius + 1e-5,
      `vertex ${index} exceeded the bent-chain culling sphere`,
    );
  }
});
