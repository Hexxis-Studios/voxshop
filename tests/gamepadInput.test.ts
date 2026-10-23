import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GAMEPAD_AXES, mapGamepadInput, type GamepadLike } from '../runtime/gamepadInput';

const pad = (overrides: Partial<GamepadLike> = {}): GamepadLike => ({
  index: 0,
  connected: true,
  mapping: 'standard',
  axes: [0, 0],
  buttons: [],
  ...overrides,
});

test('left stick applies a radial deadzone and maps diagonal movement to WASD', () => {
  const centered = mapGamepadInput([pad({ axes: [0.19, 0.19] })]);
  assert.deepEqual([...centered.heldKeys], []);
  assert.deepEqual([centered.moveX, centered.moveZ], [0, 0]);

  const diagonal = mapGamepadInput([pad({ axes: [0.2, 0.2] })]);
  assert.deepEqual([...diagonal.heldKeys].sort(), ['KeyD', 'KeyS']);
  assert.ok(diagonal.moveX > 0 && diagonal.moveX < 0.01);
  assert.ok(diagonal.moveZ > 0 && diagonal.moveZ < 0.01);

  const cardinal = mapGamepadInput([pad({ axes: [-0.64, 0] })]);
  assert.deepEqual([...cardinal.heldKeys], ['KeyA']);
  assert.ok(Math.abs(cardinal.moveX + 0.5) < 1e-12);
  assert.equal(cardinal.moveZ, 0);
});

test('right stick exposes normalized look axes with a small radial deadzone', () => {
  const centered = mapGamepadInput([pad({ axes: [0, 0, 0.08, 0.08] })]);
  assert.deepEqual([centered.lookX, centered.lookY], [0, 0]);

  const look = mapGamepadInput([pad({ axes: [0, 0, 0.56, 0] })]);
  assert.ok(Math.abs(look.lookX - 0.5) < 1e-12);
  assert.equal(look.lookY, 0);

  const diagonal = mapGamepadInput([pad({ axes: [0, 0, 0.3, 0.4] })]);
  assert.ok(Math.abs(Math.hypot(diagonal.lookX, diagonal.lookY) - (0.5 - 0.12) / (1 - 0.12)) < 1e-12);
  assert.ok(Math.abs(diagonal.lookX / diagonal.lookY - 0.75) < 1e-12);
});

test('D-pad buttons map to arrows and use the inclusive button threshold', () => {
  const state = mapGamepadInput([
    pad({
      buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 12 ? 0.5 : 0 })),
    }),
  ]);
  assert.deepEqual([...state.heldKeys], ['ArrowUp']);
  assert.equal(state.moveZ, -1);
});

test('standard action buttons map to existing keyboard codes', () => {
  const state = mapGamepadInput([
    pad({
      buttons: Array.from({ length: 8 }, (_, index) => ({
        value: [0, 3, 4, 6, 7].includes(index) ? 0.5 : index === 2 ? 0.49 : 0,
      })),
    }),
  ]);
  assert.deepEqual([...state.heldKeys].sort(), ['KeyB', 'KeyF', 'KeyQ', 'KeyX', 'Space']);
});

test('pressed keys report rising edges while held keys and down buttons report current state', () => {
  const first = mapGamepadInput([pad({ buttons: [{ value: 1 }] })]);
  assert.deepEqual([...first.pressedKeys], ['Space']);

  const second = mapGamepadInput(
    [
      pad({
        buttons: [
          { value: 1 },
          { value: 0 },
          { value: 0 },
          { value: 0 },
          { value: 0 },
          { value: 0 },
          { value: 0 },
          { value: 0.7 },
        ],
      }),
    ],
    first,
  );
  assert.deepEqual([...second.heldKeys].sort(), ['KeyB', 'Space']);
  assert.deepEqual([...second.pressedKeys], ['KeyB']);

  const released = mapGamepadInput([pad()], second);
  assert.deepEqual([...released.heldKeys], []);
  assert.deepEqual([...released.pressedKeys], []);
});

test('either bumper emits KeyQ only when the mapped key rises', () => {
  const left = mapGamepadInput([
    pad({ buttons: Array.from({ length: 6 }, (_, index) => ({ value: index === 4 ? 1 : 0 })) }),
  ]);
  assert.deepEqual([...left.pressedKeys], ['KeyQ']);

  const held = mapGamepadInput(
    [pad({ buttons: Array.from({ length: 6 }, (_, index) => ({ value: index === 4 ? 1 : 0 })) })],
    left,
  );
  assert.deepEqual([...held.pressedKeys], []);

  const released = mapGamepadInput([pad()], held);
  const right = mapGamepadInput(
    [pad({ buttons: Array.from({ length: 6 }, (_, index) => ({ value: index === 5 ? 1 : 0 })) })],
    released,
  );
  assert.deepEqual([...right.pressedKeys], ['KeyQ']);
});

