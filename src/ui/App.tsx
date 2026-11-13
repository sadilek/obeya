// The canvas: camera, drag, unfold-in-place and the plan sheet.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { cardTag } from '../core/card-number';
import { type Bounds, boundsOf, CARD_SIZE, onCanvas, type Place, PROJECT_HEAD, PROJECT_PAD, unionBounds } from '../core/layout';
import type { CanvasInfo, CanvasSnapshot, CardPatch, Item, PendingRestart, AppUpdate, SourceUpdate, Usage } from '../core/types';
import { archivedWithDone, nameless, needsYou, titleFrom, unreadAnswers, unreadPerProject, type Waiting, waitingIn } from '../core/card';
import type { ConfigProblem } from '../core/config';
import { api, beforeReload, type CanvasFeed, cardsOn, onNotice, quietAtStart, reportFocus, setCanvas, useCanvas } from './api';
import { goTo, onSwitch } from './switch';
import { GroupNames, TerritoryLayer, useGroupNames, useTerritories } from './groups';
import { besideSheet, BOTTOM, type Cam, camFor, centreOn, chase, dragLimit, edgeScroll, FAR, flying, flyTo, keepInView, MAX_ZOOM, midX, MIN_ZOOM, NO_SIDES, overviewCam, placeIn, shows, type Sides, stopFlight, TOP, toWorld } from './camera';
import { plain } from './markdown';
import { CardNumber } from './cardNumber';
import type { ActDone, Pending } from './cardSheet';
import { CardLog } from './conversation';
import { Detail } from './detail';
import { Cards } from './message';
import type { Heard, Where } from './api';
import { replyOn, setReply } from './reply';
import { ArchivePill } from './archive';
import { useBarFit } from './barFit';
import { UsagePill } from './usage';
import { CostsPill } from './costs';
import { ConfigDialog, Problem, showCanvasesSection, showDemosSection, showDevicesSection, showRepoClones } from './config';
import { PhoneDialog } from './access';
import { Setup } from './setup';
import { Phone, phoneView } from './phone';
import { CoordinatorSheet } from './coordinator';
import { QueuePill } from './queue';
import { SearchPill } from './search';
import { depsOf, holdsAmong, loopsAmong, waitKinds, waitsAmong } from './deps';
import { collect, keep, type Kept, leaveSheet, restore, type SideSheet, takeKept, takeSheetLeft } from './keep';
import { Sign, Wordmark } from './logo';
import { DOUBLE_CLICK_KNOWN, Help, HelpButton, HELP_KEY_KNOWN, HowToHint, SEARCH_KEY_KNOWN } from './help';
import { local, readJson, writeJson, useKnown } from './stored';
import { movesWith, shifted } from './selection';
import { closeWish, keepWish, openWish, useWish, WishDialog } from './wish';
import { PlanDirNote, planDirBoxes, useHiddenEmptyNotes } from './planDirs';
import { pastedShots, pastedText } from './pasteHint';
import { filesTo, imageFiles } from './shots';
import { cardDraft, drafted, fieldOn, focusedDraft, insertPasted, keepDrafts, fieldOrMic, OBEYA_DRAFT, takesImages } from './draft';
import { HoldToTalk, PushToTalk, SPACE_SHOWS_MS, TAP_MS, ToldList, usePushToTalk, useTold } from './voice';
import { videoOf } from './spot';
import { CardView, shownState, Edges, Minimap, TalkIcon } from './parts';
import { DepLinks, Links } from './links';
import { OldBunPill, RestartPill, SourcePill, UpdatePill, WorkspacesPill } from './pills';
import { ProjectView, Sheet } from './project';
import { useSheetWidths } from './sheetWidth';
import { landingLabel, t } from './strings';
import { loadPinned, NAV_CANVAS_MIN, NAV_W, NavPill, NavSheet, savePinned } from './nav';
import { canvasPath, cardPath, queryWithout, readAddress } from './address';
import { beingWritten, split, talkAlone } from './cardState';
import { showNotice, tellers, useAck, voiceTarget } from './tell';
import { followDone, useCardEdits } from './cardHost';
import { useCanvasAddress } from './canvasAddress';
import { useCanvasActions } from './canvasActions';
import { MarkingLayer, useMarking } from './marking';
import { ConnectionDots, ConnectionGhost, ConnectionHint, ManualEdges, useDepDrawing } from './depDraw';
import { captionKey } from './walkthrough';
import { useLatest, useLive, useStable } from './latest';
import { type Pos, useOptimisticItems } from './optimistic';
import { useArchivedCards } from './archived';

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
  const canvasesRef = useLatest(canvases);
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
 * and creates one; where the configured ones did not start, the page says why, and "Try
 * again" opens the canvases once one runs.
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

