// The Coordinator's sheet: the conversation, with the height the sheet has, and below it sections
// that open and close: the rules it learned and proposes, with the values for repositories'
// settings the work retrospective proposes, and the owner's preferences; shared demos to bring
// up to date at once.

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Item, Preference, RepoRef, Reshare, SettingProposal, Talk, TalkQuote, TalkRef, TalkWait } from '../core/types';
import { api, failText } from './api';
import { useAct } from './act';
import { Body, Inline, plain } from './markdown';
import { AnswerFiles, Continues, Msg, Quote, Reading, ThreadCard } from './message';
import { WalkthroughButton } from './walkthrough';
import { isWalkthrough } from '../core/walkthrough';
import { type Reply, setReply, talkEv, talkQuote } from './reply';
import { clock, t } from './strings';
import { CiteButton } from './cite';
import { Composer } from './composer';
import { DictatedArea } from './dictation';
import { cardDraft, OBEYA_DRAFT } from './draft';
import { Shots } from './shots';
import { usePageVisible } from './seen';
import { useStickToEnd } from './stickToEnd';
import { useFitHeight } from './fitHeight';
import { PageChangeList } from './page-changes';
import { WishReplyLink } from './wish';
import { ClockMark } from './snooze';
import { know, read, session, useStoredState, write, useKnown } from './stored';
import { cardPath } from './address';
import { PlayMark, StopMark } from './parts';
import { CardLink, Naming } from './cardLink';

interface Props {
  on: boolean;
  /** The canvas, whose sections stay open or closed as the owner left them. */
  canvas: string;
  /** A command typed in the sheet, maybe in reply to a message of it: read like a spoken one; the conversation shows it at once. */
  onTell: (text: string, images?: string[], replyTo?: Reply['to']) => void;
  items: Item[];
  preferences: Preference[];
  /** Values for repositories' settings the work retrospective proposes. */
  settings: SettingProposal[];
  /** The canvas's repositories, whose CLAUDE.md a proposal may go into. */
  repos: RepoRef[];
  talk: Talk[];
  reshare?: Reshare;
  onOpen: (i: Item) => void;
  /** Opens the configuration dialog at a repository's setting. */
  onConfig: (repo: string, setting: string) => void;
}

export function CoordinatorSheet({ on, canvas, items, preferences, settings, repos, talk, reshare, onOpen, onTell, onConfig }: Props) {
  const proposals = preferences.filter((p) => p.state === 'proposed');
  const rules = preferences.filter((p) => p.state === 'active');
  const [folds, setFolds] = useStoredState<Folds>(`obeya-ksheet-${canvas}`, {});
  // the proposals stay closed only as long as no proposal came after the owner closed them; a setting's id counts negative beside the rules'
  const ids = [...proposals.map((p) => p.id), ...settings.map((p) => -p.id)];
  const proposalsOpen = !folds.proposalsClosed || ids.some((id) => !folds.proposalsClosed!.includes(id));
  return (
    <aside id="ksheet" className={on ? 'sheet on' : 'sheet'}>
      <h2>{t.coordinator.title}</h2>
      <CoordinatorTalk on={on} talk={talk} items={items} repos={repos} onOpen={onOpen} onTell={onTell} />

      <div className="k-rest">
        {ids.length > 0 && (
          <Fold
            kind="proposals"
            head={t.coordinator.proposalsHead(ids.length)}
            open={proposalsOpen}
            onToggle={() => setFolds({ ...folds, proposalsClosed: proposalsOpen ? ids : undefined })}
          >
            {proposals.length > 0 && (
              <>
                <p className="hint">{t.coordinator.proposalsHint}</p>
                <ul className="prefs proposals">
                  {proposals.map((p) => (
                    <ProposalRow key={p.id} p={p} items={items} rules={rules} repos={repos} onOpen={onOpen} />
                  ))}
                </ul>
              </>
            )}
            {settings.length > 0 && (
              <>
                <p className="hint">{t.coordinator.settingsHint}</p>
                <ul className="prefs proposals">
                  {settings.map((p) => (
                    <SettingRow key={p.id} p={p} items={items} repo={repos.find((r) => r.id === p.repo)} onOpen={onOpen} onConfig={() => onConfig(p.repo, p.field)} />
                  ))}
                </ul>
              </>
            )}
          </Fold>
        )}

        {reshare && <ReshareBox r={reshare} items={items} onOpen={onOpen} />}

        <Fold head={t.coordinator.preferencesHead(rules.length)} open={!!folds.preferences} onToggle={() => setFolds({ ...folds, preferences: !folds.preferences })}>
          <p className="hint">{t.coordinator.preferencesHint}</p>
          <ul className="prefs">
            {rules.map((p) => (
              <PreferenceRow key={p.id} p={p} />
            ))}
          </ul>
          <NewPreference repos={repos} />
        </Fold>

      </div>
    </aside>
  );
}

