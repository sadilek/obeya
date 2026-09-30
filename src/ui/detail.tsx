// The unfolded card: what it is, what its worker does, and what the owner decides.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CardAction, CardEvent, CardPatch, Demo, Item, RepoRef } from '../core/types';
import { ApiError, api, at, onCardEvent } from './api';
import { Inline, plain } from './markdown';
import { errorText, stateLabel, t } from './strings';

/** What the panel does after an action: fold the card and confirm (with undo, when it has one), or stay open. */
export type ActDone = { close: true; ack: string; undo?: () => unknown } | { close: false };

interface Props {
  item: Item;
  /** Every item on the canvas, to name the cards a queued card waits for. */
  all: Item[];
  /** The canvas's repositories; with several, the card names its own and a planned one can move. */
  repos: RepoRef[];
  parent?: Item;
  /** A proposal's source card. */
  from?: Item;
  onEdit: (p: CardPatch) => void;
  /** Saves pending edits; actions wait for it, so the worker sees the card as typed. */
  flush: () => Promise<void>;
  onDelete: () => void;
  onDone: (d: ActDone) => void;
}

export function Detail(p: Props) {
  const { item, parent } = p;
  const [error, setError] = useState('');
  const all = p.all;
  const run = async (fn: () => Promise<void>, done: ActDone) => {
    setError('');
    try {
      await p.flush();
      await fn();
      p.onDone(done);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  const act = (a: CardAction, done: ActDone) => run(() => api.act(item.id, a), done);
  const repoPrefix = p.repos.length > 1 ? `${p.repos.find((r) => r.id === item.repo)?.name ?? item.repo} · ` : '';
  const kind =
    repoPrefix +
    (parent
      ? `${plain(parent.title)} · ${item.label ?? ''} · ${t.kind.workstream}`
      : item.state === 'idea'
        ? t.kind.idea
        : item.spikeOf
          ? t.kind.spike
          : t.kind[item.kind]);
  const editable = item.source === 'manual' && (item.state === 'planned' || item.state === 'idea') && !item.queue;
  if (item.state === 'idea' && item.idea)
    return (
      <>
        <div className="p-kind">{kind}</div>
        <ManualTitle item={item} onEdit={p.onEdit} />
        <IdeaView item={item} act={act} onDelete={p.onDelete} />
        {error && <p className="p-error">{error}</p>}
      </>
    );
  const worked = ['working', 'waiting', 'approved', 'inPr', 'live'].includes(item.state) && !!item.branch;

  return (
    <>
      <div className="p-kind">{kind}</div>
      {editable ? <ManualTitle item={item} onEdit={p.onEdit} /> : <div className="p-title">{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div>}
      <div className="p-state">
        ● {stateLabel(item)}
        {item.statusLine && (item.state === 'working' || item.state === 'inPr') && <span className="p-status"> · {item.statusLine}</span>}
        {item.archivedAt && <span className="p-status"> · {t.archive.when(new Date(item.archivedAt))}</span>}
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

      {item.spikeOf && <p className="hint">{t.idea.spikeOf(plain(p.from?.title ?? ''))}</p>}

      {item.state === 'planned' && !item.queue && <LastFailure cardId={item.id} />}

      {item.state === 'planned' && (
        <>
          {editable ? <ManualFields item={item} repos={p.repos} onEdit={p.onEdit} /> : <Body md={item.body} />}
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
                  {!item.spikeOf && !item.branch && (
                    <button
                      className="btn"
                      onClick={async () => {
                        await p.flush();
                        p.onEdit({ state: 'idea' });
                        await p.flush();
                      }}
                    >
                      {t.idea.makeIdea}
                    </button>
                  )}
                  <button className="btn danger" onClick={p.onDelete}>
                    {t.delete}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {item.scope && item.scope.length > 0 && (item.state === 'planned' || item.state === 'working') && (
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

      {item.state === 'waiting' && item.need === 'demo' && item.demo && (
        <DemoView cardId={item.id} summary={item.summary ?? ''} demo={item.demo}>
          {/* the decision sits beside the video, so it needs no scrolling */}
          <div className="actions">
            <button
              className="btn primary"
              onClick={() => act({ action: 'approve' }, { close: true, ack: item.spikeOf ? t.idea.discarded : t.approved })}
            >
              {item.spikeOf ? t.idea.discard : t.approve}
            </button>
          </div>
          <Composer placeholder={t.compose.review} onSend={(text) => act({ action: 'message', text }, { close: false })} />
        </DemoView>
      )}

      {item.demo && (item.state === 'inPr' || item.state === 'approved' || item.state === 'live') && (
        <DemoView cardId={item.id} summary="" demo={item.demo} autoplay={false}>
          <p className="hint">{t.demo.kept}</p>
        </DemoView>
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

      {item.pr && (item.state === 'inPr' || item.state === 'waiting') && (
        <div className="question pr">
          <h4>
            <a href={item.pr.url} target="_blank" rel="noreferrer">
              {t.pr.title(item.pr.number)} ↗
            </a>
          </h4>
          {item.pr.conflict && <div className="q-text">{t.pr.conflict}</div>}
          {item.pr.checks.length > 0 ? (
            <ul className="checks">
              {item.pr.checks.map((c) => (
                <li key={c.name} className={c.state}>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="hint">{t.pr.noChecks}</div>
          )}
        </div>
      )}
      {item.state === 'inPr' && !item.pr && <p className="hint">{t.pr.opening}</p>}

      {(item.state === 'working' || item.state === 'inPr' || (item.state === 'waiting' && item.need !== 'demo')) && (
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

      {item.state === 'live' && item.source === 'manual' && <ArchiveButton item={item} run={run} />}

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

// ------------------------------------------------------------------ ideas

/**
 * An idea under discussion: the brief its agent keeps on top, a spike's demo when there is one,
 * then the conversation, and the owner's decisions.
 */
function IdeaView({ item, act, onDelete }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void>; onDelete: () => void }) {
  const idea = item.idea!;
  const [spiking, setSpiking] = useState(false);
  return (
    <>
      <div className="p-state">
        ● {stateLabel(item)}
        {idea.thinking && <span className="p-status"> · {t.author.explorer} {t.idea.thinking}</span>}
      </div>
      {/* the brief is what stays; the conversation beside it is how it came about */}
      <div className="idea-grid">
        <div className="idea-brief">
          <div className="question brief">
            <h4>{t.idea.brief}</h4>
            {idea.brief.trim() ? <Body md={idea.brief} /> : <div className="hint">{t.idea.briefEmpty}</div>}
          </div>
          {item.demo && (
            <>
              <h4 className="p-h">{t.idea.spikeDemo}</h4>
              <DemoView cardId={item.id} summary="" demo={item.demo} autoplay={false}>
                <p className="hint">{t.idea.spikeKept}</p>
              </DemoView>
            </>
          )}
        </div>
        <div className="idea-talk">
          <Conversation item={item} />
          <Composer placeholder={t.idea.compose} onSend={(text) => act({ action: 'discuss', text }, { close: false })} />
        </div>
      </div>
      {idea.status !== 'open' && <p className="hint">{t.idea.reopen}</p>}
      {spiking ? (
        <Composer
          placeholder={t.idea.spikePlaceholder}
          button={t.idea.spikeGo}
          allowEmpty
          onSend={(text) => act({ action: 'spike', ...(text ? { text } : {}) }, { close: true, ack: t.idea.spiked })}
        />
      ) : (
        <div className="actions">
          <button className="btn primary" onClick={() => act({ action: 'build' }, { close: true, ack: t.idea.built })}>
            {t.idea.build}
          </button>
          <button className="btn" onClick={() => act({ action: 'planDoc' }, { close: true, ack: t.idea.planned })}>
            {t.idea.planDoc}
          </button>
          <button className="btn" onClick={() => setSpiking(true)}>
            {t.idea.spike}
          </button>
          {idea.status !== 'parked' && (
            <button className="btn" onClick={() => act({ action: 'park' }, { close: true, ack: t.idea.parked })}>
              {t.idea.park}
            </button>
          )}
          {idea.status !== 'dropped' && (
            <button className="btn" onClick={() => act({ action: 'drop' }, { close: true, ack: t.idea.dropped })}>
              {t.idea.drop}
            </button>
          )}
          <button className="btn danger" onClick={onDelete}>
            {t.delete}
          </button>
        </div>
      )}
    </>
  );
}

/** The discussion of an idea, live; what the agent reads shows while it thinks. */
function Conversation({ item }: { item: Item }) {
  const events = useEvents(item.id);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, item.idea?.thinking]);
  if (!events) return null;
  const shown = events.filter((e) => e.kind === 'talk' || e.kind === 'error' || (e.kind === 'state' && e.author !== 'obeya'));
  const reading = item.idea?.thinking ? events.filter((e) => e.kind === 'activity').at(-1) : undefined;
  return (
    <>
      <h4 className="p-h">{t.idea.talk}</h4>
      <div className="talk" ref={box}>
        {shown.length === 0 && !item.idea?.thinking && <div className="hint">{t.idea.talkEmpty}</div>}
        {item.body.trim() && !events.some((e) => e.kind === 'talk') && (
          <div className="msg by-owner seed">
            <div className="who">{t.idea.seed}</div>
            <Body md={item.body} />
          </div>
        )}
        {shown.map((e) =>
          e.kind === 'talk' ? (
            <div key={e.id} className={`msg by-${e.author}`}>
              <div className="who">
                {t.author[e.author]} <span className="t">{time(e.at)}</span>
              </div>
              <Body md={e.text} />
            </div>
          ) : (
            <div key={e.id} className={`note ev-${e.kind}`} title={e.code ? e.text : undefined}>
              {time(e.at)} · {eventText(e)}
            </div>
          ),
        )}
        {item.idea?.thinking && (
          <div className="msg by-explorer thinking">
            <div className="who">
              {t.author.explorer} {t.idea.thinking}
            </div>
            {reading && <div className="hint">{reading.text}</div>}
          </div>
        )}
      </div>
    </>
  );
}

/** The narrated demo with its chapters and the report beside it. */
function DemoView({ cardId, summary, demo, children, autoplay = true }: { cardId: string; summary: string; demo: Demo; children: ReactNode; autoplay?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const src = (f: string) => at(`/cards/${cardId}/demo/${f}`);
  useEffect(() => {
    // start once the card has unfolded, like the mock; a demo kept on a finished card waits to be played
    if (!autoplay) return;
    const h = setTimeout(() => video.current?.play().catch(() => {}), 500);
    return () => clearTimeout(h);
  }, []);
  const current = demo.chapters.reduce((cur, [at], i) => (at <= now + 0.05 ? i : cur), 0);
  return (
    <>
      <div className="p-grid">
        <video ref={video} controls preload="metadata" poster={src('poster.jpg')} src={src('demo.mp4')} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}>
          <track kind="captions" src={src('captions.vtt')} srcLang="de" label="Deutsch" />
        </video>
        <div>
          <ol className="chapters">
            {demo.chapters.map(([at, title], i) => (
              <li key={i}>
                <button
                  className={i === current ? 'on' : ''}
                  onClick={() => {
                    const v = video.current;
                    if (!v) return;
                    v.currentTime = at;
                    v.play().catch(() => {});
                  }}
                >
                  <span className="t">{mmss(at)}</span>
                  {title}
                </button>
              </li>
            ))}
          </ol>
          {demo.question && (
            <div className="question">
              <h4>{t.demo.question}</h4>
              {demo.question}
            </div>
          )}
          {children}
        </div>
      </div>
      <Body md={summary} />
      <div className="cols">
        {(
          [
            [t.demo.shown, demo.shown],
            [t.demo.notShown, demo.notShown],
            [t.demo.findings, demo.findings],
          ] as const
        ).map(([h, list]) => (
          <section key={h}>
            <h4>{h}</h4>
            {list.length ? (
              <ul>
                {list.map((x, i) => (
                  <li key={i}>
                    <Inline md={x} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="hint">{t.demo.none}</span>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

/** Takes a finished card into the archive, or an archived one back onto the canvas. */
function ArchiveButton({ item, run }: { item: Item; run: (fn: () => Promise<void>, done: ActDone) => Promise<void> }) {
  const title = plain(item.title);
  return (
    <div className="actions">
      {item.archivedAt ? (
        <button className="btn" onClick={() => run(() => api.unarchive(item.id), { close: true, ack: t.archive.unarchived(title) })}>
          {t.archive.unarchive}
        </button>
      ) : (
        <button
          className="btn"
          onClick={() => run(() => api.archive(item.id), { close: true, ack: t.archive.archived(title), undo: () => api.unarchive(item.id) })}
        >
          {t.archive.archive}
        </button>
      )}
    </div>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

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

function ManualFields({ item, repos, onEdit }: { item: Item; repos: RepoRef[]; onEdit: (p: CardPatch) => void }) {
  const [body, setBody] = useState(item.body);
  const [kind, setKind] = useState(item.kind as 'feature' | 'bugfix');
  const [repo, setRepo] = useState(item.repo);
  return (
    <>
      <div className="segs">
        {repos.length > 1 && (
          <div className="seg">
            {repos.map((r) => (
              <button
                key={r.id}
                className={r.id === repo ? 'on' : ''}
                onClick={() => {
                  setRepo(r.id);
                  onEdit({ repo: r.id });
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
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

function Composer({ placeholder, onSend, button = t.send, allowEmpty = false }: { placeholder: string; onSend: (text: string) => Promise<void>; button?: string; allowEmpty?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if ((!text.trim() && !allowEmpty) || busy) return;
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
      <button className="btn primary" disabled={(!text.trim() && !allowEmpty) || busy} onClick={send}>
        {button}
      </button>
    </div>
  );
}

/** A card's log, live; null while the history loads. */
function useEvents(cardId: string): CardEvent[] | null {
  const [events, setEvents] = useState<CardEvent[] | null>(null);
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
  return events;
}

/** The owner's words for a logged error: the text for its code, else the server's text. */
const eventText = (e: CardEvent) => (e.code ? errorText(e.code) : e.text);

/**
 * Why a planned card is not running: a start through the Koordinator that failed afterwards drops
 * the card back to planned, and the reason is the last entry of its log.
 */
function LastFailure({ cardId }: { cardId: string }) {
  const last = useEvents(cardId)?.at(-1);
  if (last?.kind !== 'error') return null;
  return (
    <div className="question failed">
      <h4>{t.lastFailure(time(last.at))}</h4>
      <div className="q-text" title={last.code ? last.text : undefined}>
        {eventText(last)}
      </div>
    </div>
  );
}

/** The card's log, live. */
function Log({ cardId }: { cardId: string }) {
  const events = useEvents(cardId);
  const box = useRef<HTMLDivElement>(null);
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
            <span className="x" title={e.code ? e.text : undefined}>
              {eventText(e)}
            </span>
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
