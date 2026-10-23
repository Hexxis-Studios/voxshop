import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { sceneSchema } from '../services/projectDocument';
import {
  MAX_RAPIER_SNAPSHOT_BYTES,
  RapierPhysics,
  type PhysicsCollisionEvent,
  type PhysicsMotion,
  type PhysicsPose,
  type PhysicsTerrainSource,
} from '../runtime/RapierPhysics';
import { worldDocumentSchema, type WorldDocument } from '../services/worldDocument';

async function makeBody(
  bodyType: 'dynamic' | 'fixed' | 'kinematic-position' | 'kinematic-velocity',
  options: Record<string, unknown> = {},
  position: [number, number, number] = [0, 0, 0],
  rotation = new Quaternion(),
  terrain?: PhysicsTerrainSource,
) {
  const scene = sceneSchema.parse({
    id: 'physics-motion-scene',
    name: 'Physics motion scene',
    bounds: 20,
    nodes: [
      {
        id: 'body',
        name: 'Body',
        assetId: null,
        parentId: null,
        transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
        enabled: true,
        components: [
          { type: 'collider', size: [1, 1, 1], solid: true },
          { type: 'rigid-body', bodyType, ...options },
        ],
        attachments: [],
      },
    ],
  });
  const node = scene.nodes[0];
  let worldMatrix = new Matrix4().compose(new Vector3(...position), rotation, new Vector3(1, 1, 1));
  const physics = await RapierPhysics.create(scene, () => worldMatrix, true, false, terrain);
  return {
    physics,
    setPose(pose: PhysicsPose) {
      worldMatrix = new Matrix4().compose(pose.position, pose.rotation, new Vector3(1, 1, 1));
    },
    pose() {
      const result = { position: new Vector3(), rotation: new Quaternion(), scale: new Vector3() };
      worldMatrix.decompose(result.position, result.rotation, result.scale);
      return result;
    },
    step(deltaSeconds: number) {
      const poses = physics.step(deltaSeconds);
      const pose = poses.get(node.id);
      if (pose) this.setPose(pose);
      return pose;
    },
  };
}

function flatPhysicsTerrain(): WorldDocument {
  return worldDocumentSchema.parse({
    id: 'physics-terrain',
    name: 'Physics terrain',
    seed: 1,
    chunkSize: 16,
    voxelSize: 1,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-64, -64],
      size: [128, 128],
      minY: -4,
      maxY: 4,
      baseHeight: 0,
      amplitude: 0,
      noise: 0,
      palette: {
        surface: 0x55aa55,
        subsurface: 0x886644,
        deep: 0x554433,
        surfaceDepth: 1,
        subsurfaceDepth: 1,
        materialType: 'STANDARD',
      },
    },
    edits: [],
  });
}

test('Rapier rigid bodies collide with nearby terrain and terrain edits refresh snapshot-safe colliders', async () => {
  let surfaceY = 0;
  const world = flatPhysicsTerrain(),
    terrain: PhysicsTerrainSource = {
      world,
      cellAt: ({ x, y, z }) =>
        x >= -64 && x < 64 && z >= -64 && z < 64 && y >= -4 && y <= surfaceY
          ? { color: 0x55aa55, materialType: 'STANDARD' }
          : undefined,
      surfaceAt: () => surfaceY,
      smoothSurface: false,
    },
    options = { gravity: 9.81, linearDamping: 0, restitution: 0, canSleep: false },
    falling = await makeBody('dynamic', options, [0, 4, 0], new Quaternion(), terrain);
  try {
    for (let frame = 0; frame < 240; frame++) falling.step(1 / 60);
    assert.ok(
      Math.abs(falling.pose().position.y - 1) < 0.02,
      `The box should rest on the generated top cell, got y=${falling.pose().position.y}.`,
    );
    const snapshot = falling.physics.captureSnapshot();
    assert.ok(
      snapshot?.terrainBodyHandle !== undefined,
      'Terrain handles are included with the physics snapshot.',
    );
    const landedY = falling.pose().position.y;
    falling.physics.dispose();

    const resumed = await makeBody('dynamic', options, [0, landedY, 0], new Quaternion(), terrain);
    try {
      assert.equal(
        resumed.physics.restoreSnapshot(snapshot),
        true,
        'The terrain collider map can be rebound.',
      );
      surfaceY = -1;
      let editedWorld = world;
      for (let z = -1; z <= 1; z++)
        for (let x = -1; x <= 1; x++) {
          const edit = { x, y: 0, z, value: null };
          editedWorld = { ...editedWorld, edits: [...editedWorld.edits, edit] };
          resumed.physics.updateTerrain(editedWorld, edit);
        }
      for (let frame = 0; frame < 60; frame++) resumed.step(1 / 60);
      assert.ok(
        Math.abs(resumed.pose().position.y) < 0.03,
        'The body settles on the newly exposed lower cells.',
      );
      surfaceY = 0;
      const moved = new Vector3(33, 4, 0);
      resumed.physics.setBodyPose('body', moved);
      resumed.setPose({ position: moved, rotation: new Quaternion(), previousPosition: moved.clone() });
      for (let frame = 0; frame < 60; frame++) resumed.step(1 / 60);
      assert.ok(
        Math.abs(resumed.pose().position.y - 1) < 0.03,
        `Terrain chunks stream around a body in a new region, got y=${resumed.pose().position.y}.`,
      );
    } finally {
      resumed.physics.dispose();
    }
  } finally {
    falling.physics.dispose();
  }
});

