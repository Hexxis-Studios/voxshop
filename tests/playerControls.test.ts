import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayerControlsEditor } from '../components/PlayerControlsEditor';
import { componentSchema } from '../services/projectDocument';
import {
  addKeyboardControlSlot,
  bindKeyboardControl,
  bindGamepadControl,
  bindGamepadAxis,
  clearKeyboardControl,
  DEFAULT_PLAYER_CONTROLS,
  keyboardActionForCode,
  invertGamepadAxis,
  movementFromKeys,
  playerControlsSchema,
  resolvePlayerControls,
} from '../services/playerControls';

test('legacy player components keep their controls and can omit the optional first-person eye height', () => {
  const player = componentSchema.parse({ type: 'player', style: 'third-person', speed: 3 });
  assert.equal(player.type, 'player');
  if (player.type !== 'player') throw new Error('Expected player component.');
  assert.equal(player.controls, undefined);
  assert.equal(player.cameraHeight, undefined);
  assert.deepEqual(resolvePlayerControls(player.controls), DEFAULT_PLAYER_CONTROLS);
  assert.deepEqual(DEFAULT_PLAYER_CONTROLS.keyboard.togglePause, ['Escape']);
  assert.deepEqual(DEFAULT_PLAYER_CONTROLS.keyboard.sprint, ['ShiftLeft', 'ShiftRight']);
  assert.deepEqual(DEFAULT_PLAYER_CONTROLS.gamepad.sprint, []);
  assert.deepEqual(keyboardActionForCode('ShiftLeft', DEFAULT_PLAYER_CONTROLS.keyboard), {
    action: 'sprint',
  });
  assert.deepEqual(DEFAULT_PLAYER_CONTROLS.gamepad.togglePause, [9]);
  assert.deepEqual(keyboardActionForCode('Escape', DEFAULT_PLAYER_CONTROLS.keyboard), {
    action: 'togglePause',
  });
  assert.deepEqual(movementFromKeys(new Set(['KeyW', 'KeyD']), DEFAULT_PLAYER_CONTROLS.keyboard), {
    moveX: 1,
    moveZ: -1,
  });
  assert.deepEqual(keyboardActionForCode('Digit4', DEFAULT_PLAYER_CONTROLS.keyboard), {
    action: 'useItem',
    itemSlot: 3,
  });
});

test('first-person camera settings accept bounded eye height and older style values remain valid', () => {
  const firstPerson = componentSchema.parse({ type: 'player', style: 'first-person', speed: 4 });
  assert.equal(firstPerson.type, 'player');
  if (firstPerson.type !== 'player') throw new Error('Expected player component.');
  assert.equal(firstPerson.style, 'first-person');
  assert.equal(firstPerson.cameraHeight, undefined);
  for (const cameraHeight of [0, 0.249, 10.001, Number.NaN])
    assert.equal(
      componentSchema.safeParse({ type: 'player', style: 'first-person', speed: 4, cameraHeight }).success,
      false,
    );
});

test('partial authored controls fill missing defaults and reject conflicting bindings', () => {
  const custom = playerControlsSchema.parse({ keyboard: { moveForward: ['KeyI'], jump: ['KeyJ'] } });
  assert.deepEqual(custom.keyboard.moveForward, ['KeyI']);
  assert.deepEqual(custom.keyboard.moveBackward, ['KeyS', 'ArrowDown']);
  assert.deepEqual(custom.gamepad.jump, [0]);
  assert.deepEqual(movementFromKeys(new Set(['KeyI']), custom.keyboard), { moveX: 0, moveZ: -1 });
  assert.equal(playerControlsSchema.safeParse({ keyboard: { jump: ['KeyW'] } }).success, false);
  assert.equal(playerControlsSchema.safeParse({ gamepad: { attack: [0] } }).success, false);
});

