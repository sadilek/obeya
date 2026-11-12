// Following a canvas's plan docs as they are edited: each workstream card stays with its own
// workstream when the doc renames, reorders or drops one, and a card an agent worked on whose
// workstream left the doc leaves its project as a card of its own.

import { CARD_SIZE, boundsOf, freeSpotNear, GAP, placeWorkstreams } from '../core/layout';
import { type PlanDoc, parsePlanDoc, withoutReference, type Workstream, workstreamAliases } from '../core/plan-doc';
import { finished } from '../core/card';
import type { Board } from './board';
import { branchName, CARD_BRANCH } from './branches';
import type { CardRow, Store } from './db';
import { atWork, stateOf, toItems, worked } from './items';
import { keyOfRef, outsideRef, repoOfRef, workstreamRef } from './plan-ref';
import { fromJson, toJson } from './row';

/** How long a workstream stays away from a doc in a plan folder outside the repository before its card leaves the project: such a doc is written in place, an item moved in two edits. */
export const LEAVE_AFTER_MS = 5 * 60_000;

/** A plan doc's history that `follow` needs is being read in git (`PlanFollower.past`). */
class HistoryUnread extends Error {}

/** What `fn` gives; undefined while the plan doc's history it needs is being read. */
function unreadAs<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HistoryUnread) return undefined;
    throw e;
  }
}

/**
 * The doc's workstream that a card keyed `key` had under another key: the doc dropped or added a
 * sibling, which changes whether a code is read as a label or a label needs its title. Where it is
 * known what the workstream was (`was`), the one with its label and title (a label alone may be
 * another's now); else the only one that would have had `key`.
 */
function sameWorkstream(key: string, doc: PlanDoc, was?: Pick<Workstream, 'label' | 'title'>): Workstream | undefined {
  const its = was ? workstreamAliases(was, true) : [];
  const same = doc.workstreams.filter((w) => (was ? workstreamAliases(w).some((k) => its.includes(k)) : workstreamAliases(w).includes(key)));
  return same.length === 1 ? same[0] : undefined;
}

/** Whether a branch named after a title (`branchName`, its `slug`) was named after the workstream's, with or without its label before it. */
const named = (w: Pick<Workstream, 'label' | 'title'>, slug: string) =>
  [w.title, withoutReference(w.title), ...(w.label ? [`${w.label} ${w.title}`] : [])].some((t) => branchName(t, '000000').slice(CARD_BRANCH.length, -7) === slug);

/** Keeps the workstream cards of one canvas with their workstreams as the plan docs change (`follow`). */
export class PlanFollower {
  constructor(
    private store: Store,
    private canvasId: string,
    private board: Pick<Board, 'home' | 't' | 'log' | 'changed' | 'docsChanged'>,
    /** The plan docs as the board last read them. */
    private docs: () => PlanDoc[],
  ) {}

  /** Every workstream a plan doc has had, from its history in git, the newest first (`readPlanHistory`); none for a doc outside git. */
  private planHistory?: (ref: string) => Promise<Workstream[]>;
  /**
   * Each doc's history as read for the doc's text then (`markdown`) and the read tree then (`at`,
   * which `treeMoved` counts on); `past` is missing while git reads it.
   */
  private histories = new Map<string, { markdown: string; at: number; past?: Workstream[] }>();
  private readTreeAt = 0;
  /** The docs whose projects' repair waits for their history: they stand as last read until it is there (`follow`). */
  private heldBack = new Set<string>();
  /** Cards whose workstream left its doc, by when that was seen, that wait to leave their project (`follow`). */
  private missing = new Map<string, number>();
  /** Looks at the waiting cards again once the first of them may leave. */
  private waking?: ReturnType<typeof setTimeout>;

  /** Who reads a plan doc's history (`Board.readPlanHistory`). */
  readPlanHistory(fn: (ref: string) => Promise<Workstream[]>) {
    this.planHistory = fn;
  }

  /** The repository's read tree moved after a fetch: each doc's history is read anew. */
  treeMoved() {
    this.readTreeAt++;
  }

