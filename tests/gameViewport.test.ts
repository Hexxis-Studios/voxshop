import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GameViewport,
  activeVoxelWorldCanApplyEditChanges,
  activeWorldUnchanged,
  cameraRelativeMovement,
  terrainEditFromHit,
} from '../runtime/GameViewport';
import {
  applyProjectOperations,
  gameHudWidgetSchema,
  identityTransform,
  newProject,
  validateProject,
} from '../services/projectDocument';
import { GameSession } from '../runtime/GameSession';
import { Box3, Fog, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { createModelDocument } from '../services/modelDocument';
import { constructionProject } from './fixtures/constructionProject';

test('unlocked Play uses message tasks by default and timer deadlines above display refresh when capped', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let timerTask: (() => void) | null = null;
  let channelTask: (() => void) | null = null;
  let taskDelay = -1;
  let now = 0;
  let channelPosts = 0;
  let animationFrameRequests = 0;
  const animationFrameTasks: Array<(now: number) => void> = [];
  let viewport: any;
  viewport = Object.assign(Object.create(GameViewport.prototype), {
    renderLoop: 'unlocked',
    session: { simulation: { status: 'playing' } },
    agentPaused: false,
    disposed: false,
    renderTimer: null,
    renderTaskPending: false,
    renderTaskChannel: {
      port2: {
        postMessage() {
          channelPosts++;
          channelTask = () => viewport.onRenderTask();
        },
      },
    },
    framePacing: { capFrameRate: false, maxFpsTarget: 144 },
    lastFrameStartedAt: 0,
    nextCappedFrameAt: 0,
  }) as any;
  const renderedAt: number[] = [];
  viewport.render = (now: number) => renderedAt.push(now);

  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setTimeout(callback: () => void, delay: number) {
          timerTask = callback;
          taskDelay = delay;
          return 17;
        },
      },
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value(callback: (now: number) => void) {
        animationFrameRequests++;
        animationFrameTasks.push(callback);
        return animationFrameRequests;
      },
    });
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: () => now },
    });

    viewport.scheduleFrame();
    assert.equal(channelPosts, 1);
    assert.equal(taskDelay, -1);
    assert.equal(animationFrameRequests, 0);
    channelTask!();
    assert.equal(renderedAt.length, 1);
    assert.ok(Number.isFinite(renderedAt[0]));

    viewport.scheduleFrame();
    const pendingUncappedTask = channelTask!;
    viewport.framePacing = { capFrameRate: true, maxFpsTarget: 240 };
    viewport.scheduleFrame();
    assert.equal(animationFrameRequests, 0, 'Capped rendering does not wait for display refresh callbacks.');
    assert.ok(Math.abs(taskDelay - 1000 / 240) < 0.001);
    pendingUncappedTask();
    assert.equal(renderedAt.length, 1);
    now = 2;
    timerTask!();
    assert.equal(renderedAt.length, 1, 'The capped view waits until its frame deadline.');
    assert.ok(Math.abs(taskDelay - (1000 / 240 - now)) < 0.001);
    now = 1000 / 240;
    timerTask!();
    assert.equal(renderedAt.length, 2);
    assert.equal(renderedAt[1], now);

    viewport.agentPaused = true;
    viewport.scheduleFrame();
    assert.equal(animationFrameRequests, 1);
    viewport.agentPaused = false;
    viewport.session.simulation = null;
    viewport.scheduleFrame();
    assert.equal(animationFrameRequests, 2);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalAnimationFrame)
      Object.defineProperty(globalThis, 'requestAnimationFrame', originalAnimationFrame);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
    else Reflect.deleteProperty(globalThis, 'performance');
  }
});

