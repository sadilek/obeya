// The unfolded card: what it is, what its worker does, and what the owner decides.

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type CardAction, type CardEvent, type CardPatch, type Demo, EXPORT_HTML_MAX, finished, type Item, type NextStep, type PrComment, type PrReviewEntry, type Question, type RepoRef } from '../core/types';
import { answerText, toggle } from './answer';
import { ApiError, api, at, type Field, holdRestart, onCardEvent } from './api';
import { firstOpening } from './demoSeen';
import { Inline, plain, shortTitle } from './markdown';
import { AttachButton, ShotStrip, Shots, useShotInput } from './shots';
import { errorText, stateLabel, t } from './strings';
import { talkTurns } from './talk';

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
      : item.state === 'idea'
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
        {item.demo ? (
          <DemoView item={item} summary={item.summary ?? ''} demo={item.demo} autoplay={false}>
            {null}
          </DemoView>
        ) : (
          item.summary && (
            <div className="question review">
              <h4>{t.summary}</h4>
              <Body md={item.summary} />
            </div>
          )
        )}
        <Log cardId={item.id} />
        <details className="p-task">
          <summary>{t.task}</summary>
          <Body md={item.body} />
        </details>
      </>
    );
  const worked = ['working', 'waiting', 'approved', 'inPr', 'live', 'done'].includes(item.state) && !!item.branch;
  // a video demo goes to a page where the repository has a share target, else it is exported as a file; drafts and prototypes stay here
  const target = !!p.repos.find((r) => r.id === item.repo)?.share;
  const shareBox =
    !!item.demo && item.demo.kind !== 'html' && !item.prototypeOf ? target || item.share ? <ShareBox item={item} act={act} /> : <ExportBox item={item} run={run} /> : null;
  // a prototype is discarded or its idea built on it, never approved or deleted; built once the idea's agent has taken in what changed
  const ideaThinking = !!p.from?.idea?.thinking;
  const prototypeActions = item.prototypeOf && (
    <>
      {item.branch && (
        <button className="btn primary" disabled={ideaThinking} title={ideaThinking ? t.idea.waitForReply : undefined} onClick={() => act({ action: 'buildPrototype' }, { close: true, ack: t.idea.builtPrototype(plain(p.from?.title ?? '')) })}>
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
        <>
          <ManualFields item={item} repos={p.repos} onEdit={p.onEdit} />
          {p.from && <p className="hint">{t.proposedBy(plain(p.from.title))}</p>}
          {item.retro && <p className="hint">{t.proposedByRetro(item.retro)}</p>}
          <div className="actions">
            <button className="btn primary" onClick={() => act({ action: 'accept' }, { close: true, ack: t.accepted })}>
              {t.accept}
            </button>
            <button className="btn" onClick={() => act({ action: 'accept', start: false }, { close: false })}>
              {t.acceptOnly}
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

      {item.prototypeOf && <p className="hint">{t.idea.prototypeOf(plain(p.from?.title ?? ''))}</p>}
      {item.buildProposal && (
        <div className="question proposal">
          <h4>{t.idea.buildProposal}</h4>
          <div className="q-text">{item.buildProposal}</div>
          <div className="actions">
            <button
              className="btn primary"
              disabled={ideaThinking}
              title={ideaThinking ? t.idea.waitForReply : undefined}
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

      {item.state === 'waiting' && item.need === 'question' && (
        <Answer
          key={JSON.stringify(item.question ?? null)}
          questions={item.question ? [item.question] : []}
          heading={t.questionFromWorker}
          placeholder={item.question?.options.length ? t.ask.words : t.compose.question}
          listener={listener}
          onSend={(text, images) => act({ action: 'answer', text, images }, { close: true, ack: t.answered })}
          onWords={tell('answer')}
        />
      )}

      {item.state === 'waiting' && item.need === 'demo' && item.demo && (
        <DemoView
          item={item}
          all={all}
          run={run}
          summary={item.summary ?? ''}
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
          <div className="question review">
            <h4>{t.summary}</h4>
            <Body md={item.summary ?? ''} />
          </div>
          {item.noDemo && (
            <div className="question no-demo">
              <h4>{t.demo.noDemo}</h4>
              <div className="q-text">{item.noDemo}</div>
            </div>
          )}
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
          {item.pr.ready && <div className="q-text">{t.pr.ready(item.pr.mergeError ?? '')}</div>}
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

      {(item.state === 'working' || item.state === 'inPr' || (item.state === 'waiting' && item.need === 'review') || item.finishing) && (
        <Composer
          key={`${item.state}:${item.need ?? ''}`}
          placeholder={item.need === 'review' ? t.compose.review : t.compose.working}
          listener={listener}
          onSend={tell(item.need === 'review' ? 'feedback' : 'note')}
        />
      )}

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
            </div>
          )}
          <PrototypeDemos item={item} />
          <Conversation item={item} past />
        </>
      )}

      {worked && (
        <>
          <Log cardId={item.id} skipTalk={item.brief !== undefined} />
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

      {/* a card nobody worked on shows its log once there is something, such as a talk with the Koordinator */}
      {!worked && <Log cardId={item.id} hideEmpty skipTalk={item.brief !== undefined} />}
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
          {/* building or planning waits for the reply, which will change the brief the owner decides on */}
          {idea.thinking && <p className="hint">{t.idea.waitForReply}</p>}
          <div className="actions">
            <button className={btn('build')} disabled={idea.thinking} onClick={() => act({ action: 'build' }, { close: true, ack: t.idea.built })}>
              {t.idea.build}
            </button>
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
 * The discussion of an idea, live: the owner's messages and the agent's replies. How the agent got
 * to a reply (what it read and thought, the decisions it recorded) folds away under that reply;
 * while it thinks, its latest step shows. The agent's open questions stand at the end. `past`: the
 * idea is decided, only the talk is left.
 */
function Conversation({ item, questions, past = false }: { item: Item; questions?: ReactNode; past?: boolean }) {
  const events = useEvents(item.id);
  const box = useRef<HTMLDivElement>(null);
  const asked = JSON.stringify(item.idea?.questions ?? []);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, item.idea?.thinking, asked]);
  if (!events) return null;
  if (past && !events.some((e) => e.kind === 'talk')) return null;
  const all = talkTurns(events);
  const turns = past ? { shown: all.shown.filter((x) => x.e.kind === 'talk'), pending: [] } : all;
  const thinking = !past && !!item.idea?.thinking;
  return (
    <>
      <h4 className="p-h">{t.idea.talk}</h4>
      <div className="talk" ref={box}>
        {turns.shown.length === 0 && !thinking && <div className="hint">{t.idea.talkEmpty}</div>}
        {!past && item.body.trim() && !opened(events, item.body) && (
          <div className="msg by-owner seed">
            <div className="who">{t.idea.seed}</div>
            <Body md={item.body} />
          </div>
        )}
        {turns.shown.map(({ e, steps }) =>
          e.kind === 'talk' ? (
            <div key={e.id} className={`msg by-${e.author}`}>
              <div className="who">
                {t.author[e.author]} <span className="t">{time(e.at)}</span>
              </div>
              <Body md={e.text} />
              <Shots ids={e.images} />
              <Steps steps={steps} />
            </div>
          ) : (
            <div key={e.id} className={`note ev-${e.kind}`} title={e.code ? e.text : undefined}>
              {time(e.at)} · {eventText(e)}
            </div>
          ),
        )}
        {thinking ? (
          <div className="msg by-explorer thinking">
            <div className="who">
              {t.author.explorer} {t.idea.thinking}
            </div>
            {turns.pending.at(-1) && <div className="hint">{clipLine(turns.pending.at(-1)!.text)}</div>}
            <Steps steps={turns.pending} />
          </div>
        ) : (
          turns.pending.length > 0 && (
            <div className="msg by-explorer">
              <Steps steps={turns.pending} />
            </div>
          )
        )}
        {!thinking && questions}
      </div>
    </>
  );
}

/** What the agent did on its way to a reply, folded. */
function Steps({ steps }: { steps: CardEvent[] }) {
  if (!steps.length) return null;
  return (
    <details className="steps">
      <summary>{t.idea.steps(steps.length)}</summary>
      <ol>
        {steps.map((s) => (
          <li key={s.id} className={`step-${s.kind}`}>
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
                    {run && list === demo.findings && <FollowUp finding={x} item={item} all={all} run={run} />}
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

/**
 * Sharing the video with colleagues: "Teilen" publishes it right away, then the page's link with
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
        <button className="btn" title={t.share.shareHint} onClick={() => go('share')}>
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
 * page with the video beside it, or one HTML file that holds everything (short videos only).
 */
function ExportBox({ item, run }: { item: Item; run: Run }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'zip' | 'html' | null>(null);
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (open) api.demoSize(item.id).then(setSize, () => {});
  }, [open, item.id]);
  const tooLarge = size !== null && size > EXPORT_HTML_MAX;
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
            <button className="btn" title={t.share.zipHint} disabled={!!busy} onClick={() => go('zip')}>
              {busy === 'zip' ? t.share.preparing : t.share.zip}
            </button>
            <button className="btn" title={tooLarge ? t.share.tooLarge(size!) : t.share.htmlHint} disabled={!!busy || tooLarge} onClick={() => go('html')}>
              {busy === 'html' ? t.share.preparing : t.share.html}
            </button>
          </div>
          {tooLarge && <p className="hint">{t.share.tooLarge(size!)}</p>}
          {busy && !item.demo?.page && <p className="hint">{t.share.writingPage}</p>}
        </>
      )}
    </div>
  );
}

/** Makes a finding of the demo a card of its own that comes from this one, or names the card it already became. */
function FollowUp({ finding, item, all, run }: { finding: string; item: Item; all: Item[]; run: Run }) {
  const text = finding.trim();
  const made = all.find((i) => i.from === item.id && i.state !== 'proposal' && !i.prototypeOf && i.body.includes(text));
  if (made) return <div className="follow-up done">→ {t.demo.followedUp(plain(made.title))}</div>;
  return (
    <button
      className="follow-up"
      onClick={() => run(() => api.create({ title: shortTitle(text), body: text, from: item.id }).then(() => {}), { close: false })}
    >
      + {t.demo.followUp}
    </button>
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

/** A worker's question with its answer options, and the composer for the owner's own words: both go out as one answer. */
function Answer(p: {
  questions: Question[];
  heading: string;
  placeholder: string;
  listener: string;
  /** The options picked, with the owner's words: straight to the agent. */
  onSend: (text: string, images?: string[]) => Promise<void>;
  /** Words alone: read by the Koordinator, like spoken ones. */
  onWords: (text: string, images?: string[]) => Promise<void>;
}) {
  const answer = usePicks(p.questions);
  return (
    <>
      <Questions questions={p.questions} heading={p.heading} {...answer} />
      <Composer
        placeholder={p.placeholder}
        button={p.questions.length ? t.ask.send : t.send}
        allowEmpty={answer.picked}
        listener={p.listener}
        onSend={(words, images) => (answer.picked ? p.onSend(answerText(p.questions, answer.picks, words), images) : p.onWords(words, images))}
      />
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

/** The card's log, live. */
function Log({ cardId, hideEmpty, skipTalk }: { cardId: string; hideEmpty?: boolean; skipTalk?: boolean }) {
  const all = useEvents(cardId);
  // the conversation of a decided idea shows on its own
  const events = useMemo(() => (all && skipTalk ? all.filter((e) => e.kind !== 'talk') : all), [all, skipTalk]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);
  if (!events || (hideEmpty && !events.length)) return null;
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
              {e.kind === 'say' ? <Inline md={e.text} /> : eventText(e)}
              <Shots ids={e.images} />
            </span>
          </div>
        ))}
      </div>
    </>
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