/**
 * Obeya's conversation with the field under it, in the sheet and in the phone view; `draft` is the
 * field's (the sidebar's, or the phone view's for this canvas). `on`: the conversation is in view,
 * so the answers waiting in it are read.
 */
export function CoordinatorTalk({ on, talk, items, repos, onOpen, onTell, draft = OBEYA_DRAFT }: Pick<Props, 'on' | 'talk' | 'items' | 'repos' | 'onOpen' | 'onTell'> & { draft?: string }) {
  const fresh = useRead(on, talk, () => api.readTalk());
  return (
    <>
      <Conversation talk={talk} fresh={fresh} items={items} onOpen={onOpen} draft={draft} />
      {/* a command in writing, for when speaking is not possible; its screenshots go to the cards it creates or concerns */}
      <Composer className="tell" draft={draft} placeholder={t.voice.typePlaceholder} obeya onSend={onTell} />
      <ReviewHint items={items} repos={repos} />
    </>
  );
}

/** Where the canvas has seen a review card or a task on a branch of the owner's: the hint on "Review PR #5" and a PR of one's own is no longer shown. */
const REVIEW_KNOWN = 'obeya-review-pr-known';

/**
 * Under Obeya's field, where a repository of the canvas is on a forge and until the owner has had a
 * review card or a task on a branch of theirs once, or closed it: one quiet line on how to have
 * someone else's pull request reviewed, and one's own taken up on its branch.
 */
function ReviewHint({ items, repos }: { items: Item[]; repos: RepoRef[] }) {
  const used = items.some((i) => i.contribution || i.adopted);
  const [closed, close] = useKnown(REVIEW_KNOWN);
  useEffect(() => {
    if (used) know(REVIEW_KNOWN);
  }, [used]);
  if (used || closed || !repos.some((r) => r.forge)) return null;
  return (
    <p className="tell-hint">
      <span>{t.review.hint}</span>
      <button
        className="tell-hint-x"
        title={t.review.hideHint}
        aria-label={t.review.hideHint}
        onClick={() => {
          close();
        }}
      >
        ×
      </button>
    </p>
  );
}

/**
 * A project's conversation with its project agent, in its sheet: what the owner asked it there or
 * asked Obeya about the project, and the answers, with the field to ask more (not once the project
 * is archived). `on`: the conversation is in view.
 */
