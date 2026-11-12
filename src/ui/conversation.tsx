// A card's conversation beside what it is about: the messages, the questions its agent waits on,
// and the owner's one field under them; the card's log they are read from.

import { createContext, type CSSProperties, Fragment, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BackgroundTask, ChangeRoute, CardEvent, Demo, Item, Mock, Question, Spot } from '../core/types';
import { finished, openQuestions, parseQuestion, pausableNow, started, taskAuthor } from '../core/card';
import { mockPage } from '../core/frame';
import { mmss } from '../../plugin/skills/demo/lib/timeline.ts';
import { answerText, toggle } from './answer';
import { api, type Field, onCardEvent, onCardEventGone, onReconnect } from './api';
import type { Act, Tell } from './cardSheet';
import { PauseMark, PlayMark } from './parts';
import { holdsNotes } from '../core/queue';
import { Body, Inline } from './markdown';
import { goToMessage, Msg, Quote, Reading, tellable, useAnswer } from './message';
import { useReportedHeight } from './frame';
import { cardDraft, giveBack, questionsKey, updateDraft, useDraft } from './draft';
import { eventQuote, type Reply, setReply } from './reply';
import { RunsOn } from './agentPick';
import { Spent } from './costs';
import { CiteButton } from './cite';
import { Composer } from './composer';
import { imageUrl, Shots } from './shots';
import { useStickToEnd } from './stickToEnd';
import { dismissPlace, type Place, seekTo, usePlace, videoOf } from './spot';
import { cameInView, useSeen } from './seen';
import { SnoozeLine } from './snooze';
import { clock as time, errorText, t } from './strings';
import { worked as isWorked } from './cardState';
import { cardTalk, demoHandover, talkState, coordinatorReads, snoozeLine, type Turn, unseenTurns } from './talk';
import { WishReplyLink } from './wish';
import { claudeLoginFailed, codexLoginLost } from '../core/login';
import { CodexLogin, Reauthenticate } from './reauthenticate';
import { clip } from '../core/text';
import { DecidedChip, useUnsentDecisions } from './review';

/** The owner's first words in the discussion are the card's text (an idea said aloud): it is not shown again as the starting point. */
const opened = (events: CardEvent[], body: string) => {
  const first = events.find((e) => e.kind === 'talk');
  return first?.author === 'owner' && first.text.trim() === body.trim();
};

/**
 * A card's conversation, live: what the owner says, the agents' replies, questions and handovers,
 * and the state changes between them. How an agent got to a message (what it read and thought, its
 * status lines) folds away under that message; while it works, its latest step shows. The questions
 * it waits on stand at the end (`questions`). `past`: nobody works on the card any more.
 * `hideEmpty`: nothing shows until something was said. `onReply`: the owner can reply to a message.
 */
