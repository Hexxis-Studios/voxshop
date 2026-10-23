import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { MultiplayerGateway } from '../server/multiplayer';
import { newProject, nodeSchema, validateProject } from '../services/projectDocument';
import type { MultiplayerProjectBinding } from '../services/multiplayerProtocol';
import { MultiplayerGameConnection } from '../runtime/MultiplayerGameConnection';

function boundProject() {
  const project = newProject('multiplayer-connection', 'Multiplayer connection test');
  project.scenes[0]!.nodes = [
    nodeSchema.parse({
      id: 'player',
      name: 'Player',
      transform: { position: [0, 0, 0] },
      components: [{ type: 'player', style: 'top-down', speed: 3, jump: 5 }],
    }),
  ];
  return validateProject(project);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for authoritative multiplayer state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createHost() {
  const tempRoot = path.join(process.cwd(), '.voxshop', 'tmp');
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, 'multiplayer-connection-'));
  const project = boundProject();
  const binding = {
    projectId: project.id,
    revision: project.revision,
    sceneId: project.activeSceneId,
  } satisfies MultiplayerProjectBinding;
  const gateway = new MultiplayerGateway({
    host: '127.0.0.1',
    port: 0,
    stateFile: path.join(directory, 'rooms.json'),
  });
  await gateway.listen();
  const room = await gateway.createRoomWithProject(2, binding, project);
  return { directory, project, binding, gateway, room };
}

test('game connection applies authoritative snapshots in order and leaves the room cleanly', async () => {
  const host = await createHost();
  const applied: Array<{ frame: number; playerId: string }> = [];
  const connection = new MultiplayerGameConnection(host.room, host.binding, (game, playerId) =>
    applied.push({ frame: game.frame, playerId }),
  );
  try {
    await connection.connect();
    await waitFor(() => applied.length >= 3);

    assert.equal(connection.info().state, 'connected');
    assert.equal(connection.info().gameId, host.room.gameId);
    assert.ok(connection.info().playerId);
    assert.ok(applied.every((snapshot) => snapshot.playerId === connection.info().playerId));
    assert.ok(
      applied.every((snapshot, index) => index === 0 || snapshot.frame > applied[index - 1]!.frame),
      'Only monotonically newer authoritative game snapshots should be applied.',
    );
    assert.equal(connection.send({ moveX: 0.5 }), true);

    await connection.close();
    await waitFor(() => host.gateway.listRooms()[0]?.playerCount === 0);
    assert.equal(connection.info().state, 'disconnected');
  } finally {
    await connection.close();
    await host.gateway.close();
    await rm(host.directory, { recursive: true, force: true });
  }
});

test('game connection rejects a room snapshot bound to a different project revision', async () => {
  const host = await createHost();
  let applyCount = 0;
  const connection = new MultiplayerGameConnection(
    host.room,
    { ...host.binding, revision: host.binding.revision + 1 },
    () => applyCount++,
  );
  try {
    await assert.rejects(connection.connect(), /different project or revision/i);
    assert.equal(applyCount, 0, 'A mismatched room snapshot must not reach the renderer.');
    assert.equal(connection.info().state, 'disconnected');
    assert.match(connection.info().error ?? '', /different project or revision/i);
    await waitFor(() => host.gateway.listRooms()[0]?.playerCount === 0);
  } finally {
    await connection.close();
    await host.gateway.close();
    await rm(host.directory, { recursive: true, force: true });
  }
});
