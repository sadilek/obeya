// Push-to-talk: hold Space or the microphone, speak, let go. With the cursor in a text field the
// words are written into it, for the owner to add to and send. Otherwise the recording goes to
// Obeya with what stands in the field of the card or sidebar in view (its words first, its
// screenshots, the message it quotes): with an agent on the open card straight to that agent, else
// to the Coordinator, which answers with a confirmation to show. Where no field is in view,
// screenshots picked or pasted beside the microphone, and the paths of other files dropped on it,
// go with the next recording. The microphone is
// free again at once: each spoken command has its own line above it while it is read, which becomes
// its confirmation; a typed one gets its line with the confirmation.

import { createContext, useEffect, useRef, useState } from 'react';
import type { Place } from '../core/layout';
import { ApiError, api, confirmShownMs, type Heard, holdRestart, undoShownMs, type Where, failText } from './api';
import { beginDictation, dictate, draftOf, focusedDraft, insertFiles, insertPasted, MIC_DRAFT, moveFiles, moveImages, pastedIn, sendsWithEnter, takesImages, toObeya, updateDraft, useDraft, useFieldOn, uploaded, useFocusedDraft, withoutPasted, withoutWords, wordsOf } from './draft';
import { Aside } from './aside';
import { type Recording, record } from './recorder';
import { AttachButton, ShotStrip, useShotInput } from './shots';
import { replyOn, setReply, useReply } from './reply';
import { sent, take, type Taken } from './spot';
import { pasteKeys, t } from './strings';
import { usePasteTextHint } from './pasteHint';

/** Starts a recording, for a text field's microphone and Space held in it; null where nobody listens. */
export const HoldToTalk = createContext<(() => void) | null>(null);

type Phase = 'idle' | 'listening';

/** Space let go sooner is a tap, which plays or pauses the demo video: push-to-talk takes no shorter recording. */
export const TAP_MS = 350;

/** Below this peak a working microphone delivers nothing, not even room noise (the sidecar's threshold too). */
const QUIET_DBFS = -60;
/** How long the level may stay flat at the start of a recording before the owner is told. */
const FLAT_MS = 1500;

/**
 * How long Space is held before the microphone shows it listens: a tap on Space plays or pauses the
 * demo video, and the microphone lit up for that tap flickered. The recording runs from the press.
 */
export const SPACE_SHOWS_MS = 200;

/** How long a note under a field about its dictation stays. */
const NOTE_MS = 6000;

/**
 * Whether Obeya has the recording the page sent as `sent`, for a command whose answer the broken
 * connection lost: asked until Obeya answers, for as long as the page lives. A page going away
 * (another canvas, a reload) never hears, and gives nothing back.
 */
