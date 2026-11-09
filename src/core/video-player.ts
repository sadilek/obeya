// A demo video's player in the look of the walkthroughs' (player.css): under the picture the sentence
// being spoken as a caption, the word being spoken marked, two lines at a time, switched with CC or
// C, and under that the controls, the progress bar in a segment per chapter. The card (src/ui/detail.tsx) and the shared demo pages
// (src/server/demo-page.ts) play their videos in it. A page carries it as its source
// (`(${videoPlayer})(…)`), so the function holds all it needs; what it takes from elsewhere comes in
// `lib`, each piece as self-contained.

import type { captionPages, pageOf } from './caption-pages';

/** The player's words, in the interface's or the page's language. */
export interface PlayerWords {
  play: string;
  pause: string;
  previous: string;
  next: string;
  /** CC's label and the hint beside it until C was used. */
  captions: string;
  captionsHint: string;
  /** The hint over the progress bar until ← or → was used. */
  seekHint: string;
  /** The picker of the captions' language, where there are several. */
  language: string;
  mute: string;
  unmute: string;
  fullscreen: string;
  fullscreenOff: string;
}

export interface PlayerOptions {
  /** The chapters' start times and titles: a segment of the progress bar each. */
  chapters: [number, string][];
  words: PlayerWords;
  /** A video without sound: its captions are the narration, always on. */
  silent?: boolean;
  /** The languages its captions come in, where the viewer has picked none, for a silent video: the interface's on the card, the browser's on a page. */
  prefer: readonly string[];
  /** It takes its keys itself (a shared page: Space, ← and →, C); on the card Obeya's own handlers route them. */
  keys?: boolean;
  /** A full screen button among its controls (a shared page). */
  fullscreen?: boolean;
}

export interface PlayerLib {
  captionPages: typeof captionPages;
  pageOf: typeof pageOf;
  preferredTrack: (tracks: readonly string[], preferred: readonly string[]) => string | undefined;
}

export interface Player {
  /** The end of the controls' row, for buttons of the card's own (zoom, the phone's full screen). */
  slot: HTMLElement;
  destroy: () => void;
}

/** The browser's choice of captions on or off, shared with the walkthroughs' player: set while they are off. */
export const CAPTIONS_OFF = 'obeya.walkthroughCaptionsOff';
/** Set once C switched captions: CC no longer shows the key beside it. */
export const CAPTIONS_KEY_KNOWN = 'obeya.walkthroughCaptionsKeyKnown';
/** Set once ← or → jumped in a demo video: the progress bar no longer shows the keys. */
export const SEEK_KEYS_KNOWN = 'obeya-seek-keys-known';
/** The event every player of the page hears when captions were switched on or off. */
export const CAPTIONS_CHANGED = 'obeya-captions';

/**
 * Builds the caption and the controls into `root` (a `.dp`), after the picture it holds (`video`
 * and what stands over it), and plays `video` with them; `data-captions` on `root` says whether the
 * caption shows. With its own full screen button it marks `root` `.full` while in full screen. A click on the picture plays or pauses it; a click
 * or a drag on the progress bar goes to that place; the arrows beside it go to the chapter before
 * (the start of this one, once it has played a few seconds) and after.
 */
