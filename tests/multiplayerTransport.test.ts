import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createApp } from '../server/app';
import { MultiplayerGateway } from '../server/multiplayer';
import type { ServerMessage } from '../services/multiplayerProtocol';
import { MultiplayerClient } from '../runtime/MultiplayerClient';
import { nodeSchema } from '../services/projectDocument';

function open(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForTypes(socket: WebSocket, expectedTypes: string[]) {
  const expected = new Set(expectedTypes);
  const messages: ServerMessage[] = [];
  return new Promise<ServerMessage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for: ${[...expected].join(', ')}`));
    }, 5000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      messages.push(message);
      expected.delete(message.type);
      if (expected.size === 0) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(messages);
      }
    };
    socket.on('message', onMessage);
  });
}

function waitForClientTypes(client: MultiplayerClient, expectedTypes: string[]) {
  const expected = new Set(expectedTypes);
  const messages: ServerMessage[] = [];
  return new Promise<ServerMessage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for: ${[...expected].join(', ')}`));
    }, 5000);
    const unsubscribe = client.onMessage((message) => {
      messages.push(message);
      expected.delete(message.type);
      if (expected.size === 0) {
        clearTimeout(timer);
        unsubscribe();
        resolve(messages);
      }
    });
  });
}

function playerState(playerId: string) {
  return {
    playerId,
    position: [1, 2, 3] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    velocity: [0, 0, 0] as [number, number, number],
    health: 10,
    maxHealth: 10,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for multiplayer room state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test('multiplayer gateway refuses plaintext non-loopback binds', () => {
  assert.throws(() => new MultiplayerGateway({ host: '0.0.0.0' }), /require TLS certificate/);
});

test('multiplayer gateway advertises secure remote transport only with a TLS key pair', () => {
  assert.throws(
    () => new MultiplayerGateway({ host: '0.0.0.0', tlsCertFile: 'server.crt' }),
    /requires both certificate and private-key files/,
  );
  assert.throws(
    () => new MultiplayerGateway({ host: '0.0.0.0', tlsCertFile: 'server.crt', tlsKeyFile: 'server.key' }),
    /require an advertised public host/,
  );
  const gateway = new MultiplayerGateway({
    host: '0.0.0.0',
    publicHost: 'games.example.test',
    port: 4270,
    tlsCertFile: 'server.crt',
    tlsKeyFile: 'server.key',
  });
  assert.equal(gateway.websocketUrl, 'wss://games.example.test:4270/multiplayer');
  const local = new MultiplayerGateway({ host: '127.0.0.1', port: 4270 });
  assert.equal(local.websocketUrl, 'ws://127.0.0.1:4270/multiplayer');
});

test('multiplayer gateway serves a real TLS WebSocket listener', async () => {
  const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const gateway = new MultiplayerGateway({
    host: '127.0.0.1',
    publicHost: 'localhost',
    port: 0,
    tlsCertFile: path.join(fixtureDirectory, 'multiplayer-test-cert.pem'),
    tlsKeyFile: path.join(fixtureDirectory, 'multiplayer-test-key.pem'),
  });
  let socket: WebSocket | undefined;
  try {
    const url = await gateway.listen();
    assert.match(url, /^wss:\/\/localhost:\d+\/multiplayer$/);
    socket = new WebSocket(url, { rejectUnauthorized: false });
    await open(socket);
  } finally {
    if (socket) {
      const closed = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
      socket.close();
      await closed;
    }
    await gateway.close();
  }
});

test('browser-native multiplayer client joins, sends input, receives an authoritative snapshot and leaves', async () => {
  const gateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0 });
  const client = await (async () => {
    const websocketUrl = await gateway.listen();
    const room = gateway.createRoom(1);
    return new MultiplayerClient({ websocketUrl, gameId: room.gameId, credential: room.credential });
  })();
  try {
    const room = gateway.listRooms()[0];
    assert.ok(room);
    const joined = await client.connect();
    assert.equal(client.playerId, joined.playerId);
    assert.match(client.resumeToken ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(joined.nextInputSequence, 0);

    const queued = waitForClientTypes(client, ['queued']);
    assert.equal(client.sendInput({ moveX: 0.5, jump: true }), 0);
    assert.deepEqual(await queued, [{ version: 1, type: 'queued', inputSequence: 0 }]);

    const committed = waitForClientTypes(client, ['ack', 'snapshot']);
    gateway.beginTick(room.gameId, 1);
    gateway.publishSnapshot(room.gameId, 1, [playerState(joined.playerId)]);
    assert.deepEqual(
      (await committed).map((message) => message.type),
      ['ack', 'snapshot'],
    );

    await client.leave();
    assert.equal(gateway.listRooms()[0]?.playerCount, 0);
    assert.equal(client.connectionState, 'disconnected');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(gateway.listRooms()[0]?.playerCount, 0, 'Explicit leave must prevent automatic rejoin.');
  } finally {
    await client.leave();
    await gateway.close();
  }
});

test('multiplayer gateway expires unresponsive sockets while healthy clients remain resumable', async () => {
  const gateway = new MultiplayerGateway({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 25,
  });
  const sockets: WebSocket[] = [];
  try {
    const websocketUrl = await gateway.listen();
    const room = gateway.createRoom(2);
    const unresponsive = new WebSocket(websocketUrl, { autoPong: false });
    const healthy = new WebSocket(websocketUrl);
    sockets.push(unresponsive, healthy);
    await Promise.all([open(unresponsive), open(healthy)]);
    const unresponsiveClosed = new Promise<number>((resolve) =>
      unresponsive.once('close', (code) => resolve(code)),
    );

    const unresponsiveJoinedPromise = waitForTypes(unresponsive, ['joined']);
    const healthyJoinedPromise = waitForTypes(healthy, ['joined']);
    const join = JSON.stringify({
      version: 1,
      type: 'join',
      gameId: room.gameId,
      credential: room.credential,
      reconnect: true,
    });
    unresponsive.send(join);
    healthy.send(join);
    const [unresponsiveJoined, healthyJoined] = await Promise.all([
      unresponsiveJoinedPromise,
      healthyJoinedPromise,
    ]);
    const unresponsivePlayer = unresponsiveJoined[0];
    const healthyPlayer = healthyJoined[0];
    assert.equal(unresponsivePlayer.type, 'joined');
    assert.equal(healthyPlayer.type, 'joined');
    if (unresponsivePlayer.type !== 'joined' || healthyPlayer.type !== 'joined')
      throw new Error('Expected both clients to join.');
    await waitFor(
      () => gateway.listRooms()[0]?.playerCount === 1 && gateway.listRooms()[0]?.reservedPlayerCount === 1,
      2000,
    );
    assert.equal(await unresponsiveClosed, 1006);
    assert.equal(unresponsive.readyState, WebSocket.CLOSED);
    assert.equal(healthy.readyState, WebSocket.OPEN);
    assert.equal(gateway.listRooms()[0]?.playerCount, 1);
    assert.equal(gateway.listRooms()[0]?.reservedPlayerCount, 1);

    const healthyQueued = waitForTypes(healthy, ['queued']);
    healthy.send(JSON.stringify({ version: 1, type: 'input', sequence: 0, input: { jump: true } }));
    assert.deepEqual(await healthyQueued, [{ version: 1, type: 'queued', inputSequence: 0 }]);

    const resumed = new WebSocket(websocketUrl);
    sockets.push(resumed);
    await open(resumed);
    const resumedJoinedPromise = waitForTypes(resumed, ['joined']);
    assert.ok(unresponsivePlayer.resumeCredential);
    resumed.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        resumeCredential: unresponsivePlayer.resumeCredential,
        reconnect: true,
      }),
    );
    const resumedJoined = (await resumedJoinedPromise)[0];
    assert.equal(resumedJoined.type, 'joined');
    if (resumedJoined.type !== 'joined') throw new Error('Expected the timed-out client to resume.');
    assert.equal(resumedJoined.playerId, unresponsivePlayer.playerId);
    assert.notEqual(resumedJoined.resumeCredential, unresponsivePlayer.resumeCredential);
    assert.equal(gateway.listRooms()[0]?.playerCount, 2);
    assert.equal(gateway.listRooms()[0]?.reservedPlayerCount, 0);
    assert.equal(healthy.readyState, WebSocket.OPEN);
    assert.equal(healthyPlayer.type, 'joined');
  } finally {
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.terminate();
    await gateway.close();
  }
});

