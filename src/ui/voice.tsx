// Push-to-talk: hold Space or the microphone, speak, let go. The recording goes to Obeya, which
// answers with a confirmation to show and play. Screenshots picked or pasted beside the microphone
// go with the next recording. The microphone is free again at once: each command, spoken or typed,
// has its own line above it while the Koordinator reads it, which becomes its confirmation.

import { useEffect, useRef, useState } from 'react';
import { ApiError, api, holdRestart } from './api';
import { AttachButton, type ShotInput, ShotStrip } from './shots';
import { errorText, t } from './strings';

export interface Heard {
  confirm: string;
  token?: string;
  /** How long the command still waits for "Rückgängig". */
  undoMs?: number;
  /** Where the spoken confirmation plays from; it may still be rendering. */
  audio?: string;
  /** Said to the open card's agent or idea: the card shows it, so there is nothing to confirm. */
  quiet?: boolean;
  /** Nothing was heard: the screenshots shown with it wait for the next recording. */
  unheard?: boolean;
}

export type Where = { card: string } | { project: string } | null;

type Phase = 'idle' | 'listening';

/** Below this peak a working microphone delivers nothing, not even room noise (the sidecar's threshold too). */
const QUIET_DBFS = -60;
/** How long the level may stay flat at the start of a recording before the owner is told. */
const FLAT_MS = 1500;

/**
 * Recording and sending, with the screenshots beside the microphone; `level` drives the ring while
 * listening, `flat` says the microphone delivers nothing. `send` hands a recording on and settles
 * with what Obeya made of it; the next one may start meanwhile.
 */
export function usePushToTalk(where: () => Where, send: (target: Where, request: () => Promise<Heard>) => Promise<Heard>, onHeard: (h: Heard) => void, shots: ShotInput) {
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  /** Screenshots sent with a recording still being read: the next recording does not take them again. */
  const sending = useRef(new Set<string>());
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [flat, setFlat] = useState(false);
  const mic = useRef<Promise<{ stream: MediaStream; ctx: AudioContext; analyser: AnalyserNode }> | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; t0: number; target: Where } | null>(null);
  const held = useRef<number | null>(null);
  const frame = useRef(0);

  async function start() {
    if (held.current !== null || rec.current) return;
    const pressed = performance.now();
    held.current = pressed;
    const target = where();
    api.warmVoice();
    let m;
    try {
      // the first press after a page load opens the microphone, which takes a moment
      mic.current ??= navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        return { stream, ctx, analyser };
      });
      m = await mic.current;
    } catch {
      mic.current = null;
      held.current = null;
      onHeard({ confirm: t.voice.noMic });
      return;
    }
    if (held.current !== pressed) {
      // let go before the microphone was open: nothing was recorded, and a recording started now would run on unheld
      if (held.current === null && performance.now() - pressed >= 350) onHeard({ confirm: t.voice.notReady });
      return;
    }
    void m.ctx.resume();
    const recorder = new MediaRecorder(m.stream);
    const r = { recorder, chunks: [] as Blob[], t0: performance.now(), target };
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.start();
    rec.current = r;
    setPhase('listening');
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
    setLevel(0);
    setFlat(false);
    const length = performance.now() - r.t0;
    setPhase('idle');
    r.recorder.onstop = async () => {
      // a tap is not a command
      if (length < 350) return;
      // those still uploading wait for the next recording
      const images = shotsRef.current.images.filter((id) => !sending.current.has(id));
      for (const id of images) sending.current.add(id);
      const h = await send(r.target, () => api.voice(new Blob(r.chunks, { type: r.recorder.mimeType }), r.target, images));
      for (const id of images) sending.current.delete(id);
      if (!h.unheard) shotsRef.current.clear(images);
    };
    r.recorder.stop();
  }

  useEffect(() => () => void mic.current?.then((m) => m.stream.getTracks().forEach((tr) => tr.stop())), []);
  // a restart waits while the owner speaks
  useEffect(() => {
    holdRestart('voice', phase === 'idle' ? null : 'voice');
    return () => holdRestart('voice', null);
  }, [phase]);
  return { phase, level, flat, start, stop };
}

