// The inbox: what waits for the owner on every canvas, slid out from the bar's „brauchen dich“.
// Each entry names its canvas small, its card large and what it waits for lighter; the buttons
// answer it in one click, and „Zur Karte“ is always there, never the primary one.

import { answerText } from './answer';
import type { InboxEntry } from '../core/inbox';
import type { CardAction } from '../core/types';
import { Docked } from './docked';
import { Inline, plain } from './markdown';
import { clock, shortDay, t } from './strings';

/** One click on an entry: the action, what the owner reads once it went through, and whether it is the entry's default. */
export interface QuickReply {
  label: string;
  action: CardAction;
  ack: string;
  /** What the server is at meanwhile, where the action takes a while (a landing). */
  wait?: string;
  primary?: true;
  title?: string;
}

/** The buttons that answer an entry without opening its card; the one that is its default is primary, and only one is. */
export function quickReplies(e: InboxEntry): QuickReply[] {
  if (e.options) {
    const q = { text: e.text, options: e.options };
    return e.options.map((o) => ({
      label: o,
      action: { action: 'answer', text: answerText([q], [[o]], ''), picks: [o] },
      ack: t.inbox.answeredWith(o),
      ...(o === e.pick ? { primary: true as const, title: t.inbox.pickHint } : {}),
    }));
  }
  if (e.kind === 'demo' || e.kind === 'review')
    return [
      e.contribution
        ? { label: t.review.merge(e.contribution), action: { action: 'approve' }, ack: t.review.merged(e.contribution), wait: t.review.merging, primary: true }
        : e.noChange
          ? { label: t.approveNoChange, action: { action: 'approve' }, ack: t.approvedNoChange, primary: true }
          : { label: t.approve, action: { action: 'approve' }, ack: t.approved, wait: t.approving, primary: true },
    ];
  if (e.kind === 'proposal')
    return [
      ...(e.asks ? [] : [{ label: t.accept, action: { action: 'accept' } as CardAction, ack: t.accepted, primary: true as const }]),
      { label: t.dismiss, action: { action: 'dismiss' }, ack: t.dismissed },
    ];
  if (e.kind === 'superseded')
    return [
      { label: t.superseded.keep, action: { action: 'keep' }, ack: t.superseded.keep, primary: true, title: t.superseded.keepHint },
      { label: t.superseded.remove, action: { action: 'dismiss' }, ack: t.dismissed, title: t.superseded.removeHint },
    ];
  return [];
}

/** The key an entry is known by: what the owner already acted on stays out of the list until the server has caught up. */
export const entryKey = (e: InboxEntry) => `${e.canvas}/${e.card ?? 'obeya'}/${e.kind}`;

/** When it began waiting: the time today, else the day. */
const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : shortDay(iso));

const CanvasIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5c0 4-6 3-10 6" />
  </svg>
);

export function Inbox({
  entries,
  on,
  onGo,
  onReply,
}: {
  entries: InboxEntry[];
  on: boolean;
  onGo: (e: InboxEntry) => void;
  onReply: (e: InboxEntry, r: QuickReply) => void;
}) {
  return (
    <Docked id="inbox" on={on} label={t.inbox.title}>
      <h2>{t.inbox.title}</h2>
      {entries.length === 0 ? (
        <p className="empty-inbox">{t.inbox.empty}</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <li key={entryKey(e)} className={`k-${e.kind}`}>
              <div className="where">
                <CanvasIcon />
                <span className="canvas">{e.canvasName}</span>
                <span className="since">{when(e.since)}</span>
              </div>
              <div className="ttl">{e.kind === 'obeya' ? t.koordinator.title : <Inline md={e.title} />}</div>
              {e.text && <div className="text">{e.kind === 'obeya' ? plain(e.text) : <Inline md={e.text} />}</div>}
              <div className="replies">
                {quickReplies(e).map((r) => (
                  <button key={r.label} className={r.primary ? 'btn primary' : 'btn'} title={r.title} onClick={() => onReply(e, r)}>
                    {r.label}
                  </button>
                ))}
                <button className="btn" onClick={() => onGo(e)}>
                  {e.kind === 'obeya' ? t.inbox.goToObeya : t.inbox.goToCard}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Docked>
  );
}
