import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { ServiceError } from './projectStore';
import {
  multiplayerPlayerSnapshotSchema,
  multiplayerServerTickSchema,
  MULTIPLAYER_MAX_PLAYERS,
  MULTIPLAYER_PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type MultiplayerPlayerSnapshot,
  type MultiplayerProjectBinding,
  type ServerMessage,
} from '../services/multiplayerProtocol';
import { projectSchema, type ProjectDocument } from '../services/projectDocument';
import { MultiplayerSimulationHost } from './multiplayerSimulation';
import {
  MultiplayerRoom,
  MULTIPLAYER_RESUME_GRACE_MS,
  type AcceptedPlayerIntent,
  type RoomReceiveResult,
} from '../services/multiplayerRoom';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  loadMultiplayerPersistence,
  saveMultiplayerPersistence,
  type MultiplayerPersistence,
} from './multiplayerPersistence';

const MAX_ROOMS = 128;
const ROOM_CREDENTIAL_BYTES = 32;
const SOCKET_MAX_PAYLOAD_BYTES = 4096;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const PERSISTENCE_COALESCE_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

type Connection = {
  id: string;
  socket: WebSocket;
  isAlive: boolean;
  reconnectable?: boolean;
  room?: ManagedRoom;
  playerId?: string;
};

type PendingTick = { serverTick: number; inputs: AcceptedPlayerIntent[] };

type ManagedRoom = {
  gameId: string;
  projectBinding?: MultiplayerProjectBinding;
  credentialHash: Buffer;
  resumeCredentials: Map<string, { hash: Buffer; expiresAt: number | null }>;
  room: MultiplayerRoom;
  connections: Map<string, Connection>;
  pendingTick?: PendingTick;
  lastServerTick: number;
  lastSnapshot?: Extract<ServerMessage, { type: 'snapshot' }>;
  authority?: MultiplayerSimulationHost;
  tickTimer?: NodeJS.Timeout;
  tickInProgress?: boolean;
};

type MultiplayerErrorCode = Extract<ServerMessage, { type: 'error' }>['code'];

function credentialHash(credential: string) {
  return createHash('sha256').update(credential).digest();
}

function hasCredential(credential: string, expectedHash: Buffer) {
  const actualHash = credentialHash(credential);
  return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}

function messageText(data: RawData) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.concat(data).toString('utf8');
}

function formatHost(host: string) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function receiveErrorCode(result: Extract<RoomReceiveResult, { ok: false }>): MultiplayerErrorCode {
  return result.reason === 'invalid-connection' ? 'invalid-message' : result.reason;
}

/**
 * Local-authority room host. Room secrets are returned once at creation and only their
 * SHA-256 digests are retained. Unexpected disconnects may resume the same identity
 * for 60 seconds. Game simulation calls beginTick before stepping and publishSnapshot
 * after it has applied those intents.
 */
export class MultiplayerGateway {
  private readonly rooms = new Map<string, ManagedRoom>();
  private readonly connections = new Set<Connection>();
  private server?: WebSocketServer;
  private httpsServer?: HttpsServer;
  private heartbeatTimer?: NodeJS.Timeout;
  private persistenceTimer?: NodeJS.Timeout;
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistenceError?: Error;
  private persistenceReady = false;

