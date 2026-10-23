import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Box3, Vector3 } from 'three';
import { SpatialIndex } from '../runtime/SpatialIndex';

const REPEATS = 8;
type Index = { set(id: string, box: Box3): void; query(box: Box3): Set<string> };
type Run = () => number;

// Retains the pre-optimization set path so one run can compare both implementations.
class LegacySpatialIndex implements Index {
  private cells = new Map<string, Set<string>>();
  private membership = new Map<string, string[]>();
  private large = new Set<string>();

  constructor(private cellSize = 8) {}

  private keys(box: Box3): string[] | null {
    const x = Math.floor(box.min.x / this.cellSize),
      z = Math.floor(box.min.z / this.cellSize),
      endX = Math.floor(box.max.x / this.cellSize),
      endZ = Math.floor(box.max.z / this.cellSize);
    if (![x, z, endX, endZ].every(Number.isFinite) || (endX - x + 1) * (endZ - z + 1) > 4096) return null;
    const keys: string[] = [];
    for (let i = x; i <= endX; i++) for (let j = z; j <= endZ; j++) keys.push(`${i}:${j}`);
    return keys;
  }

  set(id: string, box: Box3) {
    this.delete(id);
    const keys = this.keys(box);
    this.membership.set(id, keys ?? []);
    if (!keys) {
      this.large.add(id);
      return;
    }
    for (const key of keys) {
      if (!this.cells.has(key)) this.cells.set(key, new Set());
      this.cells.get(key)!.add(id);
    }
  }

  private delete(id: string) {
    for (const key of this.membership.get(id) ?? []) {
      const cell = this.cells.get(key)!;
      cell.delete(id);
      if (!cell.size) this.cells.delete(key);
    }
    this.membership.delete(id);
    this.large.delete(id);
  }

  query(box: Box3): Set<string> {
    const keys = this.keys(box);
    if (!keys) return new Set(this.membership.keys());
    const result = new Set(this.large);
    for (const key of keys) for (const id of this.cells.get(key) ?? []) result.add(id);
    return result;
  }
}

function boxAt(x: number, z: number, half = 0.6) {
  return new Box3(new Vector3(x - half, 0, z - half), new Vector3(x + half, 1.8, z + half));
}

const scenarios: { label: string; create: (index: Index) => Run }[] = [
  {
    label: 'stationary scene: 4096 colliders, 1200 player queries',
    create(index) {
      for (let i = 0; i < 4096; i++) index.set(`s${i}`, boxAt((i % 64) * 12, Math.floor(i / 64) * 12));
      const queries = Array.from({ length: 1200 }, (_, i) => boxAt((i % 64) * 12, Math.floor(i / 64) * 12));
      return () => {
        let candidates = 0;
        for (const query of queries) candidates += index.query(query).size;
        return candidates;
      };
    },
  },
  {
    label: 'moving crowd: 512 colliders updated and queried for 120 steps',
    create(index) {
      const boxes = Array.from({ length: 512 }, (_, i) => boxAt((i % 32) * 5, Math.floor(i / 32) * 5)),
        deltas = boxes.map((_, i) => new Vector3(0.025 + (i % 3) * 0.005, 0, 0.01));
      boxes.forEach((box, i) => index.set(`m${i}`, box));
      return () => {
        let candidates = 0;
        for (let frame = 0; frame < 120; frame++)
          for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            box.translate(deltas[i]);
            index.set(`m${i}`, box);
            candidates += index.query(box).size;
          }
        return candidates;
      };
    },
  },
  {
    label: 'sleeping crowd: 1024 unchanged dynamic bounds reset for 120 steps',
    create(index) {
      const boxes = Array.from({ length: 1024 }, (_, i) => boxAt((i % 32) * 4, Math.floor(i / 32) * 4));
      boxes.forEach((box, i) => index.set(`d${i}`, box));
      return () => {
        let candidates = 0;
        for (let frame = 0; frame < 120; frame++) {
          for (let i = 0; i < boxes.length; i++) index.set(`d${i}`, boxes[i]);
          candidates += index.query(boxes[(frame * 17) % boxes.length]).size;
        }
        return candidates;
      };
    },
  },
];

const implementations = {
  legacy: () => new LegacySpatialIndex(8),
  optimized: () => new SpatialIndex(8),
};

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length / 2;
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

const measurements = scenarios.map(({ label, create }) => {
  for (const implementation of Object.values(implementations)) create(implementation())();
  const samples = { legacy: [] as number[], optimized: [] as number[] },
    checksums = { legacy: [] as number[], optimized: [] as number[] };

  for (let repeat = 0; repeat < REPEATS; repeat++) {
    const order = repeat % 2 === 0 ? (['legacy', 'optimized'] as const) : (['optimized', 'legacy'] as const),
      runs = order.map((name) => ({ name, run: create(implementations[name]()) }));
    for (const { name, run } of runs) {
      const start = performance.now(),
        checksum = run();
      samples[name].push(performance.now() - start);
      checksums[name].push(checksum);
    }
  }

  for (const checksum of [...checksums.legacy, ...checksums.optimized])
    assert.equal(checksum, checksums.legacy[0]);
  const legacyMedianMs = Number(median(samples.legacy).toFixed(2)),
    optimizedMedianMs = Number(median(samples.optimized).toFixed(2));
  return {
    label,
    repeatsPerImplementation: REPEATS,
    order: 'alternates legacy-first and optimized-first',
    legacyMedianMs,
    optimizedMedianMs,
    improvementPercent: Number(((1 - optimizedMedianMs / legacyMedianMs) * 100).toFixed(1)),
    checksum: checksums.legacy[0],
  };
});

const timestamp = new Date().toISOString(),
  receiptPath = resolve(
    '.voxshop',
    'engine-development',
    'benchmarks',
    `spatial-index-${timestamp.replace(/[:.]/g, '-')}.json`,
  ),
  receipt = {
    timestamp,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    warmupRunsPerImplementation: 1,
    measurements,
    scopeLimits: [
      'Synthetic Node CPU timings; excludes GameSimulation and Rapier work.',
      'Does not measure renderer, GPU, display cadence, or game FPS.',
      'Repeated unchanged bounds model dynamic bodies whose pose updates preserve the same X/Z cells; it is not a count of bodies observed in a live game.',
    ],
  };

mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ receiptPath, ...receipt }, null, 2));
