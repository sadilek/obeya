// The learner and the retrospective: they read what the owner says and does, and propose rules
// from it, so the owner never has to say the same thing twice. The learner reads one input at a
// time; the retrospective, every so many inputs, what happened on the canvas since the last one.

import { z } from 'zod';
import { LANGUAGE_NAMES } from '../core/locale';
import { clip } from '../core/text';
import type { CardEvent, Item, Preference } from '../core/types';
import type { Board } from './board';
import type { Utterance } from './history';
import { type AgentRuntime, type AgentTool, readSession, waitQuietly } from './runtime';

/**
 * What the owner said that may hold a lasting preference: to a worker (answer, note, feedback), in
 * an idea's discussion, to the Coordinator in conversation (a command it carried out, or a question
 * or remark it replied to), or in the text of a card they wrote.
 */
export type OwnerInput = 'answer' | 'note' | 'feedback' | 'idea' | 'command' | 'talk' | 'card';

/** What the learner reads an input with. */
export interface InputContext {
  /** The question the owner answered. */
  question?: string;
  /** The Coordinator's reply to what the owner said to it. */
  reply?: string;
  /** The card's text before the owner wrote in it: a proposal's, a follow-up's. */
  before?: string;
}

export interface LearnerOptions {
  board: Board;
  runtime: AgentRuntime;
  /** Where it reads for what the owner says without a card: the home repository's read tree. */
  home: () => string;
  /** Where it reads for what the owner says on a card: its repository's read tree. */
  pathFor: (card: Item) => string;
  /** After how many of the owner's inputs the retrospective runs; REVIEW_EVERY by default. */
  reviewEvery?: number;
}

export class Learner {
  /** The learner's and the retrospective's turns, one at a time. */
  private learning: Promise<unknown> = Promise.resolve();

  constructor(private o: LearnerOptions) {}

  /** The language its agents write the owner in: the owner's conversation language. */
  private get language() {
    return LANGUAGE_NAMES[this.o.board.conversation()];
  }

  /**
   * The owner said something (to a worker, in an idea, to the Coordinator, in a card's text): if it
   * states a lasting preference, propose it as a rule for every agent; the owner accepts it in the
   * sheet. `card` is the card it concerns, or the one open; none in a conversation without one.
   * Runs in the background, one at a time.
   */
  learn(card: Item | null, kind: OwnerInput, text: string, context: InputContext = {}) {
    // what surrounded the input is read now: by its turn, the agent may have answered it
    const around = this.around(card, kind, text, context);
    this.learning = this.learning.then(() => this.distill(card, kind, text, context, around)).catch((e) => console.error('Coordinator (learning):', e));
    this.noticed();
  }

  /**
   * The owner said something, or clicked without words (a start, an approval, a dismissed
   * proposal): every `reviewEvery` of these, the retrospective reads the history since the last one,
   * after the learner has read the input that completed the count. The count is a setting of the
   * canvas, so it survives a restart.
   */
  noticed() {
    const b = this.o.board;
    // the first input counted starts the history; it was logged a moment ago
    if (!b.setting(REVIEW_SINCE)) b.setSetting(REVIEW_SINCE, new Date(Date.now() - 60_000).toISOString());
    const count = Number(b.setting(REVIEW_COUNT) ?? 0) + 1;
    if (count < (this.o.reviewEvery ?? REVIEW_EVERY)) return b.setSetting(REVIEW_COUNT, String(count));
    const since = b.setting(REVIEW_SINCE)!;
    b.setSetting(REVIEW_COUNT, '0');
    b.setSetting(REVIEW_SINCE, new Date().toISOString());
    this.learning = this.learning.then(() => this.review(since)).catch((e) => console.error('Coordinator (retrospective):', e));
  }

