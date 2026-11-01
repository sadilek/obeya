// Re-voices a rendered demo in another language: the same picture, the narration, chapter titles
// and report page translated and spoken anew. Works on any demo that kept its frames (`.work/`
// with `frames/` and `frames.txt`), whichever version of the director recorded it: it reads what
// the render left in the directory, not the demo script.
//
// `node revoice.ts <demo dir> <language>`, or `node demo.ts --revoice <language>` in the demo's
// directory. The first run writes the words to translate (`.work/revoice/source.json`) and says
// where the translation goes; the agent running the skill translates them, and the next run
// synthesises the clips in that language's voice, stretches each scene's narrated stretch to the
// new clip's length, so what happened on a word still happens on it, and rebuilds `demo.mp4`,
// the captions, `chapters.vtt`, the stills, the poster and `index.html` in place. The demo as
// recorded stays in `.work/revoice/original/`, which every later run reads from. The demo keeps
// the caption tracks it had, on the new clips' times: a track in the new narration's language takes
// its sentences, every other keeps its own, a cue per sentence as well. A silent demo (no voice) can
// be voiced this way too.
//
// Plain Node with type stripping, like the director.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assemble, type Clip, holdRenderLock, type Mark, type Report, synthesize } from './director.ts';
import { isMain } from './here.ts';
import { LANGUAGE_NAMES, LANGUAGES, type Language } from './locale.ts';
import { inLanguage, readDemoSettings, silent, withVoice } from './settings.ts';
import { checkSetup, describeSetup } from './setup.ts';
import { listedTracks, sentencesOf, sharedOut, type Track, trackFile } from './subtitles.ts';

/** What a demo says, in one language: what is translated. */
export interface Words {
  /** The report page's title. */
  title: string;
  /** Per scene, in order: its chapter title and its narration, audio tags and all. */
  scenes: { title: string; say: string }[];
  report: Report;
}

/** A cue of a WebVTT file: from, to (seconds) and its text. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** The files of a render that re-voicing replaces, beside a caption file per track; the recorded ones are kept in `original/`. */
const RENDERED = ['demo.mp4', 'captions.vtt', 'chapters.vtt', 'index.html', 'poster.jpg'] as const;
/** A caption track's file, and its language. */
const TRACK_FILE = /^captions\.([^.]+)\.vtt$/;
/** A scene whose narration gets this much longer or shorter changes pace visibly: worth a look at its stills. */
const PACE_WARN = 0.35;

export function cuesOf(vtt: string): Cue[] {
  const time = (h: string, m: string, s: string, ms: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  return vtt
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const c = /^(\d+):(\d{2}):(\d{2})\.(\d{3}) --> (\d+):(\d{2}):(\d{2})\.(\d{3})[^\n]*\n([\s\S]*)$/m.exec(block.trim());
      return c ? [{ start: time(c[1]!, c[2]!, c[3]!, c[4]!), end: time(c[5]!, c[6]!, c[7]!, c[8]!), text: c[9]!.trim() }] : [];
    });
}

/** An entry of an ffconcat list: a frame and how long it is held (the last one: none). */
export interface Held {
  file: string;
  seconds?: number;
}

export function framesOf(list: string): Held[] {
  const out: Held[] = [];
  for (const line of list.split('\n')) {
    const file = /^file '(.*)'$/.exec(line.trim());
    if (file) out.push({ file: file[1]! });
    const d = /^duration ([\d.]+)$/.exec(line.trim());
    if (d && out.length) out[out.length - 1]!.seconds = Number(d[1]);
  }
  return out;
}

/** A stretch of the video played `ratio` times as long. */
export interface Stretch {
  from: number;
  to: number;
  ratio: number;
}

/** Where a moment of the video lands once each stretch (none overlapping) plays `ratio` times as long. */
export function stretched(stretches: Stretch[]): (t: number) => number {
  const sorted = [...stretches].sort((a, b) => a.from - b.from);
  return (t) => {
    let shift = 0;
    for (const s of sorted) {
      if (t <= s.from) break;
      shift += (Math.min(t, s.to) - s.from) * (s.ratio - 1);
    }
    return t + shift;
  };
}

/** The frames held as long as `at` (old video time → new) makes them: a frame across a stretch's edge takes a share of both. */
export function retimed(frames: Held[], at: (t: number) => number): Held[] {
  let t = 0;
  return frames.map((f) => {
    if (f.seconds === undefined) return f;
    const seconds = at(t + f.seconds) - at(t);
    t += f.seconds;
    return { ...f, seconds };
  });
}

