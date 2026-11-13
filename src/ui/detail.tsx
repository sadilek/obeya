// The unfolded card: what it is, what its worker does, and what the owner decides.

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import type { ApproveResult, CardPatch, Item, RepoRef, UpstreamRef } from '../core/types';
import { agentListens, answering, archiveRefusal, askable, finished, handedOver, plannableAsProject, snoozable, stopped } from '../core/card';
import { ApiError, api, failText } from './api';
import { cardPath } from './address';
import { Naming } from './cardLink';
import { arrivedOnOpenCard, held, openedWith } from './demoSeen';
import { Branch, type CardChange, useCardDiff } from './diff';
import type { CardDiff } from '../core/diff';
import { ResultFiles } from './files';
import { DiscardChanges, FolderBox, FolderLine } from './folder';
import { landedRef } from './parts';
import { holdsNotes } from '../core/queue';
import { forcedText, QueueList, scrollerOf, useQueueMove, useQueueSort, waitText, type Behind } from './queue';
import { Body, plain } from './markdown';
import { MdField } from './mdField';
import { DictateButton, DictationLine } from './dictation';
import { appended, cardDraft, dropDraft, typeAtCursor, updateDraft, useFieldOn } from './draft';
import { AttachButton, ShotStrip, Shots, useShotInput } from './shots';
import { makingWords, newRepoWords, type RepoChoice, RepoPick, useRepoChoice } from './repoPick';
import { ClockMark, SnoozeMenu, snoozeWho } from './snooze';
import { kindLabel, snoozeWhen, t } from './strings';
import { agentWorks, ownerField, talkAlone, waitsFirstStart, worked as isWorked } from './cardState';
import { type Act, type ActDone, ArchiveButton, Armed, CardHead, DeleteButton, Later, type Pending, RepoDownBox, type Run, StartButton, StartOn, StateLine, SupersededBox, type Tell } from './cardSheet';
import { ApproveReview, Findings, holdsUp, useUnsentDecisions } from './review';
import { IdeaView, PrototypeDemos } from './idea';
import { Conversation, Fold, LastFailure, Mocks, Split, Talk, TalkColumn, useOpenQuestions, wordsField } from './conversation';
import { DemoView } from './demo';
import { PrBox, saveHeld } from './pr';
import { DemoShare } from './share';

interface Props {
  item: Item;
  /** Every item on the canvas, to name the cards a queued card waits for. */
  all: Item[];
  /** The canvas's repositories; with several, the card names its own and a planned one can move. */
  repos: RepoRef[];
  parent?: Item;
  /** The card it came from: a proposal's source, a prototype's idea, a follow-up's card. */
  from?: Item;
  onEdit: (p: CardPatch) => void;
  /** Saves pending edits; actions wait for it, so the worker sees the card as typed. */
  flush: () => Promise<void>;
  onDelete: () => void;
  onDone: (d: ActDone, pending?: Pending) => void;
  /** Reads the plan doc of a workstream's project, at the workstream; the phone view reads no plan docs. */
  onReadPlan?: (project: Item, mark?: string) => void;
  /** Opens the configuration at the clone count (or the slots) of a repository: the card waits for a free clone or slot. Not in the phone view. */
  onClones?: (repo: string, field: 'clones' | 'slots') => void;
  /** Opens the configuration at the owner's personal demo site. */
  onDemoSites?: () => void;
  onTell: Tell;
}

/** What every view of an open card gets: what its host gives `Detail`, and how the card acts. */
interface View extends Props {
  act: Act;
  run: Run;
  /** The card's repository among the canvas's. */
  repo: RepoRef | undefined;
  /** The repository the card is to be built in, before work on it begins: one of the canvas's or a new one. */
  choice: RepoChoice;
  /** Obeya, where it reads what is typed on the card because no agent listens there; the field says so, as the microphone does. */
  listener: string | undefined;
  /** The card's text and title take what is typed: written by the owner, and nobody started on it yet. */
  editable: boolean;
  /** Why the owner's last action on the card failed, where the view shows it. */
  error: ReactNode;
}

/** The open card: its head, and the view of its kind, which owns what the card shows and offers. */
export function Detail(p: Props) {
  const { item, parent } = p;
  const [error, setError] = useState('');
  const run: Run = async (fn, done) => {
    setError('');
    const answered = p.flush().then(fn);
    // what takes the server a while (a push onto main) does not hold the card open: the canvas shows it under way
    if (done.close && done.pending) return p.onDone(done, { card: item.id, title: plain(item.title), answered });
    try {
      await answered;
      p.onDone(done);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      setError(failText(e));
    }
  };
  // an approval that posts the text for the PR takes the owner's edit of it as it stands, saved or not
  const act: Act = (a, done) =>
    run(async () => {
      if (a.action === 'approve' || a.action === 'pushChanges') await saveHeld(item.id);
      const r = await api.act<ApproveResult | void>(item.id, a);
      // the decisions on findings that went with the approval are no longer the field's to send
      if (a.action === 'approve' && a.findings) updateDraft(cardDraft(item.id), { findings: undefined });
      return r;
    }, done);
  const choice = useRepoChoice(item, p.onEdit);
  const repo = p.repos.find((r) => r.id === item.repo);
  // a proposal being reworked takes the agent's title and text: the fields come back with them, rather than keeping a draft
  // a stopped task keeps what it was started with: the task is its conversation's first message
  const editable = item.source === 'manual' && (item.state === 'planned' || item.state === 'idea' || item.state === 'proposal') && !item.queue && !item.proposal?.revising && !stopped(item);
  const v: View = {
    ...p,
    act,
    run,
    repo,
    choice,
    listener: agentListens(item) ? undefined : t.voice.card(plain(item.title)),
    editable,
    error: error && <p className="p-error">{error}</p>,
  };
  const question = item.kind === 'question' && !!item.thread;
  const idea = item.state === 'idea' && !!item.idea;
  const kind = [p.repos.length > 1 ? (repo?.name ?? item.repo) : '', parent ? `${plain(parent.title)} · ${item.label ?? ''} · ${t.kind.workstream}` : kindLabel(item)].filter(Boolean).join(' · ');
  return (
    <>
      {/* an idea's title is the owner's to change until it goes into the archive */}
      <CardHead item={item} kind={kind} onEdit={(idea ? !item.archivedAt : editable && !question && !item.prototypeEnd) && p.onEdit} />
      {question ? <QuestionView {...v} /> : idea ? <IdeaView {...v} /> : item.prototypeEnd ? <EndedPrototypeView {...v} /> : item.state === 'proposal' ? <ProposalView {...v} /> : <TaskView {...v} />}
    </>
  );
}

