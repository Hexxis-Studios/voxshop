export type MultiplayerRoomOptions = {
  websocketUrl: string;
  gameId: string;
  credential: string;
};

const multiplayerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const roomCredentialPattern = /^[A-Za-z0-9_-]{43}$/;

/** Validate values entered in the opt-in join form before handing them to the transport client. */
export function validateMultiplayerRoomOptions(input: MultiplayerRoomOptions): MultiplayerRoomOptions {
  const websocketUrl = input.websocketUrl.trim();
  const gameId = input.gameId.trim();
  const credential = input.credential.trim();

  let url: URL;
  try {
    url = new URL(websocketUrl);
  } catch {
    throw new Error('Enter a valid multiplayer WebSocket address.');
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use secure wss or a local ws address without embedded credentials or query parameters.');
  if (!multiplayerIdPattern.test(gameId))
    throw new Error(
      'Room ID must be 1–64 letters, numbers, underscores or hyphens and start with a letter or number.',
    );
  if (!roomCredentialPattern.test(credential))
    throw new Error('Room credential must be 43 letters, numbers, underscores or hyphens.');

  return { websocketUrl, gameId, credential };
}

export type MultiplayerConnectionInfo = {
  state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  playerId?: string;
  gameId?: string;
  error?: string;
};

export function describeMultiplayerConnection(info: MultiplayerConnectionInfo) {
  if (info.error) return presentMultiplayerError(info.error);
  if (info.state === 'connected')
    return `Connected${info.playerId ? ` as ${info.playerId}` : ''}${info.gameId ? ` · room ${info.gameId}` : ''}.`;
  if (info.state === 'connecting') return 'Joining room…';
  if (info.state === 'reconnecting') return 'Connection lost. Reconnecting…';
  return 'Offline. Multiplayer is optional.';
}

export function presentMultiplayerError(message: string) {
  const code = message.match(
    /(?:Multiplayer join failed:\s*)?(unknown-room|invalid-credential|invalid-message|room-full)\.?/i,
  )?.[1];
  switch (code) {
    case 'unknown-room':
      return 'Room ID was not found. Check the ID and try again.';
    case 'invalid-credential':
      return 'Room credential was rejected. Check it and try again.';
    case 'invalid-message':
      return 'The host rejected the room details.';
    case 'room-full':
      return 'This room is full.';
    default:
      return message;
  }
}

export function multiplayerErrorMessage(cause: unknown, fallback: string) {
  if (typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string')
    return presentMultiplayerError(cause.message);
  return fallback;
}
