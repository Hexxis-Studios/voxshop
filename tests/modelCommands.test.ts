import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyVoxelCommand,
  applyVoxelCommandToLookup,
  blendVoxelWeights,
  createMoveCommand,
  createMoveCommandFromLookup,
  moveVoxelInLookup,
  createVoxelEdit,
  createVoxelEditFromLookup,
  replaceModelCommand,
  type VoxelEdit,
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

test('lookup-based edits match full-model commands for touched and fill voxels', () => {
  const before = normalizeVoxels([
    rich,
    { ...rich, x: 1 },
    { ...rich, x: 2, isLocked: true },
    { ...rich, x: 4, color: 0x0000ff },
  ]);
  const lookup = new Map(before.map((voxel) => [`${voxel.x},${voxel.y},${voxel.z}`, voxel]));
  const edits = [
    { mode: 'paint' as const, targets: [rich], color: 0x00ff00 },
    { mode: 'lock' as const, targets: [rich] },
    { mode: 'fill' as const, targets: [rich], color: 0x00ff00 },
    { mode: 'add' as const, targets: [{ x: 3, y: 0, z: 0 }], color: 0xabcdef },
    { mode: 'weight' as const, targets: [rich], weights: [{ bone: 'Hand', weight: 1 }] },
  ];
  for (const edit of edits) {
    assert.deepEqual(
      createVoxelEditFromLookup((key) => lookup.get(key), edit),
      createVoxelEdit(before, edit),
    );
  }
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

test('sparse commands share untouched voxels and replace only edited records', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1 }]);
  const command = createVoxelEdit(before, {
    mode: 'paint',
    targets: [{ x: 0, y: 0, z: 0 }],
    color: 0x00ff00,
  });
  const after = applyVoxelCommand(before, command);

  assert.notEqual(
    after.find((voxel) => voxel.x === 0),
    before[0],
  );
  assert.equal(
    after.find((voxel) => voxel.x === 1),
    before[1],
  );
  assert.equal(before[0].color, 0xff0000);
  assert.equal(after.find((voxel) => voxel.x === 0)!.color, 0x00ff00);
  assert.throws(
    () =>
      applyVoxelCommand(before, { action: 'add', voxels: [{ before: null, after: { ...rich, x: NaN } }] }),
    /coordinates must be finite/,
  );
});

test('one-voxel commands preserve a cap-scale model and share every untouched record', () => {
  const before = Array.from({ length: 250_000 }, (_, x) => ({
    x,
    y: 0,
    z: 0,
    color: 0x647a52,
    materialType: VoxelMaterial.STANDARD,
    isLocked: false,
  }));
  const index = 125_000;
  const source = before[index];
  const command = {
    action: 'paint' as const,
    voxels: [{ before: source, after: { ...source, color: 0x13579b } }],
  };

  const painted = applyVoxelCommand(before, command);
  assert.equal(painted.length, before.length);
  assert.strictEqual(painted[0], before[0]);
  assert.strictEqual(painted[index], before[index + 1]);
  assert.equal(painted.at(-1)?.color, 0x13579b);
  assert.equal(source.color, 0x647a52);

  const undone = applyVoxelCommand(painted, command, true);
  assert.equal(undone.length, before.length);
  assert.strictEqual(undone[0], before[0]);
  assert.equal(undone.at(-1)?.color, source.color);
});

test('skin-weight edits normalize influences, retain the dominant legacy bone, and undo fully', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1, isLocked: true }]);
  const command = createVoxelEdit(before, {
    mode: 'weight',
    targets: [rich, { ...rich, x: 1 }],
    weights: [
      { bone: 'Hand', weight: 0.25 },
      { bone: 'Root', weight: 0.75 },
    ],
  });
  assert.equal(command.action, 'weight');
  assert.equal(command.voxels.length, 1, 'Locked voxels are skipped.');
  const after = applyVoxelCommand(before, command);
  const skinned = after.find((voxel) => voxel.x === 0)!;
  assert.equal(skinned.bone, 'Root');
  assert.deepEqual(skinned.weights, [
    { bone: 'Root', weight: 0.75 },
    { bone: 'Hand', weight: 0.25 },
  ]);
  assert.deepEqual(ordered(applyVoxelCommand(after, command, true)), ordered(before));
  assert.deepEqual(applyVoxelCommand(applyVoxelCommand(after, command, true), command), after);
  assert.throws(
    () =>
      createVoxelEdit(before, { mode: 'weight', targets: [rich], weights: [{ bone: 'Root', weight: 0.7 }] }),
    /sum to one/,
  );
  assert.throws(
    () =>
      createVoxelEdit(before, {
        mode: 'weight',
        targets: [rich],
        weights: [
          { bone: 'Root', weight: 0.5 },
          { bone: 'Root', weight: 0.5 },
        ],
      }),
    /unique joints/,
  );
});

