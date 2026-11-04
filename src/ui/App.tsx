// The canvas: camera, drag, unfold-in-place and the plan sheet.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { type Bounds, boundsOf, CARD_SIZE, centre, onCanvas, type Place, PROJECT_HEAD, PROJECT_PAD, unionBounds } from '../core/layout';
import { type CanvasInfo, type CanvasSnapshot, type CardPatch, type ConfigProblem, finished, type Group, type Item, nameless, needsYou, openPerGroup, type PendingRestart, type PlanDir, EVICT_HOLD_MS, START_ALL_HOLD_MS, titleFrom, type AppUpdate, type SourceUpdate, unreadAnswers, unreadPerProject, type Usage, type Waiting, waitingIn } from '../core/types';
import { api, ApiError, beforeReload, type CanvasFeed, cardsOn, onNotice, quietAtStart, reportFocus, setCanvas, useCanvas } from './api';
import { goTo, onSwitch } from './switch';
import { GroupNames, growFrom, inside, Lasso, MarkHint, Marked, Ring, TerritoryLayer, useTerritories } from './groups';
import { besideSheet, BOTTOM, type Cam, camFor, centreOn, chase, dragLimit, edgeScroll, FAR, flying, flyTo, keepInView, MAX_ZOOM, midX, MIN_ZOOM, NO_SIDES, overviewCam, placeIn, shows, type Sides, stopFlight, TOP, toWorld } from './camera';
import { plain } from './markdown';
import { CardNumber } from './cardNumber';
import { clip } from '../core/text';
import { type ActDone, Detail, type Pending } from './detail';
import { Cards } from './message';
import type { Heard, Where } from './api';
import { replyOn, setReply } from './reply';
import { ArchivePill } from './archive';
import { useBarFit } from './barFit';
import { UsagePill } from './usage';
import { ConfigDialog, Problem, showCanvasesSection, showDemosSection, showDevicesSection, showRepoClones } from './config';
import { PhoneDialog } from './access';
import { Setup } from './setup';
import { Phone, phoneView } from './phone';
import { KoordinatorSheet } from './koordinator';
import { forcedText, QueuePill } from './queue';
import { SearchPill } from './search';
import { depsOf, handleAt, nearestHandle, type Side, SIDES, waitsAmong } from './deps';
import { collect, keep, type Kept, leaveSheet, restore, type SideSheet, takeKept, takeSheetLeft } from './keep';
import { Sign, Wordmark } from './logo';
import { DOUBLE_CLICK_KNOWN, Help, HelpButton, HELP_KEY_KNOWN, HowToHint, SEARCH_KEY_KNOWN } from './help';
import { know, known } from './known';
import { addAll, MARK_KNOWN, markable, MOVE_MARKED_KNOWN, movesWith, shifted, toggle } from './selection';
import { closeWish, keepWish, openWish, useWish, WishDialog } from './wish';
import { PlanDirNote, planDirBoxes, useHiddenEmptyNotes } from './planDirs';
import { pastedShots } from './pasteHint';
import { attachTo, imageFiles } from './shots';
import { cardDraft, drafted, fieldOn, focusedDraft, keepDrafts, MIC_DRAFT, OBEYA_DRAFT, takesImages } from './draft';
import { HoldToTalk, PushToTalk, SPACE_SHOWS_MS, TAP_MS, ToldList, usePushToTalk, useTold } from './voice';
import { videoOf } from './spot';
import { CardView, cardClass, shownState, DepLinks, depHead, depWidth, linkPath, linkSpot, Edges, Links, Minimap, OldBunPill, ProjectView, RestartPill, Sheet, SourcePill, TalkIcon, UpdatePill, WorkspacesPill } from './parts';
import { clampWidth, loadWidths, saveWidths, SHEET_W, type SheetWidths, widthsIn } from './sheetWidth';
import { failText, t } from './strings';
import { loadPinned, NAV_CANVAS_MIN, NAV_W, NavPill, NavSheet, savePinned } from './nav';
import { canvasPath, cardPath, named, queryWithout, readAddress } from './address';
import { beingWritten, split, talkAlone } from './talk';
import { ACK_MS, noticeLine, tellers, useAck, voiceTarget } from './tell';

export function App() {
  const [phone] = useState(phoneView);
  const [canvases, setCanvases] = useState<CanvasInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.canvases().then(
      (list) => {
        setCanvases(list);
        if (phone) keepCanvases(list);
      },
      () => {
        setFailed(true);
        if (phone) setCanvases((c) => c ?? keptCanvases());
      },
    );
    // the app from the home screen while the machine sleeps: the phone view with the canvases it had, which says that Obeya does not answer
    if (!phone) return;
    const h = setTimeout(() => setCanvases((c) => c ?? keptCanvases()), quietAtStart ? 0 : 3000);
    return () => clearTimeout(h);
  }, []);
  // what the page heard of the canvas it shows, for a switch to another to start from
  const seen = useRef<CanvasFeed | null>(null);
  // a switch to another canvas: what it starts from, and whether the canvas before has gone yet
  const [switching, setSwitching] = useState<{ path: string; push: boolean; start: Partial<CanvasFeed>; gone: boolean } | null>(null);
  const shownRef = useRef<string | undefined>(undefined);
  const canvasesRef = useRef(canvases);
  canvasesRef.current = canvases;
  useEffect(() => {
    if (phone) return;
    let latest = 0;
    const to = async (path: string, push: boolean) => {
      const url = new URL(path, location.href);
      const id = readAddress(url).canvas;
      const list = seen.current?.canvases ?? canvasesRef.current ?? [];
      if (!id || id === shownRef.current || !list.some((c) => c.id === id)) return push ? location.assign(path) : location.reload();
      const n = ++latest;
      // the canvas before stays until the next one is there: the page never shows neither
      const snapshot = await api.canvasOf(id).catch(() => null);
      if (n !== latest) return;
      if (!snapshot) return push ? location.assign(path) : location.reload();
      setCanvases(list);
      setSwitching({ path: `${url.pathname}${url.search}${url.hash}`, push, start: { ...seen.current, snapshot }, gone: false });
    };
    // Back or Forward to another canvas's address; one within the canvas is the canvas's own
    const pop = () => {
      const id = readAddress().canvas;
      if (id && id !== shownRef.current) void to(`${location.pathname}${location.search}`, false);
    };
    // a link to another canvas in the page (in the navigation, a text) switches to it, as `goTo` does
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href);
      const id = readAddress(url).canvas;
      if (url.origin !== location.origin || !url.pathname.startsWith('/c/') || !id || id === shownRef.current) return;
      e.preventDefault();
      void to(`${url.pathname}${url.search}${url.hash}`, true);
    };
    addEventListener('popstate', pop);
    document.addEventListener('click', click);
    const off = onSwitch((path) => void to(path, true));
    return () => {
      off();
      removeEventListener('popstate', pop);
      document.removeEventListener('click', click);
    };
  }, []);
  // the canvas before goes first (what it writes down as it goes is still its own), then the
  // address, the API and the drafts move on to the next one, before the browser paints in between
  useLayoutEffect(() => {
    if (!switching || switching.gone) return;
    if (switching.push) history.pushState(null, '', switching.path);
    setSwitching({ ...switching, gone: true });
  }, [switching]);
  if (!canvases) return <Splash offline={failed} />;
  if (switching && !switching.gone) return null;
  // the canvas in the address, else the first
  const wanted = readAddress().canvas;
  const current = canvases.find((c) => c.id === wanted) ?? canvases[0];
  if (!current) return <NoCanvas />;
  // a phone gets every canvas's waits and work, and the cards full screen, instead of the canvas
  if (phone) return <Phone canvases={canvases} />;
  shownRef.current = current.id;
  setCanvas(current.id);
  keepDrafts(sessionStorage, current.id);
  keepWish(sessionStorage, current.id);
  const start = switching?.start.snapshot?.canvas.id === current.id ? switching.start : undefined;
  return <Live key={current.id} canvases={canvases} start={start} seen={seen} />;
}

/**
 * No canvas runs: on the first start, with none configured yet, the setup assistant fills the page
 * and creates one; where the configured ones did not start, the page says why, and „Erneut
 * versuchen“ opens the canvases once one runs.
 */
function NoCanvas() {
  const [down, setDown] = useState<ConfigProblem[] | null>(null);
  const read = () => api.configCheck().then((c) => setDown(c.problems.filter((p) => p.code === 'canvasDown')), () => setDown([]));
  useEffect(() => void read(), []);
  if (!down) return <Splash offline={false} />;
  if (!down.length) return <Setup first />;
  const retried = () =>
    void api.canvases().then((list) => {
      if (list.length) location.reload();
      else void read();
    }, console.error);
  return (
    <div id="splash" className="none-runs">
      <Sign size={56} />
      <h2>{t.noneRuns}</h2>
      {down.map((p, k) => (
        <Problem key={k} problem={p} where="" retried={retried} />
      ))}
    </div>
  );
}

/** While the page loads, and after a restart until the canvas is back: the sign in the middle, above "offline" when the server cannot be reached. */
/** The canvases the phone view last had, for when the machine does not answer. */
const KEPT_CANVASES = 'obeya-phone-canvases';
/** Set once the owner has drawn their first arrow between cards: what an arrow does no longer shows while drawing. */
const DEP_KNOWN = 'obeya-dep-known';
function keepCanvases(list: CanvasInfo[]) {
  try {
    localStorage.setItem(KEPT_CANVASES, JSON.stringify(list));
  } catch {}
}
function keptCanvases(): CanvasInfo[] | null {
  try {
    const list = JSON.parse(localStorage.getItem(KEPT_CANVASES) ?? 'null') as CanvasInfo[] | null;
    return list?.length ? list : null;
  } catch {
    return null;
  }
}

function Splash({ offline }: { offline: boolean }) {
  return (
    <div id="splash">
      <Sign size={56} />
      {offline && <div>{t.offline}</div>}
    </div>
  );
}

function Live({ canvases: loaded, start, seen }: { canvases: CanvasInfo[]; start?: Partial<CanvasFeed>; seen: { current: CanvasFeed | null } }) {
  const feed = useCanvas(undefined, start);
  seen.current = feed;
  const { snapshot, online, restart, update, source, usage, waiting, oldBun, canvases } = feed;
  if (!snapshot) return <Splash offline={!online} />;
  // a canvas started, stopped or renamed while the page is open: the switcher follows
  return <Canvas snapshot={snapshot} online={online} restart={restart} update={update} source={source} usage={usage} canvases={canvases ?? loaded} waiting={waiting} oldBun={oldBun} />;
}

/** What is open, and the view to go back to: `prevCam` laid out beside the panels `prevSide`. */
type Focus = { type: 'project'; id: string; prevCam: Cam; prevSide: Sides } | { type: 'card'; id: string; prevCam: Cam; prevSide: Sides; project: Focus | null };
type Pos = { x: number; y: number };

// opening a card takes FLY_MS + UNFOLD_MS (300 ms) and closing the same: fast, yet still a visible move
const FLY_MS = 130;
/** The room the line for what is marked takes above or below the marked cards, and its least width. */
const MARKED_ROOM = 90;
const MARKED_W = 270;
const UNFOLD_MS = 170;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How many of the newest archived cards come first, before the whole archive: more than a tall screen shows. */
const ARCHIVE_FIRST = 40;
/** What `get` returns once it returns something, within `ms`. */
async function soon<T>(get: () => T | undefined, ms = 3000): Promise<T | undefined> {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) {
    const v = get();
    if (v) return v;
  }
  return get();
}

const camKey = (canvasId: string) => `obeya-cam-${canvasId}`;

