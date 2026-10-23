import assert from 'node:assert/strict';
import test from 'node:test';
import { MultiplayerClient } from '../runtime/MultiplayerClient';
import { MultiplayerGameConnection } from '../runtime/MultiplayerGameConnection';

const INVALID_PROTOCOL_ERROR = 'The multiplayer server sent an invalid protocol message.';

class BrowserWebSocketMock {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: BrowserWebSocketMock[] = [];
  readonly callbackErrors: unknown[] = [];
  closeCode?: number;
  readyState = BrowserWebSocketMock.CONNECTING;
  private readonly listeners = new Map<string, Set<{ listener: (event: any) => void; once: boolean }>>();

  constructor(readonly url: string) {
    BrowserWebSocketMock.instances.push(this);
    queueMicrotask(() => {
      this.readyState = BrowserWebSocketMock.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add({ listener, once: options?.once ?? false });
    this.listeners.set(type, listeners);
  }

  send(serialized: string) {
    const message = JSON.parse(serialized);
    if (message.type !== 'join') return;
    this.emit('message', {
      data: JSON.stringify({
        version: 1,
        type: 'joined',
        gameId: 'room-1',
        playerId: 'player-1',
        resumeCredential: 'R'.repeat(43),
        nextInputSequence: 0,
      }),
    });
    this.emit('message', {
      data: JSON.stringify({ version: 1, type: 'snapshot', serverTick: 'invalid', players: [] }),
    });
  }

  close(code = 1000, reason = '') {
    if (code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException('The close code is reserved by the WebSocket protocol.', 'InvalidAccessError');
    this.closeCode = code;
    this.readyState = BrowserWebSocketMock.CLOSED;
    queueMicrotask(() => this.emit('close', { code, reason, wasClean: true }));
  }

  private emit(type: string, event: unknown) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const entry of [...listeners]) {
      if (entry.once) listeners.delete(entry);
      try {
        entry.listener(event);
      } catch (error) {
        // Browser event dispatch reports listener exceptions without throwing from dispatchEvent.
        this.callbackErrors.push(error);
      }
    }
  }
}

function installBrowserWebSocketMock() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  BrowserWebSocketMock.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: BrowserWebSocketMock,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('browser WebSocket protocol failures use an application close code and stop reconnecting', async () => {
  const restore = installBrowserWebSocketMock();
  const client = new MultiplayerClient({
    websocketUrl: 'ws://127.0.0.1:4270/multiplayer',
    gameId: 'room-1',
    credential: 'C'.repeat(43),
  });
  const protocolErrors: string[] = [];
  client.onProtocolError((error) => protocolErrors.push(error.message));
  try {
    await client.connect();
    await delay(300);
    const socket = BrowserWebSocketMock.instances[0]!;
    assert.deepEqual(
      socket.callbackErrors,
      [],
      'Browser event handlers must not throw on malformed messages.',
    );
    assert.equal(socket.closeCode, 4002, 'Protocol failures must use an application close code.');
    assert.deepEqual(protocolErrors, [INVALID_PROTOCOL_ERROR]);
    assert.equal(
      BrowserWebSocketMock.instances.length,
      1,
      'Malformed protocol data must not trigger reconnects.',
    );
  } finally {
    await client.leave();
    restore();
  }
});

test('game connection rejects a malformed first snapshot promptly and preserves its local protocol error', async () => {
  const restore = installBrowserWebSocketMock();
  const connection = new MultiplayerGameConnection(
    {
      websocketUrl: 'ws://127.0.0.1:4270/multiplayer',
      gameId: 'room-1',
      credential: 'C'.repeat(43),
    },
    { projectId: 'project-1', revision: 0, sceneId: 'main' },
    () => assert.fail('Malformed snapshots must not reach the renderer.'),
  );
  try {
    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      connection.connect().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 1000);
      }),
    ]);
    clearTimeout(timeout!);
    if (result.kind === 'timeout') await connection.close();
    assert.equal(
      result.kind,
      'rejected',
      'A protocol failure should reject before the first-snapshot timeout.',
    );
    if (result.kind !== 'rejected') return;
    assert.match((result.error as Error).message, /invalid protocol message/i);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(connection.info().error, INVALID_PROTOCOL_ERROR);
    assert.equal(BrowserWebSocketMock.instances[0]?.closeCode, 4002);
  } finally {
    await connection.close();
    restore();
  }
});
