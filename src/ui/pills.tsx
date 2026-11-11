// The top bar's pills: a pending restart, an update of Obeya, of its source or of Bun, and the workspaces.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AppUpdate, CanvasInfo, BlockedClone, ClonePool, Item, PendingRestart, PoolHost, SourceUpdate } from '../core/types';
import { api } from './api';
import { Doc, Inline, plain } from './markdown';
import { clock, shortDay, t } from './strings';
import { useMenuClose } from './menu';

/** A restart that waits for workers or the owner: for whom and until when (on hover), and a button that has it go ahead now. */
export function RestartPill({ restart, items }: { restart: PendingRestart; items: Item[] }) {
  if (restart.repos) return <ReposRestartPill restart={restart} items={items} />;
  const n = restart.cards.length + restart.elsewhere.reduce((m, c) => m + c.cards.length, 0);
  const until = clock(restart.deadline);
  const owner = restart.owner;
  const stop = restart.reason === 'stop';
  const update = restart.reason === 'update';
  return (
    <Pill
      restart={restart}
      items={items}
      elsewhere={restart.elsewhere}
      go={api.restartNow}
      going={stop ? t.restart.goingStop : update ? t.restart.goingUpdate : t.restart.going}
      say={t.restart.pill(n, owner, restart.reason)}
      // the deadline does not cut the owner off
      until={!owner.length}
      now={stop ? t.restart.nowStop : update ? t.restart.nowUpdate : t.restart.now}
      risk={stop ? t.restart.nowRiskStop : n ? t.restart.nowRisk : t.restart.nowOwner}
      why={
        <>
          <p>{t.restart.reason[restart.reason]}</p>
          {owner.map((h) => (
            <p key={h}>{t.restart.owner[h]}</p>
          ))}
        </>
      }
      after={
        <>
          {(stop || update) && <p className="hint">{stop ? t.restart.keptStop : t.restart.keptUpdate}</p>}
          {n > 0 && <p className="hint">{stop ? t.restart.deadlineStop(until) : owner.length ? t.restart.deadlineOwner(until) : update ? t.restart.deadlineUpdate(until) : t.restart.deadline(until)}</p>}
        </>
      }
    />
  );
}

/** A restart of some repositories' agents alone, for a change to their configuration, that waits for them; Obeya runs on. */
function ReposRestartPill({ restart, items }: { restart: PendingRestart; items: Item[] }) {
  const r = t.restart.repos;
  return (
    <Pill
      restart={restart}
      items={items}
      go={api.restartReposNow}
      going={r.going}
      say={r.pill(restart.cards.length)}
      until
      now={r.now}
      risk={r.nowRisk}
      why={<p>{restart.leaving ? r.leaving : r.reason((restart.repos ?? []).join(', '), restart.reason === 'repository')}</p>}
      after={
        <>
          {!restart.leaving && <p className="hint">{r.kept}</p>}
          <p className="hint">{r.deadline(clock(restart.deadline))}</p>
        </>
      }
    />
  );
}

/**
 * The pill of either restart: what it waits for (`say`), with `until` until when, and a button
 * (`now`, its risk on hover) that has it go ahead through `go`, saying `going` once it does. On
 * hover why (`why`), the cards it waits for here and on the other canvases (`elsewhere`), and
 * what follows (`after`).
 */
