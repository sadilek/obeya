// Prototype: an answer told as a walkthrough, played while it is being written. The answering agent
// hands Obeya one slide at a time (`walkthrough_slide`), the first as soon as it knows what the
// walkthrough answers; Obeya reads the code slides' lines from the repository, shows a player page
// under the question at once (`<name>.walkthrough.html` in the thread's output directory), and
// voices each slide's narration sentence by sentence in the voice of the demo settings, so the
// player can start with the first sentence while the agent still writes the slides after it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AnswerFile } from '../core/types';
import type { AgentTool } from './runtime';
import { DEMO_SETTINGS_FILE, inLanguage, readDemoSettings, obeyaHome } from '../../plugin/skills/demo/lib/settings.ts';
import { speak } from '../../plugin/skills/demo/lib/voices.ts';

type Slide =
  | { type: 'title'; title: string; subtitle?: string; narration?: Narration }
  | { type: 'points'; title: string; points: string[]; narration: Narration }
  | { type: 'flow'; title: string; steps: (string | { label: string; note?: string })[]; narration: Narration }
  | { type: 'code'; title: string; file: string; lines: [number, number]; focus?: [number, number][]; note?: string; narration: Narration; code?: string[] };
/** One text, or one part per item of the slide (point, step, focus), each shown as its part is spoken. */
type Narration = string | string[];

type Status = { clips: ({ file: string; seconds: number } | null)[][]; started: number; firstSoundMs: number | null; error: string | null };

/** How the agent tells a walkthrough, as every look-up hears it. */
export const WALKTHROUGH_NOTE = `Walkthroughs: an answer that explains how something unfolds, step after step (a flow through the code, what happens one thing after the other, what a change does), comes as a short narrated walkthrough rather than a block of text or a numbered list: the owner follows the steps more easily when they are told, one slide at a time. Other answers stay text; you judge which kind a question is, and the owner can always ask for a walkthrough of a text answer. Tell it with walkthrough_slide, one call per slide, in order: the owner sees and hears each slide as soon as you have handed it over, while you work on the next, so hand over the title slide as soon as you know what the walkthrough answers, and each further slide as soon as you have checked what it says. 4 to 8 slides, each with "narration" in the owner's language: spoken prose, two to four sentences a slide, explaining rather than reading the slide out; either one string, or a list of parts, one per item of the slide (point, step, focus range), each spoken while its item shows. Then call answer_owner with one or two sentences on what the walkthrough shows (the walkthrough comes with it by itself). Slide types:
- {"type": "title", "title", "subtitle", "narration"}: the first slide, what the walkthrough answers.
- {"type": "points", "title", "points": ["…"], "narration"}: up to five short points.
- {"type": "flow", "title", "steps": ["…" or {"label", "note"}], "narration"}: a simple diagram, three to six boxes in a row joined by arrows.
- {"type": "code", "title", "file": "<path in the repository>", "lines": [from, to], "focus": [[from, to], …], "note": "…", "narration"}: real lines of the repository (at most 30; Obeya reads them from the file, so give the exact line numbers you read), the focus ranges highlighted one after the other.`;

interface Live {
  file: string;
  caption: string;
  clipsDir: string;
  slides: (Slide & { parts: string[]; items?: number[] })[];
  status: Status;
  /** The voicing so far: each slide's sentences after those of the slide before. */
  voicing: Promise<void>;
}

/**
 * The walkthroughs of one turn of a look-up: the tool its agent hands slides over with, and what
 * the answer comes with. `onShown`: a walkthrough's first slide is there, its page to show under
 * the question while the agent goes on.
 */
export class Walkthroughs {
  private live = new Map<string, Live>();

  constructor(private o: { dir: string; checkout: string; language: 'de' | 'en'; autoplay?: boolean; onShown?: (files: AnswerFile[]) => void }) {}

  tool(): AgentTool {
    return {
      name: 'walkthrough_slide',
      description:
        "Hands the next slide of a walkthrough to Obeya, which shows it and voices its narration at once (see the walkthroughs in your instructions). name: the walkthrough's file name, short, the same for all its slides; title: the walkthrough's title, with its first slide; caption: one line on what it walks through, with its first slide; slide: the slide as JSON.",
      schema: { name: z.string(), title: z.string().optional(), caption: z.string().optional(), slide: z.record(z.string(), z.unknown()) },
      run: ({ name, title, caption, slide }) => this.add(String(name), title as string | undefined, caption as string | undefined, slide as unknown as Slide),
    };
  }

