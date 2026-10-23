import {
  MULTIPLAYER_MAX_PLAYERS,
  MULTIPLAYER_PROTOCOL_VERSION,
  clientMessageSchema,
  multiplayerIdSchema,
  serverMessageSchema,
  type ClientMessage,
  type MultiplayerPlayerSnapshot,
  type MultiplayerGameState,
  type ServerMessage,
} from './multiplayerProtocol';

export const MAX_PENDING_INPUTS_PER_PLAYER = 64;
export const MULTIPLAYER_RESUME_GRACE_MS = 60_000;
const connectionIdSchema = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

type GameplayInput = Extract<ClientMessage, { type: 'input' }>['input'];
export type AcceptedPlayerIntent = { playerId: string; sequence: number; input: GameplayInput };
export type RoomReceiveResult =
  | { ok: true; type: 'joined'; playerId: string }
  | { ok: true; type: 'input'; playerId: string; sequence: number }
  | { ok: true; type: 'left'; playerId: string }
  | {
      ok: false;
      reason:
        | 'invalid-connection'
        | 'invalid-message'
        | 'wrong-room'
        | 'already-joined'
        | 'not-joined'
        | 'room-full'
        | 'stale-sequence'
        | 'input-queue-full';
    };

type Session = {
  playerId: string;
  lastAcceptedSequence: number;
  lastTickSequence?: number;
  pendingCount: number;
  disconnectedAt?: number;
};

/**
 * In-memory membership and input sequencing. The network gateway authenticates a room
 * credential before calling this core and supplies one opaque ID per live connection.
 */
export class MultiplayerRoom {
  private readonly sessionsByConnection = new Map<string, Session>();
  private readonly sessionsByPlayer = new Map<string, Session>();
  private pendingInputs: AcceptedPlayerIntent[] = [];
  private nextPlayerNumber = 1;