async function arrived(sent: string): Promise<boolean> {
  for (let wait = 500; ; wait = Math.min(wait * 2, 8000)) {
    try {
      return await api.voiceArrived(sent);
    } catch {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

interface Mic {
  stream: MediaStream;
  ctx: AudioContext;
  analyser: AnalyserNode;
}

function openMic(): Promise<Mic> {
  return navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    return { stream, ctx, analyser };
  });
}

/**
 * Whether a microphone opened earlier still delivers. The phone takes it from a page that was away
 * (another app used the microphone, the phone slept): its track has ended or stays muted, and a
 * recording from it failed or stayed silent until the page was loaded again.
 */
export const stillOpen = (m: { stream: MediaStream; ctx: { state: string } }) =>
  m.ctx.state !== 'closed' && m.stream.getAudioTracks().some((tr) => tr.readyState === 'live' && !tr.muted);

function closeMic(m: Mic) {
  m.stream.getTracks().forEach((tr) => tr.stop());
  void m.ctx.close().catch(() => {});
}

/** How long the microphone stays open after a recording, for the next press to start at once. */
export const MIC_KEPT_MS = 10_000;

/**
 * The microphone between presses: opened by the first, kept for `keptMs` after the last and then
 * let go, so other apps (a call) get it and the system's microphone indicator goes out. Until
 * 2026-11-09 it stayed open as long as the page, and Teams found it taken.
 */
export function micHolder<M>(open: () => Promise<M>, close: (m: M) => void, keptMs = MIC_KEPT_MS) {
  let held: Promise<M> | null = null;
  /** The held microphone once it is open: dropped then, it closes before anything opens it anew. */
  let opened: M | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = () => {
    clearTimeout(timer);
    const h = held;
    const m = opened;
    held = null;
    opened = undefined;
    if (m !== undefined) close(m);
    else void h?.then(close, () => {});
  };
  return {
    /** The open microphone, opening it if it is not. */
    take(): Promise<M> {
      clearTimeout(timer);
      if (!held) {
        const p = open();
        held = p;
        p.then((m) => held === p && (opened = m), () => {});
      }
      return held;
    },
    /** Lets it go at once; the next `take` opens it afresh. */
    drop,
    /** Lets it go after `keptMs`, unless taken again meanwhile. */
    release() {
      clearTimeout(timer);
      timer = setTimeout(drop, keptMs);
    },
  };
}

/** A name for a recording, unique enough to ask about it; `crypto.randomUUID` is missing outside a secure context. */
const recordingName = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Recording and sending; `level` drives the ring while listening, `flat` says the microphone delivers
 * nothing. A recording begun with the cursor in a text field is dictated into it. Any other one
 * `send` hands on with the draft `field` names for its target, and settles with what Obeya made of
 * it; the next one may start meanwhile.
 */
export function usePushToTalk(
  where: () => Where,
  field: (target: Where) => string,
  send: (target: Where, request: () => Promise<Heard>) => Promise<Heard>,
  onHeard: (h: Heard) => void,
  place: () => Place | undefined,
) {
  const [phase, setPhase] = useState<Phase>('idle');
  /** The microphone shows it listens: `shownAfter` into the recording. */
  const [shown, setShown] = useState(false);
  const showing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [level, setLevel] = useState(0);
  const [flat, setFlat] = useState(false);
  /** Recordings let go of that Obeya has not answered yet. */
  const [writing, setWriting] = useState(0);
  const [mic] = useState(() => micHolder(openMic, closeMic));
  const rec = useRef<{ recording: Recording; t0: number; target: Where; into: string | null; spot: Taken | null } | null>(null);
  const held = useRef<number | null>(null);
  const frame = useRef(0);
  /** Unmounted: a press still opening the microphone is over. */
  const gone = useRef(false);
  /** Lets the microphone go after a while, unless a press holds it. */
  const release = () => held.current === null && !rec.current && mic.release();

  /** `shownAfter`: how long after the press the microphone shows it listens. */
  async function start(shownAfter = 0) {
    if (held.current !== null || rec.current) return;
    const pressed = performance.now();
    held.current = pressed;
    const target = where();
    // the cursor in a field: the words go into it
    const into = focusedDraft();
    // the video stands where the owner started speaking: what they say is about that place
    const spot = !into && target && 'card' in target ? take(target.card) : null;
    api.warmVoice();
    const failed = (confirm: string) => {
      // let go meanwhile and pressed anew: the newer press holds the microphone and tells for itself
      if (gone.current || (held.current !== null && held.current !== pressed)) return;
      mic.drop();
      held.current = null;
      onHeard({ confirm });
    };
    let m;
    try {
      // the first press after a page load opens the microphone, which takes a moment; so does the
      // first after the phone took it away
      m = await mic.take();
      // a press let go meanwhile opens nothing anew: a newer one does, or the next
      if (!stillOpen(m) && held.current === pressed) {
        mic.drop();
        m = await mic.take();
      }
    } catch {
      return failed(t.voice.noMic);
    }
    if (held.current !== pressed) {
      // let go before the microphone was open: nothing was recorded, and a recording started now would run on unheld
      if (held.current === null && !gone.current && performance.now() - pressed >= TAP_MS) onHeard({ confirm: t.voice.notReady });
      release();
      return;
    }
    void m.ctx.resume();
    let recording;
    try {
      recording = record(m.stream, m.ctx);
    } catch {
      // the next press opens the microphone afresh
      return failed(t.voice.notReady);
    }
    const r = { recording, t0: performance.now(), target, into, spot };
    rec.current = r;
    if (into) beginDictation(into);
    setPhase('listening');
    const wait = shownAfter - (performance.now() - pressed);
    if (wait > 0) showing.current = setTimeout(() => rec.current === r && setShown(true), wait);
    else setShown(true);
    const buf = new Float32Array(m.analyser.fftSize);
    let loudest = 0;
    const meter = () => {
      if (rec.current !== r) return;
      m.analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) {
        s += x * x;
        loudest = Math.max(loudest, Math.abs(x));
      }
      setLevel(Math.min(1, Math.sqrt(s / buf.length) * 6));
      // a suspended context reads flat too; only a running one tells about the microphone
      setFlat(m.ctx.state === 'running' && performance.now() - r.t0 > FLAT_MS && 20 * Math.log10(loudest) < QUIET_DBFS);
      frame.current = requestAnimationFrame(meter);
    };
    meter();
  }

  function stop() {
    held.current = null;
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    cancelAnimationFrame(frame.current);
    clearTimeout(showing.current);
    setShown(false);
    setLevel(0);
    setFlat(false);
    const length = performance.now() - r.t0;
    // a card the command makes goes where the owner was when they stopped speaking, not once it is read
    const at = r.into ? undefined : place();
    setPhase('idle');
    setWriting((n) => n + 1);
    void r.recording.stop().then(async (audio) => {
      release();
      if (r.into) return into(r.into, r.target, length < TAP_MS ? null : audio);
      // a tap is not a command
      if (length < TAP_MS) return;
      // what stands in the field goes out with the words and leaves it; nothing heard, it comes back
      const key = field(r.target);
      await uploaded(key);
      const { text, images } = draftOf(key);
      updateDraft(key, (d) => ({ text: '', images: d.images.filter((id) => !images.includes(id)) }));
      // said in reply to the message the field quotes, as typed words are
      const reply = replyOn(key);
      if (reply) setReply(key, null);
      // the field gets them back only when Obeya says it has not taken the command: until
      // 2026-10-16 a connection that broke (the browser cutting it off as the page went to another
      // canvas, say) counted as that, although Obeya had the command and read on, and the draft
      // kept for the page's next load brought the screenshots back
      const name = recordingName();
      let failed = false;
      const h = await send(r.target, async () => {
        try {
          return await api.voice(audio, r.target, { images, replyTo: reply?.to, text, spot: await sent(r.spot), place: at, sent: name });
        } catch (e) {
          if (!(e instanceof ApiError) && (await arrived(name))) return { confirm: t.voice.answerLost };
          failed = true;
          throw e;
        }
      });
      if (!h.unheard && !failed) return;
      updateDraft(key, (d) => ({ text: [text, d.text].filter((x) => x.trim()).join(' '), images: [...images, ...d.images.filter((id) => !images.includes(id))] }));
      if (reply && !replyOn(key)) setReply(key, reply);
    }).finally(() => setWriting((n) => n - 1));
  }

  /** A dictation: what was heard goes into the field at its cursor; nothing heard leaves the field as it was, and says so. */
  async function into(key: string, target: Where, audio: Blob | null) {
    if (!audio) return updateDraft(key, { dictation: '' });
    updateDraft(key, { dictation: 'writing' });
    let h: Heard;
    try {
      h = await api.voice(audio, target, { listen: true });
    } catch (e) {
      h = { confirm: failText(e, { offline: t.voice.failed }), unheard: true };
    }
    if (!h.unheard && h.text) dictate(key, h.text);
    const note = h.unheard ? h.confirm : '';
    updateDraft(key, { dictation: '', note });
    if (note) setTimeout(() => draftOf(key).note === note && updateDraft(key, { note: '' }), NOTE_MS);
  }

  // a press still opening the microphone records nothing then, and opens nothing anew
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      held.current = null;
      mic.drop();
    };
  }, []);
  // a restart waits while the owner speaks and until what they said is in the field or answered:
  // until 2026-10-14 it went ahead once they let go, and a long dictation's words were lost
  useEffect(() => {
    holdRestart('voice', phase === 'idle' && !writing ? null : 'voice');
    return () => holdRestart('voice', null);
  }, [phase, writing]);
  return { phase: shown ? phase : 'idle', level, flat, start, stop };
}