/**
 * A thread of looked-up answers on a card of its own: its conversation with the agent that looked
 * them up, whom the owner's words reach directly, and the two ways on: discuss it as an idea, or done.
 */
function QuestionView({ item, act, run, onTell, error }: View) {
  const thread = item.thread!;
  return (
    <>
      <StateLine item={item} label={`${t.question.count(thread.answers, thread.files)} · ${thread.thinking ? t.question.reading : t.question.ready}`} />
      {/* the conversation alone, as tall as the room down to the microphone allows */}
      <Split main={null} talk={<Talk item={item} past={!!item.archivedAt} field={item.archivedAt ? undefined : wordsField(t.question.compose, onTell, 'note', act, 'ask')} />} />
      <div className="actions">
        {item.archivedAt ? (
          <ArchiveButton item={item} run={run} />
        ) : (
          <>
            <button
              className="btn"
              disabled={thread.thinking}
              title={thread.thinking ? t.question.asIdeaWaits : t.question.asIdeaHint}
              onClick={() => act({ action: 'asIdea' }, { close: false })}
            >
              {t.question.asIdea}
            </button>
            <ArchiveButton item={item} run={run} className="btn primary" label={t.question.done} hint={t.question.doneHint} />
          </>
        )}
      </div>
      {error}
    </>
  );
}

/**
 * A proposal: its text as the agent taking it on will read it (editable where the owner wrote it),
 * why it was proposed, and the questions to decide, which the owner may answer before taking it.
 * What the owner types (maybe in reply to a message of its conversation) is what should change in
 * it: an agent reworks the proposal by it.
 */
function ProposalView({ item, all, from, act, listener, onTell, editable, repos, choice, onEdit, onDelete, error }: View) {
  const revising = item.proposal?.revising;
  const answer = useOpenQuestions(item);
  const idea = !!item.proposal?.idea;
  const armed = item.proposal?.acceptAfterRevision;
  const later = !idea && !!item.proposal?.startAt;
  // while it is reworked, the click waits for the new text in view; else the panel closes on the accepted card
  const accept = (start: boolean, asIdea = false) =>
    act(
      { action: 'accept', ...(start ? {} : { start: false }), ...(asIdea ? { idea: true } : {}), ...(answer.picked ? { picks: answer.picks } : {}) },
      (start || asIdea) && !revising
        ? { close: true, ack: idea || asIdea ? t.acceptedIdea : later && Date.parse(item.proposal!.startAt!) > Date.now() ? t.acceptedLater(snoozeWhen(item.proposal!.startAt!)) : t.accepted }
        : { close: false },
    );
  return (
    <>
      <TaskState item={item} />
      <SupersededBox item={item} all={all} act={act} onDelete={onDelete} />
      <RepoDownBox item={item} />
      {/* the proposal as it stands, and beside it the talk about what should change, as with an idea */}
      <Split
        className="proposal-grid"
        cite={cardDraft(item.id)}
        main={
          <>
            {editable ? <ManualFields item={item} repos={repos} choice={choice} onEdit={onEdit} grow /> : <CardText item={item} />}
            {/* which of the owner's screenshots go with the task, by their hand or the reviser's pick */}
            {!!item.images?.length && <p className="hint">{t.proposalShots}</p>}
            {!idea && <StartAt item={item} act={act} />}
            {from && <p className="hint"><Naming text={t.proposedBy} cards={[{ card: from }]} />{item.proposal?.reason && <> {item.proposal.reason}</>}</p>}
            {/* proposed by the agent of a card on another canvas, whose repository this is */}
            {!from && item.fromElsewhere && (
              <p className="hint">
                {t.proposedByElsewhere(plain(item.fromElsewhere.title), item.fromElsewhere.canvasName)}
                {item.proposal?.reason && <> {item.proposal.reason}</>}{' '}
                <a className="link" href={elsewhereHref(item)}>
                  {t.openThere}
                </a>
              </p>
            )}
            {item.retro && <p className="hint">{t.proposedByRetro(item.retro)}</p>}
            {item.proposal?.setup && item.proposal.reason && <p className="hint">{item.proposal.reason}</p>}
          </>
        }
        // while it is reworked, the owner's words wait for the rework after it, unread until then
        talk={<Talk item={item} field={wordsField(t.compose.revise, onTell, 'revise', act, 'revise', listener)} />}
      />
      {revising && <p className={armed ? 'hint go-waits' : 'hint'}>{armed ? t.acceptWaitsHint : t.acceptWaitsFor(idea ? t.acceptIdea : t.accept)}</p>}
      <div className="actions">
        {armed ? (
          <Armed label={t.acceptWaits(idea || armed === 'idea')} undo={t.unaccept} onUndo={() => act({ action: 'unaccept' }, { close: false })} />
        ) : (
          // one to start later is planned and waits until then: taking it on is all there is to it
          <StartOn item={item} act={act} on={!idea}>
            <button className="btn primary" title={later ? t.startAt.accept : undefined} onClick={() => accept(true)}>
              {idea ? t.acceptIdea : later ? t.acceptOnly : t.accept}
            </button>
          </StartOn>
        )}
        {!later && (
          <button className="btn" disabled={!!revising} onClick={() => accept(false)}>
            {idea ? t.acceptAsTask : t.acceptOnly}
          </button>
        )}
        {/* a task the owner would rather think through first */}
        {!idea && (
          <button className="btn" disabled={!!armed} title={t.acceptAsIdeaHint} onClick={() => accept(false, true)}>
            {t.acceptAsIdea}
          </button>
        )}
        <button className="btn" onClick={() => act({ action: 'dismiss' }, { close: true, ack: t.dismissed })}>
          {t.dismiss}
        </button>
        <Later item={item} act={act} />
      </div>
      {answer.questions.length > 0 && <p className="hint">{t.proposalQuestionsHint}</p>}
      {error}
    </>
  );
}

