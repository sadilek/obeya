// The unfolded card: what it is, what its worker does, and what the owner decides.

import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { buildableOn, type CardAction, prototypeWorkstream, type CardEvent, type CardPatch, type Demo, EXPORT_HTML_MAX, finished, type Item, type Mock, type NextStep, type PrComment, type PrReviewEntry, type PullRequest, type Question, type RepoRef } from '../core/types';
import { mockPage } from '../core/frame';
import { answerText, toggle } from './answer';
import { ApiError, api, at, type Field, holdRestart, onCardEvent } from './api';
import { firstOpening } from './demoSeen';
import { landedRef } from './parts';
import { useQueueMove } from './queue';
import { Inline, plain } from './markdown';
import { AttachButton, ShotStrip, Shots, useShotInput } from './shots';
import { clock as time, errorText, stateLabel, t } from './strings';
import { ownerField, parseQuestion, talkTurns, type Turn, worked as isWorked } from './talk';

/**
 * What the panel does after an action: fold the card and confirm (with undo, when it has one), or stay open.
 * With `pending`, the card folds at once, before the server has answered, and says so until it has.
 */
export type ActDone = { close: true; ack: string; undo?: () => unknown; pending?: string } | { close: false };

/** An action the server is still at, after its card has folded: the answer confirms it or tells why not. */
export type Pending = { card: string; title: string; answered: Promise<void> };

/** Whether an agent is on the card, so what the owner says with it open is, in doubt, for that agent. */
export const hasAgent = (i: Item) => ['working', 'inPr', 'waiting'].includes(i.state) || !!i.finishing;

/** Words typed into a field of the card: the Koordinator reads them like spoken ones, and the panel does not wait. */
type Tell = (text: string, images: string[] | undefined, field: Field) => void;

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
  /** Reads the plan doc of a workstream's project, at the workstream. */
  onReadPlan: (project: Item, mark?: string) => void;
  onTell: Tell;
}

