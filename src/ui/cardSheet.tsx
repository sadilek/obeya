// What the views of an open card share: how an action on it goes, its title and state line, and the
// buttons several kinds of card have.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type CardAction, type CardPatch, type Item, snoozable, stopped, stoppedArchivable } from '../core/types';
import { api, type Field } from './api';
import { plain } from './markdown';
import { AgentPick } from './agentPick';
import { useFitHeight } from './fitHeight';
import { contributorChoice, SnoozeMenu } from './snooze';
import { clock as time, t } from './strings';


/**
 * What the panel does after an action: fold the card and confirm (with undo, when it has one), or stay open.
 * With `pending`, the card folds at once, before the server has answered, and says so until it has.
 */
/** `ackFor`: with `pending`, the confirmation as the server's answer has it, where that differs from `ack`. */
export type ActDone = { close: true; ack: string; ackFor?: (result: unknown) => string | undefined; undo?: () => unknown; pending?: string } | { close: false };

/** An action the server is still at, after its card has folded: the answer confirms it or tells why not. */
export type Pending = { card: string; title: string; answered: Promise<unknown> };

/** Words typed into a field of the card: straight to its agent where one listens, else the Coordinator reads them like spoken ones; the panel does not wait. */
export type Tell = (text: string, images: string[] | undefined, field: Field, replyTo?: number) => void;

/** Beside the card's state: its agent (not its worker, which says so in its status line) waits for the usage limit, until when. */
export const Limited = ({ item }: { item: Item }) => (item.limitedUntil ? <span className="p-status"> · {t.limitedUntil(time(item.limitedUntil))}</span> : null);

/** When the card went into the archive, after its state. */
export const archivedOn = (i: Item) => i.archivedAt && <span className="p-status"> · {t.archive.when(new Date(i.archivedAt))}</span>;

/**
 * "Later …" in a card's action row, on any card the owner can snooze that is not snoozed yet (a
 * snoozed one changes its time on its line in the conversation).
 */
export function Later({ item, act }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void> }) {
  if (!snoozable(item) || item.snoozed) return null;
  return (
    <SnoozeMenu
      label={t.snooze.button}
      also={contributorChoice(item, () => void act({ action: 'awaitContributor' }, { close: false }))}
      onSnooze={(until) => void act({ action: 'snooze', until }, { close: false })}
    />
  );
}

/** A button that starts the card (`children`), with the menu of what its agent runs on joined to it where `on`. */
export function StartOn({ item, act, on = true, primary, children }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void>; on?: boolean; primary?: boolean; children: ReactNode }) {
  if (!on || item.kind === 'project') return <>{children}</>;
  return (
    <AgentPick item={item} act={(a) => act(a, { close: false })} {...(primary === false ? { primary } : {})}>
      {children}
    </AgentPick>
  );
}

/** A go clicked while an agent works on the card ("Build it like this", "Accept and start"): it waits armed until the agent is done, its take-back beside it. */
export function Armed({ label, undo, onUndo }: { label: string; undo: string; onUndo: () => void }) {
  return (
    <>
      <button className="btn primary armed" disabled aria-pressed>
        {label}
      </button>
      <button className="btn" onClick={onUndo}>
        {undo}
      </button>
    </>
  );
}

export type Run = (fn: () => Promise<void>, done: ActDone) => Promise<void>;

/**
 * Takes a finished card or a parked or dropped idea into the archive, or an archived one back onto
 * the canvas; `className`, `label` and `hint` dress the button that archives.
 */
export function ArchiveButton({ item, run, className = 'btn', label = t.archive.archive, hint }: { item: Item; run: Run; className?: string; label?: string; hint?: string }) {
  const title = plain(item.title);
  // a stopped task whose workspace holds work stays on the canvas; the button says why
  const held = stopped(item) && !stoppedArchivable(item);
  return item.archivedAt ? (
    <button className="btn" onClick={() => run(() => api.unarchive(item.id), { close: true, ack: t.archive.unarchived(title) })}>
      {t.archive.unarchive}
    </button>
  ) : (
    <button className={className} disabled={held} title={held ? t.archive.holdsWork : hint} onClick={() => run(() => api.archive(item.id), { close: true, ack: t.archive.archived(title), undo: () => api.unarchive(item.id) })}>
      {label}
    </button>
  );
}

export function ManualTitle({ item, onEdit }: { item: Item; onEdit: (p: CardPatch) => void }) {
  // a local draft: the server echo must not overwrite what is being typed
  const [title, setTitle] = useState(item.title);
  // one line of text that wraps: a long title shows in full instead of running out of the box
  const ref = useRef<HTMLTextAreaElement>(null);
  useFitHeight(ref, title);
  // the title Obeya gave the card while it is open shows, unless the owner has typed in the field
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current && !title && item.title) setTitle(item.title);
  }, [item.title]);
  return (
    <textarea
      ref={ref}
      className="p-title"
      rows={1}
      value={title}
      placeholder={t.titleOptional}
      maxLength={200}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      onChange={(e) => {
        const v = e.target.value.replace(/\s*\n\s*/g, ' ');
        typed.current = true;
        setTitle(v);
        onEdit({ title: v });
      }}
    />
  );
}