test('browser-native multiplayer client resumes after the host restarts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-client-resume-'));
  const port = await reservePort();
  const stateFile = path.join(dataDir, 'multiplayer-rooms.json');
  const firstGateway = new MultiplayerGateway({ host: '127.0.0.1', port, stateFile });
  const secondGateway = new MultiplayerGateway({ host: '127.0.0.1', port, stateFile });
  let client: MultiplayerClient | undefined;
  try {
    const websocketUrl = await firstGateway.listen();
    const room = firstGateway.createRoom(1);
    client = new MultiplayerClient({ websocketUrl, gameId: room.gameId, credential: room.credential });
    const firstJoin = await client.connect();
    const firstResumeToken = client.resumeToken;
    assert.ok(firstResumeToken);

    const queued = waitForClientTypes(client, ['queued']);
    assert.equal(client.sendInput({ moveZ: -1 }), 0);
    await queued;
    const committed = waitForClientTypes(client, ['ack', 'snapshot']);
    firstGateway.beginTick(room.gameId, 1);
    firstGateway.publishSnapshot(room.gameId, 1, [playerState(firstJoin.playerId)]);
    await committed;

    await firstGateway.close();
    await waitFor(() => client?.playerId === undefined);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(client.connectionState, 'reconnecting');
    await secondGateway.listen();
    const resumedRoom = secondGateway.listRooms()[0];
    assert.equal(resumedRoom?.gameId, room.gameId);
    await waitFor(() => client?.playerId === firstJoin.playerId, 2000);
    assert.equal(client.connectionState, 'connected');
    assert.notEqual(client.resumeToken, firstResumeToken);
    const queuedAfterResume = waitForClientTypes(client, ['queued']);
    assert.equal(client.sendInput({ moveZ: 1 }), 1);
    assert.deepEqual(await queuedAfterResume, [{ version: 1, type: 'queued', inputSequence: 1 }]);
  } finally {
    await client?.leave();
    await firstGateway.close();
    await secondGateway.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('multiplayer gateway resumes the same player, rotates its credential and sends the latest snapshot', async () => {
  const gateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  try {
    const websocketUrl = await gateway.listen();
    const room = gateway.createRoom(1);
    const first = new WebSocket(websocketUrl);
    sockets.push(first);
    await open(first);
    const firstJoinedPromise = waitForTypes(first, ['joined']);
    first.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        reconnect: true,
      }),
    );
    const firstJoined = (await firstJoinedPromise)[0];
    assert.equal(firstJoined.type, 'joined');
    if (firstJoined.type !== 'joined') throw new Error('Expected joined response.');
    assert.match(firstJoined.resumeCredential ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(firstJoined.nextInputSequence, 0);

    const queuedPromise = waitForTypes(first, ['queued']);
    first.send(JSON.stringify({ version: 1, type: 'input', sequence: 7, input: { moveX: 0.5 } }));
    assert.deepEqual(await queuedPromise, [{ version: 1, type: 'queued', inputSequence: 7 }]);
    const committedMessagesPromise = waitForTypes(first, ['ack', 'snapshot']);
    gateway.beginTick(room.gameId, 1);
    gateway.publishSnapshot(room.gameId, 1, [playerState(firstJoined.playerId)]);
    assert.deepEqual(
      (await committedMessagesPromise).map((message) => message.type),
      ['ack', 'snapshot'],
    );

    const disconnected = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.close();
    await disconnected;
    await waitFor(() => gateway.listRooms()[0]?.playerCount === 0);
    assert.equal(gateway.listRooms()[0]?.playerCount, 0);
    assert.equal(gateway.listRooms()[0]?.reservedPlayerCount, 1);

    const resumed = new WebSocket(websocketUrl);
    sockets.push(resumed);
    await open(resumed);
    const resumedMessagesPromise = waitForTypes(resumed, ['joined', 'snapshot']);
    resumed.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        resumeCredential: firstJoined.resumeCredential,
        reconnect: true,
      }),
    );
    const resumedMessages = await resumedMessagesPromise;
    const resumedJoin = resumedMessages.find((message) => message.type === 'joined');
    const resumedSnapshot = resumedMessages.find((message) => message.type === 'snapshot');
    assert.equal(resumedJoin?.type, 'joined');
    assert.equal(resumedSnapshot?.type, 'snapshot');
    if (resumedJoin?.type !== 'joined' || resumedSnapshot?.type !== 'snapshot')
      throw new Error('Expected resumed join and snapshot messages.');
    assert.equal(resumedJoin.playerId, firstJoined.playerId);
    assert.notEqual(resumedJoin.resumeCredential, firstJoined.resumeCredential);
    assert.equal(resumedJoin.nextInputSequence, 8);
    assert.equal(gateway.listRooms()[0]?.playerCount, 1);
    assert.equal(gateway.listRooms()[0]?.reservedPlayerCount, 0);
    assert.deepEqual(resumedSnapshot.players, [playerState(firstJoined.playerId)]);

    const replay = new WebSocket(websocketUrl);
    sockets.push(replay);
    await open(replay);
    const replayError = waitForTypes(replay, ['error']);
    const replayClose = new Promise<void>((resolve) => replay.once('close', () => resolve()));
    replay.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        resumeCredential: firstJoined.resumeCredential,
      }),
    );
    assert.deepEqual(await replayError, [{ version: 1, type: 'error', code: 'invalid-credential' }]);
    await replayClose;
  } finally {
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.terminate();
    await gateway.close();
  }
});

