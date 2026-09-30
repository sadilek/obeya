// The unfolded card: what it is, what its worker does, and what the owner decides.

import { useEffect, useRef, useState } from 'react';
import type { CardAction, CardEvent, CardPatch, Item } from '../core/types';
import { api, onCardEvent } from './api';
import { Inline, plain } from './markdown';
import { stateLabel, t } from './strings';

/** What the panel does after an action: fold the card and confirm, or stay open. */
export type ActDone = { close: true; ack: string } | { close: false };

interface Props {
  item: Item;
  /** Every item on the canvas, to name the cards a queued card waits for. */
  all: Item[];
  parent?: Item;
  /** A proposal's source card. */
  from?: Item;
  onEdit: (p: CardPatch) => void;
  onDelete: () => void;
  onDone: (d: ActDone) => void;
}

export function Detail(p: Props) {
  const { item, parent } = p;
  const [error, setError] = useState('');
  const all = p.all;
  const act = async (a: CardAction, done: ActDone) => {
    setError('');
    try {
      await api.act(item.id, a);
      p.onDone(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const kind = parent ? `${plain(parent.title)} · ${item.label ?? ''} · ${t.kind.workstream}` : t.kind[item.kind];
  const editable = item.source === 'manual' && item.state === 'planned' && !item.queue;
  const worked = ['working', 'waiting', 'approved', 'inPr', 'live'].includes(item.state) && !!item.branch;

  return (
    <>
      <div className="p-kind">{kind}</div>
      {editable ? <ManualTitle item={item} onEdit={p.onEdit} /> : <div className="p-title">{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div>}
      <div className="p-state">
        ● {stateLabel(item)}
        {item.statusLine && (item.state === 'working' || item.state === 'waiting') && <span className="p-status"> · {item.statusLine}</span>}
      </div>

      {item.state === 'proposal' && (
        <>
          <Body md={item.body} />
          {p.from && <p className="hint">{t.proposedBy(plain(p.from.title))}</p>}
          <div className="actions">
            <button className="btn primary" onClick={() => act({ action: 'accept' }, { close: true, ack: t.accepted })}>
              {t.accept}
            </button>
            <button className="btn" onClick={() => act({ action: 'dismiss' }, { close: true, ack: t.dismissed })}>
              {t.dismiss}
            </button>
          </div>
        </>
      )}

      {item.state === 'planned' && item.queue && (
        <div className="question queue">
          {'checking' in item.queue || 'cutting' in item.queue ? (
            <div className="q-text">{'checking' in item.queue ? t.queue.checkingLong : t.queue.cuttingLong}</div>
          ) : (
            <>
              <div className="q-text">
                {t.queue.behind(item.queue.behind.map((id) => plain(all.find((x) => x.id === id)?.title ?? id)))} {item.queue.reason}
              </div>
              <div className="actions">
                <button className="btn" onClick={() => act({ action: 'force' }, { close: true, ack: t.queue.forced })}>
                  {t.queue.force}
                </button>
                <button className="btn" onClick={() => act({ action: 'dequeue' }, { close: false })}>
                  {t.queue.dequeue}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {item.state === 'planned' && (
        <>
          {editable ? <ManualFields item={item} onEdit={p.onEdit} /> : <Body md={item.body} />}
          {parent?.plan && <PlanSource file={parent.plan.file} />}
          {!item.queue && (
            <div className="actions">
              <button className="btn primary" onClick={() => act({ action: 'start' }, { close: false })}>
                {t.start}
              </button>
              {item.source === 'manual' && (
                <>
                  <button className="btn" onClick={() => act({ action: 'split' }, { close: false })}>
                    {t.split}
                  </button>
                  <button className="btn danger" onClick={p.onDelete}>
                    {t.delete}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {item.scope && item.scope.length > 0 && (item.state === 'planned' || item.state === 'working' || item.state === 'waiting') && (
        <details className="p-task">
          <summary>
            {t.scope} ({item.scope.length})
          </summary>
          <ul className="p-files">
            {item.scope.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {item.state === 'waiting' && item.need === 'question' && item.question && (
        <div className="question">
          <h4>{t.questionFromWorker}</h4>
          <div className="q-text">{item.question.text}</div>
          {item.question.options.length > 0 && (
            <div className="opts">
              {item.question.options.map((o) => (
                <button key={o} onClick={() => act({ action: 'answer', text: o }, { close: true, ack: t.answered })}>
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {item.state === 'waiting' && item.need === 'review' && (
        <>
          <div className="question review">
            <h4>{t.summary}</h4>
            <Body md={item.summary ?? ''} />
          </div>
          <div className="actions">
            <button className="btn primary" onClick={() => act({ action: 'approve' }, { close: true, ack: t.approved })}>
              {t.approve}
            </button>
          </div>
        </>
      )}

      {(item.state === 'working' || item.state === 'waiting') && (
        <Composer
          key={`${item.state}:${item.need ?? ''}`}
          placeholder={item.need === 'question' ? t.compose.question : item.need === 'review' ? t.compose.review : t.compose.working}
          onSend={(text) =>
            item.need === 'question'
              ? act({ action: 'answer', text }, { close: true, ack: t.answered })
              : act({ action: 'message', text }, { close: false })
          }
        />
      )}

      {error && <p className="p-error">{error}</p>}

      {worked && (
        <>
          <Log cardId={item.id} />
          {item.body.trim() && (
            <details className="p-task">
              <summary>{t.task}</summary>
              <Body md={item.body} />
            </details>
          )}
          <p className="p-src">
            {t.branch} <code>{item.branch}</code>
            {parent?.plan && (
              <>
                {' · '}
                <code>{parent.plan.file}</code>
              </>
            )}
          </p>
          {(item.state === 'working' || item.state === 'waiting') && (
            <div className="actions">
              <button className="btn" onClick={() => act({ action: 'stop' }, { close: true, ack: t.stopped })}>
                {t.stop}
              </button>
            </div>
          )}
        </>
      )}

      {!worked && item.state !== 'planned' && item.state !== 'proposal' && (
        <>
          <Body md={item.body} />
          {parent?.plan && <PlanSource file={parent.plan.file} />}
        </>
      )}
    </>
  );
}

function PlanSource({ file }: { file: string }) {
  return (
    <p className="p-src">
      {t.fromPlan} <code>{file}</code>
    </p>
  );
}

// ------------------------------------------------------------------ manual cards

function ManualTitle({ item, onEdit }: { item: Item; onEdit: (p: CardPatch) => void }) {
  // a local draft: the server echo must not overwrite what is being typed
  const [title, setTitle] = useState(item.title);
  return (
    <input
      className="p-title"
      value={title}
      placeholder={t.titlePlaceholder}
      maxLength={200}
      onChange={(e) => {
        setTitle(e.target.value);
        onEdit({ title: e.target.value });
      }}
    />
  );
}

function ManualFields({ item, onEdit }: { item: Item; onEdit: (p: CardPatch) => void }) {
  const [body, setBody] = useState(item.body);
  const [kind, setKind] = useState(item.kind as 'feature' | 'bugfix');
  return (
    <>
      <div>
        <div className="seg">
          {(['feature', 'bugfix'] as const).map((k) => (
            <button
              key={k}
              className={k === kind ? 'on' : ''}
              onClick={() => {
                setKind(k);
                onEdit({ kind: k });
              }}
            >
              {t.kind[k]}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className="p-body"
        value={body}
        placeholder={t.bodyPlaceholder}
        maxLength={20000}
        onChange={(e) => {
          setBody(e.target.value);
          onEdit({ body: e.target.value });
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ talking to the worker

function Composer({ placeholder, onSend }: { placeholder: string; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSend(text.trim());
    setBusy(false);
    setText('');
  };
  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>
        {t.send}
      </button>
    </div>
  );
}

/** The card's log, live. */
function Log({ cardId }: { cardId: string }) {
  const [events, setEvents] = useState<CardEvent[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let loaded = false;
    // lines pushed while the history loads are merged in afterwards
    const early: CardEvent[] = [];
    const off = onCardEvent((e) => {
      if (e.cardId !== cardId) return;
      if (!loaded) early.push(e);
      else setEvents((cur) => (cur && !cur.some((x) => x.id === e.id) ? [...cur, e] : cur));
    });
    api.events(cardId).then((list) => {
      if (!alive) return;
      loaded = true;
      const seen = new Set(list.map((e) => e.id));
      setEvents([...list, ...early.filter((e) => !seen.has(e.id))]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [cardId]);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);
  if (!events) return null;
  return (
    <>
      <h4 className="p-h">{t.log}</h4>
      <div className="log" ref={box}>
        {events.length === 0 && <div className="hint">{t.logEmpty}</div>}
        {events.map((e) => (
          <div key={e.id} className={`ev ev-${e.kind} by-${e.author}`}>
            <span className="t">{time(e.at)}</span>
            {e.author !== 'worker' && <span className="who">{t.author[e.author]}</span>}
            <span className="x">{e.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Text from a plan doc or an agent: paragraphs, and list items as a checklist. */
export function Body({ md }: { md: string }) {
  const blocks: ({ list: { text: string; mark: string }[] } | { para: string })[] = [];
  for (const line of md.split('\n')) {
    const m = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (m) {
      const last = blocks.at(-1);
      const li = { text: m[2]!, mark: m[1] === undefined ? '' : m[1] === ' ' ? 'open' : 'done' };
      if (last && 'list' in last) last.list.push(li);
      else blocks.push({ list: [li] });
    } else if (line.trim()) blocks.push({ para: line.trim() });
  }
  return (
    <>
      {blocks.map((bl, i) =>
        'para' in bl ? (
          <p key={i} className="p-lead">
            <Inline md={bl.para} />
          </p>
        ) : (
          <ul key={i} className="p-list">
            {bl.list.map((li, j) => (
              <li key={j} className={li.mark}>
                <Inline md={li.text} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}
