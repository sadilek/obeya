// Makes a take into the demo: `demo.mp4` with its narration, the caption tracks, the chapters, the
// stills for review and the report page. The director calls it after a take, re-voicing
// (`revoice.ts`) on the frames a take left.
//
// Plain Node with type stripping, like the director.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { holdPidLock } from '../../../lib/process.ts';
import { languageName, preferredTrack } from './locale.ts';
import { type Clip, heardNotes, printHeard } from './narration.ts';
import type { NarrationLanguage } from './settings.ts';
import { narrationVtt, type Track, trackFile, trackLanguage, trackVtt, vttTime } from './subtitles.ts';
import { CLOCK, type Cut, type Frame, frameDurations, mmss } from './timeline.ts';

export interface Report {
  /**
   * What the change does, for someone who has not seen it, then what the owner needs to know beyond
   * the video (what it leaves out and why, what is open or unverified, a defect in someone else's
   * change): a few short paragraphs, separated by a blank line.
   */
  summary: string;
  /**
   * A question only the director can answer — a trade-off, a wording choice, what to do about a
   * finding. Omitted when the only ask is the usual "release or give feedback".
   */
  question?: string;
  /** Provenance lines: commit, stack, data. */
  meta: Record<string, string>;
}

/** Silence after a scene's narration before the next one starts. */
export const GAP_SECONDS = 0.6;
/** A scene this much longer than its narration and gap has a stretch worth cutting (`Director.skip`). */
const SILENCE_WARN = 5;

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}):\n${r.stderr?.slice(-3000)}`);
  return r.stdout;
}

/**
 * One render per demo at a time: two renders of the same demo (one left running in the background)
 * write the same frames and, through the demo's `login`, reset each other's app.
 */
export function holdRenderLock(work: string) {
  const other = holdPidLock(path.join(work, 'render.pid'));
  if (other) throw new Error(`another render of this demo is running (pid ${other}); wait for it, or end it with \`kill ${other}\``);
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

/**
 * An ffconcat list of `frames`, their files named relative to `from` (where the old list was, or
 * absolute) and written for one in `to`: relative, with forward slashes, which ffmpeg reads on
 * every platform, a Windows drive path not always.
 */
