// What the agents that answer the owner's questions (the Coordinator, a project agent) share, and
// how an agent's question to the owner is put together.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { type Language, ownersLanguage } from '../core/locale';
import type { AnswerFile, Question } from '../core/types';
import { type AgentRuntime, type AgentTool, BackgroundWait, type OnLimit } from './runtime';
import { clip, oneLine } from '../core/text';

/** An answer to a question the owner asked, for the card or the sheet, with the files it comes with. */
export interface OwnerAnswer {
  text: string;
  files?: AnswerFile[];
}

export interface Briefing {
  runtime: AgentRuntime;
  cwd: string;
  system: string;
  message: string;
  resume?: string;
  /** The session's id and the model it runs on (`AgentEvent` `session`). */
  onSession?: (id: string, model?: string) => void;
  /** The card the agent answers for (a project's agent), whose cost it counts to (`AgentSpec.spendOn`). */
  spendOn?: string;
  /** What the agent reads, as it reads it. */
  onTool?: (name: string, input: Record<string, unknown>) => void;
  /** The owner's conversation language: the answer's, unless the owner's words are in another (`ownersLanguage`). */
  language: Language;
  /** The workers' permission mode: the answering agent has their tools and runs as they do. */
  permissionMode?: PermissionMode;
  /** The output directory of the thread: the answer may come with files in it. */
  dir?: string;
  /** Tools besides answer_owner (to_obeya, on a Question card). */
  tools?: AgentTool[];
  /** Screenshot files that come with the message. */
  images?: string[];
  /** Ends the turn at once, its session with it (the owner paused the agent): the answer fails with `Interrupted`. */
  signal?: AbortSignal;
  /** Where the answer shows that it waits for the account's usage limit, until when; nothing once it goes on (`AgentSpec.onLimit`). */
  onLimit: OnLimit;
  /** How long a turn waits for background work that has ended to wake it, and for work that still runs (ms). */
  backgroundGrace?: number;
  backgroundLimit?: number;
  /**
   * The turn starts waiting for its background work, with `pass` to put the owner's words into its
   * session at once (its answer answers them too), or stops waiting (`undefined`): it goes on, or ends.
   */
  onWaiting?: (pass: ((text: string, images: string[]) => void) | undefined) => void;
  /**
   * The turn takes the owner's words while it reads (`hear`, at its start): they reach the agent with
   * its next step's result, or wake it while it waits for its background work, and answer_owner takes
   * no answer before the agent has them, so its one answer answers them too. `hear` returns false once
   * the answer is given: the words come too late for this turn. Else it returns how to take them
   * back, which works until the agent has them (true then); `heard` is told when it gets them.
   */
  onHearing?: (hear: Hear) => void;
}

/** How a turn takes the owner's words while it reads (`Briefing.onHearing`). */
export type Hear = (words: string, heard?: () => void) => false | (() => boolean);

/** A turn that answered nothing because it was ended on purpose (`Briefing.signal`). */
export class Interrupted extends Error {
  constructor() {
    super('interrupted');
  }
}

/**
 * A turn that answers the owner's question, with a worker's tools (the shell, the web) so it can
 * check what it says; a turn that ends without the tool answers with its last words. A turn that
 * ends while its background work runs (a download, a long query) is not over: that work wakes the
 * agent, which goes on and answers then; the owner's words meanwhile go in at once (`onWaiting`).
 * Should it never wake it, its last words are the answer after all, with the workers' limits.
 */
