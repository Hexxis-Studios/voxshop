import {
  clientMessageSchema,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '../services/multiplayerProtocol';

type JoinedMessage = Extract<ServerMessage, { type: 'joined' }>;
type GameplayInput = Extract<ClientMessage, { type: 'input' }>['input'];

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
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly protocolErrorListeners = new Set<(error: Error) => void>();

  constructor(private readonly options: { websocketUrl: string; gameId: string; credential: string }) {
    const url = new URL(options.websocketUrl);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Multiplayer URL must be local ws or use secure wss without embedded credentials.');
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
            credential: this.options.credential,
            reconnect: true,
            ...(this.resumeCredential ? { resumeCredential: this.resumeCredential } : {}),
          });
          socket.send(JSON.stringify(message));
        },
        { once: true },
      );
      socket.addEventListener('message', (event) => {
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
          settle(undefined, message);
        } else if (message.type === 'error') {
          if (
            message.code === 'unknown-room' ||
            message.code === 'invalid-credential' ||
            message.code === 'invalid-message' ||
            message.code === 'room-full'
          )
            this.permanentFailure = true;
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
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(clientMessageSchema.parse({ version: 1, type: 'leave' })));
    await new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
      socket.close(1000, 'Player left room');
    });
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
