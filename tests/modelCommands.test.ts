import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyVoxelCommand,
  createMoveCommand,
  createVoxelEdit,
  replaceModelCommand,
} from '../services/modelCommands';
import { normalizeVoxels } from '../services/modelDocument';
import { VoxelMaterial, type VoxelData } from '../types';

const rich = {
  x: 0,
  y: 0,
  z: 0,
  color: 0xff0000,
  materialType: VoxelMaterial.GLASS,
  bone: 'Root',
  weights: [{ bone: 'Root', weight: 1 }],
};
const ordered = (data: VoxelData[]) =>
  normalizeVoxels(data).sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);

test('fill respects locked barriers and preserves metadata through undo and redo', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1, isLocked: true }, { ...rich, x: 2 }]);
  const command = createVoxelEdit(before, {
    mode: 'fill',
    targets: [rich],
    color: 0x00ff00,
    materialType: VoxelMaterial.METALLIC,
  });
  const after = applyVoxelCommand(before, command);
  assert.equal(command.voxels.length, 1);
  assert.equal(after.find((v) => v.x === 0)!.color, 0x00ff00);
  assert.equal(after.find((v) => v.x === 2)!.color, 0xff0000);
  assert.deepEqual(ordered(applyVoxelCommand(after, command, true)), ordered(before));
  assert.deepEqual(
    ordered(applyVoxelCommand(applyVoxelCommand(after, command, true), command)),
    ordered(after),
  );
  assert.equal(before[0].color, 0xff0000);
});

test('delete undo restores the complete voxel, independent of current brush material', () => {
  const before = normalizeVoxels([rich]);
  const command = createVoxelEdit(before, {
    mode: 'delete',
    targets: [rich],
    materialType: VoxelMaterial.STANDARD,
  });
  const removed = applyVoxelCommand(before, command);
  assert.equal(removed.length, 0);
  assert.deepEqual(applyVoxelCommand(removed, command, true), before);
});

test('paint undo restores both color and material, retaining rig weights', () => {
  const before = normalizeVoxels([rich]);
  const command = createVoxelEdit(before, {
    mode: 'paint',
    targets: [rich],
    color: 0,
    materialType: VoxelMaterial.EMISSIVE,
  });
  const after = applyVoxelCommand(before, command);
  assert.equal(after[0].color, 0);
  assert.equal(after[0].materialType, VoxelMaterial.EMISSIVE);
  assert.deepEqual(after[0].weights, rich.weights);
  assert.deepEqual(applyVoxelCommand(after, command, true), before);
});

test('overlapping symmetry targets lock once and unlock with one undo', () => {
  const before = normalizeVoxels([rich]);
  const command = createVoxelEdit(before, { mode: 'lock', targets: [rich, rich, rich] });
  assert.equal(command.voxels.length, 1);
  const locked = applyVoxelCommand(before, command);
  assert.equal(locked[0].isLocked, true);
  assert.equal(locked[0].color, rich.color);
  assert.deepEqual(applyVoxelCommand(locked, command, true), before);
});

test('add supports an empty model, deduplicates brush targets, and redoes with its original material', () => {
  const command = createVoxelEdit([], {
    mode: 'add',
    targets: [rich, rich],
    color: 0,
    materialType: VoxelMaterial.GLASS,
  });
  const after = applyVoxelCommand([], command);
  assert.equal(after.length, 1);
  assert.equal(after[0].materialType, VoxelMaterial.GLASS);
  assert.equal(after[0].color, 0);
  assert.deepEqual(applyVoxelCommand(after, command, true), []);
  assert.deepEqual(applyVoxelCommand([], command), after);
});

test('multi-seed fill can recolor adjacent regions with different original colors', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1, color: 0x0000ff }]);
  const command = createVoxelEdit(before, {
    mode: 'fill',
    targets: [rich, { x: 1, y: 0, z: 0 }],
    color: 0x00ff00,
  });
  assert.equal(command.voxels.length, 2);
  assert.ok(applyVoxelCommand(before, command).every((v) => v.color === 0x00ff00));
});

test('moves reject occupied destinations and preserve complete records when undoing', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1 }]);
  assert.equal(createMoveCommand(before, rich, { x: 1, y: 0, z: 0 }).voxels.length, 0);
  const command = createMoveCommand(before, rich, { x: 3, y: 0, z: 0 });
  assert.deepEqual(
    ordered(applyVoxelCommand(applyVoxelCommand(before, command), command, true)),
    ordered(before),
  );
});

test('whole-model replacement supports swapped positions, smaller targets, and empty targets', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1, color: 0x0000ff }]);
  for (const target of [before.map((v) => ({ ...v, x: 1 - v.x })), [rich], []]) {
    const command = replaceModelCommand(before, normalizeVoxels(target));
    const after = applyVoxelCommand(before, command);
    assert.deepEqual(ordered(after), ordered(target));
    assert.deepEqual(ordered(applyVoxelCommand(after, command, true)), ordered(before));
  }
});

test('a rejected edit does not mutate its input or command history', () => {
  const before = normalizeVoxels([rich]);
  const snapshot = structuredClone(before);
  const command = createVoxelEdit(before, { mode: 'add', targets: [{ x: NaN, y: 0, z: 0 }], color: 0 });
  assert.throws(() => applyVoxelCommand(before, command));
  assert.deepEqual(before, snapshot);
});