export function Conversation({
  item,
  questions,
  past = false,
  hideEmpty = false,
  onReply,
  draft,
}: {
  item: Item;
  questions?: ReactNode;
  past?: boolean;
  hideEmpty?: boolean;
  onReply?: (e: CardEvent) => void;
  /** The field under the conversation, which text marked in it can be quoted into. */
  draft?: string;
}) {
  const events = useCardLog();
  const box = useRef<HTMLDivElement>(null);
  const idea = item.state === 'idea' && !!item.idea;
  const question = item.kind === 'question';
  const proposal = item.state === 'proposal';
  // a paused agent's steps stay where they were, in its bubble standing still; the questions open
  // stand at the end, also while a worker's background work keeps its turn open
  const { working, paused, key } = talkState(item, past);
  // what the owner had not seen when the conversation came into view stays marked until it goes, what comes in view is seen
  const { seen, came } = useSeen(item.id, events?.at(-1)?.id);
  // on the phone the conversation opens at the first message the owner has not seen
  const away = useContext(TalkElsewhere);
  const unseenFrom = (el: HTMLElement) => {
    if (!away || !events) return null;
    const from = Math.max(seen, events.findLast((e) => e.author === 'owner')?.id ?? -1);
    return [...el.querySelectorAll<HTMLElement>('[data-ev]')].find((m) => Number(m.dataset.ev) > from) ?? null;
  };
  // what the agents say and do follows at the end only while the owner stands there, so they can read further up meanwhile
  const onScroll = useStickToEnd(box, events?.findLast((e) => e.author === 'owner')?.id, events, unseenFrom);
  const turns = useMemo(() => (events ? cardTalk(item, events, past) : null), [events, key]);
  const byId = useMemo(() => new Map(events?.map((e) => [e.id, e])), [events]);
  const fresh = useMemo(
    () => new Set(turns && events ? unseenTurns(turns, events, seen).filter((x) => !cameInView(came, x.e.id)).map((x) => x.e.id) : []),
    [turns, seen, came],
  );
  if (!events || !turns) return null;
  if (hideEmpty && !turns.shown.length && !turns.pending.length) return null;
  const by = idea ? 'explorer' : question ? 'coordinator' : 'worker';
  const agent = t.author[by];
  // no agent's message ever closes a proposal's rounds: its rework shows only what came after the owner's latest words
  const since = proposal && turns.shown.length ? events.indexOf(turns.shown.at(-1)!.e) : -1;
  const pending = proposal ? turns.pending.filter((s) => events.indexOf(s) > since) : turns.pending;
  // the demo report's question goes with the handover it came with
  // an open one stands at the end instead, where it is answered
  const handover = item.demo?.question && !(item.state === 'waiting' && item.need === 'demo' && item.question) ? demoHandover(item.demo, turns.shown) : undefined;
  // where the conversation starts: what was said to an idea, or the task an agent started on, above
  // the line that it started; a decided idea's task is its brief, and its conversation goes on
  // a workstream's task is its text in the plan doc, which stands beside the conversation
  const task = (isWorked(item) || !!item.prototypeEnd) && item.brief === undefined && item.source !== 'plan' && (!!item.body.trim() || !!item.images?.length);
  const seed = task ? (
    <Seed item={item} by={taskAuthor(item)} who={`${t.talk.opening[taskAuthor(item)]} · ${t.task}`} />
  ) : (
    idea && !past && item.body.trim() && !opened(events, item.body) && <Seed item={item} by="owner" who={t.idea.seed} />
  );
  const seedAt = task ? Math.max(0, turns.shown.findIndex((x) => started(x.e))) : 0;
  // the comments on places in the demo video Obeya holds back while the owner watches: each can be
  // deleted, and under the last the owner can send them without watching to the end
  const held = item.held ?? [];
  // the line where the card was snoozed, while it still is, offers to wake it or change the time
  // (a planned card's conversation is a past one until it starts)
  const snoozedAt = item.snoozed && (!past || item.snoozed.start) ? turns.shown.findLast((x) => snoozeLine(x.e))?.e.id : undefined;
  const explained = explainedFailure(item, events)?.id;
  // the newest text answer's "Show as walkthrough" stays in view until the owner has used it once
  const hinted = [...turns.shown, ...turns.below].findLast((x) => !x.quiet && tellable(x.e))?.e.id;
  const line = (turn: Turn) => (
    <Fragment key={turn.e.id}>
      <Line
        turn={turn}
        snoozed={turn.e.id === snoozedAt ? item : undefined}
        explained={turn.e.id === explained}
        demoQuestion={turn === handover ? item.demo : undefined}
        quoted={turn.e.replyTo ? byId.get(turn.e.replyTo) : undefined}
        fresh={fresh.has(turn.e.id) || (!!turn.then && fresh.has(turn.then.e.id))}
        onReply={onReply}
        onDelete={held.includes(turn.e.id) ? () => takeBack(item.id, turn.e) : undefined}
        hint={turn.e.id === hinted}
      />
      {turn.e.id === held.at(-1) && (
        <div className="held-note">
          {/* the agent asked a question meanwhile: they go with the answer */}
          {item.state === 'waiting' && item.need === 'question' ? (
            t.demo.heldForAnswer(held.length)
          ) : (
            <>
              {t.demo.held(held.length)}
              <button className="held-send" title={t.demo.sendNowHint} onClick={() => void api.act(item.id, { action: 'release', now: true }).catch(() => {})}>
                {t.demo.sendNow}
              </button>
            </>
          )}
        </div>
      )}
    </Fragment>
  );
  // the agent at work, with a pause beside its name; paused, it stands still with Resume
  const bubble = (
    <Msg
      by={by}
      className={paused ? 'paused' : 'thinking'}
      who={proposal ? t.revising : `${agent} ${paused ? t.pause.paused : item.pausing ? t.pause.pausingTalk : idea ? t.idea.thinking : question ? t.answer.reading : t.talk.working}`}
      head={
        paused ? (
          <button className="turn-resume" title={t.pause.resumeHint} onClick={() => turn(item.id, 'resume')}>
            <PlayMark /> {t.pause.resume}
          </button>
        ) : (
          pausableNow(item) && (
            <button className="turn-pause" title={t.pause.hint} aria-label={t.pause.button} onClick={() => turn(item.id, 'pause')}>
              <PauseMark />
            </button>
          )
        )
      }
    >
      {pending.at(-1) && <Gist text={pending.at(-1)!.text} />}
      {!paused && item.limitedUntil && <div className="hint">{t.limitedUntil(time(item.limitedUntil))}</div>}
      {!paused && <Background tasks={item.background} />}
      <Steps steps={pending} />
    </Msg>
  );
  // paused, it stands where the agent stopped, above what came after (the line that it paused, the
  // owner's words); going on again, it is at work at the end, as after a message
  const stopped = pending.at(-1)?.id;
  const after = !paused
    ? -1
    : stopped !== undefined
      ? turns.shown.findIndex((x, i) => i >= seedAt && x.e.id > stopped)
      : turns.shown.findLastIndex((x) => x.e.kind === 'state' && x.e.author === 'owner');
  const stillAt = after >= seedAt ? after : turns.shown.length;
  // how the agent came to the questions it waits on, or the steps no message came after
  const askedAt = turns.asked.at(-1)?.e.at;
  const askedSteps = (steps: CardEvent[]) =>
    steps.length > 0 && (
      <div className={`msg by-${by}`}>
        {askedAt && (
          <div className="who">
            {agent} · {t.talk.question} <span className="t">{time(askedAt)}</span>
          </div>
        )}
        <Steps steps={steps} />
      </div>
    );
  return (
    <>
      <h4 className="p-h">
        {t.talk.heading}
        <RunsOn item={item} />
        <Spent item={item} />
      </h4>
      <div className="talk conv" ref={box} onScroll={onScroll}>
        {turns.shown.length === 0 && !turns.unread.length && !working && !turns.asked.length && !seed && <div className="hint">{idea ? t.idea.talkEmpty : question ? t.question.empty : proposal ? t.reviseHint : t.talk.empty}</div>}
        {turns.shown.slice(0, seedAt).map(line)}
        {seed}
        {turns.shown.slice(seedAt, stillAt).map(line)}
        {paused && bubble}
        {turns.shown.slice(stillAt).map(line)}
        {working ? (
          <>
            {/* the questions it waits on, the owner's words it read after asking, and below them the background work the worker still runs */}
            {askedSteps(turns.asked.flatMap((x) => x.steps))}
            {questions}
            {turns.below.map(line)}
            {bubble}
            {/* Obeya's reply to what the agent passed on, until the agent's message it leads to */}
            {turns.passedOn.map(line)}
          </>
        ) : (
          !paused && askedSteps([...turns.asked.flatMap((x) => x.steps), ...turns.pending])
        )}
        {/* a card that waits for the owner, its worker's turn over: what still runs of it, without the agent at work */}
        {!working && !paused && !past && !!item.background?.length && (
          <div className={`msg by-${by} background-only`}>
            <Background tasks={item.background} />
          </div>
        )}
        {/* what the agent has not read yet stands below its work, until it reads it; comments on the
            demo video held back, until they are sent */}
        {turns.unread.map((e) =>
          held.includes(e.id) ? (
            line({ e, steps: [] })
          ) : (
            <Message key={e.id} turn={{ e, steps: [] }} unread={t.talk.unread(idea || question || proposal ? 'reply' : holdsNotes(item) ? 'start' : 'step')} onDelete={() => takeBack(item.id, e)} />
          ),
        )}
        {!working && !past && coordinatorReads(events) && <Reading />}
        {!working && questions}
        {!working && turns.below.map(line)}
      </div>
      {draft && <CiteButton box={box} draft={draft} />}
    </>
  );
}