test('player controls inspector exposes keyboard capture, gamepad mapping and defaults', () => {
  const html = renderToStaticMarkup(
    React.createElement(PlayerControlsEditor, {
      controls: DEFAULT_PLAYER_CONTROLS,
      onChange: () => {},
    }),
  );
  assert.match(html, /Keyboard, gamepad and touch controls/);
  assert.match(html, /Unmapped controllers use raw button and axis indices/);
  assert.match(html, /aria-label="Bind Move forward key 1"/);
  assert.match(html, /aria-label="Bind Sprint key 1"/);
  assert.match(html, /Gamepad binding: Sprint button 1/);
  assert.match(html, /aria-label="Bind Move forward key 2"/);
  assert.match(html, /aria-label="Unbind Move forward key 1"/);
  assert.match(html, /aria-label="Add alternate key for Move forward"/);
  assert.match(html, /aria-label="Gamepad binding: Jump button 1"/);
  assert.match(html, /aria-label="Gamepad axis: Movement horizontal"/);
  assert.match(html, /Pause \/ resume/);
  assert.match(html, /Pause \/ resume · Start/);
  assert.match(html, /aria-label="Invert gamepad axis: Camera vertical"/);
  assert.match(html, /aria-label="Gamepad binding: Cycle construction paint button 2"/);
  assert.match(html, /aria-label="Unbind gamepad Cycle construction paint button 1"/);
  assert.match(html, /Restore default controls/);
  assert.match(html, /Touch buttons call these gameplay actions directly/);
});

test('keyboard remapping reports conflicts and unsupported hardware codes without changing controls', () => {
  const duplicate = bindKeyboardControl(DEFAULT_PLAYER_CONTROLS, 'jump', 0, 'KeyW');
  assert.deepEqual(duplicate, {
    ok: false,
    reason: 'conflict',
    conflict: { control: 'moveForward', index: 0 },
  });
  const unsupported = bindKeyboardControl(DEFAULT_PLAYER_CONTROLS, 'jump', 0, 'F1');
  assert.deepEqual(unsupported, { ok: false, reason: 'unsupported' });
  assert.deepEqual(DEFAULT_PLAYER_CONTROLS.keyboard.jump, ['Space']);

  const rebound = bindKeyboardControl(DEFAULT_PLAYER_CONTROLS, 'jump', 0, 'KeyJ');
  assert.equal(rebound.ok, true);
  if (!rebound.ok) throw new Error('Expected a valid key binding.');
  assert.deepEqual(rebound.controls.keyboard.jump, ['KeyJ']);
  assert.equal(playerControlsSchema.safeParse(rebound.controls).success, true);
});

test('alternate keys can be added and removed without hiding active defaults', () => {
  const cleared = clearKeyboardControl(DEFAULT_PLAYER_CONTROLS, 'moveForward', 0);
  assert.deepEqual(cleared.keyboard.moveForward, ['ArrowUp']);
  assert.deepEqual(movementFromKeys(new Set(['KeyW']), cleared.keyboard), { moveX: 0, moveZ: 0 });
  const withAlternate = addKeyboardControlSlot(cleared, 'moveForward');
  assert.deepEqual(withAlternate.keyboard.moveForward, ['ArrowUp', '']);
  const bound = bindKeyboardControl(withAlternate, 'moveForward', 1, 'KeyI');
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error('Expected a valid alternate key.');
  assert.deepEqual(bound.controls.keyboard.moveForward, ['ArrowUp', 'KeyI']);
  assert.deepEqual(movementFromKeys(new Set(['KeyI']), bound.controls.keyboard), { moveX: 0, moveZ: -1 });
  assert.deepEqual(clearKeyboardControl(bound.controls, 'moveForward', 1).keyboard.moveForward, ['ArrowUp']);
});