export function frameListText(frames: Held[], from: string, to: string): string {
  const name = (f: string) => path.relative(to, path.resolve(from, f)).split(path.sep).join('/');
  const lines = ['ffconcat version 1.0'];
  for (const f of frames) {
    lines.push(`file '${name(f.file)}'`);
    if (f.seconds !== undefined) lines.push(`duration ${f.seconds.toFixed(4)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes an ffconcat list that holds each frame until the next one, from t0 to tEnd, less the cuts. */
export function frameList(frames: Frame[], t0: number, tEnd: number, cuts: Cut[], file: string) {
  const held = frameDurations(frames, t0, tEnd, cuts);
  if (!held.length) throw new Error(`none of the screencast's ${frames.length} frames falls into the take`);
  const dir = path.dirname(file);
  fs.writeFileSync(file, frameListText([...held, { file: held.at(-1)!.file }], dir, dir));
}

/**
 * A scene's place in the video: where it starts, where its narration does and ends, how long each
 * of its sentences stays and, where its clip was heard back, where each of their words starts.
 */
export interface Mark {
  title: string;
  start: number;
  speechStart: number;
  speechEnd: number;
  sentences: number[];
  words?: number[][];
}

/** What a take is made into: its frames (`list`, an ffconcat list), its clips and where each scene and clip sits. */
export interface Take {
  /** Where `demo.mp4`, the captions, chapters, stills and the report page go. */
  outDir: string;
  /** Where the narration track is mixed. */
  work: string;
  list: string;
  /** The narration's clips; none for a silent demo, which gets no audio track. */
  clips?: Clip[];
  marks: Mark[];
  /** The video's length, in seconds. */
  total: number;
  viewport: { width: number; height: number };
  /** Twice the pixels and gentle compression (`DemoSpec.sharp`). */
  sharp: boolean;
  title: string;
  /** The narration's captions: each scene's sentences. */
  narration: Track;
  /** The caption tracks the demo offers, in their order (none: no subtitles): per language, each scene's sentences. */
  tracks: Track[];
  report: Report;
  language: NarrationLanguage;
}

/**
 * Makes the take into `demo.mp4` with its narration (none for a silent demo), a caption file per
 * track and `captions.vtt` (the narration's, naming the tracks: `narrationVtt`), `chapters.vtt`, a
 * still from the middle and the end of each scene, the poster and the report page; prints the review table.
 */
export function assemble({ outDir, work, list, clips, marks, total, viewport, sharp, title, narration: spoken, tracks, report, language }: Take) {
  const scale = sharp ? 2 : 1;
  /** Where scene `i` ends: where the next starts, or the video does. */
  const sceneEnd = (i: number) => (i + 1 < marks.length ? marks[i + 1]!.start : total);
  // Narration track: every clip at its scene's offset, levelled once as a whole.
  const narration = path.join(work, 'narration.wav');
  if (clips) {
    const inputs = clips.flatMap((c) => ['-i', c.file]);
    const delays = clips.map((_, i) => {
      const ms = Math.round(marks[i]!.speechStart * 1000);
      return `[${i}:a]adelay=${ms}:all=1[a${i}]`;
    });
    const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5[out]`;
    run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...delays, mix].join(';'), '-map', '[out]', '-ar', '48000', narration]);
  }

  const video = path.join(outDir, 'demo.mp4');
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    ...(clips ? ['-i', narration] : []),
    // the clock strip, painted over from the pixels around it
    '-vf', `fps=30,scale=${viewport.width * scale}:${viewport.height * scale},delogo=x=${scale}:y=${(viewport.height - CLOCK.bottom - CLOCK.cell - 2) * scale}:w=${(CLOCK.bits * CLOCK.cell + 2) * scale}:h=${(CLOCK.cell + 4) * scale},format=yuv420p`,
    // Screen content: CRF 30 keeps text sharp at about 2.5 MB per minute; a public video (`sharp`)
    // gets CRF 18, where no compression shows on the page's flat colours and fine type.
    '-c:v', 'libx264', '-preset', 'slow', '-crf', sharp ? '18' : '30', '-tune', 'stillimage',
    ...(clips ? ['-c:a', 'aac', '-b:a', sharp ? '160k' : '96k', '-shortest'] : ['-an']),
    '-movflags', '+faststart',
    video,
  ]);

  // a track of an earlier render in a language no longer among them goes
  for (const f of fs.readdirSync(outDir)) if (trackLanguage(f) && !tracks.some((t) => trackFile(t.language) === f)) fs.rmSync(path.join(outDir, f));
  for (const t of tracks) fs.writeFileSync(path.join(outDir, trackFile(t.language)), trackVtt(t, marks, t.language === spoken.language));
  fs.writeFileSync(path.join(outDir, 'captions.vtt'), narrationVtt(spoken, marks, tracks.map((t) => t.language)));
  // The scenes as chapters, for a player outside Obeya (the hero video on obeya.si reads them).
  const chapters = ['WEBVTT', ''];
  marks.forEach((m, i) => chapters.push(`${vttTime(m.start)} --> ${vttTime(sceneEnd(i))}`, m.title, ''));
  fs.writeFileSync(path.join(outDir, 'chapters.vtt'), chapters.join('\n'));

  // One still per scene, taken just before it ends: what the agent checks against the narration.
  const reviewDir = path.join(outDir, 'review');
  fs.rmSync(reviewDir, { recursive: true, force: true });
  fs.mkdirSync(reviewDir);
  const still = (at: number, name: string) =>
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', path.join(reviewDir, `${name}.jpg`)]);
  marks.forEach((m, i) => {
    const end = sceneEnd(i);
    const nn = String(i + 1).padStart(2, '0');
    still((m.start + end) / 2, `${nn}-mid`);
    still(Math.max(m.start, end - 0.4), nn);
  });
  fs.copyFileSync(path.join(reviewDir, '01.jpg'), path.join(outDir, 'poster.jpg'));

  fs.writeFileSync(path.join(outDir, 'index.html'), reportPage(title, report, marks, language, tracks.map((t) => t.language), !clips));
  console.log(`\n${Math.round(total)} s video → ${path.join(outDir, 'index.html')}`);
  console.log('\nreview:');
  const heard = heardNotes(clips ?? []);
  marks.forEach((m, i) => {
    const end = sceneEnd(i);
    const silent = end - m.speechEnd - GAP_SECONDS;
    const idle = silent > SILENCE_WARN ? `  ← ${Math.round(silent)} s without narration: cut it with d.skip where it only waits` : '';
    console.log(`  ${String(i + 1).padStart(2)}  ${mmss(m.start)}  ${m.title.padEnd(32).slice(0, 32)}${idle}`.trimEnd());
    for (const line of heard.stumbled[i] ?? []) console.log(`               ${line}`);
  });
  printHeard(heard);
  console.log(`stills → ${reviewDir}: NN-mid.jpg (middle of each scene), NN.jpg (its end)`);
}

/** The paragraphs of a report's summary, separated by a blank line. */
export const paragraphs = (summary: string) => summary.split(/\n\s*\n/).filter((p) => p.trim());

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** The report page's own words, in the narration language. */
const PAGE_WORDS: Record<NarrationLanguage, { question: string }> = {
  de: { question: 'Offene Frage' },
  en: { question: 'Open question' },
};

/**
 * The report page. Its caption tracks (`tracks`, in the settings' order; none: no subtitles) are
 * named in its language; a silent video shows one from the start: in the viewer's language where
 * there is a track in it, else the first.
 */
export function reportPage(title: string, r: Report, marks: { title: string; start: number }[], language: NarrationLanguage, tracks: string[] = [], silentVideo = false) {
  const w = PAGE_WORDS[language];
  const summary = paragraphs(r.summary)
    .map((p) => p.trim())
    .map((p) => `<p class="summary">${esc(p)}</p>`)
    .join('\n');
  const chapters = marks
    .map((m) => `<li><button data-t="${m.start.toFixed(2)}"><span class="t">${mmss(m.start)}</span>${esc(m.title)}</button></li>`)
    .join('');
  // a demo script is not type-checked: `meta` given as one line stays one line
  const rows: [string, string][] = typeof r.meta === 'string' ? [['', r.meta]] : Object.entries(r.meta);
  const meta = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg:#f7f6f3; --card:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e4e1da; --accent:#f5a524; --accent-ink:#1c1b19; --warn-bg:#fff6e5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161513; --card:#201f1c; --ink:#eeebe5; --muted:#a19d95; --line:#34322e; --warn-bg:#2e2616; } }
:root[data-theme="dark"] { --bg:#161513; --card:#201f1c; --ink:#eeebe5; --muted:#a19d95; --line:#34322e; --warn-bg:#2e2616; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width:1180px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:28px; line-height:1.2; margin:0 0 8px; letter-spacing:-.01em; }
.summary { font-size:18px; color:var(--ink); max-width:70ch; margin:0 0 12px; }
.player { margin-top:24px; display:grid; grid-template-columns: minmax(0,1fr) 280px; gap:16px; align-items:start; }
video { width:100%; border-radius:12px; background:#000; display:block; box-shadow:0 10px 30px rgba(0,0,0,.12); }
.chapters { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px; margin:0; list-style:none; }
.chapters button { all:unset; cursor:pointer; display:flex; gap:10px; width:100%; padding:8px 10px; border-radius:8px; font-size:14px; }
.chapters button:hover, .chapters button.on { background:var(--bg); }
.chapters .t { color:var(--muted); font-variant-numeric:tabular-nums; min-width:34px; }
.decision { margin:28px 0; padding:16px 20px; border-radius:12px; background:var(--warn-bg); border:1px solid var(--accent); }
.decision h2 { margin:0 0 4px; font-size:15px; text-transform:uppercase; letter-spacing:.06em; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; font-size:13px; color:var(--muted); margin:28px 0 0; }
dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; }
@media (max-width: 860px) { .player { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${summary}
<div class="player">
  <video id="v" controls preload="metadata" poster="poster.jpg">
    <source src="demo.mp4" type="video/mp4">
    ${tracks.map((l, i) => `<track kind="captions" src="${esc(trackFile(l))}" srclang="${esc(l)}" label="${esc(languageName(l, language))}"${silentVideo && i === 0 ? ' default' : ''}>`).join('\n    ')}
  </video>
  <ol class="chapters">${chapters}</ol>
</div>
${r.question ? `<div class="decision"><h2>${w.question}</h2>${esc(r.question)}</div>` : ''}
<dl>${meta}</dl>
</main>
<script>
const v = document.getElementById('v');
${silentVideo ? `// silent: the captions in the viewer's language where there is a track in it
const pick = (${preferredTrack.toString()})(${JSON.stringify(tracks)}, navigator.languages);
for (const t of v.textTracks) t.mode = t.language === pick ? 'showing' : 'disabled';
` : ''}
const buttons = [...document.querySelectorAll('.chapters button')];
buttons.forEach(b => b.onclick = () => { v.currentTime = +b.dataset.t; v.play(); });
v.ontimeupdate = () => {
  let cur = buttons[0];
  for (const b of buttons) if (+b.dataset.t <= v.currentTime + 0.05) cur = b;
  buttons.forEach(b => b.classList.toggle('on', b === cur));
};
</script>
</body>
</html>
`;
}