/** When a proposed task starts once accepted, with "Change": another time, or none, so it starts at once. */
function StartAt({ item, act }: { item: Item; act: Act }) {
  const at = item.proposal?.startAt;
  if (!at) return null;
  const set = (to: string | null) => void act({ action: 'startAt', at: to }, { close: false });
  return (
    <div className="start-at">
      <ClockMark /> {t.startAt.line(snoozeWhen(at))} ·{' '}
      <SnoozeMenu
        label={t.snooze.change}
        className="link"
        mark={false}
        heading={t.startAt.heading}
        hint={t.startAt.accept}
        set={t.startAt.set}
        at={new Date(at)}
        clear={{ label: t.startAt.none, hint: t.startAt.noneHint, onClear: () => set(null) }}
        onSnooze={set}
      />
    </div>
  );
}

/** `fresh`: the repository picker offers a new repository (not on a proposal, which starts where it is). */
function ManualFields({ item, repos, choice, fresh, onEdit, grow }: { item: Item; repos: RepoRef[]; choice: RepoChoice; fresh?: boolean; onEdit: (p: CardPatch) => void; grow?: boolean }) {
  const [body, setBody] = useState(item.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  // the field's draft holds no text, the card has it: it is where words dictated into the field go
  const key = `body:${item.id}`;
  useEffect(() => () => dropDraft(key), [key]);
  // the field's microphone shows while the field does, not over the formatted text
  const editing = useFieldOn(key);
  // a dropped file's path goes in as typed while the field has the cursor, else after the text
  // (the latest, which a path put in just before is part of before React has drawn it)
  const latest = useRef(body);
  latest.current = body;
  const put = (path: string) => {
    const el = ref.current;
    if (el && el === document.activeElement) return typeAtCursor(el, path);
    const next = (latest.current = appended(latest.current, path));
    setBody(next);
    onEdit({ body: next });
  };
  const shots = useShotInput({ initial: item.images, onChange: (images) => onEdit({ images }), put });
  return (
    <>
      {!item.newRepo?.due && <RepoPick choice={choice} repos={repos} fresh={!!fresh} />}
      {!choice.fresh && !item.adopted && <UpstreamPick item={item} repo={repos.find((r) => r.id === choice.repo)} onEdit={onEdit} />}
      {/* the task's screenshots: the worker gets them with the task when it starts */}
      <div className={`p-body-field${shots.dropping ? ' dropping' : ''}`} {...shots.drop}>
        <ShotStrip shots={shots} />
        <div className="c-field">
          {/* the text shows formatted, as its agent will read it; a proposal's in full as far as the screen allows, the panel growing with it */}
          <MdField
            text={body}
            field={ref}
            draft={key}
            grow={grow}
            fieldClass="p-body"
            shownClass="p-body p-body-shown"
            placeholder={t.bodyPlaceholder}
            onPaste={shots.onPaste}
            onChange={(v) => {
              setBody(v);
              onEdit({ body: v });
            }}
          />
          <div className="p-body-tools">
            {editing && <DictateButton draft={key} field={ref} />}
            <AttachButton shots={shots} />
          </div>
        </div>
        <DictationLine draft={key} />
        {shots.error && <p className="p-error c-error">{shots.error}</p>}
      </div>
    </>
  );
}

/** A prototype its idea built on or discarded: what came of it, and its demo beside its conversation, read only. */
function EndedPrototypeView({ item, from }: View) {
  return (
    <>
      <StateLine item={item} />
      <p className="hint ended">
        {item.builtInto ? t.idea.builtInto(plain(item.ideaTitle ?? ''), plain(item.builtInto)) : t.idea.endedLong[item.prototypeEnd!](plain(item.ideaTitle ?? from?.title ?? ''))}
      </p>
      <Split
        main={
          // the summary is the handover in the conversation, the task its first message
          item.demo && <DemoView item={item} demo={item.demo} autoplay={false} />
        }
        talk={<Talk item={item} past />}
      />
    </>
  );
}

/** A task's state line, a proposal's too: who snoozed it, else what its agent reports while it works; what landed of it. */
function TaskState({ item }: { item: Item }) {
  return (
    <StateLine item={item} paused={!!(item.paused || item.restartPaused || item.snoozed)}>
      {item.snoozed ? (
        <span className="p-status"> · {snoozeWho(item.snoozed)}</span>
      ) : (
        item.statusLine && (item.state === 'working' || item.state === 'inPr' || item.finishing || answering(item)) && <span className="p-status"> · {item.statusLine}</span>
      )}
      {item.landedPart && (
        <span className="p-status">
          {' · '}
          {t.landedPart.short} · {landedRef(item.landedPart)}
        </span>
      )}
    </StateLine>
  );
}

/** The card's text as its agent reads it, with its screenshots. */
const CardText = ({ item }: { item: Item }) => (
  <>
    <Body md={item.body} />
    <Shots ids={item.images} />
  </>
);

/**
 * A task from planned to done (a workstream, a prototype, a review card too): its text while nobody
 * has worked on it, beside the conversation while it waits for its first start; once somebody has,
 * what came of the work beside the conversation; the decisions below both.
 */
function TaskView(v: View) {
  const { item, all, parent, from, repo, choice, act, editable } = v;
  // the demo the card opened to (demoSeen.ts); closing the card forgets one that waited on it
  const [opened] = useState(() => openedWith(sessionStorage, item.id, item.demo));
  useEffect(() => () => held.clear(sessionStorage, item.id), []);
  const demoWaits = item.state === 'waiting' && item.need === 'demo';
  // a demo starts by itself only when the owner opens the card to it; one that arrives on the open card waits behind its play button
  const arrived = !!item.demo && arrivedOnOpenCard(opened, item.demo);
  useEffect(() => {
    if (arrived && demoWaits && item.demo) held.set(sessionStorage, item.id, item.demo);
  }, [arrived, demoWaits, item.demo?.handover, item.demo && JSON.stringify(item.demo.chapters)]);
  const worked = isWorked(item);
  // in a folder without git the card's change list takes the place of its branch
  const inFolder = !!repo?.folder;
  // what the card changed, read once for its branch line and its files
  const change = useCardDiff(item, { on: worked, poll: inFolder });
  // the tab the left column shows: a file picked there or in the change list beside the handover
  const [tab, setTab] = useState<string | null>(null);
  // on a review card, the findings decided in the field that hold the merge up until they are sent
  const heldUp = Object.entries(useUnsentDecisions(item))
    .filter(([, route]) => holdsUp(route))
    .map(([id]) => Number(id));
  // a task waiting for its first start, planned or in the queue, keeps its text in full beside its conversation, where notes wait for its agent
  const waits = waitsFirstStart(item);
  const proto = prototypeState(item, all, from);
  const text = (o: { fresh?: boolean; grow?: boolean }) => (editable ? <ManualFields item={item} repos={v.repos} choice={choice} onEdit={v.onEdit} {...o} /> : <CardText item={item} />);
  // work waiting for the owner's verdict, with a demo or a summary
  const review = handedOver(item);
  const lands = landing(item, repo, inFolder);
  return (
    <>
      <TaskState item={item} />
      <Where item={item} parent={parent} worked={worked} inFolder={inFolder} change={change} onReadPlan={v.onReadPlan} />

      <SupersededBox item={item} all={all} act={act} onDelete={v.onDelete} />
      <RepoDownBox item={item} />

      {!waits && <QueueBox item={item} all={all} act={act} onClones={v.onClones} />}

      {item.prototypeOf && (
        <p className="hint">
          <Naming text={proto.planning || proto.project ? t.idea.prototypeOfPlanning : t.idea.prototypeOf} cards={[{ card: proto.idea, title: proto.ideaTitle }]} />
        </p>
      )}
      {item.buildProposal && (
        <div className="question proposal">
          <h4>{t.idea.buildProposal}</h4>
          <div className="q-text">{item.buildProposal}</div>
          {proto.buildable && (
            <div className="actions">
              <BuildOn act={act} proto={proto} label={t.idea.acceptBuild} />
            </div>
          )}
        </div>
      )}
      {item.builtOn && (
        <p className="hint">
          <Naming text={t.idea.builtOn} cards={[{ card: proto.builtOn, title: proto.builtOn?.title ?? '' }]} />
        </p>
      )}
      {from && !item.prototypeOf && (
        <p className="hint">
          <Naming text={t.followUpOf} cards={[{ card: from }]} />
        </p>
      )}
      {!from && item.fromElsewhere && <FromElsewhere item={item} />}

      <LastFailure item={item} />

      {item.state === 'planned' && !worked && !waits && text({ fresh: true })}

      {/* what the card changed in a folder without git stays in view: in its left column, or above its conversation where it has none */}
      {worked && inFolder && talkAlone(item) && <FolderBox item={item} diff={change.diff} />}
      {waits ? (
        <Split
          main={
            <>
              <QueueBox item={item} all={all} act={act} onClones={v.onClones} />
              {text({ fresh: true, grow: true })}
            </>
          }
          talk={<TaskTalk item={item} act={act} onTell={v.onTell} />}
          cite={!!ownerField(item) && cardDraft(item.id)}
        />
      ) : worked ? (
        // what came of the work on the left, once there is something, the conversation with the owner's one field on the right;
        // the task is the conversation's first message, and the summary its handover
        <Split
          main={!talkAlone(item) && <TaskResult v={v} diff={change.diff} tab={tab} onTab={setTab} autoplay={demoWaits && !arrived} />}
          // what is typed into a card waiting to start waits for its agent, not for Obeya
          talk={<TaskTalk item={item} listener={holdsNotes(item) ? undefined : v.listener} act={act} onTell={v.onTell} />}
          cite={!!ownerField(item) && cardDraft(item.id)}
        />
      ) : (
        <>
          <Brief item={item} />
          {item.state !== 'planned' && <CardText item={item} />}
          {/* a card nobody worked on shows its conversation once there is something, such as a talk with the Coordinator */}
          <TalkColumn bare>
            <Conversation item={item} past hideEmpty />
          </TalkColumn>
        </>
      )}

      {v.error}

      {/* the decisions below what the card shows, as on every card */}
      <TaskActions v={v} worked={worked} proto={proto} approve={<ApproveButton item={item} act={act} lands={lands} change={change} upstream={upstreamOf(item, repo, lands)} />} />
      {review && item.noChange && !item.prototypeOf && (
        <p className="hint">{inFolder ? t.folder.noChangeHint : item.followsPrs ? t.follows.hint(item.followsPrs.map(prName), item.followsPrs.some((p) => p.maintainers)) : t.noChangeHint}</p>
      )}
      {review && lands.direct && !item.prototypeOf && <p className="hint">{t.directHint}</p>}
      {review && heldUp.length > 0 && <p className="hint">{t.review.heldUp(heldUp)}</p>}
    </>
  );
}

/**
 * Where a task's work stands, at the top in every state: the pull request a review card reviews,
 * the branch an agent works on (in a folder without git, what it changed there), a workstream's plan doc.
 */
function Where({ item, parent, worked, inFolder, change, onReadPlan }: { item: Item; parent?: Item | undefined; worked: boolean; inFolder: boolean; change: CardChange; onReadPlan?: ((project: Item, mark?: string) => void) | undefined }) {
  if (!worked && !parent?.plan && !item.contribution) return null;
  // an archived project's doc is gone
  const readPlan = parent && !parent.archivedAt && onReadPlan;
  return (
    <p className="p-src">
      {item.contribution && (
        <>
          <a href={item.contribution.url} target="_blank" rel="noreferrer">
            {t.review.kind(item.contribution.number, item.contribution.author)} ↗
          </a>
          {worked && ' · '}
        </>
      )}
      {worked && (inFolder ? <FolderLine item={item} diff={change.diff} sizeBelow={!talkAlone(item)} /> : item.branch && <Branch item={item} diff={change.diff} onRead={change.set} sizeBelow={!talkAlone(item)} />)}
      {/* the open pull request of the owner's branch the task works on, until the work went onto it */}
      {worked && item.adopted?.pr && !item.pr && (
        <>
          {' · '}
          <a href={item.adopted.pr.url} target="_blank" rel="noreferrer">
            {t.adopted.pr(prName(item.adopted.pr))}{'\u00a0'}↗
          </a>
        </>
      )}
      {/* the pull requests the handed-over work went onto instead of the branch, which the approval follows */}
      {worked &&
        !item.pr &&
        item.followsPrs?.map((p) => (
          <Fragment key={p.url}>
            {' · '}
            <a href={p.url} target="_blank" rel="noreferrer">
              {t.adopted.pr(prName(p))}{'\u00a0'}↗
            </a>
          </Fragment>
        ))}
      {parent?.plan && (
        <>
          {worked && item.branch && ' · '}
          <code>{parent.plan.file}</code>{' '}
          {readPlan && (
            <button className="link" onClick={() => readPlan(parent, item.label)}>
              {t.plan.readAt}
            </button>
          )}
        </>
      )}
    </p>
  );
}

/** What a card in the queue waits for, with the buttons that start it anyway or take it out of the queue. */
function QueueBox({ item, all, act, onClones }: { item: Item; all: Item[]; act: Act; onClones?: ((repo: string, field: 'clones' | 'slots') => void) | undefined }) {
  const q = item.queue;
  if (item.state !== 'planned' || !q) return null;
  if ('checking' in q)
    return (
      <div className="question queue">
        <div className="q-text">{t.queue.checkingLong}</div>
      </div>
    );
  return (
    <div className="question queue">
      <div className="q-text">
        {'paused' in q ? (
          t.queue.pausedLong
        ) : 'workspace' in q ? (
          <>
            {t.queue.workspaceLong[q.workspace]}{' '}
            {onClones && (
              <button className="link" onClick={() => onClones(item.repo, q.workspace === 'slots' ? 'slots' : 'clones')}>
                {t.queue.workspaceConfig[q.workspace]}
              </button>
            )}
          </>
        ) : (
          <WaitsFor queue={q} all={all} />
        )}
      </div>
      <QueuePlace item={item} items={all} />
      <div className="actions">
        {/* behind other cards, it may start anyway */}
        {'behind' in q && (
          <StartOn item={item} act={act} primary={false}>
            <button className="btn" onClick={() => act({ action: 'force' }, { close: true, ack: forcedText(q) })}>
              {t.queue.force}
            </button>
          </StartOn>
        )}
        <button className="btn" onClick={() => act({ action: 'dequeue' }, { close: false })}>
          {t.queue.dequeue}
        </button>
      </div>
    </div>
  );
}

/** What a queued card waits for, each card a link that opens it in this one's place. */
function WaitsFor({ queue, all }: { queue: Behind; all: Item[] }) {
  const cards = queue.behind.map((id) => ({ card: all.find((x) => x.id === id), title: all.find((x) => x.id === id)?.title ?? id }));
  return <Naming text={(...names) => waitText(queue, all, (id) => names[queue.behind.indexOf(id)]!)} cards={cards} />;
}

/** Where a waiting card stands in the queue, with the buttons that move it; unfolded, the queue around it, where it is dragged instead. */
function QueuePlace({ item, items }: { item: Item; items: Item[] }) {
  const m = useQueueMove(item, items);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const q = useQueueSort(items, scrollerOf(box), item.id);
  // folded under a drag: the card is not dropped anywhere
  useEffect(() => {
    if (!open) q.sort.cancel();
  }, [open]);
  if (!m) return null;
  return (
    <div className="q-place" ref={box}>
      <span className="hint">{m.place}</span>
      {!open && m.buttons}
      <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t.queue.hide : t.queue.show}
      </button>
      {!open && m.why && <div className="hint why">{m.why}</div>}
      {open && (
        <div className="q-around">
          <QueueList items={items} q={q} />
          <p className="hint">{t.queue.dragOwn}</p>
        </div>
      )}
    </div>
  );
}