test('multiplayer rooms restore hashed credentials, player sequence and latest snapshot after restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-restart-'));
  const stateFile = path.join(dataDir, 'multiplayer-rooms.json');
  const firstGateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0, stateFile });
  const secondGateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0, stateFile });
  const sockets: WebSocket[] = [];
  const projectBinding = { projectId: 'sample-game', revision: 7, sceneId: 'snowfield' };
  try {
    const firstUrl = await firstGateway.listen();
    const room = firstGateway.createRoom(2, projectBinding);
    const first = new WebSocket(firstUrl);
    sockets.push(first);
    await open(first);
    const joinedPromise = waitForTypes(first, ['joined']);
    first.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        reconnect: true,
      }),
    );
    const joined = (await joinedPromise)[0];
    assert.equal(joined.type, 'joined');
    if (joined.type !== 'joined') throw new Error('Expected joined response.');
    const oldResumeCredential = joined.resumeCredential;
    assert.ok(oldResumeCredential);

    const queuedPromise = waitForTypes(first, ['queued']);
    first.send(JSON.stringify({ version: 1, type: 'input', sequence: 12, input: { jump: true } }));
    await queuedPromise;
    const publishedPromise = waitForTypes(first, ['ack', 'snapshot']);
    firstGateway.beginTick(room.gameId, 4);
    firstGateway.publishSnapshot(room.gameId, 4, [playerState(joined.playerId)]);
    await publishedPromise;

    await firstGateway.close();
    const stored = await readFile(stateFile, 'utf8');
    assert.equal(stored.includes(room.credential), false);
    assert.equal(stored.includes(oldResumeCredential), false);
    assert.ok(stored.includes(createHash('sha256').update(room.credential).digest('hex')));

    const secondUrl = await secondGateway.listen();
    assert.deepEqual(secondGateway.listRooms(), [
      {
        gameId: room.gameId,
        projectBinding,
        maxPlayers: 2,
        playerCount: 0,
        reservedPlayerCount: 1,
      },
    ]);
    const resumed = new WebSocket(secondUrl);
    sockets.push(resumed);
    await open(resumed);
    const resumedMessagesPromise = waitForTypes(resumed, ['joined', 'snapshot']);
    resumed.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        resumeCredential: oldResumeCredential,
      }),
    );
    const resumedMessages = await resumedMessagesPromise;
    const resumedJoin = resumedMessages.find((message) => message.type === 'joined');
    const snapshot = resumedMessages.find((message) => message.type === 'snapshot');
    assert.equal(resumedJoin?.type, 'joined');
    assert.equal(snapshot?.type, 'snapshot');
    if (resumedJoin?.type !== 'joined' || snapshot?.type !== 'snapshot')
      throw new Error('Expected joined response and restored snapshot.');
    assert.equal(resumedJoin.playerId, joined.playerId);
    assert.equal(resumedJoin.nextInputSequence, 13);
    assert.notEqual(resumedJoin.resumeCredential, oldResumeCredential);
    assert.equal(snapshot.serverTick, 4);
    assert.deepEqual(snapshot.players, [playerState(joined.playerId)]);
  } finally {
    await firstGateway.close();
    await secondGateway.close();
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.terminate();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('multiplayer startup rejects corrupt persisted state without replacing it', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-corrupt-'));
  const stateFile = path.join(dataDir, 'multiplayer-rooms.json');
  const contents = '{"version":99,"rooms":[]}';
  await writeFile(stateFile, contents, { mode: 0o600 });
  const gateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0, stateFile });
  try {
    await assert.rejects(gateway.listen(), /unreadable/);
    assert.equal(await readFile(stateFile, 'utf8'), contents);
  } finally {
    await gateway.close();
    assert.equal(await readFile(stateFile, 'utf8'), contents);
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('authenticated local host creates credentialed rooms and commits authoritative multiplayer ticks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-'));
  const service = await createApp({
    root: process.cwd(),
    dataDir,
    token: 'a'.repeat(64),
    multiplayerHost: '127.0.0.1',
    multiplayerPort: 0,
  });
  const sockets: WebSocket[] = [];
  const http = createServer(service.app);
  let baseUrl = '';
  try {
    const websocketUrl = await service.multiplayer.listen();
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      capabilities: string[];
      multiplayer: { websocketUrl: string };
    };
    assert.equal(sessionResponse.status, 200);
    assert.ok(session.capabilities.includes('multiplayer'));
    assert.equal(session.multiplayer.websocketUrl, websocketUrl);

    const unauthorized = await fetch(`${baseUrl}/api/multiplayer/rooms`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    let project = await service.store.create('Multiplayer binding test', 'multiplayer-binding');
    const player = nodeSchema.parse({
      id: 'player',
      name: 'Player',
      transform: {},
      components: [
        { type: 'player', style: 'top-down', speed: 3 },
        { type: 'health', maximum: 100 },
      ],
    });
    project = (
      await service.store.commit(project.id, {
        expectedRevision: project.revision,
        requestId: 'add-multiplayer-player',
        operations: [{ type: 'scene.put', scene: { ...project.scenes[0], nodes: [player] } }],
      })
    ).project;
    const projectBinding = {
      projectId: project.id,
      revision: project.revision,
      sceneId: project.activeSceneId,
    };
    const staleBinding = await fetch(`${baseUrl}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VoxShop-Token': 'a'.repeat(64) },
      body: JSON.stringify({
        maxPlayers: 1,
        projectBinding: { ...projectBinding, revision: project.revision + 1 },
      }),
    });
    assert.equal(staleBinding.status, 409);
    const createdResponse = await fetch(`${baseUrl}/api/multiplayer/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VoxShop-Token': 'a'.repeat(64) },
      body: JSON.stringify({ maxPlayers: 1, projectBinding }),
    });
    assert.equal(createdResponse.status, 201);
    const room = (await createdResponse.json()) as {
      gameId: string;
      credential: string;
      maxPlayers: number;
      websocketUrl: string;
      projectBinding: typeof projectBinding;
    };
    assert.equal(room.credential.length, 43);
    assert.equal(room.websocketUrl, websocketUrl);
    assert.deepEqual(room.projectBinding, projectBinding);
    assert.equal(new URL(room.websocketUrl).search, '');

    const badSocket = new WebSocket(websocketUrl);
    sockets.push(badSocket);
    await open(badSocket);
    const badResponse = waitForTypes(badSocket, ['error']);
    const badClose = new Promise<void>((resolve) => badSocket.once('close', () => resolve()));
    badSocket.send(
      JSON.stringify({ version: 1, type: 'join', gameId: room.gameId, credential: 'B'.repeat(43) }),
    );
    assert.deepEqual(await badResponse, [{ version: 1, type: 'error', code: 'invalid-credential' }]);
    await badClose;

    const listedAfterBadCredential = await fetch(`${baseUrl}/api/multiplayer/rooms`, {
      headers: { 'X-VoxShop-Token': 'a'.repeat(64) },
    });
    assert.deepEqual(await listedAfterBadCredential.json(), {
      rooms: [
        {
          gameId: room.gameId,
          projectBinding,
          maxPlayers: 1,
          playerCount: 0,
          reservedPlayerCount: 0,
        },
      ],
    });

    const socket = new WebSocket(websocketUrl);
    sockets.push(socket);
    await open(socket);
    const joinedResponse = waitForTypes(socket, ['joined']);
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
      }),
    );
    const joined = (await joinedResponse)[0];
    assert.equal(joined.type, 'joined');
    if (joined.type !== 'joined') throw new Error('Expected joined response.');
    assert.equal(joined.resumeCredential, undefined);
    assert.equal(joined.nextInputSequence, undefined);

    const queuedResponse = waitForTypes(socket, ['queued']);
    const publishedMessages = waitForTypes(socket, ['ack', 'snapshot']);
    socket.send(JSON.stringify({ version: 1, type: 'input', sequence: 7, input: { moveX: 0.5 } }));
    assert.deepEqual(
      (await queuedResponse).filter((message) => message.type === 'queued'),
      [{ version: 1, type: 'queued', inputSequence: 7 }],
    );

    const token = { 'X-VoxShop-Token': 'a'.repeat(64), 'Content-Type': 'application/json' };
    const began = await fetch(`${baseUrl}/api/multiplayer/rooms/${room.gameId}/tick/start`, {
      method: 'POST',
      headers: token,
      body: JSON.stringify({ serverTick: 1 }),
    });
    assert.equal(began.status, 409);
    assert.match(((await began.json()) as { error: string }).error, /authoritative simulation/);
    const overlappingTick = await fetch(`${baseUrl}/api/multiplayer/rooms/${room.gameId}/tick/start`, {
      method: 'POST',
      headers: token,
      body: JSON.stringify({ serverTick: 2 }),
    });
    assert.equal(overlappingTick.status, 409);

    const committed = await fetch(`${baseUrl}/api/multiplayer/rooms/${room.gameId}/tick/commit`, {
      method: 'POST',
      headers: token,
      body: JSON.stringify({
        serverTick: 1,
        players: [
          {
            playerId: joined.playerId,
            position: [1, 2, 3],
            rotation: [0, 0, 0],
            velocity: [0.5, 0, 0],
            health: 10,
            maxHealth: 10,
          },
        ],
      }),
    });
    assert.equal(committed.status, 409);
    const messages = await publishedMessages;
    const ack = messages.find((message) => message.type === 'ack');
    assert.ok(ack && ack.type === 'ack');
    assert.equal(ack.inputSequence, 7);
    const snapshot = messages.find(
      (message) => message.type === 'snapshot' && message.serverTick >= ack.serverTick,
    );
    assert.ok(snapshot && snapshot.type === 'snapshot' && snapshot.game);
    assert.equal(snapshot.game.projectId, projectBinding.projectId);
    assert.equal(snapshot.game.revision, projectBinding.revision);
    assert.equal(snapshot.game.sceneId, projectBinding.sceneId);
    assert.equal(
      snapshot.game.players.find((player) => player.playerId === joined.playerId)?.nodeId,
      'mp-player-1',
    );

    const disconnected = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close();
    await disconnected;
    await waitFor(() => service.multiplayer.listRooms()[0]?.playerCount === 0);
    assert.equal(service.multiplayer.listRooms()[0]?.playerCount, 0);

    const removed = await fetch(`${baseUrl}/api/multiplayer/rooms/${room.gameId}`, {
      method: 'DELETE',
      headers: { 'X-VoxShop-Token': 'a'.repeat(64) },
    });
    assert.deepEqual(await removed.json(), { ok: true });
    assert.deepEqual(service.multiplayer.listRooms(), []);
  } finally {
    await service.multiplayer.close();
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.terminate();
    if (http.listening) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())));
    await rm(dataDir, { recursive: true, force: true });
  }
});