/** An ffconcat list of `frames`, their files named relative to `from` (where the old list was) and written for one in `to`. */
export function frameListText(frames: Held[], from: string, to: string): string {
  const name = (f: string) => path.relative(to, path.resolve(from, f)).split(path.sep).join('/');
  const lines = ['ffconcat version 1.0'];
  for (const f of frames) {
    lines.push(`file '${name(f.file)}'`);
    if (f.seconds !== undefined) lines.push(`duration ${f.seconds.toFixed(4)}`);
  }
  return `${lines.join('\n')}\n`;
}

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

/** The paragraphs of a report's summary, separated by a blank line. */
const paragraphs = (summary: string) => summary.split(/\n\s*\n/).filter((p) => p.trim());

/**
 * The report page the director wrote (`index.html`): its language, title and report. A page of a
 * director before 2026-10-19 also has lists of what was shown, not shown and noticed, which are
 * left out, as a render leaves them out now.
 */
export function reportOf(html: string): { language?: Language; title: string; report: Report } {
  const one = (re: RegExp) => unesc(re.exec(html)?.[1] ?? '');
  const lang = /<html\b[^>]*\blang="([a-z]{2})"/.exec(html)?.[1];
  const summary = [...html.matchAll(/<p class="summary">([\s\S]*?)<\/p>/g)].map((m) => unesc(m[1]!));
  if (!summary.length) throw new Error('index.html is no report page of the director: it has no summary');
  const entries = [...(/<dl>([\s\S]*?)<\/dl>/.exec(html)?.[1] ?? '').matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [unesc(m[1]!), m[2]!] as const);
  // a demo whose `meta` was one line rather than an object got a row per character
  const spelt = entries.length > 1 && entries.every(([k], i) => k === String(i));
  const meta = spelt ? { '': unesc(entries.map(([, v]) => v).join('')) } : Object.fromEntries(entries.map(([k, v]) => [k, unesc(v)]));
  const question = one(/<div class="decision"><h2>[^<]*<\/h2>([\s\S]*?)<\/div>/);
  return {
    ...(LANGUAGES.find((l) => l === lang) ? { language: lang as Language } : {}),
    title: one(/<h1>([\s\S]*?)<\/h1>/),
    report: { summary: summary.join('\n\n'), ...(question ? { question } : {}), meta },
  };
}

/** The audio tags of a narration, in order (`[short pause]`): a translation keeps them where they stand. */
const tagsOf = (say: string) => [...say.matchAll(/\[[^\]]*\]/g)].map((m) => m[0].toLowerCase());

/** What is wrong with a translation of `source`; empty when nothing is. */
export function translationProblems(source: Words, t: Partial<Words>): string[] {
  const problems: string[] = [];
  if (!t.title?.trim()) problems.push('title is empty');
  if (!Array.isArray(t.scenes) || t.scenes.length !== source.scenes.length) return [...problems, `scenes: ${source.scenes.length} expected, ${t.scenes?.length ?? 0} given`];
  t.scenes.forEach((s, i) => {
    if (!s?.title?.trim()) problems.push(`scene ${i + 1}: title is empty`);
    if (!s?.say?.trim()) problems.push(`scene ${i + 1}: say is empty`);
    else if (tagsOf(s.say).join(' ') !== tagsOf(source.scenes[i]!.say).join(' '))
      problems.push(`scene ${i + 1}: the audio tags differ from the source's (${tagsOf(source.scenes[i]!.say).join(' ') || 'none'})`);
    else if (sentencesOf(s.say).length !== sentencesOf(source.scenes[i]!.say).length)
      problems.push(`scene ${i + 1}: ${sentencesOf(source.scenes[i]!.say).length} sentences expected, ${sentencesOf(s.say).length} given (one per sentence of the source: each is a caption, shown at the same time as in the other languages)`);
  });
  const r = t.report;
  if (!r?.summary?.trim()) problems.push('report.summary is empty');
  else if (paragraphs(r.summary).length !== paragraphs(source.report.summary).length)
    problems.push(`report.summary: ${paragraphs(source.report.summary).length} paragraphs expected, separated by a blank line`);
  if (!!source.report.question !== !!r?.question?.trim()) problems.push(source.report.question ? 'report.question is missing' : 'report.question is not in the source');
  if (!r?.meta || Object.keys(r.meta).length !== Object.keys(source.report.meta).length) problems.push(`report.meta: ${Object.keys(source.report.meta).length} entries expected`);
  return problems;
}

