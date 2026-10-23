import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GameSession } from '../runtime/GameSession';
import { GameViewport } from '../runtime/GameViewport';
import { identityTransform, newProject, nodeSchema, validateProject } from '../services/projectDocument';

function playerNode(id: string, position: [number, number, number], moveRight?: string) {
  return nodeSchema.parse({
    id,
    name: id,
    transform: { ...identityTransform(), position },
    components: [
      {
        type: 'player',
        style: 'third-person',
        speed: 3,
        jump: 5,
        ...(moveRight && { controls: { keyboard: { moveRight: [moveRight] } } }),
      },
      { type: 'inventory', slots: 4 },
    ],
  });
}

function multiplayerProject(twoPlayers = false) {
  const project = newProject('multiplayer-viewport', 'Multiplayer viewport test');
  project.scenes[0]!.items = [
    { id: 'wood', name: 'Wood', description: '', maxStack: 99 },
    { id: 'iron', name: 'Iron ore', description: '', maxStack: 99 },
  ];
  project.scenes[0]!.nodes = [
    playerNode('local-player', [0, 0, 0], 'KeyD'),
    ...(twoPlayers ? [playerNode('remote-player', [20, 0, 0], 'KeyL')] : []),
  ];
  return validateProject(project);
}

function viewportFor(session: GameSession, send: (input: Record<string, unknown>) => boolean = () => true) {
  return Object.assign(Object.create(GameViewport.prototype), {
    session,
    multiplayer: { send },
    playerControlsCache: new WeakMap(),
    pending: {},
    audio: { unlock() {} },
    onState() {},
  }) as GameViewport;
}

test('remote control actor and authored bindings follow the selected multiplayer player', () => {
  const local = {
      id: 'local-player',
      transform: { position: [0, 0, 0] },
      player: { type: 'player', style: 'third-person', controls: { keyboard: { moveRight: ['KeyD'] } } },
    },
    remote = {
      id: 'remote-player',
      transform: { position: [20, 0, 0] },
      player: { type: 'player', style: 'third-person', controls: { keyboard: { moveRight: ['KeyL'] } } },
    },
    simulation = {
      selectedMultiplayerPlayerNodeId: 'remote-player',
      nodes: new Map([
        [local.id, local],
        [remote.id, remote],
      ]),
      component: (node: typeof local | typeof remote, type: string) =>
        type === 'player' ? node.player : undefined,
    },
    viewport = Object.assign(Object.create(GameViewport.prototype), {
      session: { simulation },
      playerControlsCache: new WeakMap(),
    }) as any;

  assert.equal(viewport.controlledPlayer().id, 'remote-player');
  assert.deepEqual(viewport.activePlayerControls().keyboard.moveRight, ['KeyL']);
  assert.equal(viewport.controlledPlayer().transform.position[0], 20);
});

test('room UI and gameplay step send intentions without mutating the local session', async () => {
  const project = multiplayerProject();
  const session = new GameSession(project, project.activeSceneId);
  const inputs: Record<string, unknown>[] = [];
  try {
    await session.ready;
    session.simulation.inventory = [
      { itemId: 'wood', quantity: 3 },
      { itemId: 'iron', quantity: 1 },
    ];
    session.simulation.paused = true;
    const beforeInventory = structuredClone(session.simulation.inventory);
    const beforeFrame = session.simulation.frame;
    const originalStep = session.step.bind(session);
    let localSteps = 0;
    session.step = ((...args: Parameters<GameSession['step']>) => {
      localSteps++;
      return originalStep(...args);
    }) as GameSession['step'];
    const viewport = viewportFor(session, (input) => {
      inputs.push(input);
      return true;
    });

    assert.equal(viewport.moveInventoryStack(1, 0), true);
    assert.equal(viewport.sortInventoryByName(), true);
    assert.equal(viewport.selectConstructionPaint('stone'), true);
    assert.equal(viewport.triggerHudEvent('open'), true);
    assert.throws(() => viewport.step({ moveX: 1 }), /advanced by its host/i);

    assert.deepEqual(inputs, [
      { inventoryMove: { fromIndex: 1, toIndex: 0 } },
      { inventorySort: true },
      { constructionPaint: 'stone' },
      { uiEventId: 'open' },
    ]);
    assert.equal(localSteps, 0, 'Paused HUD actions must be sent to the room host, never stepped locally.');
    assert.deepEqual(session.simulation.inventory, beforeInventory);
    assert.equal(session.simulation.frame, beforeFrame);
    assert.equal(Reflect.get(session.simulation, 'constructionPaintId'), null);
  } finally {
    session.dispose();
  }
});

test('Stop clears the active multiplayer connection before returning to editor mode', () => {
  let closeCount = 0;
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: null,
    multiplayer: { close: async () => closeCount++, info: () => ({ state: 'connected' }) },
    multiplayerError: undefined,
    remoteTopology: 'remote-player',
    importedAudio: { stop() {} },
  }) as GameViewport;

  viewport.stop();

  assert.equal(closeCount, 1);
  assert.equal(viewport.multiplayerInfo().state, 'disconnected');
  assert.equal(Reflect.get(viewport, 'remoteTopology'), '');
});

test('Dispose clears the active multiplayer connection and releases viewport resources', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  let closeCount = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { removeEventListener() {} },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value() {} });
  try {
    const viewport = Object.assign(Object.create(GameViewport.prototype), {
      session: null,
      multiplayer: { close: async () => closeCount++, info: () => ({ state: 'connected' }) },
      importedAudio: { dispose() {} },
      audio: { dispose() {} },
      frame: 0,
      renderTimer: null,
      renderTaskChannel: null,
      observer: { disconnect() {} },
      renderer: { domElement: { removeEventListener() {}, remove() {} }, dispose() {} },
      controls: { dispose() {} },
      scene: new THREE.Scene(),
      visuals: { dispose() {} },
      gpuTimer: { dispose() {} },
      worldRenderer: null,
      select() {},
    }) as GameViewport;

    viewport.dispose();

    assert.equal(closeCount, 1);
    assert.equal(viewport.multiplayerInfo().state, 'disconnected');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalCancelAnimationFrame)
      Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancelAnimationFrame);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});
