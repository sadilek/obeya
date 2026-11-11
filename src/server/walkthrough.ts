// A looked-up answer told as a walkthrough, played while it is being written. The answering agent
// hands Obeya one slide at a time (`walkthrough_slide`), the title slide as soon as it knows what the
// walkthrough answers; Obeya reads a code slide's lines from the repository itself, keeps the
// walkthrough as a file of the thread's output directory (`<name>.walkthrough.json`) that the player
// under the question reads as it grows, and voices each slide's narration sentence by sentence in
// the voice of the demo settings for the language the title slide names, so the player starts with the first sentence while the agent still
// writes the slides after it. One voice speaks for every walkthrough of the server, a sentence at a
// time, in the queue it shares with the renders (narration.ts): what a playing player needs next
// goes first. Each sentence voiced is heard back with the speech recognition of voice in, for the
// times of its words, which the caption's pointer follows. Demo settings without a voice leave it
// unvoiced: the player shows each sentence as a caption for as long as reading it takes. What a
// server left unvoiced when it stopped, the next one voices once a player reads the walkthrough.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { LANGUAGES, type Language } from '../core/locale';
import type { AnswerFile } from '../core/types';
import { type Clip, estimatedStarts, heardStarts, itemsOf, type Slide, type SlideContent, type Walkthrough, WALKTHROUGH_SUFFIX } from '../core/walkthrough';
import { clip, messageOf } from '../core/text';
import { within } from '../core/late';
import type { AgentTool } from './runtime';
import { readsOut, tooFull } from './slide-checks';
import { sentencesOf } from '../../plugin/skills/demo/lib/subtitles.ts';

/** Slides a walkthrough has at most. */
export const MAX_SLIDES = 8;
/** How long hearing a sentence back may take: a cold start of the recognition loads its model, about 1 GB. */
export const HEAR_MS = 60_000;
/** Lines a code slide shows at most. */
export const MAX_CODE_LINES = 30;
/** The largest file a code slide is read from, and the longest line it shows. */
const MAX_CODE_FILE = 2_000_000;
const MAX_LINE = 400;

/** How every look-up agent hears when a walkthrough comes, and how it tells one. */
export const WALKTHROUGH_RULES = `
Walkthroughs: an answer that explains how something works or what happens when (a flow through the code, what happens one thing after the other, what a change does, how two variants differ) comes as a short narrated walkthrough rather than a block of text or a numbered list: the owner follows it more easily told one slide at a time. Other answers stay text; you judge which kind a question is, and the owner can always ask for a walkthrough of a text answer.
- Tell it with walkthrough_slide, one call per slide, in order. The owner sees and hears each slide as soon as you have handed it over, while you work on the next: hand over the title slide as soon as you know what the walkthrough answers, each further slide once you have checked what it says.
- 4 to ${MAX_SLIDES} slides: a title slide first, then points, flows and, only when the owner asks to see the code, code slides; otherwise the owner does not read code.
- Each slide's narration is in the owner's language, spoken prose of two to four sentences that explains rather than reads the slide out. The title slide names that language (language), and the voice speaks the walkthrough in it. Give it as one text, or on a slide whose items show one after the other (points, steps, focus ranges) as one part per item, each spoken while its item shows.
- Each slide has room for little: a point takes a line or two (about 60 characters a line); a flow's box holds a short word or two, about 17 characters a line with three steps, 11 with four and 8 with five. Obeya refuses a slide that does not fit or whose narration only reads it out, saying why: revise it and hand it over again.
- Then call answer_owner with a sentence or two on what the walkthrough shows: it comes with your answer by itself.
`.trim();

const narration = z.union([z.string(), z.array(z.string())]);
const SLIDE = z.discriminatedUnion('type', [
  z.object({ type: z.literal('title'), title: z.string(), subtitle: z.string().optional(), language: z.enum(LANGUAGES), narration: narration.optional() }),
  z.object({ type: z.literal('points'), title: z.string(), points: z.array(z.string()).min(1).max(5), narration }),
  z.object({ type: z.literal('flow'), title: z.string(), steps: z.array(z.union([z.string(), z.object({ label: z.string(), note: z.string().optional() })])).min(3).max(6), narration }),
  z.object({
    type: z.literal('code'),
    title: z.string(),
    file: z.string(),
    lines: z.tuple([z.number().int(), z.number().int()]),
    focus: z.array(z.tuple([z.number().int(), z.number().int()])).max(5).optional(),
    note: z.string().optional(),
    narration,
  }),
]);
type Given = z.infer<typeof SLIDE>;

