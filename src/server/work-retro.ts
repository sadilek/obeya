// The Arbeitsrückschau: Obeya looks back at how the workers worked, to make future runs cheaper.
// When a card's work ends, an excerpt of its runs (transcript.ts, no model) goes to a short session
// that notes the friction in it; after WORK_RETRO_RAMP finished cards of a new repository (1, 2 more,
// 4 more), then every WORK_RETRO_EVERY, or when the
// owner asks, a session in that repository's checkout reads the notes since the last one and
// proposes cards (a script, a skill), CLAUDE.md lines or values for the repository's settings for
// friction that recurs across cards.

import { z } from 'zod';
import { type CardEvent, PROPOSED_SETTINGS, type ProposedSetting } from '../core/types';
import type { Board } from './board';
import type { FrictionNote } from './db';
import { readSession } from './coordinator';
import { type AgentRuntime, type AgentTool, waitQuietly } from './runtime';
import { remote } from './hosts';
import { type Excerpt, excerptOf, excerptText, findTranscript } from './transcript';
import { type Language, LANGUAGE_NAMES } from '../core/locale';
import { MESSAGES } from '../core/messages';
import { clip } from '../core/text';

export interface WorkRetroOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout of a repository of the canvas, by its id. */
  pathFor: (repo: string) => string;
  /** The transcript file of a session, or null; under the SDK's projects directory by default. */
  transcript?: (sessionId: string, cwd: string | null) => string | null;
  /** After how many finished cards of a repository the retrospective runs; WORK_RETRO_EVERY by default. */
  every?: number;
  /** How many finished cards each of a repository's first retrospectives waits for; WORK_RETRO_RAMP by default. */
  ramp?: number[];
  /** The values of a repository's settings a retrospective may propose, as they apply now; none where they cannot be read. */
  settingsFor?: (repo: string) => Record<ProposedSetting, string | string[]> | undefined;
  /** The language of what lands in a repository (`language` of its settings), by its id; English when left out. */
  repoLanguage?: (repo: string) => Language;
}

/** A card whose work ended, as read at that moment: what follows may delete or archive it. */
interface Ended {
  id: string;
  title: string;
  repo: string;
  sessions: string[];
  workspace: string | null;
}

export class WorkRetro {
  /** Notes and retrospectives run one at a time, so a retrospective reads the notes of the card that completed its count. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private o: WorkRetroOptions) {}

  /**
   * A card's work ended: landed, closed without a change, or thrown away. Its runs are read now,
   * before the card goes; a card that never ran counts for nothing.
   */
  ended(cardId: string, workspace: string | null = null) {
    const b = this.o.board;
    let row;
    try {
      row = b.row(cardId);
    } catch {
      return;
    }
    const sessions = [...new Set([...earlierRuns(b.events(cardId)), ...(row.session_id ? [row.session_id] : [])])];
    if (!sessions.length) return;
    const card: Ended = { id: cardId, title: row.title ?? '', repo: row.repo ?? b.home, sessions, workspace: workspace ?? row.workspace };
    const due = this.count(card.repo);
    this.serial(() => this.notes(card));
    if (due) this.serial(() => this.retro(card.repo));
  }

  /**
   * The owner asks for the retrospective of a repository now: it reads the notes since the last
   * one, and the count starts again. When it is done, the owner hears what came of it.
   */
  now(repo: string) {
    this.o.board.setSetting(countKey(repo), '0');
    this.ran(repo);
    this.serial(() => this.retro(repo, true));
  }

  /**
   * Counts a finished card of the repository; whether the retrospective is due. A new repository's
   * first retrospectives come sooner (`ramp`: after its first card, 2 more, 4 more), so the owner
   * does not wait long for the first improvements; then every WORK_RETRO_EVERY. The count and the
   * retrospectives run are settings, so they survive a restart.
   */
  private count(repo: string): boolean {
    const b = this.o.board;
    const ramp = this.o.ramp ?? WORK_RETRO_RAMP;
    const runs = this.runs(repo);
    const n = Number(b.setting(countKey(repo)) ?? 0) + 1;
    if (n < (runs < ramp.length ? ramp[runs]! : (this.o.every ?? WORK_RETRO_EVERY))) {
      b.setSetting(countKey(repo), String(n));
      return false;
    }
    b.setSetting(countKey(repo), '0');
    this.ran(repo);
    return true;
  }

  /** How many retrospectives the repository had. */
  private runs(repo: string): number {
    return Number(this.o.board.setting(runsKey(repo)) ?? 0);
  }

