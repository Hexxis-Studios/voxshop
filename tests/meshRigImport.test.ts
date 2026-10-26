import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer, File } from 'node:buffer';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sculptedAsset } from '../services/assetAssembly';
import { createModelDocument, parseModelDocument, serializeModelDocument } from '../services/modelDocument';
import { assetSchema } from '../services/projectDocument';
import { voxelizeMeshWithRig } from '../services/meshVoxelization';
import { createAssetVisual } from '../runtime/assetMesh';
import { createGltfFileResolver, type GltfImportFile } from '../services/gltfImport';

function animatedSkinnedFixture() {
  const source = new THREE.Group();
  source.position.set(3, -1, 2);
  source.rotation.set(0.1, Math.PI / 4, -0.05);
  source.scale.setScalar(1.5);

  const root = new THREE.Bone();
  root.name = 'Root';
  root.position.set(0.1, 0.15, 0);
  root.rotation.z = 0.2;
  const child = new THREE.Bone();
  child.name = 'Child';
  child.position.set(0, 0.8, 0);
  child.rotation.x = -0.35;
  root.add(child);
  source.add(root);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.7, 0, 0, 0.7, 0, 0, 0.7, 1.6, 0, -0.7, 1.6, 0], 3),
  );
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6b87a8 }));
  mesh.name = 'Body';
  source.add(mesh);
  source.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([root, child]));
  source.updateMatrixWorld(true);
  mesh.skeleton.update();

  const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8);
  const endRotation = child.quaternion.clone().multiply(delta);
  const position = new THREE.VectorKeyframeTrack('Child.position', [0, 1], [0, 0.8, 0, 0, 1, 0]);
  const rotation = new THREE.QuaternionKeyframeTrack(
    'Child.quaternion',
    [0, 1],
    [
      child.quaternion.x,
      child.quaternion.y,
      child.quaternion.z,
      child.quaternion.w,
      endRotation.x,
      endRotation.y,
      endRotation.z,
      endRotation.w,
    ],
  );
  return { source, child, clip: new THREE.AnimationClip('Wave', 1, [position, rotation]) };
}

