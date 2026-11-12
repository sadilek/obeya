// A card's row as the UI sees it (`Item`): what `toItems` makes of the stored rows and the plan
// docs, and what a row says of the card's work.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanDoc } from '../core/plan-doc';
import type { CardState, Demo, EarlierDemo, Idea, Item, PullRequest, Superseded, Thread } from '../core/types';
import { finished } from '../core/card';
import { type AgentEffort, cardAgentOf } from '../core/agents';
import type { CardRow } from './db';
import { docOfRef, keyOfRef, OUTSIDE_PATH, pathOfRef, repoOfRef, workstreamRef } from './plan-ref';
import { fromJson, type PrState, type StoredDemo } from './row';
import { revocable } from './revocable';
import { sessionHarness } from './runtime';
import { atHand, cardDemos, pageTagsOf, reshareable, sameDemo, sharedDemos, type ThemeNow } from './shared-pages';

/** States a worker or the owner's decision is still part of. */
export const ACTIVE: string[] = ['working', 'waiting', 'inPr', 'approved'];

/** A demo as the UI gets it: without its directories, and saying whether a video has a poster. */
const shownDemo = ({ dir, kept: _, ...d }: StoredDemo): Demo => (d.kind !== 'html' && !existsSync(join(dir, 'poster.jpg')) ? { ...d, noPoster: true } : d);

/** The earlier demos at hand (`atHand`) as the UI gets them, each with its place among them. */
const earlierDemos = (r: CardRow): EarlierDemo[] => atHand(r).map(({ d, n }) => ({ ...shownDemo(d), n }));

