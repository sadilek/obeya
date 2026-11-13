// What a pull request's review means for Obeya, read off its status on the forge: what the card
// shows of it, what the PR still waits for before a merge, and how sure its reviewers are.

import type { PrReviewEntry, PrThread, PrWait } from '../core/types';
import type { PrStatus } from './forge';

/**
 * What the card shows of a pull request's review, oldest first: each round a reviewer left comments
 * on the code in, with the replies in each thread, and the conversation between the rounds.
 * Comments by `skip` (bots that are not reviewers) are left out; `mine` marks `self`: the PR's
 * author, which is the worker writing in the owner's name, or on a review card the owner's account.
 */
export function reviewOf(s: PrStatus, skip: string[] = [], self = s.author): PrReviewEntry[] {
  const shown = s.comments.filter((c) => !skip.includes(c.author));
  const mine = (author: string) => (author === self ? { mine: true } : {});
  const threads = new Map<string, PrThread>();
  const rounds = new Map<string, Extract<PrReviewEntry, { threads: PrThread[] }>>();
  const entries: PrReviewEntry[] = [];
  for (const c of shown) {
    if (c.replyTo || !c.id.startsWith('i')) continue;
    const thread: PrThread = {
      author: c.author,
      ...mine(c.author),
      body: readable(c.body),
      at: c.at ?? '',
      ...(c.path ? { path: c.path } : {}),
      ...(c.line ? { line: c.line } : {}),
      ...(c.url ? { url: c.url } : {}),
      resolved: !!c.resolved,
      replies: [],
    };
    threads.set(c.id, thread);
    const key = c.round ?? c.id;
    const round = rounds.get(key);
    if (round) round.threads.push(thread);
    else {
      const r = { author: c.author, ...mine(c.author), at: c.at ?? '', threads: [thread] };
      rounds.set(key, r);
      entries.push(r);
    }
  }
  for (const c of shown) {
    const reply = { author: c.author, ...mine(c.author), body: readable(c.body), at: c.at ?? '' };
    if (c.replyTo) threads.get(c.replyTo)?.replies.push(reply);
    // a comment rewritten since stands where it was last changed
    else if (!c.id.startsWith('i')) entries.push({ ...reply, ...(c.edited ? { at: c.edited, edited: true } : {}), ...(c.url ? { url: c.url } : {}) });
  }
  for (const r of rounds.values()) r.at = r.threads.reduce((a, t) => (t.at && t.at < a ? t.at : a), r.at);
  return entries.filter((e) => 'threads' in e || e.body).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * What the pull request waits for before it can be merged, in the order it is in the way: what the
 * forge sees (a conflict, a branch behind its base, a draft, branch protection, mergeability not
 * worked out yet), checks failed or running, review threads open, a reviewer who has not seen the
 * PR's own latest changes, and whoever was asked for another look not having answered since the
 * author last asked (a review bot answers a re-review by rewriting its summary, often without a new
 * comment). Comments by `skip` do not count as an answer. Nothing for a PR no longer open.
 */
export function waitsOf(s: PrStatus, skip: string[] = []): PrWait[] {
  if (s.state !== 'OPEN') return [];
  const waits: PrWait[] = [];
  if (s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY') waits.push('conflict');
  else if (s.mergeState === 'BEHIND') waits.push('behind');
  else if (s.mergeState === 'DRAFT') waits.push('draft');
  else if (s.mergeState === 'BLOCKED') waits.push('protection');
  // UNSTABLE: a check not passed, which the checks below name where they hold it
  else if (s.mergeable !== 'MERGEABLE' || (s.mergeState !== 'CLEAN' && s.mergeState !== 'HAS_HOOKS' && !(s.mergeState === 'UNSTABLE' && s.checks.some((c) => c.state !== 'success'))))
    waits.push('forge');
  if (s.checks.some((c) => c.state === 'failure')) waits.push('checksFailed');
  else if (s.checks.some((c) => c.state !== 'success')) waits.push('checks');
  const others = reviewers(s, skip);
  if (others.some((c) => c.id.startsWith('i') && !c.replyTo && !c.resolved)) waits.push('threads');
  if (changesRequested(s, skip).length) waits.push('changes');
  if (reviewStale(s, skip)) waits.push('review');
  else {
    const asked = requestOf(s, skip);
    const after = (who?: string) => others.some((c) => (!who || c.author === who) && (c.edited ?? c.at ?? '') > asked!.at);
    if (asked && !(asked.awaits.length ? asked.awaits.every(after) : after())) waits.push('answer');
  }
  return waits;
}

/**
 * Whether a reviewer wrote on the pull request, but nothing since its own changes last changed
 * (a merge of the base does not count): the last verdict is about an older state. A PR merged on Greptile's 3/5 of its first commit
 * (2026-10-02): the fix pushed after it was never reviewed, as nobody asked for another look.
 */
export function reviewStale(s: PrStatus, skip: string[] = []): boolean {
  if (!s.changedAt) return false;
  const last = reviewers(s, skip).reduce((a, c) => latest(a, c.edited ?? c.at), '');
  return !!last && last < s.changedAt;
}

/**
 * The author's latest request for another look, and whose answer it waits for: a conversation
 * comment of theirs that answers a reviewer whose latest word in the conversation before it was no
 * passing verdict (a request for changes in a plain comment, which names nobody, is answered so;
 * that reviewer's answer is awaited, another's does not stand in for it), or that mentions an
 * account, as review bots are asked (`@greptile review`; then any reviewer's word answers). A
 * comment that mentions nobody while every reviewer's latest word is a passing verdict (a thank-you
 * for a 5/5 summary without findings) asks for nothing: waiting for its answer stalled a PR whose
 * review was through (2026-11-02). Passing: an approval, or a confidence of at least 4/5. A
 * reviewer's word in a thread on the code is the thread's business, not the conversation's.
 * Comments by `skip` are no reviewer's word.
 */
export function requestOf(s: PrStatus, skip: string[] = []): { at: string; awaits: string[] } | null {
  const said = reviewers(s, skip).filter((c) => !c.id.startsWith('i'));
  const when = (c: PrStatus['comments'][number]) => c.edited ?? c.at ?? '';
  let found: { at: string; awaits: string[] } | null = null;
  for (const c of s.comments) {
    if (c.author !== s.author || !c.id.startsWith('c') || !c.at || (found && c.at < found.at)) continue;
    const latestOf = new Map<string, PrStatus['comments'][number]>();
    for (const o of said) if (when(o) <= c.at && (!latestOf.has(o.author) || when(o) >= when(latestOf.get(o.author)!))) latestOf.set(o.author, o);
    const awaits = [...latestOf].filter(([, o]) => !passing(o)).map(([who]) => who);
    if (awaits.length || mentions(c.body)) found = { at: c.at, awaits };
  }
  return found;
}

/** When the author last asked for another look (`requestOf`); empty where they never did. */
export const lastAsked = (s: PrStatus, skip: string[] = []) => requestOf(s, skip)?.at ?? '';

/** Below this share of a reviewer's confidence (4 of 5), Obeya leaves the merge to the owner. */
export const MIN_CONFIDENCE = 0.8;

/** Whether a reviewer's comment is a verdict that lets the PR go: an approval, or a confidence of at least 4/5. */
export const passing = (c: PrStatus['comments'][number]) => {
  if (c.verdict === 'approved') return true;
  const m = confidenceIn(c.body);
  return !!m && m.score / m.of >= MIN_CONFIDENCE;
};

/** The confidence a comment gives, as a review bot writes it (Greptile's "Confidence Score: 3/5"); none where it gives none. */
const confidenceIn = (body: string): { score: number; of: number } | null => {
  const m = /Confidence Score:\s*(\d+)\s*\/\s*(\d+)/i.exec(body);
  return m ? { score: Number(m[1]), of: Number(m[2]) } : null;
};

/**
 * The reviewers whose request for changes (GitHub's "Request changes") stands: their latest review
 * with a verdict asks for changes, not approved or dismissed since.
 */
export function changesRequested(s: PrStatus, skip: string[] = []): string[] {
  const last = new Map<string, { at: string; verdict: string }>();
  for (const c of reviewers(s, skip)) {
    if (!c.verdict) continue;
    const at = c.at ?? '';
    const known = last.get(c.author);
    if (!known || at >= known.at) last.set(c.author, { at, verdict: c.verdict });
  }
  return [...last].filter(([, v]) => v.verdict === 'changes').map(([who]) => who);
}

/** Whether a comment mentions an account (`@name`), outside code (fenced, indented or inline) and quoted lines. */
const mentions = (body: string) =>
  /(^|[^\w`@/.-])@[a-z0-9][a-z0-9-]*/i.test(
    body
      .replace(/^ {0,3}(```|~~~)[\s\S]*?(^ {0,3}\1|$(?![\s\S]))/gm, '')
      .replace(/`[^`\n]*`/g, '')
      .replace(/^ {0,3}>.*$/gm, '')
      .replace(/^(?: {4}|\t).*$/gm, ''),
  );

/**
 * The confidence a reviewer gave last, in a comment rewritten or written latest (Greptile's
 * "Confidence Score: 3/5" in its summary); none when no reviewer gives one.
 */
export function confidence(s: PrStatus, skip: string[] = []): { score: number; of: number; by: string } | undefined {
  let found: { score: number; of: number; by: string; at: string } | undefined;
  for (const c of reviewers(s, skip)) {
    const m = confidenceIn(c.body);
    const at = c.edited ?? c.at ?? '';
    if (m && (!found || at >= found.at)) found = { ...m, by: c.author, at };
  }
  return found && { score: found.score, of: found.of, by: found.by };
}

const reviewers = (s: PrStatus, skip: string[]) => s.comments.filter((c) => c.author !== s.author && !skip.includes(c.author));
const latest = (a: string, b?: string) => (b && b > a ? b : a);

const MAX_BODY = 3000;
/** Where `readable` took a part out. */
const GONE = '\u0000';

/**
 * A comment as text the card renders: review bots write HTML (badges, folded prompts for other
 * agents, diagrams) into their Markdown; the badges' names stay, code and folded parts go.
 */
export function readable(body: string): string {
  let t = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<details>[\s\S]*?<\/details>/gi, `\n${GONE}\n`)
    .replace(/<picture>[\s\S]*?<\/picture>/gi, '')
    .replace(/```[\s\S]*?(```|$)/g, `\n${GONE}\n`)
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<h\d[^>]*>([\s\S]*?)<\/h\d>/gi, '\n### $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1');
  // headings become bold lines; a heading whose section went (a diagram, say) goes with it
  const lines = t.split('\n').map((l) => l.trimEnd());
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (!h) {
      if (line.trim() !== GONE) out.push(line);
      continue;
    }
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (next && next.trim() !== GONE && !/^#{1,6}\s/.test(next.trim()) && h[1]!.trim()) out.push(`**${h[1]!.trim()}**`);
  }
  t = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY).trimEnd()} …` : t;
}