/** How the video was encoded: its size, and whether it is `sharp` (twice the pixels, CRF 18), which x264 notes in the file. */
function renderOf(video: string): { viewport: { width: number; height: number }; sharp: boolean } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  const [width, height] = (r.stdout ?? '').trim().split(',').map(Number);
  if (!width || !height) throw new Error(`cannot read the size of ${video}: ${r.stderr ?? r.error?.message}`);
  const head = fs.readFileSync(video).subarray(0, 1 << 20).toString('latin1');
  const sharp = /crf=18\.0/.test(head);
  return { viewport: sharp ? { width: width / 2, height: height / 2 } : { width, height }, sharp };
}

const read = (f: string) => fs.readFileSync(f, 'utf8');

/**
 * The caption cues of each scene, from `captions` (one per sentence of each scene's narration,
 * `says`), or, of a demo rendered before captions came a sentence at a time, one per scene.
 */
export function cuesByScene<T>(captions: T[], says: string[]): T[][] {
  const counts = says.map((s) => sentencesOf(s).length);
  if (captions.length === counts.reduce((a, b) => a + b, 0)) {
    let at = 0;
    return counts.map((n) => captions.slice(at, (at += n)));
  }
  if (captions.length === says.length) return captions.map((c) => [c]);
  throw new Error(`the render does not add up: ${captions.length} captions for ${says.length} scenes of ${counts.reduce((a, b) => a + b, 0)} sentences`);
}

/** Re-voices the demo in `dir` in `language` (see the header). */
export async function revoice(dir: string, language: string | undefined) {
  const to = LANGUAGES.find((l) => l === language);
  if (!to) throw new Error(`--revoice needs the language to re-voice in: ${LANGUAGES.join(' or ')}`);
  const work = path.join(dir, '.work');
  const list = path.join(work, 'frames.txt');
  if (!fs.existsSync(list) || !fs.existsSync(path.join(work, 'frames'))) throw new Error(`${dir} kept no frames (.work/frames.txt and .work/frames/): it cannot be re-voiced, only recorded again`);
  holdRenderLock(work);
  const here = path.join(work, 'revoice');
  const original = path.join(here, 'original');
  // what was kept of an earlier re-voicing holds while the frames are those it was made from; a render since replaced them
  const keptList = path.join(original, 'frames.txt');
  if (fs.existsSync(path.join(original, 'index.html')) && !fs.existsSync(keptList)) fs.copyFileSync(list, keptList);
  const kept = fs.existsSync(keptList) && read(keptList) === read(list);
  const page = reportOf(read(path.join(kept ? original : dir, 'index.html')));
  if (page.language === to) throw new Error(`${dir} is narrated in ${LANGUAGE_NAMES[to]} already`);
  if (!kept) {
    for (const f of RENDERED) if (f !== 'poster.jpg' && !fs.existsSync(path.join(dir, f))) throw new Error(`${f} is missing in ${dir}`);
    fs.rmSync(original, { recursive: true, force: true });
    fs.mkdirSync(original, { recursive: true });
    for (const f of [...RENDERED, ...fs.readdirSync(dir).filter((f) => TRACK_FILE.test(f))]) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(original, f));
    fs.copyFileSync(list, keptList);
  }
  const chapters = cuesOf(read(path.join(original, 'chapters.vtt')));
  const jobs = JSON.parse(read(path.join(work, 'jobs.json'))) as { text: string }[];
  if (chapters.length !== jobs.length) throw new Error(`the render does not add up: ${jobs.length} scenes in .work/jobs.json, ${chapters.length} chapters`);
  const says = jobs.map((j) => j.text);
  const sceneCues = cuesByScene(cuesOf(read(path.join(original, 'captions.vtt'))), says);
  // each scene's narrated stretch: from its first sentence's cue to its last's
  const captions = sceneCues.map((c, i) => (c.length ? { start: c[0]!.start, end: c.at(-1)!.end } : { start: chapters[i]!.start, end: chapters[i]!.start }));
  const source: Words = { title: page.title, scenes: jobs.map((j, i) => ({ title: chapters[i]!.text, say: j.text })), report: page.report };
  fs.writeFileSync(path.join(here, 'source.json'), `${JSON.stringify({ language: page.language, ...source }, null, 2)}\n`);

  const file = path.join(here, `${to}.json`);
  if (!fs.existsSync(file)) {
    console.log(translationBrief(dir, file, to));
    process.exitCode = 2;
    return;
  }
  const words = JSON.parse(read(file)) as Words;
  const problems = translationProblems(source, words);
  if (problems.length) throw new Error(`${file} is no translation of source.json yet:\n${problems.map((p) => `  ${p}`).join('\n')}`);

  const settings = withVoice(inLanguage(readDemoSettings(), to), process.env.DEMO_VOICE);
  if (silent(settings)) throw new Error('re-voicing needs a voice, and the demo settings name none (or DEMO_VOICE=none): name one with DEMO_VOICE');
  const setup = await checkSetup(settings, { narrationOnly: true });
  if (setup.items.some((i) => i.state === 'missing')) throw new Error(`cannot re-voice yet:\n${describeSetup(setup)}`);
  const clips: Clip[] = synthesize(words.scenes.map((s) => s.say), here, settings);

  // Each scene's narrated stretch takes as long as its new clip; lead, gaps, what follows the words and the cuts' flashes stay as recorded.
  const stretches = captions.map((c, i) => ({ from: c.start, to: c.end, ratio: clips[i]!.seconds / Math.max(0.1, c.end - c.start) }));
  const at = stretched(stretches);
  const frames = framesOf(read(list));
  const total = frames.reduce((t, f) => t + (f.seconds ?? 0), 0);
  const newList = path.join(here, 'frames.txt');
  fs.writeFileSync(newList, frameListText(retimed(frames, at), work, here));
  // the new narration's sentences share its clips; every track keeps a cue per sentence on the same times
  const narration: Track = { language: to, scenes: words.scenes.map((s) => sentencesOf(s.say)) };
  const marks: Mark[] = captions.map((c, i) => ({
    title: words.scenes[i]!.title,
    start: at(chapters[i]!.start),
    speechStart: at(c.start),
    speechEnd: at(c.start) + clips[i]!.seconds,
    sentences: sharedOut(clips[i]!.seconds, narration.scenes[i]!),
  }));
  const { viewport, sharp } = renderOf(path.join(original, 'demo.mp4'));
  assemble({ outDir: dir, work: here, list: newList, clips, marks, total: at(total), viewport, sharp, title: words.title, narration, tracks: keptTracks(original, page.language, says, narration), report: words.report, language: to });

  console.log(`\nre-voiced in ${LANGUAGE_NAMES[to]}; the narration per scene:`);
  stretches.forEach((s, i) => {
    const pace = Math.abs(s.ratio - 1) > PACE_WARN ? `  ← its picture runs ${s.ratio > 1 ? 'slower' : 'faster'}: check its stills` : '';
    console.log(`  ${String(i + 1).padStart(2)}  ${(s.to - s.from).toFixed(1).padStart(5)} s → ${clips[i]!.seconds.toFixed(1).padStart(5)} s (×${s.ratio.toFixed(2)})${pace}`);
  });
  console.log(`the demo as recorded: ${original}`);
}

