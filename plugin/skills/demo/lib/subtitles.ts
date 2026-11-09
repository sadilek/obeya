// A demo's captions: its narration a cue per sentence, a track in the narration's language and in
// each further one of the demo settings (`subtitleLanguages`), every track with the same cue times.
// `captions.vtt` holds the narration's cues as well: where in the video it says what (`placeIn` of
// the server reads it there), and which tracks the demo offers, in order, in its first line (`narrationVtt`). With a voice,
// each sentence's cue starts with its first word as the clip was heard back (`spokenTimes`), and the
// narration's own track marks each word's start in its cue (a WebVTT timestamp, `<00:00:03.120>word`),
// which the player's pointer follows; a clip not heard back is shared out over its sentences by
// their length, without word times. Without a voice (`none`), each sentence stays as long as it
// takes to read in the language that takes longest.
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
import { heardStarts, wordsOf } from './word-times.ts';

/**
 * How long a sentence of a silent demo stays: characters a second (a wide character, as in
 * Chinese or Japanese, counting twice), and the least it stays however short. Subtitle guides ask
 * for 15 to 17 characters a second; the lower end, since the viewer also watches the screen.
 */
export const READING = { charsPerSecond: 15, minSeconds: 2 };

/** Words a period follows without ending the sentence (lower case, without their last period). */
const ABBREVIATIONS = new Set(['bzw', 'usw', 'etc', 'ca', 'vgl', 'nr', 'dr', 'vs', 'e.g', 'i.e', 'mr', 'mrs', 'ms', 'st', 'inkl', 'ggf', 'evtl', 'sog', 'approx', 'resp', 'z.b', 'd.h', 'u.a']);

/** German words an ordinal follows (lower case): „am 1. November“, „die 3. Option“, „zum 2. Mal“. */
const BEFORE_ORDINAL = new Set(['am', 'an', 'im', 'in', 'vom', 'zum', 'zur', 'bis', 'ab', 'seit', 'nach', 'vor', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'jeder', 'jede', 'jedes', 'jeden', 'jedem']);

