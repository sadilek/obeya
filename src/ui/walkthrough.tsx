// The player of a looked-up answer told as a walkthrough, under the question from its first slide on
// while the agent still tells it: it reads the walkthrough as it grows and plays slides and voice in
// step, items lighting up as the narration reaches them, the spoken sentence as a caption. What it
// plays lives outside React, by walkthrough, so the player goes on unbroken when its message is
// drawn anew (the answer's words arriving above it) and pauses only once no message shows it.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AnswerFile } from '../core/types';
import { INTERRUPTED, itemsOf, type Walkthrough } from '../core/walkthrough';
import { answerFile, api, at } from './api';
import { known, know } from './known';
import { t } from './strings';

/** How often the player reads the walkthrough while it grows or is voiced. */
const POLL_MS = 400;
/** The pause between two sentences of a slide, and between two slides. */
const GAP_S = 0.15;
const NEXT_SLIDE_MS = 600;
/** Seconds a sentence not voiced yet is taken to last, per character, to lay out its slide. */
const SECONDS_PER_CHAR = 0.075;

/** The walkthroughs this page asked for with "Show as walkthrough", by address: they start by themselves, the click allowed the sound. */
const askedHere = new Set<string>();

const walkthroughUrl = (thread: number, name: string) => at(`/threads/${thread}/walkthroughs/${encodeURIComponent(name)}`);