/** A command on its way: while the Koordinator reads it, then its confirmation. */
export interface Told {
  id: number;
  /** What it is about while it is read: the card in view, or the words typed. */
  label: string;
  /** The card it was said to, named in the confirmation when another card is open by then. */
  card?: { id: string; title: string };
  heard?: Heard;
  /** "Rückgängig" shows while the command still waits. */
  undo?: boolean;
}

/** How long a confirmation stays, unless its undo window is longer. */
const SHOWN_MS = 7000;

/**
 * Commands spoken or typed, each with its own line from sending to its confirmation; one that went
 * out quietly (to the open card's agent or idea) leaves no line. The server reads them one after the other.
 */
export function useTold(onHeard: (h: Heard) => void) {
  const [told, setTold] = useState<Told[]>([]);
  const next = useRef(0);
  const update = (id: number, fn: (x: Told) => Told | null) => setTold((ts) => ts.flatMap((x) => (x.id === id ? (fn(x) ?? []) : [x])));

  async function tell(label: string, card: Told['card'], request: () => Promise<Heard>): Promise<Heard> {
    const id = ++next.current;
    setTold((ts) => [...ts, { id, label, ...(card ? { card } : {}) }]);
    let h: Heard;
    try {
      h = await request();
    } catch (e) {
      h = { confirm: e instanceof ApiError ? errorText(e.code) : t.voice.failed };
    }
    if (h.quiet) update(id, () => null);
    else {
      const undo = !!(h.token && h.undoMs);
      update(id, (x) => ({ ...x, heard: h, undo }));
      if (undo) {
        // a restart within the undo window would lose the command
        const by = `undo-${h.token}`;
        holdRestart(by, 'voice');
        setTimeout(() => holdRestart(by, null), h.undoMs! + 1000);
        setTimeout(() => update(id, (x) => ({ ...x, undo: false })), Math.max(0, h.undoMs! - 400));
      }
      setTimeout(() => update(id, () => null), Math.max(SHOWN_MS, (h.undoMs ?? 0) + 1500));
    }
    onHeard(h);
    return h;
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
  return { told, tell, undo };
}

/** The commands on their way, above the microphone, oldest first; `open`: the card open now. */
export function ToldList({ told, open, onUndo }: { told: Told[]; open?: string; onUndo: (x: Told) => void }) {
  return (
    <>
      {told.map((x) => (
        <div key={x.id} className={`ack told ${x.heard ? 'heard' : 'reading'}`}>
          <span>
            {x.heard ? (
              <>
                {x.card && x.card.id !== open && <b>{t.voice.about(x.card.title)}</b>}
                {x.heard.confirm}
              </>
            ) : (
              t.voice.reading(x.label)
            )}
          </span>
          {x.undo && <button onClick={() => onUndo(x)}>{t.undo}</button>}
        </div>
      ))}
    </>
  );
}

export function PushToTalk({ phase, level, flat, target, shots, onDown }: { phase: Phase; level: number; flat: boolean; target: string; shots: ShotInput; onDown: () => void }) {
  return (
    <div id="ptt" className={`${phase}${shots.dropping ? ' dropping' : ''}`} {...shots.drop}>
      <div className="ptt-row">
        <button
          id="mic"
          title={t.voice.hold}
          style={{ ['--lvl' as string]: 1 + level * 0.45 }}
          onPointerDown={(e) => {
            e.preventDefault();
            onDown();
          }}
        >
          <span className="ring" />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <div className="ptt-shots">
          <AttachButton shots={shots} title={t.voice.attach} />
          <ShotStrip shots={shots} />
        </div>
      </div>
      {shots.error && <div className="ptt-error">{shots.error}</div>}
      {flat ? (
        <div id="target" className="flat">
          {t.voice.flat}
        </div>
      ) : (
        <div id="target">
          → <b>{target}</b>
        </div>
      )}
    </div>
  );
}

/** Plays a spoken confirmation; the previous one stops. Nothing is said while a demo video plays. */
let playing: HTMLAudioElement | null = null;
export function play(audio: string | undefined) {
  playing?.pause();
  if (!audio || videoPlaying()) return;
  playing = new Audio(audio);
  playing.play().catch(() => {});
}
const videoPlaying = () => [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
// a video the owner starts silences what is being said ('play' does not bubble, so listen on the way down)
addEventListener('play', (e) => e.target instanceof HTMLVideoElement && playing?.pause(), true);
