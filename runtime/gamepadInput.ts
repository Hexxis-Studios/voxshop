export interface GamepadButtonLike {
  readonly value?: unknown;
}

export interface GamepadLike {
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes?: readonly unknown[];
  readonly buttons?: readonly (GamepadButtonLike | null | undefined)[];
}

export interface GamepadInput {
  padIndex: number | null;
  moveX: number;
  moveZ: number;
  lookX: number;
  lookY: number;
  heldKeys: ReadonlySet<string>;
  pressedKeys: ReadonlySet<string>;
  heldButtons: ReadonlySet<number>;
  pressedButtons: ReadonlySet<number>;
}

export type GamepadDirections = {
  moveForward: number | null;
  moveBackward: number | null;
  moveLeft: number | null;
  moveRight: number | null;
};

export type GamepadAxisBinding = { axis: number | null; inverted: boolean };
export type GamepadAxes = Record<'moveX' | 'moveY' | 'lookX' | 'lookY', GamepadAxisBinding>;

export const DEFAULT_GAMEPAD_AXES: GamepadAxes = {
  moveX: { axis: 0, inverted: false },
  moveY: { axis: 1, inverted: false },
  lookX: { axis: 2, inverted: false },
  lookY: { axis: 3, inverted: false },
};

export const DEFAULT_GAMEPAD_DIRECTIONS: GamepadDirections = {
  moveForward: 12,
  moveBackward: 13,
  moveLeft: 14,
  moveRight: 15,
};

const DEADZONE = 0.28;
const LOOK_DEADZONE = 0.12;
const BUTTON_THRESHOLD = 0.5;
const BUTTON_CODES: Readonly<Record<number, string>> = {
  0: 'Space',
  2: 'KeyE',
  3: 'KeyF',
  4: 'KeyQ',
  5: 'KeyQ',
  6: 'KeyX',
  7: 'KeyB',
  12: 'ArrowUp',
  13: 'ArrowDown',
  14: 'ArrowLeft',
  15: 'ArrowRight',
};

function normalizedStick(x: number, y: number, deadzone: number): [number, number] {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return [0, 0];
  const adjustedMagnitude = (Math.min(1, magnitude) - deadzone) / (1 - deadzone);
  return [(x / magnitude) * adjustedMagnitude, (y / magnitude) * adjustedMagnitude];
}

export function mapGamepadInput(
  pads: readonly (GamepadLike | null)[] | null | undefined,
  previous?: Pick<GamepadInput, 'padIndex' | 'heldKeys' | 'heldButtons'>,
  directions: GamepadDirections = DEFAULT_GAMEPAD_DIRECTIONS,
  axes: GamepadAxes = DEFAULT_GAMEPAD_AXES,
): GamepadInput {
  const pad = pads?.find(
    (candidate) => candidate?.connected && (candidate.mapping === 'standard' || candidate.mapping === ''),
  );
  if (!pad)
    return {
      padIndex: null,
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      heldKeys: new Set(),
      pressedKeys: new Set(),
      heldButtons: new Set(),
      pressedButtons: new Set(),
    };

  const heldKeys = new Set<string>();
  const heldButtons = new Set<number>();
  const buttons = pad.buttons ?? [];
  for (let index = 0; index < buttons.length; index++) {
    const value = buttons[index]?.value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= BUTTON_THRESHOLD) {
      heldButtons.add(index);
      const code = BUTTON_CODES[index];
      if (code) heldKeys.add(code);
    }
  }

  const finiteAxis = (index: number | null) => {
    if (index === null) return 0;
    const value = pad.axes?.[index];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  };
  const axisValue = (binding: GamepadAxisBinding) => finiteAxis(binding.axis) * (binding.inverted ? -1 : 1);
  const x = axisValue(axes.moveX);
  const y = axisValue(axes.moveY);
  const magnitude = Math.hypot(x, y);
  let [moveX, moveZ] = normalizedStick(x, y, DEADZONE);
  const [lookX, lookY] = normalizedStick(axisValue(axes.lookX), axisValue(axes.lookY), LOOK_DEADZONE);
  if (magnitude > DEADZONE) {
    if (Math.abs(x / magnitude) >= DEADZONE) heldKeys.add(x < 0 ? 'KeyA' : 'KeyD');
    if (Math.abs(y / magnitude) >= DEADZONE) heldKeys.add(y < 0 ? 'KeyW' : 'KeyS');
  }
  const down = (index: number | null) => index !== null && heldButtons.has(index);
  moveX = Math.max(
    -1,
    Math.min(1, moveX + Number(down(directions.moveRight)) - Number(down(directions.moveLeft))),
  );
  moveZ = Math.max(
    -1,
    Math.min(1, moveZ + Number(down(directions.moveBackward)) - Number(down(directions.moveForward))),
  );

  const previousKeys = previous?.padIndex === pad.index ? previous.heldKeys : undefined;
  const previousButtons = previous?.padIndex === pad.index ? previous.heldButtons : undefined;
  const pressedKeys = new Set([...heldKeys].filter((code) => !previousKeys?.has(code)));
  const pressedButtons = new Set([...heldButtons].filter((button) => !previousButtons?.has(button)));
  return {
    padIndex: pad.index,
    moveX,
    moveZ,
    lookX,
    lookY,
    heldKeys,
    pressedKeys,
    heldButtons,
    pressedButtons,
  };
}
