import React, { useEffect, useId, useRef, useState } from 'react';
import { apiJson } from '../services/localApi';
import type { MultiplayerProjectBinding } from '../services/multiplayerProtocol';

type RoomSummary = {
  gameId: string;
  projectBinding?: MultiplayerProjectBinding;
  maxPlayers: number;
  playerCount: number;
  reservedPlayerCount: number;
};
type CreatedRoom = RoomSummary & { credential: string; websocketUrl: string };

export default function MultiplayerRooms({
  onClose,
  projectBinding,
  onPlayCreated,
  children,
}: {
  onClose: () => void;
  projectBinding?: MultiplayerProjectBinding;
  onPlayCreated?: (room: CreatedRoom) => void;
  children?: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [created, setCreated] = useState<CreatedRoom | null>(null);
  const [maxPlayers, setMaxPlayers] = useState(16);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const refresh = async (signal?: AbortSignal) => {
    try {
      const result = await apiJson<{ rooms: RoomSummary[] }>('/api/multiplayer/rooms', { signal });
      setRooms(result.rooms);
      setError('');
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Could not load rooms.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);

  const createRoom = async () => {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const room = await apiJson<CreatedRoom>('/api/multiplayer/rooms', {
        method: 'POST',
        body: JSON.stringify({ maxPlayers, ...(projectBinding ? { projectBinding } : {}) }),
      });
      setCreated(room);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create a room.');
    } finally {
      setBusy(false);
    }
  };

  const deleteRoom = async (gameId: string) => {
    setBusy(true);
    setError('');
    try {
      await apiJson(`/api/multiplayer/rooms/${encodeURIComponent(gameId)}`, { method: 'DELETE' });
      setDeleteId(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not close the room.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="studio-dialog studio-multiplayer-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="studio-multiplayer-heading">
        <div>
          <h2 id={titleId}>Multiplayer rooms</h2>
          <p>
            {projectBinding
              ? `Rooms created here bind to ${projectBinding.projectId} at revision ${projectBinding.revision}, scene ${projectBinding.sceneId}.`
              : 'Create and manage transport rooms for your game sessions.'}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close multiplayer rooms">
          Close
        </button>
      </header>

      <section className="studio-multiplayer-create" aria-label="Create room">
        <label>
          Player limit
          <input
            type="number"
            min={1}
            max={128}
            step={1}
            value={maxPlayers}
            onChange={(event) => setMaxPlayers(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="studio-primary"
          disabled={busy || !Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 128}
          onClick={() => void createRoom()}
        >
          Create room
        </button>
      </section>

      {created && (
        <section className="studio-multiplayer-created" role="status">
          <strong>Room created. Save this credential now.</strong>
          <p>It is shown once and will be lost when this panel closes.</p>
          <label>
            Room credential
            <input
              type="text"
              readOnly
              value={created.credential}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="One-time room credential"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              if (!navigator.clipboard?.writeText) {
                setError('Clipboard access is unavailable. Select and copy the credential instead.');
                return;
              }
              void navigator.clipboard
                .writeText(created.credential)
                .then(() => setCopied(true))
                .catch(() => setError('Clipboard access failed. Select and copy the credential instead.'));
            }}
          >
            {copied ? 'Copied' : 'Copy credential'}
          </button>
          <dl>
            <div>
              <dt>Room ID</dt>
              <dd>{created.gameId}</dd>
            </div>
            <div>
              <dt>WebSocket</dt>
              <dd>{created.websocketUrl}</dd>
            </div>
            {created.projectBinding && (
              <div>
                <dt>Project</dt>
                <dd>
                  {created.projectBinding.projectId} · r{created.projectBinding.revision} · scene{' '}
                  {created.projectBinding.sceneId}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <section className="studio-multiplayer-list" aria-label="Active rooms">
        <div className="studio-multiplayer-list-heading">
          <h3>Active rooms</h3>
          <button type="button" disabled={busy || loading} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {loading ? (
          <p>Loading rooms…</p>
        ) : rooms.length === 0 ? (
          <p>No rooms are running.</p>
        ) : (
          rooms.map((room) => (
            <article key={room.gameId} className="studio-multiplayer-room">
              <div>
                <strong>{room.gameId}</strong>
                <small>
                  {room.playerCount} connected · {room.reservedPlayerCount} reconnecting · {room.maxPlayers}{' '}
                  seats
                </small>
                {room.projectBinding && (
                  <small>
                    {room.projectBinding.projectId} · r{room.projectBinding.revision} · scene{' '}
                    {room.projectBinding.sceneId}
                  </small>
                )}
              </div>
              {deleteId === room.gameId ? (
                <span className="studio-multiplayer-confirm">
                  <small>Disconnect everyone?</small>
                  <button type="button" disabled={busy} onClick={() => void deleteRoom(room.gameId)}>
                    Close room
                  </button>
                  <button type="button" disabled={busy} onClick={() => setDeleteId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" disabled={busy} onClick={() => setDeleteId(room.gameId)}>
                  Close
                </button>
              )}
            </article>
          ))
        )}
      </section>

      {created?.projectBinding && onPlayCreated && (
        <button type="button" className="studio-primary" onClick={() => onPlayCreated(created)}>
          Play this room
        </button>
      )}
      {children}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      <p className="studio-multiplayer-note">
        Loopback rooms are reachable from this computer only. Remote players need a host configured with TLS
        and network access. Project-bound rooms run the saved game on the host; everyone joins the same
        revision.
      </p>
    </dialog>
  );
}