test('read-only physics queries return nearest ray hits and filtered oriented-shape overlaps', async () => {
  const scene = sceneSchema.parse({
    id: 'physics-query-scene',
    name: 'Physics query scene',
    bounds: 20,
    nodes: [
      {
        id: 'sensor',
        name: 'Sensor',
        transform: { position: [1.5, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ type: 'collider', size: [1, 1, 1], solid: false, sensor: true }],
      },
      {
        id: 'wall',
        name: 'Wall',
        transform: { position: [4, 5, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
        components: [{ type: 'collider', size: [1, 2, 2], solid: true }],
      },
      {
        id: 'far-wall',
        name: 'Far wall',
        transform: { position: [8, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ type: 'collider', size: [1, 2, 2], solid: true }],
      },
    ],
  });
  const physics = await RapierPhysics.create(
    scene,
    (node) =>
      new Matrix4().compose(
        new Vector3(...node.transform.position),
        new Quaternion().setFromEuler(new Euler(...node.transform.rotation)),
        new Vector3(...node.transform.scale),
      ),
    true,
  );
  try {
    const wallHit = physics.query({
        shape: 'ray',
        origin: [0, 5, 0],
        direction: [10, 0, 0],
        maxDistance: 20,
        includeSensors: false,
        excludeNodeIds: [],
      }),
      sensorHit = physics.query({
        shape: 'ray',
        origin: [0, 5, 0],
        direction: [1, 0, 0],
        maxDistance: 20,
        includeSensors: true,
        excludeNodeIds: [],
      }),
      overlaps = physics.query({
        shape: 'capsule',
        position: [1.5, 5, 0],
        radius: 0.25,
        halfHeight: 0.4,
        rotation: [0, 0, 0, 1],
        includeSensors: true,
        excludeNodeIds: [],
      }),
      boxOverlap = physics.query({
        shape: 'box',
        position: [4, 5, 0],
        size: [1.5, 2.5, 2.5],
        rotation: [0, 0, 0, 1],
        includeSensors: false,
        excludeNodeIds: [],
      }),
      sphereOverlap = physics.query({
        shape: 'sphere',
        position: [8, 5, 0],
        radius: 0.3,
        includeSensors: false,
        excludeNodeIds: [],
      }),
      sphereCast = physics.query({
        shape: 'shape-cast',
        castShape: { shape: 'sphere', radius: 0.25 },
        position: [0, 5, 0],
        direction: [10, 0, 0],
        maxDistance: 20,
        includeSensors: false,
        excludeNodeIds: [],
      }),
      capsuleCast = physics.query({
        shape: 'shape-cast',
        castShape: {
          shape: 'capsule',
          radius: 0.25,
          halfHeight: 0.4,
          rotation: [0, 0, 0, 1],
        },
        position: [0, 5, 0],
        direction: [1, 0, 0],
        maxDistance: 20,
        includeSensors: false,
        excludeNodeIds: [],
      }),
      boxCast = physics.query({
        shape: 'shape-cast',
        castShape: {
          shape: 'box',
          size: [0.5, 0.5, 0.5],
          rotation: [0, 0, 0, 1],
        },
        position: [0, 5, 0],
        direction: [1, 0, 0],
        maxDistance: 20,
        includeSensors: false,
        excludeNodeIds: [],
      });
    assert.equal(wallHit.available && wallHit.shape === 'ray' ? wallHit.hit?.nodeId : null, 'wall');
    assert.equal(wallHit.available && wallHit.shape === 'ray' ? wallHit.hit?.distance : null, 3);
    assert.equal(sensorHit.available && sensorHit.shape === 'ray' ? sensorHit.hit?.nodeId : null, 'sensor');
    assert.deepEqual(overlaps.available && overlaps.shape === 'capsule' ? overlaps.nodeIds : [], ['sensor']);
    assert.deepEqual(boxOverlap.available && boxOverlap.shape === 'box' ? boxOverlap.nodeIds : [], ['wall']);
    assert.deepEqual(
      sphereOverlap.available && sphereOverlap.shape === 'sphere' ? sphereOverlap.nodeIds : [],
      ['far-wall'],
    );
    for (const cast of [sphereCast, capsuleCast, boxCast]) {
      assert.equal(cast.available && cast.shape === 'shape-cast' ? cast.hit?.nodeId : null, 'wall');
      assert.ok(cast.available && cast.shape === 'shape-cast' && cast.hit && cast.hit.distance > 0);
      assert.ok(cast.available && cast.shape === 'shape-cast' && cast.hit);
      assert.ok(cast.hit!.normal[0] < -0.99);
      assert.ok(Math.abs(cast.hit!.position[0] - 3) < 1e-3);
      assert.ok(cast.hit!.position[1] > 4 && cast.hit!.position[1] < 6);
    }
  } finally {
    physics.dispose();
  }
});

async function makeContactWorld(
  order: ('wall' | 'mover')[] = ['wall', 'mover'],
  moverSpeed = 0.25,
  wallSize = 1,
) {
  const wall = {
      id: 'wall',
      name: 'Wall',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [wallSize, 1, 1], solid: true },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            { event: 'collision', actions: [{ type: 'add', variable: 'contact', value: 1 }] },
            { event: 'separation', actions: [{ type: 'add', variable: 'contact', value: -1 }] },
          ],
        },
      ],
      attachments: [],
    },
    mover = {
      id: 'mover',
      name: 'Mover',
      assetId: null,
      parentId: null,
      transform: { position: [-0.75, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [1, 1, 1], solid: false, sensor: true },
        {
          type: 'rigid-body',
          bodyType: 'dynamic',
          gravity: 0,
          linearDamping: 0,
          angularDamping: 0,
          velocity: [moverSpeed, 0, 0],
          angularVelocity: [0, 0, 0],
          canSleep: false,
        },
      ],
      attachments: [],
    },
    scene = sceneSchema.parse({
      id: 'physics-snapshot-scene',
      name: 'Physics snapshot scene',
      bounds: 20,
      nodes: order.map((id) => (id === 'wall' ? wall : mover)),
    });
  let moverX = -0.75;
  const physics = await RapierPhysics.create(
    scene,
    (node) =>
      new Matrix4().compose(
        new Vector3(node.id === 'mover' ? moverX : 0, 0, 0),
        new Quaternion(),
        new Vector3(1, 1, 1),
      ),
    true,
  );
  return {
    physics,
    setMoverX(value: number) {
      moverX = value;
    },
    step() {
      const result = physics.stepWithEvents(1 / 60),
        pose = result.poses.get('mover');
      if (pose) moverX = pose.position.x;
      return result;
    },
  };
}