function Pill({ restart, items, elsewhere = [], go, going, say, until, now, risk, why, after }: {
  restart: PendingRestart;
  items: Item[];
  elsewhere?: PendingRestart['elsewhere'];
  go: () => Promise<{ restarting: boolean }>;
  going: string;
  say: string;
  until: boolean;
  now: string;
  risk: string;
  why: ReactNode;
  after: ReactNode;
}) {
  const [on, setOn] = useState(false);
  const titles = restart.cards.map((id) => plain(items.find((i) => i.id === id)?.title ?? id));
  const click = () => {
    setOn(true);
    go().then(
      (r) => r.restarting || setOn(false),
      () => setOn(false),
    );
  };
  if (on)
    return (
      <div className="pill restart going" id="restart">
        <span className="spin">↻</span> {going}
      </div>
    );
  return (
    <div className="pill restart" id="restart">
      <span className="spin">↻</span>
      <span className="say">{say}</span>
      {until && <span className="hint">{t.restart.until(clock(restart.deadline))}</span>}
      <button onClick={click}>
        {now}
        <span className="tip risk" role="tooltip">
          {risk}
        </span>
      </button>
      <div className="tip why" role="tooltip">
        {why}
        {titles.length + elsewhere.length > 0 && (
          <>
            <p>{t.restart.waits}</p>
            {titles.length > 0 && (
              <ul>
                {titles.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            {elsewhere.map((c) => (
              <div key={c.canvas} className="elsewhere">
                <p className="hint">{t.restart.on(c.canvas)}</p>
                <ul>
                  {c.cards.map((x, i) => (
                    <li key={i}>{plain(x)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
        {after}
      </div>
    </div>
  );
}

/**
 * A newer version of the app, downloaded by its shell: what changed (on hover), and a button that
 * installs it once the workers paused, as a restart waits for them (then RestartPill shows the wait).
 * A .deb cannot be replaced by the app: the button opens the release to download it.
 */
export function UpdatePill({ update }: { update: AppUpdate }) {
  const [asked, setAsked] = useState(false);
  const install = () => {
    setAsked(true);
    api.installUpdate().catch(() => setAsked(false));
  };
  return (
    <div className="pill restart update" id="update">
      <span>{t.update.pill(update.version)}</span>
      {update.download ? (
        <button onClick={() => window.open(update.download, '_blank')}>{t.download}</button>
      ) : (
        <button onClick={install} disabled={asked}>
          {t.update.install}
        </button>
      )}
      <div className="tip why" role="tooltip">
        <p>
          <b>{t.update.title(update.version, update.date ? shortDay(update.date) : null)}</b>
        </p>
        {update.notes && <Doc md={update.notes} />}
        <p className="hint">{update.download ? t.update.howDownload : t.update.how}</p>
      </div>
    </div>
  );
}

/**
 * New commits on the upstream of the checkout Obeya runs from (Obeya from source): which (on
 * hover), and a button that pulls them as a fast-forward, after which Obeya restarts with the new
 * code once the workers paused (then RestartPill shows the wait). Where Obeya cannot fast-forward,
 * there is no button, and the hover says what stands in the way.
 */
export function SourcePill({ source }: { source: SourceUpdate }) {
  const [asked, setAsked] = useState(false);
  // a pull that failed comes back with git's message: the button is there again
  useEffect(() => setAsked(false), [source]);
  const pull = () => {
    setAsked(true);
    api.pullSource().catch(() => setAsked(false));
  };
  const more = source.count - source.commits.length;
  const how = !source.blocked
    ? t.source.how(source.checkout)
    : source.blocked.why === 'diverged'
      ? t.source.diverged(source.checkout, source.upstream)
      : t.source.local(source.checkout, source.blocked.files.map((f) => `\`${f}\``).join(', '));
  return (
    <div className={source.blocked ? 'pill restart update source by-hand' : 'pill restart update source'} id="source-update">
      <span>{t.source.pill(source.count)}</span>
      {!source.blocked && (
        <button onClick={pull} disabled={asked}>
          {t.source.pull}
        </button>
      )}
      <div className="tip why" role="tooltip">
        <p>
          <b>{t.source.title(source.count, source.upstream)}</b>
        </p>
        <ul>
          {source.commits.map((c, i) => (
            <li key={i}>
              {c.subject} <span className="hint">{shortDay(c.date)}</span>
            </li>
          ))}
        </ul>
        {more > 0 && <p className="hint">{t.source.more(more)}</p>}
        {source.error && <p className="warn">{t.source.failed(source.error)}</p>}
        <p className="hint">
          <Inline md={how} />
        </p>
      </div>
    </div>
  );
}

/**
 * The Bun the server runs on is too old (on Linux, before 1.3.14): it can deadlock, and then the
 * canvas stops loading. It stays in the bar for as long as the server runs on it; what to do, on hover.
 */
export function OldBunPill({ version }: { version: string }) {
  return (
    <div className="pill restart old-bun" id="old-bun">
      <span className="warn">⚠</span>
      <span className="say">{t.oldBun.pill(version)}</span>
      <div className="tip why" role="tooltip">
        <p>
          <b>{t.oldBun.title}</b>
        </p>
        <p>{t.oldBun.why(version)}</p>
        <p>
          <Inline md={t.oldBun.how} />
        </p>
      </div>
    </div>
  );
}

/**
 * Each repository's pool by machine: a dot per clone (solid while its card's worker is at work,
 * pale while the card holds it otherwise, orange while free but blocked), or per slot of a
 * repository in worktrees, and how many new cards could start now. A click (a tap) drops down each machine's slots and each of its workspaces by path with the card in it, which opens
 * the card (`onOpen`; `onElsewhere` one on another canvas), and why a blocked clone goes to no card
 * and what to do about it. While every clone is taken and a card waits for one, a faint "⋯" beside
 * a card opens what gives its clone to the one waiting longest (`onTake`); during the undo window
 * the row offers "Undo" (`onKeep`). A clone blocked by uncommitted changes names the card they come
 * from and offers "Save "Commit to a new branch and free the clone" (`onLeftovers`).
 */
export function WorkspacesPill({ pools, canvas, canvases, items, onOpen, onElsewhere, onTake, onKeep, onLeftovers }: {
  pools: ClonePool[];
  canvas: CanvasInfo;
  canvases: CanvasInfo[];
  items: Item[];
  onOpen: (i: Item) => void;
  onElsewhere: (canvas: string, card: string) => void;
  onTake: (i: Item) => void;
  onKeep: (i: Item) => void;
  onLeftovers: (repo: string, host: string, path: string) => void;
}) {
  // open by a click (a tap) until one elsewhere, Escape or a card opened from it
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMenuClose(open, ref, () => setOpen(false), true);
  const several = pools.length > 1;
  const name = (repo: string) => canvas.repos.find((r) => r.id === repo)?.name ?? repo;
  const forWorkspace = items.filter((i) => (i.queue && 'workspace' in i.queue && i.queue.workspace !== 'slots') || i.waitsForClone).length;
  const forSlot = items.filter((i) => i.queue && 'workspace' in i.queue && i.queue.workspace === 'slots').length;
  // a clone is taken from its card only while none is free and a card of its repository waits for one
  const wanted = (p: ClonePool) =>
    p.hosts.every((h) => h.cards.length + blocked(h) >= h.total) && items.some((i) => i.repo === p.repo && ((i.queue && 'workspace' in i.queue) || i.waitsForClone));
  const blocked = (h: PoolHost) => h.blocked?.length ?? 0;
  // a new card takes a free clone that is not blocked, on a machine whose busy workers leave it a slot
  const room = (h: PoolHost) => Math.max(0, Math.min(h.slots - h.busy.length, h.total - h.cards.length - blocked(h)));
  const free = (p: ClonePool) => p.hosts.reduce((n, h) => n + room(h), 0);
  const total = (p: ClonePool) => p.hosts.reduce((n, h) => n + h.total, 0);
  const blockedIn = (p: ClonePool) => p.hosts.reduce((n, h) => n + blocked(h), 0);
  const full = pools.every((p) => free(p) === 0);
  // the machines a pool names: those with clones or a clone's folder kept, and every other machine than this one
  const named = (p: ClonePool) => p.hosts.filter((h) => h.total > 0 || !h.here || h.kept?.length);
  const opened = (go: () => void) => {
    setOpen(false);
    go();
  };
  return (
    <div
      ref={ref}
      className={['pill workspaces', full && 'full', open && 'open'].filter(Boolean).join(' ')}
      id="workspaces"
    >
      <button className="face" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="lbl">{t.workspaces.label}</span>
        {pools.map((p) => {
          const hosts = named(p);
          return (
            <span key={p.repo} className="pool">
              {several && <span className="hint">{name(p.repo)}</span>}
              {hosts.map((h) => (
                <span key={h.name} className="host">
                  {hosts.length > 1 && <span className="hint">{h.name}</span>}
                  <span className="slots" aria-hidden>
                    {Array.from({ length: h.total }, (_, i) => (
                      <i key={i} className={i < h.busy.length ? 'on' : i < h.cards.length ? 'held' : i < h.cards.length + blocked(h) ? 'blocked' : undefined} />
                    ))}
                  </span>
                </span>
              ))}
              <b>{t.workspaces.free(free(p), total(p), blockedIn(p))}</b>
              {blockedIn(p) > 0 && <b className="warn">{t.workspaces.blockedCount(blockedIn(p))}</b>}
            </span>
          );
        })}
      </button>
      <div className="tip" role="dialog" aria-label={t.workspaces.label}>
        {pools.map((p) => (
          <div key={p.repo}>
            {several && (
              <p>
                <b>{name(p.repo)}</b>
              </p>
            )}
            {named(p).map((h) => (
              <div key={h.name}>
                <p>
                  {h.worktrees
                    ? t.workspaces.worktreeSlots(h.name, h.busy.length, h.slots, h.workspaces.length > 0)
                    : t.workspaces.host(h.name, h.busy.length, h.slots, h.cards.length, h.total)}
                </p>
                {h.workspaces.length > 0 && (
                  <WorkspaceRows
                    host={h}
                    items={items}
                    canvases={canvases}
                    onOpen={(i) => opened(() => onOpen(i))}
                    onElsewhere={(c, card) => opened(() => onElsewhere(c, card))}
                    onTake={wanted(p) ? onTake : undefined}
                    onKeep={onKeep}
                  />
                )}
                {h.kept?.map((k) => (
                  <p key={k.path} className="hint">
                    {t.workspaces.kept(k.path, k.lost.map(t.workspaces.lost))}
                  </p>
                ))}
                <BlockedClones
                  host={h}
                  items={items}
                  canvases={canvases}
                  onOpen={(i) => opened(() => onOpen(i))}
                  onElsewhere={(c, card) => opened(() => onElsewhere(c, card))}
                  onLeftovers={(path) => onLeftovers(p.repo, h.name, path)}
                />
              </div>
            ))}
          </div>
        ))}
        {forWorkspace > 0 && <p>{t.workspaces.waiting(forWorkspace)}</p>}
        {forSlot > 0 && <p>{t.workspaces.waitingSlot(forSlot)}</p>}
      </div>
    </div>
  );
}

/**
 * A machine's workspaces, one per line: the dot the pill shows for it, its path (cut at the front
 * where it is too long, so its end stays), and the card in it, which opens on a click; or that it
 * is free, or blocked. With `onTake` (a card waits, none is free), a faint "⋯" beside each card
 * that may give its clone up, which opens the one action and what it does; a card giving it up has
 * "Undo" (`onKeep`) instead.
 */
function WorkspaceRows({ host, items, canvases, onOpen, onElsewhere, onTake, onKeep }: {
  host: PoolHost;
  items: Item[];
  canvases: CanvasInfo[];
  onOpen: (i: Item) => void;
  onElsewhere: (canvas: string, card: string) => void;
  onTake?: (i: Item) => void;
  onKeep: (i: Item) => void;
}) {
  const blocked = new Set(host.blocked?.map((b) => b.path));
  // the row whose "⋯" is open
  const [more, setMore] = useState<string | null>(null);
  return (
    <ul className="ws-list">
      {host.workspaces.map((w) => {
        const item = w.card && !w.canvas ? items.find((i) => i.id === w.card) : undefined;
        const busy = !!w.card && host.busy.includes(w.card);
        const state = busy ? 'on' : w.card ? 'held' : blocked.has(w.path) ? 'blocked' : 'free';
        const there = w.canvas && canvases.find((c) => c.id === w.canvas);
        return (
          <li key={w.path} className={state}>
            <i aria-hidden />
            <span className="ws-path" title={w.path}>
              {/* the mark keeps the path's leading slash at its start in the right-to-left box that cuts it at the front */}
              {'\u200e' + w.path}
            </span>
            <span className="ws-card">
              {item ? (
                <a className="from" onClick={() => onOpen(item)}>
                  {plain(item.title)}
                </a>
              ) : w.card && there ? (
                <>
                  <a className="from" onClick={() => onElsewhere(there.id, w.card!)}>
                    {plain(w.title ?? '')}
                  </a>
                  <span className="hint"> · {t.workspaces.onCanvas(there.name)}</span>
                </>
              ) : w.card ? (
                <span className="hint">{w.title ? t.workspaces.notOnCanvas(plain(w.title)) : t.workspaces.offCanvas}</span>
              ) : (
                <span className={state === 'blocked' ? 'warn' : 'hint'}>{state === 'blocked' ? t.workspaces.blockedRow : t.workspaces.freeRow}</span>
              )}
              {busy && !w.leaving && <span className="hint"> · {t.workspaces.atWork}</span>}
              {item && w.leaving && (
                <>
                  <span className="hint"> · {t.workspaces.leaving}</span>
                  <button className="btn ws-take" onClick={() => onKeep(item)}>
                    {t.undo}
                  </button>
                </>
              )}
              {item && w.takeable && onTake && (
                <button className="ws-more" title={t.workspaces.more} aria-label={t.workspaces.more} aria-expanded={more === w.path} onClick={() => setMore(more === w.path ? null : w.path)}>
                  ⋯
                </button>
              )}
            </span>
            {item && w.takeable && onTake && more === w.path && (
              <div className="ws-menu">
                <button
                  className="btn ws-take"
                  onClick={() => {
                    setMore(null);
                    onTake(item);
                  }}
                >
                  {t.workspaces.take}
                </button>
                <span className="hint">{t.workspaces.takeWhat}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Why each of a machine's blocked clones goes to no card, and what the owner can do: a line per
 * clone, one for all of an unreachable machine's. One blocked by uncommitted changes names the card
 * whose branch it is on (a link, as in the rows) and whether its work has landed, and offers "Save
 * "Commit to a new branch and free the clone" (`onLeftovers`).
 */
function BlockedClones({ host, items, canvases, onOpen, onElsewhere, onLeftovers }: {
  host: PoolHost;
  items: Item[];
  canvases: CanvasInfo[];
  onOpen: (i: Item) => void;
  onElsewhere: (canvas: string, card: string) => void;
  onLeftovers: (path: string) => void;
}) {
  const all = host.blocked ?? [];
  const away = all.filter((b) => b.why === 'unreachable').map((b) => b.path);
  const by = (b: BlockedClone) => {
    if (!b.by) return null;
    const item = b.by.canvas ? undefined : items.find((i) => i.id === b.by!.card);
    const there = b.by.canvas && canvases.find((c) => c.id === b.by!.canvas);
    const title = plain(item?.title ?? b.by.title);
    return (
      <>
        {' '}
        {t.workspaces.blocked.leftBy}
        {item ? <a className="from" onClick={() => onOpen(item)}>{title}</a> : there ? <a className="from" onClick={() => onElsewhere(there.id, b.by!.card)}>{title}</a> : t.quote(title)}
        {t.workspaces.blocked.leftWork(b.by.work)}
      </>
    );
  };
  const line = (b: BlockedClone) => {
    const tb = t.workspaces.blocked;
    switch (b.why) {
      case 'dirty':
        return (
          <>
            {tb.dirty(b.path, b.files ?? [], b.more ?? 0)}
            {by(b)}
            <span className="ws-leftovers">
              <button className="btn ws-take" onClick={() => onLeftovers(b.path)}>
                {t.workspaces.keepLeftovers}
              </button>
              <span className="hint">{t.workspaces.keepLeftoversWhat(!!b.made)}</span>
            </span>
          </>
        );
      case 'broken':
        return tb.broken(b.path, b.error ?? '', !!b.made);
      case 'missing':
        return tb.missing(b.path, !!b.made);
      case 'failed':
        return tb.failed(b.path, b.error ?? '');
      case 'unreachable':
        return tb.unreachable(host.name, away);
    }
  };
  return (
    <>
      {all
        .filter((b, i) => b.why !== 'unreachable' || all.findIndex((x) => x.why === 'unreachable') === i)
        .map((b) => (
          <p key={b.path} className="warn">
            {line(b)}
          </p>
        ))}
    </>
  );
}
