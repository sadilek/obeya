// The Arbeitsrückschau: Obeya looks back at how the workers worked, to make future runs cheaper.
// When a card's work ends, an excerpt of its runs (transcript.ts, no model) goes to a short session
// that notes the friction in it; every WORK_RETRO_EVERY finished cards of a repository, or when the
// owner asks, a session in that repository's checkout reads the notes since the last one and
// proposes cards (a script, a skill) or CLAUDE.md lines for friction that recurs across cards.

import { z } from 'zod';
import type { CardEvent } from '../core/types';
import type { Board } from './board';
import type { FrictionNote } from './db';
import { readSession } from './koordinator';
import type { AgentRuntime, AgentTool } from './runtime';
import { type Excerpt, excerptOf, excerptText, findTranscript } from './transcript';
import { type Language, LANGUAGE_NAMES } from '../core/locale';
import { MESSAGES } from '../core/messages';

export interface WorkRetroOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout of a repository of the canvas, by its id. */
  pathFor: (repo: string) => string;
  /** The transcript file of a session, or null; under the SDK's projects directory by default. */
  transcript?: (sessionId: string, cwd: string | null) => string | null;
  /** After how many finished cards of a repository the retrospective runs; WORK_RETRO_EVERY by default. */
  every?: number;
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
    this.serial(() => this.retro(repo, true));
  }

  /** Counts a finished card of the repository; whether the retrospective is due. The count is a setting, so it survives a restart. */
  private count(repo: string): boolean {
    const b = this.o.board;
    const n = Number(b.setting(countKey(repo)) ?? 0) + 1;
    if (n < (this.o.every ?? WORK_RETRO_EVERY)) {
      b.setSetting(countKey(repo), String(n));
      return false;
    }
    b.setSetting(countKey(repo), '0');
    return true;
  }

  /** The excerpt of the card's runs, made into 0 to 3 friction notes by a short session; none without an excerpt. */
  private async notes(card: Ended): Promise<void> {
    const find = this.o.transcript ?? ((id, cwd) => findTranscript(id, cwd));
    const runs = card.sessions.map((s) => excerptOf(find(s, card.workspace))).filter((e): e is Excerpt => !!e);
    const text = excerptText(runs);
    if (!text) return;
    const notes: FrictionNote[] = [];
    await readSession(this.o.runtime, {
      cwd: this.o.pathFor(card.repo),
      system: NOTES_SYSTEM(LANGUAGE_NAMES[this.o.board.language()]),
      model: NOTES_MODEL,
      role: 'chores',
      effort: 'low',
      brief: `The card: "${card.title}".\n\nThe excerpt of its worker's ${runs.length > 1 ? `${runs.length} runs` : 'run'}:\n\n${text}`,
      tools: (finish): AgentTool[] => [
        {
          name: 'note',
          description: `Note one piece of friction worth preventing (in ${LANGUAGE_NAMES[this.o.board.language()]}, a sentence each): what went wrong, what it cost, what would have prevented it.`,
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
      this.o.board.log(card.id, 'state', 'koordinator', this.o.board.t.retro.friction(notes.map((n) => this.o.board.t.retro.note(n.what, n.cost, n.fix)).join('\n')));
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
      if (told) b.speak(undefined, b.t.retro.nothingToRead(name));
      return;
    }
    // the cards as tags, in the order their notes came
    const tags = new Map<string, string>();
    for (const n of notes) if (![...tags.values()].includes(n.cardId)) tags.set(`K${tags.size + 1}`, n.cardId);
    const tagOf = (id: string) => [...tags].find(([, c]) => c === id)![0];
    const titles = new Map(notes.map((n) => [n.cardId, n.title]));
    const byCard = [...tags].map(([tag, id]) => {
      const mine = notes.filter((n) => n.cardId === id);
      return `${tag} "${titles.get(id)}":\n${mine.map((n) => `- ${n.what} Kosten: ${n.cost} Verhindert hätte es: ${n.fix}`).join('\n')}`;
    });
    const proposed = b.retroProposals(repo);
    const rules = b.preferences('proposed', 'rejected', 'filed').filter((p) => p.target === repo);
    const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
    const dismissed = [...proposed.filter((p) => p.dismissed).map((p) => `card "${p.title}" (${p.retro})`), ...rules.filter((p) => p.state === 'rejected').map((p) => `CLAUDE.md line "${p.text}"`)];
    const before = [...proposed.filter((p) => !p.dismissed).map((p) => `card "${p.title}" (${p.state === 'proposal' ? 'waiting for the owner' : 'taken'})`), ...rules.filter((p) => p.state !== 'rejected').map((p) => `CLAUDE.md line "${p.text}" (${p.state === 'proposed' ? 'waiting for the owner' : 'taken'})`)];
    let made = 0;
    const basisOf = (cards: unknown): { ids: string[] } | string => {
      const ids = [...new Set((Array.isArray(cards) ? cards : []).map((t) => tags.get(String(t))).filter((x): x is string => !!x))];
      if (ids.length < 2) return 'Not recorded: a proposal rests on friction on at least two cards; pass their tags in cards. Without two, propose nothing.';
      return { ids };
    };
    await readSession(this.o.runtime, {
      cwd: this.o.pathFor(repo),
      system: RETRO_SYSTEM(b.language()),
      role: 'chores',
      brief: [
        `The repository: ${name}. The friction noted on its cards since the last Arbeitsrückschau, card by card:\n\n${byCard.join('\n\n')}`,
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
            description: `Propose a feature card that prevents the friction: a script, a skill, a fix to a tool. title, body and basis in ${LANGUAGE_NAMES[b.language()]}; cards: the tags of the cards it rests on (at least two).`,
            schema: { title: z.string(), body: z.string(), basis: z.string(), cards: z.array(z.string()) },
            run: ({ title, body, basis, cards }) => {
              if (made >= WORK_RETRO_PROPOSALS) return f(`At most ${WORK_RETRO_PROPOSALS} proposals. End your turn now.`);
              const t = clip(String(title).trim(), 200);
              if (!t) return 'Not recorded: the title is missing.';
              const on = basisOf(cards);
              if (typeof on === 'string') return on;
              const why = clip(String(basis).trim(), 600);
              const p = b.proposeRetro(repo, { title: t, body: `${String(body).trim()}\n\n${b.t.retro.occasion(why)}`, basis: why });
              b.log(p.id, 'state', 'koordinator', b.t.retro.from(name, why, on.ids.map((id) => b.t.quote(titles.get(id) ?? '')).join(', ')));
              made++;
              return after();
            },
          },
          {
            name: 'rule',
            description: `Propose a line for the repository's CLAUDE.md, for knowledge the workers lacked: rule short and in ${LANGUAGE_NAMES[b.language()]}; basis in ${LANGUAGE_NAMES[b.language()]}; cards: the tags of the cards it rests on (at least two).`,
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
          { name: 'done', description: 'Nothing (more) to propose.', schema: {}, run: () => f('Fine. End your turn now.') },
        ];
      },
    });
    if (told) b.speak(undefined, b.t.retro.done(name, made));
  }

  private serial(fn: () => Promise<void>) {
    this.chain = this.chain
      .catch(() => {})
      .then(fn)
      .catch((e) => console.error('Arbeitsrückschau:', e));
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
    const m = /\((?:Sitzung|session) ([\w-]+)\) (?:bleibt für die Arbeitsrückschau erhalten|is kept for the work retrospective)/.exec(e.text);
    return m ? [m[1]!] : [];
  });
}

