// The skills a card's agent can be asked for by `/name` in the owner's words, as Claude Code lists
// them for a session in that repository: the repository's own, the user's, those of the plugins the
// session loads, and the skills Claude Code brings. Claude Code tells without a session doing any work
// (no message, no tokens): a process starts, answers, and ends.

import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Skill } from '../core/types';
import { Kept } from '../core/kept';
import { withTimeout } from '../core/late';
import { idleClaude } from './claude';
import { messageOf } from '../core/text';

/** Where an agent works, as far as its skills go. */
export interface SkillPlace {
  cwd: string;
  /** Local plugins the agent's sessions load. */
  plugins: string[];
  /** The repository's Claude Code settings wait for the owner's trust: the session reads none of its files, its skills neither. */
  untrusted: boolean;
}

/** Lists the skills of a session at `place`. */
export type SkillLister = (place: SkillPlace) => Promise<Skill[]>;

/** How long a list stays as it was asked; after that it is asked again, and the old one serves meanwhile. */
const FRESH_MS = 2 * 60_000;
/** A Claude Code that does not answer within this has no skills to offer. */
const ANSWER_MS = 20_000;

/**
 * The commands Claude Code lists that the owner may name: those of the repository, the user and
 * plugins, and of its own those that are skills (`/code-review`); not its controls of the session
 * (`/compact`, `/model`), which Obeya runs itself. Each name once, sorted.
 */
export function skillsOf(commands: SlashCommand[], skillNames: Set<string>): Skill[] {
  const byName = new Map<string, { skill: Skill; rank: number }>();
  for (const c of commands) {
    if ((c.builtin && !skillNames.has(c.name)) || byName.has(c.name)) continue;
    const skill = { name: c.name, description: firstLine(c.description), ...(c.argumentHint?.trim() ? { hint: c.argumentHint.trim() } : {}) };
    byName.set(c.name, { skill, rank: rank(c) });
  }
  return [...byName.values()].sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name)).map((s) => s.skill);
}

/**
 * Where a skill comes from, in the order the menu lists them: the repository's first, then the
 * user's, those of plugins, and Claude Code's own last. Claude Code marks the first two at the end of
 * the description.
 */
function rank(c: SlashCommand): number {
  const description = c.description.trim();
  if (description.endsWith('(project)')) return 0;
  if (description.endsWith('(user)')) return 1;
  return c.builtin ? 3 : 2;
}

/** What the menu shows of a description, on one line: its first line, clipped. */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : line;
}

const DESCRIPTION_MAX = 200;

/** Asks Claude Code on this machine, with the machine's login and the user's settings. */
export const sdkSkills: SkillLister = async (place) => {
  const { q, close } = idleClaude(place.cwd, {
    ...(place.plugins.length ? { plugins: place.plugins.map((path) => ({ type: 'local' as const, path })) } : {}),
    ...(place.untrusted ? { settingSources: ['user' as const] } : {}),
  });
  try {
    // which of Claude Code's own commands are skills, only the skill list says
    const [commands, skills] = await withTimeout(Promise.all([q.supportedCommands(), q.reloadSkills().then((r) => r.skills)]), ANSWER_MS, 'Claude Code did not list its skills');
    return skillsOf(commands, new Set(skills.map((s) => s.name)));
  } finally {
    close();
  }
};

/**
 * The skill lists by place, each asked once at a time and kept a while (`FRESH_MS`): opening a card
 * asks for them, and many cards share a repository. A list that fails is empty, and asked again next time.
 */
export class Skills {
  private kept = new Map<string, Kept<Skill[]>>();

  constructor(
    private list: SkillLister = sdkSkills,
    private now = () => Date.now(),
  ) {}

  /** The skills at `place`: the list kept, asked afresh behind it once it is old; the first time, once Claude Code has answered. */
  of(place: SkillPlace): Promise<Skill[]> {
    const key = JSON.stringify([place.cwd, place.plugins, place.untrusted]);
    let kept = this.kept.get(key);
    if (!kept) {
      const failed = (e: unknown) => console.error(`Obeya: Claude Code did not list the skills in ${place.cwd}: ${messageOf(e)}`);
      this.kept.set(key, (kept = new Kept(() => this.list(place), { forMs: FRESH_MS, failed, forget: true, now: this.now })));
    }
    const skills = kept.get();
    return skills ? Promise.resolve(skills) : kept.fresh().then((s) => s ?? []);
  }
}