/** German months (lower case): a number before one is a day, an ordinal, whatever comes before it („Freitag, 1. November“). */
const MONTHS = new Set(['januar', 'jänner', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember']);

/**
 * The sentences of a narration in `language` as captions show them (`untagged`): split after a
 * full stop, question or exclamation mark, or an ellipsis, followed by a space and not by a
 * lower-case letter. A period after a single letter or a common abbreviation ends no sentence, nor,
 * in German, one after a number that an article or preposition comes before or a month follows: an
 * ordinal („am 1. November“, „Freitag, 1. November“). Elsewhere a number ends its sentence („There
 * are 3. Then save.“).
 */
export function sentencesOf(say: string, language = 'en'): string[] {
  const german = /^de(-|$)/i.test(language);
  const text = untagged(say);
  const out: string[] = [];
  let from = 0;
  for (const m of text.matchAll(/[.!?…]+["'»«“”‘’)\]]*(?=\s|$)/g)) {
    const end = m.index + m[0].length;
    const next = text.slice(end).trimStart()[0];
    if (next !== undefined) {
      const [before = '', word = ''] = (/(?:([^\s("'„“«»]+)\s+)?([^\s("'„“«»]+)$/.exec(text.slice(from, m.index)) ?? []).slice(1).map((w) => (w ?? '').toLowerCase());
      const month = /^\p{L}+/u.exec(text.slice(end).trimStart())?.[0].toLowerCase() ?? '';
      const ordinal = german && /^\d+$/.test(word) && (BEFORE_ORDINAL.has(before) || MONTHS.has(month));
      const abbreviation = m[0] === '.' && (/^\p{L}$/u.test(word) || ordinal || ABBREVIATIONS.has(word));
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

/**
 * How long each sentence of a scene's clip of `seconds` stays, and where each of its words starts,
 * in seconds of the clip: from what was heard of the clip (`timed`, in pieces with the second each
 * starts at), lined up letter by letter with the sentences (`heardStarts`), so each sentence's cue
 * starts with its first word and lasts until the next one's; the first from the clip's start, the
 * last to its end. A clip not heard back is shared out by length (`sharedOut`), without word times.
 */
export function spokenTimes(seconds: number, sentences: string[], timed?: [string, number][]): { sentences: number[]; words?: number[][] } {
  if (!timed?.length || !sentences.length) return { sentences: sharedOut(seconds, sentences) };
  const starts = heardStarts(sentences.join(' '), timed, seconds);
  let k = 0;
  const words = sentences.map((s) => {
    const n = wordsOf(s).length;
    k += n;
    return starts.slice(k - n, k).map((t) => Math.min(seconds, t));
  });
  const from = words.map((w, i) => (i === 0 ? 0 : (w[0] ?? 0)));
  return { sentences: from.map((t, i) => Math.max(0, (from[i + 1] ?? seconds) - t)), words };
}

/** A caption track: its language and, per scene, its sentences, one cue each. */
export interface Track {
  language: string;
  scenes: string[][];
}

/**
 * Where a scene's narration starts in the video, how long each of its sentences stays, and where
 * each of their words starts, in seconds from the narration's start, where the clip was heard back.
 */
export interface Timed {
  speechStart: number;
  sentences: number[];
  words?: number[][];
}

export function vttTime(s: number) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
}

/**
 * A track as WebVTT: each sentence of each scene one after the other from its scene's narration on.
 * `spoken`: the track is the narration's own, whose words start where the scene's `words` say: each
 * word after a cue's first gets its start as a timestamp before it, later than the one before and
 * within the cue, as WebVTT asks.
 */
export function trackVtt(track: Track, scenes: Timed[], spoken = false): string {
  const vtt = ['WEBVTT', ''];
  scenes.forEach((scene, i) => {
    let at = scene.speechStart;
    (track.scenes[i] ?? []).forEach((text, j) => {
      const seconds = scene.sentences[j] ?? 0;
      const words = wordsOf(text);
      const starts = spoken ? scene.words?.[j] : undefined;
      let said = text;
      if (starts?.length === words.length && seconds > 0.001 * words.length) {
        let last = at;
        said = words
          .map((w, k) => {
            if (k === 0) return w;
            // a millisecond kept for each word after it, so the ones heard at the very end stay apart too
            last = Math.min(at + seconds - 0.001 * (words.length - k), Math.max(last + 0.001, scene.speechStart + starts[k]!));
            return `<${vttTime(last)}>${w}`;
          })
          .join(' ');
      }
      vtt.push(`${vttTime(at)} --> ${vttTime(at + seconds)}`, said, '');
      at += seconds;
    });
  });
  return vtt.join('\n');
}

/** A cue's text without its tags: the words as they read, the timestamps of the words left out. */
export const cueText = (text: string) => text.replace(/<[^>]*>/g, '');

/** The file of a track's captions. */
export const trackFile = (language: string) => `captions.${language}.vtt`;

/** The first line of a `captions.vtt` that names the demo's tracks: WebVTT lets text follow its signature. */
const LISTED = /^\uFEFF?WEBVTT[ \t]+-[ \t]+subtitles:[ \t]*([^\r\n]*)/;

/**
 * The narration's captions as `captions.vtt` holds them: `trackVtt` with the words' times, whose first line names the
 * languages of the demo's tracks in their order (`WEBVTT - subtitles: de fr`), or `none`.
 */
export function narrationVtt(narration: Track, scenes: Timed[], tracks: string[]): string {
  return trackVtt(narration, scenes, true).replace(/^WEBVTT/, `WEBVTT - subtitles: ${tracks.length ? tracks.join(' ') : 'none'}`);
}

/** The languages of a demo's tracks, in order, as its `captions.vtt` names them; undefined for one from before, which names none and is its only track. */
export function listedTracks(captions: string): string[] | undefined {
  const listed = LISTED.exec(captions)?.[1]?.trim();
  if (listed === undefined) return undefined;
  return listed === 'none' ? [] : listed.split(/\s+/).filter(Boolean);
}

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

/** The narration's own captions: its sentences, scene by scene. */
export const narrationTrack = (source: SubtitleSource): Track => ({ language: source.language, scenes: source.scenes.map((s) => s.sentences) });

/**
 * The caption tracks of a render, one per language of `languages` in their order: the narration's
 * from `source`, each other from its translation in
 * `work/subtitles/<language>.json`. Where one is missing, or was made for a narration that has
 * changed since (it is set aside as `<language>.stale.json`), the brief that asks the agent for it
 * instead. A translation that does not keep the sentences one to one fails the render.
 */
export function subtitleTracks(work: string, source: SubtitleSource, languages: string[]): { tracks: Track[] } | { brief: string } {
  const narration = narrationTrack(source);
  const others = languages.filter((l) => l !== source.language);
  const ordered = (translated: Track[]) => languages.flatMap((l) => (l === source.language ? [narration] : translated.filter((t) => t.language === l)));
  if (!others.length) return { tracks: ordered([]) };
  const here = path.join(work, 'subtitles');
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
  const tracks: Track[] = [];
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
  return missing.length ? { brief: subtitleBrief(here, source.language, missing, stale) } : { tracks: ordered(tracks) };
}

/** What the agent is asked to translate for the subtitles, and how. */
function subtitleBrief(here: string, narration: string, missing: string[], stale: string[]) {
  const name = (l: string) => `${languageName(l, 'en')} (${l})`;
  return [
    `This demo's subtitles come in ${missing.map(name).join(', ')}, and it is narrated in ${name(narration)}. Translate the sentences of`,
    `  ${path.join(here, 'source.json')}`,
    'into each and write them to',
    ...missing.map((l) => `  ${path.join(here, `${l}.json`)}`),
    'as {"scenes": [{"sentences": ["…", …]}, …]}: the scenes in order, each sentence translated on its own and as many as the source has, since each is a caption shown at the same time in every language. Then run this again.',
    '- Write them as subtitles read: plainly, without the audio tags and respellings the narration may have had.',
    '- The screen keeps its language: quote a label as it appears on screen, with its meaning after it in parentheses: „Teilen“ (Share).',
    ...(stale.length ? [`- The narration changed since ${stale.map((l) => `${l}.json`).join(', ')} was written: it is set aside as ${stale.map((l) => `${l}.stale.json`).join(', ')}; keep what still fits.`] : []),
  ].join('\n');
}
