import {
  clientMessageSchema,
  multiplayerIdSchema,
  multiplayerProjectBindingSchema,
  parseServerMessage,
  type ClientMessage,
  type MultiplayerProjectBinding,
  type ServerMessage,
} from '../services/multiplayerProtocol';
import { z } from 'zod';
import { validateMultiplayerRoomOptions, type MultiplayerRoomOptions } from './multiplayerControls';

type JoinedMessage = Extract<ServerMessage, { type: 'joined' }>;
type GameplayInput = Extract<ClientMessage, { type: 'input' }>['input'];
type MultiplayerClientOptions = MultiplayerRoomOptions & { projectBinding?: MultiplayerProjectBinding };

const RESUME_INDEX_PREFIX = 'voxshop:multiplayer-resume-index:v1:';
const RESUME_RECORD_PREFIX = 'voxshop:multiplayer-resume:v1:';
const MAX_RESUME_RECORD_CHARS = 8192;
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const resumeRecordSchema = z
  .object({
    version: z.literal(1),
    websocketUrl: z.string().min(1).max(2048),
    gameId: multiplayerIdSchema,
    projectBinding: multiplayerProjectBindingSchema,
    resumeCredential: z.string().regex(RESUME_TOKEN_PATTERN),
  })
  .strict();
type ResumeRecord = z.infer<typeof resumeRecordSchema>;

function projectIndexKey(binding: MultiplayerProjectBinding) {
  return `${RESUME_INDEX_PREFIX}${binding.projectId}:${binding.revision}:${binding.sceneId}`;
}

