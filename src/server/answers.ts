// Questions the Koordinator looks up: what it cannot answer in its quick reading of a command (what
// an agent would do on a card, what the plan says) goes to an agent that takes the time to read.
// A workstream's question goes to its project agent, any other to a thorough Koordinator turn. The
// answer comes later: in full in the log of the card that was open (else in the Koordinator's
// sheet), and summed up aloud.

import type { Item } from '../core/types';
import { INFORM_RULES, inform, type OwnerAnswer } from './advisor';
import type { Board } from './board';
import type { AgentRuntime } from './runtime';
import { describeTool } from './workers';

export interface AnswerOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the answer is read from: the card's repository, or the canvas's home. */
  pathFor: (card: Item | undefined) => string;
  /** The task the card's worker gets at its start. */
  startBrief: (card: Item) => string | undefined;
  /** The project agent of a project answers what is asked about it and its workstreams. */
  projectAgent: (project: Item) => { inform: (project: Item, message: string, onTool?: (name: string, input: Record<string, unknown>) => void) => Promise<OwnerAnswer> };
  preferences?: () => string;
  /** The answer is in: the Koordinator hears it with the owner's next command. */
  onAnswer?: (question: string, answer: string) => void;
}

/** Log lines of a card the answering agent reads. */
const LOG_LINES = 25;

export class Answers {
  /** Exchanges being looked up, so a resume does not ask twice. */
  private busy = new Set<number>();

  constructor(private o: AnswerOptions) {}

  /** Looks up the question of an exchange with the Koordinator. */
  lookUp(talkId: number) {
    if (this.busy.has(talkId)) return;
    const t = this.o.board.exchange(talkId);
    if (!t?.question || t.answer !== undefined) return;
    this.busy.add(talkId);
    const about = t.about ? this.o.board.item(t.about) : undefined;
    const project = about?.kind === 'project' ? about : about?.parent ? this.o.board.item(about.parent) : undefined;
    const by = project?.plan ? 'project' : 'koordinator';
    const reading = t.cardId && this.o.board.item(t.cardId) ? t.cardId : undefined;
    // what it reads shows on the open card, as an exploration agent's reading does
    const onTool = (name: string, input: Record<string, unknown>) => {
      if (reading && !name.startsWith('mcp__')) this.o.board.log(reading, 'activity', by, describeTool(name, input));
    };
    const message = this.message(t.said, t.question, about, project);
    const asked =
      by === 'project'
        ? this.o.projectAgent(project!).inform(project!, message, onTool)
        : inform({
            runtime: this.o.runtime,
            cwd: this.o.pathFor(about),
            effort: 'medium',
            system: `You are the Koordinator of Obeya, a canvas on which the owner directs coding agents.\n\n${INFORM_RULES}`,
            message: [message, this.o.preferences?.() ?? ''].filter(Boolean).join('\n\n'),
            onTool,
          });
    asked
      .then((a) => this.deliver(talkId, by, t.question!, a, reading))
      .catch((e) =>
        this.deliver(talkId, by, t.question!, { text: `Ich konnte die Frage nicht beantworten (${e instanceof Error ? e.message : String(e)}).`, spoken: 'Ich konnte die Frage nicht beantworten.' }, reading),
      )
      .finally(() => this.busy.delete(talkId));
  }

  /** After a restart: questions still being looked up are looked up again. */
  resume() {
    for (const id of this.o.board.lookingUp()) this.lookUp(id);
  }

  private deliver(talkId: number, by: 'koordinator' | 'project', question: string, a: OwnerAnswer, card: string | undefined) {
    const text = clip(a.text || a.spoken, 12000);
    this.o.board.answerTalk(talkId, text, by);
    if (card && this.o.board.item(card)) this.o.board.log(card, 'say', by, text);
    const spoken = a.spoken || (text.length <= 300 ? text : '');
    if (spoken) this.o.board.speak(undefined, clip(spoken, 400));
    this.o.onAnswer?.(question, text);
  }

  private message(said: string, question: string, about: Item | undefined, project: Item | undefined): string {
    const parts = [`The owner said: "${said}"`, `The question, as the Koordinator understood it: ${question}`];
    if (about && about.kind !== 'project') {
      const state = about.queue ? 'planned, queued' : about.need ? `${about.state}: ${about.need}` : about.state;
      parts.push(
        [
          `It is about the ${about.kind} "${about.title}"${about.label ? ` (workstream ${about.label} of the project "${project?.title ?? ''}")` : ''}, state ${state}.`,
          about.statusLine ? `Its last status line: ${about.statusLine}` : '',
          about.question ? `Its open question: ${about.question.text}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const brief = ['planned', 'proposal', 'working', 'waiting', 'inPr', 'approved'].includes(about.state) ? this.o.startBrief(about) : undefined;
      if (brief)
        parts.push(
          `${about.state === 'planned' || about.state === 'proposal' ? 'The task its worker would get if the owner started it now' : 'The task its worker got at its start'} (the worker also follows the repository's CLAUDE.md and docs):\n\n<task>\n${brief}\n</task>`,
        );
      const log = this.o.board
        .events(about.id)
        .filter((e) => e.kind !== 'activity')
        .slice(-LOG_LINES);
      if (log.length) parts.push(`The card's log, latest last:\n${log.map((e) => `- ${e.at.slice(0, 16)} ${e.author} (${e.kind}): ${clip(e.text, 300)}`).join('\n')}`);
    } else if (project) parts.push(`It is about the project "${project.title}".`);
    if (project?.plan) parts.push(`The project's plan doc: ${project.plan.file}.`);
    return parts.join('\n\n');
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
