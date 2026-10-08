// The floating panel of the app's push-to-talk key: while the owner holds the key in another app,
// it shows that Obeya listens and to whom, then what it heard and the confirmation, with
// "Rückgängig" while the command waits, and plays the spoken confirmation. The shell
// (app/src/ptt.rs) records and sends and calls `window.obeyaPanel`; the panel has the shell fit
// the window to its lines (`panel_fit`), hiding it when none are left.

import { FALLBACK_LANGUAGE, languageOf } from '../core/locale';
import { api } from './api';
import { setLanguage, t } from './strings';
import type { Heard } from './voice';

const language = await api.language().then(
  (l) => l.language,
  () => languageOf(navigator.language) ?? FALLBACK_LANGUAGE,
);
setLanguage(language);

/** How long a confirmation stays, unless its undo window is longer (as above the microphone). */
const SHOWN_MS = 7000;

interface Line {
  el: HTMLDivElement;
  timers: ReturnType<typeof setTimeout>[];
}
const box = document.getElementById('lines')!;
const lines = new Map<number | 'listening', Line>();
let playing: HTMLAudioElement | null = null;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  }
}

/** The window as tall as its lines, or hidden without any (after this change; not in a frame: a hidden window draws none). */
function fit() {
  queueMicrotask(() => {
    const height = lines.size ? Math.ceil(box.getBoundingClientRect().height) : 0;
    void window.__TAURI_INTERNALS__?.invoke('panel_fit', { height }).catch(() => {});
  });
}

function put(id: number | 'listening', className: string, ...children: Node[]) {
  const old = lines.get(id);
  const el = document.createElement('div');
  el.className = `line ${className}`;
  el.append(...children);
  if (old) {
    old.timers.forEach(clearTimeout);
    old.el.replaceWith(el);
  } else box.append(el);
  const line: Line = { el, timers: [] };
  lines.set(id, line);
  fit();
  return line;
}

function drop(id: number | 'listening') {
  const line = lines.get(id);
  if (!line) return;
  line.timers.forEach(clearTimeout);
  line.el.remove();
  lines.delete(id);
  fit();
}

const span = (className: string, text: string) => Object.assign(document.createElement('span'), { className, textContent: text });

const panel = {
  /** The owner holds the key: what is being said stops, and the line shows who listens (as the page said; none without a page). */
  listen(target: string | null) {
    playing?.pause();
    const what = document.createElement('span');
    what.className = 'what';
    what.append(span('', t.voice.listening), span('target', `→ ${target ?? t.voice.koordinator}`), span('flat', ''));
    put('listening', 'listening', Object.assign(document.createElement('span'), { className: 'mic' }), what);
  },
  /** The microphone's level, 0–1, and whether it has delivered nothing for a while. */
  level(level: number, flat: boolean) {
    const line = lines.get('listening');
    if (!line) return;
    (line.el.querySelector('.mic') as HTMLElement).style.setProperty('--lvl', String(1 + level * 0.8));
    line.el.querySelector('.flat')!.textContent = flat ? t.voice.flat : '';
  },
  /** Let go too soon, or another key went with it: nothing is sent. */
  cancel() {
    drop('listening');
  },
  /** Let go: the recording `id` is being read, said with the card `title` open (or none). */
  reading(id: number, title: string | null) {
    drop('listening');
    put(id, 'reading', span('what', t.voice.reading(title ? `„${title}“` : t.voice.koordinator)));
  },
  /** What Obeya made of recording `id` on `canvas`. */
  heard(id: number, canvas: string, h: Heard & { text?: string }) {
    if (h.quiet) {
      // said to the open card's agent: the card shows it, and the panel shows it was sent
      drop(id);
      return;
    }
    const what = document.createElement('span');
    what.className = 'what';
    if (h.text) what.append(span('heard', `„${h.text}“`));
    what.append(document.createTextNode(h.confirm));
    const line = (() => {
      if (!(h.token && h.undoMs)) return put(id, '', what);
      const button = Object.assign(document.createElement('button'), { textContent: t.undo });
      const l = put(id, '', what, button);
      button.onclick = async () => {
        button.remove();
        const res = await fetch(`/api/c/${encodeURIComponent(canvas)}/command/undo`, { method: 'POST', body: JSON.stringify({ token: h.token }) }).catch(() => null);
        const { undone } = res?.ok ? ((await res.json()) as { undone: boolean }) : { undone: false };
        if (undone) drop(id);
        else what.lastChild!.textContent = res ? t.voice.tooLate : t.offlineError;
        fit();
      };
      l.timers.push(setTimeout(() => (button.remove(), fit()), Math.max(0, h.undoMs - 400)));
      return l;
    })();
    line.timers.push(setTimeout(() => drop(id), Math.max(SHOWN_MS, (h.undoMs ?? 0) + 1500)));
    if (h.audio && !lines.has('listening')) {
      playing?.pause();
      playing = new Audio(h.audio);
      playing.play().catch(() => {});
    }
  },
  /** Recording `id` did not reach Obeya. */
  failed(id: number) {
    const line = put(id, '', span('what', t.voice.failed));
    line.timers.push(setTimeout(() => drop(id), SHOWN_MS));
  },
};

(window as unknown as { obeyaPanel: typeof panel }).obeyaPanel = panel;