test('switching selected controllers resets prior key edges and reports padIndex', () => {
  const first = mapGamepadInput([pad({ buttons: [{ value: 1 }] })]);
  const next = mapGamepadInput([null, pad({ index: 1, buttons: [{ value: 1 }] })], first);
  assert.equal(next.padIndex, 1);
  assert.deepEqual([...next.pressedKeys], ['Space']);
});

test('null, disconnected, and non-standard pads produce an empty state', () => {
  for (const pads of [
    null,
    undefined,
    [null],
    [pad({ connected: false, buttons: [{ value: 1 }] })],
    [pad({ mapping: 'vendor', buttons: [{ value: 1 }] })],
  ]) {
    assert.deepEqual(mapGamepadInput(pads), {
      padIndex: null,
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      heldKeys: new Set(),
      pressedKeys: new Set(),
      heldButtons: new Set(),
      pressedButtons: new Set(),
    });
  }
});

test('the first connected standard-layout pad is selected', () => {
  const state = mapGamepadInput([
    pad({ mapping: 'vendor' }),
    pad({ index: 1, connected: false }),
    pad({ index: 2, axes: [0, -1] }),
    pad({ index: 3, buttons: [{ value: 1 }] }),
  ]);
  assert.equal(state.padIndex, 2);
  assert.deepEqual([...state.heldKeys], ['KeyW']);
  assert.equal(state.moveZ, -1);
});

test('malformed axes and buttons are ignored safely', () => {
  const malformed = mapGamepadInput([
    pad({
      axes: [Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY],
      buttons: [null, { value: Number.NaN }, { value: '1' }, { value: Number.POSITIVE_INFINITY }],
    }),
  ]);
  assert.deepEqual([...malformed.heldKeys], []);
  assert.deepEqual([malformed.moveX, malformed.moveZ], [0, 0]);
  assert.deepEqual([malformed.lookX, malformed.lookY], [0, 0]);

  const finiteAxisSurvives = mapGamepadInput([pad({ axes: [Number.NaN, -0.8, Number.NaN, -0.8] })]);
  assert.deepEqual([...finiteAxisSurvives.heldKeys], ['KeyW']);
  assert.equal(finiteAxisSurvives.lookX, 0);
  assert.ok(finiteAxisSurvives.lookY < -0.7);
});

test('button edges expose physical indices and authored D-pad directions change movement', () => {
  const bindings = { moveForward: 15, moveBackward: null, moveLeft: 13, moveRight: 14 };
  const pressed = mapGamepadInput(
    [pad({ buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 15 ? 1 : 0 })) })],
    undefined,
    bindings,
  );
  assert.deepEqual([...pressed.heldButtons], [15]);
  assert.deepEqual([...pressed.pressedButtons], [15]);
  assert.equal(pressed.moveZ, -1);
  assert.equal(pressed.moveX, 0);

  const held = mapGamepadInput(
    [pad({ buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 15 ? 1 : 0 })) })],
    pressed,
    bindings,
  );
  assert.deepEqual([...held.pressedButtons], []);
});

test('unmapped controllers expose raw buttons to authored bindings', () => {
  const state = mapGamepadInput(
    [
      pad({
        mapping: '',
        axes: [0, -1, 0.5, 0],
        buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 9 ? 1 : 0 })),
      }),
    ],
    undefined,
    { moveForward: 9, moveBackward: null, moveLeft: null, moveRight: null },
  );
  assert.equal(state.padIndex, 0);
  assert.deepEqual([...state.pressedButtons], [9]);
  assert.equal(state.moveZ, -1);
  assert.ok(state.lookX > 0.4);
});

test('authored axis indices, inversion, and unbound sticks apply to raw gamepad axes', () => {
  const axes = {
    ...DEFAULT_GAMEPAD_AXES,
    moveX: { axis: 4, inverted: true },
    moveY: { axis: null, inverted: false },
    lookX: { axis: 1, inverted: false },
    lookY: { axis: 2, inverted: true },
  };
  const state = mapGamepadInput(
    [pad({ mapping: '', axes: [0, 0.8, 0.7, 0, 0.9] })],
    undefined,
    undefined,
    axes,
  );
  assert.ok(state.moveX < -0.8);
  assert.equal(state.moveZ, 0);
  assert.ok(state.lookX > 0.7);
  assert.ok(state.lookY < -0.5);

  const invertedMove = mapGamepadInput([pad({ axes: [0, 0, 0, 0, 0.8] })], undefined, undefined, {
    ...DEFAULT_GAMEPAD_AXES,
    moveX: { axis: 4, inverted: true },
    lookX: { axis: null, inverted: false },
    lookY: { axis: null, inverted: false },
  });
  assert.ok(invertedMove.moveX < -0.7);
});
