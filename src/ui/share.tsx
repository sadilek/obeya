// Sharing a card's demo with colleagues: on a page of the repository's demo site, or as a file.

import { useEffect, useRef, useState } from 'react';
import { type CardAction, type Demo, type EarlierDemo, EXPORT_HTML_MAX, type Item, type PageTags, type RepoRef, withSupplemented } from '../core/types';
import { api } from './api';
import { useCopy } from './copy';
import { useMenuClose } from './menu';
import { dimensions, shownTags } from '../core/page-tags';
import { ACK_MS } from './tell';
import { t } from './strings';
import { PageChangeList } from './page-changes';
import type { Act, Run } from './cardSheet';

/**
 * Sharing the demo shown (`demo`, the latest or an earlier one): on a page where the card's
 * repository has a share target, else as a file to pass on.
 */
export function DemoShare({ item, demo, repo, act, run, onDemoSites }: { item: Item; demo: Demo; repo: RepoRef | undefined; act: Act; run: Run; onDemoSites?: (() => void) | undefined }) {
  if (!repo?.share && !item.share)
    return <ExportBox item={item} demo={demo} run={run} needs={repo?.shareNeeds} personal={repo?.sharePersonal} repoPath={repo?.path} onDemoSites={onDemoSites} />;
  return (
    <ShareBox
      item={item}
      demo={demo}
      act={act}
      onApproval={!!repo?.shareOnApproval}
      // on the personal site, the tick that is not there yet turns sharing with the approval on for the whole repository
      approveAll={
        repo?.shareOnPersonal && !repo.shareOnApproval
          ? () =>
              run(async () => {
                await api.shareApprovedRepo(repo.path, true);
                if (item.notOnApproval) await api.act(item.id, { action: 'shareOnApproval', on: true });
              }, { close: false })
          : undefined
      }
      vocabulary={repo?.shareTags}
      unlisted={item.share ? !!item.share.unlisted : !!repo?.shareUnlisted}
    />
  );
}

/**
 * Sharing the demo shown with colleagues: "Share" publishes it right away, then the page's link with
 * "Stop sharing" for this demo. A demo not on the page yet goes onto it beside the versions
 * there ("Add to the page"; an earlier demo in its place by handover) or, the latest, in their place
 * ("Replace on the page"), the worker's word on it first; "Share again" once the site writes pages
 * differently than when it published this one. Where the site publishes on approval (`onApproval`),
 * the latest demo not on the page has "Share on approval" until the card is approved, and
 * "Share" reads "Share now": the owner may share it before approving, or not on approving.
 */