/**
 * What came of a task's work, on the left beside its conversation: a workstream's text in its plan
 * doc, what landed of it, what a review card's agent found, the demo and the files the work made or
 * changed, the pull requests, what follows the landing, a decided idea's brief.
 */
function TaskResult({ v, diff, tab, onTab, autoplay }: { v: View; diff: CardDiff | null; tab: string | null; onTab: (path: string) => void; autoplay: boolean }) {
  const { item, act } = v;
  const demoWaits = item.state === 'waiting' && item.need === 'demo';
  // a demo, video or HTML artifact, goes to a page where the repository has a share target, else it is exported as a file; prototypes stay here
  const sharing = !!item.demo && !item.prototypeOf;
  return (
    <>
      {/* a workstream's text in its plan doc stays in view in every state: the task it is, ahead of what came of it */}
      {item.source === 'plan' && (
        <div className="p-plan">
          <h4 className="p-h">{t.talk.opening.plan}</h4>
          {/* in full, the column scrolls; above a demo or the files it made a few lines, so what came of the work stays in view below */}
          {item.demo || item.files ? (
            <Fold lines={3}>
              <Body md={item.body} />
            </Fold>
          ) : (
            <Body md={item.body} />
          )}
        </div>
      )}
      {/* what landed of a workstream the plan doc keeps open comes first: the demo below shows it */}
      {item.landedPart && (
        <p className="hint">
          {t.landedPart.long}{' '}
          {item.landedPart.pr ? (
            <a href={item.landedPart.pr.url} target="_blank" rel="noreferrer">
              {t.pr.title(item.landedPart.pr.number)} ↗
            </a>
          ) : (
            <code>{landedRef(item.landedPart)}</code>
          )}
        </p>
      )}
      {/* what a review card's agent found comes first, at a glance above its demo */}
      {item.contribution && (item.contribution.results || item.contribution.findings || item.contribution.clash) && (
        <Findings
          item={item}
          decides={!!ownerField(item) && !finished(item.state)}
          onPush={() => act({ action: 'pushMain' }, { close: true, ack: t.review.pushing(item.contribution!.number), undo: () => api.act(item.id, { action: 'keepMain' }) })}
        />
      )}
      {/* the last handover's demo stays while the agent works on the card again; a new handover replaces it. Beside it, the files the work made or changed */}
      <ResultFiles
        item={item}
        tab={tab}
        onTab={onTab}
        diff={diff}
        demo={
          item.demo && (
            <DemoView
              item={item}
              demo={item.demo}
              autoplay={autoplay}
              comments={agentListens(item)}
              top={
                (!demoWaits || sharing) &&
                ((shown, latest) => (
                  <>
                    {!demoWaits && latest && (
                      <p className="hint">
                        {shown.asked && item.state === 'waiting' && item.need === 'question'
                          ? t.demo.asked
                          : item.state === 'working' || item.state === 'waiting'
                            ? shown.asked
                              ? t.demo.askedAgain
                              : t.demo.again
                            : t.demo.kept}
                      </p>
                    )}
                    {/* drafts shown with a question are not the work's demo: the handover brings the one to share */}
                    {sharing && !shown.asked && <DemoShare item={item} demo={shown} repo={v.repo} act={act} run={v.run} onDemoSites={v.onDemoSites} />}
                  </>
                ))
              }
            />
          )
        }
      />
      {item.pr && (item.state === 'inPr' || item.state === 'waiting') && (
        <PrBox pr={item.pr} {...(item.rollbackOf ? { rollbackOf: item.rollbackOf } : {})} {...(item.contribution?.held && item.state === 'waiting' ? { held: item.contribution.held, author: item.contribution.author, card: item.id } : {})} />
      )}
      {(item.state === 'inPr' || item.state === 'waiting') && item.morePrs?.map((pr) => <PrBox key={pr.url} pr={pr} />)}
      {item.state === 'inPr' && !item.pr && <p className="hint">{item.upstream && v.repo?.upstream ? t.pr.openingUpstream(v.repo.upstream.name) : t.pr.opening}</p>}
      {item.finishing && finished(item.state) && <p className="hint">{item.followUp ? t.followingUpLong : item.restartPaused ? (item.state === 'done' ? t.restartPause.doneLong : t.restartPause.liveLong) : item.state === 'done' ? t.finishingDoneLong : t.finishingLong}</p>}
      <Brief item={item} />
    </>
  );
}

