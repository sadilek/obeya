// A review card: what its agent found in the pull request, the owner's decisions on it, and the merge.

import { useContext } from 'react';
import type { ApproveResult, CardAction, ChangeRoute, Contribution, Item, Finding, Clash as ClashFound } from '../core/types';
import { finished } from '../core/card';
import { Inline, plain } from './markdown';
import { Cards } from './message';
import { cardDraft, updateDraft, useDraft } from './draft';
import { t } from './strings';
import { type ActDone } from './cardSheet';

/**
 * Approving a review card: "Merge (PR #5)", or where its agent's own changes wait for the approval,
 * "Push and merge" with "Push and comment only" beside it (the merge later), and with
 * requests to the contributor beside them "Push and send to …", which merges nothing and
 * leaves the card waiting for them.
 */
export function ApproveReview({ item, act }: { item: Item; act: (a: CardAction, done: ActDone) => Promise<void> }) {
  const c = item.contribution!;
  const decided = useUnsentDecisions(item);
  // a follow-up task or an ignored finding goes with the merge; a decision that holds the PR up goes with Send first
  const heldUp = Object.values(decided).some(holdsUp);
  // a PR in conflict with main is not merged: the confirmation says who resolves it
  const ackFor = (r: unknown) => {
    const conflict = (r as ApproveResult)?.conflict;
    return conflict === 'agent' ? t.review.conflictAgent(c.number) : conflict === 'contributor' ? t.review.conflictContributor(c.number, c.author) : undefined;
  };
  const go = (ack: string, pending: string) => act({ action: 'approve', ...(Object.keys(decided).length ? { findings: decided } : {}) }, { close: true, ack, ackFor, pending });
  if (c.held?.asks.length)
    return (
      <button className="btn primary" disabled={heldUp} title={t.review.pushSendHint(c.author)} onClick={() => go(t.review.pushedSent(c.author), t.review.pushingHeld)}>
        {t.review.pushSend(c.author)}
      </button>
    );
  const label = c.held ? (c.clash ? t.review.pushMergeAnyway(c.number) : t.review.pushMerge(c.number)) : c.clash ? t.review.mergeAnyway(c.number) : t.review.merge(c.number);
  return (
    <>
      <button className="btn primary" disabled={heldUp} title={c.clash ? t.review.mergeClashHint : c.held ? t.review.pushMergeHint : t.review.mergeHint} onClick={() => go(t.review.merged(c.number), c.held ? t.review.pushingHeld : t.review.merging)}>
        {label}
      </button>
      {c.held && (
        <button className="btn" disabled={heldUp} title={c.held.body ? t.review.pushOnlyHint : t.review.pushOnlyQuietHint} onClick={() => act({ action: 'pushChanges' }, { close: true, ack: c.held!.body ? t.review.pushed(c.number) : t.review.pushedQuiet(c.number), pending: t.review.pushingHeld })}>
          {c.held.body ? t.review.pushOnly : t.review.pushOnlyQuiet}
        </button>
      )}
    </>
  );
}

/**
 * What a review card's agent found, beside its demo: the checks on the PR's head and the merge probe
 * on one line, then each finding of the review, which its agent keeps as the conversation goes on.
 * Findings its agent would make one follow-up task stand together in a bracket that says so, while
 * they are open or made one. On an open finding the owner decides ("To contributor", "Change
 * it myself", "As a follow-up task", "Ignore", a second click takes it back; a bracket picks nothing for its others)
 * while their words reach its agent (`decides`); the decisions stand in the card's draft and go out
 * with the field's one Send. "Change it myself" is greyed with its reason where the contributor allows
 * no edits by maintainers. A finding something came of says what; one made a follow-up task links
 * that task.
 */
export function Findings({ item, decides, onPush }: { item: Item; decides: boolean; onPush?: () => void }) {
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
            ) : f.status === 'fixed' && c.held ? (
              t.review.fixedHeld
            ) : (
              t.review.status[f.status](c.author)
            )}
          </div>
        ) : f.decided ? (
          <div className="f-status pending">
            {f.decided === 'self' ? t.review.goingSelf : f.decided === 'later' ? t.review.goingLater : f.withChanges ? t.review.goingWithChanges(c.author) : t.review.goingTo(c.author)}
          </div>
        ) : (
          decides && (
            <div className="choices single f-choices" role="group">
              {routes(c).map((r) => (
                <button
                  key={r.route}
                  className={`choice${picks[f.id] === r.route ? ' on' : ''}`}
                  aria-pressed={picks[f.id] === r.route}
                  disabled={r.off}
                  title={r.hint}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(f, r.route)}
                >
                  {r.label}
                </button>
              ))}
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
      {c.clash && !finished(item.state) && <Clash clash={c.clash} {...(decides && onPush ? { onPush } : {})} />}
      {c.findings && (
        <h4 className="p-h">{t.review.findings(findings.length, open.length, open.filter((f) => f.security).length)}</h4>
      )}
      {blocks}
      {decides && open.some((f) => !f.decided) && <p className="hint">{t.review.decideHint}</p>}
    </section>
  );
}

