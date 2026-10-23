import { Fragment, useState } from 'react';
import {
  addKeyboardControlSlot,
  bindGamepadAxis,
  bindKeyboardControl,
  bindGamepadControl,
  clearKeyboardControl,
  invertGamepadAxis,
  resolvePlayerControls,
  type GamepadAxisControl,
  type GamepadControl,
  type KeyboardControl,
  type PlayerControls,
} from '../services/playerControls';

const keyboardControls: { control: KeyboardControl; label: string }[] = [
  { control: 'togglePause', label: 'Pause / resume' },
  { control: 'moveForward', label: 'Move forward' },
  { control: 'moveBackward', label: 'Move backward' },
  { control: 'moveLeft', label: 'Move left' },
  { control: 'moveRight', label: 'Move right' },
  { control: 'sprint', label: 'Sprint' },
  { control: 'jump', label: 'Jump' },
  { control: 'interact', label: 'Interact' },
  { control: 'attack', label: 'Attack' },
  { control: 'useItem', label: 'Use inventory slot' },
  { control: 'placeCell', label: 'Place cell' },
  { control: 'removeCell', label: 'Remove cell' },
  { control: 'cyclePaint', label: 'Cycle construction paint' },
];

const gamepadControls: { control: GamepadControl; label: string }[] = [
  { control: 'togglePause', label: 'Pause / resume · Start' },
  { control: 'moveForward', label: 'Move forward · D-pad' },
  { control: 'moveBackward', label: 'Move backward · D-pad' },
  { control: 'moveLeft', label: 'Move left · D-pad' },
  { control: 'moveRight', label: 'Move right · D-pad' },
  { control: 'sprint', label: 'Sprint' },
  { control: 'jump', label: 'Jump' },
  { control: 'interact', label: 'Interact' },
  { control: 'attack', label: 'Attack' },
  { control: 'useItem', label: 'Use first available item' },
  { control: 'placeCell', label: 'Place cell' },
  { control: 'removeCell', label: 'Remove cell' },
  { control: 'cyclePaint', label: 'Cycle construction paint' },
];

const gamepadAxes: { control: GamepadAxisControl; label: string }[] = [
  { control: 'moveX', label: 'Movement horizontal' },
  { control: 'moveY', label: 'Movement vertical' },
  { control: 'lookX', label: 'Camera horizontal' },
  { control: 'lookY', label: 'Camera vertical' },
];

const gamepadButtonNames = [
  'Bottom face',
  'Right face',
  'Left face',
  'Top face',
  'Left shoulder',
  'Right shoulder',
  'Left trigger',
  'Right trigger',
  'Select',
  'Start',
  'Left stick press',
  'Right stick press',
  'D-pad up',
  'D-pad down',
  'D-pad left',
  'D-pad right',
];

function displayCode(code: string) {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  return code;
}

function displayButton(index: number) {
  return gamepadButtonNames[index] ?? `Button ${index + 1}`;
}

