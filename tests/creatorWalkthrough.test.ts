import assert from 'node:assert/strict';
import test from 'node:test';
import { creatorWalkthrough } from '../runtime/creatorWalkthrough';
import type { GameViewport } from '../runtime/GameViewport';

test('inspect walkthrough preserves restored gameplay until Reset walkthrough is chosen', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'),
    originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'),
    restored = {
      sceneId: 'second',
      frame: 11,
      inventory: 63,
      selectedPaint: 'metal',
      terrain: [{ x: 1, y: 0, z: 2 }],
    },
    initial = structuredClone(restored),
    buttonHandlers: Array<Record<string, () => void>> = [],
    buttons = Array.from({ length: 4 }, () => {
      const handlers: Record<string, () => void> = {};
      buttonHandlers.push(handlers);
      return {
        disabled: false,
        addEventListener(type: string, listener: () => void) {
          handlers[type] = listener;
        },
      };
    }),
    status = { textContent: 'Paused at frame 0.' },
    form = {
      addEventListener() {},
      querySelector() {
        return null;
      },
    },
    panel = {
      open: false,
      style: { cssText: '' },
      innerHTML: '',
      querySelector(selector: string) {
        return selector === 'form' ? form : status;
      },
      querySelectorAll() {
        return buttons;
      },
    },
    appended: unknown[] = [],
    document = {
      createElement() {
        return panel;
      },
      getElementById() {
        return null;
      },
      body: {
        appendChild(element: unknown) {
          appended.push(element);
        },
      },
    };
  let playCalls = 0;
  const viewport = {
    simulation: {
      inspect: () => ({ frame: restored.frame, status: 'playing' }),
    },
    play(agentDriven: boolean) {
      assert.equal(agentDriven, true);
      playCalls++;
      Object.assign(restored, initial, {
        sceneId: 'main',
        frame: 0,
        inventory: 64,
        selectedPaint: 'grass',
        terrain: [],
      });
    },
  } as unknown as GameViewport;

  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { search: '?voxshop-inspect=1' },
    });

    creatorWalkthrough(viewport);

    assert.deepEqual(appended, [panel]);
    assert.equal(playCalls, 0);
    assert.deepEqual(restored, initial);
    assert.equal(status.textContent, 'Frame 11 · playing');

    buttonHandlers[1]?.click?.();
    assert.equal(playCalls, 1);
    assert.deepEqual(restored, {
      sceneId: 'main',
      frame: 0,
      inventory: 64,
      selectedPaint: 'grass',
      terrain: [],
    });
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
