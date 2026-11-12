// A card's demo: the narrated video with its chapters, or the HTML artifact, and its earlier versions.

import { type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Demo, EarlierDemo, Item } from '../core/types';
import { chapterAt } from '../core/card';
import { mmss } from '../../plugin/skills/demo/lib/timeline.ts';
import { languageName, preferredTrack } from '../core/locale';
import { api, cardAt, holdRestart } from './api';
import { demoMark, markSeen, sameDemo, unseen } from './demoSeen';
import { know } from './stored';
import { Body } from './markdown';
import { useReportedHeight } from './frame';
import { useFullscreen } from './fullscreen';
import { captionPages, cueWords, pageOf, spokenWord } from '../core/caption-pages';
import { CAPTIONS_CHANGED, type PlayerWords, SEEK_KEYS_KNOWN, videoPlayer } from '../core/video-player';
import { zoomedBox } from './walkthrough';
import { plainKey, useZoom } from './zoom';
import { showsVersions, watch } from './spot';
import { clock as time, shortDay, t, uiLanguage } from './strings';
import { TalkElsewhere } from './conversation';
import { ShareIcon } from './share';

/** The highest an HTML demo's frame grows; a page higher still scrolls inside it. */
const ARTIFACT_CAP = 30000;

/**
 * The narrated demo with its chapters and the report beside it, or the HTML artifact. `comments`: the
 * card's agent hears the owner, whose words may be about a place in the video. Once a later handover
 * replaced a demo, the owner may step back to it and forth again; a comment on a place in it takes
 * them there too.
 */
export function DemoView({
  item,
  summary = '',
  demo: latest,
  children,
  top,
  autoplay = true,
  comments = false,
}: {
  item: Item;
  summary?: string;
  demo: Demo;
  children?: ReactNode;
  /** above the video or artifact, where it is seen on opening however long the chapters or the artifact: sharing, about the demo shown */
  top?: false | ((shown: Demo, latest: boolean) => ReactNode);
  /** starts by itself when this browser has not played it yet */
  autoplay?: boolean;
  comments?: boolean;
}) {
  const cardId = item.id;
  const shown = useShownDemo(item, latest);
  const { demo } = shown;
  // start once the card has unfolded, like the mock, until it has played once; a demo kept on a finished card waits to be played.
  // A page out of sight (a tab in the background, an agent's browser) does not start it: nobody would see it, only hear it
  // the demo the card opened to: a later handover on the open card never starts by itself
  const [opened] = useState(latest);
  const [autostart] = useState(() => autoplay && latest.kind !== 'html' && !document.hidden && unseen(localStorage, cardId, latest));
  // a new handover often renders into the same directory: its handover in the address makes a card left open load it afresh
  const src = (f: string) => cardAt(cardId, `${shown.latest ? `/demo/${f}` : `/demos/${(demo as EarlierDemo).n}/${f}`}${demo.handover === undefined ? '' : `?v=${demo.handover}`}`);
  return (
    <>
      <div className="demo-view">
        {/* which of the card's demos is shown, in the line with sharing */}
        {(shown.all.length > 1 || top) && (
          <div className="demo-top">
            {shown.all.length > 1 && <DemoVersions item={item} shown={shown} />}
            {top && top(demo, shown.latest)}
          </div>
        )}
        {demo.kind === 'html' ? (
          <Artifact src={src('index.html')} />
        ) : (
          <DemoPlayer cardId={cardId} demo={demo} src={src} latest={shown.latest} autoplay={autostart && !shown.moved && sameDemo(opened, latest)} comments={comments} playFrom={shown.playFrom} />
        )}
        {/* its report's question stands in the conversation, where it is answered */}
        {children}
      </div>
      <Body md={summary} />
    </>
  );
}

/**
 * Which of the card's demos shows: the latest, or an earlier one the owner stepped back to (a new
 * handover leaves them where they are), or the one a comment on a place in it took them to, which
 * then plays from that place (`playFrom`, which the player takes once). `moved`: the owner went to
 * another of the card's demos since it opened.
 */
function useShownDemo(item: Item, latest: Demo) {
  // the earlier demo shown (its `n`), or the latest
  const [shownN, setShownN] = useState<number | null>(null);
  const [moved, setMoved] = useState(false);
  const playFrom = useRef<number | null>(null);
  const earlier = item.demos ?? [];
  const demo = earlier.find((d) => d.n === shownN) ?? latest;
  const all = [...earlier, latest];
  const show = (d: Demo) => {
    setMoved(true);
    setShownN(d === latest ? null : (d as EarlierDemo).n);
  };
  useEffect(() => {
    if (!earlier.length) return;
    return showsVersions({
      cardId: item.id,
      shown: demo.handover,
      show: (handover, from) => {
        const d = all.find((d) => d.handover === handover);
        if (!d) return false;
        playFrom.current = from;
        show(d);
        return true;
      },
    });
  }, [demo, latest, item.demos]);
  return { demo, all, at: all.indexOf(demo), latest: demo === latest, show, playFrom, moved };
}