test('viewport inspection synchronously renders without waiting for a suspended animation frame or advancing play', async () => {
  const originalAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  let animationFrameRequests = 0;
  const order: unknown[][] = [];
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    project: { id: 'game', revision: 3 },
    session: null,
    camera: { position: { toArray: () => [1, 2, 3] } },
    controls: { target: { toArray: () => [0, 0, 0] } },
    renderer: {
      domElement: { width: 100, height: 50 },
      info: { render: { calls: 1, triangles: 12 }, memory: { geometries: 1, textures: 0 } },
    },
    gpuTimer: { stats: () => ({ supported: false, sampleCount: 0 }) },
    visuals: { stats: () => ({ instances: 0 }) },
    worldRenderer: null,
    activeHudTabs: { menu: 'settings' },
    last: 250,
    resize() {
      order.push(['resize']);
    },
    render(now: number, scheduleNextFrame: boolean) {
      order.push(['render', now, scheduleNextFrame, this.last]);
    },
    capture(alreadyRendered: boolean) {
      order.push(['capture', alreadyRendered]);
      return 'data:image/png;base64,iVBORw0KGgo=';
    },
  }) as any;

  try {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value() {
        animationFrameRequests++;
        return 1;
      },
    });

    const result = await viewport.observe({ type: 'capture' });
    assert.equal(animationFrameRequests, 0);
    assert.deepEqual(
      order.map((entry) => entry[0]),
      ['resize', 'render', 'capture'],
    );
    assert.equal(order[1][2], false, 'A one-off inspection render must not schedule another frame.');
    assert.equal(order[1][3], order[1][1], 'Zero elapsed time prevents simulation advancement.');
    assert.equal(order[2][1], true, 'The capture reuses the freshly rendered canvas.');
    assert.equal(result.image, 'data:image/png;base64,iVBORw0KGgo=');
    assert.deepEqual(result.observation.hudTabs, { menu: 'settings' });
  } finally {
    if (originalAnimationFrame)
      Object.defineProperty(globalThis, 'requestAnimationFrame', originalAnimationFrame);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
});

test('standalone performance capture rejects overlap and always ends GPU sampling', async () => {
  const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
  let finishWait: (() => void) | undefined;
  let starts = 0,
    stops = 0;
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    renderLoop: 'unlocked',
    session: { simulation: { status: 'playing', paused: false } },
    agentPaused: false,
    performanceCaptureActive: false,
    framePacing: { capFrameRate: false, maxFpsTarget: 144 },
    totalRendererCalls: 10,
    totalRendererCallMs: 25,
    totalSimulationSteps: 60,
    gpuTimer: {
      startCapture() {
        starts++;
      },
      stopCapture() {
        stops++;
      },
      stats: () => ({ supported: true, sampleCount: 1, p95Ms: 2 }),
    },
    renderer: { info: { render: { calls: 3, triangles: 12 } } },
    visuals: { stats: () => ({ occlusion: { suppressedInstances: 2 } }) },
    worldRenderer: null,
    framePacingSettings: () => ({ capFrameRate: false, maxFpsTarget: 144 }),
  }) as any;

  try {
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (callback: () => void, duration: number) => {
        assert.equal(duration, 1000);
        finishWait = callback;
        return 1;
      },
    });
    const capture = viewport.measurePerformance(1000);
    assert.equal(viewport.performanceCaptureActive, true);
    await assert.rejects(viewport.measurePerformance(1000), /already in progress/);
    finishWait!();
    const result = await capture;
    assert.equal(result.gpu.sampleCount, 1);
    assert.equal(viewport.performanceCaptureActive, false);
    assert.deepEqual([starts, stops], [1, 1]);
  } finally {
    if (originalSetTimeout) Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout);
    else Reflect.deleteProperty(globalThis, 'setTimeout');
  }
});