// This digest only namespaces storage; the stored record is checked against the complete scope.
function resumeScopeDigest(record: Pick<ResumeRecord, 'websocketUrl' | 'gameId' | 'projectBinding'>) {
  const source = `${record.websocketUrl}\0${record.gameId}\0${record.projectBinding.projectId}\0${record.projectBinding.revision}\0${record.projectBinding.sceneId}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(source)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function browserSessionStorage(): Storage | undefined {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? undefined : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function removeSavedResumeSession(binding: MultiplayerProjectBinding, digest?: string) {
  const storage = browserSessionStorage();
  if (!storage) return;
  const index = projectIndexKey(binding);
  let storedDigest = digest;
  try {
    storedDigest ??= storage.getItem(index) ?? undefined;
    if (storedDigest && /^[a-f0-9]{16}$/.test(storedDigest))
      storage.removeItem(`${RESUME_RECORD_PREFIX}${storedDigest}`);
    storage.removeItem(index);
  } catch {
    // Storage can be revoked between access and cleanup; resume will fail closed on the next read.
  }
}

export function loadMultiplayerResumeSession(
  binding: MultiplayerProjectBinding,
): (MultiplayerRoomOptions & { projectBinding: MultiplayerProjectBinding }) | undefined {
  const validatedBinding = multiplayerProjectBindingSchema.safeParse(binding);
  if (!validatedBinding.success) return undefined;
  binding = validatedBinding.data;
  const storage = browserSessionStorage();
  if (!storage) return undefined;
  const index = projectIndexKey(binding);
  let digest: string | null;
  try {
    digest = storage.getItem(index);
  } catch {
    return undefined;
  }
  if (!digest) return undefined;
  const discard = () => removeSavedResumeSession(binding, digest ?? undefined);
  if (!/^[a-f0-9]{16}$/.test(digest)) {
    discard();
    return undefined;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(`${RESUME_RECORD_PREFIX}${digest}`);
  } catch {
    discard();
    return undefined;
  }
  if (!raw || raw.length > MAX_RESUME_RECORD_CHARS) {
    discard();
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    discard();
    return undefined;
  }
  const result = resumeRecordSchema.safeParse(parsed);
  if (
    !result.success ||
    result.data.projectBinding.projectId !== binding.projectId ||
    result.data.projectBinding.revision !== binding.revision ||
    result.data.projectBinding.sceneId !== binding.sceneId ||
    resumeScopeDigest(result.data) !== digest
  ) {
    discard();
    return undefined;
  }
  try {
    return {
      ...validateMultiplayerRoomOptions({
        websocketUrl: result.data.websocketUrl,
        gameId: result.data.gameId,
        resumeCredential: result.data.resumeCredential,
        resumeAfterReload: true,
      }),
      projectBinding: result.data.projectBinding,
    };
  } catch {
    discard();
    return undefined;
  }
}

/** Browser-native WebSocket client for a game room with automatic resume after unexpected drops. */
export class MultiplayerClient {
  private socket?: WebSocket;
  private joined?: JoinedMessage;
  private resumeCredential?: string;
  private nextSequence = 0;
  private closed = false;
  private connecting?: Promise<JoinedMessage>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 250;
  private everJoined = false;
  private permanentFailure = false;
  private leaveRequested = false;
  private resumePersistenceWarning?: string;
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly protocolErrorListeners = new Set<(error: Error) => void>();
  private readonly options: MultiplayerClientOptions;

  constructor(options: MultiplayerClientOptions) {
    const { projectBinding, ...roomOptions } = options;
    const validatedBinding = projectBinding
      ? multiplayerProjectBindingSchema.parse(projectBinding)
      : undefined;
    this.options = {
      ...validateMultiplayerRoomOptions(roomOptions),
      ...(validatedBinding ? { projectBinding: validatedBinding } : {}),
    };
    this.resumeCredential = this.options.resumeCredential;
    const url = new URL(this.options.websocketUrl);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Multiplayer URL must be local ws or use secure wss without embedded credentials.');
    if (this.options.resumeAfterReload) {
      if (!this.options.projectBinding)
        throw new Error('Resume after reload is available for project-bound multiplayer rooms.');
      const storage = browserSessionStorage();
      if (!storage) throw new Error('This browser does not allow tab-scoped storage for multiplayer resume.');
      const probe = `${RESUME_INDEX_PREFIX}probe:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      try {
        storage.setItem(probe, '1');
        storage.removeItem(probe);
      } catch {
        throw new Error(
          'Tab-scoped storage is unavailable; turn off resume after reload or allow session storage.',
        );
      }
    }
  }

  get playerId() {
    return this.joined?.playerId;
  }

  get connectionState(): 'connected' | 'connecting' | 'reconnecting' | 'disconnected' {
    if (this.joined && this.socket?.readyState === WebSocket.OPEN) return 'connected';
    if (this.connecting) return this.everJoined ? 'reconnecting' : 'connecting';
    if (this.reconnectTimer) return 'reconnecting';
    return 'disconnected';
  }

  get resumeToken() {
    return this.resumeCredential;
  }

  get resumeWarning() {
    return this.resumePersistenceWarning;
  }

  onMessage(listener: (message: ServerMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onProtocolError(listener: (error: Error) => void) {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  connect(): Promise<JoinedMessage> {
    this.permanentFailure = false;
    return this.connectOnce();
  }

  private connectOnce(): Promise<JoinedMessage> {
    if (this.joined && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.joined);
    if (this.connecting) return this.connecting;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.leaveRequested = false;
    this.closed = false;

    this.connecting = new Promise<JoinedMessage>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error, joined?: JoinedMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(joined!);
      };
      const timeout = setTimeout(() => {
        socket.close(1000, 'Join timed out');
        settle(new Error('Multiplayer join timed out.'));
      }, 10_000);
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.options.websocketUrl);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.socket = socket;
      socket.addEventListener(
        'open',
        () => {
          const message = clientMessageSchema.parse({
            version: 1,
            type: 'join',
            gameId: this.options.gameId,
            ...(this.options.credential ? { credential: this.options.credential } : {}),
            reconnect: true,
            ...(this.resumeCredential ? { resumeCredential: this.resumeCredential } : {}),
          });
          socket.send(JSON.stringify(message));
        },
        { once: true },
      );
      socket.addEventListener('message', (event) => {
        if (this.leaveRequested) return;
        let message: ServerMessage;
        try {
          if (typeof event.data !== 'string') throw new Error('Expected a text protocol message.');
          message = parseServerMessage(JSON.parse(event.data));
        } catch {
          const error = Error('The multiplayer server sent an invalid protocol message.');
          this.permanentFailure = true;
          try {
            socket.close(4002, 'Invalid protocol message');
          } catch {
            // Keep reporting the protocol error even if the browser cannot close the socket.
          }
          settle(error);
          for (const listener of this.protocolErrorListeners) listener(error);
          return;
        }
        if (message.type === 'joined') {
          this.joined = message;
          this.everJoined = true;
          this.reconnectDelayMs = 250;
          this.resumeCredential = message.resumeCredential ?? this.resumeCredential;
          this.nextSequence = message.nextInputSequence ?? this.nextSequence;
          if (this.options.resumeAfterReload) this.saveResumeSession();
          settle(undefined, message);
        } else if (message.type === 'error') {
          if (
            message.code === 'unknown-room' ||
            message.code === 'invalid-credential' ||
            message.code === 'invalid-message' ||
            message.code === 'room-full'
          )
            this.permanentFailure = true;
          if (
            (message.code === 'invalid-credential' || message.code === 'unknown-room') &&
            this.options.projectBinding &&
            (this.options.resumeAfterReload || this.options.resumeCredential)
          ) {
            this.clearResumeSession();
            this.resumeCredential = undefined;
          }
          settle(new Error(`Multiplayer join failed: ${message.code}.`));
        }
        for (const listener of this.listeners) listener(message);
      });
      socket.addEventListener('error', () => settle(new Error('Multiplayer connection failed.')));
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = undefined;
        this.joined = undefined;
        if (!settled) settle(new Error('Multiplayer connection closed before joining.'));
        if (this.everJoined && !this.closed) this.scheduleReconnect();
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  sendInput(input: GameplayInput) {
    if (!this.joined || this.socket?.readyState !== WebSocket.OPEN || this.closed)
      throw new Error('Join a multiplayer room before sending gameplay input.');
    const message = clientMessageSchema.parse({
      version: 1,
      type: 'input',
      sequence: this.nextSequence,
      input,
    });
    this.socket.send(JSON.stringify(message));
    return this.nextSequence++;
  }

  async leave() {
    this.leaveRequested = true;
    this.closed = true;
    this.everJoined = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.joined = undefined;
    this.resumeCredential = undefined;
    this.nextSequence = 0;
    if (this.options.resumeAfterReload || this.options.resumeCredential) this.clearResumeSession();
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(clientMessageSchema.parse({ version: 1, type: 'leave' })));
    await new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
      socket.close(1000, 'Player left room');
    });
  }

  /** Close the renderer socket as a disconnect, retaining only an opted-in tab resume token. */
  disconnectForPageExit() {
    if (this.leaveRequested) return Promise.resolve();
    if (!this.options.resumeAfterReload) return this.leave();
    this.closed = true;
    this.everJoined = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.resumeCredential) this.saveResumeSession();
    const socket = this.socket;
    this.socket = undefined;
    this.joined = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'Renderer reloaded');
    return Promise.resolve();
  }

  private saveResumeSession() {
    const binding = this.options.projectBinding;
    const token = this.resumeCredential;
    if (!binding || !token || !this.options.resumeAfterReload) return;
    const storage = browserSessionStorage();
    if (!storage) {
      this.resumePersistenceWarning =
        'Tab storage became unavailable; this player cannot resume after reload.';
      return;
    }
    const record: ResumeRecord = {
      version: 1,
      websocketUrl: this.options.websocketUrl,
      gameId: this.options.gameId,
      projectBinding: binding,
      resumeCredential: token,
    };
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_RESUME_RECORD_CHARS) {
      this.resumePersistenceWarning = 'Saved multiplayer session exceeded its storage limit.';
      return;
    }
    const digest = resumeScopeDigest(record);
    const dataKey = `${RESUME_RECORD_PREFIX}${digest}`;
    try {
      const index = projectIndexKey(binding);
      const oldDigest = storage.getItem(index);
      storage.setItem(dataKey, serialized);
      storage.setItem(index, digest);
      if (oldDigest && oldDigest !== digest && /^[a-f0-9]{16}$/.test(oldDigest))
        storage.removeItem(`${RESUME_RECORD_PREFIX}${oldDigest}`);
      this.resumePersistenceWarning = undefined;
    } catch {
      this.resumePersistenceWarning =
        'Tab storage became unavailable; this player cannot resume after reload.';
    }
  }

  private clearResumeSession() {
    const binding = this.options.projectBinding;
    if (!binding) return;
    const digest = resumeScopeDigest({
      websocketUrl: this.options.websocketUrl,
      gameId: this.options.gameId,
      projectBinding: binding,
    });
    const storage = browserSessionStorage();
    if (!storage) return;
    try {
      if (storage.getItem(projectIndexKey(binding)) === digest) removeSavedResumeSession(binding, digest);
    } catch {
      // Storage can be revoked; a later read discards invalid session data.
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.permanentFailure || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(10_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectOnce().catch(() => this.scheduleReconnect());
    }, delay);
  }
}
