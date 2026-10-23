import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { cameraRelativeMovement, GameViewport } from '../runtime/GameViewport';
import { mapGamepadInput } from '../runtime/gamepadInput';
import { movementFromKeys, resolvePlayerControls } from '../services/playerControls';

type ViewportInputHarness = {
  session: { simulation: { constructionState: () => null; nodes: Map<string, never> } };
  gamepadInput: ReturnType<typeof mapGamepadInput>;
  playerControlsCache: WeakMap<object, unknown>;
  pending: Record<string, boolean>;
  agentPaused: boolean;
  cameraOverride: boolean;
  pollGamepad: () => ReturnType<typeof mapGamepadInput>;
};

function withGamepads<T>(getGamepads: () => (Gamepad | null)[], run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads },
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

function viewportHarness(): ViewportInputHarness {
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: { simulation: { constructionState: () => null, nodes: new Map() } },
    gamepadInput: mapGamepadInput(null),
    playerControlsCache: new WeakMap(),
    pending: {},
    agentPaused: true,
    cameraOverride: true,
  }) as ViewportInputHarness;
  const prototype = GameViewport.prototype as unknown as {
    pollGamepad: ViewportInputHarness['pollGamepad'];
  };
  viewport.pollGamepad = () => prototype.pollGamepad.call(viewport);
  return viewport;
}

test('gamepad Start toggles pause on press edges without repeating while held', () => {
  const buttons = Array.from({ length: 16 }, () => ({ value: 0 }));
  const pad = {
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [],
    buttons,
  } as unknown as Gamepad;
  const simulation = {
    status: 'playing',
    paused: false,
    nodes: new Map(),
    component: () => undefined,
    constructionState: () => null,
    setPaused(paused: boolean) {
      this.paused = paused;
    },
    inspect() {
      return { paused: this.paused };
    },
  };
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: { simulation },
    gamepadInput: mapGamepadInput(null),
    playerControlsCache: new WeakMap(),
    pending: { attack: true },
    keys: new Set<string>(),
    touchMovement: { moveX: 0, moveZ: 0 },
    accumulator: 0.05,
    agentPaused: false,
    cameraOverride: false,
  }) as any;
  const prototype = GameViewport.prototype as unknown as {
    pollGamepad: () => ReturnType<typeof mapGamepadInput>;
  };
  const poll = () => prototype.pollGamepad.call(viewport);

  buttons[9]!.value = 1;
  withGamepads(
    () => [pad],
    () => poll(),
  );
  assert.equal(simulation.paused, true);
  withGamepads(
    () => [pad],
    () => poll(),
  );
  assert.equal(simulation.paused, true, 'a held Start button only triggers its first press edge');
  buttons[9]!.value = 0;
  withGamepads(
    () => [pad],
    () => poll(),
  );
  buttons[9]!.value = 1;
  withGamepads(
    () => [pad],
    () => poll(),
  );
  assert.equal(simulation.paused, false);
});

test('physical movement axes rotate with the follow-camera yaw', () => {
  const forward = cameraRelativeMovement(0, -1, Math.PI / 2);
  assert.ok(Math.abs(forward.moveX + 1) < 1e-12);
  assert.ok(Math.abs(forward.moveZ) < 1e-12);

  const right = cameraRelativeMovement(1, 0, Math.PI / 2);
  assert.ok(Math.abs(right.moveX) < 1e-12);
  assert.ok(Math.abs(right.moveZ + 1) < 1e-12);

  const diagonal = cameraRelativeMovement(1, 1, 0.37);
  assert.ok(Math.abs(Math.hypot(diagonal.moveX, diagonal.moveZ) - Math.SQRT2) < 1e-12);
});

test('viewport polls a standard gamepad into existing movement and action inputs', () => {
  const buttons = Array.from({ length: 8 }, (_, index) => ({ value: index === 0 ? 1 : 0 }));
  const pad = {
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0.8, 0],
    buttons,
  } as unknown as Gamepad;
  const viewport = viewportHarness();

  withGamepads(
    () => [pad],
    () => {
      const first = viewport.pollGamepad();
      assert.equal(first.heldKeys.has('KeyD'), true);
      assert.ok(Math.abs(first.moveX - (0.8 - 0.28) / 0.72) < 1e-12);
      assert.equal(first.pressedKeys.has('Space'), true);
      assert.deepEqual(viewport.pending, { jump: true });
      assert.equal(viewport.agentPaused, false);
      assert.equal(viewport.cameraOverride, false);

      viewport.pending = {};
      viewport.pollGamepad();
      assert.deepEqual(viewport.pending, {});

      buttons[7].value = 1;
      viewport.pollGamepad();
      assert.deepEqual(viewport.pending, { placeCell: true, removeCell: false });
    },
  );
});

test('viewport clears mapped gamepad input when browser access is restricted', () => {
  const viewport = viewportHarness();
  withGamepads(
    () => {
      throw new DOMException('Gamepad access denied.', 'SecurityError');
    },
    () => {
      assert.equal(viewport.pollGamepad().padIndex, null);
      assert.deepEqual([...viewport.gamepadInput.heldKeys], []);
    },
  );
});

