// The host side of an open card, the same on the canvas and in the phone view: what the owner types
// into it is saved shortly after typing stops, and an action that closes it is confirmed above the
// microphone.

import { useEffect, useRef } from 'react';
import type { CardPatch } from '../core/types';
import { api, ApiError, beforeReload, failText } from './api';
import type { ActDone, Pending } from './cardSheet';
import { t } from './strings';

/** How long after the last keystroke an edit of the open card is saved. */
const EDIT_MS = 400;

/**
 * Edits of the open card (`openId`), saved `EDIT_MS` after typing stops, before a reload and when the
 * page leaves the card's canvas. `flush` saves them at once (actions on the card wait for it), `drop`
 * forgets them (the card is deleted).
 */
export function useCardEdits(openId: () => string | null | undefined) {
  const edit = useRef<{ id: string; patch: CardPatch; timer?: ReturnType<typeof setTimeout> } | null>(null);
  /** Saves what was typed into the open card; actions on it wait for this. */
  const flush = (): Promise<void> => {
    const e = edit.current;
    if (!e) return Promise.resolve();
    clearTimeout(e.timer);
    edit.current = null;
    return Object.keys(e.patch).length ? api.patch(e.id, e.patch) : Promise.resolve();
  };
  const onEdit = (p: CardPatch) => {
    const id = openId();
    if (!id) return;
    if (edit.current?.id !== id) flush().catch(console.error);
    const e = (edit.current ??= { id, patch: {} });
    Object.assign(e.patch, p);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => flush().catch(console.error), EDIT_MS);
  };
  const drop = () => {
    if (edit.current) clearTimeout(edit.current.timer);
    edit.current = null;
  };
  useEffect(() => {
    const off = beforeReload(() => void flush().catch(console.error));
    return () => {
      off();
      flush().catch(console.error);
    };
  }, []);
  return { onEdit, flush, drop };
}

/**
 * After an action on the open card: `close` folds it, and the confirmation follows; an action the
 * server is still at says so until it answered, and the card counts as under way meanwhile
 * (`underway` with what it says, `null` once a refusal puts it back as it was).
 */
export function followDone(
  d: ActDone,
  p: Pending | undefined,
  to: { close: () => unknown; showAck: (text: string, undo?: () => unknown) => void; showWait: (text: string) => void; underway: (card: string, what: string | null) => void },
) {
  if (!d.close) return;
  to.close();
  if (!p || !d.pending) return to.showAck(d.ack, d.undo);
  const what = d.pending;
  to.underway(p.card, what);
  to.showWait(`${what.charAt(0).toUpperCase()}${what.slice(1)}`);
  p.answered.then(
    (r) => to.showAck(d.ackFor?.(r) ?? d.ack, d.undo),
    (e) => {
      if (!(e instanceof ApiError)) console.error(e);
      to.underway(p.card, null);
      to.showAck(t.cardError(p.title, failText(e)));
    },
  );
}