function generatedAnimatedGltf() {
  const chunks: Uint8Array[] = [];
  const bufferViews: Record<string, number>[] = [];
  let byteLength = 0;
  const addView = (values: Float32Array | Uint16Array, target?: number) => {
    const aligned = (byteLength + 3) & ~3;
    if (aligned > byteLength) chunks.push(new Uint8Array(aligned - byteLength));
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const index = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: aligned,
      byteLength: bytes.byteLength,
      ...(target && { target }),
    });
    chunks.push(bytes);
    byteLength = aligned + bytes.byteLength;
    return index;
  };
  const accessors: Record<string, unknown>[] = [];
  const addAccessor = (
    values: Float32Array | Uint16Array,
    type: string,
    count: number,
    target?: number,
    componentType = values instanceof Uint16Array ? 5123 : 5126,
    extra: Record<string, unknown> = {},
  ) => {
    const bufferView = addView(values, target);
    const accessor = accessors.length;
    accessors.push({ bufferView, componentType, count, type, ...extra });
    return accessor;
  };
  const positions = addAccessor(
    new Float32Array([-0.7, 0, 0, 0.7, 0, 0, 0.7, 1.6, 0, -0.7, 1.6, 0]),
    'VEC3',
    4,
    34962,
    5126,
    { min: [-0.7, 0, 0], max: [0.7, 1.6, 0] },
  );
  const joints = addAccessor(
    new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    'VEC4',
    4,
    34962,
  );
  const weights = addAccessor(
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    'VEC4',
    4,
    34962,
    5126,
  );
  const index = addAccessor(new Uint16Array([0, 1, 2, 0, 2, 3]), 'SCALAR', 6, 34963, 5123, {
    min: [0],
    max: [3],
  });
  const sourcePosition = new THREE.Vector3(3, -1, 2);
  const sourceRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, Math.PI / 4, -0.05));
  const sourceScale = new THREE.Vector3(1.5, 1.5, 1.5);
  const sourceTransform = new THREE.Matrix4().compose(sourcePosition, sourceRotation, sourceScale);
  const rootLocal = new THREE.Matrix4().compose(
    new THREE.Vector3(0.1, 0.15, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.2)),
    new THREE.Vector3(1, 1, 1),
  );
  const childLocal = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.8, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  const rootWorld = sourceTransform.clone().multiply(rootLocal);
  const childWorld = rootWorld.clone().multiply(childLocal);
  const inverseBind = [rootWorld.clone().invert(), childWorld.clone().invert()].flatMap((matrix) =>
    matrix.toArray(),
  );
  const inverseBinds = addAccessor(new Float32Array(inverseBind), 'MAT4', 2);
  const times = addAccessor(new Float32Array([0, 1]), 'SCALAR', 2, undefined, 5126, { min: [0], max: [1] });
  const positionsTrack = addAccessor(new Float32Array([0, 0.8, 0, 0, 1, 0]), 'VEC3', 2);
  const restRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0));
  const endRotation = restRotation
    .clone()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8));
  const rotationsTrack = addAccessor(
    new Float32Array([
      restRotation.x,
      restRotation.y,
      restRotation.z,
      restRotation.w,
      endRotation.x,
      endRotation.y,
      endRotation.z,
      endRotation.w,
    ]),
    'VEC4',
    2,
  );
  const bytes = new Uint8Array(byteLength);
  let byteOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, byteOffset);
    byteOffset += chunk.byteLength;
  }
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: 'Source',
        translation: sourcePosition.toArray(),
        rotation: sourceRotation.toArray(),
        scale: sourceScale.toArray(),
        children: [1, 3],
      },
      {
        name: 'Root',
        translation: [0.1, 0.15, 0],
        rotation: [0, 0, Math.sin(0.1), Math.cos(0.1)],
        children: [2],
      },
      { name: 'Child', translation: [0, 0.8, 0], rotation: [Math.sin(-0.175), 0, 0, Math.cos(-0.175)] },
      { name: 'Body', mesh: 0, skin: 0 },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: positions, JOINTS_0: joints, WEIGHTS_0: weights }, indices: index },
        ],
      },
    ],
    skins: [{ joints: [1, 2], skeleton: 1, inverseBindMatrices: inverseBinds }],
    animations: [
      {
        name: 'Wave',
        samplers: [
          { input: times, output: positionsTrack, interpolation: 'LINEAR' },
          { input: times, output: rotationsTrack, interpolation: 'LINEAR' },
        ],
        channels: [
          { sampler: 0, target: { node: 2, path: 'translation' } },
          { sampler: 1, target: { node: 2, path: 'rotation' } },
        ],
      },
    ],
    buffers: [
      {
        byteLength: bytes.byteLength,
        uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
      },
    ],
    bufferViews,
    accessors,
  };
}