/** Pauses the agent's turn on the card, or lets the paused agent go on; the card shows it once the server has. */
const turn = (cardId: string, action: 'pause' | 'resume') => void api.act(cardId, { action }).catch(() => {});

/**
 * Takes back words of the owner's the agent has not read (a note waiting for its next step, a
 * comment held back while the owner watches the demo): they leave the conversation, and go back
 * into the card's field when it is empty.
 */
const takeBack = (cardId: string, e: CardEvent) =>
  void api
    .act(cardId, { action: 'unsay', id: e.id })
    .then(() => giveBack(cardDraft(cardId), e.text, e.images))
    .catch(() => {});

/** Where a conversation starts, as its first message: what was said to an idea, the task an agent started on; long ones folded. */
function Seed({ item, by, who }: { item: Item; by: string; who: string }) {
  return (
    <Msg by={by} className="seed" who={who}>
      <Fold>
        <Body md={item.body} />
      </Fold>
      <Shots ids={item.images} />
    </Msg>
  );
}

/** A text shown to its first eight lines or so (or `lines`), with "more" for the rest. */
export function Fold({ children, lines }: { children: ReactNode; lines?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  return (
    <>
      <div ref={box} className={`fold${open ? '' : ' folded'}${long && !open ? ' cut' : ''}`} style={lines ? ({ '--fold-lines': lines } as CSSProperties) : undefined}>
        {children}
      </div>
      {(long || open) && (
        <button className="link fold-more" onClick={() => setOpen(!open)}>
          {open ? t.talk.less : t.talk.more}
        </button>
      )}
    </>
  );
}

/** A state change or an error between the messages, or a message. */
function Line({
  turn,
  snoozed,
  explained,
  ...rest
}: {
  turn: Turn;
  snoozed?: Item;
  explained?: boolean;
  demoQuestion?: Demo;
  quoted?: CardEvent;
  fresh?: boolean;
  onReply?: (e: CardEvent) => void;
  onDelete?: () => void;
  hint?: boolean;
}) {
  return snoozed ? (
    <SnoozeLine item={snoozed} e={turn.e} at={time(turn.e.at)} />
  ) : turn.line ? (
    <div className={`note ev-${turn.e.kind}`} title={turn.e.code ? turn.e.text : undefined}>
      {time(turn.e.at)} · <Linked text={eventText(turn.e)} />
      {turn.e.kind === 'error' && !explained && claudeLoginFailed(turn.e.text) && <Reauthenticate token={turn.e.token} />}
      {turn.e.kind === 'error' && !explained && codexLoginLost(turn.e.text) && <CodexLogin host={codexLoginLost(turn.e.text)!.host} />}
    </div>
  ) : (
    <Message turn={turn} {...rest} />
  );
}

/** A line's text with its addresses as links (the comment Obeya or the agent wrote on a pull request, say). */
function Linked({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)])/).map((part, i) =>
    i % 2 ? (
      <a key={i} className="link" href={part} target="_blank" rel="noreferrer">
        {part.replace(/^https?:\/\/(www\.)?/, '')}
      </a>
    ) : (
      part
    ),
  );
}

