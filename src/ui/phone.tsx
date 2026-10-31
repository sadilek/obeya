// The phone view: on a phone the page shows, instead of the canvas, what waits for the owner across
// every canvas („Für dich“), what runs („Läuft“) and, folded away until opened, what is done but not
// archived yet („Erledigt“); Obeya's conversation is a panel of its own that
// comes up from below. A card opens full screen with the canvas's own detail view (answer options,
// demo, approve buttons), its conversation in the same panel, and Back returns to the list. The microphone is held by touch; Enter breaks the line, only Send sends;
// what was typed but not sent survives a reload. It holds one WebSocket per canvas.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type CanvasInfo, type CanvasSnapshot, type CardPatch, finishedArchivable, type Item, needsYou, openQuestions, unreadAnswers, type Usage } from '../core/types';
import { api, beforeReload, cardsOn, onNotice, phoneInUse, setCanvas, useCanvas, type Where } from './api';
import { enterBreaksLines } from './composer';
import { type ActDone, Detail, type Pending, TalkElsewhere, useEvents } from './detail';
import { cardDraft, fieldOn, focusedDraft, keepDrafts, MIC_DRAFT, obeyaDraft } from './draft';
import { KoordinatorTalk } from './koordinator';
import { Sign } from './logo';
import { Notify, registerWorker } from './notify';
import { plain } from './markdown';
import { Cards } from './message';
import { glide, type Mark, settle, speed, THROWN, thrown } from './panelHeight';
import { CardFace, cardClass, shownState, TalkIcon } from './parts';
import { videoOf } from './spot';
import { clock, failText, forTouch, shortDay, t } from './strings';
import { UsagePill } from './usage';
import { agentWorks, cardTalk, koordinatorReads, obeyaWorks, opensWithTalk, runs, unseen } from './talk';
import { seenOf } from './seen';
import { noticeLine, tellers, useAck } from './tell';
import { HoldToTalk, PushToTalk, ToldList, usePushToTalk, useTold } from './voice';

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
/** Whether the owner opened „Geplant“ or „Erledigt“ in this tab; each starts closed. */
const PLANNED_OPEN = 'obeya-phone-planned';
const DONE_OPEN = 'obeya-phone-done';
/** How long the server may not answer before the view says so: a phone back from its lock screen reconnects within this. */
const QUIET_MS = 3000;

/** The address with `card` open (or none) and the conversation of what is in view open or not, keeping what else it holds (`?view=phone`, say). */
function addressWith({ card, talk }: { card: string | null; talk: boolean }) {
  const q = new URLSearchParams(location.search);
  if (card) q.set('card', card);
  else q.delete('card');
  if (talk) q.set('talk', '');
  else q.delete('talk');
  const s = q.toString().replace(/=(&|$)/g, '$1');
  return `${location.pathname}${s ? `?${s}` : ''}`;
}
const cardInAddress = () => new URLSearchParams(location.search).get('card');
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