  constructor(
    readonly roomId: string,
    readonly maxPlayers = 16,
    initialNextPlayerNumber = 1,
  ) {
    if (!multiplayerIdSchema.safeParse(roomId).success) throw new Error('Invalid multiplayer room ID.');
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > MULTIPLAYER_MAX_PLAYERS)
      throw new Error(`Room capacity must be an integer from 1 to ${MULTIPLAYER_MAX_PLAYERS}.`);
    if (!Number.isInteger(initialNextPlayerNumber) || initialNextPlayerNumber < 1)
      throw new Error('Next player number must be a positive integer.');
    this.nextPlayerNumber = initialNextPlayerNumber;
  }

  get playerCount(): number {
    return this.sessionsByConnection.size;
  }

  get reservedPlayerCount(): number {
    return this.sessionsByPlayer.size - this.sessionsByConnection.size;
  }

  get activePlayerIds(): string[] {
    return [...this.sessionsByConnection.values()].map((session) => session.playerId).sort();
  }

  get retainedPlayerIds(): string[] {
    return [...this.sessionsByPlayer.keys()].sort();
  }

  exportPersistenceState(playerIds: ReadonlySet<string>) {
    return {
      nextPlayerNumber: this.nextPlayerNumber,
      players: [...playerIds].flatMap((playerId) => {
        const session = this.sessionsByPlayer.get(playerId);
        return session
          ? [
              {
                playerId,
                lastAcceptedSequence: session.lastAcceptedSequence,
                ...(session.lastTickSequence === undefined
                  ? {}
                  : { lastTickSequence: session.lastTickSequence }),
              },
            ]
          : [];
      }),
    };
  }

  restoreDisconnectedSession(
    playerId: string,
    lastAcceptedSequence: number,
    lastTickSequence: number | undefined,
    disconnectedAt: number,
  ) {
    if (!multiplayerIdSchema.safeParse(playerId).success || this.sessionsByPlayer.has(playerId))
      throw new Error('Stored multiplayer player identity is invalid or duplicated.');
    if (
      !Number.isInteger(lastAcceptedSequence) ||
      lastAcceptedSequence < -1 ||
      lastAcceptedSequence > 2_147_483_647 ||
      (lastTickSequence !== undefined &&
        (!Number.isInteger(lastTickSequence) || lastTickSequence < 0 || lastTickSequence > 2_147_483_647)) ||
      !Number.isFinite(disconnectedAt)
    )
      throw new Error('Stored multiplayer session sequence is invalid.');
    const playerNumber = /^player-(\d+)$/.exec(playerId)?.[1];
    if (playerNumber) this.nextPlayerNumber = Math.max(this.nextPlayerNumber, Number(playerNumber) + 1);
    this.sessionsByPlayer.set(playerId, {
      playerId,
      lastAcceptedSequence,
      ...(lastTickSequence === undefined ? {} : { lastTickSequence }),
      pendingCount: 0,
      disconnectedAt,
    });
  }

  nextInputSequence(connectionId: string) {
    return (this.sessionsByConnection.get(connectionId)?.lastAcceptedSequence ?? -1) + 1;
  }

  /** Validate and associate a client message with the caller's opaque transport connection. */
  receive(connectionId: string, value: unknown): RoomReceiveResult {
    if (!connectionIdSchema(connectionId)) return { ok: false, reason: 'invalid-connection' };
    const parsed = clientMessageSchema.safeParse(value);
    if (!parsed.success) return { ok: false, reason: 'invalid-message' };
    const message = parsed.data;

    if (message.type === 'join') {
      if (message.gameId !== this.roomId) return { ok: false, reason: 'wrong-room' };
      if (this.sessionsByConnection.has(connectionId)) return { ok: false, reason: 'already-joined' };
      this.expireDisconnectedSessions();
      if (this.sessionsByPlayer.size >= this.maxPlayers) return { ok: false, reason: 'room-full' };

      const session: Session = {
        playerId: `player-${this.nextPlayerNumber++}`,
        lastAcceptedSequence: -1,
        pendingCount: 0,
      };
      this.sessionsByConnection.set(connectionId, session);
      this.sessionsByPlayer.set(session.playerId, session);
      return { ok: true, type: 'joined', playerId: session.playerId };
    }

    const session = this.sessionsByConnection.get(connectionId);
    if (!session) return { ok: false, reason: 'not-joined' };
    if (message.type === 'leave') {
      this.sessionsByConnection.delete(connectionId);
      this.sessionsByPlayer.delete(session.playerId);
      // A disconnect cancels queued intentions so they cannot execute after departure.
      this.pendingInputs = this.pendingInputs.filter((intent) => intent.playerId !== session.playerId);
      return { ok: true, type: 'left', playerId: session.playerId };
    }

    if (message.sequence <= session.lastAcceptedSequence) return { ok: false, reason: 'stale-sequence' };
    if (session.pendingCount >= MAX_PENDING_INPUTS_PER_PLAYER)
      return { ok: false, reason: 'input-queue-full' };

    session.lastAcceptedSequence = message.sequence;
    session.pendingCount += 1;
    this.pendingInputs.push({
      playerId: session.playerId,
      sequence: message.sequence,
      input: message.input,
    });
    return { ok: true, type: 'input', playerId: session.playerId, sequence: message.sequence };
  }

  /** Detach a lost transport while retaining its identity and input sequence briefly. */
  disconnect(connectionId: string): boolean {
    const session = this.sessionsByConnection.get(connectionId);
    if (!session) return false;
    this.sessionsByConnection.delete(connectionId);
    session.pendingCount = 0;
    session.disconnectedAt = Date.now();
    this.pendingInputs = this.pendingInputs.filter((intent) => intent.playerId !== session.playerId);
    return true;
  }

  /** Rebind a retained player identity to a fresh transport connection. */
  resume(connectionId: string, playerId: string): RoomReceiveResult {
    if (!connectionIdSchema(connectionId)) return { ok: false, reason: 'invalid-connection' };
    if (this.sessionsByConnection.has(connectionId)) return { ok: false, reason: 'already-joined' };
    this.expireDisconnectedSessions();
    if (this.playerCount >= this.maxPlayers) return { ok: false, reason: 'room-full' };
    const session = this.sessionsByPlayer.get(playerId);
    if (!session || session.disconnectedAt === undefined) return { ok: false, reason: 'not-joined' };
    session.disconnectedAt = undefined;
    session.pendingCount = 0;
    this.sessionsByConnection.set(connectionId, session);
    return { ok: true, type: 'joined', playerId };
  }

  /** Remove expired disconnected identities and return their IDs so the gateway can drop tokens. */
  expireDisconnectedSessions(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const [playerId, session] of this.sessionsByPlayer) {
      if (
        session.disconnectedAt !== undefined &&
        now - session.disconnectedAt >= MULTIPLAYER_RESUME_GRACE_MS
      ) {
        this.sessionsByPlayer.delete(playerId);
        expired.push(playerId);
      }
    }
    return expired;
  }

  /** Hand every queued, accepted intent to one authoritative host tick in receive order. */
  takeInputsForTick(): AcceptedPlayerIntent[] {
    const batch = this.pendingInputs;
    this.pendingInputs = [];
    for (const intent of batch) {
      const session = this.sessionsByPlayer.get(intent.playerId);
      if (session) session.lastTickSequence = Math.max(session.lastTickSequence ?? -1, intent.sequence);
    }
    for (const session of this.sessionsByConnection.values()) session.pendingCount = 0;
    return batch;
  }

  /** Create an ack only for a sequence already handed to the authoritative host tick. */
  createAck(connectionId: string, serverTick: number): Extract<ServerMessage, { type: 'ack' }> | null {
    if (!connectionIdSchema(connectionId)) return null;
    const session = this.sessionsByConnection.get(connectionId);
    if (!session || session.lastTickSequence === undefined) return null;
    return serverMessageSchema.parse({
      version: MULTIPLAYER_PROTOCOL_VERSION,
      type: 'ack',
      inputSequence: session.lastTickSequence,
      serverTick,
    }) as Extract<ServerMessage, { type: 'ack' }>;
  }

  /** Build a snapshot exclusively from host-supplied state for current room members. */
  createSnapshot(
    serverTick: number,
    players: MultiplayerPlayerSnapshot[],
    game?: MultiplayerGameState,
  ): Extract<ServerMessage, { type: 'snapshot' }> {
    const snapshot = serverMessageSchema.parse({
      version: MULTIPLAYER_PROTOCOL_VERSION,
      type: 'snapshot',
      serverTick,
      players,
      ...(game ? { game } : {}),
    });
    if (snapshot.type !== 'snapshot') throw new Error('Expected a server snapshot.');
    if (snapshot.players.length !== this.playerCount)
      throw new Error('Snapshot must include every active room player.');
    const activePlayerIds = new Set(
      [...this.sessionsByConnection.values()].map((session) => session.playerId),
    );
    for (const player of snapshot.players)
      if (!activePlayerIds.has(player.playerId))
        throw new Error(`Snapshot player ${player.playerId} is not a member of this room.`);
    if (game) {
      const gamePlayerIds = new Set(game.players.map((player) => player.playerId));
      if (
        [...activePlayerIds].some((playerId) => !gamePlayerIds.has(playerId)) ||
        game.players.some(
          (player) =>
            !this.sessionsByPlayer.has(player.playerId) ||
            player.connected !== activePlayerIds.has(player.playerId),
        )
      )
        throw new Error('Authoritative game state has an invalid active or retained room player.');
    }
    return snapshot;
  }
}
