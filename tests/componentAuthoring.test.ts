import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, availableComponentTypes } from '../components/componentAuthoring';
import {
  assetSchema,
  componentSchema,
  newProject,
  nodeSchema,
  validateProject,
  type Component,
} from '../services/projectDocument';
import { NodeInspector } from '../components/NodeInspector';
import { createModelDocument } from '../services/modelDocument';
import { generateCharacter } from '../services/assetAssembly';

test('arbitrary socket attachments expose position, rotation, and bounded scale fitting', () => {
  const body = assetSchema.parse(
    generateCharacter({
      id: 'fit-body',
      name: 'Fit body',
      profile: 'biped',
      height: 24,
      width: 10,
      color: 0x647a52,
      accent: 0xf4d7b6,
    }),
  );
  const gear = assetSchema.parse({
    id: 'fit-gear',
    name: 'Custom gear',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
    source: { kind: 'authored', description: '' },
  });
  const project = newProject('attachment-fitting', 'Attachment fitting');
  project.assets.push(body, gear);
  const transform = {
    position: [0.1, 0.2, 0.3] as [number, number, number],
    rotation: [0.1, 0.2, 0.3] as [number, number, number],
    scale: [2, 1, 0.5] as [number, number, number],
  };
  const node = nodeSchema.parse({
    id: 'fitting-wearer',
    name: 'Fitting wearer',
    transform: {},
    assetId: body.id,
    attachments: [
      {
        assetId: gear.id,
        socket: 'hand',
        slot: 'custom-hand-item',
        transform,
        hiddenBones: [],
      },
    ],
  });
  project.scenes[0].nodes.push(node);
  const validated = validateProject(project);
  assert.deepEqual(validated.scenes[0].nodes[0].attachments[0].transform, transform);

  const html = renderToStaticMarkup(
    React.createElement(NodeInspector, {
      node,
      project,
      onApply: async () => null,
      onDelete: () => {},
    }),
  );
  assert.match(html, /Equipment position · meters/);
  assert.match(html, /Equipment rotation · radians/);
  assert.match(html, /Equipment scale · multiplier/);
  assert.match(html, /min="0\.001" max="1000"/);
});

test('interactable schema defaults preserve older nodes and bound its fields', () => {
  const oldNode = nodeSchema.parse({ id: 'old-node', name: 'Old node', transform: {} });
  assert.deepEqual(oldNode.components, []);
  assert.deepEqual(componentSchema.parse({ type: 'interactable' }), {
    type: 'interactable',
    prompt: 'Interact',
    range: 3,
  });

  assert.equal(componentSchema.safeParse({ type: 'interactable', prompt: 'E', range: 0.01 }).success, true);
  assert.equal(
    componentSchema.safeParse({ type: 'interactable', prompt: 'x'.repeat(160), range: 100 }).success,
    true,
  );
  for (const prompt of ['', ' ', 'x'.repeat(161)])
    assert.equal(componentSchema.safeParse({ type: 'interactable', prompt, range: 3 }).success, false);
  for (const range of [0, -1, 100.01, Infinity, NaN])
    assert.equal(componentSchema.safeParse({ type: 'interactable', prompt: 'Use', range }).success, false);
});

test('interactable is discoverable, addable once, and starts with authoring defaults', () => {
  assert.ok(availableComponentTypes([]).includes('interactable'));

  const added = addComponent([], 'interactable');
  assert.deepEqual(added, [
    { type: 'interactable', prompt: 'Interact', range: 3, requiresLineOfSight: false },
  ]);
  assert.equal(availableComponentTypes(added).includes('interactable'), false);
  assert.equal(addComponent(added, 'interactable'), added);
});

