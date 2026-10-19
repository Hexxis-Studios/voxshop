import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as THREE from 'three';
import { VoxelEngine } from '../services/VoxelEngine';
import { createModelDocument, normalizeVoxels, parseModelDocument } from '../services/modelDocument';
import { AppState, VoxelMaterial, type VoxelData } from '../types';
import { CONFIG } from '../utils/voxelConstants';
import type { SkeletonDef } from '../utils/riggingConstants';

const profile: SkeletonDef = {
  id: 'test',
  name: 'Test',
  bones: [{ name: 'Root', parent: null, pivotType: 'center', color: '#ffffff' }],
  animations: [],
};
const rich: VoxelData = {
  x: 0,
  y: 0,
  z: 0,
  color: 0,
  materialType: VoxelMaterial.GLASS,
  isLocked: false,
  bone: 'Root',
  weights: [{ bone: 'Root', weight: 1 }],
};
const ordered = (data: VoxelData[]) =>
  normalizeVoxels(data).sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);

/** Real engine methods/meshes, without constructing a WebGL renderer or starting a frame loop. */
function engineFor(t: TestContext, data: VoxelData[] = []) {
  const engine = Object.create(VoxelEngine.prototype) as any;
  Object.assign(engine, {
    scene: new THREE.Scene(),
    dummy: new THREE.Object3D(),
    voxelMap: new Map(),
    voxels: [],
    standardMesh: null,
    metallicMesh: null,
    glassMesh: null,
    emissiveMesh: null,
    state: AppState.STABLE,
    undoStack: [],
    redoStack: [],
    initialModelState: [],
    voxelSnapshot: null,
    rigGroup: null,
    rigSkeleton: null,
    mixer: null,
    currentSkeleton: null,
    currentEditMaterial: VoxelMaterial.STANDARD,
    currentEditColor: null,
    transformControl: { detach() {}, dragging: false, axis: null },
    editMesh: null,
    editInstanceId: null,
    editInstanceType: null,
    solidPreviewEnabled: false,
    solidPreviewMesh: null,
    onCountChange() {},
    onStateChange() {},
    brushType: 'single',
    brushSize: 1,
    symmetryX: false,
    symmetryY: false,
    symmetryZ: false,
  });
  engine.loadInitialModel(data);
  t.after(() => {
    engine.clearRig();
    const geometries = new Set<THREE.BufferGeometry>();
    engine.getAllMeshes().forEach((mesh: THREE.InstancedMesh) => {
      geometries.add(mesh.geometry);
      mesh.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
  });
  return engine;
}

function finishRebuild(engine: any) {
  engine.rebuildStartTime = Date.now() - 100000;
  for (let i = 0; i < 250 && engine.state === AppState.REBUILDING; i++) engine.updatePhysics();
  assert.equal(engine.state, AppState.STABLE);
}

test('engine native save/import preserves rig profiles, weights, materials, locks, and black', (t) => {
  const engine = engineFor(t);
  engine.loadInitialModel([{ ...rich, isLocked: true }], profile);
  const expected = engine.getModelDocument();
  const saved = engine.getJsonData();
  engine.loadInitialModel([]);
  engine.importJsonData(saved);
  assert.deepEqual(engine.getModelDocument(), expected);
  assert.equal(engine.getModelDocument().voxels[0].color, 0);
  const copy = engine.getVoxelDataForSave();
  copy[0].weights[0].weight = 0;
  assert.equal(engine.getVoxelDataForSave()[0].weights[0].weight, 1);
});

test('engine Fill saves its new color and material and supports exact undo/redo', (t) => {
  const engine = engineFor(t, [rich]);
  const before = engine.getModelDocument();
  engine.editVoxels({ mode: 'fill', targets: [rich], color: 0x00ff00, materialType: VoxelMaterial.EMISSIVE });
  const painted = parseModelDocument(engine.getJsonData());
  assert.equal(painted.voxels[0].color, 0x00ff00);
  assert.equal(painted.voxels[0].materialType, VoxelMaterial.EMISSIVE);
  engine.undo();
  assert.deepEqual(engine.getModelDocument(), before);
  engine.currentEditMaterial = VoxelMaterial.METALLIC;
  engine.redo();
  assert.deepEqual(engine.getModelDocument(), painted);
});

test('engine Delete undo preserves the complete voxel after brush settings change', (t) => {
  const engine = engineFor(t, [rich]);
  const before = engine.getModelDocument();
  engine.editVoxels({ mode: 'delete', targets: [rich] });
  engine.currentEditMaterial = VoxelMaterial.METALLIC;
  engine.undo();
  assert.deepEqual(engine.getModelDocument(), before);
});

test('construction replay follows the current undo history and leaves undone edits undone', async (t) => {
  const engine = engineFor(t, [rich]);
  engine.editVoxels({ mode: 'paint', targets: [rich], color: 0x00ff00 });
  engine.editVoxels({ mode: 'paint', targets: [rich], color: 0x0000ff });
  engine.undo();
  await engine.playTimeLapse();
  assert.equal(engine.getVoxelDataForSave()[0].color, 0x00ff00);
  assert.equal(engine.undoStack.length, 1);
  assert.equal(engine.redoStack.length, 1);
});
test('replay never autosaves intermediate geometry and a new model cancels late replay frames', async (t) => {
  const engine = engineFor(t, [rich]);
  engine.editVoxels({ mode: 'paint', targets: [rich], color: 0x00ff00 });
  const author = engine.getModelDocument();
  let notifications = 0;
  engine.onDocumentChange = () => notifications++;
  const replay = engine.playTimeLapse();
  assert.deepEqual(engine.getModelDocument(), author);
  engine.loadInitialModel([{ x: 8, y: 2, z: 1, color: 0xff00ff }]);
  const opened = engine.getModelDocument();
  await replay;
  assert.deepEqual(engine.getModelDocument(), opened);
  assert.equal(notifications, 1);
});
test('a delayed image import cannot replace a newly opened model', async (t) => {
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image'),
    readerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  class FakeImage {
    onload?: () => void;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  class FakeReader {
    onload?: (event: any) => void;
    readAsDataURL() {
      queueMicrotask(() => this.onload?.({ target: { result: 'data:image/png;base64,AA==' } }));
    }
  }
  Object.defineProperty(globalThis, 'Image', { value: FakeImage, configurable: true });
  Object.defineProperty(globalThis, 'FileReader', { value: FakeReader, configurable: true });
  t.after(() => {
    for (const [key, descriptor] of [
      ['Image', imageDescriptor],
      ['FileReader', readerDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  });
  const engine = engineFor(t, [rich]),
    pending = engine.voxelizeImage(new File(['test'], 'image.png'));
  engine.loadInitialModel([{ x: 9, y: 1, z: 2, color: 0 }]);
  const expected = engine.getModelDocument();
  await assert.rejects(pending, /active model changed/);
  assert.deepEqual(engine.getModelDocument(), expected);
});
test('legacy binary exports preserve canonical locked colors and reject unrepresentable sparse volumes', async (t) => {
  let blob: Blob | null = null;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => ({ click() {} }) },
    configurable: true,
  });
  const create = t.mock.method(URL, 'createObjectURL', (value: Blob) => {
    blob = value;
    return 'blob:test';
  });
  t.after(() => {
    create.mock.restore();
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete (globalThis as any).document;
  });
  const engine = engineFor(t, [
    { x: 0, y: 0, z: 0, color: 0x00ff00, isLocked: true },
    { x: 1, y: 0, z: 0, color: 0 },
    { x: 2, y: 0, z: 0, color: 0xff1122 },
  ]);
  await engine.exportVOX();
  const vox = engine.importVOX(await blob!.arrayBuffer());
  assert.deepEqual(
    vox.map((v: any) => v.color).sort((a: number, b: number) => a - b),
    [0, 0x00ff00, 0xff1122],
  );
  await engine.exportQB();
  const qb = engine.importQB(await blob!.arrayBuffer());
  assert.deepEqual(
    qb.map((v: any) => v.color).sort((a: number, b: number) => a - b),
    [0, 0x00ff00, 0xff1122],
  );
  engine.loadInitialModel([
    { x: 0, y: 0, z: 0, color: 0 },
    { x: 10000, y: 10000, z: 10000, color: 0 },
  ]);
  await assert.rejects(engine.exportVOX(), /256/);
  await assert.rejects(engine.exportQB(), /volume cells/);
  await assert.rejects(engine.exportMinecraft('nbt'), /volume cells/);
});

test('smaller and empty rebuilds end with exactly the target and remain undoable', (t) => {
  for (const target of [[{ ...rich, x: 6, color: 0xff0000, isLocked: true }], []]) {
    const engine = engineFor(t, [
      { ...rich, materialType: VoxelMaterial.STANDARD },
      { ...rich, x: 2, color: 0x0000ff },
    ]);
    const before = engine.getVoxelDataForSave();
    engine.rebuild(target);
    // A save during the effect stores authored geometry, never flying fragments.
    assert.deepEqual(ordered(parseModelDocument(engine.getJsonData()).voxels), ordered(target));
    finishRebuild(engine);
    assert.deepEqual(ordered(engine.getVoxelDataForSave()), ordered(target));
    assert.equal(engine.voxels.length, target.length);
    engine.undo();
    assert.deepEqual(ordered(engine.getVoxelDataForSave()), ordered(before));
    engine.redo();
    assert.deepEqual(ordered(engine.getVoxelDataForSave()), ordered(target));
  }
});

test('rebuild waits for Y/Z motion and owns a detached copy of the target', (t) => {
  const engine = engineFor(t, [rich]);
  const target = [{ ...rich, y: 10, z: 12, weights: [{ bone: 'Root', weight: 1 }] }];
  engine.rebuild(target);
  target[0].weights[0].weight = 0;
  engine.rebuildStartTime = Date.now() - 100000;
  engine.updatePhysics();
  assert.equal(engine.state, AppState.REBUILDING);
  finishRebuild(engine);
  assert.equal(engine.getVoxelDataForSave()[0].y, 10);
  assert.equal(engine.getVoxelDataForSave()[0].weights[0].weight, 1);
});

test('AI morph preserves locked voxel colors and rig information', (t) => {
  const engine = engineFor(t, [
    { ...rich, isLocked: true },
    { ...rich, x: 1 },
  ]);
  engine.mergeAIGeneratedModel([
    { ...rich, color: 0xffffff },
    { ...rich, x: 3 },
  ]);
  finishRebuild(engine);
  const preserved = engine.getModelDocument().voxels.find((v: VoxelData) => v.x === 0);
  assert.deepEqual(preserved, normalizeVoxels([{ ...rich, isLocked: true }])[0]);
  assert.equal(engine.voxels.length, 2);
});

test('flip/rotate/resample preserve metadata and do not clear previous edit history', (t) => {
  const engine = engineFor(t, [{ ...rich, x: 2, z: 1 }]);
  const before = engine.getModelDocument();
  engine.editVoxels({ mode: 'lock', targets: [{ x: 2, y: 0, z: 1 }] });
  engine.flipModel('x');
  engine.rotateModel90('cw');
  engine.resample(2);
  assert.equal(engine.undoStack.length, 4);
  for (let i = 0; i < 4; i++) engine.undo();
  assert.deepEqual(engine.getModelDocument(), before);
});

test('repeated edits reuse mesh buffers and new instances are populated immediately', (t) => {
  const engine = engineFor(t, [rich]);
  const mesh = engine.standardMesh;
  engine.rebuildInstancedMesh();
  engine.editVoxels({ mode: 'add', targets: [{ x: 20, y: 2, z: 3 }], color: 0xff0000 });
  assert.equal(engine.standardMesh, mesh);
  assert.equal(engine.standardMesh.count, 1);
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [20, 2, 3]);
});

test('empty-grid pointer Add places the first block and can undo it', (t) => {
  const engine = engineFor(t);
  engine.state = AppState.EDITING;
  engine.editMode = 'add';
  engine.currentEditColor = '#000000';
  engine.currentEditMaterial = VoxelMaterial.GLASS;
  engine.mouse = new THREE.Vector2();
  engine.raycaster = new THREE.Raycaster();
  engine.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  engine.camera.position.set(0, 10, 20);
  engine.camera.lookAt(0, CONFIG.FLOOR_Y + 1, 0);
  engine.camera.updateMatrixWorld();
  engine.renderer = {
    domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
  };
  engine.handleEditClick({ clientX: 50, clientY: 50 });
  assert.deepEqual(
    engine.getModelDocument().voxels,
    normalizeVoxels([{ x: 0, y: CONFIG.FLOOR_Y + 1, z: 0, color: 0, materialType: VoxelMaterial.GLASS }]),
  );
  assert.equal(engine.undoStack.length, 1);
  engine.undo();
  assert.equal(engine.voxels.length, 0);
});

test('invalid import/rebuild preserves the current model and its history', (t) => {
  const engine = engineFor(t, [rich]);
  engine.editVoxels({ mode: 'lock', targets: [rich] });
  const before = engine.getJsonData();
  assert.throws(() => engine.importJsonData('{"format":"voxshop-model","version":42,"voxels":[]}'));
  assert.throws(() => engine.rebuild([{ ...rich, x: Infinity }]));
  assert.equal(engine.getJsonData(), before);
  assert.equal(engine.undoStack.length, 1);
});

test('opening a new model cancels an old reconstruction and clears stale rigs', (t) => {
  const engine = engineFor(t, [rich]);
  engine.loadInitialModel([rich], profile);
  engine.buildRigAndPreview(profile);
  const rig = engine.rigGroup;
  engine.rebuild([{ ...rich, x: 5 }]);
  engine.loadInitialModel([{ ...rich, x: 10 }]);
  engine.updatePhysics();
  assert.equal(engine.currentSkeletonDef, null);
  assert.equal(engine.scene.children.includes(rig), false);
  assert.equal(engine.pendingRebuildModel, null);
  assert.equal(engine.getVoxelDataForSave()[0].x, 10);
});
