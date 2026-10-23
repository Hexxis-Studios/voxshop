import { z } from 'zod';

const keyboardCodeSchema = z
  .string()
  .regex(
    /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Meta(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter))$/,
    'Use a supported KeyboardEvent.code value.',
  );
const keyboardBindingSchema = z.union([keyboardCodeSchema, z.literal('')]);
const buttonIndexSchema = z.number().int().min(0).max(31);
const axisIndexSchema = z.number().int().min(0).max(15);
const keyList = (values: string[]) => z.array(keyboardBindingSchema).max(4).default(values);
const buttonList = (values: number[]) => z.array(buttonIndexSchema).max(4).default(values);

const defaultKeyboard = {
  togglePause: ['Escape'],
  moveForward: ['KeyW', 'ArrowUp'],
  moveBackward: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  interact: ['KeyE'],
  attack: ['KeyF'],
  useItem: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'],
  placeCell: ['KeyB'],
  removeCell: ['KeyX'],
  cyclePaint: ['KeyQ'],
};

const defaultGamepad = {
  togglePause: [9],
  moveForward: 12,
  moveBackward: 13,
  moveLeft: 14,
  moveRight: 15,
  sprint: [],
  jump: [0],
  interact: [2],
  attack: [3],
  useItem: [1],
  placeCell: [7],
  removeCell: [6],
  cyclePaint: [4, 5],
  axes: {
    moveX: { axis: 0, inverted: false },
    moveY: { axis: 1, inverted: false },
    lookX: { axis: 2, inverted: false },
    lookY: { axis: 3, inverted: false },
  },
};

const gamepadAxisSchema = z.object({ axis: axisIndexSchema.nullable(), inverted: z.boolean() });
const gamepadAxesSchema = z.object({
  moveX: gamepadAxisSchema.default(defaultGamepad.axes.moveX),
  moveY: gamepadAxisSchema.default(defaultGamepad.axes.moveY),
  lookX: gamepadAxisSchema.default(defaultGamepad.axes.lookX),
  lookY: gamepadAxisSchema.default(defaultGamepad.axes.lookY),
});

const keyboardSchema = z.object({
  togglePause: keyList(defaultKeyboard.togglePause),
  moveForward: keyList(defaultKeyboard.moveForward),
  moveBackward: keyList(defaultKeyboard.moveBackward),
  moveLeft: keyList(defaultKeyboard.moveLeft),
  moveRight: keyList(defaultKeyboard.moveRight),
  sprint: keyList(defaultKeyboard.sprint),
  jump: keyList(defaultKeyboard.jump),
  interact: keyList(defaultKeyboard.interact),
  attack: keyList(defaultKeyboard.attack),
  useItem: z.array(keyboardBindingSchema).length(9).default(defaultKeyboard.useItem),
  placeCell: keyList(defaultKeyboard.placeCell),
  removeCell: keyList(defaultKeyboard.removeCell),
  cyclePaint: keyList(defaultKeyboard.cyclePaint),
});

const gamepadSchema = z.object({
  togglePause: buttonList(defaultGamepad.togglePause),
  moveForward: buttonIndexSchema.nullable().default(defaultGamepad.moveForward),
  moveBackward: buttonIndexSchema.nullable().default(defaultGamepad.moveBackward),
  moveLeft: buttonIndexSchema.nullable().default(defaultGamepad.moveLeft),
  moveRight: buttonIndexSchema.nullable().default(defaultGamepad.moveRight),
  sprint: buttonList(defaultGamepad.sprint),
  jump: buttonList(defaultGamepad.jump),
  interact: buttonList(defaultGamepad.interact),
  attack: buttonList(defaultGamepad.attack),
  useItem: buttonList(defaultGamepad.useItem),
  placeCell: buttonList(defaultGamepad.placeCell),
  removeCell: buttonList(defaultGamepad.removeCell),
  cyclePaint: buttonList(defaultGamepad.cyclePaint),
  axes: gamepadAxesSchema.default(defaultGamepad.axes),
});

