export type FrameCounterSnapshot = {
  atMs: number;
  rendererCalls: number;
  rendererCallMs: number;
  simulationSteps: number;
};

export type FramePacingSettings = {
  capFrameRate: boolean;
  maxFpsTarget: number;
};

export const DEFAULT_FRAME_PACING: FramePacingSettings = {
  capFrameRate: false,
  maxFpsTarget: 144,
};

export const FRAME_RATE_TARGETS = [30, 60, 90, 120, 144, 165, 240, 360] as const;

export function normalizeFramePacing(value: unknown): FramePacingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Frame pacing settings must be an object.');
  const settings = value as Partial<FramePacingSettings>;
  if (typeof settings.capFrameRate !== 'boolean')
    throw new Error('Frame-rate cap setting must be a boolean.');
  if (!FRAME_RATE_TARGETS.some((target) => target === settings.maxFpsTarget))
    throw new Error('Frame-rate target must be one of the supported rates.');
  return { capFrameRate: settings.capFrameRate, maxFpsTarget: settings.maxFpsTarget! };
}

export function advanceFrameDeadline(deadline: number, now: number, maxFpsTarget: number) {
  if (
    !Number.isFinite(deadline) ||
    !Number.isFinite(now) ||
    !FRAME_RATE_TARGETS.some((target) => target === maxFpsTarget)
  )
    throw new Error('Frame pacing deadline and target must be valid.');
  const interval = 1000 / maxFpsTarget;
  return deadline + (Math.max(0, Math.floor((now - deadline) / interval)) + 1) * interval;
}

export function measureFramePacing(before: FrameCounterSnapshot, after: FrameCounterSnapshot) {
  const elapsedMs = after.atMs - before.atMs;
  const rendererCalls = after.rendererCalls - before.rendererCalls;
  const rendererCallMs = after.rendererCallMs - before.rendererCallMs;
  const simulationSteps = after.simulationSteps - before.simulationSteps;
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    !Number.isSafeInteger(rendererCalls) ||
    rendererCalls < 0 ||
    !Number.isFinite(rendererCallMs) ||
    rendererCallMs < 0 ||
    !Number.isSafeInteger(simulationSteps) ||
    simulationSteps < 0
  )
    throw new Error('Frame pacing counters must be monotonic and have a positive elapsed interval.');
  return {
    elapsedMs,
    rendererCalls,
    rendererCallMs,
    rendererCallMsPerCall: rendererCalls ? rendererCallMs / rendererCalls : 0,
    simulationSteps,
    rendererCallsPerSecond: (rendererCalls * 1000) / elapsedMs,
    simulationHz: (simulationSteps * 1000) / elapsedMs,
  };
}
