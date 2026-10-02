// Push-to-talk: hold Space or the microphone, speak, let go. The recording goes to Obeya, which
// answers with a confirmation to show and play. Screenshots picked or pasted beside the microphone
// go with the next recording.

import { useEffect, useRef, useState } from 'react';
import { api, holdRestart } from './api';
import { AttachButton, type ShotInput, ShotStrip } from './shots';
import { t } from './strings';

export interface Heard {
  confirm: string;
  token?: string;
  /** How long the command still waits for "Rückgängig". */
  undoMs?: number;
  /** Where the spoken confirmation plays from; it may still be rendering. */
  audio?: string;
  /** Said to the open idea: its conversation shows it, so there is nothing to confirm. */
  quiet?: boolean;
  /** Nothing was heard: the screenshots shown with it wait for the next recording. */
  unheard?: boolean;
}

export type Where = { card: string } | { project: string } | null;

type Phase = 'idle' | 'listening' | 'thinking';

/** Below this peak a working microphone delivers nothing, not even room noise (the sidecar's threshold too). */
const QUIET_DBFS = -60;
/** How long the level may stay flat at the start of a recording before the owner is told. */
const FLAT_MS = 1500;

/**
 * Recording and sending, with the screenshots beside the microphone; `level` drives the ring while
 * listening, `flat` says the microphone delivers nothing.
 */
export function usePushToTalk(where: () => Where, onHeard: (h: Heard) => void, shots: ShotInput) {
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [flat, setFlat] = useState(false);
  const mic = useRef<Promise<{ stream: MediaStream; ctx: AudioContext; analyser: AnalyserNode }> | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; t0: number; target: Where } | null>(null);
  const held = useRef<number | null>(null);
  const frame = useRef(0);

  async function start() {
    if (held.current !== null || rec.current || phase === 'thinking') return;
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
    r.recorder.onstop = async () => {
      // a tap is not a command
      if (length < 350) return setPhase('idle');
      setPhase('thinking');
      // those still uploading wait for the next recording
      const images = shotsRef.current.images;
      try {
        const h = await api.voice(new Blob(r.chunks, { type: r.recorder.mimeType }), r.target, images);
        if (!h.unheard) shotsRef.current.clear(images);
        // a restart within the undo window would lose the command
        if (h.token && h.undoMs) {
          const by = `undo-${h.token}`;
          holdRestart(by, 'voice');
          setTimeout(() => holdRestart(by, null), h.undoMs + 1000);
        }
        onHeard(h);
      } catch {
        onHeard({ confirm: t.voice.failed });
      }
      setPhase('idle');
    };
    r.recorder.stop();
  }

  useEffect(() => () => void mic.current?.then((m) => m.stream.getTracks().forEach((tr) => tr.stop())), []);
  // a restart waits while the owner speaks and Obeya reads it
  useEffect(() => {
    holdRestart('voice', phase === 'idle' ? null : 'voice');
    return () => holdRestart('voice', null);
  }, [phase]);
  return { phase, level, flat, start, stop };
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

/** Plays a spoken confirmation; the previous one stops. */
let playing: HTMLAudioElement | null = null;
export function play(audio: string | undefined) {
  playing?.pause();
  if (!audio) return;
  playing = new Audio(audio);
  playing.play().catch(() => {});
}