test('viewport clears held input after the selected controller disconnects', () => {
  const viewport = viewportHarness();
  const pad = {
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, -1],
    buttons: [],
  } as unknown as Gamepad;
  withGamepads(
    () => [pad],
    () => viewport.pollGamepad(),
  );
  assert.deepEqual([...viewport.gamepadInput.heldKeys], ['KeyW']);
  withGamepads(
    () => [null],
    () => {
      assert.equal(viewport.pollGamepad().padIndex, null);
      assert.deepEqual([...viewport.gamepadInput.heldKeys], []);
    },
  );
});

test('player-authored key and D-pad bindings drive viewport movement and actions', () => {
  const controls = resolvePlayerControls({
      keyboard: { moveForward: ['KeyI'], jump: ['KeyJ'] },
      gamepad: {
        moveForward: 15,
        moveRight: null,
        jump: [0],
        useItem: [],
        axes: {
          moveX: { axis: 2, inverted: true },
          moveY: { axis: null, inverted: false },
          lookX: { axis: null, inverted: false },
          lookY: { axis: null, inverted: false },
        },
      },
    }),
    player = {},
    simulation = {
      nodes: new Map([['player', player]]),
      component: () => ({ type: 'player', style: 'third-person', speed: 3, jump: 6, controls }),
      constructionState: () => null,
      inventory: [],
      items: new Map(),
    };
  type AuthoredViewportHarness = {
    session: { simulation: typeof simulation };
    gamepadInput: ReturnType<typeof mapGamepadInput>;
    playerControlsCache: WeakMap<object, unknown>;
    keys: Set<string>;
    touchMovement: { moveX: number; moveZ: number };
    pending: Record<string, boolean>;
    agentPaused: boolean;
    cameraOverride: boolean;
    pollGamepad: () => ReturnType<typeof mapGamepadInput>;
  };
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session: { simulation },
    gamepadInput: mapGamepadInput(null),
    playerControlsCache: new WeakMap(),
    keys: new Set<string>(),
    touchMovement: { moveX: 0, moveZ: 0 },
    pending: {},
    agentPaused: true,
    cameraOverride: true,
  }) as unknown as AuthoredViewportHarness;
  const prototype = GameViewport.prototype as unknown as {
    handleKeyDown: (event: KeyboardEvent) => void;
    pollGamepad: () => ReturnType<typeof mapGamepadInput>;
  };
  viewport.pollGamepad = () => prototype.pollGamepad.call(viewport);

  prototype.handleKeyDown.call(viewport, {
    code: 'KeyI',
    preventDefault() {},
  } as KeyboardEvent);
  assert.deepEqual(movementFromKeys(viewport.keys, controls.keyboard), { moveX: 0, moveZ: -1 });
  prototype.handleKeyDown.call(viewport, {
    code: 'KeyJ',
    preventDefault() {},
  } as KeyboardEvent);
  assert.deepEqual(viewport.pending, { jump: true });

  viewport.pending = {};
  const pad = {
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0.8],
    buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 0 || index === 15 ? 1 : 0 })),
  } as unknown as Gamepad;
  withGamepads(
    () => [pad],
    () => {
      const state = viewport.pollGamepad();
      assert.equal(state.moveZ, -1);
      assert.ok(state.moveX < -0.7);
      assert.deepEqual(viewport.pending, { jump: true });
    },
  );
});

test('right-stick look orbits the follow camera and clamps pitch above the player', () => {
  type CameraHarness = {
    gameCameraYaw: number;
    gameCameraPitch: number | null;
    gameCameraOffset: THREE.Vector3;
    agentPaused: boolean;
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3 };
    updateGameCamera: (
      target: THREE.Vector3,
      style: 'first-person' | 'top-down' | 'third-person',
      dt: number,
      lookX: number,
      lookY: number,
    ) => void;
  };
  const target = new THREE.Vector3(3, 1, -2);
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(target).add(new THREE.Vector3(0, 6, 10));
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    gameCameraYaw: 0,
    gameCameraPitch: null,
    gameCameraOffset: new THREE.Vector3(),
    agentPaused: false,
    camera,
    controls: { target: new THREE.Vector3() },
  }) as CameraHarness;
  const prototype = GameViewport.prototype as unknown as {
    updateGameCamera: CameraHarness['updateGameCamera'];
  };
  viewport.updateGameCamera = (target, style, dt, lookX, lookY) =>
    prototype.updateGameCamera.call(viewport, target, style, dt, lookX, lookY);

  viewport.updateGameCamera(target, 'third-person', 0.2, 0.5, 0.5);
  const offset = camera.position.clone().sub(target);
  assert.ok(offset.x > 0, 'horizontal stick should rotate the camera around the player');
  assert.ok(offset.y < 6, 'downward stick input should lower the camera angle');
  assert.deepEqual(viewport.controls.target.toArray(), target.toArray());

  viewport.updateGameCamera(target, 'third-person', 10, 0, 1);
  const lowAngle = Math.atan2(
    camera.position.y - target.y,
    Math.hypot(camera.position.x - target.x, camera.position.z - target.z),
  );
  assert.ok(lowAngle >= THREE.MathUtils.degToRad(8) - 1e-6);

  viewport.updateGameCamera(target, 'third-person', 10, 0, -1);
  const highAngle = Math.atan2(
    camera.position.y - target.y,
    Math.hypot(camera.position.x - target.x, camera.position.z - target.z),
  );
  assert.ok(highAngle <= THREE.MathUtils.degToRad(80) + 1e-6);
});