  /** The retrospective: one session reads what happened since `since` and proposes rules for patterns across cards. */
  private async review(since: string): Promise<void> {
    const history = this.history(since);
    if (!history.length) return;
    const rules = this.o.board.preferences('active');
    let proposed = 0;
    await readSession(this.o.runtime, {
      cwd: this.o.home(),
      role: 'coordinator',
      onLimit: waitQuietly,
      system: REVIEW_SYSTEM(this.language),
      tools: (finish): AgentTool[] => [
        {
          name: 'propose',
          description: `Propose a rule to the owner: one short rule in ${this.language}, and why (one short sentence in ${this.language}, under 150 characters, naming what in the history it rests on). Pass replaces with the number of a recorded rule it refines or contradicts. ${REPOS_PARAM}`,
          schema: { rule: z.string(), why: z.string(), replaces: z.number().int().optional(), repos: z.array(z.string()).optional() },
          run: ({ rule, why, replaces, repos }) => {
            const r = ruleText(rule);
            if (!r) return 'Empty rule ignored.';
            if (proposed >= REVIEW_PROPOSALS) return finish(`At most ${REVIEW_PROPOSALS} proposals. End your turn now.`);
            const made = this.proposeRule(r, repos, replaces, rules, this.o.board.preferences('proposed'), { review: true, quote: String(why ?? '') });
            if (typeof made === 'string') return made;
            if (!made) return 'Already proposed.';
            proposed++;
            return proposed < REVIEW_PROPOSALS ? 'Proposed.' : finish('Proposed. That was the last one; end your turn now.');
          },
        },
        { name: 'done', description: 'Nothing (more) to propose.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
      brief: [`What happened on the canvas since the last retrospective, oldest first:\n${history.join('\n')}`, ...this.rules(null)].filter(Boolean).join('\n\n'),
    });
  }

  /**
   * What the retrospective reads, oldest first, at most the latest REVIEW_HISTORY lines: the cards'
   * milestones (the owner's notes, answers and clicks, the agents' questions and hand-overs, answers
   * given in the owner's name), the owner's words in ideas and to the Coordinator (taken back or
   * not), the cards they deleted or dismissed, and the rule proposals they decided on.
   */
  private history(since: string): string[] {
    const b = this.o.board;
    const title = (id?: string) => (id ? b.item(id)?.title : undefined);
    const lines: { at: string; text: string }[] = [
      ...b.history.timeline(since, REVIEW_HISTORY).flatMap((m) => {
        const t = title(m.cardId);
        if (!t) return [];
        const who = m.kind === 'answer' && m.author !== 'owner' ? `${WHO[m.author]}, in the owner's name,` : WHO[m.author];
        const what = m.kind === 'created' ? (m.author === 'owner' ? 'the owner created the card' : 'an agent proposed the card') : `${who}${STEPS[m.kind] ?? ' '}${clip(m.text, 300)}`;
        return [{ at: m.at, text: `"${t}": ${what}` }];
      }),
      ...b.history
        .utterances(since, REVIEW_HISTORY)
        .filter((u) => u.kind === 'talk')
        .map((u) => ({ at: u.at, text: `"${u.title ?? ''}": the owner in the idea's discussion: ${clip(u.text, 300)}` })),
      ...b.sheet
        .latest(REVIEW_HISTORY)
        .filter((t) => t.at > since && t.reply !== undefined)
        .map((t) => {
          const open = title(t.cardId);
          return {
            at: t.at,
            text: `the owner to you${open ? ` (with "${open}" open)` : ''}: ${clip(t.said, 300)} → ${clip(t.reply!, 200)}${t.undone ? ' (the owner took it back)' : ''}`,
          };
        }),
      ...b.history.removed(since).map((r) => ({
        at: r.at,
        text: r.state === 'proposal' ? `the owner dismissed the card an agent proposed: "${r.title}"` : `the owner deleted the card "${r.title}" (${r.state})`,
      })),
      ...b.history.decidedProposals(since).map((p) => ({
        at: p.at,
        text: `the owner ${p.state === 'rejected' ? 'rejected' : 'accepted'} the proposed rule "${p.text}"${p.state === 'filed' ? ` for the CLAUDE.md of ${p.target}` : ''}${p.quote ? ` (its occasion: ${clip(p.quote, 200)})` : ''}`,
      })),
    ];
    return lines
      .sort((x, y) => x.at.localeCompare(y.at))
      .slice(-REVIEW_HISTORY)
      .map((l) => `- ${l.at.slice(0, 16).replace('T', ' ')} ${l.text}`);
  }

  /**
   * What the learner and the retrospective read about the rules: the canvas's repositories, the active
   * rules (numbered, for `replaces`), the rules on their way into a CLAUDE.md, and the proposals
   * waiting or rejected.
   */
  private rules(card: Item | null): string[] {
    const b = this.o.board;
    const repo = card?.repo ?? b.home;
    const rules = b.preferences('active');
    const where = (p: Preference) => (p.target ? ` (for the CLAUDE.md of ${p.target})` : '');
    const list = (ps: Preference[]) => ps.map((p) => `- ${p.text}${where(p)}`).join('\n');
    const [open, filed, rejected] = [b.preferences('proposed'), b.preferences('filed'), b.preferences('rejected')];
    return [
      `The canvas's repositories (ids for repos):\n${b.canvas.repos.map((r) => `- ${r.id}: ${r.name}, at ${r.path}${r.id === repo ? (card ? " (the card's)" : ' (the home repository)') : ''}`).join('\n')}`,
      rules.length ? `Rules recorded so far:\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}` : 'No rules recorded so far.',
      filed.length ? `Rules the owner accepted for a repository's CLAUDE.md (in it or on their way; do not propose them again):\n${list(filed)}` : '',
      open.length ? `Proposals waiting for the owner (do not propose them again):\n${list(open)}` : '',
      rejected.length ? `Proposals the owner rejected (do not propose them again):\n${list(rejected)}` : '',
    ];
  }

  /**
   * Proposes `rule` to the owner for the repositories of `repos` (none: the preference memory), each
   * where `open` does not hold it yet, as a change of the rule numbered `replaces` among `rules`.
   * Says for how many it proposed it, or why `repos` are not the canvas's.
   */
  private proposeRule(rule: string, repos: unknown, replaces: unknown, rules: Preference[], open: Preference[], occasion: Parameters<Board['proposePreference']>[1]): number | string {
    const targets = this.targets(repos);
    if (typeof targets === 'string') return targets;
    const fresh = targets.filter((t) => !open.some((p) => p.text === rule && p.target === t));
    const old = typeof replaces === 'number' ? rules[replaces - 1] : undefined;
    for (const t of fresh) this.o.board.proposePreference(rule, occasion, old?.id, t);
    return fresh.length;
  }

  /** The repositories a proposal is for (none: the preference memory), or why they are not the canvas's. */
  private targets(repos: unknown): (string | undefined)[] | string {
    const ids = Array.isArray(repos) ? [...new Set(repos.map(String).filter(Boolean))] : [];
    const known = this.o.board.canvas.repos.map((r) => r.id);
    const unknown = ids.filter((id) => !known.includes(id));
    if (unknown.length) return `Unknown repository ${unknown.join(', ')}; the canvas has ${known.join(', ')}. Call propose again.`;
    return ids.length ? ids : [undefined];
  }

  /** What the learner reads an input in: the card's text, the agent's last message before it, what the owner said in the last days. */
  private around(card: Item | null, kind: OwnerInput, text: string, { question }: InputContext): string[] {
    // a card deleted meanwhile has no log to read
    const events = card && this.o.board.item(card.id) ? this.o.board.events(card.id) : [];
    // the newest first; a question the owner answered is shown as such
    const said = question ? undefined : events.find((e) => AGENTS.includes(e.author) && SAYS.includes(e.kind));
    const recent = this.o.board.history.utterances(new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString(), RECENT_UTTERANCES + 1);
    // the input itself is among them, as the newest with its words (a card's text is not)
    const self = recent.findLastIndex((u) => u.text === text);
    if (self >= 0) recent.splice(self, 1);
    return [
      card?.body && kind !== 'card' ? `The card's text:\n${clip(card.body, 1500)}` : '',
      recent.length
        ? `What the owner said in the last ${RECENT_DAYS} days, oldest first:\n${recent
            .slice(-RECENT_UTTERANCES)
            .map((u) => `- ${u.at.slice(0, 10)}, ${UTTERED[u.kind]}${u.title ? ` on "${u.title}"` : ''}: ${clip(u.text, 300)}`)
            .join('\n')}`
        : '',
      said ? `The ${said.author === 'explorer' ? 'idea agent' : 'agent'}'s last message on the card before it:\n${clip(said.text, 1500)}` : '',
    ];
  }

  private async distill(card: Item | null, kind: OwnerInput, text: string, context: InputContext, around: string[]): Promise<void> {
    const rules = this.o.board.preferences('active');
    const open = this.o.board.preferences('proposed');
    const { question, reply, before } = context;
    let proposed = false;
    await readSession(this.o.runtime, {
      cwd: card && !card.repoDown ? this.o.pathFor(card) : this.o.home(),
      role: 'coordinator',
      onLimit: waitQuietly,
      system: LEARN_SYSTEM(this.language),
      tools: (finish): AgentTool[] => [
        {
          name: 'propose',
          description: `Propose a lasting preference to the owner as one short rule in ${this.language}. Pass replaces with the number of a recorded rule it refines or contradicts. ${REPOS_PARAM}`,
          schema: { rule: z.string(), replaces: z.number().int().optional(), repos: z.array(z.string()).optional() },
          run: ({ rule, replaces, repos }) => {
            const r = ruleText(rule);
            if (!r) return finish('Empty rule ignored.');
            if (proposed) return finish('One proposal per input. End your turn now.');
            const made = this.proposeRule(r, repos, replaces, rules, open, { ...(card ? { cardId: card.id } : {}), quote: text });
            if (typeof made === 'string') return made;
            if (!made) return finish('Already proposed. End your turn now.');
            proposed = true;
            if (card) this.o.board.log(card.id, 'state', 'coordinator', this.o.board.t.coordinator.proposes(r));
            return finish('Proposed. End your turn now.');
          },
        },
        { name: 'nothing', description: 'Nothing lasting to record.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
      brief: [
        card ? `Card${kind === 'talk' || kind === 'command' ? ' the owner had open' : ''}: ${card.kind === 'project' ? 'project ' : ''}"${card.title}".` : '',
        ...around,
        question ? `The worker asked: ${question}` : '',
        before ? `Before the owner wrote in it, the card's text read:\n${before}` : '',
        `The owner's ${INPUTS[kind]}: ${text}`,
        reply ? `You replied: ${reply}` : '',
        ...this.rules(card),
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
  }
}

/**
 * Where a rule goes: the preference memory, for how agents work with the owner through Obeya, or a
 * repository's CLAUDE.md, for anything about the repository. Shared by the learner and the retrospective.
 */
const WHERE_RULES_GO = `
A rule goes to one of two places:
- The preference memory, for rules at the level of Obeya: how the agents work with the owner through Obeya, whatever the repository. What to ask the owner and what to decide alone, how many options a question offers, how to report, hand over and demo, what to decide in the owner's name and what not. Leave repos out.
- A repository's CLAUDE.md, for anything about a repository: its conventions, product requirements, tools, how its code is written, tested and landed, the UI and its wording, and taste in code too, even when it holds in every repository. There it is versioned, colleagues see it, and Claude Code follows it outside Obeya as well. Pass repos: the repository it concerns (usually the card's), or every repository of the canvas when it holds in all of them. A worker writes it into the CLAUDE.md once the owner accepts it; until that has landed, no agent follows it. If the repository's CLAUDE.md or docs say it already (you can read them), propose nothing.
`.trim();

const REPOS_PARAM =
  "repos: the ids of the repositories whose CLAUDE.md the rule belongs in (one proposal each); leave it out for a rule on how agents work with the owner through Obeya.";

const LEARN_SYSTEM = (language: string) => `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. You keep the owner's rules, so the owner never has to say the same thing twice.

You get one thing the owner just said: to the agent on a card, in the text of a card they wrote, or to you in conversation. With it you see the card, what the owner said in the last days, the agent's last message before it, the canvas's repositories, the rules recorded so far, and the proposals waiting for the owner or rejected by them. Decide whether it holds a lasting rule that should guide future work on other cards too: how to work, what to ask and what not, style, wording, testing, tools.

${WHERE_RULES_GO}

Signals for one:
- It is phrased generally: "immer", "nie", "ab jetzt", "grundsätzlich", "jedes Mal", "bei so etwas".
- It corrects how an agent works rather than what it builds: the agent asked what it could have decided itself, skipped a check, wrote in a style the owner does not want, went beyond its task. The agent's last message shows what the owner reacts to.
- It repeats something the owner said before, on this card or another: said twice, it should not need saying a third time.
Not a preference: deciding the case at hand (an option, a name, a date, what this card should do), approving, asking how things stand, correcting a fact. Most of what the owner says is like that: then call nothing.

Make few, good proposals: at most one per input, and only one you expect the owner to accept; when unsure, wait until the owner says it again. Call propose with a short, general rule in ${language}, in the owner's terms and without the occasion ("Fragen an mich mit höchstens drei Optionen.", "Änderungen am Login bekommen immer das Codex-Review." for the repository with the login); the owner accepts or rejects it before it applies. If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not propose what a recorded rule or a waiting proposal already covers, nor a rejected proposal again, in other words either.
`.trim();

/** After how many of the owner's inputs the retrospective runs, at most how many rules it proposes, and how much history it reads. */
export const REVIEW_EVERY = 20;
const REVIEW_PROPOSALS = 3;
const REVIEW_HISTORY = 300;
/** The settings that keep the retrospective's count across restarts, and when its history begins. */
const REVIEW_COUNT = 'review_inputs';
const REVIEW_SINCE = 'review_since';

const REVIEW_SYSTEM = (language: string) => `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. You keep the owner's rules, so the owner never has to say the same thing twice.

${WHERE_RULES_GO}

This is the retrospective. You get what happened on the canvas since the last one, oldest first: what the owner said and clicked (notes, answers, feedback, approvals, starts against your advice, cards and proposals they deleted or dismissed, commands they took back, rule proposals they accepted or rejected), and what the agents asked and handed over. Each thing the owner said was already read on its own; look for what only shows across several moments and cards:
- the same correction or feedback on different cards;
- the same kind of question, answered the same way each time;
- proposals of one kind the owner always dismisses, or always takes;
- your advice to wait overruled again and again;
- commands taken back, and what the owner did instead.
Clicks without words count here: what the owner does again and again says what they want as much as what they say.

Propose a rule only for a pattern seen at least twice, on different cards, that you expect the owner to accept; most of the time there is none. Call propose for each, at most ${REVIEW_PROPOSALS}: rule, a short, general rule in ${language} in the owner's terms and without the occasion ("Fragen an mich mit höchstens drei Optionen.", "Änderungen am Login bekommen immer das Codex-Review." for the repository with the login); why, one short sentence in ${language} for the owner (under 150 characters) naming the cards or moments it rests on. If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not propose what a recorded rule or a waiting proposal already covers, nor a rejected proposal again, in other words either. Then call done.
`.trim();

/** How the retrospective names who did something on a card, and what. */
const WHO: Record<CardEvent['author'], string> = {
  owner: 'the owner',
  worker: 'the agent',
  explorer: 'the idea agent',
  project: 'the project agent',
  coordinator: 'you',
  obeya: 'Obeya',
};
const STEPS: Partial<Record<CardEvent['kind'], string>> = {
  state: ': ',
  question: ' asked: ',
  answer: ' answered: ',
  review: ' handed over: ',
  hint: ' wrote to the agent: ',
  error: ', an error: ',
};

/** How far back the learner reads what the owner said, and at most how much of it. */
const RECENT_DAYS = 3;
const RECENT_UTTERANCES = 30;

/** Who on a card speaks for an agent, and in which of its log lines. */
const AGENTS: CardEvent['author'][] = ['worker', 'explorer'];
const SAYS: CardEvent['kind'][] = ['say', 'question', 'review', 'report', 'talk'];

/** How the learner hears what the owner said in the last days. */
const UTTERED: Record<Utterance['kind'], string> = {
  hint: 'to the agent',
  answer: "answering the agent's question",
  talk: "in an idea's discussion",
  say: 'to you',
};

/** A rule as an agent proposes it, cut to the length a rule may have; empty where it wrote none. */
const ruleText = (rule: unknown) => String(rule).trim().slice(0, 500);

/** How the learner hears each kind of input. */
const INPUTS: Record<OwnerInput, string> = {
  answer: 'answer',
  note: 'note to the worker',
  feedback: 'feedback on the finished work',
  idea: 'words in the discussion of an idea',
  command: 'words to you, which you carried out',
  talk: 'question or remark to you',
  card: 'text of a card they wrote, the task for an agent',
};
