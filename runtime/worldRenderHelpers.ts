import type { WorldEdit } from '../services/worldDocument';

export function summarizeDurations(samples: number[]) {
  if (!samples.length) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    count: samples.length,
    p50Ms: sorted[Math.floor(samples.length * 0.5)],
    p95Ms: sorted[Math.floor(samples.length * 0.95)],
    maxMs: sorted.at(-1)!,
  };
}

export function sameEdit(first: WorldEdit | undefined, second: WorldEdit | undefined): boolean {
  return (
    first === second ||
    (!!first &&
      !!second &&
      first.x === second.x &&
      first.y === second.y &&
      first.z === second.z &&
      first.value?.color === second.value?.color &&
      first.value?.materialType === second.value?.materialType)
  );
}
