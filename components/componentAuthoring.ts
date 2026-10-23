import type { Component } from '../services/projectDocument';

export const componentTypes = [
  'player',
  'combat',
  'collider',
  'rigid-body',
  'joint',
  'interactable',
  'inventory',
  'construction',
  'collectible',
  'gate',
  'health',
  'enemy',
  'animation',
  'rules',
  'patrol',
] satisfies Component['type'][];

const defaults = {
  player: { type: 'player', style: 'third-person', speed: 3, jump: 6, cameraHeight: 1.6 },
  combat: { type: 'combat', damage: 25, range: 3, cooldown: 0.35 },
  collider: {
    type: 'collider',
    size: [1, 2, 1],
    offset: [0, 1, 0],
    solid: true,
    shape: 'box',
    sensor: false,
    friction: 0.5,
    restitution: 0,
  },
  'rigid-body': {
    type: 'rigid-body',
    bodyType: 'dynamic',
    mass: 1,
    gravity: 18,
    linearDamping: 0.15,
    restitution: 0.2,
    velocity: [0, 0, 0],
    angularDamping: 0.1,
    angularVelocity: [0, 0, 0],
    ccd: false,
    canSleep: true,
    lockRotation: false,
  },
  joint: {
    type: 'joint',
    connectedNodeId: 'other-body',
    jointType: 'revolute',
    anchorSelf: [0, 0, 0],
    anchorOther: [0, 0, 0],
    axis: [0, 1, 0],
  },
  interactable: { type: 'interactable', prompt: 'Interact', range: 3, requiresLineOfSight: false },
  inventory: { type: 'inventory', slots: 24 },
  construction: {
    type: 'construction',
    place: true,
    remove: true,
    range: 6,
    placeCost: [],
    removeYield: [],
  },
  collectible: { type: 'collectible', variable: 'score', amount: 1, quantity: 1 },
  gate: { type: 'gate', variable: 'score', required: 5 },
  health: { type: 'health', maximum: 100 },
  enemy: { type: 'enemy', speed: 1, damage: 10, range: 1.5 },
  animation: { type: 'animation', idle: 'idle', moving: 'walk' },
  rules: {
    type: 'rules',
    apiVersion: 1,
    rules: [
      {
        event: 'interact',
        interval: 1,
        once: false,
        actions: [{ type: 'message', text: 'Hello, creator!' }],
      },
    ],
  },
  patrol: {
    type: 'patrol',
    points: [
      [0, 0, 0],
      [3, 0, 0],
    ],
    speed: 1,
  },
} satisfies Record<Component['type'], Component>;

export function availableComponentTypes(
  components: readonly Component[],
  isPlayer = components.some((component) => component.type === 'player'),
  hasJointTarget = false,
) {
  return componentTypes.filter(
    (type) =>
      !components.some((component) => component.type === type) &&
      (type !== 'joint' || hasJointTarget) &&
      ((type !== 'inventory' && type !== 'construction' && type !== 'combat') || isPlayer),
  );
}

export function addComponent(
  components: Component[],
  type: Component['type'],
  connectedNodeId?: string,
): Component[] {
  if (components.some((component) => component.type === type)) return components;
  if (type === 'joint')
    return connectedNodeId
      ? [...components, { ...structuredClone(defaults.joint), connectedNodeId }]
      : components;
  if (
    (type === 'inventory' || type === 'construction' || type === 'combat') &&
    !components.some((component) => component.type === 'player')
  )
    return components;

  if (type === 'rigid-body') {
    const next = components.map((component) => {
      if (component.type !== 'collider') return component;
      if (component.sensor) return { ...component, solid: false };
      return component.solid ? component : { ...component, solid: true };
    });
    if (!next.some((component) => component.type === 'collider'))
      next.push(structuredClone(defaults.collider));
    next.push(structuredClone(defaults[type]));
    return next;
  }

  return [...components, structuredClone(defaults[type])];
}
