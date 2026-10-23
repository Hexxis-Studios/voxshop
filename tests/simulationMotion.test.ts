import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { GameSimulation } from '../runtime/GameSimulation';
import { GameSession } from '../runtime/GameSession';
import { serializeGameProgress } from '../runtime/gameProgress';
import { newProject, validateProject, type Component, type SceneNode } from '../services/projectDocument';

function node(id: string, components: Component[], position: [number, number, number]): SceneNode {
  return {
    id,
    name: id,
    parentId: null,
    assetId: null,
    enabled: true,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    components,
    attachments: [],
  };
}

function motionProject(bodyOptions: Record<string, unknown> = {}) {
  const project = newProject('motion-checkpoint', 'Motion checkpoint');
  project.scenes[0].variables = { score: 0 };
  project.scenes[0].nodes = [
    node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
      ],
      [0, 0, 0],
    ),
    node(
      'body',
      [
        { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
        {
          type: 'rigid-body',
          gravity: 18,
          linearDamping: 0.2,
          angularDamping: 0.1,
          velocity: [1, 0, -0.5],
          angularVelocity: [0.2, 0.5, 0.3],
          canSleep: false,
          ...bodyOptions,
        } as Component,
      ],
      [8, 20, 0],
    ),
    node('plain', [], [-8, 0, 0]),
  ];
  return validateProject(project);
}

function capsuleSlopeProject(slopeDegrees: number, maxSlopeAngle: number) {
  const project = newProject('capsule-slope', 'Capsule slope'),
    radians = (slopeDegrees * Math.PI) / 180,
    player = node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 2, jump: 6, maxSlopeAngle },
        {
          type: 'collider',
          size: [0.6, 1.8, 0.6],
          offset: [0, 0.9, 0],
          solid: true,
          shape: 'capsule',
        },
      ],
      [-3, 0, 0],
    ),
    floor = node(
      'floor',
      [{ type: 'collider', size: [40, 1, 20], offset: [0, 0, 0], solid: true }],
      [0, -0.5, 0],
    ),
    slope = node(
      'slope',
      [{ type: 'collider', size: [4, 0.2, 20], offset: [0, 0, 0], solid: true }],
      [0, 0.1 * Math.cos(radians) + 2 * Math.sin(radians), 0],
    );
  slope.transform.rotation = [0, 0, radians];
  project.scenes[0].nodes = [player, floor, slope];
  return validateProject(project);
}

function capsuleStepProject(withCeiling: boolean) {
  const project = newProject('capsule-step', 'Capsule step'),
    player = node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 2, jump: 6, stepHeight: 0.5 },
        {
          type: 'collider',
          size: [0.6, 1.8, 0.6],
          offset: [0, 0.9, 0],
          solid: true,
          shape: 'capsule',
        },
      ],
      [-1, 0, 0],
    ),
    floor = node(
      'floor',
      [{ type: 'collider', size: [40, 1, 20], offset: [0, 0, 0], solid: true }],
      [0, -0.5, 0],
    ),
    step = node(
      'step',
      [{ type: 'collider', size: [0.6, 0.5, 4], offset: [0, 0, 0], solid: true }],
      [0, 0.25, 0],
    );
  project.scenes[0].nodes = [player, floor, step];
  if (withCeiling)
    project.scenes[0].nodes.push(
      node(
        'ceiling',
        [{ type: 'collider', size: [1, 0.5, 4], offset: [0, 0, 0], solid: true }],
        [0.55, 1.3, 0],
      ),
    );
  return validateProject(project);
}

function checkpoint(simulation: GameSimulation) {
  const snapshot = simulation.progressSnapshot();
  assert.ok(snapshot);
  const serialized = serializeGameProgress(snapshot);
  assert.ok(serialized, 'the real simulation produces a valid durable checkpoint');
  return JSON.parse(serialized) as typeof snapshot;
}

