// A card an agent proposes (a worker's `propose_card`, the revision of a proposal): its questions
// and its task as the agent gives them, and what became of one the agent took back.

import { z } from 'zod';
import { toQuestion } from './advisor';
import type { Retracted } from './board';

/** The questions of a proposal (`propose_card`, `revise_proposal`) as the agent gives them. */
export const PROPOSAL_QUESTIONS = z.array(z.object({ question: z.string(), options: z.array(z.string()).max(4).optional(), multiple: z.boolean().optional() })).max(5);

/** The questions of a proposal as the card holds them. */
export const proposalQuestions = (questions: z.infer<typeof PROPOSAL_QUESTIONS> = []) => questions.map((q) => toQuestion(q.question, q.options, q.multiple));

/** What became of a proposal the worker took back (`replaced`: by a new one), as it reads it. */
export const retractedText = (r: Retracted, replaced: boolean): string => {
  if (r.kind === 'unknown')
    return `No proposal of yours is called so${replaced ? ', so nothing was replaced' : '; nothing was withdrawn'}. Yours: ${r.mine.length ? r.mine.map((m) => `“${m.title}” (${m.gone ? 'removed' : m.state})`).join(', ') : 'none'}.`;
  const it = `“${r.title}”`;
  switch (r.kind) {
    case 'gone':
      return `${it} was still open and is gone from the canvas.`;
    case 'marked':
      return `The owner had taken ${it} on already (${r.state}): Obeya marks it as ${replaced ? 'replaced' : 'withdrawn'} and offers the owner to remove it.`;
    case 'finished':
      return `${it} is done already (${r.state}); it stays as it is.`;
    case 'dismissed':
      return `The owner had dismissed ${it} already.`;
    case 'removed':
      return `The owner had removed ${it} already.`;
    case 'already':
      return `${it} was withdrawn already.`;
  }
};

/** How an agent writes a proposal's task, for the agent who takes it on and has not seen `unseen`. */
export const proposalTask = (unseen: string) =>
  `task: the card's text, written for the agent who will take it on, which has seen neither ${unseen}: what is wrong or wanted, where (files, names), what done looks like. Write it as the owner would write a card: no "I", no "my question", no "your card"; name other cards by their title.`;