test('inventory slots may be explicitly unbound while retaining stable slot indices', () => {
  const cleared = clearKeyboardControl(DEFAULT_PLAYER_CONTROLS, 'useItem', 0);
  assert.equal(cleared.keyboard.useItem.length, 9);
  assert.equal(cleared.keyboard.useItem[0], '');
  assert.equal(keyboardActionForCode('Digit1', cleared.keyboard), null);
  assert.deepEqual(keyboardActionForCode('Digit2', cleared.keyboard), { action: 'useItem', itemSlot: 1 });
  assert.equal(playerControlsSchema.safeParse(cleared).success, true);
  const savedPlayer = componentSchema.parse({
    type: 'player',
    style: 'first-person',
    speed: 4,
    controls: cleared,
  });
  assert.equal(savedPlayer.type, 'player');
  if (savedPlayer.type !== 'player') throw new Error('Expected a player component.');
  assert.equal(savedPlayer.controls?.keyboard.useItem[0], '');
});

test('gamepad remapping rejects conflicts and preserves existing alternate buttons', () => {
  const duplicate = bindGamepadControl(DEFAULT_PLAYER_CONTROLS, 'attack', 0, 0);
  assert.deepEqual(duplicate, {
    ok: false,
    reason: 'conflict',
    conflict: { control: 'jump', index: 0 },
  });

  const rebound = bindGamepadControl(DEFAULT_PLAYER_CONTROLS, 'cyclePaint', 0, 8);
  assert.equal(rebound.ok, true);
  if (!rebound.ok) throw new Error('Expected a valid gamepad binding.');
  assert.deepEqual(rebound.controls.gamepad.cyclePaint, [8, 5]);
  const cleared = bindGamepadControl(rebound.controls, 'cyclePaint', 1, null);
  assert.equal(cleared.ok, true);
  if (!cleared.ok) throw new Error('Expected to clear one alternate button.');
  assert.deepEqual(cleared.controls.gamepad.cyclePaint, [8]);
  assert.equal(playerControlsSchema.safeParse(cleared.controls).success, true);
});

test('sprint can be assigned a gamepad button and participates in conflict checks', () => {
  const bound = bindGamepadControl(DEFAULT_PLAYER_CONTROLS, 'sprint', 0, 8);
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error('Expected sprint to accept a gamepad binding.');
  assert.deepEqual(bound.controls.gamepad.sprint, [8]);
  assert.deepEqual(bindGamepadControl(bound.controls, 'sprint', 0, 0), {
    ok: false,
    reason: 'conflict',
    conflict: { control: 'jump', index: 0 },
  });
});

test('gamepad movement can be unassigned and restored with a nonconflicting button', () => {
  const unassigned = bindGamepadControl(DEFAULT_PLAYER_CONTROLS, 'moveForward', 0, null);
  assert.equal(unassigned.ok, true);
  if (!unassigned.ok) throw new Error('Expected to clear movement.');
  assert.equal(unassigned.controls.gamepad.moveForward, null);
  const restored = bindGamepadControl(unassigned.controls, 'moveForward', 0, 10);
  assert.equal(restored.ok, true);
  if (!restored.ok) throw new Error('Expected to set movement.');
  assert.equal(restored.controls.gamepad.moveForward, 10);
  assert.equal(playerControlsSchema.safeParse(restored.controls).success, true);
});

test('gamepad axis bindings can be reassigned, inverted, and unbound while legacy defaults remain', () => {
  const old = playerControlsSchema.parse({ gamepad: { jump: [0] } });
  assert.deepEqual(old.gamepad.axes.moveX, { axis: 0, inverted: false });
  assert.deepEqual(old.gamepad.axes.lookY, { axis: 3, inverted: false });

  const remapped = bindGamepadAxis(old, 'lookY', 7);
  assert.deepEqual(remapped.gamepad.axes.lookY, { axis: 7, inverted: false });
  const inverted = invertGamepadAxis(remapped, 'lookY', true);
  assert.deepEqual(inverted.gamepad.axes.lookY, { axis: 7, inverted: true });
  const unbound = bindGamepadAxis(inverted, 'lookY', null);
  assert.deepEqual(unbound.gamepad.axes.lookY, { axis: null, inverted: true });
  assert.equal(playerControlsSchema.safeParse(unbound).success, true);
  assert.equal(
    playerControlsSchema.safeParse({ gamepad: { axes: { moveX: { axis: 16, inverted: false } } } }).success,
    false,
  );
});
