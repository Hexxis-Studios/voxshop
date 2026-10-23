import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createWorldChunkStore, worldDocumentSchema } from '../services/worldDocument';

const horizontalCoordinates = [-12, -4, -1, 0, 1, 4, 12].flatMap((x) => [-1, 0].map((z) => ({ x, z })));
const passes = 5;
const results: {
  mode: 'heightfield' | 'voxel3d';
  caveDensity?: number;
  overhangDensity?: number;
  chunkSize: number;
  sampleYChunk: number;
  chunkCount: number;
  generatedCells: number;
  medianMs: number;
  samplesMs: number[];
  sha256: string;
}[] = [];
const scenarios = [
  { mode: 'heightfield' as const },
  { mode: 'voxel3d' as const },
  { mode: 'voxel3d' as const, caveDensity: 0.65 },
  { mode: 'voxel3d' as const, overhangDensity: 0.65 },
];
for (const { mode, caveDensity, overhangDensity } of scenarios) {
  for (const chunkSize of [16, 32]) {
    const sampleY = Math.floor(64 / chunkSize);
    const coordinates = horizontalCoordinates.map(({ x, z }) => ({ x, y: sampleY, z }));
    const world = worldDocumentSchema.parse({
      id: 'sampling-benchmark',
      name: 'Sampling benchmark',
      seed: 817,
      chunkSize,
      voxelSize: 0.5,
      generator: {
        type: 'terrain',
        version: 1,
        mode,
        origin: [-512, -512],
        size: [1024, 1024],
        minY: 0,
        maxY: 127,
        baseHeight: 64,
        amplitude: 24,
        noise: 0.82,
        landformScale: 96,
        ...(caveDensity === undefined ? {} : { caveDensity }),
        ...(overhangDensity === undefined ? {} : { overhangDensity }),
        palette: { surface: 0x79a94e, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
        biomeField: {
          scale: 96,
          biomes: [
            {
              id: 'grassland',
              name: 'Grassland',
              palette: { surface: 0x38b34b, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
            },
            {
              id: 'tundra',
              name: 'Tundra',
              palette: { surface: 0x90dcf2, subsurface: 0x817969, deep: 0x526376, materialType: 'STANDARD' },
            },
          ],
        },
      },
    });
    const samples: number[] = [];
    let generatedCells = 0;
    let digest = '';
    for (let pass = -1; pass < passes; pass++) {
      const store = createWorldChunkStore(world);
      const hash = createHash('sha256');
      let elapsed = 0;
      let cells = 0;
      for (const coordinate of coordinates) {
        const started = performance.now();
        const chunk = store.hydrate(coordinate);
        elapsed += performance.now() - started;
        cells += chunk.cells.size;
        // Hashing and unloading are deliberately outside the generation timer.
        hash.update(JSON.stringify([...chunk.cells]));
        store.unload(coordinate);
      }
      const currentDigest = hash.digest('hex');
      if (digest && digest !== currentDigest) throw new Error('Terrain generation changed between passes.');
      digest = currentDigest;
      generatedCells = cells;
      if (pass >= 0) samples.push(elapsed);
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    results.push({
      mode,
      ...(caveDensity === undefined ? {} : { caveDensity }),
      ...(overhangDensity === undefined ? {} : { overhangDensity }),
      chunkSize,
      sampleYChunk: sampleY,
      chunkCount: coordinates.length,
      generatedCells,
      medianMs: sorted[Math.floor(passes / 2)],
      samplesMs: samples,
      sha256: digest,
    });
  }
}
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model,
      method:
        'One warmup and five fresh-store passes hydrating 14 generated chunks across repeated horizontal columns, in the vertical chunk containing baseHeight 64 for each chunk size. The voxel3d cases compare the legacy passage with caveDensity 0.65 or overhangDensity 0.65. Generation timers exclude hashing, store construction and unloading; this is CPU generation work, not meshing, rendering or FPS.',
      horizontalCoordinates,
      results,
    },
    null,
    2,
  ),
);
