// A proposal reworked by what the owner said about it: an agent rewrites its text, reason and
// questions in one read-only turn, and the proposal waits for it. What the owner did not touch stays.
// It sees the screenshots the owner showed and picks those that go with the card's task.
// The owner's words on an open proposal come straight to this agent, as to a card's worker, and it
// passes on what asks Obeya for something (`to_obeya`).

import { basename } from 'node:path';
import { z } from 'zod';
import { ownersLanguage } from '../core/locale';
import { formatQuestion, type Item, type Question, type Revising } from '../core/types';
import { BadRequest, type Board } from './board';
import { imageNote, MAX_IMAGES } from './images';
import type { AgentRuntime } from './runtime';
import { readSession } from './coordinator';
import { toObeyaTool } from './to-obeya';
import { messageOf } from '../core/text';
import { PROPOSAL_QUESTIONS, proposalQuestions, proposalTask } from './workers';

export interface RevisionOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the agent may read in: the card's repository. */
  pathFor: (card: Item) => string;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids: string[]) => string[];
  preferences?: () => string;
  /** Passes on to Obeya what the owner's words ask of it (accept the proposal, a rule, another card), with the card in focus. */
  toObeya?: (cardId: string, request: string) => Promise<string>;
  /** The revision is over: the new text stands (`revised`), or the agent ended without one and the old text stays. */
  onRevised?: (cardId: string, revised: boolean) => void;
}

/** A proposal as the agent writes it back. */
interface Revised {
  title: string;
  task: string;
  reason?: string;
  idea?: boolean;
  questions: { question: string; options?: string[]; multiple?: boolean }[];
  /** The screenshots that go with the card's task, by file name; none given: those that go with it now. */
  images?: string[];
  /** Its turn in the conversation: the answer to what the owner asked, and what changed. */
  reply?: string;
}

export class Revisions {
  /** Proposals being reworked, so a resume does not start a second agent. */
  private busy = new Set<string>();

  constructor(private o: RevisionOptions) {}

  /**
   * The owner's words on a proposal (`said`: the line of the log with them; `images`: the
   * screenshots with them): it waits while an agent reworks it by them. Said while it is reworked,
   * they wait for the rework after it.
   */
  revise(cardId: string, words: string, spoken: boolean, said?: number, images: string[] = []) {
    if (!this.o.board.revising(cardId, words, spoken, said, images)) this.run(cardId);
  }

  /** The owner takes back words that wait for the next rework: they leave the conversation, and no agent hears them. */
  unsay(cardId: string, id: number) {
    if (!this.o.board.unread(cardId, id) || !this.o.board.unrevise(cardId, id)) throw new BadRequest('notHeld', 'the agent has read these words already');
    this.o.board.withdraw(cardId, id);
  }

  /** After a restart: proposals still being reworked are reworked again. */
  resume() {
    for (const i of this.o.board.items()) if (i.proposal?.revising) this.run(i.id);
  }

  private run(cardId: string) {
    if (this.busy.has(cardId)) return;
    const card = this.o.board.item(cardId);
    const said = card?.proposal?.revising;
    if (!card || !said) return;
    this.busy.add(cardId);
    this.o.board.readNow(cardId, said.said ?? []);
    const shots = this.shots(card, said);
    this.ask(card, said, shots)
      .then(
        (r) => {
          // the words only asked Obeya for something: the proposal stays as it was, and what Obeya did stands in its conversation
          if (!r) return this.o.board.revised(cardId) || undefined;
          const questions = proposalQuestions(r.questions);
          // of the screenshots it saw, those it names; naming none of them keeps what went with the task
          const images = r.images && [...new Set(r.images.map((f) => basename(String(f))))].filter((id) => shots.all.includes(id)).slice(0, MAX_IMAGES);
          const p = { title: r.title, task: r.task, ...(r.reason?.trim() ? { reason: r.reason.trim() } : {}), idea: !!r.idea, questions, ...(images ? { images } : {}) };
          if (!this.o.board.revised(cardId, p)) return;
          const reply = r.reply?.trim();
          if (reply) this.o.board.log(cardId, 'talk', 'worker', reply.slice(0, 4000));
          if (changed(card, p)) this.o.board.log(cardId, 'state', 'coordinator', this.o.board.t.coordinator.revised);
          // a question asked anew stands in the conversation from now on; one it kept stands where it was asked
          const asked = new Set(card.proposal!.questions.map(key));
          for (const q of questions) if (!asked.has(key(q))) this.o.board.log(cardId, 'question', 'worker', formatQuestion(q, this.o.board.language()));
          return true;
        },
        (e) => {
          if (!this.o.board.revised(cardId)) return;
          this.o.board.log(cardId, 'error', 'coordinator', this.o.board.t.coordinator.reviseFailed(messageOf(e)));
          return false;
        },
      )
      .then((revised) => revised !== undefined && this.o.onRevised?.(cardId, revised))
      .catch((e) => console.error('revision:', e))
      .finally(() => {
        this.busy.delete(cardId);
        // what the owner said meanwhile is reworked in by the next
        this.run(cardId);
      });
  }

