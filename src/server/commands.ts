// Spoken (or typed) commands: the Koordinator reads what the owner said as one or more actions,
// confirms them in one sentence, and runs them after a short delay unless the owner takes them back.

import { z } from 'zod';
import { type AgentChoice, answering, type CanvasConfig, finished, type Item, type NextStep, prototypeWorkstream, type Queue } from '../core/types';
import { BadRequest, type Board } from './board';
import type { Config } from './config';
import type { Moment } from './db';
import { type AgentRuntime, type AgentSession, failureReason } from './runtime';
import { type Language, LANGUAGE_NAMES } from '../core/locale';
import { MESSAGES } from '../core/messages';

export type Command = (
  /** `from`: the card it follows up on. */
  | { do: 'newCard'; title: string; body: string; start: boolean; repo?: string; from?: string }
  | { do: 'newIdea'; title: string; body: string; repo?: string }
  /** `force` starts a card that waits behind others now, despite the likely merge conflict. */
  /** `direct`: onto the default branch without a pull request, where the card's repository allows it. */
  | { do: 'approve'; card: string; direct?: boolean }
  | { do: 'start' | 'force' | 'dequeue' | 'accept' | 'dismiss' | 'split' | 'stop' | 'build' | 'planDoc' | 'park' | 'drop'; card: string }
  /** On a prototype: build its idea on it (or `workstream`, of the project the idea became), or throw it away. */
  | { do: 'buildPrototype'; card: string; workstream?: string }
  | { do: 'discard'; card: string }
  /** `spoken`: the words came through speech recognition (the default), not typed. */
  /** `revise`: the owner's words on a proposal, which an agent reworks it by. */
  | { do: 'note' | 'answer' | 'feedback' | 'discuss' | 'prototype' | 'revise'; card: string; text: string; spoken?: boolean }
  /** Saves Obeya's configuration, which then starts again with it. */
  | { do: 'configure'; canvases: CanvasConfig[] }
  /**
   * Records a rule every agent follows, active at once, or with `repos` files it for those
   * repositories' CLAUDE.md; `replaces`: the rule (id) it changes, `card`: the card open when the owner said it.
   */
  | { do: 'remember'; text: string; replaces?: number; card?: string; repos?: string[] }
  /** Runs the Arbeitsrückschau of a repository now. */
  | { do: 'workRetro'; repo: string }
  /** Puts the cards into the group of that name, a new one when the canvas has none of that name. */
  | { do: 'group'; cards: string[]; name: string }
  | { do: 'ungroup'; cards: string[] }
  | { do: 'renameGroup'; group: string; name: string }
) & {
  /** Screenshots that came with the command (image ids), on the actions that take them (`TAKES_IMAGES`). */
  images?: string[];
};

/**
 * Actions whose words reach the learner on their own way (a note, an idea's discussion) or are a
 * rule already: a command with one of them is not offered for learning again.
 */
const LEARNED: Command['do'][] = ['note', 'answer', 'feedback', 'discuss', 'newIdea', 'remember'];

/** An idea's suggested next step, as the Koordinator reads it: the action it would take, or answering the questions. */
const NEXT_ACTION: Record<NextStep['step'], string> = {
  answer: 'have the owner answer its open questions (discuss)',
  build: 'build',
  planDoc: 'plan_doc',
  prototype: 'prototype',
  park: 'park',
  drop: 'drop',
};

/** The answers an idea's agent would give to its own open questions. */
const picks = (i: Item) => {
  const picked = (i.idea?.questions ?? []).filter((q) => q.pick).map((q) => `"${clip(q.text, 120)}" → ${q.pick!.options.join(', ')}`);
  return picked.length ? ` (its own answers: ${picked.join('; ')})` : '';
};

/** The actions a command's screenshots go with: those that create a card, start one or say something to its agent. */
const TAKES_IMAGES: Command['do'][] = ['newCard', 'newIdea', 'start', 'force', 'note', 'answer', 'feedback', 'discuss'];

/** Actions whose text goes to an agent: a card's, or the one that reworks a proposal. */
const TO_AGENT: Command['do'][] = ['note', 'answer', 'feedback', 'discuss', 'revise'];

export interface Heard {
  /** What the owner hears and reads back. */
  confirm: string;
  /** Takes the actions back while they wait; absent when there was nothing to do. */
  token?: string;
  /**
   * Said to the agent of the card the owner has open (a note, an answer, talk to an idea): it went
   * out at once and stands in the card's log or conversation, which is confirmation enough.
   */
  quiet?: boolean;
}

export interface Focus {
  card?: string;
  project?: string;
}

/** The field on the open card a typed command came from. */
export type Field = 'note' | 'answer' | 'feedback' | 'discuss' | 'revise';
const FIELDS: Record<Field, string> = {
  note: "the field for a note to the card's agent",
  answer: "the field for an answer to the card's open question",
  feedback: "the field for feedback on the card's work",
  discuss: "the idea's conversation",
  revise: 'the field for what should change in the proposal',
};
export const isField = (f: unknown): f is Field => typeof f === 'string' && f in FIELDS;

/** How the owner gave a command: spoken (the default) or typed, and then in which field of the open card. */
export interface Input {
  typed?: boolean;
  field?: Field;
}

export interface CommanderOptions {
  board: Board;
  runtime: AgentRuntime;
  cwd: string;
  /** Runs a command; what it throws is logged on the card. */
  execute: (c: Command) => unknown | Promise<unknown>;
  /** How long a command waits for "Rückgängig". */
  delayMs?: number;
  /** Commands one session reads; the next one starts from the stored memory. */
  sessionCommands?: number;
  /** A question the Koordinator could not answer at once: looked up, and answered later. */
  lookUp?: (talk: number) => void;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  /** Obeya's configuration: the Koordinator reads it, and changes it on the owner's word. */
  config?: Pick<Config, 'view' | 'check'>;
  /** The model and effort the owner chose for the Koordinator; another one chosen since takes a new session. */
  agentChoice?: () => AgentChoice;
  /**
   * Called with what the owner said, so lasting preferences can be learned: a question or remark
   * the Koordinator replied to (`talk`), or a command once it runs; `card` is the one open.
   */
  onOwnerInput?: (card: string | undefined, kind: 'command' | 'talk', text: string, reply: string) => void;
}

/** The Koordinator's conversation with the owner: one agent session that reads command after command. */
interface Session {
  agent: AgentSession;
  ended: boolean;
  /** The language it speaks to the owner in; another one chosen since takes a new session. */
  language: Language;
  /** The owner's choice of model and effort it started with, as JSON. */
  choice: string;
  /** Tags of the cards it has seen; they stay the same for the session, so earlier messages stay right. */
  tags: Map<string, string>;
  tagOf: Map<string, string>;
  /** Commands it has read so far; the first one brings the memory. */
  read: number;
  /** Up to when it knows the canvas's history (ISO time). */
  since: string;
  /** The rules as numbered in the latest message (their ids), for `remember` to name the one it changes. */
  rules: number[];
  /** The command being read. */
  reading?: {
    finish: (commands: Command[], confirm: string, lookUp?: LookUp) => string;
    /** The turn ended, with the error that ended it. */
    end: (error?: Error) => void;
  };
}

