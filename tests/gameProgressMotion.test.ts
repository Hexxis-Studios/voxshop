import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_PROGRESS_VERSION,
  GameProgressStore,
  MAX_GAME_PROGRESS_BYTES,
  parseGameProgress,
  serializeGameProgress,
  type GameProgressSnapshot,
  type ProgressStorageLike,
} from '../runtime/gameProgress';

class MemoryStorage implements ProgressStorageLike {
  values = new Map<string, string>();
  rejectWrites = false;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.rejectWrites) throw new Error('Storage is read-only.');
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function snapshot(): GameProgressSnapshot {
  return {
    version: GAME_PROGRESS_VERSION,
    projectId: 'motion-project',
    sceneId: 'main',
    variables: {},
    inventory: [],
    health: {},
    nodes: {},
    status: 'playing',
  };
}

function parse(value: unknown) {
  return parseGameProgress(JSON.stringify(value), 'motion-project', 'main');
}

test('progress motion round-trips and parser returns detached velocity records', () => {
  const source = snapshot();
  source.motion = {
    actors: { player: 4.5 },
    bodies: {
      crate: {
        linearVelocity: [1, -2, 3],
        angularVelocity: [0.1, 0.2, 0.3],
        sleeping: false,
      },
    },
  };
  const before = JSON.stringify(source);
  const serialized = serializeGameProgress(source);
  assert.ok(serialized);
  assert.equal(JSON.stringify(source), before, 'Serialization leaves the caller-owned snapshot unchanged.');
  assert.deepEqual(parseGameProgress(serialized, source.projectId, source.sceneId), source);

  const loaded = parseGameProgress(serialized, source.projectId, source.sceneId)!;
  loaded.motion!.actors.player = 9;
  loaded.motion!.bodies.crate.linearVelocity[0] = 8;
  assert.deepEqual(source.motion.actors, { player: 4.5 });
  assert.deepEqual(source.motion.bodies.crate.linearVelocity, [1, -2, 3]);
});

test('legacy v1 progress without motion remains valid and empty motion records are allowed', () => {
  const legacy = snapshot();
  const parsedLegacy = parse(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(parsedLegacy, legacy);
  assert.equal(parsedLegacy?.motion, undefined);

  const emptyMotion = { ...legacy, motion: { actors: {}, bodies: {} } };
  assert.deepEqual(parse(emptyMotion), emptyMotion);
});

test('full Rapier checkpoints round-trip as bounded JSON and reject malformed envelopes', () => {
  const source = snapshot();
  source.physics = {
    format: 1,
    rapierVersion: '0.21.0',
    compatibilityKey: '{"bounds":20}',
    world: 'AA==',
    bodyHandles: [{ nodeId: 'crate', handle: 0 }],
    colliderHandles: [{ nodeId: 'crate', handle: 0 }],
    worldBodyCount: 1,
    worldColliderCount: 1,
  };
  const serialized = serializeGameProgress(source);
  assert.ok(serialized);
  assert.deepEqual(parseGameProgress(serialized, source.projectId, source.sceneId), source);

  for (const physics of [
    { ...source.physics, rapierVersion: 'latest' },
    { ...source.physics, world: 'not-base64' },
    { ...source.physics, bodyHandles: [{ nodeId: 'bad id', handle: 0 }] },
    { ...source.physics, colliderHandles: [{ nodeId: 'crate', handle: 1 }] },
    { ...source.physics, worldBodyCount: 0 },
    { ...source.physics, extra: true },
  ])
    assert.equal(
      parseGameProgress(JSON.stringify({ ...source, physics }), source.projectId, source.sceneId),
      null,
      `Expected malformed physics checkpoint to be rejected: ${JSON.stringify(physics)}`,
    );
});

test('progress rejects malformed or oversized motion records', () => {
  const base = snapshot();
  const invalidValues = [
    { actors: { player: 1 } },
    { bodies: {} },
    { actors: [], bodies: {} },
    { actors: { 'bad id': 1 }, bodies: {} },
    { actors: { player: 10_001 }, bodies: {} },
    { actors: { player: Number.NaN }, bodies: {} },
    {
      actors: {},
      bodies: { crate: { linearVelocity: [0, 0], angularVelocity: [0, 0, 0], sleeping: false } },
    },
    {
      actors: {},
      bodies: {
        crate: {
          linearVelocity: [0, 0, 10_001],
          angularVelocity: [0, 0, 0],
          sleeping: false,
        },
      },
    },
    {
      actors: {},
      bodies: {
        crate: {
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          sleeping: 0,
        },
      },
    },
    {
      actors: {},
      bodies: {
        crate: {
          linearVelocity: [0.01, 0, 0],
          angularVelocity: [0, 0, 0],
          sleeping: true,
        },
      },
    },
    {
      actors: {},
      bodies: {
        crate: {
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          sleeping: false,
          extra: true,
        },
      },
    },
    { actors: {}, bodies: {}, extra: true },
    {
      actors: Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`actor-${index}`, 0])),
      bodies: {},
    },
  ];
  for (const motion of invalidValues)
    assert.equal(
      parse({ ...base, motion }),
      null,
      `Expected motion to be rejected: ${JSON.stringify(motion).slice(0, 120)}`,
    );

  const tooLarge = {
    ...base,
    motion: { actors: {}, bodies: {} },
    extra: 'x'.repeat(MAX_GAME_PROGRESS_BYTES),
  };
  assert.equal(parse(tooLarge), null, 'The overall serialized progress size limit still applies.');
});

test('rejected motion saves and storage write failures preserve the prior checkpoint', () => {
  const storage = new MemoryStorage();
  const store = new GameProgressStore('motion-project', 'main', () => storage);
  const prior = snapshot();
  assert.equal(store.save(prior), 'saved');
  const serializedPrior = storage.getItem(store.key);
  assert.ok(serializedPrior);

  const invalid = snapshot();
  invalid.motion = { actors: { player: 10_001 }, bodies: {} };
  assert.equal(store.save(invalid), 'invalid');
  assert.equal(storage.getItem(store.key), serializedPrior);

  storage.rejectWrites = true;
  const replacement = snapshot();
  replacement.variables = { score: 10 };
  assert.equal(store.save(replacement), 'unavailable');
  assert.equal(storage.getItem(store.key), serializedPrior);
  assert.deepEqual(store.load(), { status: 'loaded', snapshot: prior });
});