export function videoPlayer(root: HTMLElement, video: HTMLVideoElement, o: PlayerOptions, lib: PlayerLib): Player {
  // the keys of the browser's storage, as exported above: the function carries its own copy
  const CAPTIONS_OFF = 'obeya.walkthroughCaptionsOff';
  const CAPTIONS_KEY_KNOWN = 'obeya.walkthroughCaptionsKeyKnown';
  const SEEK_KEYS_KNOWN = 'obeya-seek-keys-known';
  const CAPTIONS_CHANGED = 'obeya-captions';
  /** The language of captions the viewer picked last. */
  const LANGUAGE = 'obeya.captionsLanguage';
  /** How far ← and → jump, in seconds; how far into a chapter "previous" goes back to its start rather than to the one before. */
  const SEEK_S = 5;
  const RESTART_S = 3;
  const PATHS = {
    previous: 'M6 5h2.4v14H6zM19 5.6v12.8a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-6.4a.8.8 0 0 1 1.2.7z',
    next: 'M15.6 5H18v14h-2.4zM5 5.6v12.8a.8.8 0 0 0 1.2.7l8.2-6.4a.8.8 0 0 0 0-1.4L6.2 4.9A.8.8 0 0 0 5 5.6z',
    play: 'M7 4.9v14.2a.9.9 0 0 0 1.4.8l11.2-7.1a.9.9 0 0 0 0-1.6L8.4 4.1A.9.9 0 0 0 7 4.9z',
    pause: 'M6.5 4.5h3.6v15H6.5zM13.9 4.5h3.6v15h-3.6z',
    speaker: 'M3.5 9.2h3.8L12 5.3v13.4l-4.7-3.9H3.5z',
  };
  const w = o.words;
  const stored = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const store = (key: string, value: string | null) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  };
  const listeners: [EventTarget, string, EventListener][] = [];
  const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void) => {
    target.addEventListener(type, fn as EventListener);
    listeners.push([target, type, fn as EventListener]);
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement) => {
    const e = document.createElement(tag);
    e.className = cls;
    parent?.append(e);
    return e;
  };
  /** A button of the controls; a click with the mouse leaves the focus where it was, so the keys stay with the page. */
  const button = (cls: string, label: string, parent: HTMLElement, act: () => void) => {
    const b = el('button', `btn small ${cls}`.trim(), parent);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    on<MouseEvent>(b, 'mousedown', (e) => e.preventDefault());
    on(b, 'click', act);
    return b;
  };
  /** Draws a button's icon, anew only when it changes: it is asked for at every frame. */
  const icon = (b: HTMLElement, filled: string, stroked = '') => {
    if (b.dataset.icon === filled + stroked) return;
    b.dataset.icon = filled + stroked;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${filled ? `<path d="${filled}"/>` : ''}${stroked ? `<path class="s" d="${stroked}"/>` : ''}</svg>`;
  };
  const label = (b: HTMLElement, text: string) => {
    b.setAttribute('aria-label', text);
    b.title = text;
  };
  /** The hint of a key beside its control, shown on hover until the key was used. */
  const hint = (parent: HTMLElement, text: string, keys: string[]) => {
    const h = el('span', 'zoom-hint', parent);
    h.append(text);
    for (const k of keys) {
      h.append(' ');
      el('kbd', '', h).textContent = k;
    }
    return h;
  };
  const mmss = (s: number) => {
    const t = Math.max(0, Math.floor(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  // the chapters: the first from the start of the video, each to the start of the next, the last to its end
  const starts = (o.chapters.length ? o.chapters.map(([at]) => at) : [0]).map((at, k) => (k === 0 ? 0 : at));
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
  const end = (k: number) => {
    const next = starts[k + 1];
    if (next !== undefined) return next;
    const d = duration();
    // until the video's length is known, the last chapter is taken as long as the others on average
    return d > starts[k]! ? d : starts[k]! + (starts.length > 1 ? starts[k]! / (starts.length - 1) : 1);
  };
  const chapterAt = (t: number) => {
    let c = 0;
    for (const [k, s] of starts.entries()) if (t >= s - 0.05) c = k;
    return c;
  };
  const seek = (t: number) => {
    const d = duration();
    video.currentTime = Math.max(0, d ? Math.min(d, t) : t);
    render();
  };
  const toggle = () => (video.paused || video.ended ? void video.play().catch(() => {}) : video.pause());

  const caption = el('div', 'wt-caption');
  const captionText = el('div', '', caption);
  const controls = el('div', 'wt-controls');
  const several = starts.length > 1;
  const prev = several
    ? button('', w.previous, controls, () => {
        const t = video.currentTime;
        const c = chapterAt(t);
        seek(t - starts[c]! > RESTART_S || c === 0 ? starts[c]! : starts[c - 1]!);
      })
    : null;
  if (prev) icon(prev, PATHS.previous);
  const play = button('wt-play', w.play, controls, toggle);
  const next = several ? button('', w.next, controls, () => seek(starts[Math.min(starts.length - 1, chapterAt(video.currentTime) + 1)]!)) : null;
  if (next) icon(next, PATHS.next);
  // a segment per chapter, as long as the chapter plays
  const bar = el('div', 'wt-segments wt-key', controls);
  const segs = starts.map((_, k) => {
    const s = el('button', 'wt-seg', bar);
    s.type = 'button';
    const title = o.chapters[k]?.[1];
    if (title) label(s, title);
    else s.setAttribute('aria-label', mmss(starts[k]!));
    on<MouseEvent>(s, 'mousedown', (e) => e.preventDefault());
    el('i', '', el('span', '', s));
    return s;
  });
  const seekHint = hint(bar, w.seekHint, ['←', '→']);
  const count = el('span', 'wt-count', controls);
  const mute = o.silent ? null : button('wt-mute', w.mute, controls, () => (video.muted = !video.muted));
  const language = el('select', 'wt-lang', controls);
  language.setAttribute('aria-label', w.language);
  language.title = w.language;
  const cc = button('wt-key wt-cc', w.captions, controls, () => setCaptions(!captionsWanted()));
  const ccHint = hint(cc, w.captionsHint, ['C']);
  cc.append('CC');
  const canFull = !!o.fullscreen && (document.fullscreenEnabled || 'webkitEnterFullscreen' in video);
  const full = canFull
    ? button('wt-full', w.fullscreen, controls, () => {
        if (document.fullscreenElement === root) return void document.exitFullscreen().catch(() => {});
        // an iPhone puts no element into full screen, only a video, in its own player
        if (document.fullscreenEnabled) void root.requestFullscreen().catch(() => {});
        else (video as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen();
      })
    : null;
  const slot = el('span', 'dp-slot', controls);
  root.append(caption, controls);

  // the bar: a click or a drag goes to the place under the pointer, within its chapter's segment
  const placeAt = (x: number) => {
    let k = 0;
    for (const [i, s] of segs.entries()) if (x >= s.getBoundingClientRect().left) k = i;
    const r = segs[k]!.getBoundingClientRect();
    const share = r.width ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0;
    return starts[k]! + share * (end(k) - starts[k]!);
  };
  let dragging = false;
  on<PointerEvent>(bar, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    seek(placeAt(e.clientX));
  });
  on<PointerEvent>(bar, 'pointermove', (e) => dragging && seek(placeAt(e.clientX)));
  on(bar, 'pointerup', () => (dragging = false));
  on(bar, 'pointercancel', () => (dragging = false));
  // a key's hint stays away once the key was used
  on(bar, 'pointerenter', () => (seekHint.hidden = stored(SEEK_KEYS_KNOWN) === '1'));
  on(cc, 'pointerenter', () => (ccHint.hidden = stored(CAPTIONS_KEY_KNOWN) === '1'));
  on(video, 'click', toggle);

  // the captions: one track at a time, in the language picked, drawn under the picture rather than over it
  let track: TextTrack | null = null;
  const tracks = () => [...video.textTracks];
  const pick = () => {
    const ts = tracks();
    const langs = ts.map((t) => t.language);
    const kept = stored(LANGUAGE);
    const want = kept && langs.includes(kept) ? kept : o.silent ? lib.preferredTrack(langs, o.prefer) : langs[0];
    return ts.find((t) => t.language === want) ?? ts[0] ?? null;
  };
  const captionsWanted = () => !!o.silent || stored(CAPTIONS_OFF) !== '1';
  const setCaptions = (show: boolean) => {
    store(CAPTIONS_OFF, show ? null : '1');
    dispatchEvent(new Event(CAPTIONS_CHANGED));
  };
  const useTrack = (t: TextTrack | null) => {
    track = t;
    for (const x of tracks()) x.mode = x === t ? 'hidden' : 'disabled';
    shownKey = null;
    render();
  };
  const offerTracks = () => {
    const ts = tracks();
    language.replaceChildren(
      ...ts.map((t, k) => {
        const opt = document.createElement('option');
        opt.value = String(k);
        opt.textContent = t.label || t.language || '–';
        return opt;
      }),
    );
    language.hidden = ts.length < 2;
    useTrack(pick());
    language.value = String(Math.max(0, ts.indexOf(track!)));
    showCaptions();
  };
  on(language, 'change', () => {
    const t = tracks()[Number(language.value)] ?? null;
    if (t?.language) store(LANGUAGE, t.language);
    useTrack(t);
  });
  const showCaptions = () => {
    const show = !!track && captionsWanted();
    caption.hidden = !show;
    cc.hidden = !track || !!o.silent;
    cc.classList.toggle('on', show);
    cc.setAttribute('aria-pressed', String(show));
    root.toggleAttribute('data-captions', show);
    render();
  };
  on(window, CAPTIONS_CHANGED, showCaptions);
  on(video.textTracks, 'addtrack', offerTracks);
  on(video.textTracks, 'removetrack', offerTracks);

  // a page of the caption at a time: the words measured in the caption's font, against its width
  const ctx = document.createElement('canvas').getContext('2d');
  let measure: { widthOf: (text: string) => number; line: number } | null = null;
  const fit = () => {
    if (!ctx || caption.hidden) return;
    const css = getComputedStyle(caption);
    ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    // a little room kept: the browser's line breaks and the canvas's widths differ by a pixel here and there
    measure = { widthOf: (text) => ctx.measureText(text).width, line: (caption.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)) * 0.97 };
    paged = null;
    render();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(caption);
  void document.fonts?.ready.then(fit);
  let paged: { text: string; words: string[]; starts: number[] } | null = null;
  /** What the caption shows: the page's words, the word marked in it (-1: none), whether it points. */
  let shownKey: string | null = null;
  /** The words of the cue being spoken, and how far into it the video is, 0 to 1. */
  const cue = (): { text: string; share: number } => {
    const cues = track?.activeCues;
    const c = cues?.length ? (cues[cues.length - 1] as VTTCue) : null;
    if (!c) return { text: '', share: 0 };
    const text = (c.text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    return { text, share: c.endTime > c.startTime ? (video.currentTime - c.startTime) / (c.endTime - c.startTime) : 0 };
  };
  const drawCaption = () => {
    if (caption.hidden) return;
    const { text, share } = cue();
    if (paged?.text !== text) {
      const words = text ? text.split(' ') : [];
      paged = { text, words, starts: measure ? lib.captionPages(words, measure.widthOf, measure.line) : [0] };
    }
    // the word being spoken, by its letters' share of the cue, as the cue's own time is its sentence's share of the scene's clip
    const { words, starts: pages } = paged;
    const weights = words.map((x) => x.length + 2);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let word = -1;
    let at = 0;
    for (const [k, x] of weights.entries()) {
      if (share * total >= at) word = k;
      at += x;
    }
    const page = lib.pageOf(pages, word);
    const from = pages[page]!;
    const shown = words.slice(from, pages[page + 1] ?? words.length);
    // the pointer only where the words shown are those heard: the narration's track of a video with sound
    const pointing = !o.silent && !!track && track === tracks()[0] && word >= 0;
    const key = JSON.stringify([shown, pointing ? word - from : -1]);
    if (key === shownKey) return;
    shownKey = key;
    caption.classList.toggle('pointing', pointing);
    captionText.replaceChildren(
      ...shown.map((x, i) => {
        const s = document.createElement('span');
        if (i > 0) s.append(' ');
        const inner = document.createElement('span');
        inner.textContent = x;
        s.append(inner);
        if (pointing && from + i <= word) inner.className = from + i < word ? 'said' : 'now';
        return s;
      }),
    );
  };

  function render() {
    const t = video.currentTime;
    const playing = !video.paused && !video.ended;
    const c = chapterAt(t);
    icon(play, playing ? PATHS.pause : PATHS.play);
    label(play, playing ? w.pause : w.play);
    if (prev) prev.disabled = t < 0.5;
    if (next) next.disabled = c >= starts.length - 1;
    for (const [k, s] of segs.entries()) {
      s.style.flexGrow = String(Math.max(1, end(k) - starts[k]!));
      const share = k < c ? 1 : k > c ? 0 : Math.min(1, (t - starts[k]!) / Math.max(0.1, end(k) - starts[k]!));
      (s.firstChild!.firstChild as HTMLElement).style.width = `${share * 100}%`;
    }
    count.textContent = duration() ? `${mmss(t)} / ${mmss(duration())}` : mmss(t);
    if (mute) {
      icon(mute, PATHS.speaker, video.muted ? 'M15.5 9.5l5 5M20.5 9.5l-5 5' : 'M15.2 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8');
      label(mute, video.muted ? w.unmute : w.mute);
    }
    if (full) {
      const isFull = document.fullscreenElement === root;
      icon(full, '', isFull ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
      label(full, isFull ? w.fullscreenOff : w.fullscreen);
      root.classList.toggle('full', isFull);
    }
    drawCaption();
  }
  // while it plays, the bar and the caption follow it frame by frame
  let frame = 0;
  const tick = () => {
    render();
    frame = !video.paused && !video.ended ? requestAnimationFrame(tick) : 0;
  };
  on(video, 'play', () => frame || (frame = requestAnimationFrame(tick)));
  for (const e of ['pause', 'ended', 'seeked', 'timeupdate', 'loadedmetadata', 'durationchange', 'volumechange']) on(video, e, render);
  on(document, 'fullscreenchange', render);

  // the keys of a shared page, for the player playing, else the one used last, else the first
  type Keyed = { root: HTMLElement; video: HTMLVideoElement; used: number };
  const me: Keyed = { root, video, used: 0 };
  const players = ((window as unknown as { obeyaPlayers?: Keyed[] }).obeyaPlayers ??= []);
  if (o.keys) {
    players.push(me);
    on(root, 'pointerdown', () => (me.used = performance.now()));
    on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
      const live = players.filter((p) => p.root.isConnected);
      const keyed = live.find((p) => !p.video.paused && !p.video.ended) ?? [...live].sort((a, b) => b.used - a.used)[0];
      if (keyed !== me) return;
      if (e.code === 'Space') {
        // a button reached with Tab takes Space itself
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        if (!e.repeat) toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        seek(video.currentTime + (e.key === 'ArrowLeft' ? -SEEK_S : SEEK_S));
        store(SEEK_KEYS_KNOWN, '1');
      } else if ((e.key === 'c' || e.key === 'C') && track && !o.silent) {
        e.preventDefault();
        if (e.repeat) return;
        store(CAPTIONS_KEY_KNOWN, '1');
        setCaptions(!captionsWanted());
      }
    });
  }

  offerTracks();
  return {
    slot,
    destroy: () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
      const i = players.indexOf(me);
      if (i >= 0) players.splice(i, 1);
      caption.remove();
      controls.remove();
      root.removeAttribute('data-captions');
    },
  };
}