/** A question to look up: what the owner asked, and the card it is about. */
type LookUp = { question: string; about?: string };
type Decision = { commands: Command[]; confirm: string; lookUp?: LookUp };

/** The actions `act` takes, as the Koordinator names them. */
const ACTIONS = ['new_card', 'new_idea', 'start', 'dequeue', 'note', 'answer', 'feedback', 'approve', 'accept', 'dismiss', 'revise', 'split', 'stop', 'discuss', 'build', 'plan_doc', 'prototype', 'park', 'drop', 'remember', 'work_retro', 'group', 'ungroup', 'rename_group'] as const;
type Action = (typeof ACTIONS)[number];

/** Actions in one command, at most: "start all queued cards" may name many. */
const MAX_ACTIONS = 20;

/** How far back a fresh session's memory reaches. */
const REMEMBERED_EXCHANGES = 20;
const HISTORY_DAYS = 14;
const HISTORY_STEPS = 60;
/** What happened between two commands, at most. */
const NEWS_STEPS = 40;

export class Commander {
  /**
   * Commands between being understood and running; the timer is set once the owner has the
   * confirmation. `said`: the owner's words, to learn from once they run, unless they reach the
   * learner another way.
   */
  private waiting = new Map<string, { commands: Command[]; said?: string; talk: number; confirm: string; card?: string; timer?: ReturnType<typeof setTimeout> }>();
  private session: Session | null = null;
  /** Commands are read one after the other, each once the previous turn has ended. */
  private turns: Promise<unknown> = Promise.resolve();
  /** What the Koordinator hears with the next command: actions the owner took back. */
  private news: string[] = [];

  constructor(private o: CommanderOptions) {}

  /**
   * Understands the command; its actions run only after `arm`, so the undo window starts when the
   * owner hears back. The exchange goes into the open card's log, or without one into the
   * Koordinator's sheet. Screenshots (image ids) go with the actions that create or concern a card.
   */
  async hear(transcript: string, focus: Focus, images: string[] = [], input: Input = {}): Promise<Heard> {
    const card = focus.card && this.o.board.item(focus.card) ? focus.card : undefined;
    let decision: Decision;
    try {
      decision = await this.interpret(transcript, focus, images, input);
    } catch (e) {
      // the Koordinator's session failed (not logged in, say): the owner hears why, not that they went unheard
      const t = this.o.board.t;
      const confirm = t.voice.couldNotRead(failureReason(e instanceof Error ? e.message : String(e), t));
      this.o.board.addTalk(transcript, confirm, card ?? null, undefined, images);
      if (card) {
        this.o.board.log(card, 'say', 'owner', transcript, undefined, images);
        this.o.board.log(card, 'say', 'koordinator', confirm);
      }
      return { confirm };
    }
    const { confirm, lookUp } = decision;
    // the open card's agent gets what was said to it in the owner's words, however the Koordinator put them
    const verbatim = decision.commands.length === 1 && ['note', 'answer', 'feedback', 'revise'].includes(decision.commands[0]!.do);
    const commands = decision.commands.map((c): Command => {
      // a rule said with a card open has that card as its occasion
      if (c.do === 'remember') return card ? { ...c, card } : c;
      const told = TO_AGENT.includes(c.do) && 'text' in c ? { ...c, spoken: !input.typed, ...(verbatim && c.card === card ? { text: transcript } : {}) } : c;
      return images.length && TAKES_IMAGES.includes(c.do) ? { ...told, images } : told;
    });
    if (lookUp) {
      // nothing to take back: the answer follows once it is looked up
      const about = lookUp.about ?? card ?? (focus.project && this.o.board.item(focus.project) ? focus.project : undefined);
      const talk = this.o.board.addTalk(transcript, confirm, card ?? null, { question: lookUp.question, about: about ?? null }, images);
      if (card) {
        this.o.board.log(card, 'say', 'owner', transcript, undefined, images);
        this.o.board.log(card, 'say', 'koordinator', confirm);
      }
      this.o.lookUp?.(talk);
      this.o.onOwnerInput?.(card, 'talk', transcript, confirm);
      return { confirm };
    }
    // a note or an answer to the open card's agent, or talk to the open idea, goes out at once and
    // stands in the card's log or conversation, which is confirmation enough
    const quiet = commands.length > 0 && commands.every((c) => ['note', 'answer', 'discuss'].includes(c.do) && 'card' in c && c.card === card);
    // talking about an idea changes nothing that would need taking back: it goes on at once
    const talking = quiet ? commands : commands.filter((c) => c.do === 'discuss');
    const rest = commands.filter((c) => !talking.includes(c));
    const talk = this.o.board.addTalk(transcript, confirm, card ?? null, undefined, images);
    if (card && !quiet) {
      this.o.board.log(card, 'say', 'owner', transcript, undefined, images);
      this.o.board.log(card, 'say', 'koordinator', confirm);
    }
    for (const c of talking) await this.run(c);
    if (!commands.length) this.o.onOwnerInput?.(card, 'talk', transcript, confirm);
    if (!rest.length) return { confirm, ...(quiet ? { quiet: true } : {}) };
    const token = crypto.randomUUID();
    const said = commands.some((c) => LEARNED.includes(c.do)) ? {} : { said: transcript };
    this.waiting.set(token, { commands: rest, ...said, talk, confirm, ...(card ? { card } : {}) });
    return { confirm, token };
  }

  /** How long a command waits for undo once armed. */
  get delayMs(): number {
    return this.o.delayMs ?? 5000;
  }

  arm(token: string) {
    const w = this.waiting.get(token);
    if (!w || w.timer) return;
    w.timer = setTimeout(async () => {
      this.waiting.delete(token);
      // what the owner takes back is not learned from either
      if (w.said) this.o.onOwnerInput?.(w.card, 'command', w.said, w.confirm);
      // in the order the owner said them; one that fails does not hold up the others
      for (const command of w.commands) await this.run(command);
    }, this.delayMs);
  }

  /** Runs one command; what it throws is logged on its card. */
  private async run(command: Command) {
    try {
      await this.o.execute(command);
    } catch (e) {
      const card = 'card' in command ? command.card : undefined;
      if (card) this.o.board.log(card, 'error', 'obeya', e instanceof Error ? e.message : String(e), e instanceof BadRequest ? e.code : undefined);
      else console.error('voice command:', e);
    }
  }

  /** Takes a waiting command back; false when it already ran. */
  undo(token: string): boolean {
    const w = this.waiting.get(token);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiting.delete(token);
    this.o.board.undoTalk(w.talk);
    if (w.card && this.o.board.item(w.card)) this.o.board.log(w.card, 'state', 'owner', this.o.board.t.voice.undone);
    this.news.push(`The owner took back what you confirmed with „${w.confirm}“; it did not happen.`);
    return true;
  }