export interface VoicingOptions {
  /** Speaks `text` in the voice of the demo settings for `language`, into the WAV `out`. */
  speak: (text: string, out: string, language: Language) => Promise<void>;
  /** Loads the voice before its first sentence, where it can stay loaded: the owner just asked for a walkthrough. */
  warm?: (language: Language) => void;
  /** The demo settings have no voice for `language`: its walkthroughs play as captions. */
  silent?: (language: Language) => boolean;
  /**
   * Hears a voiced sentence back: what was heard in pieces (words or parts of them), each with the
   * second it starts at. Without it, or where it fails, a sentence's words get starts by their length.
   */
  hear?: (wav: string, language: Language) => Promise<[string, number][]>;
  /** How long hearing a sentence may take before its words get starts by their length: the recognition may be loading. */
  hearMs?: number;
  /** How long a player's word on the slide it plays counts: it says so again while it plays. */
  playingMs?: number;
  log?: (line: string) => void;
}

interface Job {
  w: Told;
  slide: number;
  part: number;
}

/**
 * The voice of every walkthrough of the server: one sentence at a time, so a render's clips take
 * turns with them. A player that plays says which slide it is on (`played`); the next sentence is
 * the first one it still needs from there, else the first of the newest walkthrough (the one the
 * owner most likely waits for).
 */
export class Voicing {
  private jobs: Job[] = [];
  private busy = false;
  /** The walkthroughs a player plays, by their file: the slide it is on, and when it said so. */
  private playing = new Map<string, { slide: number; at: number }>();
  /** The walkthroughs being voiced or heard back, by their file, for the players' word. */
  private told = new Map<string, Told>();
  /** The sentences being heard back, per walkthrough. */
  private hearing = new Map<Told, number>();
  /** The walkthrough of the sentence the voice is speaking. */
  private speaking?: Told;

  constructor(private o: VoicingOptions) {}

  warm(language: Language) {
    if (this.o.silent?.(language)) return;
    try {
      this.o.warm?.(language);
    } catch (e) {
      this.o.log?.(`Obeya: the walkthrough voice did not load: ${messageOf(e)}`);
    }
  }

  /** A player plays slide `slide` (from 0) of the walkthrough in `file`; `-1`: it plays no longer. */
  played(file: string, slide: number) {
    if (slide < 0) this.playing.delete(file);
    else this.playing.set(file, { slide, at: Date.now() });
  }

  /** Whether sentences of the walkthrough in `file` still wait for the voice, or to be heard back. */
  voicing(file: string) {
    return this.told.has(file);
  }

  /** The sentences of a slide just handed over, to voice. */
  add(w: Told, slide: number) {
    // its voice failed: the rest would fail the same way
    if (w.data.error) return;
    // no voice: none for the rest either, so it does not fall silent halfway
    if (w.data.silent || this.o.silent?.(w.language)) return w.silence();
    this.told.set(w.file, w);
    for (const part of w.data.slides[slide]!.parts.keys()) this.jobs.push({ w, slide, part });
    void this.work();
  }

  /**
   * A walkthrough the server before this one left with sentences unvoiced: voiced on from where it
   * stopped, as it is now. Its agent's turn ended with that server, so it has every slide it gets.
   */
  resume(file: string, data: Walkthrough): Walkthrough {
    const w = Told.again(file, { ...data, done: true, language: data.language ?? writtenIn(data.slides.flatMap((s) => s.parts).join(' ')) ?? 'en' });
    // sentences voiced but not heard back by that server: their words start by their length
    for (const [k, c] of w.data.clips.entries()) for (const [p, x] of c.entries()) if (x && !x.words) w.timed(k, p, estimatedStarts(w.data.slides[k]!.parts[p] ?? '', x.seconds));
    w.finish();
    if (this.o.silent?.(w.language)) w.silence();
    else {
      this.told.set(file, w);
      for (const [slide, c] of w.data.clips.entries()) for (const [part, x] of c.entries()) if (!x) this.jobs.push({ w, slide, part });
      this.o.log?.(`Obeya: voicing on the walkthrough ${file}, left unvoiced by the server before`);
      void this.work();
    }
    return w.data;
  }