/** Visible items: projects first, their workstreams in doc order, then manual cards. */
export function toItems(rows: CardRow[], docs: PlanDoc[], home: string, worked?: Worked, themeNow?: ThemeNow): Item[] {
  const work = (r: CardRow) => workOf(r, worked, themeNow);
  const docByFile = new Map(docs.map((d) => [d.file, d]));
  // a project's group covers its workstreams
  const groupOf = new Map(rows.flatMap((r) => (r.kind === 'project' && r.group_id ? [[r.id, r.group_id]] : [])));
  // what each workstream builds on, by its project's reading of the doc
  const depsOf = new Map(rows.flatMap((r) => (r.kind === 'project' && r.deps ? [[r.id, fromJson(r.deps)]] : [])));
  const idOfRef = new Map(rows.flatMap((r) => (r.plan_ref ? [[r.plan_ref, r.id]] : [])));
  const projects: Item[] = [];
  const workstreams: { item: Item; order: number }[] = [];
  const manual: Item[] = [];
  for (const r of rows) {
    if (!r.plan_ref) {
      manual.push({
        id: r.id,
        short: r.short,
        number: r.number,
        kind: r.kind,
        state: stateOf(r),
        ...(r.need ? { need: r.need } : {}),
        title: r.title ?? '',
        body: r.body ?? '',
        x: r.x,
        y: r.y,
        source: 'manual',
        repo: r.repo ?? home,
        changedAt: r.changed_at,
        ...work(r),
        ...(r.state === 'idea' ? { idea: ideaOf(r) } : r.idea ? decided(r) : {}),
        ...(r.thread ? { thread: threadOf(r) } : {}),
        ...(r.becomes_project ? { becomesProject: true } : {}),
        ...(r.prototype_of ? { prototypeOf: r.prototype_of, ...prototypeOf(r) } : {}),
        ...(r.built_on ? { builtOn: r.built_on, ...(r.session_id ? {} : { unstarted: true as const }) } : {}),
        ...(r.images ? { images: fromJson(r.images) } : {}),
        ...(r.retro ? { retro: r.retro } : {}),
        ...(r.proposal ? (r.state === 'proposal' ? { proposal: fromJson(r.proposal)! } : { proposed: true as const, ...supersededOf(r) }) : {}),
        ...(r.group_id ? { group: r.group_id } : {}),
        ...newRepoOf(r),
      });
      continue;
    }
    const key = keyOfRef(r.plan_ref);
    const doc = docByFile.get(docOfRef(r.plan_ref));
    if (!doc) continue;
    if (key === null) {
      projects.push({
        id: r.id,
        short: r.short,
        number: r.number,
        kind: 'project',
        state: 'planned',
        title: doc.title,
        body: '',
        x: r.x,
        y: r.y,
        source: 'plan',
        repo: repoOfRef(doc.file, home),
        changedAt: r.changed_at,
        plan: { file: doc.file, goal: doc.goal },
        ...(depsOf.get(r.id)?.reading ? { arranging: true as const } : {}),
        ...(r.collapsed ? { collapsed: true } : {}),
        ...(r.from_id ? { origin: r.from_id } : {}),
        ...(r.group_id ? { group: r.group_id } : {}),
        ...(r.spent ? { spent: r.spent } : {}),
      });
      continue;
    }
    const order = doc.workstreams.findIndex((w) => w.key === key);
    const w = doc.workstreams[order];
    if (!w || !r.parent_id) continue;
    const derived = w.done ? 'live' : w.inReview ? 'inPr' : 'planned';
    // work in progress wins over the doc: a ticked-off workstream may still wait for its merge, and so
    // does a stopped one whose box a plan folder outside the repository ticked
    const state = r.state && (ACTIVE.includes(r.state) || tickedAhead(r)) ? r.state : derived === 'live' ? 'live' : (r.state ?? derived);
    // what landed of a workstream planned again, also while a new run does the rest; once that lands, the card is live
    const shipped = state === 'planned' || ACTIVE.includes(state) ? fromJson(r.shipped) : null;
    const buildsOn = (depsOf.get(r.parent_id)?.on?.[key] ?? []).flatMap((k) => idOfRef.get(workstreamRef(doc.file, k)) ?? []);
    workstreams.push({
      order,
      item: {
        id: r.id,
        short: r.short,
        number: r.number,
        kind: r.kind,
        state,
        ...(r.need ? { need: r.need } : {}),
        title: w.title,
        body: w.body,
        x: r.x,
        y: r.y,
        parent: r.parent_id,
        source: 'plan',
        repo: repoOfRef(r.plan_ref, home),
        changedAt: r.changed_at,
        ...(w.label ? { label: w.label } : {}),
        ...work(r),
        ...(shipped ? { landedPart: { ...(shipped.commit ? { commit: shipped.commit } : {}), ...(shipped.pr ? { pr: shipped.pr } : {}) } } : {}),
        ...(r.built_on ? { builtOn: r.built_on, ...(r.session_id ? {} : { unstarted: true as const }) } : {}),
        ...(buildsOn.length ? { buildsOn } : {}),
        ...(groupOf.get(r.parent_id) ? { group: groupOf.get(r.parent_id)! } : {}),
      },
    });
  }
  const shown = new Set(projects.map((p) => p.id));
  const kids = workstreams.filter((w) => shown.has(w.item.parent!));
  const ordered = projects.flatMap((p) =>
    kids
      .filter((k) => k.item.parent === p.id)
      .sort((a, b) => a.order - b.order)
      .map((k) => k.item),
  );
  return [...projects, ...ordered, ...manual];
}

/** A card's new repository while it is still to be made, before work on the card begins. */
function newRepoOf(r: CardRow): Pick<Item, 'newRepo'> {
  const n = fromJson(r.new_repo);
  if (!n || n.made || n.none || begun(r)) return {};
  const { made: _, ...newRepo } = n;
  return { newRepo };
}

/** What `toItems` made of cards' rows: the fields a worker adds, by card, with the row they came from. */
export type Worked = Map<string, { row: CardRow; work: Partial<Item> }>;

/** The fields a worker adds to the card, as `worked` holds them while its row is the same. */
function workOf(r: CardRow, worked?: Worked, themeNow?: ThemeNow): Partial<Item> {
  const had = worked?.get(r.id);
  if (had && sameRow(had.row, r)) return had.work;
  const made = work(r, themeNow);
  worked?.set(r.id, { row: r, work: made });
  return made;
}

