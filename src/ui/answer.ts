// The owner's answer to an agent's questions: the options picked and their own words, as one text.

import type { Question } from '../core/types';
import { oneLine } from '../core/text';

/**
 * One line per answered question (`**question** picks`), then the owner's own words: as in an
 * idea's conversation, which is read later without the questions beside it.
 */
export function answerText(questions: Question[], picks: string[][], words: string): string {
  const lines = questions.flatMap((q, i) => (picks[i]?.length ? [`**${oneLine(q.text)}** ${picks[i]!.join(', ')}`] : []));
  return [lines.join('\n'), words.trim()].filter(Boolean).join('\n\n');
}

/**
 * An answer `answerText` wrote, read back against the questions it may name: the options picked for
 * each question its lines name, and the owner's own words. A text that does not start with such
 * lines, every one of them naming one of `questions` and options of it, picked nothing.
 */
export function readAnswer(text: string, questions: Pick<Question, 'text' | 'options'>[]): { picks: (string[] | undefined)[]; words: string } {
  const none = { picks: [], words: text };
  const [lead = '', ...rest] = text.split('\n\n');
  const picks: (string[] | undefined)[] = [];
  for (const line of lead.split('\n')) {
    const i = questions.findIndex((q) => line.startsWith(`**${oneLine(q.text)}** `));
    const picked = i < 0 ? undefined : chosen(line.slice(oneLine(questions[i]!.text).length + 5), questions[i]!.options);
    if (!picked) return none;
    picks[i] = picked;
  }
  return { picks, words: rest.join('\n\n').trim() };
}

/** The options `answerText` joined into `s`, in any order; undefined if `s` is not made of them. */
function chosen(s: string, options: string[]): string[] | undefined {
  for (const o of options) {
    if (s === o) return [o];
    const more = s.startsWith(`${o}, `) && chosen(s.slice(o.length + 2), options.filter((x) => x !== o));
    if (more) return [o, ...more];
  }
  return undefined;
}

/** Picks one option: a single-choice question holds one (picking it again takes it back), a multiple-choice one any. */
export function toggle(q: Question, picked: string[], option: string): string[] {
  if (picked.includes(option)) return picked.filter((o) => o !== option);
  return q.multiple ? q.options.filter((o) => o === option || picked.includes(o)) : [option];
}

