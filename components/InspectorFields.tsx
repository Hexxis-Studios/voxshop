import { useRef } from 'react';

export function TextField({
  label,
  value,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  maxLength?: number;
  onChange: (v: string) => void;
}) {
  return (
    <label className="studio-field">
      {label}
      <input maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="studio-field">
      {label}
      <input
        type="number"
        step="any"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export function VectorField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
  min?: number;
  max?: number;
}) {
  return (
    <fieldset className="studio-vector">
      <legend>{label}</legend>
      {['X', 'Y', 'Z'].map((axis, i) => (
        <label key={axis}>
          {axis}
          <input
            aria-label={`${label} ${axis}`}
            type="number"
            step="any"
            min={min}
            max={max}
            value={value[i]}
            onChange={(e) => {
              const next = [...value] as [number, number, number];
              next[i] = Number(e.target.value);
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

export function DraftRecovery({
  kind,
  baseRevision,
  currentRevision,
  draft,
  onReload,
}: {
  kind: 'asset' | 'object';
  baseRevision: number;
  currentRevision: number;
  draft: unknown;
  onReload: () => void;
}) {
  const confirmation = useRef<HTMLDialogElement>(null);
  return (
    <section className="studio-component" role="alert">
      <strong>Project changed while you were editing this {kind}.</strong>
      <p>
        Your edits are still here. This draft uses revision {baseRevision}; the project is now at revision{' '}
        {currentRevision}. Download a recovery copy before reloading the latest {kind}.
      </p>
      <div className="studio-two studio-recovery-actions">
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = `${kind}-draft.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Download recovery copy
        </button>
        <button type="button" onClick={() => confirmation.current?.showModal()}>
          Reload latest {kind}
        </button>
      </div>
      <dialog ref={confirmation} className="studio-dialog" aria-label={`Reload latest ${kind}`}>
        <h2>Replace unsaved {kind} edits?</h2>
        <p>Reloading restores the latest saved values. Download a recovery copy first to keep your draft.</p>
        <div className="studio-two">
          <button type="button" autoFocus onClick={() => confirmation.current?.close()}>
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              confirmation.current?.close();
              onReload();
            }}
          >
            Replace with saved {kind}
          </button>
        </div>
      </dialog>
    </section>
  );
}