const sameRow = (a: CardRow, b: CardRow) => {
  for (const k in b) if (a[k as keyof CardRow] !== b[k as keyof CardRow]) return false;
  return true;
};

/** A pull request of the card as the card shows it. */
const pullRequest = (pr: PrState): PullRequest => ({
  url: pr.url!,
  number: pr.number!,
  ...(pr.repo ? { repo: pr.repo } : {}),
  ...(pr.merged ? { merged: true } : {}),
  ...(pr.closed ? { closed: true } : {}),
  checks: pr.checks ?? [],
  conflict: !!pr.conflictHead,
  ...(pr.readyHead && (pr.mergeError || pr.held || pr.manual) ? { ready: true, ...(pr.mergeError ? { mergeError: pr.mergeError } : {}), ...(pr.held ? { held: pr.held } : {}), ...(pr.manual ? { manual: true } : {}) } : {}),
  ...(pr.waits?.length && !pr.merged && !pr.closed ? { waits: pr.waits } : {}),
  ...(pr.upstream ? { into: { branch: pr.upstream.into, ...(pr.upstream.conflict ? { conflict: true as const } : {}), ...(pr.upstream.blocked ? { blocked: pr.upstream.blocked.why } : {}) } } : {}),
  ...(pr.review?.length ? { review: pr.review } : {}),
});