async function makeJointWorld(jointType: 'fixed' | 'revolute' | 'prismatic') {
  const anchorSelf = jointType === 'revolute' ? [-0.5, 0, 0] : [0, 0, 0],
    anchorOther = [0, 2, 0],
    axis = jointType === 'prismatic' ? [1, 0, 0] : [0, 0, 1],
    scene = sceneSchema.parse({
      id: `joint-${jointType}-scene`,
      name: `${jointType} joint scene`,
      nodes: [
        {
          id: 'frame',
          name: 'Frame',
          transform: {},
          components: [
            { type: 'collider', size: [1, 1, 1], solid: true },
            { type: 'rigid-body', bodyType: 'fixed' },
          ],
        },
        {
          id: 'moving-body',
          name: 'Moving body',
          transform: { position: jointType === 'revolute' ? [0.5, 2, 0] : [0, 2, 0] },
          components: [
            { type: 'collider', size: [1, 1, 1], solid: true },
            { type: 'rigid-body', bodyType: 'dynamic', canSleep: false },
            {
              type: 'joint',
              connectedNodeId: 'frame',
              jointType,
              anchorSelf,
              anchorOther,
              axis,
              ...(jointType === 'revolute' && { limits: [-0.5, 0.5] }),
            },
          ],
        },
      ],
    });
  const poses = new Map(
    scene.nodes.map((node) => [
      node.id,
      {
        position: new Vector3(...node.transform.position),
        rotation: new Quaternion(),
      },
    ]),
  );
  const physics = await RapierPhysics.create(
    scene,
    (node) => {
      const pose = poses.get(node.id)!;
      return new Matrix4().compose(pose.position, pose.rotation, new Vector3(1, 1, 1));
    },
    true,
  );
  return {
    physics,
    step() {
      const result = physics.stepWithEvents(1 / 60);
      for (const [id, pose] of result.poses)
        poses.set(id, { position: pose.position, rotation: pose.rotation });
      return result;
    },
    position() {
      return poses.get('moving-body')!.position.clone();
    },
  };
}

