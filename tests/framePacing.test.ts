import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceFrameDeadline,
  DEFAULT_FRAME_PACING,
  measureFramePacing,
  normalizeFramePacing,
} from '../runtime/framePacing';

test('frame pacing defaults to no software cap and validates supported targets', () => {
  assert.deepEqual(DEFAULT_FRAME_PACING, { capFrameRate: false, maxFpsTarget: 144 });
  assert.deepEqual(normalizeFramePacing({ capFrameRate: true, maxFpsTarget: 240 }), {
    capFrameRate: true,
    maxFpsTarget: 240,
  });
  assert.throws(() => normalizeFramePacing(null), /object/);
  assert.throws(() => normalizeFramePacing({ capFrameRate: 1, maxFpsTarget: 144 }), /boolean/);
  assert.throws(() => normalizeFramePacing({ capFrameRate: true, maxFpsTarget: 143 }), /supported/);
});

test('frame-pacing deadlines advance without accumulating drift or catching up', () => {
  const interval = 1000 / 60;
  assert.equal(advanceFrameDeadline(1000, 1010, 60), 1000 + interval);
  assert.equal(advanceFrameDeadline(1000, 1020, 60), 1000 + interval * 2);
  assert.throws(() => advanceFrameDeadline(Number.NaN, 1, 60), /valid/);
});

test('frame pacing separates renderer calls, call wall time and simulation steps', () => {
  const sample = measureFramePacing(
    { atMs: 1000, rendererCalls: 40, rendererCallMs: 10, simulationSteps: 240 },
    { atMs: 6000, rendererCalls: 1090, rendererCallMs: 62.5, simulationSteps: 1440 },
  );
  assert.deepEqual(sample, {
    elapsedMs: 5000,
    rendererCalls: 1050,
    rendererCallMs: 52.5,
    rendererCallMsPerCall: 0.05,
    simulationSteps: 1200,
    rendererCallsPerSecond: 210,
    simulationHz: 240,
  });
});

test('frame pacing rejects invalid intervals and counter resets', () => {
  const before = { atMs: 1, rendererCalls: 1, rendererCallMs: 0, simulationSteps: 1 };
  assert.throws(() => measureFramePacing(before, { ...before, atMs: 1 }), /monotonic/);
  assert.throws(() => measureFramePacing(before, { ...before, rendererCalls: 0 }), /monotonic/);
  assert.throws(() => measureFramePacing(before, { ...before, simulationSteps: 1.5 }), /monotonic/);
  assert.throws(() => measureFramePacing(before, { ...before, rendererCallMs: -1 }), /monotonic/);
});
