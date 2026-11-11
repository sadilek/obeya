// The phone view: on a phone the page shows, instead of the canvas, what waits for the owner across
// every canvas ("Needs you"), what runs ("Running") and, folded away until opened, what the owner
// swiped aside ("Set aside"), what is planned ("Planned") and what is done but not archived yet
// ("Done"), each canvas's cards under a head that folds them; Obeya's conversation is a panel of its own that
// comes up from below. A card opens full screen with the canvas's own detail view (answer options,
// demo, approve buttons), its conversation in the same panel, and Back returns to the list. The microphone is held by touch; Enter breaks the line, only Send sends;
// what was typed but not sent survives a reload. It holds one WebSocket for every canvas.

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type CanvasInfo, finishedArchivable, type Item, needsYou, openQuestions, unreadAnswers } from '../core/types';
import { api, cardsOn, onNotice, phoneInUse, setCanvas, useEveryCanvas, type Where } from './api';
import { enterBreaksLines } from './composer';
import { forYouCount, forYouOf, ForYouRows, forYouTotal, PhoneCard, type Swipe } from './forYou';
import { SWIPED_CARD, swipedOnce } from './aside';
import { FoldArrow, toggleFolded, useFolded as useFoldedCanvases } from './fold';
import { asideMark, changeAside, forgotten, loadAside, onAsideElsewhere, type SetAside, staysAside } from './setAside';
import { CardNumber } from './cardNumber';
import type { ActDone, Pending } from './cardSheet';
import { CardLog, TalkElsewhere, useCardLog } from './conversation';
import { Detail } from './detail';
import { cardDraft, fieldOrMic, focusedDraft, keepDrafts, obeyaDraft } from './draft';
import { CoordinatorTalk } from './coordinator';
import { Sign } from './logo';
import { Notify, registerWorker } from './notify';
import { plain } from './markdown';
import { Cards } from './message';
import { glide, type Mark, settle, speed, THROWN, thrown } from './panelHeight';
import { shownState, TalkIcon } from './parts';
import { PROBE_MS, quietText, TAILSCALE_APP, useTailnet, useWhyQuiet } from './reach';
import { videoOf } from './spot';
import { flag, local, read, session, setFlag, write } from './stored';
import { forTouch, t, when } from './strings';
import { UsagePill } from './usage';
import { agentWorks, cardTalk, coordinatorReads, obeyaWorks, opensWithTalk, runs, unseen } from './talk';
import { seenOf } from './seen';
import { showNotice, tellers, useAck } from './tell';
import { followDone, useCardEdits } from './cardHost';
import { HoldToTalk, PushToTalk, ToldList, usePushToTalk, useTold } from './voice';
import { canvasPath, cardPath, named, queryWithout, readAddress } from './address';
import { useLatest } from './latest';

/**
 * Whether the page shows the phone view: on a phone, which has a coarse pointer and a short side
 * under 600 px whichever way it is held (a tablet and a narrow window at the desk keep the canvas).
 * `?view=phone` or `?view=canvas` in the address decides instead.
 */
export function phoneView(): boolean {
  const asked = new URLSearchParams(location.search).get('view');
  if (asked === 'phone' || asked === 'canvas') return asked === 'phone';
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
}

/** The phone view keeps its drafts apart from any canvas's: it shows every canvas. */
const DRAFTS = '@phone';
/** The canvas whose Obeya the conversation at the bottom is with, as the owner last picked it. */
const OBEYA_CANVAS = 'obeya-phone-canvas';
/** Whether the owner opened "Set aside", "Planned" or "Done" in this tab; each starts closed. */
const ASIDE_OPEN = 'obeya-phone-aside-open';
const PLANNED_OPEN = 'obeya-phone-planned';
const DONE_OPEN = 'obeya-phone-done';
/** The canvases folded within the lists, as `<list>:<canvas>`, kept in this browser as the navigation keeps its own. */
const CANVASES_FOLDED = 'obeya-phone-folded';
/** How long the server may not answer before the view says so: a phone back from its lock screen reconnects within this. */
const QUIET_MS = 3000;

/** The card the address names, by its code or its id. */
const cardInAddress = () => readAddress().card ?? null;
const talkInAddress = () => new URLSearchParams(location.search).has('talk');
/** What a step in the browser's history opened: a card, or the conversation of what is in view. */
type Step = 'card' | 'talk';
/** The open card's demo video, on its page. */
const pageVideo = () => document.querySelector<HTMLVideoElement>('#ph-card .demo-view video');

/**
 * The keyboard makes the page shorter (`interactive-widget`), as Chrome on Android does with it: the
 * views fixed to the screen end at the keyboard then. Without it Chrome only shrinks the visual
 * viewport and reports it wrong by its own bars (by the gesture bar where it draws under it, by the
 * bottom toolbar where it has one), and the field ended under the keyboard or far above it. Safari
 * ignores it and shrinks the visual viewport, which the panel follows.
 */
function keyboardResizes() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
  if (meta && !meta.content.includes('interactive-widget')) meta.content += ', interactive-widget=resizes-content';
}

/** The kinds of input the keyboard comes up for; a date or a time opens the phone's own picker instead. */
const TYPED = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Whether the element is a text field: one the keyboard comes up for. */
const typesText = (el: unknown): el is HTMLTextAreaElement | HTMLInputElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TYPED.has(el.type));

/** How much shorter than the tallest seen the screen gets while the keyboard is up; a browser's bars sliding in and out take less. */
const KEYBOARD_PX = 150;

/**
 * Marks the page while the keyboard is up (`ph-kb` on the root): a text field has the focus and the
 * height the page has is well below the tallest it had at this width. The keyboard closed with the
 * phone's own button leaves the focus in the field, so the focus alone does not tell (until
 * 2026-10-17 it did, and the microphone stayed hidden after that).
 */