test('agent viewport benchmark separates callback cadence, CPU renderer calls and GPU elapsed time', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  let time = 0;
  let animationFrameCount = 0;
  let failAnimationFrame = false;
  let captureStarts = 0;
  let captureStops = 0;
  let occlusionEnabled = false;
  const occlusionModeChanges: boolean[] = [];
  const occlusionTotals = {
    visibleResults: 0,
    occludedResults: 0,
    discardedResults: 0,
    suppressedInstances: 0,
    suppressedBatchFrames: 0,
  };
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    project: { id: 'game', revision: 4 },
    totalRendererCalls: 0,
    totalRendererCallMs: 0,
    renderer: {
      domElement: { width: 1280, height: 720 },
      info: { render: { calls: 12, triangles: 240 }, memory: { geometries: 6, textures: 2 } },
      getContext: () => ({ RENDERER: 1, getExtension: () => null, getParameter: () => 'test GPU' }),
    },
    gpuTimer: {
      startCapture() {
        captureStarts++;
      },
      stopCapture() {
        captureStops++;
      },
      stats: () => ({ supported: true, sampleCount: 30, p50Ms: 2.1, p95Ms: 2.8 }),
    },
    visuals: {
      get occlusionCullingEnabled() {
        return occlusionEnabled;
      },
      setOcclusionEnabled(enabled: boolean) {
        occlusionEnabled = enabled;
        occlusionModeChanges.push(enabled);
      },
      stats: () => ({
        occlusion: {
          available: true,
          registeredBatches: 128,
          ...occlusionTotals,
        },
      }),
    },
    worldRenderer: { stats: () => ({ geometryArrayBytes: 4096 }) },
    camera: { position: { toArray: () => [0, 1, 3] } },
    controls: { target: { toArray: () => [0, 0, 0] } },
    activeHudTabs: {},
    session: null,
    resize() {},
    render() {},
    capture: () => 'data:image/png;base64,iVBORw0KGgo=',
  }) as any;

  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'visible' },
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value(callback: (now: number) => void) {
        animationFrameCount++;
        time += 1000 / 60;
        viewport.totalRendererCalls++;
        viewport.totalRendererCallMs += 2;
        if (occlusionEnabled) {
          occlusionTotals.visibleResults++;
          occlusionTotals.occludedResults++;
          occlusionTotals.suppressedInstances += 2;
          occlusionTotals.suppressedBatchFrames++;
        }
        callback(failAnimationFrame ? -1 : time);
        return 1;
      },
    });

    const result = await viewport.observe({
      type: 'benchmark',
      frames: 30,
      occlusionCullingEnabled: true,
    });
    assert.equal(
      animationFrameCount,
      65,
      'Culling warms two query passes over 128 batches before 30 samples.',
    );
    assert.equal(result.observation.benchmark.frames, 30);
    assert.equal(result.observation.benchmark.rendererCalls, 30);
    assert.equal(result.observation.benchmark.rendererCallMs, 60);
    assert.equal(result.observation.benchmark.rendererCallMsPerCall, 2);
    assert.ok(Math.abs(result.observation.benchmark.animationFrameCallbacksPerSecond - 60) < 1e-9);
    assert.equal(result.observation.benchmark.gpu.sampleCount, 30);
    assert.equal(result.observation.benchmark.occlusionCullingEnabled, true);
    assert.deepEqual(result.observation.benchmark.occlusion, {
      available: true,
      registeredBatches: 128,
      visibleResults: 30,
      occludedResults: 30,
      discardedResults: 0,
      suppressedInstances: 60,
      suppressedBatchFrames: 30,
    });
    assert.equal(occlusionEnabled, false, 'The original culling setting is restored after the measurement.');
    assert.deepEqual(occlusionModeChanges, [true, false]);
    failAnimationFrame = true;
    await assert.rejects(
      viewport.observe({ type: 'benchmark', frames: 30, occlusionCullingEnabled: true }),
      /did not produce benchmark frames/,
    );
    assert.equal(occlusionEnabled, false, 'A failed benchmark also restores the original culling setting.');
    assert.deepEqual(occlusionModeChanges, [true, false, true, false]);
    assert.deepEqual([captureStarts, captureStops], [1, 1]);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalAnimationFrame)
      Object.defineProperty(globalThis, 'requestAnimationFrame', originalAnimationFrame);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
});

test('agent observation rejects a stale rendered document before applying walkthrough input', async () => {
  let playCount = 0;
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    project: { id: 'game', revision: 3 },
    play() {
      playCount++;
    },
  }) as any;
  await assert.rejects(viewport.observe({ type: 'play' }, { id: 'game', revision: 4 }), /still opening/);
  await assert.rejects(
    viewport.observe({ type: 'play' }, { id: 'other-game', revision: 3 }),
    /still opening/,
  );
  assert.equal(playCount, 0, 'An obsolete viewport must not receive Play commands.');
});

test('agent observation rejects a project change while runtime readiness is pending', async () => {
  let ready!: () => void;
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    project: { id: 'game', revision: 3 },
    session: {
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
    },
    resize() {
      assert.fail('An obsolete revision must not be captured.');
    },
  }) as any;
  const observing = viewport.observe({ type: 'capture' }, { id: 'game', revision: 3 });
  viewport.project = { id: 'game', revision: 4 };
  ready();
  await assert.rejects(observing, /still opening/);
});