  /**
   * What the history of the doc as it reads now says. Read once per text of the doc and read tree,
   * without the server waiting: until git is through, this throws `HistoryUnread`, and the plan
   * docs are read again (`docsChanged`) once it is.
   */
  private past(doc: PlanDoc): Workstream[] {
    if (!this.planHistory) return [];
    const was = this.histories.get(doc.file);
    if (was?.markdown === doc.markdown && was.at === this.readTreeAt) {
      if (was.past) return was.past;
      throw new HistoryUnread();
    }
    const reading: { markdown: string; at: number; past?: Workstream[] } = { markdown: doc.markdown, at: this.readTreeAt };
    this.histories.set(doc.file, reading);
    this.planHistory(doc.file)
      .catch(() => [])
      .then((past) => {
        // the doc or the read tree moved on meanwhile: what the cards wait for is read anew
        if (this.histories.get(doc.file) !== reading) return;
        reading.past = past;
        this.board.docsChanged();
      });
    throw new HistoryUnread();
  }

  /**
   * Keeps each workstream card with its own workstream. A card whose workstream the doc gives
   * another key now (a sibling dropped or added, `workstreamAliases`) moves onto it. A card whose
   * workstream the doc no longer lists, while the doc is there, leaves the project once an agent
   * worked on it, with its log, as a card of its own (`leave`); one nobody worked on just goes from
   * view. It remembers what the workstream was right away, and leaves only once it holds no
   * workspace it is not at work in, and, for a doc in a plan folder outside the repository, which
   * is written in place, once the workstream stayed away for `LEAVE_AFTER_MS`. With `read` (the docs
   * were read again), a project read before workstreams had keys of their own (`#n`, their place in
   * the doc) moves its cards onto those keys first (`rekey`). Between reads, only waiting cards
   * bring it here.
   */
  follow(all: PlanDoc[], read: boolean): PlanDoc[] {
    if (!read && !this.missing.size) return all;
    const byFile = new Map(all.map((d) => [d.file, d]));
    const projects = this.store.projects(this.canvasId).filter((p) => byFile.has(p.plan_ref!));
    // the doc as last read, with its whole text: only parsed where a card needs it
    const lastOf = new Map<string, PlanDoc | null>();
    const last = (p: CardRow) => (lastOf.has(p.id) ? lastOf.get(p.id)! : lastOf.set(p.id, fromJson(p.plan)).get(p.id)!);
    // a project whose repair waits for its doc's history keeps the doc as last read until it is there,
    // also for the passes between reads, whose docs are the ones this pass returns
    if (read) this.heldBack = new Set(projects.filter((p) => last(p) && !this.rekey(p, last(p)!, byFile.get(p.plan_ref!)!)).map((p) => p.plan_ref!));
    const kidsOf = Map.groupBy(this.store.children(projects.map((p) => p.id)), (k) => k.parent_id!);
    const waiting = new Set<string>();
    const now = Date.now();
    for (const p of projects) {
      if (this.heldBack.has(p.plan_ref!)) continue;
      const doc = byFile.get(p.plan_ref!)!;
      const kids = kidsOf.get(p.id) ?? [];
      const keys = new Set(doc.workstreams.map((w) => w.key));
      const holderOf = new Map(kids.flatMap((k) => (keys.has(keyOfRef(k.plan_ref) ?? '') ? [[keyOfRef(k.plan_ref)!, k] as const] : [])));
      for (const k of kids) {
        const key = keyOfRef(k.plan_ref);
        if (key === null || keys.has(key)) continue;
        // what the workstream was: in the doc as last read, else as the card remembered it
        const known = last(p)?.workstreams.find((x) => x.key === key);
        const w = sameWorkstream(key, doc, known ?? (k.title ? { title: k.title } : undefined));
        const holder = w && holderOf.get(w.key);
        // a card nobody worked on gives way to the one with the workstream's log
        if (w && (!holder || (!worked(holder) && worked(k)))) {
          if (holder) {
            this.store.replan(holder.id, `${p.plan_ref}#\u0000${holder.id}`, p.id);
            this.store.update(holder.id, { deleted_at: new Date().toISOString() });
          }
          this.store.replan(k.id, workstreamRef(doc.file, w.key), p.id);
          holderOf.set(w.key, k);
          this.missing.delete(k.id);
          continue;
        }
        if (!worked(k)) continue;
        if (known) this.remember(k, known);
        const since = this.missing.get(k.id) ?? now;
        // a stopped card gives its workspace back first, as a workstream no longer in the doc does (`leaseEnded`);
        // a doc written in place may lack an item only while it is being edited
        if ((k.workspace && !atWork(k)) || (outsideRef(doc.file) && now - since < LEAVE_AFTER_MS)) {
          waiting.add(k.id);
          this.missing.set(k.id, since);
          continue;
        }
        const was = unreadAs(() => this.identity(k, doc, last(p), false));
        // what the workstream was waits for the doc's history: the card waits with it
        if (!was) {
          waiting.add(k.id);
          this.missing.set(k.id, since);
          continue;
        }
        this.leave(k, p, was, this.board.t.idea.leftGone(doc.title));
      }
    }
    for (const id of this.missing.keys()) if (!waiting.has(id)) this.missing.delete(id);
    clearTimeout(this.waking);
    const next = Math.min(...[...this.missing.values()].map((t) => t + LEAVE_AFTER_MS - now).filter((ms) => ms > 0));
    if (Number.isFinite(next)) {
      this.waking = setTimeout(() => this.board.changed(), next + 50);
      this.waking.unref?.();
    }
    if (!read || !this.heldBack.size) return all;
    const kept = new Map(projects.flatMap((p) => (this.heldBack.has(p.plan_ref!) ? [[p.plan_ref!, last(p)!] as const] : [])));
    return all.map((d) => kept.get(d.file) ?? d);
  }