function watchKeyboard() {
  const vv = window.visualViewport;
  const tallest = new Map<number, number>();
  const check = () => {
    const h = vv?.height ?? innerHeight;
    const w = Math.round(innerWidth);
    const top = Math.max(tallest.get(w) ?? 0, h);
    tallest.set(w, top);
    document.documentElement.classList.toggle('ph-kb', typesText(document.activeElement) && h < top - KEYBOARD_PX);
  };
  check();
  vv?.addEventListener('resize', check);
  addEventListener('resize', check);
  addEventListener('focusin', check);
  addEventListener('focusout', check);
  return () => {
    vv?.removeEventListener('resize', check);
    removeEventListener('resize', check);
    removeEventListener('focusin', check);
    removeEventListener('focusout', check);
    document.documentElement.classList.remove('ph-kb');
  };
}

/** Longer than this, or moved further, a touch is no tap: a long press selects, a swipe scrolls. */
const TAP_MS = 400;
const TAP_PX = 10;

/**
 * A tap into a text field while the keyboard is down only puts the cursor where the finger was and
 * brings the keyboard up. Left to Chrome, a tap on a word marked misspelled also opened its menu of
 * suggestions, and on the phone that closed the keyboard it had just begun to open. With the
 * keyboard up the tap is Chrome's again, and the suggestions open above it.
 */
function tapOpensKeyboard() {
  let down: { x: number; y: number; at: number; field: HTMLTextAreaElement | HTMLInputElement } | null = null;
  const start = (e: TouchEvent) => {
    const field = e.target instanceof Element ? e.target.closest('textarea, input') : null;
    const finger = e.touches[0];
    down =
      finger && e.touches.length === 1 && typesText(field) && !field.readOnly && !field.disabled && !document.documentElement.classList.contains('ph-kb')
        ? { x: finger.clientX, y: finger.clientY, at: e.timeStamp, field }
        : null;
  };
  const end = (e: TouchEvent) => {
    const tap = down;
    down = null;
    const finger = e.changedTouches[0];
    if (!tap || !finger || e.touches.length || e.timeStamp - tap.at > TAP_MS) return;
    if (Math.hypot(finger.clientX - tap.x, finger.clientY - tap.y) > TAP_PX) return;
    e.preventDefault();
    const { field } = tap;
    const at = document.caretPositionFromPoint?.(finger.clientX, finger.clientY);
    // the keyboard closed with the phone's own button left the focus in the field: focusing it anew brings the keyboard up
    if (document.activeElement === field) field.blur();
    field.focus();
    if (at?.offsetNode === field) field.setSelectionRange(at.offset, at.offset);
  };
  addEventListener('touchstart', start, { capture: true, passive: true });
  addEventListener('touchend', end, { capture: true, passive: false });
  return () => {
    removeEventListener('touchstart', start, { capture: true });
    removeEventListener('touchend', end, { capture: true });
  };
}