  private async work() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.next(); job; job = this.next()) {
        this.speaking = job.w;
        await this.voice(job).finally(() => (this.speaking = undefined));
        this.settle(job.w);
      }
    } finally {
      this.busy = false;
    }
  }

  private next(): Job | undefined {
    if (!this.jobs.length) return;
    const now = Date.now();
    const heard = this.jobs.filter((j) => {
      const p = this.playing.get(j.w.file);
      return p && now - p.at < (this.o.playingMs ?? 3000) && j.slide >= p.slide;
    });
    const from = heard.length ? heard : this.jobs;
    const newest = from.reduce((a, b) => (b.w.started > a.w.started ? b : a)).w;
    const first = from.filter((j) => j.w === newest).reduce((a, b) => (b.slide < a.slide || (b.slide === a.slide && b.part < a.part) ? b : a));
    this.jobs.splice(this.jobs.indexOf(first), 1);
    return first;
  }

  private async voice({ w, slide, part }: Job) {
    const file = `${slide + 1}-${part + 1}.wav`;
    const out = join(w.clipsPath, file);
    try {
      await this.o.speak(w.data.slides[slide]!.parts[part]!, `${out}.part.wav`, w.language);
      renameSync(`${out}.part.wav`, out);
      const seconds = wavSeconds(out);
      w.voiced(slide, part, { file, seconds });
      void this.listen(w, slide, part, out, seconds);
    } catch (e) {
      // the rest of it would fail the same way
      this.jobs = this.jobs.filter((j) => j.w !== w);
      w.failed(messageOf(e).trim().split('\n').at(-1) || 'the voice failed');
      this.o.log?.(`Obeya: voicing the walkthrough ${w.file} failed: ${messageOf(e)}`);
    }
  }

  /** Hears a sentence back for the times of its words, while the voice goes on with the next. */
  private async listen(w: Told, slide: number, part: number, wav: string, seconds: number) {
    this.hearing.set(w, (this.hearing.get(w) ?? 0) + 1);
    const sentence = w.data.slides[slide]!.parts[part]!;
    let words = estimatedStarts(sentence, seconds);
    if (this.o.hear) {
      try {
        const heard = await within(this.o.hear(wav, w.language), this.o.hearMs ?? HEAR_MS);
        if (heard?.length) words = heardStarts(sentence, heard, seconds);
        else if (!heard) this.o.log?.(`Obeya: hearing a sentence of the walkthrough ${w.file} back took too long; its words start by their length`);
      } catch (e) {
        this.o.log?.(`Obeya: hearing a sentence of the walkthrough ${w.file} back failed: ${messageOf(e)}`);
      }
    }
    w.timed(slide, part, words);
    this.hearing.set(w, this.hearing.get(w)! - 1);
    this.settle(w);
  }

  /** Done with a walkthrough once nothing of it waits for the voice or to be heard back. */
  private settle(w: Told) {
    if (this.speaking === w || this.jobs.some((j) => j.w === w) || this.hearing.get(w)) return;
    this.hearing.delete(w);
    this.told.delete(w.file);
    this.playing.delete(w.file);
  }
}

/** One walkthrough as it is told: its file, written anew with every slide and every clip. */
export class Told {
  readonly started = Date.now();
  readonly clipsPath: string;

  private constructor(
    /** Its file, absolute. */
    readonly file: string,
    readonly data: Walkthrough & { language: Language },
  ) {
    this.clipsPath = join(file, '..', data.clipsDir);
  }

  /**
   * A walkthrough begun, in a file of its own. `language`: the one its narration is voiced in, a
   * guess until the title slide names it (`prepareWalkthrough`).
   */
  static begin(file: string, language: Language, title: string): Told {
    const clipsDir = `${file.slice(file.lastIndexOf(sep) + 1, -WALKTHROUGH_SUFFIX.length)}.clips`;
    const w = new Told(file, { title, slides: [], done: false, clips: [], clipsDir, language });
    // a directory of its own, made here: one that is there already is not the server's
    mkdirSync(w.clipsPath);
    w.write();
    return w;
  }

  /** A walkthrough a server before this one began, as its file has it. */
  static again(file: string, data: Walkthrough & { language: Language }): Told {
    return new Told(file, data);
  }

  /** The language its narration is voiced in. */
  get language(): Language {
    return this.data.language;
  }

  /** Its title and language, once the title slide gives them (a walkthrough shown before its first slide has none yet). */
  titled(title: string, language: Language) {
    this.data.title = title;
    this.data.language = language;
  }