test('animated GLB-style skin survives voxelization, model save, asset schema, and runtime sampling', () => {
  const fixture = animatedSkinnedFixture();
  const imported = voxelizeMeshWithRig(fixture.source, 12, [fixture.clip]);
  assert.ok(imported);
  assert.ok(imported.voxels.length > 0);
  assert.ok(imported.voxels.some((voxel) => voxel.weights?.some((weight) => weight.bone === 'Child')));

  const skeleton = imported.skeleton;
  const rootDef = skeleton.bones.find((bone) => bone.name === 'Root')!;
  const childDef = skeleton.bones.find((bone) => bone.name === 'Child')!;
  assert.deepEqual(childDef.parent, 'Root');
  assert.ok(Math.abs(Math.hypot(...childDef.bindPosition!) * imported.voxelSize - 1.2) < 1e-4);
  assert.ok(Math.abs(childDef.bindRotation![0] + 0.35) < 1e-4);
  const expectedRootRotation = fixture.source.quaternion
    .clone()
    .multiply(fixture.source.children[0].quaternion);
  const importedRootRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rootDef.bindRotation!));
  assert.ok(importedRootRotation.angleTo(expectedRootRotation) < 1e-4);
  const childKeys = skeleton.animations[0].tracks.Child;
  assert.ok(Math.abs(Math.hypot(...childKeys[1].pos!) * imported.voxelSize - 0.3) < 1e-4);
  assert.ok(Math.abs(childKeys[1].rot![2] - 0.8) < 1e-4);

  const document = createModelDocument(imported.voxels, skeleton);
  const saved = parseModelDocument(serializeModelDocument(document));
  assert.deepEqual(saved, document);
  const base = assetSchema.parse({
    id: 'animated_import',
    name: 'Animated import',
    model: saved,
    voxelSize: imported.voxelSize,
    pivot: [0, imported.voxels.reduce((min, voxel) => Math.min(min, voxel.y), Infinity), 0],
    rig: null,
    source: { kind: 'imported', description: 'Generated animated skin fixture' },
  });
  const asset = assetSchema.parse(sculptedAsset(base, saved));
  assert.equal(asset.voxelSize, imported.voxelSize);
  assert.ok(asset.rig);
  const legacyRig = assetSchema.parse({ ...asset, model: createModelDocument(imported.voxels) });
  assert.deepEqual(sculptedAsset(legacyRig, legacyRig.model).rig, legacyRig.rig);

  const visual = createAssetVisual(asset);
  const assetBounds = visual.group.userData.assetBounds as THREE.Box3;
  assert.ok(Math.abs(assetBounds.min.y + imported.voxelSize * 0.5) < 1e-5);
  const runtimeMesh = visual.group.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
  assert.ok(runtimeMesh);
  visual.group.updateMatrixWorld(true);
  runtimeMesh.skeleton.update();
  const childBone = visual.bones.get('Child')!;
  const restPosition = childBone.position.clone();
  const restQuaternion = childBone.quaternion.clone();
  const skinnedGeometry = runtimeMesh.geometry;
  const skinIndex = skinnedGeometry.attributes.skinIndex;
  const skinWeight = skinnedGeometry.attributes.skinWeight;
  const childIndex = asset.rig!.joints.findIndex((joint) => joint.name === 'Child');
  let vertexIndex = -1;
  for (let index = 0; index < skinWeight.count && vertexIndex < 0; index++)
    for (let slot = 0; slot < 4; slot++)
      if (skinIndex.getComponent(index, slot) === childIndex && skinWeight.getComponent(index, slot) > 0.05) {
        vertexIndex = index;
        break;
      }
  assert.notEqual(vertexIndex, -1);
  const positionAttribute = skinnedGeometry.attributes.position;
  const before = new THREE.Vector3().fromBufferAttribute(positionAttribute, vertexIndex);
  runtimeMesh.applyBoneTransform(vertexIndex, before);

  visual.animate('Wave', 0.5);
  assert.ok(childBone.position.distanceTo(restPosition) > 0.5);
  const expectedDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, childKeys[1].rot![2] / 2));
  const expectedRotation = restQuaternion.clone().multiply(expectedDelta);
  assert.ok(childBone.quaternion.angleTo(expectedRotation) < 1e-3);
  visual.group.updateMatrixWorld(true);
  runtimeMesh.skeleton.update();
  const after = new THREE.Vector3().fromBufferAttribute(positionAttribute, vertexIndex);
  runtimeMesh.applyBoneTransform(vertexIndex, after);
  assert.ok(after.distanceTo(before) > 0.02);
});

test('rig import rejects non-uniform source transforms instead of baking a broken rig', () => {
  const fixture = animatedSkinnedFixture();
  fixture.source.scale.set(2, 1, 1);
  fixture.source.updateMatrixWorld(true);
  assert.throws(
    () => voxelizeMeshWithRig(fixture.source, 12, [fixture.clip]),
    /non-uniform or negative scale/,
  );
});

test('rig import samples the skin bind pose instead of an edited source pose', () => {
  const bindFixture = animatedSkinnedFixture();
  const posedFixture = animatedSkinnedFixture();
  posedFixture.child.rotation.y += 0.6;
  posedFixture.source.updateMatrixWorld(true);

  const bindPose = voxelizeMeshWithRig(bindFixture.source, 12, [bindFixture.clip]);
  const importedPose = voxelizeMeshWithRig(posedFixture.source, 12, [posedFixture.clip]);
  assert.ok(bindPose && importedPose);
  assert.deepEqual(importedPose.voxels, bindPose.voxels);
  assert.deepEqual(importedPose.skeleton, bindPose.skeleton);
});