  private add(name: string, title: string | undefined, caption: string | undefined, raw: Slide): string {
    const base = name.replace(/\.walkthrough.*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'walkthrough';
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return 'No slide: give slide as an object with its type.';
    let w = this.live.get(base);
    if (!w) {
      const clips = `${base}.clips`;
      mkdirSync(join(this.o.dir, clips), { recursive: true });
      w = { file: `${base}.walkthrough.html`, caption: caption ?? title ?? '', clipsDir: join(this.o.dir, clips), slides: [], status: { clips: [], started: Date.now(), firstSoundMs: null, error: null }, voicing: Promise.resolve() };
      this.live.set(base, w);
      const data = JSON.stringify({ title: title ?? raw.title ?? '', language: this.o.language, clips, autoplay: !!this.o.autoplay }).replace(/</g, '\\u003c');
      const page = readFileSync(join(import.meta.dir, 'walkthrough-player.html'), 'utf8').replace('/*WALKTHROUGH*/null', data);
      writeFileSync(join(this.o.dir, w.file), page);
      this.write(w, false);
    }
    const slide = { ...withCode(raw, this.o.checkout), ...partsOf(raw) };
    const i = w.slides.length;
    w.slides.push(slide);
    w.status.clips.push(slide.parts.map(() => null));
    this.write(w, false);
    if (i === 0) this.o.onShown?.(this.files());
    const live = w;
    w.voicing = w.voicing.then(() => voice(slide.parts, i, live.clipsDir, this.o.language, live.status));
    return `Slide ${i + 1} is shown and being voiced. Hand over the next slide, or call answer_owner once the walkthrough is complete.`;
  }

  /** The players, as the answer's files. */
  files(): AnswerFile[] {
    return [...this.live.values()].map((w) => ({ name: w.file, caption: w.caption }));
  }

  /** The turn is over: the walkthroughs have all their slides. */
  finish() {
    for (const w of this.live.values()) this.write(w, true);
  }

  private write(w: Live, done: boolean) {
    writeFileSync(join(w.clipsDir, 'slides.json'), JSON.stringify({ slides: w.slides, done }));
    writeFileSync(join(w.clipsDir, 'status.json'), JSON.stringify(w.status));
  }
}

/** A code slide with its lines as the repository has them. */
function withCode(s: Slide, checkout: string): Slide {
  if (s.type !== 'code') return s;
  try {
    const all = readFileSync(join(checkout, s.file), 'utf8').split('\n');
    const [from, to] = [Math.max(1, s.lines[0]), Math.min(all.length, s.lines[1], s.lines[0] + 34)];
    return { ...s, lines: [from, to], code: all.slice(from - 1, to) };
  } catch {
    return { ...s, code: [`(${s.file} not found)`] };
  }
}

/**
 * A slide's narration as the clips it is spoken in, a sentence each, and for a narration in parts
 * the part each sentence belongs to (its item shows with the part); a slide without one says its title.
 */
function partsOf(s: Slide): { parts: string[]; items?: number[] } {
  const sentences = (text: string) => (text.match(/[^.!?]+(?:[.!?]+["“”„«»)]*|$)\s*/g) ?? [text]).map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(s.narration) && s.narration.length > 1) {
    const split = s.narration.map((p) => sentences(String(p)));
    return { parts: split.flat(), items: split.flatMap((p, k) => p.map(() => k)) };
  }
  const text = [s.narration ?? ''].flat().join(' ').trim() || [s.title, s.type === 'title' ? s.subtitle : ''].filter(Boolean).join('. ');
  return { parts: sentences(text) };
}

/** The voice of the demo settings, for a walkthrough. */
function voiceOf(language: 'de' | 'en') {
  const home = obeyaHome();
  // a scratch home without demo settings or voices of its own speaks with the machine's
  const settingsHome = existsSync(join(home, DEMO_SETTINGS_FILE)) ? home : join(homedir(), '.obeya');
  const voicesHome = existsSync(join(home, 'voices')) ? home : join(homedir(), '.obeya');
  return { s: inLanguage(readDemoSettings(settingsHome), language), voicesHome };
}

/** Loads the voice while the agent writes the first slide: a word, voiced into nowhere. */
export function warmVoice(language: 'de' | 'en') {
  const { s, voicesHome } = voiceOf(language);
  const out = join(tmpdir(), `obeya-warm-${process.pid}.wav`);
  void speak(s, language === 'de' ? 'Ja.' : 'Yes.', out, voicesHome, process.env.OBEYA_WALKTHROUGH_VOICE_URL).catch(() => {});
}

/** A slide's sentences one after the other, in the voice of the demo settings, each clip in its place once it is whole. */
async function voice(parts: string[], i: number, dir: string, language: 'de' | 'en', status: Status) {
  if (status.error) return;
  const { s, voicesHome } = voiceOf(language);
  for (const [j, text] of parts.entries()) {
    const file = `${i + 1}-${j + 1}.wav`;
    const part = `${i + 1}-${j + 1}.part.wav`;
    try {
      await speak(s, text, join(dir, part), voicesHome, process.env.OBEYA_WALKTHROUGH_VOICE_URL);
      renameSync(join(dir, part), join(dir, file));
      status.clips[i]![j] = { file, seconds: wavSeconds(join(dir, file)) };
      if (status.firstSoundMs === null) {
        status.firstSoundMs = Date.now() - status.started;
        console.log(`Obeya: walkthrough ${dir}: first sound ready ${(status.firstSoundMs / 1000).toFixed(1)} s after its first slide`);
      }
    } catch (e) {
      status.error = (e as Error).message.trim().split('\n').at(-1) ?? 'voice failed';
    }
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    if (status.error) return;
  }
}

function wavSeconds(file: string): number {
  const b = readFileSync(file);
  const bytesPerSecond = b.readUInt32LE(28);
  // the data chunk follows the header chunks
  let at = 12;
  while (at < b.length - 8) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'data') return size / bytesPerSecond;
    at += 8 + size;
  }
  return b.length / bytesPerSecond;
}