  private ran(repo: string) {
    this.o.board.setSetting(runsKey(repo), String(this.runs(repo) + 1));
  }

  /** The excerpt of the card's runs, made into 0 to 3 friction notes by a short session; none without an excerpt. */
  private async notes(card: Ended): Promise<void> {
    const find = this.o.transcript ?? ((id, cwd) => findTranscript(id, cwd));
    // a worker on another machine left its transcripts there
    let there: ReturnType<typeof remote> = null;
    try {
      there = remote(card.workspace);
    } catch {
      // a host no longer in the configuration: its runs are not read
      return;
    }
    const files = await Promise.all(card.sessions.map((s) => (there ? there.host.transcript(s, there.path) : find(s, card.workspace))));
    const runs = files.map(excerptOf).filter((e): e is Excerpt => !!e);
    const text = excerptText(runs);
    if (!text) return;
    const notes: FrictionNote[] = [];
    const settings = this.settingsText(card.repo);
    await readSession(this.o.runtime, {
      cwd: this.o.pathFor(card.repo),
      system: NOTES_SYSTEM(LANGUAGE_NAMES[this.o.board.conversation()]),
      role: 'chores',
      // nobody waits for it
      onLimit: waitQuietly,
      brief: `The card: "${card.title}".${settings ? `\n\n${settings}` : ''}\n\nThe excerpt of its worker's ${runs.length > 1 ? `${runs.length} runs` : 'run'}:\n\n${text}`,
      tools: (finish): AgentTool[] => [
        {
          name: 'note',
          description: `Note one piece of friction worth preventing (in ${LANGUAGE_NAMES[this.o.board.conversation()]}, a sentence each): what went wrong, what it cost, what would have prevented it.`,
          schema: { what: z.string(), cost: z.string(), fix: z.string() },
          run: ({ what, cost, fix }) => {
            if (notes.length >= MAX_NOTES) return finish(`At most ${MAX_NOTES} notes. End your turn now.`);
            const n = { what: clip(String(what).trim(), 600), cost: clip(String(cost).trim(), 300), fix: clip(String(fix).trim(), 600) };
            if (!n.what) return 'Empty note ignored.';
            notes.push(n);
            return notes.length < MAX_NOTES ? 'Noted.' : finish('Noted. That was the last one; end your turn now.');
          },
        },
        { name: 'done', description: 'Nothing (more) worth noting.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
    });
    this.o.board.addFriction(card.repo, card.id, notes);
    // the owner sees on the card what was noted; a card deleted meanwhile has no log to show it
    if (notes.length && this.o.board.item(card.id))
      this.o.board.log(card.id, 'state', 'coordinator', this.o.board.t.retro.friction(notes.map((n) => this.o.board.t.retro.note(n.what, n.cost, n.fix)).join('\n')));
  }

  /**
   * The retrospective of a repository: one session in its checkout reads the friction noted since the
   * last one and proposes at most WORK_RETRO_PROPOSALS cards or CLAUDE.md lines, each for friction
   * on at least two cards. Asked for by the owner (`told`), it tells them what came of it.
   */
  private async retro(repo: string, told = false): Promise<void> {
    const b = this.o.board;
    const name = b.canvas.repos.find((r) => r.id === repo)?.name ?? repo;
    const since = b.setting(sinceKey(repo));
    const notes = b.friction(repo, since);
    b.setSetting(sinceKey(repo), new Date().toISOString());
    if (!notes.length) {
      if (told) b.notify({ text: b.t.retro.nothingToRead(name) });
      return;
    }
    // the cards by their numbers, in the order their notes came
    const tags = new Map<string, string>();
    for (const n of notes) if (![...tags.values()].includes(n.cardId)) tags.set(b.tagOf(n.cardId), n.cardId);
    const titles = new Map(notes.map((n) => [n.cardId, n.title]));
    const byCard = [...tags].map(([tag, id]) => {
      const mine = notes.filter((n) => n.cardId === id);
      return `${tag} "${titles.get(id)}":\n${mine.map((n) => `- ${n.what} Kosten: ${n.cost} Verhindert hätte es: ${n.fix}`).join('\n')}`;
    });
    const proposed = b.retroProposals(repo);
    const rules = b.preferences('proposed', 'rejected', 'filed').filter((p) => p.target === repo);
    const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
    const values = b.settingProposals(repo);
    const valueText = (p: (typeof values)[number]) => `setting ${p.field} = ${JSON.stringify(p.value)}`;
    const dismissed = [
      ...proposed.filter((p) => p.dismissed).map((p) => `card "${p.title}" (${p.retro})`),
      ...rules.filter((p) => p.state === 'rejected').map((p) => `CLAUDE.md line "${p.text}"`),
      ...values.filter((p) => p.state === 'rejected').map((p) => `${valueText(p)} (${p.basis})`),
    ];
    const before = [
      ...proposed.filter((p) => !p.dismissed).map((p) => `card "${p.title}" (${p.state === 'proposal' ? 'waiting for the owner' : 'taken'})`),
      ...rules.filter((p) => p.state !== 'rejected').map((p) => `CLAUDE.md line "${p.text}" (${p.state === 'proposed' ? 'waiting for the owner' : 'taken'})`),
      ...values.filter((p) => p.state !== 'rejected').map((p) => `${valueText(p)} (${p.state === 'proposed' ? 'waiting for the owner' : 'taken'})`),
    ];
    const settings = this.settingsText(repo);
    let made = 0;
    const basisOf = (cards: unknown): { ids: string[] } | string => {
      const ids = [...new Set((Array.isArray(cards) ? cards : []).map((t) => tags.get(String(t))).filter((x): x is string => !!x))];
      if (ids.length < 2) return 'Not recorded: a proposal rests on friction on at least two cards; pass their tags in cards. Without two, propose nothing.';
      return { ids };
    };
    await readSession(this.o.runtime, {
      cwd: this.o.pathFor(repo),
      system: RETRO_SYSTEM(b.conversation(), b.language(), this.o.repoLanguage?.(repo) ?? 'en'),
      role: 'chores',
      onLimit: waitQuietly,
      brief: [
        `The repository: ${name}. The friction noted on its cards since the last Arbeitsrückschau, card by card:\n\n${byCard.join('\n\n')}`,
        settings,
        dismissed.length ? `Proposals of earlier Arbeitsrückschauen the owner dismissed (do not propose them again, in other words either):\n${list(dismissed)}` : '',
        before.length ? `Proposed before and waiting or taken (do not propose them again):\n${list(before)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      tools: (f): AgentTool[] => {
        const after = () => (made < WORK_RETRO_PROPOSALS ? 'Proposed.' : f('Proposed. That was the last one; end your turn now.'));
        return [
          {
            name: 'card',
            description: `Propose a feature card that prevents the friction: a script, a skill, a fix to a tool. title, body and basis in ${LANGUAGE_NAMES[b.conversation()]}; cards: the tags of the cards it rests on (at least two).`,
            schema: { title: z.string(), body: z.string(), basis: z.string(), cards: z.array(z.string()) },
            run: ({ title, body, basis, cards }) => {
              if (made >= WORK_RETRO_PROPOSALS) return f(`At most ${WORK_RETRO_PROPOSALS} proposals. End your turn now.`);
              const t = clip(String(title).trim(), 200);
              if (!t) return 'Not recorded: the title is missing.';
              const on = basisOf(cards);
              if (typeof on === 'string') return on;
              const why = clip(String(basis).trim(), 600);
              const p = b.proposeRetro(repo, { title: t, body: `${String(body).trim()}\n\n${b.t.retro.occasion(why)}`, basis: why });
              b.log(p.id, 'state', 'coordinator', b.t.retro.from(name, why, on.ids.map((id) => b.t.quote(titles.get(id) ?? '')).join(', ')));
              made++;
              return after();
            },
          },
          {
            name: 'rule',
            description: `Propose a line for the repository's CLAUDE.md, for knowledge the workers lacked: rule short and in ${LANGUAGE_NAMES[this.o.repoLanguage?.(repo) ?? 'en']}, the repository's language; basis in ${LANGUAGE_NAMES[b.conversation()]}; cards: the tags of the cards it rests on (at least two).`,
            schema: { rule: z.string(), basis: z.string(), cards: z.array(z.string()) },
            run: ({ rule, basis, cards }) => {
              if (made >= WORK_RETRO_PROPOSALS) return f(`At most ${WORK_RETRO_PROPOSALS} proposals. End your turn now.`);
              const r = clip(String(rule).trim(), 500);
              if (!r) return 'Not recorded: the rule is missing.';
              const on = basisOf(cards);
              if (typeof on === 'string') return on;
              if (b.preferences('proposed').some((p) => p.text === r && p.target === repo)) return 'Already proposed.';
              b.proposePreference(r, { review: true, quote: clip(String(basis).trim(), 300) }, undefined, repo);
              made++;
              return after();
            },
          },
          {
            name: 'setting',
            description: `Propose a value for one of the repository's settings that Obeya gives every worker: ${PROPOSED_SETTINGS.join(', ')}. value: a string for setup and run, a list of strings for checks and softPaths; basis in ${LANGUAGE_NAMES[b.conversation()]}; cards: the tags of the cards it rests on (at least two).`,
            schema: { field: z.enum(PROPOSED_SETTINGS), value: z.union([z.string(), z.array(z.string())]), basis: z.string(), cards: z.array(z.string()) },
            run: ({ field, value, basis, cards }) => {
              if (made >= WORK_RETRO_PROPOSALS) return f(`At most ${WORK_RETRO_PROPOSALS} proposals. End your turn now.`);
              const k = String(field) as ProposedSetting;
              if (!PROPOSED_SETTINGS.includes(k)) return `Not recorded: field is one of ${PROPOSED_SETTINGS.join(', ')}.`;
              const v = settingValue(k, value);
              if (v === null) return 'Not recorded: the value is missing.';
              const on = basisOf(cards);
              if (typeof on === 'string') return on;
              if (b.settingProposals(repo).some((p) => p.state === 'proposed' && p.field === k)) return `Not recorded: a value for ${k} already waits for the owner.`;
              b.proposeSetting({ repo, field: k, value: v, basis: clip(String(basis).trim(), 600), cards: on.ids });
              made++;
              return after();
            },
          },
          { name: 'done', description: 'Nothing (more) to propose.', schema: {}, run: () => f('Fine. End your turn now.') },
        ];
      },
    });
    if (told) b.notify({ text: b.t.retro.done(name, made) });
  }

