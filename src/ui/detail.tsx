// The unfolded card: what it is, what its worker does, and what the owner decides.

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type CardAction, type CardEvent, type CardPatch, type Demo, EXPORT_HTML_MAX, finished, type Item, type Mock, type NextStep, type PrComment, type PrReviewEntry, type Question, type RepoRef } from '../core/types';
import { mockPage } from '../core/frame';
import { answerText, toggle } from './answer';
import { ApiError, api, at, type Field, holdRestart, onCardEvent } from './api';
import { firstOpening } from './demoSeen';
import { Inline, plain } from './markdown';
import { AttachButton, ShotStrip, Shots, useShotInput } from './shots';
import { errorText, stateLabel, t } from './strings';
import { parseQuestion, talkTurns, type Turn } from './talk';

/** What the panel does after an action: fold the card and confirm (with undo, when it has one), or stay open. */
export type ActDone = { close: true; ack: string; undo?: () => unknown } | { close: false };

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
  onDone: (d: ActDone) => void;
  /** Reads the plan doc of a workstream's project, at the workstream. */
  onReadPlan: (project: Item, mark?: string) => void;
  onTell: Tell;
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
  const editable = item.source === 'manual' && (item.state === 'planned' || item.state === 'idea' || item.state === 'proposal') && !item.queue;
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
        <p className="hint ended">{t.idea.endedLong[item.prototypeEnd](plain(p.from?.title ?? ''))}</p>
        {/* the summary is the handover in the conversation */}
        {item.demo && (
          <DemoView item={item} summary="" demo={item.demo} autoplay={false}>
            {null}
          </DemoView>
        )}
        <Conversation item={item} past />
        <details className="p-task">
          <summary>{t.task}</summary>
          <Body md={item.body} />
        </details>
      </>
    );
  const worked = ['working', 'waiting', 'approved', 'inPr', 'live', 'done'].includes(item.state) && !!item.branch;
  // a demo, video or HTML artifact, goes to a page where the repository has a share target, else it is exported as a file; prototypes stay here
  const target = !!p.repos.find((r) => r.id === item.repo)?.share;
  const shareBox = !!item.demo && !item.prototypeOf ? target || item.share ? <ShareBox item={item} act={act} /> : <ExportBox item={item} run={run} /> : null;
  // a prototype is discarded or its idea built on it, never approved or deleted; built once the idea's agent has taken in what changed
  const ideaThinking = !!p.from?.idea?.thinking;
  const prototypeActions = item.prototypeOf && (
    <>
      {item.branch && (
        <button className="btn primary" disabled={ideaThinking} title={ideaThinking ? t.idea.prototypeWaits : undefined} onClick={() => act({ action: 'buildPrototype' }, { close: true, ack: t.idea.builtPrototype(plain(p.from?.title ?? '')) })}>
          {t.idea.buildPrototype}
        </button>
      )}
      <button className="btn" onClick={() => act({ action: 'discard' }, { close: true, ack: t.idea.discarded })}>
        {t.idea.discard}
      </button>
    </>
  );

  // work that changes nothing in the repository ends with the approval: no pull request, nothing lands
  const approveButton = (
    <button className="btn primary" onClick={() => act({ action: 'approve' }, { close: true, ack: item.noChange ? t.approvedNoChange : t.approved })}>
      {item.noChange ? t.approveNoChange : t.approve}
    </button>
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
        <ProposalView item={item} from={p.from} act={act}>
          <ManualFields item={item} repos={p.repos} onEdit={p.onEdit} />
        </ProposalView>
      )}

      {item.state === 'planned' && item.queue && (
        <div className="question queue">
          {'checking' in item.queue || 'cutting' in item.queue ? (
            <div className="q-text">{'checking' in item.queue ? t.queue.checkingLong : t.queue.cuttingLong}</div>
          ) : 'workspace' in item.queue ? (
            <>
              <div className="q-text">{t.queue.workspaceLong[item.queue.workspace]}</div>
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

      {item.prototypeOf && <p className="hint">{t.idea.prototypeOf(plain(p.from?.title ?? ''))}</p>}
      {item.buildProposal && (
        <div className="question proposal">
          <h4>{t.idea.buildProposal}</h4>
          <div className="q-text">{item.buildProposal}</div>
          <div className="actions">
            <button
              className="btn primary"
              disabled={ideaThinking}
              title={ideaThinking ? t.idea.prototypeWaits : undefined}
              onClick={() => act({ action: 'buildPrototype' }, { close: true, ack: t.idea.builtPrototype(plain(p.from?.title ?? '')) })}
            >
              {t.idea.acceptBuild}
            </button>
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

      {item.state === 'waiting' && item.need === 'demo' && item.demo && (
        // the summary is the handover in the conversation below
        <DemoView
          item={item}
          all={all}
          run={run}
          summary=""
          demo={item.demo}
          onAnswer={tell('answer')}
          listener={listener}
        >
          {/* the decision sits beside the video, so it needs no scrolling */}
          <div className="actions">
            {prototypeActions || approveButton}
          </div>
          {item.noChange && !item.prototypeOf && <p className="hint">{t.noChangeHint}</p>}
          <Composer placeholder={t.compose.review} listener={listener} onSend={tell('feedback')} />
          {shareBox}
        </DemoView>
      )}

      {item.demo && (item.state === 'inPr' || item.state === 'approved' || finished(item.state)) && (
        <DemoView item={item} all={all} run={run} summary="" demo={item.demo} autoplay={false}>
          <p className="hint">{t.demo.kept}</p>
          {shareBox}
        </DemoView>
      )}

      {item.state === 'waiting' && item.need === 'review' && (
        <>
          {/* the summary, and why there is no demo, are the handover in the conversation below */}
          <div className="actions">
            {prototypeActions || approveButton}
          </div>
          {item.noChange && !item.prototypeOf && <p className="hint">{t.noChangeHint}</p>}
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
          {item.pr.ready && <div className="q-text">{item.pr.held ? t.pr.held(item.pr.held.score, item.pr.held.by) : t.pr.ready(item.pr.mergeError ?? '')}</div>}
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
          {item.pr.review && <PrReview entries={item.pr.review} />}
        </div>
      )}
      {item.state === 'inPr' && !item.pr && <p className="hint">{t.pr.opening}</p>}

      {item.finishing && finished(item.state) && <p className="hint">{item.state === 'done' ? t.finishingDoneLong : t.finishingLong}</p>}

      {/* what was said on the card and how the work went, from its idea's discussion on; the owner's words go below it */}
      {worked && <TaskTalk item={item} listener={listener} act={act} tell={tell} />}

      {finished(item.state) && item.source === 'manual' && !item.finishing && (
        <div className="actions">
          <ArchiveButton item={item} run={run} />
        </div>
      )}

      {error && <p className="p-error">{error}</p>}

      {/* a decided idea keeps what it was decided on, and how */}
      {item.brief !== undefined && (
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
      )}

      {worked && (
        <>
          {((item.body.trim() && item.body.trim() !== item.brief?.trim()) || !!item.images?.length) && (
            <details className="p-task">
              <summary>{t.task}</summary>
              <Body md={item.body} />
              <Shots ids={item.images} />
            </details>
          )}
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
          {(item.state === 'working' || item.state === 'waiting' || item.finishing) && (
            <div className="actions">
              {/* a prototype that waits for review has its decision beside the demo */}
              {item.prototypeOf && !(item.state === 'waiting' && item.need !== 'question') && prototypeActions}
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
          <Shots ids={item.images} />
          {parent?.plan && <PlanSource file={parent.plan.file} onRead={parent.archivedAt ? undefined : () => p.onReadPlan(parent, item.label)} />}
        </>
      )}

      {/* a card nobody worked on shows its conversation once there is something, such as a talk with the Koordinator */}
      {!worked && <Conversation item={item} past hideEmpty />}
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
      <div className="idea-grid">
        <div className="idea-brief">
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
        </div>
        <div className="idea-talk">
          {/* the questions stand under the agent's reply, in the conversation; the owner's words go with their picks */}
          {/* an archived idea is read only: it comes back onto the canvas before anyone talks to it again */}
          {item.archivedAt ? (
            <Conversation item={item} past />
          ) : (
            <>
              <Conversation item={item} questions={<Questions questions={idea.questions} heading={idea.questions.length > 1 ? t.ask.questions : t.ask.question} {...answer} />} />
              <Composer
                placeholder={idea.questions.length ? t.ask.words : t.idea.compose}
                button={idea.questions.length ? t.ask.send : t.send}
                allowEmpty={answer.picked}
                listener={t.voice.idea(plain(item.title))}
                // picked options go to the agent as they are; words alone go through the Koordinator, like spoken ones
                onSend={async (words, images) =>
                  answer.picked
                    ? act({ action: 'discuss', text: answerText(idea.questions, answer.picks, words, true), images }, { close: false })
                    : onTell(words, images, 'discuss')
                }
              />
            </>
          )}
        </div>
      </div>
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
          {idea.thinking && <p className={idea.buildAfterReply ? 'hint build-waits' : 'hint'}>{idea.buildAfterReply ? t.idea.buildWaitsHint : t.idea.waitForReply}</p>}
          <div className="actions">
            {idea.buildAfterReply ? (
              <>
                <button className="btn primary armed" disabled aria-pressed>
                  {t.idea.buildWaits}
                </button>
                <button className="btn" onClick={() => act({ action: 'unbuild' }, { close: false })}>
                  {t.idea.unbuild}
                </button>
              </>
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
function ProposalView({ item, from, act, children }: { item: Item; from?: Item; act: (a: CardAction, done: ActDone) => Promise<void>; children: ReactNode }) {
  const questions = item.proposal?.questions ?? [];
  const answer = usePicks(questions);
  const idea = !!item.proposal?.idea;
  const accept = (start: boolean) => act({ action: 'accept', ...(start ? {} : { start: false }), ...(answer.picked ? { picks: answer.picks } : {}) }, start ? { close: true, ack: idea ? t.acceptedIdea : t.accepted } : { close: false });
  return (
    <>
      {children}
      {from && <p className="hint">{t.proposedBy(plain(from.title))}{item.proposal?.reason && <> {item.proposal.reason}</>}</p>}
      {item.retro && <p className="hint">{t.proposedByRetro(item.retro)}</p>}
      {questions.length > 0 && (
        <>
          <Questions questions={questions} heading={t.proposalQuestions} {...answer} />
          <p className="hint">{t.proposalQuestionsHint}</p>
        </>
      )}
      <div className="actions">
        <button className="btn primary" onClick={() => accept(true)}>
          {idea ? t.acceptIdea : t.accept}
        </button>
        <button className="btn" onClick={() => accept(false)}>
          {idea ? t.acceptAsTask : t.acceptOnly}
        </button>
        <button className="btn" onClick={() => act({ action: 'dismiss' }, { close: true, ack: t.dismissed })}>
          {t.dismiss}
        </button>
      </div>
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
  const asking = item.state === 'waiting' && item.need === 'question' ? item.question : undefined;
  // a worker finishing after the landing works unless it waits for the owner's answer
  const working = !past && (idea ? !!item.idea?.thinking : item.state === 'working' || (!!item.finishing && finished(item.state)));
  const asked = JSON.stringify(item.idea?.questions ?? asking ?? []);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, working, asked]);
  const turns = useMemo(() => (events ? talkTurns(events, { asking, over: !working }) : null), [events, asked, working]);
  if (!events || !turns) return null;
  if (hideEmpty && !turns.shown.length && !turns.pending.length) return null;
  const agent = idea ? t.author.explorer : t.author.worker;
  // the demo report's question goes with the handover it came with
  const handover = item.demo?.question ? turns.shown.findLast((x) => x.e.kind === 'review') : undefined;
  return (
    <>
      <h4 className="p-h">{t.talk.heading}</h4>
      <div className="talk conv" ref={box}>
        {turns.shown.length === 0 && !working && !turns.asked && <div className="hint">{idea ? t.idea.talkEmpty : t.talk.empty}</div>}
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
          <div className={`msg by-${idea ? 'explorer' : 'worker'} thinking`}>
            <div className="who">
              {agent} {idea ? t.idea.thinking : t.talk.working}
            </div>
            {turns.pending.at(-1) && <div className="hint">{clipLine(turns.pending.at(-1)!.text)}</div>}
            <Steps steps={turns.pending} />
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
  const [height, setHeight] = useState(48);
  const page = useMemo(() => mockPage(mock.html), [mock.html]);
  useEffect(() => {
    // a mock as high as its frame would grow with each step: it stops after a few
    let steps = 0;
    const on = (e: MessageEvent) => {
      const h = e.source === frame.current?.contentWindow && (e.data as { obeyaHeight?: unknown } | null)?.obeyaHeight;
      if (typeof h === 'number' && h > 0 && steps++ < 30) setHeight(Math.min(Math.ceil(h), 480));
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);
  return (
    <figure className="mock">
      {mock.title && <figcaption>{mock.title}</figcaption>}
      <iframe ref={frame} sandbox="allow-scripts" srcDoc={page} title={mock.title || t.idea.mock} style={{ height }} />
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
  onAnswer,
  listener,
}: {
  item: Item;
  all?: Item[];
  run?: Run;
  summary: string;
  demo: Demo;
  children: ReactNode;
  autoplay?: boolean;
  /** Answers the report's open question; without it the question only shows. */
  onAnswer?: (text: string, images?: string[]) => Promise<void>;
  /** Who reads what the owner types into the answer field. */
  listener?: string;
}) {
  const cardId = item.id;
  const video = useRef<HTMLVideoElement>(null);
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
      <div className="p-grid">
        {demo.kind === 'html' ? (
          // the worker's page: scripts run, but in an origin of its own, away from Obeya's API
          <iframe className="artifact" sandbox="allow-scripts" src={src('index.html')} title={t.demo.artifact} />
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
        <div>
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
          {demo.question && (
            <div className="question">
              <h4>{t.demo.question}</h4>
              <div className="q-text">{demo.question}</div>
              {demo.answer ? (
                <p className="hint">
                  {t.demo.yourAnswer}: {demo.answer}
                </p>
              ) : (
                onAnswer && <Composer placeholder={t.demo.answerPlaceholder} listener={listener} onSend={onAnswer} />
              )}
            </div>
          )}
          {children}
        </div>
      </div>
      <Body md={summary} />
    </>
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

function ManualTitle({ item, onEdit }: { item: Item; onEdit: (p: CardPatch) => void }) {
  // a local draft: the server echo must not overwrite what is being typed
  const [title, setTitle] = useState(item.title);
  // one line of text that wraps: a long title shows in full instead of running out of the box
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
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
  }, [title]);
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

function ManualFields({ item, repos, onEdit }: { item: Item; repos: RepoRef[]; onEdit: (p: CardPatch) => void }) {
  const [body, setBody] = useState(item.body);
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
 * A worked card's conversation, and below it what the owner says to its agent: the answer to the
 * question it waits on (options picked and own words go out as one answer), a note, or feedback.
 */
function TaskTalk({ item, listener, act, tell }: { item: Item; listener: string; act: (a: CardAction, done: ActDone) => Promise<void>; tell: (field: Field) => (text: string, images?: string[]) => Promise<void> }) {
  const asking = item.state === 'waiting' && item.need === 'question';
  const key = JSON.stringify(item.question ?? null);
  const questions = useMemo(() => (asking && item.question ? [item.question] : []), [asking, key]);
  const answer = usePicks(questions);
  const review = item.state === 'waiting' && item.need === 'review';
  return (
    <>
      <Conversation item={item} questions={asking && <Questions questions={questions} heading={t.questionFromWorker} {...answer} />} />
      {asking ? (
        <Composer
          key={key}
          placeholder={item.question?.options.length ? t.ask.words : t.compose.question}
          button={questions.length ? t.ask.send : t.send}
          allowEmpty={answer.picked}
          listener={listener}
          // picked options go to the worker as they are; words alone go through the Koordinator, like spoken ones
          onSend={(words, images) =>
            answer.picked ? act({ action: 'answer', text: answerText(questions, answer.picks, words), images }, { close: true, ack: t.answered }) : tell('answer')(words, images)
          }
        />
      ) : (
        (item.state === 'working' || item.state === 'inPr' || review || item.finishing) && (
          <Composer key={`${item.state}:${item.need ?? ''}`} placeholder={review ? t.compose.review : t.compose.working} listener={listener} onSend={tell(review ? 'feedback' : 'note')} />
        )
      )}
    </>
  );
}

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

const time = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

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