export function inform(b: Briefing): Promise<OwnerAnswer> {
  return new Promise((resolve, reject) => {
    if (b.signal?.aborted) return reject(new Interrupted());
    let answer: OwnerAnswer | null = null;
    let last = '';
    let closed = false;
    const settle = (a: OwnerAnswer) => {
      if (answer) return 'Only the first answer counts.';
      answer = a;
      resolve(a);
      return 'Delivered. End your turn now.';
    };
    const close = () => {
      closed = true;
      work.stop();
      session.close();
    };
    const over = () => {
      close();
      if (answer) return;
      if (last.trim()) settle({ text: last.trim() });
      else reject(new Error('no answer'));
    };
    const pass = (text: string, images: string[]) => {
      work.stop();
      session.send(text, images);
    };
    // the owner's words the agent has not had yet (`onHearing`), and how it gets them
    const added: { words: string; heard?: () => void }[] = [];
    const take = () => {
      if (!added.length) return undefined;
      const now = added.splice(0);
      for (const w of now) w.heard?.();
      return now.map((w) => w.words).join('\n\n');
    };
    // words a step brought that the agent wrote nothing after yet: an answer_owner it called in the
    // same message as that step (tools run in parallel) was written before it had them
    let unseen: string | undefined;
    const stepTakes = () => {
      const words = answer ? undefined : take();
      if (words) unseen = unseen ? `${unseen}\n\n${words}` : words;
      return words;
    };
    const hear: Hear = (words, heard) => {
      if (answer || closed) return false;
      const w = { words, ...(heard ? { heard } : {}) };
      added.push(w);
      // waiting for its background work, the agent has no next step: the words start its next turn
      if (work.waiting && work.running > 0) pass(take()!, []);
      return () => {
        const i = added.indexOf(w);
        if (i < 0) return false;
        added.splice(i, 1);
        return true;
      };
    };
    // words go in while the work runs; once it ended, it is about to wake the agent, and they wait for the next turn
    const told = () => b.onWaiting?.(work.waiting && work.running > 0 ? pass : undefined);
    const work = new BackgroundWait(over, { grace: b.backgroundGrace, limit: b.backgroundLimit }, told);
    const session = b.runtime.start(
      {
        cwd: b.cwd,
        role: 'coordinator',
        ...(b.permissionMode ? { permissionMode: b.permissionMode } : {}),
        ...(b.resume ? { resume: b.resume } : {}),
        ...(b.spendOn ? { spendOn: b.spendOn } : {}),
        ...(b.dir ? { dirs: [b.dir] } : {}),
        system: `${b.system}\n\n${ownersLanguage(b.language)}`,
        onLimit: b.onLimit,
        tools: [
          {
            name: 'answer_owner',
            description: `Your answer to the owner, in the owner's language: text in full (markdown, short paragraphs or a list; it stands in the card's log).${b.dir ? ` files: files of yours in ${b.dir} the answer comes with (in the owner's language too), each with its path and a one-line caption in the owner's language; the owner sees them under the text (a page or an image shown inline, any other file to open).` : ''}`,
            schema: b.dir ? { text: z.string(), files: z.array(z.object({ path: z.string(), caption: z.string() })).max(MAX_FILES).optional() } : { text: z.string() },
            run: ({ text, files }) => {
              const unheard = answer ? undefined : [unseen, take()].filter(Boolean).join('\n\n');
              unseen = undefined;
              if (unheard) return `Nothing was shown yet: ${unheard}\n\nCall answer_owner again with an answer that answers this too.`;
              if (!b.dir || files === undefined) return settle({ text: String(text).trim() });
              const checked = answerFiles(b.dir, files);
              if (typeof checked === 'string') return `${checked} Nothing was shown yet: call answer_owner again.`;
              return settle({ text: String(text).trim(), ...(checked.length ? { files: checked } : {}) });
            },
          },
          ...(b.tools ?? []),
        ],
        ...(b.onHearing ? { contextUpdate: stepTakes } : {}),
        onEvent: (e) => {
          // what a failed session still reports after its error
          if (closed) return;
          if (e.type === 'background') {
            work.changed(e.tasks.length);
            if (work.waiting) told();
            return;
          }
          // a turn may also start without a message (finished background work)
          work.stop();
          if (e.type === 'text' || e.type === 'tool') unseen = undefined;
          if (e.type === 'session') b.onSession?.(e.id, e.model);
          else if (e.type === 'text') last = e.text;
          else if (e.type === 'tool') b.onTool?.(e.name, e.input);
          else if (e.type === 'error' && !answer) {
            close();
            reject(new Error(e.message));
          } else if (e.type === 'idle') {
            work.running = e.background ?? 0;
            // the turn ended without the words passed in at its end: they start the turn that answers
            const unheard = answer ? undefined : take();
            if (unheard) {
              session.send(unheard);
              return work.start();
            }
            // a message still to come (words passed in as the agent woke) starts the turn that answers
            if (!answer && (work.running > 0 || e.more)) work.start();
            else over();
          }
        },
      },
      b.message,
      b.images,
    );
    b.onHearing?.(hear);
    b.signal?.addEventListener('abort', () => {
      close();
      if (!answer) reject(new Interrupted());
    });
  });
}

/** Files one answer comes with, at most. */
const MAX_FILES = 20;

/**
 * The files an answer names, as paths in its thread's output directory (absolute, or relative to
 * it); what is wrong with them instead, for the agent to fix: a path outside the directory, or no file.
 */
export function answerFiles(dir: string, list: unknown): AnswerFile[] | string {
  const root = resolve(dir);
  const files: AnswerFile[] = [];
  const wrong: string[] = [];
  for (const f of (Array.isArray(list) ? list : []) as { path?: unknown; caption?: unknown }[]) {
    const path = String(f?.path ?? '').trim();
    const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (!full.startsWith(root + sep)) wrong.push(`${path} is not in ${root}`);
    else if (!existsSync(full) || !statSync(full).isFile()) wrong.push(`${path} is no file`);
    else {
      const name = relative(root, full).split(sep).join('/');
      if (!files.some((x) => x.name === name)) files.push({ name, caption: clip(oneLine(String(f?.caption ?? '')), 200) });
    }
  }
  return wrong.length ? `${wrong.join('; ')}: the files of an answer are in its output directory ${root}.` : files;
}

/** How to answer a question of the owner's, the same for every agent that answers one. */
export const INFORM_RULES = `
The owner asked a question about the canvas, spoken or typed. Obeya's quick reading of every command could not answer it from the cards alone and passed it to you; the owner heard that the answer comes in a moment. Take the time to look it up: the repository's docs and plan docs, CLAUDE.md, the code, and what the message gives you. You have the tools a worker has: what the answer depends on beyond the text (the git history, files on this machine and their dates, a release, pull request or CI run on GitHub with gh, a page on the web), check rather than guess.
- "What would the agent do on this card?": the message holds the task the card's worker gets at its start. Derive from it, the plan doc and the repository's instructions the concrete steps the worker would take, in order, and what it would ask the owner. Say what it would change, and where the plan leaves it open.
- Answer what was asked, concretely and grounded in what you read; name the source (plan doc section, file). Say where you are guessing. Never answer that you cannot know: say what the sources say.
- The owner does not read code: no code blocks, file paths only where they help.
Read and check what you need, then call answer_owner exactly once and end your turn.
`.trim();

/**
 * A question from an agent's tool call, as the owner gets it: the options the card offers to choose
 * from (the owner can always write something else), several of them when `multiple`. Its text may be
 * long (a script to read over, a draft to check): the bound only stops a runaway, like an idea
 * agent's answer.
 */
export function toQuestion(text: unknown, options: unknown, multiple?: unknown): Question {
  const opts = [...new Set((Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean))];
  return { text: clip(String(text).trim(), 12000), options: opts, ...(multiple === true && opts.length > 1 ? { multiple: true } : {}) };
}

/** A question as an agent asks it through a tool: with its own pick, the options it would choose if it had to decide, and why. */
export interface Asked {
  question: string;
  options?: string[];
  multiple?: boolean;
  pick?: string[];
  pick_why?: string;
}

/** A question as the card shows it, with the agent's own pick when that names its options. */
export function withPick(a: Asked): Question {
  const q = toQuestion(a.question, a.options, a.multiple);
  const picked = (a.pick ?? []).map((o) => String(o).trim()).filter((o) => q.options.includes(o));
  const options = q.multiple ? [...new Set(picked)] : picked.slice(0, 1);
  return options.length ? { ...q, pick: { options, why: clip(String(a.pick_why ?? '').trim(), 400) } } : q;
}


/** The decisions so far, as an agent reads them. */
export function decisionLog(decisions: { question: string; answer: string; by: string }[]): string {
  return decisions.length
    ? decisions.map((d) => `- ${d.question.split('\n')[0]} → ${d.answer} (${d.by === 'owner' ? 'owner' : 'an agent'})`).join('\n')
    : '(none yet)';
}