  /**
   * The screenshots the agent sees, by id: those with the words it reworks the proposal by
   * (`said`), those that go with its task now (`kept`), and those the owner showed before in its
   * conversation (`earlier`); `all` of them, at most twice a message's worth.
   */
  private shots(card: Item, said: Revising) {
    const shown = this.o.board.events(card.id).flatMap((e) => (e.author === 'owner' && !e.unread ? (e.images ?? []) : []));
    const all = [...new Set([...(said.images ?? []), ...(card.images ?? []), ...shown.reverse()])].filter((id) => this.o.imageFiles?.([id]).length).slice(0, 2 * MAX_IMAGES);
    const kept = (card.images ?? []).filter((id) => all.includes(id));
    return { all, said: all.filter((id) => said.images?.includes(id)), kept, earlier: all.filter((id) => !said.images?.includes(id) && !kept.includes(id)) };
  }

  /** The reworked proposal, or null when the agent only passed the words on to Obeya. */
  private async ask(card: Item, said: Revising, shots: ReturnType<Revisions['shots']>): Promise<Revised | null> {
    let revised: Revised | undefined;
    let passed = false;
    const toObeya = this.o.toObeya;
    const error = await readSession(this.o.runtime, {
      cwd: this.o.pathFor(card),
      role: 'coordinator',
      spendOn: card.id,
      // the proposal waits on, and shows until when
      onLimit: (until) => this.o.board.waitsForLimit({ card: card.id }, until),
      system: [SYSTEM, this.o.toObeya ? TO_OBEYA : '', this.o.preferences?.() ?? ''].filter(Boolean).join('\n\n'),
      tools: (finish) => [
        {
          name: 'revise_proposal',
          description: [
            `The whole proposal as it is to stand now, in the owner's language. ${ownersLanguage(this.o.board.conversation())}`,
            `title: short and precise. ${proposalTask('the card it came from nor this conversation')}`,
            `reason: for the owner only, why it is proposed, a sentence or two (keep it unless what the owner said changes it). idea: true for something to think through with the owner before anyone builds it.`,
            `questions: what the owner still has to decide, each with up to four short options; keep them out of task. A question the owner's words settle goes, and its decision goes into task.`,
            `reply: your turn in the conversation beside the proposal, a sentence or two for the owner: the answer to what they asked (asked which option you would take: your pick and why), and what you changed, without repeating the text.`,
            shots.all.length
              ? `images: the file names of the screenshots shown to you that go with the card's task, for the agent who takes it on to see: one that shows what the task is about goes; one the owner's words make obsolete, or that only went with a question you answered, does not. Leave it out to keep those that go with it now.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          schema: {
            title: z.string(),
            task: z.string(),
            reason: z.string().optional(),
            idea: z.boolean().optional(),
            questions: PROPOSAL_QUESTIONS,
            reply: z.string(),
            ...(shots.all.length ? { images: z.array(z.string()).optional() } : {}),
          },
          run: (r) => {
            if (revised) return 'Only the first one counts.';
            if (!String(r.title).trim() || !String(r.task).trim()) return 'Not recorded: title and task must not be empty.';
            revised = r as unknown as Revised;
            return finish('Recorded. End your turn now.');
          },
        },
        ...(toObeya
          ? [
              toObeyaTool((request) => {
                passed = true;
                return toObeya(card.id, request);
              }),
            ]
          : []),
      ],
      brief: this.message(card, said, shots),
      images: this.o.imageFiles?.(shots.all) ?? [],
    });
    if (revised) return revised;
    if (error !== undefined) throw new Error(error);
    if (passed) return null;
    throw new Error('der Agent hat keinen neuen Text geliefert');
  }

  private message(card: Item, said: Revising, shots: ReturnType<Revisions['shots']>): string {
    const p = card.proposal!;
    const from = card.from ? this.o.board.item(card.from) : undefined;
    const summary = from ? this.o.board.summary(from.id)?.trim() : undefined;
    return [
      `The proposal as it stands${p.idea ? ' (proposed as an idea)' : ''}:\n\n<title>${card.title}</title>\n\n<task>\n${card.body}\n</task>`,
      p.reason ? `Why it was proposed (for the owner only): ${p.reason}` : '',
      card.retro ? `The work retrospective proposed it, resting on: ${card.retro}` : '',
      p.questions.length
        ? `Its questions to the owner:\n${p.questions.map((q) => `- ${q.text}${q.options.length ? ` (options: ${q.options.join(' / ')}${q.multiple ? '; several may be chosen' : ''})` : ''}`).join('\n')}`
        : 'It has no questions to the owner.',
      from ? `It came from the card "${from.title}"${summary ? `, whose worker handed over:\n\n${summary}` : '.'}` : '',
      `What the owner ${said.spoken ? 'said about it (speech recognition, may contain errors)' : 'wrote about it'}:\n\n<owner>\n${said.words}\n</owner>${imageNote(shots.said)}`,
      shots.all.length
        ? [
            shots.kept.length ? `Screenshots that go with the card's task now: ${shots.kept.join(', ')}.` : `No screenshot goes with the card's task now.`,
            shots.earlier.length ? `Screenshots the owner showed earlier in this conversation, which do not go with it: ${shots.earlier.join(', ')}.` : '',
            `All of them are shown below, in this order: ${shots.all.join(', ')}.`,
          ]
            .filter(Boolean)
            .join(' ')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

/** A question as the conversation holds it. */
const key = (q: Question) => JSON.stringify([q.text, q.options, !!q.multiple]);

/** Whether the proposal reads otherwise now: words that only asked something leave it as it was. */
function changed(card: Item, p: { title: string; task: string; reason?: string; idea: boolean; questions: Question[]; images?: string[] }): boolean {
  const was = card.proposal!;
  return (
    (!!p.images && JSON.stringify(p.images) !== JSON.stringify(card.images ?? [])) ||
    p.title !== card.title ||
    p.task !== card.body ||
    (p.reason ?? '') !== (was.reason ?? '') ||
    p.idea !== !!was.idea ||
    JSON.stringify(p.questions.map(key)) !== JSON.stringify(was.questions.map(key))
  );
}

const TO_OBEYA =
  "Some of the owner's words ask Obeya rather than you: accept the proposal (and start it), dismiss it, a new card, a rule to remember, an action on another card, a question about the canvas or another card. Pass those on with to_obeya: Obeya does them as the owner meant, with a confirmation the owner can take back. When that is all they said, revise_proposal is not needed.";

const SYSTEM = `
You rework a card an agent proposed on Obeya, a canvas on which the owner directs coding agents. The owner read the proposal and spoke to you about it: what to add, drop, decide or put differently, or a question. Rewrite the proposal by their words: what they did not touch stays as it was, in its wording; what they said goes in, as they meant it, in the card's text and not as a quote of them. What they only asked (which option you would take, what something means) you answer in your reply; the decision stays theirs, so the proposal stays as it was there. Spoken words may be misheard: read them for what they most likely meant.
The card's text is all the agent who takes it on gets, so it must stand on its own. Read in the repository only where the owner's words need it (a file, a name they mention). Then call revise_proposal once with the whole proposal and your reply, and end your turn. You cannot change files.
`.trim();
