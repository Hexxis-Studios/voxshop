import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { generateCharacter } from '../services/assetAssembly';
import {
  assetSchema,
  identityTransform,
  newProject,
  nodeSchema,
  validateProject,
  type Asset,
} from '../services/projectDocument';
import { createVoxelEditFromLookup, applyVoxelCommand } from '../services/modelCommands';
import { voxelKey } from '../services/modelDocument';
import { VoxelMaterial, type VoxelData } from '../types';
import { createAssetVisual, createNodeVisual, disposeObject } from '../runtime/assetMesh';
import { geometryArrayBytes } from '../runtime/geometryArrayBytes';
import { ProjectStore } from '../server/projectStore';
import { buildGame } from '../server/gameBuild';

const outputDirectory = path.resolve('.voxshop/engine-development/asset-profile');
const outputPath = path.join(outputDirectory, `authored-assets-${timestamp()}.json`);
const palette = [0x456b3a, 0x527b40, 0x658748, 0x748d4e, 0x879858];

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function time<T>(run: () => T) {
  const started = performance.now();
  const value = run();
  return { value, ms: Number((performance.now() - started).toFixed(3)) };
}

async function timeAsync<T>(run: () => Promise<T>) {
  const started = performance.now();
  const value = await run();
  return { value, ms: Number((performance.now() - started).toFixed(3)) };
}

function makeSparseTree(): Asset {
  const voxels = new Map<string, VoxelData>();
  const add = (x: number, y: number, z: number, color: number) => {
    const voxel = {
      x,
      y,
      z,
      color,
      materialType: VoxelMaterial.STANDARD,
      isLocked: false,
    } satisfies VoxelData;
    voxels.set(voxelKey(voxel), voxel);
  };

  for (let y = 0; y < 36; y++)
    for (let z = -3; z <= 3; z++)
      for (let x = -3; x <= 3; x++) if (x * x + z * z <= 10) add(x, y, z, y < 5 ? 0x735336 : 0x84603b);

  // A deterministic, perforated canopy exercises sparse occupancy across many chunks.
  for (let y = 24; y <= 62; y++) {
    for (let z = -22; z <= 22; z++) {
      for (let x = -22; x <= 22; x++) {
        const nx = x / 22,
          ny = (y - 43) / 19,
          nz = z / 22;
        if (nx * nx + ny * ny + nz * nz > 1) continue;
        const hash = Math.imul(x + 29, 73856093) ^ Math.imul(y + 67, 19349663) ^ Math.imul(z + 31, 83492791);
        if ((hash >>> 0) % 100 >= 34) continue;
        const colorIndex = (Math.abs(x * 3 + y * 5 + z * 7) + ((hash >>> 8) & 0xff)) % palette.length;
        add(x, y, z, palette[colorIndex]);
      }
    }
  }

  return assetSchema.parse({
    id: 'profile-sparse-tree',
    name: 'Sparse multi-chunk tree benchmark',
    voxelSize: 0.08,
    pivot: [0, 0, 0],
    model: { format: 'voxshop-model', version: 1, voxels: [...voxels.values()], skeleton: null },
    rig: null,
    source: { kind: 'generated', description: 'Deterministic sparse canopy benchmark fixture.', seed: 1 },
  });
}

function measureVisual(visual: ReturnType<typeof createAssetVisual>) {
  let meshCount = 0,
    skinnedMeshCount = 0,
    skinAttributeVertices = 0,
    vertexCount = 0,
    triangleCount = 0,
    cpuArrayBytes = 0;
  visual.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      skinnedMeshCount++;
      const skinIndices = mesh.geometry.getAttribute('skinIndex')?.count ?? 0;
      const skinWeights = mesh.geometry.getAttribute('skinWeight')?.count ?? 0;
      if (!skinIndices || skinIndices !== skinWeights)
        throw new Error('Rigged geometry is missing matching skin index/weight attributes.');
      skinAttributeVertices += skinIndices;
    }
    vertexCount += mesh.geometry.getAttribute('position')?.count ?? 0;
    triangleCount += (mesh.geometry.index?.count ?? 0) / 3;
    cpuArrayBytes += geometryArrayBytes(mesh.geometry);
  });
  return { meshCount, skinnedMeshCount, skinAttributeVertices, vertexCount, triangleCount, cpuArrayBytes };
}

