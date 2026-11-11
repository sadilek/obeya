// A card's demo: the directory the `demo` skill rendered into, or an HTML artifact the worker
// made instead. Here the plugin that brings the skill, the check of what a worker hands over, the
// chapters of a video and what its narration says at a place; what the directory holds is read in
// demo-files.ts, and served in serve-files.ts.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chapterAt } from '../core/types';
import { resource } from './resources';
import { oneLine } from '../core/text';
import { type Cue, cuesOf } from '../../plugin/skills/demo/lib/subtitles.ts';

/**
 * The plugin Obeya loads into its workers' sessions: it brings the demo skill (`obeya:demo`), the
 * pipeline that records a demo. A Claude Code session without Obeya reaches the same skill through
 * the plugin or a user skill that points to `plugin/skills/demo`.
 */
export const OBEYA_PLUGIN = resource('plugin');
export const DEMO_SKILL = 'obeya:demo';

/** The demo skill's instructions, for a session that does not know the skill to read. */
export const DEMO_SKILL_FILE = join(OBEYA_PLUGIN, 'skills', 'demo', 'SKILL.md');

/** What is wrong with the plugin workers load, for the log at start; null when nothing is. */
export function checkPlugin(dir = OBEYA_PLUGIN): string | null {
  for (const f of [join('.claude-plugin', 'plugin.json'), join('skills', 'demo', 'SKILL.md')])
    if (!existsSync(join(dir, f))) return `${join(dir, f)} is missing: workers' sessions have no demo skill`;
  return null;
}

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/**
 * The name of the demo skill in a worker's session on this machine. Claude Code lists a skill file
 * once: a user skill that links to the plugin's (`~/.claude/skills/demo` pointing to
 * `plugin/skills/demo`, as a session without Obeya reaches the skill) is listed under its own name
 * instead, and the session knows no `obeya:demo`.
 */
export function demoSkillName(skills = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills'), file = DEMO_SKILL_FILE): string {
  if (!existsSync(skills)) return DEMO_SKILL;
  const names = readdirSync(skills);
  // what is known while the directory holds the same skills: following each one's links took
  // seconds on a busy Windows machine with many of them, at every worker's start
  const key = [skills, file, statSync(skills).mtimeMs, ...names].join('\0');
  if (skillNamed?.key === key) return skillNamed.name;
  const own = realpath(file);
  const name = (own && names.find((name) => realpath(join(skills, name, 'SKILL.md')) === own)) || DEMO_SKILL;
  skillNamed = { key, name };
  return name;
}
let skillNamed: { key: string; name: string } | undefined;

/** The page of an HTML artifact; the files beside it (images, styles) are served too. */
export const ARTIFACT_PAGE = 'index.html';

/** What is wrong with an HTML artifact's directory, for the worker to fix; null when nothing is. */
export function checkArtifact(dir: string): string | null {
  return existsSync(join(dir, ARTIFACT_PAGE)) ? null : `${ARTIFACT_PAGE} is missing in ${dir}`;
}

/** The skill starts narration this long after its scene; a chapter starts at the scene. */
const NARRATION_LEAD = 0.35;

/**
 * Chapter marks for the scene titles, from `chapters.vtt` (one cue per scene, in order), or from
 * the captions of a demo without one, rendered when they had one cue per scene. Returns what is
 * wrong with the directory instead, for the worker to fix.
 */
export function readChapters(dir: string, titles: string[]): [number, string][] | string {
  for (const f of ['demo.mp4', 'captions.vtt']) if (!existsSync(join(dir, f))) return `${f} is missing in ${dir}`;
  const scenes = cues(dir, 'chapters.vtt').map((c) => c.start);
  if (scenes.length) {
    if (scenes.length !== titles.length) return `chapters.vtt has ${scenes.length} scenes but ${titles.length} chapter titles were given`;
    return titles.map((t, i) => [Math.max(0, Math.round(scenes[i]! * 100) / 100), t]);
  }
  const starts = cues(dir).map((c) => c.start);
  if (starts.length !== titles.length) return `captions.vtt has ${starts.length} cues but ${titles.length} chapter titles were given`;
  return titles.map((t, i) => [Math.max(0, Math.round((starts[i]! - NARRATION_LEAD) * 100) / 100), t]);
}

/**
 * The chapter marks of a video demo made anew in its directory (re-voiced, say), titles and all,
 * from its `chapters.vtt` (one cue per scene, its title). Returns what is wrong instead.
 */
export function rereadChapters(dir: string): [number, string][] | string {
  if (!existsSync(join(dir, 'chapters.vtt'))) return `chapters.vtt is missing in ${dir}`;
  return readChapters(dir, cues(dir, 'chapters.vtt').map((c) => c.text));
}

/** The cues of a demo's captions (one per sentence of its narration; per scene before 2026-11), or of another WebVTT file of it, each on one line. */
function cues(dir: string, file = 'captions.vtt'): Cue[] {
  let vtt: string;
  try {
    vtt = readFileSync(join(dir, file), 'utf8');
  } catch {
    return [];
  }
  return cuesOf(vtt).map((c) => ({ ...c, text: oneLine(c.text) }));
}

/**
 * The chapter at a place in a demo video and what its narration says around there: the sentence of
 * the scene's cue that the place falls on, by its share of the cue's time (the voice speaks evenly
 * enough for that); between cues, the last one's last sentence.
 */
export function placeIn(dir: string, chapters: [number, string][], at: number): { chapter?: string; narration?: string } {
  const chapter = chapters[chapterAt(chapters, at)]?.[1];
  const cue = cues(dir).findLast((c) => c.start <= at + 0.05);
  let narration: string | undefined;
  if (cue) {
    const sentences = cue.text.match(/[^.!?…]+(?:[.!?…]+[»«“”"']?|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [cue.text];
    const share = at >= cue.end ? 1 : (at - cue.start) / Math.max(0.1, cue.end - cue.start);
    const offset = Math.min(cue.text.length - 1, Math.max(0, share * cue.text.length));
    let passed = 0;
    narration = sentences.find((x) => (passed += x.length + 1) > offset) ?? sentences.at(-1);
  }
  return { ...(chapter ? { chapter } : {}), ...(narration ? { narration } : {}) };
}