  /** Something the Koordinator hears with the owner's next command: an answer it looked up. */
  tell(text: string) {
    this.news.push(text);
  }

  /** Words Whisper should expect: Obeya's own, and the titles on the canvas. */
  vocabulary(): string {
    const titles = this.o.board
      .snapshot()
      .items.filter((i) => !finished(i.state))
      .map((i) => i.title.replace(/[`*_]/g, ''));
    return [this.o.board.t.vocabulary, ...titles].join(' ').slice(0, 900);
  }

  /** Starts the Koordinator's session ahead, so a command does not wait for its start-up. Called when the owner starts speaking. */
  warm() {
    if (!this.live()) this.session = this.open();
  }

  private choice = () => JSON.stringify(this.o.agentChoice?.() ?? {});

  /** The session that reads the next command, if it is still up, speaks the owner's language and runs as they chose. */
  private live(): Session | null {
    const s = this.session;
    if (s && !s.ended && !s.reading && (s.language !== this.o.board.language() || s.choice !== this.choice())) {
      s.ended = true;
      s.agent.close();
      this.session = null;
    }
    return this.session && !this.session.ended ? this.session : null;
  }

  /** A session whose tools act on whatever command it is reading. */
  private open(): Session {
    const language = this.o.board.language();
    const t = MESSAGES[language];
    const say = CONFIRM[language];
    const s: Session = { agent: null as unknown as AgentSession, ended: false, language, choice: this.choice(), tags: new Map(), tagOf: new Map(), read: 0, since: '', rules: [] };
    const finish = (commands: Command[], confirm: string, lookUp?: LookUp) => (s.reading ? s.reading.finish(commands, confirm, lookUp) : 'No command to read.');
    const repos = this.o.board.canvas.repos;
    const config = this.o.config;
    s.agent = this.o.runtime.start({
      cwd: this.o.cwd,
      readOnly: true,
      effort: 'medium',
      role: 'koordinator',
      system: system(language),
      tools: [
        {
          name: 'act',
          description: [
            'Do what the owner asked: one or more actions, in the order the owner said them. They run together after a short undo window, with one confirmation for all.',
            'Actions (card: the tag of the card; new_card and new_idea take none, except a follow-up):',
            `- new_card: a new card. title short and precise, body what the owner asked for in their words, start whether work should begin right away${repos.length > 1 ? ', repo the repository it belongs to (an id from the list)' : ''}. A follow-up of a card (for one of its findings, or something from its summary): card the tag of that card, and body the finding or passage in full, then what the owner added.`,
            "- start: start work on a planned card. On a queued card (waiting behind cards in progress or queued ahead of it) it starts it now, despite the likely merge conflict; a card the Koordinator is still checking starts by itself unless its changes likely conflict with work in progress. On a project: all its planned workstreams go to the Koordinator together, which decides their order and which of them wait (for a dependency or a likely conflict); use it when the owner wants a project's workstreams started (\"starte das Projekt\", \"alle Workstreams\") rather than starting them one by one.",
            '- dequeue: take a card out of the queue (waiting behind other cards, for a free workspace, or still being checked or split by the Koordinator); it goes back to planned and does not start until started again („nimm … aus der Warteschlange“, „lass … doch noch nicht starten“).',
            "- note: text to the agent working on a card (working, in PR, waiting, or live or done while its agent finishes after the landing); it doesn't stop it. Whatever the owner says to the agent: an instruction, a remark on its work, a question to it; never a question the owner asks you about the canvas.",
            "- answer: text as the answer to the card's open question: the agent's, or the one in its demo report (the demo then still waits for approval). A bare „ja“ or „nein“ to a card with an open question is an answer, not an approval.",
            '- feedback: text as feedback on work waiting for review (demo or summary), a question about that work included; the agent works on it again.',
            '- approve: approve work waiting for review; direct: true when the owner wants it straight onto main without a pull request („ohne PR“, „direkt auf main“), which a repository whose work goes out as a pull request allows only where the list of repositories says so. accept: take a proposed card and start it (a proposed idea: its discussion opens; the open questions on it go along). dismiss: discard a proposed card. revise: text what the owner wants changed in a proposed card, or their thoughts on it (added, dropped, decided, put differently); an agent rewrites its text and questions by it in a minute or so, and accepting it waits for that (by a click once it is there). split: let the Koordinator cut a planned card into packages. stop: stop the agent on a card.',
            `- new_idea: a new idea to think through with an exploration agent before anything is planned ("Ich will über … nachdenken", "Idee: …"). title short and precise, body what the owner said about it, in their words${repos.length > 1 ? ', repo as for new_card' : ''}.`,
            `- remember (no card): a rule the owner wants kept for all future work („Merk dir: …“, „ab jetzt immer …“). text: the rule, short and general, in ${LANGUAGE_NAMES[language]}; replaces: the number of a rule of the owner it changes or contradicts, also when it moves that rule into a CLAUDE.md. It goes to one of two places. The owner's rules, for how the agents work with the owner through Obeya whatever the repository (what to ask and what to decide alone, how to report, hand over and demo): leave repos out; it applies at once. A repository's CLAUDE.md, for anything about a repository (its conventions, product, tools, how its code is written, tested and landed, its UI and wording, taste in code even when it holds in every repository): repos the ids of the repositories it concerns (usually the open card's; every one when it holds in all of them); it goes into the repository's card ${t.quote(t.claudeMd.title)}, whose worker writes it into the CLAUDE.md. confirm says where it goes (${say.remember}).`,
            `- work_retro (no card): the Arbeitsrückschau of a repository, now („Mach eine Arbeitsrückschau für den Shop“): it reads the friction noted on the workers' runs of its finished cards since the last one and proposes cards (a script, a skill) or CLAUDE.md lines for what recurs on several cards; they come as proposals for the owner, and the owner hears when it is done. It also runs by itself every 10 finished cards of a repository. repo: the repository's id (the one the owner names, else the open card's, else the first). confirm e.g. ${say.retro}`,
            "- On a card in state idea: discuss (text: what the owner says in its discussion: a thought, a question, an answer to the idea's agent; it goes on at once, without undo), build (its brief becomes the task and a worker starts on it at once; while its agent works on a reply, or starts on one with a discuss in the same command, once that reply is there, unless the reply asks questions), plan_doc (a big idea becomes a project: an agent starts at once on its plan doc, and the project then takes the idea's place), prototype (a worker builds a throwaway prototype shown as a demo on it, beside any others; text: what it should show, its approach first in a few words; empty: one prototype for each variant its agent planned that has none running yet, all at once, or without planned variants one of the idea as it stands), park (for later), drop (it stays on the canvas with its brief). Planning an idea waits for its agent's reply while it works on one, or starts on one in the same command: then pass what the owner said with discuss, and say that planning goes by a click once the reply is there.",
            `- group: put cards into a group, shown on the canvas as a coloured territory behind them. cards: their tags; text: the group's name (group is only for rename_group), one the canvas has (see the list) or a new one, which is then created. A card is in one group at most, so this takes it out of its group. A workstream stands for its project: the whole project goes into the group. ungroup: take cards (cards) out of their group. rename_group: group the group's current name, text its new name. A group no card belongs to any more goes. confirm e.g. ${say.group}`,
            '- On a prototype (a card marked prototype of an idea): build (the idea is built on this prototype\'s branch; its other prototypes are thrown away; when the idea became a project, one of its workstreams is built on the branch instead: the one its plan doc builds on the prototype with, or cards: the tag of the one the owner names), drop (the prototype is thrown away into the archive). approve on a prototype also throws it away.',
            "Texts for a card's agent (note, answer, feedback) and for revise in the owner's own words, not rephrased: all they said, or with several actions in one sentence the part for that action. Other texts (a new card's body, a rule, talk to an idea) as the owner meant them (fix obvious recognition errors).",
          ].join('\n'),
          schema: {
            actions: z
              .array(
                z.object({
                  do: z.enum(ACTIONS),
                  card: z.string().optional(),
                  text: z.string().optional(),
                  title: z.string().optional(),
                  body: z.string().optional(),
                  start: z.boolean().optional(),
                  repo: z.string().optional(),
                  replaces: z.number().int().optional(),
                  repos: z.array(z.string()).optional(),
                  cards: z.array(z.string()).optional(),
                  group: z.string().optional(),
                  direct: z.boolean().optional(),
                }),
              )
              .min(1)
              .max(MAX_ACTIONS),
            confirm: z.string(),
          },
          run: ({ actions, confirm }) => {
            const commands: Command[] = [];
            const problems: string[] = [];
            (actions as ActionArgs[]).forEach((a, n) => {
              const r = this.command(a, s);
              if (typeof r === 'string') problems.push(`action ${n + 1} (${a.do}${a.card ? ` on ${a.card}` : ''}): ${r}`);
              else commands.push(r);
            });
            if (!problems.length)
              commands.forEach((c, n) => {
                const r = this.waitsForReply(c, commands);
                const a = (actions as ActionArgs[])[n]!;
                if (r) problems.push(`action ${n + 1} (${a.do}${a.card ? ` on ${a.card}` : ''}): ${r}`);
              });
            if (problems.length)
              return `Nothing recorded: ${problems.join('; ')}. Fix or drop what does not fit and call act again, or use reply (a question the owner asks is answered with reply, or with look_up when it needs reading).`;
            return finish(commands, String(confirm));
          },
        },
        {
          name: 'reply',
          description:
            'No action: answer a question from what this conversation gives you (the cards, their states and history, what was said), or say that it is unclear what is meant (ask what is meant, briefly).',
          schema: { confirm: z.string() },
          run: ({ confirm }) => finish([], String(confirm)),
        },
        ...(config
          ? [
              {
                name: 'config',
                description: [
                  "Read Obeya's configuration: the canvases this Obeya serves (canvases), each with its repositories (path; adapter, else picked by the repository's origin; clones: clones to create, workspaces: existing clones to use, both only for adapters whose workers use clones; share: the command line that shares video demos on a page outside Obeya, in place of the adapter's (resolved marks adapterShares where the adapter has one); without either, \"Teilen\" exports a demo as a ZIP or one HTML file), what they amount to (resolved: canvas id, as in ?c=<id>, name, repository ids, adapter and whether workers use clones or worktrees), problems, which canvases run now (running), where it is saved (file; source: whether the running canvases come from that file or from the command line), and the server's settings from its command line (port, data directory, the agents' permission mode, whether it restarts by itself).",
                  'Call it for any question about the configuration, and before configure.',
                ].join('\n'),
                schema: {},
                run: () => JSON.stringify(config.view(), null, 1),
              },
              {
                name: 'configure',
                description: [
                  "Change Obeya's configuration on the owner's word: canvases is the whole new list as config shows it (keep what the owner did not ask to change). It is saved after the undo window, and Obeya then starts again with it once no agent is in the middle of a turn; the page reloads.",
                  "A canvas's id follows its name (without one, the first repository's adapter names it), unless id is set: to rename a canvas, set id to its current id (from resolved), or it becomes a new, empty canvas and its cards stay under the old id, unseen. The first repository a canvas was served with stays its home and must stay listed. Server settings (port, permission mode) are not part of it; they come from the command line.",
                  `confirm: one short ${LANGUAGE_NAMES[language]} sentence saying what changes and that Obeya then starts again, e.g. ${say.configure}`,
                ].join('\n'),
                schema: {
                  canvases: z.array(
                    z.object({
                      name: z.string().optional(),
                      id: z.string().optional(),
                      repos: z.array(
                        z.object({ path: z.string(), adapter: z.string().optional(), workspaces: z.array(z.string()).optional(), clones: z.number().int().optional(), share: z.string().optional() }),
                      ),
                    }),
                  ),
                  confirm: z.string(),
                },
                run: ({ canvases, confirm }: Record<string, unknown>) => {
                  const { problems, canvases: checked } = config.check(canvases);
                  if (problems.length)
                    return `Nothing recorded, the configuration does not work: ${problems.map((p) => p.detail).join('; ')}. Fix it and call configure again, or reply to the owner.`;
                  return finish([{ do: 'configure', canvases: checked }], String(confirm));
                },
              },
            ]
          : []),
        {
          name: 'look_up',
          description: [
            'No action: a question that needs reading you cannot do in this quick turn: what an agent would do on a card if it were started, what the plan doc says about a workstream, how something works in the code, why something is the way it is.',
            "Never for a question about the work of an agent on a card (working, waiting for review, in PR, waiting, or finishing what remains): that agent knows its work, which is on its branch and not in the checkout look_up reads; pass the question to it (note, or feedback when it waits for review).",
            "An agent that reads the plan docs, the repository and the card's start task answers it in a few seconds; a question about a workstream goes to its project agent.",
            `question: the question in full, standing on its own (in English or German). card: the tag of the card it is about, if any (the open one unless the owner means another). confirm: a short ${LANGUAGE_NAMES[language]} acknowledgement, e.g. ${say.lookUp}`,
          ].join('\n'),
          schema: { question: z.string(), card: z.string().optional(), confirm: z.string() },
          run: ({ question, card, confirm }) => {
            const q = String(question).trim();
            if (!q) return 'The question is missing.';
            const about = card ? s.tags.get(String(card)) : undefined;
            if (card && (!about || !this.o.board.item(about))) return `Unknown tag ${String(card)}; call look_up again with a tag from the list, or without card.`;
            const agent = about ? this.o.board.item(about)! : undefined;
            if (agent && hasAgent(agent))
              return `An agent is on ${String(card)} (${agent.need ?? agent.state}): it answers what is asked about its work, which is on its branch and not in the checkout look_up reads. Pass the owner's words to it with act (${agent.state === 'waiting' && (agent.need === 'demo' || agent.need === 'review') ? 'feedback' : 'note'}).`;
            return finish([], String(confirm), { question: q, ...(about ? { about } : {}) });
          },
        },
      ],
      onEvent: (e) => {
        if (e.type === 'error') {
          s.ended = true;
          s.agent.close();
          s.reading?.end(new Error(e.message));
        } else if (e.type === 'idle') s.reading?.end();
      },
    });
    s.agent.done.then(() => {
      s.ended = true;
      s.reading?.end(new Error('the session ended'));
      if (this.session === s) this.session = null;
    });
    return s;
  }