  /** The card keeps what its workstream was (`w`), for when it leaves the project after the doc is read again. */
  private remember(row: CardRow, w: Pick<Workstream, 'label' | 'title' | 'body'>) {
    const title = w.label ? `${w.label} ${w.title}` : w.title;
    if (row.title !== title || row.body !== w.body) this.store.update(row.id, { title, body: w.body });
  }

  /**
   * Moves the project's cards from the keys an older Obeya gave its workstreams (their place in
   * the doc, `#n`) onto the keys they have now. A card an agent worked on goes by the title its
   * branch was named after, since the doc may have changed under its old key, so that its log stays
   * with its own workstream; one whose workstream the doc no longer has leaves the project, and the
   * project lays out afresh in the doc's order, with fresh cards for the workstreams without one.
   * Otherwise the cards keep their places. Returns false, changing nothing, while what it needs of
   * the doc's history is still being read.
   */
  private rekey(project: CardRow, before: PlanDoc, doc: PlanDoc): boolean {
    const again = parsePlanDoc(before.file, before.markdown);
    if ('reason' in again || again.workstreams.length !== before.workstreams.length) return true;
    const renamed = new Map(before.workstreams.flatMap((w, i) => (w.key !== again.workstreams[i]!.key ? [[w.key, again.workstreams[i]!.key] as const] : [])));
    if (!renamed.size) return true;
    const kids = this.store.children([project.id]);
    const keys = new Set(doc.workstreams.map((w) => w.key));
    // positional keys of a doc read before this one, whose cards are out of view now
    const positional = (k: string) => renamed.has(k) || (/^#\d+$/.test(k) && !before.workstreams.some((w) => w.key === k));
    const moving = kids.filter((k) => positional(keyOfRef(k.plan_ref) ?? ''));
    if (!moving.length) return true;
    const claimed = new Set(kids.filter((k) => !moving.includes(k)).flatMap((k) => keyOfRef(k.plan_ref) ?? []));
    const to = new Map<string, string>();
    const leaving: CardRow[] = [];
    const started = new Map(moving.map((k) => [k.id, this.startedAs(k)]));
    // first the cards an agent worked on, the most recent first, by the workstream they were started on
    const order = [...moving].sort((a, b) => Number(!started.get(a.id)) - Number(!started.get(b.id)) || b.updated_at.localeCompare(a.updated_at));
    // what the cards worked on, decided before anything changes: the doc's history may still be read
    const was = unreadAs(() => {
      for (const k of order) {
        const slug = started.get(k.id);
        const key = slug ? this.startedOn(slug, doc, claimed, again) : renamed.get(keyOfRef(k.plan_ref)!);
        if (key && keys.has(key) && !claimed.has(key)) {
          to.set(k.id, key);
          claimed.add(key);
        } else if (worked(k)) leaving.push(k);
      }
      return new Map(leaving.map((k) => [k.id, this.identity(k, doc, before, true)]));
    });
    if (!was) return false;
    const ref = (key: string) => workstreamRef(doc.file, key);
    this.store.db.transaction(() => {
      // out of each other's way first: two cards may swap keys
      for (const k of moving) this.store.replan(k.id, `${project.plan_ref}#\u0000${k.id}`, project.id);
      for (const k of moving) {
        const key = to.get(k.id);
        if (key) this.store.replan(k.id, ref(key), project.id);
        // nobody worked on it: it goes, and the workstream gets a card of its own; its reference stays
        // one of no card, so that nothing reads it as a card of the owner's they deleted
        else if (!leaving.includes(k)) this.store.update(k.id, { deleted_at: new Date().toISOString() });
      }
      for (const k of leaving) {
        const w = was.get(k.id)!;
        if ((atWork(k) || !k.workspace) && !outsideRef(doc.file)) this.leave(k, project, w, this.board.t.idea.leftOther(doc.title));
        // a stopped card gives its workspace back first, and a doc outside the repository may lack an item
        // only for a moment: it leaves later (`follow`), with what it remembers
        else {
          this.store.replan(k.id, `${project.plan_ref}#~${k.id.slice(0, 6)}`, project.id);
          this.remember(k, w);
        }
      }
      // cards left, others get fresh ones: the project lays out afresh in the doc's order, which the mix-up had broken anyway
      if (leaving.length) {
        const rows = new Map(this.store.children([project.id]).flatMap((k) => (keyOfRef(k.plan_ref) ? [[keyOfRef(k.plan_ref)!, k] as const] : [])));
        const at = placeWorkstreams(doc.workstreams.map((w) => ({ done: w.done || finished(rows.get(w.key)?.state ?? 'planned') })));
        doc.workstreams.forEach((w, i) => {
          const row = rows.get(w.key);
          if (row) this.store.update(row.id, at[i]!);
          else this.store.insert([{ canvas_id: this.canvasId, kind: 'task', parent_id: project.id, plan_ref: ref(w.key), ...at[i]! }]);
        });
      }
      // what the Coordinator read of which workstream builds on which goes with the cards
      const deps = fromJson(project.deps);
      if (deps?.on) {
        const keyOf = new Map(moving.flatMap((k) => (to.has(k.id) ? [[keyOfRef(k.plan_ref)!, to.get(k.id)!] as const] : [])));
        const on = Object.fromEntries(
          Object.entries(deps.on).flatMap(([k, by]) => {
            const key = keyOf.get(k) ?? (positional(k) ? undefined : k);
            return key ? [[key, by.flatMap((b) => keyOf.get(b) ?? (positional(b) ? [] : [b]))]] : [];
          }),
        );
        this.store.update(project.id, { deps: toJson({ ...deps, on }) });
      }
    })();
    return true;
  }

  /**
   * The key of the doc's workstream an agent started on under the title its branch was named after
   * (`slug`), among those no card has yet (`claimed`): by that title, or, where the doc reworded it
   * since, by the label the doc as Obeya last kept it (`stored`, read anew) or the doc's history gave
   * that title.
   */
  private startedOn(slug: string, doc: PlanDoc, claimed: Set<string>, stored: PlanDoc): string | undefined {
    const free = doc.workstreams.filter((w) => !claimed.has(w.key));
    const byTitle = free.find((w) => named(w, slug));
    if (byTitle) return byTitle.key;
    const label =
      stored.workstreams.find((w) => w.label && named(w, slug))?.label ??
      this.past(doc).find((w) => w.label && named(w, slug))?.label;
    const same = label ? free.filter((w) => w.label === label) : [];
    return same.length === 1 && doc.workstreams.filter((w) => w.label === label).length === 1 ? same[0]!.key : undefined;
  }

  /** The title of the card the agent last started on, as its branch has it (`branchName`); none for a card never started. */
  private startedAs(row: CardRow): string | null {
    const short = row.id.slice(0, 6);
    const at = new RegExp(`${CARD_BRANCH}([a-z0-9-]+)-${short}`);
    const slug = at.exec(row.branch ?? '')?.[1] ?? at.exec(this.store.branchMention(row.id) ?? '')?.[1] ?? null;
    // a title without a Latin letter or digit names its branch `card`, which tells no workstream apart
    return slug === 'card' ? null : slug;
  }

  /**
   * The workstream a card worked on, from the doc as last read (`before`), what the card remembered
   * of it (`remember`) or the history of the doc (`doc`, as it reads now): by its key, or, for a
   * card whose key was its place in the doc (`positional`), by the title its branch was named after.
   */
  private identity(row: CardRow, doc: PlanDoc, before: PlanDoc | null, positional: boolean): Pick<Workstream, 'label' | 'title' | 'body'> {
    const key = keyOfRef(row.plan_ref) ?? '';
    const slug = this.startedAs(row);
    const past = () => this.past(doc);
    // what the card remembered when its workstream left the doc (`remember`)
    const kept = () => (!positional && row.title ? { title: row.title, body: row.body ?? '' } : undefined);
    const byKey = () => (positional ? undefined : (before?.workstreams.find((w) => w.key === key) ?? kept() ?? past().find((w) => w.key === key)));
    const bySlug = () => (slug ? (before?.workstreams.find((w) => named(w, slug)) ?? past().find((w) => named(w, slug))) : undefined);
    const byPlace = () => (positional && !slug ? before?.workstreams.find((w) => w.key === key) : undefined);
    return byKey() ?? bySlug() ?? byPlace() ?? { title: slug ? slug.replace(/-/g, ' ') : key, body: '' };
  }

  /**
   * The card leaves its project as a card of its own, its log saying so (`why`), with the title and
   * text of the workstream it worked on (`w`). Finished, it goes into the archive; otherwise it
   * stands beside the project.
   */
  private leave(row: CardRow, project: CardRow, w: Pick<Workstream, 'label' | 'title' | 'body'>, why: string) {
    // a workstream planned again after part of it landed is done now that the doc asks no more of it
    const state = row.state === 'planned' && row.shipped ? 'live' : stateOf(row);
    const done = finished(state) && !atWork(row);
    const at = done ? { x: row.x, y: row.y } : this.besideProject(project);
    this.store.replan(row.id, null, null);
    this.store.update(row.id, {
      title: w.label ? `${w.label} ${w.title}` : w.title,
      body: w.body,
      state,
      repo: repoOfRef(project.plan_ref!, this.board.home),
      group_id: project.group_id,
      ...at,
      ...(done ? { archived_at: new Date().toISOString() } : {}),
    });
    this.board.log(row.id, 'state', 'obeya', why);
  }

  /** A free spot for a card at the right of the project, near its top. */
  private besideProject(project: CardRow): { x: number; y: number } {
    const items = toItems(this.store.cards(this.canvasId), this.docs(), this.board.home);
    const p = items.find((i) => i.id === project.id);
    if (!p) return { x: project.x, y: project.y };
    const box = boundsOf(p, items);
    return freeSpotNear({ x: box.x + box.w + GAP, y: box.y }, CARD_SIZE.task, items.filter((i) => !i.parent).map((i) => boundsOf(i, items)));
  }
}