/** A decided idea's brief, what it was decided on and how, with its prototypes' demos. */
function Brief({ item }: { item: Item }) {
  if (item.brief === undefined) return null;
  return (
    <>
      {item.brief.trim() && (
        <div className="question brief">
          <h4>{t.idea.brief}</h4>
          <Body md={item.brief} />
          <Mocks mocks={item.mocks} />
        </div>
      )}
      <PrototypeDemos item={item} />
    </>
  );
}

/**
 * Where a prototype stands with its idea. Its idea is built on it once the idea's agent has taken in
 * what changed; once the idea is a project (or planned as one), its plan doc settles the prototypes:
 * the one it builds on goes to that workstream, the others are discarded.
 */
function prototypeState(item: Item, all: Item[], from: Item | undefined) {
  const project = item.prototypeOf ? all.find((i) => i.kind === 'project' && i.origin === item.prototypeOf) : undefined;
  const planning = !project && !!from?.becomesProject;
  return {
    idea: item.prototypeOf ? all.find((i) => i.id === item.prototypeOf) : undefined,
    ideaTitle: plain(item.ideaTitle ?? from?.title ?? ''),
    project,
    planning,
    buildable: !project && !planning,
    thinking: !project && !!from?.idea?.thinking,
    // the prototype a card was built on
    builtOn: item.builtOn ? item.prototypes?.find((x) => x.id === item.builtOn) : undefined,
  };
}