test('player combat is optional, configurable, and exposed in the manual inspector', () => {
  assert.deepEqual(componentSchema.parse({ type: 'combat' }), {
    type: 'combat',
    damage: 25,
    range: 3,
    cooldown: 0.35,
  });
  for (const invalid of [
    { damage: 0 },
    { damage: 10000.01 },
    { range: 0 },
    { range: 100.01 },
    { cooldown: -0.01 },
    { cooldown: 60.01 },
  ])
    assert.equal(componentSchema.safeParse({ type: 'combat', ...invalid }).success, false);

  assert.equal(availableComponentTypes([]).includes('combat'), false);
  const playerComponents = addComponent(addComponent([], 'player'), 'combat');
  assert.deepEqual(playerComponents.at(-1), {
    type: 'combat',
    damage: 25,
    range: 3,
    cooldown: 0.35,
  });
  assert.equal(availableComponentTypes(playerComponents).includes('combat'), false);

  const project = newProject('combat-inspector', 'Combat inspector');
  const player = nodeSchema.parse({
    id: 'player',
    name: 'Player',
    transform: {},
    components: [{ type: 'player', style: 'top-down', speed: 3 }, { type: 'combat' }],
  });
  project.scenes[0].nodes.push(player);
  const html = renderToStaticMarkup(
    React.createElement(NodeInspector, {
      node: player,
      project,
      onApply: async () => null,
      onDelete: () => {},
    }),
  );
  assert.match(html, /Attack damage/);
  assert.match(html, /Attack range/);
  assert.match(html, /Attack cooldown \(seconds\)/);

  const invalidProject = newProject('combat-owner', 'Combat owner');
  invalidProject.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'non-player',
      name: 'Non-player',
      transform: {},
      components: [{ type: 'combat' }],
    }),
  );
  assert.throws(() => validateProject(invalidProject), /Combat components belong on the player/);
});

test('first-person camera style and eye height are editable on the player', () => {
  const project = newProject('first-person-inspector', 'First-person inspector');
  const player = nodeSchema.parse({
    id: 'player',
    name: 'Player',
    transform: {},
    components: [{ type: 'player', style: 'first-person', speed: 3, cameraHeight: 1.8 }],
  });
  project.scenes[0].nodes.push(player);
  const html = renderToStaticMarkup(
    React.createElement(NodeInspector, {
      node: player,
      project,
      onApply: async () => null,
      onDelete: () => {},
    }),
  );
  assert.match(html, /Camera style/);
  assert.match(html, /option value="first-person"[^>]*>First person/);
  assert.match(html, /Eye height/);
  assert.match(html, /value="1.8"/);
  assert.match(html, /Gravity/);
  assert.match(html, /Terminal fall speed/);
  assert.match(html, /Coyote time \(seconds\)/);
  assert.match(html, /Jump buffer \(seconds\)/);
  assert.match(html, /Step height/);
});

test('slope tuning is shown only for an explicitly shaped solid non-sensor player collider', () => {
  const render = (shape: 'box' | 'sphere' | 'capsule' | undefined, solid: boolean, sensor = false) => {
    const project = newProject('capsule-inspector', 'Capsule inspector'),
      player = nodeSchema.parse({
        id: 'player',
        name: 'Player',
        transform: {},
        components: [
          { type: 'player', style: 'third-person', speed: 3 },
          {
            type: 'collider',
            size: [0.6, 1.8, 0.6],
            offset: [0, 0.9, 0],
            solid,
            sensor,
            shape,
          },
        ],
      });
    project.scenes[0].nodes.push(player);
    return renderToStaticMarkup(
      React.createElement(NodeInspector, {
        node: player,
        project,
        onApply: async () => null,
        onDelete: () => {},
      }),
    );
  };

  for (const shape of ['box', 'sphere', 'capsule'] as const)
    assert.match(render(shape, true), /Maximum climb slope \(degrees\)/);
  assert.doesNotMatch(render(undefined, true), /Maximum climb slope \(degrees\)/);
  assert.doesNotMatch(render('box', false), /Maximum climb slope \(degrees\)/);
  assert.doesNotMatch(render('capsule', true, true), /Maximum climb slope \(degrees\)/);
});