  /**
   * Planning an idea, or building it on a prototype, waits for its agent's reply, which changes the
   * brief the owner decides on: what the owner said goes to the agent, and they click once the reply
   * is there. Building it as it stands goes ahead after the reply, unless that asks questions.
   */
  private waitsForReply(c: Command, all: Command[]): string | undefined {
    if (c.do === 'accept' && all.some((d) => d.do === 'revise' && d.card === c.card))
      return 'accepting a proposal waits for its reworked text, so the owner sees what they take: drop this action, keep revise, and say in confirm that accepting goes by a click once the new text is there';
    if (c.do !== 'planDoc' && c.do !== 'buildPrototype') return;
    const id = c.do === 'buildPrototype' ? this.o.board.item(c.card)?.prototypeOf : c.card;
    const idea = id ? this.o.board.item(id) : undefined;
    if (!idea) return;
    const talked = all.some((d) => d.do === 'discuss' && d.card === idea.id);
    if (!idea.idea?.thinking && !talked) return;
    return `the idea's agent ${talked ? 'starts on a reply with the discuss in this command' : 'is still working on its reply'}, and building or planning waits for that reply, so the owner decides on the brief it leaves. Drop this action and pass what the owner said to the idea with discuss (one per idea), then say in confirm that ${c.do === 'planDoc' ? 'planning' : 'building'} goes by a click on the card once the reply is there.`;
  }

