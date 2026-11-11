// The player of a looked-up answer told as a walkthrough, under the question from its first slide on
// while the agent still tells it: it reads the walkthrough as it grows and plays slides and voice in
// step, items lighting up (a flow's boxes building up) as the narration reaches them, the spoken
// sentence as a caption whose pointer marks the word being spoken, two lines at a time; "CC" or C
// switch captions for every walkthrough and demo video of the browser. Slides and player take showntell's look
// (styles.css `.wt-*`, the caption and controls src/core/player.css, which a demo video's player shares). What it plays lives outside React, by walkthrough, so the player goes on unbroken when its message is
// drawn anew (the answer's words arriving above it) and pauses only once no message shows it; a
// restart's reload brings it back where it was. Without a voice (demo settings without one), each
// sentence stands as a caption for as long as reading it takes.

import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnswerFile } from '../core/types';
import { estimatedStarts, itemStarts, SLIDE_HEIGHT, SLIDE_WIDTH, type Walkthrough, wordsOf } from '../core/walkthrough';
import { answerFile, api, at, beforeReload } from './api';
import { captionPages, pageOf } from '../core/caption-pages';
import { CAPTIONS_CHANGED, CAPTIONS_KEY_KNOWN, CAPTIONS_OFF } from '../core/video-player';
import { know, known, local, session, setFlag, takeJson, writeJson, useKnown } from './stored';
import { t } from './strings';
import { plainKey, useZoom } from './zoom';
import { zoomBox } from './zoomBox';
import { signal } from './signal';

/** The deck's margin around the slide, on its sides and above it (styles.css `.wt-stage`). */
const WT_INSET = 10;
/** The caption's padding, and its two lines with a font that grows with the player's width between two sizes (styles.css `.wt-caption`). */
const WT_CAPTION = { padding: 14, lines: 2 * 1.45, font: (width: number) => Math.min(30, Math.max(15, 0.023 * width)) };
/** The row of controls under it; in a player narrower than 520 px the segments take a row of their own above them. */
const WT_CONTROLS = (width: number) => (width < 520 ? 62 : 38);

/**
 * Where a zoomed player stands in a window `w`×`h`: its picture (a slide, a video) of `aspect` as
 * large as fits with what stands around it, the deck's margin `inset` (a slide is narrower than the
 * player by both sides' margins), the caption while captions are on, and the controls. Those grow
 * with the width other than in step with it, so the box is worked out again for the width it came
 * to, until it settles.
 */
export function zoomedBox(aspect: number, w: number, h: number, captions: boolean, inset = 0) {
  const around = (width: number) => inset - (2 * inset) / aspect + WT_CONTROLS(width) + (captions ? WT_CAPTION.padding + WT_CAPTION.lines * WT_CAPTION.font(width) : 0);
  let box = zoomBox(aspect, w, h, { fixed: around(w), perWidth: 0 });
  for (let k = 0; k < 4; k++) box = zoomBox(aspect, w, h, { fixed: around(box.width), perWidth: 0 });
  return box;
}

/** Whether captions show, for every walkthrough and demo video of the page and the next one: the owner's choice, kept in the browser. */
let captionsOn = !known(CAPTIONS_OFF);
let captionsKeyKnown = known(CAPTIONS_KEY_KNOWN);

function setCaptions(on: boolean) {
  setFlag(local, CAPTIONS_OFF, !on);
  dispatchEvent(new Event(CAPTIONS_CHANGED));
}

// switched here or on a demo video's player: every walkthrough follows
if (typeof window !== 'undefined')
  addEventListener(CAPTIONS_CHANGED, () => {
    captionsOn = !known(CAPTIONS_OFF);
    for (const p of sessions.values()) p.notify();
  });

/**
 * C switches captions on or off where a walkthrough or a demo video is what the owner is at: one
 * zoomed, playing or under the pointer. Elsewhere C stays the key that opens the conversation with
 * Obeya; `true` when it took the key.
 */
export function captionKey(e: KeyboardEvent): boolean {
  if ((e.key !== 'c' && e.key !== 'C') || !plainKey(e)) return false;
  const video = [...document.querySelectorAll<HTMLVideoElement>('.dp video')].some((v) => !v.paused && !v.ended);
  if (!document.querySelector('.wt.zoomed, .dp.zoomed') && ![...sessions.values()].some((p) => p.playing) && !video && !document.querySelector('.wt:hover, .dp:hover')) return false;
  e.preventDefault();
  // a key held down switches once
  if (e.repeat) return true;
  know(CAPTIONS_KEY_KNOWN);
  captionsKeyKnown = true;
  setCaptions(!captionsOn);
  return true;
}

