// The unfolded card: what it is, what its worker does, and what the owner decides.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { agentListens, answering, type ApproveResult, askable, type CardAction, type CardPatch, type Demo, finished, finishedArchivable, finishingUp, handedOver, type Item, plannableAsProject, type RepoRef, snoozable, stopped } from '../core/types';
import { ApiError, api, type Field, failText } from './api';
import { cardPath } from './address';
import { Naming } from './cardLink';
import { arrivedOnOpenCard, held, openedWith } from './demoSeen';
import { Branch, useCardDiff } from './diff';
import { ResultFiles } from './files';
import { DiscardChanges, FolderBox, FolderLine } from './folder';
import { landedRef, shownTitle } from './parts';
import { holdsNotes } from '../core/queue';
import { forcedText, QueueList, scrollerOf, useQueueMove, useQueueSort, waitText, type Behind } from './queue';
import { Body, Inline, plain } from './markdown';
import { MdField } from './mdField';
import { DictateButton, DictationLine } from './dictation';
import { appended, cardDraft, dropDraft, typeAtCursor, updateDraft, useFieldOn } from './draft';
import { AttachButton, ShotStrip, Shots, useShotInput } from './shots';
import { newRepoWords, type RepoChoice, RepoPick, useRepoChoice } from './repoPick';
import { ClockMark, SnoozeMenu, snoozeWho } from './snooze';
import { becomesLabel, snoozeWhen, stateLabel, t } from './strings';
import { agentWorks, ownerField, talkAlone, waitsFirstStart, worked as isWorked } from './talk';
import { type ActDone, ArchiveButton, Armed, Later, Limited, ManualTitle, type Pending, type Run, StartOn, type Tell, archivedOn } from './cardSheet';
import { ApproveReview, Findings, useUnsentDecisions } from './review';
import { IdeaView, PrototypeDemos } from './idea';
import { Conversation, Fold, LastFailure, Mocks, Split, Talk, TalkColumn, useOpenQuestions } from './conversation';
import { DemoView } from './demo';
import { PrBox, saveHeld } from './pr';
import { ExportBox, ShareBox } from './share';

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