  /** One action as a command, or why it cannot be done. */
  private command(a: ActionArgs, s: Session): Command | string {
    if (a.do === 'remember') {
      const text = a.text?.trim();
      if (!text) return 'the rule is missing';
      if (text.length > 500) return 'a rule has at most 500 characters';
      const known = this.o.board.canvas.repos.map((r) => r.id);
      const repos = [...new Set(a.repos ?? [])];
      const unknown = repos.filter((r) => !known.includes(r));
      if (unknown.length) return `unknown repository ${unknown.join(', ')}; the canvas has ${known.join(', ')}`;
      const to = repos.length ? { repos } : {};
      if (a.replaces === undefined) return { do: 'remember', text, ...to };
      const replaces = s.rules[a.replaces - 1];
      if (replaces === undefined) return `there is no rule ${a.replaces}; give the number of one of the owner's rules, or none`;
      return { do: 'remember', text, replaces, ...to };
    }
    if (a.do === 'work_retro') {
      const repos = this.o.board.canvas.repos;
      if (a.repo && !repos.some((r) => r.id === a.repo)) return `unknown repository ${a.repo}; the canvas has ${repos.map((r) => r.id).join(', ')}`;
      const open = a.card ? this.o.board.item(s.tags.get(a.card) ?? '')?.repo : undefined;
      return { do: 'workRetro', repo: a.repo ?? open ?? repos[0]!.id };
    }
    if (a.do === 'group' || a.do === 'ungroup') {
      const tags = [...new Set([...(a.cards ?? []), ...(a.card ? [a.card] : [])])];
      if (!tags.length) return 'name the cards with cards (their tags)';
      const cards: string[] = [];
      for (const t of tags) {
        const id = s.tags.get(t);
        if (!id || !this.o.board.item(id)) return `unknown tag ${t}`;
        cards.push(id);
      }
      if (a.do === 'ungroup') return { do: 'ungroup', cards };
      // the name may come where rename_group takes the group
      const name = (a.text || a.group)?.replace(/\s+/g, ' ').trim();
      if (!name) return "the group's name is missing (text)";
      if (name.length > 60) return "a group's name has at most 60 characters";
      return { do: 'group', cards, name };
    }
    if (a.do === 'rename_group') {
      const groups = this.o.board.snapshot().groups;
      const g = groups.find((x) => x.name.toLowerCase() === a.group?.trim().toLowerCase());
      if (!g) return `there is no group ${a.group ?? '(none named)'}; the canvas has ${groups.map((x) => `"${x.name}"`).join(', ') || 'none'}`;
      const name = a.text?.replace(/\s+/g, ' ').trim();
      if (!name) return 'the new name is missing (text)';
      if (name.length > 60) return "a group's name has at most 60 characters";
      if (groups.some((x) => x.id !== g.id && x.name.toLowerCase() === name.toLowerCase())) return `there is a group "${name}" already`;
      return { do: 'renameGroup', group: g.id, name };
    }
    if (a.do === 'new_idea') {
      if (!a.title?.trim()) return 'a new idea needs a title';
      const repos = this.o.board.canvas.repos;
      const repo = repos.length > 1 && repos.some((r) => r.id === a.repo) ? a.repo : undefined;
      return { do: 'newIdea', title: a.title.trim(), body: a.body ?? '', ...(repo ? { repo } : {}) };
    }
    if (a.do === 'new_card') {
      if (!a.title?.trim()) return 'a new card needs a title';
      const repos = this.o.board.canvas.repos;
      const repo = repos.length > 1 && repos.some((r) => r.id === a.repo) ? a.repo : undefined;
      const from = a.card ? s.tags.get(a.card) : undefined;
      if (a.card && (!from || !this.o.board.item(from))) return `unknown tag ${a.card}; give the card a follow-up comes from, or none`;
      return { do: 'newCard', title: a.title.trim(), body: a.body ?? '', start: Boolean(a.start), ...(repo ? { repo } : {}), ...(from ? { from } : {}) };
    }
    const id = a.card ? s.tags.get(a.card) : undefined;
    const card = id ? this.o.board.item(id) : undefined;
    if (!card) return `unknown tag ${a.card ?? '(none)'}`;
    const reviewable = card.state === 'waiting' && (card.need === 'review' || card.need === 'demo');
    const is = `it is ${card.need ? `${card.state}: ${card.need}` : card.state}`;
    if (card.prototypeOf && a.do === 'drop') return { do: 'discard', card: card.id };
    if (card.prototypeOf && a.do === 'build') {
      const project = this.o.board.projectOf(card.prototypeOf);
      if (!project) return { do: 'buildPrototype', card: card.id };
      if (!a.cards?.length && prototypeWorkstream(this.o.board.snapshot().items, project.id)) return { do: 'buildPrototype', card: card.id };
      const ws = a.cards?.length === 1 ? s.tags.get(a.cards[0]!) : undefined;
      if (!ws || this.o.board.item(ws)?.parent !== project.id)
        return `the prototype's idea is the project "${project.title}" now, and its plan doc does not say which workstream builds on the prototype: name the one with cards (its tag)`;
      return { do: 'buildPrototype', card: card.id, workstream: ws };
    }
    if (['discuss', 'build', 'plan_doc', 'prototype', 'park', 'drop'].includes(a.do) !== (card.state === 'idea'))
      return card.state === 'idea' ? `the card is an idea: discuss it, or build, plan_doc, prototype, park or drop it` : `only an idea can be discussed, built, prototyped, parked or dropped (${is})`;
    switch (a.do) {
      case 'discuss':
        if (!a.text?.trim()) return 'the text is missing';
        return { do: 'discuss', card: card.id, text: a.text.trim() };
      case 'prototype':
        return { do: 'prototype', card: card.id, text: a.text?.trim() ?? '' };
      case 'plan_doc':
        return { do: 'planDoc', card: card.id };
      case 'note':
      case 'answer':
      case 'feedback': {
        if (!a.text?.trim()) return 'the text is missing';
        if (a.do === 'note' && !['working', 'inPr', 'waiting'].includes(card.state) && !card.finishing) return `no agent works on this card (${is}), a note cannot reach it`;
        if (a.do === 'answer' && !card.question) return `the card has no open question (${is})`;
        if (a.do === 'feedback' && !reviewable) return `the card does not wait for review (${is})`;
        return { do: a.do, card: card.id, text: a.text.trim() };
      }
      case 'start':
        if (card.kind === 'project') {
          if (!this.o.board.snapshot().items.some((i) => i.parent === card.id && i.state === 'planned' && !i.queue))
            return 'the project has no planned workstream left that is not already with the Koordinator';
          break;
        }
        if (card.state !== 'planned') return `only a planned card can be started (${is})`;
        if (card.queue && 'behind' in card.queue) return { do: 'force', card: card.id };
        if (card.queue && 'workspace' in card.queue) return 'the card waits for a free workspace and starts by itself once one is free';
        if (card.queue) return `the Koordinator is still ${'cutting' in card.queue ? 'splitting' : 'checking'} the card; it starts by itself unless it collides`;
        break;
      case 'dequeue':
        if (card.state !== 'planned' || !card.queue) return `the card is not in the queue (${is})`;
        break;
      case 'approve': {
        if (!reviewable) return `the card does not wait for review (${is})`;
        const repo = this.o.board.canvas.repos.find((r) => r.id === card.repo);
        // where work lands on main anyway, approving it directly is approving it
        if (!a.direct || !repo?.pullRequests) break;
        // the owner hears why rather than getting a pull request they did not want
        if (!repo.direct) return `the repository ${card.repo} lands approved work only through a pull request; it does not allow pushing it directly onto main. Tell the owner so with reply, and approve without direct only once they want the pull request`;
        if (card.prototypeOf) return 'a prototype never lands; approving it throws it away';
        return { do: 'approve', card: card.id, direct: true };
      }
      case 'accept':
      case 'dismiss':
        if (card.state !== 'proposal') return `the card is no proposal (${is})`;
        if (a.do === 'accept' && card.proposal?.revising)
          return 'the proposal is being reworked by what the owner said; accepting it goes by a click, which waits for the new text: drop this action and say so in confirm';
        break;
      case 'revise':
        if (card.state !== 'proposal') return `only a proposed card can be revised (${is})`;
        if (!a.text?.trim()) return 'the text is missing';
        if (card.proposal?.revising) return 'the proposal is still being reworked by what the owner said before; reply that the new text comes in a moment, and to say it again then';
        return { do: 'revise', card: card.id, text: a.text.trim() };
      case 'split':
        if (card.source !== 'manual' || card.state !== 'planned' || card.queue) return 'only a planned card of the owner can be split';
        break;
      case 'stop':
        if (card.state !== 'working' && card.state !== 'waiting' && !card.finishing) return `no agent works on this card (${is})`;
        break;
    }
    return { do: a.do, card: card.id };
  }