type Proto = ReturnType<typeof prototypeState>;

/** Builds the prototype's idea on it; while the idea's agent works, it waits. */
function BuildOn({ act, proto, label }: { act: Act; proto: Proto; label: string }) {
  return (
    <button
      className="btn primary"
      disabled={proto.thinking}
      title={proto.thinking ? t.idea.prototypeWaits : undefined}
      onClick={() => act({ action: 'buildPrototype' }, { close: true, ack: t.idea.builtPrototype(proto.ideaTitle) })}
    >
      {label}
    </button>
  );
}

/** A prototype's decisions: its idea built on it, or it discarded; never approved or deleted. */
function PrototypeActions({ item, act, proto }: { item: Item; act: Act; proto: Proto }) {
  return (
    <>
      {item.branch && proto.buildable && <BuildOn act={act} proto={proto} label={t.idea.buildPrototype} />}
      <button className="btn" onClick={() => act({ action: 'discard' }, { close: true, ack: t.idea.discarded })}>
        {t.idea.discard}
      </button>
    </>
  );
}

/**
 * How the card's work lands: work that changes nothing in the repository ends with the approval (no
 * pull request, nothing lands); where work goes out as a pull request (`pr`), and where the settings
 * allow it the owner may have it pushed onto main directly instead (`direct`); a card's own branch
 * may change both.
 */
function landing(item: Item, repo: RepoRef | undefined, inFolder: boolean) {
  const pr = !inFolder && !item.noChange && (item.lands?.land ?? (repo?.pullRequests ? 'pr' : 'main')) === 'pr';
  return { pr, direct: pr && (item.lands?.direct ?? !!repo?.direct), inFolder };
}

/**
 * In a fork (`RepoRef.upstream`), before work begins: the base the task is built on, the fork's main
 * branch or the original's newest main, which also decides whether it goes to the original as a pull
 * request. Saved as it is picked; the approve buttons offer the other way again.
 */
