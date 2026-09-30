// Push-to-talk: hold Space or the microphone, speak, let go. The recording goes to Obeya, which
// answers with a confirmation to show and play.

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { t } from './strings';

export interface Heard {
  confirm: string;
  token?: string;
  audio?: string;
}

export type Where = { card: string } | { project: string } | null;

type Phase = 'idle' | 'listening' | 'thinking';

/** Recording and sending; `level` drives the ring while listening. */
export function usePushToTalk(where: () => Where, onHeard: (h: Heard) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const mic = useRef<{ stream: MediaStream; analyser: AnalyserNode } | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; t0: number; target: Where } | null>(null);
  const frame = useRef(0);

  async function start() {
    if (rec.current || phase === 'thinking') return;
    try {
      if (!mic.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        mic.current = { stream, analyser };
      }
    } catch {
      onHeard({ confirm: t.voice.noMic });
      return;
    }
    const recorder = new MediaRecorder(mic.current.stream);
    const r = { recorder, chunks: [] as Blob[], t0: performance.now(), target: where() };
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.start();
    rec.current = r;
    setPhase('listening');
    const buf = new Uint8Array(512);
    const meter = () => {
      if (!rec.current || !mic.current) return setLevel(0);
      mic.current.analyser.getByteTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += ((x - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(s / buf.length) * 6));
      frame.current = requestAnimationFrame(meter);
    };
    meter();
  }

  function stop() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    cancelAnimationFrame(frame.current);
    setLevel(0);
    const held = performance.now() - r.t0;
    r.recorder.onstop = async () => {
      // a tap is not a command
      if (held < 350) return setPhase('idle');
      setPhase('thinking');
      try {
        onHeard(await api.voice(new Blob(r.chunks, { type: r.recorder.mimeType }), r.target));
      } catch {
        onHeard({ confirm: t.voice.failed });
      }
      setPhase('idle');
    };
    r.recorder.stop();
  }

  useEffect(() => () => mic.current?.stream.getTracks().forEach((tr) => tr.stop()), []);
  return { phase, level, start, stop };
}

export function PushToTalk({ phase, level, target, onDown }: { phase: Phase; level: number; target: string; onDown: () => void }) {
  return (
    <div id="ptt" className={phase}>
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
      <div id="target">
        → <b>{target}</b>
      </div>
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