/** Who stands on the owner's side of the conversation: the owner, and whoever answers a question in their name. */
const ownerSide = (e: CardEvent) => e.author === 'owner' || e.kind === 'answer';

/**
 * One message of the conversation; a question with its options and what came of it, a handover with
 * its demo report's question, a reply with the handover that came next and says what changed; the owner's reply with the message it replies to (`quoted`) above it.
 * `onReply`: the owner can reply to it; `onDelete`: the owner can take it back (a comment not yet
 * sent, words not yet read); `unread`: the agent has not read it yet, and when it will; `fresh`: the
 * owner had not seen it when the conversation came into view; `hint`: the newest text answer, whose
 * "Show as walkthrough" stays in view until the owner has used it once.
 */
function Message({
  turn,
  demoQuestion,
  quoted,
  fresh,
  onReply,
  onDelete,
  unread,
  hint,
}: {
  turn: Turn;
  demoQuestion?: Demo;
  quoted?: CardEvent;
  fresh?: boolean;
  onReply?: (e: CardEvent) => void;
  onDelete?: () => void;
  unread?: string;
  hint?: boolean;
}) {
  const { e, steps } = turn;
  const q = e.kind === 'question' ? parseQuestion(e.text) : undefined;
  const answer = useAnswer(e, hint);
  return (
    <Msg
      by={ownerSide(e) ? 'owner' : e.author}
      className={[q && 'q', turn.end && `ended ${turn.end}`, fresh && 'fresh', unread ? 'unread' : onDelete && 'held'].filter(Boolean).join(' ')}
      who={`${t.author[e.author]}${e.kind === 'question' ? ` · ${t.talk.question}` : e.kind === 'review' ? ` · ${t.talk.handover}` : ''}`}
      at={e.at}
      ev={e.id}
      // an answer whose walkthrough plays before its words: the answer to reply to is still to come
      onReply={onReply && !turn.quiet && !e.answer?.live ? () => onReply(e) : undefined}
      onDelete={onDelete}
      deleteLabel={unread ? t.talk.withdraw : t.demo.unsay}
      head={answer.head}
    >
      {quoted && <Quote q={eventQuote(quoted)} />}
      {answer.continues}
      {e.spot && <SpotLink cardId={e.cardId} spot={e.spot} />}
      {!turn.quiet && <Body md={q ? q.text : (turn.words ?? e.text)} />}
      {e.wish && <WishReplyLink wish={e.wish} />}
      {q && turn.end !== 'settled' && q.options.length > 0 && (
        <ul className="q-opts">
          {q.options.map((o) => (
            <li key={o} className={(turn.picks ? turn.picks.includes(o) : turn.answer?.includes(o)) ? 'on' : ''}>
              <Inline md={o} />
            </li>
          ))}
        </ul>
      )}
      {turn.end === 'again' ? (
        <button className="hint q-end" title={t.talk.toQuoted} onMouseDown={(m) => m.preventDefault()} onClick={() => goToMessage(turn.next!, '.question.ask')}>
          {t.talk.again} ↓
        </button>
      ) : (
        turn.end && <div className="hint q-end">{t.talk[turn.end]}</div>
      )}
      {turn.then && (
        <div className="then" data-ev={turn.then.e.id}>
          <span className="then-who">
            {t.talk.handover}
            <span className="t">{time(turn.then.e.at)}</span>
          </span>
          <Body md={turn.then.e.text} />
        </div>
      )}
      {demoQuestion?.question && (
        <div className={`demo-q${demoQuestion.answer === undefined ? '' : ' answered'}`}>
          <b>{t.talk.demoQuestion}</b> {demoQuestion.question}
          {!!demoQuestion.options?.length && (
            <ul className="q-opts">
              {demoQuestion.options.map((o) => (
                <li key={o} className={demoQuestion.answer?.includes(o) ? 'on' : ''}>
                  <Inline md={o} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Mocks mocks={e.mocks} />
      {answer.files}
      <Shots ids={e.images} />
      <Steps steps={turn.then ? [...steps, ...turn.then.steps] : steps} />
      {unread && <div className="hint unread-mark">{unread}</div>}
    </Msg>
  );
}

/** The mocks of an idea's agent, side by side where there is room. */
export function Mocks({ mocks }: { mocks?: Mock[] }) {
  if (!mocks?.length) return null;
  return (
    <div className="mocks">
      {mocks.map((m, i) => (
        <MockFrame key={i} mock={m} />
      ))}
    </div>
  );
}

/**
 * One mock in the frame a worker's HTML artifact gets: its scripts run, but in an origin of its own,
 * away from Obeya's API, and connect to nothing (the empty frame Obeya serves for it, which writes
 * the page it is sent into itself). It grows to the height the mock reports, up to a limit, then scrolls.
 */
function MockFrame({ mock }: { mock: Mock }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const height = useReportedHeight(frame, 480) ?? 48;
  const page = useMemo(() => mockPage(mock.html), [mock.html]);
  return (
    <figure className="mock">
      {mock.title && <figcaption>{mock.title}</figcaption>}
      <iframe
        key={page}
        ref={frame}
        sandbox="allow-scripts"
        src="/api/mock-frame"
        onLoad={(e) => e.currentTarget.contentWindow?.postMessage({ obeyaPage: page }, '*')}
        title={mock.title || t.idea.mock}
        style={{ height }}
      />
    </figure>
  );
}

/** What the agent did on its way to a message, folded: its history. */
function Steps({ steps }: { steps: CardEvent[] }) {
  if (!steps.length) return null;
  return (
    <details className="steps">
      <summary>{t.talk.steps(steps.length)}</summary>
      <ol>
        {steps.map((s) => (
          <li key={s.id} className={`step-${s.kind}`}>
            {s.author !== 'worker' && s.author !== 'explorer' && <b>{t.author[s.author]}: </b>}
            {s.kind === 'say' || s.kind === 'closing' ? <Body md={s.text} /> : s.text}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The agent's background work that runs (a test run, a render, a watcher), each with how long it has run, the time going on. */
function Background({ tasks }: { tasks?: BackgroundTask[] }) {
  const [now, setNow] = useState(Date.now);
  const runs = !!tasks?.length;
  useEffect(() => {
    if (!runs) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runs]);
  if (!tasks?.length) return null;
  return (
    <div className="background-work">
      <span className="background-head">{t.talk.background}</span>
      <ul>
        {tasks.map((task, i) => (
          <li key={`${i}|${task.since}|${task.description}`}>
            {task.description} <span className="t">{t.talk.backgroundFor(Math.max(0, Math.floor((now - task.since) / 1000)))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const clipLine = (s: string) => {
  const line = s.split('\n').find((l) => l.trim())?.trim() ?? '';
  return clip(line, 140);
};

/** The agent's latest words, cut to their first line; under the mouse, all of them. */
function Gist({ text }: { text: string }) {
  const line = clipLine(text);
  const full = text.trim();
  if (line === full) return <div className="hint">{line}</div>;
  return (
    <div className="hint gist">
      <span className="gist-line">{line}</span>
      <span className="gist-full">{full}</span>
    </div>
  );
}

/**
 * The layout every card with a conversation shares, idea, proposal, task or question: what the card
 * is about on the left (brief, text, demo), the conversation on the right; the decisions go below
 * both. Without anything on the left (a task with no result yet, a question), the conversation
 * stands alone. `cite`:
 * the draft of the card's field, which text marked on the left can be quoted into.
 */
export function Split({ main, talk, className, cite }: { main: ReactNode; talk: ReactNode; className?: string; cite?: string | false }) {
  const box = useRef<HTMLDivElement>(null);
  // on the phone the field is in a panel of its own, which a quote brings up
  const away = useContext(TalkElsewhere);
  return (
    <div className={['split', className, !main && 'alone'].filter(Boolean).join(' ')}>
      {main && (
        <div className="split-main" ref={box}>
          {main}
        </div>
      )}
      {main && cite && <CiteButton box={box} draft={cite} anywhere onCite={away ? () => away.open(true) : undefined} />}
      <TalkColumn>{talk}</TalkColumn>
    </div>
  );
}

/**
 * Where a card's conversation goes instead of its column: the phone view's panel from below (`el`,
 * null while the panel is closed), which `open` brings up, with the cursor in the field when `focus`;
 * None on the canvas.
 */
export const TalkElsewhere = createContext<{ el: HTMLElement | null; open: (focus?: boolean) => void } | null>(null);

/** A card's conversation: in its column, or where `TalkElsewhere` puts it. `bare`: no column of its own on the canvas. */
export function TalkColumn({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const away = useContext(TalkElsewhere);
  if (away) return away.el && createPortal(children, away.el);
  return bare ? children : <div className="split-talk">{children}</div>;
}

/** The owner's one field under a conversation: words, and the options picked, go out with one Send. */
interface TalkField {
  placeholder: string;
  /** Obeya, when it reads the words rather than the card's agent. */
  listener?: string;
  /** Starts the field afresh when it changes (another question, another state). */
  key?: string;
  /**
   * The picks stand in the text, each with its question: the conversation is read later without
   * the questions beside. Without it the text is the owner's words, and the picks go apart from
   * them; the conversation marks them on the question.
   */
  quote?: boolean;
  /** Words alone go to the card's agent, or to the Coordinator that `listener` names; `replyTo`: the message they reply to. */
  onWords: (text: string, images?: string[], replyTo?: number) => Promise<void>;
  /** Picked options go to the agent with the words: `picks` holds them for each question, and with `quote` the text names them too. */
  onPicked: (text: string, picks: string[][], images?: string[], replyTo?: number) => Promise<void>;
  /** On a review card: the owner's decisions on its findings go to the agent with the words. */
  onDecided?: (text: string, findings: Record<string, ChangeRoute>, images?: string[], replyTo?: number) => Promise<void>;
}

/**
 * The field of an idea, a question card or a proposal: words alone go through `onTell` as typed into
 * `field`, to the card's agent or to the Coordinator `listener` names; words with options picked go
 * to the agent as the kind's `action`, the picks named in them.
 */
export const wordsField = (placeholder: string, onTell: Tell, field: Field, act: Act, action: 'discuss' | 'ask' | 'revise', listener?: string): TalkField => ({
  placeholder,
  listener,
  quote: true,
  onWords: async (words, images, replyTo) => onTell(words, images, field, replyTo),
  onPicked: (text, _, images, replyTo) => act({ action, text, images, ...(replyTo ? { replyTo } : {}) }, { close: false }),
});

/**
 * The right column of every card with a conversation: the conversation with the questions it waits
 * on at its end, and under it the owner's one field (none where nobody hears it). `past`: nobody
 * works on the card any more. Where the field is, the owner can reply to a message of the
 * conversation: it stands quoted above the field, and the words go out with it.
 */
export function Talk({ item, past, field }: { item: Item; past?: boolean; field?: TalkField }) {
  const picks = useOpenQuestions(item, past);
  const { questions, picked } = picks;
  const options = questions.some((q) => q.options.length > 0);
  const draft = cardDraft(item.id);
  // the demo video stands at a place: the words are about it, where the card's agent hears them
  const place = usePlace(item.id);
  const at = field && !field.listener && !options ? place : null;
  // a review card's field, where its agent hears the words: the owner's decisions on its findings go with them
  const review = !!item.contribution && !!field && !field.listener && !finished(item.state);
  const unsent = useUnsentDecisions(item);
  const decided = review ? unsent : {};
  const deciding = Object.keys(decided).length > 0;
  const send = async (words: string, images?: string[], to?: Reply['to']) => {
    const replyTo = typeof to === 'number' ? to : undefined;
    if (deciding && field!.onDecided) {
      await field!.onDecided(words.trim(), decided, images, replyTo);
      updateDraft(draft, { findings: undefined });
      return;
    }
    await (picked ? field!.onPicked(field!.quote ? answerText(questions, picks.picks, words) : words.trim(), picks.picks, images, replyTo) : field!.onWords(words, images, replyTo));
    picks.clear();
  };
  return (
    <>
      <Conversation
        item={item}
        past={past}
        onReply={field ? (e) => setReply(draft, { to: e.id, quote: eventQuote(e) }) : undefined}
        draft={field ? draft : undefined}
        questions={<Questions {...picks} />}
      />
      {field && (
        <Composer
          key={field.key}
          draft={draft}
          placeholder={options ? t.ask.words : at ? t.demo.commentAt(mmss(at.at)) : field.placeholder}
          label={options ? t.ask.send : t.send}
          allowEmpty={picked || deciding}
          obeya={field.listener}
          skills={field.listener ? undefined : item.id}
          chip={
            (at || deciding) && (
              <>
                {at && <PlaceChip cardId={item.id} place={at} />}
                {deciding && <DecidedChip item={item} decided={decided} />}
              </>
            )
          }
          onSend={send}
        />
      )}
    </>
  );
}

/** The place in the demo video the words in the field are about: its frame, time and chapter, with × to take it out. */
function PlaceChip({ cardId, place }: { cardId: string; place: Place }) {
  const frame = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const v = videoOf(cardId);
    const c = frame.current;
    if (!v?.videoWidth || !c) return;
    c.width = 64;
    c.height = Math.round((64 * v.videoHeight) / v.videoWidth);
    try {
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    } catch {}
  }, [place.at]);
  return (
    <div className="quote place" title={t.demo.place}>
      <canvas ref={frame} className="place-frame" />
      <span className="place-text">
        <b>{mmss(place.at)}</b>
        {place.chapter && ` · ${place.chapter}`}
      </span>
      <button className="quote-clear" title={t.demo.unplace} aria-label={t.demo.unplace} onMouseDown={(m) => m.preventDefault()} onClick={dismissPlace}>
        ×
      </button>
    </div>
  );
}

/** Above the owner's words in the conversation: the place in the demo video they are about; a click plays the video from there. */
function SpotLink({ cardId, spot }: { cardId: string; spot: Spot }) {
  return (
    <button className="spot" title={t.demo.toPlace} onClick={() => seekTo(cardId, spot.at, spot.demo)}>
      {spot.still && <img src={imageUrl(spot.still)} alt="" loading="lazy" />}
      <span>
        ▶ {mmss(spot.at)}
        {spot.chapter && ` · ${spot.chapter}`}
      </span>
    </button>
  );
}

/**
 * The questions the card waits on (`openQuestions`, none once nobody works on it: `past`), and the
 * options the owner picked for each; they start over when the questions change. They stand in the
 * card's draft beside its words, so they outlive closing the card and a page load. While the questions
 * are not open (the agent works on a reply), the picks wait in the draft until they are again.
 */
export function useOpenQuestions(item: Item, past = false) {
  const json = JSON.stringify(past ? [] : openQuestions(item));
  const questions = useMemo(() => JSON.parse(json) as Question[], [json]);
  const draft = cardDraft(item.id);
  const key = questionsKey(questions);
  const saved = useDraft(draft).picks;
  const picks = saved?.of === key ? saved.picks : [];
  const choose = (i: number, o: string) =>
    updateDraft(draft, (d) => {
      const was = d.picks?.of === key ? d.picks.picks : [];
      return { picks: { of: key, picks: questions.map((q, j) => (j === i ? toggle(q, was[j] ?? [], o) : (was[j] ?? []))) } };
    });
  const clear = () => updateDraft(draft, { picks: undefined });
  return { questions, picks, choose, clear, picked: picks.some((x) => x.length > 0) };
}

/** An agent's questions, each with its options as radio buttons, or checkboxes when several may be chosen. */
function Questions(p: { questions: Question[]; picks: string[][]; choose: (i: number, option: string) => void }) {
  if (!p.questions.length) return null;
  return (
    <div className="question ask">
      <h4>{p.questions.length > 1 ? t.ask.questions : t.ask.question}</h4>
      {p.questions.map((q, i) => (
        <div key={i} className="ask-q">
          <div className="q-text">
            <Body md={q.text} />
          </div>
          {q.options.length > 0 && (
            <div className={`choices ${q.multiple ? 'multiple' : 'single'}`} role={q.multiple ? 'group' : 'radiogroup'}>
              {q.multiple && <div className="hint">{t.ask.several}</div>}
              {q.options.map((o) => {
                const on = (p.picks[i] ?? []).includes(o);
                return (
                  <button
                    key={o}
                    role={q.multiple ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    className={`choice${on ? ' on' : ''}${q.pick?.options.includes(o) ? ' picked' : ''}`}
                    // a click must not take the focus: Space would then not reach push-to-talk
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => p.choose(i, o)}
                  >
                    <span>
                      <Inline md={o} />
                      {q.pick?.options.includes(o) && <span className="pick-tag">{t.ask.pick}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {q.pick?.why && <div className="hint pick-why">{t.ask.pickWhy(q.pick.why)}</div>}
        </div>
      ))}
    </div>
  );
}

/** The open card's log, as the `CardLog` around it reads it. */
const Log = createContext<CardEvent[] | null>(null);

/**
 * Loads and follows the log of the open card `id` once for everything inside that reads it
 * (`useCardLog`): its conversation, the failure above it, the phone's button for its conversation.
 */
export function CardLog({ id, children }: { id: string | undefined; children: ReactNode }) {
  return <Log.Provider value={useEvents(id)}>{children}</Log.Provider>;
}

/** The open card's log, live; null while the history loads. */
export const useCardLog = () => useContext(Log);

/** A card's log, live; null while the history loads. It loads anew once the connection is back: what was pushed meanwhile never came. */
function useEvents(cardId: string | undefined): CardEvent[] | null {
  const [events, setEvents] = useState<CardEvent[] | null>(null);
  // another card's log is not shown for a moment while this one loads
  const [of, setOf] = useState(cardId);
  if (of !== cardId) {
    setOf(cardId);
    setEvents(null);
  }
  useEffect(() => {
    if (!cardId) return;
    let alive = true;
    // lines pushed while the history loads are merged in afterwards, without those taken out meanwhile
    let loading: { early: CardEvent[]; gone: Set<number> } | null = null;
    const load = () => {
      const now = { early: [] as CardEvent[], gone: new Set<number>() };
      loading = now;
      api.events(cardId).then(
        (list) => {
          if (!alive || loading !== now) return;
          loading = null;
          // what came meanwhile is newer than what the history says of the same line
          const fresh = new Map(now.early.map((e) => [e.id, e]));
          const seen = new Set(list.map((e) => e.id));
          setEvents([...list.map((e) => fresh.get(e.id) ?? e), ...now.early.filter((e) => !seen.has(e.id))].filter((e) => !now.gone.has(e.id)));
        },
        () => {
          // the connection went again: the next one loads it
          if (loading === now) loading = null;
        },
      );
    };
    const off = onCardEvent((e) => {
      if (e.cardId !== cardId) return;
      // a line comes again once it changed (the agent read the owner's words)
      const known = (list: CardEvent[]) => [...list.filter((x) => x.id !== e.id), e].sort((a, b) => a.id - b.id);
      loading?.early.push(e);
      setEvents((cur) => cur && (cur.some((x) => x.id === e.id) ? known(cur) : [...cur, e]));
    });
    const offGone = onCardEventGone((c, id) => {
      if (c !== cardId) return;
      loading?.gone.add(id);
      setEvents((cur) => cur && cur.filter((x) => x.id !== id));
    });
    const offBack = onReconnect(load);
    load();
    return () => {
      alive = false;
      off();
      offGone();
      offBack();
    };
  }, [cardId]);
  return events;
}

/** The owner's words for a logged error: the text for its code, else the server's text. */
const eventText = (e: CardEvent) => (e.code ? errorText(e.code) : e.text);

/** The error the box above the conversation explains a failed start with, which offers the login there and not again in the conversation. */
const explainedFailure = (item: Item, events: CardEvent[] | null | undefined) => {
  const last = item.state === 'planned' && !item.queue ? events?.at(-1) : undefined;
  return last?.kind === 'error' ? last : undefined;
};

/**
 * Why a planned card is not running: a start through the Coordinator that failed afterwards drops
 * the card back to planned, and the reason is the last entry of its log.
 */
export function LastFailure({ item }: { item: Item }) {
  const last = explainedFailure(item, useCardLog());
  if (!last) return null;
  return (
    <div className="question failed">
      <h4>{t.lastFailure(time(last.at))}</h4>
      <div className="q-text" title={last.code ? last.text : undefined}>
        {eventText(last)}
        {claudeLoginFailed(last.text) && <Reauthenticate start token={last.token} />}
        {codexLoginLost(last.text) && <CodexLogin start host={codexLoginLost(last.text)!.host} />}
      </div>
    </div>
  );
}
