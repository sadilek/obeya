// A card's pull request: its checks, its review, and the text that goes onto it with the approval.

import { useEffect, useState } from 'react';
import { type HeldChanges, type PrComment, type PrReviewEntry, type PullRequest } from '../core/types';
import { api, failText } from './api';
import { Body, Inline } from './markdown';
import { MdField } from './mdField';
import { DictationLine } from './dictation';
import { cardDraft, draftOf, dropDraft, hasDraft, updateDraft, useDraft, useDrafting } from './draft';
import { clock as time, t } from './strings';


/**
 * A card's pull request: its checks, whether it is ready, and its review. On a review card whose
 * agent's own changes wait for the approval (`held`), first what goes onto the PR with it: how many
 * commits, the text posted with them, and the findings it asks the contributor for.
 */
export function PrBox({ pr, held, author, card }: { pr: PullRequest; held?: HeldChanges; author?: string; card?: string }) {
  // a conflict says so on its own line
  const waits = pr.ready ? [] : (pr.waits ?? []).filter((w) => w !== 'conflict' || !pr.conflict);
  return (
    <div className="question pr">
      <h4>
        <a href={pr.url} target="_blank" rel="noreferrer">
          {t.pr.title(pr.number, pr.repo)} ↗
        </a>
      </h4>
      {held && (
        <div className="pr-held">
          <h5>
            {t.review.heldHead(pr.number)} · {t.review.heldCommits(held.commits)}
          </h5>
          {card ? (
            <HeldText card={card} body={held.body} />
          ) : (
            <div className="pr-held-text">
              <Body md={held.body} />
            </div>
          )}
          {held.asks.length > 0 && author && <div className="pr-held-asks">{t.review.heldAsks(held.asks, author)}</div>}
        </div>
      )}
      {pr.merged && <div className="q-text">{t.pr.merged}</div>}
      {pr.closed && <div className="q-text">{t.pr.closed}</div>}
      {pr.conflict && <div className="q-text">{t.pr.conflict}</div>}
      {waits.length > 0 && <div className="q-text">{t.pr.waits(waits)}</div>}
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

/** The draft of the text for the PR the owner is rewriting on card `id`, kept like the card's field. */
const heldDraft = (id: string) => `${cardDraft(id)}:pr-text`;

/** Saves what the owner wrote into the text for the PR on card `id` and has not saved yet; emptied, it is no comment. */
export async function saveHeld(id: string) {
  if (!hasDraft(heldDraft(id))) return;
  await api.act(id, { action: 'editHeld', body: draftOf(heldDraft(id)).text });
  dropDraft(heldDraft(id));
}

/**
 * The text that goes onto the PR with the approval, which the owner rewrites as they do a card's
 * text: a click into it opens its markdown, and leaving the field (closing the card with it, too)
 * makes their wording the text that goes out, as does the approval with the cursor still in it;
 * emptied, the commits go without a comment. What is typed waits in a draft of its own until then,
 * through a reload; words dictated with the cursor in it go in.
 */
function HeldText({ card, body }: { card: string; body: string }) {
  const key = heldDraft(card);
  const drafting = useDrafting(key);
  const { text } = useDraft(key);
  const [error, setError] = useState('');
  // what was saved shows until the PR's text comes back with it
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => setSent(null), [body]);
  const leave = async () => {
    const words = draftOf(key).text;
    if (!hasDraft(key) || words.trim() === body) return dropDraft(key);
    setError('');
    try {
      await api.act(card, { action: 'editHeld', body: words });
      setSent(words.trim());
      dropDraft(key);
    } catch (e) {
      setError(failText(e));
    }
  };
  return (
    <>
      <MdField
        text={drafting ? text : (sent ?? body)}
        draft={key}
        grow
        fieldClass="pr-held-field"
        shownClass="pr-held-text"
        title={t.review.heldEditHint}
        placeholder={t.review.heldNone}
        onChange={(v) => updateDraft(key, { text: v })}
        onLeave={() => void leave()}
      />
      <DictationLine draft={key} />
      {error && <div className="p-error">{error}</div>}
    </>
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