test('number keys route only authored usable inventory slots during Play', () => {
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: {
      simulation: {
        nodes: new Map(),
        component: () => undefined,
        inventory: [
          { itemId: 'medkit', quantity: 1 },
          { itemId: 'ore', quantity: 2 },
        ],
        items: new Map([
          ['medkit', { use: { type: 'heal', amount: 25 } }],
          ['ore', {}],
        ]),
      },
    },
    pending: {},
    keys: new Set<string>(),
    playerControlsCache: new WeakMap(),
    agentPaused: true,
    cameraOverride: true,
  }) as any;

  viewport.handleKeyDown({ code: 'Digit1', preventDefault() {} });
  assert.equal(viewport.pending.useItem, 'medkit');
  assert.equal(viewport.agentPaused, false);
  assert.equal(viewport.keys.has('Digit1'), true);
  viewport.keys.delete('Digit1');
  viewport.pending = {};
  viewport.handleKeyDown({ code: 'Digit2', preventDefault() {} });
  assert.equal(viewport.pending.useItem, undefined);
  assert.equal(viewport.keys.has('Digit2'), true);
});

test('agent walkthrough pause input toggles once in a multi-frame step', () => {
  const project = validateProject(newProject('agent-pause', 'Agent pause'));
  const session = new GameSession(project, project.activeSceneId);
  const viewport = Object.assign(Object.create(GameViewport.prototype), { session }) as any;
  try {
    const paused = viewport.step({ togglePause: true }, 3);
    assert.equal(paused.paused, true);
    assert.equal(paused.frame, 0);

    const resumed = viewport.step({ togglePause: true }, 2);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.frame, 1);
  } finally {
    session.dispose();
  }
});

test('agent walkthrough input selects a valid HUD tab and rejects an unknown page', () => {
  const project = newProject('agent-hud-tabs', 'Agent HUD tabs');
  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({
      id: 'home',
      type: 'tab-button',
      text: 'Home',
      groupId: 'menu',
      tabId: 'home',
    }),
    gameHudWidgetSchema.parse({
      id: 'settings',
      type: 'tab-button',
      text: 'Settings',
      groupId: 'menu',
      tabId: 'settings',
    }),
  ];
  const session = new GameSession(validateProject(project), project.activeSceneId),
    changes: Record<string, string>[] = [],
    viewport = Object.assign(Object.create(GameViewport.prototype), {
      session,
      activeHudTabs: {},
      onHudTab(tabs: Record<string, string>) {
        changes.push(tabs);
      },
    }) as GameViewport;
  try {
    viewport.step({ uiTab: { groupId: 'menu', tabId: 'settings' } });
    assert.deepEqual(changes, [{ menu: 'settings' }]);
    assert.deepEqual((viewport as any).activeHudTabs, { menu: 'settings' });
    assert.throws(
      () => viewport.step({ uiTab: { groupId: 'menu', tabId: 'missing' } }),
      /not in the active scene/,
    );
  } finally {
    session.dispose();
  }
});

test('HUD inventory action queues only an owned usable item', () => {
  const simulation = {
    paused: false,
    inventory: [{ itemId: 'potion', quantity: 1 }],
    items: new Map([['potion', { use: { type: 'heal', amount: 25 } }]]),
  };
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: { simulation },
    pending: {},
    audio: { unlock() {} },
    agentPaused: true,
    cameraOverride: true,
  }) as GameViewport;
  assert.equal(viewport.triggerUseItem('potion'), true);
  assert.equal((viewport as any).pending.useItem, 'potion');
  assert.equal(viewport.triggerUseItem('missing'), false);
  assert.equal(viewport.triggerUseItem('stone'), false);
});

test('Escape toggles pause once per key press and clears queued movement actions', () => {
  const simulation = {
    status: 'playing',
    paused: false,
    nodes: new Map(),
    component: () => undefined,
    setPaused(paused: boolean) {
      this.paused = paused;
    },
    inspect() {
      return { paused: this.paused };
    },
  };
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: { simulation },
    pending: { attack: true },
    keys: new Set<string>(),
    touchMovement: { moveX: 1, moveZ: -1 },
    accumulator: 0.05,
    playerControlsCache: new WeakMap(),
    agentPaused: false,
    cameraOverride: false,
  }) as any;
  let prevented = 0;
  const keyDown = () =>
    viewport.handleKeyDown({
      code: 'Escape',
      preventDefault() {
        prevented++;
      },
    });

  keyDown();
  assert.equal(simulation.paused, true);
  assert.deepEqual(viewport.pending, {});
  assert.deepEqual(viewport.touchMovement, { moveX: 0, moveZ: 0 });
  assert.equal(viewport.accumulator, 0);
  keyDown();
  assert.equal(simulation.paused, true, 'keyboard repeat does not toggle back while Escape is held');
  assert.equal(prevented, 2);

  viewport.keys.delete('Escape');
  keyDown();
  assert.equal(simulation.paused, false);
});

