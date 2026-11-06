// Prototype: an answer told as a walkthrough. The answering agent writes slides and their
// narration into `<name>.walkthrough.json` in its thread's output directory and passes that file
// with its answer; Obeya reads the code slides' lines from the repository, writes a player page
// beside it (`<name>.html`, which shows under the answer in its frame), and voices the narration
// slide by slide in the voice of the demo settings, the first slide first, so the page can start
// playing while the rest is still being voiced.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AnswerFile } from '../core/types';
import { DEMO_SETTINGS_FILE, inLanguage, readDemoSettings, obeyaHome } from '../../plugin/skills/demo/lib/settings.ts';
import { speak } from '../../plugin/skills/demo/lib/voices.ts';

export const WALKTHROUGH_SUFFIX = '.walkthrough.json';

type Slide =
  | { type: 'title'; title: string; subtitle?: string; narration?: Narration }
  | { type: 'points'; title: string; points: string[]; narration: Narration }
  | { type: 'flow'; title: string; steps: (string | { label: string; note?: string })[]; narration: Narration }
  | { type: 'code'; title: string; file: string; lines: [number, number]; focus?: [number, number][]; note?: string; narration: Narration; code?: string[] };
/** One text, or one part per item of the slide (point, step, focus), each shown as its part is spoken. */
type Narration = string | string[];

interface Walkthrough {
  title: string;
  language?: 'de' | 'en';
  slides: Slide[];
}

/** How the agent writes a walkthrough, as every look-up hears it. */
export const WALKTHROUGH_NOTE = `Walkthroughs: an answer that explains how something unfolds, step after step (a flow through the code, what happens one thing after the other, what a change does), comes as a short narrated walkthrough rather than a block of text or a numbered list: the owner follows the steps more easily when they are told, one slide at a time. Other answers stay text; you judge which kind a question is, and the owner can always ask for a walkthrough of a text answer. Write it as <name>${WALKTHROUGH_SUFFIX} in your output directory and pass that file with answer_owner (caption: what it walks through); Obeya voices the narration and plays slides and sound under your answer. Your answer's text then says in one or two sentences what the walkthrough shows. The file: {"title": "…", "slides": [ … ]}, 4 to 8 slides, each with "narration" in the owner's language: spoken prose, two to four sentences a slide, explaining rather than reading the slide out. Either one string, or a list of parts, one per item of the slide (point, step, focus range), each spoken while its item shows. Slide types:
- {"type": "title", "title", "subtitle"}: the first slide, what the walkthrough answers.
- {"type": "points", "title", "points": ["…"]}: up to five short points.
- {"type": "flow", "title", "steps": ["…" or {"label", "note"}]}: a simple diagram, three to six boxes in a row joined by arrows.
- {"type": "code", "title", "file": "<path in the repository>", "lines": [from, to], "focus": [[from, to], …], "note": "…"}: real lines of the repository (at most 30; Obeya reads them from the file, so give the exact line numbers you read), the focus ranges highlighted one after the other.`;

/** A walkthrough's frame, and the page beside it: the files the answer shows in their place. */
export function walkthroughs(files: AnswerFile[] | undefined, dir: string, checkout: string, language: 'de' | 'en'): AnswerFile[] | undefined {
  if (!files?.some((f) => f.name.endsWith(WALKTHROUGH_SUFFIX))) return files;
  return files.map((f) => {
    if (!f.name.endsWith(WALKTHROUGH_SUFFIX)) return f;
    try {
      return { name: render(dir, f.name, checkout, language), caption: f.caption };
    } catch (e) {
      console.error(`Obeya: walkthrough ${f.name}: ${(e as Error).message}`);
      return f;
    }
  });
}

function render(dir: string, name: string, checkout: string, fallback: 'de' | 'en'): string {
  const w = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Walkthrough;
  const language = w.language ?? fallback;
  for (const s of w.slides) {
    if (s.type !== 'code') continue;
    try {
      const all = readFileSync(join(checkout, s.file), 'utf8').split('\n');
      const [from, to] = [Math.max(1, s.lines[0]), Math.min(all.length, s.lines[1], s.lines[0] + 34)];
      s.lines = [from, to];
      s.code = all.slice(from - 1, to);
    } catch {
      s.code = [`(${s.file} not found)`];
    }
  }
  const base = name.slice(0, -WALKTHROUGH_SUFFIX.length);
  const clips = `${base}.clips`;
  mkdirSync(join(dir, clips), { recursive: true });
  // each slide's narration in parts, each part a clip of its own: the first sound waits for one sentence, not a slide
  const slides = w.slides.map((s) => ({ ...s, ...partsOf(s) }));
  const status: Status = { clips: slides.map((s) => s.parts.map(() => null)), started: Date.now(), firstSoundMs: null, error: null };
  writeFileSync(join(dir, clips, 'status.json'), JSON.stringify(status));
  const data = JSON.stringify({ ...w, slides, language, clips }).replace(/</g, '\\u003c');
  const page = readFileSync(join(import.meta.dir, 'walkthrough-player.html'), 'utf8').replace('/*WALKTHROUGH*/null', data);
  writeFileSync(join(dir, `${base}.walkthrough.html`), page);
  void voice(slides, join(dir, clips), language, status);
  return `${base}.walkthrough.html`;
}

type Status = { clips: ({ file: string; seconds: number } | null)[][]; started: number; firstSoundMs: number | null; error: string | null };

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

/** The narration clip by clip, in order, in the voice of the demo settings, each clip in its place once it is whole. */
async function voice(slides: { parts: string[] }[], dir: string, language: 'de' | 'en', status: Status) {
  const home = obeyaHome();
  // a scratch home without demo settings or voices of its own speaks with the machine's
  const settingsHome = existsSync(join(home, DEMO_SETTINGS_FILE)) ? home : join(homedir(), '.obeya');
  const voicesHome = existsSync(join(home, 'voices')) ? home : join(homedir(), '.obeya');
  const s = inLanguage(readDemoSettings(settingsHome), language);
  const write = () => writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  for (const [i, slide] of slides.entries())
    for (const [j, text] of slide.parts.entries()) {
      const file = `${i + 1}-${j + 1}.wav`;
      const part = `${i + 1}-${j + 1}.part.wav`;
      try {
        await speak(s, text, join(dir, part), voicesHome, process.env.OBEYA_WALKTHROUGH_VOICE_URL);
        renameSync(join(dir, part), join(dir, file));
        status.clips[i]![j] = { file, seconds: wavSeconds(join(dir, file)) };
        if (status.firstSoundMs === null) {
          status.firstSoundMs = Date.now() - status.started;
          console.log(`Obeya: walkthrough ${dir}: first sound ready after ${(status.firstSoundMs / 1000).toFixed(1)} s`);
        }
      } catch (e) {
        status.error = (e as Error).message.trim().split('\n').at(-1) ?? 'voice failed';
        write();
        return;
      }
      write();
    }
  console.log(`Obeya: walkthrough ${dir}: all ${slides.length} slides voiced after ${((Date.now() - status.started) / 1000).toFixed(1)} s`);
}

function wavSeconds(file: string): number {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(24);
  const bytesPerSecond = b.readUInt32LE(28);
  // the data chunk follows the header chunks
  let at = 12;
  while (at < b.length - 8) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'data') return size / bytesPerSecond;
    at += 8 + size;
  }
  return b.length / (bytesPerSecond || rate * 2);
}
