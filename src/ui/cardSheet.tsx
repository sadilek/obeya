// What the views of an open card share: how an action on it goes, its head and state line, and the
// boxes and buttons several kinds of card have.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { archiveRefusal, type CardAction, type CardPatch, finishingUp, type Item, snoozable } from '../core/types';
import { api, type Field } from './api';
import { Naming } from './cardLink';
import { plain } from './markdown';
import { shownTitle } from './parts';
import { AgentPick } from './agentPick';
import { useFitHeight } from './fitHeight';
import { contributorChoice, SnoozeMenu } from './snooze';
import { clock as time, stateLabel, t } from './strings';

/**
 * What the panel does after an action: fold the card and confirm (with undo, when it has one), or stay open.
 * With `pending`, the card folds at once, before the server has answered, and says so until it has.
 * `ackFor`: with `pending`, the confirmation as the server's answer has it, where that differs from `ack`.
 */
export type ActDone = { close: true; ack: string; ackFor?: (result: unknown) => string | undefined; undo?: () => unknown; pending?: string } | { close: false };

/** An action the server is still at, after its card has folded: the answer confirms it or tells why not. */
export type Pending = { card: string; title: string; answered: Promise<unknown> };

/** An action on the open card, after its edits are saved; a failure shows on the card. */
export type Act = (a: CardAction, done: ActDone) => Promise<void>;

/** Any call for the open card, as `Act` goes: after its edits are saved, a failure shown on the card. */
export type Run = (fn: () => Promise<unknown>, done: ActDone) => Promise<void>;

/** Words typed into a field of the card: straight to its agent where one listens, else the Coordinator reads them like spoken ones; the panel does not wait. */
export type Tell = (text: string, images: string[] | undefined, field: Field, replyTo?: number) => void;

/** The head of an open card: what kind it is (a plain task says nothing of its kind), and its title, a field to type it into where `onEdit`. */
export function CardHead({ item, kind, onEdit }: { item: Item; kind: string; onEdit?: false | ((p: CardPatch) => void) }) {
  return (
    <>
      {kind && <div className="p-kind">{kind}</div>}
      {onEdit ? <ManualTitle item={item} onEdit={onEdit} /> : <div className="p-title">{shownTitle(item)}</div>}
    </>
  );
}

/**
 * An open card's state line: its state (or `label`), what its kind adds (`children`), the usage
 * limit its agent waits for, and when it went into the archive. `paused`: it stands still.
 */
export function StateLine({ item, label, paused, children }: { item: Item; label?: string; paused?: boolean; children?: ReactNode }) {
  return (
    <div className={['p-state', finishingUp(item) && 'finishing', paused && 'paused'].filter(Boolean).join(' ')}>
      ● {label ?? stateLabel(item)}
      {children}
      {/* its agent (not its worker, which says so in its status line) waits for the usage limit, until when */}
      {item.limitedUntil && <span className="p-status"> · {t.limitedUntil(time(item.limitedUntil))}</span>}
      {item.archivedAt && <span className="p-status"> · {t.archive.when(new Date(item.archivedAt))}</span>}
    </div>
  );
}

/**
 * On an accepted proposal its agent withdrew or replaced since: who did, why, and the choice to
 * remove the card (as "Delete" does, its worker stopped, with an undo) or keep it.
 */
export function SupersededBox({ item, all, act, onDelete }: { item: Item; all: Item[]; act: Act; onDelete: () => void }) {
  const s = item.superseded;
  if (!s) return null;
  // the replacement under its title now, if it is still on the canvas
  const replacement = s.by ? all.find((x) => x.id === s.by) : undefined;
  return (
    <div className="question superseded">
      <h4>{s.by ? <Naming text={t.superseded.by} cards={[{ card: replacement, title: replacement?.title ?? s.title ?? '' }]} /> : t.superseded.withdrawn}</h4>
      {s.why && <div className="q-text">{s.why}</div>}
      <div className="actions">
        <button className="btn danger" title={t.superseded.removeHint} onClick={onDelete}>
          {t.remove}
        </button>
        <button className="btn" title={t.superseded.keepHint} onClick={() => act({ action: 'keep' }, { close: false })}>
          {t.superseded.keep}
        </button>
      </div>
    </div>
  );
}

/** On a card whose repository does not run on the canvas: no agent works on it until that is back. */
export function RepoDownBox({ item }: { item: Item }) {
  if (!item.repoDown) return null;
  // Stop, then Archive or Delete: on the owner's own tasks, not on a workstream or a prototype, which neither takes
  const stoppable = (item.state === 'working' || item.state === 'waiting' || !!item.finishing) && item.kind === 'task' && item.source === 'manual' && !item.prototypeOf;
  return (
    <div className="question repo-down">
      <div className="q-text">
        {t.repoDown.long(item.repo)}
        {stoppable && ` ${t.repoDown.stopHint}`}
      </div>
    </div>
  );
}

/**
 * "Later …" in a card's action row, on any card the owner can snooze that is not snoozed yet (a
 * snoozed one changes its time on its line in the conversation).
 */
export function Later({ item, act }: { item: Item; act: Act }) {
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
export function StartOn({ item, act, on = true, primary, children }: { item: Item; act: Act; on?: boolean; primary?: boolean; children: ReactNode }) {
  if (!on || item.kind === 'project') return <>{children}</>;
  return (
    <AgentPick item={item} act={(a) => act(a, { close: false })} {...(primary === false ? { primary } : {})}>
      {children}
    </AgentPick>
  );
}

/** "Start" in its variants (`label`, `hint`): starts the card, with the menu of what its agent runs on joined to it where `on`. */
export function StartButton({ item, act, label, hint, disabled, on }: { item: Item; act: Act; label: string; hint: string; disabled?: boolean; on?: boolean }) {
  return (
    <StartOn item={item} act={act} on={on}>
      <button className="btn primary" disabled={disabled} title={hint} onClick={() => act({ action: 'start' }, { close: false })}>
        {label}
      </button>
    </StartOn>
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

/** Deletes the card (its host gives the undo). */
export const DeleteButton = ({ onDelete }: { onDelete: () => void }) => (
  <button className="btn danger" onClick={onDelete}>
    {t.delete}
  </button>
);

/**
 * Takes a finished card or a parked or dropped idea into the archive, or an archived one back onto
 * the canvas; `className`, `label` and `hint` dress the button that archives.
 */
export function ArchiveButton({ item, run, className = 'btn', label = t.archive.archive, hint }: { item: Item; run: Run; className?: string; label?: string; hint?: string }) {
  const title = plain(item.title);
  // a stopped task whose workspace holds work stays on the canvas; the button says why
  const held = archiveRefusal(item) === 'holdsWork';
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

function ManualTitle({ item, onEdit }: { item: Item; onEdit: (p: CardPatch) => void }) {
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