/** A command on its way: while it is transcribed or the Coordinator reads it, then its confirmation. */
export interface Told {
  id: number;
  /** What the line says meanwhile: the card in view, and what happens to the words; null for typed words, which the conversation shows at once. */
  pending: string | null;
  /** The card it was said to, named in the confirmation when another card is open by then. */
  card?: { id: string; title: string };
  heard?: Heard;
  /** "Undo" shows while the command still waits. */
  undo?: boolean;
}

/**
 * Commands spoken or typed, each with its own line from sending to its confirmation; one that went
 * out quietly (to the open card's agent) leaves no line. The server reads them one after the other.
 * `show` adds a confirmation that comes without a request: a request a card's agent passed on.
 * `inView` says whether the conversation the owner looks at shows the reply already: then it gets
 * no line, unless it has "Undo", which only the line offers.
 */
export function useTold(onHeard: (h: Heard) => void, inView: (h: Heard) => boolean = () => false) {
  const [told, setTold] = useState<Told[]>([]);
  const toldRef = useRef(told);
  toldRef.current = told;
  const next = useRef(0);
  const update = (id: number, fn: (x: Told) => Told | null) => setTold((ts) => ts.flatMap((x) => (x.id === id ? (fn(x) ?? []) : [x])));

  function settle(id: number, h: Heard) {
    if (h.quiet || (!h.token && inView(h))) return update(id, () => null);
    const undo = !!(h.token && h.undoMs);
    update(id, (x) => ({ ...x, heard: h, undo }));
    if (undo) setTimeout(() => update(id, (x) => ({ ...x, undo: false })), undoShownMs(h.undoMs!));
    setTimeout(() => update(id, () => null), confirmShownMs(h.undoMs));
  }

  async function tell(pending: string | null, card: Told['card'], request: () => Promise<Heard>): Promise<Heard> {
    const id = ++next.current;
    setTold((ts) => [...ts, { id, pending, ...(card ? { card } : {}) }]);
    let h: Heard;
    try {
      h = await request();
    } catch (e) {
      h = { confirm: failText(e, { offline: t.voice.failed }) };
    }
    settle(id, h);
    onHeard(h);
    return h;
  }

  function show(card: Told['card'], h: Heard) {
    // the server offers a command's undo again when the connection comes back: one line for it
    if (h.token && toldRef.current.some((x) => x.heard?.token === h.token)) return;
    const id = ++next.current;
    setTold((ts) => [...ts, { id, pending: '', ...(card ? { card } : {}) }]);
    settle(id, h);
  }

  async function undo(x: Told) {
    update(x.id, (y) => ({ ...y, undo: false }));
    try {
      const { undone } = await api.undo(x.heard!.token!);
      update(x.id, (y) => (undone ? null : { ...y, heard: { confirm: t.voice.tooLate } }));
    } catch {
      update(x.id, (y) => ({ ...y, heard: { confirm: t.offlineError } }));
    }
  }

  // a restart waits while Obeya reads what the owner said or typed
  const reading = told.some((x) => !x.heard);
  useEffect(() => {
    holdRestart('told', reading ? 'voice' : null);
    return () => holdRestart('told', null);
  }, [reading]);
  /** A line the owner swiped aside: gone, and the confirmation of a command still read does not follow. */
  const drop = (x: Told) => update(x.id, () => null);
  return { told, tell, show, undo, drop };
}