test('Rapier motion capture returns detached actual linear and angular velocities', async () => {
  const { physics } = await makeBody('dynamic', {
    gravity: 0,
    linearDamping: 0,
    angularDamping: 0,
    velocity: [1.25, -2.5, 3.75],
    angularVelocity: [-4.5, 5.25, 6.75],
    canSleep: false,
  });
  try {
    const captured = physics.captureMotion('body');
    assert.ok(captured);
    assert.deepEqual(captured.linearVelocity, [1.25, -2.5, 3.75]);
    assert.deepEqual(captured.angularVelocity, [-4.5, 5.25, 6.75]);
    captured.linearVelocity[0] = 999;
    captured.angularVelocity[1] = 999;
    assert.deepEqual(physics.captureMotion('body')?.linearVelocity, [1.25, -2.5, 3.75]);
    assert.deepEqual(physics.captureMotion('body')?.angularVelocity, [-4.5, 5.25, 6.75]);
  } finally {
    physics.dispose();
  }
});

test('fixed, hinge and slider joints constrain bodies and resume from joint-aware snapshots', async () => {
  const hinge = await makeJointWorld('revolute'),
    slider = await makeJointWorld('prismatic'),
    fixed = await makeJointWorld('fixed');
  let resumed: Awaited<ReturnType<typeof makeJointWorld>> | undefined;
  try {
    for (let frame = 0; frame < 120; frame++) {
      hinge.step();
      slider.step();
      fixed.step();
    }
    const hingePosition = hinge.position(),
      hingeRadius = Math.hypot(hingePosition.x, hingePosition.y - 2),
      hingeAngle = Math.atan2(hingePosition.y - 2, hingePosition.x);
    assert.ok(Math.abs(hingeRadius - 0.5) < 0.03);
    assert.ok(Math.abs(hingeAngle) <= 0.53);
    assert.ok(Math.abs(slider.position().y - 2) < 0.02);
    assert.ok(Math.abs(fixed.position().y - 2) < 0.02);

    const snapshot = hinge.physics.captureSnapshot();
    assert.ok(snapshot);
    assert.equal(snapshot.jointHandles?.length, 1);
    resumed = await makeJointWorld('revolute');
    assert.equal(resumed.physics.restoreSnapshot(snapshot), true);
    for (let frame = 0; frame < 12; frame++) {
      hinge.step();
      resumed.step();
    }
    assert.ok(hinge.position().distanceTo(resumed.position()) < 1e-6);
  } finally {
    resumed?.physics.dispose();
    fixed.physics.dispose();
    slider.physics.dispose();
    hinge.physics.dispose();
  }
});