function UpstreamPick({ item, repo, onEdit }: { item: Item; repo: RepoRef | undefined; onEdit: (p: CardPatch) => void }) {
  const [on, setOn] = useState(!!item.upstream);
  useEffect(() => setOn(!!item.upstream), [item.upstream]);
  const up = repo?.upstream;
  if (!up || item.prototypeOf || item.state !== 'planned') return null;
  const pick = (v: boolean) => {
    setOn(v);
    onEdit({ upstream: v });
  };
  return (
    <div className="upstream-pick">
      <span className="hint">{t.upstream.startOn}</span>
      <div className="seg">
        {/* what each start point means, on the button: the card stays calm */}
        <button className={on ? '' : 'on'} title={t.upstream.pickMine(up.into, up.name)} onClick={() => pick(false)}>
          {t.upstream.mine(up.into)}
        </button>
        <button className={on ? 'on' : ''} title={t.upstream.pickPr(up.into, up.name, up.branch)} onClick={() => pick(true)}>
          {t.upstream.pr(up.branch, up.name)}
        </button>
      </div>
    </div>
  );
}

/** A branch's pull request as the card names it: `#82`, after its repository where that is another than origin's. */
export const prName = (pr: { number: number; repo?: string }) => `${pr.repo ?? ''}#${pr.number}`;

/** The original repository a fork's card may go to as a pull request too, where its work lands on the main branch and changes something there. */
function upstreamOf(item: Item, repo: RepoRef | undefined, lands: ReturnType<typeof landing>): UpstreamRef | undefined {
  return !lands.pr && !lands.inFolder && !item.noChange && !item.prototypeOf && !item.contribution && !item.adopted ? repo?.upstream : undefined;
}

/** Approving the card's work: a review card's merge, in a folder without git with "Discard changes" beside it, else as the work lands. */
function ApproveButton({ item, act, lands, change, upstream }: { item: Item; act: Act; lands: ReturnType<typeof landing>; change: CardChange; upstream?: UpstreamRef | undefined }) {
  if (item.contribution) return <ApproveReview item={item} act={act} />;
  if (lands.inFolder)
    return (
      <>
        <button className="btn primary" title={item.noChange ? undefined : t.folder.approveHint} onClick={() => act({ action: 'approve' }, item.noChange ? { close: true, ack: t.approvedNoChange } : { close: true, ack: t.folder.approved })}>
          {item.noChange ? t.approveNoChange : t.approve}
        </button>
        <DiscardChanges diff={change.diff} act={act} onDone={change.reload} />
      </>
    );
  // in a fork: the card's choice is the first button, the other one beside it
  if (upstream) {
    // what sending it to the original means, on that button: built on the original, or applied to it untested
    const hint = (item.upstream ? t.upstream.hint : t.upstream.hintPort)(upstream.into, upstream.name, upstream.branch, item.upstreamNew);
    const mineHint = t.upstream.mineHint(upstream.into, upstream.name);
    const toOriginal = () => act({ action: 'approve', upstream: true }, { close: true, ack: t.upstream.approved(upstream.name), pending: t.upstream.approving });
    const mine = () => act({ action: 'approve', upstream: false }, { close: true, ack: t.approved, pending: t.approving });
    return item.upstream ? (
      <>
        <button className="btn primary" title={hint} onClick={toOriginal}>
          {t.upstream.approve(upstream.name)}
        </button>
        <button className="btn" title={mineHint} onClick={mine}>
          {t.upstream.approveMine}
        </button>
      </>
    ) : (
      <>
        <button className="btn primary" title={mineHint} onClick={mine}>
          {t.approve}
        </button>
        <button className="btn" title={hint} onClick={toOriginal}>
          {t.upstream.approve(upstream.name)}
        </button>
      </>
    );
  }
  // work that went onto pull requests open already instead of the branch: the approval follows them
  const follows = item.noChange && item.followsPrs;
  if (follows) {
    const names = follows.map(prName);
    return (
      <button className="btn primary" onClick={() => act({ action: 'approve' }, { close: true, ack: t.follows.approved(names), pending: t.approving })}>
        {t.follows.approve(follows.length)}
      </button>
    );
  }
  // a branch of the owner's with an open pull request: the work goes onto that one
  const pr = !item.noChange && item.adopted?.pr;
  if (pr)
    return (
      <button className="btn primary" title={t.adopted.approveHint(item.adopted!.branch, prName(pr), !!pr.maintainers)} onClick={() => act({ action: 'approve' }, { close: true, ack: t.adopted.approved(prName(pr)), pending: t.adopted.approving })}>
        {t.adopted.approve}
      </button>
    );
  return (
    <>
      <button className="btn primary" onClick={() => act({ action: 'approve' }, item.noChange ? { close: true, ack: t.approvedNoChange } : { close: true, ack: t.approved, pending: t.approving })}>
        {item.noChange ? t.approveNoChange : lands.pr ? t.approvePr : t.approve}
      </button>
      {lands.direct && (
        <button className="btn" title={t.directHint} onClick={() => act({ action: 'approve', direct: true }, { close: true, ack: t.approvedDirect, pending: t.approvingDirect })}>
          {t.approveDirect}
        </button>
      )}
    </>
  );
}

/**
 * Taking back the owner's approval, where it can be (`Item.revocable`): the button says what it
 * does, closing the pull request or reverting the work on main or through a rollback PR, and waits
 * for "Undo" before Obeya does it.
 */
function RevokeButton({ item, act }: { item: Item; act: Act }) {
  const r = item.revocable;
  if (!r) return null;
  const tr = t.revoke;
  const [label, hint, ack] =
    r.how === 'approval'
      ? [tr.approval, tr.approvalHint, tr.ackApproval]
      : r.how === 'closePr'
        ? [tr.closePr(r.pr), tr.closePrHint, tr.ackClosePr(r.pr)]
        : r.how === 'revert'
          ? [tr.revert, tr.revertHint, tr.ackRevert]
          : [tr.rollbackPr(r.pr), tr.rollbackPrHint(r.pr), tr.ackRollbackPr(r.pr)];
  return (
    <button className="btn" title={hint} onClick={() => act({ action: 'revoke' }, { close: true, ack, undo: () => api.act(item.id, { action: 'keepApproval' }) })}>
      {label}
    </button>
  );
}

/**
 * A task's decisions, in one row below what it shows. Nobody worked on it yet: start it (a new
 * repository first, where one was picked), later, plan it as an idea or a project, delete it. Somebody
 * did: start it again (a stopped task, a workstream on a prototype's branch, the rest of a
 * workstream after a part of it landed), approve or decide on the prototype, later, stop the agent,
 * archive, delete a stopped task.
 */