  /** The repository's settings a retrospective may propose a value for, as they apply now, for a session's brief; empty where they cannot be read. */
  private settingsText(repo: string): string {
    const now = this.o.settingsFor?.(repo);
    if (!now) return '';
    const shown = (v: string | string[]) => (Array.isArray(v) ? (v.length ? v.map((x) => JSON.stringify(x)).join(', ') : '(none)') : v.trim() ? JSON.stringify(v) : '(empty)');
    return `The repository's settings in Obeya now, which every worker gets in its brief:\n${PROPOSED_SETTINGS.map((k) => `- ${k} (${SETTING_MEANING[k]}): ${shown(now[k])}`).join('\n')}`;
  }

  private serial(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch((e) => console.error('Arbeitsrückschau:', e));
  }

  /** Settles once what is queued now has run (tests). */
  idle(): Promise<unknown> {
    return this.chain;
  }
}

/** The sessions of a card's earlier runs, from its log. */
export function earlierRuns(events: CardEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.author !== 'obeya' || e.kind !== 'state') return [];
    // the line that keeps an earlier run (`earlierRun` in either language)
    const m = /\((?:Sitzung|session) ((?:codex:)?[\w-]+)\) (?:bleibt für die Arbeitsrückschau erhalten|is kept for the work retrospective)/.exec(e.text);
    return m ? [m[1]!] : [];
  });
}