/**
 * The commands on their way, above the microphone, oldest first; `open`: the card open now. With
 * `aside` (the phone) the owner swipes a line away, and `onGone` drops it.
 */
export function ToldList({ told, open, onUndo, aside = false, onGone }: { told: Told[]; open?: string; onUndo: (x: Told) => void; aside?: boolean; onGone?: (x: Told) => void }) {
  return (
    <>
      {told.map((x) => (x.heard || x.pending) && (
        <Aside key={x.id} on={aside} onGone={() => onGone?.(x)} className={`ack told ${x.heard ? 'heard' : 'reading'}`}>
          <span>
            {x.heard ? (
              <>
                {x.card && x.card.id !== open && <b>{t.voice.about(x.card.title)}</b>}
                {x.heard.confirm}
              </>
            ) : (
              x.pending
            )}
          </span>
          {x.undo && <button onClick={() => onUndo(x)}>{t.undo}</button>}
        </Aside>
      ))}
    </>
  );
}

/**
 * A microphone held by a finger: the touch is the press and nothing else. Held for half a second,
 * Chrome on Android took it for a long press on what stands around the button (the field's frame):
 * it began selecting text, which closed the keyboard and cancelled the touch, so the recording ended
 * at once. A touch whose start is cancelled makes no long press, no selection and no focus change.
 */
export function useHeldByTouch<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // React listens to touchstart passively, where cancelling it does nothing
    const hold = (e: TouchEvent) => e.preventDefault();
    el.addEventListener('touchstart', hold, { passive: false });
    return () => el.removeEventListener('touchstart', hold);
  });
  return ref;
}

/**
 * The microphone at the bottom, and under it where what is said goes: into the field with the
 * cursor, or to `target` with what stands in its field (`field`, the draft of the card or sidebar in
 * view, while that has its field on the page). With no `target` (the phone, where what is in view
 * fills the screen) that line is left out. Without such a field, screenshots for the next
 * recording are picked beside the microphone; dropped on it or pasted (App), they go to the field
 * when there is one. So do the paths of other files dropped on it, which show beside it by their
 * names while they wait there. Those for Obeya stay in view: they go into Obeya's field when it
 * opens, and back beside the microphone when it closes, the paths that still stand in its words too.
 */