/** Where a waiting card stands in the queue, with the buttons that move it. */
function QueuePlace({ item, items }: { item: Item; items: Item[] }) {
  const m = useQueueMove(item, items, true);
  if (!m) return null;
  return (
    <div className="q-place">
      <span className="hint">{m.place}</span>
      {m.buttons}
      {m.why && <div className="hint why">{m.why}</div>}
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
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  const act = (a: CardAction, done: ActDone) => run(() => api.act(item.id, a), done);
  // who reads what is typed here, as under the microphone
  const listener = (hasAgent(item) ? t.voice.agent : t.voice.card)(plain(item.title));
  const tell = (field: Field) => async (text: string, images?: string[]) => p.onTell(text, images, field);
  const repo = p.repos.length > 1 ? (p.repos.find((r) => r.id === item.repo)?.name ?? item.repo) : '';
  // a plain task says nothing of its kind
  const kind = [
    repo,
    parent
      ? `${plain(parent.title)} · ${item.label ?? ''} · ${t.kind.workstream}`
      : item.state === 'idea' || item.proposal?.idea
        ? t.kind.idea
        : item.becomesProject
          ? t.kind.becomesProject
          : item.prototypeOf
            ? t.kind.prototype
            : item.kind === 'project'
              ? t.kind.project
              : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // a proposal being reworked takes the agent's title and text: the fields come back with them, rather than keeping a draft
  const editable = item.source === 'manual' && (item.state === 'planned' || item.state === 'idea' || item.state === 'proposal') && !item.queue && !item.proposal?.revising;
  if (item.state === 'idea' && item.idea)
    return (
      <>
        {kind && <div className="p-kind">{kind}</div>}
        {item.archivedAt ? <div className="p-title">{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div> : <ManualTitle item={item} onEdit={p.onEdit} />}
        <IdeaView item={item} act={act} run={run} onDelete={p.onDelete} onTell={p.onTell} />
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
          {item.archivedAt && <span className="p-status"> · {t.archive.when(new Date(item.archivedAt))}</span>}
        </div>
        <p className="hint ended">
          {item.builtInto ? t.idea.builtInto(plain(item.ideaTitle ?? ''), plain(item.builtInto)) : t.idea.endedLong[item.prototypeEnd](plain(item.ideaTitle ?? p.from?.title ?? ''))}
        </p>
        <Split
          main={
            <>
              {/* the summary is the handover in the conversation */}
              {item.demo && (
                <DemoView item={item} summary="" demo={item.demo} autoplay={false}>
                  {null}
                </DemoView>
              )}
              <details className="p-task" open={!item.demo}>
                <summary>{t.task}</summary>
                <Body md={item.body} />
              </details>
            </>
          }
          talk={<Talk item={item} past />}
        />
      </>
    );
  const worked = isWorked(item);
  // a demo, video or HTML artifact, goes to a page where the repository has a share target, else it is exported as a file; prototypes stay here
  const target = !!p.repos.find((r) => r.id === item.repo)?.share;
  const shareBox = !!item.demo && !item.prototypeOf ? target || item.share ? <ShareBox item={item} act={act} /> : <ExportBox item={item} run={run} /> : null;
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
  // where work goes out as a pull request, the owner may have it pushed onto main directly instead
  const direct = !item.noChange && !!p.repos.find((r) => r.id === item.repo)?.direct;
  const approveButton = (
    <>
      <button className="btn primary" onClick={() => act({ action: 'approve' }, item.noChange ? { close: true, ack: t.approvedNoChange } : { close: true, ack: t.approved, pending: t.approving })}>
        {item.noChange ? t.approveNoChange : direct ? t.approvePr : t.approve}
      </button>
      {direct && (
        <button className="btn" title={t.directHint} onClick={() => act({ action: 'approve', direct: true }, { close: true, ack: t.approvedDirect, pending: t.approvingDirect })}>
          {t.approveDirect}
        </button>
      )}
    </>
  );

  // work waiting for the owner's verdict, with a demo or a summary
  const review = item.state === 'waiting' && (item.need === 'demo' || item.need === 'review');
  const demoWaits = item.state === 'waiting' && item.need === 'demo';
  // an agent is on the card and can be stopped
  const running = item.state === 'working' || item.state === 'waiting' || !!item.finishing;
  const archivable = finished(item.state) && item.source === 'manual' && !item.finishing;
  const scope = !!item.scope?.length && (
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
      {editable ? <ManualTitle item={item} onEdit={p.onEdit} /> : <div className="p-title">{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div>}
      <div className="p-state">
        ● {stateLabel(item)}
        {item.statusLine && (item.state === 'working' || item.state === 'inPr' || item.finishing) && <span className="p-status"> · {item.statusLine}</span>}
        {item.archivedAt && <span className="p-status"> · {t.archive.when(new Date(item.archivedAt))}</span>}
      </div>

      {item.state === 'proposal' && (
        <ProposalView item={item} from={p.from} act={act} listener={listener} onRevise={tell('revise')}>
          {editable ? <ManualFields item={item} repos={p.repos} onEdit={p.onEdit} grow /> : <Body md={item.body} />}
        </ProposalView>
      )}

      {item.state === 'planned' && item.queue && (
        <div className="question queue">
          {'checking' in item.queue || 'cutting' in item.queue ? (
            <div className="q-text">{'checking' in item.queue ? t.queue.checkingLong : t.queue.cuttingLong}</div>
          ) : 'workspace' in item.queue ? (
            <>
              <div className="q-text">{t.queue.workspaceLong[item.queue.workspace]}</div>
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
                {t.queue.behind(item.queue.behind.map((id) => plain(all.find((x) => x.id === id)?.title ?? id)))} {item.queue.reason}
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
      )}

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

      {item.state === 'planned' && !item.queue && <LastFailure cardId={item.id} />}

      {item.state === 'planned' && (
        <>
          {editable ? (
            <ManualFields item={item} repos={p.repos} onEdit={p.onEdit} />
          ) : (
            <>
              <Body md={item.body} />
              <Shots ids={item.images} />
            </>
          )}
          {parent?.plan && <PlanSource file={parent.plan.file} onRead={parent.archivedAt ? undefined : () => p.onReadPlan(parent, item.label)} />}
          {!item.queue && (
            <div className="actions">
              <button className="btn primary" onClick={() => act({ action: 'start' }, { close: false })}>
                {t.start}
              </button>
              {prototypeActions}
              {item.source === 'manual' && !item.prototypeOf && (
                <>
                  <button className="btn" onClick={() => act({ action: 'split' }, { close: false })}>
                    {t.split}
                  </button>
                  {!item.branch && (
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

      {item.state === 'planned' && scope}

      {worked ? (
        // what the work is and what came of it on the left, the conversation with the owner's one field on the right
        <Split
          main={
            <>
              {/* the summary is the handover in the conversation */}
              {item.demo && (demoWaits || item.state === 'inPr' || item.state === 'approved' || finished(item.state)) && (
                <DemoView item={item} all={all} run={run} summary="" demo={item.demo} autoplay={demoWaits}>
                  {!demoWaits && <p className="hint">{t.demo.kept}</p>}
                  {shareBox}
                </DemoView>
              )}
              {item.pr && (item.state === 'inPr' || item.state === 'waiting') && <PrBox pr={item.pr} />}
              {item.state === 'inPr' && !item.pr && <p className="hint">{t.pr.opening}</p>}
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
              {item.finishing && finished(item.state) && <p className="hint">{item.state === 'done' ? t.finishingDoneLong : t.finishingLong}</p>}
              {brief}
              {((item.body.trim() && item.body.trim() !== item.brief?.trim()) || !!item.images?.length) && (
                // the task stays in view until there is a result to look at
                <details className="p-task" open={!item.demo && !item.brief?.trim()}>
                  <summary>{t.task}</summary>
                  <Body md={item.body} />
                  <Shots ids={item.images} />
                </details>
              )}
              {item.state === 'working' && scope}
              <p className="p-src">
                {t.branch} <code>{item.branch}</code>
                {parent?.plan && (
                  <>
                    {' · '}
                    <code>{parent.plan.file}</code>{' '}
                    {/* an archived project's doc is gone */}
                    {!parent.archivedAt && (
                      <button className="link" onClick={() => p.onReadPlan(parent, item.label)}>
                        {t.plan.readAt}
                      </button>
                    )}
                  </>
                )}
              </p>
            </>
          }
          talk={<TaskTalk item={item} listener={listener} act={act} tell={tell} />}
        />
      ) : (
        <>
          {brief}
          {item.state !== 'planned' && item.state !== 'proposal' && (
            <>
              <Body md={item.body} />
              <Shots ids={item.images} />
              {parent?.plan && <PlanSource file={parent.plan.file} onRead={parent.archivedAt ? undefined : () => p.onReadPlan(parent, item.label)} />}
            </>
          )}
          {/* a card nobody worked on shows its conversation once there is something, such as a talk with the Koordinator */}
          {item.state !== 'proposal' && <Conversation item={item} past hideEmpty />}
        </>
      )}

      {/* the decisions go below both columns, as on an idea or a proposal */}
      {worked && (running || archivable) && (
        <div className="actions">
          {review ? prototypeActions || approveButton : running && prototypeActions}
          {running && (
            <button className="btn" onClick={() => act({ action: 'stop' }, { close: true, ack: t.stopped })}>
              {t.stop}
            </button>
          )}
          {archivable && <ArchiveButton item={item} run={run} />}
        </div>
      )}
      {review && item.noChange && !item.prototypeOf && <p className="hint">{t.noChangeHint}</p>}
      {review && direct && !item.prototypeOf && <p className="hint">{t.directHint}</p>}

      {error && <p className="p-error">{error}</p>}
    </>
  );
}

// ------------------------------------------------------------------ ideas

/**
 * An idea under discussion: the brief its agent keeps on top, a prototype's demo when there is one,
 * then the conversation, and the owner's decisions.
 */
function IdeaView({ item, act, run, onDelete, onTell }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void>; run: Run; onDelete: () => void; onTell: Tell }) {
  const idea = item.idea!;
  const [prototyping, setPrototyping] = useState(false);
  const answer = usePicks(idea.questions);
  // what the agent would do in the owner's place is the marked click; without a suggestion, building is
  const next = idea.status === 'open' && !idea.thinking ? idea.next : undefined;
  const btn = (step: NextStep['step']) => (next ? (next.step === step ? 'btn primary suggested' : 'btn') : step === 'build' ? 'btn primary' : 'btn');
  return (
    <>
      <div className="p-state">
        ● {stateLabel(item)}
        {idea.thinking && <span className="p-status"> · {t.author.explorer} {t.idea.thinking}</span>}
        {item.archivedAt && <span className="p-status"> · {t.archive.when(new Date(item.archivedAt))}</span>}
      </div>
      {/* the brief is what stays; the conversation beside it is how it came about */}
      <Split
        main={
          <>
            <div className="question brief">
              <h4>{t.idea.brief}</h4>
              {idea.brief.trim() ? <Body md={idea.brief} /> : <div className="hint">{t.idea.briefEmpty}</div>}
              <Mocks mocks={idea.mocks} />
            </div>
            {/* a demo copied onto the idea, from before every prototype kept its own */}
            {item.demo && !item.prototypes?.length && (
              <>
                <h4 className="p-h">{t.idea.prototypeDemo}</h4>
                <DemoView item={item} summary="" demo={item.demo} autoplay={false}>
                  <p className="hint">{t.idea.prototypeKept}</p>
                </DemoView>
              </>
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
              questions={idea.questions}
              heading={idea.questions.length > 1 ? t.ask.questions : t.ask.question}
              picks={answer}
              field={{
                placeholder: t.idea.compose,
                listener: t.voice.idea(plain(item.title)),
                quote: true,
                onWords: async (words, images) => onTell(words, images, 'discuss'),
                onPicked: (text, images) => act({ action: 'discuss', text, images }, { close: false }),
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
          {idea.thinking && <p className={idea.buildAfterReply ? 'hint go-waits' : 'hint'}>{idea.buildAfterReply ? t.idea.buildWaitsHint : t.idea.waitForReply}</p>}
          <div className="actions">
            {idea.buildAfterReply ? (
              <Armed label={t.idea.buildWaits} undo={t.idea.unbuild} onUndo={() => act({ action: 'unbuild' }, { close: false })} />
            ) : (
              // while the agent works, the click waits for its reply in view; else the panel closes on the built card
              <button className={btn('build')} onClick={() => act({ action: 'build' }, idea.thinking ? { close: false } : { close: true, ack: t.idea.built })}>
                {t.idea.build}
              </button>
            )}
            <button className={btn('planDoc')} disabled={idea.thinking} onClick={() => act({ action: 'planDoc' }, { close: true, ack: t.idea.planned })}>
              {t.idea.planDoc}
            </button>
            <button className={btn('prototype')} onClick={() => setPrototyping(true)}>
              {t.idea.prototype}
            </button>
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
            {idea.status === 'dropped' && <ArchiveButton item={item} run={run} />}
            <button className="btn danger" onClick={onDelete}>
              {t.delete}
            </button>
          </div>
        </>
      )}
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
  listener: string;
  /** What should change in it, typed: an agent reworks the proposal by it. */
  onRevise: (text: string) => Promise<void>;
  children: ReactNode;
}) {
  const questions = item.proposal?.questions ?? [];
  const revising = item.proposal?.revising;
  const answer = usePicks(questions);
  const idea = !!item.proposal?.idea;
  const armed = !!item.proposal?.acceptAfterRevision;
  // while it is reworked, the click waits for the new text in view; else the panel closes on the accepted card
  const accept = (start: boolean) =>
    act(
      { action: 'accept', ...(start ? {} : { start: false }), ...(answer.picked ? { picks: answer.picks } : {}) },
      start && !revising ? { close: true, ack: idea ? t.acceptedIdea : t.accepted } : { close: false },
    );
  return (
    <>
      {/* the proposal as it stands, and beside it the talk about what should change, as with an idea */}
      <Split
        className="proposal-grid"
        main={
          <>
            {children}
            {from && <p className="hint">{t.proposedBy(plain(from.title))}{item.proposal?.reason && <> {item.proposal.reason}</>}</p>}
            {item.retro && <p className="hint">{t.proposedByRetro(item.retro)}</p>}
          </>
        }
        talk={
          <Talk
            item={item}
            questions={questions}
            heading={t.proposalQuestions}
            picks={answer}
            // while it is reworked, the owner's words stand in the conversation and wait there
            field={
              revising
                ? undefined
                : { placeholder: t.compose.revise, listener, noImages: true, quote: true, onWords: (words) => onRevise(words), onPicked: (text) => act({ action: 'revise', text }, { close: false }) }
            }
          />
        }
      />
      {revising && <p className={armed ? 'hint go-waits' : 'hint'}>{armed ? t.acceptWaitsHint : t.acceptWaitsFor(idea ? t.acceptIdea : t.accept)}</p>}
      <div className="actions">
        {armed ? (
          <Armed label={t.acceptWaits(idea)} undo={t.unaccept} onUndo={() => act({ action: 'unaccept' }, { close: false })} />
        ) : (
          <button className="btn primary" onClick={() => accept(true)}>
            {idea ? t.acceptIdea : t.accept}
          </button>
        )}
        <button className="btn" disabled={!!revising} onClick={() => accept(false)}>
          {idea ? t.acceptAsTask : t.acceptOnly}
        </button>
        <button className="btn" onClick={() => act({ action: 'dismiss' }, { close: true, ack: t.dismissed })}>
          {t.dismiss}
        </button>
      </div>
      {questions.length > 0 && !revising && <p className="hint">{t.proposalQuestionsHint}</p>}
    </>
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
        button={t.idea.prototypeGo(Math.max(n, 1))}
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
 * `hideEmpty`: nothing shows until something was said.
 */
function Conversation({ item, questions, past = false, hideEmpty = false }: { item: Item; questions?: ReactNode; past?: boolean; hideEmpty?: boolean }) {
  const events = useEvents(item.id);
  const box = useRef<HTMLDivElement>(null);
  const idea = item.state === 'idea' && !!item.idea;
  const proposal = item.state === 'proposal';
  const asking = item.state === 'waiting' && item.need === 'question' ? item.question : undefined;
  // a worker finishing after the landing works unless it waits for the owner's answer
  const working = !past && (idea ? !!item.idea?.thinking : proposal ? !!item.proposal?.revising : item.state === 'working' || (!!item.finishing && finished(item.state)));
  const asked = JSON.stringify(item.idea?.questions ?? asking ?? []);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, working, asked]);
  const turns = useMemo(() => (events ? talkTurns(events, { asking, over: !working }) : null), [events, asked, working]);
  if (!events || !turns) return null;
  if (hideEmpty && !turns.shown.length && !turns.pending.length) return null;
  const agent = idea ? t.author.explorer : t.author.worker;
  // no agent's message ever closes a proposal's rounds: its rework shows only what came after the owner's latest words
  const since = proposal && turns.shown.length ? events.indexOf(turns.shown.at(-1)!.e) : -1;
  const pending = proposal ? turns.pending.filter((s) => events.indexOf(s) > since) : turns.pending;
  // the demo report's question goes with the handover it came with
  // an open one stands at the end instead, where it is answered
  const handover = item.demo?.question && !(item.state === 'waiting' && item.need === 'demo' && item.question) ? turns.shown.findLast((x) => x.e.kind === 'review') : undefined;
  return (
    <>
      <h4 className="p-h">{t.talk.heading}</h4>
      <div className="talk conv" ref={box}>
        {turns.shown.length === 0 && !working && !turns.asked && <div className="hint">{idea ? t.idea.talkEmpty : proposal ? t.reviseHint : t.talk.empty}</div>}
        {idea && !past && item.body.trim() && !opened(events, item.body) && (
          <div className="msg by-owner seed">
            <div className="who">{t.idea.seed}</div>
            <Body md={item.body} />
          </div>
        )}
        {turns.shown.map((turn) =>
          turn.line ? (
            <div key={turn.e.id} className={`note ev-${turn.e.kind}`} title={turn.e.code ? turn.e.text : undefined}>
              {time(turn.e.at)} · {eventText(turn.e)}
            </div>
          ) : (
            <Message key={turn.e.id} turn={turn} demoQuestion={turn === handover ? item.demo : undefined} />
          ),
        )}
        {working ? (
          <div className={`msg by-${idea ? 'explorer' : proposal ? 'koordinator' : 'worker'} thinking`}>
            <div className="who">{proposal ? t.revising : `${agent} ${idea ? t.idea.thinking : t.talk.working}`}</div>
            {pending.at(-1) && <div className="hint">{clipLine(pending.at(-1)!.text)}</div>}
            <Steps steps={pending} />
          </div>
        ) : (
          (turns.pending.length > 0 || (turns.asked?.steps.length ?? 0) > 0) && (
            <div className={`msg by-${idea ? 'explorer' : 'worker'}`}>
              {/* how the worker came to the question it waits on */}
              {turns.asked && (
                <div className="who">
                  {agent} · {t.talk.question} <span className="t">{time(turns.asked.e.at)}</span>
                </div>
              )}
              <Steps steps={[...(turns.asked?.steps ?? []), ...turns.pending]} />
            </div>
          )
        )}
        {!working && questions}
      </div>
    </>
  );
}

/** Who stands on the owner's side of the conversation: the owner, and whoever answers a question in their name. */
const ownerSide = (e: CardEvent) => e.author === 'owner' || e.kind === 'answer';

/** One message of the conversation; a question with its options and what came of it, a handover with its demo report's question. */
function Message({ turn, demoQuestion }: { turn: Turn; demoQuestion?: Demo }) {
  const { e, steps } = turn;
  const q = e.kind === 'question' ? parseQuestion(e.text) : undefined;
  return (
    <div className={`msg by-${ownerSide(e) ? 'owner' : e.author}${q ? ' q' : ''}${turn.settled ? ' settled' : ''}`}>
      <div className="who">
        {t.author[e.author]}
        {e.kind === 'question' && ` · ${t.talk.question}`}
        {e.kind === 'review' && ` · ${t.talk.handover}`}
        <span className="t">{time(e.at)}</span>
      </div>
      {!turn.quiet && <Body md={q ? q.text : e.text} />}
      {q && !turn.settled && q.options.length > 0 && (
        <ul className="q-opts">
          {q.options.map((o) => (
            <li key={o} className={turn.answer?.includes(o) ? 'on' : ''}>
              <Inline md={o} />
            </li>
          ))}
        </ul>
      )}
      {turn.settled && <div className="hint">{t.talk.settled}</div>}
      {demoQuestion?.question && (
        <div className="demo-q">
          <b>{t.talk.demoQuestion}</b> {demoQuestion.question}
        </div>
      )}
      <Mocks mocks={e.mocks} />
      <Shots ids={e.images} />
      <Steps steps={steps} />
    </div>
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
 * away from Obeya's API. It grows to the height the mock reports, up to a limit, then scrolls.
 */
function MockFrame({ mock }: { mock: Mock }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const height = useReportedHeight(frame, 480) ?? 48;
  const page = useMemo(() => mockPage(mock.html), [mock.html]);
  return (
    <figure className="mock">
      {mock.title && <figcaption>{mock.title}</figcaption>}
      <iframe ref={frame} sandbox="allow-scripts" srcDoc={page} title={mock.title || t.idea.mock} style={{ height }} />
    </figure>
  );
}

/**
 * The frame's height for the page in it to fit: what the page reports (`withHeightReport` in
 * `src/core/frame.ts`) and the frame's border, up to `cap`; undefined until it has reported. A
 * page as high as its frame would grow with each step: it stops after a few.
 */
function useReportedHeight(frame: RefObject<HTMLIFrameElement | null>, cap: number) {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    let steps = 0;
    const on = (e: MessageEvent) => {
      const h = e.source === frame.current?.contentWindow && (e.data as { obeyaHeight?: unknown } | null)?.obeyaHeight;
      const f = frame.current;
      // the border is inside the frame's height (border-box): without it the page is a few pixels too high and scrolls
      if (typeof h === 'number' && h > 0 && f && steps++ < 30) setHeight(Math.min(Math.ceil(h) + f.offsetHeight - f.clientHeight, cap));
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);
  return height;
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
            {s.kind === 'say' ? <Body md={s.text} /> : s.text}
          </li>
        ))}
      </ol>
    </details>
  );
}

const clipLine = (s: string) => {
  const line = s.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 140 ? line.slice(0, 139) + '…' : line;
};

type Run = (fn: () => Promise<void>, done: ActDone) => Promise<void>;

/** The narrated demo with its chapters and the report beside it; with `run`, each finding can become a card. */
function DemoView({
  item,
  all = [],
  run,
  summary,
  demo,
  children,
  autoplay = true,
}: {
  item: Item;
  all?: Item[];
  run?: Run;
  summary: string;
  demo: Demo;
  children: ReactNode;
  autoplay?: boolean;
}) {
  const cardId = item.id;
  const video = useRef<HTMLVideoElement>(null);
  const artifact = useRef<HTMLIFrameElement>(null);
  const artifactHeight = useReportedHeight(artifact, ARTIFACT_CAP);
  const [now, setNow] = useState(0);
  const src = (f: string) => at(`/cards/${cardId}/demo/${f}`);
  // start once the card has unfolded, like the mock, the first time only; a demo kept on a finished card waits to be played
  const [autostart] = useState(() => autoplay && demo.kind !== 'html' && firstOpening(localStorage, cardId, demo));
  // a video that does not start on its own shows a big play button over it until it first plays
  const [started, setStarted] = useState(autostart);
  useEffect(() => {
    if (!autostart) return;
    const h = setTimeout(() => video.current?.play().catch(() => setStarted(false)), 300);
    return () => clearTimeout(h);
  }, []);
  useEffect(() => () => holdRestart('video', null), []);
  const current = demo.chapters.reduce((cur, [at], i) => (at <= now + 0.05 ? i : cur), 0);
  return (
    <>
      <div className="demo-view">
        {demo.kind === 'html' ? (
          // the worker's page: scripts run, but in an origin of its own, away from Obeya's API. Once
          // the frame has the page's height it does not scroll: a page whose images grow with its
          // width fits beside a scrollbar but not without one, and kept a bar that scrolled by a few pixels
          <iframe
            ref={artifact}
            className="artifact"
            sandbox="allow-scripts"
            src={src('index.html')}
            title={t.demo.artifact}
            style={{ height: artifactHeight }}
            scrolling={artifactHeight !== undefined && artifactHeight < ARTIFACT_CAP ? 'no' : undefined}
          />
        ) : (
          <div className="player">
            <video
              ref={video}
              controls
              preload="metadata"
              poster={src('poster.jpg')}
              src={src('demo.mp4')}
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              // a restart waits while the owner watches
              onPlay={() => {
                setStarted(true);
                holdRestart('video', 'video');
              }}
              onPause={() => holdRestart('video', null)}
              onEnded={() => holdRestart('video', null)}
            >
              <track kind="captions" src={src('captions.vtt')} srcLang="de" label="Deutsch" />
            </video>
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
      {pr.ready && <div className="q-text">{pr.held ? t.pr.held(pr.held.score, pr.held.by) : t.pr.ready(pr.mergeError ?? '')}</div>}
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
 * Sharing the demo with colleagues: "Teilen" publishes it right away, then the page's link with
 * "Nicht mehr teilen"; "Neu teilen" once the card has a newer demo than the page, "Erneut teilen"
 * once the share command writes pages differently than when it published this one.
 */
function ShareBox({ item, act }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const s = item.share;
  const go = (action: 'share' | 'unshare') => act({ action }, { close: false });
  return (
    <div className="share">
      {!s ? (
        <button className="btn" title={item.demo?.kind === 'html' ? t.share.shareHintHtml : t.share.shareHint} onClick={() => go('share')}>
          {t.share.share}
        </button>
      ) : s.state === 'publishing' || s.state === 'withdrawing' ? (
        <div className="share-row">
          <span className="share-busy">{s.state === 'publishing' ? t.share.publishing : t.share.withdrawing}</span>
        </div>
      ) : (
        <>
          <div className="share-row">
            <span className="share-label">{t.share.shared}</span>
            <a className="share-link" href={s.url} target="_blank" rel="noreferrer" title={t.share.open}>
              {s.url!.replace(/^https?:\/\//, '')}
            </a>
            <button
              className="btn"
              onClick={() =>
                navigator.clipboard.writeText(s.url!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }, console.error)
              }
            >
              {copied ? t.share.copied : t.share.copy}
            </button>
          </div>
          {s.stale && <p className="hint">{t.share.stale}</p>}
          {s.outdated && <p className="hint">{t.share.outdated}</p>}
          <div className="share-row">
            {s.stale && (
              <button className="btn" title={t.share.againHint} onClick={() => go('share')}>
                {t.share.again}
              </button>
            )}
            {s.outdated && (
              <button className="btn" title={t.share.reshareHint} onClick={() => go('share')}>
                {t.share.reshare}
              </button>
            )}
            <button className="btn" title={t.share.stopHint} onClick={() => go('unshare')}>
              {t.share.stop}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "Teilen" where the repository has no share target: the demo as a file to pass on, a ZIP of its
 * page with the video or the HTML artifact beside it, or one HTML file that holds everything
 * (short videos, artifacts that are their index.html alone).
 */
function ExportBox({ item, run }: { item: Item; run: Run }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'zip' | 'html' | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const artifact = item.demo?.kind === 'html';
  useEffect(() => {
    if (open && !artifact) api.demoSize(item.id).then(setSize, () => {});
  }, [open, item.id, artifact]);
  const tooLarge = size !== null && size > EXPORT_HTML_MAX;
  const notAlone = artifact && !item.demo?.single;
  const go = (as: 'zip' | 'html') => {
    setBusy(as);
    void run(() => api.exportDemo(item.id, as), { close: false }).finally(() => setBusy(null));
  };
  return (
    <div className="share">
      {!open ? (
        <button className="btn" title={t.share.exportHint} onClick={() => setOpen(true)}>
          {t.share.share}
        </button>
      ) : (
        <>
          <p className="hint">{t.share.exportIntro}</p>
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
          {busy && !item.demo?.page && <p className="hint">{t.share.writingPage}</p>}
        </>
      )}
    </div>
  );
}

/** Takes a finished card or a dropped idea into the archive, or an archived one back onto the canvas. */
function ArchiveButton({ item, run }: { item: Item; run: Run }) {
  const title = plain(item.title);
  return item.archivedAt ? (
    <button className="btn" onClick={() => run(() => api.unarchive(item.id), { close: true, ack: t.archive.unarchived(title) })}>
      {t.archive.unarchive}
    </button>
  ) : (
    <button className="btn" onClick={() => run(() => api.archive(item.id), { close: true, ack: t.archive.archived(title), undo: () => api.unarchive(item.id) })}>
      {t.archive.archive}
    </button>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function PlanSource({ file, onRead }: { file: string; onRead?: () => void }) {
  return (
    <p className="p-src">
      {t.fromPlan} <code>{file}</code>{' '}
      {onRead && (
        <button className="link" onClick={onRead}>
          {t.plan.readAt}
        </button>
      )}
    </p>
  );
}

// ------------------------------------------------------------------ manual cards

/** Keeps a text box as tall as its text (within its CSS min- and max-height), on every change and when its width changes. */
function useFitHeight(ref: RefObject<HTMLTextAreaElement | null>, text: string, on = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    // the panel unfolds from the card's width, and a narrower box needs more lines
    let width = el.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // in the next frame: changing the height inside the callback makes it a resize loop
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [text, on]);
}

function ManualTitle({ item, onEdit }: { item: Item; onEdit: (p: CardPatch) => void }) {
  // a local draft: the server echo must not overwrite what is being typed
  const [title, setTitle] = useState(item.title);
  // one line of text that wraps: a long title shows in full instead of running out of the box
  const ref = useRef<HTMLTextAreaElement>(null);
  useFitHeight(ref, title);
  return (
    <textarea
      ref={ref}
      className="p-title"
      rows={1}
      value={title}
      placeholder={t.titlePlaceholder}
      maxLength={200}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      onChange={(e) => {
        const v = e.target.value.replace(/\s*\n\s*/g, ' ');
        setTitle(v);
        onEdit({ title: v });
      }}
    />
  );
}

function ManualFields({ item, repos, onEdit, grow }: { item: Item; repos: RepoRef[]; onEdit: (p: CardPatch) => void; grow?: boolean }) {
  const [body, setBody] = useState(item.body);
  // a proposal's text shows in full as far as the screen allows, the panel growing with it
  const ref = useRef<HTMLTextAreaElement>(null);
  useFitHeight(ref, body, grow);
  const [repo, setRepo] = useState(item.repo);
  const shots = useShotInput({ initial: item.images, onChange: (images) => onEdit({ images }) });
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
      </div>
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
function TaskTalk({ item, listener, act, tell }: { item: Item; listener: string; act: (a: CardAction, done: ActDone) => Promise<void>; tell: (field: Field) => (text: string, images?: string[]) => Promise<void> }) {
  const field = ownerField(item);
  const key = JSON.stringify(item.question ?? null);
  const questions = useMemo(() => ((field === 'answer' || field === 'demo') && item.question ? [item.question] : []), [field, key]);
  const picks = usePicks(questions);
  return (
    <Talk
      item={item}
      questions={questions}
      heading={field === 'demo' ? t.demo.question : t.questionFromWorker}
      picks={picks}
      field={
        field
          ? {
              key: `${item.state}:${item.need ?? ''}:${field}:${key}`,
              placeholder: { note: t.compose.working, answer: t.compose.question, feedback: t.compose.review, demo: t.compose.demo, discuss: '', revise: t.compose.revise }[field],
              listener,
              onWords: tell(field),
              onPicked: (text, images) => act({ action: 'answer', text, images }, { close: true, ack: t.answered }),
            }
          : undefined
      }
    />
  );
}

/**
 * The layout every card with a conversation shares, idea, proposal or task: what the card is about
 * on the left (brief, text, demo), the conversation on the right; the decisions go below both.
 */
function Split({ main, talk, className }: { main: ReactNode; talk: ReactNode; className?: string }) {
  return (
    <div className={className ? `split ${className}` : 'split'}>
      <div className="split-main">{main}</div>
      <div className="split-talk">{talk}</div>
    </div>
  );
}

/** The owner's one field under a conversation: words, and the options picked, go out with one Send. */
interface TalkField {
  placeholder: string;
  listener: string;
  /** Starts the field afresh when it changes (another question, another state). */
  key?: string;
  noImages?: boolean;
  /** The picks name their questions also when there is one: the conversation is read later without it beside. */
  quote?: boolean;
  /** Words alone go through the Koordinator, like spoken ones. */
  onWords: (text: string, images?: string[]) => Promise<void>;
  /** Picked options go to the agent as they are, with the words. */
  onPicked: (text: string, images?: string[]) => Promise<void>;
}

/**
 * The right column of every card with a conversation: the conversation with the questions it waits
 * on at its end, and under it the owner's one field (none where nobody hears it). `past`: nobody
 * works on the card any more.
 */
function Talk({ item, questions = [], heading = t.ask.question, picks, past, field }: { item: Item; questions?: Question[]; heading?: string; picks?: Picks; past?: boolean; field?: TalkField }) {
  const options = questions.some((q) => q.options.length > 0);
  const picked = !!picks?.picked;
  return (
    <>
      <Conversation item={item} past={past} questions={picks && <Questions questions={questions} heading={heading} {...picks} />} />
      {field && (
        <Composer
          key={field.key}
          placeholder={options ? t.ask.words : field.placeholder}
          button={options ? t.ask.send : t.send}
          allowEmpty={picked}
          listener={field.listener}
          noImages={field.noImages}
          onSend={(words, images) => (picked ? field.onPicked(answerText(questions, picks!.picks, words, field.quote), images) : field.onWords(words, images))}
        />
      )}
    </>
  );
}

type Picks = ReturnType<typeof usePicks>;

/** The options the owner picked for each question; they start over when the questions change. */
function usePicks(questions: Question[]) {
  const key = JSON.stringify(questions);
  const [state, setState] = useState({ key, picks: [] as string[][] });
  const picks = state.key === key ? state.picks : [];
  const choose = (i: number, o: string) =>
    setState((cur) => {
      const was = cur.key === key ? cur.picks : [];
      return { key, picks: questions.map((q, j) => (j === i ? toggle(q, was[j] ?? [], o) : (was[j] ?? []))) };
    });
  return { picks, choose, picked: picks.some((x) => x.length > 0) };
}

/** An agent's questions, each with its options as radio buttons, or checkboxes when several may be chosen. */
function Questions(p: { questions: Question[]; heading: string; picks: string[][]; choose: (i: number, option: string) => void }) {
  if (!p.questions.length) return null;
  return (
    <div className="question ask">
      <h4>{p.heading}</h4>
      {p.questions.map((q, i) => (
        <div key={i} className="ask-q">
          <div className="q-text">{q.text}</div>
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

/** What the owner writes to an agent; screenshots are pasted, dropped or picked, unless `noImages`. */
function Composer({
  placeholder,
  onSend,
  button = t.send,
  allowEmpty = false,
  noImages = false,
  listener,
  onText,
}: {
  placeholder: string;
  onSend: (text: string, images?: string[]) => Promise<void>;
  button?: string;
  allowEmpty?: boolean;
  noImages?: boolean;
  /** Who reads what is typed (the Koordinator, or the card's agent through it); it then gets ready while the owner types. */
  listener?: string;
  /** Hears the text as it is typed. */
  onText?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const shots = useShotInput({ off: noImages });
  const images = shots.images;
  const ready = (!!text.trim() || images.length > 0 || allowEmpty) && !busy && !shots.uploading;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    await onSend(text.trim(), images.length ? images : undefined);
    setBusy(false);
    setText('');
    onText?.('');
    shots.clear();
  };
  return (
    <div className={`composer${shots.dropping ? ' dropping' : ''}`} {...shots.drop}>
      <ShotStrip shots={shots} />
      <div className="c-field">
        <textarea
          value={text}
          placeholder={placeholder}
          rows={2}
          onFocus={listener ? () => api.warmVoice() : undefined}
          onChange={(e) => {
            setText(e.target.value);
            onText?.(e.target.value);
          }}
          onPaste={shots.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <AttachButton shots={shots} />
      </div>
      <button className="btn primary" disabled={!ready} onClick={send}>
        {button}
      </button>
      {shots.error && <p className="p-error c-error">{shots.error}</p>}
      {listener && <div className="c-listener">→ {listener}</div>}
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
                  {t.pr.onGithub} ↗
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