  push(slide: Slide) {
    this.data.slides.push(slide);
    this.data.clips.push(slide.parts.map(() => null));
    this.write();
  }

  voiced(slide: number, part: number, clip: Clip) {
    this.data.clips[slide]![part] = clip;
    this.write();
  }

  /** The second each word of a sentence voiced starts at. */
  timed(slide: number, part: number, words: number[]) {
    const c = this.data.clips[slide]![part];
    if (!c) return;
    c.words = words;
    this.write();
  }

  failed(why: string) {
    this.data.error = why;
    this.write();
  }

  /** The demo settings have no voice: it plays as captions. */
  silence() {
    if (this.data.silent) return;
    this.data.silent = true;
    this.write();
  }

  finish() {
    this.data.done = true;
    this.write();
  }

  /** Whole or not at all: the player reads it while it is written. */
  private write() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/**
 * The walkthrough of one answer: the tool its agent hands the slides over with, and the file the
 * answer comes with. `onShown`: its first slide is there, its player to show under the question
 * while the agent goes on.
 */
export class AnswerWalkthrough {
  private told?: Told;

  constructor(
    private o: {
      /** The thread's output directory. */
      dir: string;
      /** The repository a code slide's lines are read from. */
      checkout: string;
      voicing: Voicing;
      onShown?: (files: AnswerFile[]) => void;
      /** The walkthrough the owner asked for, shown before its first slide (`prepareWalkthrough`). */
      prepared?: Told;
    },
  ) {
    this.told = o.prepared;
  }

  tool(): AgentTool {
    return {
      name: 'walkthrough_slide',
      description: `Hands the next slide of your walkthrough to Obeya, which shows it to the owner at once and voices its narration (see Walkthroughs in your instructions). The first slide is the title slide. Kinds: title (title, subtitle, language: the language every narration of the walkthrough is in, which the voice speaks); points (title, up to five short points); flow (title, three to six steps in a row joined by arrows, each a label or {label, note}); code (title, file: its path in the repository, lines: [from, to] as you read them, at most ${MAX_CODE_LINES}, which Obeya reads from the file itself; focus: ranges within them highlighted one after the other; note). narration: one text, or one part per point, step or focus range.`,
      schema: { slide: SLIDE },
      run: ({ slide }) => this.add(slide),
    };
  }

  /** The answer's file, once the walkthrough has its first slide. */
  files(): AnswerFile[] {
    const t = this.told;
    return t?.data.slides.length ? [{ name: t.file.slice(this.o.dir.length + 1), caption: t.data.title }] : [];
  }

  /** The turn is over: the walkthrough has all the slides it gets. */
  finish() {
    this.told?.finish();
  }