test('player jump tuning has legacy-compatible defaults and bounded authoring values', () => {
  assert.deepEqual(componentSchema.parse({ type: 'player', style: 'third-person', speed: 3 }), {
    type: 'player',
    style: 'third-person',
    speed: 3,
    jump: 6,
  });
  for (const invalid of [
    { sprintMultiplier: 0.99 },
    { sprintMultiplier: 4.01 },
    { gravity: -0.01 },
    { gravity: 100.01 },
    { terminalVelocity: 0 },
    { terminalVelocity: 200.01 },
    { coyoteTime: -0.01 },
    { coyoteTime: 0.501 },
    { jumpBuffer: -0.01 },
    { jumpBuffer: 0.501 },
    { stepHeight: -0.01 },
    { stepHeight: 5.01 },
  ])
    assert.equal(
      componentSchema.safeParse({ type: 'player', style: 'third-person', speed: 3, ...invalid }).success,
      false,
    );
});

test('legacy colliders and rigid bodies parse with backward-compatible physics defaults', () => {
  const oldNode = nodeSchema.parse({
    id: 'old-physics',
    name: 'Old physics',
    transform: {},
    components: [
      { type: 'collider', size: [1, 2, 1], offset: [0, 1, 0], solid: true },
      { type: 'rigid-body', gravity: 18, linearDamping: 0.15, restitution: 0.2, velocity: [0, 0, 0] },
    ],
  });
  assert.deepEqual(oldNode.components, [
    {
      type: 'collider',
      size: [1, 2, 1],
      offset: [0, 1, 0],
      solid: true,
      sensor: false,
      friction: 0.5,
      restitution: 0,
    },
    {
      type: 'rigid-body',
      bodyType: 'dynamic',
      mass: 1,
      gravity: 18,
      linearDamping: 0.15,
      restitution: 0.2,
      angularDamping: 0.1,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      ccd: false,
      canSleep: true,
      lockRotation: false,
    },
  ]);
});

test('physics component fields enforce supported shapes and bounded values', () => {
  assert.equal(
    componentSchema.safeParse({ type: 'collider', size: [1, 1, 1], shape: 'capsule' }).success,
    true,
  );
  for (const shape of ['mesh', '', 'cone'])
    assert.equal(componentSchema.safeParse({ type: 'collider', size: [1, 1, 1], shape }).success, false);
  for (const friction of [-0.01, 10.01, Infinity])
    assert.equal(componentSchema.safeParse({ type: 'collider', size: [1, 1, 1], friction }).success, false);
  for (const restitution of [-0.01, 1.01, NaN])
    assert.equal(
      componentSchema.safeParse({ type: 'collider', size: [1, 1, 1], restitution }).success,
      false,
    );

  for (const bodyType of ['static', 'kinematic', ''])
    assert.equal(componentSchema.safeParse({ type: 'rigid-body', bodyType }).success, false);
  for (const mass of [0, -1, 1000000.01, Infinity])
    assert.equal(componentSchema.safeParse({ type: 'rigid-body', mass }).success, false);
  for (const angularDamping of [-0.01, 20.01, NaN])
    assert.equal(componentSchema.safeParse({ type: 'rigid-body', angularDamping }).success, false);
  for (const angularVelocity of [
    [0, 0],
    [0, 0, 101],
    [0, -101, 0],
  ])
    assert.equal(componentSchema.safeParse({ type: 'rigid-body', angularVelocity }).success, false);
});