function ShareBox({ item, demo, act, onApproval, approveAll, vocabulary, unlisted }: { item: Item; demo: Demo; act: Act; onApproval: boolean; approveAll?: (() => Promise<void>) | undefined; vocabulary?: PageTags | undefined; unlisted: boolean }) {
  const [copied, copy] = useCopy(2000);
  const s = item.share;
  const all = [...(item.demos ?? []), ...(item.demo ? [item.demo] : [])];
  const latest = demo === item.demo;
  const which = demo.handover !== undefined ? { demo: demo.handover } : {};
  const go = (a: CardAction) => act(a, { close: false });
  const busy = s?.state === 'publishing' || s?.state === 'withdrawing';
  // the versions on the page, by their numbers in the line above
  const numbers = all.flatMap((d, i) => (d.handover !== undefined && s?.on?.includes(d.handover) ? [i + 1] : []));
  const onPage = numbers.length ? t.share.demos(numbers) : null;
  // the earlier demos this one supplements go on a new page with it
  const mine = all.indexOf(demo);
  const along = mine < 0 ? [] : withSupplemented(all, mine).slice(0, -1).map((d) => all.indexOf(d) + 1);
  // a latest demo from before handovers were kept is on the page unless the page shows an earlier one
  const here = !!s?.url && (demo.handover !== undefined ? !!s.on?.includes(demo.handover) : latest && !s.stale);
  // approving would put this demo on the page: the owner may opt out, or share it now; where it would not, the owner may have it do so for the repository
  const before = latest && !here && !busy && !item.landing && (item.state === 'working' || item.state === 'waiting');
  const later = onApproval && before;
  const approval = (later || (before && approveAll)) && (
    <label className="share-check" title={later ? t.share.onApprovalHint : t.share.onApprovalRepoHint}>
      <input type="checkbox" checked={later && !item.notOnApproval} onChange={(e) => (later ? go({ action: 'shareOnApproval', on: e.target.checked }) : void approveAll?.())} />
      {item.contribution ? t.review.onApproval : t.share.onApproval}
    </label>
  );
  const replace = (first: boolean) => (
    <button key="replace" className={first ? 'btn primary' : 'btn'} title={t.share.replaceHint} onClick={() => go({ action: 'share', ...which })}>
      {t.share.replace}
    </button>
  );
  const add = (first: boolean) => (
    <button key="add" className={first ? 'btn primary' : 'btn'} title={latest ? t.share.addHint : t.share.addEarlierHint} onClick={() => go({ action: 'share', ...which, add: true })}>
      {latest ? t.share.add : t.share.share}
    </button>
  );
  const link = (
    <>
      <span className="share-label">{t.share.shared}</span>
      <a className="share-link" href={s?.url} target="_blank" rel="noreferrer" title={t.share.open}>
        {s?.url?.replace(/^https?:\/\//, '')}
      </a>
      <button className="btn" onClick={() => copy(s!.url!)}>
        {copied ? t.share.copied : t.share.copy}
      </button>
    </>
  );
  return (
    // the button and what is under way stay on the right, where the button was; the link takes the line
    <div className={s?.url && !busy ? 'share wide' : 'share'}>
      {busy ? (
        <span className="share-busy">{s.state === 'publishing' ? t.share.publishing : t.share.withdrawing}</span>
      ) : !s?.url ? (
        <div className="share-row">
          {along.length > 0 && <p className="hint">{t.share.along(t.share.demos(along))}</p>}
          {approval}
          <button className="btn share-go" title={later ? t.share.shareNowHint : unlisted ? t.share.shareHintUnlisted : demo.kind === 'html' ? t.share.shareHintHtml : t.share.shareHint} onClick={() => go({ action: 'share', ...which })}>
            <ShareIcon />
            {later ? t.share.shareNow : t.share.share}
          </button>
        </div>
      ) : here ? (
        <>
          <div className="share-row">
            {link}
            <button className="btn" title={numbers.length > 1 ? t.share.stopOneHint : t.share.stopHint} onClick={() => go({ action: 'unshare', ...which })}>
              {t.share.stop}
            </button>
          </div>
          {all.length > 1 && onPage && <p className="hint">{t.share.onPage(onPage)}</p>}
          {s.unlisted && <p className="hint">{t.share.unlisted}</p>}
          {s.outdated && (
            <div className="share-row">
              <p className="hint">{t.share.outdated}</p>
              <PageChangeList changes={s.outdated.map((id) => ({ id }))} />
              <button className="btn" title={t.share.reshareHint} onClick={() => go({ action: 'share', ...which })}>
                {t.share.reshare}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="share-row">{link}</div>
          <div className="share-row">
            <p className="hint">
              {t.share.pageShows(onPage)}
              {latest && demo.follows && all.length > 1 && (
                <>
                  <br />
                  <span className="agent-says">{t.share.agentSays(demo.follows, all.length - 1)}</span>
                </>
              )}
            </p>
            {/* the worker's word comes first; without it "Replace on the page", as the latest demo always went out before */}
            {!latest ? add(false) : demo.follows === 'supplements' ? [add(true), replace(false)] : [replace(true), add(false)]}
          </div>
          {approval && <div className="share-row">{approval}</div>}
        </>
      )}
      {vocabulary && <ShareTags tags={item.tags} vocabulary={vocabulary} set={(dimension, values) => go({ action: 'pageTags', dimension, values })} />}
    </div>
  );
}

/** How long a tapped × asks "Remove" before it is an × again. */
const ARMED_MS = 4000;

/**
 * The page's tags as chips, before sharing and after: × takes one off, "+" offers the values of the
 * site's vocabulary the page lacks. A change takes effect at once (a shared page goes out again), and
 * stays: neither a later worker nor Obeya's reading session changes what the owner set. A tag taken
 * off stays in its place for a while, struck through, with "Undo". A tap on × first asks
 * "Remove": on a phone the card's layout may still move under the finger as it opens.
 */
function ShareTags({ tags, vocabulary, set }: { tags: PageTags | undefined; vocabulary: PageTags; set: (dimension: string, values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(open, box, () => setOpen(false), true);
  // the chip whose × was tapped, asking "Remove"; how the last press on an × came (touch asks first)
  const [armed, setArmed] = useState<string | null>(null);
  const touch = useRef(false);
  useEffect(() => {
    if (!armed) return;
    const off = (e: PointerEvent) => !(e.target as Element).closest?.('.tag-chip.armed') && setArmed(null);
    const timer = setTimeout(() => setArmed(null), ARMED_MS);
    document.addEventListener('pointerdown', off, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', off, true);
    };
  }, [armed]);
  // the tags taken off a moment ago, each with "Undo" until its time is up
  const [gone, setGone] = useState<{ key: string; d: string; v: string }[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const forget = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setGone((g) => g.filter((x) => x.key !== key));
  };
  // one taken off is off at once, before the server's answer
  const isGone = (d: string, v: string) => gone.some((g) => g.d === d && g.v === v);
  const on = new Map(shownTags(tags, vocabulary).map(([d, values]) => [d, values.filter((v) => !isGone(d, v))] as const));
  const rest = dimensions(vocabulary).flatMap(([d, values]) => {
    const left = values.filter((v) => !on.get(d)?.includes(v));
    return left.length ? [[d, left] as const] : [];
  });
  const remove = (d: string, v: string) => {
    const key = `${d}\n${v}`;
    setArmed(null);
    set(d, (on.get(d) ?? []).filter((x) => x !== v));
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => forget(key), ACK_MS));
    setGone((g) => [...g.filter((x) => x.key !== key), { key, d, v }]);
  };
  // the ones gone stand where they stood, among the others in the vocabulary's order
  const withGone = { ...tags };
  for (const g of gone) withGone[g.d] = [...(withGone[g.d] ?? []), g.v];
  const chips = shownTags(withGone, vocabulary);
  return (
    <div className="share-row share-tags" ref={box} title={t.share.tagsHint}>
      <span className="share-label">{t.share.tags}</span>
      {!chips.length && <span className="hint t">{t.share.noTags}</span>}
      {chips.flatMap(([d, values]) =>
        values.map((v) => {
          const key = `${d}\n${v}`;
          if (isGone(d, v))
            return (
              <span key={key} className="tag-chip gone">
                <span className="t">
                  <span className="dim">{d}:</span> {v}
                </span>
                <button
                  className="tag-undo"
                  title={t.share.restoreTag(d, v)}
                  onClick={() => {
                    forget(key);
                    set(d, [...(on.get(d) ?? []), v]);
                  }}
                >
                  {t.undo}
                </button>
              </span>
            );
          const sure = armed === key;
          return (
            <span key={key} className={sure ? 'tag-chip armed' : 'tag-chip'}>
              <span className="t">
                <span className="dim">{d}:</span> {v}
              </span>
              <button
                className={sure ? 'x sure' : 'x'}
                title={t.share.removeTag(d, v)}
                aria-label={t.share.removeTag(d, v)}
                onPointerDown={(e) => (touch.current = e.pointerType !== 'mouse')}
                onClick={() => {
                  // a mouse or a key takes it off at once; a finger first gets "Remove" to tap
                  if (sure || !touch.current) remove(d, v);
                  else setArmed(key);
                  touch.current = false;
                }}
              >
                {sure ? (
                  t.share.removeTagSure
                ) : (
                  <svg viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 2l6 6M8 2l-6 6" />
                  </svg>
                )}
              </button>
            </span>
          );
        }),
      )}
      {rest.length > 0 && (
        <span className="menu-pill">
          <button className={open ? 'tag-add on' : 'tag-add'} title={t.share.addTag} aria-label={t.share.addTag} aria-expanded={open} onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1.5v7M1.5 5h7" />
            </svg>
          </button>
          {open && (
            <div className="bar-menu tag-menu">
              {rest.map(([d, values]) => (
                <div key={d} className="tag-dim">
                  <span className="hint">{d}</span>
                  {values.map((v) => (
                    <button
                      key={v}
                      className="tag-chip pick"
                      onClick={() => {
                        setOpen(false);
                        forget(`${d}\n${v}`);
                        set(d, [...(on.get(d) ?? []), v]);
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

/** Sharing's mark on its button: a box with an arrow going out of it. */
export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12M7.5 7.5L12 3l4.5 4.5M5 11v9h14v-9" />
    </svg>
  );
}

/**
 * "Share" where the repository has no share target: the demo as a file to pass on, a ZIP of its
 * page with the video or the HTML artifact beside it, or one HTML file that holds everything
 * (short videos, artifacts that are their index.html alone). Where its site lacks its credentials
 * on this machine, a line under the buttons names the file.
 */
function ExportBox({
  item,
  demo,
  run,
  needs,
  personal,
  repoPath,
  onDemoSites,
}: {
  item: Item;
  demo: Demo;
  run: Run;
  needs?: { site: string; file: string } | undefined;
  /** Why the owner's personal demo site does not take the demo: none set up here, or the repository is private and not ticked. */
  personal?: 'none' | 'private' | undefined;
  repoPath?: string | undefined;
  /** Opens the configuration at the personal demo site. */
  onDemoSites?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'zip' | 'html' | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const artifact = demo.kind === 'html';
  // the demo shown: the latest, or an earlier one by its place among the card's earlier demos
  const n = demo === item.demo ? undefined : (demo as EarlierDemo).n;
  useEffect(() => {
    setSize(null);
    if (open && !artifact) api.demoSize(item.id, n).then(setSize, () => {});
  }, [open, item.id, artifact, n]);
  const tooLarge = size !== null && size > EXPORT_HTML_MAX;
  const notAlone = artifact && !demo.single;
  const go = (as: 'zip' | 'html') => {
    setBusy(as);
    void run(() => api.exportDemo(item.id, as, demo === item.demo ? undefined : demo.handover), { close: false }).finally(() => setBusy(null));
  };
  return (
    <div className={open ? 'share wide' : 'share'}>
      {!open ? (
        <button className="btn share-go" title={t.share.exportHint} onClick={() => setOpen(true)}>
          <ShareIcon />
          {t.share.share}
        </button>
      ) : (
        <>
          {!needs && personal !== 'private' && <p className="hint">{t.share.exportIntro}</p>}
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
          {busy && !demo.page && <p className="hint">{t.share.writingPage}</p>}
        </>
      )}
      {needs && <p className="hint">{t.share.needsEnv(needs.site, needs.file)}</p>}
      {open && personal === 'none' && onDemoSites && (
        <p className="hint">
          {t.share.noPersonal}{' '}
          <button className="link" onClick={onDemoSites}>
            {t.share.setUpPersonal}
          </button>
        </p>
      )}
      {open && personal === 'private' && repoPath && (
        <>
          <p className="hint">{t.share.privateRepo}</p>
          <label className="share-check">
            <input type="checkbox" checked={false} onChange={() => void run(() => api.allowPrivateRepo(repoPath, true).then(() => {}), { close: false })} />
            {t.share.allowPrivate}
          </label>
        </>
      )}
    </div>
  );
}