function profileVisual(build: () => ReturnType<typeof createAssetVisual>) {
  const warmup = build();
  disposeObject(warmup.group);
  const samplesMs: number[] = [];
  let finalVisual: ReturnType<typeof createAssetVisual> | undefined;
  for (let sample = 0; sample < 3; sample++) {
    const result = time(build);
    samplesMs.push(result.ms);
    if (sample === 2) finalVisual = result.value;
    else disposeObject(result.value.group);
  }
  const geometry = measureVisual(finalVisual!);
  disposeObject(finalVisual!.group);
  return { medianBuildMs: median(samplesMs), samplesMs, geometry };
}

function makeCharacter() {
  return generateCharacter({
    id: 'profile-rigged-character',
    name: 'Detailed generated humanoid benchmark',
    profile: 'biped',
    height: 64,
    width: 22,
    color: 0x62798a,
    accent: 0xb27a48,
    voxelSize: 0.045,
  });
}

const generation = time(makeCharacter);
const character = generation.value;
const characterValidation = time(() => assetSchema.parse(character));
const validatedCharacter = characterValidation.value;
const characterRoundTrip = time(() => assetSchema.parse(JSON.parse(JSON.stringify(validatedCharacter))));

const characterVisual = profileVisual(() => createAssetVisual(validatedCharacter));
if (characterVisual.geometry.skinnedMeshCount !== 1 || !characterVisual.geometry.skinAttributeVertices)
  throw new Error('Generated character did not produce a skinned voxel mesh.');
const animatedVisual = createAssetVisual(validatedCharacter);
const animationSample = time(() => {
  for (let frame = 0; frame < 1200; frame++) animatedVisual.animate('walk', frame / 60);
});
disposeObject(animatedVisual.group);

const editableVoxels = validatedCharacter.model.voxels;
const editTarget = editableVoxels[Math.floor(editableVoxels.length / 2)];
if (!editTarget) throw new Error('Generated character benchmark has no voxels.');
const coordinateMap = new Map(editableVoxels.map((voxel) => [voxelKey(voxel), voxel]));
const currentBone = editTarget.bone ?? 'root';
const alternateBone = validatedCharacter.rig?.joints.find((joint) => joint.name !== currentBone)?.name;
if (!alternateBone) throw new Error('Generated character has no alternate joint for the edit probe.');
const editWeights = [{ bone: alternateBone, weight: 1 }];
const editDelta = time(() =>
  createVoxelEditFromLookup((key) => coordinateMap.get(key), {
    mode: 'weight',
    targets: [{ x: editTarget.x, y: editTarget.y, z: editTarget.z }],
    weights: editWeights,
  }),
);
if (editDelta.value.voxels.length !== 1)
  throw new Error('One-voxel weight edit did not produce exactly one delta.');
const editApply = time(() => applyVoxelCommand(editableVoxels, editDelta.value));
const editUndo = time(() => applyVoxelCommand(editApply.value, editDelta.value, true));
const editedVoxel = editApply.value.find((voxel) => voxelKey(voxel) === voxelKey(editTarget));
const restoredVoxel = editUndo.value.find((voxel) => voxelKey(voxel) === voxelKey(editTarget));
if (!editedVoxel?.weights?.length || JSON.stringify(restoredVoxel) !== JSON.stringify(editTarget))
  throw new Error('Weight edit apply/undo did not round-trip the selected voxel.');

const propGeneration = time(makeSparseTree);
const sparseProp = propGeneration.value;
const propRoundTrip = time(() => assetSchema.parse(JSON.parse(JSON.stringify(sparseProp))));
const propNode = nodeSchema.parse({
  id: 'profile-sparse-tree-node',
  name: sparseProp.name,
  assetId: sparseProp.id,
  transform: identityTransform(),
  attachments: [],
});
const sparsePropVisual = profileVisual(() =>
  createNodeVisual(propNode, new Map([[sparseProp.id, sparseProp]])),
);
if (sparsePropVisual.geometry.meshCount < 2)
  throw new Error('Sparse prop did not exercise the runtime chunked visual path.');