export function PushToTalk({ phase, level, flat, target, field, onDown }: { phase: Phase; level: number; flat: boolean; target: string | null; field: string | null; onDown: () => void }) {
  const on = useFieldOn(field);
  const key = on ? field! : MIC_DRAFT;
  const shots = useShotInput({ draft: key, off: !takesImages(key) });
  // the screenshots and files for Obeya show where Obeya is spoken to: in its field while that is in view, else beside the microphone
  const obeya = useRef<string | null>(null);
  const beside = useDraft(MIC_DRAFT);
  const { images: waiting, text: paths } = beside;
  useEffect(() => {
    if (toObeya(key) && takesImages(key)) {
      obeya.current = key;
      moveImages(MIC_DRAFT, key);
      if (paths.trim()) {
        const texts = pastedIn(beside);
        insertFiles(key, wordsOf(withoutPasted(paths, texts)));
        insertPasted(key, texts);
        updateDraft(MIC_DRAFT, { text: '', pasted: [] });
      }
    } else if (key === MIC_DRAFT && obeya.current) {
      moveImages(obeya.current, MIC_DRAFT);
      moveFiles(obeya.current, MIC_DRAFT);
      obeya.current = null;
    }
  }, [key, waiting, paths]);
  const draft = useDraft(key);
  const pasted = pastedIn(draft);
  const text = withoutPasted(draft.text, pasted);
  const quote = useReply(key);
  const pasteHint = usePasteTextHint();
  const into = useFocusedDraft();
  const n = shots.images.length;
  const mic = useHeldByTouch<HTMLButtonElement>();
  const parts = [...(text.trim() ? [t.voice.withText] : []), ...(pasted.length ? [t.voice.withPasted] : []), ...(n ? [t.voice.withShots(n)] : []), ...(on && quote ? [t.voice.withQuote] : [])];
  return (
    <div id="ptt" className={`${phase}${shots.dropping ? ' dropping' : ''}`} {...shots.drop}>
      <div className="ptt-row">
        <button
          id="mic"
          ref={mic}
          title={t.voice.hold}
          style={{ ['--lvl' as string]: 1 + level * 0.45 }}
          onPointerDown={(e) => {
            // the cursor stays where it is: in a field, what is said is written into it
            e.preventDefault();
            onDown();
          }}
          // held by a finger, it shows no menu
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="ring" />
          <MicIcon />
        </button>
        {key === MIC_DRAFT && (
          <div className="ptt-shots">
            <AttachButton shots={shots} title={t.voice.attach} />
            <ShotStrip shots={shots} />
            <FileChips />
          </div>
        )}
      </div>
      {shots.error && key === MIC_DRAFT && <div className="ptt-error">{shots.error}</div>}
      {flat ? (
        <div id="target" className="flat">
          {t.voice.flat}
        </div>
      ) : into ? (
        <div id="target" className="into">
          → <b>{t.voice.intoField}</b>
          {sendsWithEnter(into) && t.voice.sendWithEnter && ` · ${t.voice.sendWithEnter}`}
        </div>
      ) : (
        target !== null && (
          <div id="target">
            → <b>{target}</b>
            {parts.length > 0 ? <span className="with"> {t.voice.with(parts)}</span> : pasteHint && <span className="hint"> · {t.voice.pasteText(pasteKeys().paste)}</span>}
          </div>
        )
      )}
    </div>
  );
}

/**
 * The files dropped on the microphone without a field to take their paths, by name, and the texts
 * pasted outside a field, by their start: each to remove.
 */
function FileChips() {
  const draft = useDraft(MIC_DRAFT);
  const texts = pastedIn(draft);
  const words = wordsOf(withoutPasted(draft.text, texts));
  if (!words.length && !texts.length) return null;
  const drop = (text: string) => updateDraft(MIC_DRAFT, { text });
  return (
    <div className="ptt-files">
      {words.map((w, i) => (
        <span key={`f${i}`} className="c-file" title={w}>
          <span className="name">{w.replace(/"/g, '').split(/[\\/]/).at(-1)}</span>
          <button className="remove" title={t.remove} onClick={() => drop(withoutWords(draft.text, [w]))}>
            ×
          </button>
        </span>
      ))}
      {texts.map((p, i) => (
        <span key={`t${i}`} className="c-file c-pasted" title={p.length > PASTED_TITLE ? `${p.slice(0, PASTED_TITLE)} …` : p}>
          <span className="name">{p.slice(0, 300)}</span>
          <button className="remove" title={t.remove} onClick={() => drop(withoutPasted(draft.text, [p]))}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/** How much of a pasted text its chip's tooltip shows. */
const PASTED_TITLE = 600;

export function MicIcon({ size }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