test('scene joints connect two rigid bodies with bounded hinge or slider settings', () => {
  const joint = componentSchema.parse({ type: 'joint', connectedNodeId: 'frame' });
  assert.deepEqual(joint, {
    type: 'joint',
    connectedNodeId: 'frame',
    jointType: 'revolute',
    anchorSelf: [0, 0, 0],
    anchorOther: [0, 0, 0],
    axis: [0, 1, 0],
  });
  assert.equal(availableComponentTypes([], false, false).includes('joint'), false);
  assert.equal(availableComponentTypes([], false, true).includes('joint'), true);
  assert.deepEqual(addComponent([], 'joint', 'frame'), [joint]);
  for (const invalid of [
    { connectedNodeId: 'frame', jointType: 'revolute', axis: [0, 0, 0] },
    { connectedNodeId: 'frame', jointType: 'prismatic', axis: [0, 0, 0] },
    { connectedNodeId: 'frame', jointType: 'fixed', limits: [-1, 1] },
    { connectedNodeId: 'frame', jointType: 'revolute', limits: [1, -1] },
  ])
    assert.equal(componentSchema.safeParse({ type: 'joint', ...invalid }).success, false);
  assert.equal(
    componentSchema.safeParse({
      type: 'joint',
      connectedNodeId: 'frame',
      jointType: 'prismatic',
      limits: [-2, 2],
    }).success,
    true,
  );

  const project = newProject('joint-links', 'Joint links'),
    rigidBody = (id: string, components: Component[] = []) =>
      nodeSchema.parse({
        id,
        name: id,
        transform: {},
        components: [
          { type: 'collider', size: [1, 1, 1], solid: true },
          { type: 'rigid-body', bodyType: id === 'frame' ? 'fixed' : 'dynamic' },
          ...components,
        ],
      });
  project.scenes[0].nodes.push(rigidBody('frame'), rigidBody('door', [joint]));
  assert.equal(validateProject(project).scenes[0].nodes.length, 2);
  assert.throws(
    () =>
      validateProject({
        ...project,
        scenes: [
          {
            ...project.scenes[0],
            nodes: [rigidBody('frame'), rigidBody('door', [{ ...joint, connectedNodeId: 'missing' }])],
          },
        ],
      }),
    /two different rigid-body nodes/,
  );
});

test('joint fields and sibling body targets are available in the object inspector', () => {
  const project = newProject('joint-inspector', 'Joint inspector'),
    frame = nodeSchema.parse({
      id: 'frame',
      name: 'Frame',
      transform: {},
      components: [
        { type: 'collider', size: [1, 1, 1], solid: true },
        { type: 'rigid-body', bodyType: 'fixed' },
      ],
    }),
    door = nodeSchema.parse({
      id: 'door',
      name: 'Door',
      transform: {},
      components: [
        { type: 'collider', size: [1, 1, 1], solid: true },
        { type: 'rigid-body' },
        { type: 'joint', connectedNodeId: 'frame' },
      ],
    });
  project.scenes[0].nodes.push(frame, door);
  const html = renderToStaticMarkup(
    React.createElement(NodeInspector, {
      node: door,
      project,
      onApply: async () => null,
      onDelete: () => {},
    }),
  );
  assert.match(html, /Connected body/);
  assert.match(html, /Frame · frame/);
  assert.match(html, /option value="revolute"/);
  assert.match(html, /Local joint axis/);
  assert.match(html, /Enable motion limits/);
});

test('physics authoring defaults and rigid-body collider requirements preserve authored settings', () => {
  const collider = addComponent([], 'collider');
  assert.deepEqual(collider, [
    {
      type: 'collider',
      size: [1, 2, 1],
      offset: [0, 1, 0],
      solid: true,
      shape: 'box',
      sensor: false,
      friction: 0.5,
      restitution: 0,
    },
  ]);

  const authoredCollider = {
    ...collider[0],
    shape: 'sphere' as const,
    solid: false,
    sensor: true,
    friction: 1.25,
    restitution: 0.4,
  };
  const withBody = addComponent([authoredCollider], 'rigid-body');
  assert.deepEqual(withBody[0], authoredCollider);
  const contactCollider = { ...authoredCollider, solid: false, sensor: false };
  assert.deepEqual(addComponent([contactCollider], 'rigid-body')[0], { ...contactCollider, solid: true });
  assert.equal(withBody[1].type, 'rigid-body');
  if (withBody[1].type !== 'rigid-body') throw new Error('Expected a rigid body.');
  assert.deepEqual(withBody[1], {
    type: 'rigid-body',
    bodyType: 'dynamic',
    mass: 1,
    gravity: 18,
    linearDamping: 0.15,
    restitution: 0.2,
    angularDamping: 0.1,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    ccd: false,
    canSleep: true,
    lockRotation: false,
  });
});

