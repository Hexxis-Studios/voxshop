import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PENDING_INPUTS_PER_PLAYER,
  MULTIPLAYER_RESUME_GRACE_MS,
  MultiplayerRoom,
} from '../services/multiplayerRoom';
import type { MultiplayerPlayerSnapshot } from '../services/multiplayerProtocol';

const join = (gameId = 'arena') => ({ version: 1, type: 'join', gameId, credential: 'A'.repeat(43) });
const input = (sequence: number, value: Record<string, unknown> = {}) => ({
  version: 1,
  type: 'input',
  sequence,
  input: value,
});
const playerState = (playerId: string, health = 10): MultiplayerPlayerSnapshot => ({
  playerId,
  position: [1, 2, 3],
  rotation: [0, 0, 0],
  velocity: [0, 0, 0],
  health,
  maxHealth: 10,
});

test('room assigns player identity, binds it to the opaque connection and enforces seat capacity', () => {
  const room = new MultiplayerRoom('arena', 1);
  const first = room.receive('transport-A', join());
  assert.deepEqual(first, { ok: true, type: 'joined', playerId: 'player-1' });
  assert.deepEqual(room.receive('transport-B', join()), { ok: false, reason: 'room-full' });
  assert.deepEqual(room.receive('transport-A', join()), { ok: false, reason: 'already-joined' });
  assert.equal(room.playerCount, 1);
  assert.deepEqual(room.receive('transport-B', input(1)), { ok: false, reason: 'not-joined' });
});

test('room rejects client-selected identity, foreign room and authority fields', () => {
  const room = new MultiplayerRoom('arena');
  for (const message of [
    { ...join(), playerId: 'admin' },
    { ...join(), connectionId: 'transport-A' },
    { ...input(1), playerId: 'player-1' },
    { ...input(1), gameId: 'another-room' },
    { version: 1, type: 'leave', playerId: 'player-1' },
    { version: 1, type: 'leave', gameId: 'another-room' },
    input(1, { position: [0, 0, 0] }),
    input(1, { transform: { position: [0, 0, 0] } }),
    input(1, { health: 100 }),
    input(1, { nodeId: 'door-1' }),
  ])
    assert.deepEqual(room.receive('transport-A', message), { ok: false, reason: 'invalid-message' });
  assert.deepEqual(room.receive('transport-A', join('another-room')), { ok: false, reason: 'wrong-room' });
  assert.deepEqual(room.receive('', join()), { ok: false, reason: 'invalid-connection' });
  assert.deepEqual(room.receive('transport-A', join()), {
    ok: true,
    type: 'joined',
    playerId: 'player-1',
  });
});

test('room emits each validated intent once in receive order and rejects repeated sequences', () => {
  const room = new MultiplayerRoom('arena');
  const { playerId } = room.receive('transport-A', join()) as { playerId: string };
  assert.deepEqual(room.receive('transport-A', input(4, { moveX: 0.5 })), {
    ok: true,
    type: 'input',
    playerId,
    sequence: 4,
  });
  assert.deepEqual(room.receive('transport-A', input(3)), { ok: false, reason: 'stale-sequence' });
  assert.deepEqual(room.receive('transport-A', input(4)), { ok: false, reason: 'stale-sequence' });
  room.receive('transport-B', join());
  room.receive('transport-B', input(2, { jump: true }));
  assert.deepEqual(room.takeInputsForTick(), [
    { playerId, sequence: 4, input: { moveX: 0.5 } },
    { playerId: 'player-2', sequence: 2, input: { jump: true } },
  ]);
  assert.deepEqual(room.takeInputsForTick(), []);
  assert.deepEqual(room.createAck('transport-A', 12), {
    version: 1,
    type: 'ack',
    inputSequence: 4,
    serverTick: 12,
  });
  assert.equal(room.createAck('missing-connection', -1), null);
});