export function ProjectTalk({ on, project, talk, items, onOpen }: { on: boolean; project: Item; talk: Talk[]; items: Item[]; onOpen: (i: Item) => void }) {
  const fresh = useRead(on, talk, (ids) => api.readTalk(ids));
  const draft = cardDraft(project.id);
  const [error, setError] = useState('');
  const end = useFollowInSheet(talk);
  // answers that waited unread (the project's card said so) are where the sheet opens, below the workstreams
  const waited = fresh[0];
  useEffect(() => {
    if (waited !== undefined) end.current?.querySelector('.msg.fresh')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [waited]);
  return (
    <section className="p-talk" ref={end}>
      <h4 className="p-h">{t.plan.askHead}</h4>
      {!talk.length && <p className="hint">{t.plan.askHint}</p>}
      <Conversation talk={talk} fresh={fresh} items={items} onOpen={onOpen} draft={draft} sheetOf={project.id} />
      {!project.archivedAt && (
        <Composer
          className="tell"
          draft={draft}
          placeholder={t.plan.askPlaceholder}
          label={t.plan.askSend}
          onSend={(text, images, replyTo) => {
            setError('');
            return api.act(project.id, { action: 'consult', text, ...(images ? { images } : {}), ...(replyTo && typeof replyTo !== 'number' ? { replyTo } : {}) }).catch((e) => setError(failText(e)));
          }}
        />
      )}
      {error && <p className="p-error">{error}</p>}
    </section>
  );
}

/**
 * The project's conversation has no scrollbar of its own: it grows in the sheet, which scrolls. What
 * the owner just asked, and an answer that comes while the field under the conversation is in view,
 * is brought into view there: the field stays in view, unless the answer is taller than the sheet,
 * whose start then stands at the sheet's top. Returns the ref of the conversation's section.
 */
function useFollowInSheet(talk: Talk[]) {
  const box = useRef<HTMLElement>(null);
  // whether the end of the conversation is in view, as the owner last scrolled the sheet
  const inView = useRef(true);
  useEffect(() => {
    const el = box.current;
    const sheet = el?.closest('.sheet');
    if (!el || !sheet) return;
    const see = new IntersectionObserver(([e]) => void (inView.current = !!e?.isIntersecting), { root: sheet });
    const field = el.querySelector('.composer') ?? el;
    see.observe(field);
    return () => see.disconnect();
  }, []);
  const last = talk.at(-1);
  // what changes once the owner asks and once an answer comes
  const key = `${last?.id}:${last?.answer !== undefined}`;
  const seen = useRef(key);
  useEffect(() => {
    if (key === seen.current) return;
    seen.current = key;
    const el = box.current;
    const sheet = el?.closest('.sheet');
    if (!el || !sheet || !inView.current) return;
    const msgs = el.querySelectorAll('.talk > .msg');
    const newest = msgs[msgs.length - 1];
    const tall = !!newest && newest.getBoundingClientRect().height > sheet.clientHeight * 0.8;
    (tall ? newest : (el.querySelector('.composer') ?? el)).scrollIntoView({ block: tall ? 'start' : 'nearest', behavior: 'smooth' });
  }, [key]);
  return box;
}

/**
 * Answers that came while the owner was elsewhere are read once the conversation is in view (its
 * sheet open, and the page not hidden); those that were waiting stay marked until it closes, so the
 * owner sees which. Those that come while it is in view are read as they come, unmarked. `read`
 * tells the server, with the ids of those read.
 */
function useRead(on: boolean, talk: Talk[], read: (ids: number[]) => Promise<unknown>): number[] {
  const [fresh, setFresh] = useState<number[]>([]);
  const visible = usePageVisible();
  const unread = talk.filter((x) => x.unread).map((x) => x.id);
  const inView = useRef(false);
  useEffect(() => {
    const was = inView.current;
    inView.current = on && visible;
    if (!on) return setFresh([]);
    if (!visible || !unread.length) return;
    if (!was) setFresh((f) => [...f, ...unread.filter((id) => !f.includes(id))]);
    read(unread).catch(() => {});
  }, [on, visible, unread.join()]);
  return fresh;
}

/** Which of the sheet's sections the owner opened, per canvas; the proposals are open unless closed, with the ones open then. */
interface Folds {
  preferences?: boolean;
  proposalsClosed?: number[];
}

/** A section under the conversation: a head with its count that opens and closes it. */
function Fold({ kind, head, open, onToggle, children }: { kind?: string; head: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={['fold', kind, open && 'open'].filter(Boolean).join(' ')}>
      <button className="fold-head" aria-expanded={open} onClick={onToggle}>
        <span className="arrow" />
        {head}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

/**
 * What the owner said to the Coordinator with no card open, and its replies; newest last. The owner
 * can reply to each message, as on a card: it stands quoted above the field, and above the words
 * that reply to it. Words written in a project's sheet went straight to its project agent, with no
 * reply of Obeya's; outside that sheet (`sheetOf`) a line names the project.
 */
function Conversation({ talk, fresh, items, onOpen, draft, sheetOf }: { talk: Talk[]; fresh: number[]; items: Item[]; onOpen: (i: Item) => void; draft: string; sheetOf?: string }) {
  const box = useRef<HTMLDivElement>(null);
  // every change on the canvas brings a new snapshot: only what the owner just said takes the
  // conversation back to its end, so they can read further up in the meantime
  const onScroll = useStickToEnd(box, talk.at(-1)?.id, talk);
  if (!talk.length) return null;
  // the newest text answer's "Show as walkthrough" stays in view until the owner has used it once
  const hinted = talk.findLast((x) => tellable(x, items))?.id;
  return (
    <div
      className="talk conv"
      ref={box}
      onScroll={onScroll}
    >
      {talk.map((x) => {
        // the owner replies to one of the exchange's messages
        const reply = (part: TalkRef['part'], by: TalkQuote['by'], text: string) => () => {
          const q = { talk: x.id, part, by, text };
          setReply(draft, { to: { talk: x.id, part }, quote: talkQuote(q) });
        };
        // a thread moved onto a Question card goes on there, while the card is on the canvas; once it
        // is done (archived) or deleted, its answers stand here again
        const card = x.movedTo ? items.find((i) => i.id === x.movedTo) : undefined;
        const asked = x.askedIn && x.askedIn !== sheetOf ? items.find((i) => i.id === x.askedIn) : undefined;
        // a card left for another canvas, built there in a new repository: a line with a link to it there
        if (x.moved)
          return (
            <div key={x.id} className="note ev-state">
              {clock(x.at)} · {t.coordinator.moved(plain(x.moved.title), x.moved.canvasName)}{' '}
              <a className="link" href={cardPath(x.moved.canvas, x.moved.card)}>
                {t.openThere}
              </a>
            </div>
          );
        return (
          <Fragment key={x.id}>
            {/* Obeya took a step up by itself, once a card it waited on got there or the answer it looked up for it came in: no words of the owner's */}
            {x.after ? (
              <div className="note ev-state">
                {clock(x.at)} · {t.coordinator.after(x.after.title, x.after.met, x.after.state)}
              </div>
            ) : x.answered ? null : (
              <Msg by="owner" who={t.author.owner} at={x.at} ev={talkEv({ talk: x.id, part: 'said' })} onReply={reply('said', 'owner', x.said)}>
                {x.replyTo && <Quote q={talkQuote(x.replyTo)} />}
                <Body md={x.said} />
                <Shots ids={x.images} />
                {x.continues && <Continues question={x.continues} reading={x.answer === undefined && !card} adds={x.addsTo} />}
                {asked && <div className="hint">{t.coordinator.askedIn(plain(asked.title))}</div>}
              </Msg>
            )}
            {x.askedIn ? null : x.heldUntil ? (
              <Msg by="coordinator" className="thinking" who={t.author.coordinator}>
                <div className="hint">{(x.heldByOutage ? t.coordinator.heldUnreachable : t.coordinator.held)(clock(x.heldUntil))}</div>
              </Msg>
            ) : x.reply === undefined ? (
              <Reading />
            ) : (
              <Msg
                by="coordinator"
                // what waited unread: the reply, unless an answer to look up follows it
                className={x.undone ? 'undone' : fresh.includes(x.id) && !x.question ? 'fresh' : undefined}
                who={t.author.coordinator}
                at={x.at}
                ev={talkEv({ talk: x.id, part: 'reply' })}
                onReply={reply('reply', 'coordinator', x.reply)}
                head={x.thread === undefined && tellable(x, items) && <WalkthroughButton of={{ talk: x.id }} hint={x.id === hinted} />}
              >
                <Body md={x.reply} />
                {x.wish && !x.undone && <WishReplyLink wish={x.wish} />}
                {x.undone && <div className="hint">{t.coordinator.undone}</div>}
                {x.waits?.map((w) => <WaitLine key={w.card} talk={x.id} wait={w} card={items.find((i) => i.id === w.card)} onOpen={onOpen} />)}
              </Msg>
            )}
            {/* a line leads to the Question card the thread goes on at */}
            {card ? (
              <div className="moved">
                <ThreadCard thread={x.thread!} card={card} onOpen={onOpen} />
              </div>
            ) : (
              <>
                {/* a question it looked up: the answer follows the acknowledgement, or the later words that went into its look-up; stopped, it waits for "Resume" */}
                {x.question && x.answer === undefined && !x.joinedInto && x.stopped && (
                  <Msg
                    by={x.askedIn ? 'project' : 'coordinator'}
                    className="paused"
                    who={`${t.author[x.askedIn ? 'project' : 'coordinator']} ${t.pause.paused}`}
                    head={
                      <button className="turn-resume" title={t.pause.resumeHint} onClick={() => void api.resumeLookUp(x.id).catch(() => {})}>
                        <PlayMark /> {t.pause.resume}
                      </button>
                    }
                  >
                    <div className="hint">{t.coordinator.lookUpStopped}</div>
                  </Msg>
                )}
                {x.question && x.answer === undefined && !x.joinedInto && !x.stopped && !x.files?.length && (
                  <Msg by={x.askedIn ? 'project' : 'coordinator'} className="thinking" who={t.author[x.askedIn ? 'project' : 'coordinator']} head={!x.movedTo && <StopLookUp talk={x.id} />}>
                    <div className="hint">{x.limitedUntil ? (x.limitedByOutage ? t.coordinator.lookUpUnreachable : t.coordinator.lookUpLimited)(clock(x.limitedUntil)) : t.coordinator.lookingUp}</div>
                  </Msg>
                )}
                {/* its walkthrough plays here from its first slide on, and plays on as the answer's words come in above it */}
                {(x.answer !== undefined || (x.question && !x.stopped && !!x.files?.length)) && (
                  <Msg
                    by={x.answerBy ?? 'coordinator'}
                    className={fresh.includes(x.id) ? 'fresh' : undefined}
                    who={t.author[x.answerBy ?? 'coordinator']}
                    ev={talkEv({ talk: x.id, part: 'answer' })}
                    onReply={x.answer !== undefined ? reply('answer', x.answerBy ?? 'coordinator', x.answer) : undefined}
                    head={
                      x.answer === undefined ? (
                        <StopLookUp talk={x.id} />
                      ) : x.thread !== undefined && (
                        <>
                          <ThreadCard thread={x.thread} onOpen={onOpen} />
                          {tellable(x, items) && <WalkthroughButton of={{ talk: x.id }} hint={x.id === hinted} />}
                        </>
                      )
                    }
                  >
                    {x.answer !== undefined ? <Body md={x.answer} /> : <div className="hint">{t.coordinator.lookingUp}</div>}
                    {x.thread !== undefined && <AnswerFiles thread={x.thread} files={x.files} />}
                  </Msg>
                )}
              </>
            )}
          </Fragment>
        );
      })}
      <CiteButton box={box} draft={draft} />
    </div>
  );
}

/**
 * Whether an exchange of the sheet has a text answer "Show as walkthrough" can tell: a looked-up
 * answer without a walkthrough (its thread not on a Question card), or a reply that only answers.
 */
const tellable = (x: Talk, items: Item[]) =>
  x.thread !== undefined
    ? x.answer !== undefined && !x.files?.some((f) => isWalkthrough(f.name)) && !(x.movedTo && items.some((i) => i.id === x.movedTo))
    : !!x.replyOnly && !!x.reply && !x.undone && !x.heldUntil;

/** On a look-up still running, faint until the pointer is on it: halts it at once; "Resume" lets it go on. */
function StopLookUp({ talk }: { talk: number }) {
  return (
    <button className="turn-pause" title={t.coordinator.stopLookUpHint} aria-label={t.pause.halt} onClick={() => void api.stopLookUp(talk).catch(() => {})}>
      <StopMark />
    </button>
  );
}

/** Under Obeya's reply: a card it waits on, to take the step it said it would take then; "Stop waiting" drops that step. */
function WaitLine({ talk, wait, card, onOpen }: { talk: number; wait: TalkWait; card: Item | undefined; onOpen: (i: Item) => void }) {
  return (
    <div className="hint wait-line">
      <span>
        <ClockMark /> <Naming text={(title) => t.coordinator.waits(title, wait.state)} cards={[{ card, title: wait.title }]} onOpen={onOpen} />
      </span>
      <button className="btn small" title={t.coordinator.unwaitHint} onClick={() => void api.unwait(talk, wait.card).catch(() => {})}>
        {t.coordinator.unwait}
      </button>
    </div>
  );
}

/** Where a rule goes: the owner's preferences or a repository's CLAUDE.md. */
function TargetPick({ value, repos, onChange }: { value: string; repos: RepoRef[]; onChange: (target: string) => void }) {
  return (
    <label className="target">
      {t.coordinator.target}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t.coordinator.targetPreferences}</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {t.coordinator.targetClaudeMd(r.name)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A rule's text being edited in place: Enter takes it, Escape leaves it as it was. */
function RuleEdit({ draft, setDraft, onEnter, onBlur }: { draft: string; setDraft: (d: string | null) => void; onEnter: () => void; onBlur?: () => void }) {
  return <DictatedArea data-esc autoFocus value={draft} rows={2} onChange={setDraft} onEnter={onEnter} onEscape={() => setDraft(null)} {...(onBlur ? { onBlur } : {})} />;
}

/**
 * A rule the Coordinator learned, with where it came from and where it goes (the preferences, or a
 * repository's CLAUDE.md): the owner accepts it, in their own words and for another place if they
 * like, or rejects it.
 */
function ProposalRow({ p, items, rules, repos, onOpen }: { p: Preference; items: Item[]; rules: Preference[]; repos: RepoRef[]; onOpen: (i: Item) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [target, setTarget] = useState(p.target ?? '');
  const { status: error, act: decide } = useAct();
  const card = p.cardId ? items.find((i) => i.id === p.cardId) : undefined;
  const replaced = p.replaces !== undefined ? rules.find((r) => r.id === p.replaces) : undefined;
  const accept = () =>
    decide(() => api.acceptProposal(p.id, draft === null || draft.trim() === p.text ? undefined : draft.trim(), target === (p.target ?? '') ? undefined : target || null));
  const quote = p.quote && (p.quote.length > 200 ? `${p.quote.slice(0, 200).trimEnd()} …` : p.quote);
  return (
    <li className="proposal">
      {draft === null ? (
        <span className="pref-text">{p.text}</span>
      ) : (
        <RuleEdit draft={draft} setDraft={setDraft} onEnter={() => draft.trim() && accept()} />
      )}
      {replaced && <span className="occasion">{t.coordinator.changes(replaced.text)}</span>}
      <span className="occasion">
        {p.review ? (
          <>
            {t.coordinator.fromReview}
            {quote && `: ${quote}`}
          </>
        ) : (
          <>
            {card && <CardLink card={card} title={card.title} onOpen={onOpen} className="from" />}
            {card && quote && ': '}
            {quote && <q>{quote}</q>}
          </>
        )}
      </span>
      <TargetPick value={target} repos={repos} onChange={setTarget} />
      <span className="pref-actions">
        <button className="btn primary" disabled={draft !== null && !draft.trim()} onClick={accept}>
          {t.coordinator.accept}
        </button>
        {draft === null ? (
          <button className="btn" onClick={() => setDraft(p.text)}>
            {t.coordinator.change}
          </button>
        ) : (
          <button className="btn" onClick={() => setDraft(null)}>
            {t.cancel}
          </button>
        )}
        <button className="btn danger" onClick={() => decide(() => api.rejectProposal(p.id))}>
          {t.coordinator.reject}
        </button>
      </span>
      {error && <span className="p-error">{error}</span>}
    </li>
  );
}

/** A cog: what a setting proposal changes is the configuration. */
function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * The value of a setting proposal as the owner edits it, kept per tab while it waits, so an edit
 * outlives closing the sheet and a page load.
 */
function useSettingDraft(id: number, proposed: string): [string, (v: string) => void] {
  const key = `obeya-setting-draft-${id}`;
  const [draft, setDraft] = useState(() => read(session, key) ?? proposed);
  return [
    draft,
    (v) => {
      setDraft(v);
      write(session, key, v === proposed ? null : v);
    },
  ];
}

/** A value as the owner reads and edits it: a list one entry a line. */
const asText = (v: string | string[]) => (Array.isArray(v) ? v.join('\n') : v);

/**
 * A value for a repository's setting the work retrospective proposes, with the cards it rests on and
 * the value it would replace: the owner takes it, as it is or changed, on this machine or into the
 * repository for everyone (neither is the default: they choose each time), or rejects it.
 */
function SettingRow({ p, items, repo, onOpen, onConfig }: { p: SettingProposal; items: Item[]; repo: RepoRef | undefined; onOpen: (i: Item) => void; onConfig: () => void }) {
  const [draft, setDraft] = useSettingDraft(p.id, asText(p.value));
  const field = useRef<HTMLTextAreaElement>(null);
  useFitHeight(field, draft);
  const { status: error, busy, act: decide } = useAct({ detail: ['settingsShare'] });
  const k = t.coordinator;
  const list = Array.isArray(p.value);
  const changed = draft.trim() !== asText(p.value);
  const edited = !changed ? undefined : list ? draft.split('\n').map((x) => x.trim()).filter(Boolean) : draft.trim();
  const take = (where: 'machine' | 'repository') => decide(() => api.takeSetting(p.id, where, edited));
  const now = p.now === undefined ? null : asText(p.now).trim();
  const branch = repo?.branch ?? 'main';
  const everyone = repo?.pullRequests ? k.forEveryonePr(branch) : k.forEveryoneMain(branch);
  return (
    <li className="proposal setting">
      <span className="setting-kind">
        <GearIcon />
        {k.settingKind(repo?.name ?? p.repo)}
      </span>
      <span className="setting-name">
        <span className="pref-text">{t.config.settings[p.field]}</span>
        <a className="from" title={k.openConfigHint} onClick={onConfig}>
          {k.openConfig}
        </a>
      </span>
      <span className="setting-diff">
        {now !== null && (
          <>
            <span className="setting-label">{k.settingWas}</span>
            <pre className={now ? 'setting-value was' : 'setting-value was setting-none'}>{now || k.settingEmpty}</pre>
          </>
        )}
        <span className="setting-label">{k.settingNew}</span>
        <span className="setting-new">
          <textarea ref={field} className="setting-value" aria-label={k.settingNew} spellCheck={false} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <span className="setting-edit">
            {changed ? (
              <>
                {k.settingEdited}{' '}
                <a className="from" onClick={() => setDraft(asText(p.value))}>
                  {k.settingRestore}
                </a>
              </>
            ) : (
              k.settingEditable
            )}
          </span>
        </span>
      </span>
      <span className="occasion">
        {k.fromRetro}: <Inline md={p.basis} />{' '}
        {p.cards.map((c, i) => {
          const card = items.find((x) => x.id === c.id);
          return (
            <Fragment key={c.id}>
              {i > 0 && ', '}
              <CardLink card={card} title={c.title} onOpen={onOpen} className="from" />
            </Fragment>
          );
        })}
      </span>
      <span className="pref-actions">
        <span className="take-on">{k.takeOn}</span>
        <button className="btn primary" disabled={busy || !draft.trim()} title={k.onMachineHint} onClick={() => take('machine')}>
          {k.onMachine}
        </button>
        <button className="btn primary" disabled={busy || !draft.trim()} title={everyone} onClick={() => take('repository')}>
          {k.forEveryone}
        </button>
      </span>
      <span className="occasion">
        {k.onMachine}: {k.onMachineHint} {k.forEveryone}: {everyone}
      </span>
      <span className="pref-actions">
        <button className="btn danger" disabled={busy} onClick={() => decide(() => api.rejectSetting(p.id))}>
          {k.reject}
        </button>
      </span>
      {error && <span className="p-error">{error}</span>}
    </li>
  );
}

/** How many of the outdated shared demos to share again at once: the newest few, or all. */
const RESHARE_COUNTS = [10, 20, 50, 100];

/**
 * Shared demos whose pages are made differently now: shared again many at once, the newest first,
 * one after the other, with how far it got and which failed.
 */
function ReshareBox({ r, items, onOpen }: { r: Reshare; items: Item[]; onOpen: (i: Item) => void }) {
  const counts = RESHARE_COUNTS.filter((n) => n < r.outdated);
  const [pick, setPick] = useState<number | 'all'>();
  const { status: error, act } = useAct();
  // the newest 20 unless the owner picks otherwise; null is all of them
  const chosen = pick === 'all' ? null : pick !== undefined && counts.includes(pick) ? pick : (counts.find((n) => n >= 20) ?? null);
  const run = r.run;
  const going = !!run && run.left > 0;
  const s = t.coordinator.reshare;
  const out = run ? run.done + run.failed.length : 0;
  return (
    <div className="reshare">
      <ul className="prefs proposals">
        {run && (
          <li>
            <span className="pref-text">
              {run.tags
                ? going
                  ? s.tagProgress(out, run.total)
                  : run.stopped
                    ? s.tagStopped(run.done, run.total)
                    : s.tagFinished(run.done, run.total)
                : going
                  ? s.progress(out, run.total)
                  : run.stopped
                    ? s.stopped(run.done, run.total)
                    : s.finished(run.done, run.total)}
            </span>
            <span className="bar">
              <span style={{ width: `${run.total ? (100 * out) / run.total : 100}%` }} />
            </span>
            {going && run.current && <span className="occasion">{s.now(plain(run.current))}</span>}
            {run.failed.length > 0 && (
              <span className="occasion">
                {s.failed(run.failed.length)}
                {run.failed.map((f) => {
                  const card = items.find((i) => i.id === f.id);
                  return (
                    <span key={f.id} className="failed">
                      <CardLink card={card} title={f.title} onOpen={onOpen} className="from" />
                    </span>
                  );
                })}
              </span>
            )}
            {/* beside the notice of outdated pages, its "Hide" puts both away; a run tagging pages goes alone */}
            {(going || run.tags || !r.outdated) && (
              <span className="pref-actions">
                {going ? (
                  <button className="btn" title={s.stopHint} disabled={!!run.stopped} onClick={() => act(api.stopReshare)}>
                    {s.stop}
                  </button>
                ) : (
                  <button className="btn" onClick={() => act(api.dismissReshare)}>
                    {s.dismiss}
                  </button>
                )}
              </span>
            )}
          </li>
        )}
        {r.outdated > 0 && !going && (
          <li>
            <span className="pref-text">{s.outdated(r.outdated)}</span>
            <span className="occasion">{s.outdatedHint}</span>
            {r.changes && <PageChangeList changes={r.changes} />}
            <span className="pref-actions">
              {counts.length > 0 && (
                <select value={chosen ?? ''} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : 'all')}>
                  {counts.map((n) => (
                    <option key={n} value={n}>
                      {s.newest(n)}
                    </option>
                  ))}
                  <option value="">{s.all(r.outdated)}</option>
                </select>
              )}
              <button className="btn primary" onClick={() => act(() => api.reshare(chosen))}>
                {s.go}
              </button>
              <button className="btn" title={s.dismissOutdatedHint} onClick={() => act(api.dismissReshare)}>
                {s.dismiss}
              </button>
            </span>
          </li>
        )}
        {!!r.untagged && !going && (
          <li>
            <span className="pref-text">{s.untagged(r.untagged)}</span>
            <span className="occasion">{s.untaggedHint}</span>
            <span className="pref-actions">
              <button className="btn primary" onClick={() => act(() => api.reshare(null, true))}>
                {s.tag(r.untagged)}
              </button>
            </span>
          </li>
        )}
      </ul>
      {error && <p className="p-error">{error}</p>}
    </div>
  );
}

function PreferenceRow({ p }: { p: Preference }) {
  const [draft, setDraft] = useState<string | null>(null);
  const { status: error, act } = useAct();
  const save = () => {
    if (draft === null || draft.trim() === p.text) return setDraft(null);
    act(async () => {
      await api.setPreference(p.id, draft);
      setDraft(null);
    });
  };
  return (
    <li>
      {draft === null ? (
        <span className="pref-text" title={t.coordinator.edit} onClick={() => setDraft(p.text)}>
          {p.text}
        </span>
      ) : (
        <RuleEdit draft={draft} setDraft={setDraft} onEnter={save} onBlur={save} />
      )}
      <button className="pref-del" title={t.remove} onClick={() => api.setPreference(p.id, null).catch(() => {})}>
        ✕
      </button>
      {error && <span className="p-error">{error}</span>}
    </li>
  );
}

/** A rule the owner writes: one of theirs, active at once, or for a repository's CLAUDE.md, which goes into its card "Add to CLAUDE.md". */
function NewPreference({ repos }: { repos: RepoRef[] }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [filed, setFiled] = useState('');
  const { status: error, act } = useAct();
  const add = () =>
    text.trim() &&
    act(async () => {
      await api.addPreference(text.trim(), target || undefined);
      setText('');
      setFiled(target ? t.coordinator.filed(repos.find((r) => r.id === target)?.name ?? target) : '');
    });
  return (
    <div className="composer pref-new">
      {/* as high as the rule: a dictated one is a sentence or more */}
      <DictatedArea
        fit
        value={text}
        rows={1}
        placeholder={t.coordinator.addPlaceholder}
        onChange={(text) => {
          setText(text);
          setFiled('');
        }}
        onEnter={add}
      >
        <button className="btn" disabled={!text.trim()} onClick={add}>
          {t.coordinator.add}
        </button>
      </DictatedArea>
      <TargetPick value={target} repos={repos} onChange={setTarget} />
      {filed && <span className="hint filed">{filed}</span>}
      {error && <span className="p-error">{error}</span>}
    </div>
  );
}
