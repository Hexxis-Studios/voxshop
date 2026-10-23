import os from 'node:os';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import {
  assetSchema,
  identityTransform,
  newProject,
  nodeSchema,
  validateProject,
  type SceneNode,
} from '../services/projectDocument';
import { normalizeVoxels, voxelKey } from '../services/modelDocument';
import { applyVoxelCommand, createVoxelEditFromLookup } from '../services/modelCommands';
import { geometryArrayBytes } from '../runtime/geometryArrayBytes';
import { createVoxelGeometryChunks, VOXEL_CHUNK_SIZE } from '../runtime/voxelGeometry';
import { createNodeVisual } from '../runtime/assetMesh';
import { VoxelMaterial, type VoxelData } from '../types';
import { ProjectStore } from '../server/projectStore';
import { buildGame } from '../server/gameBuild';

const assetSizes = [10_000, 100_000, 250_000];
const palette = [0x647a52, 0x74885b, 0x859466, 0x988f66, 0xa69a70, 0x667b68, 0x7d876b, 0x92866c];
const outputDirectory = path.resolve('.voxshop/engine-development/asset-budget');

function dimensionsFor(count: number): [number, number, number] {
  if (count === 256) return [16, 4, 4];
  if (count === 10_000) return [100, 10, 10];
  if (count === 100_000) return [100, 50, 20];
  if (count === 250_000) return [100, 50, 50];
  throw new Error(`No benchmark dimensions for ${count} voxels.`);
}

function makeVoxels(count: number): VoxelData[] {
  const [width, height, depth] = dimensionsFor(count);
  const voxels: VoxelData[] = [];
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const patch = ((x >> 3) + (y >> 3) + (z >> 3)) % palette.length;
        voxels.push({
          x,
          y,
          z,
          color: palette[patch],
          materialType: VoxelMaterial.STANDARD,
          isLocked: false,
        });
      }
    }
  }
  return voxels;
}

function makeCheckerboardVoxels([width, height, depth]: [number, number, number]): VoxelData[] {
  const voxels: VoxelData[] = [];
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        if ((x + y + z) % 2) continue;
        const patch = ((x >> 3) + (y >> 3) + (z >> 3)) % palette.length;
        voxels.push({
          x,
          y,
          z,
          color: palette[patch],
          materialType: VoxelMaterial.STANDARD,
          isLocked: false,
        });
      }
    }
  }
  return voxels;
}

function cloneVoxels(voxels: VoxelData[]): VoxelData[] {
  return voxels.map((voxel) => ({
    ...voxel,
    ...(voxel.weights && { weights: voxel.weights.map((weight) => ({ ...weight })) }),
  }));
}

function measure<T>(run: () => T) {
  const start = performance.now();
  const value = run();
  return { value, ms: Number((performance.now() - start).toFixed(3)) };
}

async function measureAsync<T>(run: () => Promise<T>) {
  const start = performance.now();
  const value = await run();
  return { value, ms: Number((performance.now() - start).toFixed(3)) };
}

