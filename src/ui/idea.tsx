// An idea under discussion, and the prototypes built of it.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Item, NextStep, RepoRef } from '../core/types';
import { archiveRefusal } from '../core/card';
import { Body, Inline } from './markdown';
import { cardDraft } from './draft';
import { Composer } from './composer';
import { newRepoWords, type RepoChoice, RepoPick } from './repoPick';
import { snoozeWho } from './snooze';
import { stateLabel, t } from './strings';
import { type Act, ArchiveButton, Armed, DeleteButton, Later, RepoDownBox, type Run, StateLine, SupersededBox, type Tell } from './cardSheet';
import { Mocks, Split, Talk, wordsField } from './conversation';
import { DemoView } from './demo';

/**
 * An idea under discussion: the brief its agent keeps on top, a prototype's demo when there is one,
 * then the conversation, and the owner's decisions.
 */
export function IdeaView({
  item,
  all,
  repo,
  act,
  run,
  listener,
  onDelete,
  onTell,
  choice,
  repos,
  error,
}: {
  item: Item;
  all: Item[];
  repo: RepoRef | undefined;
  act: Act;
  run: Run;
  listener?: string | undefined;
  onDelete: () => void;
  onTell: Tell;
  choice: RepoChoice;
  repos: RepoRef[];
  error: ReactNode;
}) {
  const idea = item.idea!;
  // a folder without git has no branch to build a prototype on
  const prototypes = !repo?.folder;
  // a new repository building creates first: the button names it, a line under it says what it does
  const fresh = newRepoWords(choice, true);
  const [prototyping, setPrototyping] = useState(false);
  // what the agent would do in the owner's place is the marked click; without a suggestion, building is
  const next = idea.status === 'open' && !idea.thinking ? idea.next : undefined;
  const btn = (step: NextStep['step']) => (next ? (next.step === step ? 'btn primary suggested' : 'btn') : step === 'build' ? 'btn primary' : 'btn');
  return (
    <>
      <SupersededBox item={item} all={all} act={act} onDelete={onDelete} />
      <RepoDownBox item={item} />
      <StateLine item={item} paused={!!item.snoozed}>
        {item.snoozed && <span className="p-status"> · {snoozeWho(item.snoozed)}</span>}
        {idea.thinking && <span className="p-status"> · {t.author.explorer} {t.idea.thinking}</span>}
      </StateLine>
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
            {/* what "Split off a task" would build, as its worker's task */}
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
        // an archived idea is read only: it comes back onto the canvas before anyone talks to it again
        talk={<Talk item={item} past={!!item.archivedAt} field={item.archivedAt ? undefined : wordsField(t.idea.compose, onTell, 'discuss', act, 'discuss', listener)} />}
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
              // built in a new repository, it stays open for "Undo" and then follows the card to its canvas
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
            {/* parked or dropped, and not while a prototype of it is on the canvas */}
            {!archiveRefusal(item) && <ArchiveButton item={item} run={run} />}
            <DeleteButton onDelete={onDelete} />
          </div>
          {fresh && <p className="hint">{fresh.hint}</p>}
        </>
      )}
      {error}
    </>
  );
}

/**
 * "Have a prototype built": the variants the idea's agent planned, each chosen unless its prototype
 * runs already, and an approach of the owner's own; one prototype each starts at once.
 */
function PrototypeStart({ item, act }: { item: Item; act: Act }) {
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

/** The demos of an idea's prototypes, each under its title and how it stands; the latest one open. */
export function PrototypeDemos({ item }: { item: Item }) {
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
