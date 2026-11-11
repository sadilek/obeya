// The narration of a demo: the scenes' texts spoken, one clip each, in the voice the demo settings
// name (`tts.py` does the speaking), and what a voice that hears its clips back heard of them.
//
// Plain Node with type stripping, like the director.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DemoSettings } from './settings.ts';
import { ttsArgs, voiceSpec } from './voices.ts';

export interface Clip {
  id: string;
  file: string;
  seconds: number;
  /**
   * What a voice that hears its clips back (Qwen3) heard, a line per sentence: `stumbled` where
   * every take differed from the script by a stretch, `misheard` the words heard as others.
   */
  heard?: { script: string; heard: string | null; stumbled?: true; misheard?: [string, string][] }[];
  /** Why such a voice heard nothing of the clip. */
  unheard?: string;
  /** What was heard of the clip in pieces (parts of words), each with the second it starts at: the captions' times. */
  timed?: [string, number][];
}

/**
 * What the review table says of what was heard: per scene, each sentence that stumbled in every
 * take; once per word heard as another, how it was heard and in which scenes; why nothing was
 * heard, if so.
 */
export function heardNotes(clips: Clip[]) {
  const stumbled = clips.map((c) =>
    (c.heard ?? []).filter((h) => h.stumbled).map((h) => `stumbled in every take, the best kept: "${h.script}" heard as "${h.heard}"`),
  );
  const words = new Map<string, { as: Set<string>; scenes: Set<number> }>();
  clips.forEach((c, i) =>
    c.heard?.forEach((h) =>
      h.misheard?.forEach(([word, as]) => {
        const seen = words.get(word) ?? { as: new Set(), scenes: new Set() };
        seen.as.add(as);
        seen.scenes.add(i + 1);
        words.set(word, seen);
      }),
    ),
  );
  const misheard = [...words].map(
    ([word, { as, scenes }]) => `"${word}" heard as ${[...as].map((a) => `"${a}"`).join(', ')} (scene ${[...scenes].join(', ')})`,
  );
  const unheard = clips.find((c) => c.unheard)?.unheard;
  return { stumbled, misheard, unheard };
}

/** The notes on what was heard that follow the review table, or the scene list of `--narration`. */
export function printHeard({ stumbled, misheard, unheard }: ReturnType<typeof heardNotes>) {
  if (stumbled.some((s) => s.length)) console.log('stumbled in every take: reword the sentence or respell the word it stumbles over, then render the narration again (--narration)');
  if (misheard.length) console.log(`heard differently (a word the voice cannot read goes into lib/lexicon.qwen3.<language>.json):\n${misheard.map((m) => `  ${m}`).join('\n')}`);
  if (unheard) console.log(`narration not heard back: ${unheard}`);
}

/** Keeps the scenes' narration in `dir` (`jobs.json`: that of the take whose frames lie beside it, which re-voicing reads); returns the file. */
export function writeJobs(says: string[], dir: string, name = 'jobs.json') {
  const jobsFile = path.join(dir, name);
  fs.writeFileSync(jobsFile, JSON.stringify(says.map((say, i) => ({ id: `s${i + 1}`, text: say }))));
  return jobsFile;
}

/** The scenes' narration (`says`), one clip each, in the voice and language of `settings`; cached in `dir` by voice and text. */
export function synthesize(says: string[], dir: string, settings: DemoSettings): Clip[] {
  // not `jobs.json`: the narration alone (`--narration`) records no take, and the frames kept are another's
  const jobsFile = writeJobs(says, dir, 'tts-jobs.json');
  const spec = voiceSpec(settings);
  const specFile = path.join(dir, 'voice.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  console.log(`narration: ${says.length} clips, voice ${settings.voice}, language ${settings.language}`);
  const args = [...ttsArgs(spec), specFile, settings.language, jobsFile, dir];
  // tts.py's progress (the voice loading, waiting for the lock) shows as it happens.
  const r = spawnSync('uv', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`tts.py failed (${r.error?.message ?? r.status}); its output is above`);
  return (JSON.parse(fs.readFileSync(path.join(dir, 'tts.json'), 'utf8')) as { clips: Clip[] }).clips;
}