  private interpret(transcript: string, focus: Focus, images: string[], input: Input): Promise<Decision> {
    return new Promise((decide, fail) => {
      this.turns = this.turns.then(() => this.read(transcript, focus, images, input, decide)).catch(fail);
    });
  }

  /** Reads one command; settles when the turn has ended, while the decision goes out as soon as it is taken. */
  private async read(transcript: string, focus: Focus, images: string[], input: Input, decide: (d: Decision) => void, retry = true): Promise<void> {
    const warmed = this.live();
    const s = warmed ?? (this.session = this.open());
    let decided = false;
    const ended = new Promise<Error | undefined>((end) => {
      s.reading = {
        finish: (commands, confirm, lookUp) => {
          if (decided) return 'Already decided.';
          decided = true;
          decide({ commands, confirm: confirm.trim().slice(0, 400), ...(lookUp ? { lookUp } : {}) });
          return 'Done. End your turn now.';
        },
        end,
      };
    });
    const files = this.o.imageFiles?.(images) ?? [];
    s.agent.send(this.brief(s, transcript, focus, input, files.length), files);
    const error = await ended;
    s.reading = undefined;
    if (error && !decided) {
      // a session that waited or talked before may have gone stale: read the command once more in a fresh one
      if (warmed && retry) return this.read(transcript, focus, images, input, decide, false);
      throw error;
    }
    if (!decided) decide({ commands: [], confirm: MESSAGES[s.language].voice.notUnderstood });
    if (s.read >= (this.o.sessionCommands ?? 30)) {
      // long enough: the next session starts from the stored memory, so the context stays short
      s.ended = true;
      s.agent.close();
      this.session = null;
      this.warm();
    }
  }

  /** What the open card's worker handed over: its summary in full, so a follow-up carries what it is about. */
  private report(card: Item): string {
    const summary = this.o.board.summary(card.id)?.trim();
    return summary ? `\n\nIts worker's summary:\n${summary}` : '';
  }