/** After how many finished cards of a repository the retrospective runs, the first few sooner, and at most how much it proposes. */
export const WORK_RETRO_EVERY = 10;
export const WORK_RETRO_RAMP = [1, 2, 4];
const WORK_RETRO_PROPOSALS = 3;
const MAX_NOTES = 3;
/** The settings that keep a repository's count across restarts, and when its last retrospective was. */
const countKey = (repo: string) => `work_retro_cards:${repo}`;
const sinceKey = (repo: string) => `work_retro_since:${repo}`;
const runsKey = (repo: string) => `work_retro_runs:${repo}`;


/** What each setting a retrospective may propose is for, as the sessions read it. */
const SETTING_MEANING: Record<ProposedSetting, string> = {
  checks: 'the commands a worker runs before it hands its work over',
  setup: 'the command that prepares a fresh workspace, e.g. installs dependencies',
  softPaths: 'paths (a trailing / covers a directory) whose edits never count as a merge conflict between two cards, resolved when a branch is rebased, e.g. docs',
  run: '"How to run the app": the recipe every worker reads, in prose: how to start the app, what to do after which kind of change, where it gives its address, the login and test data for a demo',
};

/** A proposed value as the setting takes it: a command or recipe for setup and run, a list of non-empty strings for the others. */
function settingValue(field: ProposedSetting, value: unknown): string | string[] | null {
  if (field === 'setup' || field === 'run') {
    const v = typeof value === 'string' ? value.trim() : Array.isArray(value) ? value.map(String).join('\n').trim() : '';
    return v ? clip(v, 4000) : null;
  }
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []).map((x) => String(x).trim()).filter(Boolean);
  return list.length ? list.slice(0, 20).map((x) => clip(x, 500)) : null;
}