/** Scales the slide to the stage's width, as it changes. */
function useSlideScale(stage: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => el.style.setProperty('--wt-scale', String(el.clientWidth / SLIDE_WIDTH));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  });
}

/** How often the player reads the walkthrough while it grows or is voiced. */
const POLL_MS = 400;
/** The pause between two sentences of a slide, and between two slides. */
const GAP_S = 0.15;
const NEXT_SLIDE_MS = 600;
/** Seconds a sentence not voiced yet is taken to last, per character, to lay out its slide. */
const SECONDS_PER_CHAR = 0.075;
/** Without a voice: how long a sentence stands as a caption, by its characters, read beside the slide. */
const READING_PER_CHAR = 0.065;
const READING_FROM_S = 0.6;
const READING_MIN_S = 1.6;
const readingSeconds = (sentence: string) => Math.max(READING_MIN_S, READING_FROM_S + sentence.length * READING_PER_CHAR);

/** The walkthroughs this page asked for with "Show as walkthrough", by address: they start by themselves, the click allowed the sound. */
const askedHere = new Set<string>();

const walkthroughUrl = (thread: number, name: string) => at(`/threads/${thread}/walkthroughs/${encodeURIComponent(name)}`);

/** That the owner has used "Show as walkthrough": the newest answer's button no longer stays in view. */
const WALKTHROUGH_KNOWN = 'obeya.walkthroughKnown';

/** What plays a sentence: its voice, or without one the time it takes to read. */
type Sound = Pick<HTMLAudioElement, 'dataset' | 'currentTime' | 'ended' | 'play' | 'pause'>;

/** A sentence read rather than heard: it lasts as long as reading it takes, and ends as a clip does. */
class Reading implements Sound {
  dataset: DOMStringMap = {};
  ended = false;
  onended?: () => void;
  private seconds = 0;
  /** Seconds read while it does not go on. */
  private read = 0;
  /** When it went on, less what was read before. */
  private since?: number;
  private timer?: ReturnType<typeof setTimeout>;

  load(seconds: number) {
    this.pause();
    this.seconds = seconds;
    this.read = 0;
    this.ended = false;
  }

  get currentTime() {
    return this.since === undefined ? this.read : Math.min(this.seconds, (performance.now() - this.since) / 1000);
  }

  play() {
    if (this.since !== undefined) return Promise.resolve();
    if (this.ended) this.read = 0;
    this.ended = false;
    this.since = performance.now() - this.read * 1000;
    this.timer = setTimeout(() => {
      this.since = undefined;
      this.read = this.seconds;
      this.ended = true;
      this.onended?.();
    }, (this.seconds - this.read) * 1000);
    return Promise.resolve();
  }

  pause() {
    if (this.since === undefined) return;
    this.read = this.currentTime;
    this.since = undefined;
    clearTimeout(this.timer);
  }
}

/**
 * The voice of every player of the page, one at a time as they play. One element for all, so that
 * the first tap or click anywhere on the page allows its sound for good: a phone's browser (Safari
 * on the iPhone) plays an element's sound only once a tap started it, and a walkthrough asked for or
 * waiting for its voice starts playing after the tap, not in it.
 */
let voiceElement: HTMLAudioElement | undefined;
const theVoice = () => {
  if (voiceElement) return voiceElement;
  voiceElement = new Audio();
  voiceElement.preload = 'auto';
  voiceElement.onended = () => speaker?.ended();
  return voiceElement;
};
/** The player the voice speaks for. */
let speaker: Playback | undefined;
/** A WAV without a sample, played in the first tap or click. */
const NOTHING = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';
const allowSound = () => {
  if (speaker) return;
  const voice = theVoice();
  voice.src = NOTHING;
  voice.play().then(
    () => {
      for (const e of ['click', 'touchend']) removeEventListener(e, allowSound, true);
    },
    () => {},
  );
};
if (typeof window !== 'undefined') for (const e of ['click', 'touchend']) addEventListener(e, allowSound, true);

/** Where a player stood when a restart reloaded the page, by walkthrough. */
interface KeptPlace {
  slide: number;
  part: number;
  playing: boolean;
}
const KEPT_KEY = 'obeya-kept-walkthroughs';
/** How old a place may be to come back: a restart takes seconds. */
const KEPT_FRESH_MS = 5 * 60_000;

