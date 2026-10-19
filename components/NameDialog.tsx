import React, { useEffect, useId, useRef, useState } from 'react';

export interface NameRequest {
  title: string;
  initialValue: string;
  confirmLabel: string;
  inputLabel?: string;
  onCancel?: () => void;
  onConfirm: (name: string) => void | Promise<void>;
}

export function NameDialog({ request, onClose }: { request: NameRequest | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const inputId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cancel = () => {
    if (busy) return;
    request?.onCancel?.();
    onClose();
  };

  useEffect(() => {
    if (request) {
      setName(request.initialValue);
      setError('');
      if (!dialog.current?.open) dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [request]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      className="m-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#1a1d1f] p-6 text-slate-200 shadow-2xl backdrop:bg-black/60"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!request || !name.trim() || busy) return;
          setBusy(true);
          try {
            await request.onConfirm(name.trim());
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to save.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id={titleId} className="mb-5 text-lg font-bold">
          {request?.title}
        </h2>
        <label htmlFor={inputId} className="mb-2 block text-sm">
          {request?.inputLabel ?? 'Name'}
        </label>
        <input
          id={inputId}
          autoFocus
          required
          maxLength={256}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded-lg border border-white/20 bg-black/30 p-3 text-white focus:border-blue-400 focus:outline-none"
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-rose-300">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={cancel}
            className="rounded-lg px-4 py-2 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? 'Saving…' : request?.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
