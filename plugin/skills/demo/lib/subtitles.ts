// A demo's captions: its narration a cue per sentence, in the narration language and in each
// language the demo settings add (`subtitles`), every track with the same cue times. With a voice,
// a scene's clip is shared out over its sentences by their length; without one (voice `none`), each
// sentence stays as long as it takes to read in the language that takes longest.
//
// The translations come from the agent rendering the demo, the way re-voicing gets its own
// (`revoice.ts`): a render writes the sentences to `.work/subtitles/source.json` and, while a
// language lacks its translation beside it, stops before recording (exit 2) and says where each
// goes. A translation keeps the sentences one to one, or it is refused: that is what lets every
// track share the cue times.
//
// Plain Node with type stripping, like the director.

import fs from 'node:fs';
import path from 'node:path';
import { languageName } from './locale.ts';
import { untagged } from './timeline.ts';

/**
 * How long a sentence of a silent demo stays: characters a second (a wide character, as in
 * Chinese or Japanese, counting twice), and the least it stays however short. Subtitle guides ask
 * for 15 to 17 characters a second; the lower end, since the viewer also watches the screen.
 */
export const READING = { charsPerSecond: 15, minSeconds: 2 };

/** Words a period follows without ending the sentence (lower case, without their last period). */
const ABBREVIATIONS = new Set(['bzw', 'usw', 'etc', 'ca', 'vgl', 'nr', 'dr', 'vs', 'e.g', 'i.e', 'mr', 'mrs', 'ms', 'st', 'inkl', 'ggf', 'evtl', 'sog', 'approx', 'resp', 'z.b', 'd.h', 'u.a']);

/**
 * The sentences of a narration as captions show them (`untagged`): split after a full stop,
 * question or exclamation mark, or an ellipsis, followed by a space and not by a lower-case letter.
 * A period after a single letter, a number (a German ordinal: „am 1. November“) or a common
 * abbreviation ends no sentence.
 */