/**
 * Unpushed commits on the local main that a review card's PR collides with, as Obeya found before
 * the merge: which commit the pull after it would stop at, the card that landed it (to open), and
 * what the owner can do about it.
 */
function Clash({ clash, onPush }: { clash: ClashFound; onPush?: () => void }) {
  const cards = useContext(Cards);
  const card = clash.card && cards.items.find((x) => x.id === clash.card!.id);
  // a commit named as its card is named once, as the card
  const same = !!clash.card && plain(clash.card.title).trim().toLowerCase() === clash.subject.trim().toLowerCase();
  const named = clash.card && (same ? t.review.clashCommit(clash.subject) : t.review.clashCard(plain(clash.card.title)));
  return (
    <div className="rr-clash">
      <b>{t.review.clashHead(clash.unpushed)}</b>
      <div>
        {!same && <>{t.review.clashCommit(clash.subject)} </>}
        {named &&
          (card ? (
            <a href="#" onClick={(e) => (e.preventDefault(), cards.open(card))}>
              {named}
            </a>
          ) : (
            named
          ))}{' '}
        {t.review.clashFiles(clash.files)}
      </div>
      {onPush && (
        <div className="rr-clash-push">
          <button className="btn" onClick={onPush}>
            {t.review.pushMain}
          </button>
          <span>{t.review.pushHint}</span>
        </div>
      )}
      <div className="rr-clash-what">{t.review.mergeInstead(clash.card ? plain(clash.card.title) : null)}</div>
    </div>
  );
}

/** What the owner decided in the card's draft for the findings still open and undecided on the card, which has not gone out yet. */
export function useUnsentDecisions(item: Item): Record<string, ChangeRoute> {
  const all = useDraft(cardDraft(item.id)).findings;
  const findings = item.contribution?.findings;
  return all ? Object.fromEntries(Object.entries(all).filter(([id]) => findings?.some((f) => f.id === Number(id) && f.status === 'open' && !f.decided))) : {};
}

/** The owner's decisions on a finding, in the order their buttons stand; "Change it myself" greyed with its reason where the contributor allows no edits by maintainers. */
const routes = (c: Contribution): { route: ChangeRoute; label: string; hint?: string; off?: boolean }[] => [
  { route: 'contributor', label: t.review.toContributor },
  { route: 'self', label: t.review.self, hint: c.canModify ? t.review.selfHint : t.review.selfOff(c.author), off: !c.canModify },
  { route: 'later', label: t.review.later, hint: t.review.laterHint },
  { route: 'drop', label: t.review.drop, hint: t.review.dropHint },
];

/** A decision on a finding that holds the merge up until it is sent: it goes to the contributor, or the owner changes it themselves. */
export const holdsUp = (route: ChangeRoute) => route === 'contributor' || route === 'self';

/** A finding whose bundle still means something: open, or made a follow-up task. */
const bundled = (f: Finding) => f.status === 'open' || f.status === 'later';

/**
 * Above the field of a review card: what the owner decided for its findings (`useUnsentDecisions`),
 * which goes out with the words; with several made follow-up tasks, how many tasks they become as
 * their agent bundled them.
 */
export function DecidedChip({ item, decided }: { item: Item; decided: Record<string, ChangeRoute> }) {
  const c = item.contribution!;
  const named = Object.entries(decided);
  if (!named.length) return null;
  const later = named.filter(([, route]) => route === 'later').map(([id]) => c.findings!.find((f) => f.id === Number(id))!);
  const tasks = new Set(later.map((f) => [f.id, ...(f.with ?? []).filter((w) => later.some((l) => l.id === w))].sort((a, b) => a - b).join())).size;
  return (
    <div className="quote decided">
      <div className="decided-lines">
        {named.map(([id, route]) => (
          <span key={id} className="quote-text">
            {t.review.decidedLine(Number(id), routes(c).find((r) => r.route === route)!.label)}
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