test('semantic use actions reach a usable inventory item after the ninth slot', () => {
  const simulation = {
    inventory: [
      ...Array.from({ length: 9 }, (_, index) => ({ itemId: `ore-${index}`, quantity: 1 })),
      { itemId: 'medkit', quantity: 1 },
    ],
    items: new Map([['medkit', { use: { type: 'heal', amount: 25 } }]]),
  };
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: { simulation },
    audio: { unlock() {}, clearPending() {} },
    importedAudio: { unlock() {}, setMusic() {}, stop() {} },
    pending: {},
    agentPaused: true,
    cameraOverride: true,
  }) as any;

  assert.equal(viewport.triggerAction('useItem'), true);
  assert.equal(viewport.pending.useItem, 'medkit');
});

test('touch camera drag rotates the follow view without changing movement or action input', () => {
  const player = {},
    simulation = {
      nodes: new Map([['player', player]]),
      component: (node: object, type: string) =>
        node === player && type === 'player' ? { style: 'third-person' as const } : undefined,
    },
    target = new Vector3(0, 1, 0),
    camera = new PerspectiveCamera(),
    pending = { attack: true },
    keys = new Set(['KeyW']),
    viewport = Object.assign(Object.create(GameViewport.prototype), {
      session: { simulation },
      camera,
      controls: { target: new Vector3() },
      gameCameraOffset: new Vector3(),
      gameCameraYaw: 0,
      gameCameraPitch: null,
      cameraOverride: true,
      agentPaused: true,
      pending,
      keys,
    }) as any;

  viewport.updateGameCamera(target, 'third-person', 1 / 60, 0, 0);
  const beforePosition = camera.position.clone(),
    beforeDirection = camera.getWorldDirection(new Vector3());
  assert.equal(viewport.lookByTouch(24, -12), true);
  assert.ok(viewport.gameCameraYaw > 0);
  assert.ok(viewport.gameCameraPitch > Math.atan2(6, 10));
  assert.equal(viewport.cameraOverride, false);
  assert.deepEqual([...keys], ['KeyW']);
  assert.deepEqual(pending, { attack: true });

  viewport.updateGameCamera(target, 'third-person', 1 / 60, 0, 0);
  assert.ok(camera.position.distanceTo(beforePosition) > 0.1);
  assert.ok(camera.getWorldDirection(new Vector3()).distanceTo(beforeDirection) > 0.01);
  viewport.lookByTouch(0, -10000);
  assert.ok(viewport.gameCameraPitch <= (80 * Math.PI) / 180);
  assert.deepEqual([...keys], ['KeyW']);
  assert.deepEqual(pending, { attack: true });
});

test('framing scene bounds extends fog far enough to keep the framed world visible', () => {
  const fog = new Fog(0x9bb9c0, 32, 52),
    camera = new PerspectiveCamera(50, 16 / 9, 0.1, 2000),
    target = new Vector3(),
    viewport = Object.assign(Object.create(GameViewport.prototype), {
      camera,
      controls: { target, update() {} },
      scene: { fog },
      cameraOverride: false,
    }) as any,
    bounds = new Box3(new Vector3(-36, -12, -36), new Vector3(36, 12, 36));

  viewport.frameBounds(bounds);

  const center = bounds.getCenter(new Vector3()),
    radius = bounds.getBoundingSphere(new Sphere()).radius,
    distance = camera.position.distanceTo(center);
  assert.deepEqual(target.toArray(), center.toArray());
  assert.ok(fog.far > distance + radius, 'Fog must end beyond all framed terrain geometry.');
  assert.equal(viewport.cameraOverride, true);
});

