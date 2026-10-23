import test from 'node:test';
import assert from 'node:assert/strict';
import { locateCell, localCellIndex, WorldChunkStore } from '../services/worldChunks';

test('chunk mapping uses bounded local coordinates for positive and negative world cells', () => {
  assert.deepEqual(locateCell({ x: -1, y: -16, z: 16 }, 16), {
    chunk: { x: -1, y: -1, z: 1 },
    local: { x: 15, y: 0, z: 0 },
  });
  assert.deepEqual(locateCell({ x: -17, y: 0, z: 15 }, 16), {
    chunk: { x: -2, y: 0, z: 0 },
    local: { x: 15, y: 0, z: 15 },
  });
  assert.equal(localCellIndex({ x: 15, y: 15, z: 15 }, 16), 4095);
  assert.equal(localCellIndex({ x: 31, y: 31, z: 31 }, 32), 32767);
  assert.throws(() => locateCell({ x: 1.5, y: 0, z: 0 }, 16), /safe integer/);
  assert.throws(() => localCellIndex({ x: 16, y: 0, z: 0 }, 16), /outside the chunk/);
  assert.throws(() => new WorldChunkStore(1, 0, () => 1), /Chunk size/);
  assert.throws(() => new WorldChunkStore(1, 33, () => 1), /Chunk size/);
});

test('seeded cell generation is repeatable across stores and unloads', () => {
  const generate = (_position: { x: number; y: number; z: number }, random: () => number) =>
    random() < 0.35 ? Math.floor(random() * 0x1000000) : undefined;
  const first = new WorldChunkStore(217, 8, generate);
  const second = new WorldChunkStore(217, 8, generate);
  const original = [...first.hydrate({ x: -2, y: 0, z: 3 }).cells];
  assert.deepEqual([...second.hydrate({ x: -2, y: 0, z: 3 }).cells], original);
  assert.equal(first.unload({ x: -2, y: 0, z: 3 }), true);
  assert.deepEqual([...first.hydrate({ x: -2, y: 0, z: 3 }).cells], original);

  const otherSeed = new WorldChunkStore(218, 8, generate);
  assert.notDeepEqual([...otherSeed.hydrate({ x: -2, y: 0, z: 3 }).cells], original);
});

test('sparse edits and generated-cell tombstones survive unload and edit snapshot restore', () => {
  const generate = (position: { x: number; y: number; z: number }) =>
    (position.x + position.y + position.z) % 2 === 0 ? 1 : undefined;
  const store = new WorldChunkStore<number>(4, 4, generate);
  store.set({ x: -1, y: 0, z: 0 }, 7);
  store.set({ x: 0, y: 0, z: 0 }, null);
  assert.equal(store.get({ x: -1, y: 0, z: 0 }), 7);
  assert.equal(store.get({ x: 0, y: 0, z: 0 }), undefined);
  assert.equal(store.loadedChunkCount(), 2);

  store.unloadAll();
  assert.equal(store.loadedChunkCount(), 0);
  assert.equal(store.get({ x: -1, y: 0, z: 0 }), 7);
  assert.equal(store.get({ x: 0, y: 0, z: 0 }), undefined);

  const edits = store.exportEdits();
  assert.deepEqual(edits, [
    { x: -1, y: 0, z: 0, value: 7 },
    { x: 0, y: 0, z: 0, value: null },
  ]);
  const restored = new WorldChunkStore<number>(4, 4, generate);
  restored.restoreEdits(edits);
  assert.equal(restored.get({ x: -1, y: 0, z: 0 }), 7);
  assert.equal(restored.get({ x: 0, y: 0, z: 0 }), undefined);
  assert.throws(
    () =>
      restored.restoreEdits([
        { x: 1, y: 1, z: 1, value: 2 },
        { x: 1, y: 1, z: 1, value: 3 },
      ]),
    /duplicate/,
  );
});
