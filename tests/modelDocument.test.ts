import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  createModelDocument,
  normalizeVoxels,
  parseModelDocument,
  serializeModelDocument,
} from '../services/modelDocument';
import { SKELETONS, type SkeletonDef } from '../utils/riggingConstants';
import { VoxelMaterial } from '../types';

export const skeleton: SkeletonDef = {
  id: 'test-rig',
  name: 'Test rig',
  bones: [{ name: 'Root', parent: null, pivotType: 'center', color: '#ffffff' }],
  animations: [
    {
      name: 'Idle',
      duration: 1,
      tracks: {
        Root: [
          { time: 0, rot: [0, 0, 0] },
          { time: 1, rot: [0, 1, 0] },
        ],
      },
    },
  ],
};

test('native save/open preserves black, materials, bone weights, locks, and the animation profile', () => {
  const source = createModelDocument(
    [
      {
        x: 0,
        y: 1,
        z: -2,
        color: 0,
        materialType: VoxelMaterial.GLASS,
        bone: 'Root',
        weights: [{ bone: 'Root', weight: 1 }],
        isLocked: true,
      },
      { x: 1, y: 1, z: -2, color: 0x00ff00, materialType: VoxelMaterial.EMISSIVE },
    ],
    skeleton,
  );
  assert.deepEqual(parseModelDocument(serializeModelDocument(source)), source);
});

test('legacy and GLB compact arrays remain readable', () => {
  const legacy = parseModelDocument(
    JSON.stringify([
      {
        id: 7,
        x: 1.1,
        y: 2,
        z: 3,
        c: '#000000',
        m: 'GLASS',
        b: 'Root',
        w: [{ bone: 'Root', weight: 1 }],
        l: true,
      },
      { x: -1, y: 0, z: 0, color: '#f00' },
    ]),
  );
  assert.equal(legacy.voxels[0].color, 0);
  assert.equal(legacy.voxels[0].x, 1);
  assert.equal(legacy.voxels[0].isLocked, true);
  assert.equal(legacy.voxels[0].materialType, VoxelMaterial.GLASS);
  assert.deepEqual(legacy.voxels[0].weights, [{ bone: 'Root', weight: 1 }]);
  assert.equal(legacy.voxels[1].color, 0xff0000);
  assert.equal(legacy.skeleton, null);
});

test('document snapshots do not share mutable weights or skeleton frames with callers', () => {
  const input = [{ x: 0, y: 0, z: 0, color: 0, weights: [{ bone: 'Root', weight: 1 }] }];
  const doc = createModelDocument(input, skeleton);
  doc.voxels[0].weights![0].weight = 0;
  doc.skeleton!.animations[0].tracks.Root[0].rot![0] = 10;
  assert.equal(input[0].weights[0].weight, 1);
  assert.equal(skeleton.animations[0].tracks.Root[0].rot![0], 0);
});

test('all shipped skeleton profiles can be saved and reopened', () => {
  for (const profile of SKELETONS) {
    const doc = createModelDocument([], profile);
    assert.deepEqual(parseModelDocument(serializeModelDocument(doc)), doc, profile.name);
  }
});

test('all existing preset models load through the compatibility reader', () => {
  const directory = new URL('../presets/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const preset = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    const legacy = parseModelDocument(JSON.stringify(preset.data));
    assert.ok(legacy.voxels.length > 0, file);
    assert.deepEqual(parseModelDocument(serializeModelDocument(legacy)), legacy, file);
  }
});

test('invalid voxel data and unknown future formats are rejected before loading', () => {
  for (const input of [
    null,
    [null],
    [{ x: Infinity }],
    [{ x: '1' }],
    [{ color: 'oops' }],
    [{ materialType: {} }],
    [{ weights: [{ bone: 'Root', weight: -1 }] }],
  ]) {
    assert.throws(() => normalizeVoxels(input));
  }
  assert.throws(
    () => parseModelDocument('{"format":"voxshop-model","version":2,"voxels":[]}'),
    /Unsupported/,
  );
  assert.throws(() => parseModelDocument('{"voxels":[]}'), /Expected/);
  const cyclic = structuredClone(skeleton);
  cyclic.bones[0].parent = 'Root';
  assert.throws(() => createModelDocument([], cyclic), /cycle/);
});

test('normalization deduplicates rounded positions using the last complete record', () => {
  const data = normalizeVoxels([
    { x: 0, color: 0 },
    { x: 0.1, color: 0xffffff, isLocked: true },
  ]);
  assert.equal(data.length, 1);
  assert.equal(data[0].color, 0xffffff);
  assert.equal(data[0].isLocked, true);
});