function compareBody(a: GameSimulation, b: GameSimulation, tolerance = 1e-4) {
  const positionA = new Vector3(),
    rotationA = new Quaternion(),
    positionB = new Vector3(),
    rotationB = new Quaternion();
  a.worldMatrix(a.nodes.get('body')!).decompose(positionA, rotationA, new Vector3());
  b.worldMatrix(b.nodes.get('body')!).decompose(positionB, rotationB, new Vector3());
  assert.ok(
    positionA.distanceTo(positionB) < tolerance,
    `body positions differ: ${positionA.toArray()} / ${positionB.toArray()}`,
  );
  assert.ok(1 - Math.abs(rotationA.dot(rotationB)) < tolerance, 'body orientations continue together');
  const motionA = checkpoint(a).motion!.bodies.body,
    motionB = checkpoint(b).motion!.bodies.body;
  for (const key of ['linearVelocity', 'angularVelocity'] as const)
    assert.ok(new Vector3(...motionA[key]).distanceTo(new Vector3(...motionB[key])) < tolerance, key);
  assert.equal(motionA.sleeping, motionB.sleeping);
}

test('falling and spinning bodies continue from a serialized checkpoint, including queued startup steps', async () => {
  const project = motionProject(),
    source = new GameSimulation(project);
  await source.ready;
  let resumed: GameSimulation | undefined;
  try {
    assert.deepEqual(source.errors, []);
    for (let i = 0; i < 25; i++) source.step();
    const saved = checkpoint(source);
    assert.ok(saved.motion!.bodies.body.linearVelocity[1] < -5);
    resumed = new GameSimulation(project, project.activeSceneId, saved);
    assert.equal(resumed.progressRestored, true);
    assert.deepEqual(
      checkpoint(resumed).motion,
      saved.motion,
      'saving again during physics startup retains incoming motion',
    );
    for (let i = 0; i < 10; i++) {
      source.step();
      resumed.step();
    }
    await resumed.ready;
    assert.deepEqual(resumed.errors, []);
    compareBody(source, resumed);
    assert.equal(resumed.frame, source.frame);
    for (let i = 0; i < 15; i++) {
      source.step();
      resumed.step();
    }
    compareBody(source, resumed);
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('player checkpoints preserve an ascending jump through landing', async () => {
  const project = motionProject();
  project.scenes[0].nodes = project.scenes[0].nodes.filter((n) => n.id === 'player');
  const source = new GameSimulation(project);
  source.step({ jump: true });
  for (let i = 0; i < 8; i++) source.step();
  const saved = checkpoint(source),
    resumed = new GameSimulation(project, project.activeSceneId, saved);
  try {
    assert.ok(saved.motion!.actors.player > 0);
    for (let i = 0; i < 65; i++) {
      source.step();
      resumed.step();
      assert.ok(
        source
          .worldPosition(source.nodes.get('player')!)
          .distanceTo(resumed.worldPosition(resumed.nodes.get('player')!)) < 1e-9,
      );
      assert.equal(source.velocities.get('player'), resumed.velocities.get('player'));
    }
    assert.equal(resumed.worldPosition(resumed.nodes.get('player')!).y, 0);
  } finally {
    source.dispose();
    resumed.dispose();
  }
});

test('sprint applies its authored speed multiplier only while the player is moving', () => {
  const project = newProject('sprint-motion', 'Sprint motion');
  project.scenes[0].nodes = [
    node(
      'player',
      [{ type: 'player', style: 'top-down', speed: 3, jump: 0, sprintMultiplier: 2 }],
      [0, 0, 0],
    ),
  ];
  const simulation = new GameSimulation(validateProject(project));
  try {
    const player = simulation.nodes.get('player')!;
    simulation.step({ moveX: 1 });
    const walkPosition = simulation.worldPosition(player).x;
    simulation.step({ moveX: 1, sprint: true });
    const sprintDistance = simulation.worldPosition(player).x - walkPosition;
    assert.ok(Math.abs(sprintDistance - 0.1) < 1e-9, `Expected 0.1m sprint step, got ${sprintDistance}.`);
    simulation.step({ sprint: true });
    assert.equal(simulation.worldPosition(player).x, walkPosition + sprintDistance);
  } finally {
    simulation.dispose();
  }
});

test('explicit capsule players climb slopes only up to their authored maximum angle', async () => {
  const blocked = new GameSimulation(capsuleSlopeProject(50, 45));
  let allowed: GameSimulation | undefined;
  try {
    await blocked.ready;
    allowed = new GameSimulation(capsuleSlopeProject(50, 60));
    await allowed.ready;
    assert.deepEqual(blocked.errors, []);
    assert.deepEqual(allowed.errors, []);
    for (let frame = 0; frame < 300; frame++) {
      blocked.step({ moveX: 1 });
      allowed.step({ moveX: 1 });
    }
    const blockedPosition = blocked.worldPosition(blocked.nodes.get('player')!),
      allowedPosition = allowed.worldPosition(allowed.nodes.get('player')!);
    assert.ok(
      blockedPosition.x < allowedPosition.x - 0.75,
      `The 60-degree controller should climb farther than the 45-degree controller: ${blockedPosition.toArray()} / ${allowedPosition.toArray()}`,
    );
    assert.ok(
      allowedPosition.x > 0,
      `The 60-degree controller should pass the ramp: ${allowedPosition.toArray()}`,
    );
  } finally {
    blocked.dispose();
    allowed?.dispose();
  }
});

test('capsule autostep climbs the authored height and rejects a step blocked by a ceiling', async () => {
  const climb = new GameSimulation(capsuleStepProject(false));
  let blocked: GameSimulation | undefined;
  try {
    await climb.ready;
    blocked = new GameSimulation(capsuleStepProject(true));
    await blocked.ready;
    let maximumStepHeight = 0;
    for (let frame = 0; frame < 90; frame++) {
      climb.step({ moveX: 1 });
      blocked.step({ moveX: 1 });
      maximumStepHeight = Math.max(maximumStepHeight, climb.worldPosition(climb.nodes.get('player')!).y);
    }
    const climbed = climb.worldPosition(climb.nodes.get('player')!),
      underCeiling = blocked.worldPosition(blocked.nodes.get('player')!);
    assert.ok(climbed.x > 0.5, `The capsule should get over the block, got ${climbed.toArray()}.`);
    assert.ok(
      Math.abs(maximumStepHeight - 0.5) < 0.03,
      `The capsule should reach the step top, got ${maximumStepHeight}.`,
    );
    assert.ok(underCeiling.x < -0.1, `The ceiling should prevent step-up, got ${underCeiling.toArray()}.`);
  } finally {
    climb.dispose();
    blocked?.dispose();
  }
});

test('capsule jump uses swept grounding and lands back on the default floor', async () => {
  const project = motionProject();
  project.scenes[0].nodes = project.scenes[0].nodes.filter((entry) => entry.id === 'player');
  project.scenes[0].nodes[0]!.components = project.scenes[0].nodes[0]!.components.map((entry) =>
    entry.type === 'collider' ? { ...entry, shape: 'capsule' } : entry,
  );
  const simulation = new GameSimulation(validateProject(project));
  try {
    await simulation.ready;
    simulation.step();
    simulation.step({ jump: true });
    assert.ok(simulation.worldPosition(simulation.nodes.get('player')!).y > 0.05);
    for (let frame = 0; frame < 120; frame++) simulation.step();
    assert.ok(
      Math.abs(simulation.worldPosition(simulation.nodes.get('player')!).y) < 0.02,
      'the capsule settles at floor height after its jump',
    );
  } finally {
    simulation.dispose();
  }
});

test('player gravity and terminal fall speed are authored and applied independently', async () => {
  const project = motionProject();
  project.scenes[0].nodes = project.scenes[0].nodes.filter((n) => n.id === 'player');
  const player = project.scenes[0].nodes[0];
  player.components = player.components.map((component) =>
    component.type === 'player' ? { ...component, gravity: 100, terminalVelocity: 2 } : component,
  );
  player.transform.position[1] = 10;
  const simulation = new GameSimulation(project);
  try {
    await simulation.ready;
    for (let i = 0; i < 6; i++) simulation.step();
    assert.equal(simulation.velocities.get('player'), -2);
    assert.ok(simulation.worldPosition(simulation.nodes.get('player')!).y < 10);
  } finally {
    simulation.dispose();
  }
});

test('jump buffering accepts a pressed jump on the first grounded step', async () => {
  const project = motionProject();
  project.scenes[0].nodes = project.scenes[0].nodes.filter((n) => n.id === 'player');
  const player = project.scenes[0].nodes[0];
  player.components = player.components.map((component) =>
    component.type === 'player' ? { ...component, jumpBuffer: 0.01 } : component,
  );
  player.transform.position[1] = 0.03;
  const simulation = new GameSimulation(project);
  try {
    await simulation.ready;
    simulation.velocities.set('player', -3);
    simulation.step({ jump: true });
    assert.equal(simulation.worldPosition(simulation.nodes.get('player')!).y, 0);
    simulation.step({ jump: false });
    assert.ok(simulation.worldPosition(simulation.nodes.get('player')!).y > 0);
    assert.ok((simulation.velocities.get('player') ?? 0) > 0);
  } finally {
    simulation.dispose();
  }
});

test('coyote time accepts one jump just after ground contact is lost', async () => {
  const project = motionProject();
  project.scenes[0].nodes = project.scenes[0].nodes.filter((n) => n.id === 'player');
  const player = project.scenes[0].nodes[0];
  player.components = player.components.map((component) =>
    component.type === 'player' ? { ...component, coyoteTime: 0.01 } : component,
  );
  const simulation = new GameSimulation(project);
  try {
    await simulation.ready;
    simulation.step();
    player.transform.position[1] = 0.03;
    simulation.step({ jump: true });
    assert.ok(simulation.worldPosition(simulation.nodes.get('player')!).y > 0.03);
    assert.ok((simulation.velocities.get('player') ?? 0) > 0);
  } finally {
    simulation.dispose();
  }
});

test('live restore rewinds body poses and velocities, and legacy saves reset to authored motion', async () => {
  const project = motionProject(),
    live = new GameSimulation(project);
  await live.ready;
  let reference: GameSimulation | undefined;
  try {
    const authored = checkpoint(live);
    for (let i = 0; i < 20; i++) live.step();
    const saved = checkpoint(live);
    reference = new GameSimulation(project, project.activeSceneId, saved);
    await reference.ready;
    for (let i = 0; i < 20; i++) live.step();
    assert.equal(live.restoreProgress(saved), true);
    compareBody(live, reference);
    for (let i = 0; i < 12; i++) {
      live.step();
      reference.step();
    }
    compareBody(live, reference);
    delete authored.motion;
    assert.equal(live.restoreProgress(authored), true);
    assert.deepEqual(live.nodes.get('body')!.transform.position, [8, 20, 0]);
    assert.deepEqual(checkpoint(live).motion!.bodies.body.linearVelocity, [1, 0, -0.5]);
    assert.equal(live.velocities.size, 0);
  } finally {
    live.dispose();
    reference?.dispose();
  }
});

test('incompatible motion references are rejected before any live simulation state changes', async () => {
  const project = motionProject(),
    simulation = new GameSimulation(project);
  await simulation.ready;
  try {
    for (let i = 0; i < 10; i++) simulation.step();
    const before = checkpoint(simulation);
    for (const incompatible of [
      { actors: { missing: 2 }, bodies: {} },
      { actors: { plain: 2 }, bodies: {} },
      { actors: {}, bodies: { plain: before.motion!.bodies.body } },
      {
        actors: {},
        bodies: { body: { linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], sleeping: true } },
      },
    ]) {
      assert.equal(
        simulation.restoreProgress({ ...before, variables: { score: 999 }, motion: incompatible }),
        false,
      );
      assert.deepEqual(checkpoint(simulation), before);
    }
  } finally {
    simulation.dispose();
  }
});

test('sleeping motion restores before contact reconstruction and settles safely after load', async () => {
  const project = motionProject({
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      canSleep: true,
      lockRotation: true,
    }),
    source = new GameSimulation(project);
  await source.ready;
  let resumed: GameSimulation | undefined;
  try {
    for (let i = 0; i < 600; i++) source.step();
    const saved = checkpoint(source);
    assert.equal(saved.motion!.bodies.body.sleeping, true);
    resumed = new GameSimulation(project, project.activeSceneId, saved);
    await resumed.ready;
    assert.deepEqual(checkpoint(resumed).motion!.bodies.body, saved.motion!.bodies.body);
    assert.equal(source.restoreProgress(saved), true);
    assert.equal(checkpoint(source).motion!.bodies.body.sleeping, true);
    compareBody(source, resumed);
    // A new Rapier world rebuilds contacts and may wake touching sleepers. Contact caches aren't saved.
    for (let i = 0; i < 600; i++) resumed.step();
    assert.equal(checkpoint(resumed).motion!.bodies.body.sleeping, true);
    const position = resumed.worldPosition(resumed.nodes.get('body')!);
    assert.ok(position.y > 0.48 && position.y < 0.52);
    assert.ok(Math.abs(position.x - 8) < 1e-4 && Math.abs(position.z) < 1e-4);
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('velocity-based kinematics move visible scene nodes and resume their motion', async () => {
  const project = motionProject({
      bodyType: 'kinematic-velocity',
      gravity: 0,
      linearDamping: 0,
      angularDamping: 0,
      velocity: [2, 0, 0],
      angularVelocity: [0, 0.5, 0],
    }),
    source = new GameSimulation(project);
  await source.ready;
  let resumed: GameSimulation | undefined;
  try {
    for (let i = 0; i < 30; i++) source.step();
    assert.ok(Math.abs(source.worldPosition(source.nodes.get('body')!).x - 9) < 1e-4);
    assert.ok(source.nodes.get('body')!.transform.rotation[1] > 0.2);
    resumed = new GameSimulation(project, project.activeSceneId, checkpoint(source));
    await resumed.ready;
    for (let i = 0; i < 30; i++) {
      source.step();
      resumed.step();
    }
    compareBody(source, resumed);
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('campaign save/load keeps each visited scene body motion independent', async () => {
  const project = motionProject();
  const portal = (destination: string) =>
    node(
      'portal',
      [
        { type: 'interactable', prompt: 'Travel', range: 3 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'interact',
              interval: 1,
              once: false,
              actions: [{ type: 'transition', sceneId: destination }],
            },
          ],
        },
      ],
      [0, 0, -1],
    );
  const first = project.scenes[0];
  first.nodes.push(portal('second'));
  const second = structuredClone(first);
  second.id = 'second';
  second.nodes = second.nodes.filter((n) => n.id !== 'portal');
  second.nodes.push(portal(first.id));
  const body = second.nodes.find((n) => n.id === 'body')!.components.find((c) => c.type === 'rigid-body')!;
  body.velocity = [-2, 0, 0];
  project.scenes.push(second);
  const session = new GameSession(validateProject(project), first.id);
  await session.ready;
  let resumed: GameSession | undefined, reference: GameSimulation | undefined;
  try {
    for (let i = 0; i < 15; i++) session.step();
    session.step({ interact: true });
    await session.ready;
    assert.equal(session.simulation.scene.id, 'second');
    for (let i = 0; i < 10; i++) session.step();
    const saved = session.progressSnapshot()!;
    const firstSaved = saved.scenes.find((s) => s.sceneId === first.id)!;
    assert.ok(firstSaved.motion!.bodies.body.linearVelocity[0] > 0);
    assert.ok(saved.scenes.find((s) => s.sceneId === 'second')!.motion!.bodies.body.linearVelocity[0] < 0);
    resumed = new GameSession(project, first.id, JSON.parse(JSON.stringify(saved)));
    await resumed.ready;
    compareBody(session.simulation, resumed.simulation);
    resumed.step({ interact: true });
    await resumed.ready;
    assert.equal(resumed.simulation.scene.id, first.id);
    reference = new GameSimulation(project, first.id, firstSaved);
    await reference.ready;
    compareBody(resumed.simulation, reference);
    for (let i = 0; i < 10; i++) {
      resumed.step();
      reference.step();
    }
    compareBody(resumed.simulation, reference);
  } finally {
    session.dispose();
    resumed?.dispose();
    reference?.dispose();
  }
});