  /** The message for one command: what the Koordinator needs to know besides what it already knows. */
  private brief(s: Session, transcript: string, focus: Focus, input: Input, shots = 0): string {
    const { items, groups: groupList } = this.o.board.snapshot();
    const groups = new Map(groupList.map((g) => [g.id, g.name]));
    const relevant = items.filter((i) => i.kind !== 'project' && (!finished(i.state) || i.finishing || i.id === focus.card));
    const tag = (id: string) => {
      let t = s.tagOf.get(id);
      if (!t) {
        t = `K${s.tags.size + 1}`;
        s.tags.set(t, id);
        s.tagOf.set(id, t);
      }
      return t;
    };
    const describe = (i: Item) => {
      const project = i.parent ? items.find((p) => p.id === i.parent) : undefined;
      const state = i.queue
        ? queued(i.queue, items)
        : i.need
          ? `${i.state}: ${i.need}${answering(i) ? ", its agent works on the owner's answer to the question in its demo report" : ''}`
          : i.idea && i.idea.status !== 'open'
            ? `idea: ${i.idea.status}`
            : i.idea?.thinking
              ? `idea, its agent is working on its reply${i.idea.buildAfterReply ? '; built once the reply is there, unless it asks questions' : ''}`
            : i.finishing
              ? `${i.state}, its agent finishes what remains${i.state === 'done' ? ' (nothing to land: the work changed no code)' : ' after the landing'}`
              : i.state;
      const repo = this.o.board.canvas.repos.length > 1 ? ` in ${i.repo}` : '';
      const idea = i.prototypeOf ? items.find((x) => x.id === i.prototypeOf) : undefined;
      const became = i.prototypeOf ? items.find((x) => x.kind === 'project' && x.origin === i.prototypeOf) : undefined;
      const builds = became && prototypeWorkstream(items, became.id);
      const group = i.group ? groups.get(i.group) : undefined;
      return `${tag(i.id)} [${state}] "${i.title}"${repo}${project ? ` (project "${project.title}")` : ''}${group ? ` (group "${group}")` : ''}${became ? ` (prototype of the idea "${i.ideaTitle ?? ''}", which became the project ${tag(became.id)} "${became.title}"${builds ? `; build starts its workstream ${tag(builds.id)} "${builds.title}" on it` : ''}${i.buildProposal ? '; its worker proposes to build on it' : ''})` : idea ? ` (prototype of ${tag(idea.id)} "${idea.title}"${i.buildProposal ? '; its worker proposes to build the idea on it' : ''})` : ''}${i.proposal ? ` — proposed ${i.proposal.idea ? 'idea' : 'task'}${i.proposal.revising ? `, being reworked by what the owner said${i.proposal.acceptAfterRevision ? '; accepted once the new text is there, unless it asks questions' : ''}` : ''}${i.proposal.questions.length ? `, open questions: ${i.proposal.questions.map((q) => q.text).join(' | ')}` : ''}` : ''}${i.statusLine ? ` — status: ${clip(i.statusLine, 160)}` : ''}${i.question ? ` — open question${i.need === 'demo' ? ' in its demo report' : ''}: ${i.question.text}` : ''}${i.idea?.next ? ` — its agent would ${NEXT_ACTION[i.idea.next.step]} next: ${clip(i.idea.next.why, 200)}${picks(i)}` : ''}${i.idea?.variants.length ? ` — prototypes its agent planned: ${i.idea.variants.map((v) => v.approach).join(', ')}` : ''}`;
    };
    const step = (m: Moment) => {
      const card = items.find((i) => i.id === m.cardId);
      // a card no longer shown (its plan doc is gone) is no longer talked about
      if (!card) return [];
      const what =
        m.kind === 'created'
          ? m.author === 'owner'
            ? 'new card'
            : 'proposed by an agent'
          : `${STEP[m.kind] ?? ''}${clip(m.text, 200)}`;
      return [`- ${when(m.at)} ${tag(m.cardId)} "${card.title}": ${what}`];
    };
    const now = new Date().toISOString();
    const first = s.read === 0;
    let history: string[];
    if (first) {
      const talk = this.o.board.talk(REMEMBERED_EXCHANGES);
      const steps = this.o.board.timeline(new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString(), HISTORY_STEPS);
      history = [
        talk.length
          ? `Your conversation with the owner before this session (oldest first; card tags did not exist then):\n${talk
              .map((t) => {
                const open = t.cardId ? items.find((i) => i.id === t.cardId) : undefined;
                const later = t.answer !== undefined ? ` → the answer you looked up: "${clip(t.answer, 400)}"` : t.question ? ' (you were looking it up; no answer came)' : '';
                return `- ${when(t.at)}${open ? ` (with "${open.title}" open)` : ''} the owner: "${t.said}" → you: "${t.reply}"${t.undone ? ' (the owner took it back)' : ''}${later}`;
              })
              .join('\n')}`
          : 'You have not talked with the owner before.',
        `What happened on the canvas in the last ${HISTORY_DAYS} days (oldest first):\n${steps.flatMap(step).join('\n') || '(nothing)'}`,
      ];
    } else {
      const steps = this.o.board.timeline(s.since, NEWS_STEPS + 1);
      const more = steps.length > NEWS_STEPS ? steps.splice(0, steps.length - NEWS_STEPS).length : 0;
      history = steps.length ? [`What happened on the canvas since the owner's last command:\n${more ? `- (${more} earlier steps left out)\n` : ''}${steps.flatMap(step).join('\n')}`] : [];
    }
    s.read++;
    s.since = now;
    const news = this.news.splice(0);
    const rules = this.o.board.preferences('active');
    s.rules = rules.map((r) => r.id);
    const focused = focus.card ? relevant.find((i) => i.id === focus.card) : undefined;
    const project = focus.project ? items.find((i) => i.id === focus.project) : undefined;
    // projects with workstreams to start: start on one hands them all to the Koordinator
    const projects = items.flatMap((p) => {
      if (p.kind !== 'project') return [];
      const open = items.filter((i) => i.parent === p.id && i.state === 'planned' && !i.queue);
      return open.length ? [`${tag(p.id)} [project] "${p.title}" — planned workstreams not yet started: ${open.map((i) => i.label ?? i.title).join(', ')}`] : [];
    });
    return [
      `Now: ${when(now)}.`,
      ...history,
      ...news,
      input.typed
        ? `The owner typed${focused && input.field ? ` into ${FIELDS[input.field]}` : ''} (as written, no recognition errors): "${transcript}"`
        : `The owner said (speech recognition, may contain errors): "${transcript}"`,
      ...(shots
        ? [
            `The owner attached ${shots === 1 ? 'a screenshot' : `${shots} screenshots`} (shown below). Obeya gives ${shots === 1 ? 'it' : 'them'} to every new_card, new_idea, start, note, answer, feedback and discuss action you take for this message; a title for a new card may say what ${shots === 1 ? 'it shows' : 'they show'}.`,
          ]
        : []),
      focused ? `The owner has this card open, so "it", "this" and a bare answer refer to it: ${describe(focused)}${this.report(focused)}` : project ? `The owner is looking at the project ${tag(project.id)} "${project.title}".` : 'No card is open: the owner speaks to you, the Koordinator.',
      `Cards on the canvas now:\n${relevant.map(describe).join('\n') || '(none)'}`,
      ...(projects.length ? [`Projects with workstreams to start:\n${projects.join('\n')}`] : []),
      `Groups on the canvas: ${groupList.map((g) => `"${g.name}"`).join(', ') || '(none yet)'}`,
      rules.length
        ? `The owner's rules, which every agent follows (follow them yourself too):\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}`
        : 'The owner has recorded no rules yet.',
      `Repositories on this canvas (the first is the default for a new card): ${this.o.board.canvas.repos.map((r) => `${r.id} (${r.name}${r.pullRequests ? `; approved work goes out as a pull request${r.direct ? ', or directly onto main where the owner says so' : ''}` : ''})`).join(', ')}`,
    ].join('\n\n');
  }
}

/** What `act` gets for one action. */
interface ActionArgs {
  do: Action;
  card?: string;
  text?: string;
  title?: string;
  body?: string;
  start?: boolean;
  repo?: string;
  replaces?: number;
  repos?: string[];
  cards?: string[];
  group?: string;
  direct?: boolean;
}