test('first-person camera follows eye height, matches forward movement, and clamps vertical look', () => {
  const target = new Vector3(2, 1.6, -3),
    camera = new PerspectiveCamera(),
    viewport = Object.assign(Object.create(GameViewport.prototype), {
      gameCameraYaw: 0,
      gameCameraPitch: null,
      gameCameraOffset: new Vector3(),
      gameCameraLookTarget: new Vector3(),
      agentPaused: true,
      camera,
      controls: { target: new Vector3() },
    }) as any;
  viewport.updateGameCamera(target, 'first-person', 1 / 60, 0, 0);
  assert.ok(camera.position.distanceTo(target) < 1e-8);
  const forward = camera.getWorldDirection(new Vector3()),
    expectedMovement = cameraRelativeMovement(0, -1, viewport.gameCameraYaw);
  assert.ok(forward.distanceTo(new Vector3(expectedMovement.moveX, 0, expectedMovement.moveZ)) < 1e-8);

  viewport.adjustGameCamera('first-person', Math.PI / 2, 100);
  assert.equal(viewport.gameCameraPitch, (85 * Math.PI) / 180);
  viewport.updateGameCamera(target, 'first-person', 1, 0, 0);
  const turned = camera.getWorldDirection(new Vector3());
  assert.ok(turned.x < -0.08 && turned.y > 0.99, 'Yaw turns with movement; pitch looks up without flipping.');

  viewport.adjustGameCamera('first-person', 0, -100);
  assert.equal(viewport.gameCameraPitch, (-85 * Math.PI) / 180);
});

const terrain = {
  type: 'world.create',
  id: 'terrain',
  name: 'Terrain',
  seed: 11,
  chunkSize: 16,
  voxelSize: 0.5,
  generator: {
    type: 'terrain',
    version: 1,
    origin: [0, 0],
    size: [8, 8],
    mode: 'voxel3d',
    minY: 0,
    maxY: 16,
    baseHeight: 4,
    amplitude: 0,
    palette: { surface: 0x55aa44, subsurface: 0x725439, deep: 0x686b70, materialType: 'STANDARD' },
  },
} as const;

function project() {
  return applyProjectOperations(newProject('project', 'Project'), [
    terrain,
    { type: 'scene.put', scene: { id: 'main', name: 'Main scene', worldId: 'terrain' } },
  ]);
}

test('active world reuse accepts remote asset and node changes but rejects terrain and project changes', () => {
  const original = project(),
    withAsset = applyProjectOperations(original, [
      {
        type: 'asset.put',
        asset: { id: 'prop', name: 'Prop', model: createModelDocument([]), voxelSize: 0.1, rig: null },
      },
    ]),
    withNode = applyProjectOperations(withAsset, [
      {
        type: 'node.put',
        sceneId: 'main',
        node: {
          id: 'prop-node',
          name: 'Prop',
          assetId: 'prop',
          parentId: null,
          transform: identityTransform(),
          enabled: true,
          components: [],
          attachments: [],
        },
      },
    ]);

  assert.equal(activeWorldUnchanged(original, withAsset), true);
  assert.equal(activeWorldUnchanged(withAsset, withNode), true);
  assert.equal(activeWorldUnchanged(original, JSON.parse(JSON.stringify(withNode))), true);
  assert.equal(
    activeWorldUnchanged(
      original,
      applyProjectOperations(original, [
        { type: 'world.edit', worldId: 'terrain', edits: [{ x: 1, y: 4, z: 1, value: null }] },
      ]),
    ),
    false,
  );
  assert.equal(
    activeWorldUnchanged(
      original,
      applyProjectOperations(original, [{ type: 'world.update', worldId: 'terrain', seed: 12 }]),
    ),
    false,
  );
  const editedWorld = applyProjectOperations(original, [
    { type: 'world.edit', worldId: 'terrain', edits: [{ x: 1, y: 4, z: 1, value: null }] },
  ]);
  assert.equal(activeVoxelWorldCanApplyEditChanges(original, editedWorld), true);
  assert.equal(
    activeVoxelWorldCanApplyEditChanges(
      original,
      applyProjectOperations(original, [{ type: 'world.update', worldId: 'terrain', seed: 12 }]),
    ),
    false,
  );
  assert.equal(activeVoxelWorldCanApplyEditChanges(original, { ...original, id: 'another-project' }), false);
  assert.equal(activeWorldUnchanged(original, { ...original, id: 'another-project' }), false);
});

test('Play placement uses the authored logical cell size and terrain palette defaults', () => {
  const authored = project().worlds[0],
    place = terrainEditFromHit(authored, 'place', [0, 1.75, 0], [0, 1, 0]);
  assert.deepEqual(place, {
    x: 0,
    y: 4,
    z: 0,
    value: { color: 0x55aa44, materialType: 'STANDARD' },
  });
  assert.equal(authored.voxelSize, 0.5);
});

