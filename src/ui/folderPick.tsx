// „Auswählen …“ beside a folder's path: the system's folder dialog on the machine Obeya runs on,
// offered only where it has one and the browser runs there too (the dialog opens on its screen).
// One control for the setup assistant's first canvas and a repository's path in the configuration.

import { useEffect, useState } from 'react';
import { api } from './api';
import { t } from './strings';

/** Asked once per page: neither the machine's dialogs nor where the browser runs change while it is open. */
let offered: Promise<boolean> | null = null;
const pickerHere = () => (offered ??= api.setupPicker().then((r) => r.picker, () => false));

/**
 * The button; nothing where the dialog isn't offered. `available`: what the caller already knows of
 * that (the setup assistant's view), asked of the server otherwise. A chosen folder goes to `onPick`;
 * cancelling the dialog changes nothing.
 */
export function FolderPick({ prompt, available, onPick, onError }: { prompt: string; available?: boolean; onPick: (path: string) => void; onError?: (e: unknown) => void }) {
  const [asked, setAsked] = useState<boolean | null>(null);
  useEffect(() => {
    if (available !== undefined) return;
    let live = true;
    void pickerHere().then((p) => live && setAsked(p));
    return () => {
      live = false;
    };
  }, [available]);
  const [open, setOpen] = useState(false);
  if (!(available ?? asked)) return null;
  const pick = async () => {
    setOpen(true);
    try {
      const { path } = await api.setupPick(prompt);
      if (path) onPick(path);
    } catch (e) {
      onError?.(e);
    }
    setOpen(false);
  };
  return (
    <button type="button" className="btn small folder-pick" disabled={open} onClick={pick}>
      {t.setup.first.pick}
    </button>
  );
}