const NOTES_SYSTEM = (language: string) => `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. Each worker works on one card in its own workspace of a repository. You look back at how a worker worked, so that future runs in this repository go faster.

You get an excerpt of one card's run from its transcript: tool calls that failed, with their errors; similar calls in a row (a failed one followed by its correction, or one command again and again); files written whole more than once; the worker's words around them; and how many tool calls the run took, and after how many it first changed a file.

Note the friction a change to the repository would prevent in future runs:
- a command with wrong flags, or run the wrong way, and corrected;
- a script that failed and was rewritten;
- a long search for how to start, run, test or demo something;
- a tool or check used wrongly, a missing piece of knowledge about the repository;
- working out what one of the repository's settings in Obeya (listed with the card, where they are) would have said: how to run the app, which checks to run, how to prepare a fresh workspace. Its fix names the setting and the value the run shows works: the commands as the worker finally ran them.
Not friction: a test or type check failing on the change being made and then fixed (that is the work itself), one quick slip corrected at once at no cost, a call blocked by a rule that then worked the other way at once.

Note 0 to 3, the costliest first; most runs have one or none. Call note for each: what (concretely: the command, the file, the error), cost (the steps or time it took, a wrong turn), fix (what would have prevented it: a script, a skill, a line in the CLAUDE.md, a clearer error message; concretely). In ${language}, a sentence each: the owner reads them on the card. You may read the repository (you cannot change it) to check whether that already exists. Then call done.
`.trim();

const RETRO_SYSTEM = (language: Language, ui: Language, repository: Language) => `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. Each worker works on one card in its own workspace of a repository. This is the Arbeitsrückschau for the repository you are in (you cannot change it): you get the friction noted on its workers' runs since the last one, card by card, and propose what would make future runs cheaper.

Look for friction that recurs on at least two different cards, the same detour taken again and again, and that a change to the repository would prevent:
- a script (scripts/…) for what workers keep putting together by hand or keep getting wrong;
- a skill (.claude/skills/…) for a procedure they keep fumbling;
- a fix to a tool, a check or an error message that misleads;
- a line in the repository's CLAUDE.md, for knowledge they lacked;
- a value for one of the repository's settings in Obeya (listed after the friction, as they are now), where workers each worked out what it would have told them: how to run the app (run), which checks to run, the setup of a fresh workspace. Obeya hands a setting to every worker where it needs it, so where one holds the knowledge it beats a CLAUDE.md line.
Read the repository first: its CLAUDE.md, its docs, scripts and skills. Propose nothing it has already; where it has it but the workers did not find it, propose making it findable (a CLAUDE.md line). Skills of the user (~/.claude/skills) are out of scope.

Propose at most ${WORK_RETRO_PROPOSALS}, only for patterns on at least two cards and only what you expect the owner to take; most of the time that is fewer, or none.
- card: a feature card. title in ${LANGUAGE_NAMES[language]}, naming what it builds: ${language === 'de' ? '„Skript \`scripts/x.ts\` für …“, „Skill für …“' : '“Script \`scripts/x.ts\` for …”, “Skill for …”'}. body in ${LANGUAGE_NAMES[language]}: what to build and how to verify it, so a worker needs no other context, and the friction it prevents. basis: one sentence in ${LANGUAGE_NAMES[language]} for the owner, naming the cards it rests on and what went wrong on them. cards: the tags of those cards.
- rule: a line for the CLAUDE.md: rule short, general, in ${LANGUAGE_NAMES[repository]} (the language of what lands in the repository, whatever the owner's); basis and cards as for card. It waits for the owner and goes into the CLAUDE.md through the card ${MESSAGES[ui].quote(MESSAGES[ui].claudeMd.title)}.
- setting: field and the whole value it should have (it replaces the one now), from what the notes show works, checked against the repository: for run a recipe a worker can follow without searching (the commands, what to do after a change, where the app's address is, how to get past a login, what to stage); basis and cards as for card. The owner takes it on their machine or into the repository's .obeya/settings.json for everyone.
The owner does not know the tags: name cards by their titles in basis. Do not propose again what was proposed before, above all what the owner dismissed, in other words either. Then call done.
`.trim();