  private add(input: unknown): string {
    const parsed = SLIDE.safeParse(input);
    if (!parsed.success) return `Not shown: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'slide'}: ${i.message}`).join('; ')}.`;
    const given = parsed.data;
    const begun = !!this.told?.data.slides.length;
    if (!begun && given.type !== 'title') return 'Not shown: a walkthrough begins with its title slide.';
    if (begun && given.type === 'title') return 'Not shown: an answer has one walkthrough, and it has its title slide already.';
    if (begun && this.told!.data.slides.length >= MAX_SLIDES) return `Not shown: a walkthrough has at most ${MAX_SLIDES} slides. Call answer_owner now.`;
    const language = given.type === 'title' ? given.language : this.told!.language;
    const slide = this.slideOf(given, language);
    if (typeof slide === 'string') return `Not shown: ${slide}`;
    const told = this.told ?? (this.told = Told.begin(walkthroughFile(this.o.dir, given.title), language, given.title.trim()));
    if (!begun) told.titled(given.title.trim(), language);
    told.push(slide);
    const n = told.data.slides.length;
    if (n === 1) this.o.onShown?.(this.files());
    this.o.voicing.add(told, n - 1);
    return `Slide ${n} is shown and being voiced. Hand over the next slide, or, once the walkthrough is complete, call answer_owner with a sentence or two on what it shows: the walkthrough is the answer.`;
  }

  /** A slide as the player plays it, or what is wrong with it. */
  private slideOf(given: Given, language: Language): Slide | string {
    let content: SlideContent;
    if (given.type === 'title') content = { type: 'title', title: given.title.trim(), ...(given.subtitle?.trim() ? { subtitle: given.subtitle.trim() } : {}) };
    else if (given.type === 'points') content = { type: 'points', title: given.title, points: given.points };
    else if (given.type === 'flow') content = { type: 'flow', title: given.title, steps: given.steps.map((s) => (typeof s === 'string' ? { label: s } : s)) };
    else {
      const code = this.codeOf(given.file, given.lines, given.focus ?? []);
      if (typeof code === 'string') return code;
      content = { type: 'code', title: given.title, file: given.file, lines: given.lines, focus: given.focus ?? [], ...(given.note ? { note: given.note } : {}), code };
    }
    const parts = this.partsOf(content, given.narration, language);
    if (typeof parts === 'string') return parts;
    const wrong = tooFull(content) ?? readsOut(content, [given.narration ?? ''].flat());
    return wrong ?? { ...content, ...parts };
  }

  /**
   * A slide's narration as the sentences it is voiced in, and for a narration in parts the item each
   * sentence shows with. A title slide says its title first: a short sentence, voiced quickly, so the
   * first sound comes soon.
   */
  private partsOf(s: SlideContent, given: string | string[] | undefined, language: Language): { parts: string[]; items?: number[] } | string {
    const sentences = (text: string) => sentencesOf(text.trim(), language).filter(Boolean);
    const items = itemsOf(s);
    if (Array.isArray(given) && given.length > 1 && s.type !== 'title') {
      if (given.length !== items) return `its narration has ${given.length} parts for ${items} ${s.type === 'code' ? 'focus ranges' : s.type === 'flow' ? 'steps' : 'points'}: give one part per item, or one text.`;
      const split = given.map(sentences);
      if (split.some((p) => !p.length)) return 'a part of its narration is empty.';
      return { parts: split.flat(), items: split.flatMap((p, k) => p.map(() => k)) };
    }
    const said = sentences([given ?? ''].flat().join(' '));
    if (s.type !== 'title') return said.length ? { parts: said } : 'its narration is missing.';
    const bare = (x: string) => x.replace(/[\s.!?:;,]+$/, '');
    return { parts: said[0] && bare(said[0]) === bare(s.title) ? said : [`${bare(s.title)}.`, ...said] };
  }

  /** The lines of a code slide as the repository has them, or what is wrong with them. */
  private codeOf(path: string, [from, to]: [number, number], focus: [number, number][]): string[] | string {
    let file: string;
    try {
      const root = realpathSync(this.o.checkout);
      file = realpathSync(resolve(root, path));
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) return `${path} is no file of the repository.`;
    } catch {
      return `${path} is no file of the repository.`;
    }
    if (to - from + 1 > MAX_CODE_LINES) return `a code slide shows at most ${MAX_CODE_LINES} lines, not ${to - from + 1}.`;
    if (statSync(file).size > MAX_CODE_FILE) return `${path} is too large for a code slide.`;
    const lines = readFileSync(file, 'utf8').split('\n').map((l) => clip(l.replace(/\r$/, ''), MAX_LINE));
    if (lines.at(-1) === '') lines.pop();
    if (from < 1 || to < from || to > lines.length) return `${path} has lines 1 to ${lines.length}; lines ${from} to ${to} are not among them.`;
    const outside = focus.find(([a, b]) => a < from || b > to || b < a);
    if (outside) return `the focus ${outside[0]}–${outside[1]} is not within lines ${from}–${to}.`;
    return lines.slice(from - 1, to);
  }

}

/**
 * A file of its own in the thread's directory, named after its title: earlier answers keep theirs.
 */
export function walkthroughFile(dir: string, title: string): string {
  mkdirSync(dir, { recursive: true });
  const base =
    title
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'walkthrough';
  // neither it nor its clips' directory there yet, so nothing of the agent's stands in for them (a link elsewhere)
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const file = join(dir, `${name}${WALKTHROUGH_SUFFIX}`);
    if (!existsSync(file) && !lexists(join(dir, `${name}.clips`)) && !lexists(file)) return file;
  }
}


/**
 * "Show as walkthrough": the walkthrough the owner asked for, shown at once and empty until its
 * agent hands over the title slide, named after the question it answers. `language`: the one its
 * narration will most likely be in, until the title slide says.
 */
export const prepareWalkthrough = (dir: string, question: string, language: Language) => Told.begin(walkthroughFile(dir, question), language, '');

/** Words frequent in prose of one language and rare in the other's. */
const COMMON: Record<Language, Set<string>> = {
  de: new Set('der die das und ist nicht ein eine einen dem den des mit auf für sich auch wird werden wenn dann noch nur oder aber wie bei zu im zum zur von sie es er ich du wir'.split(' ')),
  en: new Set('the and is not a of to with on for it its this that be are when then only or but how at from by they you we what which'.split(' ')),
};

/**
 * The language a text of some sentences is written in, as far as its most common words tell (an
 * answer a walkthrough is to tell, so the voice for it can load before the title slide names it);
 * `undefined` where they tell none.
 */
export function writtenIn(text: string): Language | undefined {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const hits = LANGUAGES.map((l) => words.filter((w) => COMMON[l].has(w)).length);
  const best = Math.max(...hits);
  return best && hits.filter((h) => h === best).length === 1 ? LANGUAGES[hits.indexOf(best)] : undefined;
}

/** Whether `clipsDir` is the directory Obeya made beside the walkthrough `name` for its clips. */
const ownClips = (dir: string, name: string, clipsDir: string) => {
  if (clipsDir !== `${name.slice(0, -WALKTHROUGH_SUFFIX.length)}.clips`) return false;
  try {
    return lstatSync(join(dir, clipsDir)).isDirectory();
  } catch {
    return false;
  }
};

const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** How long a WAV plays: its data chunk over its byte rate. */
export function wavSeconds(file: string): number {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(28);
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'data') return Math.min(size, b.length - at - 8) / rate;
    at += 8 + size + (size % 2);
  }
  return 0;
}

/** The walkthrough file's shape, as far as the player relies on it. */
const KEPT = z.object({
  title: z.string(),
  slides: z.array(
    z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('title'), title: z.string(), subtitle: z.string().optional() }),
        z.object({ type: z.literal('points'), title: z.string(), points: z.array(z.string()) }),
        z.object({ type: z.literal('flow'), title: z.string(), steps: z.array(z.object({ label: z.string(), note: z.string().optional() })) }),
        z.object({
          type: z.literal('code'),
          title: z.string(),
          file: z.string(),
          lines: z.tuple([z.number(), z.number()]),
          focus: z.array(z.tuple([z.number(), z.number()])),
          note: z.string().optional(),
          code: z.array(z.string()),
        }),
      ])
      .and(z.object({ parts: z.array(z.string()), items: z.array(z.number()).optional() })),
  ),
  done: z.boolean(),
  clips: z.array(z.array(z.object({ file: z.string(), seconds: z.number(), words: z.array(z.number()).optional() }).nullable())),
  clipsDir: z.string(),
  error: z.string().optional(),
  language: z.enum(LANGUAGES).optional(),
  silent: z.boolean().optional(),
});

/**
 * A walkthrough of the thread's directory `dir` as the player reads it; `undefined` for a name
 * that is none. `playing`: the slide its player is on (`-1`: it does not play), for the voice.
 */
export function readWalkthrough(dir: string, name: string, voicing: Voicing | undefined, playing?: number): Walkthrough | undefined {
  if (!name.endsWith(WALKTHROUGH_SUFFIX) || name.includes('/') || name.includes('\\') || name.startsWith('.')) return;
  const file = join(dir, name);
  if (playing !== undefined && Number.isInteger(playing)) voicing?.played(file, playing);
  try {
    // a link in the directory leads nowhere outside it
    if (realpathSync(file) !== join(realpathSync(dir), name) || !statSync(file).isFile()) return;
    const read = KEPT.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    // a file of that name that is no walkthrough as Obeya writes them
    if (!read.success) return;
    const w = read.data as Walkthrough;
    if (voicing && !voicing.voicing(file)) {
      // sentences whose voice stopped with the server that voiced them: this one voices them now
      // (into the clips' directory Obeya made for it, never one the file names elsewhere)
      if (!w.error && !w.silent && w.clips.some((c) => c.some((x) => !x)) && ownClips(dir, name, w.clipsDir)) return voicing.resume(file, w);
      // sentences not heard back by the server that voiced them: their words start by their length
      for (const [k, c] of w.clips.entries()) for (const [p, x] of c.entries()) if (x && !x.words) x.words = estimatedStarts(w.slides[k]!.parts[p] ?? '', x.seconds);
    }
    return w;
  } catch {
    return;
  }
}
