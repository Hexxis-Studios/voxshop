import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '../services/localApi';
export default function PlaytestDialog({
  scene,
  onClose,
  onRun,
}: {
  scene: any;
  onClose: () => void;
  onRun: (spec: any) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [text, setText] = useState(
      JSON.stringify(
        { sceneId: scene.id, steps: [{ frames: 120, input: {} }], assertions: [{ type: 'no-errors' }] },
        null,
        2,
      ),
    ),
    [error, setError] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="studio-dialog" aria-labelledby="playtest-title" onCancel={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const spec = JSON.parse(text);
            if (!spec.steps || !spec.assertions) throw new Error('Include steps and assertions.');
            await onRun(spec);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <h2 id="playtest-title">Test gameplay</h2>
        <p>
          Run repeatable input and assertions on an isolated copy. This checks simulation; use Play to inspect
          visuals and controls.
        </p>
        <div className="studio-two">
          {(['exploration', 'arena', 'survival', 'construction'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() =>
                void apiJson(`/api/examples/${kind}/playtest`)
                  .then((spec) => {
                    spec.sceneId = scene.id;
                    setText(JSON.stringify(spec, null, 2));
                  })
                  .catch((e) => setError(e.message))
              }
            >
              {kind === 'arena'
                ? 'Arena scenario'
                : kind === 'survival'
                  ? 'Survival crafting scenario'
                  : kind === 'construction'
                    ? 'Construction sandbox scenario'
                    : 'Crystal trail scenario'}
            </button>
          ))}
        </div>
        <label className="studio-field">
          Playtest JSON
          <textarea
            aria-label="Playtest JSON"
            rows={17}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p>
          Use status, variable, position, enabled, active-scene, terrain-cell, inventory, health, scene-path
          and no-errors assertions. At most 18,000 fixed simulation frames per run.
        </p>
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
        <div className="studio-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="studio-primary">Run scenario</button>
        </div>
      </form>
    </dialog>
  );
}