test('Rapier world snapshots resume body state and contact events across node order changes', async () => {
  const source = await makeContactWorld(),
    initial = source.step();
  const target = await makeContactWorld(['mover', 'wall']);
  try {
    assert.deepEqual(initial.collisions, [{ nodeAId: 'wall', nodeBId: 'mover', started: true }]);
    const snapshot = source.physics.captureSnapshot();
    assert.ok(snapshot);
    assert.equal(snapshot.rapierVersion, '0.21.0');
    assert.equal(target.physics.restoreSnapshot(snapshot), true);

    for (let i = 0; i < 8; i++) {
      const expected = source.step(),
        actual = target.step(),
        expectedPose = expected.poses.get('mover'),
        actualPose = actual.poses.get('mover'),
        expectedMotion = source.physics.captureMotion('mover'),
        actualMotion = target.physics.captureMotion('mover');
      assert.deepEqual(actual.collisions, expected.collisions);
      assert.ok(expectedPose && actualPose && expectedMotion && actualMotion);
      assert.ok(expectedPose.position.distanceTo(actualPose.position) < 1e-7);
      assert.ok(1 - Math.abs(expectedPose.rotation.dot(actualPose.rotation)) < 1e-7);
      assert.deepEqual(actualMotion, expectedMotion);
    }

    source.setMoverX(-3);
    target.setMoverX(-3);
    const expectedExit = source.step(),
      actualExit = target.step();
    assert.deepEqual(actualExit.collisions, expectedExit.collisions);
    assert.deepEqual(actualExit.collisions, [{ nodeAId: 'wall', nodeBId: 'mover', started: false }]);
    assert.ok(
      expectedExit.poses.get('mover')!.position.distanceTo(actualExit.poses.get('mover')!.position) < 1e-7,
    );
    assert.deepEqual(target.physics.captureMotion('mover'), source.physics.captureMotion('mover'));
  } finally {
    target.physics.dispose();
    source.physics.dispose();
  }
});

test('Rapier world snapshot restore rejects incompatible and out-of-range metadata atomically', async () => {
  const source = await makeContactWorld(),
    snapshot = source.physics.captureSnapshot(),
    target = await makeContactWorld(['wall', 'mover'], 1);
  try {
    assert.ok(snapshot);
    const before = target.physics.captureMotion('mover');
    assert.ok(before);

    const wrongVersion = { ...snapshot, rapierVersion: '0.20.0' };
    assert.equal(target.physics.restoreSnapshot(wrongVersion), false);
    const badBodyHandle = {
      ...snapshot,
      bodyHandles: snapshot.bodyHandles.map((entry) => ({ ...entry })),
    };
    badBodyHandle.bodyHandles[0].handle = snapshot.worldBodyCount;
    assert.equal(target.physics.restoreSnapshot(badBodyHandle), false);
    const tooLarge = { ...snapshot, world: new Uint8Array(MAX_RAPIER_SNAPSHOT_BYTES + 1) };
    assert.equal(target.physics.restoreSnapshot(tooLarge), false);
    assert.deepEqual(target.physics.captureMotion('mover'), before);

    const incompatible = await makeContactWorld(['wall', 'mover'], 0, 2);
    try {
      assert.equal(incompatible.physics.restoreSnapshot(snapshot), false);
    } finally {
      incompatible.physics.dispose();
    }
  } finally {
    target.physics.dispose();
    source.physics.dispose();
  }
});

test('restored motion continues translating and rotating after Rapier reconstruction', async () => {
  const source = await makeBody('dynamic', {
    gravity: 0,
    linearDamping: 0,
    angularDamping: 0,
    velocity: [2, 0.5, -1],
    angularVelocity: [0.25, 0.5, 1],
    canSleep: false,
  });
  try {
    for (let i = 0; i < 12; i++) source.step(1 / 60);
    const snapshot = source.physics.captureMotion('body'),
      sourcePose = source.pose();
    assert.ok(snapshot);
    const rebuilt = await makeBody(
      'dynamic',
      {
        gravity: 0,
        linearDamping: 0,
        angularDamping: 0,
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        canSleep: false,
      },
      [sourcePose.position.x, sourcePose.position.y, sourcePose.position.z],
      sourcePose.rotation,
    );
    try {
      assert.equal(rebuilt.physics.restoreMotion('body', snapshot), true);
      for (let i = 0; i < 30; i++) {
        source.step(1 / 60);
        rebuilt.step(1 / 60);
      }
      const expected = source.pose(),
        actual = rebuilt.pose();
      assert.ok(expected.position.distanceTo(actual.position) < 1e-5);
      assert.ok(1 - Math.abs(expected.rotation.dot(actual.rotation)) < 1e-6);
      assert.ok(actual.position.x > sourcePose.position.x + 0.9);
      assert.ok(1 - Math.abs(actual.rotation.dot(sourcePose.rotation)) > 0.001);
    } finally {
      rebuilt.physics.dispose();
    }
  } finally {
    source.physics.dispose();
  }
});

