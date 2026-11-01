// The unfolded card: what it is, what its worker does, and what the owner decides.

import { createContext, type CSSProperties, Fragment, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentListens, answering, askable, type BackgroundTask, buildableOn, type CardAction, type ChangeRoute, chapterAt, prototypeWorkstream, type CardEvent, type CardPatch, type Demo, type EarlierDemo, EXPORT_HTML_MAX, finished, finishedArchivable, finishingUp, handedOver, type Item, type Mock, type NextStep, type PageTags, openQuestions, pausableNow, plannableAsProject, type PrComment, type PrReviewEntry, type PullRequest, type Question, type Finding, type RepoRef, snoozable, type Spot, started, stopped, stoppedArchivable, taskAuthor, withSupplemented } from '../core/types';
import { mockPage } from '../core/frame';
import { mmss } from '../../plugin/skills/demo/lib/timeline.ts';
import { languageName, preferredTrack } from '../core/locale';
import { answerText, toggle } from './answer';
import { ApiError, api, cardAt, type Field, holdRestart, onCardEvent, onCardEventGone, onReconnect } from './api';
import { useCopy } from './copy';
import { firstOpening } from './demoSeen';
import { know, known } from './known';
import { Branch } from './diff';
import { ResultFiles } from './files';
import { DiscardChanges, FolderBox, FolderLine, useFolderDiff } from './folder';
import { landedRef, PauseMark, PlayMark, shownTitle } from './parts';
import { holdsNotes } from '../core/queue';
import { QueueList, scrollerOf, useMenuClose, useQueueMove, useQueueSort, waitedOn } from './queue';
import { dimensions, shownTags } from '../core/page-tags';
import { Inline, plain } from './markdown';
import { Body, Cards, goToMessage, Msg, Quote, Reading, useAnswer, useReportedHeight } from './message';
import { appended, cardDraft, giveBack, questionsKey, typeAtCursor, updateDraft, useDraft } from './draft';
import { eventQuote, type Reply, setReply } from './reply';
import { CiteButton } from './cite';
import { Composer } from './composer';
import { useFitHeight } from './fitHeight';
import { useFullscreen } from './fullscreen';
import { type Box, onto, ZOOM_EASE, ZOOM_MS, zoomBox } from './zoomBox';
import { AttachButton, imageUrl, ShotStrip, Shots, useShotInput } from './shots';
import { useStickToEnd } from './stickToEnd';
import { newRepoWords, type RepoChoice, RepoPick, useRepoChoice } from './repoPick';
import { dismissPlace, type Place, seekTo, showsVersions, usePlace, videoOf, watch } from './spot';
import { cameInView, useSeen } from './seen';
import { ClockMark, SnoozeLine, SnoozeMenu, snoozeWho } from './snooze';
import { becomesLabel, clock as time, errorText, failText, shortDay, snoozeWhen, stateLabel, t, uiLanguage } from './strings';
import { agentWorks, cardTalk, demoHandover, talkState, koordinatorReads, ownerField, parseQuestion, snoozeLine, talkAlone, type Turn, unseenTurns, waitsFirstStart, worked as isWorked } from './talk';
import { PageChangeList } from './page-changes';
import { WishReplyLink } from './wish';
import { claudeLoginFailed } from '../core/login';
import { Reauthenticate } from './reauthenticate';

/**
 * What the panel does after an action: fold the card and confirm (with undo, when it has one), or stay open.
 * With `pending`, the card folds at once, before the server has answered, and says so until it has.
 */
export type ActDone = { close: true; ack: string; undo?: () => unknown; pending?: string } | { close: false };

/** An action the server is still at, after its card has folded: the answer confirms it or tells why not. */
export type Pending = { card: string; title: string; answered: Promise<void> };

/** Words typed into a field of the card: straight to its agent where one listens, else the Koordinator reads them like spoken ones; the panel does not wait. */
type Tell = (text: string, images: string[] | undefined, field: Field, replyTo?: number) => void;

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