function Canvas({
  snapshot,
  online,
  restart,
  update,
  source,
  usage,
  canvases,
  waiting,
  oldBun,
}: {
  snapshot: CanvasSnapshot;
  online: boolean;
  restart: PendingRestart | null;
  update: AppUpdate | null;
  source: SourceUpdate | null;
  /** The plan's usage limits, while the bar shows them. */
  usage: Usage | null;
  canvases: CanvasInfo[];
  waiting: Record<string, Waiting>;
  /** The Bun the server runs on, when it is too old for it (docs/design/distribution.md, Builds). */
  oldBun: string | null;
}) {
  // ---------------------------------------------------------------- items
  // Local positions win over the snapshot until the server echoes them back.
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  // Projects collapsed or expanded here, until the server echoes it back.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  // Cards created here, until the snapshot carries them.
  const [pending, setPending] = useState<Item[]>([]);
  // Approved cards the server is still landing, with what the card says meanwhile, until it moves on.
  const [underway, setUnderway] = useState<Record<string, string>>({});
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    const byId = new Map(snapshot.items.map((i) => [i.id, i]));
    setMoved((m) => {
      const keep = Object.entries(m).filter(([id, p]) => {
        const i = byId.get(id);
        const d = dragRef.current;
        return i && (d?.id === id || d?.with.some((w) => w.id === id) || i.x !== p.x || i.y !== p.y);
      });
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
    setFolded((f) => {
      const keep = Object.entries(f).filter(([id, c]) => byId.has(id) && !!byId.get(id)!.collapsed !== c);
      return keep.length === Object.keys(f).length ? f : Object.fromEntries(keep);
    });
    setPending((p) => (p.some((i) => byId.has(i.id)) ? p.filter((i) => !byId.has(i.id)) : p));
    setUnderway((u) => {
      const keep = Object.entries(u).filter(([id]) => byId.get(id)?.state === 'waiting');
      return keep.length === Object.keys(u).length ? u : Object.fromEntries(keep);
    });
  }, [snapshot]);

  const items = useMemo((): Item[] => {
    // the snapshot may carry a new card before its creation answers: then it is there once
    const ids = new Set(snapshot.items.map((i) => i.id));
    const all = [...snapshot.items, ...pending.filter((i) => !ids.has(i.id))];
    return all.map((i) => {
      const at = moved[i.id] ? { ...i, ...moved[i.id] } : i;
      const c = folded[i.id];
      if (c === undefined) return at;
      const { collapsed: _, ...open } = at;
      return c ? { ...open, collapsed: true as const } : open;
    });
  }, [snapshot, pending, moved, folded]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // the workstreams of a collapsed project are not on the canvas: its marks stand for them
  const placed = useMemo(() => onCanvas(items).map((item) => ({ item, b: boundsOf(item, items) })), [items]);
  const territories = useTerritories(placed, snapshot.groups);
  const kidsOf = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of items) if (i.parent) m.set(i.parent, [...(m.get(i.parent) ?? []), i]);
    return m;
  }, [items]);
  const repliesIn = useMemo(() => unreadPerProject(snapshot.talk), [snapshot.talk]);
  // ideas with a prototype on the canvas, which stay out of the archive until it ends
  const prototyped = useMemo(() => new Set(items.flatMap((i) => (i.prototypeOf ? [i.prototypeOf] : []))), [items]);
  const [noteHidden, hideNote] = useHiddenEmptyNotes(snapshot.canvas.id);
  // where notes on plan directories were moved here, by repository, until the server echoes it back
  const [notesMoved, setNotesMoved] = useState<Record<string, Pos>>({});
  useEffect(() => {
    const at = new Map(snapshot.planDirs?.map((d) => [d.repo, d.at]));
    setNotesMoved((m) => {
      const keep = Object.entries(m).filter(([repo, p]) => dragRef.current?.note === repo || at.get(repo)?.x !== p.x || at.get(repo)?.y !== p.y);
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
  }, [snapshot]);
  // a fresh array only when what is shown changes: the camera keeps the notes in sight
  const planDirs = useMemo(() => {
    const shown = snapshot.planDirs?.filter((d) => !noteHidden(d)).map((d) => (notesMoved[d.repo] ? { ...d, at: notesMoved[d.repo] } : d));
    return shown?.length ? shown : undefined;
  }, [snapshot.planDirs, noteHidden, notesMoved]);
  const notes = useMemo(() => (planDirs ? planDirBoxes(planDirs, placed) : []), [planDirs, placed]);
  const all: Bounds = useMemo(() => unionBounds([...placed.map((p) => p.b), ...notes]) ?? { x: 0, y: 0, w: 1000, h: 600 }, [placed, notes]);
  // what the view keeps in sight: the cards, a project only while it shows none, and the notes on plan directories
  const content = useMemo(() => [...placed.filter(({ item }) => item.collapsed || !kidsOf.has(item.id)).map((p) => p.b), ...notes], [placed, kidsOf, notes]);
  const contentRef = useRef(content);
  contentRef.current = content;
  const byId = (id: string) => itemsRef.current.find((i) => i.id === id);
  /** Where a card stands on the canvas; a workstream of a collapsed project, where its project does. */
  const bounds = (i: Item) => boundsOf(standsFor(i), itemsRef.current);
  /** The card on the canvas that shows `i`: a workstream of a collapsed project shows as a mark on its project. */
  const standsFor = (i: Item) => {
    const p = i.parent ? byId(i.parent) : undefined;
    return p?.collapsed ? p : i;
  };

  // ---------------------------------------------------------------- camera
  const [cam, setCam, camRef] = useLive<Cam>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(camKey(snapshot.canvas.id)) ?? 'null');
      // saved as it would be without a sheet, which none is before the page opens one
      if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite)) return keepInView(saved, content, { left: 0, top: TOP, right: innerWidth, bottom: innerHeight - BOTTOM });
    } catch {}
    return centreOn(all, 1);
  });
  // the panels docked at the window's edges that the camera is laid out for: a sheet that opens,
  // closes or is dragged wider moves the view by half the difference, so its middle stays the middle
  const camSide = useRef<Sides>(NO_SIDES);
  /** Flies to `to`, laid out for the sheets as they are now. */
  const fly = (to: Cam, ms?: number) => {
    camSide.current = sideNow();
    return flyTo(camRef.current, to, setCam, ms);
  };
  const flyOrJump = async (to: Cam, ms: number, jump: boolean) => (jump ? ((camSide.current = sideNow()), setCam(to)) : fly(to, ms));
  /** The view `f` was opened from, beside the sheets as they are now. */
  const back = (f: Focus) => besideSheet(f.prevCam, f.prevSide, sideNow());
  useEffect(() => {
    document.documentElement.style.setProperty('--s', String(cam.s));
    if (focusRef.current) return;
    const h = setTimeout(() => {
      try {
        localStorage.setItem(camKey(snapshot.canvas.id), JSON.stringify(besideSheet(cam, camSide.current, NO_SIDES)));
      } catch {}
    }, 300);
    return () => clearTimeout(h);
  }, [cam, snapshot.canvas.id]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((n) => n + 1);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  // ---------------------------------------------------------------- focus
  const [focus, setFocus, focusRef] = useLive<Focus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dim, setDim] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [sheetOn, setSheetOn, sheetOnRef] = useLive(false);
  // the open project's plan doc, read in the widened sheet
  const [reading, setReading, readingRef] = useLive<{ mark?: string } | null>(null);
  // how wide the sheets are, as the owner dragged them; in effect clamped to the window
  const [widths, setWidths] = useState<SheetWidths>(() => loadWidths(localStorage));
  const sheetW = widthsIn(widths, innerWidth);
  const sheetWRef = useRef(sheetW);
  sheetWRef.current = sheetW;
  const [kOn, setKOn, kOnRef] = useLive(false);
  const [aOn, setAOn, aOnRef] = useLive(false);
  const [sOn, setSOn, sOnRef] = useLive(false);
  // the card whose row in the search is under the pointer or picked by the arrow keys
  const [foundId, setFoundId] = useState<string | null>(null);
  // where the search's list stands while open: a card behind it is out of sight
  const [searchCover, setSearchCover] = useState<DOMRect | undefined>(undefined);
  const [cOn, setCOn, cOnRef] = useLive(false);
  // the navigation pinned as a sidebar on the left (src/ui/nav.tsx)
  const [pinned, setPinned, pinnedRef] = useLive(loadPinned);
  const pin = (on: boolean) => {
    setPinned(on);
    savePinned(on);
  };
  /**
   * What the panels docked at the window's edges take of it, as just set: the sheet on the right and
   * the pinned navigation on the left; the canvas is what remains between them. A narrow window lays
   * the sheet over the canvas instead (styles.css), and the navigation stays under its button, as it
   * does where it would leave the canvas too little room beside the sheet: the two never stack.
   */
  const sideNow = (): Sides => {
    const narrow = matchMedia(NARROW).matches;
    const right = narrow || !(kOnRef.current || sheetOnRef.current) ? 0 : sheetOnRef.current && readingRef.current ? sheetWRef.current.read : sheetWRef.current.sheet;
    return { left: !narrow && pinnedRef.current && innerWidth - NAV_W - right >= NAV_CANVAS_MIN ? NAV_W : 0, right };
  };
  /** Opens Obeya's sheet or closes it; an open project closes. */
  const toggleKoordinator = () => {
    setKOn(!kOn);
    if (!kOn && focusRef.current?.type === 'project') closeProject(false);
  };
  /** The sheet as the owner opens it to talk (its button, `C`): the field under the conversation takes the cursor. */
  const talkKoordinator = () => {
    toggleKoordinator();
    if (!kOn) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#ksheet .tell textarea')?.focus({ preventScroll: true }));
  };
  // the archive and the search drop down from the bar one at a time
  const toggleArchive = () => (setSOn(false), setAOn(!aOnRef.current));
  const toggleSearch = () => (setAOn(false), setSOn(!sOnRef.current));
  // the configuration is a dialog over the page: what is open behind it stays as it was
  const toggleConfig = () => setCOn(!cOnRef.current);
  // asking Obeya about the configuration: its conversation in place of the dialog, ready to type into
  const talkFromConfig = () => {
    setCOn(false);
    if (!kOn) talkKoordinator();
  };
  const [helpOn, setHelpOn] = useState(false);
  // „Telefon verbinden“, from the section „Von anderen Geräten“ of the configuration
  const [phoneOn, setPhoneOn] = useState(false);
  const wishOn = useWish().open;
  // the bar's `?` button stays until the owner opened the legend with the key; the legend's foot says so
  const [helpKnown, setHelpKnown] = useState(() => known(HELP_KEY_KNOWN));
  const [helpNote, setHelpNote] = useState<'button' | 'gone'>();
  // the bar's button for a new task stays until the owner created one by double-click; it only says how
  const [dblKnown, setDblKnown] = useState(() => known(DOUBLE_CLICK_KNOWN));
  const [newHintOn, setNewHintOn] = useState(false);
  // the bar's button that teaches `/`, until the owner used it, and the hint it opens
  const [searchKnown, setSearchKnown] = useState(() => known(SEARCH_KEY_KNOWN));
  const [searchHintOn, setSearchHintOn] = useState(false);
  const [setupOn, setSetupOn] = useState(false);
  // what is wrong in the configuration as saved, marked on its button; read when the page loads,
  // after a save in the dialog, when a repository's settings change on its default branch, which
  // the canvas counts in its repositories (`configRev`), and when a canvas or repository does not
  // start, which the canvases count (theirs, and which of them run)
  const [configProblems, setConfigProblems] = useState(0);
  const configRevs = [...snapshot.canvas.repos.map((r) => `${r.id}:${r.configRev ?? 0}`), ...canvases.map((c) => `${c.id}:${c.configRev ?? 0}`), `${snapshot.canvas.configRev ?? 0}`].join(' ');
  useEffect(() => void api.configCheck().then((c) => setConfigProblems(c.problems.length), console.error), [configRevs]);
  // the archive, read while its list or the search is open; archived cards unfold from their row there
  const [archived, setArchived] = useState<Item[]>([]);
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  /** The card `id`, on the canvas or else in the archive. */
  const itemOrArchived = (id: string) => byId(id) ?? archivedRef.current.find((i) => i.id === id);
  const archiveEls = useRef(new Map<string, HTMLElement>()).current;
  // rows of the project sheet, where its archived workstreams and its idea unfold from
  const sheetEls = useRef(new Map<string, HTMLElement>()).current;
  /** The element a card unfolds from and folds back to: on the canvas, or a row in the sheet it was opened from. */
  const fromEl = (id: string, inProject: boolean) =>
    els.get(id) ?? (inProject ? (sheetEls.get(id) ?? archiveEls.get(id)) : (archiveEls.get(id) ?? sheetEls.get(id)));
  // an archived card opened from a project's sheet, which the archive list may not hold
  const [opened, setOpened] = useState<Item | null>(null);
  // the archived card about to unfold from its row in the archive's list, which brings the row into view first
  const [archiveKeep, setArchiveKeep] = useState<string | undefined>(undefined);
  // read again only when the archive changed since (`snapshot.archive`); read the first time, its
  // newest cards come first, for the list to show at once while the rest loads
  const archiveRead = useRef<string | undefined>(undefined);
  useEffect(() => {
    if ((!aOn && !sOn) || (archiveRead.current !== undefined && archiveRead.current === snapshot.archive)) return;
    let current = true;
    let all = false;
    const rev = snapshot.archive;
    if (!archivedRef.current.length) api.archived(ARCHIVE_FIRST).then((a) => current && !all && setArchived(a), console.error);
    api.archived().then((a) => {
      if (!current) return;
      all = true;
      archiveRead.current = rev;
      setArchived(a);
    }, console.error);
    return () => void (current = false);
  }, [aOn, sOn, snapshot.archive]);
  const [popId, setPopId] = useState<string | null>(null);
  const els = useRef(new Map<string, HTMLElement>()).current;
  const panelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  useBarFit(barRef);
  const innerRef = useRef<HTMLDivElement>(null);
  // the panel follows its content from the unfold until it starts to fold
  const unfolded = useRef(false);
  const fitPanel = (i: Item) => {
    const panel = panelRef.current;
    const inner = innerRef.current;
    if (panel && inner) Object.assign(panel.style, panelRect(i, inner, sideNow()));
  };

  // edits of the open card, saved shortly after typing stops
  const edit = useRef<{ id: string; patch: CardPatch; timer?: ReturnType<typeof setTimeout> } | null>(null);
  /** Saves what was typed into the open card; actions on it wait for this. */
  const flushEdit = (): Promise<void> => {
    const e = edit.current;
    if (!e) return Promise.resolve();
    clearTimeout(e.timer);
    edit.current = null;
    return Object.keys(e.patch).length ? api.patch(e.id, e.patch) : Promise.resolve();
  };
  // leaving for another canvas: what was typed is saved at once, and what this canvas still had
  // under way (a lookup, a step of the address) no longer touches the page, which shows the other
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
      flushEdit().catch(console.error);
      beingWritten.clear();
    },
    [],
  );
  // a call about a card goes to its canvas, even once the page shows another
  useEffect(() => cardsOn(snapshot.canvas.id, snapshot.items.map((i) => i.id)), [snapshot]);
  // what the open card holds as typed, which the snapshot may not carry yet
  const openDraft = useRef<Pick<Item, 'kind' | 'title' | 'body' | 'images'>>({ kind: 'task', title: '', body: '' });
  const onEdit = (p: CardPatch) => {
    const id = focusRef.current?.id;
    if (!id) return;
    if (p.title !== undefined) openDraft.current.title = p.title;
    if (p.body !== undefined) openDraft.current.body = p.body;
    if (p.images !== undefined) openDraft.current.images = p.images;
    if (edit.current?.id !== id) flushEdit().catch(console.error);
    const e = (edit.current ??= { id, patch: {} });
    Object.assign(e.patch, p);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => flushEdit().catch(console.error), 400);
  };

  /**
   * Opens a card the search found: one on the canvas where it stands, the search closing (a
   * workstream of a collapsed project in its project's sheet); an archived one from its row.
   */
  function openFound(i: Item) {
    if (i.archivedAt) {
      // the search's field stays under the dim, where what is typed would change the list the card folds back into
      (document.activeElement as HTMLElement | null)?.blur();
      return open(i);
    }
    setSOn(false);
    const p = i.parent ? byId(i.parent) : undefined;
    return open(p?.collapsed ? p : i);
  }

  /** Unfolds the card `i`; `quick` without the flight and the unfold, as after a reload. */
  async function open(i: Item, quick = false) {
    const f = focusRef.current;
    if (f?.type === 'card') return;
    if (i.kind === 'project') return openProject(i);
    setFocus({ type: 'card', id: i.id, prevCam: camRef.current, prevSide: camSide.current, project: f });
    openDraft.current = { kind: i.kind, title: i.title, body: i.body, images: i.images ?? [] };
    setOpened(i.archivedAt ? i : null);
    // bring the card to the middle at a readable scale first, so the unfold starts where the eye is;
    // an archived card is not on the canvas and unfolds from its row in the archive
    if (!i.archivedAt) await flyOrJump(centreOnPoint(bounds(i), Math.max(camRef.current.s, 0.85), sideNow()), FLY_MS, quick);
    const el = fromEl(i.id, !!f);
    const panel = panelRef.current;
    // nothing to unfold from: the canvas stays as it was, open for the next card
    if (!el || !panel) return setFocus(f);
    addressOpens(i, f ? itemOrArchived(f.id) : undefined);
    const r = el.getBoundingClientRect();
    flushSync(() => setOpenId(i.id));
    panel.style.setProperty('--c', `var(--${shownState(i)})`);
    panel.className = '';
    panel.style.setProperty('--unfold', `${quick ? 0 : UNFOLD_MS}ms`);
    Object.assign(panel.style, rect(r), { display: 'block' });
    panel.getBoundingClientRect();
    panel.classList.add('anim');
    fitPanel(i);
    unfolded.current = true;
    setDim(true);
    if (!quick) await sleep(UNFOLD_MS);
    panel.classList.add('ready');
    // a card of the owner's without a title is written in its text first: Obeya names it from that
    const title = panel.querySelector<HTMLTextAreaElement>('textarea.p-title');
    const body = panel.querySelector<HTMLTextAreaElement>('textarea.p-body');
    if (title && !title.value) (body ?? title).focus();
    body?.setSelectionRange(body.value.length, body.value.length);
  }

  // a card that starts or finishes work while open changes its width and colour: resize in place
  const openItem = openId
    ? (itemOrArchived(openId) ?? (opened?.id === openId ? opened : undefined))
    : undefined;
  const openState = openItem && `${shownState(openItem)}:${openItem.need ?? ''}:${split(openItem)}`;
  useEffect(() => {
    const panel = panelRef.current;
    const i = openItem;
    if (!panel || !i || !unfolded.current) return;
    panel.style.setProperty('--c', `var(--${shownState(i)})`);
    fitPanel(i);
  }, [openState]);
  // content that grows or shrinks (a log loading, a question arriving, a resized text box) resizes it too
  useEffect(() => {
    const content = innerRef.current?.firstElementChild;
    if (!openId || !content) return;
    // in the next frame: a split that fills the panel takes back what the rest grew by, which would
    // change the content again while the observer reports
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const i = itemOrArchived(openId);
        if (i && unfolded.current) fitPanel(i);
      });
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [openId]);
  // and so does the window: a split filling the panel takes the height it has
  useEffect(() => {
    const i = openId && itemOrArchived(openId);
    if (i && unfolded.current) fitPanel(i);
  }, [tick]);

  // the open card went away on the server (cut into packages, deleted elsewhere): fold the panel
  useEffect(() => {
    if (openId && !openItem && focusRef.current?.type === 'card') closeCard({ keepUntitled: true });
  }, [openId, openItem]);

  function onDone(d: ActDone, p?: Pending) {
    if (!d.close) return;
    closeCard({ keepUntitled: true });
    if (!p || !d.pending) return showAck(d.ack, d.undo);
    // the card says it is under way until the snapshot moves it on; a refusal puts it back as it was
    const what = d.pending;
    setUnderway((u) => ({ ...u, [p.card]: what }));
    showWait(`${what.charAt(0).toUpperCase()}${what.slice(1)}`);
    p.answered.then(
      () => showAck(d.ack, d.undo),
      (e) => {
        if (!(e instanceof ApiError)) console.error(e);
        setUnderway(({ [p.card]: _, ...rest }) => rest);
        showAck(t.cardError(p.title, failText(e)));
      },
    );
  }

  /** Folds the open card; `onward` where another opens in its place next, which takes over its address. */
  async function closeCard({ keepUntitled = false, onward = false } = {}) {
    const f = focusRef.current;
    const panel = panelRef.current;
    if (f?.type !== 'card' || !panel) return;
    if (!onward) addressCloses(f.project ? itemOrArchived(f.project.id) : undefined);
    const saved = flushEdit().catch(console.error);
    panel.querySelector('video')?.pause();
    const i = byId(f.id);
    const el = fromEl(f.id, !!f.project);
    unfolded.current = false;
    panel.classList.remove('ready');
    if (el) Object.assign(panel.style, rect(el.getBoundingClientRect()));
    setDim(false);
    await sleep(UNFOLD_MS);
    panel.style.display = 'none';
    panel.className = '';
    beingWritten.delete(f.id);
    setOpenId(null);
    setFocus(f.project);
    // a new card left empty was not wanted; one with a task but no title, Obeya names
    const draft = openDraft.current;
    if (i?.source === 'manual' && !draft.title.trim()) {
      if (nameless(draft)) saved.then(() => api.act(i.id, { action: 'name' })).catch(console.error);
      else if (!keepUntitled) api.remove(i.id).catch(console.error);
    }
    await fly(back(f), FLY_MS);
    // the card may have gone (archived, deleted) and taken the last content in view with it
    recover();
  }

  /**
   * Opens a card the server made just now (a thread moved onto a Question card), which the canvas
   * may not show yet; a card open now folds first.
   */
  async function openFresh(i: Item) {
    const f = focusRef.current;
    if (f?.type === 'card') {
      if (f.id === i.id) return;
      await closeCard({ keepUntitled: true, onward: true });
    }
    flushSync(() => {
      if (!snapshotRef.current.items.some((x) => x.id === i.id)) setPending((p) => [...p, i]);
    });
    await open(i);
  }

  async function openProject(p: Item, quick = false) {
    // an archived project is not on the canvas: its sheet takes the archive list's place
    await projectSheet(p, null, quick, !p.archivedAt);
  }

  /** Reads the project's plan doc in the sheet, at the workstream `mark`; `null` goes back to the workstreams. */
  async function readPlan(p: Item, r: { mark?: string } | null, quick = false) {
    if (focusRef.current?.type === 'card') await closeCard();
    // the project stays in view beside the wider sheet
    await projectSheet(p, r, quick, true);
  }

  /** Shows the project in the sheet, its workstreams or (`r`) its plan doc, and with `inView` flies to it. */
  async function projectSheet(p: Item, r: { mark?: string } | null, quick: boolean, inView: boolean) {
    const f = focusRef.current;
    setFocus(f?.type === 'project' ? { ...f, id: p.id } : { type: 'project', id: p.id, prevCam: camRef.current, prevSide: camSide.current });
    addressOpens(p, undefined);
    setSheetId(p.id);
    setReading(r);
    setSheetOn(true);
    setKOn(false);
    setAOn(false);
    if (inView) await flyOrJump(camFor(bounds(p), sideNow()), 700, quick);
  }

  /** Closes the open project; `toArchive`: back to the archive an archived one was opened from. */
  async function closeProject(toArchive = true) {
    const f = focusRef.current;
    if (f?.type !== 'project') return;
    setFocus(null);
    addressCloses(undefined);
    setSheetOn(false);
    // one opened from the search goes back to the search's list, which stayed open; the two never show at once
    if (toArchive && !sOnRef.current && archivedRef.current.some((i) => i.id === f.id) && !itemsRef.current.some((i) => i.id === f.id)) setAOn(true);
    await fly(back(f), 600);
    recover();
  }

  async function deleteOpen() {
    const f = focusRef.current;
    if (f?.type !== 'card') return;
    const i = byId(f.id);
    const title = openDraft.current.title.trim() || titleFrom(openDraft.current.body);
    if (edit.current) clearTimeout(edit.current.timer);
    edit.current = null;
    // nothing for Obeya to name: the card goes
    openDraft.current = { kind: i?.kind ?? 'task', title: '', body: '' };
    await closeCard({ keepUntitled: true });
    if (!i) return;
    await api.remove(i.id);
    if (title) showAck(t.deleted(plain(title)), () => api.restore(i.id));
  }

  async function createAt(world: Pos) {
    const [w, h] = CARD_SIZE.task;
    const card = await api.create({ title: '', x: Math.round(world.x - w / 2), y: Math.round(world.y - h / 2) });
    beingWritten.add(card.id);
    flushSync(() => {
      // the snapshot that carries it may have come first: then it is no longer pending
      if (!snapshotRef.current.items.some((i) => i.id === card.id)) setPending((p) => [...p, card]);
      setPopId(card.id);
    });
    await open(card);
  }
  const createAtCentre = () => createAt(toWorld(camRef.current, midX(sideNow()), innerHeight / 2));

  // ---------------------------------------------------------------- kept across a restart
  // a restart reloads the page: what was open comes back as it was, without the flights
  const keepNow = useRef(() => {});
  keepNow.current = () => {
    flushEdit().catch(console.error);
    const f = focusRef.current;
    const project = f?.type === 'project' ? f.id : f?.type === 'card' ? f.project?.id : undefined;
    const sheet: SideSheet | undefined = kOn ? 'koordinator' : aOn ? 'archive' : undefined;
    keep(sessionStorage, snapshot.canvas.id, {
      at: Date.now(),
      ...(f?.type === 'card' ? { card: f.id } : {}),
      ...(project ? { project, reading: !!readingRef.current } : {}),
      ...(sheet ? { sheet } : {}),
      ...(cOn ? { config: true } : {}),
      ...collect(),
    });
  };
  useEffect(() => beforeReload(() => keepNow.current()), []);
  // Obeya's sheet left open over a draft comes back with the canvas; left empty or closed, it stays closed
  useEffect(() => {
    const away = () => leaveSheet(sessionStorage, snapshot.canvas.id, kOnRef.current && drafted(OBEYA_DRAFT));
    addEventListener('pagehide', away);
    // a switch to another canvas leaves this one as going to another page does
    return () => {
      removeEventListener('pagehide', away);
      away();
    };
  }, []);
  useEffect(() => {
    const k = takeKept(sessionStorage, snapshot.canvas.id);
    const sheetLeft = takeSheetLeft(sessionStorage, snapshot.canvas.id);
    // the canvas's own address, where the page came without one or with another canvas's; `?talk`
    // (Obeya's answer in another canvas's navigation) opens Obeya's sheet, once
    const a = readAddress();
    const code = !a.canvas || a.canvas === snapshot.canvas.id ? a.card : undefined;
    const talk = new URLSearchParams(location.search).has('talk');
    history.replaceState(history.state, '', `${code ? cardPath(snapshot.canvas.id, code) : canvasPath(snapshot.canvas.id)}${queryWithout(location.search, 'c', 'card', 'talk')}`);
    // what comes back is what the address names already; a kept card the address left out (a
    // restart of the app's shell, a link to the canvas) gets its address once it is open
    addressSet.current = true;
    const done = () => {
      addressSet.current = false;
      if (gone.current) return;
      history.replaceState(history.state, '', pathOf(openNow()));
    };
    if (k) return void reopen(k).catch(console.error).finally(done);
    if (sheetLeft || talk) {
      // beside the sheet at once, as the canvas comes back
      quickSide.current = Date.now() + 2000;
      setKOn(true);
    }
    (code ? openAddress(code, true) : Promise.resolve()).catch(console.error).finally(done);
  }, []);
  async function reopen(k: Kept) {
    // the sheet that comes back sets the camera beside it at once, as the rest comes back without flights
    quickSide.current = Date.now() + 2000;
    if (k.sheet === 'koordinator') setKOn(true);
    else if (k.sheet === 'archive') setAOn(true);
    if (k.config) setCOn(true);
    await openAgain(k, true);
    restore(k);
  }
  /** Opens the project `k.project` (its plan doc with `reading`) and the card `k.card` in it or on the canvas; an archived one from its row in the archive or the project's sheet. */
  async function openAgain(k: Pick<Kept, 'card' | 'project' | 'reading'>, quick: boolean) {
    const find = async (id?: string) => (id ? namedBy(id) : undefined);
    // an archived project's sheet lists its workstreams from the archive, which this loads
    const p = await find(k.project);
    // the doc opens at its top, and the kept position puts it back where it was
    if (p) await (k.reading ? readPlan(p, {}, quick) : openProject(p, quick));
    const i = await find(k.card);
    // an archived card unfolds from its row in the archive or the project's sheet, once that has loaded
    // and the archive's list has brought it into view
    if (i?.archivedAt && !p) setArchiveKeep(i.id);
    try {
      if (i && (!i.archivedAt || (await soon(() => fromEl(i.id, !!p))))) await open(i, quick);
    } finally {
      setArchiveKeep(undefined);
    }
  }

  // ---------------------------------------------------------------- the address
  // the address names the open card or project (`/c/<canvas>/card/<code>`). Opening one is a step in
  // the browser's history, so Back closes it again, as on the phone; one opened in place of another
  // (by a link in it) takes over that one's step. Changes take effect one after the other: a step
  // back is done once the browser says so.
  const addressChain = useRef(Promise.resolve());
  const address = (change: () => void | Promise<void>) => void (addressChain.current = addressChain.current.then(() => (gone.current ? undefined : change())).catch(console.error));
  /** The step back this page asked the browser for, until it is done. */
  const stepBack = useRef<(() => void) | null>(null);
  /** While the page opens what the address names (as it loads, on Back or Forward): the address is set already. */
  const addressSet = useRef(false);
  /** The card or project open now. */
  const openNow = () => {
    const f = focusRef.current;
    return f ? itemOrArchived(f.id) : undefined;
  };
  const pathOf = (i: Item | undefined) => `${i ? cardPath(snapshot.canvas.id, i) : canvasPath(snapshot.canvas.id)}${location.search}`;
  /** `i` opens over `under` (the project it is opened from, else the canvas). */
  function addressOpens(i: Item, under: Item | undefined) {
    if (addressSet.current) return;
    address(() => {
      const at = readAddress().card;
      if (at && named([i], at)) return;
      if (!at || (under && named([under], at))) history.pushState({ step: true }, '', pathOf(i));
      else history.replaceState(history.state, '', pathOf(i));
    });
  }
  /** What is open closes down to `under` (the project still open, else the canvas). */
  function addressCloses(under: Item | undefined) {
    if (addressSet.current) return;
    address(() => {
      if (!(history.state as { step?: true } | null)?.step) return history.replaceState(history.state, '', pathOf(under));
      return new Promise<void>((done) => {
        stepBack.current = () => {
          // the step before may name what is no longer open (a card opened over its project, then reloaded without it)
          const at = readAddress().card;
          if (at && !(under && named([under], at))) history.replaceState(history.state, '', pathOf(under));
          done();
        };
        history.back();
      });
    });
  }
  /** The card or project an address (or an id) names, on the canvas or in the archive, which it loads where it has to. */
  async function namedBy(code: string) {
    const here = named(itemsRef.current, code) ?? named(archivedRef.current, code);
    if (here) return here;
    const gone = await api.archived().catch(() => []);
    archivedRef.current = gone;
    setArchived(gone);
    return named(gone, code);
  }
  /** Opens what the address names; a code no card has leaves the canvas, at its address. */
  async function openAddress(code: string, quick: boolean) {
    const i = await namedBy(code);
    if (gone.current) return;
    // by its short code, where it was named by its id
    history.replaceState(history.state, '', pathOf(i));
    if (!i) return;
    if (i.kind === 'project') return openAgain({ project: i.id }, quick);
    // an archived workstream unfolds from its project's sheet, any other archived card from the archive's list
    const project = i.archivedAt ? i.parent : undefined;
    if (i.archivedAt && !project) setAOn(true);
    await openAgain({ card: i.id, project }, quick);
  }
  /** Back or Forward: what the address no longer names closes, what it names opens. */
  async function followAddress() {
    const code = readAddress().card;
    const i = code ? await namedBy(code) : undefined;
    if (gone.current) return;
    addressSet.current = true;
    try {
      const f = focusRef.current;
      if (f?.type === 'card' && f.id !== i?.id) await closeCard({ keepUntitled: true });
      const p = focusRef.current;
      if (p?.type === 'project' && p.id !== i?.id && i?.parent !== p.id) await closeProject(false);
      // a code no card has any longer: openAddress leaves the canvas at its address
      if (code && (!i || focusRef.current?.id !== i.id)) await openAddress(code, false);
    } finally {
      addressSet.current = false;
    }
  }
  const follow = useRef(followAddress);
  follow.current = followAddress;
  useEffect(() => {
    const pop = () => {
      // Back or Forward to another canvas: the page switches to it (App)
      const to = readAddress().canvas;
      if (to && to !== snapshot.canvas.id) return;
      const done = stepBack.current;
      stepBack.current = null;
      if (done) done();
      else address(() => follow.current());
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);

  // ---------------------------------------------------------------- acknowledgement with undo
  const { showAck, showWait, fail, line: ackLine } = useAck();

  /** The play button on a card: starts it, or one queued behind others despite the likely conflict. */
  const startCard = useCallback(async (i: Item) => {
    try {
      await api.act(i.id, { action: i.queue ? 'force' : 'start' });
      if (i.queue) showAck(forcedText(i.queue));
    } catch (e) {
      fail(e);
    }
  }, []);

  /** The archive button on a finished card or a parked or dropped idea: takes it off the canvas, with a moment to undo. */
  const archiveCard = useCallback(async (i: Item) => {
    try {
      await api.archive(i.id);
      showAck(t.archive.archived(plain(i.title)), () => api.unarchive(i.id));
    } catch (e) {
      fail(e);
    }
  }, []);

  /**
   * The project's button, on its card and in its sheet: all planned workstreams go to the
   * Koordinator together, which waits a few seconds before it plans them, so the start can be taken back.
   */
  const startAll = useCallback(async (p: Item, n: number) => {
    try {
      await api.act(p.id, { action: 'start' });
      showAck(
        t.plan.startedAll(n),
        async () => {
          try {
            await api.act(p.id, { action: 'dequeue' });
            showAck(t.plan.startTakenBack);
          } catch (e) {
            showAck(e instanceof ApiError && e.code === 'notQueued' ? t.voice.tooLate : t.offlineError);
          }
        },
        START_ALL_HOLD_MS,
      );
    } catch (e) {
      fail(e);
    }
  }, []);

  /**
   * „Entziehen“ in the Workspaces list: the card's clone goes to the card waiting longest once the
   * undo window is through; „Rückgängig“ (here or in its row) takes that back meanwhile.
   */
  const keepWorkspace = useCallback(async (i: Item) => {
    try {
      await api.act(i.id, { action: 'keepWorkspace' });
      showAck(t.workspaces.keptBack(plain(i.title)));
    } catch (e) {
      showAck(e instanceof ApiError && e.code === 'notEvictable' ? t.voice.tooLate : failText(e));
    }
  }, []);
  const takeWorkspace = useCallback(async (i: Item) => {
    try {
      await api.act(i.id, { action: 'takeWorkspace' });
      showAck(t.workspaces.taken(plain(i.title)), () => keepWorkspace(i), EVICT_HOLD_MS);
    } catch (e) {
      fail(e);
    }
  }, []);

  /**
   * The project's „Anordnen“, on its card and in its sheet: its workstreams in columns by what builds
   * on what, once Obeya has read that from the plan doc. It takes effect at once; „Rückgängig“ puts
   * the cards (and the project, which may have made room for itself) back where they stood.
   */
  const arrange = useCallback(async (p: Item) => {
    const before = [p, ...itemsRef.current.filter((i) => i.parent === p.id)].map(({ id, x, y }) => ({ id, x, y }));
    try {
      await api.act(p.id, { action: 'arrange' });
      showAck(t.plan.arranged, async () => {
        try {
          await Promise.all(before.map(({ id, x, y }) => api.patch(id, { x, y })));
          showAck(t.plan.arrangeUndone);
        } catch (e) {
          fail(e);
        }
      });
    } catch (e) {
      fail(e);
    }
  }, []);

  /** The fold in a project's head: collapsed, only its head and a mark for each workstream stay on the canvas. */
  const collapse = useCallback(async (p: Item, collapsed: boolean) => {
    setFolded((f) => ({ ...f, [p.id]: collapsed }));
    try {
      await api.patch(p.id, { collapsed });
    } catch (e) {
      setFolded(({ [p.id]: _, ...rest }) => rest);
      fail(e);
    }
  }, []);
  // a stable handle on `open` for the memoised project views
  const openRef = useRef(open);
  openRef.current = open;
  const openCard = useCallback((i: Item) => void openRef.current(i).catch(console.error), []);

  /** "Als Projekt aufbereiten" on the note on a plan directory: a card whose agent prepares the doc, started at once. */
  const preparePlanDoc = useCallback(async (dir: PlanDir, file: string) => {
    try {
      const card = await api.preparePlanDoc(snapshot.canvas.id, dir.repo, file);
      showAck(t.planDir.started(plain(card.title)));
    } catch (e) {
      fail(e);
    }
  }, []);

  // ---------------------------------------------------------------- voice
  const where = (): Where => {
    const f = focusRef.current;
    return f?.type === 'card' ? { card: f.id } : f?.type === 'project' ? { project: f.id } : null;
  };
  // where the pointer is on the page, null once it left the window
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => void (pointerAt.current = { x: e.clientX, y: e.clientY });
    const out = (e: MouseEvent) => void (e.relatedTarget || (pointerAt.current = null));
    addEventListener('pointermove', move, true);
    document.addEventListener('mouseout', out);
    return () => {
      removeEventListener('pointermove', move, true);
      document.removeEventListener('mouseout', out);
    };
  }, []);
  /** The canvas on the screen: beside the sheets, below the top bar and above the microphone. */
  const viewNow = () => {
    const side = sideNow();
    return { left: side.left, top: TOP, right: innerWidth - side.right, bottom: innerHeight - BOTTOM };
  };
  /**
   * Where a card a command makes goes: under the pointer on the canvas, else in the middle of the
   * view (`pointer` false: always there); with a card or project open, in the view it goes back to.
   */
  const placeNow = (pointer = true): Place => {
    const f = focusRef.current;
    return placeIn(f ? back(f) : camRef.current, viewNow(), f || !pointer ? null : pointerAt.current);
  };
  // a command that makes a card: when it appears out of view, the camera goes there
  const newCardWatch = useRef<{ known: Set<string>; until: number } | null>(null);
  function onHeard(h: Heard) {
    // said to the open card's agent: the card shows it
    if (h.quiet) return;
    // the owner asked to tell Obeya's makers something: the draft for them opens
    if (h.wish) openWish(h.wish);
    if (h.token && !focusRef.current) newCardWatch.current = { known: new Set(itemsRef.current.map((i) => i.id)), until: Date.now() + 20_000 };
  }
  // the reply stands in Obeya's sheet, or the answer in the project's sheet, open in front of the owner: no line above the microphone
  const told = useTold(
    onHeard,
    (h) =>
      !cOnRef.current &&
      ((kOnRef.current && snapshotRef.current.talk.some((x) => x.id === h.talk)) ||
        (!!h.inCard && focusRef.current?.type === 'card' && focusRef.current.id === h.inCard) ||
        (!!h.project && sheetOnRef.current && !readingRef.current && focusRef.current?.type === 'project' && focusRef.current.id === h.project)),
  );
  const { tellAbout, tellTyped } = tellers(byId, told, fail, placeNow);
  // a card Obeya asked to open before it was on the canvas
  const openSoon = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => {
    const o = openSoon.current;
    if (!o) return;
    const i = snapshot.items.find((x) => x.id === o.id);
    if (!i && Date.now() < o.until) return;
    openSoon.current = null;
    if (!i || focusRef.current) return;
    newCardWatch.current = null;
    setKOn(false);
    void open(i);
  }, [snapshot]);
  useEffect(() => {
    const w = newCardWatch.current;
    if (!w) return;
    if (Date.now() > w.until) return void (newCardWatch.current = null);
    const made = snapshot.items.find((i) => i.source === 'manual' && !w.known.has(i.id));
    if (!made || focusRef.current) return;
    newCardWatch.current = null;
    setPopId(made.id);
    // a new idea opens, so the owner sees the discussion begin
    if (made.state === 'idea') {
      setKOn(false);
      open(made);
    } else if (!shows(camRef.current, viewNow(), boundsOf(made, itemsRef.current))) fly(centreOnPoint(boundsOf(made, itemsRef.current), Math.max(camRef.current.s, 0.8), sideNow()), 700);
  }, [snapshot]);
  // what Obeya tells the owner without a command to answer: an answer looked up, what a request a
  // card's agent passed on came to (with "Rückgängig" while its actions wait)
  useEffect(
    () =>
      onNotice((n) => {
        // the open card moved to another canvas (built in a new repository there): the page follows it
        const f = focusRef.current;
        if (n.movedTo && n.cardId && f?.type === 'card' && f.id === n.cardId) return goTo(cardPath(n.movedTo, n.cardId));
        const i = itemsRef.current.find((x) => x.id === n.cardId);
        if (n.wish) openWish(n.wish);
        // the card a review of its PR asked for, unless the owner has another one open; one just made, once it is on the canvas
        if (n.open && n.cardId && !focusRef.current) {
          if (i) {
            setKOn(false);
            void open(i);
          } else openSoon.current = { id: n.cardId, until: Date.now() + 10_000 };
        }
        told.show(i ? { id: i.id, title: plain(i.title) } : undefined, { confirm: noticeLine(n.text), ...(n.token ? { token: n.token } : {}), ...(n.undoMs ? { undoMs: n.undoMs } : {}), ...(n.talk ? { talk: n.talk } : {}), ...(n.project ? { project: n.project } : {}), ...(n.inTalk && n.cardId ? { inCard: n.cardId } : {}) });
      }),
    [],
  );
  /** The draft of the field that speaks to `target`, whether or not it is on the page: the open card's, or Obeya's sidebar's. */
  const draftFor = (target: Where) => (target && 'card' in target ? cardDraft(target.card) : !target && kOnRef.current ? OBEYA_DRAFT : null);
  /** The draft a recording for `target` goes out with: its field's, or without one on the page the screenshots beside the mic. */
  const fieldFor = (target: Where) => {
    const key = draftFor(target);
    return key && fieldOn(key) ? key : MIC_DRAFT;
  };
  const ptt = usePushToTalk(where, fieldFor, tellAbout, (h) => showAck(h.confirm), placeNow);
  const pttRef = useRef(ptt);
  pttRef.current = ptt;
  // a text field's microphone, and Space held in it
  /** The open card's demo video while the owner holds Space or the microphone: whether it played, and since when. */
  const pressing = useRef<{ video: HTMLVideoElement | null; playing: boolean; at: number; space: boolean; dictating: boolean } | null>(null);
  /** Space or the microphone held: the demo video pauses, so its narration stays out of the recording. */
  const press = (space: boolean) => {
    const f = focusRef.current;
    const video = f?.type === 'card' ? (videoOf(f.id) ?? panelRef.current?.querySelector('video') ?? null) : null;
    pressing.current = { video, playing: !!video && !video.paused, at: performance.now(), space, dictating: !!focusedDraft() };
    video?.pause();
    // a tap on Space plays or pauses the video: with one open, the microphone shows it listens only once Space stays down
    pttRef.current.start(space && video ? SPACE_SHOWS_MS : 0);
  };
  /**
   * Let go: a tap on Space plays or pauses the video; after speaking, a video that played plays on,
   * unless the words went into a field, where the owner goes on writing about the place it stands at.
   */
  const letGo = () => {
    const p = pressing.current;
    pressing.current = null;
    pttRef.current.stop();
    if (!p?.video) return;
    const tap = p.space && performance.now() - p.at < TAP_MS;
    if (tap ? !p.playing : p.playing && !p.dictating) p.video.play().catch(() => {});
  };
  const letGoRef = useRef(letGo);
  letGoRef.current = letGo;
  const pressRef = useRef(press);
  pressRef.current = press;
  const holdToTalk = useCallback(() => pressRef.current(false), []);
  useEffect(() => {
    const up = (e: KeyboardEvent) => e.code === 'Space' && letGoRef.current();
    const release = () => letGoRef.current();
    // a screenshot pasted (⌘V) anywhere but in a text field goes to the field in view, or beside the mic
    const paste = (e: ClipboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return;
      const files = imageFiles(e.clipboardData?.files);
      const key = fieldFor(where());
      if (!files.length || !takesImages(key)) return;
      e.preventDefault();
      pastedShots();
      void attachTo(key, files);
    };
    addEventListener('keyup', up, true);
    addEventListener('pointerup', release);
    addEventListener('paste', paste);
    return () => {
      removeEventListener('keyup', up, true);
      removeEventListener('pointerup', release);
      removeEventListener('paste', paste);
    };
  }, []);
  const focusItem = focus ? itemOrArchived(focus.id) : undefined;
  const target = voiceTarget(focus && { type: focus.type, item: focusItem });
  // a card a command makes goes into what is in view, reported once the view rests
  useEffect(() => {
    const h = setTimeout(() => reportFocus(placeNow(false)), 300);
    return () => clearTimeout(h);
  }, [focus?.type, focus?.id, cam, tick, kOn, sheetOn, sheetW.sheet]);

  // ---------------------------------------------------------------- pointer: pan, drag, click
  const viewportRef = useRef<HTMLDivElement>(null);
  // `from`: where the press began; one that went nowhere is a click on the empty canvas
  const panRef = useRef<{ x: number; y: number; from: Pos } | null>(null);
  // a dragged card follows the world point it was picked up at, also while the view scrolls under it
  // (or the note on a plan directory, by its repository, with where it is now)
  // `with`: the other marked cards, which move by as much; `shift`: a Shift + click marks the card instead of opening it
  type Drag = { id: string; note?: string; to?: Pos; with: { id: string; start: Pos }[]; shift: boolean; x: number; y: number; px: number; py: number; grab: Pos; start: Pos; limit: Bounds; moved: boolean; frame: number; last: number };
  const dragRef = useRef<Drag | null>(null);
  const [panning, setPanning] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragWith, setDragWith] = useState<string[]>([]);
  // the card the pointer is on, for the waits around it
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ from: string; side: Side; x: number; y: number; target?: string } | null>(null);
  // the dot under the pointer: the canvas renders again only when it changes
  const [handle, setHandle] = useState<{ id: string; side: Side } | null>(null);
  const handleRef = useRef(handle);
  const showHandle = (h: { id: string; side: Side } | null) => {
    const was = handleRef.current;
    if (was?.id === h?.id && was?.side === h?.side) return;
    handleRef.current = h;
    setHandle(h);
  };
  const connectable = (item: Item) => item.source !== 'plan' && item.kind !== 'project';
  // what covers an arrow's trash button: the cards, which lie above the arrows
  const cardBoxes = useMemo(() => placed.flatMap(({ item, b }) => (item.kind === 'project' ? [] : [b])), [placed]);
  const titleOf = (id: string) => {
    const i = byId(id);
    return clip(i ? plain(i.title) || titleFrom(i.body) || t.titlePlaceholder : '…', 50);
  };
  // what an arrow does shows while the owner draws one, until they have drawn their first
  const [depKnown, setDepKnown] = useState(() => known(DEP_KNOWN));
  // arrows the owner removed that the server may still have: one holding a queued card goes there only
  // once „Rückgängig“ has run out (`sent` from then on), so that taking it back never leaves the card started
  const [removing, setRemoving] = useState<{ key: string; sent?: true }[]>([]);
  // those removals while „Rückgängig“ runs, each with its timer and what sends it
  const pendingRemovals = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send: (keepalive?: boolean) => void }>());
  // what the owner removed goes to the server even when the page goes before „Rückgängig“ has run out
  useEffect(() => {
    const away = () => {
      for (const p of pendingRemovals.current.values()) {
        clearTimeout(p.timer);
        p.send(true);
      }
      pendingRemovals.current.clear();
    };
    addEventListener('pagehide', away);
    return () => {
      removeEventListener('pagehide', away);
      away();
    };
  }, []);
  /** A removal still waiting for „Rückgängig“ to run out is taken back: the arrow stays. */
  function keepDependency(key: string) {
    const p = pendingRemovals.current.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pendingRemovals.current.delete(key);
    setRemoving((r) => r.filter((x) => x.key !== key));
  }
  // Shift + drag on the canvas draws a lasso, Shift + click on a card takes it in or out: what is marked
  // moves together and goes into a group at once through the colour ring
  const lassoRef = useRef<Pos[] | null>(null);
  const [lasso, setLasso] = useState<Pos[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const marked = selection.filter((id) => placed.some((p) => p.item.id === id));
  // how to mark shows after a card was moved alone, until the owner has marked cards; how to move them beside them, until they have
  const [markKnown, setMarkKnown] = useState(() => known(MARK_KNOWN));
  const [moveKnown, setMoveKnown] = useState(() => known(MOVE_MARKED_KNOWN));
  const [markHint, setMarkHint] = useState<{ at: Pos; key: number } | null>(null);
  useEffect(() => {
    if (!marked.length || markKnown) return;
    know(MARK_KNOWN);
    setMarkKnown(true);
    setMarkHint(null);
  }, [marked.length]);
  useEffect(() => {
    if (!markHint) return;
    const h = setTimeout(() => setMarkHint(null), 7000);
    return () => clearTimeout(h);
  }, [markHint]);
  const [ring, setRing] = useState<{ at: Pos; ids: string[] } | null>(null);
  const markedBox = unionBounds(placed.filter((p) => marked.includes(p.item.id)).map((p) => p.b));
  /** Where the line for what is marked stands: over its top right corner, below it where the bar leaves no room, always in view. */
  const markedAt = (b: Bounds) => {
    const c = cam;
    const top = c.y + b.y * c.s;
    const below = top < TOP + MARKED_ROOM;
    const y = below ? c.y + (b.y + b.h) * c.s : top;
    const side = sideNow();
    return { at: { x: Math.min(innerWidth - side.right - 12, Math.max(side.left + MARKED_W, c.x + (b.x + b.w) * c.s)), y: Math.min(innerHeight - MARKED_ROOM, Math.max(TOP + MARKED_ROOM, y)) }, below };
  };
  async function assignGroup(to: { group: string | null } | { name: string }) {
    const r = ring!;
    setRing(null);
    // the territory grows from the pointer, or from the one card it is for
    const one = r.ids.length === 1 ? placed.find((p) => p.item.id === r.ids[0])?.b : undefined;
    growFrom(r.ids, one ? centre(one) : toWorld(camRef.current, r.at.x, r.at.y));
    try {
      if ('name' in to) await api.createGroup(to.name, r.ids);
      else await api.assign(r.ids, to.group);
    } catch (e) {
      fail(e);
    }
  }
  /** The trash button on an owner-drawn arrow: it goes at once, with „Rückgängig“. */
  function removeDependency(from: string, to: Item) {
    const key = `${from}:${to.id}`;
    if (!(to.queue && 'behind' in to.queue && to.queue.behind.includes(from))) {
      api.dependency(from, to.id, true).then(
        () => showAck(t.deps.removed, () => api.dependency(from, to.id).catch(fail)),
        fail,
      );
      return;
    }
    setRemoving((r) => [...r, { key }]);
    const send = (keepalive = false) => {
      setRemoving((r) => r.map((x) => (x.key === key ? { key, sent: true } : x)));
      api.dependency(from, to.id, true, keepalive).catch((e) => {
        setRemoving((r) => r.filter((x) => x.key !== key));
        fail(e);
      });
    };
    const timer = setTimeout(() => {
      pendingRemovals.current.delete(key);
      send();
    }, ACK_MS);
    pendingRemovals.current.set(key, { timer, send });
    showAck(t.deps.removed, () => keepDependency(key));
  }
  // a removal the server has done is shown by the snapshot from then on
  useEffect(() => {
    const drawn = new Set(placed.flatMap(({ item }) => (item.manualDependsOn ?? []).map((from) => `${from}:${item.id}`)));
    if (removing.some((x) => x.sent && !drawn.has(x.key))) setRemoving((r) => r.filter((x) => !x.sent || drawn.has(x.key)));
  }, [placed, removing]);
  /** The × on a group's name in the colour ring: its cards belong to none, with a moment to undo. */
  async function deleteGroup(g: Group) {
    setRing(null);
    try {
      const gone = await api.deleteGroup(g.id);
      showAck(t.groups.removed(g.name), () => api.createGroup(gone.group.name, gone.cards, gone.group.hue));
    } catch (e) {
      fail(e);
    }
  }
  /** A right click on a card opens the colour ring for it (a workstream's is its project's), on a marked one for all marked. */
  function onContextMenu(e: React.MouseEvent) {
    if (focusRef.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.item');
    let i = el && byId(el.dataset.id!);
    if (i?.parent) i = byId(i.parent);
    if (!i) return;
    e.preventDefault();
    setRing({ at: { x: e.clientX, y: e.clientY }, ids: marked.includes(i.id) ? marked : [i.id] });
  }
  // the panels docked at the window's edges; the canvas, its edge indicators, the bar and the microphone keep between them
  const side = sideNow();
  const quickSide = useRef(0);
  // the panels the page loads with (the pinned navigation, on every switch of canvas) take their
  // room at once: the camera comes back beside them, not saved without them and then flown over
  const sideLaidOut = useRef(false);
  useEffect(() => {
    const first = !sideLaidOut.current;
    sideLaidOut.current = true;
    const from = camSide.current;
    if (side.left === from.left && side.right === from.right) return;
    camSide.current = side;
    // the open card's view goes back to where it was opened from, beside whatever sheet is open then
    if (focusRef.current?.type === 'card') return;
    const to = kept(besideSheet(camRef.current, from, side));
    if (first || resizing || Date.now() < quickSide.current) {
      stopFlight();
      setCam(to);
    } else fly(to, 450);
  }, [side.left, side.right]);

  // the grip at the open sheet's left edge widens or narrows it; reading a plan doc has its own width
  const gripOn = kOn || sheetOn;
  const gripKind = !!reading && sheetOn ? 'read' : 'sheet';
  const gripRef = useRef<{ x: number; w: number; kind: 'sheet' | 'read' } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!resizing) saveWidths(localStorage, widths);
  }, [widths, resizing]);
  function onGripDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gripRef.current = { x: e.clientX, w: sheetW[gripKind], kind: gripKind };
    setResizing(true);
  }
  function onGripMove(e: React.PointerEvent) {
    const g = gripRef.current;
    if (!g) return;
    const w = clampWidth(g.w + g.x - e.clientX, innerWidth, g.kind);
    setWidths((ws) => ({ ...ws, [g.kind]: w }));
  }
  function onGripUp() {
    gripRef.current = null;
    setResizing(false);
  }
  /** `c`, moved just far enough that the view outside the sheet shows some content. */
  const kept = (c: Cam) => keepInView(c, contentRef.current, viewNow());
  /** The view at the current zoom with a world point in the middle, as far as content stays in sight. */
  const viewOn = (wx: number, wy: number) => kept({ s: camRef.current.s, x: midX(sideNow()) - wx * camRef.current.s, y: innerHeight / 2 - wy * camRef.current.s });
  /** When no content is in view any more (cards went, the window shrank), flies to the nearest. */
  const recover = () => {
    if (focusRef.current?.type === 'card' || dragRef.current || panRef.current || flying()) return;
    const c = camRef.current;
    const k = kept(c);
    if (k.x !== c.x || k.y !== c.y) fly(k, 400);
  };
  useEffect(recover, [content, tick]);

  function onPointerDown(e: React.PointerEvent) {
    if (focusRef.current?.type === 'card' || e.button !== 0) return;
    if (connection) {
      e.stopPropagation();
      if (connection.target) {
        // the arrow drawn again while its removal waits for „Rückgängig“ to run out: it simply stays
        if (pendingRemovals.current.has(`${connection.from}:${connection.target}`)) keepDependency(`${connection.from}:${connection.target}`);
        else {
          const { from, target } = connection;
          api.dependency(from, target).catch((err) => showAck(err instanceof ApiError && err.code === 'dependencyCycle' ? t.deps.cycle(titleOf(from), titleOf(target)) : failText(err)));
        }
        if (!depKnown) {
          know(DEP_KNOWN);
          setDepKnown(true);
        }
      }
      setConnection(null);
      return;
    }
    stopFlight();
    const el = (e.target as Element).closest<HTMLElement>('.item');
    const note = (e.target as Element).closest<HTMLElement>('.plan-dir');
    if (note) {
      // it moves by its top left as it stands now: one above the projects stands on its bottom
      const repo = note.dataset.repo!;
      const r = note.getBoundingClientRect();
      const start = toWorld(camRef.current, r.left, r.top);
      const b = notes[planDirs!.findIndex((d) => d.repo === repo)]!;
      const content = unionBounds(placed.map((p) => p.b)) ?? b;
      const grab = toWorld(camRef.current, e.clientX, e.clientY);
      dragRef.current = { id: `note:${repo}`, note: repo, with: [], shift: false, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, grab, start, limit: dragLimit(content, b), moved: false, frame: 0, last: 0 };
    } else if (el && (!el.classList.contains('project') || (e.target as Element).closest('.head'))) {
      const i = byId(el.dataset.id!);
      if (!i) return;
      // a marked card takes the other marked ones along
      const along = movesWith(marked, i.id).flatMap((id) => {
        const x = byId(id);
        return x ? [{ id, start: { x: x.x, y: x.y } }] : [];
      });
      const moving = new Set([i.id, ...along.map((a) => a.id)]);
      // the view scrolls as far as the rest of the canvas reaches, plus room to drop the cards beside it
      const rest = onCanvas(itemsRef.current).filter((x) => !moving.has(x.id));
      const b = unionBounds([...moving].map((id) => bounds(byId(id)!)))!;
      const content = unionBounds(rest.map((x) => boundsOf(x, rest))) ?? b;
      const grab = toWorld(camRef.current, e.clientX, e.clientY);
      // Shift + press would otherwise extend the page's text selection up to the pointer
      if (e.shiftKey) e.preventDefault();
      dragRef.current = { id: i.id, with: along, shift: e.shiftKey, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, grab, start: { x: i.x, y: i.y }, limit: dragLimit(content, b), moved: false, frame: 0, last: 0 };
    } else if (e.shiftKey) {
      // Shift + press would otherwise extend the page's text selection up to the pointer
      e.preventDefault();
      lassoRef.current = [{ x: e.clientX, y: e.clientY }];
      setLasso(lassoRef.current);
    } else {
      panRef.current = { x: e.clientX, y: e.clientY, from: { x: e.clientX, y: e.clientY } };
      setPanning(true);
    }
    viewportRef.current!.setPointerCapture(e.pointerId);
  }

  /** Puts the dragged card under the pointer. */
  function place(d: Drag) {
    const w = toWorld(camRef.current, d.px, d.py);
    let p = { x: Math.round(d.start.x + w.x - d.grab.x), y: Math.round(d.start.y + w.y - d.grab.y) };
    if (d.note) {
      d.to = p;
      return setNotesMoved((m) => ({ ...m, [d.note!]: p }));
    }
    // workstreams stay inside their project
    if (byId(d.id)?.parent) p = { x: Math.max(PROJECT_PAD, p.x), y: Math.max(PROJECT_HEAD, p.y) };
    const by = { x: p.x - d.start.x, y: p.y - d.start.y };
    setMoved((m) => ({ ...m, [d.id]: p, ...shifted(d.with, by) }));
  }

  /** While a card is dragged, scrolls the view when the pointer is near an edge. */
  function edgeTick(now: number) {
    const d = dragRef.current;
    if (!d) return;
    const ms = d.last ? Math.min(50, now - d.last) : 0;
    d.last = now;
    const c = camRef.current;
    const side = sideNow();
    const view = { left: side.left, top: TOP, right: innerWidth - side.right, bottom: innerHeight };
    const next = edgeScroll(c, { x: d.px, y: d.py }, { x: d.x, y: d.y }, view, d.limit, ms);
    if (next.x !== c.x || next.y !== c.y) {
      setCam(next);
      place(d);
    }
    d.frame = requestAnimationFrame(edgeTick);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (connection) {
      const p = toWorld(camRef.current, e.clientX, e.clientY);
      const near = placed.filter(({ item }) => item.id !== connection.from && connectable(item)).map(({ item, b }) => ({ id: item.id, area: b.w * b.h, d: Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h)) })).filter((x) => x.d <= 8 / camRef.current.s).sort((a, b) => a.d - b.d || a.area - b.area)[0];
      setConnection({ ...connection, x: p.x, y: p.y, target: near?.id });
      return;
    }
    // the dots stay hidden while something is dragged, lassoed or panned, and while a card is open
    const busy = lassoRef.current || dragRef.current || panRef.current || focusRef.current?.type === 'card';
    if (busy) showHandle(null);
    else {
      const c = camRef.current;
      const near = placed.flatMap(({ item, b }) => (connectable(item) ? [{ id: item.id, b }] : []));
      showHandle(nearestHandle(near, toWorld(c, e.clientX, e.clientY), 16 / c.s));
    }
    if (lassoRef.current) {
      lassoRef.current = [...lassoRef.current, { x: e.clientX, y: e.clientY }];
      setLasso(lassoRef.current);
      return;
    }
    const d = dragRef.current;
    if (d) {
      d.px = e.clientX;
      d.py = e.clientY;
      if (!d.moved && Math.hypot(d.px - d.x, d.py - d.y) < 5) return;
      if (!d.moved) {
        setDragId(d.id);
        setDragWith(d.with.map((w) => w.id));
        d.moved = true;
        d.frame = requestAnimationFrame(edgeTick);
      }
      place(d);
      return;
    }
    // the view follows the pointer step by step, so after a stop at the content's edge it turns back at once
    const p = panRef.current;
    if (!p) return;
    const c = camRef.current;
    setCam(kept({ ...c, x: c.x + e.clientX - p.x, y: c.y + e.clientY - p.y }));
    p.x = e.clientX;
    p.y = e.clientY;
  }

  function onPointerUp(e: React.PointerEvent) {
    const l = lassoRef.current;
    if (l) {
      lassoRef.current = null;
      setLasso([]);
      const c = camRef.current;
      // a Shift + click on a project beside its workstreams marks the project
      if (l.every((p) => Math.hypot(p.x - l[0]!.x, p.y - l[0]!.y) < 5)) {
        const el = document.elementFromPoint(l[0]!.x, l[0]!.y)?.closest<HTMLElement>('.item');
        const i = el && byId(el.dataset.id!);
        if (i) setSelection((sel) => toggle(sel, markable(i)));
        return;
      }
      // what the lasso caught: each card whose middle lies inside, a workstream as its project
      const ids = [...new Set(placed.filter(({ b }) => inside({ x: c.x + (b.x + b.w / 2) * c.s, y: c.y + (b.y + b.h / 2) * c.s }, l)).map(({ item }) => markable(item)))];
      setSelection((sel) => addAll(sel, ids));
      return;
    }
    const d = dragRef.current;
    if (d) {
      cancelAnimationFrame(d.frame);
      dragRef.current = null;
      setDragId(null);
      setDragWith([]);
      const repo = d.note;
      if (repo) {
        if (d.moved && d.to)
          api.movePlanDirNote(repo, d.to).catch((err) => {
            console.error(err);
            setNotesMoved(({ [repo]: _, ...rest }) => rest);
          });
        return;
      }
      const i = byId(d.id);
      if (!i) return;
      if (d.moved) {
        for (const x of [i, ...d.with.flatMap((w) => byId(w.id) ?? [])])
          api.patch(x.id, { x: x.x, y: x.y }).catch((err) => {
            console.error(err);
            setMoved(({ [x.id]: _, ...rest }) => rest);
          });
        if (d.with.length && !moveKnown) {
          know(MOVE_MARKED_KNOWN);
          setMoveKnown(true);
        }
        if (!d.with.length && !markKnown) setMarkHint({ at: { x: e.clientX, y: e.clientY }, key: Date.now() });
      } else if (d.shift) setSelection((sel) => toggle(sel, markable(i)));
      else open(i);
      return;
    }
    const p = panRef.current;
    panRef.current = null;
    setPanning(false);
    // a click on the empty canvas lets go of what is marked
    if (p && Math.hypot(e.clientX - p.from.x, e.clientY - p.from.y) < 5) setSelection([]);
  }

  function onDoubleClick(e: React.MouseEvent) {
    // the pointer capture retargets the event to the viewport, so look at what is under the pointer
    if (focusRef.current || document.elementFromPoint(e.clientX, e.clientY)?.closest('.item, .plan-dir')) return;
    createAt(toWorld(camRef.current, e.clientX, e.clientY));
    if (!dblKnown) {
      know(DOUBLE_CLICK_KNOWN);
      setDblKnown(true);
      setNewHintOn(false);
    }
  }

  useEffect(() => {
    const vp = viewportRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (focusRef.current?.type === 'card') return;
      stopFlight();
      const c = camRef.current;
      if (e.ctrlKey || e.metaKey) {
        const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.s * Math.exp(-e.deltaY * 0.012)));
        setCam(kept({ s, x: e.clientX - (e.clientX - c.x) * (s / c.s), y: e.clientY - (e.clientY - c.y) * (s / c.s) }));
      } else setCam(kept({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [setCam]);

  // ---------------------------------------------------------------- keys
  // an approved card stops needing the owner with the click, before the snapshot says it lands
  const underwayRef = useRef(underway);
  underwayRef.current = underway;
  const yours = (i: Item) => needsYou(i) && !underwayRef.current[i.id];
  // answers in Obeya's sheet the owner has not seen: Obeya waits for them like a card
  const unread = kOn ? 0 : unreadAnswers(snapshot.talk);
  // what waits on each canvas, for the navigation: this one's as this page sees it, without what the
  // owner just acted on and without answers in Obeya's sheet while it is open
  const navWaiting = { ...waiting, [snapshot.canvas.id]: waitingIn({ items: items.filter((i) => !underway[i.id]), talk: kOn ? [] : snapshot.talk }) };
  const nav = {
    canvas: snapshot.canvas,
    canvases,
    waiting: navWaiting,
    underway: (id: string) => !!underway[id],
    open: openId ?? undefined,
    pinned,
    pinnable: !matchMedia(NARROW).matches && innerWidth - NAV_W - side.right >= NAV_CANVAS_MIN,
    onPin: pin,
    onOpen: (c: string, i: Item) => (c === snapshot.canvas.id ? void openFresh(i) : goTo(cardPath(c, i))),
    onObeya: (c: string) => (c === snapshot.canvas.id ? kOnRef.current || toggleKoordinator() : goTo(`${canvasPath(c)}?talk`)),
  };
  const proposalCount = snapshot.preferences.filter((p) => p.state === 'proposed').length + (snapshot.settingProposals?.length ?? 0);
  const doneCount = items.filter((i) => i.source === 'manual' && finished(i.state)).length;
  async function archiveDone() {
    const { ids } = await api.archiveDone();
    if (ids.length) showAck(t.archive.archivedMany(ids.length), () => Promise.all(ids.map((id) => api.unarchive(id))));
  }
  const attnLast = useRef<string | null>(null);
  /** The next card that needs the owner, in turn, and Obeya's sheet among them while an answer waits there. */
  function nextAttention() {
    const koordinator = !kOnRef.current && unreadAnswers(snapshotRef.current.talk) > 0;
    const all = itemsRef.current;
    const list: (Item | 'k')[] = [...all.filter(yours), ...(koordinator ? ['k' as const] : [])];
    if (!list.length || focusRef.current?.type === 'card') return;
    // the one after the card Tab opened last, by its place on the canvas: that card may need the owner no longer
    const key = (x: Item | 'k') => (x === 'k' ? 'k' : x.id);
    const at = (id: string | null) => (id === 'k' ? all.length : all.findIndex((i) => i.id === id));
    const last = at(attnLast.current);
    const next = list.find((x) => at(key(x)) > last) ?? list[0]!;
    attnLast.current = key(next);
    if (next === 'k') toggleKoordinator();
    else open(next);
  }
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const f = focusRef.current;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    // a field being edited handles its own keys (Esc cancels the edit there); any other field's Esc closes what it is in
    if (typing && (e.target as Element).closest('[data-esc]')) return;
    // the configuration over the page takes the keys until it closes, Esc closing it
    if (cOnRef.current) {
      if (e.key === 'Escape' && !document.querySelector('.setup')) {
        e.preventDefault();
        setCOn(false);
      }
      return;
    }
    // so does „Telefon verbinden“
    if (phoneOn) {
      if (e.key === 'Escape') setPhoneOn(false);
      return;
    }
    // so does the hint on how to create a task; Space and Enter press its button
    if (newHintOn || searchHintOn) {
      if (e.key === 'Escape') setNewHintOn(false), setSearchHintOn(false);
      return;
    }
    // the draft for Obeya's makers takes the keys until it closes, Esc closing it
    if (wishOn) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeWish();
      }
      return;
    }
    // the legend over the page takes the keys until it closes
    if (helpOn) {
      if (e.key === 'Escape' || e.key === '?') setHelpOn(false);
      // Space would press the focused button behind it
      if (e.key === 'Escape' || e.key === '?' || e.code === 'Space') e.preventDefault();
      return;
    }
    if (e.key === '?' && !typing) {
      e.preventDefault();
      setHelpNote(helpKnown ? undefined : 'gone');
      setHelpOn(true);
      if (!helpKnown) {
        know(HELP_KEY_KNOWN);
        setHelpKnown(true);
      }
      return;
    }
    // hold Space anywhere but in a text field to speak; the demo pauses while the owner talks, and a tap plays or pauses it
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      if (!e.repeat) press(true);
      return;
    }
    if (e.key === 'Escape' && connection) { setConnection(null); return; }
    if (e.key === 'Escape') {
      // a screenshot or demo shown large closes first, a card's diff, the queue's list and the navigation's; the card stays open
      if (document.querySelector('.lightbox, .demo-zoom, .queue-menu, .nav-menu, .diff-view')) return;
      // so does the quote of a message the owner was replying to: in the field with the cursor, the open card's, the sidebar's
      const quoting = [focusedDraft(), f?.type === 'card' || f?.type === 'project' ? cardDraft(f.id) : null, kOnRef.current ? OBEYA_DRAFT : null].find((k) => k && fieldOn(k) && replyOn(k));
      if (quoting) return setReply(quoting, null);
      // the archive's list closes after a card unfolded from it
      if (f?.type !== 'card' && aOnRef.current) return setAOn(false);
      if (f?.type !== 'card' && sOnRef.current) return setSOn(false);
      // what is marked lets go before a sheet closes, once the colour ring for it has closed
      if (f?.type !== 'card' && !typing && !ring && marked.length) return setSelection([]);
      if (typing) (e.target as HTMLElement).blur();
      if (f?.type === 'card') closeCard();
      else if (kOnRef.current) setKOn(false);
      else if (f?.type === 'project' && readingRef.current && sheetProject) readPlan(sheetProject, null);
      else if (f?.type === 'project') closeProject();
      return;
    }
    if (typing || f?.type === 'card' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '0') {
      setFocus(null);
      setSheetOn(false);
      fly(kept(overviewCam(all, sideNow())), 700);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      nextAttention();
    } else if (e.key === 'n' || e.key === 'c' || e.key === 'a' || e.key === '/') {
      // the key is the shortcut's alone: its character would land in the field the shortcut focuses (the archive's filter, the search)
      e.preventDefault();
      if (e.key === 'n') createAtCentre();
      else if (e.key === 'c') talkKoordinator();
      else if (e.key === '/') {
        toggleSearch();
        if (!searchKnown) {
          know(SEARCH_KEY_KNOWN);
          setSearchKnown(true);
        }
      } else toggleArchive();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', h, true);
    return () => removeEventListener('keydown', h, true);
  }, []);

  // ---------------------------------------------------------------- render
  const sheetProject = sheetId ? itemOrArchived(sheetId) : undefined;
  const sheetKids = !sheetProject ? [] : sheetProject.archivedAt ? archived.filter((i) => i.parent === sheetProject.id) : (kidsOf.get(sheetProject.id) ?? []);
  const deps = useMemo(() => (hoverId && !panning && !dragId ? depsOf(hoverId, items) : undefined), [hoverId, panning, dragId, items]);
  const waits = useMemo(() => waitsAmong(items), [items]);
  const waitKeys = useMemo(() => new Set(waits.map(([from, to]) => `${from}:${to}`)), [waits]);
  // the waits shown as lines: those the owner is removing go at once
  const shownWaits = waits.filter(([from, to]) => !removing.some((x) => x.key === `${from}:${to}`));
  const standsForId = (id: string) => (byId(id) ? standsFor(byId(id)!).id : id);
  const depOf = (id: string) => (!deps ? undefined : id === hoverId ? 'self' : deps.before.has(id) ? 'before' : deps.after.has(id) ? 'after' : undefined);
  // a workstream of a collapsed project points to where its project stands
  const at = new Map(placed.map((p) => [p.item.id, p.b]));
  // the card picked in the search lights up where it stands: on its folded project, or its edge indicator while out of sight
  const found = foundId ? byId(foundId) : undefined;
  const litId = found && standsFor(found).id;
  const edgeTargets = items.flatMap((item) => {
    const b = at.get(standsFor(item).id);
    return b && yours(item) && (focus?.type !== 'project' || item.parent === focus.id) ? [{ item, b }] : [];
  });
  let litEdge = litId ? edgeTargets.find((e) => standsFor(e.item).id === litId) : undefined;
  if (found && litId && !litEdge && at.has(litId)) edgeTargets.push((litEdge = { item: found, b: at.get(litId)! }));

  // the button for the conversation with Obeya: the rightmost in the bar; while its sidebar is open it
  // belongs to the sidebar, at its top corner, and closes it. It is one element that never moves to
  // another parent, so opening and closing the sidebar only changes its colour; in the bar a hidden
  // copy keeps its room
  const talkButton = (
    <button className={kOn ? 'pill kpill talk-pill on' : 'pill kpill talk-pill'} title={t.koordinator.buttonTitle} aria-label={t.koordinator.button} onClick={talkKoordinator}>
      <TalkIcon />
      {unread > 0 && (
        <span className="n unread" title={t.koordinator.unreadCount(unread)}>
          {unread}
        </span>
      )}
      {proposalCount > 0 && (
        <span className="n prop" title={t.koordinator.proposalsCount(proposalCount)}>
          {proposalCount}
        </span>
      )}
    </button>
  );

  return (
    <HoldToTalk.Provider value={holdToTalk}>
      <div
        className={[cam.s < FAR && 'z-far', resizing && 'resizing'].filter(Boolean).join(' ') || undefined}
        style={
          {
            '--sheet-w': `${sheetW.sheet}px`,
            '--read-w': `${sheetW.read}px`,
            '--side': `${side.right}px`,
            '--left': `${side.left}px`,
          } as React.CSSProperties
        }
      >
        <div
          id="viewport"
          ref={viewportRef}
          className={[panning && 'panning', ring && 'still'].filter(Boolean).join(' ') || undefined}
          style={{ backgroundSize: `${22 * cam.s}px ${22 * cam.s}px`, backgroundPosition: `${cam.x}px ${cam.y}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        >
          <div id="world" style={{ transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.s})` }}>
            <TerritoryLayer {...territories} selected={placed.filter((p) => (ring ? ring.ids : marked).includes(p.item.id)).map((p) => p.b)} />
            <Links placed={placed} waits={shownWaits} standsFor={standsForId} />
            <DepLinks placed={placed} waits={shownWaits} lit={deps?.edges ?? []} standsFor={standsForId} s={cam.s}>
              {/* an arrow the owner drew: under the pointer, a trash button that removes it, where no card
                  covers it; the button and the band that shows it keep their size on screen at every zoom */}
              {placed.flatMap(({ item, b }) => (connectable(item) ? item.manualDependsOn ?? [] : []).filter((from) => waitKeys.has(`${from}:${item.id}`) && !removing.some((x) => x.key === `${from}:${item.id}`)).flatMap((from) => {
                const a = placed.find((p) => p.item.id === from && connectable(p.item))?.b;
                if (!a) return [];
                const r = 13 / cam.s;
                const { x, y } = linkSpot(a, b, depHead(cam.s), cardBoxes, r);
                return [<g className="manual-edge" key={`${from}:${item.id}`}>
                  <path className="manual-hit" d={linkPath(a, b, depHead(cam.s))} strokeWidth={22 / cam.s} />
                  <foreignObject x={x - r} y={y - r} width={2 * r} height={2 * r}><button title={t.deps.remove} aria-label={t.deps.remove} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); removeDependency(from, item); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" /></svg></button></foreignObject>
                </g>];
              }))}
            </DepLinks>
            <svg className="manual-deps" width="1" height="1">
              <defs><marker id="manual-arrow" viewBox="0 0 9 8" refX="0.3" refY="4" markerWidth={6} markerHeight={(6 * 8) / 9} markerUnits="strokeWidth" orient="auto"><path d="M0,0 L9,4 L0,8 z" /></marker><marker id="ghost-arrow" viewBox="0 0 9 8" refX="9" refY="4" markerWidth={6} markerHeight={(6 * 8) / 9} markerUnits="strokeWidth" orient="auto"><path d="M0,0 L9,4 L0,8 z" /></marker></defs>
              {connection && (() => { const a = placed.find((p) => p.item.id === connection.from)?.b; if (!a) return null; const start = handleAt(a, connection.side); const b = placed.find((p) => p.item.id === connection.target)?.b; const path = b ? linkPath({ ...start, w: 0, h: 0 }, b, depHead(cam.s)) : `M${start.x},${start.y} L${connection.x},${connection.y}`; return <path className="manual-ghost" d={path} strokeWidth={depWidth(cam.s)} markerEnd={b ? "url(#manual-arrow)" : "url(#ghost-arrow)"} />; })()}
            </svg>
            {placed.map(({ item, b }) =>
              item.kind === 'project' ? (
                <ProjectView key={item.id} item={item} b={b} lit={item.id === litId} kids={kidsOf.get(item.id) ?? []} replies={repliesIn.get(item.id) ?? 0} els={els} onStartAll={startAll} onArrange={arrange} onCollapse={collapse} onOpen={openCard} />
              ) : (
                <CardView
                  key={item.id}
                  item={item}
                  b={b}
                  lifted={item.id === openId}
                  dragging={item.id === dragId || dragWith.includes(item.id)}
                  pop={item.id === popId}
                  lit={item.id === litId}
                  prototyped={prototyped.has(item.id)}
                  showRepo={snapshot.canvas.repos.length > 1}
                  els={els}
                  onStart={startCard}
                  onArchive={archiveCard}
                  dep={depOf(item.id)}
                  underway={underway[item.id] ?? (item.landing ? t.approving : undefined)}
                  onHover={setHoverId}
                />
              ),
            )}
            {placed.filter(({ item }) => connectable(item)).map(({ item, b }) => <div key={`handles:${item.id}`} data-id={item.id} className={`connection-handles ${cardClass(item, underway[item.id]).replace(/^card\s*/, '')}${depOf(item.id) ? ' dep-highlight' : ''}${connection?.target === item.id ? ' target' : ''}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
              {SIDES.map((side) => <button key={side} className={`connection-dot ${side}${!connection && handle?.id === item.id && handle.side === side ? ' visible' : ''}`} title={t.deps.connect} aria-label={t.deps.connect} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); const p = toWorld(camRef.current, e.clientX, e.clientY); setConnection({ from: item.id, side, ...p }); }} />)}
            </div>)}
            {planDirs?.map((d, n) => (
              <PlanDirNote
                key={d.repo}
                dir={d}
                b={notes[n]!}
                dragging={dragId === `note:${d.repo}`}
                {...(snapshot.canvas.repos.length > 1 ? { repo: snapshot.canvas.repos.find((r) => r.id === d.repo)?.name ?? d.repo } : {})}
                onPrepare={preparePlanDoc}
                onOpen={(id) => {
                  const i = byId(id);
                  if (i) open(i).catch(console.error);
                }}
                onChange={() => {
                  showCanvasesSection();
                  setCOn(true);
                }}
                onHide={() => hideNote(d)}
              />
            ))}
            <GroupNames shapes={territories.shapes} />
          </div>
        </div>
        {/* on an empty canvas the camera centres the notes on the plan directories: the hint stands above them, with space between */}
        {!items.length && (
          <div className={notes.length ? 'empty above-note' : 'empty'} {...(notes.length ? { style: { top: cam.y + Math.min(...notes.map((b) => b.y)) * cam.s - 48 } } : {})}>
            <p className="none">{t.empty.none}</p>
            <p>{t.empty.speak}</p>
            <p className="where">{t.empty.where}</p>
            <p>{t.empty.click}</p>
          </div>
        )}
        {!ring && <Lasso pts={lasso} />}
        {markedBox && !ring && !dragId && !lasso.length && focus?.type !== 'card' && (
          <Marked
            {...markedAt(markedBox)}
            count={marked.length}
            hint={!moveKnown && marked.length > 1}
            onGroup={(at) => setRing({ at, ids: marked })}
          />
        )}
        {markHint && <MarkHint key={markHint.key} at={markHint.at} />}
        {connection && !depKnown && (
          <p id="dephint" style={{ left: cam.x + connection.x * cam.s, top: cam.y + connection.y * cam.s }}>
            {connection.target ? t.deps.waits(titleOf(connection.from), titleOf(connection.target)) : t.deps.pick(titleOf(connection.from))}
          </p>
        )}
        {ring && (
          <Ring
            at={ring.at}
            count={ring.ids.length}
            groups={snapshot.groups}
            open={openPerGroup(snapshot.items)}
            onPick={(group) => assignGroup({ group })}
            onCreate={(name) => assignGroup({ name })}
            onDelete={deleteGroup}
            onClose={() => setRing(null)}
          />
        )}
        {(!focus || focus.type === 'project') && <Edges cam={cam} targets={edgeTargets} side={side} onOpen={open} lit={litEdge?.item.id} cover={sOn ? searchCover : undefined} />}
        {/* in the app on a Mac the bar is the window's title bar: it moves the window (app/src/main.rs); beside the pinned navigation, the traffic lights sit in that */}
        <header id="bar" ref={barRef} {...(window.obeyaApp?.platform === 'macos' ? { className: side.left ? 'titlebar beside-nav' : 'titlebar', 'data-tauri-drag-region': '' } : {})}>
          <Wordmark height={22} />
          <span className="bar-sign">
            <Sign size={24} />
          </span>
          {/* beside the pinned navigation the bar heads the canvas with its name, which the navigation's button gave before */}
          {side.left ? (
            <h1 className="bar-canvas" title={snapshot.canvas.name} {...(window.obeyaApp?.platform === 'macos' ? { 'data-tauri-drag-region': '' } : {})}>
              {snapshot.canvas.name}
            </h1>
          ) : (
            <NavPill {...nav} />
          )}
          <SearchPill
            on={sOn}
            teach={!searchKnown && items.length > 5}
            onTeach={() => focusRef.current?.type !== 'card' && setSearchHintOn(true)}
            onClose={() => setSOn(false)}
            held={focus?.type === 'card'}
            items={items}
            archived={archived}
            onOpen={openFound}
            onLight={setFoundId}
            els={archiveEls}
            onCover={setSearchCover}
          />
          <ArchivePill
            on={aOn}
            onToggle={toggleArchive}
            onClose={() => setAOn(false)}
            held={focus?.type === 'card'}
            archived={archived}
            done={doneCount}
            onOpen={open}
            onArchiveDone={() => archiveDone().catch(console.error)}
            els={archiveEls}
            keep={focus?.type === 'card' ? focus.id : archiveKeep}
            icon={<BarIcon d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" />}
          />
          <QueuePill items={items} onOpen={open} />
          {!dblKnown && (
            <button className="pill new-card" title={t.newCard} onClick={() => focusRef.current?.type !== 'card' && setNewHintOn(true)}>
              + <span className="lbl">{t.newCard}</span>
            </button>
          )}
          {!helpKnown && (
            <HelpButton
              on={helpOn}
              onClick={() => {
                setHelpNote('button');
                setHelpOn(!helpOn);
              }}
            />
          )}
          <div className="right">
            {!online && <div className="pill offline">{t.offline}</div>}
            {oldBun && <OldBunPill version={oldBun} />}
            {online && restart && <RestartPill restart={restart} items={items} />}
            {online && update && restart?.reason !== 'update' && <UpdatePill update={update} />}
            {online && source && <SourcePill source={source} />}
            {online && usage && <UsagePill usage={usage} />}
            {snapshot.workspaces && <WorkspacesPill pools={snapshot.workspaces} canvas={snapshot.canvas} canvases={canvases} items={items} onOpen={(i) => void openFresh(i)} onElsewhere={(c, card) => goTo(cardPath(c, card))} onTake={takeWorkspace} onKeep={keepWorkspace} />}
            <button className={cOn ? 'pill kpill config on' : 'pill kpill config'} title={t.config.button} onClick={toggleConfig}>
              <BarIcon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              <span className="lbl">{t.config.button}</span>
              {configProblems > 0 && (
                <span className="n err" title={t.config.problemCount(configProblems)}>
                  {configProblems}
                </span>
              )}
            </button>
            {!kOn && (
              <div className="talk-room" aria-hidden>
                {talkButton}
              </div>
            )}
          </div>
        </header>
        <NavSheet on={side.left > 0} {...nav} />
        <Minimap
          cam={cam}
          side={side}
          all={all}
          placed={placed}
          territories={territories.shapes}
          onJump={(wx, wy) => !focusRef.current && fly(viewOn(wx, wy), 500)}
          onFollow={(wx, wy) => !focusRef.current && chase(camRef.current, viewOn(wx, wy), setCam)}
        />
        <div id="dim" className={dim ? 'on' : undefined} onClick={() => closeCard()} />
        {helpOn && <Help note={helpNote} onClose={() => setHelpOn(false)} />}
        <WishDialog />
        {newHintOn && <HowToHint label={t.newCard} text={t.newCardHint.text} onClose={() => setNewHintOn(false)} />}
        {searchHintOn && <HowToHint label={t.search.field} text={t.search.hint} onClose={() => setSearchHintOn(false)} />}
        <div id="panel" ref={panelRef}>
          {openItem && <CardNumber n={openItem.number} className="sheet-no" />}
          <button className="close" title={t.close} onClick={() => closeCard()}>
            ✕
          </button>
          <div className="inner card-sheet" ref={innerRef}>
            <div className="content">
              {openItem && (
                <Cards.Provider value={{ items, open: (i) => void openFresh(i) }}>
                <Detail
                  key={openItem.id}
                  item={openItem}
                  all={items}
                  repos={snapshot.canvas.repos}
                  parent={openItem.parent ? itemOrArchived(openItem.parent) : undefined}
                  from={openItem.from ? itemOrArchived(openItem.from) : undefined}
                  onReadPlan={(project, mark) => readPlan(project, { mark })}
                  onClones={(repo, field) => {
                    showRepoClones({ canvas: snapshot.canvas.id, repo, field });
                    setCOn(true);
                  }}
                  onDemoSites={() => {
                    showDemosSection();
                    setCOn(true);
                  }}
                  onEdit={onEdit}
                  flush={flushEdit}
                  onDelete={deleteOpen}
                  onDone={onDone}
                  onTell={(text, images, field, replyTo) => tellTyped(text, images, { card: openItem.id }, field, replyTo)}
                />
                </Cards.Provider>
              )}
            </div>
          </div>
        </div>
        <ConfigDialog
          on={cOn}
          page={snapshot.canvas.id}
          onClose={() => setCOn(false)}
          onSetup={() => setSetupOn(true)}
          onTalk={talkFromConfig}
          onProblems={setConfigProblems}
          revs={configRevs}
          onConnect={() => (setCOn(false), setPhoneOn(true))}
          onAsk={(text, canvas) => void told.tell(t.voice.reading(t.voice.koordinator), undefined, () => (canvas ? api.commandOn(canvas, text) : api.command(text, null, { place: placeNow() })))}
        />
        {setupOn && <Setup onClose={() => setSetupOn(false)} />}
        {phoneOn && (
          <PhoneDialog
            onClose={() => setPhoneOn(false)}
            onSection={() => {
              setPhoneOn(false);
              showDevicesSection();
              setCOn(true);
            }}
          />
        )}
        <KoordinatorSheet on={kOn} canvas={snapshot.canvas.id} items={items} preferences={snapshot.preferences} settings={snapshot.settingProposals ?? []} repos={snapshot.canvas.repos} talk={snapshot.talk} reshare={snapshot.reshare} onOpen={(i) => void openFresh(i)} onTell={(text, images, replyTo) => tellTyped(text, images, null, undefined, replyTo)} onConfig={(repo, setting) => {
            showRepoClones({ canvas: snapshot.canvas.id, repo, field: 'settings', setting });
            setCOn(true);
          }} />
        <PushToTalk
          phase={ptt.phase}
          level={ptt.level}
          flat={ptt.flat}
          target={target}
          field={draftFor(where())}
          onDown={() => press(false)}
        />
        <Sheet
          project={sheetProject}
          kids={sheetKids}
          all={items}
          on={sheetOn}
          reading={reading}
          onOpen={open}
          onRead={(r) => sheetProject && readPlan(sheetProject, r)}
          onStartAll={startAll}
          onArrange={arrange}
          els={sheetEls}
          version={snapshot}
        />
        <div id="talk-docked" className={kOn ? 'on' : undefined}>
          {talkButton}
        </div>
        {gripOn && !kOn && (
          <button id="sheet-close" title={t.close} onClick={() => (sheetOn ? closeProject() : setKOn(false))}>
            ✕
          </button>
        )}
        <div
          id="sheet-grip"
          className={gripOn ? 'on' : undefined}
          style={{ right: sheetW[gripKind] - 6 }}
          title={t.sheetGrip}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onDoubleClick={() => setWidths((ws) => ({ ...ws, [gripKind]: gripKind === 'sheet' ? SHEET_W : null }))}
        />
        {/* commands on their way and confirmations, stacked above the microphone */}
        <div id="acks">
          <ToldList told={told.told} open={focus?.type === 'card' ? focus.id : undefined} onUndo={told.undo} />
          {ackLine}
        </div>
      </div>
    </HoldToTalk.Provider>
  );
}

/**
 * Where the unfolded card sits: in the middle of the canvas between the panels `side`, reaching over
 * the sheet where the canvas is too narrow for it, as tall as its content needs up to a limit, beyond
 * which it scrolls. Lays the content out at the final width
 * to measure it, so call it with the content rendered.
 */
function panelRect(i: Item, inner: HTMLElement, side: Sides) {
  const tall = i.state !== 'planned' && i.state !== 'proposal';
  // a card with a conversation beside what it is about (an idea, a proposal, a task an agent worked on) gets the room of the mock's demo panel
  const wide = split(i);
  // a task an agent works on without a result yet is its conversation alone, and only as wide
  const want = wide ? 1600 : talkAlone(i) ? TALK_W : tall ? 980 : 900;
  // the sheet lies dimmed under an open card, so a card wider than the canvas reaches over it; the
  // pinned navigation, which stays usable beside it, limits it unless the window leaves less than a
  // conversation's width beside the navigation
  const room = innerWidth - side.left - 80;
  const W = Math.min(want, Math.max(room, Math.min(TALK_W, innerWidth - 80)));
  inner.style.width = `${W}px`;
  inner.style.removeProperty('--pb');
  inner.style.overflowY = '';
  const pad = getComputedStyle(inner);
  const base = parseFloat(pad.paddingBottom);
  const content = inner.firstElementChild as HTMLElement;
  // heights unrounded: a content half a pixel higher than its panel scrolls it
  const height = (e: HTMLElement) => e.getBoundingClientRect().height;
  const mic = (document.getElementById('ptt')?.getBoundingClientRect().top ?? innerHeight) - MIC_GAP;
  // a split (an idea, a proposal, a task) grows with its taller column up to the room from the top
  // of the window down to the microphone: beyond that its columns scroll, and the panel itself does not
  const fill = content.querySelector<HTMLElement>('.split');
  if (fill) {
    fill.style.minHeight = fill.style.maxHeight = '';
    if (!matchMedia(NARROW).matches) {
      const rest = height(content) - height(fill) + parseFloat(pad.paddingTop) + base;
      const room = Math.floor(mic - PANEL_TOP_OVER - rest);
      fill.style.minHeight = `${SPLIT_MIN}px`;
      fill.style.maxHeight = `${Math.max(SPLIT_MIN, room)}px`;
      // nothing to scroll to, so no scrollbar either; on a low window the panel scrolls past the microphone
      if (room >= SPLIT_MIN) inner.style.overflowY = 'hidden';
    }
  }
  const need = height(content) + parseFloat(pad.paddingTop) + base;
  // any other panel grows with its content up to the same room and scrolls beyond it; only a window
  // too low for SPLIT_MIN lets it reach under the microphone
  const toMic = Math.floor(mic - PANEL_TOP_OVER);
  const max = Math.min(fill ? Infinity : Math.max(toMic, SPLIT_MIN), innerHeight - PANEL_TOP_OVER - PANEL_BOTTOM);
  // in the middle of the window below the top bar, ending above the microphone. A panel too tall for
  // the room below the bar reaches over the bar, which the dim covers while a card is open, so a low
  // window still shows much of the card
  const top = (H: number) => Math.max(PANEL_TOP_OVER, Math.min(Math.max(PANEL_TOP, (innerHeight - H) / 2), mic - H));
  // the microphone sits over the bottom of a tall panel: the content gets room below it to scroll
  // up past the microphone, and the panel grows by that room where it can
  const under = (H: number) => Math.max(0, top(H) + H - mic - base);
  let H = Math.min(Math.ceil(need), max);
  H = Math.min(Math.ceil(need + under(H)), max);
  const extra = under(H);
  // through --pb, which the card's sticky row of decisions reaches down over too (styles.css)
  if (extra) inner.style.setProperty('--pb', `${base + extra}px`);
  // in the middle of the canvas where it fits there, else as near to it as the window allows
  const lo = W <= room ? side.left + 40 : 40;
  return { left: `${Math.max(lo, Math.min(midX(side) - W / 2, innerWidth - W - 40))}px`, top: `${top(H)}px`, width: `${W}px`, height: `${H}px` };
}

/** A panel holding a conversation alone: its column at its widest (560 px, styles.css) and the panel's padding. */
const TALK_W = 640;
/** Below this the split's columns stack (styles.css) and the panel scrolls as a whole. */
const NARROW = '(max-width: 760px)';

/** Where a panel starts at the top: below the bar. */
const PANEL_TOP = 64;
/** Where a panel too tall for the room below the bar starts instead, over the bar. */
const PANEL_TOP_OVER = 12;
/** The least room a panel keeps at the bottom of the window, on a window too low to end it above the microphone. */
const PANEL_BOTTOM = 46;
/** The least height of a split (an idea, a proposal, a task) and of a panel that scrolls: on a low window the panel reaches under the microphone instead. */
const SPLIT_MIN = 320;

/** Room between the panel's content and the microphone. */
const MIC_GAP = 12;

const rect = (r: DOMRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** Camera centred on the middle of `b` at scale `s` between the panels `side`, ignoring the top bar (the unfold is centred there too). */
const centreOnPoint = (b: Bounds, s: number, side: Sides): Cam => ({ s, x: midX(side) - (b.x + b.w / 2) * s, y: innerHeight / 2 - (b.y + b.h / 2) * s });

/** State with a ref that holds the value set last, for what reads it before the next render. */
function useLive<T>(init: T | (() => T)): [T, (v: T) => void, { readonly current: T }] {
  const [v, setV] = useState(init);
  const ref = useRef(v);
  const set = useCallback((n: T) => {
    ref.current = n;
    setV(n);
  }, []);
  return [v, set, ref];
}

/** A button's icon in the top bar, shown in place of its label where the bar is narrow (beside a wide sheet). */
function BarIcon({ d }: { d: string }) {
  return (
    <svg className="bar-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