/**
 * The caption tracks of the demo as recorded, in their order, re-voiced as `narration`: the one in
 * its language takes its sentences, that of the recorded narration (in `from`) the sentences of
 * `says`, each other the texts of its cues, scene by scene. A demo from before its `captions.vtt`
 * named its tracks had the narration's alone, and keeps that.
 */
export function keptTracks(original: string, from: string | undefined, says: string[], narration: Track): Track[] {
  const listed = listedTracks(read(path.join(original, 'captions.vtt')));
  if (!listed) return [narration];
  return listed.map((language) => {
    if (language === narration.language) return narration;
    if (language === from) return { language, scenes: says.map(sentencesOf) };
    return { language, scenes: cuesByScene(cuesOf(read(path.join(original, trackFile(language)))), says).map((cues) => cues.map((c) => c.text)) };
  });
}

/** What the agent is asked to translate, and how. */
function translationBrief(dir: string, file: string, to: Language) {
  const name = LANGUAGE_NAMES[to];
  return [
    `To re-voice this demo, translate ${path.join(path.dirname(file), 'source.json')} into ${name} and write it to`,
    `  ${file}`,
    'in the same shape and order, without "language". Then run this again.',
    `- say: written as it should sound in ${name}, in the same person; its audio tags ([short pause] …) stay where they stand, and it has as many sentences as the source's, each a caption.`,
    `- The screen keeps its language: quote a label as it appears on screen, with its meaning in ${name} after it: in a say as an aside („Teilen“, share, …), which the voice speaks more reliably than parentheses; elsewhere „Teilen“ (Share).`,
    `  ${path.join(dir, 'review')} holds a still from the middle and the end of each scene, to read the labels from.`,
    '- report and title: the report page; meta: its keys and values, branch names and commits as they are.',
  ].join('\n');
}

if (isMain(import.meta.filename)) {
  const [dir, language] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node revoice.ts <demo dir> <language>');
    process.exit(1);
  }
  await revoice(path.resolve(dir), language);
}