export function PlayerControlsEditor({
  controls,
  onChange,
}: {
  controls: PlayerControls;
  onChange: (controls: PlayerControls) => void;
}) {
  const [listening, setListening] = useState<string | null>(null);
  const [bindingMessage, setBindingMessage] = useState('');
  const [gamepadMessage, setGamepadMessage] = useState('');
  const [addingGamepadFor, setAddingGamepadFor] = useState<GamepadControl | null>(null);

  const isDirectionalGamepadControl = (control: GamepadControl) =>
    control === 'moveForward' ||
    control === 'moveBackward' ||
    control === 'moveLeft' ||
    control === 'moveRight';

  const changeGamepadBinding = (control: GamepadControl, index: number, button: number | null) => {
    const result = bindGamepadControl(controls, control, index, button);
    if (!result.ok) {
      if (result.reason === 'unsupported') setGamepadMessage('That gamepad button cannot be assigned here.');
      else {
        const conflict = gamepadControls.find((candidate) => candidate.control === result.conflict.control);
        const conflictLabel =
          result.conflict.control === 'moveForward' ||
          result.conflict.control === 'moveBackward' ||
          result.conflict.control === 'moveLeft' ||
          result.conflict.control === 'moveRight'
            ? (conflict?.label ?? result.conflict.control)
            : `${conflict?.label ?? result.conflict.control} button ${result.conflict.index + 1}`;
        setGamepadMessage(`${displayButton(button!)} is already assigned to ${conflictLabel}.`);
      }
      return;
    }
    setGamepadMessage('');
    onChange(result.controls);
    setAddingGamepadFor(null);
  };

  return (
    <details className="studio-controls-editor">
      <summary>Keyboard, gamepad and touch controls</summary>
      <p>
        Movement follows these bindings; the left stick stays camera-relative. Change them or restore
        defaults.
      </p>
      <div className="studio-controls-editor__section">
        <strong>Keyboard</strong>
        {keyboardControls.map(({ control, label }) => {
          const values = controls.keyboard[control];
          const count = control === 'useItem' ? 9 : Math.max(1, values.length);
          return (
            <Fragment key={control}>
              {Array.from({ length: count }, (_, index) => {
                const code = values[index] ?? '';
                const actionLabel =
                  control === 'useItem' ? `${label} ${index + 1}` : `${label} key ${index + 1}`;
                const captureId = `${control}:${index}`;
                return (
                  <div className="studio-controls-editor__row" key={captureId}>
                    <span>{actionLabel}</span>
                    <button
                      type="button"
                      aria-label={`Bind ${actionLabel}`}
                      aria-pressed={listening === captureId}
                      onClick={() => {
                        setBindingMessage('');
                        setListening(captureId);
                      }}
                      onKeyDown={(event) => {
                        if (listening !== captureId) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.code === 'Escape') {
                          setListening(null);
                          return;
                        }
                        const result = bindKeyboardControl(controls, control, index, event.code);
                        if (!result.ok) {
                          if (result.reason === 'unsupported')
                            setBindingMessage('That key is not supported. Choose a standard keyboard key.');
                          else {
                            const conflict = keyboardControls.find(
                              (candidate) => candidate.control === result.conflict.control,
                            );
                            const conflictLabel =
                              result.conflict.control === 'useItem'
                                ? `${conflict?.label ?? result.conflict.control} ${result.conflict.index + 1}`
                                : `${conflict?.label ?? result.conflict.control} key ${result.conflict.index + 1}`;
                            setBindingMessage(
                              `${displayCode(event.code)} is already assigned to ${conflictLabel}.`,
                            );
                          }
                          return;
                        }
                        setBindingMessage('');
                        onChange(result.controls);
                        setListening(null);
                      }}
                    >
                      {listening === captureId ? 'Press a key…' : code ? displayCode(code) : 'Unbound'}
                    </button>
                    <button
                      type="button"
                      aria-label={`Unbind ${actionLabel}`}
                      disabled={!code}
                      onClick={() => {
                        setBindingMessage('');
                        setListening(null);
                        onChange(clearKeyboardControl(controls, control, index));
                      }}
                    >
                      Unbind
                    </button>
                  </div>
                );
              })}
              {control !== 'useItem' && values.length < 4 && (
                <button
                  type="button"
                  aria-label={`Add alternate key for ${label}`}
                  onClick={() => {
                    setBindingMessage('');
                    onChange(addKeyboardControlSlot(controls, control));
                  }}
                >
                  + Add key for {label.toLowerCase()}
                </button>
              )}
            </Fragment>
          );
        })}
        {bindingMessage && <small role="status">{bindingMessage}</small>}
      </div>
      <div className="studio-controls-editor__section">
        <strong>Gamepad</strong>
        {gamepadControls.map(({ control, label }) => {
          const value = controls.gamepad[control];
          const directional = isDirectionalGamepadControl(control);
          const buttons = Array.isArray(value) ? value : value === null ? [] : [value];
          const count = directional ? 1 : Math.max(1, buttons.length + Number(addingGamepadFor === control));
          return (
            <Fragment key={control}>
              {Array.from({ length: count }, (_, index) => {
                const selected = buttons[index] ?? -1;
                const actionLabel = directional ? label : `${label} button ${index + 1}`;
                const isPending = addingGamepadFor === control && index === buttons.length;
                return (
                  <div className="studio-controls-editor__row" key={`${control}:${index}`}>
                    <span>{actionLabel}</span>
                    <select
                      aria-label={`Gamepad binding: ${actionLabel}`}
                      value={selected}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        changeGamepadBinding(control, index, next < 0 ? null : next);
                      }}
                    >
                      <option value={-1}>Unassigned</option>
                      {Array.from({ length: 32 }, (_, button) => (
                        <option key={button} value={button}>
                          {displayButton(button)}
                        </option>
                      ))}
                    </select>
                    {!directional && selected >= 0 && (
                      <button
                        type="button"
                        aria-label={`Unbind gamepad ${actionLabel}`}
                        onClick={() => changeGamepadBinding(control, index, null)}
                      >
                        Unbind
                      </button>
                    )}
                    {isPending && (
                      <button type="button" onClick={() => setAddingGamepadFor(null)}>
                        Cancel
                      </button>
                    )}
                  </div>
                );
              })}
              {!directional && buttons.length > 0 && buttons.length < 4 && addingGamepadFor !== control && (
                <button
                  type="button"
                  aria-label={`Add gamepad button for ${label}`}
                  onClick={() => {
                    setGamepadMessage('');
                    setAddingGamepadFor(control);
                  }}
                >
                  + Add button for {label.toLowerCase()}
                </button>
              )}
            </Fragment>
          );
        })}
        {gamepadMessage && <small role="status">{gamepadMessage}</small>}
        <strong>Stick axes</strong>
        {gamepadAxes.map(({ control, label }) => {
          const binding = controls.gamepad.axes[control];
          return (
            <div className="studio-controls-editor__row" key={control}>
              <span>{label}</span>
              <select
                aria-label={`Gamepad axis: ${label}`}
                value={binding.axis ?? -1}
                onChange={(event) => {
                  const axis = Number(event.target.value);
                  onChange(bindGamepadAxis(controls, control, axis < 0 ? null : axis));
                }}
              >
                <option value={-1}>Unassigned</option>
                {Array.from({ length: 16 }, (_, axis) => (
                  <option key={axis} value={axis}>
                    Axis {axis + 1}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Invert gamepad axis: ${label}`}
                  checked={binding.inverted}
                  onChange={(event) => onChange(invertGamepadAxis(controls, control, event.target.checked))}
                />
                Invert
              </label>
            </div>
          );
        })}
        <small>
          Unmapped controllers use raw button and axis indices. Defaults use axes 1–2 for movement and 3–4 for
          camera look; assign or invert them to match your controller.
        </small>
        <small>
          Touch buttons call these gameplay actions directly; the movement stick remains available.
        </small>
      </div>
      <button type="button" onClick={() => onChange(resolvePlayerControls())}>
        Restore default controls
      </button>
    </details>
  );
}