function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function collectGarbage() {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

async function fileContainsText(filePath: string, marker: string): Promise<boolean> {
  let carry = '';
  for await (const chunk of createReadStream(filePath, { encoding: 'utf8' })) {
    const text = carry + chunk;
    if (text.includes(marker)) return true;
    carry = text.slice(-(marker.length - 1));
  }
  return false;
}

function memorySnapshot() {
  const { rss, heapUsed } = process.memoryUsage();
  return { rssBytes: rss, heapUsedBytes: heapUsed };
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

const warmup = makeVoxels(256);
normalizeVoxels(warmup);
assetSchema.parse({
  id: 'warmup',
  name: 'Warmup asset',
  model: { format: 'voxshop-model', version: 1, voxels: warmup, skeleton: null },
});
collectGarbage();

const assetResults: Record<string, unknown>[] = [];
let largestVoxels: VoxelData[] = [];

for (const count of assetSizes) {
  const voxels = makeVoxels(count);
  const normalization = measure(() => normalizeVoxels(voxels));
  const normalizedVoxelCount = normalization.value.length;
  const normalizationMs = normalization.ms;
  normalization.value.length = 0;
  collectGarbage();

  const validation = measure(() =>
    assetSchema.parse({
      id: `asset-${count}`,
      name: `${count.toLocaleString()} voxel asset`,
      model: { format: 'voxshop-model', version: 1, voxels, skeleton: null },
    }),
  );
  const asset = validation.value;

  for (const { geometry } of createVoxelGeometryChunks(asset, [], VOXEL_CHUNK_SIZE)) geometry.dispose();
  const staticMeshBuildSamplesMs: number[] = [];
  let chunks: ReturnType<typeof createVoxelGeometryChunks> = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    const result = createVoxelGeometryChunks(asset, [], VOXEL_CHUNK_SIZE);
    staticMeshBuildSamplesMs.push(Number((performance.now() - start).toFixed(3)));
    if (sample === 4) chunks = result;
    else for (const { geometry } of result) geometry.dispose();
  }
  const staticMeshBuildMs = median(staticMeshBuildSamplesMs);
  const geometry = {
    chunkSize: VOXEL_CHUNK_SIZE,
    chunks: chunks.length,
    triangles: chunks.reduce((total, chunk) => total + (chunk.geometry.index?.count ?? 0) / 3, 0),
    cpuArrayBytes: chunks.reduce((total, chunk) => total + geometryArrayBytes(chunk.geometry), 0),
  };
  for (const chunk of chunks) chunk.geometry.dispose();

  assetResults.push({
    voxelCount: count,
    dimensions: dimensionsFor(count),
    normalizationMs,
    normalizedVoxelCount,
    assetSchemaValidationMs: validation.ms,
    staticMeshBuildMs,
    staticMeshBuildSamplesMs,
    geometry,
  });
  if (count === 250_000) largestVoxels = voxels;
  collectGarbage();
}

const sparseEditLookup = measure(
  () => new Map(largestVoxels.map((voxel) => [voxelKey(voxel), voxel] as const)),
);
const sparseEditTarget = largestVoxels[Math.floor(largestVoxels.length / 2)];
if (!sparseEditTarget) throw new Error('The cap-scale sparse edit fixture is empty.');
const sparseEditCommand = measure(() =>
  createVoxelEditFromLookup((key) => sparseEditLookup.value.get(key), {
    mode: 'paint',
    targets: [sparseEditTarget],
    color: 0x13579b,
  }),
);
if (sparseEditCommand.value.voxels.length !== 1)
  throw new Error('The cap-scale sparse edit fixture must touch exactly one voxel.');
const sparseEditApplySamplesMs: number[] = [];
const sparseEditUndoSamplesMs: number[] = [];
let sparseEditRoundTripVerified = false;
for (let sample = 0; sample < 5; sample++) {
  const applied = measure(() => applyVoxelCommand(largestVoxels, sparseEditCommand.value));
  const undone = measure(() => applyVoxelCommand(applied.value, sparseEditCommand.value, true));
  if (
    applied.value.length !== largestVoxels.length ||
    applied.value.at(-1)?.color !== 0x13579b ||
    undone.value.length !== largestVoxels.length ||
    undone.value.at(-1)?.color !== sparseEditTarget.color
  )
    throw new Error('The cap-scale sparse edit did not preserve the voxel count and undo result.');
  if (sample === 0) sparseEditRoundTripVerified = true;
  sparseEditApplySamplesMs.push(applied.ms);
  sparseEditUndoSamplesMs.push(undone.ms);
  applied.value.length = 0;
  undone.value.length = 0;
}
const sparseEditAtCap = {
  voxelCount: largestVoxels.length,
  operation: 'paint one voxel with a prebuilt coordinate lookup',
  coordinateLookupBuildMs: sparseEditLookup.ms,
  commandCreationMs: sparseEditCommand.ms,
  applySamplesMs: sparseEditApplySamplesMs,
  applyMedianMs: median(sparseEditApplySamplesMs),
  undoSamplesMs: sparseEditUndoSamplesMs,
  undoMedianMs: median(sparseEditUndoSamplesMs),
  roundTripVerified: sparseEditRoundTripVerified,
};
sparseEditLookup.value.clear();
collectGarbage();

const checkerboardWarmup = assetSchema.parse({
  id: 'checkerboard-warmup',
  name: 'Checkerboard warmup',
  model: {
    format: 'voxshop-model',
    version: 1,
    voxels: makeCheckerboardVoxels([16, 16, 16]),
    skeleton: null,
  },
});
for (const { geometry } of createVoxelGeometryChunks(checkerboardWarmup, [], VOXEL_CHUNK_SIZE))
  geometry.dispose();

const checkerboardVoxels = makeCheckerboardVoxels([100, 100, 50]);
if (checkerboardVoxels.length !== 250_000)
  throw new Error(`Expected 250,000 checkerboard voxels, received ${checkerboardVoxels.length}.`);
const checkerboardAsset = assetSchema.parse({
  id: 'checkerboard-surface-stress',
  name: '250,000 voxel checkerboard surface stress',
  model: { format: 'voxshop-model', version: 1, voxels: checkerboardVoxels, skeleton: null },
});
checkerboardVoxels.length = 0;
const checkerboardBuild = measure(() => createVoxelGeometryChunks(checkerboardAsset, [], VOXEL_CHUNK_SIZE));
const checkerboardGeometry = {
  chunkSize: VOXEL_CHUNK_SIZE,
  chunks: checkerboardBuild.value.length,
  triangles: checkerboardBuild.value.reduce(
    (total, chunk) => total + (chunk.geometry.index?.count ?? 0) / 3,
    0,
  ),
  cpuArrayBytes: checkerboardBuild.value.reduce(
    (total, chunk) => total + geometryArrayBytes(chunk.geometry),
    0,
  ),
};
for (const chunk of checkerboardBuild.value) chunk.geometry.dispose();
checkerboardBuild.value.length = 0;
const checkerboardSurfaceStress = {
  voxelCount: 250_000,
  dimensions: [100, 100, 50],
  topology: '3D checkerboard; no face-adjacent occupied cells',
  meshBuildMs: checkerboardBuild.ms,
  geometry: checkerboardGeometry,
};
const checkerboardRuntimeBuild = measure(() =>
  createNodeVisual(
    { assetId: checkerboardAsset.id, attachments: [] } as unknown as SceneNode,
    new Map([[checkerboardAsset.id, checkerboardAsset]]),
  ),
);
const runtimeMeshes = checkerboardRuntimeBuild.value.group.children.filter(
  (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
);
const runtimeInstancedMeshes = runtimeMeshes.filter(
  (mesh): mesh is THREE.InstancedMesh => (mesh as THREE.InstancedMesh).isInstancedMesh,
);
const runtimeGeometrySet = new Set(runtimeMeshes.map((mesh) => mesh.geometry));
const checkerboardRuntimeRepresentation = {
  representation: checkerboardRuntimeBuild.value.group.userData.voxelRepresentation,
  buildMs: checkerboardRuntimeBuild.ms,
  chunks: checkerboardRuntimeBuild.value.group.userData.voxelChunkCount,
  meshes: runtimeMeshes.length,
  instances: runtimeInstancedMeshes.reduce((total, mesh) => total + mesh.count, 0),
  instanceBufferBytes: runtimeInstancedMeshes.reduce(
    (total, mesh) =>
      total + mesh.instanceMatrix.array.byteLength + (mesh.instanceColor?.array.byteLength ?? 0),
    0,
  ),
  uniqueGeometryArrayBytes: [...runtimeGeometrySet].reduce(
    (total, geometry) => total + geometryArrayBytes(geometry),
    0,
  ),
};
checkerboardRuntimeBuild.value.group.clear();
runtimeMeshes.length = 0;
runtimeInstancedMeshes.length = 0;
runtimeGeometrySet.clear();
checkerboardAsset.model.voxels.length = 0;
collectGarbage();

const capScaleCheckerboardVoxels = makeCheckerboardVoxels([100, 100, 50]);
if (capScaleCheckerboardVoxels.length !== 250_000)
  throw new Error('The high-surface aggregate-cap fixture must contain exactly 250,000 voxels.');
const capScaleSparsePaintColor = 0x13579b;
const projectDraft = {
  ...newProject('asset-budget-project', 'Asset budget benchmark'),
  assets: Array.from({ length: 4 }, (_, index) => ({
    id: index === 0 ? 'asset-high-surface' : `asset-dense-${index}`,
    name: index === 0 ? '250,000 voxel checkerboard' : `250,000 voxel dense cuboid ${index}`,
    model: {
      format: 'voxshop-model' as const,
      version: 1 as const,
      voxels: index === 0 ? capScaleCheckerboardVoxels : cloneVoxels(largestVoxels),
      skeleton: null,
    },
  })),
};
projectDraft.scenes[0].nodes = projectDraft.assets.map((asset, index) =>
  nodeSchema.parse({
    id: `asset-node-${index + 1}`,
    name: asset.name,
    assetId: asset.id,
    transform: identityTransform(),
    attachments: [],
  }),
);

const projectValidation = measure(() => validateProject(projectDraft));
const project = projectValidation.value;
const serialization = measure(() => JSON.stringify(project));
const jsonBytes = Buffer.byteLength(serialization.value, 'utf8');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'voxshop-asset-budget-profile-'));
let capScalePersistenceAndExport: Record<string, unknown>;
try {
  const store = new ProjectStore(path.join(temporaryRoot, 'projects'));
  const importResult = await measureAsync(() => store.import(project, 'asset-budget-cap-profile'));
  const stateFile = path.join(temporaryRoot, 'projects', 'asset-budget-cap-profile.json');
  const savedStateBytes = (await stat(stateFile)).size;
  const commitResult = await measureAsync(() =>
    store.commit('asset-budget-cap-profile', {
      expectedRevision: 0,
      requestId: 'cap-scale-sparse-paint',
      operations: [
        {
          type: 'asset.edit',
          id: 'asset-dense-1',
          edit: {
            mode: 'paint',
            targets: [{ x: sparseEditTarget.x, y: sparseEditTarget.y, z: sparseEditTarget.z }],
            color: capScaleSparsePaintColor,
          },
        },
      ],
    }),
  );
  const committedStateBytes = (await stat(stateFile)).size;
  const backupStateBytes = (await stat(`${stateFile}.bak`)).size;
  const committedSparseVoxel = commitResult.value.project.assets
    .find((asset) => asset.id === 'asset-dense-1')
    ?.model.voxels.find((voxel) => voxelKey(voxel) === voxelKey(sparseEditTarget));
  if (commitResult.value.appliedRevision !== 1 || committedSparseVoxel?.color !== capScaleSparsePaintColor)
    throw new Error('Cap-scale ProjectStore commit did not apply the sparse asset edit.');
  const undoResult = await measureAsync(() =>
    store.history('asset-budget-cap-profile', 'undo', {
      expectedRevision: 1,
      requestId: 'cap-scale-undo',
    }),
  );
  const undoneSparseVoxel = undoResult.value.project.assets
    .find((asset) => asset.id === 'asset-dense-1')
    ?.model.voxels.find((voxel) => voxelKey(voxel) === voxelKey(sparseEditTarget));
  if (undoResult.value.project.revision !== 2 || undoneSparseVoxel?.color === capScaleSparsePaintColor)
    throw new Error('Cap-scale ProjectStore history did not undo the sparse asset edit.');
  const redoResult = await measureAsync(() =>
    store.history('asset-budget-cap-profile', 'redo', {
      expectedRevision: 2,
      requestId: 'cap-scale-redo',
    }),
  );
  const redoneSparseVoxel = redoResult.value.project.assets
    .find((asset) => asset.id === 'asset-dense-1')
    ?.model.voxels.find((voxel) => voxelKey(voxel) === voxelKey(sparseEditTarget));
  if (redoResult.value.project.revision !== 3 || redoneSparseVoxel?.color !== capScaleSparsePaintColor)
    throw new Error('Cap-scale ProjectStore history did not redo the sparse asset edit.');
  const redoneStateBytes = (await stat(stateFile)).size;
  const readResult = await measureAsync(() => store.read('asset-budget-cap-profile'));
  const sourceVoxelCount = project.assets.reduce((total, asset) => total + asset.model.voxels.length, 0);
  const restoredVoxelCount = readResult.value.assets.reduce(
    (total, asset) => total + asset.model.voxels.length,
    0,
  );
  const restoredHighSurfaceAsset = readResult.value.assets.find((asset) => asset.id === 'asset-high-surface');
  const restoredSparseAsset = readResult.value.assets.find((asset) => asset.id === 'asset-dense-1');
  const restoredSparseVoxel = restoredSparseAsset?.model.voxels.find(
    (voxel) => voxelKey(voxel) === voxelKey(sparseEditTarget),
  );
  if (
    restoredVoxelCount !== sourceVoxelCount ||
    readResult.value.assets.length !== project.assets.length ||
    readResult.value.scenes[0].nodes.length !== project.assets.length ||
    restoredHighSurfaceAsset?.model.voxels.length !== 250_000 ||
    restoredSparseAsset?.model.voxels.length !== 250_000 ||
    restoredSparseVoxel?.color !== capScaleSparsePaintColor
  )
    throw new Error('Cap-scale persistence changed asset contents, nodes, sparse paint or voxel counts.');

  const exportDirectory = path.join(temporaryRoot, 'exports');
  const standalone = await measureAsync(() =>
    buildGame(readResult.value, 'main', { root: process.cwd(), directory: exportDirectory }),
  );
  const standaloneFile = await stat(standalone.value.path);
  if (
    standaloneFile.size !== standalone.value.bytes ||
    standalone.value.assets !== project.assets.length ||
    standalone.value.voxels !== sourceVoxelCount
  )
    throw new Error('Cap-scale standalone export did not retain the mixed-topology project assets.');
  const sparseColorInStandalone = await fileContainsText(
    standalone.value.path,
    `"color":${capScaleSparsePaintColor}`,
  );
  if (!sparseColorInStandalone)
    throw new Error('Standalone export did not embed the edited cap-scale voxel color.');
  capScalePersistenceAndExport = {
    topology:
      'one 250,000-voxel checkerboard and three 250,000-voxel dense cuboids; asset-dense-1 has one sparse paint edit',
    importMs: importResult.ms,
    sparseAssetEditCommitMs: commitResult.ms,
    committedRevision: commitResult.value.appliedRevision,
    sparseAssetEditUndoMs: undoResult.ms,
    undoRevision: undoResult.value.project.revision,
    sparseAssetEditRedoMs: redoResult.ms,
    redoRevision: redoResult.value.project.revision,
    readMs: readResult.ms,
    savedStateBytes,
    committedStateBytes,
    backupStateBytes,
    redoneStateBytes,
    standaloneExportMs: standalone.ms,
    standaloneHtmlBytes: standalone.value.bytes,
    assetCount: standalone.value.assets,
    voxelCount: standalone.value.voxels,
    sparseEditedVoxel: {
      assetId: 'asset-dense-1',
      coordinate: { x: sparseEditTarget.x, y: sparseEditTarget.y, z: sparseEditTarget.z },
      color: capScaleSparsePaintColor,
      persistedColor: restoredSparseVoxel.color,
      standaloneEmbeddedMarkerFound: sparseColorInStandalone,
    },
    sha256: standalone.value.sha256,
  };
} finally {
  const resolvedRoot = path.resolve(temporaryRoot);
  const tempBase = path.resolve(os.tmpdir()) + path.sep;
  if (!resolvedRoot.startsWith(tempBase))
    throw new Error('Refusing to remove a path outside the OS temp directory.');
  await rm(resolvedRoot, { recursive: true, force: true });
}
const processMemoryAfterCapScaleExport = {
  ...memorySnapshot(),
  lifetimeHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
  measurement:
    'Point-in-time whole-process RSS and V8 heap after cap-scale ProjectStore import/read and standalone export, plus the process-lifetime maximum RSS from Node resourceUsage (reported in bytes after converting its KiB value). Both include benchmark inputs, project draft, validated project, serialized JSON, export/runtime allocations and Node runtime. The high-water value covers the sequential benchmark process; it is not per-phase, per-asset or concurrent-workload attribution.',
};
const capScaleConcurrentWorkload = await (async () => {
  const concurrentRoot = await mkdtemp(path.join(os.tmpdir(), 'voxshop-asset-budget-concurrent-'));
  const highWaterBeforeBytes = process.resourceUsage().maxRSS * 1024;
  const rssBeforeBytes = process.memoryUsage.rss();
  try {
    const store = new ProjectStore(path.join(concurrentRoot, 'projects'));
    const operations = await measureAsync(() =>
      Promise.all([
        store.import(project, 'asset-budget-concurrent-a'),
        store.import(project, 'asset-budget-concurrent-b'),
        buildGame(project, 'main', {
          root: process.cwd(),
          directory: path.join(concurrentRoot, 'export-a'),
        }),
        buildGame(project, 'main', {
          root: process.cwd(),
          directory: path.join(concurrentRoot, 'export-b'),
        }),
      ]),
    );
    const [importA, importB, exportA, exportB] = operations.value;
    const [fileA, fileB] = await Promise.all([stat(exportA.path), stat(exportB.path)]);
    const sourceVoxelCount = project.assets.reduce((total, asset) => total + asset.model.voxels.length, 0);
    if (
      importA.id !== 'asset-budget-concurrent-a' ||
      importB.id !== 'asset-budget-concurrent-b' ||
      importA.assets.length !== project.assets.length ||
      importB.assets.length !== project.assets.length ||
      importA.assets.reduce((total, asset) => total + asset.model.voxels.length, 0) !== sourceVoxelCount ||
      importB.assets.reduce((total, asset) => total + asset.model.voxels.length, 0) !== sourceVoxelCount ||
      fileA.size !== exportA.bytes ||
      fileB.size !== exportB.bytes ||
      exportA.sha256 !== exportB.sha256
    )
      throw new Error('Concurrent cap-scale import/export changed project contents or export output.');
    const highWaterAfterBytes = process.resourceUsage().maxRSS * 1024;
    return {
      workload: 'Two cap-scale ProjectStore imports and two standalone exports launched together.',
      concurrentOperations: 4,
      assetCountPerImport: project.assets.length,
      voxelCountPerImport: sourceVoxelCount,
      elapsedMs: operations.ms,
      exportBytesEach: exportA.bytes,
      equalExportHashes: exportA.sha256 === exportB.sha256,
      highWaterBeforeBytes,
      highWaterAfterBytes,
      highWaterIncreaseAboveSequentialRunBytes: Math.max(0, highWaterAfterBytes - highWaterBeforeBytes),
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage.rss(),
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
    };
  } finally {
    const resolvedRoot = path.resolve(concurrentRoot);
    const tempBase = path.resolve(os.tmpdir()) + path.sep;
    if (!resolvedRoot.startsWith(tempBase))
      throw new Error('Refusing to remove a path outside the OS temp directory.');
    await rm(resolvedRoot, { recursive: true, force: true });
  }
})();
collectGarbage();
const report = {
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  gcExposed: typeof (globalThis as typeof globalThis & { gc?: () => void }).gc === 'function',
  method:
    'One timed pass per normalization, schema-validation, project-validation, and serialization stage after a 256-voxel warmup. Dense cuboid static mesh build uses one additional warmup and five timed passes; staticMeshBuildMs is the median and individual samples are retained. The cap-scale sparse-edit case measures five paint/undo passes on one voxel of a 250,000-voxel dense asset with command lookup construction reported separately. The persistence/export fixture imports a four-asset/1,000,000-voxel project, commits one sparse paint through the production ProjectStore transaction/history/backup path, verifies persistent undo and redo after disk reloads, checks its saved/reloaded voxel, and searches the standalone HTML as a stream for the unique edited color marker. Assets use deterministic eight-color 8-voxel patches. Model normalization uses normalizeVoxels; asset validation uses assetSchema.parse; raw static geometry uses createVoxelGeometryChunks with the runtime 16-voxel chunk size. Project validation, compact JSON.stringify, atomic ProjectStore import/commit/undo/redo/read and standalone buildGame export use one 250,000-voxel checkerboard plus three 250,000-voxel dense cuboids (1,000,000 stored voxels total); the checkerboard has no face-adjacent occupied cells. A separate one-pass checkerboard case measures raw greedy mesh and actual runtime representation. Timings are local CPU/filesystem samples and exclude GPU upload and rendering. The sequential process-lifetime high-water RSS and a two-import/two-export concurrent case are reported; neither attributes memory to an individual asset or phase.',
  currentCaps: { voxelsPerAsset: 250_000, voxelsPerProject: 1_000_000 },
  processMemoryAfterCapScaleExport,
  assetResults,
  sparseEditAtCap,
  checkerboardSurfaceStress,
  checkerboardRuntimeRepresentation,
  projectAtAggregateCap: {
    assetCount: project.assets.length,
    topology: ['250,000-voxel checkerboard', 'three 250,000-voxel dense cuboids'],
    voxelsPerAsset: project.assets.map((asset) => asset.model.voxels.length),
    totalVoxels: project.assets.reduce((total, asset) => total + asset.model.voxels.length, 0),
    validationMs: projectValidation.ms,
    compactJsonSerializationMs: serialization.ms,
    compactJsonBytes: jsonBytes,
  },
  capScalePersistenceAndExport,
  capScaleConcurrentWorkload,
};

await mkdir(outputDirectory, { recursive: true });
const reportPath = path.join(outputDirectory, `asset-budget-${timestamp()}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, ...report }, null, 2));
