import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { WorldChunkStore } from '../services/worldChunks';

const warmupChunks = 4;
const sampleChunks = 30;
const results = [16, 32].map((size) => {
  const store = new WorldChunkStore(42, size, (position) => ({ ...position }));
  for (let x = 0; x < warmupChunks; x++) store.hydrate({ x: -x - 1, y: 0, z: 0 });

  const samples: number[] = [];
  for (let x = 0; x < sampleChunks; x++) {
    const start = performance.now();
    store.hydrate({ x, y: 0, z: -1 });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    chunkSize: size,
    cellsPerChunk: size ** 3,
    sampleChunks,
    medianMs: Number(samples[Math.floor(sampleChunks * 0.5)].toFixed(3)),
    p95Ms: Number(samples[Math.floor(sampleChunks * 0.95)].toFixed(3)),
    maxMs: Number(samples[sampleChunks - 1].toFixed(3)),
  };
});

console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      method:
        'Synchronous dense logical-cell hydration with one small object per cell; excludes terrain noise, meshing, rendering and GPU work.',
      warmupChunks,
      results,
    },
    null,
    2,
  ),
);