/** That the owner has used "Show as walkthrough": the newest answer's button no longer stays in view. */
const WALKTHROUGH_KNOWN = 'obeya.walkthroughKnown';

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
  captions = true;
  /** It started by itself once: it does not again. */
  autoplayed = false;
  /** The browser refused to play without a click (no click on the page yet). */
  refused = false;
  readonly audio = new Audio();
  private next?: ReturnType<typeof setTimeout>;
  /** A read is running or due: one at a time. */
  private reading = false;
  private shown = 0;
  private hide?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(
    private url: string,
    private clipUrl: (dir: string, file: string) => string,
    /** To start by itself once it can; the page may learn it only after the player showed (the click's reply comes after the walkthrough). */
    public autoplay: boolean,
  ) {
    this.audio.preload = 'auto';
    this.audio.onended = () => this.ended();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
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
    // with its voice failed, it still gets the slides the agent writes
    return !!d && d.done && (!!d.error || d.clips.every((c) => c.every(Boolean)));
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

  clip(slide: number, part: number) {
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

  /** Where in its slide the player is. */
  now() {
    const playingThis = this.audio.dataset.key === `${this.slide}-${this.part}`;
    return this.partStart(this.slide, this.part) + (playingThis ? this.audio.currentTime || 0 : 0);
  }

  /** The item of the slide shown last by now, -1 before the first. */
  item(): number {
    const s = this.data?.slides[this.slide];
    if (!s) return -1;
    const n = itemsOf(s);
    const time = this.now();
    let shown = -1;
    for (let k = 0; k < n; k++) {
      const from = s.items ? this.partStart(this.slide, Math.max(0, s.items.indexOf(k))) : (k / n) * this.slideSeconds(this.slide) * 0.9;
      if (time >= from - 0.05) shown = k;
    }
    return shown;
  }

  play() {
    if (!this.data?.slides.length) return;
    // only one walkthrough speaks at a time
    for (const p of sessions.values()) if (p !== this && p.playing) p.pause();
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

  toggleCaptions = () => {
    this.captions = !this.captions;
    this.changed();
  };

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
    this.audio.src = this.clipUrl(this.data!.clipsDir, c.file);
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

  private ended() {
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
  const d = p.data;
  if (!d) return <div className="wt wt-loading hint">{p.missing ? t.walkthrough.missing : t.walkthrough.loading}</div>;
  const slide = d.slides[p.slide];
  const voiced = d.clips.flat().filter(Boolean).length;
  const total = d.clips.flat().length;
  const status = d.error
    ? d.error === INTERRUPTED
      ? t.walkthrough.interrupted
      : t.walkthrough.failed(d.error)
    : p.playing && p.writing
      ? t.walkthrough.writing
      : p.playing && p.waiting
        ? t.walkthrough.voicing(voiced, total)
        : '';
  const item = p.started ? p.item() : -1;
  return (
    <figure className="wt">
      <div className="wt-stage">
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
        {status && (
          <div className={`wt-status${d.error ? ' error' : ''}`} title={d.error && d.error !== INTERRUPTED ? d.error : undefined}>
            {status}
          </div>
        )}
        {(!p.started || p.refused) && slide && (
          <button className="wt-start" onMouseDown={(e) => e.preventDefault()} onClick={() => p.play()}>
            <span>{t.walkthrough.play}</span>
          </button>
        )}
      </div>
      {p.captions && p.started && slide && <div className="wt-caption">{p.writing ? '' : slide.parts[p.part]}</div>}
      <div className="wt-controls">
        <button className="btn small" aria-label={t.walkthrough.previous} title={t.walkthrough.previous} disabled={p.slide === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => p.go(p.slide - 1)}>
          ◀
        </button>
        <button className="btn small wt-play" disabled={!slide} aria-label={p.playing ? t.walkthrough.pause : t.walkthrough.resume} title={p.playing ? t.walkthrough.pause : t.walkthrough.resume} onMouseDown={(e) => e.preventDefault()} onClick={p.toggle}>
          {p.playing ? '❚❚' : '▶'}
        </button>
        <button className="btn small" aria-label={t.walkthrough.next} title={t.walkthrough.next} disabled={!slide || p.slide >= d.slides.length - 1} onMouseDown={(e) => e.preventDefault()} onClick={() => p.go(p.slide + 1)}>
          ▶▶
        </button>
        <div className="wt-segments">
          {d.slides.map((_, k) => (
            <button key={k} className={`wt-seg${d.clips[k]?.[0] ? ' voiced' : ''}`} aria-label={t.walkthrough.slide(k + 1, d.slides.length, !d.done)} onMouseDown={(e) => e.preventDefault()} onClick={() => p.go(k)}>
              <i style={{ width: k < p.slide ? '100%' : k > p.slide ? 0 : `${Math.min(100, (p.now() / Math.max(0.1, p.slideSeconds(k))) * 100)}%` }} />
            </button>
          ))}
        </div>
        {slide && <span className="wt-count">{t.walkthrough.slide(p.slide + 1, d.slides.length, !d.done)}</span>}
        <button className={`btn small${p.captions ? ' on' : ''}`} aria-pressed={p.captions} title={t.walkthrough.captions} onMouseDown={(e) => e.preventDefault()} onClick={p.toggleCaptions}>
          CC
        </button>
      </div>
    </figure>
  );
}

/** One slide; before the walkthrough first plays, with all its items. */
function SlideView({ p, title, index, item }: { p: Playback; title: string; index: number; item: number }) {
  const s = p.data!.slides[index]!;
  const shown = (k: number) => !p.started || k <= item;
  const state = (k: number) => [shown(k) && 'shown', p.started && k === item && 'now'].filter(Boolean).join(' ');
  const kicker = (
    <div className="wt-kicker">
      {title} · {index + 1}
    </div>
  );
  if (s.type === 'title')
    return (
      <div className="wt-slide wt-title">
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
        <ul className="wt-points">
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
          {s.steps.map((x, k) => (
            <div key={k} className="wt-step-wrap">
              {k > 0 && <span className={`wt-arrow${shown(k) ? ' shown' : ''}`}>→</span>}
              <div className={`wt-step ${state(k)}`}>
                <b>{x.label}</b>
                {x.note && <span>{x.note}</span>}
              </div>
            </div>
          ))}
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
  const [used, setUsed] = useState(() => known(WALKTHROUGH_KNOWN));
  return (
    <button
      className={`msg-act msg-walk${hint && !used ? ' shown' : ''}`}
      title={t.answer.walkthroughHint}
      disabled={busy}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setBusy(true);
        know(WALKTHROUGH_KNOWN);
        setUsed(true);
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
