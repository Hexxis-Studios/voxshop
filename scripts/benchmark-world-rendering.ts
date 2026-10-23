import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { createWorldCellSampler, worldDocumentSchema } from '../services/worldDocument';
import { terrainCaveCenterY } from '../services/terrainNoise';
import { WorldStreamRenderer } from '../runtime/WorldStreamRenderer';
import { buildCoarseWorldVoxelChunk } from '../runtime/worldVoxelLod';
import { geometryArrayBytes } from '../runtime/geometryArrayBytes';

const outputDirectory = path.resolve('.voxshop/engine-development/world-rendering-profile');
const warmupCount = 1;
const sampleCount = 5;
const voxelSize = 0.5;
const results: Record<string, unknown>[] = [];
const streamTileResults: Record<string, unknown>[] = [];
const descriptorScaleResults: Record<string, unknown>[] = [];
const palette = {
  surface: 0x79a94e,
  subsurface: 0x806044,
  deep: 0x5e6269,
  materialType: 'STANDARD' as const,
};
const scenarios = [
  { name: 'finite-passage' },
  { name: 'cave-field', caveDensity: 0.65 },
  { name: 'deep-cave-field', caveDensity: 0.65, maxY: 1023 },
  { name: 'surface-overhang', overhangDensity: 0.65 },
];

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples: number[]) {
  return {
    count: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const forceGc = () => (globalThis as typeof globalThis & { gc?: () => void }).gc?.();

function geometryDigest(geometry: THREE.BufferGeometry) {
  const hash = createHash('sha256');
  for (const attributeName of ['position', 'normal', 'color']) {
    const array = geometry.getAttribute(attributeName).array;
    hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
  if (geometry.index) {
    const array = geometry.index.array;
    hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
  for (const group of geometry.groups) hash.update(`${group.start}:${group.count}:${group.materialIndex};`);
  return hash.digest('hex');
}

for (const scenario of scenarios) {
  const world = worldDocumentSchema.parse({
    id: `world-rendering-${scenario.name}`,
    name: `World rendering ${scenario.name}`,
    seed: 817,
    chunkSize: 16,
    voxelSize,
    generator: {
      type: 'terrain',
      version: 1,
      mode: 'voxel3d',
      origin: [-512, -512],
      size: [1024, 1024],
      minY: 0,
      maxY: 'maxY' in scenario ? scenario.maxY : 127,
      baseHeight: 64,
      amplitude: 24,
      noise: 0.82,
      landformScale: 96,
      ...('caveDensity' in scenario ? { caveDensity: scenario.caveDensity } : {}),
      ...('overhangDensity' in scenario ? { overhangDensity: scenario.overhangDensity } : {}),
      palette,
    },
    edits: [],
  });
  const coordinate = {
    x: 0,
    y: Math.floor(
      ('overhangDensity' in scenario ? world.generator.baseHeight + 8 : terrainCaveCenterY(world)) / 16,
    ),
    z: 0,
  };

  for (const coarseFactor of [2, 4, 8, 16] as const) {
    const samplesMs: number[] = [];
    let finalGeometry = { voxelCellCount: 0, vertices: 0, triangles: 0, cpuArrayBytes: 0, sha256: '' };
    for (let pass = -warmupCount; pass < sampleCount; pass++) {
      const cellAt = createWorldCellSampler(world);
      const startedAt = performance.now();
      const build = buildCoarseWorldVoxelChunk(world, coordinate, cellAt, coarseFactor);
      const elapsed = performance.now() - startedAt;
      const currentDigest = build ? geometryDigest(build.geometry) : 'empty';
      const geometry = build
        ? {
            voxelCellCount: build.voxelCellCount,
            vertices: build.geometry.getAttribute('position').count,
            triangles: (build.geometry.index?.count ?? 0) / 3,
            cpuArrayBytes: geometryArrayBytes(build.geometry),
            sha256: currentDigest,
          }
        : { voxelCellCount: 0, vertices: 0, triangles: 0, cpuArrayBytes: 0, sha256: currentDigest };
      build?.geometry.dispose();
      if (pass >= 0) {
        samplesMs.push(Number(elapsed.toFixed(3)));
        if (finalGeometry.sha256 && finalGeometry.sha256 !== currentDigest)
          throw new Error(`${scenario.name} coarse mesh changed between passes.`);
        finalGeometry = geometry;
      }
    }
    results.push({
      scenario: scenario.name,
      ...('caveDensity' in scenario ? { caveDensity: scenario.caveDensity } : {}),
      maxY: world.generator.maxY,
      ...(scenario.name === 'surface-overhang' ? { overhangDensity: scenario.overhangDensity } : {}),
      coordinate,
      coarseFactor,
      sourceChunkSize: 16,
      logicalCellSizeMeters: voxelSize,
      warmupCount,
      samplesMs,
      medianBuildMs: percentile(samplesMs, 0.5),
      p95BuildMs: percentile(samplesMs, 0.95),
      emptyGeometry: finalGeometry.sha256 === 'empty',
      ...finalGeometry,
    });
  }

  for (const { level, coordinate } of [
    { level: 'far' as const, coordinate: { x: -6, z: -3 } },
    { level: 'horizon' as const, coordinate: { x: -2, z: -2 } },
  ]) {
    const samplesMs: number[] = [];
    let finalGeometry = { vertices: 0, triangles: 0, cpuArrayBytes: 0, sha256: '' };
    const target = new THREE.Vector3(0, world.generator.baseHeight * world.voxelSize, 0);
    for (let pass = -warmupCount; pass < sampleCount; pass++) {
      const renderer = new WorldStreamRenderer(new THREE.Scene(), world);
      renderer.update(target, undefined, false, true);
      const startedAt = performance.now();
      const geometry = renderer.buildTileGeometry(level, coordinate, target);
      const elapsed = performance.now() - startedAt;
      const currentDigest = geometry ? geometryDigest(geometry) : 'empty';
      const measurement = geometry
        ? {
            vertices: geometry.getAttribute('position').count,
            triangles: (geometry.index?.count ?? 0) / 3,
            cpuArrayBytes: geometryArrayBytes(geometry),
            sha256: currentDigest,
          }
        : { vertices: 0, triangles: 0, cpuArrayBytes: 0, sha256: currentDigest };
      geometry?.dispose();
      renderer.dispose();
      if (pass >= 0) {
        samplesMs.push(Number(elapsed.toFixed(3)));
        if (finalGeometry.sha256 && finalGeometry.sha256 !== currentDigest)
          throw new Error(`${scenario.name} ${level} tile changed between passes.`);
        finalGeometry = measurement;
      }
    }
    streamTileResults.push({
      scenario: scenario.name,
      ...('caveDensity' in scenario ? { caveDensity: scenario.caveDensity } : {}),
      maxY: world.generator.maxY,
      ...(scenario.name === 'surface-overhang' ? { overhangDensity: scenario.overhangDensity } : {}),
      level,
      coordinate,
      tileSizeCells: level === 'far' ? 64 : 256,
      logicalCellSizeMeters: voxelSize,
      warmupCount,
      samplesMs,
      medianBuildMs: percentile(samplesMs, 0.5),
      p95BuildMs: percentile(samplesMs, 0.95),
      ...finalGeometry,
    });
  }
}

// Prove descriptor size does not expand resident geometry. This samples the existing
// synchronous production stream at the center and after a quarter-span teleport.
for (const size of [4096, 65_536]) {
  const world = worldDocumentSchema.parse({
    id: `world-scale-${size}`,
    name: `World scale ${size}`,
    seed: 817,
    chunkSize: 16,
    voxelSize,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-size / 2, -size / 2],
      size: [size, size],
      minY: 0,
      maxY: 127,
      baseHeight: 64,
      amplitude: 24,
      noise: 0.82,
      landformScale: 96,
      palette,
    },
    edits: [],
  });
  forceGc();
  const baselineMemory = process.memoryUsage();
  const scene = new THREE.Scene();
  const renderer = new WorldStreamRenderer(scene, world);
  const windows: Record<string, unknown>[] = [];
  const quarterSpan = Math.floor(size / 4) * voxelSize;
  for (const location of [
    { name: 'center', x: 0, z: 0 },
    { name: 'quarter-span-teleport', x: quarterSpan, z: quarterSpan },
  ]) {
    const target = new THREE.Vector3(location.x, world.generator.baseHeight * voxelSize, location.z);
    const updateMs: number[] = [];
    const startedAt = performance.now();
    for (let frame = 0; frame < 140; frame++) {
      const frameStartedAt = performance.now();
      renderer.update(target);
      updateMs.push(performance.now() - frameStartedAt);
    }
    const windowBuildElapsedMs = performance.now() - startedAt;
    const stats = renderer.stats();
    if (stats.residentGeometries > stats.maximumResidentGeometries)
      throw new Error(
        `World ${size} exceeded its bounded stream window at ${location.name}: ${stats.residentGeometries}/${stats.maximumResidentGeometries}.`,
      );
    windows.push({
      location: location.name,
      updateCalls: updateMs.length,
      windowBuildElapsedMs: Number(windowBuildElapsedMs.toFixed(3)),
      cpuStreamUpdateMs: summarize(updateMs),
      residentGeometries: stats.residentGeometries,
      maximumResidentGeometries: stats.maximumResidentGeometries,
      residentGeometryArrayBytes: stats.residentGeometryArrayBytes,
      residentCoarseBufferBytes: stats.residentCoarseBufferBytes,
      tileBuildMs: stats.tileBuildMs,
    });
  }
  forceGc();
  const residentMemory = process.memoryUsage();
  renderer.dispose();
  scene.clear();
  descriptorScaleResults.push({
    descriptorSizeCells: [size, size],
    horizontalAddressableCells: size * size,
    verticalCells: world.generator.maxY - world.generator.minY + 1,
    descriptorAddressableCells: size * size * (world.generator.maxY - world.generator.minY + 1),
    logicalCellSizeMeters: voxelSize,
    residentMemoryBytes: {
      processRssBefore: baselineMemory.rss,
      processHeapUsedBefore: baselineMemory.heapUsed,
      processRssWithResidentWorld: residentMemory.rss,
      processHeapUsedWithResidentWorld: residentMemory.heapUsed,
      processExternalWithResidentWorld: residentMemory.external,
    },
    memoryScope:
      'Whole Node process after forced GC; includes runtime, scene and descriptor. Not an asset-only or peak-memory measurement.',
    windows,
  });
}

const report = {
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  method:
    'Measures production buildCoarseWorldVoxelChunk and WorldStreamRenderer.buildTileGeometry paths with fresh deterministic world samplers for one warmup and five timed runs per scenario. Coarse voxel results include factors two/four/eight/sixteen; streamed tile results include representative far and horizon tiles through the production renderer. Descriptor-scale runs stream two windows in 4,096² and 65,536²-cell worlds and record CPU update distributions, resident CPU geometry arrays and whole-process memory after GC. These timings exclude browser rendering, GPU allocation/completion and presented FPS.',
  results,
  streamTileResults,
  descriptorScaleResults,
};
const outputPath = path.join(outputDirectory, `world-rendering-${timestamp()}.json`);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