test('the viewport preserves construction failure feedback and leaves terminal runs untouched', () => {
  const session = new GameSession(constructionProject(), 'main');
  session.simulation.inventory = [];
  let rendererUpdates = 0;
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } },
    terrainHit: () => ({ point: [2, 3.5, 0], normal: [0, 1, 0], coarseSurface: false }),
    syncTerrainRenderer() {
      rendererUpdates++;
    },
  }) as GameViewport;
  viewport.step({ placeCell: true });
  assert.match(session.simulation.message, /Not enough materials/);
  viewport.step({ placeCell: true });
  assert.match(session.simulation.message, /Not enough materials/);
  assert.deepEqual(session.simulation.terrainProgressEdits, []);
  assert.equal(rendererUpdates, 0);
  session.simulation.inventory = [{ itemId: 'stone', quantity: 1 }];
  viewport.step({ placeCell: true });
  assert.equal(rendererUpdates, 1);
  assert.deepEqual(session.simulation.inventory, []);
  session.simulation.status = 'won';
  session.simulation.message = 'The authored win message.';
  viewport.step({ removeCell: true });
  assert.equal(session.simulation.message, 'The authored win message.');
  assert.equal(rendererUpdates, 1);
  session.dispose();
});

test('viewport campaign resume selects the saved active scene and Stop restores the authored entry', () => {
  const project = newProject('viewport-campaign', 'Viewport campaign');
  project.scenes.push({ ...structuredClone(project.scenes[0]), id: 'second', name: 'Second' });
  const authored = validateProject(project);
  const first = new GameSession(authored, 'main'),
    second = new GameSession(authored, 'second');
  const checkpoint = first.progressSnapshot()!;
  checkpoint.activeSceneId = 'second';
  checkpoint.scenes.push(second.simulation.progressSnapshot()!);
  first.dispose();
  second.dispose();

  const rendered: string[] = [],
    camera = new PerspectiveCamera();
  camera.position.set(15, 14, 20);
  // Exercise the real viewport lifecycle without constructing a WebGL context.
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    project: authored,
    session: null,
    runtimeSceneId: 'main',
    controls: { enabled: true, target: new Vector3(0, 1, 0), update() {} },
    camera,
    renderer: { domElement: { focus() {} } },
    audio: { unlock() {}, clearPending() {} },
    importedAudio: { unlock() {}, setMusic() {}, stop() {} },
    visuals: { update() {}, flush() {} },
    select() {},
    blur() {},
    syncTerrainRenderer() {},
    renderScene(id: string) {
      rendered.push(id);
      this.runtimeSceneId = id;
    },
  }) as GameViewport;
  viewport.play(true, checkpoint);
  assert.equal(viewport.simulation?.scene.id, 'second');
  assert.equal(viewport.progressRestoredSceneId, 'second');
  assert.deepEqual(rendered, ['second']);
  viewport.stop();
  assert.equal(viewport.simulation, null);
  assert.deepEqual(rendered, ['second', 'main']);
  assert.equal(project.activeSceneId, 'main');
});

test('HUD inventory move and sort update the live hotbar state immediately', () => {
  const project = newProject('inventory-viewport', 'Inventory viewport');
  project.scenes[0]!.items = [
    { id: 'wood', name: 'Wood', description: '', maxStack: 99 },
    { id: 'iron', name: 'Iron ore', description: '', maxStack: 99 },
  ];
  project.scenes[0]!.nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: identityTransform(),
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'inventory', slots: 4 },
      ],
      attachments: [],
    },
  ];
  const validatedProject = validateProject(project);
  const session = new GameSession(validatedProject, validatedProject.activeSceneId);
  const states: string[][] = [];
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session,
    onState: (state: { inventory: { itemId: string }[] }) =>
      states.push(state.inventory.map((stack) => stack.itemId)),
  }) as GameViewport;
  try {
    session.simulation.inventory = [
      { itemId: 'wood', quantity: 3 },
      { itemId: 'iron', quantity: 1 },
    ];
    assert.equal(viewport.moveInventoryStack(1, 0), true);
    assert.deepEqual(states.at(-1), ['iron', 'wood']);
    assert.equal(viewport.sortInventoryByName(), true);
    assert.deepEqual(states.at(-1), ['iron', 'wood']);
    assert.equal(viewport.moveInventoryStack(0, 9), false);
  } finally {
    session.dispose();
  }
});
