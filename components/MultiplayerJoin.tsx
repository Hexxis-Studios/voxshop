import React, { useEffect, useState } from 'react';
import type { GameViewport } from '../runtime/GameViewport';
import {
  describeMultiplayerConnection,
  multiplayerErrorMessage,
  validateMultiplayerRoomOptions,
  type MultiplayerConnectionInfo,
} from '../runtime/multiplayerControls';

export type MultiplayerJoinViewport = Pick<
  GameViewport,
  'joinMultiplayerRoom' | 'leaveMultiplayerRoom' | 'multiplayerInfo'
>;

export default function MultiplayerJoin({ viewport }: { viewport: MultiplayerJoinViewport }) {
  const [websocketUrl, setWebsocketUrl] = useState('');
  const [gameId, setGameId] = useState('');
  const [credential, setCredential] = useState('');
  const [resumeAfterReload, setResumeAfterReload] = useState(false);
  const [showCredential, setShowCredential] = useState(false);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<MultiplayerConnectionInfo>(() => viewport.multiplayerInfo());

  useEffect(() => {
    const refresh = () => setInfo(viewport.multiplayerInfo());
    refresh();
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [viewport]);

  const join = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    let options;
    try {
      options = validateMultiplayerRoomOptions({ websocketUrl, gameId, credential, resumeAfterReload });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the room details and try again.');
      return;
    }
    setJoining(true);
    try {
      await viewport.joinMultiplayerRoom(options);
      setCredential('');
      setShowCredential(false);
      setInfo(viewport.multiplayerInfo());
    } catch (cause) {
      setError(multiplayerErrorMessage(cause, 'Could not join the multiplayer room.'));
    } finally {
      setJoining(false);
    }
  };

  const leave = async () => {
    setError('');
    setLeaving(true);
    try {
      await viewport.leaveMultiplayerRoom();
      setInfo(viewport.multiplayerInfo());
    } catch (cause) {
      setError(multiplayerErrorMessage(cause, 'Could not leave the multiplayer room.'));
    } finally {
      setLeaving(false);
    }
  };

  const active = info.state !== 'disconnected';

  return (
    <section className="studio-multiplayer-join" aria-label="Join multiplayer room">
      <h3>Multiplayer</h3>
      <p>Offline play is the default. Enter details from your room host to join a shared session.</p>
      <form method="post" onSubmit={(event) => void join(event)}>
        <label>
          WebSocket address
          <input
            type="url"
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            placeholder="wss://host.example/multiplayer"
            value={websocketUrl}
            onChange={(event) => setWebsocketUrl(event.target.value)}
          />
        </label>
        <label>
          Room ID
          <input
            type="text"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            value={gameId}
            onChange={(event) => setGameId(event.target.value)}
          />
        </label>
        <label>
          Room credential
          <span className="studio-multiplayer-join-secret">
            <input
              type={showCredential ? 'text' : 'password'}
              maxLength={43}
              autoComplete="off"
              spellCheck={false}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" onClick={() => setShowCredential((shown) => !shown)}>
              {showCredential ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>
        <label className="studio-checkbox-field">
          <input
            type="checkbox"
            checked={resumeAfterReload}
            onChange={(event) => setResumeAfterReload(event.target.checked)}
          />
          Resume this player after a reload in this tab
        </label>
        <div className="studio-multiplayer-join-actions">
          <button type="submit" className="studio-primary" disabled={joining || leaving || active}>
            {info.state === 'connecting' ? 'Joining…' : 'Join room'}
          </button>
          <button type="button" disabled={leaving || !active} onClick={() => void leave()}>
            Leave room
          </button>
        </div>
      </form>
      <p role="status" aria-live="polite">
        {describeMultiplayerConnection(info)}
      </p>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
