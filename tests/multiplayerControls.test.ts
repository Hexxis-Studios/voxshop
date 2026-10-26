import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeMultiplayerConnection,
  presentMultiplayerError,
  validateMultiplayerRoomOptions,
} from '../runtime/multiplayerControls';

const credential = 'A'.repeat(43);

test('multiplayer join fields accept secure hosts and explicit local plaintext only', () => {
  assert.deepEqual(
    validateMultiplayerRoomOptions({
      websocketUrl: '  wss://rooms.example.test/multiplayer  ',
      gameId: '  room_1  ',
      credential: ` ${credential} `,
    }),
    {
      websocketUrl: 'wss://rooms.example.test/multiplayer',
      gameId: 'room_1',
      credential,
    },
  );
  assert.equal(
    validateMultiplayerRoomOptions({
      websocketUrl: 'ws://localhost:4317/multiplayer',
      gameId: 'local-room',
      credential,
    }).websocketUrl,
    'ws://localhost:4317/multiplayer',
  );
});

test('multiplayer join validation rejects unsafe endpoints and malformed room secrets', () => {
  const valid = { websocketUrl: 'wss://rooms.example.test/multiplayer', gameId: 'room', credential };
  for (const websocketUrl of [
    'ws://rooms.example.test/multiplayer',
    'https://rooms.example.test/multiplayer',
    'ws://user:password@localhost:4317',
    'wss://rooms.example.test/multiplayer?credential=secret',
  ])
    assert.throws(
      () => validateMultiplayerRoomOptions({ ...valid, websocketUrl }),
      /WebSocket address|secure wss|local ws/,
    );
  assert.throws(() => validateMultiplayerRoomOptions({ ...valid, gameId: '../room' }), /Room ID/);
  assert.throws(() => validateMultiplayerRoomOptions({ ...valid, credential: 'short' }), /Room credential/);
  assert.throws(
    () => validateMultiplayerRoomOptions({ ...valid, websocketUrl: `wss://${'a'.repeat(2048)}` }),
    /2048 characters or fewer/,
  );
});

test('saved tab resume options accept only the bounded rotating token without a room secret', () => {
  const resumeCredential = 'R'.repeat(43);
  assert.deepEqual(
    validateMultiplayerRoomOptions({
      websocketUrl: 'wss://rooms.example.test/multiplayer',
      gameId: 'room',
      resumeCredential,
      resumeAfterReload: true,
    }),
    {
      websocketUrl: 'wss://rooms.example.test/multiplayer',
      gameId: 'room',
      resumeCredential,
      resumeAfterReload: true,
    },
  );
});

test('multiplayer connection status is readable without showing room credentials', () => {
  assert.equal(
    describeMultiplayerConnection({ state: 'connected', playerId: 'player-1', gameId: 'room-1' }),
    'Connected as player-1 · room room-1.',
  );
  assert.equal(describeMultiplayerConnection({ state: 'reconnecting' }), 'Connection lost. Reconnecting…');
  assert.equal(
    describeMultiplayerConnection({ state: 'disconnected', error: 'This room uses a different project.' }),
    'This room uses a different project.',
  );
  assert.equal(
    presentMultiplayerError('Multiplayer join failed: invalid-credential.'),
    'Room or saved resume credential was rejected. Check the room details and try again.',
  );
  assert.equal(
    presentMultiplayerError('This room uses a different project.'),
    'This room uses a different project.',
  );
  assert.doesNotMatch(describeMultiplayerConnection({ state: 'connected', gameId: 'room-1' }), /A{43}/);
});
