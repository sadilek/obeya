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
 * The button; nothing where the dialog isn't offered (the server says, for this browser). A chosen
 * folder goes to `onPick`; cancelling the dialog changes nothing. `onOpen` as the dialog opens (what
 * an earlier attempt said no longer holds), `onError` with what went wrong.
 */
export function FolderPick({ prompt, onPick, onOpen, onError }: { prompt: string; onPick: (path: string) => void; onOpen: () => void; onError: (e: unknown) => void }) {
  const [here, setHere] = useState(false);
  useEffect(() => {
    let live = true;
    void pickerHere().then((p) => live && setHere(p));
    return () => {
      live = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  if (!here) return null;
  const pick = async () => {
    setOpen(true);
    onOpen();
    try {
      const { path } = await api.setupPick(prompt);
      if (path) onPick(path);
    } catch (e) {
      onError(e);
    }
    setOpen(false);
  };
  return (
    <button type="button" className="btn small folder-pick" disabled={open} onClick={pick}>
      {t.setup.first.pick}
    </button>
  );
}
