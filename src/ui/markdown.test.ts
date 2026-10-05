import { describe, expect, test } from 'bun:test';
import { blocks } from './markdown';

describe('plan docs as documents', () => {
  test('headings, paragraphs joined across lines, rules, quotes and code', () => {
    const md = '# Title\n\n## Goal\n\nOne line\nwrapped.\n\n> A quote\n> on two lines.\n\n---\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n<!-- a comment -->\nAfter.\n';
    expect(blocks(md)).toEqual([
      { t: 'h', level: 1, text: 'Title' },
      { t: 'h', level: 2, text: 'Goal' },
      { t: 'p', text: 'One line wrapped.' },
      { t: 'quote', text: 'A quote on two lines.' },
      { t: 'hr' },
      { t: 'code', text: 'const a = 1;\n\nconst b = 2;' },
      { t: 'p', text: 'After.' },
    ]);
  });

  test('a checklist with wrapped items and nested sub-items, across a blank line', () => {
    const md = [
      '- [x] **W1:** Parser. Reads the doc',
      '  and its workstreams.',
      '  - sub one',
      '  - sub two',
      '',
      '- [ ] **W2 (in review):** UI.',
      '1. not nested',
      '',
      'Paragraph.',
    ].join('\n');
    const [list, para] = blocks(md);
    expect(list).toEqual({
      t: 'list',
      list: {
        ordered: false,
        items: [
          {
            text: '**W1:** Parser. Reads the doc and its workstreams.',
            mark: 'done',
            children: [{ ordered: false, items: [{ text: 'sub one', mark: '', children: [] }, { text: 'sub two', mark: '', children: [] }] }],
          },
          { text: '**W2 (in review):** UI.', mark: 'open', children: [] },
          { text: 'not nested', mark: '', children: [] },
        ],
      },
    });
    expect(para).toEqual({ t: 'p', text: 'Paragraph.' });
  });

  test('a table with a header, and escaped pipes in cells', () => {
    expect(blocks('| A | B |\n|---|:-:|\n| 1 | `x \\| y` |\n')).toEqual([{ t: 'table', head: ['A', 'B'], rows: [['1', '`x | y`']] }]);
  });

  test('a paragraph ends where a list or heading starts', () => {
    expect(blocks('Text\n- item\n## H').map((b) => b.t)).toEqual(['p', 'list', 'h']);
  });
});