test('manual influence painting rescales the remaining weights and respects the four-joint cap', () => {
  assert.throws(() => blendVoxelWeights({}, 'Hand', 0, 'Root'), /greater than zero/);
  assert.deepEqual(
    blendVoxelWeights(
      {
        bone: 'Root',
        weights: [
          { bone: 'Root', weight: 0.8 },
          { bone: 'Hand', weight: 0.2 },
        ],
      },
      'Hand',
      0.6,
    ),
    [
      { bone: 'Hand', weight: 0.6 },
      { bone: 'Root', weight: 0.4 },
    ],
  );
  const capped = blendVoxelWeights(
    {
      weights: [
        { bone: 'Root', weight: 0.4 },
        { bone: 'Arm', weight: 0.3 },
        { bone: 'Leg', weight: 0.2 },
        { bone: 'Wing', weight: 0.1 },
      ],
    },
    'Tail',
    0.5,
  );
  assert.deepEqual(
    capped.map((entry) => entry.bone),
    ['Tail', 'Root', 'Arm', 'Leg'],
  );
  assert.ok(Math.abs(capped.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 1e-12);
  assert.deepEqual(blendVoxelWeights({}, 'Hand', 0.4, 'Root'), [
    { bone: 'Root', weight: 0.6 },
    { bone: 'Hand', weight: 0.4 },
  ]);
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

test('lookup edit batches match sequential array edits and their reverse history order', () => {
  const before = normalizeVoxels([rich, { ...rich, x: 1 }, { ...rich, x: 2 }]);
  const edits: VoxelEdit[] = [
    { mode: 'paint', targets: [{ x: 1, y: 0, z: 0 }], color: 0x00ff00 },
    { mode: 'paint', targets: [{ x: 1, y: 0, z: 0 }], color: 0x0000ff },
    { mode: 'delete', targets: [{ x: 0, y: 0, z: 0 }] },
    { mode: 'add', targets: [{ x: 3, y: 0, z: 0 }], color: 0xffffff },
    { mode: 'paint', targets: [{ x: 3, y: 0, z: 0 }], color: 0x112233 },
    { mode: 'lock', targets: [{ x: 3, y: 0, z: 0 }] },
  ];
  const lookup = new Map(before.map((voxel) => [`${voxel.x},${voxel.y},${voxel.z}`, voxel]));
  const history: ReturnType<typeof createVoxelEdit>[] = [];
  let expected = before;
  for (const edit of edits) {
    const delta = createVoxelEditFromLookup((key) => lookup.get(key), edit);
    history.push(delta);
    expected = applyVoxelCommand(expected, delta);
    applyVoxelCommandToLookup(lookup, delta);
    assert.deepEqual([...lookup.values()], expected);
  }
  for (const delta of history.reverse()) {
    expected = applyVoxelCommand(expected, delta, true);
    applyVoxelCommandToLookup(lookup, delta, true);
    assert.deepEqual([...lookup.values()], expected);
  }
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

test('lookup-backed moves match the array helper with at most two coordinate reads', () => {
  const before = normalizeVoxels([
    rich,
    { ...rich, x: 1 },
    { ...rich, x: 2, isLocked: true },
    ...Array.from({ length: 256 }, (_, index) => ({ ...rich, x: index + 10 })),
  ]);
  const byCoordinate = new Map(before.map((voxel) => [`${voxel.x},${voxel.y},${voxel.z}`, voxel]));
  const cases = [
    { from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 }, changed: true },
    { from: { x: 2, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 }, changed: false },
    { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, changed: false },
    { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, changed: false },
  ];
  for (const { from, to, changed } of cases) {
    let lookupCalls = 0;
    const command = createMoveCommandFromLookup(
      (key) => {
        lookupCalls++;
        return byCoordinate.get(key);
      },
      from,
      to,
    );
    assert.deepEqual(command, createMoveCommand(before, from, to));
    assert.equal(command.voxels.length, changed ? 1 : 0);
    assert.ok(lookupCalls <= 2, `Move performs at most two coordinate reads (observed ${lookupCalls}).`);
  }
});

test('lookup move mutates only the moved record and rejects occupied destinations', () => {
  const voxels = normalizeVoxels([rich, { ...rich, x: 1 }, { ...rich, x: 2 }]);
  const lookup = new Map(voxels.map((voxel) => [`${voxel.x},${voxel.y},${voxel.z}`, voxel]));
  const moved = lookup.get('0,0,0')!;
  const untouched = lookup.get('2,0,0')!;
  const originalColor = moved.color;

  assert.strictEqual(moveVoxelInLookup(lookup, moved, { x: 4, y: 0, z: 0 }), moved);
  assert.equal(lookup.has('0,0,0'), false);
  assert.strictEqual(lookup.get('4,0,0'), moved);
  assert.strictEqual(lookup.get('2,0,0'), untouched);
  assert.equal(moved.color, originalColor, 'Coordinate updates leave authored voxel attributes untouched.');
  assert.equal(lookup.size, voxels.length);
  assert.equal(moveVoxelInLookup(lookup, moved, { x: 1, y: 0, z: 0 }), null);
  assert.strictEqual(lookup.get('4,0,0'), moved, 'A rejected move leaves the original index intact.');

  assert.strictEqual(moveVoxelInLookup(lookup, moved, { x: 0, y: 0, z: 0 }), moved);
  assert.deepEqual(ordered([...lookup.values()]), ordered(voxels));
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