/** The places the reload before this page kept, taken once. */
const keptPlaces: Map<string, KeptPlace> = (() => {
  const k = takeJson<{ at: number; places: [string, KeptPlace][] }>(session, KEPT_KEY);
  // what a page wrote differently, or broken, keeps no place rather than the page from loading
  try {
    return new Map(k && Date.now() - k.at < KEPT_FRESH_MS ? k.places : []);
  } catch {
    return new Map();
  }
})();

class Playback {
  data: Walkthrough | null = null;
  missing = false;
  /** The slide and its sentence being played, or next. */
  slide = 0;
  part = 0;
  playing = false;
  /** Played once: before, a slide shows all its items. */
  started = false;
  /** Waiting for the voice of the sentence due. */
  waiting = false;
  /** Waiting for the agent's next slide. */
  writing = false;
  /** It started by itself once: it does not again. */
  autoplayed = false;
  /** The browser refused to play without a click (no click on the page yet). */
  refused = false;
  /** Without a voice, what plays its sentences; for a player the voice does not speak for, what stands still. */
  private readonly reader = new Reading();
  private next?: ReturnType<typeof setTimeout>;
  /** A read is running or due: one at a time. */
  private reading = false;
  private shown = 0;
  private hide?: ReturnType<typeof setTimeout>;
  private changes = signal();
  version = 0;

  constructor(
    private url: string,
    private clipUrl: (dir: string, file: string) => string,
    /** To start by itself once it can; the page may learn it only after the player showed (the click's reply comes after the walkthrough). */
    public autoplay: boolean,
  ) {
    this.reader.onended = () => this.ended();
    // where it stood before a restart reloaded the page: it plays on from there, if it played (and the tab is in sight)
    const kept = keptPlaces.get(url);
    if (kept) {
      this.slide = kept.slide;
      this.part = kept.part;
      if (kept.playing && !document.hidden) this.autoplay = true;
      else this.started = true;
    }
  }

  /** Without a voice the walkthrough is read. */
  get silent() {
    return !!this.data?.silent;
  }

  get audio(): Sound {
    return !this.silent && speaker === this ? theVoice() : this.reader;
  }

  /** Where it stands, for the reload a restart brings. */
  place(): KeptPlace | undefined {
    return this.started || this.autoplay ? { slide: this.slide, part: this.part, playing: this.playing || (this.autoplay && !this.autoplayed) } : undefined;
  }

  subscribe = this.changes.on;

  private changed() {
    this.version++;
    this.changes.emit();
  }

  /** Draws its player anew: something of the page changed that it shows (captions on or off). */
  notify() {
    this.changed();
  }

  /** A message shows the player; once none does, it pauses. */
  attach(): () => void {
    this.shown++;
    clearTimeout(this.hide);
    this.read();
    return () => {
      this.shown--;
      // the answer's words arriving draw its message anew: it shows again at once
      this.hide = setTimeout(() => {
        if (this.shown <= 0) this.pause();
      }, 500);
    };
  }

  private complete() {
    const d = this.data;
    // with its voice failed, it still gets the slides the agent writes; each sentence's words come once it is heard back
    return !!d && d.done && (!!d.error || !!d.silent || d.clips.every((c) => c.every((x) => x?.words)));
  }

  /** Reads the walkthrough, and again and again while it grows and a message shows it. */
  private read() {
    if (this.reading) return;
    this.reading = true;
    void this.poll();
  }

  private async poll() {
    try {
      const r = await fetch(`${this.url}?playing=${this.playing ? this.slide : -1}`, { cache: 'no-store' });
      if (r.status === 404) this.missing = true;
      else if (r.ok) this.data = (await r.json()) as Walkthrough;
    } catch {}
    this.grew();
    this.changed();
    if (this.complete() || this.missing || this.shown <= 0) this.reading = false;
    else setTimeout(() => void this.poll(), POLL_MS);
  }

  /** What came since: a slide the player waited for, a sentence voiced it waited for. */
  private grew() {
    const d = this.data;
    if (!d?.slides.length) return;
    if (this.autoplay && !this.started && !this.autoplayed) {
      this.autoplayed = true;
      // a place kept from before a restart within what is there
      this.slide = Math.min(this.slide, d.slides.length - 1);
      this.part = Math.min(this.part, d.slides[this.slide]!.parts.length - 1);
      this.play();
    }
    if (this.writing && this.slide + 1 < d.slides.length) {
      this.writing = false;
      if (this.playing) this.go(this.slide + 1);
    } else if (this.writing && d.done) {
      this.writing = false;
      this.playing = false;
    }
    if (this.playing && this.waiting && this.clip(this.slide, this.part)) this.playPart(this.slide, this.part);
  }