test('project validation accepts sensor-only rigid bodies and still requires a collider', () => {
  const project = newProject('sensor-body', 'Sensor body');
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'body',
      name: 'Body',
      transform: {},
      components: [{ type: 'collider', size: [1, 1, 1], solid: false, sensor: true }, { type: 'rigid-body' }],
    }),
  );
  const validated = validateProject(project);
  assert.equal(
    validated.scenes[0].nodes[0].components.find((component) => component.type === 'collider')?.sensor,
    true,
  );

  const missingCollider = newProject('missing-collider', 'Missing collider');
  missingCollider.scenes[0].nodes.push(
    nodeSchema.parse({ id: 'body', name: 'Body', transform: {}, components: [{ type: 'rigid-body' }] }),
  );
  assert.throws(() => validateProject(missingCollider), /solid collider or trigger sensor/);
});

test('rigid-body inspector keeps trigger sensor authoring available and explains its behavior', () => {
  const project = newProject('sensor-inspector', 'Sensor inspector');
  const node = nodeSchema.parse({
    id: 'body',
    name: 'Body',
    transform: {},
    components: [{ type: 'collider', size: [1, 1, 1], solid: false, sensor: true }, { type: 'rigid-body' }],
  });
  project.scenes[0].nodes.push(node);
  const html = renderToStaticMarkup(
    React.createElement(NodeInspector, {
      node,
      project,
      onApply: async () => null,
      onDelete: () => {},
    }),
  );
  const triggerIndex = html.indexOf('Trigger sensor'),
    checkboxStart = html.lastIndexOf('<input', triggerIndex),
    checkbox = html.slice(checkboxStart, triggerIndex);
  assert.ok(triggerIndex >= 0);
  assert.match(checkbox, /checked=""/);
  assert.doesNotMatch(checkbox, /disabled/);
  assert.match(html, /sensor rigid bodies move under physics/);
});

test('player inventory behavior starts with bounded slots and stays off non-player objects', () => {
  assert.equal(availableComponentTypes([]).includes('inventory'), false);
  const player = addComponent([], 'player');
  assert.equal(availableComponentTypes(player).includes('inventory'), true);
  const inventory = addComponent(player, 'inventory');
  assert.deepEqual(inventory.at(-1), { type: 'inventory', slots: 24 });
  assert.equal(availableComponentTypes(inventory).includes('inventory'), false);
  assert.equal(componentSchema.safeParse({ type: 'inventory' }).success, true);
  assert.equal(componentSchema.safeParse({ type: 'inventory', slots: 129 }).success, false);
});

test('player construction behavior starts free and stays off non-player objects', () => {
  assert.equal(availableComponentTypes([]).includes('construction'), false);
  assert.deepEqual(addComponent([], 'construction'), []);

  const player = addComponent([], 'player');
  assert.equal(availableComponentTypes(player).includes('construction'), true);
  const construction = addComponent(player, 'construction');
  assert.deepEqual(construction.at(-1), {
    type: 'construction',
    place: true,
    remove: true,
    range: 6,
    placeCost: [],
    removeYield: [],
  });
  assert.equal(availableComponentTypes(construction).includes('construction'), false);
  assert.equal(componentSchema.safeParse({ type: 'construction' }).success, true);
});