function TaskActions({ v, worked, proto, approve }: { v: View; worked: boolean; proto: Proto; approve: ReactNode }) {
  const { item, act, choice, repo } = v;
  // nobody worked on it yet, and it is in no queue (the queue's box has its buttons)
  const unworked = item.state === 'planned' && !worked && !item.queue;
  if (!unworked && !worked) return null;
  // a new repository the start creates first: the button names it, a line under it says what it does
  const fresh = newRepoWords(choice, false);
  // an agent is on the card and can be stopped
  const running = item.state === 'working' || item.state === 'waiting' || !!item.finishing;
  // a stopped task starts again, or goes into the archive with its conversation, from this row
  const halted = stopped(item) && !item.queue;
  const own = item.source === 'manual' && !item.prototypeOf;
  // a workstream given a prototype's branch, which no agent has worked on since, and one planned again after a part of it landed start from this row too
  const onPrototype = item.state === 'planned' && !!item.unstarted && !item.queue;
  const rest = item.state === 'planned' && !!item.landedPart && !item.branch && !item.queue;
  const start = unworked ? (
    // one snoozed to start later starts now with "Wake now" on its line in the conversation
    item.newRepo?.due ? (
      <Armed label={makingWords(item, choice.name)} undo={t.undo} {...(item.newRepo.making ? {} : { onUndo: () => act({ action: 'stayHere' }, { close: false }) })} />
    ) : (
      !item.snoozed && <StartButton item={item} act={act} on={!fresh} disabled={!!fresh && !fresh.ready} label={fresh?.button ?? t.start} hint={fresh?.hint ?? (repo?.folder ? t.folder.startHint : t.startHint)} />
    )
  ) : onPrototype && !item.snoozed ? (
    <StartButton item={item} act={act} label={t.start} hint={t.startHint} />
  ) : rest ? (
    <StartButton item={item} act={act} label={t.landedPart.start} hint={t.landedPart.startHint} />
  ) : (
    halted && !item.archivedAt && <StartButton item={item} act={act} label={t.startAgain} hint={t.startAgainHint} />
  );
  const prototype = item.prototypeOf && <PrototypeActions item={item} act={act} proto={proto} />;
  // work waiting for the owner's verdict: its approval, or on a prototype its decisions
  const decide = handedOver(item) ? prototype || approve : (unworked || running || (halted && !item.archivedAt)) && prototype;
  // a stopped task whose workspace holds work shows the button, which says why it stays
  const refusal = archiveRefusal(item);
  const archive = worked && (!refusal || refusal === 'holdsWork');
  if (!unworked && !(running || archive || halted || onPrototype || rest || snoozable(item) || item.revocable)) return null;
  return (
    <>
      <div className="actions">
        {start}
        {decide}
        <Later item={item} act={act} />
        <RevokeButton item={item} act={act} />
        {worked && running && (
          <button className="btn" title={t.stopHint} onClick={() => act({ action: 'stop' }, { close: true, ack: t.stopped })}>
            {t.stop}
          </button>
        )}
        {/* a task with a branch has work already, one decided as a project goes its way: neither is discussed or planned anew */}
        {unworked && own && plannableAsProject(item) && (
          <>
            <button
              className="btn"
              title={t.idea.makeIdeaHint}
              onClick={async () => {
                await v.flush();
                v.onEdit({ state: 'idea' });
                await v.flush();
              }}
            >
              {t.idea.makeIdea}
            </button>
            <button className="btn" title={t.idea.planDocHint} onClick={() => act({ action: 'planDoc' }, { close: true, ack: t.idea.planned })}>
              {t.idea.planDoc}
            </button>
          </>
        )}
        {archive && <ArchiveButton item={item} run={v.run} />}
        {own && (unworked || (halted && !item.archivedAt)) && <DeleteButton onDelete={v.onDelete} />}
      </div>
      {unworked && fresh && <p className="hint">{fresh.hint}</p>}
    </>
  );
}

/**
 * A task's conversation, from its idea's discussion on: the question its worker waits on (its own,
 * or the one in its demo report) stands at the end, and under it the card's one field (`ownerField`).
 */
function TaskTalk({
  item,
  listener,
  act,
  onTell,
}: {
  item: Item;
  listener?: string | undefined;
  act: Act;
  onTell: Tell;
}) {
  const field = ownerField(item);
  const key = JSON.stringify(item.question ?? null);
  return (
    <Talk
      item={item}
      field={
        field
          ? {
              key: `${item.state}:${item.need ?? ''}:${field}:${key}`,
              placeholder: { note: item.snoozed && !item.snoozed.waiting && !item.snoozed.start ? t.snooze.compose : item.paused || item.pausing ? t.pause.compose : askable(item) || item.followUp ? t.compose.followUp : agentWorks(item) ? t.compose.working : holdsNotes(item) ? t.compose.queued : t.compose.idle, answer: t.compose.question, feedback: t.compose.review, demo: t.compose.demo }[field],
              listener,
              onWords: async (text, images, replyTo) => onTell(text, images, field, replyTo),
              onPicked: (text, [picks = []], images, replyTo) => act({ action: 'answer', text, picks, images, ...(replyTo ? { replyTo } : {}) }, { close: false }),
              onDecided: (text, findings, images, replyTo) => act({ action: 'message', text, findings, ...(images ? { images } : {}), ...(replyTo ? { replyTo } : {}) }, { close: false }),
            }
          : undefined
      }
    />
  );
}

/** Where the card a card comes from opens on its other canvas. */
const elsewhereHref = (item: Item) => cardPath(item.fromElsewhere!.canvas, item.from!);

/** A card that comes from a card on another canvas: which, and a link that opens it there. */
function FromElsewhere({ item }: { item: Item }) {
  const e = item.fromElsewhere!;
  return (
    <p className="hint">
      {t.fromElsewhere(plain(e.title), e.canvasName)}{' '}
      <a className="link" href={elsewhereHref(item)}>
        {t.openThere}
      </a>
    </p>
  );
}