  clip(slide: number, part: number): { file: string; seconds: number; words?: number[] } | null {
    if (this.silent) {
      const sentence = this.data?.slides[slide]?.parts[part];
      return sentence === undefined ? null : { file: '', seconds: readingSeconds(sentence) };
    }
    return this.data?.clips[slide]?.[part] ?? null;
  }

  /** How long a sentence lasts: as voiced, else as its length suggests. */
  partSeconds(slide: number, part: number) {
    return this.clip(slide, part)?.seconds ?? (this.data?.slides[slide]?.parts[part]?.length ?? 0) * SECONDS_PER_CHAR;
  }

  partStart(slide: number, part: number) {
    let s = 0;
    for (let p = 0; p < part; p++) s += this.partSeconds(slide, p) + GAP_S;
    return s;
  }

  slideSeconds(slide: number) {
    return this.partStart(slide, this.data?.slides[slide]?.parts.length ?? 0);
  }

  /** Where in its sentence the player is; `undefined` while that sentence does not play (it waits for its voice). */
  private inPart() {
    return this.audio.dataset.key === `${this.slide}-${this.part}` ? this.audio.currentTime || 0 : undefined;
  }

  /** Where in its slide the player is. */
  now() {
    return this.partStart(this.slide, this.part) + (this.inPart() ?? 0);
  }

  /** The second of its sentence each word starts at: as heard back, else as its length suggests. */
  wordStarts(slide: number, part: number) {
    return this.clip(slide, part)?.words ?? estimatedStarts(this.data?.slides[slide]?.parts[part] ?? '', this.partSeconds(slide, part));
  }

  /** The word of the sentence being spoken, -1 before the first or while it does not play. */
  word(): number {
    const t = this.inPart();
    if (t === undefined) return -1;
    let now = -1;
    for (const [k, start] of this.wordStarts(this.slide, this.part).entries()) if (t >= start - 0.05) now = k;
    return now;
  }

  /** The item of the slide shown last by now, -1 before the first. */
  item(): number {
    const s = this.data?.slides[this.slide];
    if (!s) return -1;
    const time = this.now();
    const starts = itemStarts(
      s,
      (part, word) => this.partStart(this.slide, part) + (this.wordStarts(this.slide, part)[word] ?? 0),
      (part) => this.partStart(this.slide, part),
      this.slideSeconds(this.slide),
    );
    let shown = -1;
    for (const [k, from] of starts.entries()) if (time >= from - 0.05) shown = k;
    return shown;
  }

  play() {
    if (!this.data?.slides.length) return;
    // only one walkthrough speaks at a time
    for (const p of sessions.values()) if (p !== this && p.playing) p.pause();
    if (!this.silent && speaker !== this) {
      theVoice().pause();
      delete theVoice().dataset.key;
      speaker = this;
    }
    this.started = true;
    this.playing = true;
    this.refused = false;
    const d = this.data;
    const here = this.audio.dataset.key === `${this.slide}-${this.part}`;
    // paused at the end of a slide: on with the next, or from the start once there is none
    const over = here && this.audio.ended && this.part === d.slides[this.slide]!.parts.length - 1;
    this.writing = false;
    if (over && this.slide + 1 < d.slides.length) this.playPart(this.slide + 1, 0);
    else if (over && d.done) this.playPart(0, 0);
    else if (here && !this.audio.ended) this.start();
    else this.playPart(this.slide, this.part);
    this.changed();
    this.read();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this.next);
    this.audio.pause();
    this.changed();
  }

  toggle = () => (this.playing ? this.pause() : this.play());

  /** To slide `slide`, from its start; playing on if it played. */
  go(slide: number) {
    const d = this.data;
    if (!d?.slides.length) return;
    clearTimeout(this.next);
    this.writing = false;
    this.slide = Math.max(0, Math.min(d.slides.length - 1, slide));
    this.part = 0;
    this.audio.pause();
    delete this.audio.dataset.key;
    if (this.playing) this.playPart(this.slide, 0);
    this.changed();
  }

  /** Plays a sentence once it is voiced; until then the player waits for it. */
  private playPart(slide: number, part: number) {
    this.slide = slide;
    this.part = part;
    const c = this.clip(slide, part);
    this.waiting = !c;
    if (!c) {
      this.audio.pause();
      return this.changed();
    }
    this.audio.dataset.key = `${slide}-${part}`;
    if (this.silent) this.reader.load(c.seconds);
    else theVoice().src = this.clipUrl(this.data!.clipsDir, c.file);
    this.start();
    this.changed();
  }

  private start() {
    const key = this.audio.dataset.key;
    this.audio.play().catch((e: unknown) => {
      // a play cut short by the next sentence, or one that no longer plays: nothing was refused
      if (!this.playing || key !== this.audio.dataset.key || (e instanceof DOMException && e.name === 'AbortError')) return;
      // no click on the page yet: the owner starts it
      this.playing = false;
      this.refused = true;
      this.changed();
    });
  }

  ended() {
    const d = this.data;
    if (!d) return;
    if (this.part + 1 < d.slides[this.slide]!.parts.length) this.next = setTimeout(() => this.playPart(this.slide, this.part + 1), GAP_S * 1000);
    else if (this.slide + 1 < d.slides.length) this.next = setTimeout(() => this.go(this.slide + 1), NEXT_SLIDE_MS);
    else if (!d.done) this.writing = true;
    else this.playing = false;
    this.changed();
  }
}

