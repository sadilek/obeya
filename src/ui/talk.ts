// An idea's conversation, from its card's events.

import type { CardEvent } from '../core/types';

/**
 * An idea's events as its conversation: the owner's and the agent's messages and what else stands
 * between them, each reply with the steps that led to it; `pending` are the steps of a turn
 * without reply yet.
 */
export function talkTurns(events: CardEvent[]): { shown: { e: CardEvent; steps: CardEvent[] }[]; pending: CardEvent[] } {
  const shown: { e: CardEvent; steps: CardEvent[] }[] = [];
  let steps: CardEvent[] = [];
  for (const e of events) {
    if (e.author === 'explorer' && (e.kind === 'activity' || e.kind === 'say' || e.kind === 'state')) steps.push(e);
    else if (e.kind === 'talk' && e.author === 'explorer') {
      // a turn that ended without a reply took its last words as the reply
      shown.push({ e, steps: steps.filter((s) => !(s.kind === 'say' && s.text === e.text.trim())) });
      steps = [];
    } else if (e.kind === 'talk' || e.kind === 'error' || (e.kind === 'state' && e.author !== 'obeya')) shown.push({ e, steps: [] });
  }
  return { shown, pending: steps };
}