export const playerControlsSchema = z
  .object({
    keyboard: keyboardSchema.default(defaultKeyboard),
    gamepad: gamepadSchema.default(defaultGamepad),
  })
  .superRefine((controls, context) => {
    const keyboard = new Map<string, string>();
    for (const [action, codes] of Object.entries(controls.keyboard))
      for (const code of codes) {
        if (!code) continue;
        const previous = keyboard.get(code);
        if (previous)
          context.addIssue({
            code: 'custom',
            path: ['keyboard', action],
            message: `${code} is already assigned to ${previous}.`,
          });
        else keyboard.set(code, action);
      }

    const gamepad = new Map<number, string>();
    for (const action of ['moveForward', 'moveBackward', 'moveLeft', 'moveRight'] as const) {
      const button = controls.gamepad[action];
      if (button === null) continue;
      const previous = gamepad.get(button);
      if (previous)
        context.addIssue({
          code: 'custom',
          path: ['gamepad', action],
          message: `Button ${button} is already assigned to ${previous}.`,
        });
      else gamepad.set(button, action);
    }
    for (const action of [
      'togglePause',
      'sprint',
      'jump',
      'interact',
      'attack',
      'useItem',
      'placeCell',
      'removeCell',
      'cyclePaint',
    ] as const)
      for (const button of controls.gamepad[action]) {
        const previous = gamepad.get(button);
        if (previous)
          context.addIssue({
            code: 'custom',
            path: ['gamepad', action],
            message: `Button ${button} is already assigned to ${previous}.`,
          });
        else gamepad.set(button, action);
      }
  });

export type PlayerControls = z.infer<typeof playerControlsSchema>;
export type KeyboardControl = keyof PlayerControls['keyboard'];
export type GamepadControl = Exclude<keyof PlayerControls['gamepad'], 'axes'>;
export type GamepadAxisControl = keyof PlayerControls['gamepad']['axes'];
export const DEFAULT_PLAYER_CONTROLS = playerControlsSchema.parse({});

export function resolvePlayerControls(controls?: unknown): PlayerControls {
  return controls === undefined ? DEFAULT_PLAYER_CONTROLS : playerControlsSchema.parse(controls);
}

export type KeyboardBindingTarget = { control: KeyboardControl; index: number };
export type KeyboardBindingResult =
  | { ok: true; controls: PlayerControls }
  | { ok: false; reason: 'unsupported' }
  | { ok: false; reason: 'conflict'; conflict: KeyboardBindingTarget };

/** Assigns a key only when it is supported and unused, so editor changes remain schema-valid. */
export function bindKeyboardControl(
  controls: PlayerControls,
  control: KeyboardControl,
  index: number,
  code: string,
): KeyboardBindingResult {
  if (!keyboardCodeSchema.safeParse(code).success) return { ok: false, reason: 'unsupported' };
  const values = controls.keyboard[control];
  const fixedSlots = control === 'useItem';
  if (index < 0 || index > values.length || (fixedSlots && index >= values.length))
    return { ok: false, reason: 'unsupported' };
  for (const [otherControl, codes] of Object.entries(controls.keyboard) as [KeyboardControl, string[]][]) {
    const duplicateIndex = codes.findIndex(
      (candidate, candidateIndex) =>
        candidate === code && !(otherControl === control && candidateIndex === index),
    );
    if (duplicateIndex >= 0)
      return { ok: false, reason: 'conflict', conflict: { control: otherControl, index: duplicateIndex } };
  }
  const nextValues = [...values];
  if (index === nextValues.length) nextValues.push(code);
  else nextValues[index] = code;
  return {
    ok: true,
    controls: playerControlsSchema.parse({
      ...controls,
      keyboard: { ...controls.keyboard, [control]: nextValues },
    }),
  };
}

