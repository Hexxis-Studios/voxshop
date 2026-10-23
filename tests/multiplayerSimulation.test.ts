import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MultiplayerGateway } from '../server/multiplayer';
import { newProject, nodeSchema, validateProject, type ProjectDocument } from '../services/projectDocument';
import type { ServerMessage } from '../services/multiplayerProtocol';

type Client = { socket: WebSocket; messages: ServerMessage[] };

async function openClient(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const messages: ServerMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  return { socket, messages };
}

async function waitForMessage<T extends ServerMessage>(
  client: Client,
  after: number,
  predicate: (message: ServerMessage) => message is T,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = client.messages.slice(after).find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for multiplayer message after index ${after}.`);
}

const isJoined = (message: ServerMessage): message is Extract<ServerMessage, { type: 'joined' }> =>
  message.type === 'joined';
const isSnapshot = (message: ServerMessage): message is Extract<ServerMessage, { type: 'snapshot' }> =>
  message.type === 'snapshot';
const isAck = (message: ServerMessage): message is Extract<ServerMessage, { type: 'ack' }> =>
  message.type === 'ack';
const isError = (message: ServerMessage): message is Extract<ServerMessage, { type: 'error' }> =>
  message.type === 'error';
function lastMessage<T extends ServerMessage>(client: Client, predicate: (message: ServerMessage) => message is T) {
  for (let index = client.messages.length - 1; index >= 0; index--)
    if (predicate(client.messages[index])) return client.messages[index] as T;
  return undefined;
}

function multiplayerProject(): ProjectDocument {
  const project = newProject('multiplayer-test', 'Multiplayer simulation test'),
    transform = (position: [number, number, number]) => ({
      position,
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    });
  project.scenes[0].variables = { coins: 0, touches: 0 };
  project.scenes[0].items = [
    { id: 'gem', name: 'Gem', description: 'Shared pickup', maxStack: 10 },
    { id: 'stone', name: 'Stone', description: 'Starting material', maxStack: 10 },
  ];
  project.scenes[0].objectives = [
    { id: 'gem-objective', text: 'Collect a gem', condition: { variable: 'coins', op: '>=', value: 1 } },
  ];
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'player',
      name: 'Player',
      transform: transform([0, 0, 0]),
      components: [
        { type: 'player', style: 'top-down', speed: 3, gravity: 0 },
        { type: 'collider', size: [0.6, 1, 0.6], solid: true },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              once: true,
              actions: [{ type: 'inventory', add: [{ itemId: 'stone', quantity: 1 }, { itemId: 'gem', quantity: 2 }] }],
            },
          ],
        },
      ],
    }),
    nodeSchema.parse({
      id: 'gem-pickup',
      name: 'Gem pickup',
      transform: transform([-2, 0, 0]),
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], solid: false, sensor: true },
        { type: 'collectible', itemId: 'gem', quantity: 1 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'touch',
              once: true,
              actions: [
                { type: 'add', variable: 'touches', value: 1 },
                { type: 'message', text: 'Shared pickup rule fired.' },
              ],
            },
          ],
        },
      ],
    }),
    nodeSchema.parse({
      id: 'coin-pickup',
      name: 'Coin pickup',
      transform: transform([-3, 0, 0]),
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], solid: false, sensor: true },
        { type: 'collectible', variable: 'coins', amount: 1 },
      ],
    }),
  ];
  return validateProject(project);
}

async function waitFor<T>(predicate: () => T | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for authoritative multiplayer state.');
}

test('real gateway shares one authoritative world, orders inputs, rejects authority claims and resumes saved actors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-simulation-')),
    stateFile = path.join(directory, 'rooms.json'),
    port = 0,
    project = multiplayerProject(),
    binding = { projectId: project.id, revision: project.revision, sceneId: project.scenes[0].id },
    gateway = new MultiplayerGateway({ host: '127.0.0.1', port, stateFile });
  let first: Client | undefined,
    second: Client | undefined,
    restartedClient: Client | undefined,
    restartedGateway: MultiplayerGateway | undefined;
  try {
    await gateway.listen();
    const room = await gateway.createRoomWithProject(2, binding, project);
    first = await openClient(room.websocketUrl);
    second = await openClient(room.websocketUrl);
    const firstJoinAt = first.messages.length,
      secondJoinAt = second.messages.length;
    first.socket.send(JSON.stringify({ version: 1, type: 'join', gameId: room.gameId, credential: room.credential, reconnect: true }));
    second.socket.send(JSON.stringify({ version: 1, type: 'join', gameId: room.gameId, credential: room.credential, reconnect: true }));
    const [firstJoined, secondJoined] = await Promise.all([
      waitForMessage(first, firstJoinAt, isJoined),
      waitForMessage(second, secondJoinAt, isJoined),
    ]);
    assert.ok(firstJoined.resumeCredential);
    assert.ok(secondJoined.resumeCredential);
    assert.notEqual(firstJoined.playerId, secondJoined.playerId);

    const firstInitial = await waitForMessage(first, firstJoinAt, isSnapshot, 5000);
    const secondInitial = await waitForMessage(second, secondJoinAt, isSnapshot, 5000);
    const twoPlayerState = (snapshot: Extract<ServerMessage, { type: 'snapshot' }>) =>
      snapshot.game?.players.length === 2 && snapshot.game.players.every((player) => player.connected);
    const sharedInitial = await waitFor(() => {
      const left = lastMessage(first!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) && twoPlayerState(message),
      );
      const right = lastMessage(second!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) && twoPlayerState(message),
      );
      return left && right ? [left, right] as const : false;
    });
    assert.ok(firstInitial.game);
    assert.ok(secondInitial.game);
    const [leftInitial, rightInitial] = sharedInitial;
    assert.deepEqual(leftInitial.game, rightInitial.game);
    const actorId = leftInitial.game!.players.find((player) => player.playerId === firstJoined.playerId)!.nodeId,
      initialX = leftInitial.game!.nodes.find((node) => node.nodeId === actorId)!.transform.position[0];

    let sequence = firstJoined.nextInputSequence ?? 0;
    const inventoryAt = first.messages.length;
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { inventoryMove: { fromIndex: 0, toIndex: 1 } } }));
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { inventoryMove: { fromIndex: 1, toIndex: 0 } } }));
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { inventorySort: true } }));
    const inventoryAck = await waitForMessage(first, inventoryAt, (message): message is Extract<ServerMessage, { type: 'ack' }> =>
      isAck(message) && message.inputSequence >= sequence - 1,
    );
    const sortedSnapshot = await waitForMessage(first, inventoryAt, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && message.serverTick >= inventoryAck.serverTick &&
      message.game?.players.find((player) => player.playerId === firstJoined.playerId)?.inventory[0]?.itemId === 'gem',
    );
    assert.deepEqual(
      sortedSnapshot.game!.players.find((player) => player.playerId === firstJoined.playerId)?.inventory,
      [{ itemId: 'gem', quantity: 4 }, { itemId: 'stone', quantity: 2 }],
    );
    assert.deepEqual(
      sortedSnapshot.game!.players.find((player) => player.playerId === secondJoined.playerId)?.inventory,
      [{ itemId: 'stone', quantity: 2 }, { itemId: 'gem', quantity: 4 }],
      'inventory actions apply only to the originating player',
    );
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { moveX: -1 } }));
    const movingAt = first.messages.length;
    const movedLeft = await waitForMessage(first, movingAt, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && (message.game?.nodes.find((node) => node.nodeId === actorId)?.transform.position[0] ?? initialX) < initialX - 0.15,
    );
    assert.ok(movedLeft.game);
    const beforeOrderedInputs = movedLeft.game.nodes.find((node) => node.nodeId === actorId)!.transform.position[0];
    const orderedAt = first.messages.length;
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { moveX: 1 } }));
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { moveX: -1 } }));
    const finalSequence = sequence - 1;
    await waitForMessage(first, orderedAt, (message): message is Extract<ServerMessage, { type: 'ack' }> =>
      isAck(message) && message.inputSequence >= finalSequence,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const orderedSnapshot = lastMessage(first, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && message.serverTick > movedLeft.serverTick,
    );
    assert.ok(orderedSnapshot?.game);
    assert.ok(
      orderedSnapshot.game.nodes.find((node) => node.nodeId === actorId)!.transform.position[0] < beforeOrderedInputs - 0.15,
      'the last accepted full input state must control subsequent authoritative steps',
    );

    const pickupState = await waitFor(() => {
      const a = lastMessage(first!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) &&
        message.game?.nodes.find((node) => node.nodeId === 'gem-pickup')?.enabled === false &&
        message.game?.nodes.find((node) => node.nodeId === 'coin-pickup')?.enabled === false,
      );
      const b = lastMessage(second!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) &&
        message.game?.nodes.find((node) => node.nodeId === 'gem-pickup')?.enabled === false &&
        message.game?.nodes.find((node) => node.nodeId === 'coin-pickup')?.enabled === false,
      );
      return a && b && a.game && b.game ? [a, b] as const : false;
    });
    const [pickupLeft, pickupRight] = pickupState;
    assert.deepEqual(pickupLeft.game, pickupRight.game, 'both clients receive identical authoritative scene state');
    assert.equal(pickupLeft.game!.variables.coins, 1);
    assert.equal(pickupLeft.game!.variables.touches, 1);
    assert.equal(pickupLeft.game!.message, 'Shared pickup rule fired.');
    assert.equal(pickupLeft.game!.objectives.find((objective) => objective.id === 'gem-objective')?.completed, true);
    assert.deepEqual(
      pickupLeft.game!.players.find((player) => player.playerId === firstJoined.playerId)?.inventory,
      [{ itemId: 'gem', quantity: 5 }, { itemId: 'stone', quantity: 2 }],
    );
    assert.deepEqual(
      pickupLeft.game!.players.find((player) => player.playerId === secondJoined.playerId)?.inventory,
      [{ itemId: 'stone', quantity: 2 }, { itemId: 'gem', quantity: 4 }],
    );

    const secondNodeId = pickupLeft.game!.players.find((player) => player.playerId === secondJoined.playerId)!.nodeId,
      secondPosition = pickupLeft.game!.nodes.find((node) => node.nodeId === secondNodeId)!.transform.position;
    second.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: 0, input: { transform: { position: [99, 99, 99] } } }));
    const rejectedAt = second.messages.length;
    const rejected = await waitForMessage(second, rejectedAt, isError);
    assert.equal(rejected.code, 'invalid-message');
    await waitFor(() => {
      const snapshot = lastMessage(first!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) && message.game?.players.find((player) => player.playerId === secondJoined.playerId)?.connected === false,
      );
      if (!snapshot?.game) return false;
      assert.deepEqual(snapshot.game.nodes.find((node) => node.nodeId === secondNodeId)?.transform.position, secondPosition);
      return snapshot;
    });
    const stopAt = first.messages.length;
    first.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: sequence++, input: { moveX: 0 } }));
    const stoppedAck = await waitForMessage(first, stopAt, (message): message is Extract<ServerMessage, { type: 'ack' }> =>
      isAck(message) && message.inputSequence >= sequence - 1,
    );
    const stoppedSnapshot = await waitForMessage(first, stopAt, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && message.serverTick >= stoppedAck.serverTick,
    );
    const savedPlayerX = stoppedSnapshot.game!.nodes.find((node) => node.nodeId === actorId)!.transform.position[0];

    await gateway.close();
    restartedGateway = new MultiplayerGateway({ host: '127.0.0.1', port, stateFile });
    const restartUrl = await restartedGateway.listen();
    restartedClient = await openClient(restartUrl);
    const reconnectAt = restartedClient.messages.length;
    restartedClient.socket.send(
      JSON.stringify({
        version: 1,
        type: 'join',
        gameId: room.gameId,
        credential: room.credential,
        resumeCredential: firstJoined.resumeCredential,
      }),
    );
    const resumed = await waitForMessage(restartedClient, reconnectAt, isJoined);
    assert.equal(resumed.playerId, firstJoined.playerId);
    const restored = await waitForMessage(
      restartedClient,
      reconnectAt,
      (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) && !!message.game?.players.find((player) => player.playerId === firstJoined.playerId)?.connected,
    );
    assert.ok(restored.game);
    assert.equal(restored.game.players.filter((player) => player.playerId === firstJoined.playerId).length, 1);
    assert.equal(restored.game.nodes.filter((node) => node.playerId === firstJoined.playerId).length, 1);
    assert.equal(restored.game.nodes.find((node) => node.nodeId === actorId)?.transform.position[0], savedPlayerX);
    assert.equal(restored.game.variables.coins, 1);
    assert.equal(restored.game.variables.touches, 1);
    assert.equal(restored.game.nodes.find((node) => node.nodeId === 'gem-pickup')?.enabled, false);
    assert.equal(restored.game.nodes.find((node) => node.nodeId === 'coin-pickup')?.enabled, false);
  } finally {
    for (const client of [first, second, restartedClient]) {
      if (client?.socket.readyState === WebSocket.OPEN) client.socket.close();
    }
    await gateway.close().catch(() => {});
    await restartedGateway?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

function multiplayerCampaignProject(): ProjectDocument {
  const project = newProject('multiplayer-campaign', 'Multiplayer campaign test'),
    entry = project.scenes[0],
    nextSceneId = 'campaign-next',
    transform = (position: [number, number, number]) => ({
      position,
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    });
  entry.items = [
    { id: 'alpha', name: 'Alpha', description: 'First carried item', maxStack: 10 },
    { id: 'beta', name: 'Beta', description: 'Second carried item', maxStack: 10 },
  ];
  entry.nodes = [
    nodeSchema.parse({
      id: 'campaign-player',
      name: 'Player',
      transform: transform([0, 0, 0]),
      components: [
        { type: 'player', style: 'top-down', speed: 3, gravity: 0 },
        { type: 'collider', size: [0.6, 1, 0.6], solid: true },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [{
            event: 'start',
            once: true,
            actions: [{ type: 'inventory', add: [
              { itemId: 'beta', quantity: 1 },
              { itemId: 'alpha', quantity: 1 },
            ] }],
          }],
        },
      ],
    }),
    nodeSchema.parse({
      id: 'campaign-exit',
      name: 'Exit',
      transform: transform([0, 0, 0]),
      components: [
        { type: 'collider', size: [1, 1, 1], solid: false, sensor: true },
        { type: 'interactable', prompt: 'Continue', range: 3 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [{
            event: 'interact',
            once: true,
            actions: [
              { type: 'add', variable: 'crossings', value: 1, scope: 'campaign' },
              { type: 'transition', sceneId: nextSceneId },
            ],
          }, {
            event: 'tick',
            interval: 0.1,
            actions: [{ type: 'add', variable: 'timerTicks', value: 1 }],
          }],
        },
      ],
    }),
    nodeSchema.parse({
      id: 'campaign-enemy',
      name: 'Enemy',
      transform: transform([0, 0, 0]),
      components: [{ type: 'enemy', speed: 0.1, damage: 100, range: 0.5 }, { type: 'health', maximum: 100 }],
    }),
  ];
  const destination = structuredClone(entry);
  destination.id = nextSceneId;
  destination.name = 'Destination';
  destination.variables = {};
  destination.nodes = [
    nodeSchema.parse({
      id: 'destination-player',
      name: 'Player',
      transform: transform([8, 0, 0]),
      components: [
        { type: 'player', style: 'top-down', speed: 3, gravity: 0 },
        { type: 'collider', size: [0.6, 1, 0.6], solid: true },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
      ],
    }),
    nodeSchema.parse({
      id: 'destination-start',
      name: 'Destination start marker',
      transform: transform([20, 0, 0]),
      components: [{
        type: 'rules',
        apiVersion: 1,
        rules: [{
          event: 'start',
          once: true,
          actions: [{ type: 'add', variable: 'destinationStarts', value: 1, scope: 'campaign' }],
        }],
      }],
    }),
  ];
  project.scenes.push(destination);
  return validateProject(project);
}

test('real gateway transitions both clients, preserves campaign actors and restores the active scene after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'voxshop-multiplayer-campaign-')),
    stateFile = path.join(directory, 'rooms.json'),
    project = multiplayerCampaignProject(),
    binding = { projectId: project.id, revision: project.revision, sceneId: project.scenes[0].id },
    nextSceneId = project.scenes[1].id,
    gateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0, stateFile });
  let first: Client | undefined,
    second: Client | undefined,
    resumedFirst: Client | undefined,
    resumedSecond: Client | undefined,
    restartedGateway: MultiplayerGateway | undefined;
  try {
    await gateway.listen();
    const room = await gateway.createRoomWithProject(2, binding, project);
    first = await openClient(room.websocketUrl);
    second = await openClient(room.websocketUrl);
    first.socket.send(JSON.stringify({ version: 1, type: 'join', gameId: room.gameId, credential: room.credential, reconnect: true }));
    second.socket.send(JSON.stringify({ version: 1, type: 'join', gameId: room.gameId, credential: room.credential, reconnect: true }));
    const [firstJoined, secondJoined] = await Promise.all([
      waitForMessage(first, 0, isJoined),
      waitForMessage(second, 0, isJoined),
    ]);
    assert.ok(firstJoined.resumeCredential);
    assert.ok(secondJoined.resumeCredential);
    const bothReady = await waitFor(() => {
      const snapshot = lastMessage(first!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) && message.game?.players.length === 2 && message.game.players.every((player) => player.connected),
      );
      return snapshot?.game ? snapshot : false;
    });
    assert.equal(bothReady.game?.entrySceneId, binding.sceneId);
    assert.equal(bothReady.game?.sceneId, binding.sceneId);
    const playerState = (snapshot: Extract<ServerMessage, { type: 'snapshot' }>, playerId: string) =>
        snapshot.game!.players.find((player) => player.playerId === playerId)!,
      firstInitial = playerState(bothReady, firstJoined.playerId),
      secondInitial = playerState(bothReady, secondJoined.playerId);
    assert.deepEqual(firstInitial.inventory.map((stack) => stack.itemId), ['beta', 'alpha']);
    assert.deepEqual(secondInitial.inventory.map((stack) => stack.itemId), ['beta', 'alpha']);

    let secondSequence = secondJoined.nextInputSequence ?? 0;
    const moveAt = second.messages.length;
    second.socket.send(JSON.stringify({
      version: 1,
      type: 'input',
      sequence: secondSequence++,
      input: { inventoryMove: { fromIndex: 0, toIndex: 1 } },
    }));
    const moveAck = await waitForMessage(second, moveAt, (message): message is Extract<ServerMessage, { type: 'ack' }> => isAck(message));
    const orderedInventory = await waitForMessage(second, moveAt, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && message.serverTick >= moveAck.serverTick &&
      message.game?.players.find((player) => player.playerId === secondJoined.playerId)?.inventory[0]?.itemId === 'alpha',
    );
    assert.deepEqual(playerState(orderedInventory, firstJoined.playerId).inventory.map((stack) => stack.itemId), ['beta', 'alpha']);
    assert.deepEqual(playerState(orderedInventory, secondJoined.playerId).inventory.map((stack) => stack.itemId), ['alpha', 'beta']);

    const damagedSnapshot = await waitFor(() => {
      const snapshot = lastMessage(first!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) &&
        (message.game?.players.find((player) => player.playerId === firstJoined.playerId)?.health ?? 100) < 100,
      );
      return snapshot?.game ? snapshot : false;
    });
    const firstHealth = playerState(damagedSnapshot, firstJoined.playerId).health,
      secondHealth = playerState(damagedSnapshot, secondJoined.playerId).health;
    assert.equal(secondHealth, 100, 'the enemy should target the connected actor nearest its position');
    assert.equal(firstHealth, 0, 'the nearest actor should be defeated while the other remains active');
    assert.equal(damagedSnapshot.game!.status, 'playing', 'one dead actor must not end the shared room while another lives');
    assert.equal(damagedSnapshot.game!.nodes.find((node) => node.nodeId === 'campaign-player')?.enabled, false);
    const timerSnapshot = await waitFor(() => {
      const snapshot = lastMessage(first!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) &&
        message.game?.sceneId === binding.sceneId &&
        message.game.frame >= damagedSnapshot.game!.frame + 30,
      );
      return snapshot?.game ? snapshot : false;
    });
    const sourceSnapshots = first.messages.filter((message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && message.game?.sceneId === binding.sceneId,
    );
    const adjacentFrames = sourceSnapshots.slice(1).flatMap((snapshot, index) => {
      const previous = sourceSnapshots[index];
      return snapshot.serverTick === previous.serverTick + 1 ? [[previous, snapshot] as const] : [];
    });
    assert.ok(adjacentFrames.length > 0, 'the host should emit consecutive shared ticks');
    for (const [previous, next] of adjacentFrames)
      assert.equal(next.game!.frame, previous.game!.frame + 1, 'two clients must share one simulation step per host tick');
    const elapsedTimerTicks = timerSnapshot.game!.variables.timerTicks ?? 0,
      expectedTimerTicks = Math.floor(timerSnapshot.game!.seconds / 0.1);
    assert.ok(
      Math.abs(elapsedTimerTicks - expectedTimerTicks) <= 2,
      'the shared tick timer should advance at its authored interval, once per simulation step',
    );

    const transitionAt = first.messages.length;
    second.socket.send(JSON.stringify({ version: 1, type: 'input', sequence: secondSequence++, input: { interact: true } }));
    const transitioned = await waitForMessage(first, transitionAt, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      isSnapshot(message) && message.game?.sceneId === nextSceneId,
    );
    assert.equal(transitioned.game?.entrySceneId, binding.sceneId);
    assert.equal(transitioned.game?.campaignVariables.crossings, 1);
    assert.equal(transitioned.game?.campaignVariables.destinationStarts, 1);
    assert.deepEqual(playerState(transitioned, firstJoined.playerId).inventory.map((stack) => stack.itemId), ['beta', 'alpha']);
    assert.deepEqual(playerState(transitioned, secondJoined.playerId).inventory.map((stack) => stack.itemId), ['alpha', 'beta']);
    assert.equal(playerState(transitioned, firstJoined.playerId).health, firstHealth);
    assert.equal(playerState(transitioned, secondJoined.playerId).health, secondHealth);
    const sharedTransition = await waitFor(() => {
      const snapshot = lastMessage(second!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) && message.game?.sceneId === nextSceneId,
      );
      return snapshot?.game ? snapshot : false;
    });
    assert.deepEqual(sharedTransition.game, transitioned.game, 'both clients receive identical transition snapshots');

    await gateway.close();
    restartedGateway = new MultiplayerGateway({ host: '127.0.0.1', port: 0, stateFile });
    const restartUrl = await restartedGateway.listen();
    resumedFirst = await openClient(restartUrl);
    resumedSecond = await openClient(restartUrl);
    resumedFirst.socket.send(JSON.stringify({
      version: 1,
      type: 'join',
      gameId: room.gameId,
      credential: room.credential,
      resumeCredential: firstJoined.resumeCredential,
    }));
    resumedSecond.socket.send(JSON.stringify({
      version: 1,
      type: 'join',
      gameId: room.gameId,
      credential: room.credential,
      resumeCredential: secondJoined.resumeCredential,
    }));
    const [resumedFirstJoin, resumedSecondJoin] = await Promise.all([
      waitForMessage(resumedFirst, 0, isJoined),
      waitForMessage(resumedSecond, 0, isJoined),
    ]);
    assert.equal(resumedFirstJoin.playerId, firstJoined.playerId);
    assert.equal(resumedSecondJoin.playerId, secondJoined.playerId);
    const restored = await waitFor(() => {
      const snapshot = lastMessage(resumedFirst!, (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
        isSnapshot(message) &&
        message.game?.sceneId === nextSceneId &&
        message.game.players.length === 2 &&
        message.game.players.every((player) => player.connected),
      );
      return snapshot?.game ? snapshot : false;
    });
    assert.equal(restored.game?.entrySceneId, binding.sceneId);
    assert.equal(restored.game?.campaignVariables.crossings, 1);
    assert.equal(restored.game?.campaignVariables.destinationStarts, 1, 'restart must not rerun destination start rules');
    assert.equal(restored.game?.players.filter((player) => player.playerId === firstJoined.playerId).length, 1);
    assert.equal(restored.game?.nodes.filter((node) => node.playerId === firstJoined.playerId).length, 1);
    assert.equal(playerState(restored, firstJoined.playerId).health, firstHealth);
    assert.equal(playerState(restored, secondJoined.playerId).health, secondHealth);
    assert.deepEqual(playerState(restored, firstJoined.playerId).inventory.map((stack) => stack.itemId), ['beta', 'alpha']);
    assert.deepEqual(playerState(restored, secondJoined.playerId).inventory.map((stack) => stack.itemId), ['alpha', 'beta']);
  } finally {
    for (const client of [first, second, resumedFirst, resumedSecond])
      if (client?.socket.readyState === WebSocket.OPEN) client.socket.close();
    await gateway.close().catch(() => {});
    await restartedGateway?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