/** The fields a worker adds to a card. */
function work(r: CardRow, themeNow?: ThemeNow): Partial<Item> {
  const detail = fromJson(r.detail) ?? {};
  const demo = r.demo ? shownDemo(fromJson(r.demo)) : undefined;
  const earlier = demo ? earlierDemos(r) : [];
  const handed = r.need === 'review' || r.need === 'demo';
  const answering = detail.answering && handed;
  const scope = fromJson(r.scope)?.files;
  const pr = fromJson(r.pr) ?? undefined;
  const contribution = fromJson(r.contribution);
  const share = shareOf(r, themeNow);
  const notOnApproval = fromJson(r.share)?.notOnApproval;
  const tags = demo && !r.prototype_of ? pageTagsOf(r) : {};
  const landed = fromJson(r.landed);
  const revoke = revocable(r);
  return {
    ...(scope?.length ? { scope } : {}),
    ...(r.upstream ? { upstream: true as const } : {}),
    ...(r.adopted ? { adopted: fromJson(r.adopted) } : {}),
    ...(r.queue && stateOf(r) === 'planned' ? { queue: fromJson(r.queue) } : {}),
    ...(pr?.url ? { pr: pullRequest(pr) } : {}),
    ...(pr?.rollback ? { rollbackOf: pr.rollback.of } : {}),
    ...(revoke ? { revocable: revoke } : {}),
    ...(pr?.more?.some((m) => m.url) ? { morePrs: pr.more.filter((m) => m.url).map(pullRequest) } : {}),
    ...(contribution ? { contribution: { url: contribution.url, number: contribution.number, author: contribution.author, title: contribution.title, canModify: contribution.canModify, ...(contribution.results ? { results: contribution.results } : {}), ...(contribution.findings ? { findings: contribution.findings } : {}), ...(contribution.requested ? { requested: contribution.requested } : {}), ...(contribution.held ? { held: { body: contribution.held.body, commits: contribution.held.commits, asks: contribution.held.asks } } : {}), ...(contribution.clash ? { clash: contribution.clash } : {}) } } : {}),
    ...(r.status_line ? { statusLine: r.status_line } : {}),
    ...(detail.question && r.need === 'question' ? { question: detail.question } : {}),
    // a demo's question is as open as a worker's: the owner answers it on the card or by voice
    ...(demo?.question && !demo.answer && r.need === 'demo' ? { question: { text: demo.question, options: demo.options ?? [], ...(demo.multiple ? { multiple: true } : {}), ...(demo.pick ? { pick: demo.pick } : {}) } } : {}),
    ...(detail.summary && handed ? { summary: detail.summary } : {}),
    ...(answering ? { answering: true } : {}),
    ...(detail.answered && !answering && handed ? { answered: true } : {}),
    ...(r.held ? { held: fromJson(r.held).map((h) => h.id) } : {}),
    // approved work is held for its next handover while the card is at work or asks the owner; on a waiting card it is landing
    ...(r.approved_at && r.state === 'waiting' && r.need !== 'question' ? { landing: true } : {}),
    ...(demo ? { demo } : {}),
    ...(earlier.length ? { demos: earlier } : {}),
    ...(r.files ? { files: fromJson(r.files) } : {}),
    ...(r.change_size ? { changeSize: fromJson(r.change_size) } : {}),
    ...(share ? { share } : {}),
    ...(notOnApproval ? { notOnApproval } : {}),
    ...(Object.keys(tags).length ? { tags } : {}),
    ...(r.from_id ? { from: r.from_id } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
    // a workspace on another machine as ssh and scp write it
    ...(r.workspace ? { workspace: r.workspace.replace(/^ssh:\/\/([^/]+)/, '$1:') } : {}),
    ...(r.kept_in ? { keptIn: r.kept_in.replace(/^ssh:\/\/([^/]+)/, '$1:') } : {}),
    ...(landed && (r.workspace || landed.needsClone) ? { finishing: true, ...(landed.followUp && !landed.resolve ? { followUp: true } : {}), ...(landed.needsClone && !r.workspace ? { waitsForClone: true } : {}) } : {}),
    ...(detail.noChange && handed ? { noChange: true } : {}),
    ...(detail.lands && handed ? { lands: detail.lands } : {}),
    ...(detail.upstreamNew && handed ? { upstreamNew: detail.upstreamNew } : {}),
    ...(r.paused ? { paused: true } : {}),
    ...(r.pausing && !r.paused ? { pausing: true } : {}),
    ...(r.snoozed ? { snoozed: fromJson(r.snoozed) } : {}),
    ...(r.app && r.workspace && !r.parked ? { app: r.app } : {}),
    ...(r.session_id && r.model ? { runsOn: { harness: sessionHarness(r.session_id), model: r.model, ...(r.effort ? { effort: r.effort as AgentEffort } : {}) } } : {}),
    ...(r.agent ? { agent: cardAgentOf(r.agent) } : {}),
    ...(r.spent ? { spent: r.spent } : {}),
  };
}

/** The card's shared page as the UI sees it: none when it is not shared and not about to be. */
function shareOf(r: CardRow, themeNow?: ThemeNow): Item['share'] {
  const s = fromJson(r.share);
  if (!s || (!s.state && !s.url)) return undefined;
  // asked of a page at rest alone, so the cards never shared ask nothing
  const theme = s.url && !s.state ? themeNow?.(r) : undefined;
  // the newest demo of a handover: drafts shown with a question since are not what the page lacks
  const latest = r.demo ? [...(fromJson(r.demos) ?? []), fromJson(r.demo)].findLast((d) => !d.asked) : undefined;
  const shared = s.url ? sharedDemos(s) : [];
  // the card's demos on the page, by their handovers
  const on = cardDemos(r).flatMap((d) => (d.handover !== undefined && shared.some((x) => sameDemo(x, d)) ? [d.handover] : []));
  const stale = !!s.url && !!latest && !shared.some((x) => sameDemo(x, latest));
  const outdated = reshareable(r, theme);
  return {
    state: s.refresh ? 'shared' : (s.state ?? 'shared'),
    ...(s.url ? { url: s.url } : {}),
    ...(on.length ? { on } : {}),
    ...(stale ? { stale: true } : {}),
    // shown with each version on the page; the latest, not on it, brings the changes with "Replace on the page" or "Add to the page"
    ...(outdated.length ? { outdated } : {}),
    ...(s.personal && s.token ? { unlisted: true as const } : {}),
  };
}

/** A prototype's end and proposal; an ended one keeps the summary it was handed over with. */
function prototypeOf(r: CardRow): Partial<Item> {
  const p = fromJson(r.prototype) ?? {};
  const summary = p.end && r.detail ? fromJson(r.detail).summary : undefined;
  return { ...(p.variant ? { variant: p.variant } : {}), ...(p.end ? { prototypeEnd: p.end } : {}), ...(p.into ? { builtInto: p.into } : {}), ...(p.proposal && !p.end ? { buildProposal: p.proposal } : {}), ...(summary ? { summary } : {}) };
}

/** The mark of an accepted proposal its agent withdrew or replaced, while the card is not finished. */
const supersededOf = (r: CardRow): { superseded?: Superseded } => {
  const superseded = fromJson(r.proposal)?.superseded;
  return superseded && !r.archived_at && !finished(stateOf(r)) ? { superseded } : {};
};

/** A card that was an idea, as decided: the brief with its mocks. */
function decided(r: CardRow): Pick<Item, 'brief' | 'mocks'> {
  const i = fromJson(r.idea!);
  return { brief: i.brief, ...(i.mocks?.length ? { mocks: i.mocks } : {}) };
}

function threadOf(r: CardRow): Thread {
  const t = fromJson(r.thread!);
  return { talk: t.talk, ...(t.thinking ? { thinking: true } : {}), answers: t.answers, files: t.files };
}

function ideaOf(r: CardRow): Idea {
  const i = r.idea ? fromJson(r.idea) : { status: 'open' as const, brief: '' };
  return { status: i.status, brief: i.brief, thinking: !!i.thinking, ...(i.buildAfterReply ? { buildAfterReply: true as const } : {}), yourTurn: !!i.yourTurn, questions: i.questions ?? [], ...(i.next ? { next: i.next } : {}), variants: i.variants ?? [], mocks: i.mocks ?? [], ...(i.split ? { split: i.split } : {}) };
}

/** Whether an agent worked on the card: it was started, or its work landed or ended. */
export const worked = (r: CardRow) => !!(r.session_id || r.branch || r.shipped || r.landed || (r.state && r.state !== 'planned'));

/** A card's state as its row holds it; a plan card's, which its plan doc gives, reads as planned. */
export const stateOf = (r: Pick<CardRow, 'state'>): CardState => r.state ?? 'planned';

/** Whether work on the card has begun: it is no idea and planned no more, or it has a workspace. */
export const begun = (r: CardRow) => (r.state !== 'idea' && stateOf(r) !== 'planned') || !!r.workspace;

/** Whether the card's agent finishes what remains after its work landed. */
export const finishing = (r: CardRow) => !!(r.landed && r.workspace);

/** Whether an agent is at work on the card: in progress, or finishing after the landing. */
export const atWork = (r: CardRow) => !!(r.state && ACTIVE.includes(r.state)) || finishing(r);

/** Whether the work of a project's doc is done: each workstream ticked, or its card (among `rows`) finished. */
export function workDone(doc: PlanDoc, rows: Pick<CardRow, 'plan_ref' | 'state'>[]): boolean {
  const states = new Map(rows.flatMap((r) => (r.plan_ref && keyOfRef(r.plan_ref) !== null && docOfRef(r.plan_ref) === doc.file && r.state ? [[r.plan_ref, r.state]] : [])));
  return doc.workstreams.every((w) => {
    const state = states.get(workstreamRef(doc.file, w.key));
    return w.done || (!!state && finished(state));
  });
}

/**
 * A workstream card with work not landed yet that a box in a plan folder outside the repository says
 * nothing of: the worker ticks it there at once, in no commit, so it may be ticked while the card is
 * in its pull request (before it is even open) or stopped with its branch.
 */
export function tickedAhead(r: Pick<CardRow, 'plan_ref' | 'state' | 'branch'>): boolean {
  if (!r.plan_ref || !OUTSIDE_PATH.test(pathOfRef(r.plan_ref))) return false;
  return r.state === 'inPr' || (r.state === 'planned' && !!r.branch);
}