/** Removes one alternative, or clears a fixed inventory slot without changing its slot index. */
export function clearKeyboardControl(
  controls: PlayerControls,
  control: KeyboardControl,
  index: number,
): PlayerControls {
  const values = controls.keyboard[control];
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return controls;
  const nextValues = [...values];
  if (control === 'useItem') nextValues[index] = '';
  else nextValues.splice(index, 1);
  return playerControlsSchema.parse({
    ...controls,
    keyboard: { ...controls.keyboard, [control]: nextValues },
  });
}

/** Adds an empty optional key slot; fixed nine-slot inventory bindings cannot be extended. */
export function addKeyboardControlSlot(controls: PlayerControls, control: KeyboardControl): PlayerControls {
  if (control === 'useItem') return controls;
  const values = controls.keyboard[control];
  if (values.length >= 4) return controls;
  return playerControlsSchema.parse({
    ...controls,
    keyboard: { ...controls.keyboard, [control]: [...values, ''] },
  });
}

export type GamepadBindingTarget = { control: GamepadControl; index: number };
export type GamepadBindingResult =
  | { ok: true; controls: PlayerControls }
  | { ok: false; reason: 'unsupported' }
  | { ok: false; reason: 'conflict'; conflict: GamepadBindingTarget };

const directionalGamepadControls = new Set<GamepadControl>([
  'moveForward',
  'moveBackward',
  'moveLeft',
  'moveRight',
]);

/** Changes one standard-gamepad binding without creating a duplicate action mapping. */
export function bindGamepadControl(
  controls: PlayerControls,
  control: GamepadControl,
  index: number,
  button: number | null,
): GamepadBindingResult {
  if (!Number.isInteger(index) || index < 0) return { ok: false, reason: 'unsupported' };
  const directional = directionalGamepadControls.has(control);
  if ((directional && index !== 0) || (!directional && index > 4))
    return { ok: false, reason: 'unsupported' };
  if (button !== null && !buttonIndexSchema.safeParse(button).success)
    return { ok: false, reason: 'unsupported' };
  if (button !== null) {
    for (const otherControl of [
      'togglePause',
      'moveForward',
      'moveBackward',
      'moveLeft',
      'moveRight',
      'sprint',
      'jump',
      'interact',
      'attack',
      'useItem',
      'placeCell',
      'removeCell',
      'cyclePaint',
    ] as const) {
      const value = controls.gamepad[otherControl];
      const otherButtons = Array.isArray(value) ? value : value === null ? [] : [value];
      const duplicateIndex = otherButtons.findIndex(
        (candidate, candidateIndex) =>
          candidate === button && !(otherControl === control && candidateIndex === index),
      );
      if (duplicateIndex >= 0)
        return { ok: false, reason: 'conflict', conflict: { control: otherControl, index: duplicateIndex } };
    }
  }
  const current = controls.gamepad[control];
  if (directional)
    return {
      ok: true,
      controls: playerControlsSchema.parse({
        ...controls,
        gamepad: { ...controls.gamepad, [control]: button },
      }),
    };
  const nextButtons = [...(current as number[])];
  if (button === null) {
    if (index >= nextButtons.length) return { ok: true, controls };
    nextButtons.splice(index, 1);
  } else if (index === nextButtons.length) {
    if (nextButtons.length >= 4) return { ok: false, reason: 'unsupported' };
    nextButtons.push(button);
  } else if (index < nextButtons.length) nextButtons[index] = button;
  else return { ok: false, reason: 'unsupported' };
  return {
    ok: true,
    controls: playerControlsSchema.parse({
      ...controls,
      gamepad: { ...controls.gamepad, [control]: nextButtons },
    }),
  };
}

/** Remaps one raw controller axis while preserving its inversion setting. */
export function bindGamepadAxis(
  controls: PlayerControls,
  control: GamepadAxisControl,
  axis: number | null,
): PlayerControls {
  if (axis !== null && !axisIndexSchema.safeParse(axis).success) return controls;
  return playerControlsSchema.parse({
    ...controls,
    gamepad: {
      ...controls.gamepad,
      axes: { ...controls.gamepad.axes, [control]: { ...controls.gamepad.axes[control], axis } },
    },
  });
}