/** When something began: the time today, else the day. */
const when = (iso: string | number) => (new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : shortDay(iso));

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
  const [snaps, setSnaps] = useState<Record<string, CanvasSnapshot>>({});
  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;
  const [offline, setOffline] = useState<Record<string, number | null>>({});
  // the plan's usage limits, the same over every canvas's connection
  const [usage, setUsage] = useState<Usage | null>(null);
  const feed = (id: string, live: ReturnType<typeof useCanvas>) => {
    setUsage(live.usage);
    if (live.snapshot) setSnaps((s) => (s[id] === live.snapshot ? s : { ...s, [id]: live.snapshot! }));
    setOffline((o) => (o[id] === live.offlineSince ? o : { ...o, [id]: live.offlineSince }));
    if (live.canvases) setCanvases(live.canvases);
  };

  // ---------------------------------------------------------------- what is open
  const [open, setOpenState] = useState<string | null>(cardInAddress);
  const openRef = useRef(open);
  openRef.current = open;
  // the conversation of what is in view, a panel over it: the open card's, else Obeya's
  const [talk, setTalk] = useState(talkInAddress);
  const talkRef = useRef(talk);
  talkRef.current = talk;
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
  // a tapped push: its card (or „Für dich“ for several) in the app that is open already
  useEffect(() => {
    registerWorker();
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const tapped = (e: MessageEvent) => {
      if (e.data?.type !== 'open' || typeof e.data.url !== 'string') return;
      const card = new URL(e.data.url, location.href).searchParams.get('card');
      if (card) openId(card);
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
      setOpenState(cardInAddress());
      setTalk(talkInAddress());
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  // „Geplant“ and „Erledigt“ start closed, and stay as the owner left them while a card is open and over a reload
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
  const allRef = useRef(all);
  allRef.current = all;
  const byId = (id: string) => allRef.current.find((x) => x.item.id === id)?.item;
  // approved cards the server is still landing: they need the owner no longer
  const [underway, setUnderway] = useState<string[]>([]);
  useEffect(() => setUnderway((u) => u.filter((id) => byId(id)?.state === 'waiting')), [snaps]);
  const opened = open ? all.find((x) => x.item.id === open) : undefined;

  // the canvas whose Obeya is spoken to without a card open
  const [obeyaCanvas, setObeyaCanvasState] = useState(() => {
    const wanted = new URLSearchParams(location.search).get('c') ?? localStorage.getItem(OBEYA_CANVAS);
    return (canvases.find((c) => c.id === wanted) ?? canvases[0]!).id;
  });
  const obeyaId = canvases.some((c) => c.id === obeyaCanvas) ? obeyaCanvas : canvases[0]!.id;
  const obeyaRef = useRef(obeyaId);
  obeyaRef.current = obeyaId;
  const setObeyaCanvas = (id: string) => {
    setObeyaCanvasState(id);
    try {
      localStorage.setItem(OBEYA_CANVAS, id);
    } catch {}
  };
  // every call goes to the API of the canvas in view: the open card's, else Obeya's
  setCanvas(opened?.canvas.id ?? obeyaId);
  // and every call about a card to its canvas's
  for (const c of ordered) cardsOn(c.id, snaps[c.id]!.items.map((i) => i.id));

  // ---------------------------------------------------------------- edits of the open card
  const edit = useRef<{ id: string; patch: CardPatch; timer?: ReturnType<typeof setTimeout> } | null>(null);
  /** Saves what was typed into the open card; actions on it wait for this. */
  function flushEdit(): Promise<void> {
    const e = edit.current;
    if (!e) return Promise.resolve();
    clearTimeout(e.timer);
    edit.current = null;
    return Object.keys(e.patch).length ? api.patch(e.id, e.patch) : Promise.resolve();
  }
  const onEdit = (p: CardPatch) => {
    const id = openRef.current;
    if (!id) return;
    if (edit.current?.id !== id) flushEdit().catch(console.error);
    const e = (edit.current ??= { id, patch: {} });
    Object.assign(e.patch, p);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => flushEdit().catch(console.error), 400);
  };
  useEffect(() => beforeReload(() => void flushEdit().catch(console.error)), []);

  // ---------------------------------------------------------------- voice and confirmations
  const { showAck, showWait, fail, line: ackLine } = useAck(true);
  // the reply stands in Obeya's conversation, open in front of the owner: no line above the microphone
  const told = useTold(() => {}, (h) => talkRef.current && (h.inCard ? openRef.current === h.inCard : !!snapsRef.current[obeyaRef.current]?.talk.some((x) => x.id === h.talk)));
  const { tellAbout, tellTyped } = tellers(byId, told, fail, () => undefined);
  const where = (): Where => (openRef.current ? { card: openRef.current } : null);
  /** The draft of the field that speaks to `target`: the open card's, or the one under Obeya's conversation. */
  const draftFor = (target: Where) => (target && 'card' in target ? cardDraft(target.card) : obeyaDraft(obeyaRef.current));
  const fieldFor = (target: Where) => {
    const key = draftFor(target);
    return fieldOn(key) ? key : MIC_DRAFT;
  };
  const ptt = usePushToTalk(where, fieldFor, tellAbout, (h) => showAck(h.confirm), () => undefined);
  const pttRef = useRef(ptt);
  pttRef.current = ptt;
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
        const i = n.cardId ? byId(n.cardId) : undefined;
        told.show(i ? { id: i.id, title: plain(i.title) } : undefined, { confirm: noticeLine(n.text), ...(n.token ? { token: n.token } : {}), ...(n.undoMs ? { undoMs: n.undoMs } : {}), ...(n.talk ? { talk: n.talk } : {}), ...(n.inTalk && n.cardId ? { inCard: n.cardId } : {}) });
      }),
    [],
  );
  // Esc closes the open conversation, else the open card, as Back does (a keyboard at the phone, or the view tried at the desk)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.lightbox')) return;
      if (talkRef.current) closeTalk();
      else back();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  /** After an action on the open card: back to the list, with the confirmation; one the server is still at says so until it answered. */
  function onDone(d: ActDone, p?: Pending) {
    if (!d.close) return;
    back();
    if (!p || !d.pending) return showAck(d.ack, d.undo);
    const card = p.card;
    setUnderway((u) => [...u, card]);
    showWait(`${d.pending.charAt(0).toUpperCase()}${d.pending.slice(1)}`);
    p.answered.then(
      () => showAck(d.ack, d.undo),
      (e) => {
        setUnderway((u) => u.filter((id) => id !== card));
        showAck(t.cardError(p.title, failText(e)));
      },
    );
  }
  async function deleteOpen() {
    const i = opened?.item;
    if (!i) return;
    if (edit.current) clearTimeout(edit.current.timer);
    edit.current = null;
    back();
    try {
      await api.remove(i.id);
      showAck(t.deleted(plain(i.title)), () => api.restore(i.id));
    } catch (e) {
      fail(e);
    }
  }

  // ---------------------------------------------------------------- the machine not answering
  const quietSince = Object.values(offline).reduce<number | null>((min, x) => (x === null ? min : min === null ? x : Math.min(min, x)), null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (quietSince === null) return;
    const h = setTimeout(() => tick((n) => n + 1), Math.max(0, quietSince + QUIET_MS - Date.now()) + 50);
    return () => clearTimeout(h);
  }, [quietSince]);
  const quiet = quietSince !== null && Date.now() - quietSince >= QUIET_MS;

  const feeds = canvases.map((c) => <Feed key={c.id} id={c.id} onChange={feed} />);
  const several = canvases.length > 1;
  const banner = quiet && (
    <div className="ph-quiet" role="status">
      <b>{t.phone.notAnswering(when(quietSince!))}</b>
      <span>{t.phone.notAnsweringWhy}</span>
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
        {feeds}
        <div id="ph-card" className="ph-view" ref={cardRef} style={i ? ({ '--c': `var(--${shownState(i)})` } as React.CSSProperties) : undefined}>
          <header className="ph-bar">
            <button className="ph-back" onClick={back}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t.phone.back}
            </button>
            {c && several && <span className="ph-canvas">{c.name}</span>}
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
  // the tasks nobody has started yet (stopped ones and those set to start at a time among them), but nothing the lists above show already
  const planned = all.filter(({ item }) => plannedLater(item) && !runs(item) && !isUnderway(item.id));
  // what the canvas's „Erledigte archivieren“ would take, but nothing the lists above show already
  const done = all.filter(({ item }) => finishedArchivable(item) && !needsYou(item) && !item.snoozed?.waiting && !runs(item) && !isUnderway(item.id));
  return (
    <HoldToTalk.Provider value={press}>
      {feeds}
      <div id="ph-home" className="ph-view" ref={homeRef}>
        <header className="ph-bar ph-home">
          <Sign size={26} />
          <span className="ph-word">Obeya</span>
          {usage && <UsagePill usage={usage} />}
        </header>
        {banner}
        <Notify />
        <section className="ph-section">
          <h2>{t.phone.forYou}</h2>
          <ForYou
            canvases={ordered}
            snaps={snaps}
            several={several}
            underway={isUnderway}
            onOpen={openCard}
            onObeya={(id) => {
              setObeyaCanvas(id);
              openTalk();
            }}
          />
        </section>
        <section className="ph-section">
          <h2>{t.phone.running}</h2>
          {/* nothing known yet (the server has not answered since the page loaded): no claim that nothing runs */}
          {/* a snoozed card at the end, after those at work now */}
          {ordered.length > 0 && <Running entries={all.filter(({ item }) => runs(item) || isUnderway(item.id)).sort((a, b) => Number(!!a.item.snoozed) - Number(!!b.item.snoozed))} several={several} onOpen={openCard} />}
        </section>
        {planned.length > 0 && <Folded label={t.phone.planned} entries={planned} several={several} open={plannedOpen} onToggle={togglePlanned} onOpen={openCard} />}
        {done.length > 0 && <Folded label={t.phone.done} entries={done} several={several} open={doneOpen} onToggle={toggleDone} onOpen={openCard} />}
      </div>
      {talk && (
        <TalkPanel title={t.koordinator.title} label={t.phone.talkTitle} banner={banner} onClose={closeTalk} leave={leaveTalk} onLeave={() => setClosing(true)}>
          {obeyaSnap && (
            <div className="ph-talk" key={obeyaId}>
              <KoordinatorTalk
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
      <TalkButton label={t.phone.talkTitle} shown={shown} n={unread} count={t.koordinator.unreadCount(unread)} working={ordered.some((c) => obeyaWorks(snaps[c.id]!.talk))} onClick={() => (talk ? leaveTalk.current?.() : openTalkNewest())} />
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

/** One canvas's live snapshot, handed up as it changes. */
function Feed({ id, onChange }: { id: string; onChange: (id: string, live: ReturnType<typeof useCanvas>) => void }) {
  const live = useCanvas(id);
  useEffect(() => onChange(id, live), [live.snapshot, live.offlineSince, live.canvases, live.usage]);
  return null;
}

/** What waits for the owner, canvas by canvas in the switcher's order and within a canvas in Tab's order; Obeya where an answer waits unread. */
function ForYou({
  canvases,
  snaps,
  several,
  underway,
  onOpen,
  onObeya,
}: {
  canvases: CanvasInfo[];
  snaps: Record<string, CanvasSnapshot>;
  several: boolean;
  underway: (id: string) => boolean;
  onOpen: (i: Item) => void;
  onObeya: (canvas: string) => void;
}) {
  const rows = canvases.flatMap((c) => {
    const s = snaps[c.id]!;
    // cards snoozed while they waited for the owner stand at the end, until they come back
    const cards = [...s.items.filter((i) => needsYou(i) && !underway(i.id)), ...s.items.filter((i) => i.snoozed?.waiting)];
    const unread = unreadAnswers(s.talk) ? s.talk.filter((x) => x.unread) : [];
    return [
      ...cards.map((i) => (
        <li key={i.id}>
          <button className={`${cardClass(i)} ph-card`} onClick={() => onOpen(i)}>
            <CardFace item={i} where={several ? c.name : undefined} since={i.waitingSince ? t.phone.since(when(i.waitingSince)) : undefined} />
          </button>
        </li>
      )),
      ...(unread.length
        ? [
            <li key={`obeya:${c.id}`}>
              <button className="card s-working ph-card" onClick={() => onObeya(c.id)}>
                <div className="kind">
                  <span>{[several && c.name, t.koordinator.title].filter(Boolean).join(' · ')}</span>
                </div>
                <div className="ttl">{plain(unread.at(-1)!.question ?? unread.at(-1)!.said)}</div>
                <div className="state">
                  {t.phone.obeyaAnswered}
                  <span className="since"> · {t.phone.since(when(unread.at(-1)!.at))}</span>
                </div>
              </button>
            </li>,
          ]
        : []),
    ];
  });
  if (!canvases.length) return null;
  const waits = canvases.some((c) => snaps[c.id]!.items.some(needsYou) || unreadAnswers(snaps[c.id]!.talk) > 0);
  return (
    <>
      {!waits && <p className="ph-none">{t.phone.nothingWaits}</p>}
      {rows.length > 0 && <ul className="ph-list">{rows}</ul>}
    </>
  );
}

/** The cards at work, each with its status line, as their cards on the canvas show them. */
function Running({ entries, several, onOpen }: { entries: { item: Item; canvas: CanvasInfo }[]; several: boolean; onOpen: (i: Item) => void }) {
  if (!entries.length) return <p className="ph-none">{t.phone.nothingRuns}</p>;
  return (
    <ul className="ph-list">
      {entries.map(({ item: i, canvas: c }) => (
        <li key={i.id}>
          <button className={`${cardClass(i)} ph-card`} onClick={() => onOpen(i)}>
            <CardFace item={i} where={several ? c.name : undefined} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A task planned and not archived that neither waits for the owner nor got snoozed while it did: the phone's „Geplant“. */
const plannedLater = (i: Item) => i.kind === 'task' && i.state === 'planned' && !i.archivedAt && !needsYou(i) && !i.snoozed?.waiting;

/** Whether a folded list is open, kept in this tab under `key`, and the toggle that opens and closes it. */
function useFolded(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => sessionStorage.getItem(key) === '1');
  const toggle = () =>
    setOpen((o) => {
      try {
        if (o) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, '1');
      } catch {}
      return !o;
    });
  return [open, toggle];
}

/**
 * The cards planned or done, below the others: a head with their count that opens and closes the
 * list. Opened, the head moves to the top of the screen so the cards below it show.
 */
function Folded({ label, entries, several, open, onToggle, onOpen }: { label: string; entries: { item: Item; canvas: CanvasInfo }[]; several: boolean; open: boolean; onToggle: () => void; onOpen: (i: Item) => void }) {
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
          <span className="n">{entries.length}</span>
        </button>
      </h2>
      {open && (
        <ul className="ph-list">
          {entries.map(({ item: i, canvas: c }) => (
            <li key={i.id}>
              <button className={`${cardClass(i)} ph-card`} onClick={() => onOpen(i)}>
                <CardFace item={i} where={several ? c.name : undefined} />
              </button>
            </li>
          ))}
        </ul>
      )}
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
  const events = useEvents(item.id);
  // the conversation marks what it holds seen while it is open
  const messages = events && !open ? unseen(cardTalk(item, events), events, seenOf(item.id)) : 0;
  const questions = openQuestions(item).length;
  const working = agentWorks(item) || (!!events && koordinatorReads(events));
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