export function Detail(p: Props) {
  const { item, parent } = p;
  const [error, setError] = useState('');
  // the demo the card opened to (demoSeen.ts); closing the card forgets one that waited on it
  const [opened] = useState(() => openedWith(sessionStorage, item.id, item.demo));
  useEffect(() => () => held.clear(sessionStorage, item.id), []);
  const demoWaits = item.state === 'waiting' && item.need === 'demo';
  // a demo starts by itself only when the owner opens the card to it; one that arrives on the open card waits behind its play button
  const arrived = !!item.demo && arrivedOnOpenCard(opened, item.demo);
  useEffect(() => {
    if (arrived && demoWaits && item.demo) held.set(sessionStorage, item.id, item.demo);
  }, [arrived, demoWaits, item.demo?.handover, item.demo && JSON.stringify(item.demo.chapters)]);
  const all = p.all;
  const run = async (fn: () => Promise<unknown>, done: ActDone) => {
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
  const act = (a: CardAction, done: ActDone) =>
    run(async () => {
      if (a.action === 'approve' || a.action === 'pushChanges') await saveHeld(item.id);
      const r = await api.act<ApproveResult | void>(item.id, a);
      // the decisions on findings that went with the approval are no longer the field's to send
      if (a.action === 'approve' && a.findings) updateDraft(cardDraft(item.id), { findings: undefined });
      return r;
    }, done);
  // the repository the card is to be built in, before work on it begins: one of the canvas's or a new one
  const choice = useRepoChoice(item, p.onEdit);
  // on a review card, the findings decided in the field that hold the merge up until they are sent
  const heldUp = Object.entries(useUnsentDecisions(item))
    .filter(([, route]) => route === 'contributor' || route === 'self')
    .map(([id]) => Number(id));
  // in a folder without git the card's change list takes the place of its branch
  const inFolder = !!p.repos.find((r) => r.id === item.repo)?.folder;
  // what the card changed, read once for its branch line and its files; in a folder without git its change list takes the branch's place
  const change = useCardDiff(item, { on: isWorked(item), poll: inFolder });
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
  // once the idea is a project, its plan doc settles the prototypes: the one it builds on goes to that workstream, the others are discarded
  const project = item.prototypeOf ? all.find((i) => i.kind === 'project' && i.origin === item.prototypeOf) : undefined;
  const ideaCard = item.prototypeOf ? all.find((i) => i.id === item.prototypeOf) : undefined;
  const builtOn = item.builtOn ? item.prototypes?.find((x) => x.id === item.builtOn) : undefined;
  const ideaThinking = !project && !!p.from?.idea?.thinking;
  const planning = !project && !!p.from?.becomesProject;
  const buildable = !project && !planning;
  const buildOn = (label: string) => (
    <button
      className="btn primary"
      disabled={ideaThinking}
      title={ideaThinking ? t.idea.prototypeWaits : undefined}
      onClick={() => act({ action: 'buildPrototype' }, { close: true, ack: t.idea.builtPrototype(ideaTitle) })}
    >
      {label}
    </button>
  );
  const prototypeActions = item.prototypeOf && (
    <>
      {item.branch && buildable && buildOn(t.idea.buildPrototype)}
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
    <ApproveReview item={item} act={act} />
  ) : inFolder ? (
    <>
      <button className="btn primary" title={item.noChange ? undefined : t.folder.approveHint} onClick={() => act({ action: 'approve' }, item.noChange ? { close: true, ack: t.approvedNoChange } : { close: true, ack: t.folder.approved })}>
        {item.noChange ? t.approveNoChange : t.approve}
      </button>
      <DiscardChanges diff={change.diff} act={act} onDone={change.reload} />
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
  // an agent is on the card and can be stopped
  const running = item.state === 'working' || item.state === 'waiting' || !!item.finishing;
  const archivable = finishedArchivable(item);
  // a stopped task starts again, or goes into the archive with its conversation, from the row below it
  const halted = stopped(item) && !item.queue;
  // a workstream given a prototype's branch, which no agent has worked on since, starts from the same row
  const onPrototype = item.state === 'planned' && !!item.unstarted && !item.queue;
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
      {worked && (inFolder ? <FolderLine item={item} diff={change.diff} sizeBelow={!talkAlone(item)} /> : item.branch && <Branch item={item} diff={change.diff} onRead={change.set} sizeBelow={!talkAlone(item)} />)}
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
            <WaitsFor queue={item.queue} all={all} />
          </div>
          <QueuePlace item={item} items={all} />
          <div className="actions">
            <StartOn item={item} act={act} primary={false}>
              <button className="btn" onClick={() => act({ action: 'force' }, { close: true, ack: forcedText(item.queue) })}>
                {t.queue.force}
              </button>
            </StartOn>
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
      <div className={['p-state', finishingUp(item) && 'finishing', (item.paused || item.restartPaused || item.snoozed) && 'paused'].filter(Boolean).join(' ')}>
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
        <p className="hint">
          <Naming text={planning || project ? t.idea.prototypeOfPlanning : t.idea.prototypeOf} cards={[{ card: ideaCard, title: ideaTitle }]} />
        </p>
      )}
      {item.buildProposal && (
        <div className="question proposal">
          <h4>{t.idea.buildProposal}</h4>
          <div className="q-text">{item.buildProposal}</div>
          {buildable && <div className="actions">{buildOn(t.idea.acceptBuild)}</div>}
        </div>
      )}
      {item.builtOn && (
        <p className="hint">
          <Naming text={t.idea.builtOn} cards={[{ card: builtOn, title: builtOn?.title ?? '' }]} />
        </p>
      )}
      {p.from && !item.prototypeOf && item.state !== 'proposal' && <p className="hint"><Naming text={t.followUpOf} cards={[{ card: p.from }]} /></p>}
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

      {/* what the card changed in a folder without git stays in view: in its left column, or above its conversation where it has none */}
      {worked && inFolder && talkAlone(item) && <FolderBox item={item} diff={change.diff} />}
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
                {item.contribution && (item.contribution.results || item.contribution.findings || item.contribution.clash) && <Findings
                    item={item}
                    decides={!!ownerField(item) && !finished(item.state)}
                    onPush={() => act({ action: 'pushMain' }, { close: true, ack: t.review.pushing(item.contribution!.number), undo: () => api.act(item.id, { action: 'keepMain' }) })}
                  />}
                {/* the last handover's demo stays while the agent works on the card again; a new handover replaces it. Beside it, the files the work made or changed */}
                <ResultFiles
                  item={item}
                  tab={tab}
                  onTab={setTab}
                  diff={change.diff}
                  demo={
                    item.demo && (
                      <DemoView
                        item={item}
                        demo={item.demo}
                        autoplay={demoWaits && !arrived}
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
                              {sharing && !shown.asked && shareBox(shown)}
                            </>
                          ))
                        }
                      />
                    )
                  }
                />
                {item.pr && (item.state === 'inPr' || item.state === 'waiting') && (
                  <PrBox pr={item.pr} {...(item.contribution?.held && item.state === 'waiting' ? { held: item.contribution.held, author: item.contribution.author, card: item.id } : {})} />
                )}
                {(item.state === 'inPr' || item.state === 'waiting') && item.morePrs?.map((pr) => <PrBox key={pr.url} pr={pr} />)}
                {item.state === 'inPr' && !item.pr && <p className="hint">{t.pr.opening}</p>}
                {item.finishing && finished(item.state) && <p className="hint">{item.followUp ? t.followingUpLong : item.restartPaused ? (item.state === 'done' ? t.restartPause.doneLong : t.restartPause.liveLong) : item.state === 'done' ? t.finishingDoneLong : t.finishingLong}</p>}
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
          {/* a card nobody worked on shows its conversation once there is something, such as a talk with the Coordinator */}
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
          {/* one snoozed to start later starts now with "Wake now" on its line in the conversation */}
          {item.newRepo?.due ? (
            <Armed label={t.repoPick.making(choice.name)} undo={t.undo} onUndo={() => act({ action: 'stayHere' }, { close: false })} />
          ) : (
            !item.snoozed && (
              <StartOn item={item} act={act} on={!fresh}>
                <button
                  className="btn primary"
                  disabled={!!fresh && !fresh.ready}
                  title={fresh?.hint ?? (inFolder ? t.folder.startHint : t.startHint)}
                  onClick={() => act({ action: 'start' }, { close: false })}
                >
                  {fresh?.button ?? t.start}
                </button>
              </StartOn>
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
      {worked && (running || archivable || halted || onPrototype || rest || snoozable(item)) && (
        <div className="actions">
          {onPrototype && !item.snoozed && (
            <StartOn item={item} act={act}>
              <button className="btn primary" title={t.startHint} onClick={() => act({ action: 'start' }, { close: false })}>
                {t.start}
              </button>
            </StartOn>
          )}
          {rest && (
            <StartOn item={item} act={act}>
              <button className="btn primary" title={t.landedPart.startHint} onClick={() => act({ action: 'start' }, { close: false })}>
                {t.landedPart.start}
              </button>
            </StartOn>
          )}
          {halted && !item.archivedAt && (
            <StartOn item={item} act={act}>
              <button className="btn primary" title={t.startAgainHint} onClick={() => act({ action: 'start' }, { close: false })}>
                {t.startAgain}
              </button>
            </StartOn>
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
      {review && heldUp.length > 0 && <p className="hint">{t.review.heldUp(heldUp)}</p>}
    </>
  );
}

/**
 * On an accepted proposal its agent withdrew or replaced since: who did, why, and the choice to
 * remove the card (as "Delete" does, its worker stopped, with an undo) or keep it.
 */
function SupersededBox({ item, all, act, onDelete }: { item: Item; all: Item[]; act: (a: CardAction, done: ActDone) => Promise<void>; onDelete: () => void }) {
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

/** On a card whose repository does not run on the canvas: no agent works on it until that is back. */
function RepoDownBox({ item }: { item: Item }) {
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
    </>
  );
}

/** When a proposed task starts once accepted, with "Change": another time, or none, so it starts at once. */
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
              placeholder: { note: item.snoozed && !item.snoozed.waiting && !item.snoozed.start ? t.snooze.compose : item.paused || item.pausing ? t.pause.compose : askable(item) || item.followUp ? t.compose.followUp : agentWorks(item) ? t.compose.working : holdsNotes(item) ? t.compose.queued : t.compose.idle, answer: t.compose.question, feedback: t.compose.review, demo: t.compose.demo }[field],
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