const authoredProject = newProject('authored-asset-profile', 'Authored asset capacity profile');
authoredProject.assets = [validatedCharacter, sparseProp];
authoredProject.scenes[0].nodes = [validatedCharacter, sparseProp].map((asset) =>
  nodeSchema.parse({
    id: `${asset.id}-node`,
    name: asset.name,
    assetId: asset.id,
    transform: identityTransform(),
    attachments: [],
  }),
);
const projectValidation = time(() => validateProject(authoredProject));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'voxshop-authored-asset-profile-'));
let persistenceAndExport;
try {
  const store = new ProjectStore(path.join(temporaryRoot, 'projects'));
  const storeImport = await timeAsync(() => store.import(projectValidation.value, 'profile-project'));
  const projectFile = path.join(temporaryRoot, 'projects', 'profile-project.json');
  const savedProjectBytes = (await stat(projectFile)).size;
  const storeRead = await timeAsync(() => store.read('profile-project'));
  if (
    storeRead.value.assets.length !== 2 ||
    storeRead.value.assets.reduce((count, asset) => count + asset.model.voxels.length, 0) !==
      projectValidation.value.assets.reduce((count, asset) => count + asset.model.voxels.length, 0)
  )
    throw new Error('Project store round-trip changed the profiled assets or voxel count.');

  const exportDirectory = path.join(temporaryRoot, 'exports');
  const standaloneExport = await timeAsync(() =>
    buildGame(storeRead.value, 'main', { root: process.cwd(), directory: exportDirectory }),
  );
  const exportedHtml = await readFile(standaloneExport.value.path, 'utf8');
  if (
    Buffer.byteLength(exportedHtml, 'utf8') !== standaloneExport.value.bytes ||
    !exportedHtml.includes('Authored asset capacity profile')
  )
    throw new Error('Standalone export is missing the profiled project or has an inconsistent size.');
  persistenceAndExport = {
    projectValidationMs: projectValidation.ms,
    storeImportMs: storeImport.ms,
    storeReadMs: storeRead.ms,
    savedStateBytes: savedProjectBytes,
    standaloneExportMs: standaloneExport.ms,
    standaloneHtmlBytes: standaloneExport.value.bytes,
    standaloneSha256: standaloneExport.value.sha256,
    assetCount: standaloneExport.value.assets,
    voxelCount: standaloneExport.value.voxels,
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const report = {
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  method:
    'Profiles the production biped character generator and a deterministic sparse, multi-chunk canopy fixture. Each geometry build receives one warmup and three timed runs; the median and samples are retained. Weight edit creation uses an already-built coordinate map, while applying and undoing the command measures the current canonical array path. Asset JSON round trips include assetSchema validation. Project validation, atomic disk import/read and standalone HTML export use the production ProjectStore and buildGame paths for these two fixtures. Animation timing covers 1,200 calls that update bone transforms; rendering/GPU work, peak memory and presented-frame cadence are excluded.',
  currentCaps: { voxelsPerAsset: 250_000, voxelsPerProject: 1_000_000 },
  riggedCharacter: {
    generator: 'generateCharacter(profile=biped, height=64, width=22)',
    voxelCount: validatedCharacter.model.voxels.length,
    jointCount: validatedCharacter.rig?.joints.length ?? 0,
    animationClipCount: validatedCharacter.rig?.clips.length ?? 0,
    generationMs: generation.ms,
    schemaValidationMs: characterValidation.ms,
    jsonRoundTripAndValidationMs: characterRoundTrip.ms,
    jsonBytes: Buffer.byteLength(JSON.stringify(validatedCharacter), 'utf8'),
    riggedVisual: characterVisual,
    animation: { calls: 1200, totalMs: animationSample.ms },
    oneVoxelWeightEdit: {
      targetBone: editTarget.bone ?? null,
      deltaCreationMs: editDelta.ms,
      applyMs: editApply.ms,
      undoMs: editUndo.ms,
      countAfterApply: editApply.value.length,
      countAfterUndo: editUndo.value.length,
    },
  },
  sparseStaticProp: {
    generator: 'deterministic trunk with a perforated ellipsoid canopy',
    voxelCount: sparseProp.model.voxels.length,
    generationMs: propGeneration.ms,
    jsonRoundTripAndValidationMs: propRoundTrip.ms,
    jsonBytes: Buffer.byteLength(JSON.stringify(sparseProp), 'utf8'),
    chunkedVisual: sparsePropVisual,
  },
  projectPersistenceAndExport: persistenceAndExport,
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath: outputPath, ...report }, null, 2));