/** The line above a demo that a later handover replaced: which of the card's demos shows, with steps back and forth. */
function DemoVersions({ item, shown }: { item: Item; shown: ReturnType<typeof useShownDemo> }) {
  const { demo, all, at, latest, show } = shown;
  return (
    <div className={latest ? 'demo-versions' : 'demo-versions earlier'} title={latest ? undefined : t.demo.earlierHint}>
      <button className="step" disabled={at === 0} title={t.demo.older} aria-label={t.demo.older} onClick={() => show(all[at - 1]!)}>
        ‹
      </button>
      <span>
        {t.demo.version(at + 1, all.length, latest)}
        {demo.at && ` · ${handedAt(demo.at)}`}
        {demo.handover !== undefined && item.share?.on?.includes(demo.handover) && (
          <span className="on-page" title={t.share.onPageMark} aria-label={t.share.onPageMark}>
            <ShareIcon />
          </span>
        )}
      </span>
      <button className="step" disabled={latest} title={t.demo.newer} aria-label={t.demo.newer} onClick={() => show(all[at + 1]!)}>
        ›
      </button>
      {at < all.length - 2 && (
        <button className="link" onClick={() => show(all.at(-1)!)}>
          {t.demo.toLatest}
        </button>
      )}
    </div>
  );
}

/**
 * The worker's HTML artifact: scripts run, but in an origin of its own, away from Obeya's API. Once
 * the frame has the page's height, the page stops scrolling up and down by itself
 * (`withHeightReport`); sideways it still scrolls, where it is wider than the frame.
 */