/** The players of this page, by walkthrough: what one plays survives its message being drawn anew. */
const sessions = new Map<string, Playback>();

// a restart reloads the page: each player comes back where it stood
beforeReload(() => {
  const places = [...sessions].flatMap(([url, p]): [string, KeptPlace][] => {
    const at = p.place();
    return at ? [[url, at]] : [];
  });
  if (places.length) writeJson(session, KEPT_KEY, { at: Date.now(), places });
});

function usePlayback(thread: number, name: string): Playback {
  const url = walkthroughUrl(thread, name);
  let p = sessions.get(url);
  if (!p) {
    p = new Playback(url, (dir, file) => answerFile(thread, `${dir}/${file}`), askedHere.has(url));
    sessions.set(url, p);
  }
  const session = p;
  useSyncExternalStore(session.subscribe, () => session.version);
  useEffect(() => session.attach(), [session]);
  // while it plays, what lights up follows the voice
  const [, frame] = useState(0);
  useEffect(() => {
    if (!session.playing) return;
    let id = requestAnimationFrame(function tick() {
      frame((n) => n + 1);
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [session, session.playing]);
  return session;
}

/** A walkthrough an answer comes with, played under it; one the owner asked for on this page starts by itself. */
export function WalkthroughPlayer({ thread, file }: { thread: number; file: AnswerFile }) {
  const p = usePlayback(thread, file.name);
  const stage = useRef<HTMLDivElement>(null);
  useSlideScale(stage);
  // without a voice the captions are the narration: always on
  const captions = captionsOn || p.silent;
  const zoom = useZoom<HTMLElement>({ box: (w, h) => zoomedBox(SLIDE_WIDTH / SLIDE_HEIGHT, w, h, captionsOn || p.silent, WT_INSET), playing: () => p.playing });
  // the caption switched on or off while zoomed: the zoomed player grows or shrinks to stay in the window
  useEffect(() => zoom.refit(), [captions]);
  const d = p.data;
  if (!d) return <div className="wt wt-loading hint">{p.missing ? t.walkthrough.missing : t.walkthrough.loading}</div>;
  const slide = d.slides[p.slide];
  const voiced = d.clips.flat().filter(Boolean).length;
  const total = d.clips.flat().length;
  const status = d.error
    ? t.walkthrough.failed(d.error)
    : p.playing && p.writing
      ? t.walkthrough.writing
      : p.playing && p.waiting
        ? t.walkthrough.voicing(voiced, total)
        : '';
  const item = p.started ? p.item() : -1;
  const zoomLabel = zoom.box ? t.demo.unzoom : t.demo.zoom;
  return (
    <div className="wt-holder" ref={zoom.player} style={zoom.box ? { height: zoom.box.from.height } : undefined}>
    {zoom.box && <div className={zoom.box.closing ? 'demo-zoom closing' : 'demo-zoom'} ref={zoom.backdrop} title={t.demo.unzoom} onClick={zoom.toggle} />}
    <figure className={zoom.box ? 'wt zoomed' : 'wt'} ref={zoom.screen} style={zoom.box ? { left: zoom.box.to.left, top: zoom.box.to.top, width: zoom.box.to.width } : undefined}>
      <div className={p.started && !p.refused ? 'wt-stage zoomable' : 'wt-stage'} ref={stage} onClick={() => p.started && !p.refused && zoom.toggle()}>
        <div className="wt-canvas">
          {slide ? (
            <SlideView key={p.slide} p={p} title={d.title} index={p.slide} item={item} />
          ) : (
            // asked for and not begun yet: a slide taking shape, so it is plain that one is being written
            <div className="wt-slide wt-title wt-pending" aria-label={t.walkthrough.preparing}>
              <div className="wt-bar" />
              <i className="wt-ghost wide" />
              <i className="wt-ghost" />
              <p>{t.walkthrough.preparing}</p>
            </div>
          )}
        </div>
        {status && (
          <div className={`wt-status${d.error ? ' error' : ''}`} title={d.error}>
            {status}
          </div>
        )}
        {(!p.started || p.refused) && slide && (
          <button className="wt-start" onMouseDown={(e) => e.preventDefault()} onClick={(e) => (e.stopPropagation(), p.play())}>
            <span>{t.walkthrough.play}</span>
          </button>
        )}
      </div>
      {captions && p.started && slide && <Caption sentence={p.writing ? '' : (slide.parts[p.part] ?? '')} word={p.word()} pointer={!p.silent} />}
      <div className="wt-controls">
        <button className="btn small" aria-label={t.walkthrough.previous} title={t.walkthrough.previous} disabled={p.slide === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => p.go(p.slide - 1)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 5h2.4v14H6zM19 5.6v12.8a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-6.4a.8.8 0 0 1 1.2.7z" />
          </svg>
        </button>
        <button className="btn small wt-play" disabled={!slide} aria-label={p.playing ? t.walkthrough.pause : t.walkthrough.resume} title={p.playing ? t.walkthrough.pause : t.walkthrough.resume} onMouseDown={(e) => e.preventDefault()} onClick={p.toggle}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={p.playing ? 'M6.5 4.5h3.6v15H6.5zM13.9 4.5h3.6v15h-3.6z' : 'M7 4.9v14.2a.9.9 0 0 0 1.4.8l11.2-7.1a.9.9 0 0 0 0-1.6L8.4 4.1A.9.9 0 0 0 7 4.9z'} />
          </svg>
        </button>
        <button className="btn small" aria-label={t.walkthrough.next} title={t.walkthrough.next} disabled={!slide || p.slide >= d.slides.length - 1} onMouseDown={(e) => e.preventDefault()} onClick={() => p.go(p.slide + 1)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15.6 5H18v14h-2.4zM5 5.6v12.8a.8.8 0 0 0 1.2.7l8.2-6.4a.8.8 0 0 0 0-1.4L6.2 4.9A.8.8 0 0 0 5 5.6z" />
          </svg>
        </button>
        {/* a segment per slide, as long as the slide plays */}
        <div className="wt-segments">
          {d.slides.map((_, k) => (
            <button
              key={k}
              className={`wt-seg${d.silent || d.clips[k]?.[0] ? '' : ' pending'}`}
              style={{ flexGrow: Math.max(1, p.slideSeconds(k)) }}
              aria-label={t.walkthrough.slide(k + 1, d.slides.length, !d.done)}
              title={t.walkthrough.slide(k + 1, d.slides.length, !d.done)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => p.go(k)}
            >
              <span>
                <i style={{ width: k < p.slide ? '100%' : k > p.slide ? 0 : `${Math.min(100, (p.now() / Math.max(0.1, p.slideSeconds(k))) * 100)}%` }} />
              </span>
            </button>
          ))}
        </div>
        {slide && <span className="wt-count">{t.walkthrough.slide(p.slide + 1, d.slides.length, !d.done)}</span>}
        {!d.silent && (
          <button
            className={`btn small wt-key wt-cc${captions ? ' on' : ''}`}
            aria-pressed={captions}
            aria-label={t.walkthrough.captions}
            title={captionsKeyKnown ? t.walkthrough.captions : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setCaptions(!captions)}
          >
            {/* the key beside CC until the owner first switched captions with it */}
            {!captionsKeyKnown && (
              <span className="zoom-hint">
                {t.walkthrough.captionsHint} <kbd>C</kbd>
              </span>
            )}
            CC
          </button>
        )}
        <button className="btn small wt-key wt-zoom" title={zoom.keyKnown ? zoomLabel : undefined} aria-label={zoomLabel} onMouseDown={(e) => e.preventDefault()} onClick={zoom.toggle}>
          {/* the key beside the magnifier until the owner first zoomed with it */}
          {!zoom.keyKnown && (
            <span className="zoom-hint">
              {zoom.box ? t.demo.unzoomHint : t.demo.zoomHint} <kbd>Z</kbd>
            </span>
          )}
          <svg viewBox="0 0 24 24">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d={zoom.box ? 'M7.5 10.5h6M15.5 15.5L21 21' : 'M7.5 10.5h6M10.5 7.5v6M15.5 15.5L21 21'} />
          </svg>
        </button>
      </div>
    </figure>
    </div>
  );
}

/**
 * The sentence being spoken, the word being spoken marked, the words said before it apart from those
 * still to come. A sentence read (`pointer` off) marks no word, and turns its pages as reading it goes.
 */
function Caption({ sentence, word, pointer }: { sentence: string; word: number; pointer: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // a page of two lines at a time: the words measured in the caption's font, against its width
  const [measure, setMeasure] = useState<{ widthOf: (text: string) => number; line: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ctx = document.createElement('canvas').getContext('2d');
    const fit = () => {
      const css = getComputedStyle(el);
      if (!ctx) return;
      ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      // a little room kept: the browser's line breaks and the canvas's widths differ by a pixel here and there
      setMeasure({ widthOf: (text) => ctx.measureText(text).width, line: (el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)) * 0.97 });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    // the caption's font may come after the first measure
    void document.fonts.ready.then(fit);
    return () => ro.disconnect();
  }, []);
  const words = wordsOf(sentence);
  const starts = useMemo(() => (measure ? captionPages(words, measure.widthOf, measure.line) : [0]), [sentence, measure]);
  const page = pageOf(starts, word);
  const from = starts[page]!;
  const to = starts[page + 1] ?? words.length;
  return (
    <div ref={box} className={`wt-caption${pointer && word >= 0 ? ' pointing' : ''}`}>
      <div>
        {words.slice(from, to).map((w, i) => {
          const k = from + i;
          return (
            <span key={k}>
              {i > 0 && ' '}
              <span className={!pointer ? undefined : k < word ? 'said' : k === word ? 'now' : undefined}>{w}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** A number for `text`, the same every time: where the title slide's rings and dots stand. */
function hashOf(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  return h >>> 0;
}

/** The inks a title slide's motif takes its colours from, in turn. */
const MOTIF_INKS = ['--working', '--inPr', '--idea', '--proposal', '--approved', '--waiting'];

/** Rings, an arc and a field of dots on the right of a title slide, placed and coloured by its title, as showntell's title slides have. */
function Motif({ title }: { title: string }) {
  const h = hashOf(title);
  const pick = (n: number, shift: number) => (h >>> shift) % n;
  const ink = (k: number) => `var(${MOTIF_INKS[(pick(MOTIF_INKS.length, 0) + k) % MOTIF_INKS.length]})`;
  const cx = 640 + pick(6, 3) * 14;
  const cy = 170 + pick(7, 6) * 26;
  const r = 104 + pick(4, 9) * 10;
  const from = pick(8, 12) * 45;
  const arc = (deg: number, radius: number) => `${cx + radius * Math.cos((deg * Math.PI) / 180)} ${cy + radius * Math.sin((deg * Math.PI) / 180)}`;
  const dx = cx - 150 + pick(3, 15) * 20;
  const dy = cy + r - 20 - pick(3, 17) * 18;
  return (
    <svg className="wt-motif" viewBox={`0 0 ${SLIDE_WIDTH} ${SLIDE_HEIGHT}`} aria-hidden="true">
      <circle className="disc" cx={cx} cy={cy} r={r * 0.62} fill={ink(1)} />
      {[1, 1.38, 1.8, 2.3].map((f, k) => (
        <circle key={k} className="ring" cx={cx} cy={cy} r={r * f} stroke={ink(k % 2 ? 1 : 0)} opacity={0.5 - k * 0.1} />
      ))}
      <path className="arc" d={`M ${arc(from, r * 0.86)} A ${r * 0.86} ${r * 0.86} 0 0 1 ${arc(from + 110, r * 0.86)}`} stroke={ink(0)} />
      <g className="dots" fill={ink(2)}>
        {Array.from({ length: 20 }, (_, k) => (
          <circle key={k} cx={dx + (k % 5) * 13} cy={dy + Math.floor(k / 5) * 13} r={2.2} />
        ))}
      </g>
    </svg>
  );
}

/** One slide; before the walkthrough first plays, with all its items. */
function SlideView({ p, title, index, item }: { p: Playback; title: string; index: number; item: number }) {
  const s = p.data!.slides[index]!;
  const shown = (k: number) => !p.started || k <= item;
  const state = (k: number) => [shown(k) && 'shown', p.started && k === item && 'now'].filter(Boolean).join(' ');
  const kicker = (
    <div className="wt-kicker">
      <span className="n">{String(index + 1).padStart(2, '0')}</span>
      <span className="t">{title}</span>
    </div>
  );
  if (s.type === 'title')
    return (
      <div className="wt-slide wt-title">
        <Motif title={s.title} />
        <div className="wt-bar" />
        <h1>{s.title}</h1>
        {s.subtitle && <p>{s.subtitle}</p>}
      </div>
    );
  if (s.type === 'points')
    return (
      <div className="wt-slide">
        {kicker}
        <h2>{s.title}</h2>
        <ul className={`wt-points${p.started && item >= 0 ? ' telling' : ''}`}>
          {s.points.map((x, k) => (
            <li key={k} className={state(k)}>
              {x}
            </li>
          ))}
        </ul>
      </div>
    );
  if (s.type === 'flow')
    return (
      <div className="wt-slide">
        {kicker}
        <h2>{s.title}</h2>
        <div className="wt-flow">
          <div className="wt-flow-row">
            {s.steps.map((x, k) => (
              <div key={k} className="wt-step-wrap">
                {k > 0 && (
                  // the arrow into the box being told is drawn in the accent
                  <svg className={`wt-arrow${shown(k) ? ' shown' : ''}${p.started && k === item ? ' lit' : ''}`} viewBox="0 0 32 16" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                    <path d="M5 8h21M20 3l6 5-6 5" />
                  </svg>
                )}
                <div className={`wt-step ${state(k)}`}>
                  <b>{x.label}</b>
                  {x.note && <span>{x.note}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  return <CodeSlide p={p} kicker={kicker} index={index} item={item} />;
}

/** Real lines of the repository, the range the narration is at highlighted and scrolled into view. */
function CodeSlide({ p, kicker, index, item }: { p: Playback; kicker: React.ReactNode; index: number; item: number }) {
  const s = p.data!.slides[index]!;
  const box = useRef<HTMLDivElement>(null);
  const focus = s.type === 'code' && p.started && item >= 0 ? s.focus[item] : undefined;
  useEffect(() => {
    const el = box.current;
    const first = el?.querySelector<HTMLElement>('.focus');
    el?.scrollTo({ top: first ? Math.max(0, first.offsetTop - el.clientHeight * 0.3) : 0, behavior: 'smooth' });
  }, [focus?.[0]]);
  if (s.type !== 'code') return null;
  const [from] = s.lines;
  return (
    <div className="wt-slide wt-code-slide">
      {kicker}
      <h2>{s.title}</h2>
      <div className="wt-codebox">
        <div className="wt-file">
          {s.file}:{s.lines[0]}–{s.lines[1]}
        </div>
        <div ref={box} className={`wt-code${focus ? ' focusing' : ''}`}>
          {s.code.map((line, k) => {
            const n = from + k;
            return (
              <div key={k} className={focus && n >= focus[0] && n <= focus[1] ? 'focus' : undefined}>
                <i>{n}</i>
                <code>{line}</code>
              </div>
            );
          })}
        </div>
      </div>
      {s.note && <div className="wt-note">{s.note}</div>}
    </div>
  );
}

/** What "Show as walkthrough" tells: an answer of the sheet (its exchange), or a message of a card's conversation. */
export type Tellable = { talk: number } | { card: string; ev: number };

/**
 * "Show as walkthrough" in the head of a text answer, shown on hover as the head's other actions
 * are (`hint`: the newest answer's stays in view until the owner has used it once): the answer is
 * told again as a walkthrough, the next answer, which starts by itself once its first sentence is
 * voiced.
 */
export function WalkthroughButton({ of, hint }: { of: Tellable; hint?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [used, knowUsed] = useKnown(WALKTHROUGH_KNOWN);
  return (
    <button
      className={`msg-act msg-walk${hint && !used ? ' shown' : ''}`}
      title={t.answer.walkthroughHint}
      disabled={busy}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setBusy(true);
        knowUsed();
        // asked once: the walkthrough comes as the next answer
        ('talk' in of ? api.walkthrough(of.talk) : api.cardWalkthrough(of.card, of.ev))
          .then(({ thread, file }) => {
            const url = walkthroughUrl(thread, file);
            askedHere.add(url);
            // its player may show already, before the click's reply
            const p = sessions.get(url);
            if (p) p.autoplay = true;
          })
          .catch(() => setBusy(false));
      }}
    >
      ▶ {t.answer.walkthrough}
    </button>
  );
}