export function Detail(p: Props) {
  const { item, parent } = p;
  const [error, setError] = useState('');
  // a prototype whose idea has become a project: the workstream to build on it
  const [workstream, setWorkstream] = useState('');
  const [picking, setPicking] = useState(false);
  const all = p.all;
  const run = async (fn: () => Promise<void>, done: ActDone) => {
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
  const act = (a: CardAction, done: ActDone) => run(() => api.act(item.id, a), done);
  // the repository the card is to be built in, before work on it begins: one of the canvas's or a new one
  const choice = useRepoChoice(item, p.onEdit);
  // in a folder without git the card's change list takes the place of its branch
  const inFolder = !!p.repos.find((r) => r.id === item.repo)?.folder;
  const changes = useFolderDiff(item, inFolder && item.kind === 'task' && !!item.branch);
  // the tab the left column shows: a file picked there or in the change list beside the handover
  const [tab, setTab] = useState<string | null>(null);
  // Obeya reads what is typed here when no agent listens on the card: the field says so, as the microphone does
  const listener = agentListens(item) ? undefined : t.voice.card(plain(item.title));
  const tell = (field: Field) => async (text: string, images?: string[], replyTo?: number) => p.onTell(text, images, field, replyTo);
  const repo = p.repos.length > 1 ? (p.repos.find((r) => r.id === item.repo)?.name ?? item.repo) : '';
  // a plain task says nothing of its kind
  const kind = [
    repo,
    parent
      ? `${plain(parent.title)} · ${item.label ?? ''} · ${t.kind.workstream}`
      : item.state === 'idea' || item.proposal?.idea
        ? t.kind.idea
        : item.becomesProject
          ? becomesLabel(item)
          : item.prototypeOf
            ? t.kind.prototype
            : item.kind === 'project'
              ? t.kind.project
              : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // a proposal being reworked takes the agent's title and text: the fields come back with them, rather than keeping a draft
  // a stopped task keeps what it was started with: the task is its conversation's first message
  const editable = item.source === 'manual' && (item.state === 'planned' || item.state === 'idea' || item.state === 'proposal') && !item.queue && !item.proposal?.revising && !stopped(item);
  if (item.kind === 'question' && item.thread)
    return (
      <>
        <div className="p-kind">{[repo, t.kind.question].filter(Boolean).join(' · ')}</div>
        <div className="p-title">
          <Inline md={item.title} />
        </div>
        <QuestionView item={item} act={act} run={run} onTell={p.onTell} />
        {error && <p className="p-error">{error}</p>}
      </>
    );
  if (item.state === 'idea' && item.idea)
    return (
      <>
        {kind && <div className="p-kind">{kind}</div>}
        {item.archivedAt ? <div className="p-title">{shownTitle(item)}</div> : <ManualTitle item={item} onEdit={p.onEdit} />}
        <SupersededBox item={item} all={all} act={act} onDelete={p.onDelete} />
        <RepoDownBox item={item} />
        <IdeaView item={item} act={act} run={run} listener={listener} onDelete={p.onDelete} onTell={p.onTell} prototypes={!inFolder} choice={choice} repos={p.repos} />
        {error && <p className="p-error">{error}</p>}
      </>
    );
  if (item.prototypeEnd)
    return (
      <>
        {kind && <div className="p-kind">{kind}</div>}
        <div className="p-title">
          <Inline md={item.title} />
        </div>
        <div className="p-state">
          ● {stateLabel(item)}
          {archivedOn(item)}
        </div>
        <p className="hint ended">
          {item.builtInto ? t.idea.builtInto(plain(item.ideaTitle ?? ''), plain(item.builtInto)) : t.idea.endedLong[item.prototypeEnd](plain(item.ideaTitle ?? p.from?.title ?? ''))}
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
  const worked = isWorked(item);
  // a new repository the start creates first: the button names it, a line under it says what it does
  const fresh = newRepoWords(choice, false);
  // a task waiting for its first start, planned or in the queue, keeps its text in full beside its conversation, where notes wait for its agent
  const waits = waitsFirstStart(item);
  // a demo, video or HTML artifact, goes to a page where the repository has a share target, else it is exported as a file; prototypes stay here
  const shares = p.repos.find((r) => r.id === item.repo);
  // about the demo shown, the latest or an earlier one
  const sharing = !!item.demo && !item.prototypeOf;
  const shareBox = (demo: Demo) =>
    shares?.share || item.share ? (
      <ShareBox
        item={item}
        demo={demo}
        act={act}
        onApproval={!!shares?.shareOnApproval}
        // on the personal site, the tick that is not there yet turns sharing with the approval on for the whole repository
        approveAll={shares?.shareOnPersonal && !shares.shareOnApproval ? () => run(async () => {
          await api.shareApprovedRepo(shares.path, true);
          if (item.notOnApproval) await api.act(item.id, { action: 'shareOnApproval', on: true });
        }, { close: false }) : undefined}
        vocabulary={shares?.shareTags}
        unlisted={item.share ? !!item.share.unlisted : !!shares?.shareUnlisted}
      />
    ) : (
      <ExportBox item={item} demo={demo} run={run} needs={shares?.shareNeeds} personal={shares?.sharePersonal} repoPath={shares?.path} onDemoSites={p.onDemoSites} />
    );
  // a prototype is discarded or its idea built on it, never approved or deleted; built once the idea's agent has taken in what changed
  const ideaTitle = plain(item.ideaTitle ?? p.from?.title ?? '');
  // once the idea has become a project, one of its workstreams is built on the prototype instead
  const project = item.prototypeOf ? all.find((i) => i.kind === 'project' && i.origin === item.prototypeOf) : undefined;
  const workstreams = project ? all.filter((i) => i.parent === project.id && buildableOn(i)) : [];
  // the plan doc says which workstream builds on the prototypes; the owner picks only where it does not, or another
  const named = project && !picking ? prototypeWorkstream(all, project.id) : undefined;
  const chosen = named ?? workstreams.find((w) => w.id === workstream);
  const ideaThinking = !project && !!p.from?.idea?.thinking;
  const planning = !project && !!p.from?.becomesProject;
  const buildOn = (label: string) => (
    <button
      className="btn primary"
      disabled={ideaThinking || planning || (!!project && !chosen)}
      title={ideaThinking ? t.idea.prototypeWaits : planning ? t.idea.waitForProject : project && !chosen ? t.idea.chooseWorkstream : undefined}
      onClick={() =>
        act(
          { action: 'buildPrototype', ...(chosen ? { workstream: chosen.id } : {}) },
          { close: true, ack: chosen ? t.idea.builtWorkstream(workstreamName(chosen)) : t.idea.builtPrototype(ideaTitle) },
        )
      }
    >
      {label}
    </button>
  );
  const workstreamPick = project && named ? (
    <div className="build-on">
      <span>
        {t.idea.buildsWorkstream(workstreamName(named))}{' '}
        <button className="link" onClick={() => setPicking(true)}>
          {t.idea.otherWorkstream}
        </button>
      </span>
    </div>
  ) : project && (
    <label className="build-on">
      {t.idea.workstreamOf(plain(project.title))}
      <select value={workstream} onChange={(e) => setWorkstream(e.target.value)}>
        <option value="">{workstreams.length ? t.idea.chooseWorkstream : t.idea.noWorkstream}</option>
        {workstreams.map((w) => (
          <option key={w.id} value={w.id}>
            {workstreamName(w)}
          </option>
        ))}
      </select>
    </label>
  );
  const prototypeActions = item.prototypeOf && (
    <>
      {item.branch && workstreamPick}
      {item.branch && buildOn(t.idea.buildPrototype)}
      <button className="btn" onClick={() => act({ action: 'discard' }, { close: true, ack: t.idea.discarded })}>
        {t.idea.discard}
      </button>
    </>
  );

  // work that changes nothing in the repository ends with the approval: no pull request, nothing lands
  // where work goes out as a pull request, the button says so, and where the settings allow it the
  // owner may have it pushed onto main directly instead; a card's own branch may change both
  const repoRef = p.repos.find((r) => r.id === item.repo);
  const pr = !inFolder && !item.noChange && (item.lands?.land ?? (repoRef?.pullRequests ? 'pr' : 'main')) === 'pr';
  const direct = pr && (item.lands?.direct ?? !!repoRef?.direct);
  const approveButton = item.contribution ? (
    <button
      className="btn primary"
      title={t.review.mergeHint}
      onClick={() => act({ action: 'approve' }, { close: true, ack: t.review.merged(item.contribution!.number), pending: t.review.merging })}
    >
      {t.review.merge(item.contribution.number)}
    </button>
  ) : inFolder ? (
    <>
      <button className="btn primary" title={item.noChange ? undefined : t.folder.approveHint} onClick={() => act({ action: 'approve' }, item.noChange ? { close: true, ack: t.approvedNoChange } : { close: true, ack: t.folder.approved })}>
        {item.noChange ? t.approveNoChange : t.approve}
      </button>
      <DiscardChanges diff={changes.diff} act={act} onDone={changes.reload} />
    </>
  ) : (
    <>
      <button className="btn primary" onClick={() => act({ action: 'approve' }, item.noChange ? { close: true, ack: t.approvedNoChange } : { close: true, ack: t.approved, pending: t.approving })}>
        {item.noChange ? t.approveNoChange : pr ? t.approvePr : t.approve}
      </button>
      {direct && (
        <button className="btn" title={t.directHint} onClick={() => act({ action: 'approve', direct: true }, { close: true, ack: t.approvedDirect, pending: t.approvingDirect })}>
          {t.approveDirect}
        </button>
      )}
    </>
  );

  // work waiting for the owner's verdict, with a demo or a summary
  const review = handedOver(item);
  const demoWaits = item.state === 'waiting' && item.need === 'demo';
  // an agent is on the card and can be stopped
  const running = item.state === 'working' || item.state === 'waiting' || !!item.finishing;
  const archivable = finishedArchivable(item);
  // a stopped task starts again, or goes into the archive with its conversation, from the row below it
  const halted = stopped(item) && !item.queue;
  // a workstream planned again after a part of it landed starts its rest from the same row
  const rest = item.state === 'planned' && !!item.landedPart && !item.branch && !item.queue;
  // an archived project's doc is gone
  const readPlan = parent && !parent.archivedAt && p.onReadPlan;
  // a workstream names its plan doc at the top in every state, an agent's work its branch beside it
  const where = (worked || parent?.plan || item.contribution) && (
    <p className="p-src">
      {item.contribution && (
        <>
          <a href={item.contribution.url} target="_blank" rel="noreferrer">
            {t.review.kind(item.contribution.number, item.contribution.author)} ↗
          </a>
          {worked && ' · '}
        </>
      )}
      {worked && (inFolder ? <FolderLine item={item} diff={changes.diff} sizeBelow={!talkAlone(item)} /> : item.branch && <Branch item={item} sizeBelow={!talkAlone(item)} />)}
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
  // what a card in the queue waits for, with the buttons that start it anyway or take it out of the queue
  const queueBox = item.state === 'planned' && item.queue && (
    <div className="question queue">
      {'checking' in item.queue ? (
        <div className="q-text">{t.queue.checkingLong}</div>
      ) : 'paused' in item.queue ? (
        <>
          <div className="q-text">{t.queue.pausedLong}</div>
          <QueuePlace item={item} items={all} />
          <div className="actions">
            <button className="btn" onClick={() => act({ action: 'dequeue' }, { close: false })}>
              {t.queue.dequeue}
            </button>
          </div>
        </>
      ) : 'workspace' in item.queue ? (
        <>
          <div className="q-text">
            {t.queue.workspaceLong[item.queue.workspace]}{' '}
            {p.onClones && (
              <button className="link" onClick={() => p.onClones?.(item.repo, item.queue && 'workspace' in item.queue && item.queue.workspace === 'slots' ? 'slots' : 'clones')}>
                {t.queue.workspaceConfig[item.queue.workspace]}
              </button>
            )}
          </div>
          <QueuePlace item={item} items={all} />
          <div className="actions">
            <button className="btn" onClick={() => act({ action: 'dequeue' }, { close: false })}>
              {t.queue.dequeue}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="q-text">
            {t.queue.behind(waitedOn(item.queue.behind, all))} {item.queue.reason}
          </div>
          <QueuePlace item={item} items={all} />
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
  );
  // a decided idea keeps what it was decided on, and how
  const brief = item.brief !== undefined && (
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

  return (
    <>
      {kind && <div className="p-kind">{kind}</div>}
      {editable ? <ManualTitle item={item} onEdit={p.onEdit} /> : <div className="p-title">{shownTitle(item)}</div>}
      <div className={['p-state', finishingUp(item) && 'finishing', (item.paused || item.snoozed) && 'paused'].filter(Boolean).join(' ')}>
        ● {stateLabel(item)}
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
        <Limited item={item} />
        {archivedOn(item)}
      </div>
      {where}

      <SupersededBox item={item} all={all} act={act} onDelete={p.onDelete} />
      <RepoDownBox item={item} />

      {item.state === 'proposal' && (
        <ProposalView item={item} from={p.from} act={act} listener={listener} onRevise={tell('revise')}>
          {editable ? (
            <ManualFields item={item} repos={p.repos} choice={choice} onEdit={p.onEdit} grow />
          ) : (
            <>
              <Body md={item.body} />
              <Shots ids={item.images} />
            </>
          )}
        </ProposalView>
      )}

      {!waits && queueBox}

      {item.prototypeOf && (
        <p className="hint">{project ? t.idea.prototypeOfProject(ideaTitle, plain(project.title)) : planning ? t.idea.prototypeOfPlanning(ideaTitle) : t.idea.prototypeOf(ideaTitle)}</p>
      )}
      {item.buildProposal && (
        <div className="question proposal">
          <h4>{t.idea.buildProposal}</h4>
          <div className="q-text">{item.buildProposal}</div>
          <div className="actions">
            {workstreamPick}
            {buildOn(t.idea.acceptBuild)}
          </div>
        </div>
      )}
      {item.builtOn && (
        <p className="hint">{t.idea.builtOn(plain(item.prototypes?.find((x) => x.id === item.builtOn)?.title ?? ''))}</p>
      )}
      {p.from && !item.prototypeOf && item.state !== 'proposal' && <p className="hint">{t.followUpOf(plain(p.from.title))}</p>}
      {!p.from && item.fromElsewhere && item.state !== 'proposal' && <FromElsewhere item={item} />}

      <LastFailure item={item} />

      {item.state === 'planned' && !worked && !waits && (
        <>
          {editable ? (
            <ManualFields item={item} repos={p.repos} choice={choice} fresh onEdit={p.onEdit} />
          ) : (
            <>
              <Body md={item.body} />
              <Shots ids={item.images} />
            </>
          )}
        </>
      )}

      {item.state === 'planned' && !worked && !waits && <Scope files={item.scope} />}

      {/* what the card changed in a folder without git stays in view: in its left column, or above its conversation where it has none */}
      {worked && inFolder && talkAlone(item) && <FolderBox item={item} diff={changes.diff} />}
      {waits ? (
        <Split
          main={
            <>
              {queueBox}
              {editable ? (
                <ManualFields item={item} repos={p.repos} choice={choice} fresh onEdit={p.onEdit} grow />
              ) : (
                <>
                  <Body md={item.body} />
                  <Shots ids={item.images} />
                </>
              )}
              <Scope files={item.scope} />
            </>
          }
          talk={<TaskTalk item={item} act={act} tell={tell} />}
          cite={!!ownerField(item) && cardDraft(item.id)}
        />
      ) : worked ? (
        // what came of the work on the left, once there is something, the conversation with the owner's one field on the right;
        // the task is the conversation's first message, and the summary its handover
        <Split
          main={
            !talkAlone(item) && (
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
                    <Scope files={item.scope} />
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
                {item.contribution && (item.contribution.results || item.contribution.findings) && <Findings item={item} decides={!!ownerField(item) && !finished(item.state)} />}
                {/* the last handover's demo stays while the agent works on the card again; a new handover replaces it. Beside it, the files the work made or changed */}
                <ResultFiles
                  item={item}
                  tab={tab}
                  onTab={setTab}
                  {...(inFolder ? { diff: changes.diff } : {})}
                  demo={
                    item.demo && (
                      <DemoView
                        item={item}
                        demo={item.demo}
                        autoplay={demoWaits}
                        comments={agentListens(item)}
                        top={
                          (!demoWaits || sharing) &&
                          ((shown, latest) => (
                            <>
                              {!demoWaits && latest && <p className="hint">{item.state === 'working' || item.state === 'waiting' ? t.demo.again : t.demo.kept}</p>}
                              {sharing && shareBox(shown)}
                            </>
                          ))
                        }
                      />
                    )
                  }
                />
                {item.pr && (item.state === 'inPr' || item.state === 'waiting') && <PrBox pr={item.pr} />}
                {item.state === 'inPr' && !item.pr && <p className="hint">{t.pr.opening}</p>}
                {item.finishing && finished(item.state) && <p className="hint">{item.followUp ? t.followingUpLong : item.state === 'done' ? t.finishingDoneLong : t.finishingLong}</p>}
                {brief}
              </>
            )
          }
          // what is typed into a card waiting to start waits for its agent, not for Obeya
          talk={<TaskTalk item={item} listener={holdsNotes(item) ? undefined : listener} act={act} tell={tell} />}
          cite={!!ownerField(item) && cardDraft(item.id)}
        />
      ) : (
        <>
          {brief}
          {item.state !== 'planned' && item.state !== 'proposal' && (
            <>
              <Body md={item.body} />
              <Shots ids={item.images} />
            </>
          )}
          {/* a card nobody worked on shows its conversation once there is something, such as a talk with the Koordinator */}
          {item.state !== 'proposal' && (
            <TalkColumn bare>
              <Conversation item={item} past hideEmpty />
            </TalkColumn>
          )}
        </>
      )}

      {error && <p className="p-error">{error}</p>}

      {/* the decisions of a card nobody worked on yet, below what it shows, as on every card */}
      {item.state === 'planned' && !worked && !item.queue && (
        <div className="actions">
          {/* one snoozed to start later starts now with „Jetzt zurückholen“ on its line in the conversation */}
          {item.newRepo?.due ? (
            <Armed label={t.repoPick.making(choice.name)} undo={t.undo} onUndo={() => act({ action: 'stayHere' }, { close: false })} />
          ) : (
            !item.snoozed && (
              <button
                className="btn primary"
                disabled={!!fresh && !fresh.ready}
                title={fresh?.hint ?? (inFolder ? t.folder.startHint : t.startHint)}
                onClick={() => act({ action: 'start' }, { close: false })}
              >
                {fresh?.button ?? t.start}
              </button>
            )
          )}
          <Later item={item} act={act} />
          {prototypeActions}
          {item.source === 'manual' && !item.prototypeOf && (
            <>
              {/* a task with a branch has work already, one decided as a project goes its way: neither is discussed or planned anew */}
              {plannableAsProject(item) && (
                <>
                  <button
                    className="btn"
                    title={t.idea.makeIdeaHint}
                    onClick={async () => {
                      await p.flush();
                      p.onEdit({ state: 'idea' });
                      await p.flush();
                    }}
                  >
                    {t.idea.makeIdea}
                  </button>
                  <button className="btn" title={t.idea.planDocHint} onClick={() => act({ action: 'planDoc' }, { close: true, ack: t.idea.planned })}>
                    {t.idea.planDoc}
                  </button>
                </>
              )}
              <button className="btn danger" onClick={p.onDelete}>
                {t.delete}
              </button>
            </>
          )}
        </div>
      )}

      {/* the decisions go below both columns, as on an idea or a proposal */}
      {worked && (running || archivable || halted || rest || snoozable(item)) && (
        <div className="actions">
          {rest && (
            <button className="btn primary" title={t.landedPart.startHint} onClick={() => act({ action: 'start' }, { close: false })}>
              {t.landedPart.start}
            </button>
          )}
          {halted && !item.archivedAt && (
            <button className="btn primary" title={t.startAgainHint} onClick={() => act({ action: 'start' }, { close: false })}>
              {t.startAgain}
            </button>
          )}
          {review ? prototypeActions || approveButton : (running || (halted && !item.archivedAt)) && prototypeActions}
          <Later item={item} act={act} />
          {running && (
            <button className="btn" title={t.stopHint} onClick={() => act({ action: 'stop' }, { close: true, ack: t.stopped })}>
              {t.stop}
            </button>
          )}
          {(archivable || (halted && !item.prototypeOf && item.source === 'manual')) && <ArchiveButton item={item} run={run} />}
          {halted && !item.archivedAt && item.source === 'manual' && !item.prototypeOf && (
            <button className="btn danger" onClick={p.onDelete}>
              {t.delete}
            </button>
          )}
        </div>
      )}
      {item.state === 'planned' && !worked && !item.queue && fresh && <p className="hint">{fresh.hint}</p>}
      {review && item.noChange && !item.prototypeOf && <p className="hint">{inFolder ? t.folder.noChangeHint : t.noChangeHint}</p>}
      {review && direct && !item.prototypeOf && <p className="hint">{t.directHint}</p>}
    </>
  );
}

/** Beside the card's state: its agent (not its worker, which says so in its status line) waits for the usage limit, until when. */
const Limited = ({ item }: { item: Item }) => (item.limitedUntil ? <span className="p-status"> · {t.limitedUntil(time(item.limitedUntil))}</span> : null);

/** When the card went into the archive, after its state. */
const archivedOn = (i: Item) => i.archivedAt && <span className="p-status"> · {t.archive.when(new Date(i.archivedAt))}</span>;

/** „Später …“ in a card's action row, on any card the owner can snooze that is not snoozed yet (a snoozed one changes its time on its line in the conversation). */
function Later({ item, act }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void> }) {
  if (!snoozable(item) || item.snoozed) return null;
  return <SnoozeMenu label={t.snooze.button} onSnooze={(until) => void act({ action: 'snooze', until }, { close: false })} />;
}

// ------------------------------------------------------------------ ideas

/**
 * An idea under discussion: the brief its agent keeps on top, a prototype's demo when there is one,
 * then the conversation, and the owner's decisions.
 */
/**
 * On an accepted proposal its agent withdrew or replaced since: who did, why, and the choice to
 * remove the card (as „Löschen“ does, its worker stopped, with an undo) or keep it.
 */
function SupersededBox({ item, all, act, onDelete }: { item: Item; all: Item[]; act: (a: CardAction, done: ActDone) => Promise<void>; onDelete: () => void }) {
  const s = item.superseded;
  if (!s) return null;
  // the replacement under its title now, if it is still on the canvas
  const by = s.by ? plain(all.find((x) => x.id === s.by)?.title ?? s.title ?? '') : undefined;
  return (
    <div className="question superseded">
      <h4>{by !== undefined ? t.superseded.by(by) : t.superseded.withdrawn}</h4>
      {s.why && <div className="q-text">{s.why}</div>}
      <div className="actions">
        <button className="btn danger" title={t.superseded.removeHint} onClick={onDelete}>
          {t.superseded.remove}
        </button>
        <button className="btn" title={t.superseded.keepHint} onClick={() => act({ action: 'keep' }, { close: false })}>
          {t.superseded.keep}
        </button>
      </div>
    </div>
  );
}

/** Where the card a card comes from opens on its other canvas. */
const elsewhereHref = (item: Item) => `?c=${encodeURIComponent(item.fromElsewhere!.canvas)}&card=${encodeURIComponent(item.from!)}`;

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

/** On a card whose repository does not run on the canvas: no agent works on it until that is back. */
function RepoDownBox({ item }: { item: Item }) {
  if (!item.repoDown) return null;
  return (
    <div className="question repo-down">
      <div className="q-text">{t.repoDown.long(item.repo)}</div>
    </div>
  );
}

/** `prototypes`: the idea's repository can have them (a folder without git has no branch to build one on). */
function IdeaView({
  item,
  act,
  run,
  listener,
  onDelete,
  onTell,
  prototypes,
  choice,
  repos,
}: {
  item: Item;
  act: (a: CardAction, done: ActDone) => Promise<void>;
  run: Run;
  listener?: string;
  onDelete: () => void;
  onTell: Tell;
  prototypes: boolean;
  choice: RepoChoice;
  repos: RepoRef[];
}) {
  const idea = item.idea!;
  // a new repository building creates first: the button names it, a line under it says what it does
  const fresh = newRepoWords(choice, true);
  const [prototyping, setPrototyping] = useState(false);
  // what the agent would do in the owner's place is the marked click; without a suggestion, building is
  const next = idea.status === 'open' && !idea.thinking ? idea.next : undefined;
  const btn = (step: NextStep['step']) => (next ? (next.step === step ? 'btn primary suggested' : 'btn') : step === 'build' ? 'btn primary' : 'btn');
  return (
    <>
      <div className={['p-state', finishingUp(item) && 'finishing', item.snoozed && 'paused'].filter(Boolean).join(' ')}>
        ● {stateLabel(item)}
        {item.snoozed && <span className="p-status"> · {snoozeWho(item.snoozed)}</span>}
        {idea.thinking && <span className="p-status"> · {t.author.explorer} {t.idea.thinking}</span>}
        <Limited item={item} />
        {archivedOn(item)}
      </div>
      {/* the brief is what stays; the conversation beside it is how it came about */}
      <Split
        cite={!item.archivedAt && cardDraft(item.id)}
        main={
          <>
            <div className="question brief">
              <h4>{t.idea.brief}</h4>
              {idea.brief.trim() ? <Body md={idea.brief} /> : <div className="hint">{t.idea.briefEmpty}</div>}
              <Mocks mocks={idea.mocks} />
            </div>
            {/* what "Teilaufgabe abtrennen" would build, as its worker's task */}
            {idea.split && !item.archivedAt && (
              // opened at the bottom of the column, it scrolls into view rather than opening out of sight
              <details className="question brief settled" onToggle={(e) => e.currentTarget.open && e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
                <summary>{t.idea.settled(idea.split.title)}</summary>
                <Body md={idea.split.brief} />
              </details>
            )}
            <PrototypeDemos item={item} />
          </>
        }
        talk={
          // an archived idea is read only: it comes back onto the canvas before anyone talks to it again
          item.archivedAt ? (
            <Talk item={item} past />
          ) : (
            <Talk
              item={item}
              field={{
                placeholder: t.idea.compose,
                listener,
                quote: true,
                onWords: async (words, images, replyTo) => onTell(words, images, 'discuss', replyTo),
                onPicked: (text, _, images, replyTo) => act({ action: 'discuss', text, images, ...(replyTo ? { replyTo } : {}) }, { close: false }),
              }}
            />
          )
        }
      />
      {idea.status !== 'open' && !item.archivedAt && <p className="hint">{t.idea.reopen}</p>}
      {item.archivedAt ? (
        <div className="actions">
          <ArchiveButton item={item} run={run} />
        </div>
      ) : prototyping ? (
        <PrototypeStart item={item} act={act} />
      ) : (
        <>
          {next && (
            <div className={`next-step ${next.step}`}>
              <span className="next-h">{t.idea.next}</span>
              <span>
                <b>{t.idea.nextStep[next.step](idea.questions.length)}</b>
                {next.why && <> – {next.why}</>}
              </span>
            </div>
          )}
          {/* planning waits for the reply, which will change the brief the owner decides on; building goes ahead after it unless it asks questions */}
          {idea.thinking && <p className={idea.buildAfterReply ? 'hint go-waits' : 'hint'}>{idea.buildAfterReply ? t.idea.buildWaitsHint : idea.split ? t.idea.waitForReplySplit : t.idea.waitForReply}</p>}
          {idea.status === 'open' && !item.newRepo?.due && <RepoPick choice={choice} repos={repos} />}
          <div className="actions">
            {/* the settled part as a task of its own; the reply may change the split, so it waits for it */}
            {idea.split && (
              <button
                className={btn('splitOff')}
                disabled={idea.thinking}
                title={t.idea.splitOffHint(idea.split.title)}
                onClick={() => act({ action: 'splitOff' }, { close: false })}
              >
                {t.idea.splitOff}
              </button>
            )}
            {item.newRepo?.due ? (
              <Armed label={t.repoPick.making(choice.name)} undo={t.undo} onUndo={() => act({ action: 'stayHere' }, { close: false })} />
            ) : idea.buildAfterReply ? (
              <Armed label={t.idea.buildWaits} undo={t.idea.unbuild} onUndo={() => act({ action: 'unbuild' }, { close: false })} />
            ) : (
              // while the agent works, the click waits for its reply in view; else the panel closes on the built card;
              // built in a new repository, it stays open for „Rückgängig“ and then follows the card to its canvas
              <button
                className={btn('build')}
                disabled={!!fresh && !fresh.ready}
                title={fresh?.hint}
                onClick={() => act({ action: 'build' }, idea.thinking || fresh ? { close: false } : { close: true, ack: t.idea.built })}
              >
                {fresh?.button ?? t.idea.build}
              </button>
            )}
            <button className={btn('planDoc')} disabled={idea.thinking} onClick={() => act({ action: 'planDoc' }, { close: true, ack: t.idea.planned })}>
              {t.idea.planDoc}
            </button>
            {prototypes && (
              <button className={btn('prototype')} onClick={() => setPrototyping(true)}>
                {t.idea.prototype}
              </button>
            )}
            {idea.status !== 'parked' && (
              <button className={btn('park')} onClick={() => act({ action: 'park' }, { close: true, ack: t.idea.parked })}>
                {t.idea.park}
              </button>
            )}
            {idea.status !== 'dropped' && (
              <button className={btn('drop')} onClick={() => act({ action: 'drop' }, { close: true, ack: t.idea.dropped })}>
                {t.idea.drop}
              </button>
            )}
            <Later item={item} act={act} />
            {/* not while a prototype of it is on the canvas */}
            {idea.status !== 'open' && !item.prototypes?.some((p) => !p.archivedAt) && <ArchiveButton item={item} run={run} />}
            <button className="btn danger" onClick={onDelete}>
              {t.delete}
            </button>
          </div>
          {fresh && <p className="hint">{fresh.hint}</p>}
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Question cards

/**
 * A thread of looked-up answers on a card of its own: its conversation with the agent that looked
 * them up, whom the owner's words reach directly, and the two ways on: discuss it as an idea, or done.
 */
function QuestionView({ item, act, run, onTell }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void>; run: Run; onTell: Tell }) {
  const thread = item.thread!;
  return (
    <>
      <div className="p-state">
        ● {t.question.count(thread.answers, thread.files)} · {thread.thinking ? t.question.reading : t.question.ready}
        <Limited item={item} />
        {archivedOn(item)}
      </div>
      {/* the conversation alone, as tall as the room down to the microphone allows */}
      <Split
        main={null}
        talk={
          item.archivedAt ? (
            <Talk item={item} past />
          ) : (
            <Talk
              item={item}
              field={{
                placeholder: t.question.compose,
                quote: true,
                onWords: async (words, images, replyTo) => onTell(words, images, 'note', replyTo),
                onPicked: (text, _, images, replyTo) => act({ action: 'ask', text, images, ...(replyTo ? { replyTo } : {}) }, { close: false }),
              }}
            />
          )
        }
      />
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
    </>
  );
}

/**
 * A proposal: its text as the agent taking it on will read it (`children`, editable), why it was
 * proposed, and the questions to decide, which the owner may answer before taking it.
 */
function ProposalView({
  item,
  from,
  act,
  listener,
  onRevise,
  children,
}: {
  item: Item;
  from?: Item;
  act: (a: CardAction, done: ActDone) => Promise<void>;
  listener?: string;
  /** What should change in it, typed (maybe in reply to a message of its conversation): an agent reworks the proposal by it. */
  onRevise: (text: string, images?: string[], replyTo?: number) => Promise<void>;
  children: ReactNode;
}) {
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
      {/* the proposal as it stands, and beside it the talk about what should change, as with an idea */}
      <Split
        className="proposal-grid"
        cite={cardDraft(item.id)}
        main={
          <>
            {children}
            {/* which of the owner's screenshots go with the task, by their hand or the reviser's pick */}
            {!!item.images?.length && <p className="hint">{t.proposalShots}</p>}
            {!idea && <StartAt item={item} act={act} />}
            {from && <p className="hint">{t.proposedBy(plain(from.title))}{item.proposal?.reason && <> {item.proposal.reason}</>}</p>}
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
        talk={
          <Talk
            item={item}
            // while it is reworked, the owner's words wait for the rework after it, unread until then
            field={{
              placeholder: t.compose.revise,
              listener,
              quote: true,
              onWords: (words, images, replyTo) => onRevise(words, images, replyTo),
              onPicked: (text, _, images, replyTo) => act({ action: 'revise', text, images, ...(replyTo ? { replyTo } : {}) }, { close: false }),
            }}
          />
        }
      />
      {revising && <p className={armed ? 'hint go-waits' : 'hint'}>{armed ? t.acceptWaitsHint : t.acceptWaitsFor(idea ? t.acceptIdea : t.accept)}</p>}
      <div className="actions">
        {armed ? (
          <Armed label={t.acceptWaits(idea || armed === 'idea')} undo={t.unaccept} onUndo={() => act({ action: 'unaccept' }, { close: false })} />
        ) : (
          // one to start later is planned and waits until then: taking it on is all there is to it
          <button className="btn primary" title={later ? t.startAt.accept : undefined} onClick={() => accept(true)}>
            {idea ? t.acceptIdea : later ? t.acceptOnly : t.accept}
          </button>
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
    </>
  );
}

/** When a proposed task starts once accepted, with „Ändern“: another time, or none, so it starts at once. */
function StartAt({ item, act }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void> }) {
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

/** A go clicked while an agent works on the card ("So bauen", "Übernehmen und starten"): it waits armed until the agent is done, its take-back beside it. */
function Armed({ label, undo, onUndo }: { label: string; undo: string; onUndo: () => void }) {
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

/**
 * "Prototyp bauen lassen": the variants the idea's agent planned, each chosen unless its prototype
 * runs already, and an approach of the owner's own; one prototype each starts at once.
 */
function PrototypeStart({ item, act }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void> }) {
  const variants = item.idea!.variants;
  const running = new Set((item.prototypes ?? []).flatMap((p) => (!p.archivedAt && p.variant ? [p.variant] : [])));
  const [chosen, setChosen] = useState(() => variants.filter((v) => !running.has(v.approach)).map((v) => v.approach));
  const [own, setOwn] = useState(false);
  const n = chosen.length + (own ? 1 : 0);
  // the choice opens below the conversation, often out of sight
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  return (
    <>
      {variants.length > 0 && (
        <div className="question ask prototype-variants">
          <h4>{t.idea.variants}</h4>
          <div className="choices multiple" role="group">
            {variants.map((v) => {
              const on = chosen.includes(v.approach);
              return (
                <button
                  key={v.approach}
                  role="checkbox"
                  aria-checked={on}
                  className={`choice${on ? ' on' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setChosen(variants.map((x) => x.approach).filter((a) => (a === v.approach ? !on : chosen.includes(a))))}
                >
                  <span>
                    <b>{v.approach}</b>
                    {running.has(v.approach) && <span className="pick-tag">{t.idea.variantRuns}</span>}
                    <span className="v-show" title={v.show}>
                      {v.show}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Composer
        placeholder={variants.length ? t.idea.prototypeOwn : t.idea.prototypePlaceholder}
        action={t.idea.prototypeGo(Math.max(n, 1))}
        allowEmpty={!variants.length || chosen.length > 0}
        noImages
        onText={(text) => setOwn(!!text.trim())}
        onSend={(text) =>
          act(
            { action: 'prototype', ...(text ? { text } : {}), ...(variants.length ? { variants: chosen } : {}) },
            { close: true, ack: t.idea.prototyped(Math.max(n, 1)) },
          )
        }
      />
      <div ref={end} className="prototype-end" />
    </>
  );
}

/** A workstream as the owner picks it: its label and title. */
const workstreamName = (w: Item) => `${w.label ? `${w.label} ` : ''}${plain(w.title)}`;

/** The demos of an idea's prototypes, each under its title and how it stands; the latest one open. */
function PrototypeDemos({ item }: { item: Item }) {
  const all = item.prototypes ?? [];
  if (!all.length) return null;
  const latest = all.filter((p) => p.demo).at(-1);
  return (
    <>
      <h4 className="p-h">{t.idea.prototypes}</h4>
      {all.map((p) => (
        <details key={p.id} className="prototype-demo" open={p === latest}>
          <summary>
            <Inline md={p.title} /> <span className="hint">· {stateLabel(p)}</span>
          </summary>
          {p.demo ? (
            <DemoView item={p} summary={p.summary ?? ''} demo={p.demo} autoplay={false}>
              <p className="hint">{t.idea.prototypeKept}</p>
            </DemoView>
          ) : (
            <p className="hint">{t.idea.prototypeNoDemo}</p>
          )}
        </details>
      ))}
    </>
  );
}

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
function Conversation({
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
  const events = useEvents(item.id);
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
  const by = idea ? 'explorer' : question ? 'koordinator' : 'worker';
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
    <Seed item={item} by={taskAuthor(item)} who={`${t.talk.opening[taskAuthor(item)]} · ${t.task}`}>
      <Scope files={item.scope} />
    </Seed>
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
      />
      {turn.e.id === held.at(-1) && (
        <div className="held-note">
          {t.demo.held(held.length)}
          <button className="held-send" title={t.demo.sendNowHint} onClick={() => void api.act(item.id, { action: 'release', now: true }).catch(() => {})}>
            {t.demo.sendNow}
          </button>
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
      <h4 className="p-h">{t.talk.heading}</h4>
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
        {!working && !past && koordinatorReads(events) && <Reading />}
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

/** Who wrote the task an agent started on: the owner, a plan doc, the Arbeitsrückschau, an agent's proposal, or a prototype's idea. */

/** Where a conversation starts, as its first message: what was said to an idea, the task an agent started on; long ones folded. */
function Seed({ item, by, who, children }: { item: Item; by: string; who: string; children?: ReactNode }) {
  return (
    <Msg by={by} className="seed" who={who}>
      <Fold>
        <Body md={item.body} />
      </Fold>
      <Shots ids={item.images} />
      {children}
    </Msg>
  );
}

/** A text shown to its first eight lines or so (or `lines`), with "more" for the rest. */
function Fold({ children, lines }: { children: ReactNode; lines?: number }) {
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

/** The files the Koordinator expects a card to change, folded. */
function Scope({ files }: { files?: string[] }) {
  if (!files?.length) return null;
  return (
    <details className="p-task">
      <summary>
        {t.scope} ({files.length})
      </summary>
      <ul className="p-files">
        {files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A state change or an error between the messages, or a message. */
function Line({ turn, snoozed, explained, ...rest }: { turn: Turn; snoozed?: Item; explained?: boolean; demoQuestion?: Demo; quoted?: CardEvent; fresh?: boolean; onReply?: (e: CardEvent) => void; onDelete?: () => void }) {
  return snoozed ? (
    <SnoozeLine item={snoozed} e={turn.e} at={time(turn.e.at)} />
  ) : turn.line ? (
    <div className={`note ev-${turn.e.kind}`} title={turn.e.code ? turn.e.text : undefined}>
      {time(turn.e.at)} · <Linked text={eventText(turn.e)} />
      {turn.e.kind === 'error' && !explained && claudeLoginFailed(turn.e.text) && <Reauthenticate token={turn.e.token} />}
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
 * owner had not seen it when the conversation came into view.
 */
function Message({
  turn,
  demoQuestion,
  quoted,
  fresh,
  onReply,
  onDelete,
  unread,
}: {
  turn: Turn;
  demoQuestion?: Demo;
  quoted?: CardEvent;
  fresh?: boolean;
  onReply?: (e: CardEvent) => void;
  onDelete?: () => void;
  unread?: string;
}) {
  const { e, steps } = turn;
  const q = e.kind === 'question' ? parseQuestion(e.text) : undefined;
  const answer = useAnswer(e);
  return (
    <Msg
      by={ownerSide(e) ? 'owner' : e.author}
      className={[q && 'q', turn.end && `ended ${turn.end}`, fresh && 'fresh', unread ? 'unread' : onDelete && 'held'].filter(Boolean).join(' ')}
      who={`${t.author[e.author]}${e.kind === 'question' ? ` · ${t.talk.question}` : e.kind === 'review' ? ` · ${t.talk.handover}` : ''}`}
      at={e.at}
      ev={e.id}
      onReply={onReply && !turn.quiet ? () => onReply(e) : undefined}
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
function Mocks({ mocks }: { mocks?: Mock[] }) {
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

/** The highest an HTML demo's frame grows; a page higher still scrolls inside it. */
const ARTIFACT_CAP = 30000;

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
  return line.length > 140 ? line.slice(0, 139) + '…' : line;
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

type Run = (fn: () => Promise<void>, done: ActDone) => Promise<void>;

/**
 * The narrated demo with its chapters and the report beside it. `comments`: the card's agent hears the
 * owner, whose words may be about a place in the video. Once a later handover replaced a demo, the
 * owner may step back to it and forth again; a comment on a place in it takes them there too.
 */
function DemoView({
  item,
  summary = '',
  demo: latest,
  children,
  top,
  autoplay = true,
  comments = false,
}: {
  item: Item;
  summary?: string;
  demo: Demo;
  children?: ReactNode;
  /** above the video or artifact, where it is seen on opening however long the chapters or the artifact: sharing, about the demo shown */
  top?: false | ((shown: Demo, latest: boolean) => ReactNode);
  autoplay?: boolean;
  comments?: boolean;
}) {
  const cardId = item.id;
  const video = useRef<HTMLVideoElement>(null);
  // on the phone the field is in a panel of its own, which a comment brings up
  const elsewhere = useContext(TalkElsewhere);
  const artifact = useRef<HTMLIFrameElement>(null);
  const artifactHeight = useReportedHeight(artifact, ARTIFACT_CAP);
  const [now, setNow] = useState(0);
  // the video's shape once its metadata is in: until it first plays, Chrome sizes the element by its poster, and
  // by its default 300 × 150 when the poster does not load, a flat strip at full width
  const [shape, setShape] = useState<string>();
  // the earlier demo shown (its `n`), or the latest; a new handover leaves the owner where they are
  const [shownN, setShownN] = useState<number | null>(null);
  const earlier = item.demos ?? [];
  const demo = earlier.find((d) => d.n === shownN) ?? latest;
  const all = [...earlier, latest];
  const shownAt = all.indexOf(demo);
  // a new handover often renders into the same directory: its handover in the address makes a card left open load it afresh
  const src = (f: string) => cardAt(cardId, `${demo === latest ? `/demo/${f}` : `/demos/${(demo as EarlierDemo).n}/${f}`}${demo.handover === undefined ? '' : `?v=${demo.handover}`}`);
  // where the demo shown next plays from, when a comment on a place in it took the owner there
  const playFrom = useRef<number | null>(null);
  const show = (d: Demo) => setShownN(d === latest ? null : (d as EarlierDemo).n);
  // start once the card has unfolded, like the mock, the first time only; a demo kept on a finished card waits to be played.
  // A page out of sight (a tab in the background, an agent's browser) does not start it: nobody would see it, only hear it
  const [autostart] = useState(() => autoplay && demo.kind !== 'html' && !document.hidden && firstOpening(localStorage, cardId, demo));
  // a video that does not start on its own shows a big play button over it until it first plays
  const [started, setStarted] = useState(autostart);
  useEffect(() => {
    if (!autostart) return;
    const h = setTimeout(() => (document.hidden ? setStarted(false) : video.current?.play().catch(() => setStarted(false))), 300);
    return () => clearTimeout(h);
  }, []);
  useEffect(() => () => holdRestart('video', null), []);
  const zoom = useZoom(video);
  // the phone view, which puts the conversation elsewhere, puts the video into full screen itself (fullscreen.ts)
  const fullscreen = useFullscreen(zoom.screen, video, !!elsewhere);
  const seek = useSeekKeys(video);
  const watching = useWatching(cardId, video, comments && demo.kind !== 'html' ? demo.chapters : null, demo.handover);
  const current = chapterAt(demo.chapters, now);
  useEffect(() => {
    if (!earlier.length) return;
    return showsVersions({
      cardId,
      shown: demo.handover,
      show: (handover, from) => {
        const d = all.find((d) => d.handover === handover);
        if (!d) return false;
        playFrom.current = from;
        show(d);
        return true;
      },
    });
  }, [demo, latest, item.demos]);
  // another demo shown: it starts from the beginning, or from the place a comment took the owner to
  const firstShown = useRef(true);
  useEffect(() => {
    if (firstShown.current) return void (firstShown.current = false);
    setNow(0);
    const v = video.current;
    const from = playFrom.current;
    playFrom.current = null;
    if (!v) return;
    if (from === null) return setStarted(false);
    const go = () => {
      v.currentTime = from;
      v.play().catch(() => setStarted(false));
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
    // into view with the line above it, unless its top is in view already
    const column = v.closest('.split-main')?.getBoundingClientRect();
    const top = v.getBoundingClientRect().top;
    if (column && (top < column.top || top > column.bottom - 80)) v.closest('.demo-view')?.querySelector('.demo-versions')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return () => v.removeEventListener('loadedmetadata', go);
  }, [shownN]);
  return (
    <>
      <div className="demo-view">
        {/* which of the card's demos is shown, in the line with sharing */}
        {(earlier.length > 0 || top) && (
          <div className="demo-top">
            {earlier.length > 0 && (
              <div className={demo === latest ? 'demo-versions' : 'demo-versions earlier'} title={demo === latest ? undefined : t.demo.earlierHint}>
                <button className="step" disabled={shownAt === 0} title={t.demo.older} aria-label={t.demo.older} onClick={() => show(all[shownAt - 1]!)}>
                  ‹
                </button>
                <span>
                  {t.demo.version(shownAt + 1, all.length, demo === latest)}
                  {demo.at && ` · ${handedAt(demo.at)}`}
                  {demo.handover !== undefined && item.share?.on?.includes(demo.handover) && (
                    <span className="on-page" title={t.share.onPageMark} aria-label={t.share.onPageMark}>
                      <ShareIcon />
                    </span>
                  )}
                </span>
                <button className="step" disabled={demo === latest} title={t.demo.newer} aria-label={t.demo.newer} onClick={() => show(all[shownAt + 1]!)}>
                  ›
                </button>
                {shownAt < all.length - 2 && (
                  <button className="link" onClick={() => show(latest)}>
                    {t.demo.toLatest}
                  </button>
                )}
              </div>
            )}
            {top && top(demo, demo === latest)}
          </div>
        )}
        {demo.kind === 'html' ? (
          // the worker's page: scripts run, but in an origin of its own, away from Obeya's API. Once
          // the frame has the page's height, the page stops scrolling up and down by itself
          // (`withHeightReport`); sideways it still scrolls, where it is wider than the frame
          <iframe ref={artifact} className="artifact" sandbox="allow-scripts" src={src('index.html')} title={t.demo.artifact} style={{ height: artifactHeight }} />
        ) : (
          <div className="player" ref={zoom.player} style={zoom.box ? { height: zoom.box.from.height } : undefined}>
            {zoom.box && <div className={zoom.box.closing ? 'demo-zoom closing' : 'demo-zoom'} ref={zoom.backdrop} title={t.demo.unzoom} onClick={zoom.toggle} />}
            <div
              className={zoom.box ? 'screen zoomed' : fullscreen.full ? 'screen full' : 'screen'}
              ref={zoom.screen}
              style={zoom.box ? { left: zoom.box.to.left, top: zoom.box.to.top, width: zoom.box.to.width, height: zoom.box.to.height } : undefined}
            >
              <video
                ref={video}
                controls
                controlsList={fullscreen.can ? 'nofullscreen' : undefined}
                preload="metadata"
                poster={demo.noPoster ? undefined : src('poster.jpg')}
                src={src('demo.mp4')}
                style={shape ? { aspectRatio: shape } : undefined}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth && v.videoHeight) setShape(`${v.videoWidth} / ${v.videoHeight}`);
                }}
                onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
                onFocus={(e) => seek.focused(e.currentTarget)}
                // a restart waits while the owner watches
                onPlay={() => {
                  setStarted(true);
                  holdRestart('video', 'video');
                }}
                onPause={() => holdRestart('video', null)}
                onEnded={() => {
                  holdRestart('video', null);
                  watching.ended();
                }}
              >
                {demo.tracks ? (
                  // a track per language, named in the interface's (none: no subtitles); a silent video shows one from the start, in the interface's language where it has a track in it, else the first
                  demo.tracks.map((l) => (
                    <track
                      key={src(`captions.${l}.vtt`)}
                      kind="captions"
                      src={src(`captions.${l}.vtt`)}
                      srcLang={l}
                      label={languageName(l, uiLanguage())}
                      default={!!demo.silent && l === preferredTrack(demo.tracks!, [uiLanguage()])}
                    />
                  ))
                ) : (
                  <track key={src('captions.vtt')} kind="captions" src={src('captions.vtt')} label={t.demo.captions} default={!!demo.silent} />
                )}
              </video>
              {seek.hint && (
                <span className="seek-hint">
                  {t.demo.seekHint} <kbd>←</kbd> <kbd>→</kbd>
                </span>
              )}
              {!started && (
                // a click anywhere on the video but its controls starts it, like on a shared page
                <button className="start" aria-label={t.demo.play} onClick={() => video.current?.play().catch(() => {})}>
                  <span>
                    <svg viewBox="0 0 24 24">
                      <path d="M6 4l15 8-15 8z" />
                    </svg>
                  </span>
                </button>
              )}
              {comments && started && (
                <button
                  className="comment-here"
                  title={t.demo.commentHint}
                  onClick={() => {
                    video.current?.pause();
                    if (zoom.box) zoom.toggle();
                    fullscreen.leave();
                    if (elsewhere) elsewhere.open(true);
                    else document.querySelector<HTMLTextAreaElement>('.card-sheet .split-talk .composer textarea')?.focus();
                  }}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" />
                  </svg>
                  {t.demo.comment}
                </button>
              )}
              {fullscreen.can && (
                <button className="fullscreen" title={fullscreen.full ? t.demo.fullscreenOff : t.demo.fullscreen} aria-label={fullscreen.full ? t.demo.fullscreenOff : t.demo.fullscreen} onClick={fullscreen.toggle}>
                  <svg viewBox="0 0 24 24">
                    <path d={fullscreen.full ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
                  </svg>
                </button>
              )}
              <button
                className="zoom"
                title={zoom.keyKnown ? (zoom.box ? t.demo.unzoom : t.demo.zoom) : undefined}
                aria-label={zoom.box ? t.demo.unzoom : t.demo.zoom}
                onClick={zoom.toggle}
              >
                {/* the key beside the magnifier until the owner first zoomed with it */}
                {!zoom.keyKnown && (
                  <span className="zoom-hint">
                    {zoom.box ? t.demo.unzoomHint : t.demo.zoomHint} <kbd>Z</kbd>
                  </span>
                )}
                <svg viewBox="0 0 24 24">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d={zoom.box ? 'M7.5 10.5h6M15.5 15.5L21 21' : 'M7.5 10.5h6M10.5 7.5v6M15.5 15.5L21 21'} />
                </svg>
              </button>
            </div>
          </div>
        )}
        {demo.chapters.length > 0 && (
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
        )}
        {/* its report's question stands in the conversation, where it is answered */}
        {children}
      </div>
      <Body md={summary} />
    </>
  );
}

/** When a demo was handed over: the time of day, with the day when it was not today. */
const handedAt = (at: string) => (new Date(at).toDateString() === new Date().toDateString() ? time(at) : `${shortDay(at)}, ${time(at)}`);

/** A video standing this long has been watched to its end, as far as the comments on it are concerned. */
const STOOD_MS = 3 * 60_000;

/**
 * The card's demo video as the one its words may be about (`chapters` null: they are not): typing in
 * the card's field pauses it, and the owner's comments on places in it, which Obeya holds back while
 * they watch, go to the agent once they have finished: the video ended, stood for a few minutes, or
 * the card closed. Words without a place, and an approval, take them too (on the server).
 */
function useWatching(cardId: string, video: RefObject<HTMLVideoElement | null>, chapters: [number, string][] | null, demo?: number) {
  const on = !!chapters;
  const release = () => void api.act(cardId, { action: 'release' }).catch(() => {});
  // going to another of the card's demos is no sign the owner has finished watching
  useEffect(() => {
    const v = video.current;
    if (!on || !v) return;
    return watch(cardId, v, chapters, demo);
  }, [on, demo]);
  useEffect(() => {
    const v = video.current;
    if (!on || !v) return;
    const typed = (e: Event) => {
      if (!v.paused && e.target instanceof HTMLTextAreaElement && e.target.closest('.card-sheet .split-talk .composer, #ph-card-talk .composer')) v.pause();
    };
    let stood: ReturnType<typeof setTimeout> | undefined;
    const paused = () => {
      clearTimeout(stood);
      stood = setTimeout(release, STOOD_MS);
    };
    const played = () => clearTimeout(stood);
    v.addEventListener('pause', paused);
    v.addEventListener('play', played);
    addEventListener('input', typed, true);
    return () => {
      clearTimeout(stood);
      v.removeEventListener('pause', paused);
      v.removeEventListener('play', played);
      removeEventListener('input', typed, true);
      release();
    };
  }, [on]);
  return { ended: () => on && release() };
}

/** A key with no modifier, pressed outside a text field and with nothing over the card: one for the demo video. */
function forTheVideo(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return false;
  return !document.querySelector('#help, #config.on, .lightbox, .diff-view');
}

/** The demo video the keys are for, with several on a card: the zoomed one, else the one playing, else the first. */
function keyedVideo() {
  const videos = [...document.querySelectorAll<HTMLVideoElement>('.card-sheet .demo-view video')];
  return document.querySelector<HTMLVideoElement>('.screen.zoomed video') ?? videos.find((v) => !v.paused) ?? videos[0];
}

/** How far ← and → jump in the demo video, in seconds. */
const SEEK_S = 5;
/** How soon after the video handed the focus back its controls take it again for their overflow menu: a press on its button, ms. */
const MENU_FOCUS_MS = 1000;
/** Set once the owner jumped with the arrow keys: a click on the video's controls stops showing them. */
const SEEK_KEYS_KNOWN = 'obeya-seek-keys-known';

/**
 * ← and → jump back and forward in the demo video, without a click on its progress bar first. The
 * browser's controls keep every key to themselves once clicked (Space too, which then neither paused
 * the video nor started a recording), so the video hands the focus back to the page at once; then
 * the keys reach Obeya's own handlers. Their overflow menu (⋮) takes the focus as it opens, right
 * after the press on its button gave it to them, and closes when it loses it: the focus coming back
 * that soon stays. Without a mouse (a phone, a tablet) there are no keys, and the focus stays too. A
 * click on the controls shows the keys over the video for a moment, until the owner first jumped
 * with them.
 */
function useSeekKeys(video: RefObject<HTMLVideoElement | null>) {
  const [hint, setHint] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const v = video.current;
      if (!v || !forTheVideo(e) || keyedVideo() !== v) return;
      e.preventDefault();
      const to = v.currentTime + (e.key === 'ArrowLeft' ? -SEEK_S : SEEK_S);
      v.currentTime = Math.max(0, Number.isFinite(v.duration) ? Math.min(v.duration, to) : to);
      setHint(false);
      know(SEEK_KEYS_KNOWN);
    };
    addEventListener('keydown', key);
    return () => {
      removeEventListener('keydown', key);
      clearTimeout(hide.current);
    };
  }, []);
  /** when the video last handed the focus back */
  const gaveBack = useRef(-Infinity);
  const focused = (v: HTMLVideoElement) => {
    if (!matchMedia('(pointer: fine)').matches || performance.now() - gaveBack.current < MENU_FOCUS_MS) return;
    v.blur();
    gaveBack.current = performance.now();
    if (known(SEEK_KEYS_KNOWN)) return;
    setHint(true);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setHint(false), 4000);
  };
  return { hint, focused };
}

/** Set once the owner zoomed with Z: the magnifier stops showing the key beside it. */
const ZOOM_KEY_KNOWN = 'obeya-zoom-key-known';

/**
 * The demo video shown large over the greyed page, short of full screen: the same video element
 * (it keeps playing) grows out of its place in the card and goes back into it. Z or the button on
 * the video toggles it, Esc or a click beside it ends it. With several demos on a card, Z takes the
 * zoomed one, else the one playing, else the first. Hovering the magnifier shows the key until
 * the owner first used it.
 */
function useZoom(video: RefObject<HTMLVideoElement | null>) {
  const player = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ from: Box; to: Box; closing?: boolean } | null>(null);
  const [keyKnown, setKeyKnown] = useState(() => known(ZOOM_KEY_KNOWN));
  const boxRef = useRef(box);
  boxRef.current = box;
  const toggle = () => {
    const cur = boxRef.current;
    const el = screen.current;
    if (!el || cur?.closing) return;
    if (!cur) {
      const from = el.getBoundingClientRect();
      const v = video.current;
      const aspect = v?.videoWidth ? v.videoWidth / v.videoHeight : from.width / from.height;
      setBox({ from: { left: from.left, top: from.top, width: from.width, height: from.height }, to: zoomBox(aspect, innerWidth, innerHeight) });
      return;
    }
    // back into its place in the card, wherever that is by now
    const r = player.current!.getBoundingClientRect();
    const back = { left: r.left, top: r.top, width: r.width, height: cur.from.height * (r.width / cur.from.width) };
    setBox({ ...cur, closing: true });
    el.animate([{ transform: 'none' }, { transform: onto(back, cur.to) }], { duration: ZOOM_MS, easing: ZOOM_EASE, fill: 'forwards' }).onfinish = () => {
      setBox(null);
      el.getAnimations().forEach((a) => a.cancel());
    };
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  // grows out of where it stood
  const zoomed = !!box;
  useLayoutEffect(() => {
    const cur = boxRef.current;
    if (!cur || !screen.current) return;
    screen.current.animate([{ transform: onto(cur.from, cur.to) }, { transform: 'none' }], { duration: ZOOM_MS, easing: ZOOM_EASE });
  }, [zoomed]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (boxRef.current) toggleRef.current();
        return;
      }
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (e.repeat || !forTheVideo(e) || keyedVideo() !== video.current) return;
      e.preventDefault();
      toggleRef.current();
      setKeyKnown(true);
      know(ZOOM_KEY_KNOWN);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  // a resized window resizes the zoomed video; a wheel over it does not scroll the card behind
  useEffect(() => {
    if (!zoomed) return;
    const resize = () => {
      const v = video.current;
      const cur = boxRef.current;
      if (cur && !cur.closing && v?.videoWidth) setBox({ ...cur, to: zoomBox(v.videoWidth / v.videoHeight, innerWidth, innerHeight) });
    };
    const still = (e: WheelEvent) => e.preventDefault();
    const els = [screen.current, backdrop.current];
    addEventListener('resize', resize);
    els.forEach((el) => el?.addEventListener('wheel', still, { passive: false }));
    return () => {
      removeEventListener('resize', resize);
      els.forEach((el) => el?.removeEventListener('wheel', still));
    };
  }, [zoomed]);
  return { player, screen, backdrop, box, toggle, keyKnown };
}

/**
 * What a review card's agent found, beside its demo: the checks on the PR's head and the merge probe
 * on one line, then each finding of the review, which its agent keeps as the conversation goes on.
 * Findings its agent would make one follow-up task stand together in a bracket that says so, while
 * they are open or made one. On an open finding the owner decides („An Beitragenden“, „Selbst
 * ändern“, „Als Folgeaufgabe“, a second click takes it back; a bracket picks nothing for its others)
 * while their words reach its agent (`decides`); the decisions stand in the card's draft and go out
 * with the field's one Send. „Selbst ändern“ is greyed with its reason where the contributor allows
 * no edits by maintainers. A finding something came of says what; one made a follow-up task links
 * that task.
 */
function Findings({ item, decides }: { item: Item; decides: boolean }) {
  const c = item.contribution!;
  const cards = useContext(Cards);
  const draft = cardDraft(item.id);
  const picks = useDraft(draft).findings ?? {};
  const findings = c.findings ?? [];
  const open = findings.filter((f) => f.status === 'open');
  const pick = (f: Finding, route: ChangeRoute) =>
    updateDraft(draft, (d) => {
      const { [f.id]: was, ...rest } = d.findings ?? {};
      return { findings: was === route ? rest : { ...rest, [f.id]: route } };
    });
  const ok = !!c.results && c.results.mergeable && c.results.checks.every((x) => x.passed);
  const one = (f: Finding) => {
    const task = f.status === 'later' && f.card ? cards.items.find((x) => x.id === f.card) : undefined;
    return (
      <div key={f.id} className={['finding', f.security && 'security', f.status !== 'open' && 'settled'].filter(Boolean).join(' ')}>
        <div className="f-head">
          <span className="f-no">{f.id}</span>
          <b>{f.title}</b>
          {f.security && <span className="f-tag">{t.review.security}</span>}
        </div>
        <div className="f-text">
          <Inline md={f.text} />
        </div>
        {f.status !== 'open' ? (
          <div className="f-status">
            {task ? (
              <a href="#" onClick={(e) => (e.preventDefault(), cards.open(task))}>
                {t.review.laterCard(plain(task.title))} →
              </a>
            ) : f.url ? (
              <a href={f.url} target="_blank" rel="noreferrer">
                {t.review.status[f.status](c.author)} ↗
              </a>
            ) : (
              t.review.status[f.status](c.author)
            )}
          </div>
        ) : f.decided ? (
          <div className="f-status pending">{f.decided === 'self' ? t.review.goingSelf : f.decided === 'later' ? t.review.goingLater : t.review.goingTo(c.author)}</div>
        ) : (
          decides && (
            <div className="choices single f-choices" role="group">
              <button className={`choice${picks[f.id] === 'contributor' ? ' on' : ''}`} aria-pressed={picks[f.id] === 'contributor'} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(f, 'contributor')}>
                {t.review.toContributor}
              </button>
              <button
                className={`choice${picks[f.id] === 'self' ? ' on' : ''}`}
                aria-pressed={picks[f.id] === 'self'}
                disabled={!c.canModify}
                title={c.canModify ? t.review.selfHint : t.review.selfOff(c.author)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(f, 'self')}
              >
                {t.review.self}
              </button>
              <button className={`choice${picks[f.id] === 'later' ? ' on' : ''}`} aria-pressed={picks[f.id] === 'later'} title={t.review.laterHint} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(f, 'later')}>
                {t.review.later}
              </button>
            </div>
          )
        )}
      </div>
    );
  };
  // each finding once: alone, or where the first of its bundle stands, with the others of it
  const shown = new Set<number>();
  const blocks = findings.flatMap((f) => {
    if (shown.has(f.id)) return [];
    const bundle = findings.filter((o) => (o.id === f.id || f.with?.includes(o.id)) && bundled(o));
    if (!bundled(f) || bundle.length < 2) return [one(f)];
    for (const o of bundle) shown.add(o.id);
    return [
      <div key={`b${f.id}`} className="f-bundle">
        <div className="f-bundle-head">{t.review.bundle(bundle.map((o) => o.id))}</div>
        {bundle.map(one)}
      </div>,
    ];
  });
  return (
    <section className="findings">
      {c.results && <div className={ok ? 'rr-checks ok' : 'rr-checks bad'}>{t.review.checks(c.results)}</div>}
      {c.findings && (
        <h4 className="p-h">{t.review.findings(findings.length, open.length, open.filter((f) => f.security).length)}</h4>
      )}
      {blocks}
      {decides && open.some((f) => !f.decided) && <p className="hint">{t.review.decideHint}</p>}
    </section>
  );
}

/** A finding whose bundle still means something: open, or made a follow-up task. */
const bundled = (f: Finding) => f.status === 'open' || f.status === 'later';

/**
 * Above the field of a review card: what the owner decided for its findings, which goes out with the
 * words; with several made follow-up tasks, how many tasks they become as their agent bundled them.
 */
function DecidedChip({ item, decided }: { item: Item; decided: Record<string, ChangeRoute> }) {
  const c = item.contribution!;
  const named = Object.entries(decided).filter(([id]) => c.findings?.some((f) => f.id === Number(id) && f.status === 'open' && !f.decided));
  if (!named.length) return null;
  const later = named.filter(([, route]) => route === 'later').map(([id]) => c.findings!.find((f) => f.id === Number(id))!);
  const tasks = new Set(later.map((f) => [f.id, ...(f.with ?? []).filter((w) => later.some((l) => l.id === w))].sort((a, b) => a - b).join())).size;
  return (
    <div className="quote decided">
      <div className="decided-lines">
        {named.map(([id, route]) => (
          <span key={id} className="quote-text">
            {t.review.decidedLine(Number(id), route === 'self' ? t.review.self : route === 'later' ? t.review.later : t.review.toContributor)}
          </span>
        ))}
        {later.length > 1 && <span className="decided-tasks">{t.review.tasks(tasks)}</span>}
      </div>
      <button className="quote-clear" title={t.review.undecide} aria-label={t.review.undecide} onMouseDown={(m) => m.preventDefault()} onClick={() => updateDraft(cardDraft(item.id), { findings: undefined })}>
        ×
      </button>
    </div>
  );
}

/** A card's pull request: its checks, whether it is ready, and its review. */
function PrBox({ pr }: { pr: PullRequest }) {
  return (
    <div className="question pr">
      <h4>
        <a href={pr.url} target="_blank" rel="noreferrer">
          {t.pr.title(pr.number)} ↗
        </a>
      </h4>
      {pr.conflict && <div className="q-text">{t.pr.conflict}</div>}
      {pr.ready && <div className="q-text">{pr.held ? t.pr.held(pr.held.score, pr.held.by) : pr.manual ? t.pr.manual : t.pr.ready(pr.mergeError ?? '')}</div>}
      {pr.checks.length > 0 ? (
        <ul className="checks">
          {pr.checks.map((c) => (
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
      {pr.review && <PrReview entries={pr.review} />}
    </div>
  );
}

/**
 * Sharing the demo shown with colleagues: "Teilen" publishes it right away, then the page's link with
 * "Nicht mehr teilen" for this demo. A demo not on the page yet goes onto it beside the versions
 * there („Zur Seite dazunehmen“; an earlier demo in its place by handover) or, the latest, in their place
 * („Auf der Seite ersetzen“), the worker's word on it first; "Erneut teilen" once the site writes pages
 * differently than when it published this one. Where the site publishes on approval (`onApproval`),
 * the latest demo not on the page has „Mit der Freigabe teilen“ until the card is approved, and
 * "Teilen" reads „Jetzt teilen“: the owner may share it before approving, or not on approving.
 */
function ShareBox({ item, demo, act, onApproval, approveAll, vocabulary, unlisted }: { item: Item; demo: Demo; act: (a: CardAction, done: ActDone) => Promise<void>; onApproval: boolean; approveAll?: (() => Promise<void>) | undefined; vocabulary?: PageTags | undefined; unlisted: boolean }) {
  const [copied, copy] = useCopy(2000);
  const s = item.share;
  const all = [...(item.demos ?? []), ...(item.demo ? [item.demo] : [])];
  const latest = demo === item.demo;
  const which = demo.handover !== undefined ? { demo: demo.handover } : {};
  const go = (a: CardAction) => act(a, { close: false });
  const busy = s?.state === 'publishing' || s?.state === 'withdrawing';
  // the versions on the page, by their numbers in the line above
  const numbers = all.flatMap((d, i) => (d.handover !== undefined && s?.on?.includes(d.handover) ? [i + 1] : []));
  const onPage = numbers.length ? t.share.demos(numbers) : null;
  // the earlier demos this one supplements go on a new page with it
  const mine = all.indexOf(demo);
  const along = mine < 0 ? [] : withSupplemented(all, mine).slice(0, -1).map((d) => all.indexOf(d) + 1);
  // a latest demo from before handovers were kept is on the page unless the page shows an earlier one
  const here = !!s?.url && (demo.handover !== undefined ? !!s.on?.includes(demo.handover) : latest && !s.stale);
  // approving would put this demo on the page: the owner may opt out, or share it now; where it would not, the owner may have it do so for the repository
  const before = latest && !here && !busy && !item.landing && (item.state === 'working' || item.state === 'waiting');
  const later = onApproval && before;
  const approval = (later || (before && approveAll)) && (
    <label className="share-check" title={later ? t.share.onApprovalHint : t.share.onApprovalRepoHint}>
      <input type="checkbox" checked={later && !item.notOnApproval} onChange={(e) => (later ? go({ action: 'shareOnApproval', on: e.target.checked }) : void approveAll?.())} />
      {item.contribution ? t.review.onApproval : t.share.onApproval}
    </label>
  );
  const replace = (first: boolean) => (
    <button key="replace" className={first ? 'btn primary' : 'btn'} title={t.share.replaceHint} onClick={() => go({ action: 'share', ...which })}>
      {t.share.replace}
    </button>
  );
  const add = (first: boolean) => (
    <button key="add" className={first ? 'btn primary' : 'btn'} title={latest ? t.share.addHint : t.share.addEarlierHint} onClick={() => go({ action: 'share', ...which, add: true })}>
      {latest ? t.share.add : t.share.share}
    </button>
  );
  const link = (
    <>
      <span className="share-label">{t.share.shared}</span>
      <a className="share-link" href={s?.url} target="_blank" rel="noreferrer" title={t.share.open}>
        {s?.url?.replace(/^https?:\/\//, '')}
      </a>
      <button className="btn" onClick={() => copy(s!.url!)}>
        {copied ? t.share.copied : t.share.copy}
      </button>
    </>
  );
  return (
    // the button and what is under way stay on the right, where the button was; the link takes the line
    <div className={s?.url && !busy ? 'share wide' : 'share'}>
      {busy ? (
        <span className="share-busy">{s.state === 'publishing' ? t.share.publishing : t.share.withdrawing}</span>
      ) : !s?.url ? (
        <div className="share-row">
          {along.length > 0 && <p className="hint">{t.share.along(t.share.demos(along))}</p>}
          {approval}
          <button className="btn share-go" title={later ? t.share.shareNowHint : unlisted ? t.share.shareHintUnlisted : demo.kind === 'html' ? t.share.shareHintHtml : t.share.shareHint} onClick={() => go({ action: 'share', ...which })}>
            <ShareIcon />
            {later ? t.share.shareNow : t.share.share}
          </button>
        </div>
      ) : here ? (
        <>
          <div className="share-row">
            {link}
            <button className="btn" title={numbers.length > 1 ? t.share.stopOneHint : t.share.stopHint} onClick={() => go({ action: 'unshare', ...which })}>
              {t.share.stop}
            </button>
          </div>
          {all.length > 1 && onPage && <p className="hint">{t.share.onPage(onPage)}</p>}
          {s.unlisted && <p className="hint">{t.share.unlisted}</p>}
          {s.outdated && (
            <div className="share-row">
              <p className="hint">{t.share.outdated}</p>
              <PageChangeList changes={s.outdated.map((id) => ({ id }))} />
              <button className="btn" title={t.share.reshareHint} onClick={() => go({ action: 'share', ...which })}>
                {t.share.reshare}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="share-row">{link}</div>
          <div className="share-row">
            <p className="hint">
              {t.share.pageShows(onPage)}
              {latest && demo.follows && all.length > 1 && (
                <>
                  <br />
                  <span className="agent-says">{t.share.agentSays(demo.follows, all.length - 1)}</span>
                </>
              )}
            </p>
            {/* the worker's word comes first; without it „Auf der Seite ersetzen“, as the latest demo always went out before */}
            {!latest ? add(false) : demo.follows === 'supplements' ? [add(true), replace(false)] : [replace(true), add(false)]}
          </div>
          {approval && <div className="share-row">{approval}</div>}
        </>
      )}
      {vocabulary && <ShareTags tags={item.tags} vocabulary={vocabulary} set={(dimension, values) => go({ action: 'pageTags', dimension, values })} />}
    </div>
  );
}

/**
 * The page's tags as chips, before sharing and after: × takes one off, „+“ offers the values of the
 * site's vocabulary the page lacks. A change takes effect at once (a shared page goes out again), and
 * stays: neither a later worker nor Obeya's reading session changes what the owner set.
 */
function ShareTags({ tags, vocabulary, set }: { tags: PageTags | undefined; vocabulary: PageTags; set: (dimension: string, values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(open, box, () => setOpen(false), true);
  const shown = shownTags(tags, vocabulary);
  const on = new Map(shown);
  const rest = dimensions(vocabulary).flatMap(([d, values]) => {
    const left = values.filter((v) => !on.get(d)?.includes(v));
    return left.length ? [[d, left] as const] : [];
  });
  return (
    <div className="share-row share-tags" ref={box} title={t.share.tagsHint}>
      <span className="share-label">{t.share.tags}</span>
      {!shown.length && <span className="hint t">{t.share.noTags}</span>}
      {shown.flatMap(([d, values]) =>
        values.map((v) => (
          <span key={`${d}\n${v}`} className="tag-chip">
            <span className="t">
              <span className="dim">{d}:</span> {v}
            </span>
            <button className="x" title={t.share.removeTag(d, v)} aria-label={t.share.removeTag(d, v)} onClick={() => set(d, values.filter((x) => x !== v))}>
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          </span>
        )),
      )}
      {rest.length > 0 && (
        <span className="menu-pill">
          <button className={open ? 'tag-add on' : 'tag-add'} title={t.share.addTag} aria-label={t.share.addTag} aria-expanded={open} onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1.5v7M1.5 5h7" />
            </svg>
          </button>
          {open && (
            <div className="bar-menu tag-menu">
              {rest.map(([d, values]) => (
                <div key={d} className="tag-dim">
                  <span className="hint">{d}</span>
                  {values.map((v) => (
                    <button
                      key={v}
                      className="tag-chip pick"
                      onClick={() => {
                        setOpen(false);
                        set(d, [...(on.get(d) ?? []), v]);
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

/** Sharing's mark on its button: a box with an arrow going out of it. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12M7.5 7.5L12 3l4.5 4.5M5 11v9h14v-9" />
    </svg>
  );
}

/**
 * "Teilen" where the repository has no share target: the demo as a file to pass on, a ZIP of its
 * page with the video or the HTML artifact beside it, or one HTML file that holds everything
 * (short videos, artifacts that are their index.html alone). Where its site lacks its credentials
 * on this machine, a line under the buttons names the file.
 */
function ExportBox({
  item,
  demo,
  run,
  needs,
  personal,
  repoPath,
  onDemoSites,
}: {
  item: Item;
  demo: Demo;
  run: Run;
  needs?: { site: string; file: string } | undefined;
  /** Why the owner's personal demo site does not take the demo: none set up here, or the repository is private and not ticked. */
  personal?: 'none' | 'private' | undefined;
  repoPath?: string | undefined;
  /** Opens the configuration at the personal demo site. */
  onDemoSites?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'zip' | 'html' | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const artifact = demo.kind === 'html';
  // the demo shown: the latest, or an earlier one by its place among the card's earlier demos
  const n = demo === item.demo ? undefined : (demo as EarlierDemo).n;
  useEffect(() => {
    setSize(null);
    if (open && !artifact) api.demoSize(item.id, n).then(setSize, () => {});
  }, [open, item.id, artifact, n]);
  const tooLarge = size !== null && size > EXPORT_HTML_MAX;
  const notAlone = artifact && !demo.single;
  const go = (as: 'zip' | 'html') => {
    setBusy(as);
    void run(() => api.exportDemo(item.id, as, demo === item.demo ? undefined : demo.handover), { close: false }).finally(() => setBusy(null));
  };
  return (
    <div className={open ? 'share wide' : 'share'}>
      {!open ? (
        <button className="btn share-go" title={t.share.exportHint} onClick={() => setOpen(true)}>
          <ShareIcon />
          {t.share.share}
        </button>
      ) : (
        <>
          {!needs && personal !== 'private' && <p className="hint">{t.share.exportIntro}</p>}
          <div className="share-row">
            <button className="btn" title={artifact ? t.share.zipHintHtml : t.share.zipHint} disabled={!!busy} onClick={() => go('zip')}>
              {busy === 'zip' ? t.share.preparing : t.share.zip}
            </button>
            <button
              className="btn"
              title={tooLarge ? t.share.tooLarge(size!) : notAlone ? t.share.notAlone : artifact ? t.share.htmlHintHtml : t.share.htmlHint}
              disabled={!!busy || tooLarge || notAlone}
              onClick={() => go('html')}
            >
              {busy === 'html' ? t.share.preparing : t.share.html}
            </button>
          </div>
          {tooLarge && <p className="hint">{t.share.tooLarge(size!)}</p>}
          {notAlone && <p className="hint">{t.share.notAlone}</p>}
          {busy && !demo.page && <p className="hint">{t.share.writingPage}</p>}
        </>
      )}
      {needs && <p className="hint">{t.share.needsEnv(needs.site, needs.file)}</p>}
      {open && personal === 'none' && onDemoSites && (
        <p className="hint">
          {t.share.noPersonal}{' '}
          <button className="link" onClick={onDemoSites}>
            {t.share.setUpPersonal}
          </button>
        </p>
      )}
      {open && personal === 'private' && repoPath && (
        <>
          <p className="hint">{t.share.privateRepo}</p>
          <label className="share-check">
            <input type="checkbox" checked={false} onChange={() => void run(() => api.allowPrivateRepo(repoPath, true).then(() => {}), { close: false })} />
            {t.share.allowPrivate}
          </label>
        </>
      )}
    </div>
  );
}

/**
 * Takes a finished card or a parked or dropped idea into the archive, or an archived one back onto
 * the canvas; `className`, `label` and `hint` dress the button that archives.
 */
function ArchiveButton({ item, run, className = 'btn', label = t.archive.archive, hint }: { item: Item; run: Run; className?: string; label?: string; hint?: string }) {
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

// ------------------------------------------------------------------ manual cards

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

/** `fresh`: the repository picker offers a new repository (not on a proposal, which starts where it is). */
function ManualFields({ item, repos, choice, fresh, onEdit, grow }: { item: Item; repos: RepoRef[]; choice: RepoChoice; fresh?: boolean; onEdit: (p: CardPatch) => void; grow?: boolean }) {
  const [body, setBody] = useState(item.body);
  // a proposal's text shows in full as far as the screen allows, the panel growing with it
  const ref = useRef<HTMLTextAreaElement>(null);
  useFitHeight(ref, body, grow);
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
      {/* the task's screenshots: the worker gets them with the task when it starts */}
      <div className={`p-body-field${shots.dropping ? ' dropping' : ''}`} {...shots.drop}>
        <ShotStrip shots={shots} />
        <div className="c-field">
          <textarea
            ref={ref}
            className="p-body"
            value={body}
            placeholder={t.bodyPlaceholder}
            maxLength={20000}
            onPaste={shots.onPaste}
            onChange={(e) => {
              setBody(e.target.value);
              onEdit({ body: e.target.value });
            }}
          />
          <AttachButton shots={shots} />
        </div>
        {shots.error && <p className="p-error c-error">{shots.error}</p>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ talking to the worker

/**
 * A task's conversation, from its idea's discussion on: the question its worker waits on (its own,
 * or the one in its demo report) stands at the end, and under it the card's one field (`ownerField`).
 */
function TaskTalk({
  item,
  listener,
  act,
  tell,
}: {
  item: Item;
  listener?: string;
  act: (a: CardAction, done: ActDone) => Promise<void>;
  tell: (field: Field) => (text: string, images?: string[], replyTo?: number) => Promise<void>;
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
              placeholder: { note: item.snoozed && !item.snoozed.waiting && !item.snoozed.start ? t.snooze.compose : item.paused || item.pausing ? t.pause.compose : askable(item) || item.followUp ? t.compose.followUp : agentWorks(item) ? t.compose.working : holdsNotes(item) ? t.compose.queued : t.compose.idle, answer: t.compose.question, feedback: t.compose.review, demo: t.compose.demo, discuss: '', revise: t.compose.revise }[field],
              listener,
              onWords: tell(field),
              onPicked: (text, [picks = []], images, replyTo) => act({ action: 'answer', text, picks, images, ...(replyTo ? { replyTo } : {}) }, { close: false }),
              onDecided: (text, findings, images, replyTo) => act({ action: 'message', text, findings, ...(images ? { images } : {}), ...(replyTo ? { replyTo } : {}) }, { close: false }),
            }
          : undefined
      }
    />
  );
}

/**
 * The layout every card with a conversation shares, idea, proposal, task or question: what the card
 * is about on the left (brief, text, demo), the conversation on the right; the decisions go below
 * both. Without anything on the left (a task with no result yet, a question), the conversation
 * stands alone. `cite`:
 * the draft of the card's field, which text marked on the left can be quoted into.
 */
function Split({ main, talk, className, cite }: { main: ReactNode; talk: ReactNode; className?: string; cite?: string | false }) {
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
function TalkColumn({ children, bare }: { children: ReactNode; bare?: boolean }) {
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
  noImages?: boolean;
  /**
   * The picks stand in the text, each with its question: the conversation is read later without
   * the questions beside. Without it the text is the owner's words, and the picks go apart from
   * them; the conversation marks them on the question.
   */
  quote?: boolean;
  /** Words alone go to the card's agent, or to the Koordinator that `listener` names; `replyTo`: the message they reply to. */
  onWords: (text: string, images?: string[], replyTo?: number) => Promise<void>;
  /** Picked options go to the agent with the words: `picks` holds them for each question, and with `quote` the text names them too. */
  onPicked: (text: string, picks: string[][], images?: string[], replyTo?: number) => Promise<void>;
  /** On a review card: the owner's decisions on its findings go to the agent with the words. */
  onDecided?: (text: string, findings: Record<string, ChangeRoute>, images?: string[], replyTo?: number) => Promise<void>;
}

/**
 * The right column of every card with a conversation: the conversation with the questions it waits
 * on at its end, and under it the owner's one field (none where nobody hears it). `past`: nobody
 * works on the card any more. Where the field is, the owner can reply to a message of the
 * conversation: it stands quoted above the field, and the words go out with it.
 */
function Talk({ item, past, field }: { item: Item; past?: boolean; field?: TalkField }) {
  const picks = useOpenQuestions(item, past);
  const { questions, picked } = picks;
  const options = questions.some((q) => q.options.length > 0);
  const draft = cardDraft(item.id);
  // the demo video stands at a place: the words are about it, where the card's agent hears them
  const place = usePlace(item.id);
  const at = field && !field.listener && !options ? place : null;
  // a review card's field, where its agent hears the words: the owner's decisions on its findings go with them
  const review = !!item.contribution && !!field && !field.listener && !finished(item.state);
  const allDecided = useDraft(draft).findings;
  const decided = review && allDecided ? Object.fromEntries(Object.entries(allDecided).filter(([id]) => item.contribution!.findings?.some((f) => f.id === Number(id) && f.status === 'open' && !f.decided))) : {};
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
          noImages={field.noImages}
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
function useOpenQuestions(item: Item, past = false) {
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

/** A card's log, live; null while the history loads. It loads anew once the connection is back: what was pushed meanwhile never came. */
export function useEvents(cardId: string): CardEvent[] | null {
  const [events, setEvents] = useState<CardEvent[] | null>(null);
  useEffect(() => {
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
 * Why a planned card is not running: a start through the Koordinator that failed afterwards drops
 * the card back to planned, and the reason is the last entry of its log.
 */
function LastFailure({ item }: { item: Item }) {
  const last = explainedFailure(item, useEvents(item.id));
  if (!last) return null;
  return (
    <div className="question failed">
      <h4>{t.lastFailure(time(last.at))}</h4>
      <div className="q-text" title={last.code ? last.text : undefined}>
        {eventText(last)}
        {claudeLoginFailed(last.text) && <Reauthenticate start token={last.token} />}
      </div>
    </div>
  );
}

/** The first line of a comment, for its folded view. */
const firstLine = (md: string) => (md.split('\n').find((l) => l.trim()) ?? '').replace(/^\s*[-*+]\s+/, '').trim();

/** Who wrote a PR comment: the PR's author is the worker, writing in the owner's name. */
const who = (c: { author: string; mine?: boolean }) => (c.mine ? t.pr.agent : c.author);

/**
 * A pull request's review: each round a reviewer left comments on the code in, every comment
 * folded to its first line with whether its thread is done; unfolded, the comment and the replies.
 * Between the rounds the conversation (the requests for another round, the reviewer's summary).
 */
function PrReview({ entries }: { entries: PrReviewEntry[] }) {
  let round = 0;
  return (
    <div className="pr-review">
      <h5>{t.pr.review}</h5>
      {entries.map((e, i) =>
        'threads' in e ? (
          <div key={i} className="pr-round">
            <div className="pr-head">
              <b>{t.pr.round(++round, who(e))}</b> · {time(e.at)} · {t.pr.threads(e.threads.length, e.threads.filter((th) => !th.resolved).length)}
            </div>
            {e.threads.map((th, j) => (
              <details key={j} className={`pr-thread ${th.resolved ? 'resolved' : 'open'}`}>
                <summary title={th.resolved ? t.pr.resolved : t.pr.open}>
                  <span className="pr-first">
                    <Inline md={firstLine(th.body)} />
                  </span>
                  {th.replies.length > 0 && <span className="pr-meta">{t.pr.replies(th.replies.length)}</span>}
                </summary>
                <div className="pr-body">
                  {th.path && (
                    <div className="pr-where">
                      {th.url ? (
                        <a href={th.url} target="_blank" rel="noreferrer">
                          {th.path}
                          {th.line ? `:${th.line}` : ''} ↗
                        </a>
                      ) : (
                        th.path
                      )}
                    </div>
                  )}
                  <Body md={th.body} />
                  {th.replies.map((r, k) => (
                    <PrReply key={k} c={r} />
                  ))}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <details key={i} className="pr-comment">
            <summary>
              <b>{who(e)}</b> · {e.edited ? t.pr.edited(time(e.at)) : time(e.at)} · <span className="pr-first">
                <Inline md={firstLine(e.body)} />
              </span>
            </summary>
            <div className="pr-body">
              <Body md={e.body} />
              {e.url && (
                <a href={e.url} target="_blank" rel="noreferrer">
                  {t.pr.onForge} ↗
                </a>
              )}
            </div>
          </details>
        ),
      )}
    </div>
  );
}

function PrReply({ c }: { c: PrComment }) {
  return (
    <div className={`pr-reply${c.mine ? ' mine' : ''}`}>
      <div className="pr-meta">
        <b>{who(c)}</b> · {time(c.at)}
      </div>
      <Body md={c.body} />
    </div>
  );
}