test('queue overflow rejects without consuming the sequence and leave drops pending input', () => {
  const room = new MultiplayerRoom('arena');
  room.receive('transport-A', join());
  for (let sequence = 0; sequence < MAX_PENDING_INPUTS_PER_PLAYER; sequence++)
    assert.equal(room.receive('transport-A', input(sequence)).ok, true);
  assert.deepEqual(room.receive('transport-A', input(MAX_PENDING_INPUTS_PER_PLAYER)), {
    ok: false,
    reason: 'input-queue-full',
  });
  assert.deepEqual(
    room.takeInputsForTick(),
    Array.from({ length: MAX_PENDING_INPUTS_PER_PLAYER }, (_, sequence) => ({
      playerId: 'player-1',
      sequence,
      input: {},
    })),
  );
  assert.equal(room.receive('transport-A', input(MAX_PENDING_INPUTS_PER_PLAYER)).ok, true);
  assert.deepEqual(room.receive('transport-A', { version: 1, type: 'leave' }), {
    ok: true,
    type: 'left',
    playerId: 'player-1',
  });
  assert.deepEqual(room.takeInputsForTick(), []);
  assert.equal(room.playerCount, 0);
  assert.deepEqual(room.receive('transport-A', input(100)), { ok: false, reason: 'not-joined' });
});

test('unexpected disconnect preserves player identity and sequence for bounded resume', () => {
  const room = new MultiplayerRoom('arena', 1);
  assert.deepEqual(room.receive('transport-A', join()), {
    ok: true,
    type: 'joined',
    playerId: 'player-1',
  });
  room.receive('transport-A', input(7));
  assert.equal(room.disconnect('transport-A'), true);
  assert.equal(room.playerCount, 0);
  assert.deepEqual(room.takeInputsForTick(), [], 'Uncommitted input is discarded on disconnect.');
  assert.deepEqual(room.receive('transport-B', join()), { ok: false, reason: 'room-full' });

  assert.deepEqual(room.resume('transport-B', 'player-1'), {
    ok: true,
    type: 'joined',
    playerId: 'player-1',
  });
  assert.deepEqual(room.receive('transport-B', input(7)), { ok: false, reason: 'stale-sequence' });
  assert.deepEqual(room.receive('transport-B', input(8)), {
    ok: true,
    type: 'input',
    playerId: 'player-1',
    sequence: 8,
  });
  assert.deepEqual(room.takeInputsForTick(), [{ playerId: 'player-1', sequence: 8, input: {} }]);
  assert.deepEqual(room.createSnapshot(1, [playerState('player-1')]).players, [playerState('player-1')]);

  assert.equal(room.disconnect('transport-B'), true);
  const expired = room.expireDisconnectedSessions(Date.now() + MULTIPLAYER_RESUME_GRACE_MS);
  assert.deepEqual(expired, ['player-1']);
  assert.deepEqual(room.resume('transport-C', 'player-1'), { ok: false, reason: 'not-joined' });
  assert.deepEqual(room.receive('transport-C', join()), {
    ok: true,
    type: 'joined',
    playerId: 'player-2',
  });
});

test('acks require a host-tick handoff and snapshots require valid server-owned room state', () => {
  const room = new MultiplayerRoom('arena');
  assert.deepEqual(room.receive('transport-A', join()), {
    ok: true,
    type: 'joined',
    playerId: 'player-1',
  });
  assert.equal(room.createAck('transport-A', 1), null);
  assert.deepEqual(room.createSnapshot(1, [playerState('player-1')]), {
    version: 1,
    type: 'snapshot',
    serverTick: 1,
    players: [playerState('player-1')],
  });
  assert.throws(() => room.createSnapshot(1, []));
  assert.throws(() => room.createSnapshot(1, [playerState('not-in-room')]));
  assert.throws(() => room.createSnapshot(-1, [playerState('player-1')]));
  assert.throws(() => room.createSnapshot(1, [playerState('player-1', 11)]));
  room.receive('transport-A', input(1));
  room.takeInputsForTick();
  assert.throws(() => room.createAck('transport-A', Number.NaN));
});
