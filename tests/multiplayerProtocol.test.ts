import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientMessageSchema,
  MULTIPLAYER_PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  serverMessageSchema,
} from '../services/multiplayerProtocol';

test('client protocol accepts bounded join, input intentions and leave messages', () => {
  const credential = 'A'.repeat(43);
  assert.deepEqual(parseClientMessage({ version: 1, type: 'join', gameId: 'arena-1', credential }), {
    version: 1,
    type: 'join',
    gameId: 'arena-1',
    credential,
  });
  assert.deepEqual(
    parseClientMessage({
      version: 1,
      type: 'input',
      sequence: 7,
      input: { moveX: 0.5, moveZ: -1, sprint: true, jump: true, interact: true, attack: false, useItem: 'potion' },
    }),
    {
      version: 1,
      type: 'input',
      sequence: 7,
      input: { moveX: 0.5, moveZ: -1, sprint: true, jump: true, interact: true, attack: false, useItem: 'potion' },
    },
  );
  assert.equal(parseClientMessage({ version: 1, type: 'leave', reason: 'user-request' }).type, 'leave');
  assert.equal(MULTIPLAYER_PROTOCOL_VERSION, 1);
});

test('client messages reject authority fields and server-only message types', () => {
  const authorityFields = [
    { nodeId: 'door-1' },
    { position: [1, 2, 3] },
    { transform: { position: [1, 2, 3] } },
    { health: 999 },
    { targetNodeId: 'enemy-1' },
  ];
  for (const field of authorityFields) {
    assert.equal(
      clientMessageSchema.safeParse({ version: 1, type: 'input', sequence: 0, input: field }).success,
      false,
    );
    assert.equal(
      clientMessageSchema.safeParse({ version: 1, type: 'input', sequence: 0, input: {}, ...field }).success,
      false,
    );
  }
  assert.equal(
    clientMessageSchema.safeParse({
      version: 1,
      type: 'snapshot',
      serverTick: 1,
      players: [],
    }).success,
    false,
  );
});

test('client protocol rejects unsupported versions, malformed sequence and out-of-range intent', () => {
  for (const message of [
    { version: 2, type: 'join', gameId: 'arena-1', credential: 'A'.repeat(43) },
    { version: 1, type: 'join', gameId: '../arena', credential: 'A'.repeat(43) },
    { version: 1, type: 'join', gameId: 'arena-1' },
    { version: 1, type: 'join', gameId: 'arena-1', credential: 'short' },
    { version: 1, type: 'input', sequence: -1, input: {} },
    { version: 1, type: 'input', sequence: 1.5, input: {} },
    { version: 1, type: 'input', sequence: 1, input: { moveX: 1.01 } },
    { version: 1, type: 'input', sequence: 1, input: { useItem: 'bad id' } },
    { version: 1, type: 'leave', reason: 'kick-everyone' },
  ])
    assert.equal(clientMessageSchema.safeParse(message).success, false);
});

test('client gameplay intents accept bounded UI, inventory and terrain actions', () => {
  for (const input of [
    { uiEventId: 'open-crafting' },
    { constructionPaint: 'stone' },
    { inventoryMove: { fromIndex: 0, toIndex: 127 } },
    { inventorySort: true },
    { terrainEdit: { x: 2, y: 3, z: 4, value: { color: 0x55aa44, materialType: 'STANDARD' } } },
  ])
    assert.equal(
      clientMessageSchema.safeParse({ version: 1, type: 'input', sequence: 0, input }).success,
      true,
    );
  for (const input of [
    { inventoryMove: { fromIndex: 128, toIndex: 0 } },
    { terrainEdit: { x: 100_001, y: 0, z: 0, value: null } },
  ])
    assert.equal(
      clientMessageSchema.safeParse({ version: 1, type: 'input', sequence: 0, input }).success,
      false,
    );
});

test('server snapshots and acknowledgements validate authoritative state separately', () => {
  assert.deepEqual(
    parseServerMessage({ version: 1, type: 'joined', gameId: 'arena-1', playerId: 'player-1' }),
    { version: 1, type: 'joined', gameId: 'arena-1', playerId: 'player-1' },
  );
  assert.deepEqual(parseServerMessage({ version: 1, type: 'queued', inputSequence: 9 }), {
    version: 1,
    type: 'queued',
    inputSequence: 9,
  });
  assert.deepEqual(parseServerMessage({ version: 1, type: 'error', code: 'room-full' }), {
    version: 1,
    type: 'error',
    code: 'room-full',
  });
  assert.deepEqual(
    parseServerMessage({
      version: 1,
      type: 'snapshot',
      serverTick: 12,
      players: [
        {
          playerId: 'player-1',
          position: [1, 2, 3],
          rotation: [0, 0.5, 0],
          velocity: [0, 0, -2],
          health: 70,
          maxHealth: 100,
        },
      ],
    }),
    {
      version: 1,
      type: 'snapshot',
      serverTick: 12,
      players: [
        {
          playerId: 'player-1',
          position: [1, 2, 3],
          rotation: [0, 0.5, 0],
          velocity: [0, 0, -2],
          health: 70,
          maxHealth: 100,
        },
      ],
    },
  );
  assert.deepEqual(parseServerMessage({ version: 1, type: 'ack', inputSequence: 9, serverTick: 12 }), {
    version: 1,
    type: 'ack',
    inputSequence: 9,
    serverTick: 12,
  });
  assert.equal(
    serverMessageSchema.safeParse({ version: 1, type: 'input', sequence: 1, input: {} }).success,
    false,
  );
});

test('server snapshots reject impossible health, invalid vectors, excessive actors and extra fields', () => {
  const validPlayer = {
    playerId: 'player-1',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    velocity: [0, 0, 0],
    health: 10,
    maxHealth: 10,
  };
  for (const player of [
    { ...validPlayer, health: 11 },
    { ...validPlayer, position: [Number.POSITIVE_INFINITY, 0, 0] },
    { ...validPlayer, nodeId: 'arbitrary-scene-node' },
  ])
    assert.equal(
      serverMessageSchema.safeParse({ version: 1, type: 'snapshot', serverTick: 0, players: [player] })
        .success,
      false,
    );
  assert.equal(
    serverMessageSchema.safeParse({
      version: 1,
      type: 'snapshot',
      serverTick: 0,
      players: Array.from({ length: 129 }, (_, i) => ({ ...validPlayer, playerId: `p-${i}` })),
    }).success,
    false,
  );
  assert.equal(
    serverMessageSchema.safeParse({
      version: 1,
      type: 'snapshot',
      serverTick: 0,
      players: [validPlayer, validPlayer],
    }).success,
    false,
  );
});