export function Phone({ canvases: loaded }: { canvases: CanvasInfo[] }) {
  keepDrafts(sessionStorage, DRAFTS);
  useState(() => {
    forTouch();
    enterBreaksLines();
    phoneInUse();
    keyboardResizes();
  });
  useEffect(watchKeyboard, []);
  useEffect(tapOpensKeyboard, []);
  const [canvases, setCanvases] = useState(loaded);
  // the canvases it last had, while the server did not answer: the list the server sends once it does
  useEffect(() => setCanvases(loaded), [loaded]);
  // every canvas over one connection, with the plan's usage limits
  const { snapshots: snaps, offlineSince: quietSince, usage, canvases: listed } = useEveryCanvas();
  const snapsRef = useLatest(snaps);
  useEffect(() => void (listed && setCanvases(listed)), [listed]);

  // ---------------------------------------------------------------- what is open
  const [open, setOpenState] = useState<string | null>(cardInAddress);
  /**
   * The address with `card` open on its canvas (or the canvas of Obeya's conversation with none),
   * and that conversation open or not, keeping what else it holds (`?view=phone`, say).
   */
  const addressWith = ({ card, talk }: { card: string | null; talk: boolean }) => {
    const x = card ? allRef.current.find((c) => c.item.id === card) : undefined;
    // a card not known yet (the snapshots still on their way) keeps the address that named it
    const path = !card ? canvasPath(obeyaRef.current) : x ? cardPath(x.canvas.id, x.item) : location.pathname;
    const q = queryWithout(location.search, 'c', 'card', 'talk');
    return `${path}${talk ? (q ? `${q}&talk` : '?talk') : q}`;
  };
  /** The id of the card a code names, once the snapshots hold it. */
  const resolve = (code: string | null) => (code && named(allRef.current.map((x) => x.item), code)?.id) || code;
  const openRef = useLatest(open);
  // the conversation of what is in view, a panel over it: the open card's, else Obeya's
  const [talk, setTalk] = useState(talkInAddress);
  const talkRef = useLatest(talk);
  /** Closes the open panel as dragging it down does, sliding out. */
  const leaveTalk = useRef<(() => void) | null>(null);
  // the panel sliding out: the button offers it again at once
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!talk) setClosing(false);
  }, [talk]);
  // opening a card or the panel is a step in the browser's history: its Back (or the swipe) closes it
  // again. Each entry holds the steps that led to it, the latest last, so they hold after Back,
  // Forward and a reload alike.
  const steps = (): Step[] => (history.state as { steps?: Step[] } | null)?.steps ?? [];
  const step = (what: Step, to: { card: string | null; talk: boolean }) => history.pushState({ steps: [...steps(), what] }, '', addressWith(to));
  /** Back from `what`: the browser's own step back where this page pushed it, else the address without it. */
  const stepBack = (what: Step, to: { card: string | null; talk: boolean }) => {
    if (steps().at(-1) === what) return history.back();
    history.replaceState(history.state, '', addressWith(to));
    if (what === 'card') setOpenState(null);
    else setTalk(false);
  };
  /** The card just opened, until it is known whether it waits for answers (its conversation opens then). */
  const looked = useRef<string | null>(cardInAddress());
  // a card opens over Obeya's conversation, and from a card's conversation another card in its place
  const openId = (id: string) => {
    if (openRef.current === id) return;
    looked.current = id;
    if (!openRef.current) homeScroll.current = homeRef.current?.scrollTop ?? 0;
    if (openRef.current) {
      // the step that opened the conversation now opens this card: Back returns to the one before
      const s = steps();
      history.replaceState({ steps: s.at(-1) === 'talk' ? [...s.slice(0, -1), 'card'] : s }, '', addressWith({ card: id, talk: false }));
    } else step('card', { card: id, talk: false });
    setOpenState(id);
    setTalk(false);
  };
  const openCard = (i: Item) => openId(i.id);
  /** Back to the list from a card, closing its conversation too. */
  const leavesCard = useRef(false);
  const back = () => {
    if (!openRef.current) return;
    flushEdit().catch(console.error);
    const p = steps();
    if (p.at(-1) === 'talk' && p.at(-2) === 'card') return history.go(-2);
    if (p.at(-1) === 'talk') {
      // the card was opened before this page pushed anything (a reload): back past the conversation, then off the card
      leavesCard.current = true;
      return history.go(-1);
    }
    stepBack('card', { card: null, talk: false });
    setTalk(false);
  };
  const openTalk = () => {
    if (talkRef.current) return;
    step('talk', { card: openRef.current, talk: true });
    setTalk(true);
  };
  const closeTalk = () => talkRef.current && stepBack('talk', { card: openRef.current, talk: false });
  /** Back to the list, from a card and the panel alike. */
  const home = () => {
    flushEdit().catch(console.error);
    const n = steps().length;
    if (n) return history.go(-n);
    history.replaceState(null, '', addressWith({ card: null, talk: false }));
    setOpenState(null);
    setTalk(false);
  };
  // a tapped push: its card (or "Needs you" for several) in the app that is open already
  useEffect(() => {
    registerWorker();
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const tapped = (e: MessageEvent) => {
      if (e.data?.type !== 'open' || typeof e.data.url !== 'string') return;
      const card = readAddress(new URL(e.data.url, location.href)).card;
      if (card) openId(resolve(card)!);
      else home();
    };
    sw.addEventListener('message', tapped);
    return () => sw.removeEventListener('message', tapped);
  }, []);
  useEffect(() => {
    const pop = () => {
      flushEdit().catch(console.error);
      looked.current = null;
      if (leavesCard.current) {
        leavesCard.current = false;
        history.replaceState(null, '', addressWith({ card: null, talk: false }));
      }
      openRef.current = resolve(cardInAddress());
      talkRef.current = talkInAddress();
      setOpenState(openRef.current);
      setTalk(talkRef.current);
      followOpen.current();
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  // "Set aside", "Planned" and "Done" start closed, and stay as the owner left them while a card is open and over a reload
  const [asideOpen, toggleAsideOpen] = useFolded(ASIDE_OPEN);
  const [plannedOpen, togglePlanned] = useFolded(PLANNED_OPEN);
  const [doneOpen, toggleDone] = useFolded(DONE_OPEN);
  // the list keeps where it was scrolled to while a card is open
  const homeRef = useRef<HTMLDivElement>(null);
  const homeScroll = useRef(0);
  useEffect(() => {
    if (!open && homeRef.current) homeRef.current.scrollTop = homeScroll.current;
  }, [open]);

  // ---------------------------------------------------------------- the cards
  const ordered = canvases.filter((c) => snaps[c.id]);
  const all = useMemo(() => ordered.flatMap((c) => snaps[c.id]!.items.map((item) => ({ item, canvas: c }))), [snaps, canvases]);
  const allRef = useLatest(all);
  const byId = (id: string) => allRef.current.find((x) => x.item.id === id)?.item;
  // a card the address names by its code: its id once the snapshots hold it, and its address by the
  // code; an open card that moved to another canvas (built in a new repository there) stays open, and
  // the address follows it there, as the canvas's page does, also on Back and Forward
  const followOpen = useLatest(() => {
    const open = openRef.current;
    if (!open) return;
    const id = resolve(open)!;
    const on = allRef.current.find((x) => x.item.id === id)?.canvas.id;
    if (id === open && (!on || on === readAddress().canvas)) return;
    if (looked.current === open) looked.current = id;
    openRef.current = id;
    setOpenState(id);
    history.replaceState(history.state, '', addressWith({ card: id, talk: talkRef.current }));
  });
  useEffect(() => followOpen.current(), [all]);
  // the cards the owner swiped aside, out of "Needs you" and "Running" until they need the owner anew;
  // the same in every tab of this browser
  const [aside, setAsideState] = useState<SetAside>(loadAside);
  useEffect(() => onAsideElsewhere(setAsideState), []);
  const change = (f: (a: SetAside) => SetAside) => setAsideState(changeAside(f));
  const putAside = (i: Item) => {
    const on = allRef.current.find((x) => x.item.id === i.id)?.canvas.id;
    if (on) change((a) => ({ ...a, [i.id]: asideMark(i, on) }));
  };
  const bringBack = (i: Item) => change(({ [i.id]: _, ...rest }) => rest);
  // forgotten once a card is back by itself, or gone from its canvas; judged on new snapshots only, so
  // that a tab behind on them leaves alone what a tab up to date set aside
  useEffect(() => {
    const gone = forgotten(loadAside(), Object.fromEntries(ordered.map((c) => [c.id, snaps[c.id]!.items])));
    if (gone.length) change((a) => Object.fromEntries(Object.entries(a).filter(([id]) => !gone.includes(id))));
  }, [all]);
  // the canvases folded within the lists, where the nudge looks for a card in sight
  const folded = useFoldedCanvases(CANVASES_FOLDED);
  // approved cards the server is still landing: they need the owner no longer
  const [underway, setUnderway] = useState<string[]>([]);
  useEffect(() => setUnderway((u) => u.filter((id) => byId(id)?.state === 'waiting')), [snaps]);
  const opened = open ? all.find((x) => x.item.id === open) : undefined;

  // the canvas whose Obeya is spoken to without a card open
  const [obeyaCanvas, setObeyaCanvasState] = useState(() => {
    const wanted = readAddress().canvas ?? read(local, OBEYA_CANVAS);
    return (canvases.find((c) => c.id === wanted) ?? canvases[0]!).id;
  });
  const obeyaId = canvases.some((c) => c.id === obeyaCanvas) ? obeyaCanvas : canvases[0]!.id;
  const obeyaRef = useLatest(obeyaId);
  const setObeyaCanvas = (id: string) => {
    // at once, for the address of the conversation opened next
    obeyaRef.current = id;
    setObeyaCanvasState(id);
    write(local, OBEYA_CANVAS, id);
  };
  // every call goes to the API of the canvas in view: the open card's, else Obeya's
  setCanvas(opened?.canvas.id ?? obeyaId);
  // and every call about a card to its canvas's
  for (const c of ordered) cardsOn(c.id, snaps[c.id]!.items.map((i) => i.id));

  // ---------------------------------------------------------------- edits of the open card
  const { onEdit, flush: flushEdit, drop: dropEdit } = useCardEdits(() => openRef.current);

  // ---------------------------------------------------------------- voice and confirmations
  const { showAck, showWait, fail, line: ackLine } = useAck(true);
  // the reply stands in Obeya's conversation, open in front of the owner: no line above the microphone
  const told = useTold(() => {}, (h) => talkRef.current && (h.inCard ? openRef.current === h.inCard : !!snapsRef.current[obeyaRef.current]?.talk.some((x) => x.id === h.talk)));
  const { tellAbout, tellTyped } = tellers(byId, told, fail, () => undefined);
  const where = (): Where => (openRef.current ? { card: openRef.current } : null);
  /** The draft of the field that speaks to `target`: the open card's, or the one under Obeya's conversation. */
  const draftFor = (target: Where) => (target && 'card' in target ? cardDraft(target.card) : obeyaDraft(obeyaRef.current));
  /** The draft a recording for `target` goes out with. */
  const fieldFor = (target: Where) => fieldOrMic(draftFor(target));
  const ptt = usePushToTalk(where, fieldFor, tellAbout, (h) => showAck(h.confirm), () => undefined);
  const pttRef = useLatest(ptt);
  /** The open card's demo video while the microphone is held: it pauses, and plays on after unless the words went into a field. */
  const pressing = useRef<{ video: HTMLVideoElement | null; playing: boolean; dictating: boolean } | null>(null);
  const press = () => {
    const id = openRef.current;
    const video = id ? (videoOf(id) ?? document.querySelector<HTMLVideoElement>('.card-sheet video')) : null;
    pressing.current = { video, playing: !!video && !video.paused, dictating: !!focusedDraft() };
    video?.pause();
    pttRef.current.start();
  };
  useEffect(() => {
    // a finger lifted, or taken over by the browser, ends the recording wherever it is
    const release = () => {
      const p = pressing.current;
      pressing.current = null;
      pttRef.current.stop();
      if (p?.video && p.playing && !p.dictating) p.video.play().catch(() => {});
    };
    addEventListener('pointerup', release);
    addEventListener('pointercancel', release);
    return () => {
      removeEventListener('pointerup', release);
      removeEventListener('pointercancel', release);
    };
  }, []);
  useEffect(
    () =>
      onNotice((n) => {
        showNotice(told, n.cardId ? byId(n.cardId) : undefined, n);
      }),
    [],
  );
  // Esc closes the open conversation, else the open card, as Back does (a keyboard at the phone, or the view tried at the desk)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.lightbox, .agent-menu')) return;
      if (talkRef.current) closeTalk();
      else back();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  /** After an action on the open card: back to the list, with the confirmation. */
  const onDone = (d: ActDone, p?: Pending) =>
    followDone(d, p, { close: back, showAck, showWait, underway: (card, what) => setUnderway((u) => (what ? [...u, card] : u.filter((id) => id !== card))) });
  async function deleteOpen() {
    const i = opened?.item;
    if (!i) return;
    dropEdit();
    back();
    try {
      await api.remove(i.id);
      showAck(t.deleted(plain(i.title)), () => api.restore(i.id));
    } catch (e) {
      fail(e);
    }
  }

  // ---------------------------------------------------------------- the machine not answering
  const [, tick] = useState(0);
  useEffect(() => {
    if (quietSince === null) return;
    const hs = [QUIET_MS, QUIET_MS + PROBE_MS].map((ms) => setTimeout(() => tick((n) => n + 1), Math.max(0, quietSince + ms - Date.now()) + 50));
    return () => hs.forEach(clearTimeout);
  }, [quietSince]);
  const { why, pushedAt, probed } = useWhyQuiet(quietSince);
  // the line comes with its cause, once the probe that started with the silence is back, so it does not change its words a moment later
  const waited = quietSince === null ? 0 : Date.now() - quietSince;
  const quiet = waited >= QUIET_MS && (probed || waited >= QUIET_MS + PROBE_MS);
  const viaTailnet = useTailnet(quietSince === null);
  const said = quietText(why, { tailnet: viaTailnet, android: /Android/i.test(navigator.userAgent), pushedAt: pushedAt === null ? null : when(pushedAt) });

  const several = canvases.length > 1;
  const banner = quiet && (
    <div className="ph-quiet" role="status">
      <b>{t.phone.notAnswering(when(quietSince!))}</b>
      <span>{said.line}</span>
      {said.open && (
        <a className="ph-quiet-open" href={TAILSCALE_APP}>
          {t.phone.whyQuiet.openTailscale}
        </a>
      )}
      {said.more.length > 0 && (
        <details className="ph-quiet-more">
          <summary>{t.phone.whyQuiet.more}</summary>
          {said.more.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </details>
      )}
    </div>
  );
  const voice = (
    <>
      <div id="acks">
        <ToldList told={told.told} open={open ?? undefined} onUndo={told.undo} aside onGone={told.drop} />
        {ackLine}
      </div>
      <PushToTalk
        phase={ptt.phase}
        level={ptt.level}
        flat={ptt.flat}
        // what is in view fills the screen: whom the microphone speaks to goes without saying, and the room is short
        target={null}
        field={draftFor(where())}
        onDown={press}
      />
    </>
  );

  // ---------------------------------------------------------------- the open card's conversation
  /** Where the open card's conversation goes: the panel's content, while it is open. */
  const [talkEl, setTalkEl] = useState<HTMLElement | null>(null);
  /** The cursor goes into the panel's field once it is there (a comment on the demo). */
  const wantFocus = useRef(false);
  const elsewhere = useMemo(
    () => ({
      el: talk ? talkEl : null,
      open: (focus?: boolean) => {
        if (talkRef.current) return void (focus && talkEl?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
        wantFocus.current = !!focus;
        openTalk();
      },
    }),
    [talk, talkEl],
  );
  // a card at work, or one that waits for answers to its questions, opens with its conversation, once
  // each time it is opened (a tap, a push, the page loading); Back or Forward to it leaves it as that step had it
  useEffect(() => {
    if (!open || !opened || looked.current !== open) return;
    looked.current = null;
    if (!talkRef.current && opensWithTalk(opened.item)) openTalk();
  }, [open, !!opened]);
  // beside a demo video the conversation is a half sheet, and the page shows the video above it; on a
  // working card too, so what the card is about stays in view above what its agent says
  const [half, setHalf] = useState(false);
  const halfFor = useRef<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const now = open && talk && opened ? open : null;
    if (now === halfFor.current) return;
    halfFor.current = now;
    setHalf(!!now && (!!pageVideo() || opened?.item.state === 'working'));
  }, [open, talk, !!opened]);
  useLayoutEffect(() => {
    const page = cardRef.current;
    const v = pageVideo();
    if (!half || !page || !v) return;
    const bar = page.querySelector('.ph-bar')?.getBoundingClientRect().bottom ?? 0;
    page.scrollTo({ top: page.scrollTop + v.getBoundingClientRect().top - bar - 10, behavior: 'smooth' });
  }, [half]);

  if (open) {
    const c = opened?.canvas;
    const items = c ? snaps[c.id]!.items : [];
    const i = opened?.item;
    return (
      <HoldToTalk.Provider value={press}>
        {/* the card's log, which its conversation and the button for it both read */}
        <CardLog id={i?.id}>
        <div id="ph-card" className="ph-view" ref={cardRef} style={i ? ({ '--c': `var(--${shownState(i)})` } as React.CSSProperties) : undefined}>
          <header className="ph-bar">
            <button className="ph-back" onClick={back}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t.phone.back}
            </button>
            {c && several && <span className="ph-canvas">{c.name}</span>}
            {i && <CardNumber n={i.number} className="ph-no" />}
          </header>
          {banner}
          <div className="card-sheet ph-sheet">
            {i && c ? (
              <Cards.Provider value={{ items, open: openCard }}>
                <TalkElsewhere.Provider value={elsewhere}>
                <Detail
                  key={i.id}
                  item={i}
                  all={items}
                  repos={snaps[c.id]!.canvas.repos}
                  parent={i.parent ? items.find((x) => x.id === i.parent) : undefined}
                  from={i.from ? items.find((x) => x.id === i.from) : undefined}
                  onEdit={onEdit}
                  flush={flushEdit}
                  onDelete={() => void deleteOpen()}
                  onDone={onDone}
                  onTell={(text, images, field, replyTo) => void tellTyped(text, images, { card: i.id }, field, replyTo)}
                />
                </TalkElsewhere.Provider>
              </Cards.Provider>
            ) : (
              // the snapshots are still on their way, or the card went (archived, deleted)
              Object.keys(snaps).length === canvases.length && <p className="hint">{t.phone.gone}</p>
            )}
          </div>
        </div>
        {talk && i && (
          <TalkPanel
            title={plain(i.title)}
            label={t.phone.cardTalk}
            banner={banner}
            half={half}
            onClose={closeTalk}
            leave={leaveTalk}
            onLeave={() => setClosing(true)}
            focus={wantFocus}
          >
            <div id="ph-card-talk" className="ph-talk split-talk" ref={setTalkEl} />
          </TalkPanel>
        )}
        {i && <CardTalkButton key={i.id} item={i} open={talk} shown={talk && !closing} onClick={() => (talk ? leaveTalk.current?.() : openTalk())} />}
        </CardLog>
        {voice}
      </HoldToTalk.Provider>
    );
  }

  const isUnderway = (id: string) => underway.includes(id);
  const obeyaSnap = snaps[obeyaId];
  const unreadOf = (id: string) => (snaps[id] ? unreadAnswers(snaps[id].talk) : 0);
  const unread = ordered.reduce((n, c) => n + unreadOf(c.id), 0);
  /** The panel, with the conversation an answer waits unread in when the one last picked has none. */
  const openTalkNewest = () => {
    const waiting = ordered.find((c) => unreadOf(c.id));
    if (!unreadOf(obeyaId) && waiting) setObeyaCanvas(waiting.id);
    openTalk();
  };
  const shown = talk && !closing;
  const setAside = new Set(all.filter(({ item }) => staysAside(aside, item)).map(({ item }) => item.id));
  // what "Needs you" leaves out: the cards the owner acted on, and those set aside
  const leftOut = (id: string) => isUnderway(id) || setAside.has(id);
  const active = (i: Item) => runs(i) || !!i.snoozed?.waiting || isUnderway(i.id);
  // a snoozed card at the end, after those at work now; one the owner snoozed while it waited for them among them
  const running = all.filter(({ item }) => active(item) && !setAside.has(item.id)).sort((a, b) => Number(!!a.item.snoozed) - Number(!!b.item.snoozed));
  // what would stand in "Needs you" or "Running" but for being set aside
  const putAway = all.filter(({ item }) => setAside.has(item.id) && (needsYou(item) || active(item)));
  // the tasks nobody has started yet (stopped ones and those set to start at a time among them), but nothing the lists above show already
  const planned = all.filter(({ item }) => plannedLater(item) && !runs(item) && !isUnderway(item.id));
  // what the canvas's "Archive finished cards" would take, but nothing the lists above show already
  const waitsHere = forYouTotal(ordered, snaps, leftOut);
  const done = all.filter(({ item }) => finishedArchivable(item) && !needsYou(item) && !item.snoozed?.waiting && !runs(item) && !isUnderway(item.id));
  // until the owner has swiped a card aside once, the first one in sight nudges, with a line above it saying how
  const inSight = (list: string, c: CanvasInfo) => !several || !folded.includes(`${list}:${c.id}`);
  const firstWaiting = ordered.filter((c) => inSight('forYou', c)).flatMap((c) => forYouOf(snaps[c.id]!, leftOut).cards)[0];
  const firstRunning = ordered.filter((c) => inSight('running', c)).flatMap((c) => running.filter((x) => x.canvas.id === c.id))[0]?.item;
  const hint = swipedOnce(SWIPED_CARD) ? undefined : (firstWaiting ?? firstRunning)?.id;
  const hintIn = hint && (firstWaiting ? 'forYou' : 'running');
  // to the left, a card waiting for the owner is snoozed instead
  const swipeWaiting: Swipe = { onGone: putAside, label: t.phone.asideLabel, snooze: true, hint };
  const swipeRunning: Swipe = { onGone: putAside, label: t.phone.asideLabel, hint };
  /** A list's cards on each canvas, swiped aside with `swipe`. */
  const cardsOf = (entries: { item: Item; canvas: CanvasInfo }[], swipe?: Swipe) => ({
    count: (c: CanvasInfo) => entries.filter((x) => x.canvas.id === c.id).length,
    cards: (c: CanvasInfo) => entries.filter((x) => x.canvas.id === c.id).map(({ item: i }) => <PhoneCard key={i.id} item={i} swipe={swipe} onOpen={openCard} />),
  });
  const runningCards = cardsOf(running, swipeRunning);
  // of those, the ones an agent or Obeya is at right now, not snoozed nor waiting for their agent to pick up the owner's words
  const atWork = (c: CanvasInfo) => running.filter(({ item, canvas }) => canvas.id === c.id && runs(item) && !item.snoozed).length;
  const asideCards = cardsOf(putAway, { onGone: bringBack, label: t.phone.backLabel });
  const plannedCards = cardsOf(planned);
  const doneCards = cardsOf(done);
  return (
    <HoldToTalk.Provider value={press}>
      <div id="ph-home" className="ph-view" ref={homeRef}>
        <header className="ph-bar ph-home">
          <Sign size={26} />
          <span className="ph-word">Obeya</span>
          {usage && <UsagePill usage={usage} />}
        </header>
        {banner}
        <Notify />
        <section className="ph-section">
          <h2>
            {t.phone.forYou}
            {waitsHere > 0 && (
              <span className="waits" title={t.nav.waiting(waitsHere)}>
                {waitsHere}
              </span>
            )}
          </h2>
          {/* nothing known yet (the server has not answered since the page loaded): no claim that nothing waits */}
          {ordered.length > 0 && !waitsHere && <p className="ph-none">{putAway.some(({ item }) => needsYou(item)) ? t.phone.nothingElseWaits : t.phone.nothingWaits}</p>}
          {hintIn === 'forYou' && <p className="ph-hint">{t.phone.swipeHint}</p>}
          <ByCanvas list="forYou" canvases={ordered} several={several} waits count={(c) => forYouCount(snaps[c.id]!, leftOut)}>
            {(c) => (
              <ForYouRows
                waiting={snaps[c.id]!}
                canvas={c.id}
                underway={leftOut}
                swipe={swipeWaiting}
                onOpen={openCard}
                onObeya={(id) => {
                  setObeyaCanvas(id);
                  openTalk();
                }}
              />
            )}
          </ByCanvas>
        </section>
        <section className="ph-section">
          <h2>{t.phone.running}</h2>
          {ordered.length > 0 && !running.length && <p className="ph-none">{putAway.some(({ item }) => active(item)) ? t.phone.nothingElseRuns : t.phone.nothingRuns}</p>}
          {hintIn === 'running' && <p className="ph-hint">{t.phone.swipeHintRunning}</p>}
          <ByCanvas list="running" canvases={ordered} several={several} count={runningCards.count} atWork={atWork}>
            {runningCards.cards}
          </ByCanvas>
        </section>
        {putAway.length > 0 && (
          <Folded label={t.phone.setAside} n={putAway.length} open={asideOpen} onToggle={toggleAsideOpen}>
            <p className="ph-hint">{t.phone.setAsideHint}</p>
            <ByCanvas list="aside" canvases={ordered} several={several} count={asideCards.count}>
              {asideCards.cards}
            </ByCanvas>
          </Folded>
        )}
        {planned.length > 0 && (
          <Folded label={t.phone.planned} n={planned.length} open={plannedOpen} onToggle={togglePlanned}>
            <ByCanvas list="planned" canvases={ordered} several={several} count={plannedCards.count}>
              {plannedCards.cards}
            </ByCanvas>
          </Folded>
        )}
        {done.length > 0 && (
          <Folded label={t.phone.done} n={done.length} open={doneOpen} onToggle={toggleDone}>
            <ByCanvas list="done" canvases={ordered} several={several} count={doneCards.count}>
              {doneCards.cards}
            </ByCanvas>
          </Folded>
        )}
      </div>
      {talk && (
        <TalkPanel title={t.coordinator.title} label={t.phone.talkTitle} banner={banner} onClose={closeTalk} leave={leaveTalk} onLeave={() => setClosing(true)}>
          {obeyaSnap && (
            <div className="ph-talk" key={obeyaId}>
              <CoordinatorTalk
                on
                talk={obeyaSnap.talk}
                items={obeyaSnap.items}
                repos={obeyaSnap.canvas.repos}
                onOpen={openCard}
                onTell={(text, images, replyTo) => void tellTyped(text, images, null, undefined, replyTo)}
                draft={obeyaDraft(obeyaId)}
              />
            </div>
          )}
        </TalkPanel>
      )}
      <TalkButton label={t.phone.talkTitle} shown={shown} n={unread} count={t.coordinator.unreadCount(unread)} working={ordered.some((c) => obeyaWorks(snaps[c.id]!.talk))} onClick={() => (talk ? leaveTalk.current?.() : openTalkNewest())} />
      {/* right of the microphone, with several canvases: whose Obeya the microphone and the panel speak to */}
      {several && (
        <label className="pill ph-canvas-pick">
          <span className="name">{canvases.find((c) => c.id === obeyaId)?.name}</span>
          <span className="hint">▾</span>
          <select value={obeyaId} aria-label={t.phone.canvas} onChange={(e) => setObeyaCanvas(e.target.value)}>
            {canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {voice}
    </HoldToTalk.Provider>
  );
}

/**
 * A list's entries canvas by canvas, in the switcher's order: with several canvases each under a head
 * with its name and how many it holds, which folds them away and keeps the count, as the navigation's
 * canvases do (kept per list and canvas in this browser); with one, the entries alone. A canvas with
 * none in the list has no head. With `atWork`, the count splits into the entries at rest and, in the
 * colour of work, those at work ("2 + 1"), since "Running" also holds snoozed cards.
 */
function ByCanvas({ list, canvases, several, waits, count, atWork, children }: { list: string; canvases: CanvasInfo[]; several: boolean; waits?: boolean; count: (c: CanvasInfo) => number; atWork?: (c: CanvasInfo) => number; children: (c: CanvasInfo) => ReactNode }) {
  const folded = useFoldedCanvases(CANVASES_FOLDED);
  const listed = canvases.flatMap((c) => {
    const n = count(c);
    return n ? [{ c, n }] : [];
  });
  if (!several)
    return (
      <>
        {listed.map(({ c }) => (
          <ul key={c.id} className="ph-list">
            {children(c)}
          </ul>
        ))}
      </>
    );
  return (
    <>
      {listed.map(({ c, n }) => {
        const id = `${list}:${c.id}`;
        const shut = folded.includes(id);
        return (
          <div key={c.id} className={['ph-group', shut && 'folded'].filter(Boolean).join(' ')}>
            <button className="ph-group-head" aria-expanded={!shut} aria-label={`${shut ? t.nav.unfold : t.nav.fold}: ${c.name}`} onClick={() => toggleFolded(CANVASES_FOLDED, id)}>
              <FoldArrow />
              <span className="name">{c.name}</span>
              {atWork ? <CountAtWork n={n} working={atWork(c)} /> : <span className={waits ? 'waits' : 'n'}>{n}</span>}
            </button>
            {!shut && <ul className="ph-list">{children(c)}</ul>}
          </div>
        );
      })}
    </>
  );
}

/** `n` cards, `working` of them at work: the others in the plain count, a "+" and those at work in blue; either alone without the "+". */
function CountAtWork({ n, working }: { n: number; working: number }) {
  const rest = n - working;
  return (
    <span className="counts" title={t.phone.atWork(rest, working)}>
      {rest > 0 && <span className="n">{rest}</span>}
      {rest > 0 && working > 0 && <span className="plus">+</span>}
      {working > 0 && <span className="n working">{working}</span>}
    </span>
  );
}

/** A task planned and not archived that neither waits for the owner nor got snoozed while it did: the phone's "Planned". */
const plannedLater = (i: Item) => i.kind === 'task' && i.state === 'planned' && !i.archivedAt && !needsYou(i) && !i.snoozed?.waiting;

/** Whether a folded list is open, kept in this tab under `key`, and the toggle that opens and closes it. */
function useFolded(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => flag(session, key));
  const toggle = () =>
    setOpen((o) => {
      setFlag(session, key, !o);
      return !o;
    });
  return [open, toggle];
}

/**
 * The cards set aside, planned or done, below the others: a head with their count that opens and
 * closes the list. Opened, the head moves to the top of the screen so the cards below it show.
 */
function Folded({ label, n, open, onToggle, children }: { label: string; n: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const head = useRef<HTMLElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (open && opened.current) head.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    opened.current = false;
  }, [open]);
  return (
    <section className={['ph-section ph-fold', open && 'open'].filter(Boolean).join(' ')} ref={head}>
      <h2>
        <button
          aria-expanded={open}
          onClick={() => {
            opened.current = !open;
            onToggle();
          }}
        >
          <span className="arrow" aria-hidden="true" />
          <span className="label">{label}</span>
          <span className="n">{n}</span>
        </button>
      </h2>
      {open && children}
    </section>
  );
}

/**
 * Left of the microphone, in reach of the thumb, as the canvas's top bar has it: opens the conversation
 * of what is in view as a panel, and closes it while it is open (inverted then). `n`: what waits there;
 * `working`: the conversation shows an agent (or Obeya) at work, which the moving line of a working card says.
 */
function TalkButton({ label, shown, n, count, working, onClick }: { label: string; shown: boolean; n: number; count: string; working: boolean; onClick: () => void }) {
  return (
    <button className={['pill kpill talk-pill ph-talk-open', shown && 'on', working && 'working'].filter(Boolean).join(' ')} aria-expanded={shown} aria-label={shown ? t.phone.closeTalk : label} onClick={onClick}>
      <TalkIcon />
      {!shown && n > 0 && (
        <span className="n unread" title={count}>
          {n}
        </span>
      )}
    </button>
  );
}

/**
 * The button for an open card's conversation: what waits there is the messages not seen yet and the
 * questions open, which count as one, the block they stand in together.
 */
function CardTalkButton({ item, open, shown, onClick }: { item: Item; open: boolean; shown: boolean; onClick: () => void }) {
  const events = useCardLog();
  // the conversation marks what it holds seen while it is open
  const messages = events && !open ? unseen(cardTalk(item, events), events, seenOf(item.id)) : 0;
  const questions = openQuestions(item).length;
  const working = agentWorks(item) || (!!events && coordinatorReads(events));
  return <TalkButton label={t.phone.cardTalk} shown={shown} n={messages + (questions ? 1 : 0)} count={t.phone.cardWaiting(messages, questions)} working={working} onClick={onClick} />;
}

/**
 * A conversation as a panel from below, Obeya's or the open card's (`children`): the conversation is
 * the only thing in it that scrolls, the field stands under it and the microphone below that.
 * Its top is a grip the owner drags to the height they want (`settle`): let go near the screen's top
 * it takes the full height, near the bottom it closes (as the button beside the microphone and Back
 * do). Let go in motion, it glides on and slows down (`thrown`), so a short swipe throws it to the
 * full height or closes it. It opens at the full height, or beside a demo video (`half`) in the
 * lower half of the screen.
 */
function TalkPanel({
  title,
  label,
  banner,
  half = false,
  onClose,
  leave: leaveRef,
  onLeave,
  focus,
  children,
}: {
  title: string;
  label: string;
  banner: React.ReactNode;
  half?: boolean;
  onClose: () => void;
  /** Where the panel puts its way of closing, for the button beside the microphone. */
  leave: React.RefObject<(() => void) | null>;
  /** The panel starts sliding out. */
  onLeave: () => void;
  /** Set: the cursor goes into the field once it is there. */
  focus?: React.RefObject<boolean>;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // the height the owner dragged it to, as a share of the screen the keyboard leaves; until then the
  // one it opens with
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => setHeight(null), [half]);
  const [leaving, setLeaving] = useState(false);
  /** Where the finger went down and where the panel's top stood then, both from the top of the screen the keyboard leaves, and where the finger has been since. */
  const drag = useRef<{ y: number; top: number; trail: Mark[] } | null>(null);
  // how a thrown panel glides on to where it comes to rest
  const [gliding, setGliding] = useState<{ ms: number; ease: string } | null>(null);
  const glided = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the panel follows the finger without easing
  const [dragging, setDragging] = useState(false);
  const gone = useRef(false);
  const leave = (ms = 200) => {
    if (gone.current) return;
    gone.current = true;
    onLeave();
    setLeaving(true);
    setTimeout(onClose, ms);
  };
  leaveRef.current = leave;
  // the panel takes the part of the screen the keyboard leaves, so the field stays above it (in Safari;
  // Chrome makes the page itself shorter, `keyboardResizes`)
  useEffect(() => {
    const vv = window.visualViewport;
    const el = panel.current;
    if (!vv || !el) return;
    const fit = () => {
      el.style.setProperty('--vvh', `${vv.height}px`);
      el.style.setProperty('--vvt', `${vv.offsetTop}px`);
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
    };
  }, []);
  // the confirmations above the microphone stand above the field while the panel is open; the field
  // comes with the conversation, which may arrive after the panel
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const root = document.documentElement;
    let field: Element | null = null;
    const size = new ResizeObserver(() => field && root.style.setProperty('--ph-field', `${field.getBoundingClientRect().height}px`));
    const find = () => {
      const f = el.querySelector('.composer');
      if (f === field) return;
      if (field) size.unobserve(field);
      field = f;
      if (!f) return root.style.removeProperty('--ph-field');
      size.observe(f);
      if (focus?.current) {
        focus.current = false;
        f.querySelector<HTMLTextAreaElement>('textarea')?.focus();
      }
    };
    const watch = new MutationObserver(find);
    watch.observe(el, { childList: true, subtree: true });
    find();
    return () => {
      watch.disconnect();
      size.disconnect();
      root.style.removeProperty('--ph-field');
    };
  }, []);
  // the page under a panel lower than the screen scrolls on until all of it can stand above the panel
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const root = document.documentElement;
    const size = new ResizeObserver(() => root.style.setProperty('--ph-panel', `${el.getBoundingClientRect().height}px`));
    size.observe(el);
    return () => {
      size.disconnect();
      root.style.removeProperty('--ph-panel');
    };
  }, []);
  const screen = () => ({ top: window.visualViewport?.offsetTop ?? 0, height: window.visualViewport?.height ?? innerHeight });
  const down = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, select')) return;
    drag.current = { y: e.clientY, top: panel.current!.getBoundingClientRect().top - screen().top, trail: [{ t: e.timeStamp, y: e.clientY }] };
    e.currentTarget.setPointerCapture(e.pointerId);
    clearTimeout(glided.current);
    setGliding(null);
  };
  /** Where the dragged top stands, as a share of the screen from its top. */
  const topAt = (e: React.PointerEvent) => {
    const d = drag.current!;
    return (d.top + e.clientY - d.y) / screen().height;
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current.trail = [...drag.current.trail.filter((m) => e.timeStamp - m.t < 200), { t: e.timeStamp, y: e.clientY }];
    setDragging(true);
    setHeight(Math.min(1, 1 - topAt(e)));
  };
  const up = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const moved = Math.abs(e.clientY - drag.current.y) > 4;
    const px = screen().height;
    // the top stands no higher than the screen's
    const at = Math.max(0, topAt(e));
    const v = e.type === 'pointercancel' ? 0 : speed(drag.current.trail, e.timeStamp);
    const to = settle(thrown(at, v, px));
    drag.current = null;
    setDragging(false);
    // a tap leaves the panel as it was
    if (!moved) return;
    let ms: number | undefined;
    if (Math.abs(v) >= THROWN) {
      // the way left to go: down out of the screen, or to the top's new place
      const g = glide(to === 'close' ? panel.current!.getBoundingClientRect().height : (at - (1 - to)) * px, v);
      ms = g.ms;
      setGliding(g);
      glided.current = setTimeout(() => setGliding(null), g.ms);
    }
    if (to === 'close') leave(ms);
    else setHeight(to);
  };
  const style = {
    ...(height === null ? {} : { '--ph-h': Math.max(0, height) }),
    ...(gliding ? { transitionDuration: `${gliding.ms}ms`, transitionTimingFunction: gliding.ease } : {}),
  };
  return (
    <div
      id="ph-talk"
      className={['ph-view ph-panel', half && 'half', (height ?? 1) < 1 && 'part', leaving && 'leaving', dragging && 'dragging'].filter(Boolean).join(' ')}
      ref={panel}
      style={style as React.CSSProperties}
      role="dialog"
      aria-label={label}
    >
      <header className="ph-bar ph-grip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <span className="ph-word">{title}</span>
      </header>
      {banner}
      {children}
    </div>
  );
}