/** How a step of a card's history reads. */
const STEP: Partial<Record<Moment['kind'], string>> = {
  question: 'the agent asked: ',
  answer: 'answer: ',
  review: 'handed over for review: ',
  hint: "the owner's note: ",
  error: 'error: ',
};

/** A queued card's state as the Koordinator reads it. */
function queued(q: Queue, items: Item[]): string {
  if ('checking' in q) return 'queued: the Koordinator checks it for merge conflicts';
  if ('cutting' in q) return 'queued: the Koordinator splits it';
  if ('workspace' in q) return `waits for a free workspace (${q.workspace === 'dirty' ? 'every free one has uncommitted changes' : 'all are leased'}); starts by itself once one is free`;
  const titles = q.behind.map((id) => `"${items.find((i) => i.id === id)?.title ?? id}"`).join(', ');
  return `queued behind ${titles}`;
}

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** A time as the Koordinator reads it: local, to the minute, with the weekday. */
function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Examples of the confirmations the Koordinator speaks, and the owner's words for its cards, per language. */
const CONFIRM: Record<Language, { act: string; words: string; remember: string; retro: string; group: string; configure: string; lookUp: string }> = {
  de: {
    act: '"Neue Aufgabe „Zählerstände als CSV“, der Agent fängt an." / "„Rabatt“ freigegeben, und die Folgeaufgabe „Archiv“ ist angelegt." / "An den Agenten von „Export“ weitergegeben."',
    words: 'In German, a card is an „Aufgabe“ (a follow-up: „Folgeaufgabe“), an idea „Idee“, a project „Projekt“; never say „Karte“. The owner may still say „Karte“ and means the same.',
    remember: '„Gemerkt, gilt ab sofort für alle Agenten.“ / „Kommt in die CLAUDE.md von <repository name>, über die Aufgabe „CLAUDE.md ergänzen“.“',
    retro: '„Ich mache die Arbeitsrückschau für den Shop; Vorschläge erscheinen als Karten.“',
    group: '„„Export“ und „Rabatt“ gehören jetzt zur Gruppe Abrechnung.“',
    configure: '„Das Repository shop-web kommt auf die Leinwand Shop; Obeya startet danach neu.“',
    lookUp: '„Ich schaue im Plan nach.“ / „Moment, ich lese nach, was der Agent bei „…“ tun würde.“',
  },
  en: {
    act: '"New task “Meter readings as CSV”, the agent starts." / "“Discount” approved, and the follow-up “Archive” is created." / "Passed on to the agent of “Export”."',
    words: 'In English, a card is a “task” (a follow-up: “follow-up”), an idea “idea”, a project “project”; never say “card”. The owner may still say “card” and means the same.',
    remember: '“Noted, it applies to all agents from now on.” / “It goes into the CLAUDE.md of <repository name>, through the task “Add to CLAUDE.md”.”',
    retro: '“I am running the work retrospective for the shop; proposals appear as cards.”',
    group: '““Export” and “Discount” now belong to the group Billing.”',
    configure: '“The repository shop-web joins the canvas Shop; Obeya then restarts.”',
    lookUp: '“Let me look at the plan.” / “One moment, I am reading what the agent would do on “…”.”',
  },
};

const system = (language: Language) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents by voice or typing. Each message brings what the owner just said or typed. Speech is transcribed by speech recognition: words may be misheard, so read for what they most likely meant, using the card titles as vocabulary. Typed text stands as written.

This is one ongoing conversation. The owner refers back to it ("the card from before", "no, the other one", "that one too"), and to how the canvas developed: each message says what happened since the previous one, and the first brings your memory of earlier conversations and the canvas's recent history. Card tags (K1, K2, …) stay the same throughout this conversation. No agent works on a planned, live or done card (done: finished without any change to the code, so nothing landed); a workstream of a project takes its state from the project's plan doc (checked off there means live).

For each message, call act, reply or look_up once, then end your turn:
- act, with every action the owner asked for, in their order, on the cards they meant (the open card unless they name another). One sentence may hold several ("gib das frei und mach eine Folgeaufgabe …" is approve and new_card, with the open card as the one it follows up on): leave none out.
- reply, when the owner asks you something you can answer from what you know (the cards, their states and history, this conversation), also about the open card, or when nothing fits or it is unclear which card or what is meant.
- look_up, when the answer needs reading: what an agent would do on a card ("Was würde der Agent hier machen, wenn ich starte?"), what the plan says, how or why something works. Never reply that you cannot know or predict it; look it up. The answer follows in a few seconds.
All three take confirm: one short ${LANGUAGE_NAMES[language]} sentence (two at most for an answer or several actions) the owner hears back, saying what will happen, naming the cards (${CONFIRM[language].act}). No preamble, no questions back unless you use reply.
${CONFIRM[language].words}
Questions about Obeya's configuration (which canvases and repositories it serves, adapters, clones, port) you answer with reply after reading it with config; a change to it the owner asks for is configure.
When the owner wants something kept for all future work ("Merk dir …", "ab jetzt immer …", "nie wieder …"), that is remember, not a note to the open card's agent. Decide where it goes: only a rule on how the agents work with the owner through Obeya, whatever the repository, is one of the owner's rules (no repos); anything about a repository (named, "hier", "in diesem Repo", or about its code, UI, wording, tests, tools or product) goes into that repository's CLAUDE.md: pass repos. Leave the place out of the rule's text, and say in confirm where it went (for a CLAUDE.md: into the repository's card ${MESSAGES[language].quote(MESSAGES[language].claudeMd.title)}, which writes it into the file).
When an agent works on the open card (working, in PR, waiting, waiting for review, or finishing what remains), what the owner says is, in doubt, for that agent: note, or answer when the card has an open question, or feedback when it waits for review. Pass their words as they are; the agent learns whether they were spoken. Talking to the agent ("mach …", "kannst du …", "warum hast du …"), a remark on the work, a question about it ("ist sichergestellt, dass …", "was passiert, wenn …"), a bare answer: all for the agent, which knows its work; never look_up. Only what clearly asks something of Obeya goes elsewhere: approve, stop, start, a follow-up or new card, a new idea, remember, grouping cards, an action on another card, or a question to you about the canvas (reply or look_up).
When the open card is a proposal, what the owner says about it (what should be added, dropped, decided or put differently, or their thoughts on it) is revise with their words, unless they clearly accept or dismiss it or ask for something else.
When the open card is an idea, what the owner says is part of its discussion: act with discuss and their words, unless they clearly ask for an action on it (build, plan_doc, prototype, park, drop). "Mach, was du vorschlägst" on an idea takes the step its agent would take next, as its line says; when that is answering, discuss with its own answers. Wanting to think about something, rather than have it done, is new_idea.
`.trim();

/** Whether an agent is on the card: working on it, waiting for the owner, in a PR, or finishing what remains after the landing. */
const hasAgent = (i: Item) => i.state === 'working' || i.state === 'waiting' || i.state === 'inPr' || !!i.finishing;
