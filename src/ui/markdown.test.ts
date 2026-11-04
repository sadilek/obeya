import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blocks, DocImages, excerpt, Inline, plain, sourceAt } from './markdown';

const html = (md: string) => renderToStaticMarkup(createElement(Inline, { md }));

describe('inline markdown', () => {
  test('an image shows where the document serves it, else as its text: a message loads nothing', () => {
    const md = 'See ![the chart](chart.png) and ![web](https://x.org/a.png).';
    expect(html(md)).toBe('See <span>the chart</span> and <span>web</span>.');
    const served = renderToStaticMarkup(createElement(DocImages.Provider, { value: (src) => (src.startsWith('http') ? null : `/files/${src}`) }, createElement(Inline, { md })));
    // React's server rendering preloads the image ahead of it
    expect(served.replace(/^<link [^>]*>/, '')).toBe('See <img class="doc-img" src="/files/chart.png" alt="the chart" title="the chart"/> and <span>web</span>.');
    expect(plain(md)).toBe('See the chart and web.');
  });

  test('emphasis with single asterisks, beside bold and underscores', () => {
    expect(html('Das ist *wichtig*.')).toBe('Das ist <em>wichtig</em>.');
    expect(html('*a* and **b** and _c_')).toBe('<em>a</em> and <b>b</b> and <em>c</em>');
    expect(html('*not **this** one*')).toBe('<em>not <b>this</b> one</em>');
    expect(html('**bold with *em* inside**')).toBe('<b>bold with <em>em</em> inside</b>');
    expect(html('***both***')).toBe('<b><em>both</em></b>');
    expect(html('(*quoted*), *two words*!')).toBe('(<em>quoted</em>), <em>two words</em>!');
  });

  test('asterisks that are not emphasis stay as they are', () => {
    for (const md of ['5 * 3 = 15', '5 * 3 * 2', 'a*b*c', '* item', '*.ts and *.tsx', '**unclosed', 'a footnote*', '`*code*`'])
      expect(html(md)).not.toContain('<em>');
    expect(html('5 * 3 * 2')).toBe('5 * 3 * 2');
  });

  test('bare web addresses are links, shown without their scheme and without the sentence around them', () => {
    const a = (url: string, shown: string) => `<a class="link" href="${url}" target="_blank" rel="noreferrer">${shown}</a>`;
    expect(html('Done: https://github.com/o/r/pull/911#issuecomment-6188630477. Next.')).toBe(
      `Done: ${a('https://github.com/o/r/pull/911#issuecomment-6188630477', 'github.com/o/r/pull/911#issuecomment-6188630477')}. Next.`,
    );
    expect(html('(see https://www.example.com/a), or')).toBe(`(see ${a('https://www.example.com/a', 'example.com/a')}), or`);
    expect(html('https://en.wikipedia.org/wiki/Foo_(bar)!')).toBe(`${a('https://en.wikipedia.org/wiki/Foo_(bar)', 'en.wikipedia.org/wiki/Foo_(bar)')}!`);
    expect(html('**on https://x.io/a_b_c**')).toBe(`<b>on ${a('https://x.io/a_b_c', 'x.io/a_b_c')}</b>`);
    expect(html('`https://x.io` and file:///tmp/a')).toBe('<code>https://x.io</code> and file:///tmp/a');
  });

  test('a markdown link keeps its text, an address in it included', () => {
    expect(html('[the PR](https://x.io/1)')).toBe('<a class="link" href="https://x.io/1" target="_blank" rel="noreferrer">the PR</a>');
    expect(html('[https://x.io/1](https://x.io/1)')).toBe('<a class="link" href="https://x.io/1" target="_blank" rel="noreferrer">https://x.io/1</a>');
  });

  test('plain text drops the markers, nested ones too', () => {
    expect(plain('*wichtig* and **bold *em***, `*code*`')).toBe('wichtig and bold em, *code*');
    expect(plain('see https://x.io/a_b_ and [it](https://x.io)')).toBe('see https://x.io/a_b_ and it');
  });

  test('plain text drops the marks of blocks and keeps what a code block holds', () => {
    expect(plain('Here is a draft. Shall I keep it this short?\n\n```text\nTmux gives you the *terminals*;\n```\nOr longer?')).toBe(
      'Here is a draft. Shall I keep it this short?\n\nTmux gives you the *terminals*;\nOr longer?',
    );
    expect(plain('~~~\nraw\n~~~')).toBe('raw');
    expect(plain('## The **plan** ##\n> quoted\n> > twice\n- one\n* two\n3. three\n- [x] done\n---\nend')).toBe('The plan\nquoted\ntwice\none\ntwo\nthree\ndone\nend');
    expect(plain('| a | b |\n|---|:-:|\n| `1` | 2 |')).toBe('a · b\n1 · 2');
    expect(plain('5 * 3 = 15, #hashtag')).toBe('5 * 3 = 15, #hashtag');
  });

  test("a card's excerpt is one line, with a dot between blocks that end in no punctuation", () => {
    expect(excerpt('Here is a draft. Shall I keep it?\n\n```\nTmux gives you the terminals.\n```')).toBe('Here is a draft. Shall I keep it? Tmux gives you the terminals.');
    expect(excerpt('## Two ways\n\n- **Keep** the cache\n- Drop it\n\nWhich one?')).toBe('Two ways · Keep the cache · Drop it · Which one?');
  });
});