/** Flips one raw controller axis independently from the hardware's reported sign. */
export function invertGamepadAxis(
  controls: PlayerControls,
  control: GamepadAxisControl,
  inverted: boolean,
): PlayerControls {
  return playerControlsSchema.parse({
    ...controls,
    gamepad: {
      ...controls.gamepad,
      axes: { ...controls.gamepad.axes, [control]: { ...controls.gamepad.axes[control], inverted } },
    },
  });
}

export function movementFromKeys(keys: ReadonlySet<string>, controls: PlayerControls['keyboard']) {
  const has = (control: 'moveForward' | 'moveBackward' | 'moveLeft' | 'moveRight') =>
    controls[control].some((code) => keys.has(code));
  return {
    moveX: Number(has('moveRight')) - Number(has('moveLeft')),
    moveZ: Number(has('moveBackward')) - Number(has('moveForward')),
  };
}

export function keyboardActionForCode(code: string, controls: PlayerControls['keyboard']) {
  if (!code) return null;
  const action = (
    [
      'togglePause',
      'moveForward',
      'moveBackward',
      'moveLeft',
      'moveRight',
      'sprint',
      'jump',
      'interact',
      'attack',
      'placeCell',
      'removeCell',
      'cyclePaint',
    ] as const
  ).find((candidate) => controls[candidate].includes(code));
  if (action) return { action } as const;
  const itemSlot = controls.useItem.indexOf(code);
  return itemSlot < 0 ? null : { action: 'useItem' as const, itemSlot };
}

function displayKey(code: string) {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  return code;
}

const GAMEPAD_BUTTON_LABELS = [
  'bottom face',
  'right face',
  'left face',
  'top face',
  'left shoulder',
  'right shoulder',
  'left trigger',
  'right trigger',
  'select',
  'start',
  'left stick press',
  'right stick press',
  'D-pad up',
  'D-pad down',
  'D-pad left',
  'D-pad right',
];

export function describePlayerControls(value?: unknown) {
  const controls = resolvePlayerControls(value),
    keys = controls.keyboard,
    gamepad = controls.gamepad,
    keyboard = (action: KeyboardControl) =>
      keys[action].map((code) => (code ? displayKey(code) : 'unbound')).join('/') || 'unbound',
    button = (action: GamepadControl) => {
      const value = gamepad[action],
        buttons = Array.isArray(value) ? value : value === null ? [] : [value];
      return (
        buttons.map((index) => GAMEPAD_BUTTON_LABELS[index] ?? `button ${index + 1}`).join('/') || 'unbound'
      );
    };
  return [
    `Keyboard ${keyboard('moveForward')}/${keyboard('moveLeft')}/${keyboard('moveBackward')}/${keyboard('moveRight')} move`,
    `${keyboard('togglePause')} pause/resume`,
    `${keyboard('sprint')} sprint`,
    `${keyboard('jump')} jump`,
    `${keyboard('interact')} interact`,
    `${keyboard('attack')} attack`,
    `inventory ${keys.useItem.map((code) => (code ? displayKey(code) : 'unbound')).join('/')}`,
    `${keyboard('placeCell')} place · ${keyboard('removeCell')} remove · ${keyboard('cyclePaint')} cycle paint`,
    `gamepad left stick move (axes ${gamepad.axes.moveX.axis ?? 'unbound'}/${gamepad.axes.moveY.axis ?? 'unbound'}) · D-pad ${button('moveForward')}/${button('moveLeft')}/${button('moveBackward')}/${button('moveRight')}`,
    `${button('jump')} jump · ${button('interact')} interact · ${button('attack')} attack · ${button('useItem')} use item`,
    `${button('sprint')} sprint`,
    `${button('togglePause')} pause/resume`,
    `${button('placeCell')} place · ${button('removeCell')} remove · ${button('cyclePaint')} cycle paint · right stick look (axes ${gamepad.axes.lookX.axis ?? 'unbound'}/${gamepad.axes.lookY.axis ?? 'unbound'})`,
    'Mouse right-drag or touch drag to look',
  ].join(' · ');
}