export function sentencesOf(say: string): string[] {
  const text = untagged(say);
  const out: string[] = [];
  let from = 0;
  for (const m of text.matchAll(/[.!?…]+["'»«“”‘’)\]]*(?=\s|$)/g)) {
    const end = m.index + m[0].length;
    const next = text.slice(end).trimStart()[0];
    if (next !== undefined) {
      const word = (/([^\s("'„“«»]+)$/.exec(text.slice(from, m.index))?.[1] ?? '').toLowerCase();
      const abbreviation = m[0] === '.' && (/^\p{L}$/u.test(word) || /^\d+$/.test(word) || ABBREVIATIONS.has(word));
      if (abbreviation || /\p{Ll}/u.test(next)) continue;
    }
    out.push(text.slice(from, end).trim());
    from = end;
  }
  const rest = text.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** How long a sentence of a silent demo stays to be read (`READING`). */
export function readingSeconds(sentence: string): number {
  const chars = [...sentence].length + (sentence.match(WIDE)?.length ?? 0);
  return Math.max(READING.minSeconds, chars / READING.charsPerSecond);
}

/** A silent scene's sentences, each as long as it takes to read in the slowest of the languages (`each`: the scene's sentences in one language, all as many). */
export function readingTimes(each: string[][]): number[] {
  return (each[0] ?? []).map((_, i) => Math.max(...each.map((sentences) => readingSeconds(sentences[i] ?? ''))));
}

/** A clip of `seconds` shared out over the sentences it speaks, by their length: the voice speaks evenly enough for that. */
export function sharedOut(seconds: number, sentences: string[]): number[] {
  const total = sentences.reduce((n, s) => n + s.length, 0);
  return sentences.map((s) => (total ? (seconds * s.length) / total : 0));
}

/** A caption track: its language and, per scene, its sentences, one cue each. */
export interface Track {
  language: string;
  scenes: string[][];
}

/** Where a scene's narration starts in the video, and how long each of its sentences stays. */
export interface Timed {
  speechStart: number;
  sentences: number[];
}

export function vttTime(s: number) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
}

/** A track as WebVTT: each sentence of each scene one after the other from its scene's narration on. */
export function trackVtt(track: Track, scenes: Timed[]): string {
  const vtt = ['WEBVTT', ''];
  scenes.forEach((scene, i) => {
    let at = scene.speechStart;
    (track.scenes[i] ?? []).forEach((text, j) => {
      const seconds = scene.sentences[j] ?? 0;
      vtt.push(`${vttTime(at)} --> ${vttTime(at + seconds)}`, text, '');
      at += seconds;
    });
  });
  return vtt.join('\n');
}

/** The file of a track's captions. `captions.vtt` holds the narration's as well, for players that know one track only. */
export const trackFile = (language: string) => `captions.${language}.vtt`;

/** What a render translates: per scene, its chapter title (for context) and its sentences. */
export interface SubtitleSource {
  language: string;
  scenes: { title: string; sentences: string[] }[];
}

/** What is wrong with a translation of `source`; empty when nothing is. */
export function subtitleProblems(source: SubtitleSource, t: unknown): string[] {
  const scenes = (t as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes) || scenes.length !== source.scenes.length) return [`scenes: ${source.scenes.length} expected, ${Array.isArray(scenes) ? scenes.length : 0} given`];
  const problems: string[] = [];
  scenes.forEach((s, i) => {
    const want = source.scenes[i]!.sentences.length;
    const sentences = (s as { sentences?: unknown } | null)?.sentences;
    if (!Array.isArray(sentences) || sentences.length !== want)
      problems.push(`scene ${i + 1}: ${want} sentences expected, ${Array.isArray(sentences) ? sentences.length : 0} given (one per sentence of the source, so every language shares its cue times)`);
    else if (sentences.some((x) => typeof x !== 'string' || !x.trim())) problems.push(`scene ${i + 1}: a sentence is empty`);
  });
  return problems;
}

const read = (f: string) => fs.readFileSync(f, 'utf8');
const sameSentences = (a: SubtitleSource, b: SubtitleSource) => JSON.stringify(a.scenes.map((s) => s.sentences)) === JSON.stringify(b.scenes.map((s) => s.sentences));

/**
 * The caption tracks of a render, the narration's (`source`) first, then one for each further
 * language of `languages` from its translation in `work/subtitles/<language>.json`. Where one is
 * missing, or was made for a narration that has changed since (it is set aside as
 * `<language>.stale.json`), the brief that asks the agent for it instead. A translation that does
 * not keep the sentences one to one fails the render.
 */
export function subtitleTracks(work: string, source: SubtitleSource, languages: string[]): { tracks: Track[] } | { brief: string } {
  const narration: Track = { language: source.language, scenes: source.scenes.map((s) => s.sentences) };
  const others = languages.filter((l) => l !== source.language);
  if (!others.length) return { tracks: [narration] };
  const here = path.join(work, 'subtitles');
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
  const tracks = [narration];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const language of others) {
    const file = path.join(here, `${language}.json`);
    // the narration the translation was asked for (or accepted for)
    const from = path.join(here, `${language}.from.json`);
    const asked = fs.existsSync(from) ? (JSON.parse(read(from)) as SubtitleSource) : undefined;
    if (fs.existsSync(file) && asked && !sameSentences(asked, source)) {
      fs.renameSync(file, path.join(here, `${language}.stale.json`));
      stale.push(language);
    }
    if (!fs.existsSync(file)) {
      fs.writeFileSync(from, `${JSON.stringify(source, null, 2)}\n`);
      missing.push(language);
      continue;
    }
    let t: unknown;
    try {
      t = JSON.parse(read(file));
    } catch (error) {
      throw new Error(`${file} is no JSON: ${(error as Error).message}`);
    }
    const problems = subtitleProblems(source, t);
    if (problems.length) throw new Error(`${file} is no translation of ${path.join(here, 'source.json')} yet:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    if (!asked) fs.writeFileSync(from, `${JSON.stringify(source, null, 2)}\n`);
    tracks.push({ language, scenes: (t as { scenes: { sentences: string[] }[] }).scenes.map((s) => s.sentences.map((x) => x.trim())) });
  }
  return missing.length ? { brief: subtitleBrief(here, source.language, missing, stale) } : { tracks };
}

/** What the agent is asked to translate for the subtitles, and how. */
function subtitleBrief(here: string, narration: string, missing: string[], stale: string[]) {
  const name = (l: string) => `${languageName(l, 'en')} (${l})`;
  return [
    `This demo's subtitles come in ${missing.map(name).join(', ')} besides ${name(narration)}. Translate the sentences of`,
    `  ${path.join(here, 'source.json')}`,
    'into each and write them to',
    ...missing.map((l) => `  ${path.join(here, `${l}.json`)}`),
    'as {"scenes": [{"sentences": ["…", …]}, …]}: the scenes in order, each sentence translated on its own and as many as the source has, since each is a caption shown at the same time in every language. Then run this again.',
    '- Write them as subtitles read: plainly, without the audio tags and respellings the narration may have had.',
    '- The screen keeps its language: quote a label as it appears on screen, with its meaning after it in parentheses: „Teilen“ (Share).',
    ...(stale.length ? [`- The narration changed since ${stale.map((l) => `${l}.json`).join(', ')} was written: it is set aside as ${stale.map((l) => `${l}.stale.json`).join(', ')}; keep what still fits.`] : []),
  ].join('\n');
}
