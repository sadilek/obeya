// Where the caption's pointer is: the words of a voiced sentence lined up with what speech
// recognition heard of it, and where a slide's items show as the narration reaches them.

import { describe, expect, test } from 'bun:test';
import { estimatedStarts, heardStarts, itemStarts, mentions, type Slide } from './walkthrough';

describe('the words of a voiced sentence', () => {
  test('start where recognition heard them, also a word it wrote otherwise', () => {
    const heard: [string, number][] = [[' The', 0.1], [' wor', 0.32], ['ker', 0.56], [' com', 0.72], ['mits', 0.88], [',', 1.1], [' and', 1.2], [' Ob', 1.4], ['ia', 1.6], [' lands', 1.8], ['.', 2.3]];
    expect(heardStarts('The worker commits, and Obeya lands.', heard, 2.5)).toEqual([0.1, 0.32, 0.72, 1.2, 1.4, 1.8]);
  });

  test('a compound heard apart starts at its first part, and a word not heard at all between its neighbours', () => {
    expect(heardStarts('Der Kastenlast hält.', [[' Der', 0], [' Kasten', 0.4], [' Last', 0.9], [' hält', 1.4]], 2)).toEqual([0, 0.4, 1.4]);
    const skipped = heardStarts('One two three four.', [[' One', 0], [' four', 1.2]], 1.6);
    expect(skipped[0]).toBe(0);
    expect(skipped[3]).toBe(1.2);
    expect(skipped[1]).toBeGreaterThan(0);
    expect(skipped[2]).toBeGreaterThan(skipped[1]!);
    expect(skipped[2]).toBeLessThan(1.2);
  });

  test('without anything heard, start by their length', () => {
    expect(heardStarts('Short and a much longer word.', [], 3)).toEqual(estimatedStarts('Short and a much longer word.', 3));
    const est = estimatedStarts('a extraordinarily b', 3);
    expect(est[0]).toBe(0);
    expect(est[2]! - est[1]!).toBeGreaterThan(est[1]! - est[0]!);
  });
});

describe("a slide's items as the narration reaches them", () => {
  const flow: Slide = {
    type: 'flow',
    title: 'Landing',
    steps: [{ label: 'Approve' }, { label: 'Rebase onto main' }, { label: 'Checks' }, { label: 'Merged' }],
    parts: ['Once you approve the card, Obeya rebases its branch onto main.', 'Then the checks run, and it is merged.'],
  };

  test('show where the narration first names them, in their order', () => {
    expect(mentions(flow)).toEqual([
      { part: 0, word: 2 },
      { part: 0, word: 6 },
      { part: 1, word: 2 },
      { part: 1, word: 7 },
    ]);
  });

  test('by the words that tell them apart, not those they share', () => {
    const shared: Slide = {
      type: 'flow',
      title: 'Pull requests',
      steps: [{ label: 'Open pull request' }, { label: 'Review pull request' }, { label: 'Merge pull request' }],
      parts: ['Someone opens a pull request.', 'A colleague reviews it.', 'Then it is merged.'],
    };
    expect(mentions(shared)).toEqual([
      { part: 0, word: 1 },
      { part: 1, word: 2 },
      { part: 2, word: 3 },
    ]);
  });

  test('the first shows with the slide, one never named between its neighbours', () => {
    expect(itemStarts(flow, (part, word) => part * 10 + word, (part) => part * 10, 20)).toEqual([0, 6, 12, 17]);
    const unnamed: Slide = { ...flow, steps: [{ label: 'Queue' }, { label: 'Rebase' }, { label: 'Wait' }, { label: 'Merged' }] };
    const at = (part: number, word: number) => part * 10 + word;
    expect(itemStarts(unnamed, at, (part) => part * 10, 20)).toEqual([0, 6, 11.5, 17]);
  });

  test('with a narration in parts, show with their part', () => {
    const parted: Slide = { type: 'points', title: 'Two', points: ['a', 'b'], parts: ['First.', 'Also first.', 'Second.'], items: [0, 0, 1] };
    expect(itemStarts(parted, (part, word) => part * 2 + word + 0.3, (part) => part * 2, 6)).toEqual([0, 4]);
  });
});
