import { MultiplayerClient } from './MultiplayerClient';
import { validateMultiplayerRoomOptions, type MultiplayerRoomOptions } from './multiplayerControls';
import type {
  ClientMessage,
  MultiplayerGameState,
  MultiplayerProjectBinding,
} from '../services/multiplayerProtocol';

export type MultiplayerGameplayInput = Extract<ClientMessage, { type: 'input' }>['input'];

/** Keeps transport/reconnect and authoritative snapshot ordering out of the renderer. */
export class MultiplayerGameConnection {
  private readonly client: MultiplayerClient;
  private lastTick = -1;
  private error?: string;
  private unsubscribe?: () => void;
  private unsubscribeProtocolError?: () => void;
  private cancelJoin?: (error: Error) => void;
  private closed = false;
  constructor(
    private readonly options: MultiplayerRoomOptions,
    private readonly binding: MultiplayerProjectBinding,
    private readonly apply: (game: MultiplayerGameState, playerId: string) => void,
  ) {
    this.client = new MultiplayerClient({
      ...validateMultiplayerRoomOptions(options),
      projectBinding: binding,
    });
  }
  info() {
    return {
      state: this.client.connectionState,
      gameId: this.options.gameId,
      playerId: this.client.playerId,
      ...(this.error ? { error: this.error } : {}),
      ...(this.client.resumeWarning ? { resumeWarning: this.client.resumeWarning } : {}),
    };
  }
  async connect() {
    if (this.closed) throw Error('This multiplayer connection has been closed.');
    let timer: ReturnType<typeof setTimeout>;
    const firstSnapshot = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        this.error = error.message;
        this.cancelJoin = undefined;
        reject(error);
      };
      this.cancelJoin = fail;
      timer = setTimeout(
        () => fail(Error('The room did not send a playable game. Create a project-bound room.')),
        10_000,
      );
      this.unsubscribeProtocolError = this.client.onProtocolError((error) => {
        if (!this.closed) this.cancelJoin?.(error);
      });
      this.unsubscribe = this.client.onMessage((message) => {
        if (this.closed) return;
        if (message.type === 'error') {
          this.error = `Multiplayer join failed: ${message.code}.`;
          this.cancelJoin?.(Error(this.error));
          return;
        }
        if (message.type !== 'snapshot' || message.serverTick <= this.lastTick) return;
        const game = message.game;
        if (!game) return;
        try {
          if (
            game.projectId !== this.binding.projectId ||
            game.revision !== this.binding.revision ||
            !this.client.playerId ||
            !game.players.some((player) => player.playerId === this.client.playerId)
          )
            throw Error(
              'This room uses a different project or revision. Open or export the room’s bound game before joining.',
            );
          if (this.lastTick === -1 && (game.entrySceneId ?? game.sceneId) !== this.binding.sceneId)
            throw Error('This room uses a different scene. Open the room’s bound scene before joining.');
          this.apply(game, this.client.playerId);
          this.lastTick = message.serverTick;
          this.error = undefined;
          clearTimeout(timer);
          this.cancelJoin = undefined;
          resolve();
        } catch (cause) {
          const error = cause instanceof Error ? cause : Error('The host snapshot could not be applied.');
          this.error = error.message;
          this.cancelJoin?.(error);
          void this.close();
        }
      });
    });
    try {
      await Promise.all([this.client.connect(), firstSnapshot]);
    } catch (error) {
      if (!this.error && error instanceof Error) this.error = error.message;
      this.cancelJoin = undefined;
      if (!this.closed) await this.close();
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }
  send(input: MultiplayerGameplayInput) {
    if (this.closed || this.client.connectionState !== 'connected') return false;
    this.client.sendInput(input);
    return true;
  }
  async close() {
    this.detach();
    await this.client.leave();
  }
  async disconnectForPageExit() {
    this.detach();
    await this.client.disconnectForPageExit();
  }
  private detach() {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeProtocolError?.();
    this.unsubscribeProtocolError = undefined;
    this.cancelJoin?.(Error('Multiplayer join was cancelled.'));
    this.cancelJoin = undefined;
  }
}