describe('plan docs as documents', () => {
  test('headings, paragraphs joined across lines, rules, quotes and code', () => {
    const md = '# Title\n\n## Goal\n\nOne line\nwrapped.\n\n> A quote\n> on two lines.\n\n---\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n<!-- a comment -->\nAfter.\n';
    expect(blocks(md)).toEqual([
      { t: 'h', level: 1, text: 'Title' },
      { t: 'h', level: 2, text: 'Goal' },
      { t: 'p', text: 'One line wrapped.' },
      { t: 'quote', blocks: [{ t: 'p', text: 'A quote on two lines.' }] },
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

  test('a quote keeps its paragraphs, lists, code and nested quotes, and runs on through a lazy line', () => {
    const md = ['> First paragraph,', 'lazily wrapped.', '>', '> Second paragraph.', '> - one', '> - two', '>', '> ```', '> code', '> ```', '> > nested', '', 'After.'].join('\n');
    expect(blocks(md)).toEqual([
      {
        t: 'quote',
        blocks: [
          { t: 'p', text: 'First paragraph, lazily wrapped.' },
          { t: 'p', text: 'Second paragraph.' },
          { t: 'list', list: { ordered: false, items: [{ text: 'one', mark: '', children: [] }, { text: 'two', mark: '', children: [] }] } },
          { t: 'code', text: 'code' },
          { t: 'quote', blocks: [{ t: 'p', text: 'nested' }] },
        ],
      },
      { t: 'p', text: 'After.' },
    ]);
  });

  test('a paragraph ends where a list or heading starts', () => {
    expect(blocks('Text\n- item\n## H').map((b) => b.t)).toEqual(['p', 'list', 'h']);
  });
});

describe('messages', () => {
  test('each line its own paragraph; a table right after a line of text', () => {
    const md = 'Final numbers:\n| | Baseline | Model |\n|---|---|---|\n| Error | 33.6 | 25.2 |\nThe gap is +4 %.\nCommit abc.';
    expect(blocks(md, { breaks: true })).toEqual([
      { t: 'p', text: 'Final numbers:' },
      { t: 'table', head: ['', 'Baseline', 'Model'], rows: [['Error', '33.6', '25.2']] },
      { t: 'p', text: 'The gap is +4 %.' },
      { t: 'p', text: 'Commit abc.' },
    ]);
  });

  test('a quote keeps its lines, and a line without > ends it', () => {
    expect(blocks('> Line one\n> Line two\nAfter.', { breaks: true })).toEqual([
      { t: 'quote', blocks: [{ t: 'p', text: 'Line one' }, { t: 'p', text: 'Line two' }] },
      { t: 'p', text: 'After.' },
    ]);
  });

  test('each blank line between blocks stays, none before the first or after the last', () => {
    const md = '\nPost:\n\nOne\n\n\nTwo\n- item\n\nAfter.\n\n';
    expect(blocks(md, { breaks: true })).toEqual([
      { t: 'p', text: 'Post:' },
      { t: 'blank' },
      { t: 'p', text: 'One' },
      { t: 'blank' },
      { t: 'blank' },
      { t: 'p', text: 'Two' },
      { t: 'list', list: { ordered: false, items: [{ text: 'item', mark: '', children: [] }] } },
      { t: 'blank' },
      { t: 'p', text: 'After.' },
    ]);
    expect(blocks('One\n\nTwo').map((b) => b.t)).toEqual(['p', 'p']);
  });

  test('a line after a list item that is not indented ends the list', () => {
    const md = '- one\n  wrapped\n- two\nAfter.';
    expect(blocks(md, { breaks: true })).toEqual([
      { t: 'list', list: { ordered: false, items: [{ text: 'one wrapped', mark: '', children: [] }, { text: 'two', mark: '', children: [] }] } },
      { t: 'p', text: 'After.' },
    ]);
  });
});

describe('a place in the formatted text, in the source', () => {
  const md = '## Where\n\nAn **Export** button, and an Export menu.\n';
  test('the clicked words where they stand in the markdown, past its marks', () => {
    expect(sourceAt(md, ' button, and an ', 0, 3)).toBe(md.indexOf(' button') + 3);
    expect(sourceAt(md, 'Where', 0, 5)).toBe(md.indexOf('Where') + 5);
  });

  test('words that stand more than once: the how-manieth they are rendered', () => {
    expect(sourceAt(md, 'Export', 0, 1)).toBe(md.indexOf('Export') + 1);
    expect(sourceAt(md, 'Export', 1, 1)).toBe(md.lastIndexOf('Export') + 1);
  });

  test('the end of the source where the words do not stand in it as rendered', () => {
    expect(sourceAt(md, 'Export button', 0, 2)).toBe(md.length);
    expect(sourceAt(md, '', 0, 0)).toBe(md.length);
  });
});