function Artifact({ src }: { src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const height = useReportedHeight(frame, ARTIFACT_CAP);
  return <iframe ref={frame} className="artifact" sandbox="allow-scripts" src={src} title={t.demo.artifact} style={{ height }} />;
}

/**
 * The demo video in the player (src/core/video-player.ts) with its chapters under it, zoom and full
 * screen; `latest`: the card's latest demo, which counts as played once it runs. Another demo of the
 * card shown in it waits behind the play button, or plays from the place a comment took the owner
 * to (`playFrom`).
 */
function DemoPlayer({
  cardId,
  demo,
  src,
  latest,
  autoplay,
  comments,
  playFrom,
}: {
  cardId: string;
  demo: Demo;
  src: (file: string) => string;
  latest: boolean;
  autoplay: boolean;
  comments: boolean;
  playFrom: RefObject<number | null>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  // on the phone the field is in a panel of its own, which a comment brings up
  const elsewhere = useContext(TalkElsewhere);
  const [now, setNow] = useState(0);
  // the video's shape once its metadata is in, where the handover did not read it: until it first plays, Chrome sizes the
  // element by its poster, and by its default 300 × 150 when the poster does not load, a flat strip at full width
  const [shape, setShape] = useState<string>();
  // a video that does not start on its own shows a big play button over it until it first plays
  const [started, setStarted] = useState(autoplay);
  useEffect(() => {
    if (!autoplay) return;
    const h = setTimeout(() => (document.hidden ? setStarted(false) : video.current?.play().catch(() => setStarted(false))), 300);
    return () => clearTimeout(h);
  }, []);
  useEffect(() => () => holdRestart('video', null), []);
  // which demo it is: an earlier one by its place, the latest by its handover and render
  const mark = latest ? demoMark(demo) : `n${(demo as EarlierDemo).n}`;
  // another demo shown, or a later handover of the latest: it starts from the beginning behind the
  // play button, or from the place a comment took the owner to (also where that put the player in
  // place of an HTML artifact)
  const shownMark = useRef<string | null>(null);
  useEffect(() => {
    const first = shownMark.current === null;
    if (shownMark.current === mark) return;
    shownMark.current = mark;
    const from = playFrom.current;
    playFrom.current = null;
    if (first && from === null) return;
    setNow(0);
    const v = video.current;
    if (!v) return;
    if (from === null) return setStarted(false);
    const go = () => {
      v.currentTime = from;
      v.play().catch(() => setStarted(false));
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
    // into view with the line above it, unless its top is in view already
    const column = v.closest('.split-main')?.getBoundingClientRect();
    const top = v.getBoundingClientRect().top;
    if (column && (top < column.top || top > column.bottom - 80)) v.closest('.demo-view')?.querySelector('.demo-versions')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return () => v.removeEventListener('loadedmetadata', go);
  }, [mark]);
  const zoom = useZoom<HTMLElement>({
    // the picture as large as fits with the caption, while it shows, and the controls under it
    box: (w, h) => {
      const v = video.current;
      const r = v?.getBoundingClientRect();
      return zoomedBox(v?.videoWidth ? v.videoWidth / v.videoHeight : r?.height ? r.width / r.height : 16 / 9, w, h, !!v?.closest('.dp')?.hasAttribute('data-captions'));
    },
    playing: () => !!video.current && !video.current.paused,
  });
  // the phone view, which puts the conversation elsewhere, puts the video into full screen itself (fullscreen.ts)
  const fullscreen = useFullscreen(zoom.screen, video, !!elsewhere);
  useSeekKeys(video);
  // the player's caption and controls (src/core/video-player.ts), and the end of their row for the zoom and the full screen
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const root = zoom.screen.current;
    const v = video.current;
    if (!root || !v) return;
    const player = videoPlayer(root, v, { chapters: demo.chapters, words: playerWords(), silent: !!demo.silent, prefer: [uiLanguage()] }, { captionPages, pageOf, cueWords, spokenWord, preferredTrack });
    setSlot(player.slot);
    // captions switched while zoomed: the zoomed player grows or shrinks to stay in the window, once the caption has
    const refit = () => requestAnimationFrame(() => zoom.refit());
    addEventListener(CAPTIONS_CHANGED, refit);
    return () => {
      removeEventListener(CAPTIONS_CHANGED, refit);
      player.destroy();
      setSlot(null);
    };
  }, [mark, JSON.stringify(demo.chapters), demo.tracks?.join(), demo.silent]);
  const watching = useWatching(cardId, video, comments ? demo.chapters : null, demo.handover);
  const current = chapterAt(demo.chapters, now);
  return (
    <>
      <div className="player" ref={zoom.player} style={zoom.box ? { height: zoom.box.from.height } : undefined}>
        {zoom.box && <div className={zoom.box.closing ? 'demo-zoom closing' : 'demo-zoom'} ref={zoom.backdrop} title={t.demo.unzoom} onClick={zoom.toggle} />}
        <figure
          className={zoom.box ? 'dp zoomed' : fullscreen.full ? 'dp full' : 'dp'}
          ref={zoom.screen}
          style={zoom.box ? { left: zoom.box.to.left, top: zoom.box.to.top, width: zoom.box.to.width } : undefined}
        >
          <div className="dp-screen">
            <video
              ref={video}
              preload="metadata"
              poster={demo.noPoster ? undefined : src('poster.jpg')}
              src={src('demo.mp4')}
              style={demo.size || shape ? { aspectRatio: demo.size ? `${demo.size[0]} / ${demo.size[1]}` : shape } : undefined}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setShape(`${v.videoWidth} / ${v.videoHeight}`);
              }}
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              // a restart waits while the owner watches
              onPlay={() => {
                setStarted(true);
                holdRestart('video', 'video');
              }}
              // played once it runs, not while it still loads after the click: closed before that, it starts at the next opening
              onPlaying={() => latest && markSeen(localStorage, cardId, demo)}
              onPause={() => holdRestart('video', null)}
              onEnded={() => {
                holdRestart('video', null);
                watching.ended();
              }}
            >
              {demo.tracks ? (
                // a track per language, named in the interface's (none: no subtitles); the player picks the one it shows
                demo.tracks.map((l) => <track key={src(`captions.${l}.vtt`)} kind="captions" src={src(`captions.${l}.vtt`)} srcLang={l} label={languageName(l, uiLanguage())} />)
              ) : (
                <track key={src('captions.vtt')} kind="captions" src={src('captions.vtt')} label={t.demo.captions} />
              )}
            </video>
            {!started && (
              // a click anywhere on the video starts it, like on a shared page
              <button className="start" aria-label={t.demo.play} onClick={() => video.current?.play().catch(() => {})}>
                <span>
                  <svg viewBox="0 0 24 24">
                    <path d="M6 4l15 8-15 8z" />
                  </svg>
                </span>
              </button>
            )}
            {comments && started && (
              <button
                className="comment-here"
                title={t.demo.commentHint}
                onClick={() => {
                  video.current?.pause();
                  if (zoom.box) zoom.toggle();
                  fullscreen.leave();
                  if (elsewhere) elsewhere.open(true);
                  else document.querySelector<HTMLTextAreaElement>('.card-sheet .split-talk .composer textarea')?.focus();
                }}
              >
                <svg viewBox="0 0 24 24">
                  <path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" />
                </svg>
                {t.demo.comment}
              </button>
            )}
          </div>
        </figure>
        {slot &&
          createPortal(
            <>
              {fullscreen.can && (
                <button
                  className="btn small wt-full"
                  title={fullscreen.full ? t.demo.fullscreenOff : t.demo.fullscreen}
                  aria-label={fullscreen.full ? t.demo.fullscreenOff : t.demo.fullscreen}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={fullscreen.toggle}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path className="s" d={fullscreen.full ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
                  </svg>
                </button>
              )}
              <button
                className="btn small wt-key wt-zoom"
                title={zoom.keyKnown ? (zoom.box ? t.demo.unzoom : t.demo.zoom) : undefined}
                aria-label={zoom.box ? t.demo.unzoom : t.demo.zoom}
                onMouseDown={(e) => e.preventDefault()}
                onClick={zoom.toggle}
              >
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
            </>,
            slot,
          )}
      </div>
      {demo.chapters.length > 0 && (
        <ol className="chapters">
          {demo.chapters.map(([at, title], i) => (
            <li key={i}>
              <button
                className={i === current ? 'on' : ''}
                onClick={() => {
                  const v = video.current;
                  if (!v) return;
                  v.currentTime = at;
                  v.play().catch(() => {});
                }}
              >
                <span className="t">{mmss(at)}</span>
                {title}
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** The demo player's words, in the interface's language. */
const playerWords = (): PlayerWords => ({
  play: t.demo.play,
  pause: t.demo.pause,
  previous: t.demo.previous,
  next: t.demo.next,
  captions: t.walkthrough.captions,
  captionsHint: t.walkthrough.captionsHint,
  seekHint: t.demo.seekHint,
  language: t.demo.language,
  mute: t.demo.mute,
  unmute: t.demo.unmute,
  fullscreen: t.demo.fullscreen,
  fullscreenOff: t.demo.fullscreenOff,
});

/** When a demo was handed over: the time of day, with the day when it was not today. */
const handedAt = (at: string) => (new Date(at).toDateString() === new Date().toDateString() ? time(at) : `${shortDay(at)}, ${time(at)}`);

/** A video standing this long has been watched to its end, as far as the comments on it are concerned. */
const STOOD_MS = 3 * 60_000;

/**
 * The card's demo video as the one its words may be about (`chapters` null: they are not): typing in
 * the card's field pauses it, and the owner's comments on places in it, which Obeya holds back while
 * they watch, go to the agent once they have finished: the video ended, stood for a few minutes, or
 * the card closed. Words without a place, and an approval, take them too (on the server).
 */
function useWatching(cardId: string, video: RefObject<HTMLVideoElement | null>, chapters: [number, string][] | null, demo?: number) {
  const on = !!chapters;
  const release = () => void api.act(cardId, { action: 'release' }).catch(() => {});
  // going to another of the card's demos is no sign the owner has finished watching
  useEffect(() => {
    const v = video.current;
    if (!on || !v) return;
    return watch(cardId, v, chapters, demo);
  }, [on, demo]);
  useEffect(() => {
    const v = video.current;
    if (!on || !v) return;
    const typed = (e: Event) => {
      if (!v.paused && e.target instanceof HTMLTextAreaElement && e.target.closest('.card-sheet .split-talk .composer, #ph-card-talk .composer')) v.pause();
    };
    let stood: ReturnType<typeof setTimeout> | undefined;
    const paused = () => {
      clearTimeout(stood);
      stood = setTimeout(release, STOOD_MS);
    };
    const played = () => clearTimeout(stood);
    v.addEventListener('pause', paused);
    v.addEventListener('play', played);
    addEventListener('input', typed, true);
    return () => {
      clearTimeout(stood);
      v.removeEventListener('pause', paused);
      v.removeEventListener('play', played);
      removeEventListener('input', typed, true);
      release();
    };
  }, [on]);
  return { ended: () => on && release() };
}

/** The demo video the keys are for, with several on a card: the zoomed one, else the one playing, else the first. */
function keyedVideo() {
  const videos = [...document.querySelectorAll<HTMLVideoElement>('.card-sheet .demo-view video')];
  return document.querySelector<HTMLVideoElement>('.dp.zoomed video') ?? videos.find((v) => !v.paused) ?? videos[0];
}

/** How far ← and → jump in the demo video, in seconds. */
const SEEK_S = 5;

/** ← and → jump back and forward in the demo video; its progress bar shows the keys on hover until the owner first jumped with them. */
function useSeekKeys(video: RefObject<HTMLVideoElement | null>) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const v = video.current;
      // a key with no modifier, pressed outside a text field and with nothing over the card
      if (!v || !plainKey(e) || keyedVideo() !== v) return;
      e.preventDefault();
      const to = v.currentTime + (e.key === 'ArrowLeft' ? -SEEK_S : SEEK_S);
      v.currentTime = Math.max(0, Number.isFinite(v.duration) ? Math.min(v.duration, to) : to);
      know(SEEK_KEYS_KNOWN);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
}