/** The canvases the phone view last had, for when the machine does not answer. */
const KEPT_CANVASES = 'obeya-phone-canvases';
/** Set once the owner has drawn their first arrow between cards: what an arrow does no longer shows while drawing. */
const keepCanvases = (list: CanvasInfo[]) => void writeJson(local, KEPT_CANVASES, list);
function keptCanvases(): CanvasInfo[] | null {
  const list = readJson<CanvasInfo[]>(local, KEPT_CANVASES);
  return list?.length ? list : null;
}

/** While the page loads, and after a restart until the canvas is back: the sign in the middle, above "offline" when the server cannot be reached. */
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
/**
 * A card dragged (or the note on a plan directory, by its repository, with where it is now);
 * `with`: the other marked cards, which move by as much; `shift`: a Shift + click marks the card
 * instead of opening it.
 */
type Drag = { id: string; note?: string; to?: Pos; with: { id: string; start: Pos }[]; shift: boolean; x: number; y: number; px: number; py: number; grab: Pos; start: Pos; limit: Bounds; moved: boolean; frame: number; last: number };

// opening a card takes FLY_MS + UNFOLD_MS (300 ms) and closing the same: fast, yet still a visible move
const FLY_MS = 130;
const UNFOLD_MS = 170;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  // a dragged card follows the world point it was picked up at, also while the view scrolls under it
  const dragRef = useRef<Drag | null>(null);
  const { items, itemsRef, setMoved, setFolded, setPending, underway, setUnderway, notesMoved, setNotesMoved } = useOptimisticItems(snapshot, dragRef);
  const snapshotRef = useLatest(snapshot);
  // the workstreams of a collapsed project are not on the canvas: its marks stand for them
  const placed = useMemo(() => onCanvas(items).map((item) => ({ item, b: boundsOf(item, items) })), [items]);
  const territories = useTerritories(placed, snapshot.groups);
  const kidsOf = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of items) if (i.parent) m.set(i.parent, [...(m.get(i.parent) ?? []), i]);
    return m;
  }, [items]);
  const repliesIn = useMemo(() => unreadPerProject(snapshot.talk), [snapshot.talk]);
  const [noteHidden, hideNote] = useHiddenEmptyNotes(snapshot.canvas.id);
  // a fresh array only when what is shown changes: the camera keeps the notes in sight
  const planDirs = useMemo(() => {
    const shown = snapshot.planDirs?.filter((d) => !noteHidden(d)).map((d) => (notesMoved[d.repo] ? { ...d, at: notesMoved[d.repo] } : d));
    return shown?.length ? shown : undefined;
  }, [snapshot.planDirs, noteHidden, notesMoved]);
  const notes = useMemo(() => (planDirs ? planDirBoxes(planDirs, placed) : []), [planDirs, placed]);
  const all: Bounds = useMemo(() => unionBounds([...placed.map((p) => p.b), ...notes]) ?? { x: 0, y: 0, w: 1000, h: 600 }, [placed, notes]);
  // what the view keeps in sight: the cards, a project only while it shows none, and the notes on plan directories
  const content = useMemo(() => [...placed.filter(({ item }) => item.collapsed || !kidsOf.has(item.id)).map((p) => p.b), ...notes], [placed, kidsOf, notes]);
  const contentRef = useLatest(content);
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
    const saved = readJson<Cam>(local, camKey(snapshot.canvas.id));
    // saved as it would be without a sheet, which none is before the page opens one
    if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite)) return keepInView(saved, content, { left: 0, top: TOP, right: innerWidth, bottom: innerHeight - BOTTOM });
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
    const h = setTimeout(() => writeJson(local, camKey(snapshot.canvas.id), besideSheet(cam, camSide.current, NO_SIDES)), 300);
    return () => clearTimeout(h);
  }, [cam, snapshot.canvas.id]);
  const groupNames = useGroupNames(territories.shapes, placed, notes, cam.s);
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
  const { sheetW, resizing, gripFor } = useSheetWidths();
  const sheetWRef = useLatest(sheetW);
  const [kOn, setKOn, kOnRef] = useLive(false);
  // the archive's list and the search drop down from the bar, one at a time
  const [drop, setDrop, dropRef] = useLive<'archive' | 'search' | null>(null);
  /** Closes the archive's list or the search, where that is what is down. */
  const shut = (d: 'archive' | 'search') => dropRef.current === d && setDrop(null);
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
  const toggleCoordinator = () => {
    setKOn(!kOn);
    if (!kOn && focusRef.current?.type === 'project') closeProject(false);
  };
  /** The sheet as the owner opens it to talk (its button, `C`): the field under the conversation takes the cursor. */
  const talkCoordinator = () => {
    toggleCoordinator();
    if (!kOn) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#ksheet .tell textarea')?.focus({ preventScroll: true }));
  };
  const toggleArchive = () => setDrop(dropRef.current === 'archive' ? null : 'archive');
  const toggleSearch = () => setDrop(dropRef.current === 'search' ? null : 'search');
  // the configuration is a dialog over the page: what is open behind it stays as it was
  const toggleConfig = () => setCOn(!cOnRef.current);
  // asking Obeya about the configuration: its conversation in place of the dialog, ready to type into
  const talkFromConfig = () => {
    setCOn(false);
    if (!kOn) talkCoordinator();
  };
  const [helpOn, setHelpOn] = useState(false);
  // "Connect a phone", from the section "Other devices" of the configuration
  const [phoneOn, setPhoneOn] = useState(false);
  const wishOn = useWish().open;
  // the bar's `?` button stays until the owner opened the legend with the key; the legend's foot says so
  const [helpKnown, knowHelp] = useKnown(HELP_KEY_KNOWN);
  const [helpNote, setHelpNote] = useState<'button' | 'gone'>();
  // the bar's button for a new task stays until the owner created one by double-click; it only says how
  const [dblKnown, knowDbl] = useKnown(DOUBLE_CLICK_KNOWN);
  const [newHintOn, setNewHintOn] = useState(false);
  // the bar's button that teaches `/`, until the owner used it, and the hint it opens
  const [searchKnown, knowSearch] = useKnown(SEARCH_KEY_KNOWN);
  const [searchHintOn, setSearchHintOn] = useState(false);
  const [setupOn, setSetupOn] = useState(false);
  // what is wrong in the configuration as saved, marked on its button; read when the page loads,
  // after a save in the dialog, when a repository's settings change on its default branch, which
  // the canvas counts in its repositories (`configRev`), and when a canvas or repository does not
  // start, which the canvases count (theirs, and which of them run)
  const [configProblems, setConfigProblems] = useState(0);
  const configRevs = [...snapshot.canvas.repos.map((r) => `${r.id}:${r.configRev ?? 0}`), ...canvases.map((c) => `${c.id}:${c.configRev ?? 0}`), `${snapshot.canvas.configRev ?? 0}`].join(' ');
  useEffect(() => void api.configCheck().then((c) => setConfigProblems(c.problems.length), console.error), [configRevs]);
  // the archived cards the page holds; the one open, or the project it is in, closes once it left the archive
  const archived = useArchivedCards(snapshot.archive, itemsRef, () => [focus?.id, focus?.type === 'card' ? focus.project?.id : undefined, sheetId]);
  /** The card `id`, on the canvas or else in the archive. */
  const itemOrArchived = (id: string) => byId(id) ?? archived.get(id);
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

  // edits of the open card, saved shortly after typing stops, and at once on leaving for another canvas
  const edits = useCardEdits(() => focusRef.current?.id);
  const flushEdit = edits.flush;
  useEffect(() => () => beingWritten.clear(), []);
  // a call about a card goes to its canvas, even once the page shows another
  useEffect(() => cardsOn(snapshot.canvas.id, snapshot.items.map((i) => i.id)), [snapshot]);
  // what the open card holds as typed, which the snapshot may not carry yet
  const openDraft = useRef<Pick<Item, 'kind' | 'title' | 'body' | 'images'>>({ kind: 'task', title: '', body: '' });
  const onEdit = (p: CardPatch) => {
    if (!focusRef.current) return;
    if (p.title !== undefined) openDraft.current.title = p.title;
    if (p.body !== undefined) openDraft.current.body = p.body;
    if (p.images !== undefined) openDraft.current.images = p.images;
    edits.onEdit(p);
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
    shut('search');
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
    address.opens(i, f ? itemOrArchived(f.id) : undefined);
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

  // the card says it is under way until the snapshot moves it on
  const onDone = (d: ActDone, p?: Pending) =>
    followDone(d, p, {
      close: () => closeCard({ keepUntitled: true }),
      showAck,
      showWait,
      underway: (card, what) => setUnderway(({ [card]: _, ...rest }) => (what ? { ...rest, [card]: what } : rest)),
    });

  /** Folds the open card; `onward` where another opens in its place next, which takes over its address. */
  async function closeCard({ keepUntitled = false, onward = false } = {}) {
    const f = focusRef.current;
    const panel = panelRef.current;
    if (f?.type !== 'card' || !panel) return;
    if (!onward) address.closes(f.project ? itemOrArchived(f.project.id) : undefined);
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
    address.opens(p, undefined);
    setSheetId(p.id);
    setReading(r);
    setSheetOn(true);
    setKOn(false);
    shut('archive');
    if (inView) await flyOrJump(camFor(bounds(p), sideNow()), 700, quick);
  }

  /** Closes the open project; `toArchive`: back to the archive an archived one was opened from. */
  async function closeProject(toArchive = true) {
    const f = focusRef.current;
    if (f?.type !== 'project') return;
    setFocus(null);
    address.closes(undefined);
    setSheetOn(false);
    // one opened from the search goes back to the search's list, which stayed open
    if (toArchive && dropRef.current !== 'search' && archived.get(f.id) && !itemsRef.current.some((i) => i.id === f.id)) setDrop('archive');
    await fly(back(f), 600);
    recover();
  }

  async function deleteOpen() {
    const f = focusRef.current;
    if (f?.type !== 'card') return;
    const i = byId(f.id);
    const title = openDraft.current.title.trim() || titleFrom(openDraft.current.body);
    edits.drop();
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
  const keepNow = useLatest(() => {
    const f = focusRef.current;
    const project = f?.type === 'project' ? f.id : f?.type === 'card' ? f.project?.id : undefined;
    const sheet: SideSheet | undefined = kOn ? 'coordinator' : drop === 'archive' ? 'archive' : undefined;
    keep(sessionStorage, snapshot.canvas.id, {
      at: Date.now(),
      ...(f?.type === 'card' ? { card: f.id } : {}),
      ...(project ? { project, reading: !!readingRef.current } : {}),
      ...(sheet ? { sheet } : {}),
      ...(cOn ? { config: true } : {}),
      ...collect(),
    });
  });
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
    // what comes back is what the address names already
    if (k) return address.load(() => reopen(k));
    if (sheetLeft || talk) {
      // beside the sheet at once, as the canvas comes back
      quickSide.current = Date.now() + 2000;
      setKOn(true);
    }
    address.load(async () => code && openAddress(code, true));
  }, []);
  async function reopen(k: Kept) {
    // the sheet that comes back sets the camera beside it at once, as the rest comes back without flights
    quickSide.current = Date.now() + 2000;
    if (k.sheet === 'coordinator') setKOn(true);
    else if (k.sheet === 'archive') setDrop('archive');
    if (k.config) setCOn(true);
    await openAgain(k, true);
    restore(k);
  }
  /** Opens the project `k.project` (its plan doc with `reading`) and the card `k.card` in it or on the canvas; an archived one from its row in the archive or the project's sheet. */
  async function openAgain(k: Pick<Kept, 'card' | 'project' | 'reading'>, quick: boolean) {
    const find = async (id?: string) => (id ? archived.namedBy(id) : undefined);
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
  const address = useCanvasAddress(
    snapshot.canvas.id,
    () => {
      const f = focusRef.current;
      return f ? itemOrArchived(f.id) : undefined;
    },
    followAddress,
  );
  /** Opens what the address names; a code no card has leaves the canvas, at its address. */
  async function openAddress(code: string, quick: boolean) {
    const i = await archived.namedBy(code);
    if (address.gone.current) return;
    // by its short code, where it was named by its id
    address.replace(i);
    if (!i) return;
    if (i.kind === 'project') return openAgain({ project: i.id }, quick);
    // an archived workstream unfolds from its project's sheet, any other archived card from the
    // archive's list, which takes the search's place
    const project = i.archivedAt ? i.parent : undefined;
    if (i.archivedAt && !project) setDrop('archive');
    await openAgain({ card: i.id, project }, quick);
  }
  /** Back or Forward: what the address no longer names closes, what it names opens. */
  async function followAddress() {
    const code = readAddress().card;
    const i = code ? await archived.namedBy(code) : undefined;
    if (address.gone.current) return;
    await address.opening(async () => {
      const f = focusRef.current;
      if (f?.type === 'card' && f.id !== i?.id) await closeCard({ keepUntitled: true });
      const p = focusRef.current;
      if (p?.type === 'project' && p.id !== i?.id && i?.parent !== p.id) await closeProject(false);
      // a code no card has any longer: openAddress leaves the canvas at its address
      if (code && (!i || focusRef.current?.id !== i.id)) await openAddress(code, false);
    });
  }

  // ---------------------------------------------------------------- acknowledgement with undo
  const { showAck, showWait, fail, line: ackLine } = useAck();

  const { startCard, archiveCard, archiveProject, unarchiveProject, archiveDone, startAll, keepWorkspace, keepLeftovers, takeWorkspace, arrange, collapse, preparePlanDoc } = useCanvasActions({
    canvasId: snapshot.canvas.id,
    items: itemsRef,
    fold: (id, c) => setFolded(({ [id]: _, ...rest }) => (c === undefined ? rest : { ...rest, [id]: c })),
    closeSheet: async (p) => {
      if (focusRef.current?.type === 'project' && focusRef.current.id === p.id) await closeProject(false);
    },
    showAck,
    fail,
  });
  // a stable handle on `open` for the memoised project views
  const openCard = useStable((i: Item) => void open(i).catch(console.error));

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
  // card's agent passed on came to (with "Undo" while its actions wait)
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
        showNotice(told, i, n);
      }),
    [],
  );
  /** The draft of the field that speaks to `target`, whether or not it is on the page: the open card's, or Obeya's sidebar's. */
  const draftFor = (target: Where) => (target && 'card' in target ? cardDraft(target.card) : !target && kOnRef.current ? OBEYA_DRAFT : null);
  /** The draft a recording for `target` goes out with. */
  const fieldFor = (target: Where) => fieldOrMic(draftFor(target));
  const ptt = usePushToTalk(where, fieldFor, tellAbout, (h) => showAck(h.confirm), placeNow);
  const pttRef = useLatest(ptt);
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
  const letGoRef = useLatest(letGo);
  const holdToTalk = useStable(() => press(false));
  useEffect(() => {
    const up = (e: KeyboardEvent) => e.code === 'Space' && letGoRef.current();
    const release = () => letGoRef.current();
    // a screenshot, a file copied in the file manager (by its path) or text pasted (⌘V) anywhere but
    // in a text field goes to the field in view, or beside the mic
    const paste = (e: ClipboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const key = fieldFor(where());
      if (files.length) {
        if (!takesImages(key)) return;
        e.preventDefault();
        if (imageFiles(e.clipboardData?.files).length) pastedShots();
        return void filesTo(key, files);
      }
      const text = e.clipboardData?.getData('text/plain').trim() ?? '';
      if (!text) return;
      e.preventDefault();
      pastedText();
      insertPasted(key, [text]);
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
  const [panning, setPanning] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragWith, setDragWith] = useState<string[]>([]);
  // the card the pointer is on, for the waits around it
  const [hoverId, setHoverId] = useState<string | null>(null);
  const dep = useDepDrawing({ placed, byId, cam: camRef, showAck, fail });
  // Shift + drag on the canvas draws a lasso, Shift + click on a card takes it in or out
  const marking = useMarking({ placed, byId, cam: camRef, showAck, fail });
  const { marked, ring } = marking;
  /**
   * A loop of waits, from its button on the canvas: Obeya gets it, with what each wait is, to reorder
   * them; its sheet opens so the owner sees what it does.
   */
  function resolveLoop(loop: { cards: string[]; edges: [string, string][] }) {
    // each card by its number too, which tells Obeya the card where titles are alike
    const named = (id: string) => t.deps.loopCard(cardTag(byId(id)!.number), dep.titleOf(id));
    const waits = loop.edges.map(([from, to]) => t.deps.loopWait(named(to), named(from), byId(to) ? waitKinds(byId(to)!, from, items) : []));
    if (!kOn) toggleCoordinator();
    void tellTyped(t.deps.loopAsk(loop.cards.map(named), waits), undefined, null);
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
    if (dep.down(e)) return;
    stopFlight();
    // a text selection left from before would make this press drag the selected text instead of the card
    const sel = getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
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
      marking.startLasso(e);
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
    // the dots stay hidden while something is dragged, lassoed or panned, and while a card is open
    if (dep.move(e, !!(marking.lassoing() || dragRef.current || panRef.current || focusRef.current?.type === 'card'))) return;
    if (marking.drawLasso(e)) return;
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
    if (marking.endLasso()) return;
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
        marking.dropped(d.with.length > 0, { x: e.clientX, y: e.clientY });
      } else if (d.shift) marking.flip(i);
      else open(i);
      return;
    }
    const p = panRef.current;
    panRef.current = null;
    setPanning(false);
    // a click on the empty canvas lets go of what is marked
    if (p && Math.hypot(e.clientX - p.from.x, e.clientY - p.from.y) < 5) marking.clear();
  }

  function onDoubleClick(e: React.MouseEvent) {
    // the pointer capture retargets the event to the viewport, so look at what is under the pointer
    if (focusRef.current || document.elementFromPoint(e.clientX, e.clientY)?.closest('.item, .plan-dir')) return;
    createAt(toWorld(camRef.current, e.clientX, e.clientY));
    if (!dblKnown) {
      knowDbl();
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
  const underwayRef = useLatest(underway);
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
    onObeya: (c: string) => (c === snapshot.canvas.id ? kOnRef.current || toggleCoordinator() : goTo(`${canvasPath(c)}?talk`)),
  };
  const proposalCount = snapshot.preferences.filter((p) => p.state === 'proposed').length + (snapshot.settingProposals?.length ?? 0);
  const doneCount = items.filter(archivedWithDone).length;
  const attnLast = useRef<string | null>(null);
  /** The next card that needs the owner, in turn, and Obeya's sheet among them while an answer waits there. */
  function nextAttention() {
    const coordinator = !kOnRef.current && unreadAnswers(snapshotRef.current.talk) > 0;
    const all = itemsRef.current;
    const list: (Item | 'k')[] = [...all.filter(yours), ...(coordinator ? ['k' as const] : [])];
    if (!list.length || focusRef.current?.type === 'card') return;
    // the one after the card Tab opened last, by its place on the canvas: that card may need the owner no longer
    const key = (x: Item | 'k') => (x === 'k' ? 'k' : x.id);
    const at = (id: string | null) => (id === 'k' ? all.length : all.findIndex((i) => i.id === id));
    const last = at(attnLast.current);
    const next = list.find((x) => at(key(x)) > last) ?? list[0]!;
    attnLast.current = key(next);
    if (next === 'k') toggleCoordinator();
    else open(next);
  }
  const keys = useLatest((e: KeyboardEvent) => {
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
    // so does "Connect a phone"
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
      knowHelp();
      return;
    }
    // C over a walkthrough (zoomed, playing or under the pointer) switches its captions, not to the conversation with Obeya
    if (captionKey(e)) return;
    // hold Space anywhere but in a text field to speak; the demo pauses while the owner talks, and a tap plays or pauses it
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      if (!e.repeat) press(true);
      return;
    }
    if (e.key === 'Escape' && dep.cancel()) return;
    if (e.key === 'Escape') {
      // a screenshot or demo shown large closes first, a card's diff, the queue's list, the navigation's and the menu of what a card's agent runs on; the card stays open
      if (document.querySelector('.lightbox, .demo-zoom, .queue-menu, .nav-menu, .diff-view, .agent-menu')) return;
      // so does the quote of a message the owner was replying to: in the field with the cursor, the open card's, the sidebar's
      const quoting = [focusedDraft(), f?.type === 'card' || f?.type === 'project' ? cardDraft(f.id) : null, kOnRef.current ? OBEYA_DRAFT : null].find((k) => k && fieldOn(k) && replyOn(k));
      if (quoting) return setReply(quoting, null);
      // the archive's list or the search closes after a card unfolded from it
      if (f?.type !== 'card' && dropRef.current) return setDrop(null);
      // what is marked lets go before a sheet closes, once the colour ring for it has closed
      if (f?.type !== 'card' && !typing && !ring && marked.length) return marking.clear();
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
      else if (e.key === 'c') talkCoordinator();
      else if (e.key === '/') {
        toggleSearch();
        knowSearch();
      } else toggleArchive();
    }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', h, true);
    return () => removeEventListener('keydown', h, true);
  }, []);

  // ---------------------------------------------------------------- render
  const sheetProject = sheetId ? itemOrArchived(sheetId) : undefined;
  // the archived card that unfolds or is open, whose row the archive's list brings into view
  const keptRow = focus?.type === 'card' ? focus.id : archiveKeep;
  const sheetKids = !sheetProject ? [] : sheetProject.archivedAt ? archived.kidsOf(sheetProject.id) : (kidsOf.get(sheetProject.id) ?? []);
  const deps = useMemo(() => (hoverId && !panning && !dragId ? depsOf(hoverId, items) : undefined), [hoverId, panning, dragId, items]);
  const waits = useMemo(() => waitsAmong(items), [items]);
  const waitKeys = useMemo(() => new Set(waits.map(([from, to]) => `${from}:${to}`)), [waits]);
  // the waits shown as lines: those the owner is removing go at once
  const shownWaits = waits.filter(([from, to]) => !dep.removed(from, to));
  // a loop only of the waits that hold its cards back: one through a card at work stalls nothing
  const loops = useMemo(() => loopsAmong(holdsAmong(items).filter(([from, to]) => !dep.removed(from, to))), [items, dep.removing]);
  const standsForId = (id: string) => (byId(id) ? standsFor(byId(id)!).id : id);
  const depOf = (id: string) => (!deps ? undefined : id === hoverId ? 'self' : loops.some((l) => l.cards.includes(hoverId!) && l.cards.includes(id)) ? 'loop' : deps.before.has(id) ? 'before' : deps.after.has(id) ? 'after' : undefined);
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
    <button className={kOn ? 'pill kpill talk-pill on' : 'pill kpill talk-pill'} title={t.coordinator.buttonTitle} aria-label={t.coordinator.button} onClick={talkCoordinator}>
      <TalkIcon />
      {unread > 0 && (
        <span className="n unread" title={t.coordinator.unreadCount(unread)}>
          {unread}
        </span>
      )}
      {proposalCount > 0 && (
        <span className="n prop" title={t.coordinator.proposalsCount(proposalCount)}>
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
          onContextMenu={(e) => focusRef.current || marking.ringAt(e)}
        >
          <div id="world" style={{ transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.s})` }}>
            <TerritoryLayer {...territories} selected={placed.filter((p) => (ring ? ring.ids : marked).includes(p.item.id)).map((p) => p.b)} />
            <GroupNames names={groupNames} />
            <Links placed={placed} waits={shownWaits} standsFor={standsForId} />
            <DepLinks placed={placed} waits={shownWaits} lit={deps?.edges ?? []} steps={deps?.steps} loops={loops.flatMap((l) => l.edges)} standsFor={standsForId} s={cam.s}>
              {(shift) => <ManualEdges dep={dep} placed={placed} waitKeys={waitKeys} loops={loops} standsFor={standsForId} s={cam.s} shift={shift} onLoop={resolveLoop} />}
            </DepLinks>
            <ConnectionGhost dep={dep} placed={placed} s={cam.s} />
            {placed.map(({ item, b }) =>
              item.kind === 'project' ? (
                <ProjectView key={item.id} item={item} b={b} lit={item.id === litId} kids={kidsOf.get(item.id) ?? []} replies={repliesIn.get(item.id) ?? 0} els={els} onStartAll={startAll} onArrange={arrange} onCollapse={collapse} onOpen={openCard} onArchive={archiveProject} />
              ) : (
                <CardView
                  key={item.id}
                  item={item}
                  b={b}
                  lifted={item.id === openId}
                  dragging={item.id === dragId || dragWith.includes(item.id)}
                  pop={item.id === popId}
                  lit={item.id === litId}
                  showRepo={snapshot.canvas.repos.length > 1}
                  els={els}
                  onStart={startCard}
                  onArchive={archiveCard}
                  dep={depOf(item.id)}
                  underway={underway[item.id] ?? (item.landing ? landingLabel(item) : undefined)}
                  onHover={setHoverId}
                />
              ),
            )}
            <GroupNames names={groupNames} over />
            <ConnectionDots dep={dep} placed={placed} underway={underway} depOf={depOf} />
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
        <MarkingLayer m={marking} placed={placed} cam={cam} side={side} still={!!dragId || focus?.type === 'card'} groups={snapshot.groups} items={snapshot.items} />
        <ConnectionHint dep={dep} cam={cam} />
        {(!focus || focus.type === 'project') && <Edges cam={cam} targets={edgeTargets} side={side} onOpen={open} lit={litEdge?.item.id} cover={drop === 'search' ? searchCover : undefined} />}
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
            on={drop === 'search'}
            teach={!searchKnown && items.length > 5}
            onTeach={() => focusRef.current?.type !== 'card' && setSearchHintOn(true)}
            onClose={() => shut('search')}
            held={focus?.type === 'card'}
            items={items}
            rev={snapshot.archive}
            onArchived={archived.learn}
            onOpen={openFound}
            onLight={setFoundId}
            els={archiveEls}
            onCover={setSearchCover}
          />
          <ArchivePill
            on={drop === 'archive'}
            onToggle={toggleArchive}
            onClose={() => shut('archive')}
            held={focus?.type === 'card'}
            rev={snapshot.archive}
            onItems={archived.learn}
            done={doneCount}
            onOpen={open}
            onArchiveDone={() => archiveDone().catch(console.error)}
            els={archiveEls}
            keep={keptRow && !byId(keptRow) ? keptRow : undefined}
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
            <CostsPill total={snapshot.spent} items={items} onOpen={open} />
            {snapshot.workspaces && <WorkspacesPill pools={snapshot.workspaces} canvas={snapshot.canvas} canvases={canvases} items={items} onOpen={(i) => void openFresh(i)} onElsewhere={(c, card) => goTo(cardPath(c, card))} onTake={takeWorkspace} onKeep={keepWorkspace} onLeftovers={keepLeftovers} />}
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
                <CardLog id={openItem.id}>
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
                </CardLog>
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
          onAsk={(text, canvas) => void told.tell(t.voice.reading(t.voice.coordinator), undefined, () => (canvas ? api.commandOn(canvas, text) : api.command(text, null, { place: placeNow() })))}
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
        <CoordinatorSheet on={kOn} canvas={snapshot.canvas.id} items={items} preferences={snapshot.preferences} settings={snapshot.settingProposals ?? []} repos={snapshot.canvas.repos} talk={snapshot.talk} reshare={snapshot.reshare} onOpen={(i) => void openFresh(i)} onTell={(text, images, replyTo) => tellTyped(text, images, null, undefined, replyTo)} onConfig={(repo, setting) => {
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
          onArchive={archiveProject}
          onUnarchive={unarchiveProject}
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
          {...gripFor(gripKind)}
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

/** A button's icon in the top bar, shown in place of its label where the bar is narrow (beside a wide sheet). */
function BarIcon({ d }: { d: string }) {
  return (
    <svg className="bar-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