test('restoring a sleeping dynamic body applies velocities before its final sleep state', async () => {
  const target = await makeBody('dynamic', {
    gravity: 0,
    linearDamping: 0,
    angularDamping: 0,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    canSleep: true,
  });
  try {
    assert.equal(
      target.physics.restoreMotion('body', {
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        sleeping: true,
      }),
      true,
    );
    assert.deepEqual(target.physics.captureMotion('body'), {
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      sleeping: true,
    });
    const before = target.pose().position.clone();
    target.physics.step(0.1);
    assert.ok(target.pose().position.distanceTo(before) < 1e-8);
    assert.equal(target.physics.captureMotion('body')?.sleeping, true);
    assert.equal(
      target.physics.restoreMotion('body', {
        linearVelocity: [1, 0, 0],
        angularVelocity: [0, 0, 0],
        sleeping: false,
      }),
      true,
    );
    assert.equal(target.physics.captureMotion('body')?.sleeping, false);
    target.step(0.1);
    assert.ok(target.pose().position.x > before.x + 0.09);
  } finally {
    target.physics.dispose();
  }
});

test('invalid and unsupported motion snapshots are rejected atomically', async () => {
  const target = await makeBody('dynamic', {
    gravity: 0,
    linearDamping: 0,
    angularDamping: 0,
    velocity: [1, 2, 3],
    angularVelocity: [4, 5, 6],
    canSleep: true,
  });
  try {
    const before = target.physics.captureMotion('body');
    assert.ok(before);
    const invalid: unknown[] = [
      { linearVelocity: [10001, 0, 0], angularVelocity: [0, 0, 0], sleeping: false },
      { linearVelocity: [9, 8, 7], angularVelocity: [0, Number.NaN, 0], sleeping: false },
      { linearVelocity: [9, 8], angularVelocity: [0, 0, 0], sleeping: false },
      { linearVelocity: new Array(3), angularVelocity: [0, 0, 0], sleeping: false },
      { linearVelocity: [9, 8, 7], angularVelocity: [0, 0, 0], sleeping: 'false' },
      { linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0], sleeping: true },
      { linearVelocity: [0, 0, 0], angularVelocity: [0, 1, 0], sleeping: true },
    ];
    for (const state of invalid) {
      assert.equal(target.physics.restoreMotion('body', state as never), false);
      assert.deepEqual(target.physics.captureMotion('body'), before);
    }
    assert.equal(
      target.physics.restoreMotion('missing', {
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        sleeping: false,
      }),
      false,
    );
  } finally {
    target.physics.dispose();
  }

  const cannotSleep = await makeBody('dynamic', { canSleep: false, velocity: [2, 0, 0] });
  const kinematic = await makeBody('kinematic-velocity', { canSleep: true, velocity: [3, 0, 0] });
  try {
    const beforeCannotSleep = cannotSleep.physics.captureMotion('body'),
      beforeKinematic = kinematic.physics.captureMotion('body');
    const sleeping: PhysicsMotion = {
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      sleeping: true,
    };
    assert.equal(cannotSleep.physics.restoreMotion('body', sleeping), false);
    assert.equal(kinematic.physics.restoreMotion('body', sleeping), false);
    assert.deepEqual(cannotSleep.physics.captureMotion('body'), beforeCannotSleep);
    assert.deepEqual(kinematic.physics.captureMotion('body'), beforeKinematic);
  } finally {
    cannotSleep.physics.dispose();
    kinematic.physics.dispose();
  }
});

test('velocity-based kinematic bodies advance from authored velocity and return their poses', async () => {
  const body = await makeBody('kinematic-velocity', {
    gravity: 0,
    linearDamping: 0,
    angularDamping: 0,
    velocity: [2, 0, 0],
    angularVelocity: [0, 0, 1],
    canSleep: false,
  });
  try {
    let returned = 0;
    for (let i = 0; i < 10; i++) {
      const pose = body.step(0.1);
      assert.ok(pose);
      returned++;
    }
    assert.equal(returned, 10);
    assert.ok(Math.abs(body.pose().position.x - 2) < 1e-4);
    assert.ok(Math.abs(body.pose().rotation.angleTo(new Quaternion()) - 1) < 1e-3);
  } finally {
    body.physics.dispose();
  }
});