/** After how many finished cards of a repository the retrospective runs, and at most how much it proposes. */
export const WORK_RETRO_EVERY = 10;
const WORK_RETRO_PROPOSALS = 3;
const MAX_NOTES = 3;
/** Notes are a small job on every finished card: a smaller model writes them. */
const NOTES_MODEL = 'sonnet';
/** The settings that keep a repository's count across restarts, and when its last retrospective was. */
const countKey = (repo: string) => `work_retro_cards:${repo}`;
const sinceKey = (repo: string) => `work_retro_since:${repo}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const NOTES_SYSTEM = (language: string) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Each worker works on one card in its own workspace of a repository. You look back at how a worker worked, so that future runs in this repository go faster.

You get an excerpt of one card's run from its transcript: tool calls that failed, with their errors; similar calls in a row (a failed one followed by its correction, or one command again and again); files written whole more than once; the worker's words around them; and how many tool calls the run took, and after how many it first changed a file.

Note the friction a change to the repository would prevent in future runs:
- a command with wrong flags, or run the wrong way, and corrected;
- a script that failed and was rewritten;
- a long search for how to start, run, test or demo something;
- a tool or check used wrongly, a missing piece of knowledge about the repository.
Not friction: a test or type check failing on the change being made and then fixed (that is the work itself), one quick slip corrected at once at no cost, a call blocked by a rule that then worked the other way at once.

Note 0 to 3, the costliest first; most runs have one or none. Call note for each: what (concretely: the command, the file, the error), cost (the steps or time it took, a wrong turn), fix (what would have prevented it: a script, a skill, a line in the CLAUDE.md, a clearer error message; concretely). In ${language}, a sentence each: the owner reads them on the card. You may read the repository (you cannot change it) to check whether that already exists. Then call done.
`.trim();

const RETRO_SYSTEM = (language: Language) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Each worker works on one card in its own workspace of a repository. This is the Arbeitsrückschau for the repository you are in (you cannot change it): you get the friction noted on its workers' runs since the last one, card by card, and propose what would make future runs cheaper.

Look for friction that recurs on at least two different cards, the same detour taken again and again, and that a change to the repository would prevent:
- a script (scripts/…) for what workers keep putting together by hand or keep getting wrong;
- a skill (.claude/skills/…) for a procedure they keep fumbling;
- a fix to a tool, a check or an error message that misleads;
- a line in the repository's CLAUDE.md, for knowledge they lacked.
Read the repository first: its CLAUDE.md, its docs, scripts and skills. Propose nothing it has already; where it has it but the workers did not find it, propose making it findable (a CLAUDE.md line). Skills of the user (~/.claude/skills) are out of scope.

Propose at most ${WORK_RETRO_PROPOSALS}, only for patterns on at least two cards and only what you expect the owner to take; most of the time that is fewer, or none.
- card: a feature card. title in ${LANGUAGE_NAMES[language]}, naming what it builds: ${language === 'de' ? '„Skript \`scripts/x.ts\` für …“, „Skill für …“' : '“Script \`scripts/x.ts\` for …”, “Skill for …”'}. body in ${LANGUAGE_NAMES[language]}: what to build and how to verify it, so a worker needs no other context, and the friction it prevents. basis: one sentence in ${LANGUAGE_NAMES[language]} for the owner, naming the cards it rests on and what went wrong on them. cards: the tags of those cards.
- rule: a line for the CLAUDE.md: rule short, general, in ${LANGUAGE_NAMES[language]}; basis and cards as for card. It waits for the owner and goes into the CLAUDE.md through the card ${MESSAGES[language].quote(MESSAGES[language].claudeMd.title)}.
The owner does not know the tags: name cards by their titles in basis. Do not propose again what was proposed before, above all what the owner dismissed, in other words either. Then call done.
`.trim();
