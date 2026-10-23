import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_PROGRESS_VERSION,
  GameProgressStore,
  parseGameProgress,
  serializeGameProgress,
  type GameProgressSnapshot,
  type ProgressStorageLike,
} from '../runtime/gameProgress';

class MemoryStorage implements ProgressStorageLike {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function snapshot(): GameProgressSnapshot {
  return {
    version: GAME_PROGRESS_VERSION,
    projectId: 'behavior-project',
    sceneId: 'main',
    variables: {},
    inventory: [],
    health: {},
    nodes: {},
    status: 'playing',
  };
}

function parse(value: unknown) {
  return parseGameProgress(JSON.stringify(value), 'behavior-project', 'main');
}

test('behavior checkpoint round-trips detached patrol, animation and cooldown state', () => {
  const source = snapshot();
  source.behavior = {
    patrolTargets: { guard: 2 },
    animations: { guard: { clip: 'Run_2', time: 12.5 } },
    cooldowns: { attack: 0.25, damage: 1.5 },
  };
  const before = JSON.stringify(source);
  const serialized = serializeGameProgress(source);
  assert.ok(serialized);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(parseGameProgress(serialized, source.projectId, source.sceneId), source);

  const loaded = parseGameProgress(serialized, source.projectId, source.sceneId)!;
  loaded.behavior!.patrolTargets.guard = 0;
  loaded.behavior!.animations.guard.time = 99;
  loaded.behavior!.cooldowns.attack = 0;
  assert.deepEqual(source.behavior, {
    patrolTargets: { guard: 2 },
    animations: { guard: { clip: 'Run_2', time: 12.5 } },
    cooldowns: { attack: 0.25, damage: 1.5 },
  });
});

test('legacy snapshots remain valid and present behavior requires all fields', () => {
  const legacy = snapshot();
  assert.deepEqual(parse(legacy), legacy);
  assert.equal(parse(legacy)?.behavior, undefined);

  const empty = {
    ...legacy,
    behavior: { patrolTargets: {}, animations: {}, cooldowns: { attack: 0, damage: 0 } },
  };
  assert.deepEqual(parse(empty), empty);
  for (const behavior of [
    { patrolTargets: {}, animations: {} },
    { patrolTargets: {}, cooldowns: { attack: 0, damage: 0 } },
    { animations: {}, cooldowns: { attack: 0, damage: 0 } },
    { patrolTargets: {}, animations: {}, cooldowns: { attack: 0 } },
    { patrolTargets: {}, animations: {}, cooldowns: { attack: 0, damage: 0 }, extra: true },
  ])
    assert.equal(parse({ ...legacy, behavior }), null);
});

test('behavior rejects invalid bounds, clip names, unknown fields and oversized records', () => {
  const base = snapshot();
  const invalidBehaviors = [
    { patrolTargets: { guard: -1 }, animations: {}, cooldowns: { attack: 0, damage: 0 } },
    { patrolTargets: { guard: 10_000 }, animations: {}, cooldowns: { attack: 0, damage: 0 } },
    { patrolTargets: { guard: 1.5 }, animations: {}, cooldowns: { attack: 0, damage: 0 } },
    {
      patrolTargets: {},
      animations: { guard: { clip: ' idle', time: 0 } },
      cooldowns: { attack: 0, damage: 0 },
    },
    {
      patrolTargets: {},
      animations: { guard: { clip: 'x'.repeat(65), time: 0 } },
      cooldowns: { attack: 0, damage: 0 },
    },
    {
      patrolTargets: {},
      animations: { guard: { clip: 'Idle', time: -1 } },
      cooldowns: { attack: 0, damage: 0 },
    },
    {
      patrolTargets: {},
      animations: { guard: { clip: 'Idle', time: 1_000_000_000_001 } },
      cooldowns: { attack: 0, damage: 0 },
    },
    { patrolTargets: {}, animations: {}, cooldowns: { attack: -1, damage: 0 } },
    { patrolTargets: {}, animations: {}, cooldowns: { attack: 10_001, damage: 0 } },
    {
      patrolTargets: {},
      animations: { guard: { clip: 'Idle', time: 0, extra: true } },
      cooldowns: { attack: 0, damage: 0 },
    },
    {
      patrolTargets: Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`node-${index}`, 0])),
      animations: {},
      cooldowns: { attack: 0, damage: 0 },
    },
  ];
  for (const behavior of invalidBehaviors) assert.equal(parse({ ...base, behavior }), null);
});

test('rejected behavior saves preserve the existing checkpoint', () => {
  const storage = new MemoryStorage();
  const store = new GameProgressStore('behavior-project', 'main', () => storage);
  const original = snapshot();
  original.behavior = { patrolTargets: {}, animations: {}, cooldowns: { attack: 0, damage: 0 } };
  assert.equal(store.save(original), 'saved');
  const previous = storage.getItem(store.key);

  const invalid = snapshot();
  invalid.behavior = { patrolTargets: {}, animations: {}, cooldowns: { attack: -0.1, damage: 0 } };
  assert.equal(store.save(invalid), 'invalid');
  assert.equal(storage.getItem(store.key), previous);
  assert.deepEqual(store.load(), { status: 'loaded', snapshot: original });
});