test('kinematic bodies emit enter and exit events for fixed sensors with collision rules', async () => {
  const scene = sceneSchema.parse({
    id: 'kinematic-sensor-scene',
    name: 'Kinematic sensor scene',
    bounds: 20,
    nodes: [
      {
        id: 'sensor',
        name: 'Sensor',
        assetId: null,
        parentId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        enabled: true,
        components: [
          { type: 'collider', size: [1, 2, 2], solid: false, sensor: true },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'collision',
                actions: [{ type: 'add', variable: 'entered', value: 1 }],
              },
            ],
          },
        ],
        attachments: [],
      },
      {
        id: 'mover',
        name: 'Mover',
        assetId: null,
        parentId: null,
        transform: { position: [-2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        enabled: true,
        components: [
          { type: 'collider', size: [0.5, 0.5, 0.5], solid: true },
          { type: 'rigid-body', bodyType: 'kinematic-position' },
        ],
        attachments: [],
      },
    ],
  });
  let moverX = -2;
  const physics = await RapierPhysics.create(
    scene,
    (node) =>
      new Matrix4().compose(
        new Vector3(node.id === 'mover' ? moverX : 0, 0, 0),
        new Quaternion(),
        new Vector3(1, 1, 1),
      ),
    true,
  );
  try {
    const collisions: PhysicsCollisionEvent[] = [];
    for (let step = 0; step < 7; step++) {
      moverX += 0.5;
      collisions.push(...physics.stepWithEvents(0.1).collisions);
    }
    assert.deepEqual(
      collisions.map(({ nodeAId, nodeBId, started }) => ({ nodeAId, nodeBId, started })),
      [
        { nodeAId: 'sensor', nodeBId: 'mover', started: true },
        { nodeAId: 'sensor', nodeBId: 'mover', started: false },
      ],
    );
  } finally {
    physics.dispose();
  }
});

test('kinematic sensors detect overlaps with other kinematic bodies', async () => {
  const scene = sceneSchema.parse({
    id: 'kinematic-pair-scene',
    name: 'Kinematic pair scene',
    bounds: 20,
    nodes: [
      {
        id: 'sensor',
        name: 'Moving sensor',
        assetId: null,
        parentId: null,
        transform: { position: [-2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        enabled: true,
        components: [
          { type: 'collider', size: [1, 2, 2], solid: false, sensor: true },
          {
            type: 'rigid-body',
            bodyType: 'kinematic-position',
            gravity: 18,
            linearDamping: 0,
            restitution: 0,
            velocity: [0, 0, 0],
          },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [{ event: 'collision', actions: [{ type: 'add', variable: 'entered', value: 1 }] }],
          },
        ],
        attachments: [],
      },
      {
        id: 'mover',
        name: 'Kinematic mover',
        assetId: null,
        parentId: null,
        transform: { position: [-4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        enabled: true,
        components: [
          { type: 'collider', size: [0.5, 0.5, 0.5], solid: true },
          {
            type: 'rigid-body',
            bodyType: 'kinematic-position',
            gravity: 18,
            linearDamping: 0,
            restitution: 0,
            velocity: [0, 0, 0],
          },
        ],
        attachments: [],
      },
    ],
  });
  let moverX = -4;
  const physics = await RapierPhysics.create(
    scene,
    (node) =>
      new Matrix4().compose(
        new Vector3(node.id === 'mover' ? moverX : -2, 0, 0),
        new Quaternion(),
        new Vector3(1, 1, 1),
      ),
    true,
  );
  try {
    const collisions: PhysicsCollisionEvent[] = [];
    for (let step = 0; step < 7; step++) {
      moverX += 0.5;
      collisions.push(...physics.stepWithEvents(0.1).collisions);
    }
    assert.deepEqual(
      collisions.map(({ nodeAId, nodeBId, started }) => ({ nodeAId, nodeBId, started })),
      [
        { nodeAId: 'sensor', nodeBId: 'mover', started: true },
        { nodeAId: 'sensor', nodeBId: 'mover', started: false },
      ],
    );
  } finally {
    physics.dispose();
  }
});

test('disposed Rapier adapters reject motion capture and restore', async () => {
  const target = await makeBody('dynamic');
  target.physics.dispose();
  assert.equal(target.physics.captureMotion('body'), null);
  assert.equal(
    target.physics.restoreMotion('body', {
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      sleeping: false,
    }),
    false,
  );
});