test('GLTFLoader animations retain source bone names and nonidentity bind transforms', async () => {
  const loader = new GLTFLoader();
  const originalProgressEvent = (globalThis as any).ProgressEvent;
  if (!originalProgressEvent)
    (globalThis as any).ProgressEvent = class extends Event {
      lengthComputable = false;
      loaded = 0;
      total = 0;
      constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
        super(type);
        Object.assign(this, init);
      }
    };
  let gltf: Awaited<ReturnType<typeof loader.parseAsync>>;
  try {
    gltf = await new Promise((resolve, reject) => {
      loader.parse(JSON.stringify(generatedAnimatedGltf()), '', resolve, reject);
    });
  } finally {
    if (originalProgressEvent) (globalThis as any).ProgressEvent = originalProgressEvent;
    else delete (globalThis as any).ProgressEvent;
  }
  const imported = voxelizeMeshWithRig(gltf.scene, 12, gltf.animations);
  assert.ok(imported);
  assert.deepEqual(
    imported.skeleton.bones.map((bone) => bone.name),
    ['Root', 'Child'],
  );
  assert.equal(imported.skeleton.animations[0].name, 'Wave');
  const root = imported.skeleton.bones.find((bone) => bone.name === 'Root')!;
  const child = imported.skeleton.bones.find((bone) => bone.name === 'Child')!;
  const sourceRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, Math.PI / 4, -0.05));
  const rootRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.2));
  assert.ok(
    new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(...root.bindRotation!))
      .angleTo(sourceRotation.multiply(rootRotation)) < 1e-4,
  );
  assert.ok(Math.abs(Math.hypot(...child.bindPosition!) * imported.voxelSize - 1.2) < 1e-4);
  const frames = imported.skeleton.animations[0].tracks.Child;
  assert.ok(Math.abs(Math.hypot(...frames[1].pos!) * imported.voxelSize - 0.3) < 1e-4);
  assert.ok(Math.abs(frames[1].rot![2] - 0.8) < 1e-4);
  assert.ok(imported.voxels.some((voxel) => voxel.weights?.some((weight) => weight.bone === 'Child')));
});

test('glTF import resolves selected external buffers and refuses missing or remote dependencies', async () => {
  const document = generatedAnimatedGltf();
  const binary = Buffer.from(document.buffers[0].uri!.split(',')[1], 'base64');
  document.buffers[0] = { byteLength: binary.byteLength, uri: 'mesh.bin' };
  const mainFile = new File([JSON.stringify(document)], 'animated.gltf', { type: 'model/gltf+json' });
  const binaryFile = new File([binary], 'mesh.bin', { type: 'application/octet-stream' });
  const resolver = createGltfFileResolver(mainFile, [mainFile, binaryFile], (file) => {
    assert.equal(file, binaryFile);
    return `data:application/octet-stream;base64,${binary.toString('base64')}`;
  });
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(resolver.resolve);
  const originalProgressEvent = (globalThis as any).ProgressEvent;
  if (!originalProgressEvent)
    (globalThis as any).ProgressEvent = class extends Event {
      lengthComputable = false;
      loaded = 0;
      total = 0;
      constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
        super(type);
        Object.assign(this, init);
      }
    };
  try {
    const loaded = await new GLTFLoader(manager).parseAsync(await mainFile.arrayBuffer(), resolver.baseUrl);
    assert.ok(loaded.scene.getObjectByProperty('isSkinnedMesh', true));
    assert.equal(loaded.animations[0]?.name, 'Wave');
    assert.ok(voxelizeMeshWithRig(loaded.scene, 12, loaded.animations)?.voxels.length);
  } finally {
    resolver.dispose();
    if (originalProgressEvent) (globalThis as any).ProgressEvent = originalProgressEvent;
    else delete (globalThis as any).ProgressEvent;
  }

  const missingResolver = createGltfFileResolver(mainFile, [mainFile], () => 'blob:unused');
  assert.throws(
    () => missingResolver.resolve(new URL('mesh.bin', missingResolver.baseUrl).href),
    /was not selected/,
  );
  assert.throws(
    () => missingResolver.resolve('https://example.invalid/mesh.bin'),
    /remote resources are not loaded/,
  );
  assert.equal(
    missingResolver.resolve('data:application/octet-stream;base64,AA=='),
    'data:application/octet-stream;base64,AA==',
  );
  missingResolver.dispose();

  const folderMain: GltfImportFile = { name: 'scene.gltf', webkitRelativePath: 'bundle/scenes/scene.gltf' };
  const folderTexture: GltfImportFile = {
    name: 'albedo.png',
    webkitRelativePath: 'bundle/textures/albedo.png',
  };
  const folderResolver = createGltfFileResolver(
    folderMain,
    [folderMain, folderTexture],
    () => 'data:image/png;base64,AA==',
  );
  const nestedReference = new URL('../textures/albedo.png', folderResolver.baseUrl).href;
  assert.equal(folderResolver.resolve(nestedReference), 'data:image/png;base64,AA==');
  folderResolver.dispose();
});