  constructor(
    private readonly options: {
      host?: string;
      publicHost?: string;
      port?: number;
      stateFile?: string;
      projectSnapshotsDir?: string;
      tlsCertFile?: string;
      tlsKeyFile?: string;
      heartbeatIntervalMs?: number;
    } = {},
  ) {
    const port = options.port ?? 4270;
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      throw new Error('Multiplayer port must be an integer from 0 to 65535.');
    if (Boolean(options.tlsCertFile) !== Boolean(options.tlsKeyFile))
      throw new Error('Multiplayer TLS requires both certificate and private-key files.');
    if (!LOOPBACK_HOSTS.has((options.host ?? '127.0.0.1').toLowerCase()) && !options.tlsCertFile)
      throw new Error('Non-loopback multiplayer binds require TLS certificate and private-key files.');
    if (WILDCARD_HOSTS.has((options.host ?? '127.0.0.1').toLowerCase()) && !options.publicHost)
      throw new Error('Wildcard multiplayer binds require an advertised public host.');
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 10 || heartbeatIntervalMs > 60_000)
      throw new Error('Multiplayer heartbeat interval must be from 10 to 60000 milliseconds.');
  }

  get websocketUrl() {
    const configuredPort = this.options.port ?? 4270;
    const address = this.httpsServer?.address() ?? this.server?.address();
    const port = address && typeof address !== 'string' ? address.port : configuredPort;
    const host = this.options.publicHost ?? this.options.host ?? '127.0.0.1';
    const scheme = this.options.tlsCertFile ? 'wss' : 'ws';
    return `${scheme}://${formatHost(host)}:${port}/multiplayer`;
  }

  async listen() {
    if (this.server) return this.websocketUrl;
    await this.loadPersistedRooms();
    const transportOptions = {
      path: '/multiplayer',
      maxPayload: SOCKET_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    } as const;
    let server: WebSocketServer;
    if (this.options.tlsCertFile && this.options.tlsKeyFile) {
      const [cert, key] = await Promise.all([
        readFile(this.options.tlsCertFile),
        readFile(this.options.tlsKeyFile),
      ]);
      const httpsServer = createHttpsServer({ cert, key });
      this.httpsServer = httpsServer;
      server = new WebSocketServer({ server: httpsServer, ...transportOptions });
      httpsServer.listen(this.options.port ?? 4270, this.options.host ?? '127.0.0.1');
    } else {
      server = new WebSocketServer({
        host: this.options.host ?? '127.0.0.1',
        port: this.options.port ?? 4270,
        ...transportOptions,
      });
    }
    this.server = server;
    server.on('connection', (socket) => this.accept(socket));
    server.on('error', (error) => console.error(`VoxShop multiplayer: ${error.message}`));
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        server.once('listening', onListening);
        server.once('error', onError);
      });
    } catch (error) {
      this.server = undefined;
      this.httpsServer?.close();
      this.httpsServer = undefined;
      server.close();
      throw error;
    }
    this.heartbeatTimer = setInterval(
      () => this.checkConnections(),
      this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.heartbeatTimer.unref();
    return this.websocketUrl;
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    const httpsServer = this.httpsServer;
    this.httpsServer = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const managed of this.rooms.values()) {
      if (managed.tickTimer) clearInterval(managed.tickTimer);
      managed.tickTimer = undefined;
      managed.authority?.dispose();
    }
    if (server) {
      for (const socket of server.clients) socket.close(1001, 'VoxShop host stopping');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (httpsServer?.listening) await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    await this.flushPersistence();
    this.connections.clear();
    this.rooms.clear();
  }

  createRoom(maxPlayers = 16, projectBinding?: MultiplayerProjectBinding) {
    if (this.rooms.size >= MAX_ROOMS) throw new ServiceError(429, 'The multiplayer host is full.');
    const gameId = randomUUID();
    const credential = randomBytes(ROOM_CREDENTIAL_BYTES).toString('base64url');
    const managed: ManagedRoom = {
      gameId,
      ...(projectBinding ? { projectBinding } : {}),
      credentialHash: credentialHash(credential),
      resumeCredentials: new Map(),
      room: new MultiplayerRoom(gameId, maxPlayers),
      connections: new Map(),
      lastServerTick: -1,
    };
    this.rooms.set(gameId, managed);
    this.schedulePersistence();
    return {
      gameId,
      ...(projectBinding ? { projectBinding } : {}),
      credential,
      maxPlayers,
      websocketUrl: this.websocketUrl,
    };
  }

  async createRoomWithProject(
    maxPlayers: number,
    projectBinding: MultiplayerProjectBinding,
    project: ProjectDocument,
  ) {
    const validated = projectSchema.parse(structuredClone(project));
    const boundScene = validated.scenes.find((scene) => scene.id === projectBinding.sceneId);
    if (
      validated.id !== projectBinding.projectId ||
      validated.revision !== projectBinding.revision ||
      !boundScene
    )
      throw new ServiceError(409, 'The bound multiplayer project revision or scene is stale.');
    if (!boundScene.nodes.some((node) => node.components.some((component) => component.type === 'player')))
      throw new ServiceError(400, 'Bound multiplayer rooms require an authored player node.');
    const game = this.createRoom(maxPlayers, projectBinding);
    const managed = this.rooms.get(game.gameId)!;
    try {
      await this.saveProjectSnapshot(game.gameId, validated);
      managed.authority = new MultiplayerSimulationHost(validated, projectBinding);
      this.startSimulationTimer(managed);
      return game;
    } catch (error) {
      this.rooms.delete(game.gameId);
      await this.removeProjectSnapshot(game.gameId).catch(() => {});
      throw error;
    }
  }

  listRooms() {
    return [...this.rooms.values()].map((managed) => {
      this.pruneExpiredPlayers(managed);
      return {
        gameId: managed.gameId,
        ...(managed.projectBinding ? { projectBinding: managed.projectBinding } : {}),
        maxPlayers: managed.room.maxPlayers,
        playerCount: managed.room.playerCount,
        reservedPlayerCount: managed.room.reservedPlayerCount,
      };
    });
  }

  deleteRoom(gameId: string) {
    const managed = this.rooms.get(gameId);
    if (!managed) return false;
    this.rooms.delete(gameId);
    if (managed.tickTimer) clearInterval(managed.tickTimer);
    managed.authority?.dispose();
    void this.removeProjectSnapshot(gameId).catch((error) => {
      console.error(`VoxShop multiplayer project snapshot could not be removed: ${(error as Error).message}`);
    });
    for (const connection of managed.connections.values())
      connection.socket.close(1008, 'Multiplayer room closed');
    this.schedulePersistence();
    return true;
  }

  beginTick(gameId: string, serverTick: number) {
    const managed = this.requireRoom(gameId);
    if (managed.authority)
      throw new ServiceError(409, 'Bound rooms are advanced by their authoritative simulation.');
    return this.beginManagedTick(managed, serverTick);
  }

  private beginManagedTick(managed: ManagedRoom, serverTick: number) {
    multiplayerServerTickSchema.parse(serverTick);
    if (managed.pendingTick) throw new ServiceError(409, 'The previous host tick is not committed.');
    if (serverTick <= managed.lastServerTick)
      throw new ServiceError(409, 'Server ticks must increase monotonically.');
    const inputs = managed.room.takeInputsForTick();
    managed.pendingTick = { serverTick, inputs };
    return structuredClone(inputs);
  }

  publishSnapshot(gameId: string, serverTick: number, players: MultiplayerPlayerSnapshot[]) {
    const managed = this.requireRoom(gameId);
    if (managed.authority)
      throw new ServiceError(409, 'Bound room snapshots are produced by their authoritative simulation.');
    return this.commitSnapshot(managed, serverTick, players);
  }

  private commitSnapshot(
    managed: ManagedRoom,
    serverTick: number,
    players: MultiplayerPlayerSnapshot[],
    game?: Extract<ServerMessage, { type: 'snapshot' }>['game'],
  ) {
    multiplayerServerTickSchema.parse(serverTick);
    if (!managed.pendingTick || managed.pendingTick.serverTick !== serverTick)
      throw new ServiceError(409, 'Begin this host tick before publishing its snapshot.');
    if (
      game &&
      (!managed.projectBinding ||
        game.projectId !== managed.projectBinding.projectId ||
        game.revision !== managed.projectBinding.revision ||
        (game.entrySceneId ?? game.sceneId) !== managed.projectBinding.sceneId)
    )
      throw new ServiceError(409, 'The authoritative game state does not match the room project binding.');
    const snapshot = managed.room.createSnapshot(serverTick, players, game);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 2_000_000)
      throw new ServiceError(413, 'The authoritative multiplayer snapshot exceeds the 2 MB limit.');
    const acknowledgedPlayers = new Set(managed.pendingTick.inputs.map((input) => input.playerId));
    for (const connection of managed.connections.values()) {
      if (!connection.playerId || !acknowledgedPlayers.has(connection.playerId)) continue;
      const ack = managed.room.createAck(connection.id, serverTick);
      if (ack) this.send(connection.socket, ack);
    }
    for (const connection of managed.connections.values()) this.send(connection.socket, snapshot);
    managed.lastServerTick = serverTick;
    managed.lastSnapshot = snapshot;
    managed.pendingTick = undefined;
    this.schedulePersistence();
    return snapshot;
  }

  async flushPersistence() {
    if (!this.options.stateFile || !this.persistenceReady) return;
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    this.enqueuePersistence();
    await this.persistenceTail;
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    if (this.persistenceError)
      throw new Error('VoxShop multiplayer state could not be saved.', { cause: this.persistenceError });
  }

  private async loadPersistedRooms() {
    const filename = this.options.stateFile;
    if (!filename || this.persistenceReady) return;
    const state = await loadMultiplayerPersistence(filename);
    const now = Date.now();
    for (const saved of state.rooms) {
      const players = saved.players.filter((player) => player.expiresAt === null || player.expiresAt > now);
      const playerIds = new Set(players.map((player) => player.playerId));
      const room = new MultiplayerRoom(saved.gameId, saved.maxPlayers, saved.nextPlayerNumber);
      const resumeCredentials = new Map<string, { hash: Buffer; expiresAt: number | null }>();
      for (const player of players) {
        const expiresAt = player.expiresAt ?? now + MULTIPLAYER_RESUME_GRACE_MS;
        room.restoreDisconnectedSession(
          player.playerId,
          player.lastAcceptedSequence,
          player.lastTickSequence,
          expiresAt - MULTIPLAYER_RESUME_GRACE_MS,
        );
        resumeCredentials.set(player.playerId, {
          hash: Buffer.from(player.credentialHash, 'hex'),
          expiresAt,
        });
      }
      const lastSnapshot = saved.lastSnapshot
        ? {
            ...saved.lastSnapshot,
            players: saved.lastSnapshot.players.filter((player) => playerIds.has(player.playerId)),
            ...(saved.lastSnapshot.game
              ? {
                  game: {
                    ...saved.lastSnapshot.game,
                    nodes: saved.lastSnapshot.game.nodes
                      .filter((node) => !node.playerId || playerIds.has(node.playerId))
                      .map((node) => (node.playerId ? { ...node, enabled: false } : node)),
                    players: saved.lastSnapshot.game.players
                      .filter((player) => playerIds.has(player.playerId))
                      .map((player) => ({ ...player, connected: false })),
                    objectives: saved.lastSnapshot.game.objectives.filter((objective) =>
                      playerIds.has(objective.playerId),
                    ),
                  },
                }
              : {}),
          }
        : undefined;
      const managed: ManagedRoom = {
        gameId: saved.gameId,
        ...(saved.projectBinding ? { projectBinding: saved.projectBinding } : {}),
        credentialHash: Buffer.from(saved.credentialHash, 'hex'),
        resumeCredentials,
        room,
        connections: new Map(),
        lastServerTick: saved.lastServerTick,
        ...(lastSnapshot ? { lastSnapshot } : {}),
      };
      if (saved.projectBinding) {
        const project = await this.readProjectSnapshot(saved.gameId);
        if (project)
          managed.authority = new MultiplayerSimulationHost(
            project,
            saved.projectBinding,
            lastSnapshot?.game,
          );
      }
      this.rooms.set(saved.gameId, managed);
      if (managed.authority) this.startSimulationTimer(managed);
    }
    this.persistenceReady = true;
    if (state.rooms.length > 0 || this.rooms.size > 0) this.schedulePersistence();
  }

  private exportPersistenceState(): MultiplayerPersistence {
    const rooms = [...this.rooms.values()].map((managed) => {
      this.pruneExpiredPlayers(managed, false);
      const sessionState = managed.room.exportPersistenceState(new Set(managed.resumeCredentials.keys()));
      const players = sessionState.players.flatMap((session) => {
        const saved = managed.resumeCredentials.get(session.playerId);
        return saved
          ? [{ ...session, credentialHash: saved.hash.toString('hex'), expiresAt: saved.expiresAt }]
          : [];
      });
      return {
        gameId: managed.gameId,
        ...(managed.projectBinding ? { projectBinding: managed.projectBinding } : {}),
        credentialHash: managed.credentialHash.toString('hex'),
        maxPlayers: managed.room.maxPlayers,
        nextPlayerNumber: sessionState.nextPlayerNumber,
        lastServerTick: managed.lastServerTick,
        players,
        lastSnapshot: managed.lastSnapshot ?? null,
      };
    });
    return { version: 1, rooms };
  }

  private schedulePersistence() {
    if (!this.options.stateFile || !this.persistenceReady || this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      this.enqueuePersistence();
    }, PERSISTENCE_COALESCE_MS);
    this.persistenceTimer.unref();
  }

  private startSimulationTimer(managed: ManagedRoom) {
    if (!managed.authority || managed.tickTimer) return;
    managed.tickTimer = setInterval(() => void this.tickAuthoritativeRoom(managed), 1000 / 60);
    managed.tickTimer.unref();
  }

  private async tickAuthoritativeRoom(managed: ManagedRoom) {
    if (
      !managed.authority ||
      managed.tickInProgress ||
      !this.rooms.has(managed.gameId) ||
      managed.room.playerCount === 0
    )
      return;
    managed.tickInProgress = true;
    const serverTick = managed.lastServerTick + 1;
    try {
      const inputs = this.beginManagedTick(managed, serverTick),
        result = await managed.authority.tick(
          managed.room.activePlayerIds,
          managed.room.retainedPlayerIds,
          inputs,
        );
      this.commitSnapshot(managed, serverTick, result.players, result.game);
    } catch (error) {
      if (managed.pendingTick?.serverTick === serverTick) managed.pendingTick = undefined;
      console.error(`VoxShop multiplayer simulation failed: ${(error as Error).message}`);
      if (managed.tickTimer) clearInterval(managed.tickTimer);
      managed.tickTimer = undefined;
    } finally {
      managed.tickInProgress = false;
    }
  }

  private projectSnapshotDirectory() {
    return (
      this.options.projectSnapshotsDir ??
      (this.options.stateFile
        ? path.join(path.dirname(this.options.stateFile), 'multiplayer-projects')
        : undefined)
    );
  }

  private projectSnapshotPath(gameId: string) {
    const directory = this.projectSnapshotDirectory();
    if (!directory) throw new Error('A state file is required for bound multiplayer rooms.');
    return path.join(directory, `${gameId}.json`);
  }

  private async saveProjectSnapshot(gameId: string, project: ProjectDocument) {
    const filename = this.projectSnapshotPath(gameId),
      directory = path.dirname(filename),
      temporary = `${filename}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(project), { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async readProjectSnapshot(gameId: string) {
    let raw: string;
    try {
      raw = await readFile(this.projectSnapshotPath(gameId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return projectSchema.parse(JSON.parse(raw));
  }

  private async removeProjectSnapshot(gameId: string) {
    await rm(this.projectSnapshotPath(gameId), { force: true });
  }

  private enqueuePersistence() {
    const filename = this.options.stateFile;
    if (!filename) return;
    const state = this.exportPersistenceState();
    this.persistenceTail = this.persistenceTail
      .then(() => saveMultiplayerPersistence(filename, state))
      .then(() => {
        this.persistenceError = undefined;
      })
      .catch((error) => {
        this.persistenceError = error instanceof Error ? error : new Error(String(error));
        console.error(`VoxShop multiplayer state could not be saved: ${this.persistenceError.message}`);
      });
  }

  private requireRoom(gameId: string) {
    const managed = this.rooms.get(gameId);
    if (!managed) throw new ServiceError(404, 'Multiplayer room does not exist.');
    return managed;
  }

  private pruneExpiredPlayers(managed: ManagedRoom, persist = true) {
    const expired = managed.room.expireDisconnectedSessions();
    for (const playerId of expired) managed.resumeCredentials.delete(playerId);
    if (expired.length) this.synchronizeManagedPlayers(managed);
    if (persist && expired.length > 0) this.schedulePersistence();
  }

  private synchronizeManagedPlayers(managed: ManagedRoom) {
    if (!managed.authority) return;
    void managed.authority
      .synchronizePlayers(managed.room.activePlayerIds, managed.room.retainedPlayerIds)
      .catch((error) => {
        console.error(`VoxShop multiplayer actors could not be synchronized: ${(error as Error).message}`);
      });
  }

  private findResumePlayer(managed: ManagedRoom, credential: string) {
    let playerId: string | undefined;
    for (const [candidateId, saved] of managed.resumeCredentials) {
      if (saved.expiresAt !== null && saved.expiresAt <= Date.now()) continue;
      if (hasCredential(credential, saved.hash)) playerId = candidateId;
    }
    return playerId;
  }

  private send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(serverMessageSchema.parse(message)));
  }

  private reject(connection: Connection, code: MultiplayerErrorCode) {
    this.send(connection.socket, { version: MULTIPLAYER_PROTOCOL_VERSION, type: 'error', code });
    connection.socket.close(1008, code);
  }

  private accept(socket: WebSocket) {
    const connection: Connection = { id: randomBytes(16).toString('hex'), socket, isAlive: true };
    this.connections.add(connection);
    socket.on('pong', () => {
      connection.isAlive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return this.reject(connection, 'invalid-message');
      let value: unknown;
      try {
        value = JSON.parse(messageText(data));
      } catch {
        return this.reject(connection, 'invalid-message');
      }
      const parsed = clientMessageSchema.safeParse(value);
      if (!parsed.success) return this.reject(connection, 'invalid-message');
      const message = parsed.data;

      if (!connection.room) {
        if (message.type !== 'join') return this.reject(connection, 'join-required');
        const managed = this.rooms.get(message.gameId);
        if (!managed) return this.reject(connection, 'unknown-room');
        this.pruneExpiredPlayers(managed);
        if (!hasCredential(message.credential, managed.credentialHash))
          return this.reject(connection, 'invalid-credential');
        const resumed = message.resumeCredential !== undefined;
        const reconnectable = resumed || message.reconnect === true;
        const playerId = resumed ? this.findResumePlayer(managed, message.resumeCredential!) : undefined;
        if (resumed && !playerId) return this.reject(connection, 'invalid-credential');
        const result = resumed
          ? managed.room.resume(connection.id, playerId!)
          : managed.room.receive(connection.id, message);
        if (!result.ok) return this.reject(connection, receiveErrorCode(result));
        if (result.type !== 'joined') return this.reject(connection, 'invalid-message');
        const resumeCredential = reconnectable
          ? randomBytes(ROOM_CREDENTIAL_BYTES).toString('base64url')
          : undefined;
        if (resumeCredential)
          managed.resumeCredentials.set(result.playerId, {
            hash: credentialHash(resumeCredential),
            expiresAt: null,
          });
        connection.room = managed;
        connection.playerId = result.playerId;
        connection.reconnectable = reconnectable;
        managed.connections.set(connection.id, connection);
        this.synchronizeManagedPlayers(managed);
        this.send(socket, {
          version: MULTIPLAYER_PROTOCOL_VERSION,
          type: 'joined',
          gameId: managed.gameId,
          playerId: result.playerId,
          ...(resumeCredential
            ? { resumeCredential, nextInputSequence: managed.room.nextInputSequence(connection.id) }
            : {}),
        });
        this.schedulePersistence();
        if (resumed && managed.lastSnapshot && !managed.authority) this.send(socket, managed.lastSnapshot);
        return;
      }

      const result = connection.room.room.receive(connection.id, message);
      if (!result.ok) return this.reject(connection, receiveErrorCode(result));
      if (result.type === 'input') {
        this.send(socket, {
          version: MULTIPLAYER_PROTOCOL_VERSION,
          type: 'queued',
          inputSequence: result.sequence,
        });
        this.schedulePersistence();
      } else if (result.type === 'left') {
        const managed = connection.room;
        if (connection.playerId) managed.resumeCredentials.delete(connection.playerId);
        managed.connections.delete(connection.id);
        connection.room = undefined;
        connection.playerId = undefined;
        connection.reconnectable = undefined;
        this.synchronizeManagedPlayers(managed);
        socket.close(1000, 'Player left room');
        this.schedulePersistence();
      }
    });
    socket.on('close', () => {
      this.connections.delete(connection);
      const managed = connection.room;
      if (!managed) return;
      if (connection.reconnectable) {
        managed.room.disconnect(connection.id);
        if (connection.playerId) {
          const saved = managed.resumeCredentials.get(connection.playerId);
          if (saved) saved.expiresAt = Date.now() + MULTIPLAYER_RESUME_GRACE_MS;
        }
      } else {
        managed.room.receive(connection.id, {
          version: MULTIPLAYER_PROTOCOL_VERSION,
          type: 'leave',
          reason: 'disconnect',
        });
      }
      managed.connections.delete(connection.id);
      connection.room = undefined;
      connection.playerId = undefined;
      connection.reconnectable = undefined;
      this.synchronizeManagedPlayers(managed);
      this.schedulePersistence();
    });
    socket.on('error', () => socket.close(1011, 'Multiplayer connection failed'));
  }

  private checkConnections() {
    for (const connection of this.connections) {
      const { socket } = connection;
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!connection.isAlive) {
        socket.terminate();
        continue;
      }
      connection.isAlive = false;
      socket.ping();
    }
  }
}

export const multiplayerSnapshotInputSchema = multiplayerPlayerSnapshotSchema
  .array()
  .max(MULTIPLAYER_MAX_PLAYERS);
