// The owner's answer to an agent's questions: the options picked and their own words, as one text.

import type { Question } from '../core/types';

/**
 * One line per answered question (`**question** picks`), then the owner's own words. A single
 * question is answered with its picks alone unless `quote`, as in an idea's conversation, which
 * is read later without the question beside it.
 */
export function answerText(questions: Question[], picks: string[][], words: string, quote = false): string {
  const answered = questions.map((q, i) => [q, picks[i] ?? []] as const).filter(([, p]) => p.length);
  const lines =
    answered.length === 1 && questions.length === 1 && !quote
      ? [answered[0]![1].join(', ')]
      : answered.map(([q, p]) => `**${oneLine(q.text)}** ${p.join(', ')}`);
  return [lines.join('\n'), words.trim()].filter(Boolean).join('\n\n');
}

/** Picks one option: a single-choice question holds one (picking it again takes it back), a multiple-choice one any. */
export function toggle(q: Question, picked: string[], option: string): string[] {
  if (picked.includes(option)) return picked.filter((o) => o !== option);
  return q.multiple ? q.options.filter((o) => o === option || picked.includes(o)) : [option];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
